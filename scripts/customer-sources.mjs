#!/usr/bin/env node
// Build locked dependency sources separately; never modify an operator's checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

function readPatches(source, patchRoot) {
  assert.match(source.revision, /^[a-f0-9]{40}$/, "Source revision must be a full commit ID");
  assert.match(source.tree, /^[a-f0-9]{40}$/, "Patched source tree must be locked");
  return source.patches.map((patch) => {
    const path = resolve(patchRoot, patch.path);
    const fromRoot = relative(patchRoot, path);
    assert.ok(
      fromRoot && !fromRoot.startsWith("..") && !isAbsolute(fromRoot),
      "Patch must be inside the release checkout",
    );
    const bytes = readFileSync(path);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      patch.sha256,
      "Patch checksum differs from the release lock",
    );
    return { path, bytes };
  });
}

export function verifySource(source, sourceRoot, patchRoot = root) {
  const cwd = resolve(sourceRoot, source.path);
  if (source.patches) {
    readPatches(source, patchRoot);
    assert.equal(
      git(cwd, "cat-file", "-t", source.revision).trim(),
      "commit",
      "Locked upstream commit is unavailable",
    );
    return;
  }
  assert.equal(
    git(cwd, "rev-parse", "HEAD^{tree}").trim(),
    git(cwd, "rev-parse", `${source.revision}^{tree}`).trim(),
    `${source.name}: source tree differs from the upstream release lock`,
  );
  assert.equal(
    git(cwd, "diff", "HEAD", "--binary"),
    "",
    `${source.name}: tracked source changes are outside the release lock`,
  );
}

/** A fresh build directory contains only the pinned commit and checksum-locked patches.
 * Source edits, ignored files, hooks and credentials are never copied into it. */
export function prepareSource(source, sourceRoot, destination, patchRoot = root) {
  assert.match(source.revision, /^[a-f0-9]{40}$/, "Source revision must be a full commit ID");
  const patches = source.patches ? readPatches(source, patchRoot) : [];
  const cwd = resolve(sourceRoot, source.path);
  assert.equal(
    git(cwd, "cat-file", "-t", source.revision).trim(),
    "commit",
    "Locked upstream commit is unavailable",
  );
  const tree = source.patches
    ? source.tree
    : git(cwd, "rev-parse", `${source.revision}^{tree}`).trim();
  // Exclusive creation protects existing paths, including a symlink or an operator checkout.
  mkdirSync(destination);
  try {
    git(
      dirname(destination),
      "clone",
      "--shared",
      "--no-checkout",
      "--",
      resolve(sourceRoot, source.path),
      destination,
    );
    git(destination, "checkout", "--detach", source.revision);
    for (const patch of patches) {
      // Apply the already verified bytes, not a path that could change after its checksum check.
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "--index", "-"], {
        cwd: destination,
        input: patch.bytes,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    assert.equal(
      git(destination, "write-tree").trim(),
      tree,
      "Prepared source tree differs from the release lock",
    );
    rmSync(resolve(destination, ".git"), { recursive: true });
    writeFileSync(
      resolve(destination, "rakazo-source.json"),
      `${JSON.stringify(source, null, 2)}\n`,
      { flag: "wx" },
    );
    return tree;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(
    args.every(
      (arg) =>
        arg.startsWith("--source-root=") ||
        arg.startsWith("--prepare-connector=") ||
        arg.startsWith("--prepare-openrag=") ||
        arg === "--connector-id" ||
        arg === "--openrag-id",
    ),
    "Unknown source argument",
  );
  const sourceRoot = resolve(
    args.find((arg) => arg.startsWith("--source-root="))?.slice("--source-root=".length) ?? root,
  );
  const lock = JSON.parse(
    readFileSync(resolve(root, "infra/compose/customer-sources.json"), "utf8"),
  );
  const operations = args.filter((arg) => !arg.startsWith("--source-root="));
  assert.ok(operations.length <= 1, "Select one source operation");
  const openrag = operations[0]?.includes("openrag");
  const selected = lock.find((source) => source.name === (openrag ? "OpenRAG" : "OpenConnector"));
  assert.ok(selected, "Dependency source lock is missing");
  const output = operations.find((arg) => arg.startsWith("--prepare-"));
  if (operations[0]?.endsWith("-id")) {
    assert.ok(!output, "Select preparation or identity inspection");
    readPatches(selected, root);
    console.log(selected.tree);
  } else if (output) {
    console.log(
      prepareSource(selected, sourceRoot, resolve(output.slice(output.indexOf("=") + 1))),
    );
  } else {
    for (const source of lock) {
      verifySource(source, sourceRoot);
      console.log(
        `${source.name}: ${source.patches ? "pinned commit and patch checksums" : "unmodified upstream source tree"} verified`,
      );
    }
  }
}
