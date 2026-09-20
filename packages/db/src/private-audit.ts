import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

export type PrivateAuditActor = Pick<AdapterContext, "spaceId" | "userId" | "botId" | "runId">;
type Owner = Pick<PrivateAuditActor, "spaceId" | "userId">;
type Db = Prisma.TransactionClient;
export const privateOwner = ({ userId, spaceId }: Owner): Owner => ({ userId, spaceId });

export async function requirePrivateOwner(db: Db, owner: Owner, botId?: string) {
  const users = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "user" WHERE id = ${owner.userId} FOR SHARE SKIP LOCKED`;
  const members = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM space_members WHERE "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId} FOR SHARE`;
  if (
    !users.length ||
    !members.length ||
    (await db.accountDeletion.count({ where: { userId: owner.userId } }))
  )
    throw new IsolationError();
  if (botId) {
    const bots = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bots WHERE id = ${botId} AND "spaceId" = ${owner.spaceId}
        AND "userId" = ${owner.userId} AND "archivedAt" IS NULL FOR SHARE SKIP LOCKED`;
    if (!bots.length) throw new IsolationError();
  }
}

export async function privateAuditProvenance(
  tx: Db,
  context: PrivateAuditActor,
  request: { sourceRunId?: string; sourceThreadId?: string } = {},
) {
  const owner = privateOwner(context);
  if (context.botId) await requirePrivateOwner(tx, owner, context.botId);
  const sourceRunId = context.runId ?? request.sourceRunId;
  if (context.runId && request.sourceRunId && context.runId !== request.sourceRunId)
    throw new IsolationError();
  const sourceRun = sourceRunId
    ? await tx.run.findFirst({
        where: { ...privateOwner(owner), id: sourceRunId },
        select: { threadId: true, botId: true },
      })
    : null;
  if (sourceRunId && (!sourceRun || (context.botId && sourceRun.botId !== context.botId)))
    throw new IsolationError();
  const sourceThreadId = sourceRun?.threadId ?? request.sourceThreadId;
  if (sourceRun && request.sourceThreadId && sourceRun.threadId !== request.sourceThreadId)
    throw new IsolationError();
  if (
    sourceThreadId &&
    !(await tx.thread.count({
      where: {
        ...privateOwner(owner),
        id: sourceThreadId,
        ...((context.botId ?? sourceRun?.botId)
          ? { botId: context.botId ?? sourceRun?.botId }
          : {}),
      },
    }))
  )
    throw new IsolationError();

  return {
    sourceRunId,
    sourceThreadId,
    agentId: context.botId ?? sourceRun?.botId,
    actorKind: context.botId || sourceRun ? "agent" : "staff",
  };
}

/** Reuse an enclosing transaction when learning commits its target and audit together. */
export function privateAuditTransaction<T>(
  client: PrismaClient | Prisma.TransactionClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  serializable = false,
): Promise<T> {
  if (!("$transaction" in client)) return work(client);
  return serializable
    ? withTransactionRetry(() => client.$transaction(work, { isolationLevel: "Serializable" }))
    : client.$transaction(work);
}
