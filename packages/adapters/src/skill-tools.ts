import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  SkillHistoryInput,
  SkillListInput,
  SkillPreviewToolInput,
  SkillReadToolInput,
  SkillReadVersionInput,
  SkillRemoveToolInput,
  SkillRestoreToolInput,
  SkillUndoToolInput,
  SkillWriteToolInput,
} from "@rakazo/contracts";
import { findSkillByName, mergeBuiltinSkills, resolveAgentSkillContent } from "@rakazo/core";
import type { PrismaClient, PrivateAuditActor } from "@rakazo/db";
import { createAgentSkillStore } from "@rakazo/db";
import { z } from "zod";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";

export const SKILL_MUTATION_TOOLS = new Set([
  "skill_create",
  "skill_update",
  "skill_delete",
  "skill_undo",
  "skill_restore",
]);
const writeSchema = (create: boolean) =>
  SkillWriteToolInput.extend({
    skillId: create ? z.never().optional() : z.string().min(1),
    expectedRevision: create ? z.literal(0) : z.number().int().positive(),
  });
export function parseSkillMutation(name: string, args: unknown): Record<string, unknown> {
  if (name === "skill_create" || name === "skill_update") {
    const input = writeSchema(name === "skill_create").parse(args);
    return { ...input, content: resolveAgentSkillContent({ content: input.content }).content };
  }
  return (
    name === "skill_delete"
      ? SkillRemoveToolInput
      : name === "skill_undo"
        ? SkillUndoToolInput
        : SkillRestoreToolInput
  ).parse(args);
}
export const skillTools: ConnectorTool[] = [
  {
    name: "skill_read",
    readOnly: true,
    description:
      "Read a private SKILL.md by ID or exact catalog name, 1000 characters at a time. Read all chunks before following instructions or editing. Pass the returned revision and nextOffset for subsequent chunks of the same version.",
    inputSchema: z.toJSONSchema(SkillReadToolInput),
  },
  {
    name: "skill_documents",
    readOnly: true,
    description:
      "List 10 private skill IDs and revisions, optionally including removed skills. Pass nextCursor to continue.",
    inputSchema: z.toJSONSchema(SkillListInput),
  },
  {
    name: "skill_history",
    readOnly: true,
    description:
      "Inspect 3 private skill audit versions, actors, reasons and accessible sources. Pass nextBeforeRevision to continue. Full content is available through skill_read_version.",
    inputSchema: z.toJSONSchema(SkillHistoryInput.omit({ limit: true })),
  },
  {
    name: "skill_read_version",
    readOnly: true,
    description:
      "Read 1000 characters of a private current or historical skill version. Continue with its revision and nextOffset. Removed versions remain readable for review.",
    inputSchema: z.toJSONSchema(SkillReadVersionInput),
  },
  {
    name: "skill_preview_undo",
    readOnly: true,
    description:
      "Preview undoing one skill revision while preserving later changes. Read all chunks of the proposed field; conflict=true requires a complete reviewed resolution. Changes both executable text and removal state. Does not mutate.",
    inputSchema: z.toJSONSchema(SkillPreviewToolInput),
  },
  {
    name: "skill_create",
    description:
      "After explicit owner approval, create a private reusable SKILL.md shared across the owner's bots. Include the complete content, expectedRevision=0 and reason. Avoid account-specific details. This adds executable instructions for future runs.",
    inputSchema: z.toJSONSchema(writeSchema(true)),
  },
  {
    name: "skill_update",
    description:
      "After explicit owner approval, replace a user-created skill with the complete reviewed content. Read it first. Supply its ID, current expectedRevision and reason. Builtin and plugin skills are read-only.",
    inputSchema: z.toJSONSchema(writeSchema(false)),
  },
  {
    name: "skill_delete",
    description:
      "After explicit owner approval, remove a user-created skill from future execution while retaining history. Supply its ID, current expectedRevision, complete current reviewedContent and reason.",
    inputSchema: z.toJSONSchema(SkillRemoveToolInput),
  },
  {
    name: "skill_undo",
    description:
      "After explicit owner approval, selectively undo one skill revision. Preview first; supply complete resulting reviewedContent, reviewedRemoved state, current expectedRevision and reason. Overlapping edits require a full resolution. No past actions replay.",
    inputSchema: z.toJSONSchema(SkillUndoToolInput),
  },
  {
    name: "skill_restore",
    description:
      "After explicit owner approval, restore a known skill version as a new revision. Prefer selective undo to retain later edits. Supply the entire target reviewedContent, reviewedRemoved state, current expectedRevision and reason. No past actions replay.",
    inputSchema: z.toJSONSchema(SkillRestoreToolInput),
  },
];
export const SKILL_TOOL_NAMES = new Set(skillTools.map((tool) => tool.name));
export const skillStore = (prisma: PrismaClient) =>
  createAgentSkillStore(
    prisma,
    BUILTIN_AGENT_SKILLS.map((skill) => skill.name),
  );
export async function listAgentSkillRecords(prisma: PrismaClient, owner: PrivateAuditActor) {
  const stored = await skillStore(prisma).list(owner);
  const builtin = BUILTIN_AGENT_SKILLS.map((skill) => ({
    ...skill,
    id: `builtin:${skill.name}`,
    source: "builtin" as const,
    readOnly: true,
    revision: 0,
    removedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
  return mergeBuiltinSkills(builtin, stored);
}
export async function skillReadFromTool(
  prisma: PrismaClient,
  owner: PrivateAuditActor,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const input = SkillReadToolInput.parse(raw);
  const skills = await listAgentSkillRecords(prisma, owner);
  const skill = input.skillId
    ? skills.find((entry) => entry.id === input.skillId)
    : findSkillByName(skills, input.name ?? "");
  if (!skill) return { error: "Skill not found." };
  // Pin later chunks to the version the reader started, even if the active skill changed.
  if (skill.source !== "builtin")
    return {
      name: skill.name,
      readOnly: skill.readOnly,
      source: skill.source,
      ...(await skillStore(prisma).readVersion(owner, {
        ...input,
        skillId: skill.id,
        revision: input.revision ?? skill.revision,
      })),
    };
  if (input.revision !== undefined && input.revision !== 0)
    return { error: "Skill version unavailable." };
  return {
    skillId: skill.id,
    name: skill.name,
    revision: 0,
    source: skill.source,
    readOnly: true,
    content: skill.content.slice(input.offset, input.offset + 1000),
    totalCharacters: skill.content.length,
    nextOffset: input.offset + 1000 < skill.content.length ? input.offset + 1000 : null,
  };
}

/** Preflight before showing consent; the transaction repeats every check before writing. */
export async function validateSkillMutation(
  prisma: PrismaClient,
  owner: PrivateAuditActor,
  name: string,
  raw: unknown,
) {
  const input = parseSkillMutation(name, raw);
  const store = skillStore(prisma);
  if (name === "skill_create") {
    const records = await listAgentSkillRecords(prisma, owner);
    const proposed = resolveAgentSkillContent({ content: String(input.content) });
    if (findSkillByName(records, proposed.name))
      throw new Error("A skill with that name already exists.");
    return;
  }
  const current = await store.history(owner, { skillId: input.skillId, limit: 1 });
  if (current.revision !== input.expectedRevision)
    throw new Error("This skill changed. Read it again before requesting approval.");
  if (name === "skill_update" || name === "skill_delete") {
    const row = await store.get(owner, String(input.skillId));
    if (row.readOnly) throw new Error("Builtin and plugin skills are read-only.");
    if (name === "skill_delete" && row.content !== input.reviewedContent)
      throw new Error("The reviewed skill text changed. Read it again.");
    return;
  }
  const next =
    name === "skill_undo"
      ? await store.previewUndo(owner, input).then((preview) => {
          if (preview.conflict && !input.resolution)
            throw new Error("Later edits overlap. Review a complete resolution before undoing.");
          return input.resolution ?? preview.proposed;
        })
      : await store.previewRestore(owner, input);
  const proposed = next as { content: string; removed: boolean };
  if (input.reviewedContent !== proposed.content || input.reviewedRemoved !== proposed.removed)
    throw new Error("The reviewed skill result changed. Preview it again.");
}

export async function skillCreateFromTool(
  prisma: PrismaClient,
  owner: PrivateAuditActor,
  raw: unknown,
) {
  const input = writeSchema(true).parse(raw);
  return skillResult(await skillStore(prisma).create(owner, input));
}
export async function skillUpdateFromTool(
  prisma: PrismaClient,
  owner: PrivateAuditActor,
  raw: unknown,
) {
  const input = writeSchema(false).parse(raw);
  return skillResult(await skillStore(prisma).update(owner, { ...input, skillId: input.skillId! }));
}
export async function skillDeleteFromTool(
  prisma: PrismaClient,
  owner: PrivateAuditActor,
  raw: unknown,
) {
  return skillStore(prisma).remove(owner, SkillRemoveToolInput.parse(raw));
}
function skillResult(row: { id: string; revision: number }) {
  return { ok: true, skillId: row.id, revision: row.revision };
}
export async function invokeSkillTool(
  prisma: PrismaClient,
  owner: PrivateAuditActor,
  name: string,
  args: Record<string, unknown>,
) {
  const store = skillStore(prisma);
  if (name === "skill_read") return skillReadFromTool(prisma, owner, args);
  if (name === "skill_documents") return store.listHistory(owner, args);
  if (name === "skill_read_version") return store.readVersion(owner, args);
  if (name === "skill_history") {
    const history = await store.history(owner, { ...args, limit: 3 });
    return {
      ...history,
      items: history.items.map((item) => ({
        ...item,
        actor: item.actor.slice(0, 80),
        reason: item.reason.slice(0, 200),
        metadataTruncated: item.actor.length > 80 || item.reason.length > 200,
      })),
    };
  }
  if (name === "skill_preview_undo") {
    const input = SkillPreviewToolInput.parse(args);
    const preview = await store.previewUndo(owner, input);
    const value = preview[input.field];
    return {
      skillId: input.skillId,
      expectedRevision: input.expectedRevision,
      revision: input.revision,
      field: input.field,
      conflict: preview.conflict,
      removed: value.removed,
      content: value.content.slice(input.offset, input.offset + 1000),
      totalCharacters: value.content.length,
      nextOffset: input.offset + 1000 < value.content.length ? input.offset + 1000 : null,
    };
  }
  if (name === "skill_create") return skillCreateFromTool(prisma, owner, args);
  if (name === "skill_update") return skillUpdateFromTool(prisma, owner, args);
  if (name === "skill_delete") return skillDeleteFromTool(prisma, owner, args);
  if (name === "skill_undo")
    return skillResult(await store.undo(owner, SkillUndoToolInput.parse(args)));
  if (name === "skill_restore")
    return skillResult(await store.restore(owner, SkillRestoreToolInput.parse(args)));
  throw new Error("Unknown skill tool.");
}
