import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  SemanticMemoryBindingSchema,
  SemanticMemoryRecordedRemoval,
  SemanticMemoryRecordedRequest,
  SemanticMemorySaveAuditResult,
  SemanticMemoryStaffSource,
  SemanticMemoryUndoInput,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { IsolationError } from "./scope.js";

export class SemanticMemoryUndoError extends Error {
  constructor(
    message: string,
    readonly previousUndo?: { id: string; status: string },
  ) {
    super(message);
  }
}

export function semanticMemoryReversalKey(input: {
  mutationId: string;
  entity: string;
  id: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify([input.mutationId, input.entity, input.id]))
    .digest("hex");
}

/** Resolve the inverse from retained evidence. Model-supplied content never defines it. */
export async function semanticMemoryUndoRequest(
  tx: Prisma.TransactionClient,
  context: AdapterContext,
  rawBinding: unknown,
  raw: unknown,
  reservationId?: string,
) {
  if (!context.botId) throw new IsolationError();
  const binding = SemanticMemoryBindingSchema.parse(rawBinding);
  if (binding.botId !== context.botId) throw new IsolationError();
  const input = SemanticMemoryUndoInput.parse(raw);
  const original = await tx.semanticMemoryMutation.findFirst({
    where: {
      id: input.mutationId,
      ...privateOwner(context),
      botId: context.botId,
      operation: { in: ["save", "undo_forget", "forget", "undo_save"] },
      status: { in: ["completed", "uncertain"] },
    },
  });
  if (!original)
    throw new SemanticMemoryUndoError("A recorded semantic-memory change is required for undo.");
  if (
    Object.entries(binding).some(([key, value]) => original[key as keyof typeof binding] !== value)
  )
    throw new SemanticMemoryUndoError(
      "Memory scope or provider changed. Review the original destination before undo.",
    );
  if (
    original.sourceRunId === null &&
    !SemanticMemoryStaffSource.safeParse(original.request).success
  )
    throw new SemanticMemoryUndoError(
      "Conversation summaries belong to history. Clear the source conversation to remove them.",
    );
  let action: "forget" | "restore";
  let expectedContent: string;
  if (original.operation === "forget" || original.operation === "undo_save") {
    const removed = SemanticMemoryRecordedRemoval.safeParse(original.result);
    const request = SemanticMemoryRecordedRequest.safeParse(original.request);
    if (
      original.status !== "completed" ||
      !removed.success ||
      !request.success ||
      removed.data.value.id !== input.id ||
      request.data.id !== input.id ||
      (removed.data.value.entity ?? request.data.entity) !== input.entity ||
      !request.data.expectedContent?.trim() ||
      request.data.expectedContent.length > 10000
    )
      throw new SemanticMemoryUndoError(
        "A confirmed removal with complete content and its exact destination is required for restoration.",
      );
    action = "restore";
    expectedContent = request.data.expectedContent;
  } else {
    const saved = SemanticMemorySaveAuditResult.safeParse(original.result);
    if (!saved.success)
      throw new SemanticMemoryUndoError("This audit record has no usable creation receipt.");
    const receipts = saved.data.ok ? saved.data.value : saved.data.receipts;
    const matches = receipts.filter(
      (receipt) => receipt.id === input.id && receipt.entity === input.entity,
    );
    const receipt = matches[0];
    if (
      matches.length !== 1 ||
      receipt?.version !== 1 ||
      !receipt?.created ||
      !receipt.content?.trim() ||
      (!saved.data.ok && saved.data.uncertainEntities.includes(input.entity))
    )
      throw new SemanticMemoryUndoError(
        "The provider did not confirm a new fact with complete content in this destination. Inspect it before making changes.",
      );
    action = "forget";
    expectedContent = receipt.content;
  }
  const previous = await tx.semanticMemoryMutation.findUnique({
    where: { reversalKey: semanticMemoryReversalKey(input) },
    select: { id: true, status: true },
  });
  if (previous && previous.id !== reservationId)
    throw new SemanticMemoryUndoError(
      "This fact already has a pending, uncertain or completed undo. Inspect its history before another action.",
      previous,
    );
  return { ...input, ...binding, action, expectedContent };
}

export async function prepareSemanticMemoryUndo(
  prisma: PrismaClient,
  context: AdapterContext,
  binding: unknown,
  raw: unknown,
) {
  return prisma.$transaction(async (tx) => {
    if (!context.botId) throw new IsolationError();
    await requirePrivateOwner(tx, context, context.botId);
    return semanticMemoryUndoRequest(tx, context, binding, raw);
  });
}
