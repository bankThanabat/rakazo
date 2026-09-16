import { afterEach, describe, expect, it, vi } from "vitest";
import { LangflowCustomerRuntime } from "./customer-runtime.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

const flowId = "11111111-1111-4111-8111-111111111111";
const componentId = "RakazoCustomerAgent-runtime";
const turn = {
  conversationId: "conversation-one",
  instructions: "Use approved knowledge and request human help when needed.",
  messages: [{ role: "user" as const, content: "What is on offer?" }],
  executionContext: {
    endpoint: "https://rakazo.example.test/api/customer-tools",
    token: "fixture-execution",
  },
  model: {
    baseUrl: "https://rakazo.example.test/api/model-bridge/v1",
    apiKey: "fixture-bridge",
    id: "fixture-model",
  },
  signal: new AbortController().signal,
};
function fixture() {
  const published: Record<string, unknown>[] = [];
  const runs: Record<string, any>[] = [];
  let sources = ["public-menu"];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/api/v1/all")
      return Response.json({
        rakazo: {
          "ext:rakazo:RakazoCustomerAgent@extra": {
            display_name: "Rakazo customer agent",
            template: Object.fromEntries([
              ["protocol_version", { value: "1" }],
              ...[
                "instructions",
                "transcript",
                "execution_endpoint",
                "execution_token",
                "model_base",
                "model_key",
                "model_id",
              ].map((name) => [name, { value: "" }]),
            ]),
          },
        },
      });
    if (path === "/api/v1/flows/") {
      published.push(body);
      return Response.json({ id: flowId });
    }
    if (path === `/api/v1/run/${flowId}`) {
      runs.push(body);
      return Response.json({
        session_id: body.session_id,
        outputs: [
          {
            outputs: [
              {
                component_id: componentId,
                outputs: { message: { message: "Friday offer", type: "text" } },
              },
            ],
          },
        ],
      });
    }
    if (path === "/v1/knowledge-filters/public")
      return Response.json({
        filter: { query_data: JSON.stringify({ filters: { data_sources: sources } }) },
      });
    if (path === "/v1/search") return Response.json({ results: [{ text: "Friday offer" }] });
    return new Response("unsupported stock API", { status: 404 });
  });
  const runtime = new LangflowCustomerRuntime(
    {
      baseUrl: "https://langflow.example.test/api/v1/",
      apiKey: "fixture-langflow-key",
      knowledge: { baseUrl: "https://rag.example.test/v1", apiKey: "fixture-rag-key" },
    },
    request,
  );
  return {
    runtime,
    request,
    published,
    runs,
    sources: (value: string[]) => {
      sources = value;
    },
    publish: () =>
      runtime.publish({ staffId: "staff", instructions: turn.instructions, signal: turn.signal }),
  };
}

describe("stock Langflow execution and OpenRAG knowledge", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("publishes a new revision and executes with isolated history, model and tool grants", async () => {
    const f = fixture();
    const ref = await f.publish();
    expect(await f.runtime.reply({ ...turn, flowId: ref })).toBe("Friday offer");
    await f.runtime.reply({ ...turn, flowId: ref });
    expect(f.published[0]).toMatchObject({
      is_component: false,
      data: {
        edges: [],
        nodes: [
          {
            data: {
              type: "ext:rakazo:RakazoCustomerAgent@extra",
              node: { template: { instructions: { value: turn.instructions } } },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(f.published)).not.toContain("fixture-execution");
    expect(JSON.stringify(f.published)).not.toContain("fixture-bridge");
    expect(f.runs[0]!.session_id).not.toBe(f.runs[1]!.session_id);
    expect(f.runs[0]).not.toHaveProperty("input_value");
    expect(f.runs[0]).toMatchObject({
      output_component: componentId,
      tweaks: {
        [componentId]: {
          transcript: JSON.stringify(turn.messages),
          execution_token: turn.executionContext.token,
          model_key: turn.model.apiKey,
          instructions: turn.instructions,
        },
      },
    });
    expect(f.request.mock.calls.at(-1)![1]).toMatchObject({
      redirect: "error",
      headers: { "x-api-key": "fixture-langflow-key" },
    });
  });
  it("rejects old fork references and mismatched instructions before executing", async () => {
    const f = fixture();
    const ref = await f.publish();
    f.request.mockClear();
    await expect(f.runtime.reply({ ...turn, flowId: "old-openrag-flow" })).rejects.toThrow(
      "Republish",
    );
    await expect(
      f.runtime.reply({ ...turn, instructions: "different", flowId: ref }),
    ).rejects.toThrow("Republish");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("never queries unscoped knowledge or sends a Langflow key to OpenRAG", async () => {
    const f = fixture();
    await f.runtime.search({ query: "menu", knowledgeFilterId: "public", signal: turn.signal });
    expect(f.request.mock.calls.at(-1)).toMatchObject([
      "https://rag.example.test/v1/search",
      {
        headers: { "x-api-key": "fixture-rag-key" },
        body: JSON.stringify({
          query: "menu",
          filters: { data_sources: ["public-menu"] },
          limit: 10,
        }),
      },
    ]);
    for (const invalid of [[], ["*"], ["public", "*"]]) {
      f.sources(invalid);
      f.request.mockClear();
      await expect(
        f.runtime.search({ query: "menu", knowledgeFilterId: "public", signal: turn.signal }),
      ).rejects.toThrow();
      expect(f.request).toHaveBeenCalledTimes(1);
    }
  });
  it("requires separate knowledge credentials", async () => {
    const f = fixture();
    const runtime = new LangflowCustomerRuntime(
      { baseUrl: "https://langflow.example.test/api/v1" },
      f.request,
    );
    await expect(
      runtime.publish({
        staffId: "staff",
        instructions: "public",
        knowledgeFilterId: "public",
        signal: turn.signal,
      }),
    ).rejects.toThrow("separate OpenRAG");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("fails publication if the installed component protocol is incompatible", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => Response.json({}));
    await expect(f.publish()).rejects.toThrow("Install");
    expect(f.published).toHaveLength(0);
  });
  it.each([
    { outputs: [] },
    { response: "old wrapper" },
    {
      session_id: "other",
      outputs: [
        {
          outputs: [
            {
              component_id: componentId,
              outputs: { message: { message: "wrong session", type: "text" } },
            },
          ],
        },
      ],
    },
  ])("rejects incompatible flow results", async (response) => {
    const f = fixture();
    const ref = await f.publish();
    f.request.mockImplementationOnce(async () => Response.json(response));
    await expect(f.runtime.reply({ ...turn, flowId: ref })).rejects.toThrow();
  });
  it("does not retry uncertain execution or expose upstream error bodies", async () => {
    const f = fixture();
    const ref = await f.publish();
    f.request.mockClear();
    f.request.mockImplementationOnce(
      async () => new Response("private credential details", { status: 503 }),
    );
    await expect(f.runtime.reply({ ...turn, flowId: ref })).rejects.toThrow(
      "Customer reply service is unavailable",
    );
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("retains network policy and protects runtime keys on public HTTP", async () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "");
    await expect(
      new LangflowCustomerRuntime({
        baseUrl: "https://runtime.example.test/api/v1",
        apiKey: "fake",
      }).publish({ staffId: "staff", instructions: "public", signal: turn.signal }),
    ).rejects.toThrow("Public model endpoints are blocked");
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    const network = vi.fn<typeof fetch>();
    await expect(
      new LangflowCustomerRuntime(
        { baseUrl: "http://runtime.example.test/api/v1", apiKey: "fake" },
        createOpenAiCompatibleFetch(network),
      ).publish({ staffId: "staff", instructions: "public", signal: turn.signal }),
    ).rejects.toThrow("HTTPS");
    expect(network).not.toHaveBeenCalled();
  });
});
