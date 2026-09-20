import { createHash } from "node:crypto";
import type {
  AdapterContext,
  SemanticMemoryResponse,
  SemanticMemorySaveResponse,
} from "@rakazo/adapter-kit";
import { SemanticMemoryBindingSchema, SemanticMemoryHistorySource } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { IsolationError } from "./scope.js";

type HistorySource = { threadId: string; generation: number };
export type SemanticHistoryIntent = HistorySource &
  (
    | { kind: "save"; throughSeq: number; content: string; previousSummary: string | null }
    | { kind: "purge"; generations: number[]; afterSaveId?: string }
  );

/** Reserve one background dispatch. A retry can inspect an uncertain intent, never replay it. */
export async function beginSemanticHistoryMutation(
  prisma: PrismaClient,
  context: AdapterContext,
  rawBinding: unknown,
  input: SemanticHistoryIntent,
) {
  const binding = SemanticMemoryBindingSchema.parse(rawBinding);
  if (
    !context.botId ||
    binding.botId !== context.botId ||
    binding.scope !== "isolated" ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0
  )
    throw new IsolationError();
  const generations =
    input.kind === "purge" ? [...new Set(input.generations)].sort((a, b) => a - b) : [];
  if (
    input.kind === "purge" &&
    (!generations.length ||
      generations.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value >= input.generation,
      ))
  )
    throw new IsolationError();
  if (
    input.kind === "save" &&
    (!Number.isSafeInteger(input.throughSeq) || input.throughSeq < 0 || !input.content.trim())
  )
    throw new IsolationError();
  const key = [
    input.kind,
    input.threadId,
    input.generation,
    input.kind === "save" ? input.throughSeq : (input.afterSaveId ?? generations),
  ];
  const id = `history:${createHash("sha256").update(JSON.stringify(key)).digest("hex")}`;
  return prisma.$transaction(async (tx) => {
    await requirePrivateOwner(tx, context, context.botId);
    // Hold the source and connection stable until the dispatch intent is committed.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM space_memory_configs WHERE "spaceId" = ${context.spaceId} FOR SHARE`;
    const thread = await tx.thread.findFirst({
      where: {
        id: input.threadId,
        ...privateOwner(context),
        botId: context.botId,
        groupId: null,
      },
    });
    if (!thread) throw new IsolationError();
    const config = await tx.spaceMemoryConfig.findUnique({ where: { spaceId: context.spaceId } });
    if (
      !config ||
      config.provider !== binding.provider ||
      `${config.id}:${config.updatedAt.toISOString()}` !== binding.configurationRevision
    )
      throw new IsolationError();
    if (input.kind === "save") {
      if (
        thread.historyCompactionGeneration !== input.generation ||
        thread.historyCompactedUpToSeq !== input.throughSeq ||
        thread.historyCompactionSummary !== input.content
      )
        throw new IsolationError();
    } else {
      if (thread.historyCompactionGeneration < input.generation) throw new IsolationError();
      if (input.afterSaveId) {
        const save = await tx.semanticMemoryMutation.findFirst({
          where: {
            id: input.afterSaveId,
            ...privateOwner(context),
            botId: context.botId,
            sourceRunId: null,
            sourceThreadId: input.threadId,
            operation: "save",
            provider: binding.provider,
            configurationRevision: binding.configurationRevision,
          },
        });
        const source = SemanticMemoryHistorySource.safeParse(save?.request);
        if (
          !save ||
          !source.success ||
          generations.length !== 1 ||
          generations[0] !== source.data.source.generation
        )
          throw new IsolationError();
      }
    }
    const request =
      input.kind === "save"
        ? {
            ...binding,
            content: input.content,
            previousSummary: input.previousSummary,
            throughSeq: input.throughSeq,
            source: { kind: "history", generation: input.generation },
            reason: "Preserve compacted conversation context",
          }
        : {
            ...binding,
            generations,
            source: { kind: "history", generation: input.generation },
            ...(input.afterSaveId ? { afterSaveId: input.afterSaveId } : {}),
            reason: "Remove summaries from cleared conversation history",
          };
    await tx.semanticMemoryMutation.create({
      data: {
        id,
        ...privateOwner(context),
        ...binding,
        sourceRunId: null,
        sourceThreadId: input.threadId,
        operation: input.kind === "save" ? "save" : "forget",
        status: "uncertain",
        request,
      },
    });
    return id;
  });
}

/** No run ledger exists for compaction; preserve the outcome even if its source was cleared. */
export async function finishSemanticHistoryMutation(
  prisma: PrismaClient,
  context: AdapterContext,
  id: string,
  result: SemanticMemorySaveResponse | SemanticMemoryResponse,
) {
  if (!context.botId) throw new IsolationError();
  const uncertain =
    !result.ok && (!("uncertainEntities" in result) || result.uncertainEntities.length > 0);
  const updated = await prisma.semanticMemoryMutation.updateMany({
    where: {
      id,
      ...privateOwner(context),
      botId: context.botId,
      sourceRunId: null,
      status: "uncertain",
      result: { equals: Prisma.DbNull },
    },
    data: {
      status: uncertain ? "uncertain" : result.ok ? "completed" : "failed",
      result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
    },
  });
  if (updated.count !== 1) throw new Error("The history memory outcome could not be recorded.");
}
