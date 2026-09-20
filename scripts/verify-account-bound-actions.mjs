#!/usr/bin/env node
// Apply the saved account guard patch to a disposable pinned checkout and test its real handlers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
assert.equal(
  process.argv.length,
  3,
  "Provide an OpenConnector checkout with installed dependencies",
);
const source = resolve(process.argv[2]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "9e11b04c46df3cefad0bed1d4f2765e24d2ef126";
const patch = join(root, "infra/open-connector-patches/account-bound-actions.patch");
const dependencies = await realpath(join(source, "node_modules"));
const directory = await mkdtemp(join(tmpdir(), "deskazo-account-guard-"));
const checkout = join(directory, "source");
const run = async (command, args) => {
  try {
    const result = await exec(command, args, { cwd: checkout, maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    process.stdout.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw error;
  }
};
try {
  await exec("git", ["clone", "--shared", "--no-checkout", source, checkout]);
  await run("git", ["checkout", "--detach", revision]);
  await run("git", ["apply", "--check", patch]);
  await run("git", ["apply", patch]);
  await symlink(dependencies, join(checkout, "node_modules"), "dir");
  await run("npm", ["run", "generate:catalog"]);
  await run("npm", ["run", "fix-check"]);
  // fix-check must not silently repair the published patch or unrelated tracked source.
  const diff = await exec("git", ["diff", "--binary"], {
    cwd: checkout,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    diff.stdout,
    await readFile(patch, "utf8"),
    "Patch must already pass formatting and lint fixes",
  );
  await run("npm", [
    "test",
    "--",
    "src/server/actions/action-runner.test.ts",
    "src/server/actions/action-idempotency.test.ts",
    "src/server/connect-server.test.ts",
    "src/server/api/openapi.test.ts",
  ]);
  // The separately shipped reply capability must compose with the account guard.
  await run("git", [
    "apply",
    join(root, "infra/open-connector-patches/instagram-comment-replies.patch"),
  ]);
  await run("npm", ["run", "generate:catalog"]);
  await run("npm", ["run", "fix-check"]);
  await run("npm", ["test", "--", "src/providers/instagram/comment-replies.test.ts"]);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        sourceRevision: revision,
        patchSha256: createHash("sha256")
          .update(await readFile(patch))
          .digest("hex"),
        verification: [
          "catalog generation",
          "lint",
          "format",
          "src/scripts/examples typechecks",
          "offline account guard and idempotency tests",
          "reply patch composition and handler tests",
          "patch unchanged by fixes",
        ],
        deployed: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
