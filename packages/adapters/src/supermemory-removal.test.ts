import type { AdapterContext, SemanticMemoryForgetRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MEMORY_CONTENT_CHARS, MAX_SUPERMEMORY_RESPONSE_BYTES } from "./supermemory-client.js";
import { SupermemoryMemoryProvider } from "./supermemory-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};
const request: SemanticMemoryForgetRequest = {
  id: "fact-1",
  botId: "bot-1",
  scope: "isolated",
  expectedContent: "Use metric units.",
  reason: "Obsolete preference",
};
const fact = {
  id: request.id,
  memory: request.expectedContent,
  isLatest: true,
  isForgotten: false,
};
const provider = () =>
  new SupermemoryMemoryProvider({
    baseUrl: "http://localhost:6767/memory/",
    apiKey: "offline-memory-key",
  });
const page = (entries: unknown[] = [fact], currentPage = 1, totalPages = 1) => ({
  memoryEntries: entries,
  pagination: { currentPage, totalPages, totalItems: entries.length },
});
const receipt = { id: request.id, forgotten: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Supermemory fact identities", () => {
  it("retains exact text and separate identities for mirrored facts", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const { containerTag } = JSON.parse(init.body);
      return Response.json({
        results: [{ id: `${containerTag}:fact`, memory: "  metric  ", similarity: 1 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await provider().recall(
        { query: "units", scope: "shared", botId: "bot-1", limit: 5 },
        context,
      ),
    ).toEqual({
      ok: true,
      value: [
        {
          id: "rakazo:workspace:space-1:fact",
          entity: "rakazo:workspace:space-1",
          memory: "  metric  ",
          score: 1,
        },
        { id: "rakazo:bot-1:fact", entity: "rakazo:bot-1", memory: "  metric  ", score: 1 },
      ],
    });
  });

  it("does not offer chunk IDs or truncated snapshots as removable facts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          results: [
            { id: "chunk-1", chunk: "Document text", similarity: 1 },
            { id: "fact-2", memory: "x".repeat(MAX_MEMORY_CONTENT_CHARS + 1), similarity: 0.5 },
          ],
        }),
      ),
    );
    const result = await provider().recall(
      { query: "units", scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toHaveLength(2);
    expect(
      result.value.every((entry) => entry.id === undefined && entry.entity === undefined),
    ).toBe(true);
  });
});

describe("Supermemory scoped removal", () => {
  it("finds an exact fact on a later page and deletes only its cited container", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page([{ ...fact, id: "other" }], 1, 2)))
      .mockResolvedValueOnce(Response.json(page([fact], 2, 2)))
      .mockResolvedValueOnce(Response.json(receipt));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await provider().forget({ ...request, scope: "shared", entity: "rakazo:bot-1" }, context),
    ).toEqual({
      ok: true,
      value: { id: request.id, expired: true, reason: request.reason, entity: "rakazo:bot-1" },
    });
    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init.method, JSON.parse(init.body)]),
    ).toEqual([
      [
        "http://localhost:6767/memory/v4/memories/list",
        "POST",
        { containerTags: ["rakazo:bot-1"], page: 1, limit: 50 },
      ],
      [
        "http://localhost:6767/memory/v4/memories/list",
        "POST",
        { containerTags: ["rakazo:bot-1"], page: 2, limit: 50 },
      ],
      [
        "http://localhost:6767/memory/v4/memories",
        "DELETE",
        { id: request.id, containerTag: "rakazo:bot-1", reason: request.reason },
      ],
    ]);
    expect(new Set(fetchMock.mock.calls.map(([, init]) => init.signal)).size).toBe(1);
    expect(fetchMock.mock.calls.every(([, init]) => init.redirect === "error")).toBe(true);
  });

  it("can find an uncited shared fact in the bot namespace without deleting both copies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page([])))
      .mockResolvedValueOnce(Response.json(page()))
      .mockResolvedValueOnce(Response.json(receipt));
    vi.stubGlobal("fetch", fetchMock);
    expect((await provider().forget({ ...request, scope: "shared" }, context)).ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).containerTags).toEqual([
      "rakazo:workspace:space-1",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body).containerTag).toBe("rakazo:bot-1");
  });

  it.each([
    { botId: "other-bot" },
    { entity: "rakazo:other-bot" },
    { entity: "rakazo:workspace:other-space", scope: "shared" as const },
    { entity: "rakazo:workspace:space-1" },
    { entity: "rakazo:bot-1:history:1" },
    { expectedContent: " " },
    { id: "" },
  ])("rejects invalid or out-of-scope requests before network access: %j", async (override) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await provider().forget({ ...request, ...override }, context)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ ...fact, id: "other-id" }],
    [{ ...fact, memory: "Use imperial units." }],
    [{ ...fact, memory: `${fact.memory} ` }],
    [{ ...fact, isLatest: false }],
    [{ ...fact, isForgotten: true }],
  ])("does not delete a missing or stale reviewed fact: %j", async (...entries) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(page(entries)));
    vi.stubGlobal("fetch", fetchMock);
    expect((await provider().forget(request, context)).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it.each([
    {},
    { ...page(), pagination: { currentPage: 2, totalPages: 2, totalItems: 1 } },
    page([{ id: request.id, memory: request.expectedContent }]),
  ])("rejects malformed inspection responses before deletion: %j", async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", fetchMock);
    expect((await provider().forget(request, context)).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([401, 404, 500])(
    "does not delete when scoped inspection is unavailable (%i)",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await provider().forget(request, context)).ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("bounds pagination before an untrusted endpoint can loop indefinitely", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url, init) =>
        Response.json(page([], JSON.parse(init.body).page, 999)),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(await provider().forget(request, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("page limit"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(100);
    expect(fetchMock.mock.calls.every(([, init]) => init.method === "POST")).toBe(true);
  });

  it("uses a single deadline across inspection pages", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      await vi.advanceTimersByTimeAsync(8000);
      const current = JSON.parse(init.body).page;
      return Response.json(page([], current, 3));
    });
    // Node's AbortSignal.timeout uses native timers; use the same abort source to
    // deterministically prove the deadline is not reset between page requests.
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    setTimeout(() => controller.abort(new Error("deadline")), 15000);
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect((await provider().forget(request, context)).ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("checks cancellation after inspection and before deletion", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      return Response.json(page());
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await provider().forget(request, { ...context, signal: controller.signal })).ok).toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([{ id: "other", forgotten: true }, { id: request.id, forgotten: false }, {}, null])(
    "requires a matching confirmation and never retries an uncertain delete: %j",
    async (body) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(Response.json(page()))
        .mockResolvedValueOnce(Response.json(body));
      vi.stubGlobal("fetch", fetchMock);
      expect(await provider().forget(request, context)).toMatchObject({
        ok: false,
        error: expect.stringContaining("Inspect"),
        uncertain: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([409, 500])("does not call an unconfirmed HTTP %i deletion a success", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page()))
      .mockResolvedValueOnce(new Response("", { status }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await provider().forget(request, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not confirmed"),
      uncertain: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["inspection", "deletion"] as const)(
    "keeps oversized %s responses bounded and preserves dispatch uncertainty",
    async (phase) => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const oversized = {
        ok: true,
        headers: new Headers({ "content-length": String(MAX_SUPERMEMORY_RESPONSE_BYTES + 1) }),
        body: { cancel },
      };
      const fetchMock = vi.fn();
      if (phase === "deletion") fetchMock.mockResolvedValueOnce(Response.json(page()));
      fetchMock.mockResolvedValueOnce(oversized);
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider().forget(request, context);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Unexpected removal confirmation");
      expect(result.uncertain).toBe(phase === "deletion" ? true : undefined);
      expect(fetchMock).toHaveBeenCalledTimes(phase === "deletion" ? 2 : 1);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("does not contact the provider when the action is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await provider().forget(request, { ...context, signal: controller.signal })).ok).toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a lost deletion response as uncertain without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page()))
      .mockRejectedValueOnce(new Error("lost response"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await provider().forget(request, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be confirmed"),
      uncertain: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
