import { createHash } from "node:crypto";
import type {
  AdapterContext,
  SemanticMemoryForgetResponse,
  SemanticMemorySaveResponse,
} from "@rakazo/adapter-kit";
import type { SemanticMemoryDetail } from "@rakazo/contracts";
import {
  SemanticMemoryAuditListInput,
  SemanticMemoryAuditReadInput,
  SemanticMemoryBindingSchema,
  SemanticMemoryHistorySource,
  SemanticMemoryRecordedRemoval,
  SemanticMemoryRecordedRequest,
  SemanticMemorySaveAuditResult,
  SemanticMemoryUndoApprovedInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { IsolationError } from "./scope.js";
import { semanticMemoryReversalKey, semanticMemoryUndoRequest } from "./semantic-memory-undo.js";

/** Commit the intent before external dispatch; a lost worker leaves an honest unknown outcome. */
export async function beginSemanticMemoryMutation(
  prisma: PrismaClient,
  context: AdapterContext,
  effectId: string,
) {
  return prisma.$transaction(async (tx) => {
    if (!context.botId || !context.runId) throw new IsolationError();
    await requirePrivateOwner(tx, context, context.botId);
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: effectId,
        status: "executing",
        spaceId: context.spaceId,
        runId: context.runId,
        kind: { in: ["save_memory", "forget_memory", "memory_semantic_undo"] },
        run: { ...privateOwner(context), botId: context.botId, thread: { groupId: null } },
      },
      include: { run: { select: { threadId: true } } },
    });
    if (!effect) throw new IsolationError();
    const destination = SemanticMemoryBindingSchema.parse(effect.request);
    if (destination.botId !== context.botId) throw new IsolationError();
    const reversal =
      effect.kind === "memory_semantic_undo"
        ? SemanticMemoryUndoApprovedInput.parse(effect.request)
        : null;
    if (reversal) {
      const current = await semanticMemoryUndoRequest(tx, context, destination, reversal);
      if (
        current.expectedContent !== reversal.expectedContent ||
        current.action !== reversal.action
      )
        throw new Error(
          "The reviewed undo content changed. Inspect the original audit record again.",
        );
    }
    return tx.semanticMemoryMutation.create({
      data: {
        id: effect.id,
        ...privateOwner(context),
        ...destination,
        sourceRunId: context.runId,
        sourceThreadId: effect.run.threadId,
        operation: reversal
          ? reversal.action === "restore"
            ? "undo_forget"
            : "undo_save"
          : effect.kind === "save_memory"
            ? "save"
            : "forget",
        ...(reversal
          ? { reversesId: reversal.mutationId, reversalKey: semanticMemoryReversalKey(reversal) }
          : {}),
        status: "uncertain",
        request: effect.request as Prisma.InputJsonValue,
      },
    });
  });
}

/** Commit provider evidence and replay state together. Deleted source runs need no effect row. */
export async function finishSemanticMemoryMutation(
  prisma: PrismaClient,
  context: AdapterContext,
  effectId: string,
  result: SemanticMemorySaveResponse | SemanticMemoryForgetResponse,
) {
  if (!context.botId) throw new IsolationError();
  const uncertain =
    !result.ok &&
    ("uncertainEntities" in result
      ? result.uncertainEntities.length > 0
      : result.uncertain === true);
  const effectResult = uncertain
    ? {
        ...result,
        uncertain: true,
        error: `${result.ok ? "" : result.error} Verify the destination before proposing another action. This write was not replayed.`,
      }
    : result;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.semanticMemoryMutation.updateMany({
      where: {
        id: effectId,
        ...privateOwner(context),
        botId: context.botId,
        sourceRunId: context.runId ?? null,
        ...(!context.runId ? { request: { path: ["source", "kind"], equals: "staff" } } : {}),
        status: "uncertain",
        result: { equals: Prisma.DbNull },
      },
      data: {
        status: uncertain ? "uncertain" : result.ok ? "completed" : "failed",
        result: result as Prisma.InputJsonValue,
        ...(!result.ok && !uncertain ? { reversalKey: null } : {}),
      },
    });
    if (updated.count !== 1)
      throw new Error("The semantic memory audit outcome could not be recorded.");
    if (!context.runId) return effectResult;
    // A recovery worker may already have classified the in-flight call as unknown.
    // Its actual acknowledgement can settle that uncertainty without another dispatch.
    const settled = await tx.externalEffect.updateMany({
      where: {
        id: effectId,
        spaceId: context.spaceId,
        runId: context.runId,
        status: { in: ["executing", "uncertain"] },
      },
      data: {
        status: uncertain ? "uncertain" : "completed",
        result: effectResult as Prisma.InputJsonValue,
      },
    });
    if (settled.count === 1) return effectResult;
    const current = await tx.externalEffect.findUnique({ where: { id: effectId } });
    // Source deletion deliberately removes its execution ledger, not provider evidence.
    if (!current) return effectResult;
    // Preserve a concurrent terminal decision; never overwrite it with a late response.
    return {
      error:
        "The memory execution state changed while the provider was responding. Inspect its audit record before another action.",
      uncertain: true,
    };
  });
}

/** Only link to history that still exists in the same private conversation generation. */
async function readableSource(
  tx: Prisma.TransactionClient,
  context: AdapterContext,
  row: {
    sourceRunId: string | null;
    sourceThreadId: string;
    botId: string;
    operation: string;
    request: unknown;
  },
): Promise<{ id: string | null; threadId: string } | null> {
  const owner = privateOwner(context);
  if (row.sourceRunId !== null) {
    return tx.run.findFirst({
      where: {
        id: row.sourceRunId,
        ...owner,
        botId: row.botId,
        thread: { ...owner, botId: row.botId, groupId: null },
      },
      select: { id: true, threadId: true },
    });
  }
  const history = SemanticMemoryHistorySource.safeParse(row.request);
  if (row.operation !== "save" || !history.success) return null;
  const thread = await tx.thread.findFirst({
    where: {
      id: row.sourceThreadId,
      ...owner,
      botId: row.botId,
      groupId: null,
      historyCompactionGeneration: history.data.source.generation,
    },
    select: { id: true },
  });
  return thread ? { id: null, threadId: thread.id } : null;
}

export function createSemanticMemoryAudit(prisma: PrismaClient) {
  return {
    async list(context: AdapterContext, raw: unknown = {}) {
      const input = SemanticMemoryAuditListInput.parse(raw);
      return prisma.$transaction(async (tx) => {
        if (!context.botId) throw new IsolationError();
        await requirePrivateOwner(tx, context, context.botId);
        const where = { ...privateOwner(context), botId: context.botId };
        if (
          input.cursor &&
          !(await tx.semanticMemoryMutation.count({ where: { ...where, id: input.cursor } }))
        )
          throw new IsolationError();
        const rows = await tx.semanticMemoryMutation.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 11,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            operation: true,
            reversesId: true,
            provider: true,
            scope: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        return {
          items: rows.slice(0, 10).map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          })),
          nextCursor: rows.length > 10 ? rows[9]!.id : null,
        };
      });
    },
    /** Complete, private recorded versions for app inspection; never query an external provider. */
    async detail(context: AdapterContext, mutationId: string): Promise<SemanticMemoryDetail> {
      return prisma.$transaction(async (tx) => {
        if (!context.botId) throw new IsolationError();
        await requirePrivateOwner(tx, context, context.botId);
        const row = await tx.semanticMemoryMutation.findFirst({
          where: { id: mutationId, ...privateOwner(context), botId: context.botId },
          include: { bot: { select: { name: true } } },
        });
        if (!row) throw new IsolationError();
        const source = await readableSource(tx, context, row);
        const request = SemanticMemoryRecordedRequest.safeParse(row.request);
        const snapshot = request.success ? request.data : {};
        const saved = SemanticMemorySaveAuditResult.safeParse(row.result);
        const removed = SemanticMemoryRecordedRemoval.safeParse(row.result);
        const unknown = { state: "unknown" as const, content: null };
        const absent = { state: "absent" as const, content: null };
        const recorded = (content: string | null | undefined) =>
          content == null ? unknown : { state: "recorded" as const, content };
        const isSave = row.operation === "save" || row.operation === "undo_forget";
        const saveResult = isSave && saved.success ? saved.data : null;
        const receipts = saveResult ? (saveResult.ok ? saveResult.value : saveResult.receipts) : [];
        const uncertainEntities = saveResult && !saveResult.ok ? saveResult.uncertainEntities : [];
        const changes: SemanticMemoryDetail["changes"] = isSave
          ? receipts.map((receipt) => ({
              id: receipt.id,
              entity: receipt.entity,
              before:
                receipt.version === 1 &&
                receipt.created === true &&
                !uncertainEntities.includes(receipt.entity)
                  ? absent
                  : unknown,
              after: uncertainEntities.includes(receipt.entity)
                ? unknown
                : recorded(receipt.content),
            }))
          : snapshot.id
            ? [
                {
                  id: snapshot.id,
                  entity:
                    snapshot.entity ??
                    (removed.success ? (removed.data.value.entity ?? null) : null),
                  before: recorded(snapshot.expectedContent),
                  after:
                    row.status === "completed" &&
                    removed.success &&
                    removed.data.value.id === snapshot.id
                      ? absent
                      : unknown,
                },
              ]
            : [];
        return {
          id: row.id,
          operation: row.operation,
          reversesId: row.reversesId,
          provider: row.provider,
          scope: row.scope,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          botName: row.bot.name,
          reason: snapshot.reason ?? null,
          sourceThreadId: source?.threadId ?? null,
          requestedContent: snapshot.content ?? snapshot.expectedContent ?? null,
          changes,
          uncertainEntities,
        };
      });
    },
    async read(context: AdapterContext, raw: unknown) {
      const input = SemanticMemoryAuditReadInput.parse(raw);
      return prisma.$transaction(async (tx) => {
        if (!context.botId) throw new IsolationError();
        await requirePrivateOwner(tx, context, context.botId);
        const row = await tx.semanticMemoryMutation.findFirst({
          where: { id: input.mutationId, ...privateOwner(context), botId: context.botId },
        });
        if (!row) throw new IsolationError();
        const source = await readableSource(tx, context, row);
        const content = JSON.stringify(
          { ...row, sourceRunId: source?.id ?? null, sourceThreadId: source?.threadId ?? null },
          null,
          2,
        );
        const version = createHash("sha256").update(content).digest("hex");
        if (input.version && input.version !== version)
          throw new Error("The memory outcome or source access changed. Start reading it again.");
        return {
          mutationId: row.id,
          version,
          content: content.slice(input.offset, input.offset + 1000),
          totalCharacters: content.length,
          nextOffset: input.offset + 1000 < content.length ? input.offset + 1000 : null,
        };
      });
    },
  };
}
