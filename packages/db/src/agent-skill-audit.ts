import type { AgentSkill as SkillView } from "@rakazo/contracts";
import {
  SkillHistoryInput,
  SkillHistorySchema,
  SkillListInput,
  SkillPreviewInput,
  SkillReadVersionInput,
  SkillRemoveInput,
  SkillRestoreInput,
  SkillUndoInput,
} from "@rakazo/contracts";
import { parseSkillMd, previewContentUndo, resolveAgentSkillContent } from "@rakazo/core";
import type { AgentSkill, Prisma, PrismaClient } from "./client.js";
import { rejectNativeLearning } from "./learning-rejection.js";
import type { PrivateAuditActor } from "./private-audit.js";
import {
  privateAuditProvenance,
  privateAuditTransaction,
  privateOwner,
  requirePrivateOwner,
} from "./private-audit.js";
import { IsolationError } from "./scope.js";

type Db = Prisma.TransactionClient;
type Fields = { content?: string; name?: string; description?: string; body?: string };
const version = (row: { content: string; removedAt: Date | null }) => ({
  content: row.content,
  removed: row.removedAt !== null,
});
export function agentSkillView(row: AgentSkill): SkillView {
  const source = row.source === "builtin" || row.source === "plugin" ? row.source : "user";
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: source !== "user",
    revision: row.revision,
    removedAt: row.removedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The only writable user-skill path. Executable text and its audit version commit together. */
export function createAgentSkillStore(
  prisma: PrismaClient | Prisma.TransactionClient,
  reservedNames: readonly string[],
) {
  const transaction = <T>(work: (tx: Db) => Promise<T>) =>
    privateAuditTransaction(prisma, work, true);
  async function owned(db: Db, actor: PrivateAuditActor, skillId: string) {
    await requirePrivateOwner(db, actor);
    const row = await db.agentSkill.findFirst({ where: { ...privateOwner(actor), id: skillId } });
    if (!row) throw new IsolationError();
    return row;
  }
  function writable(row: AgentSkill, expectedRevision: number) {
    if (row.source !== "user") throw new Error("Builtin and plugin skills are read-only.");
    if (row.revision !== expectedRevision)
      throw new Error("This skill changed. Reload before saving.");
  }
  async function persist(
    db: Db,
    actor: PrivateAuditActor,
    existing: AgentSkill | null,
    next: { content: string; removed: boolean },
    reason: string,
    operation: string,
    reversal?: { restoredFrom?: number; undoneRevision?: number },
  ) {
    if (!reason.trim() || reason.length > 1000)
      throw new Error("A skill change reason is required.");
    const parsed = parseSkillMd(next.content);
    if ("error" in parsed || next.content.length > 100000)
      throw new Error("Invalid skill content.");
    const resolved = { name: parsed.name, description: parsed.description, content: next.content };
    const nameChanged =
      !existing || existing.name.trim().toLowerCase() !== resolved.name.toLowerCase();
    if (
      !next.removed &&
      nameChanged &&
      reservedNames.some((name) => name.toLowerCase() === resolved.name.toLowerCase())
    )
      throw new Error("A builtin skill with that name already exists.");
    if (
      !next.removed &&
      (
        await db.agentSkill.findMany({
          where: {
            ...privateOwner(actor),
            removedAt: null,
            ...(existing ? { NOT: { id: existing.id } } : {}),
          },
          select: { name: true },
        })
      ).some((skill) => skill.name.trim().toLowerCase() === resolved.name.toLowerCase())
    )
      throw new Error("A skill with that name already exists.");
    const provenance = await privateAuditProvenance(db, actor);
    if (existing)
      await db.agentSkillRevision.createMany({
        skipDuplicates: true,
        data: {
          skillId: existing.id,
          revision: existing.revision,
          content: existing.content,
          removed: existing.removedAt !== null,
          reason: "Existing skill snapshot",
          operation: "baseline",
          createdAt: existing.updatedAt,
        },
      });
    const data = {
      ...resolved,
      removedAt: next.removed ? new Date() : null,
      revision: (existing?.revision ?? 0) + 1,
    };
    const row = existing
      ? await db.agentSkill.update({ where: { id: existing.id }, data })
      : await db.agentSkill.create({ data: { ...privateOwner(actor), ...data, source: "user" } });
    await db.agentSkillRevision.create({
      data: {
        skillId: row.id,
        revision: row.revision,
        content: row.content,
        removed: next.removed,
        operation,
        reason: reason.trim(),
        ...provenance,
        ...reversal,
      },
    });
    await rejectNativeLearning(db, privateOwner(actor), "skill", row.id, {
      reason,
      removed: next.removed,
      ...reversal,
    });
    return agentSkillView(row);
  }
  async function reversal(db: Db, actor: PrivateAuditActor, raw: unknown) {
    const input = SkillRestoreInput.parse(raw);
    const row = await owned(db, actor, input.skillId);
    writable(row, input.expectedRevision);
    const after = await db.agentSkillRevision.findUnique({
      where: { skillId_revision: { skillId: row.id, revision: input.revision } },
    });
    if (!after) throw new Error("This skill version is unavailable.");
    return { input, row, after };
  }
  async function preview(db: Db, actor: PrivateAuditActor, raw: unknown) {
    const result = await reversal(db, actor, {
      ...SkillPreviewInput.parse(raw),
      reason: "Preview skill undo",
    });
    const { input, row, after } = result;
    const previous =
      input.revision === 1 && after.operation === "create"
        ? { content: after.content, removed: true }
        : await db.agentSkillRevision.findUnique({
            where: { skillId_revision: { skillId: row.id, revision: input.revision - 1 } },
          });
    if (!previous)
      throw new Error(
        "The preceding skill version is unavailable. Restore a known version instead.",
      );
    const before = { content: previous.content, removed: previous.removed };
    const current = version(row);
    const reversed = previewContentUndo(before.content, after.content, current.content);
    const proposed = {
      content: reversed.content,
      removed:
        before.removed !== after.removed && current.removed === after.removed
          ? before.removed
          : current.removed,
    };
    // Undoing creation cannot silently throw away later edits to the created skill.
    const creationConflict =
      after.operation === "create" && current.content !== after.content && !current.removed;
    if (creationConflict) proposed.removed = current.removed;
    return {
      ...result,
      preview: {
        before,
        after: { content: after.content, removed: after.removed },
        current,
        proposed,
        conflict: reversed.conflict || creationConflict,
      },
    };
  }
  function reviewed(
    input: { reviewedContent?: string; reviewedRemoved?: boolean },
    next: { content: string; removed: boolean },
  ) {
    if (
      (input.reviewedContent !== undefined && input.reviewedContent !== next.content) ||
      (input.reviewedRemoved !== undefined && input.reviewedRemoved !== next.removed)
    )
      throw new Error("The reviewed skill text or removal state changed. Preview it again.");
  }
  return {
    async list(actor: PrivateAuditActor) {
      return privateAuditTransaction(prisma, async (db) => {
        await requirePrivateOwner(db, actor);
        return (
          await db.agentSkill.findMany({
            where: { ...privateOwner(actor), removedAt: null },
            orderBy: [{ name: "asc" }, { id: "asc" }],
          })
        ).map(agentSkillView);
      });
    },
    async listHistory(actor: PrivateAuditActor, raw: unknown) {
      const input = SkillListInput.parse(raw);
      return privateAuditTransaction(prisma, async (db) => {
        await requirePrivateOwner(db, actor);
        const where = {
          ...privateOwner(actor),
          ...(input.removedOnly
            ? { removedAt: { not: null } }
            : input.includeRemoved
              ? {}
              : { removedAt: null }),
        };
        if (input.cursor && !(await db.agentSkill.count({ where: { ...where, id: input.cursor } })))
          throw new IsolationError();
        const rows = await db.agentSkill.findMany({
          where,
          orderBy: { id: "asc" },
          take: 11,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: { id: true, name: true, revision: true, removedAt: true },
        });
        return {
          items: rows.slice(0, 10).map((row) => ({
            id: row.id,
            name: row.name,
            revision: row.revision,
            removed: row.removedAt !== null,
          })),
          nextCursor: rows.length > 10 ? rows[9]!.id : null,
        };
      });
    },
    async get(actor: PrivateAuditActor, skillId: string) {
      return privateAuditTransaction(prisma, async (db) => {
        const row = await owned(db, actor, skillId);
        if (row.removedAt) throw new Error("Skill not found.");
        return agentSkillView(row);
      });
    },
    async create(actor: PrivateAuditActor, input: Fields & { reason?: string }) {
      const resolved = resolveAgentSkillContent(input);
      return transaction(async (db) => {
        await requirePrivateOwner(db, actor);
        return persist(
          db,
          actor,
          null,
          { content: resolved.content, removed: false },
          input.reason ?? "Created skill",
          "create",
        );
      });
    },
    async update(
      actor: PrivateAuditActor,
      input: Fields & { skillId: string; expectedRevision: number; reason?: string },
    ) {
      return transaction(async (db) => {
        const row = await owned(db, actor, input.skillId);
        writable(row, input.expectedRevision);
        if (row.removedAt) throw new Error("Restore the skill before editing it.");
        const resolved = resolveAgentSkillContent(input, row);
        return persist(
          db,
          actor,
          row,
          { content: resolved.content, removed: false },
          input.reason ?? "Edited skill",
          "update",
        );
      });
    },
    async remove(actor: PrivateAuditActor, raw: unknown) {
      const input = SkillRemoveInput.parse(raw);
      return transaction(async (db) => {
        const row = await owned(db, actor, input.skillId);
        writable(row, input.expectedRevision);
        if (row.removedAt) throw new Error("This skill is already removed.");
        if (input.reviewedContent !== undefined && input.reviewedContent !== row.content)
          throw new Error("The reviewed skill text changed. Read it again.");
        await persist(
          db,
          actor,
          row,
          { content: row.content, removed: true },
          input.reason,
          "remove",
        );
        return { ok: true as const };
      });
    },
    async history(actor: PrivateAuditActor, raw: unknown) {
      const input = SkillHistoryInput.parse(raw);
      return privateAuditTransaction(prisma, async (db) => {
        const row = await owned(db, actor, input.skillId);
        const rows = await db.agentSkillRevision.findMany({
          where: {
            skillId: row.id,
            ...(input.beforeRevision ? { revision: { lt: input.beforeRevision } } : {}),
          },
          orderBy: { revision: "desc" },
          take: input.limit + 1,
          omit: { content: true },
        });
        const [agents, runs, threads] = await Promise.all([
          db.bot.findMany({
            where: {
              ...privateOwner(actor),
              id: { in: rows.flatMap((item) => (item.agentId ? [item.agentId] : [])) },
            },
            select: { id: true, name: true },
          }),
          db.run.findMany({
            where: {
              ...privateOwner(actor),
              id: { in: rows.flatMap((item) => (item.sourceRunId ? [item.sourceRunId] : [])) },
            },
            select: { id: true },
          }),
          db.thread.findMany({
            where: {
              ...privateOwner(actor),
              id: {
                in: rows.flatMap((item) => (item.sourceThreadId ? [item.sourceThreadId] : [])),
              },
            },
            select: { id: true },
          }),
        ]);
        return SkillHistorySchema.parse({
          readOnly: row.source !== "user",
          skillId: row.id,
          name: row.name,
          revision: row.revision,
          removed: row.removedAt !== null,
          items: rows.slice(0, input.limit).map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
            actor: item.agentId
              ? `Agent · ${agents.find((agent) => agent.id === item.agentId)?.name ?? "Former teammate"}`
              : item.actorKind === "staff"
                ? "Staff"
                : item.actorKind === "agent"
                  ? "Agent"
                  : "Unknown",
            sourceRunId: runs.some((run) => run.id === item.sourceRunId) ? item.sourceRunId : null,
            sourceThreadId: threads.some((thread) => thread.id === item.sourceThreadId)
              ? item.sourceThreadId
              : null,
          })),
          nextBeforeRevision: rows.length > input.limit ? rows[input.limit - 1]!.revision : null,
        });
      });
    },
    async readVersion(actor: PrivateAuditActor, raw: unknown) {
      const input = SkillReadVersionInput.parse(raw);
      return privateAuditTransaction(prisma, async (db) => {
        const row = await owned(db, actor, input.skillId);
        const revision = input.revision ?? row.revision;
        const stored =
          revision === row.revision
            ? { content: row.content, removed: row.removedAt !== null }
            : await db.agentSkillRevision.findUnique({
                where: { skillId_revision: { skillId: row.id, revision } },
              });
        if (!stored) throw new Error("This skill version is unavailable.");
        return {
          skillId: row.id,
          revision,
          removed: stored.removed,
          content: stored.content.slice(input.offset, input.offset + 1000),
          totalCharacters: stored.content.length,
          nextOffset: input.offset + 1000 < stored.content.length ? input.offset + 1000 : null,
        };
      });
    },
    async version(actor: PrivateAuditActor, raw: unknown) {
      const input = SkillReadVersionInput.required({ revision: true }).parse(raw);
      return privateAuditTransaction(prisma, async (db) => {
        const row = await owned(db, actor, input.skillId);
        const after = await db.agentSkillRevision.findUnique({
          where: { skillId_revision: { skillId: row.id, revision: input.revision } },
        });
        if (!after) throw new Error("This skill version is unavailable.");
        const before =
          after.revision === 1 && after.operation === "create"
            ? { content: "", removed: true }
            : await db.agentSkillRevision.findUnique({
                where: { skillId_revision: { skillId: row.id, revision: input.revision - 1 } },
              });
        const value = (item: { content: string; removed: boolean }) => ({
          content: item.content,
          removed: item.removed,
        });
        return {
          currentRevision: row.revision,
          before: before ? value(before) : null,
          after: value(after),
          current: version(row),
        };
      });
    },
    async previewRestore(actor: PrivateAuditActor, raw: unknown) {
      const { after } = await privateAuditTransaction(prisma, (db) => reversal(db, actor, raw));
      return { content: after.content, removed: after.removed };
    },
    async previewUndo(actor: PrivateAuditActor, raw: unknown) {
      return (await privateAuditTransaction(prisma, (db) => preview(db, actor, raw))).preview;
    },
    async undo(actor: PrivateAuditActor, raw: unknown) {
      const input = SkillUndoInput.parse(raw);
      return transaction(async (db) => {
        const { row, preview: change } = await preview(db, actor, input);
        if (change.conflict && !input.resolution)
          throw new Error("Later edits overlap. Review a complete resolution before undoing.");
        const next = input.resolution ?? change.proposed;
        reviewed(input, next);
        return persist(db, actor, row, next, input.reason, "undo", {
          restoredFrom: input.revision - 1,
          undoneRevision: input.revision,
        });
      });
    },
    async restore(actor: PrivateAuditActor, raw: unknown) {
      return transaction(async (db) => {
        const { input, row, after } = await reversal(db, actor, raw);
        const next = { content: after.content, removed: after.removed };
        reviewed(input, next);
        return persist(db, actor, row, next, input.reason, "restore", {
          restoredFrom: input.revision,
        });
      });
    },
  };
}
