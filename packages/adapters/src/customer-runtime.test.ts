import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRagCustomerRuntime } from "./customer-runtime.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

const turn = {
  flowId: "flow-one",
  conversationId: "conversation-one",
  instructions: "Apply Friday promotion",
  messages: [{ role: "user" as const, content: "What is on offer?" }],
  signal: new AbortController().signal,
};
describe("OpenRAG customer runtime", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses live network policy and protects x-api-key on public HTTP", async () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "");
    await expect(
      new OpenRagCustomerRuntime({
        baseUrl: "https://runtime.example.test/v1",
        apiKey: "fake-key",
      }).reply(turn),
    ).rejects.toThrow("Public model endpoints are blocked");
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    const network = vi.fn<typeof fetch>();
    const guarded = createOpenAiCompatibleFetch(network);
    await expect(
      new OpenRagCustomerRuntime(
        { baseUrl: "http://runtime.example.test/v1", apiKey: "fake-key" },
        guarded,
      ).reply(turn),
    ).rejects.toThrow("HTTPS");
    expect(network).not.toHaveBeenCalled();
  });

  it("uses the OpenRAG chat path, scopes knowledge, and starts an isolated upstream turn", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ flow_id: turn.flowId, response: "Friday offer" }),
    );
    const runtime = new OpenRagCustomerRuntime(
      { baseUrl: "https://runtime.example.test/v1/", apiKey: "fake-secret" },
      request,
    );
    expect(await runtime.reply(turn)).toBe("Friday offer");
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://runtime.example.test/v1/chat");
    expect(init).toMatchObject({ redirect: "error", headers: { "x-api-key": "fake-secret" } });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      flow_id: turn.flowId,
      stream: false,
      filters: { _id: ["rakazo:no-customer-knowledge"] },
      message: JSON.stringify({
        instructions: turn.instructions,
        conversation: turn.conversationId,
        messages: turn.messages,
      }),
    });
    await runtime.reply({ ...turn, knowledgeFilterId: "published-menu" });
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).toMatchObject({
      filter_id: "published-menu",
    });
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).not.toHaveProperty("chat_id");
  });
  it.each([
    { response: "Silently ignored flow" },
    { flow_id: "wrong-flow", response: "Wrong staff" },
    { flow_id: turn.flowId, response: "" },
    { flow_id: turn.flowId, response: "x".repeat(16_001) },
    { flow_id: turn.flowId, error: "failure" },
  ])("rejects incompatible, empty or failed responses", async (response) => {
    const runtime = new OpenRagCustomerRuntime(
      { baseUrl: "https://runtime.example.test/v1" },
      async () => Response.json(response),
    );
    await expect(runtime.reply(turn)).rejects.toThrow();
  });
  it("does not expose provider error bodies or retry a potentially executed flow", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response("private provider details", { status: 503 }),
    );
    const runtime = new OpenRagCustomerRuntime(
      { baseUrl: "https://runtime.example.test/v1" },
      request,
    );
    await expect(runtime.reply(turn)).rejects.toThrow("Customer reply service is unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
