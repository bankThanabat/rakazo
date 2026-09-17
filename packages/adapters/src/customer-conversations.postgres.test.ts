import { createHmac, randomUUID } from "node:crypto";
import type { AdapterContext, CustomerRuntime, JobPublisher } from "@rakazo/adapter-kit";
import { CustomerBindingSchema } from "@rakazo/contracts";
import {
  configureCustomerReplies,
  createCustomerInbox,
  createCustomerRepos,
  createDb,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionActionSettings } from "./connection-action-settings.js";
import { createCustomerConversations } from "./customer-conversations.js";
import { createCustomerIngress } from "./customer-ingress.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { createKnowledge } from "./knowledge.js";
import { createKnowledgeFixture } from "./knowledge-test-fixture.js";
import { createModelBridge } from "./model-bridge.js";
import { createOpenConnectorFixture, sampleAction } from "./open-connector-test-fixture.js";
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
    let knowledge: ReturnType<typeof createKnowledge>;
    let knowledgeFixture: ReturnType<typeof createKnowledgeFixture>;
    let owners: Array<Awaited<ReturnType<typeof provisionMessagingIdentity>>>;
    let feeds: Map<string, unknown[]>;
    let reply: ReturnType<typeof vi.fn<CustomerRuntime["reply"]>>;
    let search: ReturnType<typeof vi.fn<NonNullable<CustomerRuntime["search"]>>>;
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
      // Exercise a connector that requires UUID delivery keys, not arbitrary strings.
      f.providers[0]!.actions = f.providers[0]!.actions.map((action) => ({
        ...action,
        inputSchema: {
          ...sampleAction.inputSchema,
          properties: {
            ...sampleAction.inputSchema.properties,
            retryKey: { type: "string", format: "uuid" },
          },
        },
      }));
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
      search = vi.fn(async () => ({ results: [] }));
      knowledgeFixture = createKnowledgeFixture();
      knowledge = createKnowledge({
        prisma: db.prisma,
        artifacts: knowledgeFixture.artifacts,
        jobs: knowledgeFixture.jobs,
        secrets: f.secrets,
        provider: () => knowledgeFixture.provider,
      });
      service = createCustomerConversations({
        knowledge,
        prisma: db.prisma,
        secrets: f.secrets,
        integrations: new IntegrationProviderSettings(db.prisma, f.secrets, "test", {
          "open-connector": f.adapter,
        }),
        jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
        runtime: () => ({ reply, search, publish: async () => `flow-${++flowOrdinal}` }),
      });
    });
    afterEach(async () => {
      for (const owner of owners) {
        await db.prisma.space.delete({ where: { id: owner.spaceId } });
        await db.prisma.user.delete({ where: { id: owner.userId } });
      }
    });
    async function saveServices(owner: { userId: string; spaceId: string; botId: string }) {
      for (const [name, origin] of [
        ["runtime", "https://runtime.example.test"],
        ["knowledge", "https://rag.example.test"],
      ]) {
        const id = randomUUID();
        await db.prisma.botSecret.create({
          data: {
            id,
            userId: owner.userId,
            spaceId: owner.spaceId,
            botId: owner.botId,
            name: name!,
            origin: origin!,
            auth: { type: "header", name: "x-api-key" },
            ciphertext: f.secrets.seal("fixture-service-key", id),
          },
        });
      }
    }
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
          actionPolicy: {
            defaults: Object.fromEntries(
              f.providers
                .find((item) => item.service === provider)!
                .actions.map((action) => [action.id, false]),
            ),
          },
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
      await saveServices(owner);
      await service.manage(owner, owner.botId, "configure", {
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: credential.id,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
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
    it("auto replies toggle resumes existing chats, ignores the backlog and preserves manual replies", async () => {
      const a = await setup();
      const configure = (enabled: boolean) =>
        configureCustomerReplies(db.prisma, a.owner, {
          connectionId: a.account.id,
          enabled,
        });
      await configure(false);
      const c = await receive(a);
      await service.process(c.id);
      expect(reply).not.toHaveBeenCalled();
      expect(sends).toHaveLength(0);
      await configure(true);
      await service.process(c.id);
      expect(sends).toHaveLength(0);
      await receive(a, [incoming("two")]);
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      await receive(a, [incoming("three")]);
      await configure(false);
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      await receive(a, [incoming("four")]);
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      const inbox = createCustomerInbox(db.prisma);
      await inbox.reply(a.owner, { id: c.id, body: "Manual reply", nonce: randomUUID() });
      // Repeated off requests must not cancel a human's queued reply.
      await configure(false);
      await service.process(c.id);
      expect(sends).toHaveLength(2);
      expect(sends[1]?.input).toMatchObject({ texts: ["Manual reply"] });
      await configure(true);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ owner: "staff" });
    });

    it("still sends a queued handoff notice after auto replies are turned off", async () => {
      const a = await setup();
      const c = await receive(a);
      reply.mockImplementationOnce(async (request) => {
        await service.tools.execute(request.executionContext!.token, {
          name: "request_human",
          callId: "handoff",
          arguments: { reason: "Customer asks for a person" },
        });
        return "This model continuation must not be delivered";
      });
      await service.process(c.id);
      await configureCustomerReplies(db.prisma, a.owner, {
        connectionId: a.account.id,
        enabled: false,
      });
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      expect(JSON.stringify(sends[0]?.input)).toContain("A support agent will follow up here.");
    });

    it("turning auto replies off fences generation already in progress", async () => {
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
      await configureCustomerReplies(db.prisma, a.owner, {
        connectionId: a.account.id,
        enabled: false,
      });
      finish("Do not send this");
      await processing;
      expect(sends).toHaveLength(0);
    });

    it("reply assignment requires an owned active staff agent and configured customer behavior", async () => {
      const a = await setup();
      const b = await setup();
      await expect(
        configureCustomerReplies(db.prisma, b.owner, {
          connectionId: a.account.id,
          enabled: false,
        }),
      ).rejects.toThrow();
      await expect(
        configureCustomerReplies(
          db.prisma,
          { ...a.owner, spaceId: b.owner.spaceId },
          {
            connectionId: a.account.id,
            enabled: false,
          },
        ),
      ).rejects.toThrow();
      await expect(
        configureCustomerReplies(db.prisma, a.owner, {
          connectionId: a.account.id,
          enabled: true,
          botId: b.owner.botId,
        }),
      ).rejects.toThrow();
      const bot = await db.prisma.bot.create({
        data: {
          spaceId: a.owner.spaceId,
          userId: a.owner.userId,
          name: "Other staff",
          color: "blue",
        },
      });
      await expect(
        configureCustomerReplies(db.prisma, a.owner, {
          connectionId: a.account.id,
          enabled: true,
          botId: bot.id,
        }),
      ).rejects.toThrow("Set up customer replies");
      await configureCustomerReplies(db.prisma, a.owner, {
        connectionId: a.account.id,
        enabled: false,
        botId: bot.id,
      });
      expect(
        await db.prisma.customerChannel.findUnique({ where: { id: a.channel.id } }),
      ).toMatchObject({ botId: bot.id, autoReplies: false, enabled: true });
      const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      await db.prisma.customerBehavior.create({
        data: { botId: bot.id, flowId: behavior.flowId, instructions: behavior.instructions },
      });
      await configureCustomerReplies(db.prisma, a.owner, {
        connectionId: a.account.id,
        enabled: true,
        botId: bot.id,
      });
      expect(
        await db.prisma.customerChannel.findUnique({ where: { id: a.channel.id } }),
      ).toMatchObject({ botId: bot.id, autoReplies: true });
      await db.prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: new Date() } });
      await expect(
        configureCustomerReplies(db.prisma, a.owner, {
          connectionId: a.account.id,
          enabled: true,
          botId: bot.id,
        }),
      ).rejects.toThrow();
    });

    it("keeps polling other customers and checkpoints after a sender exceeds their quota", async () => {
      const a = await setup();
      await db.prisma.customerChannel.update({
        where: { id: a.channel.id },
        data: { hourlyCustomerLimit: 1 },
      });
      await receive(a, [
        incoming("01"),
        incoming("02"),
        { ...incoming("03", "other-thread"), user: "other-customer" },
      ]);
      expect(
        await db.prisma.customerMessage.findMany({
          where: { conversation: { channelId: a.channel.id } },
          orderBy: { externalId: "asc" },
          select: { externalId: true },
        }),
      ).toEqual([{ externalId: "in:01" }, { externalId: "in:03" }]);
      expect(
        await db.prisma.customerChannel.findUnique({ where: { id: a.channel.id } }),
      ).toMatchObject({ cursor: "next", pollError: null });
    });
    it("shares cases only with live space members and revokes access when made private", async () => {
      const a = await setup();
      const b = await setup();
      const conversation = await receive(a);
      const teammate = { userId: b.owner.userId, spaceId: a.owner.spaceId };
      const { organizationId } = await db.prisma.space.findUniqueOrThrow({
        where: { id: a.owner.spaceId },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: teammate.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      const repos = createCustomerRepos(db.prisma);
      await expect(repos.snapshot(teammate, conversation.id)).rejects.toThrow();
      await service.manage(a.owner, a.owner.botId, "channel", { id: a.channel.id, shared: true });
      expect((await repos.snapshot(teammate, conversation.id)).conversation.id).toBe(
        conversation.id,
      );
      await createCustomerInbox(db.prisma).updateCase(teammate, {
        id: conversation.id,
        assigneeId: teammate.userId,
        read: true,
      });
      expect((await repos.snapshot(teammate, conversation.id)).conversation).toMatchObject({
        assigneeId: teammate.userId,
        unread: false,
      });
      await service.manage(a.owner, a.owner.botId, "channel", { id: a.channel.id, shared: false });
      await expect(repos.snapshot(teammate, conversation.id)).rejects.toThrow();
      await expect(
        createCustomerInbox(db.prisma).reply(teammate, {
          id: conversation.id,
          body: "Private",
          nonce: randomUUID(),
        }),
      ).rejects.toThrow();
    });

    it("uses the selected case's approved knowledge for a teammate and rechecks sharing", async () => {
      const a = await setup();
      const b = await setup();
      const conversation = await receive(a);
      const teammate = { userId: b.owner.userId, spaceId: a.owner.spaceId };
      const { organizationId } = await db.prisma.space.findUniqueOrThrow({
        where: { id: a.owner.spaceId },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: teammate.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      const bot = await db.prisma.bot.create({
        data: {
          ...teammate,
          name: "Staff assistant",
          color: "blue",
          thread: { create: teammate },
        },
      });
      await service.manage(a.owner, a.owner.botId, "configure", {
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: a.credential.id,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
        instructions: "Public rules",
        knowledgeFilterId: "case-sources",
      });
      await saveServices({ ...teammate, botId: bot.id });
      await service.manage(teammate, bot.id, "configure", {
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: b.credential.id,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
        instructions: "Other rules",
        knowledgeFilterId: "other-sources",
      });
      const input = { id: conversation.id, query: "Return policy" };
      const repos = createCustomerRepos(db.prisma);
      await expect(repos.prepareInvestigation(teammate, conversation.id)).rejects.toThrow();
      await expect(service.manage(teammate, bot.id, "knowledge", input)).rejects.toThrow();
      expect(search).not.toHaveBeenCalled();
      await service.manage(a.owner, a.owner.botId, "channel", { id: a.channel.id, shared: true });
      expect(await repos.prepareInvestigation(teammate, conversation.id)).toMatchObject({
        botId: bot.id,
        text: expect.stringContaining(JSON.stringify(conversation.id)),
      });
      await service.manage(teammate, bot.id, "knowledge", input);
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeFilterId: "case-sources" }),
      );
      await service.manage(a.owner, a.owner.botId, "channel", { id: a.channel.id, shared: false });
      await expect(repos.prepareInvestigation(teammate, conversation.id)).rejects.toThrow();
      await expect(service.manage(teammate, bot.id, "knowledge", input)).rejects.toThrow();
      expect(search).toHaveBeenCalledTimes(1);
    });

    it("prefers the case's own assistant over an unrelated first assistant", async () => {
      const a = await setup();
      const conversation = await receive(a);
      await db.prisma.bot.create({
        data: {
          spaceId: a.owner.spaceId,
          userId: a.owner.userId,
          name: "Unrelated assistant",
          color: "blue",
          createdAt: new Date(0),
          thread: { create: { spaceId: a.owner.spaceId, userId: a.owner.userId } },
        },
      });
      const prepared = await createCustomerRepos(db.prisma).prepareInvestigation(
        a.owner,
        conversation.id,
      );
      expect(prepared.botId).toBe(a.owner.botId);
      expect(prepared.text).toContain("customer_knowledge with this case id");
      expect(prepared.text).toContain("Do not send a customer reply");
      expect(prepared.text).not.toContain(conversation.name);
    });

    it("deletes only resolved idle cases and expires their visitor capabilities", async () => {
      const a = await setup();
      const { channelId } = (await service.manage(a.owner, a.owner.botId, "website", {
        name: "Support",
        origins: ["https://shop.example.test"],
      })) as { channelId: string };
      const conversation = await db.prisma.customerConversation.create({
        data: {
          channelId,
          externalThreadId: "visitor",
          customerId: "visitor",
          name: "Visitor",
          visitorSessions: {
            create: {
              tokenHash: "fake-hash",
              origin: "https://shop.example.test",
              expiresAt: new Date(Date.now() + 60000),
            },
          },
        },
      });
      await expect(
        service.manage(a.owner, a.owner.botId, "delete", { id: conversation.id }),
      ).rejects.toThrow();
      await createCustomerInbox(db.prisma).updateCase(a.owner, {
        id: conversation.id,
        state: "resolved",
      });
      await service.manage(a.owner, a.owner.botId, "delete", { id: conversation.id });
      expect(
        await db.prisma.customerVisitorSession.count({
          where: { conversationId: conversation.id },
        }),
      ).toBe(0);
    });

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

    it("renews multipart delivery leases while competing workers reconcile", async () => {
      const a = await setup();
      const c = await receive(a);
      const format = binding();
      format.send.textLimit = { max: 4, unit: "characters" };
      await db.prisma.customerChannel.update({
        where: { id: a.channel.id },
        data: { binding: format },
      });
      reply.mockResolvedValueOnce("abcdefghijklmnop");
      const contenders: Promise<void>[] = [];
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        sendStarted = () => {
          vi.setSystemTime(Date.now() + 90000);
          contenders.push(service.process(c.id));
        };
        await service.process(c.id);
        await Promise.all(contenders);
        expect(sends).toHaveLength(4);
        expect(
          new Set(sends.map((send) => (send.input as { retryKey: string }).retryKey)).size,
        ).toBe(4);
        expect(
          await db.prisma.customerMessage.findFirst({
            where: { conversationId: c.id, role: "bot" },
          }),
        ).toMatchObject({ status: "sent", sentParts: 4 });
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject({ owner: "bot", needsHuman: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("splits Unicode replies into durable ordered sends without losing text", async () => {
      const f = await setup();
      const conversation = await receive(f);
      const body = "สวัสดี 🙂 ".repeat(500);
      reply.mockResolvedValueOnce(body);
      await service.process(conversation.id);
      const texts = sends.flatMap((send) => (send.input as { texts: string[] }).texts);
      expect(texts.join("")).toBe(body);
      expect(texts.every((text) => new TextEncoder().encode(text).length <= 1000)).toBe(true);
      const outbound = await db.prisma.customerMessage.findFirstOrThrow({
        where: { conversationId: conversation.id, role: "bot" },
      });
      expect(outbound).toMatchObject({ status: "sent", sentParts: texts.length });
    });

    it("a model handoff stops generation and sends a single acknowledgement", async () => {
      const f = await setup();
      const conversation = await receive(f);
      reply.mockImplementationOnce(async (request) => {
        await service.tools.execute(request.executionContext!.token, {
          name: "request_human",
          callId: "handoff",
          arguments: { reason: "Customer asks for a person" },
        });
        return "This model continuation must not be delivered";
      });
      await service.process(conversation.id);
      await service.process(conversation.id);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: conversation.id } }),
      ).toMatchObject({ owner: "staff", needsHuman: true });
      expect(sends).toHaveLength(1);
      expect(JSON.stringify(sends)).not.toContain("model continuation");
      expect(
        await db.prisma.customerToolCall.findFirst({ where: { name: "request_human" } }),
      ).toMatchObject({ status: "completed" });
    });

    it("resolved cases reopen, preserve unread state, and reject stale drafts", async () => {
      const f = await setup();
      const conversation = await receive(f);
      const inbox = createCustomerInbox(db.prisma);
      await inbox.updateCase(f.owner, { id: conversation.id, state: "resolved", read: true });
      expect((await createCustomerRepos(db.prisma).list(f.owner))[0]).toMatchObject({
        state: "resolved",
        unread: false,
      });
      await inbox.receive(f.channel.id, {
        externalId: "followup",
        externalThreadId: "thread",
        customerId: "customer",
        name: "Customer",
        body: "Another question",
      });
      expect((await createCustomerRepos(db.prisma).list(f.owner))[0]).toMatchObject({
        state: "open",
        unread: true,
        needsHuman: true,
      });
      await expect(
        service.manage(f.owner, f.owner.botId, "draft", {
          id: conversation.id,
          body: "Outdated",
          expectedSeq: 1,
        }),
      ).rejects.toThrow("changed");
    });

    it("website conversations use the same runtime without a connector account", async () => {
      const f = await setup();
      const result = (await service.manage(f.owner, f.owner.botId, "website", {
        name: "Website",
        origins: ["https://shop.example.test"],
      })) as { channelId: string };
      const id = await createCustomerInbox(db.prisma).receive(result.channelId, {
        externalId: "web-one",
        externalThreadId: "visitor",
        customerId: "visitor",
        name: "Visitor",
        body: "Hello",
      });
      await service.process(id);
      expect(
        await db.prisma.customerMessage.findFirst({ where: { conversationId: id, role: "bot" } }),
      ).toMatchObject({ status: "sent" });
      expect(sends).toHaveLength(0);
      expect(reply).toHaveBeenCalledTimes(1);
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
    it("binds service credentials to their destination and revokes each turn's model grant", async () => {
      const a = await setup();
      await expect(
        service.manage(a.owner, a.owner.botId, "configure", {
          runtime: { credential: "runtime", baseUrl: "https://other.example.test/api/v1" },
          modelCredentialId: a.credential.id,
          modelId: "fixture-model",
          instructions: "public",
        }),
      ).rejects.toThrow("destination-bound");
      const c = await receive(a);
      const bridge = createModelBridge({ prisma: db.prisma, secrets: f.secrets });
      let token = "";
      reply.mockImplementation(async (request) => {
        token = request.model!.apiKey;
        await expect(bridge.models(token)).resolves.toMatchObject({ object: "list" });
        throw new Error("interrupted flow");
      });
      await service.process(c.id);
      await expect(bridge.models(token)).rejects.toThrow("unavailable");
      expect(
        await db.prisma.secret.count({ where: { userId: a.owner.userId, kind: "model-bridge" } }),
      ).toBe(0);
      expect(sends).toHaveLength(0);
    });

    it("blocks revoked accounts, cross-owner configuration, and archived sending", async () => {
      const a = await setup();
      const b = await setup("another-messenger");
      const c = await receive(a);
      await expect(
        service.manage(b.owner, a.owner.botId, "configure", {
          runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
          modelCredentialId: b.credential.id,
          modelId: "fixture-model",
          knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
          flowId: "bad",
          instructions: "bad",
        }),
      ).rejects.toThrow();
      await expect(
        service.manage(a.owner, a.owner.botId, "configure", {
          runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
          modelCredentialId: b.credential.id,
          modelId: "fixture-model",
          knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
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
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: before.modelCredentialId,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
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
      await db.prisma.customerChannel.update({
        where: { id: a.channel.id },
        data: { hourlyCustomerLimit: 1 },
      });
      const batch = JSON.stringify({
        account: "account",
        messages: [
          { ...incoming("quota"), at: new Date(Date.now() + 1000).toISOString() },
          {
            ...incoming("subsequent", "another-thread"),
            user: "another-customer",
            at: new Date(Date.now() + 1000).toISOString(),
          },
        ],
      });
      await expect(
        ingress.receive(
          a.channel.id,
          new Headers({
            "x-line-signature": createHmac("sha256", "fake-webhook-key")
              .update(batch)
              .digest("base64"),
          }),
          batch,
        ),
      ).resolves.toEqual({ ok: true });
      expect(
        await db.prisma.customerMessage.count({
          where: {
            conversation: { channelId: a.channel.id },
            externalId: "in:subsequent",
          },
        }),
      ).toBe(1);
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

    async function uploadPolicy(a: Awaited<ReturnType<typeof setup>>) {
      await knowledge.configure(a.owner, {
        botId: a.owner.botId,
        baseUrl: "http://localhost:8000/v1",
        apiKey: "fixture-key",
      });
      await knowledge.attach(a.owner, a.owner.botId, true);
      const state = await knowledge.upload(a.owner, {
        botId: a.owner.botId,
        name: "policy.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("Thirty day return policy").toString("base64"),
      });
      const source = state.sources[0]!;
      const revision = await db.prisma.knowledgeRevision.findFirstOrThrow({
        where: { sourceId: source.id },
      });
      await knowledge.process(revision.id);
      await knowledge.process(revision.id);
      return source;
    }

    it("keeps a customer turn running when an internal document is deleted", async () => {
      const a = await setup();
      const source = await uploadPolicy(a);
      const c = await receive(a);
      reply.mockImplementationOnce(async () => {
        await knowledge.remove(a.owner, a.owner.botId, source.id);
        return "Still here";
      });
      await service.process(c.id);
      expect(
        await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } }),
      ).toMatchObject({ owner: "bot", needsHuman: false });
    });

    it.each(["restrict", "replace", "delete"])(
      "revokes cached knowledge and direct replies when sources %s during a customer turn",
      async (change) => {
        const a = await setup();
        const source = await uploadPolicy(a);
        await knowledge.setInternal(a.owner, a.owner.botId, source.id, false);
        const c = await receive(a);
        reply.mockImplementationOnce(async (request) => {
          const token = request.executionContext!.token;
          expect((await service.tools.list(token)).tools.map((tool) => tool.name)).toContain(
            "search_knowledge",
          );
          const search = () =>
            service.tools.execute(token, {
              name: "search_knowledge",
              callId: "knowledge-1",
              arguments: { query: "returns" },
            });
          // A failed read has no side effects, so the same call may be retried.
          knowledgeFixture.provider.search.mockRejectedValueOnce(new Error("offline"));
          await expect(search()).rejects.toThrow();
          expect(await search()).toMatchObject([
            { sourceId: source.id, text: "Thirty day return policy" },
          ]);
          await search();
          expect(knowledgeFixture.provider.search).toHaveBeenCalledTimes(3);
          if (change === "restrict") {
            await knowledge.setInternal(a.owner, a.owner.botId, source.id, true);
          } else if (change === "delete") {
            await knowledge.remove(a.owner, a.owner.botId, source.id);
          } else {
            await knowledge.upload(a.owner, {
              botId: a.owner.botId,
              sourceId: source.id,
              name: "updated.txt",
              mimeType: "text/plain",
              contentBase64: Buffer.from("Sixty day return policy").toString("base64"),
            });
            const updated = await db.prisma.knowledgeSource.findUniqueOrThrow({
              where: { id: source.id },
            });
            await knowledge.process(updated.pendingRevisionId!);
            await knowledge.process(updated.pendingRevisionId!);
          }
          await expect(search()).rejects.toThrow();
          await expect(
            service.tools.execute(token, {
              name: "openconnector_execute_tool",
              callId: "reply-1",
              arguments: {
                id: `${a.account.id}:sample.send`,
                arguments: { to: "thread", texts: ["Thirty day return policy"] },
              },
            }),
          ).rejects.toThrow();
          return "Obsolete automatic reply";
        });
        await service.process(c.id);
        await reply.mock.results[0]!.value;
        expect(sends).toHaveLength(0);
        expect(
          await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } }),
        ).toMatchObject({ owner: "staff", needsHuman: true });
        expect(
          await service.manage(a.owner, a.owner.botId, "knowledge", { query: "returns" }),
        ).toMatchObject(change === "delete" ? [] : [{ sourceId: source.id }]);
      },
    );

    it("shares the provider tools, binds the reply target, and delivers an explicit reply only once", async () => {
      const a = await setup();
      const other = await setup();
      const c = await receive(a);
      reply.mockImplementationOnce(async (request) => {
        const token = request.executionContext!.token;
        expect((await service.tools.list(token)).tools.map((tool) => tool.name)).toContain(
          "openconnector_execute_tool",
        );
        const load = (id: string) =>
          service.tools.execute(token, {
            name: "openconnector_load_tool",
            callId: "load",
            arguments: { id },
          });
        const id = `${a.account.id}:sample.send`;
        await expect(load(`${other.account.id}:sample.send`)).rejects.toThrow();
        expect(await load(id)).toMatchObject({
          inputSchema: { type: "object" },
          suggestedArguments: { to: "thread", texts: ["<your reply text>"] },
        });
        const send = (callId: string, to = "thread") =>
          service.tools.execute(token, {
            name: "openconnector_execute_tool",
            callId,
            arguments: { id, arguments: { to, texts: ["Explicit reply"] } },
          });
        await expect(send("foreign", "someone-else")).rejects.toThrow("target");
        await send("first");
        await send("retry");
        expect(sends).toHaveLength(1);
        await db.prisma.connection.update({
          where: { id: a.account.id },
          data: { actionPolicy: { overrides: { "sample.send": true } } },
        });
        await expect(load(id)).rejects.toThrow();
        await expect(send("first")).rejects.toThrow();
        return "This final answer must not be sent again";
      });
      await service.process(c.id);
      await reply.mock.results[0]!.value;
      expect(sends).toHaveLength(1);
      expect(sends[0]!.input).toMatchObject({
        to: "thread",
        texts: ["Explicit reply"],
        retryKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
      });
      expect(
        await db.prisma.customerMessage.findFirst({ where: { conversationId: c.id, role: "bot" } }),
      ).toMatchObject({ body: "Explicit reply", status: "sent" });
      expect(
        await db.prisma.customerToolCall.count({
          where: { message: { conversationId: c.id }, name: "openconnector_load_tool" },
        }),
      ).toBe(1);
    });

    it("counts catalog reads toward the turn's call limit", async () => {
      const a = await setup();
      const c = await receive(a);
      reply.mockImplementationOnce(async (request) => {
        const search = (callId: string) =>
          service.tools.execute(request.executionContext!.token, {
            name: "openconnector_search_tools",
            callId,
            arguments: { query: callId },
          });
        for (let index = 0; index < 16; index++) await search(`search-${index}`);
        await search("search-0");
        await expect(search("search-16")).rejects.toThrow();
        return "Done";
      });
      await service.process(c.id);
      await reply.mock.results[0]!.value;
    });

    it("hides and denies a workflow while one of its steps is internal", async () => {
      f.providers[0]!.actions.push({
        ...f.providers[0]!.actions[0]!,
        id: "sample.order",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      });
      const a = await setup();
      const shared = a.account.actionPolicy as Record<string, unknown>;
      let lookups = 0;
      businessHandler = () => {
        lookups++;
        return { customerId: "customer" };
      };
      await service.manage(a.owner, a.owner.botId, "configure", {
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: a.credential.id,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
        instructions: "Look up orders",
        actions: [
          {
            name: "lookup_order",
            description: "Look up a customer-owned order",
            connectionId: a.account.id,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            steps: [
              {
                name: "owner",
                action: "sample.order",
                input: {},
                effect: "read",
                check: { path: ["customerId"], equals: "$customerId" },
              },
            ],
          },
        ],
      });
      const c = await receive(a);
      reply.mockImplementationOnce(async (request) => {
        const token = request.executionContext!.token;
        const names = async () => (await service.tools.list(token)).tools.map((tool) => tool.name);
        const lookup = (callId: string) =>
          service.tools.execute(token, { name: "lookup_order", callId, arguments: {} });
        expect(await names()).toContain("lookup_order");
        await db.prisma.connection.update({
          where: { id: a.account.id },
          data: { actionPolicy: { ...shared, overrides: { "sample.order": true } } },
        });
        expect(await names()).not.toContain("lookup_order");
        expect(await names()).toContain("request_human");
        await expect(lookup("internal")).rejects.toThrow();
        expect(lookups).toBe(0);
        await db.prisma.connection.update({
          where: { id: a.account.id },
          data: { actionPolicy: { ...shared, overrides: { "sample.order": false } } },
        });
        expect(await lookup("shared")).toEqual({ customerId: "customer" });
        return "Done";
      });
      await service.process(c.id);
      await reply.mock.results[0]!.value;
      expect(lookups).toBe(1);
      expect(
        await db.prisma.customerToolCall.findFirstOrThrow({
          where: { message: { conversationId: c.id }, status: "completed" },
        }),
      ).toMatchObject({ name: "lookup_order", connectionId: a.account.id, actionId: null });
    });

    it("records a completed tool reply even when the runtime then fails", async () => {
      const a = await setup();
      const c = await receive(a);
      reply.mockImplementationOnce(async (request) => {
        await service.tools.execute(request.executionContext!.token, {
          name: "openconnector_execute_tool",
          callId: "delivered",
          arguments: {
            id: `${a.account.id}:sample.send`,
            arguments: { to: "thread", texts: ["Already delivered"] },
          },
        });
        throw new Error("Runtime stopped after the send");
      });
      await service.process(c.id);
      expect(sends).toHaveLength(1);
      expect(
        await db.prisma.customerMessage.findFirst({ where: { conversationId: c.id, role: "bot" } }),
      ).toMatchObject({ body: "Already delivered", status: "sent" });
    });

    it("does not send a final answer after an uncertain explicit send", async () => {
      const a = await setup();
      const c = await receive(a);
      reply.mockImplementationOnce(async (request) => {
        failSend = true;
        await expect(
          service.tools.execute(request.executionContext!.token, {
            name: "openconnector_execute_tool",
            callId: "uncertain",
            arguments: {
              id: `${a.account.id}:sample.send`,
              arguments: { to: "thread", texts: ["Maybe sent"] },
            },
          }),
        ).rejects.toThrow();
        failSend = false;
        return "Do not send this";
      });
      await service.process(c.id);
      await reply.mock.results[0]!.value;
      expect(sends).toHaveLength(0);
      expect(
        await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } }),
      ).toMatchObject({ needsHuman: true });
    });

    it("stores independent account choices, rejects foreign edits, and serializes concurrent overrides", async () => {
      const a = await setup();
      const b = await setup();
      const settings = createConnectionActionSettings({
        prisma: db.prisma,
        provider: () => f.adapter,
      });
      const context: AdapterContext = {
        ...a.owner,
        operationId: "settings",
        traceId: "settings",
        signal: new AbortController().signal,
      };
      await settings.configure(context, a.account.id, "defaults");
      expect((await settings.list(context, a.account.id)).every((action) => action.internal)).toBe(
        true,
      );
      await expect(
        settings.configure(context, b.account.id, { action: "sample.send", internal: false }),
      ).rejects.toThrow();
      await expect(
        settings.configure(context, a.account.id, { action: "sample.missing", internal: false }),
      ).rejects.toThrow("unavailable");
      await Promise.all([
        settings.configure(context, a.account.id, { action: "sample.send", internal: false }),
        settings.configure(context, a.account.id, { action: "sample.list", internal: false }),
      ]);
      expect(
        (await settings.list(context, a.account.id))
          .filter((action) => !action.internal)
          .map((action) => action.name)
          .sort(),
      ).toEqual(["sample.list", "sample.send"]);
      await settings.configure(context, a.account.id, { action: "sample.send", internal: null });
      expect(
        (await settings.list(context, a.account.id)).find(
          (action) => action.name === "sample.send",
        ),
      ).toMatchObject({ internal: true, overridden: false });
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
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: a.credential.id,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
        instructions: "Check promotion",
        actions: [grant],
      });
      const c = await receive(a);
      let token = "";
      let refunds = 0;
      reply.mockImplementationOnce(async (request) => {
        token = request.executionContext!.token;
        expect(await service.tools.list(token)).toMatchObject({
          tools: expect.arrayContaining([
            {
              name: "refund_order",
              description: expect.any(String),
              inputSchema: expect.any(Object),
            },
            {
              name: "request_human",
              description: expect.any(String),
              inputSchema: expect.any(Object),
            },
          ]),
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
          runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
          modelCredentialId: a.credential.id,
          modelId: "fixture-model",
          knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
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

    it("checks current eligibility again before a repeat write in a later customer turn", async () => {
      const catalog = f.providers[0]!.actions;
      for (const suffix of ["order", "refund"])
        catalog.push({
          ...catalog[0]!,
          id: `sample.${suffix}`,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        });
      const a = await setup();
      let refunds = 0;
      businessHandler = (action) => {
        if (action.endsWith(".order"))
          return { id: "owned-record", customerId: "customer", refundable: refunds === 0 };
        refunds++;
        return { refunded: true };
      };
      await service.manage(a.owner, a.owner.botId, "configure", {
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: a.credential.id,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
        instructions: "Check ownership and current refund eligibility",
        actions: [
          {
            name: "refund_order",
            description: "Refund an eligible owned order",
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
              {
                name: "eligible",
                action: "sample.order",
                input: { id: "$steps.owner.id" },
                effect: "read",
                check: { path: ["refundable"], equals: true },
              },
              {
                name: "refund",
                action: "sample.refund",
                input: { id: "$steps.eligible.id" },
                effect: "write",
              },
            ],
          },
        ],
      });
      reply.mockImplementation(async (request) => {
        await service.tools.execute(request.executionContext!.token, {
          name: "refund_order",
          callId: "refund",
          arguments: {},
        });
        return "Refund confirmed";
      });
      const c = await receive(a);
      await service.process(c.id);
      expect(refunds).toBe(1);
      await receive(a, [incoming("second")]);
      await service.process(c.id);
      expect(refunds).toBe(1);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ owner: "staff", needsHuman: true });
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
        runtime: { credential: "runtime", baseUrl: "https://runtime.example.test/api/v1" },
        modelCredentialId: a.credential.id,
        modelId: "fixture-model",
        knowledge: { credential: "knowledge", baseUrl: "https://rag.example.test/v1" },
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
