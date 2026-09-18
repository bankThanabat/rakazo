import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import type { Actor, GatewayCommand, GatewayServerConfig } from "@rakazo/contracts";
import {
  GatewayCommandSchema,
  GatewayServerConfigSchema,
  WebhookVerificationSchema,
} from "@rakazo/contracts";
import type { GatewayAccount, Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError, requireMembership } from "@rakazo/db";
import { z } from "zod";
import { ConvoyRelay } from "./convoy-relay.js";
import { loadManagedWebhook } from "./customer-incoming-settings.js";
import { equalWebhookSecret, verifyCustomerWebhook } from "./customer-ingress.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { OpenConnector } from "./open-connector.js";
import { loadOperatorSettings, saveOperatorSettings } from "./operator-settings.js";
import type { EncryptedSecretStore } from "./secrets.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const settingsId = "integration-gateway";
const routeSecrets = z.object({
  webhookSecret: z.string(),
  deliveryToken: z.string(),
  verification: WebhookVerificationSchema.optional(),
  verificationToken: z.string().optional(),
});

/** Cloud authorization is derived from a stored runtime and current membership.
 * No user/space IDs, upstream credentials or callback URLs come from a runtime. */
export class IntegrationGateway {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      secrets: EncryptedSecretStore;
      integrations: IntegrationProviderSettings;
    },
  ) {}
  async configuration() {
    const stored = await loadOperatorSettings(this.deps, settingsId);
    return stored ? GatewayServerConfigSchema.parse(stored) : null;
  }
  async configure(actor: Actor, input: GatewayServerConfig) {
    if (!actor.isDeploymentOwner) throw new IsolationError();
    const config = GatewayServerConfigSchema.parse(input);
    const current = await this.configuration();
    if (
      current &&
      ["endpoint", "projectId", "callbackOrigin"].some(
        (key) =>
          current[key as keyof GatewayServerConfig] !== config[key as keyof GatewayServerConfig],
      ) &&
      (await this.deps.prisma.gatewayRoute.count())
    )
      throw new Error("Disconnect existing routes before moving the gateway");
    await new ConvoyRelay(config).verify();
    await saveOperatorSettings(this.deps, settingsId, config);
  }
  async createRuntime(actor: Actor, name: string) {
    if (!(await this.configuration())) throw new Error("Gateway is not configured");
    await requireMembership(this.deps.prisma, actor.userId, actor.spaceId);
    if (
      (await this.deps.prisma.gatewayRuntime.count({
        where: { spaceId: actor.spaceId, userId: actor.userId, revokedAt: null },
      })) >= 10
    )
      throw new Error("Revoke an unused runtime key before creating another");
    const token = `rkz_runtime_${randomBytes(32).toString("base64url")}`;
    const row = await this.deps.prisma.gatewayRuntime.create({
      data: { userId: actor.userId, spaceId: actor.spaceId, name, tokenHash: hash(token) },
    });
    return { id: row.id, token };
  }
  async listRuntimes(
    actor: Actor,
  ): Promise<Array<{ id: string; name: string; revokedAt: Date | null }>> {
    return this.deps.prisma.gatewayRuntime.findMany({
      where: { userId: actor.userId, spaceId: actor.spaceId },
      select: { id: true, name: true, revokedAt: true },
      orderBy: { createdAt: "asc" },
    });
  }
  async revokeRuntime(actor: Actor, id: string) {
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM gateway_runtimes WHERE id = ${id} FOR UPDATE`;
      const row = await tx.gatewayRuntime.findFirst({
        where: { id, userId: actor.userId, spaceId: actor.spaceId },
      });
      if (!row) throw new IsolationError();
      await tx.gatewayRuntime.update({ where: { id }, data: { revokedAt: new Date() } });
      await tx.gatewayRoute.updateMany({
        where: { account: { runtimeId: id } },
        data: { enabled: false },
      });
    });
  }
  async command(token: string, input: unknown, signal: AbortSignal) {
    const command = GatewayCommandSchema.parse(input);
    const { prisma, integrations } = this.deps;
    if (!token.startsWith("rkz_runtime_")) throw new IsolationError();
    const runtime = await prisma.gatewayRuntime.findUnique({ where: { tokenHash: hash(token) } });
    if (!runtime || runtime.revokedAt) throw new IsolationError();
    const actor = await requireMembership(prisma, runtime.userId, runtime.spaceId);
    const adapter = await integrations.resolve("open-connector");
    if (!(adapter instanceof OpenConnector))
      throw new Error("Gateway requires a direct connector configuration");
    const context: AdapterContext = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      operationId: randomUUID(),
      traceId: randomUUID(),
      signal,
    };
    return prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM gateway_runtimes WHERE id = ${runtime.id} FOR UPDATE`;
        if ((await tx.gatewayRuntime.findUniqueOrThrow({ where: { id: runtime.id } })).revokedAt)
          throw new IsolationError();
        const accounts = await tx.gatewayAccount.findMany({
          where: {
            runtimeId: runtime.id,
            OR: [
              { revokedAt: null },
              ...(command.op === "revoke" || command.op === "cancel"
                ? [{ providerRef: command.ref }]
                : []),
            ],
          },
        });
        const owned = (ref: string) => {
          const row = accounts.find((row) => row.providerRef === ref);
          if (!row) throw new IsolationError();
          return row;
        };
        if ("ref" in command) owned(command.ref);
        if ("connections" in command) {
          context.actionAccess = command.actionAccess;
          context.connectedConnections = command.connections.map((connection) => {
            const row = owned(connection.providerRef);
            if (row.provider !== connection.externalId) throw new IsolationError();
            return { ...connection, externalId: row.provider };
          });
        }
        switch (command.op) {
          case "catalog":
            return adapter.catalog(context, command.query);
          case "setup": {
            const setup = await adapter.setup(command.provider, context);
            // Runtime owners cannot edit the operator's OAuth application.
            return {
              ...setup,
              oauthManaged: true,
              oauthFields: [],
              oauthSetupUrl: undefined,
              oauthCallbackUrl: undefined,
            };
          }
          case "listActions":
            return adapter.listActions(command.provider, context);
          case "begin": {
            if (accounts.length >= 100) throw new Error("Runtime account limit reached");
            const result = await adapter.begin({ ...command, redirectUrl: "" }, context);
            try {
              await tx.gatewayAccount.create({
                data: {
                  runtimeId: runtime.id,
                  provider: command.provider,
                  providerRef: result.state,
                },
              });
            } catch (error) {
              await adapter.revoke(result.state, context);
              throw error;
            }
            return result;
          }
          case "poll":
            return adapter.pollConnection(command.ref, context);
          case "status":
            return adapter.connectionStatus(command.ref, context);
          case "reconnect":
            return adapter.reconnect(command.ref, command.auth, context);
          case "cancel": {
            if (owned(command.ref).revokedAt) return { connected: false };
            const result = await adapter.cancelAuthorization(command.ref, context);
            if (!result.connected)
              await tx.gatewayAccount.update({
                where: { id: owned(command.ref).id },
                data: { revokedAt: new Date() },
              });
            return result;
          }
          case "revoke": {
            const account = owned(command.ref);
            await adapter.revoke(command.ref, context);
            await tx.gatewayAccount.update({
              where: { id: account.id },
              data: { revokedAt: new Date() },
            });
            await tx.gatewayRoute.updateMany({
              where: { accountId: account.id },
              data: { enabled: false },
            });
            return null;
          }
          case "discover":
            return adapter.discoverTools(context);
          case "resolve":
            return (await adapter.resolveCall(command.call, context)) ?? null;
          case "execute": {
            const events: ConnectorEvent[] = [];
            for await (const event of adapter.execute(command.call, context)) events.push(event);
            return events;
          }
          case "incoming":
            if (!(await adapter.pollConnection(command.ref, context)))
              throw new Error("Account authorization is pending");
            return this.provisionRoute(owned(command.ref), command);
          case "deliveries":
            return this.pullDeliveries(tx, runtime.id);
          case "ack": {
            const result = await tx.gatewayDelivery.updateMany({
              where: { id: command.id, route: { account: { runtimeId: runtime.id } } },
              data: { payload: null, ackedAt: new Date() },
            });
            if (!result.count) throw new IsolationError();
            return null;
          }
        }
      },
      { timeout: 120000 },
    );
  }
  /** One relay route per account and local channel. The route row is written with
   * the base client, outside the command transaction, so it survives a failed
   * Convoy call and the retry repairs the same route instead of creating another. */
  private async provisionRoute(
    account: GatewayAccount,
    command: Extract<GatewayCommand, { op: "incoming" }>,
  ) {
    const { prisma, secrets } = this.deps;
    const config = await this.configuration();
    if (!config) throw new Error("Webhook relay is not configured");
    // The cloud operator owns application verification; a runtime cannot replace it.
    const managed = await loadManagedWebhook(this.deps, account.provider);
    if (managed) command = { ...command, ...managed };
    if (!command.webhookSecret) throw new Error("Webhook signing secret is required");
    // Formats Convoy cannot verify use the same durable queue after gateway verification.
    const direct = Boolean(
      command.verification.prefix || command.verification.timestamp || command.verificationToken,
    );
    const key = { accountId: account.id, channelId: command.channelId };
    let route = await prisma.gatewayRoute.findUnique({ where: { accountId_channelId: key } });
    if (!route) {
      const id = randomUUID();
      const ciphertext = secrets.seal(
        JSON.stringify({
          webhookSecret: command.webhookSecret,
          deliveryToken: randomBytes(32).toString("base64url"),
          verification: direct ? command.verification : undefined,
          verificationToken: command.verificationToken,
        }),
        id,
      );
      route = await prisma.gatewayRoute.create({ data: { id, ...key, ciphertext } });
    }
    const secret = routeSecrets.parse(JSON.parse(secrets.load(route.ciphertext, route.id)));
    if (!equalWebhookSecret(secret.webhookSecret, command.webhookSecret))
      throw new Error("Secret differs from the existing route");
    if (
      Boolean(secret.verification) !== direct ||
      (direct && JSON.stringify(secret.verification) !== JSON.stringify(command.verification)) ||
      !equalWebhookSecret(secret.verificationToken ?? "", command.verificationToken ?? "")
    )
      throw new Error("Verification differs from the existing route");
    if (direct) {
      const webhookUrl = new URL(
        `/api/integration-gateway/webhook/${route.id}`,
        config.callbackOrigin,
      ).href;
      await prisma.gatewayRoute.update({
        where: { id: route.id },
        data: { webhookUrl, enabled: true },
      });
      return { id: route.id, webhookUrl };
    }
    const provisioned = await new ConvoyRelay(config).provision(
      route.id,
      command.verification,
      secret.webhookSecret,
      secret.deliveryToken,
    );
    await prisma.gatewayRoute.update({
      where: { id: route.id },
      data: { ...provisioned, enabled: true },
    });
    return { id: route.id, webhookUrl: provisioned.webhookUrl };
  }
  private async pullDeliveries(tx: Prisma.TransactionClient, runtimeId: string) {
    const rows = await tx.gatewayDelivery.findMany({
      where: {
        ackedAt: null,
        nextAttemptAt: { lte: new Date() },
        route: { enabled: true, account: { runtimeId, revokedAt: null } },
      },
      include: { route: { include: { account: true } } },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: 20,
    });
    // Delay redelivery after an unacknowledged pull so a poison batch
    // cannot permanently hide other channels behind the first 20 rows.
    await tx.gatewayDelivery.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { nextAttemptAt: new Date(Date.now() + 30000) },
    });
    return rows.map((row) => ({
      id: row.id,
      routeId: row.routeId,
      channelId: row.route.channelId,
      providerRef: row.route.account.providerRef,
      payload: row.payload!,
    }));
  }
  async removeUserAccounts(userId: string) {
    // Wait for commands holding a runtime row lock, then prevent new commands
    // before collecting credentials that user deletion would otherwise cascade.
    await this.deps.prisma.gatewayRuntime.updateMany({
      where: { userId },
      data: { revokedAt: new Date() },
    });
    const accounts = await this.deps.prisma.gatewayAccount.findMany({
      where: { runtime: { userId } },
      include: { runtime: true },
    });
    if (!accounts.length) return;
    const adapter = await this.deps.integrations.resolve("open-connector");
    if (!(adapter instanceof OpenConnector))
      throw new Error("Connector unavailable during account removal");
    for (const account of accounts) {
      await adapter.revoke(account.providerRef, {
        spaceId: account.runtime.spaceId,
        userId,
        operationId: "gateway.remove-user",
        traceId: account.id,
        signal: AbortSignal.timeout(10000),
      });
    }

    await this.deps.prisma.gatewayAccount.updateMany({
      where: { runtime: { userId } },
      data: { revokedAt: new Date() },
    });
    await this.deps.prisma.gatewayRoute.updateMany({
      where: { account: { runtime: { userId } } },
      data: { enabled: false },
    });
  }
  async maintain() {
    const config = await this.configuration();
    if (!config) return;
    const adapter = await this.deps.integrations.resolve("open-connector");
    if (adapter instanceof OpenConnector) {
      const accounts = await this.deps.prisma.gatewayAccount.findMany({
        where: { revokedAt: null, runtime: { revokedAt: { not: null } } },
        include: { runtime: true },
        take: 20,
      });
      for (const account of accounts) {
        await adapter.revoke(account.providerRef, {
          spaceId: account.runtime.spaceId,
          userId: account.runtime.userId,
          operationId: "gateway.cleanup",
          traceId: account.id,
          signal: AbortSignal.timeout(10000),
        });
        await this.deps.prisma.gatewayAccount.update({
          where: { id: account.id },
          data: { revokedAt: new Date() },
        });
      }
    }
    const routes = await this.deps.prisma.gatewayRoute.findMany({
      where: {
        enabled: false,
        OR: [
          { account: { revokedAt: { not: null } } },
          { account: { runtime: { revokedAt: { not: null } } } },
        ],
      },
      take: 20,
    });
    const relay = new ConvoyRelay(config);
    for (const route of routes) {
      const secret = routeSecrets.parse(
        JSON.parse(this.deps.secrets.load(route.ciphertext, route.id)),
      );
      if (!secret.verification) await relay.remove(route.id);
      await this.deps.prisma.gatewayRoute.delete({ where: { id: route.id } });
    }
  }
  private async loadRoute(routeId: string) {
    const { prisma, secrets } = this.deps;
    const route = await prisma.gatewayRoute.findUnique({
      where: { id: routeId },
      include: { account: { include: { runtime: true } } },
    });
    if (!route?.enabled || route.account.revokedAt || route.account.runtime.revokedAt)
      throw new IsolationError();
    const secret = routeSecrets.parse(JSON.parse(secrets.load(route.ciphertext, route.id)));
    await requireMembership(prisma, route.account.runtime.userId, route.account.runtime.spaceId);
    return { route, secret };
  }
  async challenge(routeId: string, token: string) {
    const { secret } = await this.loadRoute(routeId);
    if (
      !secret.verification ||
      !secret.verificationToken ||
      !equalWebhookSecret(token, secret.verificationToken)
    )
      throw new IsolationError();
  }
  async receiveWebhook(routeId: string, headers: Headers, raw: string) {
    const { route, secret } = await this.loadRoute(routeId);
    if (!secret.verification) throw new IsolationError();
    try {
      verifyCustomerWebhook(raw, headers, secret.verification, secret.webhookSecret);
    } catch {
      throw new IsolationError();
    }
    await this.enqueue(route, raw);
  }
  async receive(routeId: string, bearer: string, raw: string) {
    const { route, secret } = await this.loadRoute(routeId);
    if (secret.verification || !equalWebhookSecret(bearer, secret.deliveryToken))
      throw new IsolationError();
    await this.enqueue(route, raw);
  }
  private async enqueue(
    route: Awaited<ReturnType<IntegrationGateway["loadRoute"]>>["route"],
    raw: string,
  ) {
    const { prisma } = this.deps;
    JSON.parse(raw);
    // Authentication is complete. Tenant and route always come from stored ownership.
    const id = hash(`${route.id}\n${raw}`);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM gateway_runtimes WHERE id = ${route.account.runtimeId} FOR UPDATE`;
      const current = await tx.gatewayRoute.findUniqueOrThrow({
        where: { id: route.id },
        include: { account: { include: { runtime: true } } },
      });
      if (!current.enabled || current.account.revokedAt || current.account.runtime.revokedAt)
        throw new IsolationError();
      if (await tx.gatewayDelivery.findUnique({ where: { id } })) return;
      const queued = await tx.gatewayDelivery.count({
        where: { ackedAt: null, route: { account: { runtimeId: route.account.runtimeId } } },
      });
      if (queued >= 1000) throw new Error("Runtime inbox is full");
      await tx.gatewayDelivery.create({ data: { id, routeId: route.id, payload: raw } });
    });
  }
}
