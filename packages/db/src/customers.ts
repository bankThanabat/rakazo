import { randomUUID } from "node:crypto";
import type {
  Actor,
  CustomerChannel,
  CustomerConversation,
  CustomerSnapshot,
} from "@rakazo/contracts";
import {
  CustomerChannelSchema,
  CustomerConversationSchema,
  CustomerSnapshotSchema,
} from "@rakazo/contracts";
import type {
  CustomerChannel as ChannelRow,
  CustomerConversation as ConversationRow,
  CustomerMessage,
  Prisma,
  PrismaClient,
} from "./client.js";
import { IsolationError } from "./scope.js";

type Tx = Prisma.TransactionClient;
export const customerScope = (actor: Actor) => ({
  channel: { spaceId: actor.spaceId, userId: actor.userId },
});
export function customerChannelDto(row: ChannelRow): CustomerChannel {
  return CustomerChannelSchema.parse({
    ...row,
    webhookPath: `/api/v1/customers/channels/${row.id}/webhook`,
  });
}
export function customerConversationDto(
  row: ConversationRow & { channel: ChannelRow; messages: CustomerMessage[] },
): CustomerConversation {
  return CustomerConversationSchema.parse({
    ...row,
    provider: row.channel.provider,
    channelName: row.channel.name,
    preview: row.messages.at(-1)?.body ?? "",
    updatedAt: row.updatedAt.toISOString(),
  });
}
export async function lockCustomerConversation(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM customer_conversations WHERE id = ${id} FOR UPDATE`;
}
export async function cancelCustomerWork(tx: Tx, id: string, owner: "staff" | "bot") {
  await lockCustomerConversation(tx, id);
  await tx.customerConversation.update({
    where: { id },
    data: {
      owner,
      needsHuman: false,
      generation: { increment: 1 },
      leaseToken: null,
      leaseUntil: null,
    },
  });
  await tx.customerMessage.updateMany({
    where: { conversationId: id, status: { in: ["queued", "processing"] } },
    data: { status: "cancelled" },
  });
}
export async function appendCustomerMessage(
  tx: Tx,
  id: string,
  data: Omit<Prisma.CustomerMessageUncheckedCreateInput, "conversationId" | "seq">,
) {
  const conversation = await tx.customerConversation.update({
    where: { id },
    data: { nextSeq: { increment: 1 }, updatedAt: new Date() },
  });
  return tx.customerMessage.create({
    data: { id: randomUUID(), ...data, conversationId: id, seq: conversation.nextSeq },
  });
}

export function createCustomerRepos(prisma: PrismaClient) {
  return {
    async channels(actor: Actor) {
      return (
        await prisma.customerChannel.findMany({
          where: { spaceId: actor.spaceId, userId: actor.userId },
          orderBy: { createdAt: "asc" },
        })
      ).map(customerChannelDto);
    },
    async list(actor: Actor) {
      const rows = await prisma.customerConversation.findMany({
        where: customerScope(actor),
        include: { channel: true, messages: { orderBy: { seq: "desc" }, take: 1 } },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: 200,
      });
      return rows.map(customerConversationDto);
    },
    async snapshot(actor: Actor, id: string): Promise<CustomerSnapshot> {
      const row = await prisma.customerConversation.findFirst({
        where: { id, ...customerScope(actor) },
        include: { channel: true, messages: { orderBy: { seq: "desc" }, take: 200 } },
      });
      if (!row) throw new IsolationError();
      row.messages.reverse();
      return CustomerSnapshotSchema.parse({
        conversation: customerConversationDto(row),
        messages: row.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
      });
    },
    async setOwner(actor: Actor, id: string, owner: "bot" | "staff") {
      await prisma.$transaction(async (tx) => {
        await lockCustomerConversation(tx, id);
        const row = await tx.customerConversation.findFirst({
          where: { id, ...customerScope(actor) },
        });
        if (!row) throw new IsolationError();
        if (row.owner === owner) return;
        // Resuming only responds to new customer messages. Old work never revives.
        await cancelCustomerWork(tx, id, owner);
      });
    },
    async reply(actor: Actor, id: string, body: string, clientNonce: string) {
      await prisma.$transaction(async (tx) => {
        await lockCustomerConversation(tx, id);
        const row = await tx.customerConversation.findFirst({
          where: {
            id,
            ...customerScope(actor),
            channel: { spaceId: actor.spaceId, userId: actor.userId, enabled: true },
          },
        });
        if (!row) throw new IsolationError();
        if (row.owner !== "staff") throw new Error("Take over the conversation before replying");
        const externalId = `staff:${actor.userId}:${clientNonce}`;
        if (
          await tx.customerMessage.findUnique({
            where: { conversationId_externalId: { conversationId: id, externalId } },
          })
        )
          return;
        await tx.customerConversation.update({ where: { id }, data: { needsHuman: false } });
        await appendCustomerMessage(tx, id, {
          role: "staff",
          body,
          externalId,
          status: "queued",
          generation: row.generation,
        });
      });
    },
    async receive(
      channelId: string,
      event: {
        threadId: string;
        handle: string;
        receiptId?: string;
        from: string;
        fromLabel: string | null;
        content: string;
        mediaUrl: string | null;
        sentAt?: number;
      },
      expectedCiphertext?: string,
    ) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_channels WHERE id = ${channelId} FOR SHARE`;
        const channel = await tx.customerChannel.findUnique({ where: { id: channelId } });
        if (!channel?.enabled) return;
        if (expectedCiphertext && channel.ciphertext !== expectedCiphertext) return;
        await tx.customerConversation.createMany({
          data: {
            channelId,
            externalThreadId: event.threadId,
            customerId: event.from,
            name: event.fromLabel || event.from,
          },
          skipDuplicates: true,
        });
        const conversation = await tx.customerConversation.findUniqueOrThrow({
          where: { channelId_externalThreadId: { channelId, externalThreadId: event.threadId } },
        });
        await lockCustomerConversation(tx, conversation.id);
        const current = await tx.customerConversation.findUniqueOrThrow({
          where: { id: conversation.id },
        });
        // A provider thread cannot silently become another customer's conversation.
        if (current.customerId !== event.from) throw new IsolationError();
        const externalId = `inbound:${event.receiptId ?? event.handle}`;
        if (
          await tx.customerMessage.findUnique({
            where: { conversationId_externalId: { conversationId: current.id, externalId } },
          })
        )
          return;
        await appendCustomerMessage(tx, current.id, {
          externalId,
          providerHandle: event.handle,
          role: "customer",
          body: event.content.slice(0, 16000) || "[Attachment]",
          mediaUrl: safeCustomerMediaUrl(event.mediaUrl),
          status: current.owner === "bot" ? "queued" : "received",
          generation: current.generation,
          ...(event.sentAt && Number.isFinite(event.sentAt)
            ? { createdAt: new Date(Math.min(event.sentAt, Date.now())) }
            : {}),
        });
        return current.id;
      });
    },
  };
}

export function safeCustomerMediaUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
