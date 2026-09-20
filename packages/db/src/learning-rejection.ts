import type { Prisma, PrismaClient } from "./client.js";

export class LearningRejectedError extends Error {
  constructor(readonly reviewRequired = false) {
    super(
      reviewRequired
        ? "Related guidance was rejected. Staff review required."
        : "Previously rejected or undone guidance",
    );
  }
}

/** Shared by proposal generation and the transaction that commits automatic learning. */
export async function checkLearningRejection(
  db: PrismaClient | Prisma.TransactionClient,
  task: {
    spaceId: string;
    userId: string;
    botId: string;
    targetKind?: string;
    inferenceKey: string | null;
    correctionKey: string | null;
    rejectionOverride: boolean;
  },
  scope: "space" | "bot",
  nativeScope?: "bot" | "user",
) {
  if (task.rejectionOverride) return;
  const where = {
    spaceId: task.spaceId,
    targetKind: task.targetKind ?? "document",
    ...(nativeScope
      ? { userId: task.userId, ...(nativeScope === "bot" ? { botId: task.botId } : {}) }
      : scope === "space"
        ? { proposal: { path: ["save", "scope"], equals: "space" } }
        : { botId: task.botId }),
    rejectedAt: { not: null },
  };
  if (
    task.inferenceKey &&
    (await db.learningTask.findFirst({
      where: { ...where, inferenceKey: task.inferenceKey },
      select: { id: true },
    }))
  )
    throw new LearningRejectedError();
  if (
    task.correctionKey &&
    (await db.learningTask.findFirst({
      where: { ...where, correctionKey: task.correctionKey },
      select: { id: true },
    }))
  )
    throw new LearningRejectedError(true);
}

/** A native reversal also rejects the inference, without replaying any external actions. */
export async function rejectNativeLearning(
  tx: Prisma.TransactionClient,
  owner: { spaceId: string; userId: string },
  targetKind: "memory" | "skill",
  documentId: string,
  input: { reason: string; undoneRevision?: number; restoredFrom?: number; removed?: boolean },
) {
  if (!input.removed && input.undoneRevision === undefined && input.restoredFrom === undefined)
    return;
  const tasks = await tx.learningTask.findMany({
    where: {
      ...owner,
      targetKind,
      documentId,
      status: "applied",
      ...(input.removed
        ? {}
        : input.undoneRevision !== undefined
          ? { appliedRevision: input.undoneRevision }
          : { appliedRevision: { gt: input.restoredFrom! } }),
    },
    select: { id: true },
  });
  if (!tasks.length) return;
  await tx.learningTask.updateMany({
    where: { id: { in: tasks.map((task) => task.id) } },
    data: {
      status: "rejected",
      rejectedAt: new Date(),
      reviewedByUserId: owner.userId,
      reviewReason: input.reason,
      summarizedAt: null,
    },
  });
  await tx.learningTaskReview.createMany({
    data: tasks.map((task) => ({
      taskId: task.id,
      userId: owner.userId,
      decision: input.removed ? "remove" : input.undoneRevision !== undefined ? "undo" : "restore",
      reason: input.reason,
    })),
  });
}
