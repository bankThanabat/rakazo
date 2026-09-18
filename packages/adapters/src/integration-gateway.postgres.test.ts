import { createHmac, randomUUID } from "node:crypto";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import {
  createCustomerInbox,
  createDb,
  provisionMessagingIdentity,
  requireMembership,
} from "@rakazo/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCustomerConversations } from "./customer-conversations.js";
import { receiveCustomerRelayBatch, setupCustomerIncoming } from "./customer-relay.js";
import { IntegrationGateway } from "./integration-gateway.js";
import { IntegrationGatewayClient } from "./integration-gateway-client.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { createOpenConnectorFixture, sampleAction } from "./open-connector-test-fixture.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
let db: ReturnType<typeof createDb>;
beforeAll(() => {
  if (enabled) db = createDb(process.env.DATABASE_URL!);
});
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pool.end();
  vi.restoreAllMocks();
});

it.skipIf(!enabled)(
  "isolates customers, provisions once after a lost response, persists offline delivery and ACKs only after the local inbox commit",
  async () => {
    const { prisma } = db;
    const f = createOpenConnectorFixture((action) =>
      action === "instagram.get_current_user"
        ? { user: { userId: "instagram-account" } }
        : { userId: "line-bot-fixture" },
    );
    f.providers[0] = {
      ...f.providers[0]!,
      service: "line",
      actions: [
        {
          ...sampleAction,
          id: "line.get_bot_info",
          service: "line",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        { ...sampleAction, id: "line.send_push_text", service: "line" },
      ],
    };
    f.providers.push({
      ...f.providers[0]!,
      service: "instagram",
      actions: [
        { ...f.providers[0]!.actions[0]!, id: "instagram.get_current_user", service: "instagram" },
        { ...sampleAction, id: "instagram.send_message", service: "instagram" },
      ],
    });
    const settings = new IntegrationProviderSettings(prisma, f.secrets, "fixture", {
      "open-connector": f.adapter,
    });
    const gateway = new IntegrationGateway({ prisma, secrets: f.secrets, integrations: settings });
    const identity = async () => {
      const row = await provisionMessagingIdentity(
        prisma,
        { provider: "test", address: randomUUID() },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
      return requireMembership(prisma, row.userId, row.spaceId);
    };
    const alice = await identity();
    const bob = await identity();
    const local = await identity();
    const created = new Map<string, Array<{ uid: string; name: string; url?: string }>>();
    let loseResponse = true;
    const convoy = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const collection = path.split("/").at(init?.method === "DELETE" ? -2 : -1)!;
      if (collection === "fixture-project") return Response.json({ data: { type: "incoming" } });
      const rows = created.get(collection) ?? [];
      if (init?.method === "DELETE") {
        created.set(
          collection,
          rows.filter((row) => row.uid !== path.split("/").at(-1)),
        );
        return new Response(null, { status: 204 });
      }
      if (init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        if (collection === "sources")
          expect(input.verifier).toEqual({
            type: "hmac",
            hmac: {
              hash: "SHA256",
              encoding: "base64",
              header: "X-Line-Signature",
              secret: "fixture-channel-secret",
            },
          });
        if (collection === "endpoints") {
          expect(input.authentication.type).toBe("api_key");
          expect(input.authentication.api_key.header_name).toBe("Authorization");
          expect(input.authentication.api_key.header_value).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
        }
        const row = {
          uid: randomUUID(),
          name: input.name,
          url: `https://relay.example.test/ingest/${randomUUID()}`,
        };
        rows.push(row);
        created.set(collection, rows);
        if (collection === "endpoints" && loseResponse) {
          loseResponse = false;
          throw new Error("Lost response after provider commit");
        }
        return Response.json({ data: row });
      }
      return Response.json({ data: { content: rows, pagination: { has_next_page: false } } });
    });
    vi.stubGlobal("fetch", convoy);
    try {
      const config = {
        endpoint: "https://relay.example.test",
        apiKey: "fixture-project-key",
        projectId: "fixture-project",
        callbackOrigin: "https://gateway.example.test",
      };
      await expect(
        gateway.configure({ ...alice, isDeploymentOwner: false }, config),
      ).rejects.toThrow();
      await gateway.configure({ ...alice, isDeploymentOwner: true }, config);
      const aliceKey = await gateway.createRuntime(alice, "Alice runtime");
      const bobKey = await gateway.createRuntime(bob, "Bob runtime");
      const signal = AbortSignal.timeout(20000);
      const command = (token: string, input: unknown) => gateway.command(token, input, signal);
      const first = z.object({ state: z.string() }).parse(
        await command(aliceKey.token, {
          op: "begin",
          provider: "line",
          credential: "fixture-line-token",
        }),
      );
      await expect(command(bobKey.token, { op: "revoke", ref: first.state })).rejects.toThrow();
      await expect(
        command(bobKey.token, {
          op: "execute",
          connections: [
            {
              id: "stolen",
              providerRef: first.state,
              connectorId: "open-connector",
              externalId: "line",
              displayName: "stolen",
            },
          ],
          call: {
            tool: "line.get_bot_info",
            executionId: "stolen",
            args: {},
            route: {
              connectorId: "open-connector",
              toolName: "line.get_bot_info",
              resourceId: "stolen",
            },
          },
        }),
      ).rejects.toThrow();
      expect(f.sent).toHaveLength(0);
      // A local owner flag and forged cloud identities are not command capabilities.
      await expect(
        command(bobKey.token, {
          op: "configureOAuth",
          isDeploymentOwner: true,
          spaceId: alice.spaceId,
          values: {},
        }),
      ).rejects.toThrow();
      const client = new IntegrationGatewayClient(
        { endpoint: "https://gateway.example.test", apiKey: aliceKey.token },
        async (_url, init) =>
          Response.json({ data: await command(aliceKey.token, JSON.parse(String(init?.body))) }),
      );
      const scopedContext: AdapterContext = {
        ...local,
        operationId: "test-policy",
        traceId: "test-policy",
        signal,
        connectedConnections: [
          {
            id: "local-account",
            connectorId: "open-connector",
            externalId: "line",
            displayName: "LINE",
            providerRef: first.state,
          },
        ],
        actionAccess: { "local-account": ["line.get_bot_info"] },
      };
      const discovery = await client.discoverTools(scopedContext);
      expect(JSON.stringify(discovery)).toContain("line.get_bot_info");
      expect(JSON.stringify(discovery)).not.toContain("line.send_push_text");
      const call = {
        tool: "line.get_bot_info",
        args: {},
        executionId: "policy-call",
        route: {
          connectorId: "open-connector",
          resourceId: "local-account",
          toolName: "line.get_bot_info",
        },
      };
      const resolved = await client.resolveCall(call, scopedContext);
      expect(resolved?.tool.inputSchema).toMatchObject({ type: "object" });
      scopedContext.actionAccess = {};
      const events = [];
      for await (const event of client.execute(resolved!.call, scopedContext)) events.push(event);
      expect(events).toEqual([expect.objectContaining({ type: "error" })]);
      expect(f.sent).toHaveLength(0);
      const localSettings = new IntegrationProviderSettings(prisma, f.secrets, "local-fixture", {
        "open-connector": client,
      });
      // Keep cloud settings separate from the local runtime's provider configuration.
      const localAccount = await prisma.connection.create({
        data: {
          spaceId: local.spaceId,
          userId: local.userId,
          provider: "line",
          connectorId: "open-connector",
          displayName: "LINE",
          providerRef: first.state,
          status: "connected",
        },
      });
      const bot = await prisma.bot.findFirstOrThrow({
        where: { userId: local.userId, spaceId: local.spaceId },
      });
      const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
      const deps = { prisma, secrets: f.secrets, integrations: localSettings, jobs };
      const input = {
        connectionId: localAccount.id,
        botId: bot.id,
        secrets: { channelSecret: "fixture-channel-secret" },
      };
      await expect(setupCustomerIncoming(deps, bob, input)).rejects.toThrow();
      await expect(setupCustomerIncoming(deps, local, input)).rejects.toThrow("Lost response");
      const provisioned = await setupCustomerIncoming(deps, local, input);
      expect(provisioned.replySetupError).toBe("Choose a model for the assigned staff first.");
      await setupCustomerIncoming(deps, local, input);
      expect([...created.values()].map((rows) => rows.length)).toEqual([1, 1, 1]);
      const route = await prisma.gatewayRoute.findFirstOrThrow({
        where: { channelId: provisioned.id },
      });
      const { deliveryToken } = JSON.parse(f.secrets.load(route.ciphertext, route.id));
      const raw = JSON.stringify({
        destination: "line-bot-fixture",
        events: ["one", "two"].map((webhookEventId) => ({
          webhookEventId,
          type: "message",
          timestamp: Date.now() + 1000,
          source: { type: "user", userId: "fixture-customer" },
          message: { type: "text", text: webhookEventId },
        })),
      });
      await expect(gateway.receive(route.id, "wrong", raw)).rejects.toThrow();
      await gateway.receive(route.id, deliveryToken, raw);
      await gateway.receive(route.id, deliveryToken, raw);
      expect(await prisma.gatewayDelivery.count({ where: { routeId: route.id } })).toBe(1);
      expect(await command(bobKey.token, { op: "deliveries" })).toEqual([]);
      const delivery = await prisma.gatewayDelivery.findFirstOrThrow({
        where: { routeId: route.id },
      });
      await expect(command(bobKey.token, { op: "ack", id: delivery.id })).rejects.toThrow();
      // Simulate process restart using a fresh gateway instance and committed rows.
      const restarted = new IntegrationGateway({
        prisma,
        secrets: f.secrets,
        integrations: settings,
      });
      expect(await restarted.command(aliceKey.token, { op: "deliveries" }, signal)).toHaveLength(1);
      expect(await command(aliceKey.token, { op: "deliveries" })).toEqual([]);
      const later = JSON.stringify({ destination: "line-bot-fixture", events: [] });
      await gateway.receive(route.id, deliveryToken, later);
      const available = z
        .array(z.object({ id: z.string() }))
        .parse(await command(aliceKey.token, { op: "deliveries" }));
      expect(available).toHaveLength(1);
      expect(available[0]!.id).not.toBe(delivery.id);
      await command(aliceKey.token, { op: "ack", id: available[0]!.id });
      await prisma.gatewayDelivery.updateMany({
        where: { id: delivery.id },
        data: { nextAttemptAt: new Date(0) },
      });
      const acknowledge = vi
        .spyOn(client, "acknowledge")
        .mockRejectedValueOnce(new Error("Disconnected after local commit"));
      await receiveCustomerRelayBatch(deps, signal);
      expect(
        await prisma.customerMessage.count({
          where: { conversation: { channelId: provisioned.id } },
        }),
      ).toBe(2);
      expect(
        (await prisma.gatewayDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).ackedAt,
      ).toBeNull();
      acknowledge.mockRestore();
      await prisma.gatewayDelivery.updateMany({
        where: { routeId: route.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await receiveCustomerRelayBatch(deps, signal);
      expect(
        await prisma.customerMessage.count({
          where: { conversation: { channelId: provisioned.id } },
        }),
      ).toBe(2);
      const conversation = await prisma.customerConversation.findFirstOrThrow({
        where: { channelId: provisioned.id },
      });
      expect(conversation.owner).toBe("staff");
      expect(
        await prisma.customerMessage.count({
          where: { conversationId: conversation.id, status: "queued" },
        }),
      ).toBe(0);
      expect(
        (await prisma.gatewayDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).payload,
      ).toBeNull();
      await gateway.receive(route.id, deliveryToken, raw);
      expect(await command(aliceKey.token, { op: "deliveries" })).toEqual([]);
      await createCustomerInbox(prisma).reply(local, {
        id: conversation.id,
        body: "Manual reply",
        nonce: randomUUID(),
      });
      const customerService = createCustomerConversations({ ...deps, jobs });
      await customerService.process(conversation.id);
      expect(
        await prisma.customerMessage.count({
          where: { conversationId: conversation.id, role: "staff", status: "sent" },
        }),
      ).toBe(1);
      expect(f.sent.at(-1)?.input).toMatchObject({
        to: "fixture-customer",
        texts: ["Manual reply"],
      });
      await expect(gateway.revokeRuntime(bob, aliceKey.id)).rejects.toThrow();
      const managedId = "incoming-webhook:instagram";
      await prisma.integrationProviderConfig.create({
        data: {
          id: managedId,
          ciphertext: f.secrets.seal(
            JSON.stringify({
              appSecret: "fixture-instagram-signing",
              verifyToken: "fixture-instagram-verify",
            }),
            managedId,
          ),
        },
      });
      const ig = z.object({ state: z.string() }).parse(
        await command(aliceKey.token, {
          op: "begin",
          provider: "instagram",
          credential: "fixture-instagram-token",
        }),
      );
      const igAccount = await prisma.connection.create({
        data: {
          spaceId: local.spaceId,
          userId: local.userId,
          provider: "instagram",
          connectorId: "open-connector",
          displayName: "Instagram",
          providerRef: ig.state,
          status: "connected",
        },
      });
      const igChannel = await setupCustomerIncoming(deps, local, {
        connectionId: igAccount.id,
        botId: bot.id,
        secrets: {},
      });
      const igRoute = await prisma.gatewayRoute.findFirstOrThrow({
        where: { channelId: igChannel.id },
      });
      await gateway.challenge(igRoute.id, "fixture-instagram-verify");
      // A runtime cannot change the operator's signature verification, even by supplying secrets.
      await command(aliceKey.token, {
        op: "incoming",
        ref: ig.state,
        channelId: igChannel.id,
        webhookSecret: "attacker",
        verificationToken: "attacker",
        verification: { header: "authorization", algorithm: "token" },
      });
      await expect(gateway.challenge(igRoute.id, "attacker")).rejects.toThrow();
      const igRaw = JSON.stringify({
        entry: [
          {
            id: "instagram-account",
            messaging: [
              {
                sender: { id: "instagram-customer" },
                recipient: { id: "instagram-account" },
                timestamp: Date.now() + 1000,
                message: { mid: "fixture-instagram-message", text: "Instagram DM" },
              },
            ],
          },
        ],
      });
      const igHeaders = new Headers({
        "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-instagram-signing").update(igRaw).digest("hex")}`,
      });
      await gateway.receiveWebhook(igRoute.id, igHeaders, igRaw);
      await receiveCustomerRelayBatch(deps, signal);
      expect(
        await prisma.customerMessage.count({
          where: { conversation: { channelId: igChannel.id } },
        }),
      ).toBe(1);
      expect(
        await prisma.secret.count({
          where: { id: { startsWith: `customer-webhook:${igChannel.id}:` } },
        }),
      ).toBe(0);
      const directInput = {
        op: "incoming",
        ref: first.state,
        channelId: "fixture-direct-channel",
        webhookSecret: "fixture-signing",
        verificationToken: "fixture-verify",
        verification: {
          header: "x-hub-signature-256",
          algorithm: "sha256",
          encoding: "hex",
          prefix: "sha256=",
        },
      };
      const direct = z
        .object({ id: z.string(), webhookUrl: z.string() })
        .parse(await command(aliceKey.token, directInput));
      expect(direct.webhookUrl).toBe(
        `https://gateway.example.test/api/integration-gateway/webhook/${direct.id}`,
      );
      expect(await command(aliceKey.token, directInput)).toEqual(direct);
      await expect(
        command(aliceKey.token, { ...directInput, verificationToken: "changed" }),
      ).rejects.toThrow();
      await gateway.challenge(direct.id, "fixture-verify");
      await expect(gateway.challenge(direct.id, "wrong")).rejects.toThrow();
      const directHeaders = new Headers({
        "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-signing").update(raw).digest("hex")}`,
      });
      await gateway.receiveWebhook(direct.id, directHeaders, raw);
      await gateway.receiveWebhook(direct.id, directHeaders, raw);
      expect(await prisma.gatewayDelivery.count({ where: { routeId: direct.id } })).toBe(1);
      expect(await command(bobKey.token, { op: "deliveries" })).toEqual([]);
      expect([...created.values()].map((rows) => rows.length)).toEqual([1, 1, 1]);
      await gateway.revokeRuntime(alice, aliceKey.id);
      await expect(gateway.receiveWebhook(direct.id, directHeaders, raw)).rejects.toThrow();
      await expect(command(aliceKey.token, { op: "catalog" })).rejects.toThrow();
      await expect(gateway.receive(route.id, deliveryToken, raw)).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
      await prisma.integrationProviderConfig.deleteMany({
        where: { id: { in: ["integration-gateway", "incoming-webhook:instagram"] } },
      });
      await prisma.gatewayRuntime.deleteMany({
        where: { userId: { in: [alice.userId, bob.userId] } },
      });
      for (const actor of [alice, bob, local]) {
        await prisma.space.delete({ where: { id: actor.spaceId } });
        await prisma.user.delete({ where: { id: actor.userId } });
      }
    }
  },
);
