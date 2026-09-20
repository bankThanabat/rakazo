import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { CustomerIdentityInput, CustomerIdentitySetInput } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import {
  connectionAccessWhere,
  IsolationError,
  invalidateCustomerConversations,
  Prisma,
} from "@rakazo/db";
import type { createCustomerConnector } from "./customer-connector.js";
import { customerField } from "./customer-mapping.js";

/** Linked IDs are typed provider facts. A channel participant ID is a separate namespace. */
export async function currentCustomerIdentity(
  prisma: PrismaClient,
  scope: { conversationId: string; customerId: string; connectionId: string },
) {
  const row = await prisma.customerIdentity.findUnique({
    where: { conversationId_customerId_connectionId: scope },
    include: { connection: { select: { status: true, providerRef: true } } },
  });
  if (
    !row ||
    row.value === null ||
    row.connection.status !== "connected" ||
    row.connection.providerRef !== row.providerRef
  )
    return null;
  return { id: row.id, revision: row.revision, value: row.value, providerRef: row.providerRef };
}

export function customerIdentityReview(
  prisma: PrismaClient,
  connector: ReturnType<typeof createCustomerConnector>,
) {
  type Scope = { conversationId: string; customerId: string; connectionId: string };
  const channel = (actor: Pick<Actor, "userId" | "spaceId">, botId: string) => ({
    userId: actor.userId,
    spaceId: actor.spaceId,
    botId,
    bot: { archivedAt: null },
  });
  async function authorize(actor: Pick<Actor, "userId" | "spaceId">, botId: string, input: Scope) {
    if (
      !(await prisma.spaceMember.count({
        where: { userId: actor.userId, spaceId: actor.spaceId },
      })) ||
      !(await prisma.customerConversation.count({
        where: {
          id: input.conversationId,
          channel: channel(actor, botId),
          messages: { some: { role: "customer", senderId: input.customerId } },
        },
      }))
    )
      throw new IsolationError();
  }
  return {
    async inspect(actor: Pick<Actor, "userId" | "spaceId">, botId: string, raw: unknown) {
      const input = CustomerIdentityInput.parse(raw);
      await authorize(actor, botId, input);
      if (
        !(await prisma.connection.count({
          where: { id: input.connectionId, ...connectionAccessWhere(actor) },
        }))
      )
        throw new IsolationError();
      const row = await prisma.customerIdentity.findUnique({
        where: { conversationId_customerId_connectionId: input },
      });
      return {
        revision: row?.revision ?? 0,
        value: row?.value ?? null,
        active: Boolean(await currentCustomerIdentity(prisma, input)),
        history: row?.history ?? [],
      };
    },
    async set(actor: Pick<Actor, "userId" | "spaceId">, botId: string, raw: unknown) {
      const input = CustomerIdentitySetInput.parse(raw);
      const scope = CustomerIdentityInput.parse({
        conversationId: input.conversationId,
        customerId: input.customerId,
        connectionId: input.connectionId,
      });
      await authorize(actor, botId, scope);
      const connection = input.identity
        ? await connector.connection(actor, input.connectionId)
        : await prisma.connection.findFirst({
            where: {
              id: input.connectionId,
              connectorId: "open-connector",
              ...connectionAccessWhere(actor),
            },
          });
      if (!connection) throw new IsolationError();
      if (input.identity) {
        const observed = await connector.execute(
          actor,
          connection.id,
          input.identity.action,
          input.identity.input,
          `customer.identity:${randomUUID()}`,
          "staff",
          "read",
          connection.providerRef!,
        );
        if (customerField(observed, input.identity.path) !== input.identity.value)
          throw new Error("The provider did not return the selected customer identity");
      }
      return prisma.$transaction(async (tx) => {
        // Hold the case, account and membership stable through invalidation and binding.
        const authorized = await tx.$queryRaw<Array<{ id: string; leaseUntil: Date | null }>>`
          SELECT conversation.id, conversation."leaseUntil" FROM customer_conversations conversation
          JOIN customer_channels channel ON channel.id = conversation."channelId"
          JOIN space_members member ON member."spaceId" = channel."spaceId" AND member."userId" = ${actor.userId}
          JOIN connections account ON account.id = ${input.connectionId}
          JOIN bots bot ON bot.id = channel."botId"
          WHERE conversation.id = ${input.conversationId} AND channel."spaceId" = ${actor.spaceId}
            AND channel."userId" = ${actor.userId} AND channel."botId" = ${botId} AND bot."archivedAt" IS NULL
            AND account."spaceId" = ${actor.spaceId} AND (account."userId" = ${actor.userId} OR account.scope = 'team')
            AND (${input.identity === null} OR account.status = 'connected')
            AND account."providerRef" IS NOT DISTINCT FROM ${connection.providerRef}
            AND account."connectorId" = 'open-connector'
            AND EXISTS (SELECT 1 FROM customer_messages message WHERE message."conversationId" = conversation.id
              AND message.role = 'customer' AND message."senderId" = ${input.customerId})
          FOR UPDATE OF conversation FOR SHARE OF account, channel, member, bot`;
        if (!authorized.length) throw new IsolationError();
        const prior = await tx.customerIdentity.findUnique({
          where: { conversationId_customerId_connectionId: scope },
        });
        if ((prior?.revision ?? 0) !== input.expectedRevision)
          throw new Error("Customer identity changed; inspect it again");
        const history = Array.isArray(prior?.history) ? prior.history : [];
        if (history.length >= (input.identity ? 31 : 32))
          throw new Error(
            "Customer identity review limit reached; use staff handling for this case",
          );
        const value = input.identity?.value ?? null;
        const revision = input.expectedRevision + 1;
        const data = {
          providerRef: connection.providerRef ?? "",
          value: value ?? Prisma.JsonNull,
          revision,
          history: [
            ...history,
            {
              revision,
              value,
              reason: input.reason,
              userId: actor.userId,
              action: input.identity?.action ?? null,
              verification: input.identity
                ? {
                    path: input.identity.path,
                    inputHash: createHash("sha256")
                      .update(stableJsonValue(input.identity.input))
                      .digest("hex"),
                    accountHash: createHash("sha256").update(connection.providerRef!).digest("hex"),
                  }
                : null,
              at: new Date().toISOString(),
            },
          ],
        };
        const inFlight = await tx.customerMessage.count({
          where: {
            conversationId: input.conversationId,
            status: { in: ["processing", "sending"] },
          },
        });
        await tx.customerIdentity.upsert({
          where: { conversationId_customerId_connectionId: scope },
          create: { ...scope, ...data },
          update: data,
        });
        await invalidateCustomerConversations(tx, { id: input.conversationId }, "staff");
        return {
          revision,
          value,
          paused: true,
          inFlight: inFlight > 0 || authorized[0]!.leaseUntil !== null,
        };
      });
    },
  };
}
