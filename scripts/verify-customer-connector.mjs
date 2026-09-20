#!/usr/bin/env node
// Build the actual locked Docker source and inspect an isolated runtime without provider traffic.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareSource } from "./customer-sources.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(join(root, "infra/compose/customer-sources.json"), "utf8"));
const connector = lock.find((source) => source.name === "OpenConnector");
const args = process.argv.slice(2);
assert.ok(
  args.every((arg) => arg === "--retain-runtime" || /^--platform=linux\/(amd64|arm64)$/.test(arg)),
  "Unknown verifier argument",
);
assert.ok(
  args.filter((arg) => arg.startsWith("--platform=")).length <= 1,
  "Specify one target platform",
);
const platform = args.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length);
const platformArgs = platform ? ["--platform", platform] : [];
const exec = promisify(execFile);
// Source builds can exhaust a shared service host. Use a build machine's local
// daemon; never redirect this verifier to a hosted service's remote Docker API.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Docker CLI endpoint selection.
const explicitHost = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
const endpoint =
  explicitHost ||
  JSON.parse(
    (await exec("docker", ["context", "inspect"], { timeout: 10_000, killSignal: "SIGKILL" }))
      .stdout,
  )[0]?.Endpoints?.docker?.Host;
assert.ok(
  typeof endpoint === "string" && /^(unix|npipe):\/\//.test(endpoint),
  "Connector verification requires a local Docker endpoint on a build machine; remote Docker hosts are unsupported",
);

const buildkitImage =
  "moby/buildkit@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec";
const frontend =
  "docker/dockerfile@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12";
const directory = await mkdtemp(join(tmpdir(), "rakazo-connector-verify-"));
const source = join(directory, "source");
const name = `rakazo-connector-check-${randomUUID()}`;
const builderContainer = `buildx_buildkit_${name}0`;
const builderVolume = `${builderContainer}_state`;
const runtime = `${name}:runtime`;
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort());
const docker = (...args) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
        signal: controller.signal,
        timeout: 20 * 60_000,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              `Docker ${args[0]} failed (${error.code ?? error.signal ?? "cancelled"}); see streamed output`,
            ),
          );
        else resolve(stdout.trim());
      },
    );
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  });
const tests = [
  "src/server/actions/action-runner.test.ts",
  "src/server/actions/action-idempotency.test.ts",
  "src/server/connect-server.test.ts",
  "src/server/api/openapi.test.ts",
  "src/providers/instagram/comment-replies.test.ts",
  "src/providers/instagram/message-history.test.ts",
  "src/providers/woocommerce/order-payment.test.ts",
  "src/providers/woocommerce/store-api.test.ts",
  "src/mail/imap-smtp/runtime.test.ts",
  "src/mail/imap-smtp/host-pinning.test.ts",
  "src/providers/generic_imap/network-access.test.ts",
];
let builderAttempted = false;
let retainRuntime = false;
let report;
try {
  prepareSource(connector, root, source);
  const audit = await exec("npm", ["audit", "--omit=dev", "--json", "--ignore-scripts"], {
    cwd: source,
    signal: controller.signal,
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  assert.equal(
    JSON.parse(audit.stdout).metadata.vulnerabilities.total,
    0,
    "Production dependency advisories require review",
  );
  console.log("Production dependency audit reports zero known advisories.");
  const composed = await exec(
    "docker",
    [
      "compose",
      "--project-name",
      name,
      "--env-file",
      "/dev/null",
      "-f",
      join(source, "docker-compose.yml"),
      "-f",
      join(source, "docker-compose.build.yml"),
      "-f",
      join(root, "infra/compose/customer-connector.yml"),
      "config",
      "--format",
      "json",
    ],
    {
      env: { ...process.env, OPENCONNECTOR_SOURCE_ID: connector.tree },
      signal: controller.signal,
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  const service = JSON.parse(composed.stdout).services.connector;
  assert.equal(service.build.context, source);
  assert.equal(service.image, `rakazo-openconnector:${connector.tree}`);
  assert.equal(service.pull_policy, "never");
  assert.equal(service.volumes.find((volume) => volume.target === "/app/data").type, "volume");
  const config = join(directory, "buildkitd.toml");
  await writeFile(config, "[worker.oci]\n  max-parallelism = 1\n");
  builderAttempted = true;
  await docker(
    "buildx",
    "create",
    "--name",
    name,
    "--driver",
    "docker-container",
    "--buildkitd-config",
    config,
    "--driver-opt",
    `image=${buildkitImage}`,
    "--driver-opt",
    "memory=4g",
    "--driver-opt",
    "memory-swap=4g",
    "--driver-opt",
    "cpu-period=100000",
    "--driver-opt",
    "cpu-quota=200000",
    "--driver-opt",
    "restart-policy=no",
    endpoint,
  );
  await docker("buildx", "inspect", "--bootstrap", name);
  const limits = JSON.parse(
    await docker("inspect", builderContainer, "--format", "{{json .HostConfig}}"),
  );
  assert.equal(limits.Memory, 4 * 1024 ** 3);
  assert.equal(limits.MemorySwap, 4 * 1024 ** 3);
  assert.equal(limits.CpuQuota, 200000);
  assert.equal(limits.CpuPeriod, 100000);
  const availableKiB = Number(
    await docker("exec", builderContainer, "awk", "/^MemAvailable:/ {print $2}", "/proc/meminfo"),
  );
  assert.ok(
    availableKiB >= 4 * 1024 ** 2,
    "Build machine needs at least 4 GiB available memory before compilation",
  );
  const build = [
    "buildx",
    "build",
    "--builder",
    name,
    ...platformArgs,
    "--progress",
    "plain",
    "--resource",
    "memory=3g",
    "--resource",
    "memory-swap=3g",
    "--resource",
    "cpu-period=100000",
    "--resource",
    "cpu-quota=200000",
  ];
  // Prove enforced step limits and nested target-architecture execution before
  // compiling. Older frontends or unavailable emulation must fail at this step.
  const probe = join(directory, "Probe.Dockerfile");
  await writeFile(
    probe,
    `# syntax=${frontend}
FROM node:24-alpine
ARG TARGETARCH
RUN test "$(cat /sys/fs/cgroup/memory.max)" = 3221225472 && test "$(cat /sys/fs/cgroup/cpu.max)" = "200000 100000"
RUN node -e 'const a = require("node:assert/strict"); a.equal(process.arch, process.argv[1] === "amd64" ? "x64" : process.argv[1]); require("node:child_process").execFileSync(process.execPath,["-e","console.log(process.arch)"],{stdio:"inherit"})' "$TARGETARCH"
`,
  );
  await docker(...build, "--file", probe, source);
  console.log("Target execution and 3 GiB / 2 CPU build-step limits verified.");
  const original = await readFile(join(source, "docker/Dockerfile"), "utf8");
  assert.deepEqual(
    original.match(/^COPY --from=build .*$/gm),
    [
      "COPY --from=build /app/src ./src",
      "COPY --from=build /app/catalog ./catalog",
      "COPY --from=build /app/dist ./dist",
    ],
    "Review build-platform artifacts before copying them into a target-platform runtime",
  );
  assert.equal(
    original.match(/^FROM node:24-alpine$/gm)?.length,
    1,
    "Review changed upstream runtime stage",
  );
  const generated = `# syntax=${frontend}\n${original.replace(/^FROM node:24-alpine$/m, "FROM node:24-alpine AS runtime")}
FROM node:24-alpine AS unit-check
WORKDIR /app
ARG TARGETARCH
COPY package.json package-lock.json tsconfig.json vitest.config.ts vitest.setup.ts ./
COPY web ./web
COPY scripts ./scripts
COPY examples ./examples
COPY --from=build /app/src ./src
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN npm ci --ignore-scripts
RUN --network=none node -e 'require("node:assert/strict").equal(process.arch, process.argv[1] === "amd64" ? "x64" : process.argv[1]); console.log("Unit test architecture:", process.arch)' "$TARGETARCH"
RUN --network=none npm test -- --maxWorkers=2 ${tests.join(" ")} && printf passed > /unit-passed

FROM runtime AS runtime-check
ARG TARGETARCH
RUN --network=none --mount=type=bind,from=verification,target=/verification \\
    --mount=type=tmpfs,target=/app/data \\
    node /verification/check-connector-runtime.mjs "$TARGETARCH" && printf passed > /runtime-passed

FROM runtime AS verified
RUN --network=none \\
    --mount=type=bind,from=unit-check,source=/unit-passed,target=/unit-passed \\
    --mount=type=bind,from=runtime-check,source=/runtime-passed,target=/runtime-passed \\
    test "$(cat /unit-passed)" = passed && test "$(cat /runtime-passed)" = passed
`;
  const dockerfile = join(directory, "Verification.Dockerfile");
  await writeFile(dockerfile, generated);
  const verification = join(directory, "verification");
  await mkdir(verification);
  for (const file of ["check-connector-runtime.mjs", "inspect-openconnector-acceptance.mjs"]) {
    await writeFile(join(verification, file), await readFile(join(root, "scripts", file)));
  }
  const metadata = join(directory, "image.json");
  await docker(
    ...build,
    "--file",
    dockerfile,
    "--build-context",
    `verification=${verification}`,
    "--target",
    "verified",
    "--load",
    "--tag",
    runtime,
    "--metadata-file",
    metadata,
    source,
  );
  const image = JSON.parse(await docker("image", "inspect", runtime, "--format", "{{json .}}"));
  if (platform) assert.equal(`${image.Os}/${image.Architecture}`, platform);
  assert.deepEqual(image.Config.Entrypoint, ["/usr/local/bin/open-connector"]);
  assert.deepEqual(image.Config.Cmd, ["serve"]);
  assert.equal(
    image.Config.Env.some((value) => value.includes("synthetic-")),
    false,
  );
  retainRuntime = args.includes("--retain-runtime");
  report = {
    status: "passed",
    revision: connector.revision,
    tree: connector.tree,
    patchCount: connector.patches.length,
    providerNetwork: "disabled",
    deployed: false,
    platform: `${image.Os}/${image.Architecture}`,
    compilation: "build platform; dependencies, unit tests and runtime checked on target platform",
    builtImageId: image.Id,
    retainedRuntime: retainRuntime ? runtime : null,
    buildkitImage,
    frontend,
    buildStepMemoryBytes: 3 * 1024 ** 3,
    buildStepCpus: 2,
    buildMetadata: JSON.parse(await readFile(metadata, "utf8")),
  };
} catch (error) {
  if (builderAttempted) {
    try {
      const diagnostics = await exec(
        "docker",
        [
          "exec",
          builderContainer,
          "sh",
          "-c",
          "cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events",
        ],
        { timeout: 10_000, killSignal: "SIGKILL" },
      );
      console.error("Builder memory counters:\n", diagnostics.stdout);
    } catch {}
  }
  throw error;
} finally {
  // Kill the owned builder itself before removing metadata/cache. This terminates
  // compilation even if the build client was interrupted. Never prune shared caches.
  const failures = [];
  const cleanup = async (args, missing) => {
    try {
      await exec("docker", args, { timeout: 30_000, killSignal: "SIGKILL" });
    } catch (error) {
      if (!missing.test(String(error.stderr))) failures.push(args.slice(0, 2).join(" "));
    }
  };
  if (builderAttempted) {
    await cleanup(["rm", "--force", "--volumes", builderContainer], /No such container/);
    await cleanup(["buildx", "rm", "--force", name], /no builder|not found/i);
    await cleanup(["volume", "rm", builderVolume], /no such volume/i);
  }
  if (!retainRuntime) await cleanup(["image", "rm", runtime], /No such image/);
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(failures, [], "Owned verifier cleanup failed");
}
console.log(JSON.stringify(report));
