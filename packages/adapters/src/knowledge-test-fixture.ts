import { randomUUID } from "node:crypto";
import type { ArtifactStore, JobPublisher } from "@rakazo/adapter-kit";
import { vi } from "vitest";

/** Offline document processing; production HTTP parsing is covered by adapter contract tests. */
export function createKnowledgeFixture() {
  const files = new Map<string, Uint8Array>();
  const indexed = new Map<string, string>();
  const provider = {
    ingest: vi.fn(async ({ key, bytes }: { key: string; bytes: Uint8Array }) => {
      indexed.set(key, new TextDecoder().decode(bytes));
      return key;
    }),
    status: vi.fn(async (): Promise<"ready" | "failed" | "processing"> => "ready"),
    search: vi.fn(async (_query: string, keys: string[]) =>
      keys.flatMap((key) => (indexed.has(key) ? [{ key, text: indexed.get(key)! }] : [])),
    ),
    remove: vi.fn(async (key: string) => {
      indexed.delete(key);
    }),
  };
  const artifacts: ArtifactStore = {
    describe: () => ({
      id: "fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { stream: false },
    }),
    put: async ({ bytes }) => {
      const id = randomUUID();
      files.set(id, bytes);
      return { id, hash: "fixture" };
    },
    get: async (id) => files.get(id)!,
    remove: async (id) => {
      files.delete(id);
    },
  };
  const jobs: JobPublisher = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return { files, indexed, provider, artifacts, jobs };
}
