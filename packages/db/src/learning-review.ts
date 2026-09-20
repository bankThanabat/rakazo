import type { Actor, LearningTaskList } from "@rakazo/contracts";
import {
  LearningTaskDetailSchema,
  LearningTaskListInput,
  LearningTaskPageSchema,
  LearningTaskSchema,
} from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import type { LearningTask, LearningTaskReview, PrismaClient } from "./client.js";
import { requireLearningAccess } from "./learning-access.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { IsolationError } from "./scope.js";

type Owner = Pick<Actor, "userId" | "spaceId">;
export function learningTaskView(task: LearningTask & { reviews: LearningTaskReview[] }) {
  return LearningTaskSchema.parse({
    ...task,
    createdAt: task.createdAt.toISOString(),
    reviews: task.reviews.map((review) => ({
      ...review,
      createdAt: review.createdAt.toISOString(),
    })),
  });
}

/** Lists omit proposal bodies. Only a selected update loads full review text. */
export function createLearningReview(prisma: PrismaClient) {
  return {
    async taskList(actor: Owner, raw: LearningTaskList) {
      const input = LearningTaskListInput.parse(raw);
      return prisma.$transaction(async (tx) => {
        await requirePrivateOwner(tx, actor, input.botId);
        await requireLearningAccess(tx, actor, input.botId);
        const where = {
          ...privateOwner(actor),
          botId: input.botId,
          ...(input.ids ? { id: { in: input.ids } } : {}),
        };
        if (
          input.cursor &&
          !(await tx.learningTask.findFirst({
            where: { AND: [where, { id: input.cursor }] },
            select: { id: true },
          }))
        )
          throw new IsolationError();
        const rows = await tx.learningTask.findMany({
          where,
          take: 11,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            status: true,
            targetKind: true,
            documentId: true,
            appliedRevision: true,
            reviewReason: true,
            error: true,
            createdAt: true,
            proposal: true,
          },
        });
        return LearningTaskPageSchema.parse({
          items: rows.slice(0, 10).map(({ proposal, ...row }) => ({
            ...row,
            title:
              proposal &&
              typeof proposal === "object" &&
              !Array.isArray(proposal) &&
              proposal.save &&
              typeof proposal.save === "object" &&
              !Array.isArray(proposal.save) &&
              typeof proposal.save.title === "string"
                ? proposal.save.title
                : "",
            createdAt: row.createdAt.toISOString(),
          })),
          nextCursor: rows.length > 10 ? rows[9]!.id : null,
        });
      });
    },
    async task(actor: Owner, input: { botId: string; taskId: string }) {
      return prisma.$transaction(async (tx) => {
        await requirePrivateOwner(tx, actor, input.botId);
        const canEditSpace = await requireLearningAccess(tx, actor, input.botId);
        const row = await tx.learningTask.findFirst({
          where: { ...privateOwner(actor), botId: input.botId, id: input.taskId },
          include: { reviews: { orderBy: { createdAt: "desc" }, take: 20 } },
        });
        if (!row) throw new IsolationError();
        const task = learningTaskView({ ...row, reviews: row.reviews.reverse() });
        const proposal = task.proposal;
        if (!proposal)
          return LearningTaskDetailSchema.parse({
            task,
            before: null,
            after: null,
            scope: "bot",
            currentRevision: 0,
            stale: false,
            canEdit: true,
          });
        const native = proposal.native;
        if (native) {
          const parsed = native.kind === "skill" ? parseSkillMd(native.content) : null;
          const title =
            native.kind === "memory"
              ? native.path
              : parsed && !("error" in parsed)
                ? parsed.name
                : proposal.save.title;
          const current =
            native.kind === "memory"
              ? await tx.memoryDocument.findFirst({
                  where: {
                    ...privateOwner(actor),
                    scope: native.scope,
                    botId: native.scope === "bot" ? input.botId : null,
                    path: native.path,
                  },
                  select: { revision: true, id: true },
                })
              : await tx.agentSkill.findFirst({
                  where: {
                    ...privateOwner(actor),
                    ...(native.id
                      ? { id: native.id }
                      : { name: { equals: title, mode: "insensitive" }, removedAt: null }),
                  },
                  select: { revision: true, id: true },
                });
          return LearningTaskDetailSchema.parse({
            task,
            before: { title, content: native.beforeContent, customerVisible: false },
            after: { title, content: native.content, customerVisible: false },
            scope: native.scope === "bot" ? "private-bot" : "private-user",
            currentRevision: current?.revision ?? 0,
            stale:
              (current?.revision ?? 0) !== native.expectedRevision || current?.id !== native.id,
            canEdit: true,
          });
        }
        const save = proposal.save;
        const scopeKey = save.scope === "space" ? "space" : input.botId;
        const current = await tx.learningDocument.findFirst({
          where: { spaceId: actor.spaceId, scopeKey, kind: save.kind, key: save.key },
        });
        const baseline =
          save.expectedRevision === 0 && save.scope === "bot"
            ? await tx.learningDocument.findFirst({
                where: {
                  spaceId: actor.spaceId,
                  scopeKey: "space",
                  kind: save.kind,
                  key: save.key,
                },
              })
            : null;
        const beforeId =
          save.expectedRevision > 0
            ? (task.documentId ?? current?.id)
            : proposal.baseline?.documentId;
        const beforeRevision = save.expectedRevision || proposal.baseline?.revision || 0;
        const before =
          beforeRevision && beforeId
            ? await tx.learningRevision.findFirst({
                where: {
                  documentId: beforeId,
                  revision: beforeRevision,
                  document: { spaceId: actor.spaceId, scopeKey: { in: ["space", input.botId] } },
                },
              })
            : beforeRevision
              ? null
              : { title: "", content: "", customerVisible: false };
        return LearningTaskDetailSchema.parse({
          task,
          before,
          after: save,
          scope: save.scope,
          currentRevision: current?.revision ?? 0,
          stale:
            (current?.revision ?? 0) !== save.expectedRevision ||
            !before ||
            Boolean(
              proposal.baseline &&
                (baseline?.id !== proposal.baseline.documentId ||
                  (baseline?.revision ?? 0) !== proposal.baseline.revision),
            ),
          canEdit: save.scope === "bot" || canEditSpace,
        });
      });
    },
  };
}
