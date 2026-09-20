import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

it("rejects unsafe deployment snapshots and resumes writers on failure", () => {
  const result = spawnSync("python3", ["scripts/deployment-backup.test.py"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

// No automatic discovery of an operator's default Compose stack. This opt-in
// driver owns uniquely named projects and volumes and uses only synthetic data.
it.skipIf(process.env.RAKAZO_BACKUP_RECOVERY_TEST !== "1")(
  "recovers a disposable deployment without touching existing stacks",
  () => {
    const result = spawnSync("python3", ["scripts/verify-deployment-backup.py"], {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Disposable core-deployment recovery checks passed.");
  },
  310_000,
);
