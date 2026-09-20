import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareSource, verifySource } from "./customer-sources.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rakazo-source-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "upstream");
  mkdirSync(source);
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Synthetic fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(source, ".gitignore"), ".env\nignored\n");
  writeFileSync(join(source, "feature.txt"), "first\nsecond\n");
  writeFileSync(join(source, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(source, "docker-compose.build.yml"), "services: {}\n");
  git("add", ".");
  git("commit", "-qm", "Synthetic source");
  const revision = git("rev-parse", "HEAD");
  const patches = [];
  for (const [index, text] of [
    "patched-first\nsecond\n",
    "patched-first\npatched-second\n",
  ].entries()) {
    writeFileSync(join(source, "feature.txt"), text);
    const bytes = Buffer.from(`${git("diff", "--binary")}\n`);
    const path = `patch-${index}.patch`;
    writeFileSync(join(root, path), bytes);
    patches.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
    git("add", "feature.txt");
  }
  const tree = git("write-tree");
  git("reset", "--hard", revision);
  const lock = { name: "Synthetic", path: "upstream", revision, tree, patches };
  return { root, source, lock, git, destination: join(root, "prepared") };
}

test("prepares only locked source and ordered patches, without changing dirty operator files", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, "feature.txt"), "Operator edit\n");
  writeFileSync(join(f.source, ".env"), "SYNTHETIC_SECRET=do-not-copy\n");
  writeFileSync(join(f.source, "ignored"), "Ignored content\n");
  writeFileSync(join(f.source, "untracked"), "Untracked content\n");
  const before = f.git("status", "--porcelain", "--ignored");
  assert.equal(prepareSource(f.lock, f.root, f.destination, f.root), f.lock.tree);
  assert.equal(
    readFileSync(join(f.destination, "feature.txt"), "utf8"),
    "patched-first\npatched-second\n",
  );
  for (const file of [".git", ".env", "ignored", "untracked"])
    assert.equal(existsSync(join(f.destination, file)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.destination, "rakazo-source.json"))), f.lock);
  assert.equal(f.git("status", "--porcelain", "--ignored"), before);
  assert.equal(readFileSync(join(f.source, "feature.txt"), "utf8"), "Operator edit\n");
  assert.equal(f.git("rev-parse", "HEAD"), f.lock.revision);
});

test("rejects altered patch bytes before creating output", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, f.lock.patches[0].path), "Altered patch\n");
  assert.throws(() => prepareSource(f.lock, f.root, f.destination, f.root), /checksum/);
  assert.equal(existsSync(f.destination), false);
});

test("rejects an incorrect final tree and removes only its own incomplete output", (t) => {
  const f = fixture(t);
  assert.throws(
    () => prepareSource({ ...f.lock, tree: "0".repeat(40) }, f.root, f.destination, f.root),
    /Prepared source tree/,
  );
  assert.equal(existsSync(f.destination), false);
  assert.equal(f.git("rev-parse", "HEAD"), f.lock.revision);
});

test("never overwrites an existing destination", (t) => {
  const f = fixture(t);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, "keep"), "Operator file");
  assert.throws(() => prepareSource(f.lock, f.root, f.destination, f.root), /EEXIST/);
  assert.equal(readFileSync(join(f.destination, "keep"), "utf8"), "Operator file");
});

test("rejects patches outside the release root", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      prepareSource(
        { ...f.lock, patches: [{ path: "../outside.patch", sha256: "0".repeat(64) }] },
        f.root,
        f.destination,
        f.root,
      ),
    /inside the release/,
  );
  assert.equal(existsSync(f.destination), false);
});

test("preserves unpatched source verification for OpenRAG", (t) => {
  const f = fixture(t);
  const lock = { name: "OpenRAG", path: f.lock.path, revision: f.lock.revision };
  verifySource(lock, f.root);
  writeFileSync(join(f.source, "feature.txt"), "Operator edit\n");
  assert.throws(() => verifySource(lock, f.root), /outside the release lock/);
});

test("prepares an unpatched pinned commit without copying or changing a later dirty checkout", (t) => {
  const f = fixture(t);
  const lock = { name: "OpenRAG", path: f.lock.path, revision: f.lock.revision };
  const tree = f.git("rev-parse", `${lock.revision}^{tree}`);
  writeFileSync(join(f.source, "feature.txt"), "Later commit\n");
  f.git("add", "feature.txt");
  f.git("commit", "-qm", "Synthetic later source");
  writeFileSync(join(f.source, "feature.txt"), "Operator edit\n");
  writeFileSync(join(f.source, ".env"), "SYNTHETIC_SECRET=do-not-copy\n");
  writeFileSync(join(f.source, "untracked"), "Untracked content\n");
  const head = f.git("rev-parse", "HEAD");
  const before = f.git("status", "--porcelain", "--ignored");
  assert.equal(prepareSource(lock, f.root, f.destination, f.root), tree);
  assert.equal(readFileSync(join(f.destination, "feature.txt"), "utf8"), "first\nsecond\n");
  for (const file of [".git", ".env", "untracked"])
    assert.equal(existsSync(join(f.destination, file)), false);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("status", "--porcelain", "--ignored"), before);
});

for (const fail of ["", "connector", "rag"])
  test(`stack builds only prepared sources and cleans them on ${fail || "success"}`, (t) => {
    const f = fixture(t);
    for (const path of ["scripts", "infra/compose", "apps", "bin", "tmp"])
      mkdirSync(join(f.root, path), { recursive: true });
    symlinkSync(f.source, join(f.root, "infra/open-connector"), "dir");
    symlinkSync(f.source, join(f.root, "apps/openrag"), "dir");
    for (const file of ["customer-sources.mjs", "customer-stack.sh"])
      copyFileSync(new URL(file, import.meta.url), join(f.root, "scripts", file));
    const connector = { ...f.lock, name: "OpenConnector", path: "infra/open-connector" };
    const lock = [{ ...f.lock, name: "OpenRAG", path: "apps/openrag" }, connector];
    writeFileSync(join(f.root, "infra/compose/customer-sources.json"), JSON.stringify(lock));
    for (const name of [
      "customer-connector.yml",
      "customer-openrag.yml",
      "docker-compose.yml",
      "customer-rakazo.yml",
    ])
      writeFileSync(join(f.root, "infra/compose", name), "services: {}\n");
    writeFileSync(join(f.root, ".env"), "SYNTHETIC=1\n");
    writeFileSync(join(f.source, ".env"), "SYNTHETIC=1\n");
    writeFileSync(join(f.source, "feature.txt"), "Operator edit\n");
    const before = f.git("status", "--porcelain", "--ignored");
    const log = join(f.root, "docker-calls.jsonl");
    writeFileSync(
      join(f.root, "bin/docker"),
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SYNTHETIC_DOCKER_LOG, JSON.stringify({ args, sourceId: process.env.OPENCONNECTOR_SOURCE_ID, openragId: process.env.OPENRAG_SOURCE_ID, openragSource: process.env.OPENRAG_SOURCE_DIR }) + "\\n");
if (args.includes("rakazo-support-connector") || args.includes("rakazo-support-rag")) {
  const source = path.dirname(args[args.indexOf("-f") + 1]);
  if (fs.readFileSync(path.join(source, "feature.txt"), "utf8") !== "patched-first\\npatched-second\\n") throw new Error("Unpatched source reached Docker");
  if (fs.existsSync(path.join(source, ".env"))) throw new Error("Credential file reached build context");
  if (args.includes("rakazo-support-rag")) {
    if (source !== process.env.OPENRAG_SOURCE_DIR) throw new Error("OpenRAG build context differs from prepared source");
    if (fs.realpathSync(args[args.indexOf("--project-directory") + 1]) !== fs.realpathSync(path.join(process.cwd(), "apps/openrag"))) throw new Error("Persistent paths moved");
  }
  if (args.includes("rakazo-support-" + process.env.SYNTHETIC_BUILD_FAIL)) process.exit(7);
}
`,
      { mode: 0o755 },
    );
    const result = (() => {
      try {
        execFileSync("bash", [join(f.root, "scripts/customer-stack.sh"), "up"], {
          env: {
            ...process.env,
            PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
            TMPDIR: join(f.root, "tmp"),
            SYNTHETIC_DOCKER_LOG: log,
            SYNTHETIC_BUILD_FAIL: fail,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        return 0;
      } catch (error) {
        assert.equal(error.status, 7, error.stderr?.toString());
        return error.status;
      }
    })();
    assert.equal(result, fail ? 7 : 0);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const builds = calls.filter((call) => call.args[0] === "compose");
    assert.equal(builds.length, fail === "connector" ? 1 : fail === "rag" ? 2 : 3);
    const connectorCall = builds[0];
    assert.equal(connectorCall.sourceId, f.lock.tree);
    assert.ok(connectorCall.args.includes("--build"));
    const prepared = connectorCall.args[connectorCall.args.indexOf("-f") + 1];
    assert.equal(existsSync(prepared), false);
    assert.equal(connectorCall.openragId, f.lock.tree);
    assert.equal(existsSync(connectorCall.openragSource), false);
    assert.equal(readFileSync(join(f.source, ".env"), "utf8"), "SYNTHETIC=1\n");
    assert.equal(f.git("rev-parse", "HEAD"), f.lock.revision);
    assert.equal(f.git("status", "--porcelain", "--ignored"), before);
  });

for (const action of ["ps", "stop"])
  test(`stack ${action} works without source checkouts, locks or environment files`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "rakazo-control-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    for (const file of ["customer-stack.sh", "customer-stack-control.py"])
      copyFileSync(new URL(file, import.meta.url), join(root, "scripts", file));
    const log = join(root, "calls.jsonl");
    writeFileSync(
      join(root, "bin/docker"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "ps") throw new Error("Empty projects must only be inspected");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
`,
      { mode: 0o755 },
    );
    execFileSync("bash", [join(root, "scripts/customer-stack.sh"), action], {
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const projects = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).at(-1));
    const expected = ["rakazo-support", "rakazo-support-rag", "rakazo-support-connector"];
    assert.deepEqual(
      [...new Set(projects)],
      expected.map((name) => `label=com.docker.compose.project=${name}`),
    );
  });
