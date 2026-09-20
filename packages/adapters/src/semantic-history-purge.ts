import type { AdapterContext, SemanticMemoryResponse } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beginSemanticHistoryMutation, finishSemanticHistoryMutation } from "@rakazo/db";
import type { ConfiguredMemoryProvider } from "./memory-provider-factory.js";

/** Clear only already-withdrawn generations, with durable intent before transport. */
export async function purgeSemanticHistory(
  prisma: PrismaClient,
  configured: ConfiguredMemoryProvider,
  context: AdapterContext,
  input: { threadId: string; generation: number; generations: number[]; afterSaveId?: string },
): Promise<SemanticMemoryResponse> {
  const id = await beginSemanticHistoryMutation(
    prisma,
    context,
    {
      botId: context.botId,
      scope: "isolated",
      provider: configured.provider.describe().id,
      configurationRevision: configured.configurationRevision,
    },
    { ...input, kind: "purge" },
  );
  let result: SemanticMemoryResponse;
  try {
    result = await configured.provider.purgeHistory(
      { botId: context.botId!, generations: input.generations },
      context,
    );
  } catch {
    result = { ok: false, error: "The provider did not confirm removal of conversation memory." };
  }
  await finishSemanticHistoryMutation(prisma, context, id, result);
  return result;
}
