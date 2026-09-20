#!/usr/bin/env python3
"""Verify connector account, credential and runtime-token recovery using an isolated synthetic store."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location("runtime_fixture", Path(__file__).with_name("verify-customer-runtime-backup.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
backup = fixture.backup
docker = fixture.docker


def isolated(container, prefix):
    item = backup.inspect([container])[0]
    assert item["Config"].get("Labels", {}).get("deskazo.connector-recovery") == prefix, "Fixture ownership required"
    network = prefix+"-internal"
    assert item["HostConfig"]["NetworkMode"] == network, "Fixture network isolation required"
    details = json.loads(docker("network", "inspect", network))[0]
    assert details["Internal"] and details["Labels"].get("deskazo.connector-recovery") == prefix
    assert set(item["NetworkSettings"]["Networks"]) == {network}
    assert not item["HostConfig"].get("PortBindings"), "Fixture must not publish ports"
    return item


def ready(container, prefix):
    deadline = time.monotonic() + 120
    while True:
        item = isolated(container, prefix)
        assert item["State"]["Running"], "Fixture stopped before readiness"
        if item["State"].get("Health", {}).get("Status") == "healthy":
            return
        assert time.monotonic() < deadline, "Fixture readiness timed out"
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--helper-image", default="postgres:16")
    parser.add_argument("--report-directory", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(__file__).resolve().parent.parent
    report_dir = args.report_directory.absolute()
    report_dir.mkdir(mode=0o700)
    image = json.loads(docker("image", "inspect", args.image))[0]
    assert set(image["Config"].get("Volumes") or {}) <= {"/app/data"}
    idle = image
    helper = json.loads(docker("image", "inspect", args.helper_image))[0]["Id"]
    prefix = "deskazo-connector-recovery-" + uuid.uuid4().hex
    owned_containers, owned_volumes = [], []
    existing = docker("ps", "--quiet").split()
    def service_state(item):
        return {key: item["State"].get(key) for key in ("StartedAt", "Running")} | {"health": item["State"].get("Health", {}).get("Status")}
    before = {c["Id"]: service_state(c) for c in backup.inspect(existing)} if existing else {}
    baseline_volumes = set(docker("volume", "ls", "--quiet").split())
    target_config = target = network = None
    report = {"status": "failed", "image": image["Id"], "architecture": image["Architecture"], "checks": []}
    files = ["scripts/verify-connector-recovery.py", "scripts/check-connector-recovery.mjs",
             "scripts/verify-customer-runtime-backup.py", "scripts/customer-runtime-backup.py", "scripts/deployment-backup.py"]
    report["sourceHashes"] = {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files}
    temporary = tempfile.TemporaryDirectory(prefix="connector-recovery-fixture-")
    work = Path(temporary.name)
    try:
        architecture = docker("info", "--format", "{{.Architecture}}")
        assert {"x86_64": "amd64", "aarch64": "arm64"}.get(architecture, architecture) == image["Architecture"], "Use a native Docker engine matching the image architecture"
        if Path("/proc/meminfo").exists():
            memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
            assert int(memory["MemAvailable"].split()[0])*1024 >= 2*1024**3, "At least 2 GiB available memory required"
        customers, _ = fixture.create_fixture(work, prefix, helper, idle, owned_containers, owned_volumes)
        try:
            isolated(customers["connector"], prefix)
            raise RuntimeError("Unlabeled container was admitted")
        except AssertionError as error:
            assert str(error) == "Fixture ownership required"
        network = prefix+"-internal"
        docker("network", "create", "--internal", "--label", "deskazo.connector-recovery="+prefix, network)
        probe = prefix+"-probe"
        owned_containers.append(probe)
        docker("run", "--detach", "--pull=never", "--name", probe, "--network=none",
               "--label", "deskazo.connector-recovery="+prefix, "--memory=32m", "--memory-swap=32m",
               "--tmpfs", "/app/data:rw,size=1m",
               "--entrypoint", "sleep", idle["Id"], "600")
        try:
            isolated(probe, prefix)
            raise RuntimeError("Container outside owned internal network was admitted")
        except AssertionError as error:
            assert str(error) == "Fixture network isolation required"
        docker("rm", "--force", probe)
        report["checks"].append("owned unlabeled and wrong-network probes refused before any API request")
        original = backup.inspect([customers["connector"]])[0]
        docker("rm", "--force", customers["connector"])
        fixture_files = work/"service"
        fixture_files.mkdir()
        shutil.copyfile(root/"scripts/check-connector-recovery.mjs", fixture_files/"check.mjs")
        with (report_dir/"certificate.log").open("wb") as log:
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", "/CN=synthetic-recovery-store", "-addext", "subjectAltName=DNS:recovery-store.example.test",
                            "-keyout", str(fixture_files/"key.pem"), "-out", str(fixture_files/"cert.pem")],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
        volume = next(m["Name"] for m in original["Mounts"] if m["Destination"] == "/app/data")
        environment = {
            "OOMOL_CONNECT_ADMIN_TOKEN": "synthetic-recovery-admin",
            "OOMOL_CONNECT_RUNTIME_TOKEN": "synthetic-recovery-runtime",
            "OOMOL_CONNECT_ENCRYPTION_KEY": uuid.uuid4().hex,
            "OOMOL_CONNECT_ORIGIN": "http://127.0.0.1:3000",
            "OOMOL_CONNECT_DATA_DIR": "/app/data",
            "OOMOL_CONNECT_RECOVERY_FIXTURE": prefix,
            "OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS": "recovery-store.example.test",
            "NODE_EXTRA_CA_CERTS": "/app/recovery-fixture/cert.pem",
        }
        env_args = [value for key, value in environment.items() for value in ("--env", key+"="+value)]
        docker("run", "--detach", "--pull=never", "--name", customers["connector"], "--network", network,
               "--label", "deskazo.connector-recovery="+prefix, "--memory=768m", "--memory-swap=768m",
               "--cpus=2", "--pids-limit=128", "--health-interval=3s", "--health-timeout=5s", "--health-retries=30",
               "--mount", f"type=volume,source={volume},target=/app/data,volume-nocopy",
               "--mount", f"type=bind,source={fixture_files},target=/app/recovery-fixture,readonly", *env_args, image["Id"])

        provider = prefix+"-store"
        owned_containers.append(provider)
        docker("run", "--detach", "--no-healthcheck", "--pull=never", "--name", provider, "--network", network,
               "--network-alias", "recovery-store.example.test", "--label", "deskazo.connector-recovery="+prefix,
               "--memory=128m", "--memory-swap=128m", "--cpus=0.5", "--pids-limit=32",
               "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/app/data:rw,size=1m",
               "--mount", f"type=bind,source={fixture_files},target=/app/recovery-fixture,readonly",
               *env_args, "--entrypoint", "node", image["Id"], "/app/recovery-fixture/check.mjs", "serve")
        isolated(provider, prefix)

        def check(mode, container, state=None):
            isolated(container, prefix)
            # Check the exact owned HTTPS service before connecting credentials.
            docker("exec", container, "node", "--input-type=module", "--eval",
                   "for(let n=0;n<30;n++){try{const r=await fetch('https://recovery-store.example.test:8787');if(r.status===403)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1)")
            result = subprocess.run(["docker", "exec", "-i", container, "node", "/app/recovery-fixture/check.mjs"],
                                    input=json.dumps({"mode": mode, "fixture": prefix, "state": state}),
                                    capture_output=True, text=True, timeout=90)
            (report_dir/(mode+".log")).write_text(result.stderr)
            assert result.returncode == 0, "Connector recovery check failed; inspect private phase log"
            value = json.loads(result.stdout)
            (report_dir/(mode+".json")).write_text(json.dumps(value, indent=2)+"\n")
            return value

        ready(customers["connector"], prefix)
        print("Source connector ready; connecting a synthetic HTTPS store and checking runtime tokens.", flush=True)
        source = check("seed", customers["connector"])
        artifact = report_dir/"snapshot"
        backup.backup(argparse.Namespace(**customers, helper_image=helper, output=str(artifact)))
        ready(customers["connector"], prefix)
        docker("stop", "--time", "30", customers["connector"])
        restored = report_dir/"restored"
        backup.restore(argparse.Namespace(source=str(artifact), output=str(restored)))
        owned_volumes.extend(json.loads((restored/"volumes.json").read_text()))
        target_config = str(restored/"compose.json")
        overlay = report_dir/"fixture-limits.json"
        overlay.write_text(json.dumps({"services": {"connector": {
            "mem_limit": "768m", "memswap_limit": "768m", "cpus": 2, "pids_limit": 128,
            "labels": {"deskazo.connector-recovery": prefix}, "network_mode": network,
            "healthcheck": {"test": ["CMD", "node", "scripts/healthcheck.ts"], "interval": "3s", "timeout": "5s", "retries": 30},
        }}}))
        docker("compose", "--env-file", "/dev/null", "-f", target_config, "-f", str(overlay),
               "up", "--detach", "--no-deps", "--pull", "never", "connector")
        target = docker("compose", "--env-file", "/dev/null", "-f", target_config, "ps", "--quiet", "connector")
        ready(target, prefix)
        assert isolated(target, prefix)["Image"] == image["Id"]
        print("Restored connector ready; checking original account, credentials and tokens.", flush=True)
        recovered = check("check", target, source["state"])
        assert recovered == source, "Restored account, product or token result changed"
        report["checks"].append("same account identity and original runtime token execute authenticated synthetic store read after fresh-volume restoration")
        report["checks"].append("restricted action, changed provider identity and previously revoked token remain denied before and after restore")
        report["status"] = "passed"
    except Exception as error:
        report["failureType"] = type(error).__name__
        raise
    finally:
        report["fixtureStatesBeforeCleanup"] = {}
        for name in [*owned_containers, *([target] if target else [])]:
            info = subprocess.run(["docker", "inspect", "--format", "{{json .State}}", name], capture_output=True, timeout=20)
            if info.returncode == 0:
                state = json.loads(info.stdout)
                report["fixtureStatesBeforeCleanup"][name] = {key: state[key] for key in ("Running", "OOMKilled", "ExitCode")}
            if name.endswith("-connector") or name == target:
                logs = subprocess.run(["docker", "logs", "--tail", "100", name], capture_output=True, timeout=20)
                (report_dir/("target-container.log" if name == target else "source-container.log")).write_bytes(logs.stdout+logs.stderr)
        if target_config:
            subprocess.run(["docker", "compose", "--env-file", "/dev/null", "-f", target_config, "down", "--volumes"], capture_output=True, timeout=60)
        for name in owned_containers:
            subprocess.run(["docker", "rm", "--force", "--volumes", name], capture_output=True, timeout=45)
        for name in owned_volumes:
            subprocess.run(["docker", "volume", "rm", name], capture_output=True, timeout=45)
        if network:
            subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=30)
        report["temporaryContainersRemoved"] = not docker("ps", "--all", "--quiet", "--filter", "name="+prefix)
        if target_config:
            report["temporaryContainersRemoved"] &= not docker("compose", "--env-file", "/dev/null", "-f", target_config, "ps", "--all", "--quiet")
        report["temporaryNetworkRemoved"] = not docker("network", "ls", "--quiet", "--filter", "name="+prefix)
        remaining = set(docker("volume", "ls", "--quiet").split())
        report["unexpectedNewVolumes"] = sorted(remaining-baseline_volumes)
        report["temporaryVolumesRemoved"] = not report["unexpectedNewVolumes"] and not remaining.intersection(owned_volumes)
        after = backup.inspect(existing) if existing else []
        report["existingContainerCount"] = len(before)
        report["existingContainersUnchanged"] = all(service_state(c) == before[c["Id"]] for c in after)
        if not all(report[key] for key in ("temporaryContainersRemoved", "temporaryNetworkRemoved", "temporaryVolumesRemoved", "existingContainersUnchanged")):
            report["status"] = "failed"
        (report_dir/"result.json").write_text(json.dumps(report, indent=2)+"\n")
        temporary.cleanup()
    assert report["status"] == "passed"
    print("Connector recovery passed; owned resources removed.", flush=True)


if __name__ == "__main__":
    main()
