import type { AdapterContext, SemanticMemoryRestoreRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recallSerenity, rememberSerenity } from "./serenity-client.js";
import { SerenityMemoryProvider } from "./serenity-memory-provider.js";
import { SupermemoryMemoryProvider } from "./supermemory-memory-provider.js";

vi.mock("./serenity-client.js", async (original) => ({
  ...(await original<typeof import("./serenity-client.js")>()),
  recallSerenity: vi.fn(),
  rememberSerenity: vi.fn(),
}));
const context: AdapterContext = {
  botId: "bot-1",
  userId: "user-1",
  spaceId: "space-1",
  operationId: "restore",
  traceId: "restore",
  signal: new AbortController().signal,
};
const request: SemanticMemoryRestoreRequest = {
  botId: "bot-1",
  id: "old-fact",
  expectedContent: "Use metric units.",
  entity: "rakazo:bot-1",
  scope: "shared",
  reason: "Restore the recorded removal",
};
const supermemory = () =>
  new SupermemoryMemoryProvider({ baseUrl: "http://127.0.0.1:6767", apiKey: "synthetic-key" });
const serenity = () =>
  new SerenityMemoryProvider({
    endpoint: "http://127.0.0.1:8787/mcp",
    token: "synthetic-token",
    brainLabel: "",
    allowWrites: true,
  });
const page = (entries: unknown[] = []) => ({
  memoryEntries: entries,
  pagination: { currentPage: 1, totalPages: 1, totalItems: entries.length },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("reviewed semantic restoration", () => {
  it("restores to exactly one reviewed shared destination and preserves other facts", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          page([
            { id: "other-fact", memory: "Later preference", isLatest: true, isForgotten: false },
            { id: request.id, memory: request.expectedContent, isLatest: true, isForgotten: true },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { memories: [{ id: "new-fact", memory: request.expectedContent }] },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", transport);
    expect(await supermemory().restore(request, context)).toEqual({
      ok: true,
      value: [
        {
          version: 1,
          id: "new-fact",
          entity: request.entity,
          content: request.expectedContent,
          created: true,
        },
      ],
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(transport.mock.calls[1]![1].body)).toEqual({
      containerTag: request.entity,
      memories: [{ content: request.expectedContent, isStatic: false }],
    });
  });
  it.each([
    { id: request.id, memory: request.expectedContent, isLatest: true, isForgotten: false },
    { id: request.id, memory: "Changed text", isLatest: true, isForgotten: true },
  ])("refuses to restore an active or changed fact", async (fact) => {
    const transport = vi.fn().mockResolvedValue(Response.json(page([fact])));
    vi.stubGlobal("fetch", transport);
    expect(await supermemory().restore(request, context)).toMatchObject({
      ok: false,
      uncertainEntities: [],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("refuses an older fact when the provider reports a later version", async () => {
    const transport = vi.fn().mockResolvedValue(
      Response.json(
        page([
          {
            id: "newer-version",
            memory: "Use imperial units.",
            isLatest: true,
            isForgotten: false,
            history: [
              {
                id: request.id,
                memory: request.expectedContent,
                isLatest: false,
                isForgotten: true,
              },
            ],
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", transport);
    expect(await supermemory().restore(request, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("newer version"),
      uncertainEntities: [],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid-page", "lost-response", "changed-receipt"])(
    "retains %s honestly",
    async (outcome) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce(Response.json(outcome === "invalid-page" ? {} : page()));
      if (outcome === "lost-response") transport.mockRejectedValueOnce(new Error("Lost response"));
      else
        transport.mockResolvedValueOnce(
          Response.json(
            { memories: [{ id: "new-fact", memory: "Changed text" }] },
            { status: 201 },
          ),
        );
      vi.stubGlobal("fetch", transport);
      expect(await supermemory().restore(request, context)).toMatchObject({
        ok: false,
        uncertainEntities: outcome === "invalid-page" ? [] : [request.entity],
      });
      expect(transport).toHaveBeenCalledTimes(outcome === "invalid-page" ? 1 : 2);
    },
  );
  it.each(["Supermemory", "Serenity"])(
    "%s rejects a foreign namespace before transport",
    async (name) => {
      const transport = vi.fn();
      vi.stubGlobal("fetch", transport);
      expect(
        await (name === "Supermemory" ? supermemory() : serenity()).restore(
          { ...request, entity: "foreign" },
          context,
        ),
      ).toMatchObject({ ok: false, uncertainEntities: [] });
      expect(transport).not.toHaveBeenCalled();
      expect(rememberSerenity).not.toHaveBeenCalled();
      expect(recallSerenity).not.toHaveBeenCalled();
    },
  );
  it("Serenity restores one entity and confirms its full returned fact without inventing creation", async () => {
    vi.mocked(recallSerenity)
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            factId: "new-fact",
            fact: request.expectedContent,
            provenance: "Synthetic restore",
            entitySlug: "rakazo-bot/bot-1",
          },
        ],
      });
    vi.mocked(rememberSerenity).mockResolvedValueOnce({
      ok: true,
      value: { id: "new-fact", status: "acknowledged" },
    });
    expect(
      await serenity().restore({ ...request, entity: "rakazo-bot/bot-1" }, context),
    ).toMatchObject({
      ok: true,
      value: [
        {
          id: "new-fact",
          entity: "rakazo-bot/bot-1",
          content: request.expectedContent,
          created: null,
        },
      ],
    });
    expect(rememberSerenity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rememberSerenity).mock.calls[0]?.[3]?.entity).toBe("rakazo-bot/bot-1");
  });
  it("Serenity keeps an acknowledgement uncertain when subsequent retrieval cannot confirm it", async () => {
    vi.mocked(recallSerenity).mockResolvedValue({ ok: true, value: [] });
    vi.mocked(rememberSerenity).mockResolvedValueOnce({
      ok: true,
      value: { id: "new-fact", status: "queued" },
    });
    expect(
      await serenity().restore({ ...request, entity: "rakazo-bot/bot-1" }, context),
    ).toMatchObject({
      ok: false,
      receipts: [{ id: "new-fact", content: null }],
      uncertainEntities: ["rakazo-bot/bot-1"],
    });
  });
});
