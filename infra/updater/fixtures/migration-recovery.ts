/** Disposable recovery verifier entrypoint. The production server never imports this file. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerUpdateRun } from "@rakazo/contracts";
import { createUpdaterApp, runCommand } from "../src/index.js";
import { resolveUpdaterConfig } from "../src/updater-logic.js";

const fixture = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  directory: string;
  project: string;
  imagePrefix: string;
  faultImage: string;
  failure: string;
};
assert.match(fixture.project, /^deskazo-product-recovery-[a-f0-9]{12}-source$/);
const commit = "2".repeat(40);
const token = "synthetic-updater-migration-test-token-00000";
const config = resolveUpdaterConfig({
  RAKAZO_DEPLOY_DIR: fixture.directory,
  COMPOSE_PROJECT_NAME: fixture.project,
  RAKAZO_COMPOSE_FILE: "compose.json",
  RAKAZO_IMAGE: fixture.imagePrefix,
  RAKAZO_UPDATER_TOKEN: token,
});
const subject = createUpdaterApp(config, {
  run: async (command, args, options) => {
    if (command === "git") {
      assert.deepEqual(args, ["ls-remote", "--tags", "--", "https://github.com/elie222/rakazo"]);
      return { ok: true, exitCode: 0, output: `${commit}\trefs/tags/v1.1.0` };
    }
    assert.equal(command, "docker");
    if (args.includes("pull")) {
      // Replace only registry download: verify the pre-created target is cached at the selected tag.
      const result = await runCommand(
        "docker",
        ["image", "inspect", `${fixture.imagePrefix}:sha-${commit}`, "--format", "{{.Id}}"],
        options,
      );
      assert.equal(result.ok, true);
      assert.equal(result.output.trim(), fixture.faultImage);
      return {
        ok: true,
        exitCode: 0,
        output: "Verified cached fault image; registry lookup omitted.",
      };
    }
    return runCommand(command, args, options);
  },
});
const response = await subject.request("/apply", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "main" }),
});
assert.equal(response.status, 200);
const record = (await response.json()) as ServerUpdateRun;
process.stdout.write(`${JSON.stringify(record)}\n`);
assert.equal(record.ok, false);
const automatic = fixture.failure === "startup-only";
assert.equal(record.restart, automatic ? "not-required" : "manual");
assert.equal(
  record.steps.some((step) => step.id === "recover" && step.ok),
  automatic,
);
assert.equal(record.steps.find((step) => step.id === "migrations-before")?.ok, true);
assert.equal(record.steps.find((step) => step.id === "recreate")?.ok, false);
assert.equal(record.steps.find((step) => step.id === "stop-failed-update")?.ok, true);
assert.equal(record.steps.find((step) => step.id === "migrations-after")?.ok, true);
assert.match(
  record.restartAdvice,
  automatic ? /restored the previously running/ : /migration history changed/,
);
const env = await readFile(path.join(fixture.directory, ".env"), "utf8");
assert.match(env, /RAKAZO_IMAGE_TAG=baseline/);
process.stdout.write(
  `${
    automatic
      ? "PASS: actual updater recovered the prior image with unchanged migration history"
      : "PASS: actual updater left changed migration state stopped instead of starting the prior image"
  }\n`,
);
