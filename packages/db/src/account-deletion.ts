import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { invalidateCustomerConversations } from "./customer-inbox.js";
import { IsolationError } from "./scope.js";

/** Called only after authentication and deletion-password verification. No external effects. */
export async function requestAccountDeletion(prisma: PrismaClient, userId: string) {
  await prisma.$transaction(async (tx) => {
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE
    `;
    if (!users.length) throw new IsolationError();
    await tx.accountDeletion.upsert({ where: { userId }, create: { userId }, update: {} });
    await claimAccountOrganizations(tx, userId);
    await tx.session.deleteMany({ where: { userId } });
    await tx.bot.updateMany({ where: { userId }, data: { archivedAt: new Date() } });
    await tx.cloudAgent.updateMany({
      where: { userId, status: "running" },
      data: { cancelRequested: true, version: { increment: 1 }, nextPollAt: new Date() },
    });
    const runs = await tx.run.findMany({
      where: { userId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true, taskId: true },
    });
    await cancelRunsInTransaction(tx, runs, new Date());
    await tx.routine.updateMany({ where: { userId }, data: { active: false } });
    await tx.customerChannel.updateMany({ where: { userId }, data: { enabled: false } });
    await invalidateCustomerConversations(tx, { channel: { userId } }, "staff");
    await tx.gatewayRuntime.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
  });
}

/** Recheck while holding organization locks, including when another member has left. */
export async function claimAccountOrganizations(tx: Prisma.TransactionClient, userId: string) {
  // Lock the organization before checking its members. New members cannot join
  // an organization claimed for deletion (enforced by the membership trigger).
  const organizations = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT o.id FROM organization o JOIN member m ON m."organizationId" = o.id
    WHERE m."userId" = ${userId} ORDER BY o.id FOR UPDATE OF o
  `;
  for (const { id } of organizations) {
    if (await tx.member.count({ where: { organizationId: id, userId: { not: userId } } })) continue;
    await tx.accountDeletionResource.createMany({
      data: [{ userId, kind: "organization", spaceId: "", key: id }],
      skipDuplicates: true,
    });
    await tx.space.updateMany({
      where: { organizationId: id },
      data: { deletingAt: new Date() },
    });
  }
}
