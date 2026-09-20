import * as z from "zod";
import { MemoryDocumentSchema } from "./domain.js";
import { Id } from "./ids.js";

export const MemoryUpdateInput = z.object({
  documentId: Id,
  content: z.string().max(100000),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000).default("Edited memory"),
});
export const MemoryHistoryInput = z.object({
  documentId: Id,
  beforeRevision: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const MemoryHistorySchema = z.object({
  document: MemoryDocumentSchema.omit({ content: true }),
  items: z.array(
    z.object({
      revision: z.number().int().positive(),
      reason: z.string(),
      actor: z.string(),
      sourceRunId: Id.nullable(),
      sourceThreadId: Id.nullable(),
      restoredFrom: z.number().int().nullable(),
      undoneRevision: z.number().int().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextBeforeRevision: z.number().int().positive().nullable(),
});
export const MemoryRestoreInput = z.object({
  documentId: Id,
  revision: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  reviewedContent: z.string().max(100000).optional(),
});
export const MemoryUndoPreviewSchema = z.object({
  before: z.string(),
  after: z.string(),
  current: z.string(),
  proposed: z.string(),
  conflict: z.boolean(),
});
export const MemoryUndoInput = MemoryRestoreInput.extend({
  resolution: z.string().max(100000).optional(),
});

// Character offsets are stable when the returned revision is supplied on later reads.
export const MemoryReadInput = z.object({
  documentId: Id,
  revision: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().default(0),
});
export const MemoryReadSchema = z.object({
  documentId: Id,
  revision: z.number().int().positive(),
  content: z.string(),
  totalCharacters: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export const MemoryDocumentsInput = z.object({ cursor: Id.optional() });
export const MemoryPreviewToolInput = MemoryRestoreInput.extend({
  field: z.enum(["before", "after", "current", "proposed"]).default("proposed"),
  offset: z.number().int().nonnegative().default(0),
});

export const MemoryUndoToolInput = MemoryUndoInput.required({ reviewedContent: true });
export const MemoryRestoreToolInput = MemoryRestoreInput.required({ reviewedContent: true });
