import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AdapterContext,
  CustomerAssessmentProvider,
  CustomerRuntime,
  JobPublisher,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { NotificationDeliveryError } from "@rakazo/adapter-kit";
import { CustomerBindingSchema, CustomerPurchaseQuote } from "@rakazo/contracts";
import {
  configureCustomerReplies,
  createCustomerInbox,
  createCustomerRepos,
  createDb,
  createLearning,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createConnectionActionSettings } from "./connection-action-settings.js";
import { sendCustomerAttentionAlert } from "./customer-alerts.js";
import { createCustomerConversations } from "./customer-conversations.js";
import { createCustomerIngress } from "./customer-ingress.js";
import {
  customerReplyDefaultsId,
  defaultCustomerInstructions,
  managedCustomerRuntime,
} from "./customer-reply-defaults.js";
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
    let assess: ReturnType<typeof vi.fn<CustomerAssessmentProvider["assess"]>>;
    let notifications: NotificationProvider;
    let notify: ReturnType<typeof vi.fn<NotificationProvider["send"]>>;
    let search: ReturnType<typeof vi.fn<NonNullable<CustomerRuntime["search"]>>>;
    let failSend: boolean;
    let flowOrdinal = 0;
    let failPublish = false;
    let beforePublish: ((signal: AbortSignal) => Promise<void>) | undefined;
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
      notify = vi.fn(async () => ({ status: "accepted" as const }));
      notifications = {
        describe: () => ({
          id: "fixture",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { push: true, email: false },
        }),
        send: notify,
      };
      assess = vi.fn(async () => ({
        needsHuman: false,
        confidence: 0.99,
        reason: "Routine question",
      }));
      feeds = new Map();
      sends.length = 0;
      failSend = false;
      beforePublish = undefined;
      flowOrdinal = 0;
      failPublish = false;
      businessHandler = undefined;
      holdSend = undefined;
      sendStarted = undefined;
      f = createOpenConnectorFixture((action, input, alias) => {
        if (action.endsWith(".list")) return { messages: feeds.get(alias) ?? [], cursor: "next" };
        if (/\.(order|promotion|refund)$/.test(action) || action.startsWith("woocommerce."))
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
        assessment: () => ({ assess }),
        notifications,
        runtime: () => ({
          reply,
          search,
          publish: async ({ signal, beforeDispatch }) => {
            await beforeDispatch?.();
            await beforePublish?.(signal);
            if (failPublish) throw new Error("Reply service offline");
            return `flow-${++flowOrdinal}`;
          },
        }),
      });
    });
    afterEach(async () => {
      for (const owner of owners) {
        await db.prisma.space.delete({ where: { id: owner.spaceId } });
        await db.prisma.customerPublication.deleteMany({ where: { userId: owner.userId } });
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
    it.each(["confirmed", "lost"])(
      "routes %s checkout and readback through scoped OpenConnector without exposing capabilities",
      async (mode) => {
        const names = [
          "get_order",
          "create_cart",
          "get_cart",
          "add_cart_item",
          "update_cart_item",
          "remove_cart_item",
          "apply_cart_coupon",
          "remove_cart_coupon",
          "update_cart_customer",
          "select_cart_shipping_rate",
          "submit_checkout",
        ];
        f.providers.push({
          ...f.providers[0]!,
          service: "woocommerce",
          displayName: "Synthetic store",
          actions: names.map((name) => ({
            ...sampleAction,
            id: `woocommerce.${name}`,
            service: "woocommerce",
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
          })),
        });
        const a = await setup();
        const conversation = await receive(a);
        const auth = await f.adapter.begin(
          {
            provider: "woocommerce",
            redirectUrl: "https://example.test",
            credential: "fake-store-key",
          },
          {
            ...a.owner,
            operationId: "store",
            traceId: "store",
            signal: new AbortController().signal,
          },
        );
        const account = await db.prisma.connection.create({
          data: {
            spaceId: a.owner.spaceId,
            userId: a.owner.userId,
            connectorId: "open-connector",
            provider: "woocommerce",
            displayName: "Store",
            status: "connected",
            providerRef: auth.state,
          },
        });
        const cart = {
          items: [] as Array<{ key: string; id: number; name: string; quantity: number }>,
          totals: { currency_code: "THB", currency_minor_unit: 2, total_price: "12500" },
          needs_shipping: false,
          needs_payment: true,
          coupons: [],
          shipping_rates: [],
          billing_address: { email: "synthetic@example.test" },
          shipping_address: {},
        };
        const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
        let providerNote = "";
        businessHandler = (action, input) => {
          calls.push({ action, input });
          if (action === "woocommerce.add_cart_item")
            cart.items = [{ key: "one", id: 7, name: "Product", quantity: 1 }];
          if (action === "woocommerce.get_order")
            return {
              id: 29,
              status: "on-hold",
              currency: "THB",
              total: "125.00",
              customerNote: providerNote,
              paymentMethod: "bacs",
              needsPayment: false,
              datePaidGmt: null,
              transactionId: null,
              billing: { email: "synthetic@example.test" },
              shipping: {},
              lineItems: [{ productId: 7, variationId: 0, quantity: 1 }],
            };
          if (action === "woocommerce.submit_checkout") {
            providerNote = String(input.customerNote);
            if (mode === "lost") throw new Error("Lost provider response");
            return {
              cartToken: "ROTATED_CART_CAPABILITY",
              checkout: {
                order_id: 29,
                status: "on-hold",
                order_key: "PRIVATE_ORDER_KEY",
                payment_result: { payment_status: "success" },
              },
            };
          }
          return {
            cartToken:
              action === "woocommerce.create_cart"
                ? "FIRST_CART_CAPABILITY"
                : "ROTATED_CART_CAPABILITY",
            cart,
          };
        };
        const rowShape = z.object({ id: z.string(), revision: z.number() });
        const request = {
          conversationId: conversation.id,
          customerId: "customer",
          connectionId: account.id,
          nonce: randomUUID(),
          paymentMethods: ["bacs"],
        };
        const first = rowShape.parse(
          await service.manage(a.owner, a.owner.botId, "purchase_start", request),
        );
        const added = rowShape.parse(
          await service.manage(a.owner, a.owner.botId, "purchase_update", {
            id: first.id,
            expectedRevision: first.revision,
            change: { kind: "add", productId: 7, quantity: 1 },
          }),
        );
        const quote = z
          .object({ quote: CustomerPurchaseQuote })
          .parse(
            await service.manage(a.owner, a.owner.botId, "purchase_quote", { id: first.id }),
          ).quote;
        const checkout = {
          id: first.id,
          expectedRevision: added.revision,
          quote,
          paymentMethod: "bacs",
        };
        if (mode === "lost") {
          await expect(
            service.manage(a.owner, a.owner.botId, "purchase_checkout", checkout),
          ).rejects.toThrow("uncertain");
          await service.manage(a.owner, a.owner.botId, "purchase_reconcile", {
            id: first.id,
            expectedRevision: added.revision + 1,
            orderId: "29",
            reason: "Found exact merchant reference",
          });
        } else {
          await service.manage(a.owner, a.owner.botId, "purchase_checkout", checkout);
        }
        const submitted = await service.manage(a.owner, a.owner.botId, "purchase_status", {
          id: first.id,
        });
        expect(submitted).toMatchObject({
          status: "submitted",
          summary: { order: { id: "29", status: "on-hold", paymentStatus: "unconfirmed" } },
        });
        await expect(
          service.manage(a.owner, a.owner.botId, "purchase_checkout", checkout),
        ).rejects.toThrow("changed");
        expect(calls.map((call) => call.action)).toEqual([
          "woocommerce.create_cart",
          "woocommerce.add_cart_item",
          "woocommerce.get_cart",
          "woocommerce.submit_checkout",
          ...(mode === "lost" ? ["woocommerce.get_order"] : []),
          "woocommerce.get_order",
        ]);
        expect(calls[1]?.input.cartToken).toBe("FIRST_CART_CAPABILITY");
        expect(calls[3]?.input).toMatchObject({
          cartToken: "ROTATED_CART_CAPABILITY",
          expectedTotal: "12500",
          paymentMethod: "bacs",
        });
        const inspected = await service.manage(a.owner, a.owner.botId, "purchases", {
          conversationId: conversation.id,
        });
        for (const secret of ["CART_CAPABILITY", "PRIVATE_ORDER_KEY", auth.state])
          expect(JSON.stringify({ submitted, inspected, quote })).not.toContain(secret);
        expect(
          await db.prisma.customerConversation.findUniqueOrThrow({
            where: { id: conversation.id },
          }),
        ).toMatchObject({ owner: "staff" });
        expect(sends).toHaveLength(0);
        expect(await db.prisma.externalEffect.count({ where: { spaceId: a.owner.spaceId } })).toBe(
          0,
        );
      },
    );
    async function enableAssessment(a: Awaited<ReturnType<typeof setup>>, criteria = "") {
      const id = randomUUID();
      await db.prisma.botSecret.create({
        data: {
          id,
          userId: a.owner.userId,
          spaceId: a.owner.spaceId,
          botId: a.owner.botId,
          name: "escalation",
          origin: "https://assessment.example.test",
          auth: { type: "bearer" },
          ciphertext: f.secrets.seal("synthetic", id),
        },
      });
      await service.manage(a.owner, a.owner.botId, "assessment", {
        config: {
          provider: "jev",
          baseUrl: "https://assessment.example.test/v1",
          credential: "escalation",
          criteria,
        },
      });
    }
    async function assignedAttentionCase() {
      const a = await setup();
      const b = await setup();
      const { organizationId } = await db.prisma.space.findUniqueOrThrow({
        where: { id: a.owner.spaceId },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: b.owner.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await service.manage(a.owner, a.owner.botId, "channel", { id: a.channel.id, shared: true });
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      await createCustomerInbox(db.prisma).updateCase(a.owner, {
        id: c.id,
        assigneeId: b.owner.userId,
      });
      return { a, b, c };
    }
    it("shows the selected model to staff without leaking other Space preferences or credentials", async () => {
      const a = await setup();
      const b = await setup();
      const member = await db.prisma.spaceMember.findFirstOrThrow({
        where: { spaceId: b.owner.spaceId, userId: b.owner.userId },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: member.organizationId,
          userId: a.owner.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await db.prisma.spaceModelPreference.createMany({
        data: [
          {
            spaceId: a.owner.spaceId,
            userId: a.owner.userId,
            credentialId: a.credential.id,
            modelId: "selected-model",
            isDefault: true,
          },
          {
            spaceId: b.owner.spaceId,
            userId: a.owner.userId,
            credentialId: a.credential.id,
            modelId: "other-space-model",
            isDefault: true,
          },
        ],
      });
      const inspected = await service.manage(a.owner, a.owner.botId, "inspect", {});
      expect(inspected).toMatchObject({
        models: [
          {
            id: a.credential.id,
            preferences: [{ modelId: "selected-model", isDefault: true }],
          },
        ],
      });
      const serialized = JSON.stringify(inspected);
      expect(serialized).not.toContain("other-space-model");
      expect(serialized).not.toContain(b.credential.id);
      expect(serialized).not.toContain(a.credential.secretId);
    });
    it("hands off explicit Thai requests without spending a model turn", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      expect(reply).not.toHaveBeenCalled();
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ needsHuman: true, owner: "staff" });
      expect(
        await db.prisma.customerMessage.findFirst({
          where: { conversationId: c.id, role: "system" },
        }),
      ).toMatchObject({ body: "ส่งเรื่องให้เจ้าหน้าที่แล้ว เจ้าหน้าที่จะตอบกลับในแชทนี้" });
    });
    it.each([true, false])(
      "honors the help notification preference %s without repeating the alert",
      async (help) => {
        const a = await setup();
        await db.prisma.notificationPreference.update({
          where: { spaceId_userId: { spaceId: a.owner.spaceId, userId: a.owner.userId } },
          data: { help },
        });
        const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
        await service.process(c.id);
        await service.reconcile();
        await service.reconcile();
        expect(notify).toHaveBeenCalledTimes(help ? 1 : 0);
        if (help)
          expect(notify.mock.calls[0]?.[1]).toMatchObject({
            userId: a.owner.userId,
            spaceId: a.owner.spaceId,
          });
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject({ needsHuman: true });
      },
    );
    it("serializes alert workers and holds case and access locks through dispatch", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      notify.mockImplementationOnce(async () => {
        started();
        await held;
        return { status: "accepted" };
      });
      const first = sendCustomerAttentionAlert(db.prisma, notifications, c.id);
      await ready;
      try {
        await sendCustomerAttentionAlert(db.prisma, notifications, c.id);
        expect(notify).toHaveBeenCalledOnce();
        for (const [sql, value] of [
          ["SELECT id FROM customer_conversations WHERE id = $1 FOR UPDATE NOWAIT", c.id],
          ["SELECT id FROM customer_channels WHERE id = $1 FOR UPDATE NOWAIT", a.channel.id],
          ["SELECT id FROM bots WHERE id = $1 FOR UPDATE NOWAIT", a.owner.botId],
          ['SELECT id FROM space_members WHERE "spaceId" = $1 FOR UPDATE NOWAIT', a.owner.spaceId],
          [
            'SELECT id FROM notification_preferences WHERE "spaceId" = $1 FOR UPDATE NOWAIT',
            a.owner.spaceId,
          ],
        ]) {
          await expect(db.pool.query(sql!, [value])).rejects.toMatchObject({ code: "55P03" });
        }
      } finally {
        release();
        await first;
      }
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id);
      expect(notify).toHaveBeenCalledOnce();
    });
    it("reminds once at ten minutes without resetting the clock on follow-ups or guidance", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      const issue = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } });
      const at = (minutes: number) =>
        new Date(issue.attentionStartedAt!.getTime() + minutes * 60000);
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(0));
      await receive(a, [incoming("follow-up")]);
      await createCustomerInbox(db.prisma).steer(a.owner, {
        id: c.id,
        guidance: "Ask which size is needed",
        nonce: "reminder-guidance",
      });
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(9.999));
      expect(notify).toHaveBeenCalledOnce();
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(10));
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(10));
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls[0]?.[1].operationId).not.toBe(notify.mock.calls[1]?.[1].operationId);
      // The default recipient is already the owner; do not notify them a third time.
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(30));
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(60));
      expect(notify).toHaveBeenCalledTimes(2);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({
        attentionId: issue.attentionId,
        attentionStartedAt: issue.attentionStartedAt,
        attentionAlertStage: 2,
        ownerAttentionAlertAt: null,
        nextAttentionAlertAt: null,
        needsHuman: true,
        owner: "staff",
      });
    });
    it("notifies the assigned member, then the owner at thirty minutes", async () => {
      const { a, b, c } = await assignedAttentionCase();
      const issue = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } });
      const at = (minutes: number) =>
        new Date(issue.attentionStartedAt!.getTime() + minutes * 60000);
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(0));
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(10));
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(29.999));
      expect(notify.mock.calls.map(([, context]) => context.userId)).toEqual([
        b.owner.userId,
        b.owner.userId,
      ]);
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(30));
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, at(60));
      expect(notify.mock.calls.map(([, context]) => context.userId)).toEqual([
        b.owner.userId,
        b.owner.userId,
        a.owner.userId,
      ]);
    });
    describe("independent staff alert destinations", () => {
      function externalDestination(id = "external-fixture") {
        const send = vi.fn<NotificationProvider["send"]>(async () => ({ status: "accepted" }));
        const provider: NotificationProvider = {
          describe: () => ({ ...notifications.describe(), id }),
          send,
        };
        return { provider, send };
      }
      async function attentionCase() {
        const a = await setup();
        const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
        await service.process(c.id);
        const issue = await db.prisma.customerConversation.findUniqueOrThrow({
          where: { id: c.id },
        });
        const at = (minutes: number) =>
          new Date(issue.attentionStartedAt!.getTime() + minutes * 60000);
        return { a, c, issue, at };
      }
      it("delivers each stage to both destinations with separate stable operation IDs", async () => {
        const { a, b, c } = await assignedAttentionCase();
        const issue = await db.prisma.customerConversation.findUniqueOrThrow({
          where: { id: c.id },
        });
        const external = externalDestination();
        for (const minutes of [0, 0, 10, 10, 30, 60]) {
          await sendCustomerAttentionAlert(
            db.prisma,
            [notifications, external.provider],
            c.id,
            new Date(issue.attentionStartedAt!.getTime() + minutes * 60000),
          );
        }
        for (const send of [notify, external.send]) {
          expect(send.mock.calls.map(([, context]) => context.userId)).toEqual([
            b.owner.userId,
            b.owner.userId,
            a.owner.userId,
          ]);
        }
        expect(
          new Set(
            [...notify.mock.calls, ...external.send.mock.calls].map(
              ([, context]) => context.operationId,
            ),
          ).size,
        ).toBe(6);
        expect(
          await db.prisma.customerAlertDelivery.count({
            where: { conversationId: c.id, status: "accepted" },
          }),
        ).toBe(6);
      });
      it("retries only the rejected destination, even when provider order changes", async () => {
        const { c, at } = await attentionCase();
        const external = externalDestination();
        external.send.mockRejectedValueOnce(
          new NotificationDeliveryError("Synthetic rejection", "rejected", true),
        );
        external.send.mockRejectedValueOnce(
          new NotificationDeliveryError("Synthetic rejection", "rejected", true),
        );
        for (const minutes of [0, 1]) {
          await expect(
            sendCustomerAttentionAlert(
              db.prisma,
              [notifications, external.provider],
              c.id,
              at(minutes),
            ),
          ).rejects.toThrow();
        }
        await sendCustomerAttentionAlert(
          db.prisma,
          [external.provider, notifications],
          c.id,
          at(2),
        );
        expect(external.send).toHaveBeenCalledTimes(2);
        await sendCustomerAttentionAlert(
          db.prisma,
          [external.provider, notifications],
          c.id,
          at(3),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(external.send).toHaveBeenCalledTimes(3);
        expect(
          new Set(external.send.mock.calls.map(([, context]) => context.operationId)).size,
        ).toBe(1);
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject({ attentionAlertStage: 1, nextAttentionAlertAt: at(10), needsHuman: true });
      });
      it("keeps one unknown outcome visible while another destination succeeds", async () => {
        const { a, c, at } = await attentionCase();
        const external = externalDestination();
        external.send.mockRejectedValueOnce(new Error("Synthetic lost response"));
        await expect(
          sendCustomerAttentionAlert(db.prisma, [external.provider, notifications], c.id, at(0)),
        ).rejects.toThrow();
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          at(1),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(external.send).toHaveBeenCalledOnce();
        const snapshot = await createCustomerRepos(db.prisma).snapshot(a.owner, c.id);
        expect(snapshot.notificationIssue).toBe("uncertain");
        expect(
          snapshot.actions
            .filter((action) => action.name === "staff_notification")
            .map((action) => action.status)
            .sort(),
        ).toEqual(["accepted", "uncertain"]);
        expect(JSON.stringify(snapshot)).not.toContain("Synthetic lost response");
      });
      it("continues other destinations after a receipt commit fails and never replays the lost receipt", async () => {
        const { c, at } = await attentionCase();
        const external = externalDestination();
        await db.pool.query(`CREATE FUNCTION test_destination_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.status = 'accepted' AND NEW.provider = 'fixture' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER test_destination_receipt_failure BEFORE UPDATE ON customer_alert_deliveries FOR EACH ROW EXECUTE FUNCTION test_destination_receipt_failure()`);
        try {
          await expect(
            sendCustomerAttentionAlert(db.prisma, [notifications, external.provider], c.id, at(0)),
          ).rejects.toThrow();
        } finally {
          await db.pool.query(
            "DROP TRIGGER test_destination_receipt_failure ON customer_alert_deliveries; DROP FUNCTION test_destination_receipt_failure()",
          );
        }
        expect(
          await db.prisma.customerAlertDelivery.findMany({
            where: { conversationId: c.id },
            orderBy: { provider: "asc" },
          }),
        ).toMatchObject([
          { provider: "external-fixture", status: "accepted" },
          { provider: "fixture", status: "sending" },
        ]);
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          at(0.25),
        );
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          at(1),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(external.send).toHaveBeenCalledOnce();
        expect(
          await db.prisma.customerAlertDelivery.findFirst({
            where: { conversationId: c.id, provider: "fixture" },
          }),
        ).toMatchObject({ status: "uncertain", attempts: 1 });
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject({ attentionAlertStage: 1 });
      });
      it("does not duplicate either destination when two workers contend", async () => {
        const { c, at } = await attentionCase();
        const external = externalDestination();
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        notify.mockImplementationOnce(async () => {
          started();
          await held;
          return { status: "accepted" };
        });
        const first = sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          at(0),
        );
        try {
          await ready;
          await sendCustomerAttentionAlert(
            db.prisma,
            [external.provider, notifications],
            c.id,
            at(0),
          );
        } finally {
          release();
          await first;
        }
        await sendCustomerAttentionAlert(
          db.prisma,
          [external.provider, notifications],
          c.id,
          at(1),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(external.send).toHaveBeenCalledOnce();
      });
      it("rechecks acknowledgement between destination sends and cancels the unsent intent", async () => {
        const { c, at } = await attentionCase();
        const external = externalDestination();
        await db.pool.query(`CREATE FUNCTION test_destination_acknowledge() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.status = 'accepted' AND NEW.provider = 'fixture' THEN
          UPDATE customer_conversations SET "acknowledgedAt" = CURRENT_TIMESTAMP, "nextAttentionAlertAt" = NULL, "ownerAttentionAlertAt" = NULL WHERE id = NEW."conversationId";
          END IF; RETURN NEW; END $$;
          CREATE TRIGGER test_destination_acknowledge AFTER UPDATE ON customer_alert_deliveries FOR EACH ROW EXECUTE FUNCTION test_destination_acknowledge()`);
        try {
          await sendCustomerAttentionAlert(
            db.prisma,
            [notifications, external.provider],
            c.id,
            at(0),
          );
        } finally {
          await db.pool.query(
            "DROP TRIGGER test_destination_acknowledge ON customer_alert_deliveries; DROP FUNCTION test_destination_acknowledge()",
          );
        }
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          at(60),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(external.send).not.toHaveBeenCalled();
        expect(
          await db.prisma.customerAlertDelivery.findFirst({
            where: { conversationId: c.id, provider: "external-fixture" },
          }),
        ).toMatchObject({ status: "cancelled", attempts: 0 });
      });
      it("does not redirect a removed destination's retry to a replacement provider", async () => {
        const { a, c, at } = await attentionCase();
        const external = externalDestination();
        const replacement = externalDestination("replacement-fixture");
        external.send.mockRejectedValueOnce(
          new NotificationDeliveryError("Synthetic rejection", "rejected", true),
        );
        await expect(
          sendCustomerAttentionAlert(db.prisma, [notifications, external.provider], c.id, at(0)),
        ).rejects.toThrow();
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, replacement.provider],
          c.id,
          at(1),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(replacement.send).not.toHaveBeenCalled();
        expect(
          (await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).notificationIssue,
        ).toBe("failed");
        expect(
          await db.prisma.customerAlertDelivery.findFirst({
            where: { conversationId: c.id, provider: "external-fixture" },
          }),
        ).toMatchObject({ status: "failed", retryable: false, attempts: 1 });
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, replacement.provider],
          c.id,
          at(10),
        );
        expect(replacement.send).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledTimes(2);
      });
      it("preserves a legacy single-provider receipt when a second provider is introduced", async () => {
        const { a, c, issue, at } = await attentionCase();
        const external = externalDestination();
        await db.prisma.customerAlertDelivery.create({
          data: {
            conversationId: c.id,
            attentionId: issue.attentionId!,
            stage: 0,
            recipientId: a.owner.userId,
            provider: "fixture",
            status: "accepted",
          },
        });
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          at(0),
        );
        expect(notify).not.toHaveBeenCalled();
        expect(external.send).not.toHaveBeenCalled();
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          at(10),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(external.send).toHaveBeenCalledOnce();
      });
      it("upgrades populated single-provider receipts without changing them", async () => {
        const { a, c, issue } = await attentionCase();
        const original = await readFile(
          new URL(
            "../../db/prisma/migrations/20260918090000_customer_alert_deliveries/migration.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const upgrade = await readFile(
          new URL(
            "../../db/prisma/migrations/20260918160000_customer_alert_destinations/migration.sql",
            import.meta.url,
          ),
          "utf8",
        );
        const client = await db.pool.connect();
        const schema = `alert_upgrade_${randomUUID().replaceAll("-", "")}`;
        try {
          await client.query("BEGIN");
          // Run the actual historical and incremental SQL in an isolated schema.
          // The case FK resolves to the fixture's public customer_conversations.
          await client.query(
            `CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}", public`,
          );
          await client.query(original);
          await client.query(
            `INSERT INTO customer_alert_deliveries
            (id, "conversationId", "attentionId", stage, "recipientId", provider, status, attempts, retryable, reference, "updatedAt")
            VALUES ('accepted-receipt', $1, $2, 0, $3, 'fixture', 'accepted', 1, false, 'synthetic-ticket', CURRENT_TIMESTAMP),
                   ('rejected-receipt', $1, $2, 1, $3, 'fixture', 'failed', 2, true, NULL, CURRENT_TIMESTAMP)`,
            [c.id, issue.attentionId, a.owner.userId],
          );
          const before = await client.query("SELECT * FROM customer_alert_deliveries ORDER BY id");
          await client.query(upgrade);
          expect(
            (await client.query("SELECT * FROM customer_alert_deliveries ORDER BY id")).rows,
          ).toEqual(before.rows);
          await client.query("SAVEPOINT duplicate_receipt");
          await expect(
            client.query(`INSERT INTO customer_alert_deliveries
            SELECT 'duplicate', "conversationId", "attentionId", stage, "recipientId", provider, status, attempts, "claimToken", "leaseUntil", retryable, reference, "createdAt", "updatedAt"
            FROM customer_alert_deliveries WHERE id = 'accepted-receipt'`),
          ).rejects.toMatchObject({ code: "23505" });
          await client.query("ROLLBACK TO SAVEPOINT duplicate_receipt");
          await client.query(`INSERT INTO customer_alert_deliveries
            SELECT 'second-provider', "conversationId", "attentionId", stage, "recipientId", 'external-fixture', status, attempts, "claimToken", "leaseUntil", retryable, reference, "createdAt", "updatedAt"
            FROM customer_alert_deliveries WHERE id = 'accepted-receipt'`);
          expect(
            (await client.query("SELECT id FROM customer_alert_deliveries ORDER BY id")).rows,
          ).toHaveLength(3);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      });
      it("rejects ambiguous provider identities before creating any intent", async () => {
        const { c, at } = await attentionCase();
        const duplicate = externalDestination("fixture");
        await expect(
          sendCustomerAttentionAlert(db.prisma, [notifications, duplicate.provider], c.id, at(0)),
        ).rejects.toThrow("unique IDs");
        expect(
          await db.prisma.customerAlertDelivery.count({ where: { conversationId: c.id } }),
        ).toBe(0);
        expect(notify).not.toHaveBeenCalled();
        expect(duplicate.send).not.toHaveBeenCalled();
      });
      it("defers both destinations during quiet hours and combines the overdue reminder", async () => {
        const { a, c } = await attentionCase();
        const external = externalDestination();
        await service.manage(a.owner, a.owner.botId, "notifications", {
          quietHours: { start: "22:00", end: "08:00", timezone: "UTC" },
        });
        const night = new Date("2026-01-02T23:00:00Z");
        const morning = new Date("2026-01-03T08:00:00Z");
        await db.prisma.customerConversation.update({
          where: { id: c.id },
          data: {
            attentionStartedAt: night,
            nextAttentionAlertAt: night,
            ownerAttentionAlertAt: night,
          },
        });
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          night,
        );
        expect(notify).not.toHaveBeenCalled();
        expect(external.send).not.toHaveBeenCalled();
        expect(
          await db.prisma.customerAlertDelivery.count({ where: { conversationId: c.id } }),
        ).toBe(0);
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          morning,
        );
        await sendCustomerAttentionAlert(
          db.prisma,
          [notifications, external.provider],
          c.id,
          morning,
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(external.send).toHaveBeenCalledOnce();
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject({ attentionAlertStage: 2, nextAttentionAlertAt: null });
      });
    });
    it("keeps personal notification settings isolated and supports changing and clearing quiet hours", async () => {
      const a = await setup();
      const b = await setup();
      const quietHours = { start: "22:00", end: "08:00", timezone: "Asia/Bangkok" };
      expect(await service.manage(a.owner, a.owner.botId, "notifications", { quietHours })).toEqual(
        { help: true, quietHours },
      );
      expect(
        await service.manage(a.owner, a.owner.botId, "notifications", { help: false }),
      ).toEqual({ help: false, quietHours });
      expect(
        await service.manage(a.owner, a.owner.botId, "notifications", { quietHours: null }),
      ).toEqual({ help: false, quietHours: null });
      expect(await service.manage(b.owner, b.owner.botId, "notifications", {})).toEqual({
        help: true,
        quietHours: null,
      });
      await expect(
        service.manage(b.owner, a.owner.botId, "notifications", { help: false }),
      ).rejects.toThrow();
      await expect(
        service.manage(a.owner, a.owner.botId, "notifications", {
          quietHours: { ...quietHours, timezone: "Bad/Zone" },
        }),
      ).rejects.toThrow();
      await db.prisma.spaceMember.deleteMany({
        where: { spaceId: a.owner.spaceId, userId: a.owner.userId },
      });
      await expect(
        service.manage(a.owner, a.owner.botId, "notifications", { help: true }),
      ).rejects.toThrow();
    });
    it("defers a staff reminder to the end of their quiet hours without delaying the owner", async () => {
      const { a, b, c } = await assignedAttentionCase();
      await db.prisma.notificationPreference.create({
        data: {
          spaceId: a.owner.spaceId,
          userId: b.owner.userId,
          customerQuietHours: { start: "22:00", end: "08:00", timezone: "Asia/Bangkok" },
        },
      });
      const start = new Date("2026-01-01T14:50:00Z");
      await db.prisma.customerConversation.update({
        where: { id: c.id },
        data: {
          attentionStartedAt: start,
          nextAttentionAlertAt: start,
          ownerAttentionAlertAt: new Date("2026-01-01T15:20:00Z"),
        },
      });
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, start);
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date("2026-01-01T15:00:00Z"),
      );
      expect(notify).toHaveBeenCalledOnce();
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({
        nextAttentionAlertAt: new Date("2026-01-02T01:00:00Z"),
        attentionAlertStage: 1,
        needsHuman: true,
      });
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date("2026-01-01T15:20:00Z"),
      );
      expect(notify.mock.calls.map(([, context]) => context.userId)).toEqual([
        b.owner.userId,
        a.owner.userId,
      ]);
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date("2026-01-02T01:00:00Z"),
      );
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date("2026-01-02T01:00:00Z"),
      );
      expect(notify.mock.calls.map(([, context]) => context.userId)).toEqual([
        b.owner.userId,
        a.owner.userId,
        b.owner.userId,
      ]);
    });
    it("still escalates to the owner when the assigned member's reminder fails", async () => {
      const { a, b, c } = await assignedAttentionCase();
      const issue = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } });
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, issue.attentionStartedAt!);
      notify.mockRejectedValueOnce(
        new NotificationDeliveryError("Notification unavailable", "rejected", true),
      );
      const overdue = new Date(issue.attentionStartedAt!.getTime() + 30 * 60000);
      await expect(
        sendCustomerAttentionAlert(db.prisma, notifications, c.id, overdue),
      ).rejects.toThrow("Customer notification failed");
      expect(notify.mock.calls.map(([, context]) => context.userId)).toEqual([
        b.owner.userId,
        b.owner.userId,
        a.owner.userId,
      ]);
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date(overdue.getTime() + 60000),
      );
      expect(notify).toHaveBeenCalledTimes(4);
      expect(notify.mock.calls[1]?.[1].operationId).toBe(notify.mock.calls[3]?.[1].operationId);
    });
    it.each(["acknowledge", "resolve", "reply", "resume"])(
      "stops scheduled reminders after staff %s",
      async (action) => {
        const a = await setup();
        const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
        await service.process(c.id);
        notify.mockRejectedValueOnce(new Error("Synthetic unknown delivery"));
        await service.reconcile();
        expect(
          (await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).notificationIssue,
        ).toBe("uncertain");
        const issue = await db.prisma.customerConversation.findUniqueOrThrow({
          where: { id: c.id },
        });
        const inbox = createCustomerInbox(db.prisma);
        if (action === "acknowledge")
          await inbox.updateCase(a.owner, { id: c.id, acknowledge: true });
        if (action === "resolve") await inbox.updateCase(a.owner, { id: c.id, state: "resolved" });
        if (action === "reply")
          await inbox.reply(a.owner, { id: c.id, body: "I can help", nonce: "reply" });
        if (action === "resume") await inbox.setOwner(a.owner, c.id, "bot");
        await sendCustomerAttentionAlert(
          db.prisma,
          notifications,
          c.id,
          new Date(issue.attentionStartedAt!.getTime() + 3600000),
        );
        expect(notify).toHaveBeenCalledOnce();
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject({ nextAttentionAlertAt: null });
        const snapshot = await createCustomerRepos(db.prisma).snapshot(a.owner, c.id);
        expect(snapshot.notificationIssue).toBeNull();
        expect(snapshot.actions).toContainEqual(
          expect.objectContaining({ name: "staff_notification", status: "uncertain" }),
        );
      },
    );
    it("reconciles overdue reminders after downtime and preserves retry identity through new messages", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      await service.reconcile();
      const past = new Date(Date.now() - 31 * 60000);
      await db.prisma.customerConversation.update({
        where: { id: c.id },
        data: {
          attentionStartedAt: past,
          nextAttentionAlertAt: past,
          ownerAttentionAlertAt: past,
        },
      });
      notify.mockRejectedValueOnce(
        new NotificationDeliveryError("Notification unavailable", "rejected", true),
      );
      await service.reconcile();
      await receive(a, [incoming("retry-context")]);
      await db.prisma.customerConversation.update({
        where: { id: c.id },
        data: { nextAttentionAlertAt: new Date() },
      });
      await service.reconcile();
      await service.reconcile();
      await service.reconcile();
      expect(notify).toHaveBeenCalledTimes(3);
      expect(notify.mock.calls[1]?.[1].operationId).toBe(notify.mock.calls[2]?.[1].operationId);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({
        needsHuman: true,
        attentionAlertStage: 2,
        ownerAttentionAlertAt: null,
        nextAttentionAlertAt: null,
      });
    });
    it("combines an overnight deferred initial alert with its overdue reminder", async () => {
      const a = await setup();
      await service.manage(a.owner, a.owner.botId, "notifications", {
        quietHours: { start: "22:00", end: "08:00", timezone: "Asia/Bangkok" },
      });
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      const start = new Date("2026-01-01T15:00:00Z");
      await db.prisma.customerConversation.update({
        where: { id: c.id },
        data: {
          attentionStartedAt: start,
          nextAttentionAlertAt: start,
          ownerAttentionAlertAt: new Date("2026-01-01T15:30:00Z"),
        },
      });
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, start);
      expect(notify).not.toHaveBeenCalled();
      const morning = new Date("2026-01-02T01:00:00Z");
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, morning);
      await sendCustomerAttentionAlert(db.prisma, notifications, c.id, morning);
      expect(notify).toHaveBeenCalledOnce();
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({
        needsHuman: true,
        attentionAlertStage: 2,
        nextAttentionAlertAt: null,
        ownerAttentionAlertAt: null,
      });
    });
    it("revisits deferred alerts when quiet hours change without moving a reminder before its deadline", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      await service.reconcile();
      const issue = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } });
      await db.prisma.customerConversation.update({
        where: { id: c.id },
        data: {
          nextAttentionAlertAt: new Date(Date.now() + 86400000),
          ownerAttentionAlertAt: new Date(Date.now() + 86400000),
        },
      });
      await service.manage(a.owner, a.owner.botId, "notifications", { quietHours: null });
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({
        nextAttentionAlertAt: new Date(issue.attentionStartedAt!.getTime() + 10 * 60000),
        ownerAttentionAlertAt: new Date(issue.attentionStartedAt!.getTime() + 30 * 60000),
      });
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
    });
    it.each(["resolved", "disabled", "archived", "removed"])(
      "rechecks a pending alert after its case or access is %s",
      async (change) => {
        const a = await setup();
        const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
        await service.process(c.id);
        if (change === "resolved")
          await createCustomerInbox(db.prisma).updateCase(a.owner, { id: c.id, state: "resolved" });
        else if (change === "disabled")
          await db.prisma.customerChannel.update({
            where: { id: a.channel.id },
            data: { enabled: false },
          });
        else if (change === "archived")
          await db.prisma.bot.update({
            where: { id: a.owner.botId },
            data: { archivedAt: new Date() },
          });
        else await db.prisma.spaceMember.deleteMany({ where: { spaceId: a.owner.spaceId } });
        await sendCustomerAttentionAlert(db.prisma, notifications, c.id);
        expect(notify).not.toHaveBeenCalled();
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject({ attentionAlertStage: 0 });
      },
    );
    it("alerts once per unresolved issue and starts a new alert after staff has replied", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      await service.reconcile();
      await receive(a, [incoming("follow-up")]);
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
      await createCustomerInbox(db.prisma).reply(a.owner, {
        id: c.id,
        body: "How can I help?",
        nonce: "staff-help",
      });
      await receive(a, [incoming("new-question")]);
      await service.reconcile();
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls[0]?.[1].operationId).not.toBe(notify.mock.calls[1]?.[1].operationId);
    });
    it("acknowledges an issue once, preserves the handoff, and audits each new issue", async () => {
      const a = await setup();
      const other = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      const inbox = createCustomerInbox(db.prisma);
      await expect(
        inbox.updateCase(other.owner, { id: c.id, acknowledge: true }),
      ).rejects.toThrow();
      // Reading the case does not accept responsibility for it.
      await inbox.updateCase(a.owner, { id: c.id, read: true });
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ acknowledgedAt: null });
      await Promise.all([
        inbox.updateCase(a.owner, { id: c.id, acknowledge: true }),
        inbox.updateCase(a.owner, { id: c.id, acknowledge: true }),
      ]);
      await receive(a, [incoming("more-context")]);
      await service.reconcile();
      expect(notify).not.toHaveBeenCalled();
      await expect(
        inbox.updateCase(a.owner, { id: c.id, acknowledge: true, state: "resolved" }),
      ).rejects.toThrow("Acknowledge or resolve");
      const snapshot = await createCustomerRepos(db.prisma).snapshot(a.owner, c.id);
      expect(snapshot.conversation).toMatchObject({
        needsHuman: true,
        owner: "staff",
        state: "open",
        acknowledgedAt: expect.any(String),
      });
      const actor = await db.prisma.user.findUniqueOrThrow({ where: { id: a.owner.userId } });
      const acknowledgement = snapshot.actions.find(
        (action) => action.name === "staff_acknowledged",
      );
      expect(acknowledgement?.status).toBe("completed");
      expect(JSON.parse(acknowledgement!.outcome!)).toMatchObject({
        acknowledgedBy: actor.name,
        customerSequence: 1,
        conversationVersion: expect.any(Number),
      });
      expect(
        await db.prisma.customerAcknowledgement.findMany({ where: { conversationId: c.id } }),
      ).toMatchObject([{ userId: a.owner.userId, customerSeq: 1 }]);
      await inbox.reply(a.owner, { id: c.id, body: "I can help", nonce: "help" });
      await receive(a, [incoming("next-issue")]);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ acknowledgedAt: null });
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
      await inbox.updateCase(a.owner, { id: c.id, acknowledge: true });
      expect(
        await db.prisma.customerAcknowledgement.count({ where: { conversationId: c.id } }),
      ).toBe(2);
      await db.prisma.customerConversation.delete({ where: { id: c.id } });
      expect(
        await db.prisma.customerAcknowledgement.count({ where: { conversationId: c.id } }),
      ).toBe(0);
    });
    it("keeps failed alert delivery pending and retries without clearing the handoff", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      notify.mockRejectedValueOnce(
        new NotificationDeliveryError("Notification unavailable", "rejected", true),
      );
      await service.reconcile();
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ needsHuman: true, attentionAlertStage: 0 });
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
      expect((await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).notificationIssue).toBe(
        "failed",
      );
      await db.prisma.customerConversation.update({
        where: { id: c.id },
        data: { nextAttentionAlertAt: new Date() },
      });
      await service.reconcile();
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls[0]?.[1].operationId).toBe(notify.mock.calls[1]?.[1].operationId);
      expect(
        (await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).notificationIssue,
      ).toBeNull();
    });
    it("records an uncertain notification without resending it or exposing provider errors", async () => {
      const a = await setup();
      const other = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      notify.mockRejectedValueOnce(new Error("Synthetic provider response that must stay private"));
      await service.reconcile();
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
      const snapshot = await createCustomerRepos(db.prisma).snapshot(a.owner, c.id);
      expect(snapshot.notificationIssue).toBe("uncertain");
      expect(snapshot.conversation.needsHuman).toBe(true);
      expect(snapshot.actions).toContainEqual(
        expect.objectContaining({ name: "staff_notification", status: "uncertain" }),
      );
      expect(JSON.stringify(snapshot)).not.toContain("Synthetic provider response");
      await expect(createCustomerRepos(db.prisma).snapshot(other.owner, c.id)).rejects.toThrow();
      await db.prisma.customerConversation.delete({ where: { id: c.id } });
      expect(await db.prisma.customerAlertDelivery.count({ where: { conversationId: c.id } })).toBe(
        0,
      );
    });
    it("persists dispatch before sending and recovers a failed receipt commit without a second send", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      notify.mockImplementationOnce(async () => {
        expect(
          await db.prisma.customerAlertDelivery.findFirst({ where: { conversationId: c.id } }),
        ).toMatchObject({ status: "sending", attempts: 1 });
        return { status: "accepted", reference: "synthetic-ticket" };
      });
      await db.pool.query(`CREATE FUNCTION test_alert_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status = 'accepted' THEN RAISE EXCEPTION 'Simulated receipt commit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_alert_receipt_failure BEFORE UPDATE ON customer_alert_deliveries FOR EACH ROW EXECUTE FUNCTION test_alert_receipt_failure()`);
      try {
        await service.reconcile();
      } finally {
        await db.pool.query(
          "DROP TRIGGER test_alert_receipt_failure ON customer_alert_deliveries; DROP FUNCTION test_alert_receipt_failure()",
        );
      }
      expect(
        await db.prisma.customerAlertDelivery.findFirst({ where: { conversationId: c.id } }),
      ).toMatchObject({ status: "sending", reference: null });
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
      await db.prisma.customerAlertDelivery.updateMany({
        where: { conversationId: c.id },
        data: { leaseUntil: new Date(0) },
      });
      await service.reconcile();
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
      expect((await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).notificationIssue).toBe(
        "uncertain",
      );
    });
    it("bounds retries of confirmed rejections and retains the failure for staff", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      const issue = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } });
      notify.mockRejectedValue(
        new NotificationDeliveryError("Synthetic rate limit", "rejected", true),
      );
      for (const minutes of [0, 1, 3]) {
        await expect(
          sendCustomerAttentionAlert(
            db.prisma,
            notifications,
            c.id,
            new Date(issue.attentionStartedAt!.getTime() + minutes * 60000),
          ),
        ).rejects.toThrow();
      }
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date(issue.attentionStartedAt!.getTime() + 4 * 60000),
      );
      expect(notify).toHaveBeenCalledTimes(3);
      expect(new Set(notify.mock.calls.map(([, context]) => context.operationId)).size).toBe(1);
      expect(
        await db.prisma.customerAlertDelivery.findFirst({ where: { conversationId: c.id } }),
      ).toMatchObject({ status: "failed", attempts: 3, retryable: false });
      expect((await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).notificationIssue).toBe(
        "failed",
      );
    });
    it("does not spend the provider retry budget on claims cancelled before dispatch", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      const now = new Date();
      // A competing case change commits with each claim, before the second access check.
      await db.pool.query(`CREATE FUNCTION test_alert_pre_dispatch_change() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status = 'sending' THEN
          UPDATE customer_conversations SET "nextAttentionAlertAt" = CURRENT_TIMESTAMP + INTERVAL '1 day' WHERE id = NEW."conversationId";
        END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_alert_pre_dispatch_change AFTER INSERT OR UPDATE ON customer_alert_deliveries FOR EACH ROW EXECUTE FUNCTION test_alert_pre_dispatch_change()`);
      try {
        for (let i = 0; i < 4; i++) {
          await db.prisma.customerConversation.update({
            where: { id: c.id },
            data: { nextAttentionAlertAt: now },
          });
          await sendCustomerAttentionAlert(db.prisma, notifications, c.id, now);
        }
      } finally {
        await db.pool.query(
          "DROP TRIGGER test_alert_pre_dispatch_change ON customer_alert_deliveries; DROP FUNCTION test_alert_pre_dispatch_change()",
        );
      }
      expect(notify).not.toHaveBeenCalled();
      expect(
        await db.prisma.customerAlertDelivery.findFirst({ where: { conversationId: c.id } }),
      ).toMatchObject({ status: "cancelled", attempts: 0 });
      await db.prisma.customerConversation.update({
        where: { id: c.id },
        data: { nextAttentionAlertAt: now },
      });
      notify.mockRejectedValueOnce(
        new NotificationDeliveryError("Synthetic rate limit", "rejected", true),
      );
      notify.mockRejectedValueOnce(
        new NotificationDeliveryError("Synthetic rate limit", "rejected", true),
      );
      for (const minutes of [0, 1]) {
        await expect(
          sendCustomerAttentionAlert(
            db.prisma,
            notifications,
            c.id,
            new Date(now.getTime() + minutes * 60000),
          ),
        ).rejects.toThrow();
      }
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date(now.getTime() + 3 * 60000),
      );
      expect(notify).toHaveBeenCalledTimes(3);
      expect(
        await db.prisma.customerAlertDelivery.findFirst({ where: { conversationId: c.id } }),
      ).toMatchObject({ status: "accepted", attempts: 3 });
    });
    it("records skipped and accepted notifications without claiming device delivery", async () => {
      const a = await setup();
      const c = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
      await service.process(c.id);
      notify.mockResolvedValueOnce({ status: "skipped" });
      await service.reconcile();
      expect(
        await db.prisma.customerAlertDelivery.findFirst({ where: { conversationId: c.id } }),
      ).toMatchObject({ status: "skipped", reference: null });
      expect(
        (await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).notificationIssue,
      ).toBeNull();
      const issue = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } });
      notify.mockResolvedValueOnce({ status: "accepted", reference: "synthetic-ticket" });
      await sendCustomerAttentionAlert(
        db.prisma,
        notifications,
        c.id,
        new Date(issue.attentionStartedAt!.getTime() + 10 * 60000),
      );
      expect(
        await db.prisma.customerAlertDelivery.findFirst({
          where: { conversationId: c.id, stage: 1 },
        }),
      ).toMatchObject({ status: "accepted", reference: "synthetic-ticket" });
    });
    it("loads approved learning and private guidance into the runtime without publishing guidance", async () => {
      const a = await setup();
      await createLearning(db.prisma).save(a.owner, {
        botId: a.owner.botId,
        scope: "space",
        kind: "voice",
        key: "brand-voice",
        title: "Voice",
        content: "Use concise Thai",
        customerVisible: true,
        expectedRevision: 0,
        reason: "Approved",
        source: "Synthetic examples",
      });
      const c = await receive(a);
      await createCustomerInbox(db.prisma).steer(a.owner, {
        id: c.id,
        nonce: "guide",
        guidance: "PRIVATE: ask for size",
      });
      await service.process(c.id);
      expect(reply.mock.calls[0]![0].customerContext).toContain("Use concise Thai");
      expect(reply.mock.calls[0]![0].customerContext).toContain("PRIVATE: ask for size");
      expect(JSON.stringify(sends)).not.toContain("PRIVATE:");
    });
    it.each([
      { body: "Please don't connect me to a human, just explain the sizes.", attention: false },
      { body: "ไม่อยากคุยกับแอดมินค่ะ ขอทราบขนาดกระเป๋า", attention: false },
      { body: "I do not currently want to talk to a human.", attention: false },
      { body: "I cannot right now speak with a person.", attention: false },
      {
        body: "Don't connect me to an agent. I need an exception to the refund policy.",
        attention: true,
      },
    ])(
      "assesses negated handoff requests without bypassing other escalation rules: $body",
      async ({ body, attention }) => {
        const a = await setup();
        await enableAssessment(a);
        const c = await receive(a, [{ ...incoming(), body }]);
        assess.mockResolvedValueOnce({
          needsHuman: attention,
          confidence: 0.99,
          reason: attention ? "Policy exception needs staff" : "Routine sizing question",
        });
        await service.process(c.id);
        expect(assess).toHaveBeenCalledOnce();
        expect(assess.mock.calls[0]![0].messages).toContainEqual({
          role: "customer",
          content: body,
        });
        expect(reply).toHaveBeenCalledTimes(attention ? 0 : 1);
        expect(
          await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } }),
        ).toMatchObject({
          owner: attention ? "staff" : "bot",
          needsHuman: attention,
        });
      },
    );
    it.each([
      "I can't wait to talk to a human.",
      "I don't want a refund and I want to talk to a human.",
      "ไม่อยากคืนสินค้า ขอคุยกับแอดมินค่ะ",
    ])(
      "hands off an affirmative request despite unrelated negation without waiting for assessment: %s",
      async (body) => {
        const a = await setup();
        await enableAssessment(a);
        assess.mockRejectedValue(new Error("Assessment unavailable"));
        const c = await receive(a, [{ ...incoming(), body }]);
        await service.process(c.id);
        expect(assess).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
        expect(
          await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } }),
        ).toMatchObject({
          owner: "staff",
          needsHuman: true,
          handoffReason: "Customer requested a human",
        });
      },
    );
    it("uses saved owner criteria for assessment and preserves them in the private decision audit", async () => {
      const a = await setup();
      const criteria = "Ask staff about wholesale orders of 50 or more items.";
      await enableAssessment(a, criteria);
      const inspection = await service.manage(a.owner, a.owner.botId, "inspect", {});
      expect(inspection).toMatchObject({ behavior: { assessment: { criteria } } });
      const c = await receive(a);
      assess.mockResolvedValueOnce({
        needsHuman: true,
        confidence: 0.95,
        reason: "A configured escalation rule requires staff",
      });
      await service.process(c.id);
      expect(assess).toHaveBeenCalledWith(expect.objectContaining({ criteria }));
      expect(reply).not.toHaveBeenCalled();
      expect(
        await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } }),
      ).toMatchObject({ owner: "staff", needsHuman: true });
      expect(
        await db.prisma.customerToolCall.findFirstOrThrow({
          where: { message: { conversationId: c.id }, name: "Escalation assessment" },
        }),
      ).toMatchObject({
        result: { criteria, provider: "jev", model: "jev-latest", needsHuman: true },
      });
      expect(JSON.stringify(sends)).not.toContain(criteria);
    });
    it("fences an in-flight assessment when owner criteria change and uses new criteria after handback", async () => {
      const a = await setup();
      await enableAssessment(a, "Ask staff about wholesale.");
      const c = await receive(a);
      let release!: (value: { needsHuman: boolean; confidence: number; reason: string }) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      assess.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const processing = service.process(c.id);
      await ready;
      const criteria = "Ask staff about custom-made items.";
      await service.manage(a.owner, a.owner.botId, "assessment", {
        config: {
          provider: "jev",
          baseUrl: "https://assessment.example.test/v1",
          credential: "escalation",
          criteria,
        },
      });
      release({ needsHuman: false, confidence: 0.99, reason: "Old criteria allow this" });
      await processing;
      expect(reply).not.toHaveBeenCalled();
      expect(
        await db.prisma.customerToolCall.count({ where: { name: "Escalation assessment" } }),
      ).toBe(0);
      expect(
        await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: c.id } }),
      ).toMatchObject({ owner: "staff" });
      await createCustomerInbox(db.prisma).setOwner(a.owner, c.id, "bot");
      await receive(a, [incoming("after-rule-change")]);
      await service.process(c.id);
      expect(assess).toHaveBeenLastCalledWith(expect.objectContaining({ criteria }));
      expect(reply).toHaveBeenCalledOnce();
    });
    it("reports unavailable assessment accurately and fences a late result after steering", async () => {
      const a = await setup();
      await enableAssessment(a);
      const c = await receive(a);
      assess.mockRejectedValueOnce(new Error("offline"));
      await service.process(c.id);
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({
        needsHuman: true,
        handoffReason: expect.stringContaining("assessment is unavailable"),
      });
      await createCustomerInbox(db.prisma).setOwner(a.owner, c.id, "bot");
      await receive(a, [incoming("next")]);
      let release!: (value: { needsHuman: boolean; confidence: number; reason: string }) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      assess.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const processing = service.process(c.id);
      await ready;
      await createCustomerInbox(db.prisma).steer(a.owner, {
        id: c.id,
        nonce: "new-guidance",
        guidance: "Ask for size first",
      });
      release({ needsHuman: true, confidence: 0.99, reason: "Stale assessment" });
      await processing;
      expect(
        await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
      ).toMatchObject({ owner: "bot", needsHuman: false });
      expect(
        await db.prisma.customerToolCall.count({ where: { name: "Escalation assessment" } }),
      ).toBe(0);
    });
    it.each(
      ["initialize", "configure", "instructions"].flatMap((operation) =>
        ["cancelled", "removed", "rejoined"].map((mode) => ({ operation, mode })),
      ),
    )(
      "rejects $operation publication when staff is $mode while publishing",
      async ({ operation, mode }) => {
        const a = await setup();
        const previous = await db.prisma.customerBehavior.findUniqueOrThrow({
          where: { botId: a.owner.botId },
        });
        const member = await db.prisma.spaceMember.findFirstOrThrow({
          where: { spaceId: a.owner.spaceId, userId: a.owner.userId },
        });
        if (operation === "initialize") {
          await db.prisma.customerBehavior.delete({ where: { botId: a.owner.botId } });
          await db.prisma.spaceModelPreference.create({
            data: {
              userId: a.owner.userId,
              spaceId: a.owner.spaceId,
              credentialId: a.credential.id,
              modelId: previous.modelId!,
              isDefault: true,
            },
          });
          await db.prisma.integrationProviderConfig.create({
            data: {
              id: customerReplyDefaultsId,
              ciphertext: f.secrets.seal(
                JSON.stringify({
                  baseUrl: "https://runtime.example.test/api/v1",
                  apiKey: "fixture-operator-key",
                }),
                customerReplyDefaultsId,
              ),
            },
          });
        }
        const controller = new AbortController();
        let publicationSignal: AbortSignal | undefined;
        beforePublish = async (signal) => {
          publicationSignal = signal;
          if (mode === "cancelled") controller.abort();
          else {
            await db.prisma.spaceMember.delete({ where: { id: member.id } });
            if (mode === "rejoined")
              await db.prisma.spaceMember.create({ data: { ...member, id: randomUUID() } });
          }
          // Simulate a service completing despite cancellation or revoked local access.
        };
        try {
          const result = await service
            .manage(
              a.owner,
              a.owner.botId,
              operation,
              operation === "initialize" ? {} : { ...previous, instructions: "Late publication" },
              controller.signal,
            )
            .then(
              () => "committed",
              () => "rejected",
            );
          const current = await db.prisma.customerBehavior.findUnique({
            where: { botId: a.owner.botId },
          });
          expect({ result, current }).toEqual({
            result: "rejected",
            current: operation === "initialize" ? null : previous,
          });
          expect(
            await db.prisma.customerPublication.findMany({
              where: { botId: a.owner.botId, status: "cleanup" },
              select: { confirmed: true, behavior: { select: { botId: true } } },
            }),
          ).toEqual([{ confirmed: true, behavior: null }]);
          if (mode === "cancelled") expect(publicationSignal?.aborted).toBe(true);
        } finally {
          if (operation === "initialize")
            await db.prisma.integrationProviderConfig.delete({
              where: { id: customerReplyDefaultsId },
            });
        }
      },
    );

    it("reports effective customer knowledge during preparation without exposing runtime configuration", async () => {
      const a = await setup();
      const learning = createLearning(db.prisma);
      for (const [scope, key, content, customerVisible] of [
        ["space", "shipping", "Shared shipping policy", true],
        ["bot", "shipping", "Shipping takes three business days", true],
        ["bot", "private", "PRIVATE_STAFF_SENTINEL", false],
      ] as const) {
        await learning.save(a.owner, {
          botId: a.owner.botId,
          scope,
          kind: "knowledge",
          key,
          title: key,
          content,
          customerVisible,
          expectedRevision: 0,
          reason: "Approved synthetic policy",
          source: "Synthetic fixture",
        });
      }
      const before = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      const expectedKnowledge = {
        approvedLearning: await learning.customerContext(a.owner.spaceId, a.owner.botId),
        documentLibraryAttached: false,
        legacySearchConfigured: false,
      };
      expect(expectedKnowledge.approvedLearning).toContain("three business days");
      expect(expectedKnowledge.approvedLearning).not.toContain("Shared shipping policy");
      expect(expectedKnowledge.approvedLearning).not.toContain("PRIVATE_STAFF_SENTINEL");
      const initialized = await service.manage(a.owner, a.owner.botId, "initialize", {});
      expect(initialized).toEqual({
        prepared: true,
        modelId: "fixture-model",
        customerKnowledge: expectedKnowledge,
      });
      expect(
        await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: a.owner.botId } }),
      ).toEqual(before);
      const inspection = await service.manage(a.owner, a.owner.botId, "inspect", {});
      expect(inspection).toMatchObject({ behavior: before, customerKnowledge: expectedKnowledge });
      expect(
        await service.manage(a.owner, a.owner.botId, "instructions", {
          instructions: "Approved public policy",
        }),
      ).toEqual({ prepared: true, modelId: "fixture-model", customerKnowledge: expectedKnowledge });
    });

    it("refreshes customer knowledge changed while publishing instructions", async () => {
      const a = await setup();
      const learning = createLearning(db.prisma);
      const policy = {
        botId: a.owner.botId,
        scope: "bot" as const,
        kind: "knowledge" as const,
        key: "shipping",
        title: "Shipping",
        content: "Shipping takes three days",
        customerVisible: true,
        expectedRevision: 0,
        reason: "Approved synthetic policy",
        source: "Synthetic fixture",
      };
      await learning.save(a.owner, policy);
      await knowledge.configure(a.owner, {
        botId: a.owner.botId,
        baseUrl: "http://127.0.0.1:8888/v1",
        apiKey: "fake-knowledge-key",
      });
      await knowledge.attach(a.owner, a.owner.botId, true);
      beforePublish = async () => {
        await learning.save(a.owner, {
          ...policy,
          content: "Shipping takes five days",
          expectedRevision: 1,
        });
        await knowledge.attach(a.owner, a.owner.botId, false);
      };
      const result = await service.manage(a.owner, a.owner.botId, "instructions", {
        instructions: "Approved public instructions",
      });
      expect(result).toEqual({
        prepared: true,
        modelId: "fixture-model",
        customerKnowledge: {
          approvedLearning: await learning.customerContext(a.owner.spaceId, a.owner.botId),
          documentLibraryAttached: false,
          legacySearchConfigured: false,
        },
      });
      expect(JSON.stringify(result)).toContain("five days");
    });

    it("prepares a new staff agent and practices replies without any customer channel or named secrets", async () => {
      const a = await setup();
      const configured = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      const bot = await db.prisma.bot.create({
        data: {
          userId: a.owner.userId,
          spaceId: a.owner.spaceId,
          name: "New merchant staff",
          color: "blue",
          instructions: "Private staff information",
        },
      });
      await db.prisma.spaceModelPreference.create({
        data: {
          userId: a.owner.userId,
          spaceId: a.owner.spaceId,
          credentialId: configured.modelCredentialId!,
          modelId: configured.modelId!,
          isDefault: true,
        },
      });
      await db.prisma.integrationProviderConfig.create({
        data: {
          id: customerReplyDefaultsId,
          ciphertext: f.secrets.seal(
            JSON.stringify({
              baseUrl: "https://runtime.example.test/api/v1",
              apiKey: "fixture-operator-key",
            }),
            customerReplyDefaultsId,
          ),
        },
      });
      try {
        const prepared = await service.manage(a.owner, bot.id, "initialize", {});
        expect(prepared).toEqual({
          prepared: true,
          modelId: configured.modelId,
          customerKnowledge: {
            approvedLearning: "",
            documentLibraryAttached: false,
            legacySearchConfigured: false,
          },
        });
        const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({
          where: { botId: bot.id },
        });
        expect(behavior).toMatchObject({
          instructions: defaultCustomerInstructions,
          runtime: {
            credential: managedCustomerRuntime,
            baseUrl: "https://runtime.example.test/api/v1",
          },
          actions: [],
          revision: 1,
        });
        expect(JSON.stringify(behavior)).not.toContain("fixture-operator-key");
        expect(await db.prisma.botSecret.count({ where: { botId: bot.id } })).toBe(0);
        expect(await db.prisma.customerChannel.count({ where: { botId: bot.id } })).toBe(0);
        await service.manage(a.owner, bot.id, "instructions", {
          instructions: "Use only the approved catalog. Ask staff for missing stock information.",
        });
        await expect(
          service.manage(a.owner, bot.id, "preview", { message: "Is the blue shirt in stock?" }),
        ).resolves.toMatchObject({ status: "reply", revision: 2 });
        expect(reply.mock.calls[0]![0].instructions).toBe(
          "Use only the approved catalog. Ask staff for missing stock information.",
        );
        expect(JSON.stringify(reply.mock.calls)).not.toContain("Private staff information");
        expect(sends).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
        expect(await db.prisma.customerChannel.count({ where: { botId: bot.id } })).toBe(0);
        const publications = flowOrdinal;
        await expect(service.manage(a.owner, bot.id, "initialize", {})).resolves.toEqual(prepared);
        expect(
          await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: bot.id } }),
        ).toMatchObject({
          revision: 2,
          instructions: "Use only the approved catalog. Ask staff for missing stock information.",
        });
        expect(flowOrdinal).toBe(publications);
      } finally {
        await db.prisma.integrationProviderConfig.delete({
          where: { id: customerReplyDefaultsId },
        });
      }
    });

    it("initializes customer replies once with owned model defaults and preserves custom behavior", async () => {
      const a = await setup();
      const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      const bot = await db.prisma.bot.create({
        data: {
          userId: a.owner.userId,
          spaceId: a.owner.spaceId,
          name: "New staff",
          color: "blue",
          instructions: "Private staff instructions must not reach customers",
        },
      });
      await db.prisma.customerChannel.update({
        where: { id: a.channel.id },
        data: { botId: bot.id, autoReplies: false },
      });
      const enableReplies = () =>
        service.manage(a.owner, bot.id, "channel", { id: a.channel.id, autoReplies: true });
      await expect(
        service.manage(a.owner, bot.id, "channel", { id: a.channel.id, autoReplies: false }),
      ).resolves.toEqual({ ok: true });
      await expect(enableReplies()).rejects.toThrow("Choose a model");
      await db.prisma.spaceModelPreference.create({
        data: {
          userId: a.owner.userId,
          spaceId: a.owner.spaceId,
          credentialId: behavior.modelCredentialId!,
          modelId: behavior.modelId!,
          isDefault: true,
        },
      });
      await expect(enableReplies()).rejects.toThrow("server operator");
      await db.prisma.integrationProviderConfig.create({
        data: {
          id: customerReplyDefaultsId,
          ciphertext: f.secrets.seal(
            JSON.stringify({
              baseUrl: "https://runtime.example.test/api/v1",
              apiKey: "fixture-operator-key",
            }),
            customerReplyDefaultsId,
          ),
        },
      });
      try {
        const b = await setup();
        await expect(service.manage(b.owner, bot.id, "initialize", {})).rejects.toThrow();
        const beforeDenied = flowOrdinal;
        await expect(
          service.manage(a.owner, bot.id, "channel", { id: b.channel.id, autoReplies: true }),
        ).rejects.toThrow();
        expect(flowOrdinal).toBe(beforeDenied);
        failPublish = true;
        await expect(enableReplies()).rejects.toThrow("Reply service offline");
        expect(
          await db.prisma.customerBehavior.findUnique({ where: { botId: bot.id } }),
        ).toBeNull();
        expect(
          await db.prisma.customerChannel.findUniqueOrThrow({ where: { id: a.channel.id } }),
        ).toMatchObject({ enabled: true, autoReplies: false });
        failPublish = false;
        const [enabled, initialized] = await Promise.all([
          enableReplies(),
          service.manage(a.owner, bot.id, "initialize", {}),
        ]);
        expect(enabled).toEqual({ ok: true });
        expect(initialized).toEqual({
          prepared: true,
          modelId: behavior.modelId,
          customerKnowledge: {
            approvedLearning: "",
            documentLibraryAttached: false,
            legacySearchConfigured: false,
          },
        });
        expect(
          await db.prisma.customerChannel.findUniqueOrThrow({ where: { id: a.channel.id } }),
        ).toMatchObject({ autoReplies: true });
        expect(
          await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: bot.id } }),
        ).toMatchObject({
          instructions: defaultCustomerInstructions,
          modelCredentialId: behavior.modelCredentialId,
          modelId: behavior.modelId,
          actions: [],
          knowledgeFilterId: null,
          revision: 1,
        });
        expect(await db.prisma.botSecret.count({ where: { botId: bot.id } })).toBe(0);
        await expect(
          service.manage(a.owner, bot.id, "configure", {
            ...behavior,
            runtime: {
              credential: managedCustomerRuntime,
              baseUrl: "https://wrong.example.test/api/v1",
            },
          }),
        ).rejects.toThrow();
        await service.manage(a.owner, bot.id, "instructions", {
          instructions: "Approved custom public instructions",
        });
        const customized = await db.prisma.customerBehavior.findUniqueOrThrow({
          where: { botId: bot.id },
        });
        const publications = flowOrdinal;
        failPublish = true;
        await service.manage(a.owner, bot.id, "channel", {
          id: a.channel.id,
          autoReplies: false,
        });
        await enableReplies();
        expect(await service.manage(a.owner, bot.id, "initialize", {})).toEqual(initialized);
        expect(
          await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: bot.id } }),
        ).toEqual(customized);
        expect(flowOrdinal).toBe(publications);
        expect(await service.manage(a.owner, a.owner.botId, "initialize", {})).toEqual(initialized);
        expect(
          await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: a.owner.botId } }),
        ).toEqual(behavior);
      } finally {
        await db.prisma.integrationProviderConfig.delete({
          where: { id: customerReplyDefaultsId },
        });
      }
    });

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
    it("continues customer replies while automatic learning is paused", async () => {
      const a = await setup();
      await service.manage(a.owner, a.owner.botId, "learning_configure", { enabled: false });
      const conversation = await receive(a);
      await service.process(conversation.id);
      expect(sends).toHaveLength(1);
      expect(
        (await db.prisma.customerChannel.findUniqueOrThrow({ where: { id: a.channel.id } }))
          .pollError,
      ).toBeNull();
    });
    it("shares cases only with live space members and revokes access when made private", async () => {
      const a = await setup();
      const b = await setup();
      const conversation = await receive(a, [{ ...incoming(), body: "ขอคุยกับแอดมินค่ะ" }]);
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
      await service.process(conversation.id);
      await service.reconcile();
      expect(notify).toHaveBeenCalledOnce();
      expect(notify.mock.calls[0]?.[1]).toMatchObject({ userId: a.owner.userId });
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

    it("expires case evidence and completed receipts without erasing open work or duplicate-prevention records", async () => {
      const a = await setup();
      await db.prisma.customerChannel.update({
        where: { id: a.channel.id },
        data: { retentionDays: 7 },
      });
      const old = new Date(Date.now() - 40 * 86400000);
      const cases = [];
      for (const state of ["expired", "recent", "recovered", "open", "leased", "sending"]) {
        const conversation = await db.prisma.customerConversation.create({
          data: {
            channelId: a.channel.id,
            externalThreadId: state,
            customerId: state,
            name: "Synthetic case",
            state: state === "open" ? "open" : "resolved",
            updatedAt: ["recent", "recovered"].includes(state) ? new Date() : old,
            leaseUntil: state === "leased" ? new Date(Date.now() + 60000) : null,
            messages: {
              create: {
                seq: 1,
                role: "staff",
                body: "Synthetic reply",
                status: state === "sending" ? "sending" : "sent",
              },
            },
            alertDeliveries: {
              create: {
                attentionId: randomUUID(),
                stage: 0,
                recipientId: a.owner.userId,
                provider: "fixture",
                status: "uncertain",
              },
            },
            visitorSessions: {
              create: {
                tokenHash: randomUUID(),
                origin: "https://shop.example.test",
                expiresAt: new Date(Date.now() + 60000),
              },
            },
          },
        });
        const task = await db.prisma.learningTask.create({
          data: {
            spaceId: a.owner.spaceId,
            userId: a.owner.userId,
            botId: a.owner.botId,
            conversationId: conversation.id,
            sourceKey: state,
            evidence: { reply: "Synthetic reply" },
            status: "rejected",
            summarizedAt: new Date(),
            reviews: { create: { userId: a.owner.userId, decision: "reject", reason: "One-off" } },
          },
        });
        const operation = await db.prisma.customerOperation.create({
          data: {
            id: randomUUID(),
            spaceId: a.owner.spaceId,
            requestHash: "synthetic-hash",
            status: ["recent", "recovered"].includes(state) ? "completed" : "uncertain",
            updatedAt: state === "recovered" ? new Date() : old,
            receipt: {
              create: {
                conversationId: conversation.id,
                connectionId: "fixture",
                action: "order",
                recordKey: state,
                mapping: {},
                result: { orderId: "synthetic-order" },
                createdAt: old,
              },
            },
          },
        });
        cases.push({ state, conversation, task, operation });
      }
      const sharedDocument = await createLearning(db.prisma).save(a.owner, {
        botId: a.owner.botId,
        scope: "space",
        kind: "voice",
        key: "brand-voice",
        title: "Voice",
        content: "Be clear",
        expectedRevision: 0,
        customerVisible: true,
        reason: "Approved style",
        source: "Synthetic staff reply",
        sourceRef: { kind: "conversation", id: cases[0]!.conversation.id },
      });
      // Save validates an active source. Disable the channel only for reconciliation.
      await db.prisma.customerChannel.update({
        where: { id: a.channel.id },
        data: { enabled: false },
      });
      await service.reconcile();
      await service.reconcile();
      for (const { state, conversation, task, operation } of cases) {
        const remains = state === "expired" ? 0 : 1;
        expect(
          await db.prisma.customerConversation.count({ where: { id: conversation.id } }),
          state,
        ).toBe(remains);
        expect(
          await db.prisma.customerMessage.count({ where: { conversationId: conversation.id } }),
          state,
        ).toBe(remains);
        expect(await db.prisma.learningTask.count({ where: { id: task.id } }), state).toBe(remains);
        expect(
          await db.prisma.learningTaskReview.count({ where: { taskId: task.id } }),
          state,
        ).toBe(remains);
        expect(
          await db.prisma.customerAlertDelivery.count({
            where: { conversationId: conversation.id },
          }),
          state,
        ).toBe(remains);
        expect(
          await db.prisma.customerVisitorSession.count({
            where: { conversationId: conversation.id },
          }),
          state,
        ).toBe(remains);
        expect(
          await db.prisma.customerOperationReceipt.count({ where: { operationId: operation.id } }),
          state,
        ).toBe(state === "recent" ? 0 : remains);
        expect(
          await db.prisma.customerOperation.count({ where: { id: operation.id } }),
          state,
        ).toBe(1);
      }
      expect(
        await db.prisma.learningDocument.findUnique({ where: { id: sharedDocument.id } }),
      ).toMatchObject({ content: "Be clear" });
      const history = await db.prisma.learningRevision.findFirstOrThrow({
        where: { documentId: sharedDocument.id },
      });
      await expect(
        createLearning(db.prisma).evidence(a.owner, {
          botId: a.owner.botId,
          revisionId: history.id,
        }),
      ).rejects.toThrow();
    });

    it.each(["creating", "updating", "submitting", "uncertain"])(
      "preserves %s purchase recovery through case deletion and retention",
      async (status) => {
        const a = await setup();
        await db.prisma.customerChannel.update({
          where: { id: a.channel.id },
          data: { retentionDays: 1 },
        });
        const conversation = await db.prisma.customerConversation.create({
          data: {
            channelId: a.channel.id,
            externalThreadId: "purchase-recovery",
            customerId: "shopper",
            name: "Shopper",
            state: "resolved",
            updatedAt: new Date(0),
          },
        });
        const purchase = await db.prisma.customerPurchase.create({
          data: {
            id: randomUUID(),
            conversationId: conversation.id,
            customerId: "shopper",
            connectionId: a.account.id,
            providerRef: a.alias,
            requestHash: "synthetic",
            paymentMethods: ["bacs"],
            status,
            actionId: randomUUID(),
            actionKind: "checkout",
          },
        });
        await service.reconcile();
        expect(await db.prisma.customerPurchase.count({ where: { id: purchase.id } })).toBe(1);
        await expect(
          service.manage(a.owner, a.owner.botId, "delete", { id: conversation.id }),
        ).rejects.toThrow("pending work");
        // A confirmed receipt is ordinary retained case data; unresolved requests are not.
        await db.prisma.customerPurchase.update({
          where: { id: purchase.id },
          data: { status: "submitted", actionId: null, actionKind: null },
        });
        if (status === "uncertain") await service.reconcile();
        else await service.manage(a.owner, a.owner.botId, "delete", { id: conversation.id });
        expect(await db.prisma.customerPurchase.count({ where: { id: purchase.id } })).toBe(0);
      },
    );

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

    it("previews the configured customer voice before enabling a real channel", async () => {
      const a = await setup();
      await service.manage(a.owner, a.owner.botId, "channel", {
        id: a.channel.id,
        enabled: false,
        autoReplies: false,
      });
      await createLearning(db.prisma).save(a.owner, {
        botId: a.owner.botId,
        scope: "space",
        kind: "voice",
        key: "brand-voice",
        title: "Voice",
        content: "Use concise Thai",
        customerVisible: true,
        expectedRevision: 0,
        reason: "Approved",
        source: "Synthetic examples",
      });
      const before = await db.prisma.customerChannel.count();
      const result = await service.manage(a.owner, a.owner.botId, "preview", {
        message: "ช่วยแนะนำสินค้าได้ไหม",
      });
      expect(result).toMatchObject({ status: "reply", reply: "reply from flow-1", revision: 1 });
      expect(reply.mock.calls[0]![0]).toMatchObject({
        instructions: "Public menu only",
        customerContext: expect.stringContaining("Use concise Thai"),
        messages: [{ role: "user", content: "ช่วยแนะนำสินค้าได้ไหม" }],
      });
      expect(sends).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
      expect(await db.prisma.customerChannel.count()).toBe(before);
      expect(await db.prisma.customerConversation.count()).toBe(0);
      expect(await db.prisma.learningTask.count()).toBe(0);
      expect(
        await db.prisma.customerChannel.findUnique({ where: { id: a.channel.id } }),
      ).toMatchObject({ enabled: false, autoReplies: false });
    });

    it("previews handoff without contacting customers or notifying staff", async () => {
      const a = await setup();
      const result = await service.manage(a.owner, a.owner.botId, "preview", {
        message: "I want to talk to a human",
      });
      expect(result).toMatchObject({ status: "handoff", reason: "Customer requested a human" });
      expect(reply).not.toHaveBeenCalled();
      expect(sends).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
      expect(await db.prisma.customerConversation.count()).toBe(0);
    });

    it("previews public reads and knowledge but denies private records, writes and raw sends", async () => {
      for (const [name, readOnly] of [
        ["promotion", true],
        ["order", true],
        ["refund", false],
      ] as const)
        f.providers[0]!.actions.push({
          ...sampleAction,
          id: `sample.${name}`,
          readOnly,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        });
      const a = await setup();
      const source = await uploadPolicy(a);
      await knowledge.setInternal(a.owner, a.owner.botId, source.id, false);
      const schema = { type: "object", properties: {}, additionalProperties: false };
      const ownerRead = {
        name: "owner",
        action: "sample.order",
        input: { id: "$customerId" },
        effect: "read",
        check: { path: ["customerId"], equals: "$customerId" },
      };
      const grants = [
        {
          name: "promotion",
          description: "Public offer",
          audience: "public",
          connectionId: a.account.id,
          inputSchema: schema,
          steps: [{ name: "lookup", action: "sample.promotion", input: {}, effect: "read" }],
        },
        {
          name: "private_order",
          description: "Private order",
          audience: "customer",
          connectionId: a.account.id,
          inputSchema: schema,
          steps: [ownerRead],
        },
        {
          name: "refund",
          description: "Refund",
          audience: "public",
          connectionId: a.account.id,
          inputSchema: schema,
          steps: [
            ownerRead,
            {
              name: "refund",
              action: "sample.refund",
              effect: "write",
              input: { orderId: "$steps.owner.id" },
              operationKey: "$steps.owner.id",
              receipt: { id: ["id"] },
            },
          ],
        },
      ];
      const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      await service.manage(a.owner, a.owner.botId, "configure", { ...behavior, actions: grants });
      const perform = vi.fn((action) =>
        action === "sample.promotion" ? { offer: "Approved current offer" } : {},
      );
      businessHandler = perform;
      let previewToken = "";
      reply.mockImplementationOnce(async (request) => {
        previewToken = request.executionContext!.token;
        expect(
          (await service.tools.list(previewToken)).tools.map((tool) => tool.name).sort(),
        ).toEqual(["promotion", "request_human", "search_knowledge"]);
        for (const name of ["private_order", "refund", "openconnector_sample_send"])
          await expect(
            service.tools.execute(previewToken, { name, callId: name, arguments: {} }),
          ).rejects.toThrow();
        await expect(
          service.tools.execute(previewToken, {
            name: "promotion",
            callId: "public",
            arguments: {},
          }),
        ).resolves.toEqual({ offer: "Approved current offer" });
        await service.tools.execute(previewToken, {
          name: "search_knowledge",
          callId: "knowledge",
          arguments: { query: "return policy" },
        });
        // A concurrent reconciler must not publish or alert on this temporary case.
        await service.reconcile();
        expect((await createCustomerRepos(db.prisma).list(a.owner)).length).toBe(0);
        return "Practice answer";
      });
      await expect(
        service.manage(a.owner, a.owner.botId, "preview", { message: "What is the offer?" }),
      ).resolves.toMatchObject({
        status: "reply",
        reply: "Practice answer",
        actions: [
          { name: "promotion", status: "completed" },
          { name: "search_knowledge", status: "completed" },
        ],
      });
      expect(perform).toHaveBeenCalledTimes(1);
      expect(knowledgeFixture.provider.search).toHaveBeenCalled();
      expect(sends).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
      expect(await db.prisma.learningTask.count()).toBe(0);
      await expect(service.tools.list(previewToken)).rejects.toThrow();
    });

    it.each(["handoff", "unavailable", "runtime-failure"])(
      "previews %s and removes temporary state",
      async (mode) => {
        const a = await setup();
        await enableAssessment(a);
        if (mode === "handoff")
          assess.mockResolvedValueOnce({
            needsHuman: true,
            confidence: 0.98,
            reason: "Staff approval needed",
          });
        if (mode === "unavailable") assess.mockRejectedValueOnce(new Error("Offline assessment"));
        if (mode === "runtime-failure")
          reply.mockRejectedValueOnce(new Error("Offline reply service"));
        const result = await service.manage(a.owner, a.owner.botId, "preview", {
          message: "Can you help with this order?",
        });
        expect(result).toMatchObject({ status: mode === "handoff" ? "handoff" : "failed" });
        if (mode === "handoff")
          expect(result).toMatchObject({ assessment: { reason: "Staff approval needed" } });
        expect(await db.prisma.customerConversation.count()).toBe(0);
        expect(sends).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
      },
    );

    it("previews only owned active behavior and fences a revision change", async () => {
      const a = await setup();
      const b = await setup();
      await expect(
        service.manage(b.owner, a.owner.botId, "preview", { message: "Hello" }),
      ).rejects.toThrow();
      await expect(
        service.manage(a.owner, a.owner.botId, "preview", { message: " " }),
      ).rejects.toThrow();
      reply.mockImplementationOnce(async () => {
        await service.manage(a.owner, a.owner.botId, "instructions", {
          instructions: "Updated approved wording",
        });
        return "Stale sample";
      });
      await expect(
        service.manage(a.owner, a.owner.botId, "preview", { message: "Hello" }),
      ).rejects.toThrow("changed");
      expect(await db.prisma.customerConversation.count()).toBe(0);
      expect(sends).toHaveLength(0);
    });

    it("stops a customer preview with the staff run and discards the late answer", async () => {
      const a = await setup();
      const controller = new AbortController();
      let runtimeAborted = false;
      reply.mockImplementationOnce(async (request) => {
        controller.abort(new Error("Staff stopped practice"));
        runtimeAborted = request.signal.aborted;
        return "Late practice answer";
      });
      await expect(
        service.manage(a.owner, a.owner.botId, "preview", { message: "Hello" }, controller.signal),
      ).rejects.toThrow("Staff stopped practice");
      expect(runtimeAborted).toBe(true);
      expect(await db.prisma.customerConversation.count()).toBe(0);
      expect(sends).toHaveLength(0);
    });

    it("keeps a customer preview interrupted after owner removal and rejoin", async () => {
      const a = await setup();
      reply.mockImplementationOnce(async () => {
        const member = await db.prisma.spaceMember.findFirstOrThrow({
          where: { spaceId: a.owner.spaceId, userId: a.owner.userId },
        });
        await db.prisma.spaceMember.delete({ where: { id: member.id } });
        await db.prisma.spaceMember.create({ data: { ...member, id: randomUUID() } });
        return "Reply from revoked authority";
      });
      await expect(
        service.manage(a.owner, a.owner.botId, "preview", { message: "Hello" }),
      ).rejects.toThrow("interrupted");
      expect(await db.prisma.customerConversation.count()).toBe(0);
      expect(sends).toHaveLength(0);
    });

    it("removes expired customer previews after a worker crash without touching live channels", async () => {
      const a = await setup();
      const channels = [];
      for (const expired of [true, false]) {
        const channel = await db.prisma.customerChannel.create({
          data: {
            spaceId: a.owner.spaceId,
            userId: a.owner.userId,
            botId: a.owner.botId,
            provider: "deskazo-preview",
            accountId: randomUUID(),
            name: "Practice",
            ciphertext: "",
            autoReplies: true,
            createdAt: new Date(Date.now() - (expired ? 360000 : 0)),
          },
        });
        channels.push(channel);
        await createCustomerInbox(db.prisma).receive(channel.id, {
          externalId: "sample",
          externalThreadId: "practice",
          customerId: "sample",
          name: "Practice customer",
          body: "Hello",
        });
      }
      await service.reconcile();
      expect(await db.prisma.customerChannel.count({ where: { id: channels[0]!.id } })).toBe(0);
      expect(await db.prisma.customerChannel.count({ where: { id: channels[1]!.id } })).toBe(1);
      expect(
        await db.prisma.customerChannel.findUnique({ where: { id: a.channel.id } }),
      ).toMatchObject({ enabled: true });
      expect(await createCustomerRepos(db.prisma).list(a.owner)).toEqual([]);
      expect(reply).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(sends).toHaveLength(0);
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
    it.each(["active", "removed", "rejoined", "organization-removed"])(
      "fences website replies and execution tokens when channel membership is %s",
      async (mode) => {
        const a = await setup();
        const { channelId } = (await service.manage(a.owner, a.owner.botId, "website", {
          name: "Website",
          origins: ["https://shop.example.test"],
        })) as { channelId: string };
        const id = await createCustomerInbox(db.prisma).receive(channelId, {
          externalId: "membership-question",
          externalThreadId: "visitor",
          customerId: "visitor",
          name: "Visitor",
          body: "Hello",
        });
        const member = await db.prisma.spaceMember.findFirstOrThrow({
          where: { spaceId: a.owner.spaceId, userId: a.owner.userId },
        });
        if (mode === "organization-removed") {
          const other = await setup();
          await db.prisma.member.create({
            data: {
              id: randomUUID(),
              organizationId: member.organizationId,
              userId: other.owner.userId,
              role: "owner",
              createdAt: new Date(),
            },
          });
        }
        let toolsAvailable = false;
        reply.mockImplementation(async (request) => {
          if (mode !== "active") {
            if (mode === "organization-removed")
              await db.prisma.member.deleteMany({
                where: { organizationId: member.organizationId, userId: member.userId },
              });
            else await db.prisma.spaceMember.delete({ where: { id: member.id } });
            if (mode === "rejoined")
              await db.prisma.spaceMember.create({ data: { ...member, id: randomUUID() } });
          }
          toolsAvailable = await service.tools.list(request.executionContext!.token).then(
            () => true,
            () => false,
          );
          return "Reply generated before membership changed";
        });
        await service.process(id);
        expect(reply).toHaveBeenCalledTimes(1);
        expect(
          await db.prisma.spaceMember.count({
            where: { spaceId: a.owner.spaceId, userId: a.owner.userId },
          }),
        ).toBe(mode === "active" || mode === "rejoined" ? 1 : 0);
        expect(toolsAvailable).toBe(mode === "active");
        expect(
          await db.prisma.customerMessage.count({
            where: { conversationId: id, role: "bot", status: "sent" },
          }),
        ).toBe(mode === "active" ? 1 : 0);
        expect(
          await db.prisma.customerChannel.findUnique({ where: { id: channelId } }),
        ).toMatchObject({ enabled: mode === "active", autoReplies: mode === "active" });
      },
    );

    it("cancels queued website staff replies when the channel owner leaves", async () => {
      const a = await setup();
      const { channelId } = (await service.manage(a.owner, a.owner.botId, "website", {
        name: "Website",
        origins: ["https://shop.example.test"],
      })) as { channelId: string };
      const inbox = createCustomerInbox(db.prisma);
      const id = await inbox.receive(channelId, {
        externalId: "queued-question",
        externalThreadId: "visitor",
        customerId: "visitor",
        name: "Visitor",
        body: "Hello",
      });
      await inbox.setOwner(a.owner, id, "staff");
      await inbox.reply(a.owner, { id, body: "Queued staff reply", nonce: "queued-staff" });
      await db.prisma.spaceMember.deleteMany({
        where: { spaceId: a.owner.spaceId, userId: a.owner.userId },
      });
      await service.process(id);
      expect(
        await db.prisma.customerMessage.findFirst({
          where: { conversationId: id, body: "Queued staff reply" },
        }),
      ).toMatchObject({ status: "cancelled" });
      expect(reply).not.toHaveBeenCalled();
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

    it("authenticates withdrawals, suppresses reordered originals and fences a running reply", async () => {
      const a = await setup();
      const keyId = randomUUID();
      await db.prisma.secret.create({
        data: {
          id: keyId,
          userId: a.owner.userId,
          spaceId: a.owner.spaceId,
          kind: "webhook",
          ciphertext: f.secrets.seal("fake-key", keyId),
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
            webhook: { secretId: keyId, header: "x-signature", encoding: "base64" },
            fields: { ...binding().receive.fields, providerMessageId: ["messageId"] },
            withdrawal: { event: { path: ["type"], equals: "unsend" }, messageId: ["withdrawnId"] },
          },
        },
      });
      const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
      const ingress = createCustomerIngress({
        prisma: db.prisma,
        secrets: f.secrets,
        integrations: new IntegrationProviderSettings(db.prisma, f.secrets, "test", {
          "open-connector": f.adapter,
        }),
        jobs,
      });
      const deliver = (messages: unknown[], account = "account", valid = true) => {
        const raw = JSON.stringify({ account, messages });
        return ingress.receive(
          a.channel.id,
          new Headers({
            "x-signature": valid
              ? createHmac("sha256", "fake-key").update(raw).digest("base64")
              : "forged",
          }),
          raw,
        );
      };
      const original = (id: string) => ({
        ...incoming(id),
        messageId: id,
        at: new Date(Date.now() + 1000).toISOString(),
      });
      const withdrawal = (id: string) => ({ type: "unsend", thread: "thread", withdrawnId: id });
      await expect(deliver([withdrawal("one")], "account", false)).rejects.toThrow("signature");
      await deliver([withdrawal("one")], "another-account");
      expect(
        await db.prisma.customerMessageWithdrawal.count({ where: { channelId: a.channel.id } }),
      ).toBe(0);
      await deliver([original("early"), withdrawal("early")]);
      expect(
        await db.prisma.customerConversation.count({ where: { channelId: a.channel.id } }),
      ).toBe(0);
      await deliver([original("one")]);
      const c = await db.prisma.customerConversation.findFirstOrThrow({
        where: { channelId: a.channel.id },
      });
      let finish!: (value: string) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      reply.mockImplementationOnce(async () => {
        started();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      });
      const running = service.process(c.id);
      await ready;
      try {
        await deliver([withdrawal("one")]);
      } finally {
        finish("This response must never be sent");
        await running;
      }
      expect(sends).toHaveLength(0);
      expect(
        await db.prisma.customerMessage.findFirst({
          where: { conversationId: c.id, role: "customer" },
        }),
      ).toMatchObject({ body: "", status: "withdrawn" });
      await deliver([original("one")]);
      expect(await db.prisma.customerMessage.count({ where: { conversationId: c.id } })).toBe(1);
      await createCustomerInbox(db.prisma).setOwner(a.owner, c.id, "bot");
      await deliver([original("two")]);
      await service.process(c.id);
      expect(reply.mock.calls.at(-1)![0].messages).toEqual([
        { role: "user", content: "question two" },
      ]);
      expect(sends).toHaveLength(1);
      await service.manage(a.owner, a.owner.botId, "disconnect", { channelId: a.channel.id });
      await deliver([withdrawal("two")]);
      expect(
        await db.prisma.customerMessage.findFirst({
          where: { conversationId: c.id, externalId: "in:two" },
        }),
      ).toMatchObject({ body: "", status: "withdrawn" });
      await expect(deliver([original("three")])).rejects.toThrow("unavailable");
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

    it("retains a dispatched send identity but not late tool content after source withdrawal", async () => {
      const a = await setup();
      const c = await receive(a);
      const source = await db.prisma.customerMessage.findFirstOrThrow({
        where: { conversationId: c.id, role: "customer" },
      });
      await db.prisma.customerMessage.update({
        where: { id: source.id },
        data: { providerHandle: "source-message" },
      });
      let finish!: (value: unknown) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      sendStarted = started;
      holdSend = new Promise((resolve) => {
        finish = resolve;
      });
      reply.mockImplementationOnce(async (request) => {
        await service.tools.execute(request.executionContext!.token, {
          name: "openconnector_execute_tool",
          callId: "explicit-reply",
          arguments: {
            id: `${a.account.id}:sample.send`,
            arguments: { to: "thread", texts: ["Already dispatched reply"] },
          },
        });
        return "Do not send another reply";
      });
      const running = service.process(c.id);
      await ready;
      try {
        await createCustomerInbox(db.prisma).withdraw(a.channel.id, {
          externalThreadId: "thread",
          providerMessageId: "source-message",
        });
      } finally {
        finish({ id: "accepted", private: source.body });
        await running;
      }
      await reply.mock.results[0]!.value;
      expect(sends).toHaveLength(1);
      expect(
        await db.prisma.customerToolCall.findUnique({
          where: { messageId_callId: { messageId: source.id, callId: "explicit-reply" } },
        }),
      ).toMatchObject({ status: "completed", result: null, replyBody: null });
      expect(
        await db.prisma.customerMessage.count({ where: { conversationId: c.id, role: "bot" } }),
      ).toBe(0);
      expect(
        await db.prisma.customerMessage.findUnique({ where: { id: source.id } }),
      ).toMatchObject({ body: "", status: "withdrawn" });
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
        readOnly: true,
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

    it.each([false, undefined])(
      "rejects mislabeled reads at publication and for old stored workflows: %s",
      async (readOnly) => {
        f.providers[0]!.actions.push({
          ...sampleAction,
          id: "sample.refund",
          readOnly,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        });
        const a = await setup();
        const grant = {
          audience: "public",
          name: "lookup",
          description: "A mislabeled read",
          connectionId: a.account.id,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          steps: [{ name: "lookup", action: "sample.refund", input: {}, effect: "read" }],
        };
        const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({
          where: { botId: a.owner.botId },
        });
        const publications = flowOrdinal;
        await expect(
          service.manage(a.owner, a.owner.botId, "configure", { ...behavior, actions: [grant] }),
        ).rejects.toThrow("effect");
        expect(flowOrdinal).toBe(publications);
        expect(
          (await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: a.owner.botId } }))
            .revision,
        ).toBe(behavior.revision);
        // Rows written before publication checks existed must still be denied at dispatch.
        await db.prisma.customerBehavior.update({
          where: { botId: a.owner.botId },
          data: { actions: [grant] },
        });
        const perform = vi.fn(() => ({ refunded: true }));
        businessHandler = perform;
        reply.mockImplementationOnce(async (request) => {
          expect(
            (await service.tools.list(request.executionContext!.token)).tools.map(
              (tool) => tool.name,
            ),
          ).not.toContain("lookup");
          await expect(
            service.tools.execute(request.executionContext!.token, {
              name: "lookup",
              callId: "unsafe",
              arguments: {},
            }),
          ).rejects.toThrow("unavailable");
          return "Staff must check this operation.";
        });
        const c = await receive(a);
        await service.process(c.id);
        await reply.mock.results[0]!.value;
        expect(perform).not.toHaveBeenCalled();
        expect(
          await db.prisma.customerOperation.count({ where: { spaceId: a.owner.spaceId } }),
        ).toBe(0);
      },
    );

    it.each(["read", "revoke", "replace-account"])(
      "uses a linked merchant customer and fences %s",
      async (mode) => {
        for (const suffix of ["order", "promotion"])
          f.providers[0]!.actions.push({
            ...sampleAction,
            id: `sample.${suffix}`,
            readOnly: true,
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
          });
        const a = await setup();
        const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({
          where: { botId: a.owner.botId },
        });
        await service.manage(a.owner, a.owner.botId, "configure", {
          ...behavior,
          actions: [
            {
              name: "my_order",
              description: "Read an owned order",
              connectionId: a.account.id,
              inputSchema: {
                type: "object",
                properties: { orderId: { type: "string" } },
                required: ["orderId"],
                additionalProperties: false,
              },
              steps: [
                {
                  name: "order",
                  action: "sample.order",
                  effect: "read",
                  input: { orderId: "$input.orderId", customerId: "$providerCustomerId" },
                  check: { path: ["customerId"], equals: "$providerCustomerId" },
                },
              ],
            },
          ],
        });
        const c = await receive(a);
        const identityScope = {
          conversationId: c.id,
          customerId: "customer",
          connectionId: a.account.id,
        };
        expect(
          (await createCustomerRepos(db.prisma).snapshot(a.owner, c.id)).messages[0]!.senderId,
        ).toBe("customer");
        businessHandler = () => ({ id: 7 });
        reply.mockImplementationOnce(async (request) => {
          const token = request.executionContext!.token;
          expect((await service.tools.list(token)).tools.map((tool) => tool.name)).not.toContain(
            "my_order",
          );
          await expect(
            service.tools.execute(token, {
              name: "my_order",
              callId: "unlinked",
              arguments: { orderId: "mine" },
            }),
          ).rejects.toThrow();
          return "Staff needs to verify your merchant account.";
        });
        await service.process(c.id);
        await service.manage(a.owner, a.owner.botId, "identity_set", {
          ...identityScope,
          expectedRevision: 0,
          identity: { value: 7, action: "sample.promotion", input: {}, path: ["id"] },
          reason: "Fixture staff verification",
        });
        await createCustomerInbox(db.prisma).setOwner(a.owner, c.id, "bot");
        await receive(a, [incoming("linked-turn")]);
        businessHandler = async (_action, input) => {
          expect(input.customerId).toBe(7);
          if (mode === "revoke")
            await service.manage(a.owner, a.owner.botId, "identity_set", {
              ...identityScope,
              expectedRevision: 1,
              identity: null,
              reason: "Verification withdrawn during read",
            });
          if (mode === "replace-account")
            await db.prisma.connection.update({
              where: { id: a.account.id },
              data: { providerRef: "different-account" },
            });
          return {
            id: input.orderId,
            customerId: input.orderId === "mine" ? 7 : 8,
            status: "pending",
          };
        };
        reply.mockImplementationOnce(async (request) => {
          const token = request.executionContext!.token;
          expect((await service.tools.list(token)).tools.map((tool) => tool.name)).toContain(
            "my_order",
          );
          if (mode === "read") {
            await expect(
              service.tools.execute(token, {
                name: "my_order",
                callId: "foreign",
                arguments: { orderId: "other" },
              }),
            ).rejects.toThrow();
            await expect(
              service.tools.execute(token, {
                name: "my_order",
                callId: "own",
                arguments: { orderId: "mine" },
              }),
            ).resolves.toMatchObject({ customerId: 7, status: "pending" });
          } else {
            await expect(
              service.tools.execute(token, {
                name: "my_order",
                callId: "changed",
                arguments: { orderId: "mine" },
              }),
            ).rejects.toThrow();
          }
          return "Checked the merchant record.";
        });
        await service.process(c.id);
        expect(reply).toHaveBeenCalledTimes(2);
        await reply.mock.results[1]!.value;
      },
    );

    it("executes a scoped refund workflow once and revokes the execution after the turn", async () => {
      const actions = f.providers[0]!.actions;
      for (const suffix of ["order", "promotion", "refund"])
        actions.push({
          ...actions[0]!,
          id: `sample.${suffix}`,
          readOnly: suffix !== "refund",
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
            input: { orderId: "$steps.owner.id", amount: "$steps.owner.total" },
            effect: "write",
            operationKey: "$steps.owner.id",
            receipt: { refunded: ["refunded"] },
          },
        ],
      };
      const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({
        where: { botId: a.owner.botId },
      });
      for (const orderId of ["$input.orderId", "$steps.promotion.orderId"]) {
        const unsafe = {
          ...grant,
          steps: [
            grant.steps[0],
            grant.steps[1],
            {
              ...grant.steps[2],
              input: { checkedRecord: "$steps.owner.id", orderId, amount: "$steps.owner.total" },
            },
          ],
        };
        await expect(
          service.manage(a.owner, a.owner.botId, "configure", { ...behavior, actions: [unsafe] }),
        ).rejects.toThrow("not model input");
      }
      businessHandler = (action, input) => {
        if (action.endsWith(".order"))
          return {
            id: input.orderId,
            customerId: input.orderId === "mine" ? "customer" : "someone-else",
            total: 20,
          };
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
        await expect(
          service.tools.execute(token, {
            name: "openconnector_execute_tool",
            callId: "raw-refund-bypass",
            arguments: {
              id: `${a.account.id}:sample.refund`,
              arguments: { orderId: "mine", amount: 20 },
            },
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

    it.each([
      { stillEligible: true, retry: false },
      { stillEligible: false, retry: false },
      { stillEligible: true, retry: true },
      { stillEligible: false, retry: true },
    ])(
      "checks current eligibility and one-time recovery in later turns: %j",
      async ({ stillEligible, retry }) => {
        const catalog = f.providers[0]!.actions;
        for (const suffix of ["order", "refund"])
          catalog.push({
            ...catalog[0]!,
            id: `sample.${suffix}`,
            readOnly: suffix !== "refund",
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
          });
        const a = await setup();
        let refunds = 0;
        businessHandler = (action) => {
          if (action.endsWith(".order"))
            return {
              id: "owned-record",
              customerId: "customer",
              refundable: stillEligible || refunds === 0,
            };
          refunds++;
          if (retry && refunds === 1) throw new Error("Synthetic terminal rejection");
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
                  input: { id: "$steps.owner.id" },
                  effect: "write",
                  operationKey: "$steps.owner.id",
                  receipt: { refunded: ["refunded"] },
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
        if (retry) {
          const pending = await db.prisma.customerOperationReceipt.findFirstOrThrow({
            where: { conversationId: c.id },
          });
          expect(
            await service.manage(a.owner, a.owner.botId, "operation_retry", {
              id: pending.operationId,
              expectedAttempt: 0,
              reason: "Checked the rejected provider operation",
              providerReference: "synthetic-rejection",
              failureStatus: "rejected",
            }),
          ).toEqual({ retryReady: true, attempt: 1, dispatched: false });
          expect(refunds).toBe(1);
          await createCustomerInbox(db.prisma).setOwner(a.owner, c.id, "bot");
        }
        await receive(a, [incoming("second")]);
        await service.process(c.id);
        expect(refunds).toBe(retry && stillEligible ? 2 : 1);
        if (retry && stillEligible) {
          await receive(a, [incoming("third")]);
          await service.process(c.id);
          expect(refunds).toBe(2);
        }
        expect(
          await db.prisma.customerConversation.findUnique({ where: { id: c.id } }),
        ).toMatchObject(
          stillEligible
            ? { owner: "bot", needsHuman: false }
            : { owner: "staff", needsHuman: true },
        );
      },
    );

    it("authorizes group actions as the current sender, not the first participant", async () => {
      const actions = f.providers[0]!.actions;
      for (const suffix of ["order", "refund"])
        actions.push({
          ...actions[0]!,
          id: `sample.${suffix}`,
          readOnly: suffix !== "refund",
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
              {
                name: "refund",
                action: "sample.refund",
                input: { orderId: "$steps.owner.id" },
                effect: "write",
                operationKey: "$steps.owner.id",
                receipt: { refunded: ["refunded"] },
              },
            ],
          },
        ],
      });
      let refunds = 0;
      businessHandler = (action) => {
        if (action.endsWith(".order")) return { id: "alice-order", customerId: "alice" };
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
