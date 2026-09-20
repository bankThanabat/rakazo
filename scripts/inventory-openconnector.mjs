#!/usr/bin/env node
// Read an upstream source checkout, without credentials or provider requests.
// Tested with Node 26; usage is in docs/research/deskazo-integrations.md.
import { execFileSync } from "node:child_process";
import { access, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [source, revision, output] = process.argv.slice(2);
if (!source || !/^[a-f0-9]{40}$/.test(revision ?? "") || !output) {
  throw new Error("Usage: node scripts/inventory-openconnector.mjs SOURCE COMMIT OUTPUT.tsv");
}
const root = resolve(source);
if (
  await access(resolve(root, ".git")).then(
    () => true,
    () => false,
  )
) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== revision)
    throw new Error("Source revision does not match COMMIT");
  if (git("status", "--porcelain", "--", "src/providers", "src/core")) {
    throw new Error("Source metadata has uncommitted changes");
  }
}
const moduleAt = (path) => import(pathToFileURL(resolve(root, path)).href);
const { resolveProviderScenario } = await moduleAt("src/core/provider-scenarios.ts");
const directories = (await readdir(resolve(root, "src/providers"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const columns = [
  "revision",
  "service",
  "name",
  "scenario",
  "categories",
  "auth_types",
  "action_count",
  "actions",
  "executor_file",
  "source",
];
const rows = [];
const counts = {};
for (const service of directories) {
  const path = `src/providers/${service}`;
  const { provider } = await moduleAt(`${path}/definition.ts`);
  if (provider.service !== service) throw new Error(`Provider directory mismatch: ${service}`);
  const actions = provider.actions.map((action) => action.id).sort();
  if (new Set(actions).size !== actions.length) throw new Error(`Duplicate action: ${service}`);
  const scenario = resolveProviderScenario(provider);
  counts[scenario] = (counts[scenario] ?? 0) + 1;
  const executor = await access(resolve(root, `${path}/executors.ts`)).then(
    () => "yes",
    () => "no",
  );
  rows.push([
    revision,
    service,
    provider.displayName,
    scenario,
    provider.categories.join(";"),
    provider.authTypes.join(";"),
    actions.length,
    actions.join(";"),
    executor,
    `https://github.com/oomol-lab/open-connector/blob/${revision}/${path}/definition.ts`,
  ]);
}
const cell = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ");
await writeFile(
  output,
  `${[columns, ...rows].map((row) => row.map(cell).join("\t")).join("\n")}\n`,
);
console.log(JSON.stringify({ revision, providers: rows.length, scenarios: counts }, null, 2));
