import type { Actor, CustomerConversation, CustomerSnapshot } from "@rakazo/contracts";
import { CustomerConversationSchema, CustomerSnapshotSchema } from "@rakazo/contracts";
import type {
  CustomerChannel as ChannelRow,
  CustomerConversation as ConversationRow,
  CustomerMessage,
  PrismaClient,
} from "./client.js";
import { IsolationError } from "./scope.js";

const customerScope = (actor: Pick<Actor, "userId" | "spaceId">) => ({
  channel: { spaceId: actor.spaceId, userId: actor.userId },
});
export function customerConversationDto(
  row: ConversationRow & { channel: ChannelRow; messages: CustomerMessage[] },
): CustomerConversation {
  return CustomerConversationSchema.parse({
    ...row,
    provider: row.channel.provider,
    channelName: row.channel.name,
    canReply: row.channel.enabled && Boolean(row.channel.connectionId && row.channel.binding),
    preview: row.messages.at(-1)?.body ?? "",
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function createCustomerRepos(prisma: PrismaClient) {
  return {
    async list(actor: Pick<Actor, "userId" | "spaceId">) {
      const rows = await prisma.customerConversation.findMany({
        where: customerScope(actor),
        include: { channel: true, messages: { orderBy: { seq: "desc" }, take: 1 } },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: 200,
      });
      return rows.map(customerConversationDto);
    },
    async snapshot(
      actor: Pick<Actor, "userId" | "spaceId">,
      id: string,
    ): Promise<CustomerSnapshot> {
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
  };
}
