import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { requireLearningAccess } from "./learning-access.js";
import { IsolationError } from "./scope.js";

/** The same source fence protects polling, inference and the final document write. */
export async function requireLearningFeed(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  id: string,
) {
  const feed = await db.learningFeed.findFirst({
    where: { id, spaceId: actor.spaceId, userId: actor.userId },
    include: { connection: true },
  });
  if (!feed) throw new IsolationError();
  const canEditSpace = await requireLearningAccess(db, actor, feed.botId);
  if (feed.scope === "space" && !canEditSpace) throw new IsolationError();
  const userIds = [...new Set([actor.userId, feed.connection.userId])].sort();
  for (const userId of userIds) {
    const users = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "user" WHERE id = ${userId} FOR SHARE SKIP LOCKED`;
    if (!users.length) throw new IsolationError();
  }
  if (await db.accountDeletion.count({ where: { userId: { in: userIds } } }))
    throw new IsolationError();
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT feed.id FROM learning_feeds feed JOIN connections account ON account.id = feed."connectionId"
    WHERE feed.id = ${id} AND feed.enabled
      AND account."spaceId" = ${actor.spaceId} AND account."userId" = ${feed.connection.userId}
      AND (account."userId" = ${actor.userId} OR account.scope = 'team')
      AND account.status = 'connected' AND account."connectorId" = 'open-connector'
      AND account."providerRef" = feed."providerRef"
    FOR SHARE OF feed, account`;
  if (!rows.length) throw new IsolationError();
  return feed;
}
