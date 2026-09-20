import { readFileSync } from "node:fs";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOpenConnectorFixture } from "../../../packages/adapters/src/open-connector-test-fixture.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

it("passes the user's credential to OpenConnector and persists only its scoped reference", async () => {
  const fixture = createOpenConnectorFixture();
  const connector = fixture.adapter;
  const writes: unknown[] = [];
  const db = {
    $executeRaw: vi.fn(async () => undefined),
    connection: {
      create: vi.fn(async ({ data }) => {
        writes.push(data);
        return { ...data, id: "connection-1" };
      }),
      updateMany: vi.fn(async (input) => {
        writes.push(input);
        return { count: 1 };
      }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  };
  const handler = new RPCHandler(
    createRouter({
      prisma: db,
      env: { webOrigin: "https://example.test" },
      connectors: { managed: () => connector },
    } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("https://example.test/rpc/connections/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: {
          connectorId: "open-connector",
          provider: "sample",
          displayName: "Support",
          credential: "fake-user-account-token",
        },
      }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    json: { connectionId: "connection-1", authorizationUrl: null },
  });
  expect(db.connection.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId }),
  });
  expect(db.connection.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: "connected",
        scope: "team",
        providerRef: expect.stringMatching(/^rkz_/),
      }),
    }),
  );
  expect(JSON.stringify(writes)).not.toContain("fake-user-account-token");
  expect(JSON.stringify(writes)).not.toContain("fake-admin-token");
  expect(fixture.fetcher).toHaveBeenCalledWith(
    "https://connector.example.test/api/connections/sample",
    expect.objectContaining({ body: expect.stringContaining("fake-user-account-token") }),
  );
  expect(JSON.stringify([...fixture.records.values()])).not.toContain("fake-runtime-token-");
});

describe("OpenConnector server configuration", () => {
  it("rejects non-owner configuration before contacting OpenConnector", async () => {
    const save = vi.fn();
    const handler = new RPCHandler(
      createRouter({ integrationSettings: { save } } as unknown as RouterDeps),
    );
    const { response } = await handler.handle(
      new Request("https://example.test/rpc/integrationSetup/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            provider: "open-connector",
            endpoint: "https://connector.example.test",
            apiKey: "fake-admin-token",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });
});

it("lists team connections and discovers tools for teammates while keeping management with the creator", async () => {
  const fixture = createOpenConnectorFixture();
  const ownerContext = {
    ...actor,
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const auth = await fixture.adapter.begin(
    { provider: "sample", redirectUrl: "https://example.test", credential: "fake-account-token" },
    ownerContext,
  );
  const rows = [
    {
      id: "team-account",
      userId: actor.userId,
      spaceId: actor.spaceId,
      scope: "team",
      connectorId: "open-connector",
      provider: "sample",
      displayName: "Support",
      status: "connected",
      providerRef: auth.state,
      createdAt: new Date("2026-01-01"),
    },
    {
      id: "private-account",
      userId: actor.userId,
      spaceId: actor.spaceId,
      scope: "user",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Mail",
      status: "connected",
      createdAt: new Date("2026-01-01"),
    },
    {
      id: "foreign-account",
      userId: "teammate",
      spaceId: "other-team",
      scope: "team",
      connectorId: "open-connector",
      provider: "sample",
      displayName: "Foreign",
      status: "connected",
      createdAt: new Date("2026-01-01"),
    },
  ];
  const channel = {
    id: "customer-channel",
    provider: "sample",
    connectionId: "team-account",
    userId: "teammate",
    spaceId: actor.spaceId,
    shared: false,
    enabled: true,
    startedAt: new Date("2026-01-01"),
    botId: "support-staff",
    autoReplies: false,
    bot: { archivedAt: null, name: "Support staff" },
    binding: JSON.parse(
      readFileSync(
        new URL("../../../docs/self-host/customer-bindings.json", import.meta.url),
        "utf8",
      ),
    ).line,
  };
  // Evaluate Prisma's scalar/OR filters against mixed-owner, mixed-team rows.
  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) =>
      key === "OR"
        ? (value as Record<string, unknown>[]).some((branch) => matches(row, branch))
        : value && typeof value === "object" && "not" in value
          ? row[key] !== value.not
          : row[key] === value,
    );
  }
  const db = {
    connection: {
      findMany: vi.fn(async ({ where }) => rows.filter((row) => matches(row, where))),
      findFirst: vi.fn(async ({ where }) => rows.find((row) => matches(row, where)) ?? null),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerChannel: {
      findMany: vi.fn(async ({ where }) => {
        const { connectionId, startedAt, bot, ...scope } = where;
        const live = !startedAt || (channel.startedAt && channel.bot.archivedAt === bot.archivedAt);
        return live && matches(channel, scope) && connectionId.in.includes(channel.connectionId)
          ? [channel]
          : [];
      }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  };
  const handler = new RPCHandler(
    createRouter({
      prisma: db,
      connectors: { managed: () => fixture.adapter },
      env: { apiUrl: "https://public.example.test" },
    } as unknown as RouterDeps),
  );
  const teammate = { ...actor, userId: "teammate" };
  async function rpc(method: string, input = {}, caller = teammate) {
    const { response } = await handler.handle(
      new Request(`https://example.test/rpc/connections/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return { status: response.status, body: await response.json() };
  }
  const connections = (await rpc("list")).body.json;
  expect(connections).toEqual([
    expect.objectContaining({
      id: "team-account",
      canManage: false,
      webhookUrl: "https://public.example.test/api/customer-events/customer-channel",
      automaticReplies: false,
    }),
  ]);
  // Who answers a shared account is the manager's business, not the teammate's.
  expect(connections[0]).not.toHaveProperty("replyBotId");
  expect(JSON.stringify(connections)).not.toContain("Support staff");
  expect(JSON.stringify(connections)).not.toContain("LINE_CHANNEL_SECRET_RECORD");
  expect((await rpc("list", {}, actor)).body.json[0]).not.toHaveProperty("webhookUrl");
  channel.shared = true;
  expect((await rpc("list", {}, actor)).body.json[0].webhookUrl).toBe(
    "https://public.example.test/api/customer-events/customer-channel",
  );
  channel.provider = "deskazo-preview";
  expect((await rpc("list", {}, actor)).body.json[0]).not.toHaveProperty("webhookUrl");
  channel.provider = "sample";
  expect(
    (await rpc("tools", { connectorId: "open-connector", provider: "sample" })).body.json,
  ).toEqual([expect.objectContaining({ name: "sample.send" })]);
  expect((await rpc("list", {}, { ...teammate, spaceId: "empty-team" })).body.json).toEqual([]);
  expect((await rpc("actions", { connectionId: "team-account" })).body.json).toEqual([
    expect.objectContaining({ name: "sample.send", internal: true, overridden: false }),
  ]);
  expect((await rpc("actions", { connectionId: "foreign-account" })).status).not.toBe(200);
  expect(
    (
      await rpc("configureAction", {
        connectionId: "team-account",
        action: "sample.send",
        internal: false,
      })
    ).status,
  ).not.toBe(200);
  expect((await rpc("applyActionDefaults", { connectionId: "team-account" })).status).not.toBe(200);
  expect(
    (await rpc("rename", { connectionId: "team-account", displayName: "Changed" })).status,
  ).not.toBe(200);
  await rpc("revoke", { connectionId: "team-account" });
  expect(db.connection.update).not.toHaveBeenCalled();
  expect(db.connection.updateMany).not.toHaveBeenCalled();
  expect(fixture.accounts.size).toBe(1);
});

it("restores pending authorization only for its creator without a remote catalog request", async () => {
  const fixture = createOpenConnectorFixture();
  fixture.providers[0]!.auth = [{ type: "oauth2" }];
  const started = await fixture.adapter.begin(
    {
      provider: "sample",
      redirectUrl: "https://example.test",
      auth: { type: "oauth2", values: {} },
    },
    { ...actor, operationId: "test", traceId: "test", signal: new AbortController().signal },
  );
  const row = {
    id: "pending-account",
    spaceId: actor.spaceId,
    userId: actor.userId,
    connectorId: "open-connector",
    provider: "sample",
    providerRef: started.state,
    displayName: "Support",
    status: "pending",
    scope: "team",
    createdAt: new Date("2026-01-01"),
  };
  const handler = new RPCHandler(
    createRouter({
      prisma: { connection: { findMany: async () => [row] } },
      connectors: { managed: () => fixture.adapter },
      env: { apiUrl: "https://public.example.test" },
    } as unknown as RouterDeps),
  );
  fixture.fetcher.mockClear();
  fixture.fetcher.mockRejectedValue(new Error("OpenConnector is offline"));
  async function list(userId: string) {
    const { response } = await handler.handle(
      new Request("https://example.test/rpc/connections/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor: { ...actor, userId } } },
    );
    expect(response.status).toBe(200);
    return (await response.json()).json;
  }
  expect((await list(actor.userId))[0]).toMatchObject({
    authorizationUrl: started.authorizationUrl,
  });
  expect((await list("teammate"))[0]).not.toHaveProperty("authorizationUrl");
  expect(fixture.fetcher).not.toHaveBeenCalled();
});
