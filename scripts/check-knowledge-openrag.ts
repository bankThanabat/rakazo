/** Opt-in conformance check against an isolated, configured OpenRAG instance. */
import { randomUUID } from "node:crypto";
import { OpenRagKnowledgeProvider } from "../packages/adapters/src/knowledge-openrag.js";

if (!process.argv.includes("--live"))
  throw new Error("Use --live with an isolated knowledge instance");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone opt-in check, never run through Turbo.
const baseUrl = process.env.KNOWLEDGE_BASE_URL;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone opt-in check, never run through Turbo.
const apiKey = process.env.KNOWLEDGE_API_KEY;
if (!baseUrl || !apiKey) throw new Error("Set KNOWLEDGE_BASE_URL and KNOWLEDGE_API_KEY");
const provider = new OpenRagKnowledgeProvider({ baseUrl, apiKey });
const signal = AbortSignal.timeout(180_000);
// Two revisions of one source, then a document that belongs to another space.
const periods = ["thirty", "sixty", "ninety"];
const keys = periods.map((_, revision) => `k_test_${randomUUID()}_${revision}.txt`);
const tasks: Array<{ key: string; taskId: string }> = [];
try {
  for (const [index, key] of keys.entries()) {
    const taskId = await provider.ingest({
      key,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(`The return period is ${periods[index]} days.`),
      signal,
    });
    tasks.push({ key, taskId });
  }
  for (const { key, taskId } of tasks) {
    let status = await provider.status(taskId, key, signal);
    while (status === "processing") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = await provider.status(taskId, key, signal);
    }
    if (status !== "ready") throw new Error("Fixture ingestion failed");
  }
  for (const [index, key] of keys.entries()) {
    const hits = await provider.search("What is the return period?", [key], signal);
    if (
      !hits.length ||
      hits.some((hit) => hit.key !== key) ||
      !hits.some((hit) => hit.text.includes(periods[index]!))
    )
      throw new Error("Exact revision retrieval failed");
  }
  // The adapter rejects any hit outside the scope, so a leaked document throws here.
  const scoped = await provider.search("What is the return period?", keys.slice(0, 2), signal);
  if (scoped.some((hit) => hit.text.includes(periods[2]!)))
    throw new Error("Another space's document leaked into the scope");
  console.log("PASS: revisions coexist, exact scope selects them, and other documents stay out.");
} finally {
  // Each document uses a unique fixture key; never delete pre-existing documents.
  for (const { key, taskId } of tasks) {
    const cleanupSignal = AbortSignal.timeout(15_000);
    const status = await provider.status(taskId, key, cleanupSignal).catch(() => "processing");
    if (status !== "processing") await provider.remove(key, cleanupSignal);
    else
      console.error(
        "A fixture upload is still processing; inspect the isolated instance's task list before cleanup.",
      );
  }
}
