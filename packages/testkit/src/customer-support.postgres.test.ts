import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import {
  CustomerChannelEmulator,
  CustomerService,
  createCustomerChannelSurface,
  EncryptedSecretStore,
} from "@rakazo/adapters";
import type { Actor, CustomerProvider } from "@rakazo/contracts";
import { createDb, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!available)("customer conversation journeys", () => {
  let db: ReturnType<typeof createDb>;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  async function fixture(run?: AgentRuntime["run"], provider: CustomerProvider = "line") {
    const id = randomUUID();
    const owner = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: id },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    const actor: Actor = { userId: owner.userId, spaceId: owner.spaceId };
    const requests: AgentRunRequest[] = [];
    const runtime: AgentRuntime = {
      describe: () => ({
        id: "test",
        adapterVersion: "1",
        contractVersion: "1",
        capabilities: { streaming: true, compaction: false, tools: false, scripted: true },
      }),
      abort: async () => {},
      run:
        run ??
        async function* (request) {
          requests.push(request);
          yield { type: "done", text: `Reply to ${request.prompt}` };
        },
    };
    const emulator = new CustomerChannelEmulator();
    const service = new CustomerService({
      prisma: db.prisma,
      secrets: new EncryptedSecretStore("test-encryption-key"),
      runtime,
      resolveModel: async () => ({ provider: "test", id: "test" }),
      createSurface: (input) => createCustomerChannelSurface(input, emulator.fetch),
    });
    const channel = await service.connect(actor, {
      provider,
      accountId: id,
      name: "Support",
      botId: owner.botId,
      instructions: "Help customers with product questions.",
      credentials:
        provider === "line"
          ? { accessToken: "private-test-token", channelSecret: "private-test-secret" }
          : provider === "instagram"
            ? {
                accessToken: "private-test-token",
                appSecret: "private-test-secret",
                verifyToken: "test-verify",
                apiVersion: "v25.0",
              }
            : { accessToken: "private-test-token", clientSecret: "private-test-secret" },
    });
    cleanups.push(async () => {
      await service.stop();
      await db.prisma.organization.delete({ where: { id: owner.spaceId } });
      await db.prisma.user.delete({ where: { id: owner.userId } });
    });
    const receive = async (sender: string, text: string, eventId = randomUUID()) => {
      const response = await service.webhook(
        channel.id,
        emulator.request(provider, {
          url: `https://example.test${channel.webhookPath}`,
          accountId: id,
          secret: "private-test-secret",
          sender,
          text,
          eventId,
        }),
      );
      expect(response.status).toBe(200);
      const conversation = await db.prisma.customerConversation.findFirstOrThrow({
        where: { channelId: channel.id, customerId: sender },
      });
      return (await service.repos.list(actor)).find((row) => row.id === conversation.id)!;
    };
    return { service, actor, channel, requests, emulator, receive };
  }
  it("stores no public credentials and keeps each customer's agent history isolated", async () => {
    const f = await fixture();
    expect(JSON.stringify(await f.service.repos.channels(f.actor))).not.toContain("private-test");
    const a = await f.receive("customer-a", "Only A's question");
    const b = await f.receive("customer-b", "Only B's question");
    expect(a.id).not.toBe(b.id);
    await f.service.tick();
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(2);
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      expect(request.tools.map((tool) => tool.name)).toEqual(["request_human_handoff"]);
      expect(request.allowBuiltinTools).toBe(false);
      expect(request.history).toEqual([]);
      expect(request.threadId).toMatch(/^customer:/);
    }
    const snapshot = await f.service.repos.snapshot(f.actor, a.id);
    expect(snapshot.messages.map((m) => m.body)).toEqual([
      "Only A's question",
      "Reply to Only A's question",
    ]);
    expect(snapshot.messages.at(-1)?.status).toBe("sent");
    await expect(
      f.service.repos.snapshot({ ...f.actor, spaceId: "another-space" }, a.id),
    ).rejects.toThrow();
    await expect(
      f.service.repos.setOwner({ ...f.actor, spaceId: "another-space" }, a.id, "staff"),
    ).rejects.toThrow();
  });
  it("backfills profiles, caches lookups and preserves inbox ordering and last known identity on failure", async () => {
    const f = await fixture();
    const row = await f.receive("customer-a", "Hello");
    f.emulator.profiles.set("customer-a", {
      displayName: "Alex Customer",
      pictureUrl: "https://images.example.test/customer.png",
    });
    await Promise.all([f.service.refreshProfiles(), f.service.refreshProfiles()]);
    const profile = (await f.service.repos.snapshot(f.actor, row.id)).conversation;
    expect(profile).toMatchObject({
      name: "Alex Customer",
      avatarUrl: "https://images.example.test/customer.png",
      updatedAt: row.updatedAt,
    });
    expect(f.emulator.profileRequests).toBe(1);
    await f.service.refreshProfiles();
    expect(f.emulator.profileRequests).toBe(1);
    const expire = () =>
      db.prisma.customerConversation.update({
        where: { id: row.id },
        data: { profileRefreshAt: new Date(0) },
      });
    await expire();
    f.emulator.profiles.delete("customer-a");
    await f.service.refreshProfiles();
    expect((await f.service.repos.snapshot(f.actor, row.id)).conversation).toMatchObject({
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    await expire();
    f.emulator.profiles.set("customer-a", {
      displayName: "Alex Updated",
      pictureUrl: "http://images.example.test/customer.png",
    });
    await f.service.refreshProfiles();
    expect((await f.service.repos.snapshot(f.actor, row.id)).conversation).toMatchObject({
      name: "Alex Updated",
      avatarUrl: null,
    });
    expect(f.emulator.sent).toHaveLength(0);
  });

  it("does not fetch profiles from a disconnected channel", async () => {
    const f = await fixture();
    await f.receive("customer-a", "Hello");
    await f.service.setChannelEnabled(f.actor, f.channel.id, false);
    await f.service.refreshProfiles();
    expect(f.emulator.profileRequests).toBe(0);
  });
  it.each(["line", "instagram", "tiktok"] as const)(
    "deduplicates concurrent signed %s webhook deliveries in durable storage",
    async (provider) => {
      const f = await fixture(undefined, provider);
      await Promise.all([
        f.receive("customer", "Hello", "duplicate-event"),
        f.receive("customer", "Hello", "duplicate-event"),
      ]);
      const rows = await f.service.repos.list(f.actor);
      expect(rows).toHaveLength(1);
      expect((await f.service.repos.snapshot(f.actor, rows[0]!.id)).messages).toHaveLength(1);
      await f.service.tick();
      await f.service.tick();
      expect(f.emulator.sent).toHaveLength(1);
    },
  );
  it("suppresses an in-flight bot answer after takeover, sends staff replies once, and resumes on a new message", async () => {
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async function* () {
      started();
      await gate;
      yield { type: "done", text: "Bot answer" };
    });
    const conversation = await f.receive("customer", "Help please");
    const processing = f.service.tick();
    await start;
    await f.service.repos.setOwner(f.actor, conversation.id, "staff");
    release();
    await processing;
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(0);
    expect(
      (await f.service.repos.snapshot(f.actor, conversation.id)).messages.filter(
        (m) => m.role === "bot",
      ),
    ).toHaveLength(0);
    await f.service.repos.reply(f.actor, conversation.id, "A person can help", "same-nonce");
    await f.service.repos.reply(f.actor, conversation.id, "A person can help", "same-nonce");
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(1);
    await f.service.repos.setOwner(f.actor, conversation.id, "bot");
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(1);
    await f.receive("customer", "Thank you");
    await f.service.tick();
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(2);
  });
  it("retries an accepted LINE push with the same durable UUID after losing the response", async () => {
    const f = await fixture();
    const row = await f.receive("customer", "Hello");
    await f.service.tick();
    f.emulator.loseResponse = true;
    await f.service.tick();
    let snapshot = await f.service.repos.snapshot(f.actor, row.id);
    expect(snapshot.messages.at(-1)?.status).toBe("queued");
    await f.service.tick();
    expect(f.emulator.attempts).toHaveLength(1); // Backoff prevents an immediate retry.
    await db.prisma.customerMessage.updateMany({
      where: { conversationId: row.id, role: "bot" },
      data: { nextAttemptAt: new Date(0) },
    });
    await f.service.tick();
    snapshot = await f.service.repos.snapshot(f.actor, row.id);
    expect(snapshot.messages.at(-1)?.status).toBe("sent");
    expect(f.emulator.sent).toHaveLength(1);
    expect(f.emulator.attempts.map((request) => request.headers["x-line-retry-key"])).toEqual([
      snapshot.messages.at(-1)!.id,
      snapshot.messages.at(-1)!.id,
    ]);
  });
  it.each(["instagram", "tiktok"] as const)(
    "does not retry ambiguous %s sends",
    async (provider) => {
      const f = await fixture(undefined, provider);
      const row = await f.receive("customer", "Hello");
      await f.service.tick();
      f.emulator.failSend = true;
      await f.service.tick();
      await f.service.tick();
      expect(f.emulator.attempts).toHaveLength(1);
      expect((await f.service.repos.snapshot(f.actor, row.id)).conversation).toMatchObject({
        owner: "staff",
        needsHuman: true,
      });
    },
  );
  it("rejects another member of the same space consistently", async () => {
    const f = await fixture();
    const row = await f.receive("customer", "Hello");
    const other = { ...f.actor, userId: "other-member" };
    expect(await f.service.repos.channels(other)).toEqual([]);
    expect(await f.service.repos.list(other)).toEqual([]);
    await expect(f.service.repos.snapshot(other, row.id)).rejects.toThrow();
    await expect(f.service.repos.setOwner(other, row.id, "staff")).rejects.toThrow();
    await expect(f.service.repos.reply(other, row.id, "Hello", "nonce")).rejects.toThrow();
    await expect(f.service.setChannelEnabled(other, f.channel.id, false)).rejects.toThrow();
  });
  it("flags a runtime handoff and leaves later messages for staff", async () => {
    const f = await fixture(async function* (request) {
      await request.executeTool!("request_human_handoff", {}, "handoff");
      yield { type: "done", text: "" };
    });
    const row = await f.receive("customer", "I need a person");
    await f.service.tick();
    const snapshot = await f.service.repos.snapshot(f.actor, row.id);
    expect(snapshot.conversation).toMatchObject({ owner: "staff", needsHuman: true });
    await f.receive("customer", "More information");
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(0);
    expect((await f.service.repos.snapshot(f.actor, row.id)).messages.at(-1)?.status).toBe(
      "received",
    );
    await f.service.repos.setOwner(f.actor, row.id, "bot");
    expect((await f.service.repos.snapshot(f.actor, row.id)).conversation.needsHuman).toBe(false);
  });
  it("cancels queued staff replies across disconnect and reconnect", async () => {
    const f = await fixture();
    const row = await f.receive("customer", "Hello");
    await f.service.repos.setOwner(f.actor, row.id, "staff");
    await f.service.repos.reply(f.actor, row.id, "Old reply", "old");
    await f.service.setChannelEnabled(f.actor, f.channel.id, false);
    await f.service.setChannelEnabled(f.actor, f.channel.id, true);
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(0);
    expect((await f.service.repos.snapshot(f.actor, row.id)).messages.at(-1)?.status).toBe(
      "cancelled",
    );
  });
  it("invalidates a pending answer when channel credentials are replaced", async () => {
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async function* () {
      started();
      await gate;
      yield { type: "done", text: "Old answer" };
    });
    const row = await f.receive("customer", "Hello");
    const processing = f.service.tick();
    await start;
    await f.service.connect(f.actor, {
      ...f.channel,
      credentials: { accessToken: "replacement-token", channelSecret: "replacement-secret" },
    });
    release();
    await processing;
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(0);
    expect((await f.service.repos.snapshot(f.actor, row.id)).conversation.owner).toBe("staff");
  });
  it("keeps preceding replies in context when a customer sends two messages quickly", async () => {
    const f = await fixture();
    await f.receive("customer", "First question");
    await f.receive("customer", "Second question");
    await f.service.tick();
    await f.service.tick();
    await f.service.tick();
    expect(f.requests[1]?.history).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Reply to First question" },
    ]);
  });
  it("does not reopen a reply window when an old webhook is delivered late", async () => {
    const f = await fixture();
    const id = await f.service.repos.receive(f.channel.id, {
      threadId: `line:${f.channel.accountId}:customer`,
      handle: "old-message",
      from: "customer",
      fromLabel: null,
      content: "Old question",
      mediaUrl: null,
      sentAt: Date.now() - 8 * 86400000,
    });
    await f.service.tick();
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(0);
    expect((await f.service.repos.snapshot(f.actor, id!)).conversation.owner).toBe("staff");
  });
  it("recovers an interrupted LINE send with the original retry key", async () => {
    const f = await fixture();
    const row = await f.receive("customer", "Hello");
    await f.service.tick();
    await db.prisma.customerConversation.update({
      where: { id: row.id },
      data: {
        leaseToken: "interrupted",
        leaseUntil: new Date(0),
      },
    });
    await db.prisma.customerMessage.updateMany({
      where: { conversationId: row.id, role: "bot" },
      data: { status: "sending" },
    });
    await f.service.tick();
    await f.service.tick();
    const snapshot = await f.service.repos.snapshot(f.actor, row.id);
    expect(f.emulator.sent).toHaveLength(1);
    expect(snapshot.conversation.owner).toBe("bot");
    expect(snapshot.messages.at(-1)?.status).toBe("sent");
  });
  it.each(["expired", "exhausted"])(
    "does not resend a LINE push with an %s retry budget",
    async (condition) => {
      const f = await fixture();
      const row = await f.receive("customer", "Hello");
      await f.service.tick();
      await db.prisma.customerMessage.updateMany({
        where: { conversationId: row.id, role: "bot" },
        data: {
          sendAttempts: condition === "exhausted" ? 5 : 1,
          ...(condition === "expired" ? { createdAt: new Date(Date.now() - 25 * 3600000) } : {}),
        },
      });
      await f.service.tick();
      expect(f.emulator.sent).toHaveLength(0);
      expect((await f.service.repos.snapshot(f.actor, row.id)).conversation).toMatchObject({
        owner: "staff",
        needsHuman: true,
      });
    },
  );
  it("stops queued work after the channel owner's membership is removed", async () => {
    const f = await fixture();
    const row = await f.receive("customer", "Hello");
    await f.service.tick();
    await db.prisma.spaceMember.delete({ where: { spaceId_userId: f.actor } });
    await f.service.tick();
    expect(f.emulator.sent).toHaveLength(0);
    expect((await f.service.repos.snapshot(f.actor, row.id)).messages.at(-1)?.status).toBe(
      "failed",
    );
  });
});
