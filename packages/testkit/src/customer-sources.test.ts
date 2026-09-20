import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("prepares locked sources and controls deployed services without build inputs", () => {
  const result = spawnSync(process.execPath, ["--test", "scripts/customer-sources.test.mjs"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

it("isolates stack controls and preserves dependencies when shutdown fails", () => {
  const result = spawnSync("python3", ["scripts/customer-stack-control.test.py"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
