import { createHmac, timingSafeEqual } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { CustomerMessageLimitError, createCustomerInbox } from "@rakazo/db";
import { createCustomerConnector } from "./customer-connector.js";
import { customerField, customerPage } from "./customer-mapping.js";
import { customerWebhookBinding, liveCustomerWebhookChannel } from "./customer-webhooks.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import type { EncryptedSecretStore } from "./secrets.js";

export function equalWebhookSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyCustomerWebhook(
  raw: string,
  headers: Headers,
  config: {
    header: string;
    algorithm: "sha256" | "sha1" | "token";
    encoding: "base64" | "hex";
    prefix: string;
    timestamp?: { header: string; prefix: string; separator: string };
  },
  secret: string,
) {
  const supplied = headers.get(config.header) ?? "";
  let payload = raw;
  if (config.timestamp) {
    const timestamp = headers.get(config.timestamp.header) ?? "";
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
      throw new Error("Webhook timestamp expired");
    payload = `${config.timestamp.prefix}${timestamp}${config.timestamp.separator}${raw}`;
  }
  const expected =
    config.algorithm === "token"
      ? secret
      : createHmac(config.algorithm, secret).update(payload).digest(config.encoding);
  if (!secret || !equalWebhookSecret(supplied, config.prefix + expected))
    throw new Error("Invalid webhook signature");
}

/** Provider payloads are normalized only after account-bound authentication. */
export function createCustomerIngress(deps: {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  integrations: IntegrationProviderSettings;
  jobs: JobPublisher;
}) {
  const inbox = createCustomerInbox(deps.prisma);
  const connector = createCustomerConnector(deps);
  async function load(channelId: string) {
    const channel = await deps.prisma.customerChannel.findFirst({
      where: { id: channelId, ...liveCustomerWebhookChannel },
    });
    if (!channel?.connectionId || !channel.startedAt)
      throw new Error("Customer channel is unavailable");
    await connector.connection(channel, channel.connectionId);
    const webhook = customerWebhookBinding(channel.binding);
    if (!webhook) throw new Error("Webhook is unavailable");
    async function secret(id: string) {
      const row = await deps.prisma.secret.findFirst({
        where: {
          id,
          userId: channel!.userId,
          OR: [{ spaceId: channel!.spaceId }, { spaceId: null }],
        },
      });
      if (!row) throw new Error("Webhook credential is unavailable");
      return deps.secrets.load(row.ciphertext, row.id);
    }
    return { channel, ...webhook, secret };
  }
  return {
    async challenge(channelId: string, token: string) {
      const context = await load(channelId);
      if (
        !context.verification.verificationSecretId ||
        !equalWebhookSecret(token, await context.secret(context.verification.verificationSecretId))
      )
        throw new Error("Invalid verification token");
    },
    async receive(channelId: string, headers: Headers, raw: string) {
      const { channel, binding, verification, secret } = await load(channelId);
      verifyCustomerWebhook(raw, headers, verification, await secret(verification.secretId));
      const data: unknown = JSON.parse(raw);
      if (verification.challengePath) {
        let challenge: unknown;
        try {
          challenge = customerField(data, verification.challengePath);
        } catch {
          /* Ordinary event */
        }
        if (typeof challenge === "string" && challenge.length <= 4000) return { challenge };
      }
      const page = customerPage(binding, data, channel.startedAt!);
      for (const message of page.messages) {
        // Fence a mapping/account change racing signature verification.
        let id: string;
        try {
          id = await inbox.receive(channelId, message, undefined, channel.updatedAt);
        } catch (error) {
          if (error instanceof CustomerMessageLimitError) continue;
          throw error;
        }
        await deps.jobs
          .enqueue({
            name: "customer.process",
            payload: { conversationId: id },
            replaceKey: `customer.process:${id}`,
          })
          .catch(() => undefined);
      }
      return { ok: true };
    },
  };
}
