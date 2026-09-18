import { randomUUID } from "node:crypto";
import type { CustomerRuntime, JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  CustomerBehaviorInput,
  CustomerBindingSchema,
  CustomerChannelSettingsInput,
  CustomerConnectInput,
  CustomerDraftInput,
  CustomerInstructionsInput,
  CustomerKnowledgeInput,
  CustomerListInput,
  CustomerServiceConnection,
  CustomerWebsiteInput,
} from "@rakazo/contracts";
import { customerReplyParts } from "@rakazo/core";
import type { CustomerChannel, PrismaClient } from "@rakazo/db";
import {
  CustomerMessageLimitError,
  connectionAccessWhere,
  createCustomerInbox,
  createCustomerRepos,
  IsolationError,
  invalidateCustomerConversations,
  Prisma,
  requireCustomerAccess,
  setCustomerChannelReplies,
} from "@rakazo/db";
import { normalizeSecretDestination } from "./bot-secrets.js";
import {
  createCustomerBusinessTools,
  customerExecutionKey,
  customerPolicyHash,
  validateCustomerGrants,
} from "./customer-business-tools.js";
import type { ConnectorAudience } from "./customer-connector.js";
import { createCustomerConnector } from "./customer-connector.js";
import { customerDeliveryId, customerInput, customerPage } from "./customer-mapping.js";
import {
  customerReplyDefaults,
  loadCustomerReplyRuntime,
  managedCustomerRuntime,
} from "./customer-reply-defaults.js";
import type { CustomerRuntimeConfig } from "./customer-runtime.js";
import { LangflowCustomerRuntime } from "./customer-runtime.js";
import { customerWebhookUrl } from "./customer-webhooks.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import type { KnowledgeService } from "./knowledge.js";
import { createModelBridge } from "./model-bridge.js";
import type { EncryptedSecretStore } from "./secrets.js";

export type CustomerConversationService = ReturnType<typeof createCustomerConversations>;
const leaseMs = 120_000;
const liveChannel = {
  enabled: true,
  OR: [{ connectionId: { not: null } }, { provider: "web" }],
  bot: { archivedAt: null },
};

export function createCustomerConversations(deps: {
  knowledge?: KnowledgeService;
  prisma: PrismaClient;
  integrations: IntegrationProviderSettings;
  secrets: EncryptedSecretStore;
  jobs: JobPublisher;
  apiUrl?: string;
  apiInternalUrl?: string;
  webOrigin?: string;
  runtime?: (config: CustomerRuntimeConfig) => CustomerRuntime;
  notifications?: NotificationProvider;
}) {
  const { prisma } = deps;
  const inbox = createCustomerInbox(prisma);
  const modelBridge = createModelBridge(deps);
  const callbackBaseUrl = (deps.apiInternalUrl ?? deps.apiUrl ?? "http://127.0.0.1:3100").replace(
    /\/$/,
    "",
  );
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
    audience: ConnectorAudience = "staff",
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
      audience,
    );
  }

  async function serviceConfig(
    scope: Pick<Actor, "userId" | "spaceId"> & { botId: string },
    raw: unknown,
  ) {
    const config = CustomerServiceConnection.parse(raw);
    if (config.credential === managedCustomerRuntime) {
      const runtime = await loadCustomerReplyRuntime(deps);
      if (config.baseUrl !== runtime.baseUrl) throw new IsolationError();
      // This key is available only to the customer runtime adapter, never staff secret tools.
      return runtime;
    }
    const row = await prisma.botSecret.findFirst({
      where: {
        name: config.credential,
        userId: scope.userId,
        spaceId: scope.spaceId,
        botId: scope.botId,
      },
    });
    if (!row) throw new IsolationError();
    const destination = normalizeSecretDestination(row);
    if (
      new URL(config.baseUrl).origin !== destination.origin ||
      destination.auth.type !== "header" ||
      destination.auth.name.toLowerCase() !== "x-api-key"
    )
      throw new Error("Customer service requires a destination-bound x-api-key credential");
    return { baseUrl: config.baseUrl, apiKey: deps.secrets.load(row.ciphertext, row.id) };
  }

  const runtimeFor = async (
    scope: Pick<Actor, "userId" | "spaceId"> & { botId: string },
    behavior: { runtime: unknown; knowledge?: unknown },
  ) => {
    const config = {
      ...(await serviceConfig(scope, behavior.runtime)),
      knowledge: behavior.knowledge ? await serviceConfig(scope, behavior.knowledge) : undefined,
    };
    return deps.runtime?.(config) ?? new LangflowCustomerRuntime(config);
  };
  const tools = createCustomerBusinessTools({
    prisma,
    connector,
    runtime: runtimeFor,
    knowledge: deps.knowledge,
  });

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
        try {
          const id = await inbox.receive(channel.id, message, token);
          await processJob(id);
        } catch (error) {
          // Quota rejections must not pin a shared account's receive cursor.
          if (!(error instanceof CustomerMessageLimitError)) throw error;
        }
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
        channel: liveChannel,
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
        (message.role === "customer" && row.owner !== "bot") ||
        // Handoff notices (system) still go out when auto replies are off.
        ((message.role === "customer" || message.role === "bot") && !row.channel.autoReplies)
      ) {
        await prisma.customerMessage.update({
          where: { id: message.id },
          data: { status: "cancelled" },
        });
        return;
      }
      const binding =
        row.channel.provider === "web" ? null : CustomerBindingSchema.parse(row.channel.binding);
      const behavior = row.channel.bot.customerBehavior;
      let outbound = message;
      if (message.role === "customer") {
        if (!behavior) throw new Error("Customer behavior has not been configured");
        if (row.channel.provider !== "web")
          await connection(row.channel, row.channel.connectionId!);
        if (!behavior.modelCredentialId || !behavior.modelId)
          throw new Error("Republish customer behavior with a model connection");
        const runtime = await runtimeFor(row.channel, behavior);
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
        const modelGrant = await modelBridge.create(
          row.channel,
          {
            credentialId: behavior.modelCredentialId,
            modelId: behavior.modelId,
          },
          { expiresAt: new Date(Date.now() + 60_000) },
        );
        let body = "";
        let runtimeFailed = false;
        try {
          body = await runtime.reply({
            model: {
              baseUrl: `${callbackBaseUrl}${modelGrant.basePath}`,
              apiKey: modelGrant.apiKey,
              id: modelGrant.model,
            },
            flowId: behavior.flowId,
            knowledgeFilterId: behavior.knowledgeFilterId ?? undefined,
            instructions: behavior.instructions,
            conversationId,
            executionContext: {
              endpoint: `${callbackBaseUrl}/api/customer-tools`,
              token: execution.token,
            },
            messages: history
              .sort(
                (a, b) => (a.inReplyToSeq ?? a.seq) - (b.inReplyToSeq ?? b.seq) || a.seq - b.seq,
              )
              .map((item) => ({
                role: item.role === "customer" ? "user" : "assistant",
                content: item.body,
              })),
            signal: AbortSignal.timeout(60_000),
          });
        } catch {
          runtimeFailed = true;
        } finally {
          await modelBridge.revoke(row.channel, modelGrant.id);
        }
        const explicitReply = await prisma.customerToolCall.findFirst({
          where: { messageId: message.id, replyBody: { not: null } },
        });
        if (explicitReply && explicitReply.status !== "completed")
          throw new Error("Customer reply outcome is uncertain; do not send another reply");
        if (runtimeFailed && !explicitReply)
          throw new Error("Customer reply service did not finish");
        const generated = await prisma.$transaction(async (tx) => {
          const changed = await tx.customerConversation.updateMany({
            where: {
              ...fence,
              owner: "bot",
              generation: row.generation,
              channel: { enabled: true, autoReplies: true },
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
              body: explicitReply?.replyBody ?? body,
              role: "bot",
              senderId: message.senderId,
              status: explicitReply ? "sent" : "queued",
              sentAt: explicitReply ? new Date() : undefined,
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
      if (outbound.status === "sent") return;
      // Takeover and dispatch compete on the conversation row. Once dispatch wins, a
      // provider may accept the send even if takeover occurs while the HTTP call is in flight.
      const dispatch = await prisma.$transaction(async (tx) => {
        const current = await tx.customerConversation.updateMany({
          where: {
            ...fence,
            generation: row.generation,
            channel: { enabled: true, ...(outbound.role === "bot" ? { autoReplies: true } : {}) },
            ...(outbound.role === "bot" ? { owner: "bot" } : {}),
          },
          data: { updatedAt: new Date(), leaseUntil: new Date(Date.now() + leaseMs) },
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
      const parts = binding
        ? customerReplyParts(outbound.body, binding.send.textLimit)
        : [outbound.body];
      for (let index = outbound.sentParts; index < parts.length; index++) {
        // Recheck between parts so takeover can stop the next external send.
        if (
          !(
            await prisma.customerConversation.updateMany({
              where: {
                ...fence,
                generation: row.generation,
                channel: {
                  ...liveChannel,
                  ...(outbound.role === "bot" ? { autoReplies: true } : {}),
                },
              },
              data: { leaseUntil: new Date(Date.now() + leaseMs) },
            })
          ).count
        ) {
          await prisma.customerMessage.updateMany({
            where: { id: outbound.id, status: "sending", conversation: fence },
            data: { status: "cancelled" },
          });
          return;
        }
        if (binding)
          await action(
            row.channel,
            binding.send,
            {
              threadId: row.externalThreadId,
              customerId: outbound.senderId ?? row.customerId,
              body: parts[index],
              messageId: customerDeliveryId(outbound.id, index),
            },
            `customer.send:${outbound.id}:${index}`,
            outbound.role === "bot" ? "customer" : "staff",
          );
        await prisma.customerMessage.updateMany({
          where: { id: outbound.id, status: "sending", conversation: fence },
          data: { sentParts: index + 1 },
        });
      }
      await prisma.customerMessage.updateMany({
        where: { id: outbound.id, status: "sending", conversation: fence },
        data: { status: "sent", sentAt: new Date() },
      });
    } catch {
      if (activeMessage)
        await prisma.customerMessage.updateMany({
          where: {
            id: activeMessage,
            status: { in: ["queued", "processing", "sending"] },
            conversation: fence,
          },
          data: { status: "failed", errorCode: "execution_uncertain" },
        });
      await prisma.$transaction(async (tx) => {
        const changed = await tx.customerConversation.updateMany({
          where: { ...fence, generation },
          data: {
            needsHuman: true,
            notifiedGeneration: -1,
            owner: "staff",
            handoffReason:
              "Delivery or execution failed. Check the action outcome before retrying.",
            generation: { increment: 1 },
          },
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
          channel: liveChannel,
          messages: { some: { status: { in: ["queued", "processing", "sending"] } } },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        orderBy: { updatedAt: "asc" },
        take: 100,
        select: { id: true },
      });
      for (const conversation of conversations) await processJob(conversation.id);
      if (deps.notifications) {
        const attention = await prisma.customerConversation.findMany({
          where: { needsHuman: true, notifiedGeneration: -1, channel: liveChannel },
          include: { channel: true },
          orderBy: { updatedAt: "asc" },
          take: 100,
        });
        for (const row of attention) {
          const members = (
            await prisma.spaceMember.findMany({
              where: {
                spaceId: row.channel.spaceId,
                ...(!row.channel.shared ? { userId: row.channel.userId } : {}),
              },
              select: { userId: true },
            })
          ).map((m) => m.userId);
          const users =
            row.assigneeId && members.includes(row.assigneeId) ? [row.assigneeId] : members;
          try {
            for (const userId of users)
              await deps.notifications.send(
                {
                  kind: "help",
                  title: "Customer needs attention",
                  body: "Open the customer inbox to follow up.",
                  botId: row.channel.botId,
                  threadId: row.id,
                  customerConversationId: row.id,
                },
                {
                  userId,
                  spaceId: row.channel.spaceId,
                  operationId: `customer.alert:${row.id}:${row.generation}:${row.lastCustomerSeq}`,
                  traceId: row.id,
                  signal: AbortSignal.timeout(10000),
                },
              );
            await prisma.customerConversation.updateMany({
              where: {
                id: row.id,
                generation: row.generation,
                lastCustomerSeq: row.lastCustomerSeq,
              },
              data: { notifiedGeneration: row.generation },
            });
          } catch {
            /* Durable attention state is retried by reconciliation. */
          }
        }
      }
      await prisma.customerVisitorSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      for (const channel of await prisma.customerChannel.findMany({
        where: { retentionDays: { not: null } },
        select: { id: true, retentionDays: true },
      })) {
        await prisma.customerConversation.deleteMany({
          where: {
            channelId: channel.id,
            state: "resolved",
            leaseUntil: null,
            updatedAt: { lt: new Date(Date.now() - channel.retentionDays! * 86400000) },
            messages: { none: { status: { in: ["queued", "processing", "sending"] } } },
          },
        });
      }
    },
    manage: async function manage(
      actor: Pick<Actor, "userId" | "spaceId">,
      botId: string,
      operation: string,
      args: unknown,
    ) {
      const bot = await prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      });
      if (!bot) throw new IsolationError();
      if (operation === "search")
        return createCustomerRepos(prisma).list(actor, CustomerListInput.parse(args));
      if (operation === "delete") {
        const id = String((args as { id?: unknown }).id ?? "");
        await requireCustomerAccess(prisma, actor, id);
        const removed = await prisma.customerConversation.deleteMany({
          where: {
            id,
            channel: { userId: actor.userId, spaceId: actor.spaceId },
            state: "resolved",
            leaseUntil: null,
            messages: { none: { status: { in: ["queued", "processing", "sending"] } } },
          },
        });
        if (!removed.count)
          throw new Error(
            "Only the channel owner can delete a resolved case after pending work finishes",
          );
        return {
          deleted: true,
          scope: "Rakazo transcript, tool ledger and visitor sessions",
          externalRecords:
            "Provider records, backups and external service logs follow their own retention policies",
        };
      }
      if (operation === "knowledge") {
        const input = CustomerKnowledgeInput.parse(args);
        const channel = input.id
          ? (await requireCustomerAccess(prisma, actor, input.id)).channel
          : { ...actor, botId };
        if (
          !(await prisma.spaceMember.count({
            where: {
              spaceId: channel.spaceId,
              userId: channel.userId,
            },
          }))
        )
          throw new IsolationError();
        const agent = await prisma.bot.findUniqueOrThrow({ where: { id: channel.botId } });
        if (agent.knowledgeLibraryId) {
          if (!deps.knowledge) throw new Error("Knowledge is unavailable");
          return deps.knowledge.search(
            channel,
            channel.botId,
            "staff",
            input.query,
            AbortSignal.timeout(20_000),
          );
        }
        const behavior = await prisma.customerBehavior.findUniqueOrThrow({
          where: { botId: channel.botId },
        });
        if (!behavior.knowledgeFilterId)
          throw new Error("No approved customer knowledge is configured");
        const runtime = await runtimeFor(channel, behavior);
        if (!runtime.search) throw new Error("Knowledge search is unavailable");
        return runtime.search({
          query: input.query,
          knowledgeFilterId: behavior.knowledgeFilterId,
          signal: AbortSignal.timeout(20000),
        });
      }
      if (operation === "draft") {
        const input = CustomerDraftInput.parse(args);
        await requireCustomerAccess(prisma, actor, input.id);
        const changed = await prisma.customerConversation.updateMany({
          where: {
            id: input.id,
            nextSeq: input.expectedSeq,
            channel: { spaceId: actor.spaceId, OR: [{ userId: actor.userId }, { shared: true }] },
          },
          data: { draftText: input.body, draftForSeq: input.expectedSeq },
        });
        if (!changed.count)
          throw new Error("The conversation changed. Read it again before drafting.");
        return { saved: true, sent: false };
      }
      if (operation === "website") {
        const input = CustomerWebsiteInput.parse({ ...(args as object), botId });
        const origins = input.origins.map((value) => {
          const url = new URL(value);
          if (
            url.username ||
            url.password ||
            (url.protocol !== "https:" &&
              !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
          )
            throw new Error("Use an HTTPS website origin");
          if (url.pathname !== "/" || url.search || url.hash)
            throw new Error("Use a website origin without a path");
          return url.origin;
        });
        if (!(await prisma.customerBehavior.findUnique({ where: { botId } })))
          throw new Error("Configure customer behavior first");
        const channel = await prisma.$transaction(async (tx) => {
          const updated = await tx.customerChannel.upsert({
            where: { provider_accountId: { provider: "web", accountId: botId } },
            create: {
              botId,
              userId: actor.userId,
              spaceId: actor.spaceId,
              provider: "web",
              accountId: botId,
              name: input.name,
              ciphertext: "",
              websiteOrigins: origins,
              autoReplies: true,
              startedAt: new Date(),
            },
            update: { name: input.name, websiteOrigins: origins },
          });
          await tx.customerVisitorSession.deleteMany({
            where: { conversation: { channelId: updated.id }, origin: { notIn: origins } },
          });
          return updated;
        });
        const web = (deps.webOrigin ?? "").replace(/\/$/, "");
        return {
          channelId: channel.id,
          path: `/support/${channel.id}`,
          embed: `<script src="${web}/support-widget.js" data-channel="${channel.id}" defer></script>`,
          instructions:
            "Install on an approved website. Use the public Rakazo web origin for the script URL.",
        };
      }
      if (operation === "channel") {
        const { id, autoReplies, ...settings } = CustomerChannelSettingsInput.parse(args);
        const where = { id, botId, userId: actor.userId, spaceId: actor.spaceId };
        if (autoReplies) {
          if (!(await prisma.customerChannel.findFirst({ where }))) throw new IsolationError();
          // Publish before taking the channel lock; recheck ownership in the transaction.
          await manage(actor, botId, "initialize", {});
        }
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM customer_channels WHERE id = ${id} FOR UPDATE`;
          const channel = await tx.customerChannel.findFirst({ where });
          if (!channel) throw new IsolationError();
          if (autoReplies !== undefined) await setCustomerChannelReplies(tx, channel, autoReplies);
          await tx.customerChannel.update({ where: { id }, data: settings });
          if (settings.enabled === false || settings.shared === false)
            await invalidateCustomerConversations(tx, { channelId: id }, "staff");
        });
        return { ok: true };
      }
      if (operation === "inspect")
        return {
          behavior: await prisma.customerBehavior.findUnique({ where: { botId } }),
          channels: await prisma.customerChannel.findMany({
            where: { botId },
            select: {
              id: true,
              name: true,
              provider: true,
              connectionId: true,
              enabled: true,
              autoReplies: true,
              binding: true,
              pollError: true,
              shared: true,
              websiteOrigins: true,
              dailyMessageLimit: true,
              hourlyCustomerLimit: true,
              retentionDays: true,
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
          services: await prisma.botSecret.findMany({
            where: { userId: actor.userId, spaceId: actor.spaceId, botId },
            select: { name: true, origin: true, auth: true },
          }),
          models: await prisma.userModelCredential.findMany({
            where: { userId: actor.userId },
            select: { id: true, label: true, provider: true },
          }),
        };
      if (operation === "instructions" || operation === "configure" || operation === "initialize") {
        const existing = await prisma.customerBehavior.findUnique({ where: { botId } });
        if (operation === "initialize" && existing) return existing;
        const input =
          operation === "initialize"
            ? CustomerBehaviorInput.parse(await customerReplyDefaults(deps, actor, bot))
            : operation === "configure"
              ? CustomerBehaviorInput.parse(args)
              : CustomerBehaviorInput.parse({
                  ...existing,
                  ...CustomerInstructionsInput.parse(args),
                });
        const actions = validateCustomerGrants(input.actions);
        for (const grant of actions) await connection(actor, grant.connectionId);
        if (input.knowledgeFilterId && !input.knowledge)
          throw new Error("Select the OpenRAG knowledge connection for this filter");
        const modelGrant = await modelBridge.create(actor, {
          credentialId: input.modelCredentialId,
          modelId: input.modelId,
        });
        await modelBridge.revoke(actor, modelGrant.id);
        const runtime = await runtimeFor({ ...actor, botId }, input);
        if (!runtime.publish)
          throw new Error("Customer runtime does not support managed publication");
        const flowId = await runtime.publish({
          staffId: botId,
          instructions: input.instructions,
          knowledgeFilterId: input.knowledgeFilterId ?? undefined,
          signal: AbortSignal.timeout(30_000),
        });
        // Publish first. A failed publication leaves the active revision untouched.
        return prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
          if (
            !(await tx.bot.findFirst({
              where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
            }))
          )
            throw new IsolationError();
          if (
            input.knowledgeFilterId &&
            (await tx.bot.findUniqueOrThrow({ where: { id: botId } })).knowledgeLibraryId
          )
            throw new Error(
              "Manage attached knowledge through Documents; detach it before using a legacy filter",
            );
          const current = await tx.customerBehavior.findUnique({ where: { botId } });
          // Concurrent first connections must never replace a published/customized behavior.
          if (operation === "initialize" && current) return current;
          if (current?.revision !== existing?.revision)
            throw new Error("Customer behavior changed; inspect and retry");
          return tx.customerBehavior.upsert({
            where: { botId },
            create: {
              botId,
              ...input,
              knowledge: input.knowledge ?? Prisma.DbNull,
              actions,
              flowId,
            },
            update: {
              ...input,
              knowledge: input.knowledge ?? Prisma.DbNull,
              actions,
              flowId,
              revision: { increment: 1 },
            },
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
              autoReplies: true,
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
              autoReplies: true,
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
                  webhookUrl: customerWebhookUrl(deps.apiUrl, channel.id),
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
        failed: await prisma.customerMessage.count({
          where: {
            conversation: { channel: { spaceId: actor.spaceId, userId: actor.userId, botId } },
            status: "failed",
            createdAt: { gte: from, lt: until },
          },
        }),
        waiting: await prisma.customerConversation.count({
          where: {
            channel: { spaceId: actor.spaceId, userId: actor.userId, botId },
            needsHuman: true,
          },
        }),
        actions: await prisma.customerToolCall.count({
          where: {
            message: {
              conversation: { channel: { spaceId: actor.spaceId, userId: actor.userId, botId } },
            },
            createdAt: { gte: from, lt: until },
          },
        }),
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
