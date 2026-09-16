import { createHash, randomUUID } from "node:crypto";
import type { CustomerRuntime } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

type Endpoint = { baseUrl: string; apiKey?: string };
export type CustomerRuntimeConfig = Endpoint & { knowledge?: Endpoint };
const nodeId = "RakazoCustomerAgent-runtime";
const componentName = "RakazoCustomerAgent";
const instructionsHash = (instructions: string) =>
  createHash("sha256").update(instructions).digest("hex");

/** Calls stock Langflow for execution and stock OpenRAG for scoped retrieval. */
export class LangflowCustomerRuntime implements CustomerRuntime {
  constructor(
    private readonly config: CustomerRuntimeConfig,
    private readonly request: typeof fetch = createOpenAiCompatibleFetch(),
  ) {}

  private async call(
    endpoint: Endpoint,
    path: string,
    signal: AbortSignal,
    input?: unknown,
  ): Promise<unknown> {
    const response = await this.request(`${endpoint.baseUrl.replace(/\/$/, "")}/${path}`, {
      method: input === undefined ? "GET" : "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        ...(endpoint.apiKey ? { "x-api-key": endpoint.apiKey } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (!response.ok) throw new Error("Customer reply service is unavailable");
    const body = await readBoundedText(response, path === "all" ? 16_000_000 : 1_000_000);
    if (body.truncated) throw new Error("Customer runtime response exceeded the size limit");
    return JSON.parse(body.text);
  }

  async publish(input: Parameters<NonNullable<CustomerRuntime["publish"]>>[0]) {
    if (input.knowledgeFilterId) await this.knowledgeFilters(input.knowledgeFilterId, input.signal);
    // Use the deployed component's schema. Never submit source code supplied by a caller.
    const catalog = z
      .object({ rakazo: z.record(z.string(), z.unknown()).optional() })
      .parse(await this.call(this.config, "all", input.signal));
    const componentType = `ext:rakazo:${componentName}@extra`;
    const installed = catalog.rakazo?.[componentType];
    if (!installed) throw new Error("Install the Rakazo customer component in Langflow");
    const component = z
      .object({ template: z.record(z.string(), z.unknown()) })
      .passthrough()
      .parse(installed);
    const field = z.object({ value: z.unknown().optional() }).passthrough();
    const protocol = field.parse(component.template.protocol_version);
    if (protocol.value !== "1") throw new Error("Unsupported Rakazo customer component version");
    for (const name of [
      "instructions",
      "transcript",
      "execution_endpoint",
      "execution_token",
      "model_base",
      "model_key",
      "model_id",
    ])
      field.parse(component.template[name]);
    const template = {
      ...component.template,
      instructions: { ...field.parse(component.template.instructions), value: input.instructions },
    };
    const result = z.object({ id: z.string().uuid() }).parse(
      await this.call(this.config, "flows/", input.signal, {
        name: `Customer ${input.staffId} ${randomUUID()}`,
        description: `Rakazo customer protocol 1; instructions ${instructionsHash(input.instructions)}`,
        is_component: false,
        data: {
          nodes: [
            {
              id: nodeId,
              type: "genericNode",
              position: { x: 0, y: 0 },
              data: { id: nodeId, type: componentType, node: { ...component, template } },
            },
          ],
          edges: [],
        },
      }),
    );
    return `langflow:1:${result.id}:${instructionsHash(input.instructions)}`;
  }

  private async knowledgeFilters(id: string, signal: AbortSignal) {
    if (!this.config.knowledge)
      throw new Error("Configure a separate OpenRAG knowledge connection");
    const response = z
      .object({ filter: z.object({ query_data: z.unknown() }) })
      .parse(
        await this.call(
          this.config.knowledge,
          `knowledge-filters/${encodeURIComponent(id)}`,
          signal,
        ),
      );
    const raw = response.filter.query_data;
    const query = z
      .object({
        filters: z.object({
          data_sources: z.array(z.string().trim().min(1)).min(1),
          document_types: z.array(z.string()).optional(),
          owners: z.array(z.string()).optional(),
          connector_types: z.array(z.string()).optional(),
        }),
      })
      .parse(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (Object.values(query.filters).some((values) => values?.some((value) => /[*?]/.test(value))))
      throw new Error("Customer knowledge requires explicit data sources");
    return query.filters;
  }

  async search(input: Parameters<NonNullable<CustomerRuntime["search"]>>[0]) {
    const filters = await this.knowledgeFilters(input.knowledgeFilterId, input.signal);
    // Pass the checked concrete filters, avoiding a second mutable filter lookup upstream.
    return this.call(this.config.knowledge!, "search", input.signal, {
      query: input.query,
      filters,
      limit: 10,
    });
  }

  async reply(input: Parameters<CustomerRuntime["reply"]>[0]): Promise<string> {
    const match = /^langflow:1:([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(input.flowId);
    if (!match || match[2] !== instructionsHash(input.instructions))
      throw new Error("Republish customer behavior for the Langflow runtime");
    if (!input.executionContext || !input.model)
      throw new Error("Customer execution credentials are required");
    const sessionId = randomUUID();
    const response = await this.call(this.config, `run/${match[1]}?stream=false`, input.signal, {
      input_type: "chat",
      output_type: "chat",
      output_component: nodeId,
      session_id: sessionId,
      tweaks: {
        [nodeId]: {
          // Reassert the committed revision's instructions even if an operator edits a flow.
          instructions: input.instructions,
          transcript: JSON.stringify(input.messages),
          execution_endpoint: input.executionContext.endpoint,
          execution_token: input.executionContext.token,
          model_base: input.model.baseUrl,
          model_key: input.model.apiKey,
          model_id: input.model.id,
        },
      },
    });
    const result = z
      .object({
        session_id: z.literal(sessionId),
        outputs: z
          .array(
            z.object({
              outputs: z
                .array(
                  z.object({
                    component_id: z.literal(nodeId),
                    outputs: z.object({
                      message: z.object({
                        message: z.string().trim().min(1).max(16_000),
                        type: z.literal("text"),
                      }),
                    }),
                  }),
                )
                .length(1),
            }),
          )
          .length(1),
      })
      .parse(response);
    return result.outputs[0]!.outputs[0]!.outputs.message.message;
  }
}
