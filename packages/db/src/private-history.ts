import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrivateHistoryTarget } from "@rakazo/contracts";
import {
  PrivateHistoryApplyInput,
  PrivateHistoryInput,
  PrivateHistoryPreviewInput,
  PrivateHistoryVersionInput,
} from "@rakazo/contracts";
import { createAgentSkillStore } from "./agent-skill-audit.js";
import type { PrismaClient } from "./client.js";
import { readableLearningSources } from "./learning-sources.js";
import { createMemoryAudit } from "./memory-audit.js";
import type { PrivateAuditActor } from "./private-audit.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";

/** One review contract for native web/mobile controls. Writes still use the audited stores. */
export function createPrivateHistory(prisma: PrismaClient, reservedSkillNames: readonly string[]) {
  const memory = createMemoryAudit(prisma);
  const skills = createAgentSkillStore(prisma, reservedSkillNames);
  async function version(actor: PrivateAuditActor, raw: unknown) {
    const input = PrivateHistoryVersionInput.parse(raw);
    return input.kind === "memory"
      ? memory.version(actor, { documentId: input.id, revision: input.revision })
      : skills.version(actor, { skillId: input.id, revision: input.revision });
  }
  async function sources(
    actor: PrivateAuditActor,
    target: PrivateHistoryTarget,
    items: Array<{ revision: number; sourceThreadId: string | null }>,
  ) {
    return prisma.$transaction(async (db) => {
      await requirePrivateOwner(db, actor);
      const threads = await db.thread.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          id: { in: items.flatMap((item) => (item.sourceThreadId ? [item.sourceThreadId] : [])) },
        },
        select: { id: true, botId: true, groupId: true },
      });
      const select = {
        revision: true,
        learningTask: { select: { id: true, botId: true, importId: true, conversationId: true } },
      } as const;
      const where = {
        revision: { in: items.map((item) => item.revision) },
        learningTask: { ...privateOwner(actor), bot: { ...privateOwner(actor), archivedAt: null } },
      };
      const revisions =
        target.kind === "memory"
          ? await db.memoryRevision.findMany({
              where: { ...where, documentId: target.id, document: privateOwner(actor) },
              select,
            })
          : await db.agentSkillRevision.findMany({
              where: { ...where, skillId: target.id, skill: privateOwner(actor) },
              select,
            });
      const linked = revisions.flatMap(({ revision, learningTask: task }) => {
        if (!task) return [];
        const ref = task.importId
          ? { kind: "import" as const, id: task.importId }
          : task.conversationId
            ? { kind: "conversation" as const, id: task.conversationId }
            : null;
        return ref ? [{ revision, task, ref }] : [];
      });
      const evidence = await readableLearningSources(
        db,
        actor,
        linked.map(({ ref }) => ref),
      );
      const learning = new Map(
        linked.flatMap(({ revision, task, ref }) =>
          evidence.has(`${ref.kind}:${ref.id}`)
            ? [[revision, { botId: task.botId, taskId: task.id }] as const]
            : [],
        ),
      );
      return { threads, learning };
    });
  }
  return {
    version,
    async history(actor: PrivateAuditActor, raw: unknown) {
      const input = PrivateHistoryInput.parse(raw);
      if (input.kind === "memory") {
        const history = await memory.history(actor, {
          documentId: input.id,
          beforeRevision: input.beforeRevision,
          limit: 10,
        });
        const { threads, learning } = await sources(actor, input, history.items);
        return {
          title: history.document.path,
          scope: history.document.scope,
          botId: history.document.botId,
          revision: history.document.revision,
          removed: false,
          readOnly: false,
          items: history.items.map((item) => ({
            ...item,
            learningSource: learning.get(item.revision) ?? null,
            sourceTarget: threads.find((thread) => thread.id === item.sourceThreadId) ?? null,
            canUndo: item.revision > 1 || item.actor !== "Unknown",
          })),
          nextBeforeRevision: history.nextBeforeRevision,
        };
      }
      const history = await skills.history(actor, {
        skillId: input.id,
        beforeRevision: input.beforeRevision,
        limit: 10,
      });
      const { threads, learning } = await sources(actor, input, history.items);
      return {
        title: history.name,
        scope: "user" as const,
        botId: null,
        revision: history.revision,
        removed: history.removed,
        readOnly: history.readOnly,
        items: history.items.map((item) => ({
          ...item,
          learningSource: learning.get(item.revision) ?? null,
          sourceTarget: threads.find((thread) => thread.id === item.sourceThreadId) ?? null,
          canUndo: !history.readOnly && (item.revision > 1 || item.operation === "create"),
        })),
        nextBeforeRevision: history.nextBeforeRevision,
      };
    },
    async preview(actor: PrivateAuditActor, raw: unknown) {
      const input = PrivateHistoryPreviewInput.parse(raw);
      if (input.action === "restore") {
        const selected = await version(actor, input);
        if (selected.currentRevision !== input.expectedRevision)
          throw new Error("This document changed. Reload history and review again.");
        return { current: selected.current, proposed: selected.after, conflict: false };
      }
      if (input.kind === "memory") {
        const change = await memory.previewUndo(actor, {
          ...input,
          documentId: input.id,
          reason: "Preview undo",
        });
        return {
          current: { content: change.current, removed: false },
          proposed: { content: change.proposed, removed: false },
          conflict: change.conflict,
        };
      }
      const change = await skills.previewUndo(actor, { ...input, skillId: input.id });
      return { current: change.current, proposed: change.proposed, conflict: change.conflict };
    },
    async apply(actor: AdapterContext, raw: unknown) {
      const input = PrivateHistoryApplyInput.parse(raw);
      if (input.kind === "memory") {
        if (input.reviewed.removed) throw new Error("Memory is cleared by editing its text.");
        const request = {
          documentId: input.id,
          revision: input.revision,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          reviewedContent: input.reviewed.content,
          ...(input.resolveConflict ? { resolution: input.reviewed.content } : {}),
        };
        const saved = await (input.action === "undo"
          ? memory.undo(actor, request)
          : memory.restore(actor, request));
        return { content: saved.content, revision: saved.revision, removed: false };
      }
      const request = {
        skillId: input.id,
        revision: input.revision,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        reviewedContent: input.reviewed.content,
        reviewedRemoved: input.reviewed.removed,
        ...(input.resolveConflict ? { resolution: input.reviewed } : {}),
      };
      const saved = await (input.action === "undo"
        ? skills.undo(actor, request)
        : skills.restore(actor, request));
      return {
        content: saved.content,
        revision: saved.revision,
        removed: saved.removedAt !== null,
      };
    },
  };
}
