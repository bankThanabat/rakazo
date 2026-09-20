import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("connector verification build target", () => {
  it.each(["ssh://example.invalid", "tcp://example.invalid:2375"])(
    "rejects a remote DOCKER_HOST before running Docker: %s",
    (host) => {
      expect(() =>
        execFileSync(process.execPath, ["scripts/verify-customer-connector.mjs"], {
          env: { ...process.env, DOCKER_CONTEXT: "", DOCKER_HOST: host, PATH: "" },
          stdio: "pipe",
          timeout: 5_000,
        }),
      ).toThrow(/remote Docker hosts are unsupported/);
    },
  );

  it("inspects a selected context and rejects its remote endpoint without contacting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "connector-context-test-"));
    const calls = join(directory, "calls");
    try {
      writeFileSync(
        join(directory, "docker"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CONNECTOR_TEST_CALLS"\nprintf '%s\\n' '[{"Endpoints":{"docker":{"Host":"ssh://example.invalid"}}}]'\n`,
        { mode: 0o700 },
      );
      expect(() =>
        execFileSync(process.execPath, ["scripts/verify-customer-connector.mjs"], {
          env: {
            ...process.env,
            DOCKER_CONTEXT: "remote-fixture",
            DOCKER_HOST: "unix:///ignored.sock",
            PATH: directory,
            CONNECTOR_TEST_CALLS: calls,
          },
          stdio: "pipe",
          timeout: 5_000,
        }),
      ).toThrow(/remote Docker hosts are unsupported/);
      expect(readFileSync(calls, "utf8")).toBe("context inspect\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
