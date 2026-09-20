import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  canRestoreImage,
  MIGRATION_STATE_PREFIX,
  MIGRATION_STATE_PROBE,
  parseMigrationState,
} from "./migration-state.js";

const state = {
  database: "a".repeat(64),
  history: "b".repeat(64),
  complete: true,
  matchesHistory: true,
  matchesImage: true,
};

describe("migration recovery guard", () => {
  it("accepts only one complete probe response amid Compose diagnostics", () => {
    const output = MIGRATION_STATE_PREFIX + JSON.stringify(state);
    expect(
      parseMigrationState(`Container probe created\n${output}\nContainer probe removed`),
    ).toEqual(state);
    for (const invalid of [
      "",
      output + "\n" + output,
      MIGRATION_STATE_PREFIX + "null",
      MIGRATION_STATE_PREFIX + "{}",
      MIGRATION_STATE_PREFIX + "{",
      MIGRATION_STATE_PREFIX + JSON.stringify({ ...state, complete: "true" }),
    ]) {
      expect(parseMigrationState(invalid)).toBeNull();
    }
  });
  it("requires unchanged database and history plus a matching prior image", () => {
    expect(canRestoreImage({ ...state, matchesImage: false }, state)).toBe(true);
    for (const change of [
      { database: "c".repeat(64) },
      { history: "c".repeat(64) },
      { complete: false },
      { matchesHistory: false },
      { matchesImage: false },
    ]) {
      expect(canRestoreImage(state, { ...state, ...change })).toBe(false);
    }
    expect(canRestoreImage({ ...state, complete: false }, state)).toBe(false);
    expect(canRestoreImage({ ...state, matchesHistory: false }, state)).toBe(false);
  });
});

// Execute the production probe with deterministic filesystem/database boundaries.
async function probe(
  url: string,
  files = { "0001_example": "SELECT 1;" } as Record<string, string>,
) {
  const outputs: string[] = [];
  const checksum = createHash("sha256").update("SELECT 1;").digest("hex");
  class Client {
    async connect() {}
    on() {}
    async end() {}
    async query(sql: string) {
      return {
        rows: sql.includes("current_database()")
          ? [
              {
                database: "example",
                schema: "public",
                server: "172.20.0.2",
                port: 5432,
              },
            ]
          : [
              {
                id: "migration-id",
                checksum,
                migration_name: "0001_example",
                started_at: "2026-01-01",
                finished_at: "2026-01-01",
                rolled_back_at: null,
                applied_steps_count: 1,
              },
            ],
      };
    }
  }
  await new Script(
    `(async()=>{${MIGRATION_STATE_PROBE.replace(/^import .*;$/gm, "")}})()`,
  ).runInNewContext({
    URL,
    createHash,
    createRequire: () => () => ({ Client }),
    readdir: async () => Object.keys(files).map((name) => ({ name, isDirectory: () => true })),
    readFile: async (file: string) => Buffer.from(files[file.split("/").at(-2)!]!),
    process: { env: { DATABASE_URL: url } },
    console: {
      log: (value: string) => outputs.push(value),
      error: (value: string) => {
        throw Error(value);
      },
    },
  });
  return {
    state: parseMigrationState(outputs.join("\n")),
    output: outputs.join("\n"),
  };
}

it("does not retain database credentials or an offline password verifier", async () => {
  const firstUrl =
    "postgresql://example:synthetic-password-one@postgres:5432/example?password=also-private";
  const secondUrl =
    "postgresql://example:synthetic-password-two@postgres:5432/example?password=changed-private";
  const first = await probe(firstUrl);
  const second = await probe(secondUrl);
  expect(first.state).toMatchObject({ complete: true, matchesImage: true });
  expect(first.state?.database).toBe(second.state?.database);
  expect(first.output).not.toContain(firstUrl);
  expect(first.output).not.toContain("synthetic-password-one");
  expect(first.output).not.toContain(createHash("sha256").update(firstUrl).digest("hex"));
});

it("permits pending migrations but rejects missing or edited applied migration SQL", async () => {
  const url = "postgresql://example:synthetic@postgres:5432/example";
  const pending = await probe(url, {
    "0001_example": "SELECT 1;",
    "0002_new": "SELECT 2;",
  });
  expect(pending.state).toMatchObject({
    complete: true,
    matchesHistory: true,
    matchesImage: false,
  });
  const incompatibleFiles: Array<Record<string, string>> = [{}, { "0001_example": "SELECT 2;" }];
  for (const files of incompatibleFiles) {
    const result = await probe(url, files);
    expect(result.state).toMatchObject({
      complete: true,
      matchesHistory: false,
      matchesImage: false,
    });
  }
});
