#!/usr/bin/env node
// Verify upstream source trees without modifying operator-provided checkouts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("infra/compose/customer-sources.json", root), "utf8"));
const sourceArgument = process.argv.find((argument) => argument.startsWith("--source-root="));
const sourceRoot = sourceArgument
  ? pathToFileURL(`${resolve(sourceArgument.slice("--source-root=".length))}/`)
  : root;
for (const source of lock) {
  const cwd = fileURLToPath(new URL(source.path, sourceRoot));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (
    git("rev-parse", "HEAD^{tree}").trim() !== git("rev-parse", `${source.revision}^{tree}`).trim()
  )
    throw new Error(`${source.name}: source tree differs from the upstream release lock`);
  if (git("diff", "HEAD", "--binary"))
    throw new Error(`${source.name}: tracked source changes are outside the release lock`);
  console.log(`${source.name}: unmodified upstream source tree verified`);
}
