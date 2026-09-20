import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSupermemoryContainer,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_RECALLED_MEMORIES,
  MAX_SUPERMEMORY_RESPONSE_BYTES,
  probeSupermemory,
  saveSupermemoryMemory,
  saveSupermemoryMemoryToContainers,
  searchSupermemory,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

const config = { baseUrl: "http://localhost:6767", apiKey: "sm_test_key" };

afterEach(() => vi.unstubAllGlobals());

describe("Supermemory request URLs", () => {
  const operations = [
    { method: "GET", path: "/v3/container-tags/list", request: probeSupermemory },
    {
      method: "POST",
      path: "/v4/search",
      request: (connection: typeof config) => searchSupermemory("query", "fake:tag", connection),
    },
    {
      method: "POST",
      path: "/v4/memories",
      request: (connection: typeof config) => saveSupermemoryMemory("fact", "fake:tag", connection),
    },
    {
      method: "DELETE",
      path: "/v3/container-tags/fake%3Atag",
      request: (connection: typeof config) => deleteSupermemoryContainer("fake:tag", connection),
    },
  ];

  it.each([
    "http://127.0.0.1:8123/internal-action#",
    "http://127.0.0.1:8123/internal-action#ignored",
    "http://127.0.0.1:8123/internal-action?",
    "http://127.0.0.1:8123/internal-action?action=delete",
    "http://fake:credential@localhost:6767",
    "file:///fake-memory",
  ])("rejects ambiguous base URLs before every transport call: %s", async (baseUrl) => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ results: [], memories: [{ id: "fact-1", memory: "fact" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    for (const { request } of operations) {
      expect(await request({ ...config, baseUrl })).toMatchObject({ ok: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "/", "/memory", "/memory/"])(
    "preserves the base prefix and provider route for every method: %s",
    async (prefix) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () =>
          Response.json({ results: [], memories: [{ id: "fact-1", memory: "fact" }] }),
        );
      vi.stubGlobal("fetch", fetchMock);
      for (const { request, method, path } of operations) {
        expect(await request({ ...config, baseUrl: `http://[::1]:6767${prefix}` })).toMatchObject({
          ok: true,
        });
        const [url, init] = fetchMock.mock.lastCall!;
        expect(url).toBe(`http://[::1]:6767${prefix.replace(/\/$/, "")}${path}`);
        expect(init).toMatchObject({ method, redirect: "error" });
      }
    },
  );
});

describe("searchSupermemory", () => {
  it("posts the query and container tag, returning search results on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ memory: "User prefers British English", similarity: 0.9 }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchSupermemory("spelling preference", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: true,
      results: [{ memory: "User prefers British English", similarity: 0.9 }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v4/search");
    expect(init.headers.Authorization).toBe("Bearer sm_test_key");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toStrictEqual({
      q: "spelling preference",
      containerTag: "rakazo:bot-123",
      searchMode: "memories",
      limit: MAX_RECALLED_MEMORIES,
    });
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("500") });
    vi.unstubAllGlobals();
  });

  it("reports an unreachable server instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
  });

  it("treats document chunks as memory text when the search result has no memory field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [{ chunk: "Older decision: use Postgres." }] }), {
          status: 200,
        }),
      ),
    );

    const result = await searchSupermemory("database", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: true,
      results: [{ memory: "Older decision: use Postgres.", similarity: 0 }],
    });
    vi.unstubAllGlobals();
  });

  it("drops malformed search hits instead of injecting empty memories", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{}, { memory: "  " }, "nope", { memory: "kept" }] }),
          {
            status: 200,
          },
        ),
      ),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({ ok: true, results: [{ memory: "kept", similarity: 0 }] });
    vi.unstubAllGlobals();
  });

  it("bounds each recalled memory to the provider content limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ results: [{ memory: `kept${"x".repeat(20_000)}` }] })),
        ),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result.ok && result.results[0]?.memory).toHaveLength(MAX_MEMORY_CONTENT_CHARS);
    vi.unstubAllGlobals();
  });

  it("rejects an oversized search response before buffering it", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          "content-length": String(MAX_SUPERMEMORY_RESPONSE_BYTES + 1),
        }),
        body: { cancel },
      }),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("response is too large"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("caps a chunked search response without a content length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_SUPERMEMORY_RESPONSE_BYTES + 1))),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({ ok: false, error: "Supermemory response is too large." });
    vi.unstubAllGlobals();
  });
});

describe("searchSupermemoryContainers", () => {
  it("deduplicates and ranks results from shared and bot containers", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ results: [{ memory: "shared", similarity: 0.7 }] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [
                { memory: "private", similarity: 0.9 },
                { memory: "shared", similarity: 0.6 },
              ],
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      searchSupermemoryContainers("query", ["rakazo:workspace:ws-1", "rakazo:bot-1"], config),
    ).resolves.toEqual({
      ok: true,
      results: [
        { memory: "private", similarity: 0.9 },
        { memory: "shared", similarity: 0.7 },
      ],
    });
    vi.unstubAllGlobals();
  });
});

describe("saveSupermemoryMemory", () => {
  it("preserves the submitted content and returns confirmed memory-entry identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          documentId: "document-1",
          memories: [{ id: "entry-1", memory: "  Use metric units.  " }],
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveSupermemoryMemory("  Use metric units.  ", "rakazo:bot-1", config)).toEqual({
      ok: true,
      value: [
        {
          version: 1,
          id: "entry-1",
          entity: "rakazo:bot-1",
          content: "  Use metric units.  ",
          created: true,
        },
      ],
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      containerTag: "rakazo:bot-1",
      memories: [{ content: "  Use metric units.  ", isStatic: false }],
    });
  });

  it.each(["", "   ", "x".repeat(MAX_MEMORY_CONTENT_CHARS + 1)])(
    "rejects invalid content without silently truncating or writing",
    async (content) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      expect(await saveSupermemoryMemory(content, "rakazo:bot-1", config)).toMatchObject({
        ok: false,
        receipts: [],
        uncertainEntities: [],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([401, 500])("records unconfirmed HTTP %i saves as uncertain", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveSupermemoryMemory("fact", "rakazo:bot-1", config)).toMatchObject({
      ok: false,
      receipts: [],
      uncertainEntities: ["rakazo:bot-1"],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { documentId: "not-a-memory-id" },
    { memories: [] },
    { memories: [{ id: "", memory: "fact" }] },
  ])("never invents a receipt for a malformed acknowledgement: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    expect(await saveSupermemoryMemory("fact", "rakazo:bot-1", config)).toMatchObject({
      ok: false,
      receipts: [],
      uncertainEntities: ["rakazo:bot-1"],
    });
  });

  it("preserves provider-confirmed text rather than claiming the submitted text was stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ memories: [{ id: "entry-1", memory: "Provider normalized text" }] }),
        ),
    );
    expect(await saveSupermemoryMemory("Original text", "rakazo:bot-1", config)).toMatchObject({
      ok: true,
      value: [{ content: "Provider normalized text", created: null }],
    });
  });

  it("does not dispatch an already cancelled save", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await saveSupermemoryMemory("fact", "rakazo:bot-1", config, AbortSignal.abort()),
    ).toMatchObject({ ok: false, uncertainEntities: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a lost response uncertain without retrying", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("lost response"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveSupermemoryMemory("fact", "rakazo:bot-1", config)).toMatchObject({
      ok: false,
      uncertainEntities: ["rakazo:bot-1"],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("caps acknowledgement bodies and retains uncertainty after dispatch", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-length": String(MAX_SUPERMEMORY_RESPONSE_BYTES + 1) }),
        body: { cancel },
      }),
    );
    expect(await saveSupermemoryMemory("fact", "rakazo:bot-1", config)).toMatchObject({
      ok: false,
      uncertainEntities: ["rakazo:bot-1"],
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("saveSupermemoryMemoryToContainers", () => {
  it("preserves a shared receipt when the sibling write fails", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const { containerTag } = JSON.parse(init.body);
      if (containerTag === "rakazo:bot-1") throw new Error("lost response");
      return Response.json({ memories: [{ id: "shared-entry", memory: "fact" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await saveSupermemoryMemoryToContainers(
        "fact",
        ["rakazo:workspace:ws-1", "rakazo:bot-1"],
        config,
      ),
    ).toMatchObject({
      ok: false,
      receipts: [
        { id: "shared-entry", entity: "rakazo:workspace:ws-1", content: "fact", created: null },
      ],
      uncertainEntities: ["rakazo:bot-1"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains separate successful identities and dispatches each destination only once", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const { containerTag } = JSON.parse(init.body);
      return Response.json({ memories: [{ id: `${containerTag}:entry`, memory: "fact" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await saveSupermemoryMemoryToContainers(
      "fact",
      ["rakazo:workspace:ws-1", "rakazo:bot-1", "rakazo:bot-1"],
      config,
    );
    expect(result.ok && result.value).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("deleteSupermemoryContainer", () => {
  it("deletes the container tag on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteSupermemoryContainer("rakazo:bot-123", config);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v3/container-tags/rakazo%3Abot-123");
    expect(init.method).toBe("DELETE");
    expect(init.redirect).toBe("error");
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    const result = await deleteSupermemoryContainer("rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("404") });
    vi.unstubAllGlobals();
  });
});

describe("probeSupermemory", () => {
  it("succeeds when the container-tags endpoint responds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![1].redirect).toBe("error");
    vi.unstubAllGlobals();
  });

  it("fails when the endpoint rejects the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    vi.unstubAllGlobals();
  });

  it("fails when nothing is listening", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
  });
});
