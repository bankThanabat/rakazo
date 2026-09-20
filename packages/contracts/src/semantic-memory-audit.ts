import { z } from "zod";
import { Id } from "./ids.js";

export const SemanticMemoryAuditListInput = z.object({ cursor: Id.optional() });
export const SemanticMemoryHistoryInput = SemanticMemoryAuditListInput.extend({ botId: Id });
export const SemanticMemoryHistoryItemSchema = z.object({
  id: Id,
  operation: z.string(),
  reversesId: Id.nullable(),
  provider: z.string(),
  scope: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const SemanticMemoryHistorySchema = z.object({
  items: z.array(SemanticMemoryHistoryItemSchema),
  nextCursor: Id.nullable(),
});
export type SemanticMemoryHistory = z.infer<typeof SemanticMemoryHistorySchema>;
export const SemanticMemoryDetailInput = z.object({ botId: Id, mutationId: Id });
const recordedVersion = z.object({
  state: z.enum(["unknown", "absent", "recorded"]),
  content: z.string().nullable(),
});
export const SemanticMemoryDetailSchema = SemanticMemoryHistoryItemSchema.extend({
  botName: z.string(),
  reason: z.string().nullable(),
  sourceThreadId: Id.nullable(),
  requestedContent: z.string().nullable(),
  changes: z.array(
    z.object({
      id: z.string(),
      entity: z.string().nullable(),
      before: recordedVersion,
      after: recordedVersion,
    }),
  ),
  uncertainEntities: z.array(z.string()),
});
export type SemanticMemoryDetail = z.infer<typeof SemanticMemoryDetailSchema>;
export const SemanticMemoryRecordedRequest = z.object({
  content: z.string().optional(),
  expectedContent: z.string().optional(),
  reason: z.string().optional(),
  id: z.string().optional(),
  entity: z.string().optional(),
});
export const SemanticMemoryRecordedRemoval = z.object({
  ok: z.literal(true),
  value: z.object({ id: z.string(), expired: z.literal(true), entity: z.string().optional() }),
});
export const SemanticMemoryAuditReadInput = z
  .object({
    mutationId: Id,
    offset: z.number().int().nonnegative().default(0),
    version: z.string().max(128).optional(),
  })
  .refine((input) => input.offset === 0 || Boolean(input.version), {
    message: "Continue reading with the returned version.",
  });

export const SemanticMemoryBindingSchema = z.object({
  botId: Id,
  scope: z.enum(["isolated", "shared"]),
  provider: z.string().min(1).max(200),
  configurationRevision: z.string().min(1).max(500),
});

export const SemanticMemoryUndoInput = z.object({
  mutationId: Id.max(500),
  id: z.string().min(1).max(500),
  entity: z.string().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
});

export const SemanticMemoryUndoApprovedInput = SemanticMemoryUndoInput.extend({
  action: z.enum(["forget", "restore"]).default("forget"),
  ...SemanticMemoryBindingSchema.shape,
  expectedContent: z
    .string()
    .min(1)
    .max(10000)
    .refine((value) => Boolean(value.trim())),
});

const savedReceipt = z.object({
  version: z.literal(1).optional(),
  id: z.string().min(1).max(500),
  entity: z.string().min(1).max(500),
  content: z.string().min(1).max(10000).nullable(),
  created: z.boolean().nullable(),
});
export const SemanticMemorySaveAuditResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.array(savedReceipt) }),
  z.object({
    ok: z.literal(false),
    receipts: z.array(savedReceipt),
    uncertainEntities: z.array(z.string()),
  }),
]);

export const SemanticMemoryHistorySource = z.object({
  source: z.object({ kind: z.literal("history"), generation: z.number().int().nonnegative() }),
});

export const SemanticMemoryReversalInput = SemanticMemoryUndoInput.extend({ botId: Id });
export type SemanticMemoryReversalInput = z.infer<typeof SemanticMemoryReversalInput>;
export const SemanticMemoryReversalPreviewSchema = z.object({
  version: z.string().length(64),
  action: z.enum(["forget", "restore"]),
  content: z.string().min(1).max(10000),
  provider: z.string(),
  scope: z.enum(["isolated", "shared"]),
});
export type SemanticMemoryReversalPreview = z.infer<typeof SemanticMemoryReversalPreviewSchema>;
export const SemanticMemoryReversalApplyInput = SemanticMemoryReversalInput.extend({
  version: z.string().length(64),
  clientNonce: z.string().min(1).max(200),
});
export type SemanticMemoryReversalApply = z.infer<typeof SemanticMemoryReversalApplyInput>;
export const SemanticMemoryReversalResultSchema = z.object({
  mutationId: Id,
  status: z.enum(["completed", "failed", "uncertain"]),
});
export type SemanticMemoryReversalResult = z.infer<typeof SemanticMemoryReversalResultSchema>;
export const SemanticMemoryStaffSource = z.object({
  source: z.object({ kind: z.literal("staff"), reviewVersion: z.string().length(64) }),
});
