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
  let stored: Record<string, unknown> | undefined;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/api/v1/users/whoami")
      return Response.json({ id: flowId, username: "private-fixture-name" });
    if (path === "/api/v1/all")
      return Response.json({
        rakazo: {
          "ext:rakazo:RakazoCustomerAgent@extra": {
            display_name: "Deskazo customer agent",
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
      stored = body;
      return Response.json({ id: flowId });
    }
    if (path === `/api/v1/flows/${flowId}`) {
      if (!stored) return new Response(null, { status: 404 });
      if (init?.method === "DELETE") {
        stored = undefined;
        return new Response(null, { status: 204 });
      }
      return Response.json(stored);
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
      runtime.publish({
        publicationId: flowId,
        staffId: "staff",
        instructions: turn.instructions,
        signal: turn.signal,
      }),
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
  it("returns only the stable runtime principal and sanitizes identity errors", async () => {
    const f = fixture();
    expect(await f.runtime.identity(turn.signal)).toBe(`langflow-user:${flowId}`);
    f.request.mockImplementationOnce(async () => new Response("private-fixture-key"));
    await expect(f.runtime.identity(turn.signal)).rejects.toThrow(
      "Customer runtime identity is unavailable",
    );
  });
  it("inspects a publication without deleting it", async () => {
    const f = fixture();
    const input = { publicationId: flowId, staffId: "staff", signal: turn.signal };
    expect(await f.runtime.inspectPublication(input)).toBe(false);
    await f.publish();
    f.request.mockClear();
    expect(await f.runtime.inspectPublication(input)).toBe(true);
    expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });
  it("awaits durable admission before creating a remote flow", async () => {
    const f = fixture();
    const beforeDispatch = vi.fn(async () => {
      throw new Error("Admission failed");
    });
    await expect(
      f.runtime.publish({
        publicationId: flowId,
        staffId: "staff",
        instructions: turn.instructions,
        signal: turn.signal,
        beforeDispatch,
      }),
    ).rejects.toThrow("Admission failed");
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(f.published).toHaveLength(0);
    expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });
  it("awaits durable observation before deleting and does not mark absence as observed", async () => {
    const f = fixture();
    const beforeRemove = vi.fn(async () => {
      throw new Error("Observation failed");
    });
    expect(
      await f.runtime.removePublication({
        publicationId: flowId,
        staffId: "staff",
        signal: turn.signal,
        beforeRemove,
      }),
    ).toBe("absent");
    expect(beforeRemove).not.toHaveBeenCalled();
    await f.publish();
    f.request.mockClear();
    await expect(
      f.runtime.removePublication({
        publicationId: flowId,
        staffId: "staff",
        signal: turn.signal,
        beforeRemove,
      }),
    ).rejects.toThrow("Observation failed");
    expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });
  it("creates the caller's publication identity before a reference is returned", async () => {
    const f = fixture();
    expect(await f.publish()).toMatch(new RegExp(`^langflow:1:${flowId}:`));
    expect(f.published[0]).toMatchObject({
      id: flowId,
      name: `Customer staff ${flowId}`,
      access_type: "PRIVATE",
    });
  });
  it("rejects a provider that assigns a different identity", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) =>
      String(url).endsWith("flows/")
        ? Response.json({ id: "22222222-2222-4222-8222-222222222222" })
        : original(url, init),
    );
    await expect(f.publish()).rejects.toThrow("publication identity");
  });
  it("removes only the matching publication and treats absence as success", async () => {
    const f = fixture();
    await f.publish();
    f.request.mockClear();
    const cleanup = { publicationId: flowId, staffId: "staff", signal: turn.signal };
    await f.runtime.removePublication(cleanup);
    await f.runtime.removePublication(cleanup);
    expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(f.request.mock.calls[1]?.[1]).toMatchObject({
      redirect: "error",
      signal: turn.signal,
      headers: { "x-api-key": "fixture-langflow-key" },
    });
  });
  it.each([
    {
      id: flowId,
      name: `Customer other ${flowId}`,
      description: `Deskazo customer protocol 1; instructions ${"a".repeat(64)}`,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: `Customer staff ${flowId}`,
      description: `Deskazo customer protocol 1; instructions ${"a".repeat(64)}`,
    },
    { id: flowId, name: `Customer staff ${flowId}`, description: "unrelated flow" },
  ])("refuses removal when the ownership marker differs", async (flow) => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => Response.json(flow));
    await expect(
      f.runtime.removePublication({
        publicationId: flowId,
        staffId: "staff",
        signal: turn.signal,
      }),
    ).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([202, 401, 403, 500])("keeps cleanup failures retryable (%s)", async (status) => {
    const f = fixture();
    await f.publish();
    const original = f.request.getMockImplementation()!;
    f.request.mockClear();
    f.request.mockImplementation(async (url, init) =>
      init?.method === "DELETE"
        ? new Response("private provider error", { status })
        : original(url, init),
    );
    await expect(
      f.runtime.removePublication({
        publicationId: flowId,
        staffId: "staff",
        signal: turn.signal,
      }),
    ).rejects.toThrow("Customer reply service is unavailable");
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("accepts a concurrent removal returning 404", async () => {
    const f = fixture();
    await f.publish();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 404 }) : original(url, init),
    );
    await f.runtime.removePublication({
      publicationId: flowId,
      staffId: "staff",
      signal: turn.signal,
    });
  });
  it("does not dispatch publication or cleanup after cancellation", async () => {
    const f = fixture();
    const signal = AbortSignal.abort(new Error("Cancelled"));
    await expect(
      f.runtime.publish({
        publicationId: flowId,
        staffId: "staff",
        instructions: "public",
        signal,
      }),
    ).rejects.toThrow("Cancelled");
    await expect(
      f.runtime.removePublication({ publicationId: flowId, staffId: "staff", signal }),
    ).rejects.toThrow("Cancelled");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("does not expose malformed upstream metadata in cleanup errors", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => new Response("private-fixture-token"));
    await expect(
      f.runtime.removePublication({ publicationId: flowId, staffId: "staff", signal: turn.signal }),
    ).rejects.toThrow("Customer publication ownership could not be verified");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("refuses oversized publication metadata without deleting", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => new Response("x".repeat(1_000_001)));
    await expect(
      f.runtime.removePublication({ publicationId: flowId, staffId: "staff", signal: turn.signal }),
    ).rejects.toThrow("size limit");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("validates publication IDs before using them in requests", async () => {
    const f = fixture();
    for (const publicationId of ["../other", "not-a-uuid"]) {
      await expect(
        f.runtime.publish({
          publicationId,
          staffId: "staff",
          instructions: "public",
          signal: turn.signal,
        }),
      ).rejects.toThrow();
      await expect(
        f.runtime.removePublication({ publicationId, staffId: "staff", signal: turn.signal }),
      ).rejects.toThrow();
    }
    expect(f.request).not.toHaveBeenCalled();
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
  it("preserves multiline Thai history and literal backslashes through LFX text decoding", async () => {
    const f = fixture();
    const messages = [
      { role: "user" as const, content: "สวัสดีค่ะ" },
      { role: "assistant" as const, content: 'ยินดีค่ะ\nLiteral \\n and \\\\n. "Quotes"\tTab' },
      { role: "user" as const, content: "What should I provide first?" },
    ];
    await f.runtime.reply({ ...turn, messages, flowId: await f.publish() });
    const wire = f.runs[0]!.tweaks[componentId].transcript as string;
    expect(JSON.parse(wire.replaceAll("\\n", "\n"))).toEqual(messages);
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
        publicationId: flowId,
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
      }).publish({
        publicationId: flowId,
        staffId: "staff",
        instructions: "public",
        signal: turn.signal,
      }),
    ).rejects.toThrow("Public model endpoints are blocked");
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    const network = vi.fn<typeof fetch>();
    await expect(
      new LangflowCustomerRuntime(
        { baseUrl: "http://runtime.example.test/api/v1", apiKey: "fake" },
        createOpenAiCompatibleFetch(network),
      ).publish({
        publicationId: flowId,
        staffId: "staff",
        instructions: "public",
        signal: turn.signal,
      }),
    ).rejects.toThrow("HTTPS");
    expect(network).not.toHaveBeenCalled();
  });
});
