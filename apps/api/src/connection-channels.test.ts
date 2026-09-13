import { EncryptedSecretStore } from "@rakazo/adapters";
import { beforeEach, expect, it, vi } from "vitest";
import { ConnectionChannels, connectionIncomingDto } from "./connection-channels.js";

const bridges = vi.hoisted(
  () =>
    [] as Array<{
      options: any;
      receive: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>,
);
vi.mock("./team-chat-bridge.js", () => ({
  TeamChatBridge: class {
    receive = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    constructor(public options: any) {
      bridges.push(this);
    }
    async start() {}
  },
}));
beforeEach(() => bridges.splice(0));
function fixture() {
  const secrets = new EncryptedSecretStore("fake-encryption-key");
  const actor = { spaceId: "team-a", userId: "owner-a", email: "owner@example.test" };
  const row = {
    id: "account-a",
    spaceId: actor.spaceId,
    userId: actor.userId,
    status: "connected",
    connectorId: "open-connector",
    provider: "sample",
    providerRef: "alias-a",
    displayName: "Support",
    metadata: {},
  };
  let secret: any = null;
  const prisma: any = {
    connection: {
      findFirst: vi.fn(async ({ where }) =>
        Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
          ? row
          : null,
      ),
      findMany: vi.fn(async () => (row.status === "connected" ? [row] : [])),
      update: vi.fn(async ({ data }) => Object.assign(row, data)),
    },
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "chief-a" && where.spaceId === actor.spaceId && where.userId === actor.userId
          ? { id: "chief-a" }
          : null,
      ),
    },
    secret: {
      upsert: vi.fn(async ({ create }) => {
        secret = create;
      }),
      findFirst: vi.fn(async () => secret),
      deleteMany: vi.fn(async () => {
        secret = null;
      }),
    },
    $transaction: (callback: any) => callback(prisma),
  };
  const provider = {
    catalog: async () => [{ slug: "sample", incomingMessages: true }],
    receiveWebhook: vi.fn(async () => ({ status: 200, events: [] })),
    sendReply: vi.fn(async () => ({ handle: "sent" })),
  };
  const channels = new ConnectionChannels({
    prisma,
    secrets,
    connectors: { managed: () => provider },
    events: {},
    jobs: {},
  } as any);
  const input = {
    connectionId: row.id,
    botId: "chief-a",
    webhookOrigin: "https://example.test",
    channelSecret: "fake-channel-secret",
  };
  const request = () => new Request("https://example.test/webhook", { method: "POST" });
  return { channels, prisma, provider, actor, input, row, request };
}
it("only lets the account owner configure a bot in the same team", async () => {
  const f = fixture();
  await expect(f.channels.save({ ...f.actor, userId: "teammate" }, f.input)).rejects.toThrow();
  await expect(f.channels.save({ ...f.actor, spaceId: "team-b" }, f.input)).rejects.toThrow();
  await expect(f.channels.save(f.actor, { ...f.input, botId: "foreign-bot" })).rejects.toThrow();
  expect(f.prisma.secret.upsert).not.toHaveBeenCalled();
});
it("stores encrypted credentials and returns only public setup fields", async () => {
  const f = fixture();
  const result = await f.channels.save(f.actor, f.input);
  expect(result).toEqual({
    botId: "chief-a",
    webhookUrl: "https://example.test/api/v1/connections/account-a/webhook",
  });
  expect(connectionIncomingDto(f.row.metadata)).toEqual(result);
  expect(JSON.stringify(f.prisma.secret.upsert.mock.calls)).not.toContain(f.input.channelSecret);
  expect(JSON.stringify(f.row)).not.toContain(f.input.channelSecret);
  await f.channels.stop();
});
it("stops disabled connections and checks persisted permission before sending", async () => {
  const f = fixture();
  await f.channels.save(f.actor, f.input);
  const bridge = bridges[0]!;
  await f.channels.disable(f.actor, f.row.id);
  expect(bridge.stop).toHaveBeenCalled();
  await expect(bridge.options.send({ content: "Hello" })).rejects.toThrow("disabled");
  expect(f.provider.sendReply).not.toHaveBeenCalled();
  expect((await f.channels.receive(f.row.id, f.request())).status).toBe(404);
  await f.channels.stop();
});
it("rejects a webhook origin containing credentials or a path", async () => {
  const f = fixture();
  for (const webhookOrigin of [
    "http://example.test",
    "https://user:pass@example.test",
    "https://example.test/path",
  ]) {
    await expect(f.channels.save(f.actor, { ...f.input, webhookOrigin })).rejects.toThrow();
  }
  expect(f.prisma.secret.upsert).not.toHaveBeenCalled();
});
