import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdaterCommandRunner } from "./index.js";
import { createUpdaterApp } from "./index.js";
import type { MigrationState } from "./migration-state.js";
import { MIGRATION_STATE_PREFIX } from "./migration-state.js";
import { resolveUpdaterConfig } from "./updater-logic.js";

const directories: string[] = [];
const token = "synthetic-migration-updater-token-000000000";
const baseline: MigrationState = {
  database: "a".repeat(64),
  history: "b".repeat(64),
  complete: true,
  matchesHistory: true,
  matchesImage: true,
};
const original = "RAKAZO_IMAGE_TAG=v1.0.0\nRAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0\n";
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function attempt(states: Array<MigrationState | null>, route = "/apply") {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-migration-guard-"));
  directories.push(deployDir);
  await writeFile(path.join(deployDir, ".env"), original);
  const calls: string[][] = [];
  let probes = 0;
  let starts = 0;
  const run: UpdaterCommandRunner = async (command, args) => {
    if (command === "git")
      return {
        ok: true,
        exitCode: 0,
        output: `${"2".repeat(40)}\trefs/tags/v1.1.0`,
      };
    calls.push(args);
    if (args.includes("run")) {
      const state = states[probes++];
      return {
        ok: state !== null,
        exitCode: state === null ? 1 : 0,
        output: state ? MIGRATION_STATE_PREFIX + JSON.stringify(state) : "probe unavailable",
      };
    }
    if (args.includes("up") && ++starts === 1)
      return { ok: false, exitCode: 1, output: "new API failed" };
    return { ok: true, exitCode: 0, output: "" };
  };
  const app = createUpdaterApp(
    resolveUpdaterConfig({
      RAKAZO_DEPLOY_DIR: deployDir,
      RAKAZO_UPDATER_TOKEN: token,
    }),
    { run },
  );
  const response = await app.request(route, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
    }),
  });
  expect(response.status).toBe(200);
  return {
    record: (await response.json()) as ServerUpdateRun,
    calls,
    starts,
    env: await readFile(path.join(deployDir, ".env"), "utf8"),
  };
}

describe("migration-aware updater recovery", () => {
  it.each([
    {
      name: "successful new migration",
      after: { ...baseline, history: "c".repeat(64), matchesImage: false },
    },
    {
      name: "failed migration",
      after: { ...baseline, complete: false, history: "c".repeat(64) },
    },
    {
      name: "different database",
      after: { ...baseline, database: "c".repeat(64) },
    },
    {
      name: "prior image with different migration SQL",
      after: { ...baseline, matchesImage: false },
    },
    { name: "unreadable migration state", after: null },
  ])("keeps services stopped after $name", async ({ after }) => {
    const result = await attempt([baseline, after]);
    expect(result.starts).toBe(1);
    expect(result.record).toMatchObject({ ok: false, restart: "manual" });
    expect(result.record.steps.some((s) => s.id === "recover")).toBe(false);
    expect(result.record.restartAdvice).toContain("Services remain stopped");
    expect(result.calls.filter((a) => a.includes("stop"))).toHaveLength(2);
    expect(result.env).toBe(original);
  });
  it("retains automatic image recovery when history is unchanged and the old image matches", async () => {
    const result = await attempt([{ ...baseline, matchesImage: false }, baseline]);
    expect(result.starts).toBe(2);
    expect(result.record).toMatchObject({ ok: false, restart: "not-required" });
    expect(result.record.steps.at(-1)).toMatchObject({
      id: "recover",
      ok: true,
    });
  });
  it.each([
    null,
    { ...baseline, complete: false },
    { ...baseline, matchesHistory: false, matchesImage: false },
  ])("does not start on an unverified initial migration state", async (state) => {
    const result = await attempt([state]);
    expect(result.starts).toBe(0);
    expect(result.record.restart).toBe("manual");
    expect(result.env).toBe(original);
  });
  it.each([null, { ...baseline, matchesImage: false }])(
    "refuses incompatible explicit rollback before stopping services",
    async (state) => {
      const result = await attempt([state], "/rollback");
      expect(result.starts).toBe(0);
      expect(result.calls.some((a) => a.includes("stop"))).toBe(false);
      expect(result.record).toMatchObject({
        ok: false,
        restart: "not-required",
      });
      expect(result.env).toBe(original);
    },
  );
  it("rechecks explicit rollback after quiescing to catch an intervening migration", async () => {
    const result = await attempt([baseline, { ...baseline, matchesImage: false }], "/rollback");
    expect(result.starts).toBe(0);
    expect(result.calls.filter((a) => a.includes("stop"))).toHaveLength(1);
    expect(result.record.restart).toBe("manual");
  });
});
