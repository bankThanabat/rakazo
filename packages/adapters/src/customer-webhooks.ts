import type { Actor } from "@rakazo/contracts";
import { CustomerBindingSchema } from "@rakazo/contracts";
import type { Connection, PrismaClient } from "@rakazo/db";
import { customerChannelAccessWhere, IsolationError } from "@rakazo/db";
import { createCustomerConnector } from "./customer-connector.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";

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
        select: { id: true, connectionId: true, binding: true },
      })
    : [];
  const urls = new Map<string, string>();
  for (const channel of channels) {
    if (channel.connectionId && customerWebhookBinding(channel.binding))
      urls.set(channel.connectionId, customerWebhookUrl(deps.apiUrl, channel.id));
  }
  return urls;
}

/** Prepare a staff request; credentials and customer activation keep their existing approval flow. */
export async function prepareCustomerWebhookSetup(
  deps: { prisma: PrismaClient; integrations: IntegrationProviderSettings },
  actor: Actor,
  input: { connectionId: string; botId: string },
) {
  const connection = await createCustomerConnector(deps).connection(actor, input.connectionId);
  const bot = await deps.prisma.bot.findFirst({
    where: {
      id: input.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      thread: { isNot: null },
    },
    select: { id: true, name: true },
  });
  if (!bot) throw new IsolationError();
  return {
    botId: bot.id,
    name: bot.name,
    text: `Set up incoming customer messages for connection ${JSON.stringify(connection.id)}. Use customer_inspect and inspect this account's connector action schemas. Reuse any existing channel and do not reassign another staff member's account. Request missing credentials through the secure credential UI. Configure customer behavior and call customer_connect through the existing owner approval flow; explain that activation enables automatic replies before requesting approval. For a webhook receiver, return the generated webhookUrl and the provider's registration steps so I can paste it into the provider settings. Do not change provider webhook settings without asking. The URL will also be available on this account's connection page. If incoming messages are unsupported, explain that instead of inventing an endpoint.`,
  };
}
