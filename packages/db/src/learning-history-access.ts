import type { Actor } from "@rakazo/contracts";
import type { LearningHistory, Prisma, PrismaClient } from "./client.js";
import { requireLearningAccess } from "./learning-access.js";
import { IsolationError } from "./scope.js";

export async function requireLearningHistory(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  history: LearningHistory,
  botId: string,
) {
  const canEditSpace = await requireLearningAccess(db, actor, botId);
  if (history.scope === "space" && !canEditSpace) throw new IsolationError();
  if (history.status === "cancelled") throw new IsolationError();
  const userIds = [
    ...new Set([actor.userId, history.connectionOwnerId].filter((id): id is string => !!id)),
  ].sort();
  for (const userId of userIds) {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "user" WHERE id = ${userId} FOR SHARE SKIP LOCKED`;
    if (!rows.length) throw new IsolationError();
  }
  if (await db.accountDeletion.count({ where: { userId: { in: userIds } } }))
    throw new IsolationError();
  if (history.connectionId) {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM connections
      WHERE id = ${history.connectionId} AND "spaceId" = ${actor.spaceId}
        AND "userId" = ${history.connectionOwnerId} AND "providerRef" = ${history.providerRef}
        AND ("userId" = ${actor.userId} OR scope = 'team') AND status = 'connected'
      FOR SHARE`;
    if (!rows.length) throw new IsolationError();
  }
  return { botId, scope: history.scope };
}
