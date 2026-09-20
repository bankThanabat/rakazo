import type { Actor } from "@rakazo/contracts";
import type { CustomerChannel, Prisma, PrismaClient } from "./client.js";
import { invalidateCustomerConversations } from "./customer-inbox.js";
import { IsolationError } from "./scope.js";

/** Shared by the connection controls and the staff agent's channel tool. */
export async function setCustomerChannelReplies(
  tx: Prisma.TransactionClient,
  channel: Pick<CustomerChannel, "id" | "botId" | "autoReplies">,
  enabled: boolean,
  botId = channel.botId,
) {
  if (enabled && !(await tx.customerBehavior.findUnique({ where: { botId } })))
    throw new Error("Set up customer replies for the assigned staff first.");
  if (enabled === channel.autoReplies && botId === channel.botId) return;

  await tx.customerChannel.update({
    where: { id: channel.id },
    data: { autoReplies: enabled, botId },
  });
  // Fence generation already in flight without cancelling a human's queued reply.
  await invalidateCustomerConversations(tx, { channelId: channel.id, owner: "bot" });
  await tx.customerMessage.updateMany({
    where: {
      conversation: { channelId: channel.id },
      role: { in: ["customer", "bot"] },
      status: { in: ["queued", "processing"] },
    },
    data: { status: "cancelled" },
  });
  if (enabled) {
    // Resume chats received while replies were off; keep explicit human assignments/handoffs.
    // Only future incoming messages trigger replies, never the accumulated backlog.
    await tx.customerConversation.updateMany({
      where: { channelId: channel.id, assigneeId: null, handoffReason: null },
      data: {
        owner: "bot",
        needsHuman: false,
        nextAttentionAlertAt: null,
        ownerAttentionAlertAt: null,
        generation: { increment: 1 },
      },
    });
  }
}

export async function configureCustomerReplies(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  input: { connectionId: string; enabled: boolean; botId?: string },
) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM connections WHERE id = ${input.connectionId} FOR UPDATE`;
    const connection = await tx.connection.findFirst({
      where: {
        id: input.connectionId,
        userId: actor.userId,
        spaceId: actor.spaceId,
        status: "connected",
      },
    });
    if (!connection) throw new IsolationError();
    const channel = await tx.customerChannel.findFirst({
      where: { connectionId: connection.id, userId: actor.userId, spaceId: actor.spaceId },
    });
    if (!channel?.enabled) throw new Error("Finish connecting this account first.");
    const botId = input.botId ?? channel.botId;
    const bot = await tx.bot.findFirst({
      where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
    });
    if (!bot) throw new IsolationError();
    await tx.$queryRaw`SELECT id FROM customer_channels WHERE id = ${channel.id} FOR UPDATE`;
    const current = await tx.customerChannel.findUniqueOrThrow({ where: { id: channel.id } });
    await setCustomerChannelReplies(tx, current, input.enabled, botId);
  });
}
