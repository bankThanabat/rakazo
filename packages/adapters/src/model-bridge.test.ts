import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeTestAccess,
  bridgeTestActor,
  bridgeTestModel,
  codexBridgeResponse,
  modelBridgeFixture,
} from "./model-bridge-test-fixture.js";
import { loadProviderOAuth, parseModelSecret, serializeModelSecret } from "./pi-oauth.js";

const prompt = {
  model: bridgeTestModel,
  messages: [{ role: "user", content: "When do you close?" }],
};
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

describe("saved model OAuth bridge", () => {
  it("uses the existing Codex OAuth token through real Pi transport, with no login or API key fallback", async () => {
    const f = modelBridgeFixture();
    const grant = await f.issue();
    expect(f.upstream).not.toHaveBeenCalled();
    const response = await f.bridge.respond(grant.apiKey, prompt, signal());
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "Open until six." }, finish_reason: "stop" }],
      usage: { total_tokens: 16 },
    });
    const [url, init] = f.upstream.mock.calls[0]!;
    expect(String(url)).toContain("/codex/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${bridgeTestAccess}`);
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("fake-account");
    expect(init?.body).not.toContain(grant.apiKey);
    expect(f.payloads[0]).toMatchObject({ model: bridgeTestModel, stream: true });
    expect(f.configurations.at(-1)?.model.oauth?.credential.access).toBe(bridgeTestAccess);
    expect(await f.bridge.list(bridgeTestActor)).toEqual([
      { id: grant.id, credentialId: "credential", model: bridgeTestModel },
    ]);
    expect(JSON.stringify(await f.bridge.models(grant.apiKey))).not.toContain(bridgeTestAccess);
  });

  it("round-trips document search calls and results, including SSE tool calls and usage", async () => {
    const f = modelBridgeFixture();
    const grant = await f.issue();
    f.upstream.mockImplementationOnce(async () => codexBridgeResponse(true));
    const tools = [
      {
        type: "function",
        function: {
          name: "search_documents",
          description: "Find business hours",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ];
    const first = await f.bridge.respond(
      grant.apiKey,
      { ...prompt, tools, stream: true, stream_options: { include_usage: true } },
      signal(),
    );
    const wire = await first.text();
    expect(wire).toContain("data: [DONE]");
    const chunks = wire
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    const call = chunks
      .flatMap((chunk) => chunk.choices)
      .flatMap((choice) => choice.delta.tool_calls ?? [])[0];
    expect(call.function).toEqual({ name: "search_documents", arguments: '{"query":"hours"}' });
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { total_tokens: 16 } });
    const { index: _index, ...toolCall } = call;
    const second = await f.bridge.respond(
      grant.apiKey,
      {
        ...prompt,
        tools,
        messages: [
          ...prompt.messages,
          { role: "assistant", content: null, tool_calls: [toolCall] },
          { role: "tool", tool_call_id: call.id, content: "The store closes at six." },
        ],
      },
      signal(),
    );
    expect(await second.json()).toMatchObject({
      choices: [{ message: { content: "Open until six." } }],
    });
    expect(f.payloads[1]).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_test",
          output: "The store closes at six.",
        }),
      ]),
      tools: [expect.objectContaining({ name: "search_documents" })],
    });
  });

  it("refreshes expired OAuth in the same encrypted record and reuses it on the next request", async () => {
    const f = modelBridgeFixture();
    const row = f.rows.get("oauth-secret")!;
    row.ciphertext = serializeModelSecret({
      kind: "oauth",
      credential: { type: "oauth", access: "expired", refresh: "fake-refresh", expires: 0 },
    });
    const oauth = loadProviderOAuth("openai-codex")!;
    const refresh = vi.spyOn(oauth, "refresh").mockResolvedValue({
      type: "oauth",
      access: bridgeTestAccess,
      refresh: "rotated-fake-refresh",
      expires: 4_000_000_000_000,
    });
    const grant = await f.issue();
    await f.bridge.respond(grant.apiKey, prompt, signal());
    await f.bridge.respond(grant.apiKey, prompt, signal());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(parseModelSecret(row.ciphertext)).toMatchObject({
      kind: "oauth",
      credential: { refresh: "rotated-fake-refresh" },
    });
    expect(f.prisma.secret.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "oauth-secret" } }),
    );
  });

  it("supports another saved subscription provider without routing it to Codex", async () => {
    const f = modelBridgeFixture({
      provider: "anthropic",
      modelId: "claude-fable-5-1",
      access: "sk-ant-oat01-fake-subscription",
    });
    f.upstream.mockImplementation(async () => {
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: f.modelId,
            content: [],
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const grant = await f.issue();
    const response = await f.bridge.respond(
      grant.apiKey,
      { ...prompt, model: f.modelId },
      signal(),
    );
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "Hello" } }] });
    const [url, init] = f.upstream.mock.calls[0]!;
    expect(String(url)).toContain("anthropic.com");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer sk-ant-oat01-fake-subscription",
    );
  });

  it("creates grants for saved compatible models outside the static catalog", async () => {
    const f = modelBridgeFixture({ provider: "openai-compatible", modelId: "shop-local-model" });
    f.rows.get("oauth-secret")!.ciphertext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "fake-local-key",
    });
    const grant = await f.issue();
    expect(await f.bridge.models(grant.apiKey)).toMatchObject({
      data: [{ id: "shop-local-model" }],
    });
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("uses a saved keyless local model without a deployment credential", async () => {
    const f = modelBridgeFixture({ provider: "openai-compatible", modelId: "shop-local-model" });
    f.rows.get("oauth-secret")!.ciphertext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    f.upstream.mockImplementation(
      async () =>
        new Response(
          `${[
            {
              id: "local",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Local reply" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "local",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const grant = await f.issue();
    const response = await f.bridge.respond(
      grant.apiKey,
      { model: f.modelId, messages: [{ role: "user", content: "Hello" }] },
      signal(),
    );
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "Local reply" } }],
    });
    expect(String(f.upstream.mock.calls[0]![0])).toContain("127.0.0.1:8080");
  });

  it("rejects other owners, spaces, models, forged keys and revoked connections", async () => {
    const f = modelBridgeFixture();
    await expect(
      f.bridge.create(
        { userId: "other", spaceId: "space" },
        { credentialId: "credential", modelId: bridgeTestModel },
      ),
    ).rejects.toMatchObject({ status: 401 });
    const grant = await f.issue();
    await expect(f.bridge.models(`${grant.apiKey.slice(0, -1)}!`)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      f.bridge.models(grant.apiKey.replace(/\..+$/, `.${"a".repeat(43)}`)),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      f.bridge.respond(grant.apiKey, { ...prompt, model: "other-model" }, signal()),
    ).rejects.toMatchObject({ status: 403 });
    await f.bridge.revoke(bridgeTestActor, "oauth-secret");
    expect(f.rows.has("oauth-secret")).toBe(true);
    f.prisma.spaceMember.findFirst.mockResolvedValueOnce(null);
    await expect(f.bridge.models(grant.apiKey)).rejects.toMatchObject({ status: 401 });
    f.prisma.userModelCredential.findFirst.mockResolvedValueOnce(null);
    await expect(f.bridge.models(grant.apiKey)).rejects.toMatchObject({ status: 401 });
    await f.bridge.revoke(bridgeTestActor, grant.id);
    await expect(f.bridge.models(grant.apiKey)).rejects.toMatchObject({ status: 401 });
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("rejects unsupported options and malformed history before model access", async () => {
    const f = modelBridgeFixture();
    const grant = await f.issue();
    for (const patch of [
      { tool_choice: "required" },
      { n: 2 },
      { response_format: { type: "json_object" } },
      { base_url: "https://untrusted.example.test" },
      { messages: [{ role: "tool", tool_call_id: "unknown", content: "fake" }] },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://untrusted.example.test" } }],
          },
        ],
      },
    ]) {
      await expect(
        f.bridge.respond(grant.apiKey, { ...prompt, ...patch }, signal()),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("bounds concurrent use and cancels the upstream when a streaming client disconnects", async () => {
    const f = modelBridgeFixture();
    const grant = await f.issue();
    const aborted: AbortSignal[] = [];
    f.upstream.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const upstreamSignal = init!.signal!;
          aborted.push(upstreamSignal);
          if (upstreamSignal.aborted) reject(new Error("aborted"));
          else
            upstreamSignal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
        }),
    );
    const first = await f.bridge.respond(grant.apiKey, { ...prompt, stream: true }, signal());
    const second = await f.bridge.respond(grant.apiKey, { ...prompt, stream: true }, signal());
    await expect(f.bridge.respond(grant.apiKey, prompt, signal())).rejects.toMatchObject({
      status: 429,
    });
    await Promise.all([first.body!.cancel(), second.body!.cancel()]);
    expect(aborted.every((item) => item.aborted)).toBe(true);
    f.upstream.mockImplementation(async () => codexBridgeResponse());
    const next = await f.bridge.respond(grant.apiKey, prompt, signal());
    expect(next.status).toBe(200);
  });

  it("sanitizes provider errors and does not retry an uncertain request", async () => {
    const f = modelBridgeFixture();
    const grant = await f.issue();
    f.upstream.mockResolvedValue(
      new Response(`private details ${bridgeTestAccess}`, { status: 400 }),
    );
    await expect(f.bridge.respond(grant.apiKey, prompt, signal())).rejects.toMatchObject({
      status: 502,
      message: "Model request failed",
    });
    expect(f.upstream).toHaveBeenCalledTimes(1);
  });
});
