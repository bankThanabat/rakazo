import type { SemanticMemoryForgetResponse, SemanticMemorySaveResponse } from "@rakazo/adapter-kit";
import { z } from "zod";
import { combineMemorySaves } from "./memory-save-result.js";
import { readBodyCapped } from "./web-ssrf.js";

const SUPERMEMORY_TIMEOUT_MS = 15_000;

/** Search responses contain at most five bounded memories plus small metadata. */
export const MAX_SUPERMEMORY_RESPONSE_BYTES = 1024 * 1024;

/** How many recalled memories a search asks for, and the most that are ever injected into a run. */
export const MAX_RECALLED_MEMORIES = 5;

/** Supermemory rejects memory content longer than this. */
export const MAX_MEMORY_CONTENT_CHARS = 10_000;

export interface SupermemoryResult {
  memory: string;
  similarity: number;
  updatedAt?: string;
  id?: string;
  entity?: string;
}

export type SupermemorySearchResponse =
  | { ok: true; results: SupermemoryResult[] }
  | { ok: false; error: string };

type SupermemoryDeleteResponse = { ok: true } | { ok: false; error: string };
export type SupermemoryProbeResponse = { ok: true } | { ok: false; error: string };

export interface SupermemoryConnectionConfig {
  baseUrl: string;
  apiKey: string;
}

/** Base URLs are route prefixes, never credentials or request query/fragment state. */
export function parseSupermemoryBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    // search/hash are empty for a bare ?/#, but those delimiters still swallow appended routes.
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error(
      "Memory base URL must use HTTP(S) without credentials, a query, or a fragment.",
    );
  }
  return url;
}

function requestUrl(baseUrl: string, path: string): string {
  const url = parseSupermemoryBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url.href;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function boundedRecallLimit(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)), MAX_RECALLED_MEMORIES);
}

function unreachableError(error: unknown): string {
  return `Supermemory is unreachable: ${error instanceof Error ? error.message : String(error)}`;
}

function authHeaders(config: SupermemoryConnectionConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

function parseSearchResults(data: unknown, containerTag: string): SupermemoryResult[] {
  if (!data || typeof data !== "object") return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const parsed: SupermemoryResult[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      id?: unknown;
      memory?: unknown;
      chunk?: unknown;
      similarity?: unknown;
      updatedAt?: unknown;
    };
    const text =
      typeof row.memory === "string" ? row.memory : typeof row.chunk === "string" ? row.chunk : "";
    if (!text.trim()) continue;
    const memory = text.slice(0, MAX_MEMORY_CONTENT_CHARS);
    // Chunk IDs identify documents, not v4 memory entries. Never attach an
    // actionable identity to a truncated snapshot either.
    const hasCompleteIdentity =
      typeof row.memory === "string" &&
      text.length <= MAX_MEMORY_CONTENT_CHARS &&
      typeof row.id === "string" &&
      row.id.length > 0 &&
      row.id.length <= 500;
    parsed.push({
      memory,
      ...(hasCompleteIdentity ? { id: row.id as string, entity: containerTag } : {}),
      similarity: typeof row.similarity === "number" ? row.similarity : 0,
      ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    });
  }
  return parsed;
}

export async function searchSupermemory(
  query: string,
  containerTag: string,
  config: SupermemoryConnectionConfig,
  limit = MAX_RECALLED_MEMORIES,
  signal?: AbortSignal,
): Promise<SupermemorySearchResponse> {
  try {
    const requestAbort = requestSignal(signal);
    const response = await fetch(requestUrl(config.baseUrl, "/v4/search"), {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({
        q: query,
        containerTag,
        searchMode: "memories",
        limit: boundedRecallLimit(limit),
      }),
      redirect: "error",
      signal: requestAbort,
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory search failed: ${response.status}` };
    }
    return {
      ok: true,
      results: parseSearchResults(await readSupermemoryJson(response, requestAbort), containerTag),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Supermemory response is too large.") {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: unreachableError(error) };
  }
}

async function readSupermemoryJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SUPERMEMORY_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Supermemory response is too large.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(response, MAX_SUPERMEMORY_RESPONSE_BYTES, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Supermemory response is too large.");
    }
    throw error;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function searchSupermemoryContainers(
  query: string,
  containerTags: string[],
  config: SupermemoryConnectionConfig,
  limit = MAX_RECALLED_MEMORIES,
  signal?: AbortSignal,
): Promise<SupermemorySearchResponse> {
  const boundedLimit = boundedRecallLimit(limit);
  const responses = await Promise.all(
    containerTags.map((containerTag) =>
      searchSupermemory(query, containerTag, config, boundedLimit, signal),
    ),
  );
  const successful = responses.filter(
    (response): response is Extract<SupermemorySearchResponse, { ok: true }> => response.ok,
  );
  if (successful.length === 0) {
    return {
      ok: false,
      error: responses
        .filter(
          (response): response is Extract<SupermemorySearchResponse, { ok: false }> => !response.ok,
        )
        .map((response) => response.error)
        .join("; "),
    };
  }
  const byMemory = new Map<string, SupermemoryResult>();
  for (const result of successful.flatMap((response) => response.results)) {
    // Equal text in different namespaces represents independently removable facts.
    const key = result.id
      ? JSON.stringify([result.entity, result.id])
      : JSON.stringify([result.memory]);
    const existing = byMemory.get(key);
    if (!existing || result.similarity > existing.similarity) byMemory.set(key, result);
  }
  return {
    ok: true,
    results: [...byMemory.values()]
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, boundedLimit),
  };
}

const listedMemory = z.object({
  id: z.string().min(1),
  memory: z.string(),
  isLatest: z.boolean(),
  isForgotten: z.boolean(),
});
const memoryListResponse = z.object({
  memoryEntries: z.array(listedMemory.extend({ history: z.array(listedMemory).optional() })),
  pagination: z.object({
    currentPage: z.number().int().min(1),
    totalPages: z.number().int().min(0),
    totalItems: z.number().int().min(0),
  }),
});

/** Bounded inspection shared by removal and restoration. */
async function findSupermemoryFact(
  id: string,
  containerTags: string[],
  config: SupermemoryConnectionConfig,
  signal: AbortSignal,
): Promise<
  | {
      ok: true;
      value: {
        entity: string;
        fact: z.infer<typeof memoryListResponse>["memoryEntries"][number];
      } | null;
    }
  | { ok: false; error: string }
> {
  for (const containerTag of containerTags) {
    for (let page = 1; page <= 100; page++) {
      signal.throwIfAborted();
      const response = await fetch(requestUrl(config.baseUrl, "/v4/memories/list"), {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify({ containerTags: [containerTag], page, limit: 50 }),
        redirect: "error",
        signal,
      });
      if (!response.ok)
        return { ok: false, error: `Supermemory inspection failed: ${response.status}` };
      const parsed = memoryListResponse.safeParse(await readSupermemoryJson(response, signal));
      if (!parsed.success || parsed.data.pagination.currentPage !== page)
        return { ok: false, error: "Supermemory returned an invalid inspection page." };
      if (
        parsed.data.memoryEntries.some((entry) =>
          entry.history?.some((version) => version.id === id),
        )
      )
        return {
          ok: false,
          error:
            "The recorded fact has a newer version. Review that change before a selective reversal.",
        };
      const fact = parsed.data.memoryEntries.find((entry) => entry.id === id);
      if (fact) return { ok: true, value: { entity: containerTag, fact } };
      if (page >= parsed.data.pagination.totalPages) break;
      if (page === 100)
        return {
          ok: false,
          error: "Supermemory inspection reached its page limit. No change was attempted.",
        };
    }
  }
  return { ok: true, value: null };
}

/** One deadline covers lookup pages and deletion. Unsupported list APIs fail before mutation. */
export async function forgetSupermemoryMemory(
  request: { id: string; expectedContent: string; containerTags: string[]; reason?: string },
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SemanticMemoryForgetResponse> {
  let dispatched = false;
  try {
    const requestAbort = requestSignal(signal);
    const found = await findSupermemoryFact(
      request.id,
      request.containerTags,
      config,
      requestAbort,
    );
    if (!found.ok) return found;
    if (!found.value)
      return {
        ok: false,
        error: "The fact is unavailable in this scope. Recall it again before requesting removal.",
      };
    const { fact, entity } = found.value;
    if (!fact.isLatest || fact.isForgotten || fact.memory !== request.expectedContent)
      return { ok: false, error: "The fact changed or is no longer current. Recall it again." };
    requestAbort.throwIfAborted();
    // The API scopes deletion, but does not promise atomic compare-and-delete.
    dispatched = true;
    const removed = await fetch(requestUrl(config.baseUrl, "/v4/memories"), {
      method: "DELETE",
      headers: authHeaders(config),
      body: JSON.stringify({ id: request.id, containerTag: entity, reason: request.reason }),
      redirect: "error",
      signal: requestAbort,
    });
    if (!removed.ok)
      return {
        ok: false,
        error: `Supermemory removal was not confirmed (${removed.status}). Inspect the fact before trying again.`,
        uncertain: true,
      };
    const receipt = z
      .object({ id: z.string(), forgotten: z.literal(true) })
      .safeParse(await readSupermemoryJson(removed, requestAbort));
    if (!receipt.success || receipt.data.id !== request.id)
      return {
        ok: false,
        error: "Supermemory did not confirm this fact's removal. Inspect it before trying again.",
        uncertain: true,
      };
    return {
      ok: true,
      value: { id: request.id, entity, expired: true, reason: request.reason ?? null },
    };
  } catch (error) {
    return {
      ok: false,
      ...(dispatched ? { uncertain: true as const } : {}),
      error: dispatched
        ? "Supermemory removal could not be confirmed. Inspect the fact before trying again."
        : unreachableError(error),
    };
  }
}

/** Recreate only the reviewed fact. Other versions and unrelated facts are never replaced. */
export async function restoreSupermemoryMemory(
  request: { id: string; expectedContent: string; entity: string },
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SemanticMemorySaveResponse> {
  let inspection: Awaited<ReturnType<typeof findSupermemoryFact>>;
  const requestAbort = requestSignal(signal);
  try {
    inspection = await findSupermemoryFact(request.id, [request.entity], config, requestAbort);
  } catch {
    return {
      ok: false,
      error: "The original destination could not be inspected. No restoration was attempted.",
      receipts: [],
      uncertainEntities: [],
    };
  }
  if (!inspection.ok) return { ...inspection, receipts: [], uncertainEntities: [] };
  if (
    inspection.value &&
    (!inspection.value.fact.isForgotten ||
      !inspection.value.fact.isLatest ||
      inspection.value.fact.memory !== request.expectedContent)
  )
    return {
      ok: false,
      error: "The removed fact is active or changed. Inspect it before restoring.",
      receipts: [],
      uncertainEntities: [],
    };
  const saved = await saveSupermemoryMemory(
    request.expectedContent,
    request.entity,
    config,
    requestAbort,
  );
  if (saved.ok && saved.value.some((receipt) => receipt.content !== request.expectedContent))
    return {
      ok: false,
      error:
        "The provider saved different content. Inspect the recorded receipt before another action.",
      receipts: saved.value,
      uncertainEntities: [request.entity],
    };
  return saved;
}

/** Deletes every memory in a container, e.g. after the conversation they summarize is cleared. */
export async function deleteSupermemoryContainer(
  containerTag: string,
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SupermemoryDeleteResponse> {
  try {
    const response = await fetch(
      requestUrl(config.baseUrl, `/v3/container-tags/${encodeURIComponent(containerTag)}`),
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        redirect: "error",
        signal: requestSignal(signal),
      },
    );
    if (!response.ok) {
      return { ok: false, error: `Supermemory container delete failed: ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}

export async function saveSupermemoryMemory(
  content: string,
  containerTag: string,
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SemanticMemorySaveResponse> {
  // Preserve the submitted version. Reject rather than silently saving a prefix.
  if (!content.trim() || content.length > MAX_MEMORY_CONTENT_CHARS) {
    return {
      ok: false,
      error: "Memory content must contain 1 to 10000 characters.",
      receipts: [],
      uncertainEntities: [],
    };
  }
  let dispatched = false;
  try {
    const url = requestUrl(config.baseUrl, "/v4/memories");
    const requestAbort = requestSignal(signal);
    requestAbort.throwIfAborted();
    dispatched = true;
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ containerTag, memories: [{ content, isStatic: false }] }),
      redirect: "error",
      signal: requestAbort,
    });
    if (!response.ok) throw new Error(`Supermemory save was not confirmed (${response.status}).`);
    const receipt = z
      .object({
        memories: z
          .array(
            z.object({
              id: z.string().min(1).max(500),
              memory: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS),
            }),
          )
          .length(1),
      })
      .safeParse(await readSupermemoryJson(response, requestAbort));
    if (!receipt.success) throw new Error("Supermemory save returned an invalid receipt.");
    return {
      ok: true,
      value: receipt.data.memories.map((entry) => ({
        version: 1,
        id: entry.id,
        entity: containerTag,
        content: entry.memory,
        // Only the documented create status establishes a new entry. A compatible
        // endpoint may acknowledge an existing/deduplicated fact with another 2xx.
        created: response.status === 201 ? true : null,
      })),
    };
  } catch {
    return {
      ok: false,
      error: dispatched
        ? "Supermemory save was not confirmed. Inspect the destination before trying again."
        : "Supermemory save did not start.",
      receipts: [],
      uncertainEntities: dispatched ? [containerTag] : [],
    };
  }
}

export async function saveSupermemoryMemoryToContainers(
  content: string,
  containerTags: string[],
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SemanticMemorySaveResponse> {
  return combineMemorySaves(
    await Promise.all(
      [...new Set(containerTags)].map((containerTag) =>
        saveSupermemoryMemory(content, containerTag, config, signal),
      ),
    ),
  );
}

export async function probeSupermemory(
  config: SupermemoryConnectionConfig,
): Promise<SupermemoryProbeResponse> {
  try {
    const response = await fetch(requestUrl(config.baseUrl, "/v3/container-tags/list"), {
      method: "GET",
      headers: authHeaders(config),
      redirect: "error",
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `Supermemory rejected the connection: ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}
