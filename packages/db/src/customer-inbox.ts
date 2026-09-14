import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

async function lockConversation(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM customer_conversations WHERE id = ${id} FOR UPDATE`;
  const row = await tx.customerConversation.findUnique({
    where: { id },
    include: { channel: true },
  });
  if (!row) throw new IsolationError();
  return row;
}

function requireLive(channel: { enabled: boolean; connectionId: string | null; binding: unknown }) {
  if (!channel.enabled || !channel.connectionId || !channel.binding)
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
      },
      pollToken?: string,
      configurationTime?: Date,
    ) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_channels WHERE id = ${channelId} FOR SHARE`;
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
          },
          update: {},
        });
        const locked = await lockConversation(tx, conversation.id);
        const externalId = `in:${input.externalId}`;
        if (
          await tx.customerMessage.findUnique({
            where: { conversationId_externalId: { conversationId: locked.id, externalId } },
          })
        )
          return locked.id;
        const next = await tx.customerConversation.update({
          where: { id: locked.id },
          data: { nextSeq: { increment: 1 }, name: input.name },
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
        return next.id;
      });
    },
    async setOwner(actor: Pick<Actor, "userId" | "spaceId">, id: string, owner: "bot" | "staff") {
      await prisma.$transaction(async (tx) => {
        const row = await lockConversation(tx, id);
        if (row.channel.spaceId !== actor.spaceId || row.channel.userId !== actor.userId)
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
            data: { owner, needsHuman: false, generation: { increment: 1 } },
          });
        }
      });
    },
    async reply(
      actor: Pick<Actor, "userId" | "spaceId">,
      input: { id: string; body: string; nonce: string },
    ) {
      await prisma.$transaction(async (tx) => {
        let row = await lockConversation(tx, input.id);
        if (row.channel.spaceId !== actor.spaceId || row.channel.userId !== actor.userId)
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
          data: { nextSeq: { increment: 1 } },
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
  };
}
