import { createHmac, randomUUID } from "node:crypto";
import type { AdapterContext, CustomerRuntime, JobPublisher } from "@rakazo/adapter-kit";
import { CustomerBindingSchema } from "@rakazo/contracts";
import {
  createCustomerInbox,
  createCustomerRepos,
  createDb,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerConversations } from "./customer-conversations.js";
import { createCustomerIngress } from "./customer-ingress.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { createOpenConnectorFixture } from "./open-connector-test-fixture.js";
import { serializeModelSecret } from "./pi-oauth.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const since = new Date("2026-01-01T00:00:00Z");
function binding(provider = "sample") {
  return CustomerBindingSchema.parse({
    receive: {
      action: `${provider}.list`,
      input: {},
      items: ["messages"],
      cursor: ["cursor"],
      incoming: { path: ["incoming"], equals: true },
      fields: {
        id: ["id"],
        threadId: ["thread"],
        customerId: ["user"],
        body: ["body"],
        timestamp: ["at"],
      },
    },
    send: {
      action: `${provider}.send`,
      input: { to: "$threadId", texts: ["$body"], retryKey: "$messageId" },
    },
  });
}
const incoming = (id = "one", thread = "thread") => ({
  id,
  thread,
  user: "customer",
  body: `question ${id}`,
  at: "2026-01-02T00:00:00Z",
  incoming: true,
});

describe.skipIf(!enabled)(
  "customer conversation conformance with PostgreSQL and OpenConnector",
  () => {
    let db: ReturnType<typeof createDb>;
    let f: ReturnType<typeof createOpenConnectorFixture>;
    let service: ReturnType<typeof createCustomerConversations>;
    let owners: Array<Awaited<ReturnType<typeof provisionMessagingIdentity>>>;
    let feeds: Map<string, unknown[]>;
    let reply: ReturnType<typeof vi.fn<CustomerRuntime["reply"]>>;
    let failSend: boolean;
    let flowOrdinal = 0;
    let businessHandler: ((action: string, input: Record<string, unknown>) => unknown) | undefined;
    let holdSend: Promise<unknown> | undefined;
    let sendStarted: (() => void) | undefined;
    const sends: Array<{ action: string; input: unknown; alias: string }> = [];
    beforeAll(() => {
      db = createDb(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await db?.prisma.$disconnect();
      await db?.pool.end();
    });
    beforeEach(() => {
      owners = [];
      feeds = new Map();
      sends.length = 0;
      failSend = false;
      flowOrdinal = 0;
      businessHandler = undefined;
      holdSend = undefined;
      sendStarted = undefined;
      f = createOpenConnectorFixture((action, input, alias) => {
        if (action.endsWith(".list")) return { messages: feeds.get(alias) ?? [], cursor: "next" };
        if (/\.(order|promotion|refund)$/.test(action))
          return businessHandler?.(action, input as Record<string, unknown>);
        if (failSend) throw new Error("Unknown send outcome");
        sends.push({ action, input, alias });
        sendStarted?.();
        return holdSend ?? { id: "confirmed" };
      });
      for (const provider of ["sample", "another-messenger"]) {
        if (provider !== "sample")
          f.providers.push({
            ...f.providers[0]!,
            service: provider,
            displayName: "Another messenger",
            actions: [
              { ...f.providers[0]!.actions[0]!, id: `${provider}.send`, service: provider },
            ],
          });
        f.providers
          .find((p) => p.service === provider)!
          .actions.push({
            id: `${provider}.list`,
            service: provider,
            description: "Read incoming messages",
            execution: { locallyExecutable: true },
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          });
      }
      reply = vi.fn(async (request) => `reply from ${request.flowId}`);
      service = createCustomerConversations({
        prisma: db.prisma,
        secrets: f.secrets,
        integrations: new IntegrationProviderSettings(db.prisma, f.secrets, "test", {
          "open-connector": f.adapter,
        }),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        runtime: () => ({ reply, publish: async () => `flow-${++flowOrdinal}` }),
      });
    });
    afterEach(async () => {
      for (const owner of owners) {
        await db.prisma.space.delete({ where: { id: owner.spaceId } });
        await db.prisma.user.delete({ where: { id: owner.userId } });
      }
    });
    async function setup(provider = "sample") {
      const owner = await provisionMessagingIdentity(
        db.prisma,
        { provider: "test", address: randomUUID() },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
      owners.push(owner);
      const context: AdapterContext = {
        ...owner,
        operationId: "setup",
        traceId: "setup",
        signal: new AbortController().signal,
      };
      const auth = await f.adapter.begin(
        { provider, redirectUrl: "https://example.test", credential: "fake-account-token" },
        context,
      );
      const account = await db.prisma.connection.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          connectorId: "open-connector",
          provider,
          displayName: "Support",
          status: "connected",
          providerRef: auth.state,
        },
      });
      const stored = await f.secrets.put(
        serializeModelSecret({
          kind: "openai_compatible",
          baseUrl: "https://runtime.example.test/v1",
          apiKey: "fake-runtime-key",
        }),
        context,
      );
      await db.prisma.secret.create({ data: { ...stored, userId: owner.userId, kind: "model" } });
      const credential = await db.prisma.userModelCredential.create({
        data: {
          userId: owner.userId,
          provider: "openai-compatible",
          label: "Customer service",
          secretId: stored.id,
        },
      });
      await service.manage(owner, owner.botId, "configure", {
        credentialId: credential.id,
        instructions: "Public menu only",
      });
      await service.manage(owner, owner.botId, "connect", {
        connectionId: account.id,
        binding: binding(provider),
      });
      const channel = await db.prisma.customerChannel.findUniqueOrThrow({
        where: { connectionId: account.id },
      });
      await db.prisma.customerChannel.update({
        where: { id: channel.id },
        data: { startedAt: since, nextPollAt: since },
      });
      return { owner, channel, account, alias: auth.state, credential };
    }
    async function receive(fixture: Awaited<ReturnType<typeof setup>>, messages = [incoming()]) {
      feeds.set(fixture.alias, messages);
      await db.prisma.customerChannel.update({
        where: { id: fixture.channel.id },
        data: { nextPollAt: since },
      });
      await service.poll(fixture.channel.id);
      return db.prisma.customerConversation.findFirstOrThrow({
        where: { channelId: fixture.channel.id },
      });
    }
    it("runs two apps and two staff through the same pipeline without leaking history or credentials", async () => {
      const a = await setup();
      const b = await setup("another-messenger");
      const ca = await receive(a);
      const cb = await receive(b, [incoming("other")]);
      await Promise.all([service.process(ca.id), service.process(cb.id)]);
      expect(sends).toHaveLength(2);
      expect(sends).toEqual(
        expect.arrayContaining([
          {
            action: "sample.send",
            alias: a.alias,
            input: {
              to: "thread",
              texts: ["reply from flow-1"],
              retryKey: expect.any(String),
            },
          },
          {
            action: "another-messenger.send",
            alias: b.alias,
            input: {
              to: "thread",
              texts: ["reply from flow-2"],
              retryKey: expect.any(String),
            },
          },
        ]),
      );
      expect(reply.mock.calls.find(([r]) => r.flowId === "flow-1")![0].messages).toEqual([
        { role: "user", content: "question one" },
      ]);
      expect(JSON.stringify(reply.mock.calls)).not.toContain("fake-runtime-key");
      await expect(createCustomerRepos(db.prisma).snapshot(b.owner, ca.id)).rejects.toThrow();
      expect(
        (await service.activity(a.owner, a.owner.botId, since, new Date("2100-01-01"))).replies,
      ).toBe(1);
    });
    it("deduplicates polls and concurrent input, serializes turns, and retains prior delivered replies", async () => {
      const a = await setup();
      const c = await receive(a, [incoming("one"), incoming("two")]);
      await receive(a, [incoming("one"), incoming("two")]);
      const inbox = createCustomerInbox(db.prisma);
      await Promise.all(
        Array.from({ length: 3 }, () =>
          inbox.receive(a.channel.id, {
            externalId: "one",
            externalThreadId: "thread",
            customerId: "customer",
            name: "Customer",
            body: "question one",
          }),
        ),
      );
      expect(await db.prisma.customerMessage.count({ where: { conversationId: c.id } })).toBe(2);
      await Promise.all([service.process(c.id), service.process(c.id)]);
      await service.process(c.id);
      expect(sends).toHaveLength(2);
      expect(reply.mock.calls[1]![0].messages).toEqual([
        { role: "user", content: "question one" },
        { role: "assistant", content: "reply from flow-1" },
        { role: "user", content: "question two" },
      ]);
    });
    it("fences generation during takeover and supports idempotent human replies", async () => {
      const a = await setup();
      const c = await receive(a);
      let finish!: (text: string) => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      reply.mockImplementation(async () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const processing = service.process(c.id);
      await running;
      const inbox = createCustomerInbox(db.prisma);
      await inbox.setOwner(a.owner, c.id, "staff");
      finish("stale reply");
      await processing;
      expect(sends).toHaveLength(0);
      const manual = { id: c.id, body: "I can help", nonce: "one-nonce" };
      await Promise.all([inbox.reply(a.owner, manual), inbox.reply(a.owner, manual)]);
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      expect(sends[0]?.input).toMatchObject({ texts: ["I can help"] });
      await expect(inbox.reply(a.owner, { ...manual, body: "different" })).rejects.toThrow();
    });
    it("lets an already dispatched send finish before a takeover reply is sent", async () => {
      const a = await setup();
      const c = await receive(a);
      let finish!: (value: unknown) => void;
      holdSend = new Promise((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        sendStarted = resolve;
      });
      const processing = service.process(c.id);
      await started;
      const inbox = createCustomerInbox(db.prisma);
      await inbox.setOwner(a.owner, c.id, "staff");
      await inbox.reply(a.owner, { id: c.id, body: "Follow-up from me", nonce: "manual" });
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      finish({ id: "accepted" });
      await processing;
      holdSend = undefined;
      await service.process(c.id);
      expect(sends).toHaveLength(2);
      expect(
        await db.prisma.customerMessage.count({ where: { conversationId: c.id, status: "sent" } }),
      ).toBe(2);
      expect(
        await db.prisma.customerMessage.count({
          where: { conversationId: c.id, status: "failed" },
        }),
      ).toBe(0);
    });

    it("does not replay uncertain sends or executions after a worker crash", async () => {
      const a = await setup();
      const c = await receive(a);
      failSend = true;
      await service.process(c.id);
      failSend = false;
      flowOrdinal = 0;
      businessHandler = undefined;
      await service.process(c.id);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(sends).toHaveLength(0);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ owner: "staff", needsHuman: true });
      await db.prisma.customerMessage.create({
        data: { conversationId: c.id, seq: 99, role: "bot", body: "uncertain", status: "sending" },
      });
      await service.process(c.id);
      expect(sends).toHaveLength(0);
    });
    it("blocks revoked accounts, cross-owner configuration, and archived sending", async () => {
      const a = await setup();
      const b = await setup("another-messenger");
      const c = await receive(a);
      await expect(
        service.manage(b.owner, a.owner.botId, "configure", {
          credentialId: b.credential.id,
          flowId: "bad",
          instructions: "bad",
        }),
      ).rejects.toThrow();
      await expect(
        service.manage(a.owner, a.owner.botId, "configure", {
          credentialId: b.credential.id,
          flowId: "bad",
          instructions: "bad",
        }),
      ).rejects.toThrow();
      await db.prisma.connection.update({
        where: { id: a.account.id },
        data: { status: "disconnected" },
      });
      await service.process(c.id);
      expect(reply).not.toHaveBeenCalled();
      expect(sends).toHaveLength(0);
      await service.manage(a.owner, a.owner.botId, "disconnect", { channelId: a.channel.id });
      await expect(
        createCustomerInbox(db.prisma).reply(a.owner, { id: c.id, body: "hello", nonce: "x" }),
      ).rejects.toThrow("archived");
      expect(
        (await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).conversation.canReply,
      ).toBe(false);
    });
    it("updates public instructions without expanding grants and captures the revision", async () => {
      const a = await setup();
      const before = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      await service.manage(a.owner, a.owner.botId, "instructions", {
        instructions: "Check the approved Friday offer before summarizing orders",
        knowledgeFilterId: "ungranted",
      });
      const after = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      expect(after).toMatchObject({
        credentialId: before.credentialId,
        flowId: "flow-2",
        knowledgeFilterId: before.knowledgeFilterId,
        revision: before.revision + 1,
      });
      const c = await receive(a);
      await service.process(c.id);
      expect(reply.mock.calls[0]![0].instructions).toContain("Friday offer");
      expect(
        await db.prisma.customerMessage.findFirst({ where: { conversationId: c.id, role: "bot" } }),
      ).toMatchObject({ behaviorRevision: after.revision });
    });

    it("accepts authenticated webhook events once and rejects forgery and disconnected accounts", async () => {
      const a = await setup();
      const keyId = randomUUID();
      await db.prisma.secret.create({
        data: {
          id: keyId,
          userId: a.owner.userId,
          spaceId: a.owner.spaceId,
          kind: "webhook",
          ciphertext: f.secrets.seal("fake-webhook-key", keyId),
        },
      });
      await service.manage(a.owner, a.owner.botId, "connect", {
        connectionId: a.account.id,
        binding: {
          ...binding(),
          receive: {
            ...binding().receive,
            mode: "webhook",
            account: { path: ["account"], equals: "account" },
            webhook: { secretId: keyId, header: "x-line-signature", encoding: "base64" },
          },
        },
      });
      const ingress = createCustomerIngress({
        prisma: db.prisma,
        secrets: f.secrets,
        integrations: new IntegrationProviderSettings(db.prisma, f.secrets, "test", {
          "open-connector": f.adapter,
        }),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
      });
      const raw = JSON.stringify({
        account: "account",
        messages: [{ ...incoming(), at: new Date(Date.now() + 1000).toISOString() }],
      });
      const headers = new Headers({
        "x-line-signature": createHmac("sha256", "fake-webhook-key").update(raw).digest("base64"),
      });
      await expect(ingress.receive(a.channel.id, new Headers(), raw)).rejects.toThrow();
      await ingress.receive(a.channel.id, headers, raw);
      await ingress.receive(a.channel.id, headers, raw);
      const c = await db.prisma.customerConversation.findFirstOrThrow({
        where: { channelId: a.channel.id },
      });
      expect(await db.prisma.customerMessage.count({ where: { conversationId: c.id } })).toBe(1);
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      await service.manage(a.owner, a.owner.botId, "disconnect", { channelId: a.channel.id });
      await expect(ingress.receive(a.channel.id, headers, raw)).rejects.toThrow();
    });

    it("reconfigures during generation without disabling automatic replies", async () => {
      const a = await setup();
      const c = await receive(a);
      let finish!: (value: string) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      reply.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const processing = service.process(c.id);
      await ready;
      await service.manage(a.owner, a.owner.botId, "connect", {
        connectionId: a.account.id,
        binding: binding(),
      });
      finish("stale response");
      await processing;
      await service.reconcile();
      await service.process(c.id);
      const current = await db.prisma.customerConversation.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(current).toMatchObject({ owner: "bot", needsHuman: false });
      expect(sends).toHaveLength(0);
      expect(
        await db.prisma.customerMessage.count({
          where: { conversationId: c.id, status: "processing" },
        }),
      ).toBe(0);
    });

    it("executes a scoped refund workflow once and revokes the execution after the turn", async () => {
      const actions = f.providers[0]!.actions;
      for (const suffix of ["order", "promotion", "refund"])
        actions.push({
          ...actions[0]!,
          id: `sample.${suffix}`,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        });
      const a = await setup();
      // These three actions use the fixture's real OpenConnector transport.
      const grant = {
        name: "refund_order",
        description: "Refund a customer-owned order after checking the promotion",
        connectionId: a.account.id,
        inputSchema: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
          additionalProperties: false,
        },
        steps: [
          {
            name: "owner",
            action: "sample.order",
            input: { orderId: "$input.orderId" },
            effect: "read",
            check: { path: ["customerId"], equals: "$customerId" },
          },
          {
            name: "promotion",
            action: "sample.promotion",
            input: {},
            effect: "read",
            check: { path: ["active"], equals: true },
          },
          {
            name: "refund",
            action: "sample.refund",
            input: { orderId: "$input.orderId", amount: "$steps.owner.total" },
            effect: "write",
          },
        ],
      };
      businessHandler = (action, input) => {
        if (action.endsWith(".order"))
          return { customerId: input.orderId === "mine" ? "customer" : "someone-else", total: 20 };
        if (action.endsWith(".promotion")) return { active: true };
        if (action.endsWith(".refund")) {
          refunds++;
          return { refunded: true };
        }
      };
      await service.manage(a.owner, a.owner.botId, "configure", {
        credentialId: a.credential.id,
        instructions: "Check promotion",
        actions: [grant],
      });
      const c = await receive(a);
      let token = "";
      let refunds = 0;
      reply.mockImplementationOnce(async (request) => {
        token = request.executionContext!.token;
        expect(await service.tools.list(token)).toMatchObject({
          tools: [{ name: "refund_order" }],
        });
        await expect(
          service.tools.execute(token, {
            name: "refund_order",
            callId: "foreign",
            arguments: { orderId: "not-mine" },
          }),
        ).rejects.toThrow();
        expect(refunds).toBe(0);
        const result = await service.tools.execute(token, {
          name: "refund_order",
          callId: "once",
          arguments: { orderId: "mine" },
        });
        expect(result).toEqual({ refunded: true });
        await service.tools.execute(token, {
          name: "refund_order",
          callId: "repeated-model-call",
          arguments: { orderId: "mine" },
        });
        expect(refunds).toBe(1);
        await service.manage(a.owner, a.owner.botId, "configure", {
          credentialId: a.credential.id,
          instructions: "Stop refunds",
          actions: [],
        });
        await expect(service.tools.list(token)).rejects.toThrow();
        await expect(
          service.tools.execute(token, {
            name: "refund_order",
            callId: "after-revoke",
            arguments: { orderId: "mine" },
          }),
        ).rejects.toThrow();
        return "Refund completed";
      });
      await service.process(c.id);
      await reply.mock.results[0]!.value;
      expect(refunds).toBe(1);
      await expect(service.tools.list(token)).rejects.toThrow();
      expect(
        await db.prisma.customerToolCall.count({
          where: { message: { conversationId: c.id }, status: "completed" },
        }),
      ).toBe(1);
    });

    it("authorizes group actions as the current sender, not the first participant", async () => {
      const actions = f.providers[0]!.actions;
      for (const suffix of ["order", "refund"])
        actions.push({
          ...actions[0]!,
          id: `sample.${suffix}`,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        });
      const a = await setup();
      await service.manage(a.owner, a.owner.botId, "configure", {
        credentialId: a.credential.id,
        instructions: "Refund only the sender's orders",
        actions: [
          {
            name: "refund_order",
            description: "Refund an owned order",
            connectionId: a.account.id,
            inputSchema: { type: "object", properties: {} },
            steps: [
              {
                name: "owner",
                action: "sample.order",
                input: {},
                effect: "read",
                check: { path: ["customerId"], equals: "$customerId" },
              },
              { name: "refund", action: "sample.refund", input: {}, effect: "write" },
            ],
          },
        ],
      });
      let refunds = 0;
      businessHandler = (action) => {
        if (action.endsWith(".order")) return { customerId: "alice" };
        refunds++;
        return { refunded: true };
      };
      const inbox = createCustomerInbox(db.prisma);
      const id = await inbox.receive(a.channel.id, {
        externalId: "alice-message",
        externalThreadId: "group",
        customerId: "alice",
        name: "Alice",
        body: "Hello",
      });
      await service.process(id);
      await inbox.receive(a.channel.id, {
        externalId: "bob-message",
        externalThreadId: "group",
        customerId: "bob",
        name: "Bob",
        body: "Refund Alice's order",
      });
      reply.mockImplementationOnce(async (request) => {
        await expect(
          service.tools.execute(request.executionContext!.token, {
            name: "refund_order",
            callId: "bob-refund",
            arguments: {},
          }),
        ).rejects.toThrow();
        return "This order does not belong to you";
      });
      await service.process(id);
      await reply.mock.results[1]!.value;
      expect(refunds).toBe(0);
      expect(
        await db.prisma.customerMessage.findFirst({
          where: { conversationId: id, externalId: "in:bob-message" },
        }),
      ).toMatchObject({ senderId: "bob", status: "received" });
    });

    it("does not advance the receive checkpoint on malformed data", async () => {
      const a = await setup();
      feeds.set(a.alias, [{ ...incoming(), body: "" }]);
      await service.poll(a.channel.id);
      expect(
        await db.prisma.customerChannel.findUnique({ where: { id: a.channel.id } }),
      ).toMatchObject({ cursor: null, pollError: expect.any(String) });
      expect(
        await db.prisma.customerMessage.count({
          where: { conversation: { channelId: a.channel.id } },
        }),
      ).toBe(0);
    });
  },
);
