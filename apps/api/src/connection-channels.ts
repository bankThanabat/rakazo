import { ORPCError } from "@orpc/server";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import type { ConnectorRegistry, EncryptedSecretStore } from "@rakazo/adapters";
import { ConnectionIncomingSchema } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { TeamChatBridge } from "./team-chat-bridge.js";

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function connectionIncoming(value: unknown) {
  const raw = metadata(metadata(value).incoming);
  const parsed = ConnectionIncomingSchema.safeParse(raw);
  return parsed.success && typeof raw.secretId === "string"
    ? { ...parsed.data, secretId: raw.secretId }
    : undefined;
}
export function connectionIncomingDto(value: unknown) {
  const incoming = connectionIncoming(value);
  return incoming ? { botId: incoming.botId, webhookUrl: incoming.webhookUrl } : undefined;
}
type Actor = { spaceId: string; userId: string };
type Row = NonNullable<Awaited<ReturnType<PrismaClient["connection"]["findFirst"]>>>;

export class ConnectionChannels {
  private bridges = new Map<string, { botId: string; bridge: TeamChatBridge }>();
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      secrets: EncryptedSecretStore;
      connectors: ConnectorRegistry;
      events: ThreadEvents;
      jobs: JobPublisher;
    },
  ) {}

  private context(row: Row): AdapterContext {
    return {
      operationId: "connection.webhook",
      traceId: "connection.webhook",
      spaceId: row.spaceId,
      userId: row.userId,
      signal: AbortSignal.timeout(30000),
      connectedConnections: [
        {
          id: row.id,
          connectorId: row.connectorId,
          externalId: row.provider,
          displayName: row.displayName,
          providerRef: row.providerRef ?? undefined,
        },
      ],
    };
  }
  private async owned(actor: Actor, id: string) {
    const row = await this.deps.prisma.connection.findFirst({
      where: { id, spaceId: actor.spaceId, userId: actor.userId, status: "connected" },
    });
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }
  async save(
    actor: Actor,
    input: { connectionId: string; botId: string; webhookOrigin: string; channelSecret?: string },
  ) {
    const row = await this.owned(actor, input.connectionId);
    const provider = this.deps.connectors.managed(row.connectorId);
    const catalog = await provider?.catalog(this.context(row));
    if (
      !provider?.receiveWebhook ||
      !provider.sendReply ||
      !catalog?.some((item) => item.slug === row.provider && item.incomingMessages)
    )
      throw new ORPCError("BAD_REQUEST", {
        message: "This connection does not support incoming messages",
      });
    const bot = await this.deps.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    });
    if (!bot) throw new ORPCError("NOT_FOUND");
    const url = new URL(input.webhookOrigin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new ORPCError("BAD_REQUEST", {
        message: "Enter the public HTTPS origin without a path",
      });
    const old = connectionIncoming(row.metadata);
    if (old && old.botId !== input.botId)
      throw new ORPCError("BAD_REQUEST", {
        message: "Disable automatic replies before changing the bot",
      });
    if (!old && !input.channelSecret)
      throw new ORPCError("BAD_REQUEST", { message: "Enter the channel secret" });
    const secretId = `${row.id}:webhook`;
    const incoming = {
      botId: bot.id,
      secretId,
      webhookUrl: `${url.origin}/api/v1/connections/${row.id}/webhook`,
    };
    await this.deps.prisma.$transaction(async (tx) => {
      if (input.channelSecret) {
        const { ciphertext } = await this.deps.secrets.put(
          input.channelSecret,
          this.context(row),
          secretId,
        );
        await tx.secret.upsert({
          where: { id: secretId },
          create: {
            id: secretId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            kind: "connection-webhook",
            ciphertext,
          },
          update: { ciphertext },
        });
      }
      await tx.connection.update({
        where: { id: row.id },
        data: { metadata: JSON.parse(JSON.stringify({ ...metadata(row.metadata), incoming })) },
      });
    });
    await this.refresh();
    return { botId: incoming.botId, webhookUrl: incoming.webhookUrl };
  }
  async disable(actor: Actor, id: string) {
    const row = await this.owned(actor, id);
    const next = { ...metadata(row.metadata) };
    delete next.incoming;
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.connection.update({
        where: { id },
        data: { metadata: JSON.parse(JSON.stringify(next)) },
      });
      await tx.secret.deleteMany({
        where: {
          id: `${id}:webhook`,
          spaceId: actor.spaceId,
          userId: actor.userId,
          kind: "connection-webhook",
        },
      });
    });
    await this.refresh();
    return { ok: true as const };
  }
  async receive(id: string, request: Request): Promise<Response> {
    const row = await this.deps.prisma.connection.findFirst({ where: { id, status: "connected" } });
    const config = connectionIncoming(row?.metadata);
    if (!row || !config) return new Response(null, { status: 404 });
    const secret = await this.deps.prisma.secret.findFirst({
      where: {
        id: config.secretId,
        spaceId: row.spaceId,
        userId: row.userId,
        kind: "connection-webhook",
      },
    });
    const provider = this.deps.connectors.managed(row.connectorId);
    if (!secret || !provider?.receiveWebhook) return new Response(null, { status: 404 });
    const result = await provider.receiveWebhook(
      request,
      this.deps.secrets.load(secret.ciphertext, secret.id),
      this.context(row),
    );
    if (result.status !== 200) return new Response(null, { status: result.status });
    await this.refresh();
    const entry = this.bridges.get(id);
    if (!entry || entry.botId !== config.botId) return new Response(null, { status: 503 });
    for (const event of result.events) await entry.bridge.receive(event, { reconcile: false });
    return new Response(null, { status: 200 });
  }
  async start() {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh().catch(() => getLogger().error("Connection channel refresh failed"));
    }, 5000);
    this.timer.unref();
  }
  private refresh() {
    if (!this.refreshing)
      this.refreshing = this.refreshOnce().finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  private async refreshOnce() {
    if (this.stopped) return;
    const rows = await this.deps.prisma.connection.findMany({
      where: {
        status: "connected",
        metadata: { path: ["incoming", "botId"], string_contains: "" },
      },
    });
    const active = new Set<string>();
    for (const row of rows) {
      const config = connectionIncoming(row.metadata);
      if (!config) continue;
      const bot = await this.deps.prisma.bot.findFirst({
        where: { id: config.botId, spaceId: row.spaceId, userId: row.userId, archivedAt: null },
      });
      if (!bot) continue;
      active.add(row.id);
      const old = this.bridges.get(row.id);
      if (old?.botId === bot.id) continue;
      if (old) {
        await old.bridge.stop();
        this.bridges.delete(row.id);
      }
      const bridge = new TeamChatBridge({
        ...this.deps,
        botId: bot.id,
        providerId: `${row.connectorId}:${row.id}:${bot.id}`,
        send: async (request) => {
          const current = await this.deps.prisma.connection.findFirst({
            where: { id: row.id, spaceId: row.spaceId, userId: row.userId, status: "connected" },
          });
          if (!current || connectionIncoming(current.metadata)?.botId !== bot.id)
            throw new Error("Automatic replies are disabled");
          const provider = this.deps.connectors.managed(current.connectorId);
          if (!provider?.sendReply) throw new Error("Reply provider is unavailable");
          return provider.sendReply(request, this.context(current));
        },
      });
      await bridge.start();
      if (this.stopped) await bridge.stop();
      else this.bridges.set(row.id, { botId: bot.id, bridge });
    }
    for (const [id, entry] of this.bridges)
      if (!active.has(id)) {
        await entry.bridge.stop();
        this.bridges.delete(id);
      }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.refreshing;
    await Promise.all([...this.bridges.values()].map((entry) => entry.bridge.stop()));
    this.bridges.clear();
  }
}
