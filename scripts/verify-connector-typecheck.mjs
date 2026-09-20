#!/usr/bin/env node
// Exercise the locked typecheck runner with compilers that reject concurrent execution.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSource } from "./customer-sources.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const connector = JSON.parse(readFileSync(join(root, "infra/compose/customer-sources.json"))).find(
  (source) => source.name === "OpenConnector",
);
assert.ok(process.argv.length === 2 || process.argv[2] === "--upstream");
const directory = mkdtempSync(join(tmpdir(), "deskazo-typecheck-"));
try {
  const source = join(directory, "source");
  prepareSource(connector, root, source);
  const runner = join(source, "scripts/typecheck.ts");
  if (process.argv[2] === "--upstream") {
    writeFileSync(
      runner,
      execFileSync("git", ["show", `${connector.revision}:scripts/typecheck.ts`], {
        cwd: join(root, connector.path),
      }),
    );
  }
  const bin = join(source, "node_modules/typescript/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "tsc"),
    `
const { mkdirSync, rmdirSync, appendFileSync } = require('node:fs');
const project = process.argv[process.argv.indexOf('-p') + 1];
try { mkdirSync('.compiler-lock'); }
catch { console.error('Overlapping compiler: ' + project); process.exit(2); }
appendFileSync('compiler-events', project + '\\n');
setTimeout(() => {
  rmdirSync('.compiler-lock');
  if (project === 'scripts/tsconfig.json' && process.env.FIXTURE_FAIL === '1') {
    console.error('synthetic diagnostic');
    process.exitCode = 1;
  }
}, 100);
`,
  );
  for (const fail of [false, true]) {
    rmSync(join(source, "compiler-events"), { force: true });
    const result = spawnSync(process.execPath, [runner], {
      cwd: source,
      env: { ...process.env, FIXTURE_FAIL: fail ? "1" : "0" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.doesNotMatch(result.stderr, /Overlapping compiler/);
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.equal(
      readFileSync(join(source, "compiler-events"), "utf8"),
      "src/tsconfig.json\nscripts/tsconfig.json\nexamples/tsconfig.json\n",
    );
    if (fail) assert.match(result.stderr, /\[scripts\][\s\S]*synthetic diagnostic/);
    else assert.match(result.stdout, /Typechecked src, scripts, examples/);
  }
  console.log(
    "Passed: compilers run sequentially; every project runs; diagnostics and failure exit code survive.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
