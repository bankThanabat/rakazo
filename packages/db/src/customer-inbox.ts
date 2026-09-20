import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { customerChannelUsesConnector } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { requireCustomerAccess } from "./customers.js";
import { queueCustomerLearning } from "./learning-queue.js";
import { IsolationError } from "./scope.js";

/** A deliberate rejection, not a retryable receive failure. */
export class CustomerMessageLimitError extends Error {
  constructor() {
    super("Customer message limit reached");
  }
}

/** Suppress delayed originals after an authenticated withdrawal. */
export class CustomerMessageWithdrawnError extends Error {
  constructor() {
    super("Customer message was withdrawn");
  }
}
const withdrawalKey = (thread: string, message: string) =>
  createHash("sha256")
    .update(JSON.stringify([thread, message]))
    .digest("hex");

/** One durable clock and delivery identity per unresolved issue, independent of later messages. */
export function startCustomerAttention() {
  const now = new Date();
  return {
    needsHuman: true,
    acknowledgedAt: null,
    attentionId: randomUUID(),
    attentionStartedAt: now,
    attentionAlertStage: 0,
    nextAttentionAlertAt: now,
    ownerAttentionAlertAt: new Date(now.getTime() + 30 * 60000),
  };
}

async function lockConversation(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM customer_conversations WHERE id = ${id} FOR UPDATE`;
  const row = await tx.customerConversation.findUnique({
    where: { id },
    include: { channel: true },
  });
  if (!row) throw new IsolationError();
  return row;
}

function requireLive(channel: {
  enabled: boolean;
  provider: string;
  connectionId: string | null;
  binding: unknown;
}) {
  if (
    !channel.enabled ||
    (customerChannelUsesConnector(channel.provider) && (!channel.connectionId || !channel.binding))
  )
    throw new Error("This conversation is archived");
}

export async function invalidateCustomerConversations(
  tx: Prisma.TransactionClient,
  where: Prisma.CustomerConversationWhereInput,
  owner?: "staff",
) {
  // Lock conversations before messages, matching dispatch and receive lock order.
  await tx.customerConversation.updateMany({
    where,
    data: {
      generation: { increment: 1 },
      ...(owner
        ? { owner, needsHuman: false, nextAttentionAlertAt: null, ownerAttentionAlertAt: null }
        : {}),
    },
  });
  // Keep the lease: a dispatched send or business action can still finish.
  await tx.customerMessage.updateMany({
    where: { conversation: where, status: { in: ["queued", "processing"] } },
    data: { status: "cancelled" },
  });
}

/** Transfer ownership and queue one acknowledgement in the same transaction. */
export async function handoffCustomer(tx: Prisma.TransactionClient, id: string, reason: string) {
  const row = await lockConversation(tx, id);
  if (row.owner === "staff" && row.needsHuman) return;
  const latestCustomer = await tx.customerMessage.findFirst({
    where: { conversationId: id, role: "customer" },
    orderBy: { seq: "desc" },
    select: { body: true },
  });
  await invalidateCustomerConversations(tx, { id }, "staff");
  const next = await tx.customerConversation.update({
    where: { id },
    data: {
      ...startCustomerAttention(),
      handoffReason: reason.slice(0, 500),
      state: "open",
      nextSeq: { increment: 1 },
    },
  });
  await tx.customerMessage.create({
    data: {
      conversationId: id,
      seq: next.nextSeq,
      role: "system",
      status: "queued",
      generation: next.generation,
      body: /\p{Script=Thai}/u.test(latestCustomer?.body ?? "")
        ? "ส่งเรื่องให้เจ้าหน้าที่แล้ว เจ้าหน้าที่จะตอบกลับในแชทนี้"
        : "A support agent will follow up here.",
    },
  });
}

export function createCustomerInbox(prisma: PrismaClient) {
  return {
    async steer(
      actor: Pick<Actor, "userId" | "spaceId">,
      input: { id: string; guidance: string; nonce: string },
    ) {
      await requireCustomerAccess(prisma, actor, input.id);
      return prisma.$transaction(async (tx) => {
        const row = await lockConversation(tx, input.id);
        if (
          row.channel.spaceId !== actor.spaceId ||
          (!row.channel.shared && row.channel.userId !== actor.userId)
        )
          throw new IsolationError();
        requireLive(row.channel);
        const prior = await tx.customerGuidance.findUnique({
          where: { conversationId_nonce: { conversationId: row.id, nonce: input.nonce } },
        });
        if (prior) {
          if (prior.content !== input.guidance) throw new Error("Guidance nonce was already used");
          return { applied: true as const, inFlight: prior.inFlight, queued: false };
        }
        const latest = await tx.customerMessage.findFirst({
          where: { conversationId: row.id, role: "customer", status: { not: "withdrawn" } },
          orderBy: { seq: "desc" },
          include: { toolCalls: true },
        });
        const dispatched = await tx.customerMessage.count({
          where: {
            conversationId: row.id,
            role: { in: ["bot", "staff"] },
            status: { in: ["sending", "sent"] },
            inReplyToSeq: latest?.seq ?? -1,
          },
        });
        const inFlight = Boolean(dispatched || latest?.toolCalls.length);
        await tx.customerGuidance.create({
          data: {
            conversationId: row.id,
            nonce: input.nonce,
            content: input.guidance,
            userId: actor.userId,
            inFlight,
          },
        });
        await queueCustomerLearning(tx, row.id, actor.userId, input.guidance);
        await invalidateCustomerConversations(tx, { id: row.id });
        // A turn with any tool activity must never be replayed to apply guidance.
        const queued = Boolean(
          latest && !inFlight && row.owner === "bot" && row.channel.autoReplies,
        );
        if (queued && latest)
          await tx.customerMessage.update({
            where: { id: latest.id },
            data: {
              status: "queued",
              generation: row.generation + 1,
              executionKeyHash: null,
              executionUntil: null,
              executionPolicyHash: null,
            },
          });
        return { applied: true as const, inFlight, queued };
      });
    },
    async receive(
      channelId: string,
      input: {
        externalId: string;
        providerMessageId?: string;
        externalThreadId: string;
        customerId: string;
        name: string;
        body: string;
        unsupported?: boolean;
      },
      pollToken?: string,
      configurationTime?: Date,
    ) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_channels WHERE id = ${channelId} FOR UPDATE`;
        const channel = await tx.customerChannel.findUniqueOrThrow({ where: { id: channelId } });
        requireLive(channel);
        if (configurationTime && channel.updatedAt.getTime() !== configurationTime.getTime())
          throw new Error("Channel configuration changed");
        if (pollToken && channel.pollToken !== pollToken)
          throw new Error("Channel configuration changed");
        if (
          input.providerMessageId &&
          (await tx.customerMessageWithdrawal.count({
            where: {
              channelId,
              key: withdrawalKey(input.externalThreadId, input.providerMessageId),
            },
          }))
        )
          throw new CustomerMessageWithdrawnError();
        const conversation = await tx.customerConversation.upsert({
          where: {
            channelId_externalThreadId: { channelId, externalThreadId: input.externalThreadId },
          },
          create: {
            channelId,
            externalThreadId: input.externalThreadId,
            customerId: input.customerId,
            name: input.name,
            owner: channel.autoReplies ? "bot" : "staff",
          },
          update: {},
        });
        const locked = await lockConversation(tx, conversation.id);
        const externalId = `in:${input.externalId}`;
        const duplicate = await tx.customerMessage.findUnique({
          where: { conversationId_externalId: { conversationId: locked.id, externalId } },
        });
        if (duplicate) {
          if (
            duplicate.body !== input.body ||
            duplicate.senderId !== input.customerId ||
            (input.providerMessageId &&
              duplicate.providerHandle &&
              duplicate.providerHandle !== input.providerMessageId)
          )
            throw new Error("Message identifier was already used");
          if (input.providerMessageId && !duplicate.providerHandle)
            await tx.customerMessage.update({
              where: { id: duplicate.id },
              data: { providerHandle: input.providerMessageId },
            });
          return locked.id;
        }
        const now = new Date();
        const day = new Date(now);
        day.setUTCHours(0, 0, 0, 0);
        const daily = await tx.customerMessage.count({
          where: { role: "customer", createdAt: { gte: day }, conversation: { channelId } },
        });
        const hourly = await tx.customerMessage.count({
          where: {
            role: "customer",
            senderId: input.customerId,
            createdAt: { gte: new Date(now.getTime() - 3600000) },
            conversation: { channelId },
          },
        });
        if (daily >= channel.dailyMessageLimit || hourly >= channel.hourlyCustomerLimit)
          throw new CustomerMessageLimitError();
        const next = await tx.customerConversation.update({
          where: { id: locked.id },
          data: {
            nextSeq: { increment: 1 },
            lastCustomerSeq: locked.nextSeq + 1,
            state: "open",
            name: input.name,
            ...(!channel.autoReplies || locked.owner === "staff"
              ? {
                  needsHuman: true,
                  ...(!locked.needsHuman ? startCustomerAttention() : {}),
                }
              : {}),
          },
        });
        await tx.customerMessage.create({
          data: {
            conversationId: next.id,
            seq: next.nextSeq,
            externalId,
            providerHandle: input.providerMessageId,
            role: "customer",
            senderId: input.customerId,
            body: input.body,
            status: channel.autoReplies && next.owner === "bot" ? "queued" : "received",
            generation: next.generation,
          },
        });
        if (input.unsupported)
          await handoffCustomer(
            tx,
            next.id,
            "Customer sent a non-text message. View it in the original channel.",
          );
        return next.id;
      });
    },
    async withdraw(
      channelId: string,
      input: { externalThreadId: string; providerMessageId: string },
      configurationTime?: Date,
      pollToken?: string,
    ) {
      return prisma.$transaction(async (tx) => {
        // Learning writes lock the Space before the case; use the same order before deleting tasks.
        const { spaceId } = await tx.customerChannel.findUniqueOrThrow({
          where: { id: channelId },
          select: { spaceId: true },
        });
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${spaceId} FOR UPDATE`;
        // Same channel/conversation order as receive, including an original arriving late.
        await tx.$queryRaw`SELECT id FROM customer_channels WHERE id = ${channelId} FOR UPDATE`;
        const channel = await tx.customerChannel.findUniqueOrThrow({ where: { id: channelId } });
        if (
          (configurationTime && channel.updatedAt.getTime() !== configurationTime.getTime()) ||
          (pollToken && channel.pollToken !== pollToken)
        )
          throw new Error("Channel configuration changed");
        const recorded = await tx.customerMessageWithdrawal.createMany({
          data: { channelId, key: withdrawalKey(input.externalThreadId, input.providerMessageId) },
          skipDuplicates: true,
        });
        if (!recorded.count) return;
        const conversation = await tx.customerConversation.findUnique({
          where: {
            channelId_externalThreadId: { channelId, externalThreadId: input.externalThreadId },
          },
        });
        if (!conversation) return;
        const row = await lockConversation(tx, conversation.id);
        const messages = await tx.customerMessage.findMany({
          where: {
            conversationId: row.id,
            role: "customer",
            providerHandle: input.providerMessageId,
          },
          select: { id: true, seq: true },
        });
        if (!messages.length) return;
        const sourceIds = messages.map((m) => m.id);
        const requiresReview = Boolean(
          (row.leaseUntil && row.leaseUntil > new Date()) ||
            row.draftText ||
            (await tx.customerMessage.count({
              where: {
                conversationId: row.id,
                id: { notIn: sourceIds },
                status: { in: ["queued", "processing", "sending"] },
              },
            })) ||
            (await tx.customerToolCall.count({
              where: { messageId: { in: sourceIds }, status: { not: "completed" } },
            })),
        );
        await invalidateCustomerConversations(
          tx,
          { id: row.id },
          requiresReview ? "staff" : undefined,
        );
        await tx.customerMessage.updateMany({
          where: { id: { in: messages.map((m) => m.id) } },
          data: {
            body: "",
            mediaUrl: null,
            status: "withdrawn",
            executionKeyHash: null,
            executionPolicyHash: null,
            executionUntil: null,
          },
        });
        await tx.customerToolCall.updateMany({
          where: { messageId: { in: messages.map((m) => m.id) } },
          data: { result: Prisma.DbNull, replyBody: null },
        });
        // Preserve older decisions whose captured transcript excludes this source.
        // Unknown evidence shapes are removed rather than risking a retained copy.
        const tasks = await tx.learningTask.findMany({
          where: { conversationId: row.id },
          select: { id: true, evidence: true },
        });
        const affected = tasks.filter((task) => {
          const captured =
            task.evidence && typeof task.evidence === "object" && !Array.isArray(task.evidence)
              ? task.evidence.messages
              : null;
          return (
            !Array.isArray(captured) ||
            captured.some(
              (item) =>
                !item ||
                typeof item !== "object" ||
                Array.isArray(item) ||
                typeof item.seq !== "number" ||
                messages.some((message) => message.seq === item.seq),
            )
          );
        });
        await tx.learningTask.deleteMany({
          where: { id: { in: affected.map((task) => task.id) } },
        });
        await tx.customerConversation.update({
          where: { id: row.id },
          data: {
            draftText: null,
            draftForSeq: null,
            ...(requiresReview
              ? {
                  ...(!row.needsHuman
                    ? startCustomerAttention()
                    : {
                        needsHuman: true,
                        nextAttentionAlertAt: row.nextAttentionAlertAt,
                        ownerAttentionAlertAt: row.ownerAttentionAlertAt,
                      }),
                  handoffReason:
                    "A customer withdrew a message. Review the remaining context before resuming.",
                }
              : {}),
          },
        });
        // Never retain an undispatched draft that could quote the withdrawn source.
        await tx.customerMessage.updateMany({
          where: { conversationId: row.id, role: { not: "customer" }, status: "cancelled" },
          data: { body: "", mediaUrl: null },
        });
      });
    },
    async setOwner(actor: Pick<Actor, "userId" | "spaceId">, id: string, owner: "bot" | "staff") {
      await requireCustomerAccess(prisma, actor, id);
      await prisma.$transaction(async (tx) => {
        const row = await lockConversation(tx, id);
        if (
          row.channel.spaceId !== actor.spaceId ||
          (!row.channel.shared && row.channel.userId !== actor.userId)
        )
          throw new IsolationError();
        requireLive(row.channel);
        if (row.owner === owner) return;
        if (owner === "staff") await invalidateCustomerConversations(tx, { id }, "staff");
        else {
          if (
            await tx.customerMessage.count({
              where: { conversationId: id, role: "staff", status: { in: ["queued", "sending"] } },
            })
          )
            throw new Error("Wait for the staff reply to finish sending");
          await tx.customerConversation.update({
            where: { id },
            data: {
              owner,
              needsHuman: false,
              nextAttentionAlertAt: null,
              ownerAttentionAlertAt: null,
              handoffReason: null,
              state: "open",
              generation: { increment: 1 },
            },
          });
        }
      });
    },
    async reply(
      actor: Pick<Actor, "userId" | "spaceId">,
      input: { id: string; body: string; nonce: string },
    ) {
      await requireCustomerAccess(prisma, actor, input.id);
      await prisma.$transaction(async (tx) => {
        let row = await lockConversation(tx, input.id);
        if (
          row.channel.spaceId !== actor.spaceId ||
          (!row.channel.shared && row.channel.userId !== actor.userId)
        )
          throw new IsolationError();
        requireLive(row.channel);
        const externalId = `staff:${input.nonce}`;
        const duplicate = await tx.customerMessage.findUnique({
          where: { conversationId_externalId: { conversationId: row.id, externalId } },
        });
        if (duplicate) {
          if (duplicate.body !== input.body) throw new Error("Reply nonce was already used");
          return;
        }
        if (row.owner === "bot") {
          await invalidateCustomerConversations(tx, { id: row.id }, "staff");
          row = await lockConversation(tx, row.id);
        }
        const next = await tx.customerConversation.update({
          where: { id: row.id },
          data: {
            nextSeq: { increment: 1 },
            needsHuman: false,
            nextAttentionAlertAt: null,
            ownerAttentionAlertAt: null,
            state: "open",
            assigneeId: actor.userId,
          },
        });
        await tx.customerMessage.create({
          data: {
            conversationId: row.id,
            externalId,
            seq: next.nextSeq,
            role: "staff",
            body: input.body,
            generation: next.generation,
            status: "queued",
          },
        });
      });
    },
    async updateCase(
      actor: Pick<Actor, "userId" | "spaceId">,
      input: {
        id: string;
        state?: "open" | "resolved";
        assigneeId?: string | null;
        read?: boolean;
        acknowledge?: true;
      },
    ) {
      if (input.acknowledge && input.state === "resolved")
        throw new Error("Acknowledge or resolve the case, not both");
      await requireCustomerAccess(prisma, actor, input.id);
      await prisma.$transaction(async (tx) => {
        const row = await lockConversation(tx, input.id);
        if (
          row.channel.spaceId !== actor.spaceId ||
          (!row.channel.shared && row.channel.userId !== actor.userId)
        )
          throw new IsolationError();
        const members = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM space_members
          WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR SHARE`;
        if (!members.length) throw new IsolationError();
        if (input.acknowledge && row.needsHuman && row.state === "open" && !row.acknowledgedAt) {
          requireLive(row.channel);
          const acknowledgment = await tx.customerAcknowledgement.create({
            data: {
              conversationId: row.id,
              userId: actor.userId,
              generation: row.generation,
              customerSeq: row.lastCustomerSeq,
            },
          });
          await tx.customerConversation.update({
            where: { id: row.id },
            data: {
              acknowledgedAt: acknowledgment.createdAt,
              nextAttentionAlertAt: null,
              ownerAttentionAlertAt: null,
            },
          });
        }
        if (
          input.assigneeId &&
          ((!row.channel.shared && input.assigneeId !== row.channel.userId) ||
            !(await tx.spaceMember.count({
              where: { spaceId: actor.spaceId, userId: input.assigneeId },
            })))
        )
          throw new IsolationError();
        if (input.state === "resolved")
          await invalidateCustomerConversations(tx, { id: row.id }, "staff");
        await tx.customerConversation.update({
          where: { id: row.id },
          data: { state: input.state, assigneeId: input.assigneeId },
        });
        if (input.state === "resolved" && row.state !== "resolved")
          await queueCustomerLearning(tx, row.id, actor.userId);
        if (input.read)
          await tx.customerConversationRead.upsert({
            where: { conversationId_userId: { conversationId: row.id, userId: actor.userId } },
            create: { conversationId: row.id, userId: actor.userId, seq: row.lastCustomerSeq },
            update: { seq: row.lastCustomerSeq },
          });
      });
    },
  };
}
