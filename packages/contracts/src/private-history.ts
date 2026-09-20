import * as z from "zod";
import { Id } from "./ids.js";
import { MemoryHistorySchema } from "./memory-audit.js";

export const PrivateHistoryTargetSchema = z.object({ kind: z.enum(["memory", "skill"]), id: Id });
export type PrivateHistoryTarget = z.infer<typeof PrivateHistoryTargetSchema>;
export const PrivateHistoryInput = PrivateHistoryTargetSchema.extend({
  beforeRevision: z.number().int().positive().optional(),
});
export const PrivateHistorySchema = z.object({
  title: z.string(),
  scope: z.enum(["bot", "user"]),
  botId: Id.nullable(),
  revision: z.number().int().positive(),
  removed: z.boolean(),
  readOnly: z.boolean(),
  items: z.array(
    MemoryHistorySchema.shape.items.element.extend({
      canUndo: z.boolean(),
      learningSource: z.object({ botId: Id, taskId: Id }).nullable().default(null),
      sourceTarget: z.object({ botId: Id.nullable(), groupId: Id.nullable() }).nullable(),
    }),
  ),
  nextBeforeRevision: z.number().int().positive().nullable(),
});
export type PrivateHistory = z.infer<typeof PrivateHistorySchema>;
export const PrivateHistoryVersionInput = PrivateHistoryTargetSchema.extend({
  revision: z.number().int().positive(),
});
export const PrivateHistoryValueSchema = z.object({
  content: z.string().max(100000),
  removed: z.boolean(),
});
export type PrivateHistoryValue = z.infer<typeof PrivateHistoryValueSchema>;
export const PrivateHistoryVersionSchema = z.object({
  currentRevision: z.number().int().positive(),
  before: PrivateHistoryValueSchema.nullable(),
  after: PrivateHistoryValueSchema,
  current: PrivateHistoryValueSchema,
});
export type PrivateHistoryVersion = z.infer<typeof PrivateHistoryVersionSchema>;
export const PrivateHistoryPreviewInput = PrivateHistoryVersionInput.extend({
  expectedRevision: z.number().int().positive(),
  action: z.enum(["undo", "restore"]),
});
export const PrivateHistoryPreviewSchema = z.object({
  current: PrivateHistoryValueSchema,
  proposed: PrivateHistoryValueSchema,
  conflict: z.boolean(),
});
export type PrivateHistoryPreview = z.infer<typeof PrivateHistoryPreviewSchema>;
export const PrivateHistoryApplyInput = PrivateHistoryPreviewInput.extend({
  reason: z.string().trim().min(1).max(1000),
  reviewed: PrivateHistoryValueSchema,
  resolveConflict: z.boolean().default(false),
});
export type PrivateHistoryApply = z.infer<typeof PrivateHistoryApplyInput>;
export const PrivateHistoryAppliedSchema = PrivateHistoryValueSchema.extend({
  revision: z.number().int().positive(),
});
