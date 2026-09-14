import { randomUUID } from "node:crypto";
import type { CustomerRuntime, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  CustomerBehaviorInput,
  CustomerBindingSchema,
  CustomerConnectInput,
  CustomerInstructionsInput,
} from "@rakazo/contracts";
import type { CustomerChannel, PrismaClient } from "@rakazo/db";
import {
  connectionAccessWhere,
  createCustomerInbox,
  IsolationError,
  invalidateCustomerConversations,
  Prisma,
} from "@rakazo/db";
import {
  createCustomerBusinessTools,
  customerExecutionKey,
  customerPolicyHash,
  validateCustomerGrants,
} from "./customer-business-tools.js";
import { createCustomerConnector } from "./customer-connector.js";
import { customerInput, customerPage } from "./customer-mapping.js";
import { OpenRagCustomerRuntime } from "./customer-runtime.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { parseModelSecret } from "./pi-oauth.js";
import type { EncryptedSecretStore } from "./secrets.js";

export type CustomerConversationService = ReturnType<typeof createCustomerConversations>;
const leaseMs = 120_000;

export function createCustomerConversations(deps: {
  prisma: PrismaClient;
  integrations: IntegrationProviderSettings;
  secrets: EncryptedSecretStore;
  jobs: JobPublisher;
  apiUrl?: string;
  runtime?: (config: { baseUrl: string; apiKey?: string }) => CustomerRuntime;
}) {
  const { prisma } = deps;
  const inbox = createCustomerInbox(prisma);
  const processJob = (id: string) =>
    deps.jobs.enqueue({
      name: "customer.process",
      payload: { conversationId: id },
      replaceKey: `customer.process:${id}`,
    });

  const connector = createCustomerConnector(deps);
  const connection = connector.connection;
  async function action(
    channel: CustomerChannel,
    spec: { action?: string; input: Record<string, unknown> },
    values: Record<string, unknown>,
    executionId: string,
  ) {
    if (
      !spec.action ||
      !(await prisma.customerChannel.count({
        where: {
          id: channel.id,
          enabled: true,
          connectionId: channel.connectionId,
          bot: { archivedAt: null },
        },
      }))
    )
      throw new Error("Customer channel is unavailable");
    return connector.execute(
      channel,
      channel.connectionId!,
      spec.action,
      customerInput(spec.input, values),
      executionId,
    );
  }

  async function runtimeConfig(actor: Pick<Actor, "userId" | "spaceId">, credentialId: string) {
    const row = await prisma.userModelCredential.findFirst({
      where: { id: credentialId, userId: actor.userId },
    });
    if (!row) throw new IsolationError();
    const secret = await prisma.secret.findUniqueOrThrow({ where: { id: row.secretId } });
    const config = parseModelSecret(deps.secrets.load(secret.ciphertext, secret.id));
    if (config.kind !== "openai_compatible")
      throw new Error("Select a configured compatible customer runtime connection");
    return config;
  }

  const runtimeFor = async (actor: Pick<Actor, "userId" | "spaceId">, credentialId: string) => {
    const config = await runtimeConfig(actor, credentialId);
    return deps.runtime?.(config) ?? new OpenRagCustomerRuntime(config);
  };
  const tools = createCustomerBusinessTools({ prisma, connector, runtime: runtimeFor });

  async function poll(channelId: string) {
    const token = randomUUID();
    const now = new Date();
    const claimed = await prisma.customerChannel.updateMany({
      where: {
        id: channelId,
        enabled: true,
        bot: { archivedAt: null },
        connectionId: { not: null },
        nextPollAt: { lte: now },
        OR: [{ pollUntil: null }, { pollUntil: { lte: now } }],
      },
      data: {
        pollToken: token,
        pollUntil: new Date(now.getTime() + leaseMs),
        nextPollAt: new Date(now.getTime() + leaseMs),
      },
    });
    if (!claimed.count) return;
    const channel = await prisma.customerChannel.findUniqueOrThrow({ where: { id: channelId } });
    let intervalSeconds = 30;
    try {
      const binding = CustomerBindingSchema.parse(channel.binding);
      intervalSeconds = binding.intervalSeconds;
      if (binding.receive.mode !== "poll") return;
      if (!channel.startedAt) throw new Error("Channel has no receive boundary");
      const result = customerPage(
        binding,
        await action(
          channel,
          binding.receive,
          {
            cursor: channel.cursor ?? undefined,
            since: channel.startedAt.toISOString(),
          },
          `customer.poll:${channel.id}:${token}`,
        ),
        channel.startedAt,
      );
      for (const message of result.messages) {
        // A configuration change invalidates this poll before any more messages are accepted.
        if (
          !(await prisma.customerChannel.count({
            where: { id: channel.id, enabled: true, pollToken: token },
          }))
        )
          return;
        const id = await inbox.receive(channel.id, message, token);
        await processJob(id);
      }
      await prisma.customerChannel.updateMany({
        where: { id: channel.id, pollToken: token },
        data: {
          ...(result.cursor !== undefined ? { cursor: result.cursor ?? Prisma.DbNull } : {}),
          pollError: null,
        },
      });
    } catch {
      await prisma.customerChannel.updateMany({
        where: { id: channel.id, pollToken: token },
        data: { pollError: "Could not receive messages. Check the account and receive mapping." },
      });
    } finally {
      await prisma.customerChannel.updateMany({
        where: { id: channel.id, pollToken: token },
        data: {
          pollToken: null,
          pollUntil: null,
          nextPollAt: new Date(Date.now() + intervalSeconds * 1000),
        },
      });
    }
  }

  async function process(conversationId: string) {
    const token = randomUUID();
    const claimed = await prisma.customerConversation.updateMany({
      where: {
        id: conversationId,
        channel: { enabled: true, connectionId: { not: null }, bot: { archivedAt: null } },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
      },
      data: { leaseToken: token, leaseUntil: new Date(Date.now() + leaseMs) },
    });
    if (!claimed.count) return;
    const fence = { id: conversationId, leaseToken: token };
    let generation: number | undefined;
    let activeMessage: string | undefined;
    try {
      const row = await prisma.customerConversation.findUniqueOrThrow({
        where: { id: conversationId },
        include: { channel: { include: { bot: { include: { customerBehavior: true } } } } },
      });
      generation = row.generation;
      const stale = await prisma.customerMessage.updateMany({
        where: { conversationId, status: { in: ["processing", "sending"] } },
        data: { status: "failed" },
      });
      if (stale.count) throw new Error("An earlier execution has an uncertain outcome");
      const message = await prisma.customerMessage.findFirst({
        where: { conversationId, status: "queued" },
        orderBy: { seq: "asc" },
      });
      if (!message) return;
      activeMessage = message.id;
      if (
        message.generation !== row.generation ||
        (message.role === "customer" && row.owner !== "bot")
      ) {
        await prisma.customerMessage.update({
          where: { id: message.id },
          data: { status: "cancelled" },
        });
        return;
      }
      const binding = CustomerBindingSchema.parse(row.channel.binding);
      const behavior = row.channel.bot.customerBehavior;
      let outbound = message;
      if (message.role === "customer") {
        if (!behavior) throw new Error("Customer behavior has not been configured");
        await connection(row.channel, row.channel.connectionId!);
        const config = await runtimeConfig(row.channel, behavior.credentialId);
        const execution = customerExecutionKey(message.id);
        const running = await prisma.$transaction(async (tx) => {
          if (
            !(
              await tx.customerConversation.updateMany({
                where: { ...fence, generation: row.generation, owner: "bot" },
                data: { updatedAt: new Date() },
              })
            ).count
          )
            return false;
          return (
            (
              await tx.customerMessage.updateMany({
                where: { id: message.id, status: "queued" },
                data: {
                  status: "processing",
                  behaviorRevision: behavior.revision,
                  executionKeyHash: execution.keyHash,
                  executionPolicyHash: customerPolicyHash(behavior),
                  executionUntil: new Date(Date.now() + 60_000),
                },
              })
            ).count > 0
          );
        });
        if (!running) return;
        const history = await prisma.customerMessage.findMany({
          where: {
            conversationId,
            OR: [{ role: "customer", seq: { lte: message.seq } }, { status: "sent" }],
          },
          orderBy: { seq: "desc" },
          take: 100,
        });
        const runtime = deps.runtime?.(config) ?? new OpenRagCustomerRuntime(config);
        const body = await runtime.reply({
          flowId: behavior.flowId,
          knowledgeFilterId: behavior.knowledgeFilterId ?? undefined,
          instructions: behavior.instructions,
          conversationId,
          executionContext: {
            endpoint: `${(deps.apiUrl ?? "http://127.0.0.1:3100").replace(/\/$/, "")}/api/customer-tools`,
            token: execution.token,
          },
          messages: history
            .sort((a, b) => (a.inReplyToSeq ?? a.seq) - (b.inReplyToSeq ?? b.seq) || a.seq - b.seq)
            .map((item) => ({
              role: item.role === "customer" ? "user" : "assistant",
              content: item.body,
            })),
          signal: AbortSignal.timeout(60_000),
        });
        const generated = await prisma.$transaction(async (tx) => {
          const changed = await tx.customerConversation.updateMany({
            where: {
              ...fence,
              owner: "bot",
              generation: row.generation,
              channel: { enabled: true },
            },
            data: { nextSeq: { increment: 1 } },
          });
          if (!changed.count) return null;
          const current = await tx.customerConversation.findUniqueOrThrow({
            where: { id: conversationId },
          });
          await tx.customerMessage.update({
            where: { id: message.id },
            data: { status: "received" },
          });
          return tx.customerMessage.create({
            data: {
              conversationId,
              seq: current.nextSeq,
              body,
              role: "bot",
              senderId: message.senderId,
              status: "queued",
              generation: row.generation,
              behaviorRevision: behavior.revision,
              inReplyToSeq: message.seq,
            },
          });
        });
        if (!generated) return;
        outbound = generated;
        activeMessage = outbound.id;
      }
      // Takeover and dispatch compete on the conversation row. Once dispatch wins, a
      // provider may accept the send even if takeover occurs while the HTTP call is in flight.
      const dispatch = await prisma.$transaction(async (tx) => {
        const current = await tx.customerConversation.updateMany({
          where: {
            ...fence,
            generation: row.generation,
            channel: { enabled: true },
            ...(outbound.role === "bot" ? { owner: "bot" } : {}),
          },
          data: { updatedAt: new Date() },
        });
        if (!current.count) return false;
        return (
          (
            await tx.customerMessage.updateMany({
              where: { id: outbound.id, status: "queued" },
              data: { status: "sending", sendAttempts: { increment: 1 } },
            })
          ).count > 0
        );
      });
      if (!dispatch) return;
      await action(
        row.channel,
        binding.send,
        {
          threadId: row.externalThreadId,
          customerId: outbound.senderId ?? row.customerId,
          body: outbound.body,
          messageId: outbound.id,
        },
        `customer.send:${outbound.id}`,
      );
      await prisma.customerMessage.updateMany({
        where: { id: outbound.id, status: "sending" },
        data: { status: "sent", sentAt: new Date() },
      });
    } catch {
      if (activeMessage)
        await prisma.customerMessage.updateMany({
          where: { id: activeMessage, status: { in: ["queued", "processing", "sending"] } },
          data: { status: "failed" },
        });
      await prisma.$transaction(async (tx) => {
        const changed = await tx.customerConversation.updateMany({
          where: { ...fence, generation },
          data: { needsHuman: true, owner: "staff", generation: { increment: 1 } },
        });
        if (changed.count)
          await tx.customerMessage.updateMany({
            where: { conversationId, status: "queued" },
            data: { status: "cancelled" },
          });
      });
    } finally {
      await prisma.customerConversation.updateMany({
        where: fence,
        data: { leaseToken: null, leaseUntil: null },
      });
      if (await prisma.customerMessage.count({ where: { conversationId, status: "queued" } }))
        await processJob(conversationId);
    }
  }

  return {
    tools,
    process,
    poll,
    async reconcile() {
      const channels = await prisma.customerChannel.findMany({
        where: {
          enabled: true,
          connectionId: { not: null },
          bot: { archivedAt: null },
          nextPollAt: { lte: new Date() },
        },
        orderBy: { nextPollAt: "asc" },
        take: 100,
      });
      for (const channel of channels)
        await deps.jobs.enqueue({
          name: "customer.poll",
          payload: { channelId: channel.id },
          replaceKey: `customer.poll:${channel.id}`,
        });
      const conversations = await prisma.customerConversation.findMany({
        where: {
          channel: { enabled: true, connectionId: { not: null }, bot: { archivedAt: null } },
          messages: { some: { status: { in: ["queued", "processing", "sending"] } } },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        orderBy: { updatedAt: "asc" },
        take: 100,
        select: { id: true },
      });
      for (const conversation of conversations) await processJob(conversation.id);
    },
    async manage(
      actor: Pick<Actor, "userId" | "spaceId">,
      botId: string,
      operation: string,
      args: unknown,
    ) {
      const bot = await prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      });
      if (!bot) throw new IsolationError();
      if (operation === "inspect")
        return {
          behavior: await prisma.customerBehavior.findUnique({ where: { botId } }),
          channels: await prisma.customerChannel.findMany({
            where: { botId, connectionId: { not: null } },
            select: {
              id: true,
              name: true,
              provider: true,
              connectionId: true,
              enabled: true,
              binding: true,
              pollError: true,
            },
          }),
          connections: await prisma.connection.findMany({
            where: {
              ...connectionAccessWhere(actor),
              connectorId: "open-connector",
              status: "connected",
            },
            select: { id: true, provider: true, displayName: true },
          }),
          runtimes: await prisma.userModelCredential.findMany({
            where: { userId: actor.userId, provider: "openai-compatible" },
            select: { id: true, label: true },
          }),
        };
      if (operation === "instructions" || operation === "configure") {
        const existing = await prisma.customerBehavior.findUnique({ where: { botId } });
        const input =
          operation === "configure"
            ? CustomerBehaviorInput.parse(args)
            : CustomerBehaviorInput.parse({
                ...existing,
                ...CustomerInstructionsInput.parse(args),
              });
        const actions = validateCustomerGrants(input.actions);
        for (const grant of actions) await connection(actor, grant.connectionId);
        const runtime = await runtimeFor(actor, input.credentialId);
        if (!runtime.publish)
          throw new Error("Customer runtime does not support managed publication");
        const flowId = await runtime.publish({
          staffId: botId,
          instructions: input.instructions,
          signal: AbortSignal.timeout(30_000),
        });
        // Publish first. A failed publication leaves the active revision untouched.
        return prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
          const current = await tx.customerBehavior.findUnique({ where: { botId } });
          if (current?.revision !== existing?.revision)
            throw new Error("Customer behavior changed; inspect and retry");
          return tx.customerBehavior.upsert({
            where: { botId },
            create: { botId, ...input, actions, flowId },
            update: { ...input, actions, flowId, revision: { increment: 1 } },
          });
        });
      }
      if (operation === "connect") {
        const input = CustomerConnectInput.parse(args);
        const account = await connection(actor, input.connectionId);
        if (!(await prisma.customerBehavior.findUnique({ where: { botId } })))
          throw new Error("Configure customer behavior first");
        if (input.binding.receive.mode === "poll" && !input.binding.receive.action)
          throw new Error("Polling requires a receive action");
        if (input.binding.receive.mode === "webhook") {
          const verification = input.binding.receive.webhook;
          if (!verification) throw new Error("Webhook verification is required");
          if (verification.algorithm !== "token" && !input.binding.receive.account)
            throw new Error("Signed webhooks require an account filter");
          for (const id of [verification.secretId, verification.verificationSecretId].filter(
            Boolean,
          )) {
            const secret = await prisma.secret.findFirst({
              where: {
                id,
                userId: actor.userId,
                OR: [{ spaceId: actor.spaceId }, { spaceId: null }],
              },
            });
            if (!secret) throw new IsolationError();
          }
        }
        // Validate mappings locally before activation. Action schemas are still checked on each call.
        customerInput(input.binding.receive.input, {
          cursor: input.cursor ?? null,
          since: new Date().toISOString(),
        });
        customerInput(input.binding.send.input, {
          threadId: "thread",
          customerId: "customer",
          body: "reply",
          messageId: "message",
        });
        const now = new Date();
        return prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM connections WHERE id = ${account.id} FOR UPDATE`;
          const existing = await tx.customerChannel.findUnique({
            where: { connectionId: account.id },
          });
          if (existing && (existing.botId !== botId || existing.userId !== actor.userId))
            throw new Error("This account is assigned to another staff member");
          const channel = await tx.customerChannel.upsert({
            where: { connectionId: account.id },
            create: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId,
              provider: account.provider,
              accountId: account.id,
              connectionId: account.id,
              name: account.displayName,
              ciphertext: "",
              binding: input.binding,
              cursor:
                input.cursor ??
                (input.binding.receive.cursor && !Array.isArray(input.binding.receive.cursor)
                  ? 0
                  : Prisma.DbNull),
              enabled: true,
              startedAt: now,
              nextPollAt: input.binding.receive.mode === "poll" ? now : null,
            },
            update: {
              binding: input.binding,
              cursor:
                input.cursor ??
                (input.binding.receive.cursor && !Array.isArray(input.binding.receive.cursor)
                  ? 0
                  : Prisma.DbNull),
              enabled: true,
              startedAt: now,
              nextPollAt: input.binding.receive.mode === "poll" ? now : null,
              pollToken: null,
              pollUntil: null,
              pollError: null,
            },
          });
          await invalidateCustomerConversations(tx, { channelId: channel.id });
          return {
            id: channel.id,
            name: channel.name,
            ...(input.binding.receive.mode === "webhook"
              ? {
                  webhookUrl: `${(deps.apiUrl ?? "http://127.0.0.1:3100").replace(/\/$/, "")}/api/customer-events/${channel.id}`,
                }
              : {}),
          };
        });
      }
      if (operation === "disconnect") {
        const id = (args as { channelId?: string })?.channelId;
        if (!id) throw new Error("channelId is required");
        await prisma.$transaction(async (tx) => {
          if (
            !(
              await tx.customerChannel.updateMany({
                where: { id, botId, userId: actor.userId },
                data: { enabled: false, nextPollAt: null, pollToken: null, pollUntil: null },
              })
            ).count
          )
            throw new IsolationError();
          await invalidateCustomerConversations(tx, { channelId: id }, "staff");
        });
        return { ok: true };
      }
      throw new Error("Unknown customer operation");
    },
    async activity(
      actor: Pick<Actor, "userId" | "spaceId">,
      botId: string,
      from: Date,
      until: Date,
    ) {
      const where = {
        conversation: { channel: { spaceId: actor.spaceId, userId: actor.userId, botId } },
        sentAt: { gte: from, lt: until },
        status: "sent",
      };
      return {
        from: from.toISOString(),
        until: until.toISOString(),
        replies: await prisma.customerMessage.count({ where }),
        messages: await prisma.customerMessage.findMany({
          where: {
            conversation: { channel: { spaceId: actor.spaceId, userId: actor.userId, botId } },
            createdAt: { gte: from, lt: until },
          },
          select: {
            conversationId: true,
            role: true,
            body: true,
            status: true,
            createdAt: true,
            behaviorRevision: true,
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
      };
    },
  };
}
