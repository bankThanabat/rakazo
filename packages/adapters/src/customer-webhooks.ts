import type { Actor } from "@rakazo/contracts";
import { CustomerBindingSchema } from "@rakazo/contracts";
import type { Connection, PrismaClient } from "@rakazo/db";
import { customerChannelAccessWhere } from "@rakazo/db";

export const liveCustomerWebhookChannel = {
  enabled: true,
  startedAt: { not: null },
  bot: { archivedAt: null },
};

export function customerWebhookBinding(value: unknown) {
  const parsed = CustomerBindingSchema.safeParse(value);
  return parsed.success && parsed.data.receive.mode === "webhook" && parsed.data.receive.webhook
    ? { binding: parsed.data, verification: parsed.data.receive.webhook }
    : null;
}

export function customerWebhookUrl(apiUrl: string | undefined, channelId: string) {
  return `${(apiUrl ?? "http://127.0.0.1:3100").replace(/\/$/, "")}/api/customer-events/${channelId}`;
}

export async function listConnectionWebhooks(
  deps: { prisma: PrismaClient; apiUrl?: string },
  actor: Pick<Actor, "spaceId" | "userId">,
  connections: Connection[],
) {
  const ids = connections
    .filter((row) => row.status === "connected" && row.connectorId === "open-connector")
    .map((row) => row.id);
  const channels = ids.length
    ? await deps.prisma.customerChannel.findMany({
        where: {
          ...customerChannelAccessWhere(actor),
          ...liveCustomerWebhookChannel,
          connectionId: { in: ids },
        },
        select: {
          id: true,
          connectionId: true,
          binding: true,
          webhookUrl: true,
          autoReplies: true,
        },
      })
    : [];
  const urls = new Map<string, { url: string; autoReplies: boolean }>();
  for (const channel of channels) {
    if (channel.connectionId && customerWebhookBinding(channel.binding))
      urls.set(channel.connectionId, {
        url: channel.webhookUrl ?? customerWebhookUrl(deps.apiUrl, channel.id),
        autoReplies: channel.autoReplies,
      });
  }
  return urls;
}
