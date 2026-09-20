import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

type Scope = Pick<Actor, "spaceId" | "userId">;
type Db = PrismaClient | Prisma.TransactionClient;
export async function requireLearningAccess(db: Db, actor: Scope, botId: string) {
  const member = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  const bot =
    member &&
    (await db.bot.findFirst({
      where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
    }));
  if (!bot) throw new IsolationError();
  const space = await db.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
  return (
    member.role === "owner" || member.role === "admin" || space.createdByUserId === actor.userId
  );
}
