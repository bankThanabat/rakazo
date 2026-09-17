import type { KnowledgeProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { OpenRagKnowledgeProvider } from "./knowledge-openrag.js";
import { createKnowledgeFixture } from "./knowledge-test-fixture.js";

const signal = new AbortController().signal;

/**
 * Offline conformance: every KnowledgeProvider must keep revisions independently
 * selectable, never answer an empty scope, and treat repeated removal as success.
 */
async function assertKnowledgeConformance(provider: KnowledgeProvider) {
  const [kept, removed] = ["k_kept.txt", "k_removed.txt"];
  for (const key of [kept, removed]) {
    const taskId = await provider.ingest({
      key,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(`Policy in ${key}`),
      signal,
    });
    expect(await provider.status(taskId, key, signal)).toBe("ready");
  }
  expect(await provider.search("policy", [], signal)).toEqual([]);
  expect(await provider.search("policy", [kept], signal)).toEqual([
    { key: kept, text: `Policy in ${kept}` },
  ]);
  await provider.remove(removed, signal);
  await provider.remove(removed, signal);
  expect(await provider.search("policy", [kept, removed], signal)).toEqual([
    { key: kept, text: `Policy in ${kept}` },
  ]);
}

/** The stock OpenRAG routes the adapter uses, backed by a map. */
function openRagEmulator(): typeof fetch {
  const documents = new Map<string, string>();
  return async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/v1/", "");
    if (path === "documents/ingest") {
      const file = (init!.body as FormData).get("file") as File;
      documents.set(file.name, await file.text());
      return Response.json({ task_id: file.name });
    }
    if (path.startsWith("tasks/")) {
      const filename = decodeURIComponent(path.split("/")[1]!);
      return Response.json({
        status: "completed",
        files: { upload: { filename, status: "completed" } },
      });
    }
    const body = JSON.parse(String(init!.body));
    if (path === "search") {
      const names: string[] = body.filters.data_sources;
      return Response.json({
        results: names.flatMap((filename) =>
          documents.has(filename) ? [{ filename, text: documents.get(filename) }] : [],
        ),
      });
    }
    if (documents.delete(body.filename)) return Response.json({ success: true });
    return Response.json(
      {
        success: false,
        deleted_chunks: 0,
        filename: body.filename,
        error: "No matching document chunks were deleted.",
      },
      { status: 404 },
    );
  };
}

describe("knowledge provider conformance", () => {
  it("holds for the test fixture (offline)", async () => {
    await assertKnowledgeConformance(createKnowledgeFixture().provider);
  });

  it("holds for OpenRAG with an emulated backend (offline)", async () => {
    await assertKnowledgeConformance(
      new OpenRagKnowledgeProvider(
        { baseUrl: "http://localhost:8000/v1", apiKey: "fixture-key" },
        openRagEmulator(),
      ),
    );
  });
});
