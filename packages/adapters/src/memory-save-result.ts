import type {
  AdapterContext,
  SemanticMemoryResponse,
  SemanticMemoryRestoreRequest,
  SemanticMemorySaveRequest,
  SemanticMemorySaveResponse,
} from "@rakazo/adapter-kit";

/** Adapters never derive a writable namespace from an unbound or malformed request. */
export function validateMemorySaveScope(
  request: SemanticMemorySaveRequest,
  context: AdapterContext,
): Extract<SemanticMemorySaveResponse, { ok: false }> | null {
  if (
    !context.botId ||
    request.botId !== context.botId ||
    !["isolated", "shared"].includes(request.scope) ||
    !request.source ||
    (request.source.kind !== "durable" && request.source.kind !== "history") ||
    (request.source.kind === "history" &&
      (!Number.isSafeInteger(request.source.generation) || request.source.generation < 0))
  ) {
    return {
      ok: false,
      error: "A valid memory scope bound to the current bot is required.",
      receipts: [],
      uncertainEntities: [],
    };
  }
  return null;
}

/** Shared writes retain each acknowledgement; an error never erases a successful sibling. */
export function combineMemorySaves(
  results: SemanticMemorySaveResponse[],
): SemanticMemorySaveResponse {
  const receipts = results.flatMap((result) => (result.ok ? result.value : result.receipts));
  const failures = results.filter((result) => !result.ok);
  return failures.length === 0
    ? { ok: true, value: receipts }
    : {
        ok: false,
        error: failures.map((result) => result.error).join("; "),
        receipts,
        uncertainEntities: [...new Set(failures.flatMap((result) => result.uncertainEntities))],
      };
}

/** A history purge has the same trusted bot boundary as a save. */
export function validateMemoryPurgeScope(
  request: { botId: string; generations: number[] },
  context: AdapterContext,
): Extract<SemanticMemoryResponse, { ok: false }> | null {
  if (
    !context.botId ||
    request.botId !== context.botId ||
    !Array.isArray(request.generations) ||
    !request.generations.length ||
    request.generations.some((generation) => !Number.isSafeInteger(generation) || generation < 0)
  ) {
    return { ok: false, error: "A valid history scope bound to the current bot is required." };
  }
  return null;
}

export function validateMemoryRestoreScope(
  request: SemanticMemoryRestoreRequest,
  context: AdapterContext,
  entities: string[],
): Extract<SemanticMemorySaveResponse, { ok: false }> | null {
  if (
    !context.botId ||
    request.botId !== context.botId ||
    !["isolated", "shared"].includes(request.scope) ||
    !request.id ||
    !entities.includes(request.entity) ||
    !request.expectedContent?.trim() ||
    request.expectedContent.length > 10000 ||
    context.signal.aborted
  ) {
    return {
      ok: false,
      error:
        "A recorded removal with complete content in this bot's exact memory scope is required.",
      receipts: [],
      uncertainEntities: [],
    };
  }
  return null;
}
