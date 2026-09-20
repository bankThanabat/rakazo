#!/usr/bin/env node
// Build the locked backend on a local build machine and verify its packaged sources.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareSource } from "./customer-sources.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [argument] = process.argv.slice(2);
assert.ok(argument?.startsWith("--report-directory=") && process.argv.length === 3);
const directory = resolve(argument.slice("--report-directory=".length));
await mkdir(directory, { mode: 0o700 });
const exec = promisify(execFile);
const capture = async (args, input) => {
  if (input !== undefined) {
    return new Promise((resolveResult, reject) => {
      const child = execFile(
        "docker",
        args,
        { timeout: 120_000, maxBuffer: 4_000_000 },
        (error, stdout) => (error ? reject(error) : resolveResult(stdout.trim())),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  return (await exec("docker", args, { timeout: 120_000, maxBuffer: 4_000_000 })).stdout.trim();
};
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Honor explicit Docker endpoint selection.
const explicitHost = process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST;
const endpoint =
  explicitHost || JSON.parse(await capture(["context", "inspect"]))[0]?.Endpoints?.docker?.Host;
assert.match(endpoint, /^(unix|npipe):\/\//, "Use a local Docker engine on a build machine");
const name = `deskazo-openrag-build-${randomUUID()}`;
const builderContainer = `buildx_buildkit_${name}0`;
const builderVolume = `${builderContainer}_state`;
const tag = `${name}:backend`;
const inspectContainer = `${name}-inspect`;
const buildkit =
  "moby/buildkit@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec";
const frontend =
  "docker/dockerfile@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12";
const source = join(directory, "source");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
const existing = (await capture(["ps", "--quiet"])).split(/\s+/).filter(Boolean);
const volumesBefore = new Set(
  (await capture(["volume", "ls", "--quiet"])).split(/\s+/).filter(Boolean),
);
const states = async () =>
  existing.length
    ? JSON.parse(await capture(["inspect", ...existing])).map((c) => ({
        id: c.Id,
        startedAt: c.State.StartedAt,
        running: c.State.Running,
        health: c.State.Health?.Status,
      }))
    : [];
const before = await states();
const report = { status: "failed", checks: [] };
let builderAttempted = false;
let keepImage = false;
try {
  const lock = JSON.parse(
    await readFile(join(root, "infra/compose/customer-sources.json"), "utf8"),
  );
  const backend = lock.find((entry) => entry.name === "OpenRAG");
  assert.ok(backend, "OpenRAG source lock is missing");
  report.sourceTree = prepareSource(backend, root, source);
  report.sourceRevision = backend.revision;
  const hashes = {};
  for (const file of [
    "scripts/verify-openrag-image.mjs",
    "scripts/customer-sources.mjs",
    "infra/compose/customer-sources.json",
  ])
    hashes[file] = createHash("sha256")
      .update(await readFile(join(root, file)))
      .digest("hex");
  report.verifierSourceHashes = hashes;
  const info = JSON.parse(await capture(["info", "--format", "{{json .}}"]));
  const architecture =
    { aarch64: "arm64", x86_64: "amd64" }[info.Architecture] ?? info.Architecture;
  assert.ok(["arm64", "amd64"].includes(architecture));
  assert.ok(info.MemTotal >= 4 * 1024 ** 3, "Build engine requires at least 4 GiB total memory");
  const config = join(directory, "buildkitd.toml");
  await writeFile(config, "[worker.oci]\n  max-parallelism = 1\n");
  builderAttempted = true;
  await capture([
    "buildx",
    "create",
    "--name",
    name,
    "--driver",
    "docker-container",
    "--buildkitd-config",
    config,
    "--driver-opt",
    `image=${buildkit}`,
    "--driver-opt",
    "memory=2g",
    "--driver-opt",
    "memory-swap=2g",
    "--driver-opt",
    "cpu-period=100000",
    "--driver-opt",
    "cpu-quota=200000",
    "--driver-opt",
    "restart-policy=no",
    endpoint,
  ]);
  await capture(["buildx", "inspect", "--bootstrap", name]);
  const limits = JSON.parse(
    await capture(["inspect", builderContainer, "--format", "{{json .HostConfig}}"]),
  );
  assert.equal(limits.Memory, 2 * 1024 ** 3);
  assert.equal(limits.MemorySwap, limits.Memory);
  assert.equal(limits.CpuQuota, 200000);
  assert.equal(limits.CpuPeriod, 100000);
  const available = Number(
    await capture([
      "exec",
      builderContainer,
      "awk",
      "/^MemAvailable:/ {print $2}",
      "/proc/meminfo",
    ]),
  );
  assert.ok(available >= 3 * 1024 ** 2, "Build engine requires 3 GiB available memory");
  report.limits = {
    memoryBytes: limits.Memory,
    cpuQuota: limits.CpuQuota,
    cpuPeriod: limits.CpuPeriod,
  };
  console.log("Building the pinned OpenRAG backend on the native architecture.");
  await new Promise((resolveBuild, reject) => {
    const child = spawn(
      "docker",
      [
        "buildx",
        "build",
        "--builder",
        name,
        "--platform",
        `linux/${architecture}`,
        "--load",
        "--provenance=false",
        "--progress=plain",
        "--build-arg",
        `BUILDKIT_SYNTAX=${frontend}`,
        "--metadata-file",
        join(directory, "build-metadata.json"),
        "--file",
        join(source, "Dockerfile.backend"),
        "--tag",
        tag,
        source,
      ],
      { stdio: "inherit", timeout: 30 * 60_000, signal: controller.signal },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolveBuild() : reject(new Error(`Backend build failed: ${code}`)),
    );
  });
  const image = JSON.parse(await capture(["image", "inspect", tag]))[0];
  assert.equal(image.Architecture, architecture);
  assert.equal(Object.keys(image.Config.Volumes ?? {}).length, 0);
  const expected = {};
  const collect = async (path) => {
    for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else {
        if (entry.isSymbolicLink()) {
          const target = await readlink(join(source, file));
          const resolved = relative(source, resolve(source, dirname(file), target));
          assert.ok(
            !isAbsolute(target) && resolved !== ".." && !resolved.startsWith("../"),
            `Source link must remain within the pinned tree: ${file}`,
          );
          expected[file] = { kind: "symlink", target };
        } else {
          assert.ok(entry.isFile(), `Unsupported source entry: ${file}`);
          expected[file] = {
            kind: "file",
            sha256: createHash("sha256")
              .update(await readFile(join(source, file)))
              .digest("hex"),
          };
        }
      }
    }
  };
  for (const path of [
    "src",
    "enhancements",
    "flows",
    "securityconfig",
    "cloud_securityconfig",
    "alembic",
  ])
    await collect(path);
  for (const file of ["pyproject.toml", "uv.lock", "alembic.ini", "scripts/backend-entrypoint.sh"])
    expected[file === "scripts/backend-entrypoint.sh" ? "/entrypoint.sh" : file] = {
      kind: "file",
      sha256: createHash("sha256")
        .update(await readFile(join(source, file)))
        .digest("hex"),
    };
  const python = `import hashlib,json,os,sys
from pathlib import Path
result = {}
for name in json.load(sys.stdin):
    path = Path(name)
    if path.is_symlink():
        result[name] = {"kind": "symlink", "target": os.readlink(path)}
    elif path.is_file():
        result[name] = {"kind": "file", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    else:
        raise RuntimeError("Packaged entry is missing or not a file: " + name)
print(json.dumps(result))
`;
  const actual = JSON.parse(
    await capture(
      [
        "run",
        "--rm",
        "--interactive",
        "--pull=never",
        "--name",
        inspectContainer,
        "--network=none",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=1",
        "--read-only",
        "--entrypoint",
        "/app/.venv/bin/python",
        image.Id,
        "-c",
        python,
      ],
      JSON.stringify(Object.keys(expected)),
    ),
  );
  assert.deepEqual(
    actual,
    expected,
    "Packaged source or dependency lock differs from the pinned commit",
  );
  await writeFile(
    join(directory, "packaged-source-hashes.json"),
    `${JSON.stringify(actual, null, 2)}\n`,
  );
  const regression = await capture([
    "run",
    "--rm",
    "--pull=never",
    "--name",
    inspectContainer,
    "--network=none",
    "--memory=512m",
    "--memory-swap=512m",
    "--cpus=1",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=32m",
    "--env",
    "DATABASE_URL=sqlite+aiosqlite:///:memory:",
    "--env",
    "PYTHONPATH=/app/src",
    "--mount",
    `type=bind,source=${join(source, "tests/unit/test_knowledge_filter_not_found.py")},target=/checks/test.py,readonly`,
    "--entrypoint",
    "/app/.venv/bin/python",
    image.Id,
    "/checks/test.py",
  ]);
  await writeFile(join(directory, "filter-errors.log"), `${regression}\n`);
  report.checks.push("five offline filter error regressions pass against packaged backend code");
  report.image = image.Id;
  report.tag = tag;
  report.architecture = architecture;
  report.packagedFiles = Object.keys(expected).length;
  report.checks.push(
    "image packages pinned application, flows, security configuration, migrations and unchanged dependency lock",
  );
  keepImage = true;
  report.status = "passed";
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  const remove = async (args) => {
    await capture(args).catch(() => undefined);
  };
  await remove(["rm", "--force", inspectContainer]);
  if (builderAttempted) {
    await remove(["rm", "--force", "--volumes", builderContainer]);
    await remove(["buildx", "rm", "--force", name]);
    await remove(["volume", "rm", builderVolume]);
  }
  if (!keepImage) await remove(["image", "rm", tag]);
  await rm(source, { recursive: true, force: true });
  report.temporaryContainersRemoved = !(await capture([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `name=${name}`,
  ]));
  const volumesAfter = (await capture(["volume", "ls", "--quiet"])).split(/\s+/).filter(Boolean);
  report.unexpectedNewVolumes = volumesAfter.filter((volume) => !volumesBefore.has(volume));
  report.existingContainersUnchanged = JSON.stringify(await states()) === JSON.stringify(before);
  if (
    !report.temporaryContainersRemoved ||
    report.unexpectedNewVolumes.length ||
    !report.existingContainersUnchanged
  )
    report.status = "failed";
  await writeFile(join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
}
assert.equal(report.status, "passed");
console.log(`Pinned OpenRAG backend source verification passed: ${report.image}`);
