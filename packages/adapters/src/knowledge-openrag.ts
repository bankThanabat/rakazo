import type { KnowledgeProvider } from "@rakazo/adapter-kit";
import { KnowledgeRejectedError } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

export function knowledgeEndpoint(value: string): string {
  const url = assertAllowedOpenAiCompatibleUrl(value);
  assertHttpsForKeyedOpenAiCompatibleUrl(url, "present");
  return url.toString().replace(/\/$/, "");
}

/** Stock OpenRAG API. A revision key is immutable and unique across all libraries. */
export class OpenRagKnowledgeProvider implements KnowledgeProvider {
  private readonly baseUrl: string;
  constructor(
    config: { baseUrl: string; apiKey: string },
    private readonly request: typeof fetch = createOpenAiCompatibleFetch(),
  ) {
    this.baseUrl = knowledgeEndpoint(config.baseUrl);
    this.apiKey = config.apiKey;
  }
  private readonly apiKey: string;

  private async call(
    path: string,
    signal: AbortSignal,
    method = "GET",
    body?: BodyInit,
    missingDocumentKey?: string,
  ) {
    const response = await this.request(`${this.baseUrl}/${path}`, {
      method,
      body,
      signal,
      redirect: "error",
      headers: {
        "x-api-key": this.apiKey,
        ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
      },
    });
    const missing = method === "DELETE" && response.status === 404 && missingDocumentKey;
    if (!response.ok && !missing) {
      const message = "Knowledge service is unavailable";
      // A 4xx answer means the service refused the request instead of losing it.
      throw response.status < 500 ? new KnowledgeRejectedError(message) : new Error(message);
    }
    const result = await readBoundedText(response, 1_000_000);
    if (result.truncated) throw new Error("Knowledge response exceeded the size limit");
    const value = result.text ? JSON.parse(result.text) : {};
    if (missing) {
      const absent = z
        .object({
          success: z.literal(false),
          deleted_chunks: z.literal(0),
          filename: z.literal(missingDocumentKey),
          error: z.string().startsWith("No matching document chunks were deleted."),
        })
        .safeParse(value);
      if (!absent.success) throw new Error("Knowledge service is unavailable");
    }
    return value;
  }

  async ingest(input: Parameters<KnowledgeProvider["ingest"]>[0]) {
    const body = new FormData();
    body.append(
      "file",
      new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
      input.key,
    );
    body.append("replace_duplicates", "false");
    return z
      .object({ task_id: z.string().min(1) })
      .parse(await this.call("documents/ingest", input.signal, "POST", body)).task_id;
  }

  async status(taskId: string, key: string, signal: AbortSignal) {
    const task = z
      .object({
        status: z.string(),
        files: z.record(z.string(), z.object({ filename: z.string(), status: z.string() })),
      })
      .parse(await this.call(`tasks/${encodeURIComponent(taskId)}`, signal));
    const files = Object.values(task.files).filter((file) => file.filename === key);
    if (files.length === 1 && files[0]!.status === "completed" && task.status === "completed")
      return "ready";
    if (
      ["failed", "cancelled", "completed"].includes(task.status) ||
      files.some((f) => ["failed", "cancelled"].includes(f.status))
    )
      return "failed";
    return "processing";
  }

  async search(query: string, keys: string[], signal: AbortSignal) {
    if (!keys.length) return [];
    if (keys.some((key) => !key || /[*?]/.test(key))) throw new Error("Knowledge scope is invalid");
    const result = z
      .object({
        results: z
          .array(
            z.object({
              filename: z.string(),
              text: z.string().max(100_000),
              page: z.number().int().positive().nullish(),
            }),
          )
          .max(10),
      })
      .parse(
        await this.call(
          "search",
          signal,
          "POST",
          JSON.stringify({
            query,
            filters: { data_sources: keys },
            limit: 8,
          }),
        ),
      );
    // Never accept unexpected content even if a provider ignores the filter.
    if (result.results.some((hit) => !keys.includes(hit.filename)))
      throw new Error("Knowledge result is outside the permitted sources");
    return result.results.map((hit) => ({
      key: hit.filename,
      text: hit.text,
      ...(hit.page ? { page: hit.page } : {}),
    }));
  }

  async remove(key: string, signal: AbortSignal) {
    await this.call("documents", signal, "DELETE", JSON.stringify({ filename: key }), key);
  }
}
