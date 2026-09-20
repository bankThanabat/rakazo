import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  createDb,
  provisionMessagingIdentity,
  requireMembership,
  takeConnectorPermit,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IntegrationGateway } from "./integration-gateway.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { createOpenConnectorFixture, sampleAction } from "./open-connector-test-fixture.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(!enabled)("history gateway with one database connection", () => {
  let db: ReturnType<typeof createDb>;
  let f: ReturnType<typeof createOpenConnectorFixture>;
  let gateway: IntegrationGateway;
  let actors: Actor[];
  let runtimes: Array<{ id: string; token: string; ref: string }>;
  let onBusy: () => Promise<void>;
  let onRead: () => Promise<unknown>;
  const bucket = createHash("sha256")
    .update(JSON.stringify(["instagram", "instagram-account", "conversation-reads"]))
    .digest("hex");
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 1 });
  });
  beforeEach(async () => {
    onBusy = async () => {};
    onRead = async () => ({ conversations: [], paging: { hasNextPage: false } });
    f = createOpenConnectorFixture(() => onRead(), {
      $executeRaw: db.prisma.$executeRaw.bind(db.prisma),
      $queryRaw: (async (...args: Parameters<typeof db.prisma.$queryRaw>) => {
        const result = await db.prisma.$queryRaw(...args);
        if (
          String(args[0]).includes("INSERT INTO connector_rate_limits") &&
          Array.isArray(result) &&
          result.length === 0
        )
          await onBusy();
        return result;
      }) as typeof db.prisma.$queryRaw,
    });
    f.providers[0] = {
      ...f.providers[0]!,
      service: "instagram",
      actions: [
        {
          ...sampleAction,
          id: "instagram.list_conversations",
          service: "instagram",
          readOnly: true,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    };
    const settings = new IntegrationProviderSettings(db.prisma, f.secrets, "fixture", {
      "open-connector": f.adapter,
    });
    gateway = new IntegrationGateway({
      prisma: db.prisma,
      secrets: f.secrets,
      integrations: settings,
    });
    vi.spyOn(gateway, "configuration").mockResolvedValue({
      endpoint: "https://relay.example.test",
      apiKey: "fake",
      projectId: "fake",
      callbackOrigin: "https://gateway.example.test",
    });
    actors = [];
    runtimes = [];
    for (let i = 0; i < 2; i++) {
      const identity = await provisionMessagingIdentity(
        db.prisma,
        { provider: "test", address: randomUUID() },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
      const actor = await requireMembership(db.prisma, identity.userId, identity.spaceId);
      actors.push(actor);
      const runtime = await gateway.createRuntime(actor, "Synthetic runtime");
      const connected = z
        .object({ state: z.string() })
        .parse(
          await gateway.command(
            runtime.token,
            { op: "begin", provider: "instagram", credential: "fake" },
            new AbortController().signal,
          ),
        );
      runtimes.push({ ...runtime, ref: connected.state });
    }
  });
  afterEach(async () => {
    await db.prisma.connectorRateLimit.deleteMany({ where: { key: bucket } });
    for (const actor of actors) {
      await db.prisma.gatewayRuntime.deleteMany({ where: { userId: actor.userId } });
      await db.prisma.space.delete({ where: { id: actor.spaceId } });
      await db.prisma.user.delete({ where: { id: actor.userId } });
    }
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  function read(index: number, signal = new AbortController().signal) {
    const runtime = runtimes[index]!;
    return gateway.command(
      runtime.token,
      {
        op: "execute",
        connections: [
          {
            id: "local-account",
            connectorId: "open-connector",
            externalId: "instagram",
            providerRef: runtime.ref,
            displayName: "Synthetic",
          },
        ],
        call: {
          tool: "instagram.list_conversations",
          executionId: randomUUID(),
          args: {},
          route: {
            connectorId: "open-connector",
            resourceId: "local-account",
            toolName: "instagram.list_conversations",
          },
        },
      },
      signal,
    );
  }

  it("lets another runtime wait and cancel while a provider read is in flight", async () => {
    const started = deferred();
    const release = deferred();
    const busy = deferred();
    onRead = async () => {
      await db.prisma.connectorRateLimit.update({
        where: { key: bucket },
        data: { availableAt: new Date(Date.now() + 30000) },
      });
      started.resolve();
      await release.promise;
      return { conversations: [] };
    };
    const first = read(0);
    await started.promise;
    onBusy = async () => {
      busy.resolve();
    };
    const abort = new AbortController();
    const second = read(1, abort.signal);
    await busy.promise;
    // Both commands are active, but neither reserves the sole database connection.
    expect(await db.prisma.connectorRateLimit.count({ where: { key: bucket } })).toBe(1);
    abort.abort();
    expect(await second).toMatchObject([{ type: "error" }]);
    expect(f.sent).toHaveLength(1);
    release.resolve();
    expect(await first).toMatchObject([{ type: "result", data: { conversations: [] } }]);
  });

  it.each(["runtime", "account"])(
    "blocks a read after %s revocation while waiting",
    async (kind) => {
      await takeConnectorPermit(db.prisma, bucket, 30000);
      onBusy = async () => {
        if (kind === "runtime") await gateway.revokeRuntime(actors[0]!, runtimes[0]!.id);
        else
          await db.prisma.gatewayAccount.updateMany({
            where: { runtimeId: runtimes[0]!.id },
            data: { revokedAt: new Date() },
          });
        await db.prisma.connectorRateLimit.update({
          where: { key: bucket },
          data: { availableAt: new Date(0) },
        });
      };
      expect(await read(0)).toMatchObject([{ type: "error" }]);
      expect(f.sent).toHaveLength(0);
    },
  );

  it("withholds private results after authorization is revoked during a read", async () => {
    onRead = async () => {
      await gateway.revokeRuntime(actors[0]!, runtimes[0]!.id);
      return { messages: ["PRIVATE_HISTORY_SENTINEL"] };
    };
    const events = await read(0);
    expect(events).toMatchObject([{ type: "error" }]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_HISTORY_SENTINEL");
    expect(f.sent).toHaveLength(1);
  });
});
