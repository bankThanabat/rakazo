import type { Actor } from "@rakazo/contracts";
import { CustomerBindingSchema } from "@rakazo/contracts";
import type { Connection, PrismaClient } from "@rakazo/db";
import { customerChannelAccessWhere } from "@rakazo/db";
import { customerIncomingTemplate } from "./customer-incoming.js";

export const liveCustomerWebhookChannel = {
  enabled: true,
  startedAt: { not: null },
  bot: { archivedAt: null },
};

export function customerWebhookSecretId(channelId: string, key: string) {
  return `customer-webhook:${channelId}:${key}`;
}

export function customerWebhookBinding(value: unknown) {
  const parsed = CustomerBindingSchema.safeParse(value);
  return parsed.success && parsed.data.receive.mode === "webhook" && parsed.data.receive.webhook
    ? { binding: parsed.data, verification: parsed.data.receive.webhook }
    : null;
}

export function customerWebhookUrl(apiUrl: string | undefined, channelId: string) {
  return `${(apiUrl ?? "http://127.0.0.1:3100").replace(/\/$/, "")}/api/customer-events/${channelId}`;
}

export type ConnectionIncoming = {
  url?: string;
  autoReplies?: boolean;
  botId: string;
  botName: string;
  savedSecrets: string[];
};

/** Incoming-message state per connection id: the live webhook plus secrets saved by an unfinished setup. */
export async function listConnectionIncoming(
  deps: { prisma: PrismaClient; apiUrl?: string },
  actor: Pick<Actor, "spaceId" | "userId">,
  connections: Connection[],
) {
  const ids = connections
    .filter((row) => row.status === "connected" && row.connectorId === "open-connector")
    .map((row) => row.id);
  const incoming = new Map<string, ConnectionIncoming>();
  if (!ids.length) return incoming;
  const where = { ...customerChannelAccessWhere(actor), connectionId: { in: ids } };
  const [channels, live] = await Promise.all([
    deps.prisma.customerChannel.findMany({
      where,
      select: {
        id: true,
        connectionId: true,
        provider: true,
        binding: true,
        webhookUrl: true,
        autoReplies: true,
        botId: true,
        bot: { select: { name: true } },
      },
    }),
    deps.prisma.customerChannel.findMany({
      where: { ...where, ...liveCustomerWebhookChannel },
      select: { id: true },
    }),
  ]);
  const liveIds = new Set(live.map((row) => row.id));
  const secretIds = channels.flatMap((channel) =>
    (customerIncomingTemplate(channel.provider)?.secrets ?? []).map((secret) =>
      customerWebhookSecretId(channel.id, secret.key),
    ),
  );
  const saved = new Set(
    secretIds.length
      ? (
          await deps.prisma.secret.findMany({
            where: { id: { in: secretIds }, userId: actor.userId, kind: "customer-webhook" },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [],
  );
  for (const channel of channels) {
    if (!channel.connectionId) continue;
    const isLive = liveIds.has(channel.id) && customerWebhookBinding(channel.binding);
    incoming.set(channel.connectionId, {
      url: isLive ? (channel.webhookUrl ?? customerWebhookUrl(deps.apiUrl, channel.id)) : undefined,
      autoReplies: isLive ? channel.autoReplies : undefined,
      botId: channel.botId,
      botName: channel.bot.name,
      savedSecrets: (customerIncomingTemplate(channel.provider)?.secrets ?? [])
        .map((secret) => secret.key)
        .filter((key) => saved.has(customerWebhookSecretId(channel.id, key))),
    });
  }
  return incoming;
}
