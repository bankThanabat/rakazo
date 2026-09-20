#!/usr/bin/env -S pnpm exec tsx
/** Generate synthetic playground requests using the real adapter's question definitions.
 * No provider calls or credentials. Usage: pnpm exec tsx scripts/prepare-jev-acceptance.mts <output-directory> [observations.json]
 * Optional observed responses are replayed through the adapter; mismatched outcomes exit nonzero.
 * Fixture outcomes are desired synthetic behavior, not merchant-adjudicated labels.
 * Prepared request hashes identify source/content; they are not captured browser traffic.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JevCustomerAssessment } from "../packages/adapters/src/customer-assessment.js";

assert.ok(process.argv[2]);
const directory = resolve(process.argv[2]!);
mkdirSync(directory, { recursive: true });
const source = fileURLToPath(
  new URL("../packages/adapters/src/customer-assessment.ts", import.meta.url),
);
const fixtures = fileURLToPath(new URL("./fixtures/jev-escalation-cases.json", import.meta.url));
const cases = JSON.parse(readFileSync(fixtures, "utf8"));
const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
const observations = process.argv[3]
  ? JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"))
  : undefined;
if (observations) {
  assert.equal(observations.sourceHash, sourceHash, "Observations must match this adapter version");
  assert.deepEqual(
    observations.cases.map((item: { id: string }) => item.id).sort(),
    cases.map((item: { id: string }) => item.id).sort(),
  );
}
const hashes: Record<string, string> = {};
const results = [];
for (const entry of cases) {
  let body: unknown;
  const observed = observations?.cases.find((item: { id: string }) => item.id === entry.id);
  const adapter = new JevCustomerAssessment(
    { baseUrl: "https://unused.example.test", apiKey: "synthetic-unused", model: "jev-latest" },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      const choice = (value: string) => ({ type: "choice", choice: value, confidence: 1 });
      return Response.json(
        observed ?? {
          answers: {
            human: choice("no"),
            unresolved: choice("no"),
            supported: choice("yes"),
            configured: choice("no"),
          },
        },
      );
    },
  );
  const result = await adapter.assess({
    messages: entry.messages,
    criteria: entry.criteria,
    signal: new AbortController().signal,
  });
  const text = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(resolve(directory, `${entry.id}.json`), text, { mode: 0o600 });
  hashes[entry.id] = createHash("sha256").update(text).digest("hex");
  if (observed) {
    assert.equal(hashes[entry.id], observations.requestHashes[entry.id]);
    results.push({
      id: entry.id,
      ...result,
      expectedNeedsHuman: entry.expectedNeedsHuman,
      configuredMatches: observed.answers.configured.choice === entry.expectedConfigured,
      outcomeMatches: result.needsHuman === entry.expectedNeedsHuman,
    });
  }
}
writeFileSync(
  resolve(directory, "requests-manifest.json"),
  JSON.stringify(
    {
      sourceHash,
      fixturesHash: createHash("sha256").update(readFileSync(fixtures)).digest("hex"),
      hashes,
      scope:
        "Generated requests only. Synthetic mocked responses do not establish provider quality.",
    },
    null,
    2,
  ),
);
console.log(
  `Generated ${cases.length} requests from the real assessment adapter; no network calls.`,
);
if (observations) {
  writeFileSync(
    resolve(directory, "evaluation.json"),
    JSON.stringify(
      {
        results,
        scope:
          "Offline replay of manually observed playground JSON. Single synthetic samples do not establish merchant quality or live app integration.",
      },
      null,
      2,
    ),
  );
  const mismatches = results.filter((item) => !item.configuredMatches || !item.outcomeMatches);
  console.log(
    JSON.stringify({ cases: results.length, mismatches: mismatches.map((item) => item.id) }),
  );
  if (mismatches.length) process.exitCode = 1;
}
