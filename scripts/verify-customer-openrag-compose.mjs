#!/usr/bin/env node
// Resolve the real Compose files with synthetic settings; never start containers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSource } from "./customer-sources.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "deskazo-compose-check-"));
try {
  const source = JSON.parse(readFileSync(join(root, "infra/compose/customer-sources.json"))).find(
    (entry) => entry.name === "OpenRAG",
  );
  assert(source);
  const prepared = join(temporary, "prepared");
  const operator = join(temporary, "operator/apps/openrag");
  mkdirSync(operator, { recursive: true });
  prepareSource(source, root, prepared);
  const env = {
    PATH: process.env.PATH,
    COMPOSE_DISABLE_ENV_FILE: "true",
    OPENRAG_SOURCE_ID: source.tree,
    OPENRAG_SOURCE_DIR: prepared,
    OPENSEARCH_PASSWORD: "Synthetic-Compose-Password-23!",
  };
  const config = (overlay) =>
    JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "--project-name",
          "synthetic-support-rag",
          "--project-directory",
          operator,
          "--env-file",
          "/dev/null",
          "-f",
          join(prepared, "docker-compose.yml"),
          ...(overlay ? ["-f", join(root, "infra/compose/customer-openrag.yml")] : []),
          "config",
          "--format",
          "json",
        ],
        { env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  const before = config(false);
  const after = config(true);
  for (const [name, service] of Object.entries(before.services)) {
    const actual = after.services[name];
    assert(actual);
    for (const volume of service.volumes ?? []) {
      assert.deepEqual(
        actual.volumes.find((v) => v.target === volume.target),
        volume,
        `${name}: existing volume configuration changed`,
      );
    }
    if (service.build) {
      assert.equal(actual.build.context, prepared);
      assert.equal(actual.build.dockerfile, service.build.dockerfile);
    }
  }
  assert.equal(after.services["openrag-backend"].image, `rakazo-openrag-backend:${source.tree}`);
  assert.equal(after.services["openrag-backend"].pull_policy, "never");
  const component = after.services.langflow.volumes.find(
    (v) => v.target === "/app/custom_components/rakazo",
  );
  assert.equal(component.source, join(temporary, "operator/infra/langflow/components/rakazo"));
  assert.equal(component.read_only, true);
  assert.equal(after.services["openrag-backend"].environment.OPENRAG_RBAC_ENFORCE, "true");
  console.log(
    "Real Compose resolution preserves existing mounts, uses prepared build contexts and locks the patched backend image.",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
