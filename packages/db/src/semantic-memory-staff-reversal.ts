import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  SemanticMemoryReversalApplyInput,
  SemanticMemoryReversalInput,
  SemanticMemoryStaffSource,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { effectiveMemoryScope } from "./memory-config.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { IsolationError } from "./scope.js";
import {
  SemanticMemoryUndoError,
  semanticMemoryReversalKey,
  semanticMemoryUndoRequest,
} from "./semantic-memory-undo.js";

type Connection = {
  provider: string;
  configurationRevision: string;
  supportedActions: readonly ("forget" | "restore")[];
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function review(
  tx: Prisma.TransactionClient,
  context: AdapterContext,
  connection: Connection,
  raw: unknown,
  reservationId?: string,
) {
  const input = SemanticMemoryReversalInput.parse(raw);
  if (context.runId || context.botId !== input.botId) throw new IsolationError();
  await requirePrivateOwner(tx, context, input.botId);
  await tx.$queryRaw`SELECT id FROM space_memory_configs WHERE "spaceId" = ${context.spaceId} FOR SHARE`;
  const config = await tx.spaceMemoryConfig.findUnique({ where: { spaceId: context.spaceId } });
  const bot = await tx.bot.findUniqueOrThrow({
    where: { id: input.botId },
    select: { memoryScope: true },
  });
  if (
    !config ||
    config.provider !== connection.provider ||
    `${config.id}:${config.updatedAt.toISOString()}` !== connection.configurationRevision
  )
    throw new SemanticMemoryUndoError("Memory configuration changed. Review the change again.");
  const request = await semanticMemoryUndoRequest(
    tx,
    context,
    {
      botId: input.botId,
      scope: effectiveMemoryScope(bot.memoryScope, config.defaultMemoryScope),
      provider: connection.provider,
      configurationRevision: connection.configurationRevision,
    },
    input,
    reservationId,
  );
  if (!connection.supportedActions.includes(request.action))
    throw new SemanticMemoryUndoError("This provider cannot reverse the recorded change.");
  return { request, version: hash([privateOwner(context), request]) };
}

export async function previewStaffSemanticReversal(
  prisma: PrismaClient,
  context: AdapterContext,
  connection: Connection,
  raw: unknown,
) {
  return prisma.$transaction(async (tx) => {
    const { request, version } = await review(tx, context, connection, raw);
    return {
      version,
      action: request.action,
      content: request.expectedContent,
      provider: request.provider,
      scope: request.scope,
    };
  });
}

/** Reserve one explicit staff approval before dispatch, including retries after lost responses. */
export async function beginStaffSemanticReversal(
  prisma: PrismaClient,
  context: AdapterContext,
  connection: Connection,
  raw: unknown,
) {
  const input = SemanticMemoryReversalApplyInput.parse(raw);
  if (context.runId || context.botId !== input.botId) throw new IsolationError();
  const id = `staff:${hash([privateOwner(context), input.botId, input.clientNonce])}`;
  const reserve = () =>
    prisma.$transaction(async (tx) => {
      await requirePrivateOwner(tx, context, input.botId);
      const existing = await tx.semanticMemoryMutation.findUnique({ where: { id } });
      if (existing) {
        const source = SemanticMemoryStaffSource.safeParse(existing.request);
        const previous = SemanticMemoryReversalInput.safeParse(existing.request);
        if (
          !source.success ||
          source.data.source.reviewVersion !== input.version ||
          !previous.success ||
          JSON.stringify(previous.data) !== JSON.stringify(SemanticMemoryReversalInput.parse(input))
        )
          throw new SemanticMemoryUndoError(
            "This request identifier was already used for another review.",
          );
        return {
          id,
          status: existing.status as "completed" | "failed" | "uncertain",
          dispatch: false as const,
        };
      }
      const { request, version } = await review(tx, context, connection, input);
      if (version !== input.version)
        throw new SemanticMemoryUndoError("The reviewed memory change is stale. Review it again.");
      const thread = await tx.thread.findFirst({
        where: { ...privateOwner(context), botId: input.botId, groupId: null },
      });
      if (!thread) throw new IsolationError();
      await tx.semanticMemoryMutation.create({
        data: {
          id,
          ...privateOwner(context),
          botId: input.botId,
          sourceRunId: null,
          sourceThreadId: thread.id,
          operation: request.action === "restore" ? "undo_forget" : "undo_save",
          reversesId: request.mutationId,
          reversalKey: semanticMemoryReversalKey(request),
          provider: request.provider,
          configurationRevision: request.configurationRevision,
          scope: request.scope,
          status: "uncertain",
          request: { ...request, source: { kind: "staff", reviewVersion: version } },
        },
      });
      return { id, status: "uncertain" as const, dispatch: true as const, request };
    });
  try {
    return await reserve();
  } catch (error) {
    // A concurrent identical nonce returns the winner; another nonce finds the reversal fence.
    if (
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
      (error instanceof SemanticMemoryUndoError && error.previousUndo?.id === id)
    )
      return reserve();
    throw error;
  }
}

/** Recheck retained approval and live ownership/configuration after reservation, before transport. */
export async function validateStaffSemanticReversal(
  prisma: PrismaClient,
  context: AdapterContext,
  connection: Connection,
  id: string,
) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.semanticMemoryMutation.findFirst({
      where: {
        id,
        ...privateOwner(context),
        botId: context.botId,
        sourceRunId: null,
        status: "uncertain",
      },
    });
    if (!row || row.result !== null) throw new IsolationError();
    const source = SemanticMemoryStaffSource.parse(row.request);
    const current = await review(tx, context, connection, row.request, id);
    if (current.version !== source.source.reviewVersion)
      throw new SemanticMemoryUndoError("The reviewed memory change is stale. Review it again.");
  });
}
