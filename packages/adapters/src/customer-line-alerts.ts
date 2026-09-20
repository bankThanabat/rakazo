import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NotificationProvider } from "@rakazo/adapter-kit";
import { NotificationDeliveryError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  CustomerAlertLineDisableInput,
  CustomerAlertLineTestInput,
  CustomerAlertLineVerifyInput,
} from "@rakazo/contracts";
import type { CustomerAlertDestination, Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { z } from "zod";
import type { createCustomerConnector } from "./customer-connector.js";
import { customerDeliveryId } from "./customer-mapping.js";

type Caller = Pick<Actor, "userId" | "spaceId">;
const scope = (actor: Caller) => ({ spaceId: actor.spaceId, userId: actor.userId });
const activeKey = (actor: Caller) => JSON.stringify([actor.spaceId, actor.userId]);
const digest = (code: string) => createHash("sha256").update(code).digest("hex");
const botInfo = z.object({ userId: z.string().min(1).max(128) });
const receipt = z.object({ sentMessages: z.array(z.object({ id: z.string().min(1) })).min(1) });
const view = (row: CustomerAlertDestination | null) =>
  row && {
    id: row.id,
    connectionId: row.connectionId,
    recipient: { kind: row.kind, recipientId: row.recipientId },
    status:
      row.status === "testing" && row.createdAt.getTime() + 30000 < Date.now()
        ? "uncertain"
        : row.status,
    expiresAt: row.expiresAt,
    verifiedAt: row.verifiedAt,
  };

/** Staff-only configuration. It neither creates nor reads customer channel bindings. */
export function createCustomerLineAlerts(deps: {
  prisma: PrismaClient;
  connector: ReturnType<typeof createCustomerConnector>;
  webOrigin?: string;
}) {
  const { prisma, connector } = deps;
  function link(spaceId: string, conversationId: string) {
    const base = new URL(deps.webOrigin ?? "");
    if (
      base.username ||
      base.password ||
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
    )
      throw new Error("Configure the public Deskazo HTTPS origin before enabling LINE alerts");
    const url = new URL("/app", base.origin);
    url.searchParams.set("space", spaceId);
    url.searchParams.set("customer", conversationId);
    return url.toString();
  }
  async function staff(tx: Prisma.TransactionClient, actor: Caller, botId?: string) {
    // Deletion locks this row before recording its tombstone. Dispatch already holds
    // case locks in another transaction, so never wait here and invert that order.
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "user" WHERE id = ${actor.userId} FOR SHARE SKIP LOCKED`;
    if (!users.length)
      throw new NotificationDeliveryError("The staff account is unavailable", "rejected", true);
    const members = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT member.id FROM space_members member
      WHERE member."spaceId" = ${actor.spaceId} AND member."userId" = ${actor.userId}
        AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE "userId" = ${actor.userId})
      FOR SHARE OF member`;
    if (!members.length) throw new IsolationError();
    if (botId) {
      const bots = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM bots WHERE id = ${botId} AND "spaceId" = ${actor.spaceId}
          AND "userId" = ${actor.userId} AND "archivedAt" IS NULL FOR SHARE`;
      if (!bots.length) throw new IsolationError();
    }
  }
  async function account(
    tx: Prisma.TransactionClient,
    actor: Caller,
    connectionId: string | null,
    providerRef: string,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM connections WHERE id = ${connectionId} AND "spaceId" = ${actor.spaceId}
        AND ("userId" = ${actor.userId} OR scope = 'team') AND status = 'connected'
        AND "connectorId" = 'open-connector' AND provider = 'line' AND "providerRef" = ${providerRef}
      FOR SHARE`;
    if (!rows.length)
      throw new NotificationDeliveryError("The verified LINE account is unavailable", "rejected");
  }
  async function serialize(tx: Prisma.TransactionClient, actor: Caller) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('staff-line-alert'), hashtext(${activeKey(actor)}))`;
  }
  async function readBot(
    actor: Caller,
    connectionId: string,
    providerRef: string,
    signal?: AbortSignal,
  ) {
    const result = await connector.execute(
      actor,
      connectionId,
      "line.get_bot_info",
      {},
      `staff.line.read:${randomUUID()}`,
      "staff",
      "read",
      providerRef,
      signal,
    );
    return botInfo.parse(result).userId;
  }
  async function push(
    row: CustomerAlertDestination,
    text: string,
    operationId: string,
    signal: AbortSignal,
  ) {
    let identity: string;
    try {
      identity = await readBot(row, row.connectionId!, row.providerRef, signal);
    } catch {
      throw new NotificationDeliveryError(
        "The LINE account could not be verified",
        "rejected",
        true,
      );
    }
    if (identity !== row.botAccountId)
      throw new NotificationDeliveryError(
        "The linked LINE account changed; verify a new destination",
        "rejected",
      );
    const result = await connector.execute(
      row,
      row.connectionId!,
      "line.send_push_text",
      {
        to: row.recipientId,
        texts: [text],
        retryKey: customerDeliveryId(operationId, 0),
      },
      operationId,
      "staff",
      "write",
      row.providerRef,
      signal,
    );
    return receipt.parse(result).sentMessages[0]!.id;
  }
  async function owned(tx: Prisma.TransactionClient, actor: Caller, id: string) {
    const rows = await tx.$queryRaw<CustomerAlertDestination[]>`
      SELECT * FROM customer_alert_destinations WHERE id = ${id}
        AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`;
    if (!rows[0]) throw new IsolationError();
    return rows[0];
  }
  return {
    async inspect(actor: Caller, botId: string) {
      return prisma.$transaction(async (tx) => {
        await staff(tx, actor, botId);
        return view(
          await tx.customerAlertDestination.findUnique({ where: { activeKey: activeKey(actor) } }),
        );
      });
    },
    async test(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerAlertLineTestInput.parse(raw);
      link(actor.spaceId, "setup"); // Reject a missing or unsafe application origin before any send.
      const code = randomBytes(6).toString("hex");
      const reservation = await prisma.$transaction(
        async (tx) => {
          await staff(tx, actor, botId);
          await serialize(tx, actor);
          const prior = await tx.customerAlertDestination.findUnique({
            where: { spaceId_userId_nonce: { ...scope(actor), nonce: input.nonce } },
          });
          if (prior) {
            if (
              prior.connectionId !== input.connectionId ||
              prior.kind !== input.recipient.kind ||
              prior.recipientId !== input.recipient.recipientId
            )
              throw new Error("This test nonce already belongs to another destination");
            return { row: prior, send: false };
          }
          const current = await tx.customerAlertDestination.findUnique({
            where: { activeKey: activeKey(actor) },
          });
          if ((current?.id ?? null) !== input.expectedId)
            throw new Error("Inspect the current LINE destination before replacing it");
          const latest = await tx.customerAlertDestination.findFirst({
            where: scope(actor),
            orderBy: { createdAt: "desc" },
          });
          if (latest && latest.createdAt.getTime() + 60000 > Date.now())
            throw new Error("Wait one minute before another test alert");
          const connection = await connector.connection(actor, input.connectionId);
          await account(tx, actor, connection.id, connection.providerRef!);
          await connector.validateWorkflow(actor, connection.id, [
            { action: "line.get_bot_info", effect: "read" },
            { action: "line.send_push_text", effect: "write" },
          ]);
          const botAccountId = await readBot(
            actor,
            connection.id,
            connection.providerRef!,
            AbortSignal.timeout(10000),
          );
          if (current)
            await tx.customerAlertDestination.update({
              where: { id: current.id },
              data: { activeKey: null, status: "disabled", codeHash: null },
            });
          const row = await tx.customerAlertDestination.create({
            data: {
              ...scope(actor),
              id: randomUUID(),
              connectionId: connection.id,
              providerRef: connection.providerRef!,
              botAccountId,
              recipientId: input.recipient.recipientId,
              kind: input.recipient.kind,
              nonce: input.nonce,
              activeKey: activeKey(actor),
              codeHash: digest(code),
              expiresAt: new Date(Date.now() + 10 * 60000),
            },
          });
          return { row, send: true };
        },
        { timeout: 15000 },
      );
      if (!reservation.send) return view(reservation.row);
      try {
        await prisma.$transaction(
          async (tx) => {
            await staff(tx, actor, botId);
            await account(tx, actor, reservation.row.connectionId, reservation.row.providerRef);
            const row = await owned(tx, actor, reservation.row.id);
            if (row.status !== "testing" || row.activeKey !== activeKey(actor)) return;
            await push(
              row,
              `Deskazo staff alert test.\nVerification code: ${code}\nConfirm this code in Deskazo only if this is your account or a private staff group.`,
              `staff.line.test:${row.id}`,
              AbortSignal.timeout(10000),
            );
            await tx.customerAlertDestination.update({
              where: { id: row.id },
              data: { status: "awaiting_confirmation" },
            });
          },
          { timeout: 15000 },
        );
      } catch (error) {
        const rejected = error instanceof NotificationDeliveryError && error.outcome === "rejected";
        await prisma.customerAlertDestination.updateMany({
          where: { id: reservation.row.id, status: "testing" },
          data: {
            status: rejected ? "failed" : "uncertain",
            ...(rejected ? { codeHash: null } : {}),
          },
        });
      }
      return view(
        await prisma.customerAlertDestination.findFirst({
          where: { id: reservation.row.id, ...scope(actor) },
        }),
      );
    },
    async verify(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerAlertLineVerifyInput.parse(raw);
      const result = await prisma.$transaction(
        async (tx) => {
          await staff(tx, actor, botId);
          await serialize(tx, actor);
          const pending = await tx.customerAlertDestination.findFirst({
            where: { id: input.id, ...scope(actor) },
          });
          if (!pending) throw new IsolationError();
          await account(tx, actor, pending.connectionId, pending.providerRef);
          const row = await owned(tx, actor, input.id);
          if (
            row.activeKey !== activeKey(actor) ||
            row.connectionId !== input.connectionId ||
            row.recipientId !== input.recipient.recipientId ||
            row.kind !== input.recipient.kind
          )
            throw new Error("The LINE destination changed; inspect it again");
          if (row.status === "verified") return { row };
          if (!row.codeHash || row.expiresAt <= new Date() || row.failedVerifications >= 5)
            throw new Error("The test has expired or is unavailable; send a new approved test");
          if (
            !timingSafeEqual(
              Buffer.from(row.codeHash, "hex"),
              Buffer.from(digest(input.code), "hex"),
            )
          ) {
            await tx.customerAlertDestination.update({
              where: { id: row.id },
              data: {
                failedVerifications: { increment: 1 },
                ...(row.failedVerifications >= 4 ? { codeHash: null, status: "failed" } : {}),
              },
            });
            return { error: "The verification code does not match" };
          }
          if (
            (await readBot(
              actor,
              row.connectionId!,
              row.providerRef,
              AbortSignal.timeout(10000),
            )) !== row.botAccountId
          )
            throw new Error("The linked LINE account changed; verify a new destination");
          return {
            row: await tx.customerAlertDestination.update({
              where: { id: row.id },
              data: { status: "verified", verifiedAt: new Date(), codeHash: null },
            }),
          };
        },
        { timeout: 15000 },
      );
      if (result.error) throw new Error(result.error);
      return view(result.row!);
    },
    async disable(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerAlertLineDisableInput.parse(raw);
      return prisma.$transaction(async (tx) => {
        await staff(tx, actor, botId);
        await serialize(tx, actor);
        await owned(tx, actor, input.id);
        return view(
          await tx.customerAlertDestination.update({
            where: { id: input.id },
            data: { activeKey: null, status: "disabled", codeHash: null },
          }),
        );
      });
    },
    async providers(actor: Caller): Promise<NotificationProvider[]> {
      const row = await prisma.customerAlertDestination.findUnique({
        where: { activeKey: activeKey(actor) },
      });
      if (row?.status !== "verified") return [];
      return [
        {
          describe: () => ({
            id: `line:${row.id}`,
            adapterVersion: "1",
            contractVersion: "1",
            capabilities: { push: true, email: false },
          }),
          async send(message, context) {
            if (
              context.userId !== row.userId ||
              context.spaceId !== row.spaceId ||
              !message.customerConversationId
            )
              throw new NotificationDeliveryError("The alert recipient changed", "rejected");
            const text = `Customer needs attention.\n${link(row.spaceId, message.customerConversationId)}`;
            return prisma.$transaction(
              async (tx) => {
                await staff(tx, actor);
                await account(tx, actor, row.connectionId, row.providerRef);
                const current = await owned(tx, actor, row.id);
                if (current.status !== "verified" || current.activeKey !== activeKey(actor))
                  throw new NotificationDeliveryError(
                    "The LINE destination was disabled",
                    "rejected",
                  );
                const reference = await push(current, text, context.operationId, context.signal);
                return { status: "accepted", reference } as const;
              },
              { timeout: 15000 },
            );
          },
        },
      ];
    },
  };
}
