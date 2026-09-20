import type { AdapterContext, SemanticMemorySaveRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SerenityMemoryProvider } from "./serenity-memory-provider.js";
import { SupermemoryMemoryProvider } from "./supermemory-memory-provider.js";

const context: AdapterContext = {
  botId: "bot-1",
  userId: "user-1",
  spaceId: "space-1",
  operationId: "scope-test",
  traceId: "scope-test",
  signal: new AbortController().signal,
};
const request: SemanticMemorySaveRequest = {
  botId: "bot-1",
  scope: "isolated",
  content: "Use metric units.",
  source: { kind: "durable" },
};
afterEach(() => vi.unstubAllGlobals());
describe.each([
  {
    name: "Supermemory",
    provider: () =>
      new SupermemoryMemoryProvider({ baseUrl: "http://localhost:6767", apiKey: "synthetic-key" }),
  },
  {
    name: "Serenity",
    provider: () =>
      new SerenityMemoryProvider({
        endpoint: "http://localhost:8787/mcp",
        token: "synthetic-token",
        allowWrites: true,
        brainLabel: "",
      }),
  },
])("$name rejects invalid save authority before transport", ({ provider }) => {
  it.each([
    { name: "another bot", input: { botId: "other-bot" } },
    { name: "unknown scope", input: { scope: "global" } },
    { name: "missing source", input: { source: undefined } },
    { name: "unknown source", input: { source: { kind: "other" } } },
    { name: "negative history generation", input: { source: { kind: "history", generation: -1 } } },
    {
      name: "fractional history generation",
      input: { source: { kind: "history", generation: 0.5 } },
    },
    { name: "missing history generation", input: { source: { kind: "history" } } },
    {
      name: "unsafe history generation",
      input: { source: { kind: "history", generation: Number.MAX_SAFE_INTEGER + 1 } },
    },
  ])("$name", async ({ input }) => {
    const transport = vi.fn().mockRejectedValue(new Error("Unexpected transport"));
    vi.stubGlobal("fetch", transport);
    expect(
      await provider().save({ ...request, ...input } as SemanticMemorySaveRequest, context),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("scope"),
      receipts: [],
      uncertainEntities: [],
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { botId: "another-bot", generations: [0] },
    { botId: "bot-1", generations: [-1] },
    { botId: "bot-1", generations: [0.5] },
    { botId: "bot-1", generations: [Number.MAX_SAFE_INTEGER + 1] },
    { botId: "bot-1", generations: [] },
  ])("rejects an invalid history purge before transport: %j", async (input) => {
    const transport = vi.fn().mockRejectedValue(new Error("Unexpected transport"));
    vi.stubGlobal("fetch", transport);
    expect(await provider().purgeHistory(input, context)).toMatchObject({ ok: false });
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires a bot in the trusted context", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("Unexpected transport"));
    vi.stubGlobal("fetch", transport);
    expect(await provider().save(request, { ...context, botId: undefined })).toMatchObject({
      ok: false,
      receipts: [],
      uncertainEntities: [],
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
