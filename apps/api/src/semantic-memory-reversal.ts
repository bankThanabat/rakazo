import { ORPCError } from "@orpc/server";
import type {
  AdapterContext,
  SemanticMemoryForgetResponse,
  SemanticMemorySaveResponse,
} from "@rakazo/adapter-kit";
import type { MemoryProviderResolver } from "@rakazo/adapters";
import { SemanticMemoryReversalApplyInput, SemanticMemoryReversalInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  beginStaffSemanticReversal,
  finishSemanticMemoryMutation,
  previewStaffSemanticReversal,
  SemanticMemoryUndoError,
  validateStaffSemanticReversal,
} from "@rakazo/db";

/** Direct owner review uses the same inverse derivation and provider operations as the staff tool. */
export function createSemanticMemoryReversal(
  prisma: PrismaClient,
  providers: MemoryProviderResolver,
) {
  async function configured(context: AdapterContext) {
    const memory = await providers.resolve(context.spaceId);
    if (!memory)
      throw new ORPCError("CONFLICT", { message: "The memory provider is unavailable." });
    return {
      memory,
      connection: {
        provider: memory.provider.describe().id,
        configurationRevision: memory.configurationRevision,
        supportedActions: [
          ...(memory.provider.forget ? ["forget" as const] : []),
          ...(memory.provider.restore ? ["restore" as const] : []),
        ],
      },
    };
  }
  async function run<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SemanticMemoryUndoError)
        throw new ORPCError("CONFLICT", { message: error.message });
      throw error;
    }
  }
  return {
    preview(context: AdapterContext, raw: unknown) {
      return run(async () => {
        const input = SemanticMemoryReversalInput.parse(raw);
        const { connection } = await configured(context);
        const preview = await previewStaffSemanticReversal(
          prisma,
          { ...context, botId: input.botId },
          connection,
          input,
        );
        return preview;
      });
    },
    apply(context: AdapterContext, raw: unknown) {
      return run(async () => {
        const input = SemanticMemoryReversalApplyInput.parse(raw);
        const owner = { ...context, botId: input.botId };
        const { connection } = await configured(owner);
        const intent = await beginStaffSemanticReversal(prisma, owner, connection, input);
        if (intent.dispatch) {
          const { request } = intent;
          const operation = {
            botId: input.botId,
            id: request.id,
            entity: request.entity,
            expectedContent: request.expectedContent,
            scope: request.scope,
            reason: request.reason,
          };
          let result: SemanticMemoryForgetResponse | SemanticMemorySaveResponse;
          let current: Awaited<ReturnType<typeof configured>> | undefined;
          try {
            current = await configured(owner);
            await validateStaffSemanticReversal(prisma, owner, current.connection, intent.id);
          } catch {
            current = undefined;
            result = {
              ok: false,
              error: "Memory access or configuration changed before dispatch.",
            };
            await finishSemanticMemoryMutation(prisma, owner, intent.id, result);
          }
          if (current) {
            try {
              result =
                request.action === "restore"
                  ? await current.memory.provider.restore!(operation, owner)
                  : await current.memory.provider.forget!(operation, owner);
            } catch {
              result =
                request.action === "restore"
                  ? {
                      ok: false,
                      error: "The provider did not confirm restoration.",
                      receipts: [],
                      uncertainEntities: [request.entity],
                    }
                  : { ok: false, error: "The provider did not confirm removal.", uncertain: true };
            }
            await finishSemanticMemoryMutation(prisma, owner, intent.id, result);
          }
        }
        const row = await prisma.semanticMemoryMutation.findUniqueOrThrow({
          where: { id: intent.id },
          select: { status: true },
        });
        return {
          mutationId: intent.id,
          status: row.status as "completed" | "failed" | "uncertain",
        };
      });
    },
  };
}
