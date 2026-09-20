#!/usr/bin/env python3
"""Deploy an approved, already verified connector image with a private backup.

Run beside the host Docker daemon. Requires PyYAML and the two read-only connector
checks beside this file. Does not build, pull images, send messages, or buy services.
An existing report directory is never reused. A failed cutover restores the old
image without rewinding its data volume; incompatible data requires inspection.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

import yaml


def run(*args, timeout=60, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Command failed; private command output was withheld")
    return result.stdout


def inspect(kind, name):
    return json.loads(run("docker", kind, "inspect", name))[0]


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def saved(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def state(container):
    return {"id": container["Id"], "image": container["Image"],
            "startedAt": container["State"]["StartedAt"],
            "running": container["State"]["Running"],
            "health": container["State"].get("Health", {}).get("Status")}


def normalize(config):
    # Only these three deployment fields may change.
    result = json.loads(json.dumps(config))
    service = result["services"]["connector"]
    for key in ("image", "build", "pull_policy"):
        service.pop(key, None)
    return result


def checks(container, directory, suffix, baseline=None, require_actions=False):
    results = {}
    for name in ("inspect-openconnector-acceptance", "verify-openconnector-identities"):
        source = Path(__file__).with_name(name + ".mjs").read_bytes()
        result = json.loads(run("docker", "exec", "-i", container, "node", "--input-type=module",
                                data=source, timeout=240))
        results[name] = result
        if directory:
            saved(directory / (name + "-" + suffix + ".json"), result)
    identities = results["verify-openconnector-identities"]
    if not identities["passed"]:
        raise RuntimeError("Read-only identity checks failed")
    providers = results["inspect-openconnector-acceptance"]["providers"]
    counts = {p["service"]: p["configuredConnections"] for p in providers}
    if baseline is not None:
        if counts != baseline:
            raise RuntimeError("Configured connection counts changed")
    if require_actions and not all(a["locallyExecutable"] for p in providers for a in p["actionChecks"]):
        raise RuntimeError("Required candidate catalog actions are missing")
    return counts


def healthy(name, image):
    until = time.monotonic() + 180
    while time.monotonic() < until:
        value = inspect("container", name)
        if value["Image"] != image:
            raise RuntimeError("Running container has the wrong image")
        if value["State"].get("Health", {}).get("Status") == "healthy":
            return value
        if not value["State"]["Running"]:
            raise RuntimeError("Connector exited before becoming healthy")
        time.sleep(2)
    raise RuntimeError("Connector did not become healthy within three minutes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--volume", required=True)
    parser.add_argument("--old-image", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    for image in (args.old_image, args.candidate):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
            raise RuntimeError("Image arguments must be immutable sha256 image IDs")
        if inspect("image", image)["Id"] != image:
            raise RuntimeError("Image inspection does not match the immutable ID")
    if args.old_image == args.candidate:
        raise RuntimeError("The candidate must differ from the running image")
    os.umask(0o077)
    compose = args.compose.resolve(strict=True)
    lock = (compose.parent / ".connector-rollout.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    base = ["docker", "compose", "--project-name", args.project,
            "--project-directory", str(compose.parent), "-f", str(compose)]
    config = json.loads(run(*base, "config", "--format", "json"))
    original = inspect("container", args.container)
    if set(config["services"]) != {"connector"} or config["name"] != args.project:
        raise RuntimeError("This rollout supports only the isolated connector project")
    if original["Config"]["Labels"].get("com.docker.compose.project") != args.project:
        raise RuntimeError("Connector belongs to another project")
    if original["Image"] != args.old_image or not original["State"]["Running"]:
        raise RuntimeError("Original running image differs from the approved preflight")
    healthy(args.container, args.old_image)
    mounts = original["Mounts"]
    if len(mounts) != 1 or mounts[0].get("Name") != args.volume or mounts[0]["Destination"] != "/app/data":
        raise RuntimeError("Connector data mount differs from the approved plan")
    if inspect("image", args.candidate)["Architecture"] != "amd64":
        raise RuntimeError("Expected the previously verified native AMD64 image")
    if shutil.disk_usage(compose.parent).free < 5 * 1024**3:
        raise RuntimeError("At least five GiB free disk space is required")
    others = {}
    for cid in run("docker", "ps", "--quiet").decode().split():
        value = inspect("container", cid)
        if value["Id"] != original["Id"]:
            others[cid] = state(value)
    raw = yaml.safe_load(compose.read_text())
    candidate_config = json.loads(json.dumps(raw))
    candidate_service = candidate_config["services"]["connector"]
    candidate_service.pop("build", None)
    candidate_service["image"] = args.candidate
    candidate_service["pull_policy"] = "never"
    # Resolve with the original project directory and .env, without writing any file.
    candidate_bytes = yaml.safe_dump(candidate_config, sort_keys=False).encode()
    proposed = json.loads(run("docker", "compose", "--project-name", args.project,
        "--project-directory", str(compose.parent), "-f", "-", "config", "--format", "json",
        data=candidate_bytes))
    if normalize(config) != normalize(proposed):
        raise RuntimeError("Candidate configuration changes more than its image and build fields")
    if args.check_only:
        checks(args.container, None, "before")
        print(json.dumps({"preflight": "passed", "changed": False, "otherServices": len(others)}))
        return
    directory = args.directory.resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    report = {"status": "running", "stage": "backup", "oldImage": args.old_image,
              "candidateImage": args.candidate, "serviceBefore": state(original),
              "verifierSha256": digest(Path(__file__)), "paidResourcesCreated": False}
    report["checkSourceSha256"] = {name: digest(Path(__file__).with_name(name)) for name in (
        "inspect-openconnector-acceptance.mjs", "verify-openconnector-identities.mjs",
        "verify-connector-account-routing.mjs")}

    def checkpoint(stage):
        report["stage"] = stage
        saved(directory / "result.json", report)
        print(stage, flush=True)

    stopped = False
    replaced = False
    success = False
    try:
        counts = checks(args.container, directory, "before")
        saved(directory / "resolved-before.private.json", config)
        saved(directory / "container-before.private.json", original)
        shutil.copy2(compose, directory / "compose.original.yml")
        (directory / "compose.original.yml").chmod(0o600)
        # Save referenced env files and the automatic project .env without printing values.
        envfiles = [compose.parent / ".env"]
        for service in raw["services"].values():
            entries = service.get("env_file", [])
            if isinstance(entries, (str, dict)):
                entries = [entries]
            for entry in entries:
                path = entry if isinstance(entry, str) else entry["path"]
                envfiles.append(compose.parent / path)
        for index, path in enumerate(dict.fromkeys(envfiles)):
            if path.exists():
                shutil.copy2(path, directory / f"environment-{index}.private")
                (directory / f"environment-{index}.private").chmod(0o600)
        rollback_tag = f"{args.project}-rollback:{directory.name}"
        run("docker", "tag", args.old_image, rollback_tag)
        run("docker", "save", "--output", str(directory / "prior-image.tar"), rollback_tag, timeout=300)
        report["priorImageArchiveSha256"] = digest(directory / "prior-image.tar")
        checkpoint("stopping-connector")
        stopped = True
        run(*base, "stop", "--timeout", "30", "connector")
        if inspect("container", args.container)["State"]["Running"]:
            raise RuntimeError("Connector did not stop")
        if run("docker", "ps", "--quiet", "--filter", "volume=" + args.volume).strip():
            raise RuntimeError("Another running container uses connector data")
        checkpoint("backing-up-data")
        run("docker", "run", "--rm", "--pull=never", "--network=none", "--read-only", "--user=0",
            "--memory=256m", "--memory-swap=256m", "--cpus=1", "--pids-limit=64",
            "--mount", f"type=volume,source={args.volume},target=/source,readonly",
            "--mount", f"type=bind,source={directory},target=/backup",
            "--entrypoint=tar", args.old_image, "-cpf", "/backup/connector-data.tar", "-C", "/source", ".",
            timeout=180)
        run("tar", "-tf", str(directory / "connector-data.tar"), timeout=120)
        report["dataArchiveSha256"] = digest(directory / "connector-data.tar")
        override = directory / "candidate.override.json"
        saved(override, {"services": {"connector": {"image": args.candidate, "pull_policy": "never"}}})
        checkpoint("starting-candidate")
        replaced = True  # A failed compose up may already have replaced the old container.
        run(*base, "-f", str(override), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "connector", timeout=180)
        current = healthy(args.container, args.candidate)
        current_env = dict(value.split("=", 1) for value in current["Config"]["Env"])
        if any(current_env.get(k) != str(v) for k, v in config["services"]["connector"]["environment"].items()):
            raise RuntimeError("Configured environment changed")
        for key in ("PortBindings", "RestartPolicy"):
            if current["HostConfig"][key] != original["HostConfig"][key]:
                raise RuntimeError("Ports or restart configuration changed")
        if current["Mounts"] != original["Mounts"]:
            raise RuntimeError("Data mount changed")
        checkpoint("checking-candidate")
        checks(args.container, directory, "after", counts, require_actions=True)
        routing = Path(__file__).with_name("verify-connector-account-routing.mjs").read_bytes()
        routing_result = json.loads(run("docker", "exec", "-i", args.container, "node", "--input-type=module",
                                        data=routing, timeout=240))
        if not routing_result["passed"]:
            raise RuntimeError("Account-bound routing checks failed")
        saved(directory / "account-routing.json", routing_result)
        if any(state(inspect("container", cid)) != value for cid, value in others.items()):
            raise RuntimeError("An unrelated service changed during rollout")
        checkpoint("pinning-image")
        temporary = compose.with_name(compose.name + ".rollout-next")
        temporary.write_bytes(candidate_bytes)
        temporary.chmod(compose.stat().st_mode & 0o777)
        os.replace(temporary, compose)
        final = json.loads(run(*base, "config", "--format", "json"))
        if final != proposed:
            raise RuntimeError("Pinned configuration differs from the checked candidate")
        report.update(status="passed", serviceAfter=state(current), configuredConnections=counts,
                      allSelectedActionsAvailable=True, otherServicesUnchanged=True,
                      originalVolumePreserved=True, baseImagePinned=True,
                      privateBackupRetained=True)
        success = True
        checkpoint("complete")
    except BaseException as error:
        report["status"] = "failed"
        report["failureType"] = type(error).__name__
        report["failedStage"] = report["stage"]
        if isinstance(error, RuntimeError):
            report["failure"] = str(error)
        if stopped:
            try:
                checkpoint("rolling-back")
                shutil.copy2(directory / "compose.original.yml", compose)
                if replaced:
                    rollback = directory / "rollback.override.json"
                    saved(rollback, {"services": {"connector": {"image": args.old_image, "pull_policy": "never"}}})
                    run(*base, "-f", str(rollback), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "connector", timeout=180)
                else:
                    run("docker", "start", args.container)
                healthy(args.container, args.old_image)
                checks(args.container, directory, "rollback", counts)
                report["rollback"] = "healthy original image; data volume not rewound"
            except BaseException as rollback_error:
                report["rollback"] = "failed; operator inspection required"
                report["rollbackFailureType"] = type(rollback_error).__name__
        checkpoint("failed")
    finally:
        saved(directory / "result.json", report)
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Parser/daemon exceptions may contain private input or resolved credentials.
        print(json.dumps({"status": "failed", "failureType": type(error).__name__}))
        raise SystemExit(1)
