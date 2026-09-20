#!/usr/bin/env node
// Verify that the saved patches reproduce the tested provider source; --write refreshes the cart patch.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.argv[2], "Provide the tested OpenConnector source checkout");
assert.ok(
  process.argv.length <= 4 && (!process.argv[3] || process.argv[3] === "--write"),
  "Only --write is supported",
);
const source = resolve(process.argv[2]);
const revision = "9e11b04c46df3cefad0bed1d4f2765e24d2ef126";
const prefix = "src/providers/woocommerce";
const files = [
  "actions.ts",
  "runtime.ts",
  "order-payment.test.ts",
  "store-actions.ts",
  "store-runtime.ts",
  "store-api.test.ts",
];
const patches = ["woocommerce-order-payment.patch", "woocommerce-store-api.patch"].map((name) =>
  resolve(root, "infra/open-connector-patches", name),
);
const directory = await mkdtemp(join(tmpdir(), "deskazo-woo-patch-"));
const checkout = join(directory, "source");
const git = async (...args) =>
  (await exec("git", ["-C", checkout, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  await exec("git", ["clone", "--shared", "--no-checkout", source, checkout]);
  await git("checkout", "--detach", revision);
  await git("apply", patches[0]);
  if (process.argv[3] === "--write") {
    await git("add", prefix);
    for (const file of files)
      await copyFile(join(source, prefix, file), join(checkout, prefix, file));
    await git("add", "--intent-to-add", prefix);
    await writeFile(patches[1], await git("diff", "--binary", "--", prefix));
    // Reset only this disposable checkout, then verify the exact published artifacts.
    await git("reset", "--hard", revision);
    await git("clean", "-fd");
    await git("apply", patches[0]);
  }
  await git("apply", patches[1]);
  const hashes = {};
  for (const file of files) {
    const expected = digest(await readFile(join(source, prefix, file)));
    assert.equal(
      digest(await readFile(join(checkout, prefix, file))),
      expected,
      `Patch reproduces ${file}`,
    );
    hashes[file] = expected;
  }
  console.log(
    JSON.stringify(
      {
        status: "passed",
        sourceRevision: revision,
        providerFiles: hashes,
        patchSha256: await Promise.all(patches.map(async (path) => digest(await readFile(path)))),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
