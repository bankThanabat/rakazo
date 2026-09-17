import { KnowledgeRejectedError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { OpenRagKnowledgeProvider } from "./knowledge-openrag.js";

const signal = new AbortController().signal;
const config = { baseUrl: "http://localhost:8000/v1", apiKey: "fixture-key" };
describe("OpenRAG knowledge contract", () => {
  it("treats a missing document as deleted without ignoring other service failures", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          success: false,
          deleted_chunks: 0,
          filename: "absent.txt",
          error: "No matching document chunks were deleted.",
        },
        { status: 404 },
      ),
    );
    const provider = new OpenRagKnowledgeProvider(config, request);
    await expect(provider.remove("absent.txt", signal)).resolves.toBeUndefined();
    await expect(provider.status("missing", "absent.txt", signal)).rejects.toThrow("unavailable");
    for (const body of [
      { detail: "Not Found" },
      {
        success: false,
        deleted_chunks: 0,
        filename: "different.txt",
        error: "No matching document chunks were deleted.",
      },
    ]) {
      request.mockResolvedValueOnce(Response.json(body, { status: 404 }));
      await expect(provider.remove("absent.txt", signal)).rejects.toThrow("unavailable");
    }
    request.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(provider.remove("absent.txt", signal)).rejects.toThrow("unavailable");
  });
  it("never searches an empty scope and rejects unexpected results", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [{ filename: "internal.pdf", text: "private" }] }),
    );
    const provider = new OpenRagKnowledgeProvider(config, request);
    expect(await provider.search("policy", [], signal)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await expect(provider.search("policy", ["public.pdf"], signal)).rejects.toThrow("outside");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      query: "policy",
      filters: { data_sources: ["public.pdf"] },
      limit: 8,
    });
    await expect(provider.search("policy", ["*"], signal)).rejects.toThrow("scope");
  });
  it("requires the exact file to succeed, not just the task", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new OpenRagKnowledgeProvider(config, request);
    for (const [status, filename, fileStatus, expected] of [
      ["completed", "key.pdf", "failed", "failed"],
      ["completed", "other.pdf", "completed", "failed"],
      ["running", "key.pdf", "completed", "processing"],
      ["completed", "key.pdf", "completed", "ready"],
    ]) {
      request.mockResolvedValueOnce(
        Response.json({ status, files: { path: { filename, status: fileStatus } } }),
      );
      expect(await provider.status("task", "key.pdf", signal)).toBe(expected);
    }
  });
  it("uploads a revision filename without overwriting existing content", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ task_id: "task" }));
    const provider = new OpenRagKnowledgeProvider(config, request);
    expect(
      await provider.ingest({
        key: "k_revision.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("policy"),
        signal,
      }),
    ).toBe("task");
    const init = request.mock.calls[0]![1]!;
    const body = init.body as FormData;
    expect((body.get("file") as File).name).toBe("k_revision.txt");
    expect(body.get("replace_duplicates")).toBe("false");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("x-api-key")).toBe("fixture-key");
  });
  it("reports a refused upload as rejected and a lost one as unknown", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new OpenRagKnowledgeProvider(config, request);
    const upload = () =>
      provider.ingest({
        key: "k_revision.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array(),
        signal,
      });
    request.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(upload()).rejects.toBeInstanceOf(KnowledgeRejectedError);
    request.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await expect(upload()).rejects.not.toBeInstanceOf(KnowledgeRejectedError);
  });
});
