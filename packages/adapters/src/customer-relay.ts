import { randomUUID } from "node:crypto";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { CustomerBindingSchema, IncomingSetupInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { z } from "zod";
import { createCustomerConnector } from "./customer-connector.js";
import type { CustomerIncomingTemplate } from "./customer-incoming.js";
import { customerIncomingTemplate } from "./customer-incoming.js";
import { createCustomerIngress } from "./customer-ingress.js";
import { customerField } from "./customer-mapping.js";
import { customerWebhookSecretId, customerWebhookUrl } from "./customer-webhooks.js";
import { IntegrationGatewayClient } from "./integration-gateway-client.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import type { EncryptedSecretStore } from "./secrets.js";

type Dependencies = {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  integrations: IntegrationProviderSettings;
  apiUrl?: string;
};

/** Confirms the stored credential works before provisioning, and names the fix when it does not. */
async function verifyAccount(
  connector: ReturnType<typeof createCustomerConnector>,
  actor: Actor,
  connectionId: string,
  lookup: { action: string; path: string[] },
) {
  try {
    const result = await connector.execute(
      actor,
      connectionId,
      lookup.action,
      {},
      // A verification is a fresh read, not a replay of another attempt's cached result.
      randomUUID(),
    );
    return z.string().min(1).parse(customerField(result, lookup.path));
  } catch (cause) {
    throw new Error("Could not verify the account. Check its credentials, then try again.", {
      cause,
    });
  }
}

/** Encrypts newly entered secrets and reuses stored ones, returning every plaintext setup needs. */
async function storeSecrets(
  deps: Dependencies,
  actor: Actor,
  context: AdapterContext,
  template: CustomerIncomingTemplate,
  entered: Record<string, string>,
  secretIds: Record<string, string>,
) {
  const values: Record<string, string> = {};
  for (const secret of template.secrets) {
    const id = secretIds[secret.key]!;
    const value = entered[secret.key];
    if (value) {
      const record = await deps.secrets.put(value, context, id);
      await deps.prisma.secret.upsert({
        where: { id },
        create: {
          ...record,
          userId: actor.userId,
          spaceId: actor.spaceId,
          kind: "customer-webhook",
        },
        update: { ciphertext: record.ciphertext },
      });
      values[secret.key] = value;
      continue;
    }
    const stored = await deps.prisma.secret.findFirst({
      where: { id, userId: actor.userId, kind: "customer-webhook" },
    });
    if (!stored) throw new Error(`${secret.label} is required`);
    values[secret.key] = deps.secrets.load(stored.ciphertext, stored.id);
  }
  return values;
}

/** Turns a connected messaging account into a receiving channel using the
 * provider's incoming template. Nothing here knows which app it is setting up. */
export async function setupCustomerIncoming(deps: Dependencies, actor: Actor, raw: unknown) {
  const input = IncomingSetupInputSchema.parse(raw);
  const connector = createCustomerConnector(deps);
  const account = await connector.connection(actor, input.connectionId);
  if (account.userId !== actor.userId) throw new IsolationError();
  const template = customerIncomingTemplate(account.provider);
  if (!template) throw new Error("Incoming messages are not available for this app");
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
  });
  if (!bot) throw new IsolationError();
  const context: AdapterContext = {
    ...actor,
    operationId: "incoming.setup",
    traceId: account.id,
    signal: AbortSignal.timeout(120000),
  };
  const adapter = await deps.integrations.resolve("open-connector");
  // Persist the local channel before remote provisioning, so interrupted setup
  // retries the same route and can accept delivery as soon as setup finishes.
  const channel = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM connections WHERE id = ${account.id} FOR UPDATE`;
    const existing = await tx.customerChannel.findUnique({ where: { connectionId: account.id } });
    if (existing) {
      if (existing.botId !== bot.id || existing.userId !== actor.userId) throw new IsolationError();
      return existing;
    }
    return tx.customerChannel.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        provider: account.provider,
        accountId: account.id,
        connectionId: account.id,
        name: account.displayName,
        ciphertext: "",
        enabled: false,
        startedAt: new Date(),
        autoReplies: false,
      },
    });
  });
  const secretIds = Object.fromEntries(
    template.secrets.map((secret) => [secret.key, customerWebhookSecretId(channel.id, secret.key)]),
  );
  const accountId = template.account
    ? await verifyAccount(connector, actor, account.id, template.account)
    : "";
  // Saved once the account checks out, so a later provisioning failure retries without retyping.
  const secrets = await storeSecrets(deps, actor, context, template, input.secrets, secretIds);
  const binding = CustomerBindingSchema.parse(template.binding({ account: accountId, secretIds }));
  const webhook = binding.receive.webhook;
  const webhookKey = Object.keys(secretIds).find((key) => secretIds[key] === webhook?.secretId);
  if (!webhook || !webhookKey) throw new Error("Incoming setup requires a webhook binding");
  const relay =
    adapter instanceof IntegrationGatewayClient
      ? await adapter.incoming(
          account.providerRef!,
          channel.id,
          { webhookSecret: secrets[webhookKey]!, verification: webhook },
          context,
        )
      : null;
  const webhookUrl = relay?.webhookUrl ?? customerWebhookUrl(deps.apiUrl, channel.id);
  await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM connections WHERE id = ${account.id} FOR UPDATE`;
    const current = await tx.connection.findUniqueOrThrow({ where: { id: account.id } });
    if (current.status !== "connected" || current.providerRef !== account.providerRef)
      throw new IsolationError();
    await tx.customerChannel.update({
      where: { id: channel.id },
      data: {
        binding,
        webhookUrl,
        relayId: relay?.id ?? null,
        enabled: true,
        startedAt: channel.startedAt ?? new Date(),
      },
    });
  });
  return { id: channel.id, webhookUrl };
}

/** Outbound polling requires no public port on a customer machine. Cloud ACK
 * follows committed local inbox writes. Failed ACKs redeliver into local dedupe. */
export async function receiveCustomerRelayBatch(
  deps: Dependencies & { jobs: JobPublisher },
  signal: AbortSignal,
) {
  const adapter = await deps.integrations.resolve("open-connector");
  if (!(adapter instanceof IntegrationGatewayClient)) return;
  const ingress = createCustomerIngress(deps);
  const deliveries = await adapter.deliveries(signal);
  for (const delivery of deliveries) {
    signal.throwIfAborted();
    try {
      await ingress.receiveRelayed(delivery);
      await adapter.acknowledge(delivery.id, signal);
    } catch {
      // Continue with other channels; retain the failed delivery for recovery.
    }
  }
}
