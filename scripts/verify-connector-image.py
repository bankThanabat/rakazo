#!/usr/bin/env python3
"""Check a prebuilt connector on native Linux hardware without provider access.

Run on the target host beside check-connector-runtime.mjs and
inspect-openconnector-acceptance.mjs. Never builds or replaces a service.
The verified image remains loaded; only the owned test container is removed.
"""

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import tarfile
import uuid


def command(*args, timeout=30, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=timeout).stdout


def inspect(kind, name):
    return json.loads(command("docker", kind, "inspect", name))[0]


def service_state(name):
    value = inspect("container", name)
    return {"id": value["Id"], "image": value["Image"],
            "startedAt": value["State"]["StartedAt"],
            "running": value["State"]["Running"],
            "health": value["State"].get("Health", {}).get("Status")}


def verify(args, report):
    machine = platform.machine()
    architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(machine)
    if platform.system() != "Linux" or not architecture:
        raise RuntimeError("Use native Linux AMD64 or ARM64 hardware")
    endpoint = os.environ.get("DOCKER_HOST") if not os.environ.get("DOCKER_CONTEXT") else None
    if not endpoint:
        endpoint = json.loads(command("docker", "context", "inspect"))[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise RuntimeError("Run beside the host's local Docker daemon")
    memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    available = int(memory["MemAvailable"].split()[0]) * 1024
    if available < 2 * 1024**3:
        raise RuntimeError("At least 2 GiB of available memory is required")
    archive = args.archive.resolve(strict=True)
    root = command("docker", "info", "--format", "{{.DockerRootDir}}").strip()
    if shutil.disk_usage(root).free < archive.stat().st_size * 5 + 1024**3:
        raise RuntimeError("Insufficient space for loading the candidate image")
    with archive.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    if digest != args.sha256:
        raise RuntimeError("Archive checksum differs from the prepared artifact")
    with tarfile.open(archive) as bundle:
        manifest = json.load(bundle.extractfile("manifest.json"))
        if len(manifest) != 1 or manifest[0]["RepoTags"] != [args.image]:
            raise RuntimeError("Archive must contain only the expected candidate tag")
        config_bytes = bundle.extractfile(manifest[0]["Config"]).read()
        config_digest = "sha256:" + hashlib.sha256(config_bytes).hexdigest()
        config = json.loads(config_bytes)
        if config_digest != args.config_digest:
            raise RuntimeError("Image configuration differs from the prepared artifact")
        if config["os"] != "linux" or config["architecture"] != architecture:
            raise RuntimeError("Image architecture must match native host hardware")
        identities = {config_digest}
        if "index.json" in bundle.getnames():
            descriptors = json.load(bundle.extractfile("index.json"))["manifests"]
            if len(descriptors) != 1:
                raise RuntimeError("Archive must contain one image manifest")
            descriptor = descriptors[0]
            manifest_digest = descriptor["digest"]
            if descriptor["mediaType"] not in (
                    "application/vnd.oci.image.manifest.v1+json",
                    "application/vnd.docker.distribution.manifest.v2+json"):
                raise RuntimeError("Unsupported image manifest representation")
            payload = bundle.extractfile("blobs/sha256/" + manifest_digest.removeprefix("sha256:")).read()
            if ("sha256:" + hashlib.sha256(payload).hexdigest() != manifest_digest
                    or json.loads(payload)["config"]["digest"] != config_digest):
                raise RuntimeError("Image manifest does not bind the expected configuration")
            identities.add(manifest_digest)
    before = service_state(args.existing_container)
    if not before["running"] or before["health"] != "healthy":
        raise RuntimeError("Existing service must be healthy before verification")
    if before["image"] in identities:
        raise RuntimeError("Use a candidate distinct from the running service")
    # Refuse tag replacement even when the running service uses an immutable ID.
    existing = subprocess.run(["docker", "image", "inspect", args.image], capture_output=True, text=True)
    if existing.returncode == 0 and json.loads(existing.stdout)[0]["Id"] not in identities:
        raise RuntimeError("Candidate tag already names another image")
    report.update(archiveSha256=digest, imageConfigDigest=config_digest,
                  verifiedImageIdentities=sorted(identities),
                  platform=f"linux/{architecture}", availableMemoryBytes=available,
                  serviceBefore=before)
    scripts = Path(__file__).resolve().parent
    files = ["verify-connector-image.py", "check-connector-runtime.mjs", "inspect-openconnector-acceptance.mjs"]
    report["verifierSourceHashes"] = {
        name: hashlib.sha256((scripts / name).read_bytes()).hexdigest() for name in files
    }
    name = "deskazo-connector-native-" + str(uuid.uuid4())
    try:
        command("docker", "image", "load", "--input", str(archive), timeout=300)
        image = inspect("image", args.image)
        # Docker reports either the configuration digest or the image manifest digest.
        # The archived manifest is hashed and must bind that same configuration.
        if image["Id"] not in identities or image["Architecture"] != architecture or image["Os"] != "linux":
            raise RuntimeError("Loaded image does not match the verified configuration")
        report["loadedImageId"] = image["Id"]
        command("docker", "create", "--name", name, "--pull=never", "--network=none",
                "--memory=768m", "--memory-swap=768m", "--cpus=1", "--pids-limit=128",
                "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--tmpfs=/app/data:rw,nosuid,nodev,size=128m,mode=1777",
                "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777",
                "--mount", f"type=bind,source={scripts},target=/verification,readonly",
                "--entrypoint=node", image["Id"],
                "/verification/check-connector-runtime.mjs", architecture)
        settings = inspect("container", name)
        host = settings["HostConfig"]
        if not (host["NetworkMode"] == "none" and host["Memory"] == 768 * 1024**2
                and host["MemorySwap"] == host["Memory"] and host["NanoCpus"] == 10**9
                and host["ReadonlyRootfs"] and not host["PortBindings"]
                and host["PidsLimit"] == 128 and host["CapDrop"] == ["ALL"]
                and "no-new-privileges" in host["SecurityOpt"]
                and set(host["Tmpfs"]) == {"/app/data", "/tmp"}
                and len(settings["Mounts"]) == 1
                and all(m["Type"] == "bind" and m["Destination"] == "/verification"
                        and m["Source"] == str(scripts) and not m["RW"] for m in settings["Mounts"])):
            raise RuntimeError("Temporary container isolation differs from the requested limits")
        report["limits"] = {"memoryBytes": host["Memory"], "memorySwapBytes": host["MemorySwap"],
                            "nanoCpus": host["NanoCpus"], "network": host["NetworkMode"],
                            "readOnlyRoot": host["ReadonlyRootfs"]}
        command("docker", "start", name)
        code = command("docker", "wait", name, timeout=180).strip()
        state = inspect("container", name)["State"]
        if code != "0" or state["OOMKilled"] or state["Running"]:
            raise RuntimeError("Candidate runtime check failed or exceeded its memory limit")
        output = command("docker", "logs", name)
        results = []
        for line in output.splitlines():
            if line.startswith('{"runtime":'):
                results.append(json.loads(line))
        if len(results) != 1 or results[0].get("runtime") != "passed":
            raise RuntimeError("Candidate did not produce its runtime verification receipt")
        report["runtime"] = results[0]
    finally:
        try:
            command("docker", "rm", "--force", name, check=False)
        except (OSError, subprocess.SubprocessError):
            pass  # Removal may have completed; confirm absence independently.
        try:
            report["temporaryContainerRemoved"] = not command(
                "docker", "ps", "--all", "--quiet", "--filter", f"name=^/{name}$").strip()
        except (OSError, subprocess.SubprocessError):
            report["temporaryContainerRemoved"] = False
        try:
            after = service_state(args.existing_container)
            report["serviceAfter"] = after
            report["existingServiceUnchanged"] = before == after
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            report["existingServiceUnchanged"] = False
        if not report["temporaryContainerRemoved"] or not report["existingServiceUnchanged"]:
            raise RuntimeError("Temporary cleanup or existing service verification failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--config-digest", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--existing-container", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    # Never overwrite an earlier receipt, including after a failed run.
    with args.report.open("x") as file:
        args.report.chmod(0o600)
        report = {"status": "failed", "deployed": False}
        try:
            verify(args, report)
            report["status"] = "passed"
        except (Exception, KeyboardInterrupt) as error:
            # No daemon stderr, environment values or provider payloads in reports.
            report["failureType"] = type(error).__name__
            if isinstance(error, RuntimeError):
                report["failure"] = str(error)
        finally:
            json.dump(report, file, indent=2)
            file.write("\n")
        print(json.dumps(report))
        return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
