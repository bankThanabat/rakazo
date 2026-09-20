import type { Actor, LearningTaskProposal, NativeLearningChange } from "@rakazo/contracts";
import { NativeLearningChangeSchema } from "@rakazo/contracts";
import { parseSkillMd, resolveAgentSkillContent } from "@rakazo/core";
import { createAgentSkillStore } from "./agent-skill-audit.js";
import type { Prisma, PrismaClient } from "./client.js";
import { commitMemory } from "./memory-audit.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { IsolationError } from "./scope.js";

type Owner = Pick<Actor, "spaceId" | "userId">;
const MEMORY_PATH = "customer-learning.md";
const SKILL_NAME = "Customer handling";

/** Page only owned target metadata; source text stays outside the shared inference prompt. */
export async function nativeLearningTargets(
  prisma: PrismaClient,
  actor: Owner,
  input: { botId: string; kind: "memory" | "skill"; scope: "space" | "bot"; cursor?: string },
) {
  return prisma.$transaction(async (tx) => {
    await requirePrivateOwner(tx, actor, input.botId);
    const page = {
      take: 51,
      orderBy: { id: "asc" as const },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    };
    const rows =
      input.kind === "memory"
        ? (
            await tx.memoryDocument.findMany({
              ...page,
              where: {
                ...privateOwner(actor),
                scope: input.scope === "bot" ? "bot" : "user",
                botId: input.scope === "bot" ? input.botId : null,
              },
              select: { id: true, path: true },
            })
          ).map((row) => ({ id: row.id, name: row.path, description: "" }))
        : await tx.agentSkill.findMany({
            ...page,
            where: { ...privateOwner(actor), removedAt: null, source: "user" },
            select: { id: true, name: true, description: true },
          });
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.id : undefined };
  });
}

/** Private baselines never enter the inference model's shared-document prompt. */
export async function prepareNativeLearning(
  prisma: PrismaClient,
  actor: Owner,
  input: {
    botId: string;
    kind: "memory" | "skill";
    scope: "space" | "bot";
    addition: string;
    conditions: string;
    targetId?: string;
  },
): Promise<NativeLearningChange> {
  return prisma.$transaction(async (tx) => {
    await requirePrivateOwner(tx, actor, input.botId);
    const addition = `Applies when: ${input.conditions}\n\n${input.addition}`;
    if (input.kind === "memory") {
      const scope = input.scope === "space" ? "user" : "bot";
      const row = await tx.memoryDocument.findFirst({
        where: {
          ...privateOwner(actor),
          scope,
          botId: scope === "bot" ? input.botId : null,
          ...(input.targetId ? { id: input.targetId } : { path: MEMORY_PATH }),
        },
      });
      if (input.targetId && !row) throw new IsolationError();
      return NativeLearningChangeSchema.parse({
        kind: "memory",
        scope,
        path: row?.path ?? MEMORY_PATH,
        id: row?.id,
        expectedRevision: row?.revision ?? 0,
        beforeContent: row?.content ?? "",
        content: [row?.content, addition].filter(Boolean).join("\n\n"),
      });
    }
    const row = await tx.agentSkill.findFirst({
      where: {
        ...privateOwner(actor),
        removedAt: null,
        ...(input.targetId
          ? { id: input.targetId }
          : { name: { equals: SKILL_NAME, mode: "insensitive" } }),
      },
    });
    if (input.targetId && !row) throw new IsolationError();
    if (row && row.source !== "user") throw new Error("This skill is read-only.");
    const parsed = row ? parseSkillMd(row.content) : undefined;
    if (parsed && "error" in parsed)
      throw new Error("Review the existing skill before adding learning.");
    const body = [parsed && !("error" in parsed) ? parsed.body : undefined, addition]
      .filter(Boolean)
      .join("\n\n");
    const next = resolveAgentSkillContent(
      row
        ? { body }
        : { name: SKILL_NAME, description: "Reviewed staff procedures for customer cases.", body },
      row ?? undefined,
    );
    return NativeLearningChangeSchema.parse({
      kind: "skill",
      scope: "user",
      id: row?.id,
      expectedRevision: row?.revision ?? 0,
      beforeContent: row?.content ?? "",
      content: next.content,
    });
  });
}

/** The caller holds the learning task lock and commits its decision in this same transaction. */
export async function applyNativeLearning(
  tx: Prisma.TransactionClient,
  actor: Owner,
  task: { id: string; botId: string },
  proposal: LearningTaskProposal,
  reason: string,
  automatic = false,
) {
  const change = NativeLearningChangeSchema.parse(proposal.native);
  if (change.kind !== proposal.save.kind) throw new Error("The learning destination changed.");
  await requirePrivateOwner(tx, actor, task.botId);
  const context = {
    ...privateOwner(actor),
    ...(automatic ? { botId: task.botId } : {}),
    operationId: `learning:${task.id}`,
    traceId: task.id,
    signal: new AbortController().signal,
  };
  if (change.kind === "memory") {
    const current = await tx.memoryDocument.findFirst({
      where: {
        ...privateOwner(actor),
        scope: change.scope,
        botId: change.scope === "bot" ? task.botId : null,
        path: change.path,
      },
    });
    if (current?.id !== change.id || (current?.content ?? "") !== change.beforeContent)
      throw new Error("This memory changed. Regenerate the learning proposal.");
    const saved = await commitMemory(
      tx,
      {
        scope: change.scope,
        botId: change.scope === "bot" ? task.botId : undefined,
        path: change.path,
        content: change.content,
        expectedRevision: change.expectedRevision,
        reason,
      },
      context,
    );
    await tx.memoryRevision.update({
      where: { documentId_revision: { documentId: saved.id, revision: saved.revision } },
      data: { learningTaskId: task.id },
    });
    return { id: saved.id, revision: saved.revision, targetKind: "memory" as const };
  }
  const store = createAgentSkillStore(tx, []);
  const current = change.id ? await store.get(context, change.id) : undefined;
  if (
    (current?.content ?? "") !== change.beforeContent ||
    (!change.id && change.expectedRevision !== 0)
  )
    throw new Error("This skill changed. Regenerate the learning proposal.");
  if (change.id && !current) throw new IsolationError();
  const saved = change.id
    ? await store.update(context, {
        skillId: change.id,
        expectedRevision: change.expectedRevision,
        content: change.content,
        reason,
      })
    : await store.create(context, { content: change.content, reason });
  if (saved.content !== change.content)
    throw new Error("The reviewed skill text changed. Regenerate the proposal.");
  await tx.agentSkillRevision.update({
    where: { skillId_revision: { skillId: saved.id, revision: saved.revision } },
    data: { learningTaskId: task.id },
  });
  return { id: saved.id, revision: saved.revision, targetKind: "skill" as const };
}
