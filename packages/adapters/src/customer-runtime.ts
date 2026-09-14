import type { CustomerRuntime } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

/** Use OpenRAG chat so model, retrieval, and tool configuration remain in OpenRAG. */
export class OpenRagCustomerRuntime implements CustomerRuntime {
  constructor(
    private readonly config: { baseUrl: string; apiKey?: string },
    private readonly request: typeof fetch = createOpenAiCompatibleFetch(),
  ) {}

  private async post(path: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(`${this.config.baseUrl.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("Customer reply service is unavailable");
    const body = await readBoundedText(response, 1_000_000);
    if (body.truncated) throw new Error("Customer runtime response exceeded the size limit");
    return JSON.parse(body.text);
  }

  async publish(input: {
    staffId: string;
    instructions: string;
    knowledgeFilterId?: string;
    signal: AbortSignal;
  }) {
    const result = await this.post(
      "customer/flows",
      {
        staff_id: input.staffId,
        instructions: input.instructions,
        knowledge_filter_id: input.knowledgeFilterId,
      },
      input.signal,
    );
    return z.object({ flow_id: z.string().min(1) }).parse(result).flow_id;
  }

  async search(input: { query: string; knowledgeFilterId: string; signal: AbortSignal }) {
    return this.post(
      "customer/search",
      { query: input.query, filter_id: input.knowledgeFilterId, limit: 10 },
      input.signal,
    );
  }

  async reply(input: Parameters<CustomerRuntime["reply"]>[0]): Promise<string> {
    // A fresh upstream session replays only the scoped public transcript.
    const response = await this.post(
      "chat",
      {
        flow_id: input.flowId,
        ...(input.executionContext ? { execution_context: input.executionContext } : {}),
        ...(input.knowledgeFilterId
          ? { filter_id: input.knowledgeFilterId }
          : { filters: { _id: ["rakazo:no-customer-knowledge"] } }),
        stream: false,
        message: JSON.stringify({
          instructions: input.instructions,
          conversation: input.conversationId,
          messages: input.messages,
        }),
      },
      input.signal,
    );
    const result = z
      .object({
        flow_id: z.literal(input.flowId),
        response: z.string().trim().min(1).max(16_000),
      })
      .parse(response);
    return result.response;
  }
}
