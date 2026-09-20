import * as z from "zod";
import { Id } from "./ids.js";

export const SkillRemoveInput = z.object({
  skillId: Id,
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000).default("Removed skill"),
  reviewedContent: z.string().max(100000).optional(),
});
export const SkillRestoreInput = SkillRemoveInput.extend({
  revision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  reviewedRemoved: z.boolean().optional(),
});
export const SkillVersionSchema = z.object({
  content: z.string().max(100000),
  removed: z.boolean(),
});
export const SkillUndoInput = SkillRestoreInput.extend({
  resolution: SkillVersionSchema.optional(),
});
export const SkillUndoPreviewSchema = z.object({
  before: SkillVersionSchema,
  after: SkillVersionSchema,
  current: SkillVersionSchema,
  proposed: SkillVersionSchema,
  conflict: z.boolean(),
});
export const SkillHistoryInput = z.object({
  skillId: Id,
  beforeRevision: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const SkillHistorySchema = z.object({
  readOnly: z.boolean(),
  skillId: Id,
  name: z.string(),
  revision: z.number().int().positive(),
  removed: z.boolean(),
  items: z.array(
    z.object({
      revision: z.number().int().positive(),
      reason: z.string(),
      actor: z.string(),
      operation: z.string(),
      removed: z.boolean(),
      sourceRunId: Id.nullable(),
      sourceThreadId: Id.nullable(),
      restoredFrom: z.number().int().nullable(),
      undoneRevision: z.number().int().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextBeforeRevision: z.number().int().positive().nullable(),
});
export const SkillReadVersionInput = z.object({
  skillId: Id,
  revision: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().default(0),
});
export const SkillReadVersionSchema = z.object({
  skillId: Id,
  revision: z.number().int().positive(),
  removed: z.boolean(),
  content: z.string(),
  totalCharacters: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export const SkillListInput = z.object({
  cursor: Id.optional(),
  includeRemoved: z.boolean().default(false),
  removedOnly: z.boolean().default(false),
});
export const SkillListSchema = z.object({
  items: z.array(
    z.object({
      id: Id,
      name: z.string(),
      revision: z.number().int().positive(),
      removed: z.boolean(),
    }),
  ),
  nextCursor: Id.nullable(),
});
export const SkillUndoToolInput = SkillUndoInput.required({
  reviewedContent: true,
  reviewedRemoved: true,
});
export const SkillRestoreToolInput = SkillRestoreInput.required({
  reviewedContent: true,
  reviewedRemoved: true,
});
export const SkillRemoveToolInput = SkillRemoveInput.required({ reviewedContent: true });
export const SkillWriteToolInput = z.object({
  content: z.string().min(1).max(100000),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  skillId: Id.optional(),
});

export const SkillPreviewInput = SkillRestoreInput.omit({
  reason: true,
  reviewedContent: true,
  reviewedRemoved: true,
});
export const SkillPreviewToolInput = SkillPreviewInput.extend({
  field: z.enum(["before", "after", "current", "proposed"]).default("proposed"),
  offset: z.number().int().nonnegative().default(0),
});
export const SkillReadToolInput = z
  .object({
    name: z.string().max(80).optional(),
    skillId: Id.optional(),
    revision: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().default(0),
  })
  .refine((input) => input.name || input.skillId, "Supply a skill ID or name.");
