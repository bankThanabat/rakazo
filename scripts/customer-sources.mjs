#!/usr/bin/env node
// Verify or apply the exact support changes against operator-provided source checkouts.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("patches/customer-stack/sources.json", root), "utf8"));
const apply = process.argv.includes("--apply");
const sourceArgument = process.argv.find((argument) => argument.startsWith("--source-root="));
const sourceRoot = sourceArgument
  ? pathToFileURL(`${resolve(sourceArgument.slice("--source-root=".length))}/`)
  : root;
for (const source of lock) {
  const cwd = fileURLToPath(new URL(source.path, sourceRoot));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (git("rev-parse", "HEAD").trim() !== source.revision)
    throw new Error(`${source.name}: source revision differs from the support lock`);
  let expectedDiff = "";
  if (source.patch) {
    const patch = fileURLToPath(new URL(source.patch, root));
    expectedDiff = readFileSync(patch, "utf8");
    if (createHash("sha256").update(readFileSync(patch)).digest("hex") !== source.sha256)
      throw new Error(`${source.name}: patch checksum mismatch`);
    const installed = () =>
      spawnSync("git", ["apply", "--reverse", "--check", patch], { cwd, stdio: "ignore" })
        .status === 0;
    if (!installed() && apply) {
      git("apply", "--check", patch);
      git("apply", patch);
    }
    if (!installed())
      throw new Error(`${source.name}: run this script with --apply to install the checked patch`);
  }
  if (git("diff", "HEAD", "--binary") !== expectedDiff)
    throw new Error(
      `${source.name}: additional tracked source changes are outside the release lock`,
    );
  console.log(`${source.name}: compatible source revision and support patch verified`);
}
