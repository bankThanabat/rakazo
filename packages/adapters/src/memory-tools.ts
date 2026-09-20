import type { ConnectorTool, DurableMemoryScope } from "@rakazo/adapter-kit";
import {
  MemoryDocumentsInput,
  MemoryHistoryInput,
  MemoryPreviewToolInput,
  MemoryReadInput,
  MemoryRestoreToolInput,
  MemoryUndoToolInput,
  SemanticMemoryAuditListInput,
  SemanticMemoryAuditReadInput,
  SemanticMemoryUndoInput,
} from "@rakazo/contracts";
import type { createMemoryAudit } from "@rakazo/db";
import { z } from "zod";

export const SemanticMemoryForgetInput = z.object({
  id: z.string().min(1).max(500).describe("Memory id from a recall citation."),
  expectedContent: z
    .string()
    .min(1)
    .max(10000)
    .refine((value) => Boolean(value.trim()))
    .describe("Complete unchanged recalled fact."),
  entity: z.string().min(1).max(500).optional().describe("Namespace from the recall citation."),
  reason: z.string().trim().min(1).max(1000).optional(),
});

export const SemanticMemorySaveInput = z.object({
  content: z
    .string()
    .min(1)
    .max(10000)
    .refine((value) => Boolean(value.trim())),
  reason: z.string().trim().min(1).max(1000).optional(),
});

type SemanticMemoryBinding = {
  botId: string;
  scope: DurableMemoryScope;
  provider: string;
  configurationRevision: string;
};

function assertSemanticMemoryBinding(
  raw: Record<string, unknown>,
  binding: SemanticMemoryBinding,
  replay: boolean,
) {
  if (replay && Object.entries(binding).some(([key, value]) => raw[key] !== value))
    throw new Error("Memory scope or provider changed. Review the current destination again.");
}

export function bindSemanticMemorySave(
  raw: Record<string, unknown>,
  binding: SemanticMemoryBinding,
  replay: boolean,
) {
  assertSemanticMemoryBinding(raw, binding, replay);
  return { ...SemanticMemorySaveInput.parse(raw), ...binding };
}

/** Approval and dispatch share the server's scope, including after worker recovery. */
export function bindSemanticMemoryRemoval(
  raw: Record<string, unknown>,
  binding: SemanticMemoryBinding,
  replay: boolean,
) {
  assertSemanticMemoryBinding(raw, binding, replay);
  return { ...SemanticMemoryForgetInput.parse(raw), ...binding };
}

export const memoryAuditTools: ConnectorTool[] = [
  {
    name: "memory_semantic_undo",
    description:
      "Undo one confirmed semantic-memory creation or removal after one-time owner approval. Inspect memory_semantic_history and all memory_semantic_read chunks first. Choose the original mutationId and exact receipt id/entity, and explain the reason. The server loads the full recorded fact and inverse action for approval. A creation undo removes only the unchanged recorded fact; a removal undo recreates the full recorded text only in its original destination, preserving other facts and recording any new provider ID. It appends a linked audit event. Shared receipts are separate reversals. Unknown creation state, uncertain destinations and prior unresolved undo cannot be reversed. A confirmed reversal can itself be reversed when its receipt supplies the required evidence. Never replays external business actions.",
    inputSchema: z.toJSONSchema(SemanticMemoryUndoInput),
  },
  {
    name: "memory_semantic_history",
    readOnly: true,
    description:
      "List this bot's private semantic-memory mutation history, including confirmed, failed and uncertain provider actions. Returns ten records; use nextCursor to continue. History remains inspectable after disconnecting the provider. Read complete requests and receipts with memory_semantic_read before proposing another action. An uncertain action may already have changed the provider.",
    inputSchema: z.toJSONSchema(SemanticMemoryAuditListInput),
  },
  {
    name: "memory_semantic_read",
    readOnly: true,
    description:
      "Read 1000 characters of one semantic-memory audit record, including source references, request, scope, connection revision and provider receipts. Follow nextOffset with the returned version until complete. Null receipt content or creation state means unknown. Inspection does not retry a mutation, restore a fact, or prove erasure.",
    inputSchema: z.toJSONSchema(SemanticMemoryAuditReadInput),
  },

  {
    name: "memory_documents",
    readOnly: true,
    description:
      "Inspect this bot's private Markdown memory and your private memory shared across your bots. Returns up to 10 IDs, abbreviated paths and current revisions; pass nextCursor as cursor to continue. Use memory_read to read content. These are separate from an optional semantic memory provider, whose entries use recall_memory. Never describe user memory as shared with other staff.",
    inputSchema: z.toJSONSchema(MemoryDocumentsInput),
  },
  {
    name: "memory_read",
    readOnly: true,
    description:
      "Read up to 1000 characters of a private Markdown memory document or historical version. Pass nextOffset as offset and the returned revision to read the rest of that same version. Never replace a document until all of its content has been read.",
    inputSchema: z.toJSONSchema(MemoryReadInput),
  },
  {
    name: "memory_history",
    readOnly: true,
    description:
      "Inspect a private Markdown memory document's audit versions, responsible agent or staff, reason and accessible source references. Read memory_documents for its ID. Returns 3 versions with abbreviated reasons and nextBeforeRevision; pass it as beforeRevision for older history. Read selected content with memory_read. Unknown legacy versions are unavailable, never invented.",
    inputSchema: z.toJSONSchema(MemoryHistoryInput.omit({ limit: true })),
  },
  {
    name: "memory_preview_undo",
    readOnly: true,
    description:
      "Preview reversing one Markdown memory revision while preserving later edits. Returns one 1000-character chunk of the selected field: before, after, current or proposed. Read every chunk using nextOffset; conflict=true marks overlapping edits. Read current revision first. Source and history remain private to the memory owner. Does not mutate memory.",
    inputSchema: z.toJSONSchema(MemoryPreviewToolInput),
  },
  {
    name: "memory_undo",
    description:
      "After explicit owner approval, undo one Markdown memory revision. Preview first and include the entire exact replacement as reviewedContent; overlapping edits require the owner's reviewed resolution. Include current expectedRevision and the owner's reason. Appends an audit record and changes future native-memory retrieval; no external actions replay. Does not edit optional semantic memory providers.",
    inputSchema: z.toJSONSchema(MemoryUndoToolInput),
  },
  {
    name: "memory_restore",
    description:
      "After explicit owner approval to replace the entire Markdown memory, restore a known historical revision. Prefer selective memory_preview_undo and memory_undo to retain later edits. Include the complete historical text as reviewedContent, current expectedRevision and reason. Original history is preserved and restoration is a new revision. Does not replay actions or edit semantic memory providers.",
    inputSchema: z.toJSONSchema(MemoryRestoreToolInput),
  },
];

const SEMANTIC_MEMORY_TOOL_NAMES = new Set([
  "recall_memory",
  "save_memory",
  "forget_memory",
  "memory_semantic_undo",
]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => tool.name !== "remember")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

/** Keep tool JSON below the runtime's 12000-character display bound. Full metadata is in RPC. */
export function memoryHistoryForTool(
  history: Awaited<ReturnType<ReturnType<typeof createMemoryAudit>["history"]>>,
) {
  return {
    documentId: history.document.id,
    currentRevision: history.document.revision,
    items: history.items.map((item) => ({
      ...item,
      actor: item.actor.slice(0, 80),
      reason: item.reason.slice(0, 200),
      metadataTruncated: item.actor.length > 80 || item.reason.length > 200,
    })),
    nextBeforeRevision: history.nextBeforeRevision,
  };
}
export function memoryUndoPreviewForTool(
  preview: Awaited<ReturnType<ReturnType<typeof createMemoryAudit>["previewUndo"]>>,
  raw: unknown,
) {
  const input = MemoryPreviewToolInput.parse(raw);
  const content = preview[input.field];
  return {
    documentId: input.documentId,
    revision: input.revision,
    expectedRevision: input.expectedRevision,
    conflict: preview.conflict,
    field: input.field,
    content: content.slice(input.offset, input.offset + 1000),
    totalCharacters: content.length,
    nextOffset: input.offset + 1000 < content.length ? input.offset + 1000 : null,
  };
}
