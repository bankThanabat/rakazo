import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { requireCustomerAccess } from "./customers.js";
import { IsolationError } from "./scope.js";

/** A deliberate rejection, not a retryable receive failure. */
export class CustomerMessageLimitError extends Error {
  constructor() {
    super("Customer message limit reached");
  }
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
    (channel.provider !== "web" && (!channel.connectionId || !channel.binding))
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
    data: { generation: { increment: 1 }, ...(owner ? { owner, needsHuman: false } : {}) },
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
  await invalidateCustomerConversations(tx, { id }, "staff");
  const next = await tx.customerConversation.update({
    where: { id },
    data: {
      needsHuman: true,
      notifiedGeneration: -1,
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
      body: "A support agent will follow up here.",
    },
  });
}

export function createCustomerInbox(prisma: PrismaClient) {
  return {
    async receive(
      channelId: string,
      input: {
        externalId: string;
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
          if (duplicate.body !== input.body || duplicate.senderId !== input.customerId)
            throw new Error("Message identifier was already used");
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
            ...(locked.owner === "staff" ? { needsHuman: true, notifiedGeneration: -1 } : {}),
          },
        });
        await tx.customerMessage.create({
          data: {
            conversationId: next.id,
            seq: next.nextSeq,
            externalId,
            role: "customer",
            senderId: input.customerId,
            body: input.body,
            status: next.owner === "bot" ? "queued" : "received",
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
      },
    ) {
      await requireCustomerAccess(prisma, actor, input.id);
      await prisma.$transaction(async (tx) => {
        const row = await lockConversation(tx, input.id);
        if (
          row.channel.spaceId !== actor.spaceId ||
          (!row.channel.shared && row.channel.userId !== actor.userId)
        )
          throw new IsolationError();
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
