import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import {
  computerScopeKey,
  createCustomerInbox,
  createDb,
  provisionMessagingIdentity,
  purchaseRecoveryMs,
  requestAccountDeletion,
  requireMembership,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountDeletionService } from "./account-deletion.js";
import { LocalArtifactStore } from "./artifacts.js";
import { destroyBot } from "./child-bots.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore, resolveAgentHomePath } from "./home.js";
import { CursorCloudAgentEmulator } from "./testing/cursor-cloud-agent-emulator.js";
import { InMemoryJobQueue } from "./wakeup.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("durable account deletion", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let dataDir: string;
  let deps: Parameters<typeof createAccountDeletionService>[0];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "account-recovery-"));
    owner = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    deps = {
      prisma: db.prisma,
      sandbox: new FakeSandboxProvider(),
      home: new LocalAgentHomeStore(dataDir),
      artifacts: new LocalArtifactStore(dataDir),
      jobs: new InMemoryJobQueue(),
      dataDir,
      connectors: { managed: vi.fn(() => undefined) },
      integrations: { removeUserAccounts: vi.fn(async () => undefined) },
      knowledge: { purge: vi.fn(async () => undefined) },
    };
  });
  afterEach(async () => {
    await deps.jobs.close();
    await db.prisma.cloudAgent.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.computerProvision.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.organization.deleteMany({ where: { id: owner.spaceId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function resources() {
    const context = {
      ...owner,
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    };
    const stored = await deps.artifacts.put(
      { name: "fixture.txt", mimeType: "text/plain", bytes: Buffer.from("Synthetic private file") },
      context,
    );
    const artifact = await db.prisma.artifact.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: owner.botId,
        name: "fixture.txt",
        mimeType: "text/plain",
        size: 22,
        storageKey: stored.id,
        hash: stored.hash,
      },
    });
    const computer = await db.prisma.computer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        scope: "dedicated",
        scopeKey: computerScopeKey("dedicated", owner.spaceId, owner.botId),
        homeKey: randomUUID(),
        kind: "fake",
        providerRef: randomUUID(),
      },
    });
    const homePath = resolveAgentHomePath(deps.home, computer.homeKey, dataDir);
    await mkdir(homePath, { recursive: true });
    await writeFile(path.join(homePath, "fixture.txt"), "Synthetic private home");
    return {
      artifact,
      computer,
      homePath,
      artifactPath: path.join(dataDir, "artifacts", owner.spaceId, stored.id),
    };
  }
  async function retryNow() {
    await db.prisma.accountDeletion.update({
      where: { userId: owner.userId },
      data: { nextAttemptAt: new Date(0), leaseUntil: null },
    });
  }
  async function pendingPurchase(status: string) {
    const connection = await db.prisma.connection.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        provider: "woocommerce",
        connectorId: "open-connector",
        providerRef: "synthetic-store",
        displayName: "Store",
        status: "connected",
      },
    });
    const channel = await db.prisma.customerChannel.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: owner.botId,
        provider: "web",
        accountId: randomUUID(),
        name: "Shop",
        ciphertext: "synthetic",
      },
    });
    const conversationId = await createCustomerInbox(db.prisma).receive(channel.id, {
      externalId: "one",
      externalThreadId: "one",
      customerId: "shopper",
      name: "Shopper",
      body: "A shirt",
    });
    return db.prisma.customerPurchase.create({
      data: {
        id: randomUUID(),
        conversationId,
        customerId: "shopper",
        connectionId: connection.id,
        providerRef: "synthetic-store",
        requestHash: "synthetic",
        paymentMethods: ["bacs"],
        status,
        actionId: randomUUID(),
        actionStartedAt: new Date(),
        ciphertext: "synthetic-encrypted-cart",
        actionKind: "checkout",
      },
    });
  }
  async function cloudWork(state: "queued" | "running" | "finished" | "lost response") {
    const wire = new CursorCloudAgentEmulator();
    const provider = new CursorCloudAgentProvider({ apiKey: "fake-key", fetch: wire.fetch });
    const connection = { key: "synthetic-cloud-credential", spaceId: owner.spaceId, provider };
    const id = randomUUID();
    const request = { prompt: "Synthetic private cloud task", idempotencyKey: id };
    const context = {
      ...owner,
      operationId: id,
      traceId: id,
      signal: new AbortController().signal,
    };
    const remote = state === "queued" ? null : await provider.launch(request, context);
    if (state === "finished") wire.complete(remote!.id);
    const row = await db.prisma.cloudAgent.create({
      data: {
        id,
        operationKey: id,
        providerKey: connection.key,
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        threadId: "synthetic-thread",
        title: request.prompt,
        launchRequest: { prompt: request.prompt },
        launchDispatched: state !== "queued",
        remoteId: state === "lost response" ? null : remote?.id,
        latestRunId: state === "lost response" ? null : remote?.latestRunId,
        status: state === "finished" ? "finished" : "running",
        nextPollAt: state === "finished" ? null : new Date(),
      },
    });
    return { wire, provider, connection, row, remote, context };
  }

  it.each(["queued", "running", "finished", "lost response"] as const)(
    "cleans %s cloud work before completing account deletion",
    async (state) => {
      const h = await cloudWork(state);
      await requestAccountDeletion(db.prisma, owner.userId);
      const service = createAccountDeletionService({ ...deps, cloudAgent: h.connection });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!(await db.prisma.accountDeletion.count({ where: { userId: owner.userId } }))) break;
        await retryNow();
        await service.process(owner.userId);
      }
      expect(await db.prisma.cloudAgent.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
      if (h.remote) {
        expect((await h.provider.get(h.remote.id, h.context)).status).toBe(
          state === "finished" ? "finished" : "cancelled",
        );
      }
      expect(
        h.wire.requests.filter((r) => r.method === "POST" && r.path === "/v1/agents"),
      ).toHaveLength(state === "queued" ? 0 : 1);
    },
  );

  it.each(["unavailable", "rebound", "pending cancellation", "provider failure"])(
    "retains cloud recovery identity while cleanup is %s",
    async (failure) => {
      const h = await cloudWork("running");
      await requestAccountDeletion(db.prisma, owner.userId);
      if (failure === "pending cancellation") h.wire.cancelPending = true;
      if (failure === "provider failure") h.wire.failNextRequest = 503;
      const cloudAgent =
        failure === "unavailable"
          ? null
          : failure === "rebound"
            ? { ...h.connection, key: "different-credential" }
            : h.connection;
      await createAccountDeletionService({ ...deps, cloudAgent }).process(owner.userId);
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
      expect(await db.prisma.cloudAgent.findUnique({ where: { id: h.row.id } })).toMatchObject({
        remoteId: h.remote!.id,
        status: "running",
      });
      expect(deps.integrations.removeUserAccounts).not.toHaveBeenCalled();
      expect(
        await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
      ).toMatchObject({ errorCode: failure === "pending cancellation" ? null : "cleanup_failed" });
      h.wire.cancelPending = false;
      await retryNow();
      await createAccountDeletionService({ ...deps, cloudAgent: h.connection }).process(
        owner.userId,
      );
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
      expect(await db.prisma.cloudAgent.count({ where: { userId: owner.userId } })).toBe(0);
    },
  );

  it("keeps cloud work while a poll owns its lease", async () => {
    const h = await cloudWork("running");
    await db.prisma.cloudAgent.update({
      where: { id: h.row.id },
      data: { leaseToken: "active-poller", leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    await requestAccountDeletion(db.prisma, owner.userId);
    const requests = h.wire.requests.length;
    await createAccountDeletionService({ ...deps, cloudAgent: h.connection }).process(owner.userId);
    expect(h.wire.requests).toHaveLength(requests);
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
    await db.prisma.cloudAgent.update({
      where: { id: h.row.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await retryNow();
    await createAccountDeletionService({ ...deps, cloudAgent: h.connection }).process(owner.userId);
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
  });

  it("keeps an unobserved launch pending without dispatching another create", async () => {
    const h = await cloudWork("queued");
    await db.prisma.cloudAgent.update({
      where: { id: h.row.id },
      data: { launchDispatched: true },
    });
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService({ ...deps, cloudAgent: h.connection }).process(owner.userId);
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
    expect(await db.prisma.cloudAgent.findUnique({ where: { id: h.row.id } })).not.toBeNull();
    expect(h.wire.requests.every((r) => r.method === "GET")).toBe(true);
    expect(h.wire.ids.size).toBe(0);
  });

  it("cancels an accepted follow-up without replaying it during cloud cleanup", async () => {
    const h = await cloudWork("running");
    h.wire.complete(h.remote!.id);
    await h.provider.reply(h.remote!.id, { prompt: "Synthetic follow-up" }, h.context);
    await db.prisma.cloudAgent.update({
      where: { id: h.row.id },
      data: {
        followup: { prompt: "Synthetic follow-up" },
        followupDispatching: true,
      },
    });
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService({ ...deps, cloudAgent: h.connection }).process(owner.userId);
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
    expect((await h.provider.get(h.remote!.id, h.context)).status).toBe("cancelled");
    expect(
      h.wire.requests.filter((r) => r.method === "POST" && r.path.endsWith("/runs")),
    ).toHaveLength(1);
  });

  it("rejects cloud records created after the account deletion request", async () => {
    const h = await cloudWork("queued");
    await requestAccountDeletion(db.prisma, owner.userId);
    await expect(
      db.prisma.cloudAgent.create({
        data: {
          id: randomUUID(),
          operationKey: randomUUID(),
          providerKey: h.row.providerKey,
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: owner.botId,
          threadId: h.row.threadId,
          title: "Late cloud task",
          launchRequest: {},
        },
      }),
    ).rejects.toThrow();
    expect(await db.prisma.cloudAgent.count({ where: { userId: owner.userId } })).toBe(1);
  });

  it.each([403, 500])(
    "retains Docker cleanup after supervisor status %s and retries after restart",
    async (status) => {
      const { computer, homePath } = await resources();
      await db.prisma.computer.update({ where: { id: computer.id }, data: { kind: "docker" } });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          Response.json({ error: "Synthetic cleanup failure" }, { status }),
        );
      deps.sandbox = new DockerSandboxProvider("http://supervisor.example.test", "synthetic-token");
      await requestAccountDeletion(db.prisma, owner.userId);
      await createAccountDeletionService(deps).process(owner.userId);
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
      expect(
        await db.prisma.accountDeletionResource.findFirst({
          where: { userId: owner.userId, kind: "computer" },
        }),
      ).toMatchObject({
        key: computer.homeKey,
        providerKind: "docker",
        providerRef: computer.providerRef,
      });
      expect(
        await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
      ).toMatchObject({ errorCode: "cleanup_failed" });
      fetch.mockImplementation(async () => Response.json({ ok: true }));
      deps.sandbox = new DockerSandboxProvider("http://supervisor.example.test", "synthetic-token");
      await retryNow();
      await createAccountDeletionService(deps).process(owner.userId);
      expect(fetch).toHaveBeenCalledWith(
        `http://supervisor.example.test/computers/${computer.providerRef}`,
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({
            "x-rakazo-bot-id": computer.homeKey,
            "x-rakazo-space-id": owner.spaceId,
          }),
        }),
      );
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
      expect(
        await db.prisma.accountDeletionResource.count({ where: { userId: owner.userId } }),
      ).toBe(0);
      expect(existsSync(homePath)).toBe(false);
    },
  );

  it.each([false, true])(
    "preserves old-provider cleanup after changing provider (provision receipt=%s)",
    async (receipt) => {
      const { computer } = await resources();
      await db.prisma.computer.update({ where: { id: computer.id }, data: { kind: "e2b" } });
      if (receipt) {
        await db.prisma.computerProvision.create({
          data: {
            id: randomUUID(),
            computerId: computer.id,
            homeKey: computer.homeKey,
            userId: owner.userId,
            spaceId: owner.spaceId,
            kind: "e2b",
            providerRef: computer.providerRef,
            status: "cleanup",
            cleanup: "destroy",
          },
        });
      }
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          Response.json({ error: "computer not found" }, { status: 404 }),
        );
      deps.sandbox = new DockerSandboxProvider("http://supervisor.example.test", "synthetic-token");
      await requestAccountDeletion(db.prisma, owner.userId);
      await createAccountDeletionService(deps).process(owner.userId);
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
      if (receipt) {
        expect(
          await db.prisma.computerProvision.findUnique({ where: { computerId: computer.id } }),
        ).toMatchObject({ status: "cleanup", kind: "e2b", providerRef: computer.providerRef });
      } else {
        expect(
          await db.prisma.accountDeletionResource.findFirst({
            where: { userId: owner.userId, kind: "computer" },
          }),
        ).toMatchObject({ providerKind: "e2b", providerRef: computer.providerRef });
      }

      const unexpected = vi.fn(async () => {
        throw new Error("Unexpected allocation");
      });
      const kill = vi.fn(async () => true);
      deps.sandbox = new E2BSandboxProvider("synthetic-key", {
        create: unexpected,
        connect: unexpected,
        pause: vi.fn(async () => true),
        kill,
      });
      await retryNow();
      await createAccountDeletionService(deps).process(owner.userId);
      expect(kill).toHaveBeenCalledWith(computer.providerRef, expect.anything());
      expect(unexpected).not.toHaveBeenCalled();
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
      expect(await db.prisma.computerProvision.count({ where: { userId: owner.userId } })).toBe(0);
    },
  );

  it("retains an E2B cleanup identity through an outage and retries after restart", async () => {
    const { computer } = await resources();
    await db.prisma.computer.update({ where: { id: computer.id }, data: { kind: "e2b" } });
    let unavailable = true;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => {
        throw new Error("Unexpected creation");
      }),
      connect: vi.fn(async () => {
        throw new Error("Unexpected reconnect");
      }),
      pause: vi.fn(async () => true),
      kill: vi.fn(async () => {
        if (unavailable) throw new Error("Synthetic provider outage");
        return true;
      }),
    };
    deps.sandbox = new E2BSandboxProvider("synthetic-key", sdk);
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
    expect(
      await db.prisma.accountDeletionResource.findFirst({
        where: { userId: owner.userId, kind: "computer" },
      }),
    ).toMatchObject({
      key: computer.homeKey,
      providerKind: "e2b",
      providerRef: computer.providerRef,
    });
    expect(
      await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
    ).toMatchObject({ errorCode: "cleanup_failed" });

    unavailable = false;
    deps.sandbox = new E2BSandboxProvider("synthetic-key", sdk);
    await retryNow();
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
    expect(await db.prisma.accountDeletionResource.count({ where: { userId: owner.userId } })).toBe(
      0,
    );
    expect(sdk.kill).toHaveBeenCalledWith(
      computer.providerRef,
      expect.objectContaining({ apiKey: "synthetic-key", signal: expect.any(AbortSignal) }),
    );
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it.each(["creating", "updating", "submitting", "uncertain"])(
    "defers every cleanup provider while a recent purchase is %s, then resumes",
    async (status) => {
      const purchase = await pendingPurchase(status);
      const revoke = vi.fn(async () => undefined);
      deps.connectors.managed = () => ({ revoke }) as unknown as ManagedConnectorProvider;
      await requestAccountDeletion(db.prisma, owner.userId);
      await createAccountDeletionService(deps).process(owner.userId);
      expect(deps.integrations.removeUserAccounts).not.toHaveBeenCalled();
      expect(deps.knowledge.purge).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(
        await db.prisma.customerPurchase.findUnique({ where: { id: purchase.id } }),
      ).toMatchObject({ ciphertext: "synthetic-encrypted-cart", status });
      expect(
        await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
      ).toMatchObject({ claimId: null, leaseUntil: null, errorCode: null });
      if (status === "uncertain") {
        await db.prisma.customerPurchase.update({
          where: { id: purchase.id },
          data: {
            actionStartedAt: new Date(Date.now() - purchaseRecoveryMs - 1),
          },
        });
      } else {
        await db.prisma.customerPurchase.update({
          where: { id: purchase.id },
          data: {
            status: "submitted",
            actionId: null,
            actionStartedAt: null,
          },
        });
      }
      await retryNow();
      await createAccountDeletionService(deps).process(owner.userId);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
      expect(await db.prisma.customerPurchase.count({ where: { id: purchase.id } })).toBe(0);
    },
  );
  it.each(["channel", "connection"])(
    "defers cleanup when only the purchase %s belongs to the deleted user",
    async (scope) => {
      const purchase = await pendingPurchase("submitting");
      const otherId = randomUUID();
      await db.prisma.user.create({
        data: { id: otherId, name: "Teammate", email: `${otherId}@example.test` },
      });
      const membership = await db.prisma.spaceMember.findFirstOrThrow({
        where: { userId: owner.userId, spaceId: owner.spaceId },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: membership.organizationId,
          userId: otherId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await requireMembership(db.prisma, otherId, owner.spaceId);
      try {
        if (scope === "channel")
          await db.prisma.connection.update({
            where: { id: purchase.connectionId },
            data: { userId: otherId, scope: "team" },
          });
        else {
          const conversation = await db.prisma.customerConversation.findUniqueOrThrow({
            where: { id: purchase.conversationId },
          });
          const bot = await db.prisma.bot.create({
            data: { userId: otherId, spaceId: owner.spaceId, name: "Other staff", color: "blue" },
          });
          await db.prisma.customerChannel.update({
            where: { id: conversation.channelId },
            data: { userId: otherId, botId: bot.id },
          });
        }
        await requestAccountDeletion(db.prisma, owner.userId);
        await createAccountDeletionService(deps).process(owner.userId);
        expect(deps.integrations.removeUserAccounts).not.toHaveBeenCalled();
        expect(await db.prisma.customerPurchase.count({ where: { id: purchase.id } })).toBe(1);
        expect(
          await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
        ).toMatchObject({ claimId: null, leaseUntil: null, errorCode: null });
      } finally {
        await db.prisma.bot.deleteMany({ where: { userId: otherId } });
        await db.prisma.connection.deleteMany({ where: { userId: otherId } });
        await db.prisma.user.delete({ where: { id: otherId } });
      }
    },
  );
  it("uses the last update for legacy reservations without a start time", async () => {
    const purchase = await pendingPurchase("submitting");
    deps.connectors.managed = () =>
      ({ revoke: async () => undefined }) as unknown as ManagedConnectorProvider;
    await db.prisma.customerPurchase.update({
      where: { id: purchase.id },
      data: { actionStartedAt: null },
    });
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService(deps).process(owner.userId);
    expect(deps.integrations.removeUserAccounts).not.toHaveBeenCalled();
    await db.prisma.customerPurchase.update({
      where: { id: purchase.id },
      data: { updatedAt: new Date(Date.now() - purchaseRecoveryMs - 1) },
    });
    await retryNow();
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
  });
  it("resumes deletion after a crashed checkout reservation expires", async () => {
    const purchase = await pendingPurchase("submitting");
    deps.connectors.managed = () =>
      ({ revoke: async () => undefined }) as unknown as ManagedConnectorProvider;
    await db.prisma.customerPurchase.update({
      where: { id: purchase.id },
      data: {
        actionStartedAt: new Date(Date.now() - purchaseRecoveryMs - 1),
      },
    });
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
  });
  it.each(["artifact", "computer"])(
    "retains %s cleanup identities after bot rows disappear and resumes with a new worker",
    async (kind) => {
      const seeded = await resources();
      const failure =
        kind === "artifact"
          ? vi
              .spyOn(deps.artifacts, "remove")
              .mockRejectedValue(new Error("synthetic secret provider error"))
          : vi
              .spyOn(deps.sandbox, "destroy")
              .mockRejectedValue(new Error("synthetic secret provider error"));
      await requestAccountDeletion(db.prisma, owner.userId);
      await expect(requireMembership(db.prisma, owner.userId)).rejects.toThrow();
      await createAccountDeletionService(deps).process(owner.userId);
      expect(await db.prisma.bot.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await db.prisma.artifact.count({ where: { id: seeded.artifact.id } })).toBe(0);
      expect(await db.prisma.computer.count({ where: { id: seeded.computer.id } })).toBe(0);
      const pending = await db.prisma.accountDeletion.findUniqueOrThrow({
        where: { userId: owner.userId },
        include: { resources: true },
      });
      expect(pending).toMatchObject({ attempts: 1, errorCode: "cleanup_failed", claimId: null });
      expect(pending.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind,
            key: kind === "artifact" ? seeded.artifact.storageKey : seeded.computer.homeKey,
          }),
        ]),
      );
      expect(JSON.stringify(pending)).not.toContain("synthetic secret");
      await expect(db.prisma.user.delete({ where: { id: owner.userId } })).rejects.toMatchObject({
        code: "P2003",
      });
      if (kind === "artifact") expect(existsSync(seeded.artifactPath)).toBe(true);
      failure.mockRestore();
      await retryNow();
      // New service and local stores share only durable database/filesystem state.
      await createAccountDeletionService({
        ...deps,
        home: new LocalAgentHomeStore(dataDir),
        artifacts: new LocalArtifactStore(dataDir),
      }).process(owner.userId);
      expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
      expect(await db.prisma.accountDeletion.count({ where: { userId: owner.userId } })).toBe(0);
      expect(existsSync(seeded.artifactPath)).toBe(false);
      expect(existsSync(seeded.homePath)).toBe(false);
    },
  );
  it("keeps credentials until provider cleanup succeeds and denies new members in a claimed organization", async () => {
    await db.prisma.account.create({
      data: {
        id: randomUUID(),
        userId: owner.userId,
        accountId: "synthetic",
        providerId: "fixture",
        accessToken: "synthetic-only",
      },
    });
    vi.mocked(deps.integrations.removeUserAccounts).mockRejectedValueOnce(new Error("offline"));
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.account.count({ where: { userId: owner.userId } })).toBe(1);
    expect(await db.prisma.bot.count({ where: { id: owner.botId } })).toBe(1);
    await expect(
      db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: owner.spaceId,
          userId: owner.userId,
          role: "owner",
          createdAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await retryNow();
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.account.count({ where: { userId: owner.userId } })).toBe(0);
  });
  it("reconciles an expired worker lease, while concurrent workers do not both revoke accounts", async () => {
    await requestAccountDeletion(db.prisma, owner.userId);
    const service = createAccountDeletionService(deps);
    const enqueue = vi.spyOn(deps.jobs, "enqueue");
    await db.prisma.accountDeletion.update({
      where: { userId: owner.userId },
      data: { claimId: "lost-worker", leaseUntil: new Date(Date.now() + 60_000) },
    });
    await service.reconcile();
    await service.process(owner.userId);
    expect(enqueue).not.toHaveBeenCalled();
    expect(deps.integrations.removeUserAccounts).not.toHaveBeenCalled();
    await retryNow();
    await service.reconcile();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "account.delete", payload: { userId: owner.userId } }),
    );
    await Promise.all([
      service.process(owner.userId),
      createAccountDeletionService(deps).process(owner.userId),
    ]);
    expect(deps.integrations.removeUserAccounts).toHaveBeenCalledTimes(1);
    expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
  });
  it("retains the request when final user deletion rolls back after successful external cleanup", async () => {
    await resources();
    await db.prisma.$executeRaw`CREATE TABLE account_deletion_test_blocks (id TEXT PRIMARY KEY)`;
    await db.prisma.$executeRaw`INSERT INTO account_deletion_test_blocks VALUES (${owner.userId})`;
    await db.prisma
      .$executeRaw`CREATE FUNCTION reject_test_account_deletion() RETURNS trigger AS $$ BEGIN IF EXISTS (SELECT 1 FROM account_deletion_test_blocks WHERE id = OLD.id) THEN RAISE EXCEPTION 'synthetic final commit failure'; END IF; RETURN OLD; END; $$ LANGUAGE plpgsql`;
    await db.prisma
      .$executeRaw`CREATE TRIGGER reject_test_account_deletion BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION reject_test_account_deletion()`;
    try {
      await requestAccountDeletion(db.prisma, owner.userId);
      await createAccountDeletionService(deps).process(owner.userId);
      expect(
        await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
      ).toMatchObject({ errorCode: "cleanup_failed" });
      expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(1);
      expect(
        await db.prisma.accountDeletionResource.count({ where: { userId: owner.userId } }),
      ).toBe(0);
    } finally {
      await db.prisma.$executeRaw`DROP TRIGGER reject_test_account_deletion ON "user"`;
      await db.prisma.$executeRaw`DROP FUNCTION reject_test_account_deletion()`;
      await db.prisma.$executeRaw`DROP TABLE account_deletion_test_blocks`;
    }
    await retryNow();
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
  });
  it("retains an earlier failed bot cleanup when account deletion is requested afterward", async () => {
    const seeded = await resources();
    const bot = await db.prisma.bot.findUniqueOrThrow({ where: { id: owner.botId } });
    const failure = vi
      .spyOn(deps.artifacts, "remove")
      .mockRejectedValue(new Error("Synthetic storage failure"));
    await destroyBot(
      deps,
      bot,
      {
        ...owner,
        operationId: "fixture-delete",
        traceId: "fixture-delete",
        signal: new AbortController().signal,
      },
      { deleteMemories: true },
    );
    expect(await db.prisma.bot.count({ where: { id: owner.botId } })).toBe(0);
    expect(await db.prisma.botDeletion.findUnique({ where: { id: owner.botId } })).toMatchObject({
      userId: owner.userId,
      artifactKeys: [seeded.artifact.storageKey],
    });
    failure.mockRestore();
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService(deps).process(owner.userId);
    expect(existsSync(seeded.artifactPath)).toBe(false);
    expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
  });
  it("rejects resource writes both during and after account deletion", async () => {
    const writes = [
      () =>
        db.prisma.bot.create({
          data: { userId: owner.userId, spaceId: owner.spaceId, name: "Late", color: "blue" },
        }),
      () =>
        db.prisma.artifact.create({
          data: {
            userId: owner.userId,
            spaceId: owner.spaceId,
            name: "late.txt",
            mimeType: "text/plain",
            size: 1,
            hash: "fixture",
            storageKey: randomUUID(),
          },
        }),
      () =>
        db.prisma.computer.create({
          data: {
            userId: owner.userId,
            spaceId: owner.spaceId,
            scopeKey: randomUUID(),
            homeKey: randomUUID(),
            kind: "fake",
          },
        }),
      () =>
        db.prisma.gatewayRuntime.create({
          data: {
            userId: owner.userId,
            spaceId: owner.spaceId,
            name: "Late",
            tokenHash: randomUUID(),
          },
        }),
      () =>
        db.prisma.connection.create({
          data: {
            userId: owner.userId,
            spaceId: owner.spaceId,
            provider: "fixture",
            displayName: "Late",
            status: "connected",
          },
        }),
      () =>
        db.prisma.session.create({
          data: {
            id: randomUUID(),
            userId: owner.userId,
            token: randomUUID(),
            expiresAt: new Date("2030-01-01"),
          },
        }),
    ];
    await requestAccountDeletion(db.prisma, owner.userId);
    for (const write of writes) await expect(write()).rejects.toMatchObject({ code: "P2003" });
    await createAccountDeletionService(deps).process(owner.userId);
    for (const write of writes) await expect(write()).rejects.toMatchObject({ code: "P2003" });
  });
  it("claims and cleans a shared organization that becomes private while deletion is pending", async () => {
    const otherId = randomUUID();
    await db.prisma.user.create({
      data: { id: otherId, name: "Synthetic member", email: `${otherId}@rakazo.test` },
    });
    const member = await db.prisma.member.create({
      data: {
        id: randomUUID(),
        userId: otherId,
        organizationId: owner.spaceId,
        role: "member",
        createdAt: new Date(),
      },
    });
    try {
      await requestAccountDeletion(db.prisma, owner.userId);
      expect(
        await db.prisma.accountDeletionResource.count({
          where: { userId: owner.userId, kind: "organization" },
        }),
      ).toBe(0);
      await db.prisma.member.delete({ where: { id: member.id } });
      const service = createAccountDeletionService(deps);
      await service.process(owner.userId);
      expect(
        await db.prisma.accountDeletionResource.count({
          where: { userId: owner.userId, kind: "organization" },
        }),
      ).toBe(1);
      await expect(
        db.prisma.member.create({ data: { ...member, id: randomUUID() } }),
      ).rejects.toThrow("Organization deletion requested");
      const original = await db.prisma.member.findFirstOrThrow({
        where: { userId: owner.userId, organizationId: owner.spaceId },
      });
      await expect(
        db.prisma.member.update({ where: { id: original.id }, data: { userId: otherId } }),
      ).rejects.toThrow("Organization deletion requested");
      await service.process(owner.userId);
      expect(deps.knowledge.purge).toHaveBeenCalledWith(owner.spaceId, expect.any(AbortSignal));
      expect(await db.prisma.organization.count({ where: { id: owner.spaceId } })).toBe(0);
      expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
    } finally {
      await db.prisma.user.delete({ where: { id: otherId } });
    }
  });
  it("keeps ordinary connector revocation durable through failure before deleting credentials", async () => {
    const connection = await db.prisma.connection.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        connectorId: "fixture",
        provider: "shop",
        providerRef: "synthetic-account",
        displayName: "Shop",
        status: "connected",
      },
    });
    const revoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("Synthetic remote failure"))
      .mockResolvedValue(undefined);
    vi.mocked(deps.connectors.managed).mockReturnValue({
      revoke,
    } as unknown as ManagedConnectorProvider);
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService(deps).process(owner.userId);
    expect(await db.prisma.connection.findUnique({ where: { id: connection.id } })).toMatchObject({
      status: "revoked",
    });
    expect(
      await db.prisma.accountDeletionResource.findFirst({
        where: { userId: owner.userId, kind: "connection" },
      }),
    ).toMatchObject({ providerRef: "synthetic-account", providerKind: "fixture" });
    expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(1);
    await retryNow();
    await createAccountDeletionService(deps).process(owner.userId);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenLastCalledWith(
      "synthetic-account",
      expect.objectContaining({ userId: owner.userId, spaceId: owner.spaceId }),
    );
    expect(await db.prisma.connection.count({ where: { id: connection.id } })).toBe(0);
    expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
  });
  it("renews a slow cleanup claim and aborts provider work when another worker owns it", async () => {
    await requestAccountDeletion(db.prisma, owner.userId);
    let entered!: (signal: AbortSignal) => void;
    const waiting = new Promise<AbortSignal>((resolve) => {
      entered = resolve;
    });
    vi.mocked(deps.integrations.removeUserAccounts).mockImplementation(async (_userId, signal) => {
      entered(signal!);
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
      );
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const running = createAccountDeletionService(deps).process(owner.userId);
    try {
      const signal = await waiting;
      const initial = await db.prisma.accountDeletion.findUniqueOrThrow({
        where: { userId: owner.userId },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect
        .poll(async () =>
          (
            await db.prisma.accountDeletion.findUniqueOrThrow({ where: { userId: owner.userId } })
          ).leaseUntil!.getTime(),
        )
        .toBeGreaterThan(initial.leaseUntil!.getTime());
      await db.prisma.accountDeletion.update({
        where: { userId: owner.userId },
        data: { claimId: "replacement-worker" },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect.poll(() => signal.aborted).toBe(true);
      await running;
      expect(await db.prisma.bot.count({ where: { userId: owner.userId } })).toBe(1);
      expect(
        await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
      ).toMatchObject({ claimId: "replacement-worker" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents an in-flight membership removal from orphaning the surviving organization", async () => {
    const otherId = randomUUID();
    await db.prisma.user.create({
      data: { id: otherId, name: "Synthetic member", email: `${otherId}@rakazo.test` },
    });
    const member = await db.prisma.member.create({
      data: {
        id: randomUUID(),
        userId: otherId,
        organizationId: owner.spaceId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await requestAccountDeletion(db.prisma, owner.userId);
    let entered!: () => void;
    const atFinalDelete = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercepted = db.prisma.$extends({
      query: {
        user: {
          async delete({ args, query }) {
            if (args.where.id === owner.userId) {
              entered();
              await held;
            }
            return query(args);
          },
        },
      },
    });
    const running = createAccountDeletionService({
      ...deps,
      prisma: intercepted as typeof db.prisma,
    }).process(owner.userId);
    try {
      await atFinalDelete;
      const leaving = db.prisma.member.delete({ where: { id: member.id } });
      const rejected = expect(leaving).rejects.toThrow(
        "Cannot remove the last organization member",
      );
      // The competing DELETE has acquired its member row and is waiting for the
      // organization lock held by final account removal.
      await expect
        .poll(async () => {
          const result = await db.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%DELETE%' AND query LIKE '%member%'",
          );
          return result.rowCount;
        })
        .toBeGreaterThan(0);
      release();
      await running;
      await rejected;
      expect(await db.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
      expect(
        await db.prisma.member.count({ where: { organizationId: owner.spaceId, userId: otherId } }),
      ).toBe(1);
    } finally {
      release();
      await running;
      await db.prisma.organization.deleteMany({ where: { id: owner.spaceId } });
      await db.prisma.user.delete({ where: { id: otherId } });
    }
  });
});
