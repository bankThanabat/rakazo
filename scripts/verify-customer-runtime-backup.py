#!/usr/bin/env python3
"""Verify runtime archive/restore with disposable Docker mounts and SQLite fixtures."""

import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import uuid

spec = importlib.util.spec_from_file_location("runtime_backup", Path(__file__).with_name("customer-runtime-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
SECRET = "synthetic-$cash-${NOT_AN_ENV}"


def docker(*args):
    return backup.core.command(["docker", *args], operation="Disposable runtime verification", timeout=180).decode().strip()


def create_fixture(root, prefix, image, runtime, owned_containers, owned_volumes):
    """Create only owned idle containers and synthetic SQLite/file mounts."""
    db = root / "state.sqlite"
    with sqlite3.connect(db) as connection:
        connection.execute("CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO state VALUES (1, ?)", (SECRET,))
    database_bytes = db.read_bytes()
    archive_bytes = io.BytesIO()
    with tarfile.open(fileobj=archive_bytes, mode="w:gz") as archive:
        archive.add(db, arcname="state.sqlite")
        info = tarfile.TarInfo("owner-only.txt")
        info.size, info.mode, info.uid, info.gid = len(SECRET), 0o600, 1000, 1000
        archive.addfile(info, io.BytesIO(SECRET.encode()))
    seed = root / "seed.tgz"
    seed.write_bytes(archive_bytes.getvalue())
    shared = None
    containers = {}
    for role, destinations in backup.REQUIRED.items():
        mounts = []
        # Explicitly own image-declared application volumes, avoiding anonymous
        # volumes when a real runtime image also serves as the idle fixture.
        declared = set(runtime["Config"].get("Volumes") or {})
        assert all(path.startswith("/app/") for path in declared)
        for index, destination in enumerate(sorted(destinations | declared)):
            if destination == "/app/flows" and shared:
                volume = shared
            else:
                volume = prefix + "-" + role + str(index)
                docker("volume", "create", volume)
                owned_volumes.append(volume)
                mount = {"Type": "volume", "Name": volume, "Destination": "/seed"}
                with seed.open("rb") as file:
                    backup.core.helper(mount, image, "tar", "-xzf", "-", "-C", "/seed", "--same-owner", writable=True, stdin=file)
                if destination == "/app/flows":
                    shared = volume
            mounts += ["--mount", f"type=volume,source={volume},target={destination},volume-nocopy"]
        # Exercise a nested bind directory as used by OpenRAG's flow backup.
        if role == "openrag":
            nested = root / "flow-backup"
            nested.mkdir()
            (nested / "state.sqlite").write_bytes(database_bytes)
            (nested / "owner-only.txt").write_text(SECRET)
            mounts += ["--mount", f"type=bind,source={nested},target=/app/flows/backup"]
        name = prefix + "-" + role
        owned_containers.append(name)
        docker("run", "--detach", "--init", "--no-healthcheck", "--pull=never", "--name", name, "--network=none", "--memory=64m",
               "--memory-swap=64m", "--cpus=0.25", "--pids-limit=32", "--entrypoint", "sleep",
               "--workdir", "/app", "--env", "DATABASE_URL=",
               "--env", "LANGFLOW_DATABASE_URL=sqlite:////app/langflow-data/langflow.db",
               "--env", "FIXTURE_SECRET=" + SECRET, *mounts, runtime["Id"], "infinity")
        containers[role] = name
    return containers, database_bytes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper-image", required=True)
    parser.add_argument("--runtime-image", required=True, help="Cached Linux image with sleep and no declared volumes")
    parser.add_argument("--report-directory", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.report_directory.mkdir(mode=0o700)
    image = json.loads(docker("image", "inspect", args.helper_image))[0]["Id"]
    runtime = json.loads(docker("image", "inspect", args.runtime_image))[0]
    assert not runtime["Config"].get("Volumes"), "Fixture image must not create anonymous volumes"
    prefix = "deskazo-runtime-check-" + uuid.uuid4().hex
    owned_containers, owned_volumes = [], []
    restored_config = None
    volume_baseline = set(docker("volume", "ls", "--quiet").split())
    report = {"status": "failed", "helperImage": image, "checks": []}
    scripts = Path(__file__).resolve().parent
    report["sourceHashes"] = {name: hashlib.sha256((scripts / name).read_bytes()).hexdigest()
                              for name in ("customer-runtime-backup.py", "verify-customer-runtime-backup.py", "deployment-backup.py")}
    existing = docker("ps", "--quiet").split()
    before = {c["Id"]: c["State"]["StartedAt"] for c in backup.inspect(existing)} if existing else {}
    try:
        with tempfile.TemporaryDirectory(prefix="runtime-fixture-") as temporary:
            root = Path(temporary)
            containers, database_bytes = create_fixture(root, prefix, image, runtime, owned_containers, owned_volumes)
            print("Disposable runtimes ready; capturing shared and nested mounts.", flush=True)
            source = args.report_directory / "snapshot"
            capture_args = argparse.Namespace(**containers, helper_image=image, output=str(source))
            backup.backup(capture_args)
            saved = backup.verify(source)
            assert all(c["State"]["Running"] for c in backup.inspect(list(containers.values())))
            assert source.stat().st_mode & 0o777 == 0o700
            assert all(file.stat().st_mode & 0o777 == 0o600 for file in source.iterdir())
            first = next(m for m in saved["runtimes"]["langflow"]["Mounts"] if m["Destination"] == "/app/flows")
            second = next(m for m in saved["runtimes"]["openrag"]["Mounts"] if m["Destination"] == "/app/flows")
            assert first["archive"] == second["archive"]
            report["checks"].append("coordinated capture resumes selected runtimes; shared mount deduplicated; private artifact modes")
            target = args.report_directory / "restored"
            backup.restore(argparse.Namespace(source=str(source), output=str(target)))
            restored_volumes = json.loads((target / "volumes.json").read_text())
            owned_volumes.extend(restored_volumes)
            # Compose config serializes dollars escaped for another parse. Create
            # stopped containers to verify the actual effective environment.
            resolved = json.loads(docker("compose", "--env-file", "/dev/null", "-f", str(target / "compose.json"), "config", "--format", "json"))
            for service in resolved["services"].values():
                assert service["network_mode"] == "none" and not service.get("ports")
                assert all(m["type"] == "volume" and m["volume"]["nocopy"] for m in service["volumes"])
            assert not docker("ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=" + resolved["name"])
            restored_config = str(target / "compose.json")
            docker("compose", "--env-file", "/dev/null", "-f", restored_config, "create", "--pull", "never")
            restored_ids = docker("compose", "--env-file", "/dev/null", "-f", restored_config, "ps", "--all", "--quiet").split()
            assert len(restored_ids) == 3
            for container in backup.inspect(restored_ids):
                assert not container["State"]["Running"]
                assert backup.environment(container["Config"])["FIXTURE_SECRET"] == SECRET
                assert container["HostConfig"]["NetworkMode"] == "none" and not container["HostConfig"]["PortBindings"]
            for index, volume in enumerate(restored_volumes):
                mount = {"Type": "volume", "Name": volume, "Destination": "/restore"}
                content = backup.core.helper(mount, image, "cat", "/restore/state.sqlite")
                assert content == database_bytes
                restored_db = root / f"restored-{index}.sqlite"
                restored_db.write_bytes(content)
                with sqlite3.connect(restored_db) as connection:
                    assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                    assert connection.execute("SELECT value FROM state WHERE id=1").fetchone() == (SECRET,)
                assert backup.core.helper(mount, image, "cat", "/restore/owner-only.txt").decode() == SECRET
            report["checks"].append("fresh volume restore preserves all SQLite records and file content including nested bind; generated Compose retains literal secrets and disables networking")
            report["checks"].append("restore creates no service; verifier-created containers remain stopped with exact environment and isolated networking")
            report["status"] = "passed"
    except Exception as error:
        report["failureType"] = type(error).__name__
        raise
    finally:
        if restored_config:
            subprocess.run(["docker", "compose", "--env-file", "/dev/null", "-f", restored_config, "down", "--volumes"], capture_output=True, timeout=60)
        for name in owned_containers:
            subprocess.run(["docker", "rm", "--force", "--volumes", name], capture_output=True, timeout=45)
        for name in owned_volumes:
            subprocess.run(["docker", "volume", "rm", name], capture_output=True, timeout=45)
        report["temporaryContainersRemoved"] = not docker("ps", "--all", "--quiet", "--filter", "name=" + prefix)
        remaining = set(docker("volume", "ls", "--quiet").split())
        report["unexpectedNewVolumes"] = sorted(remaining - volume_baseline)
        report["temporaryVolumesRemoved"] = not remaining.intersection(owned_volumes) and not report["unexpectedNewVolumes"]
        if restored_config:
            report["temporaryContainersRemoved"] = report["temporaryContainersRemoved"] and not docker("compose", "--env-file", "/dev/null", "-f", restored_config, "ps", "--all", "--quiet")
        after = backup.inspect(existing) if existing else []
        report["existingContainersUnchanged"] = all(c["State"]["Running"] and c["State"]["StartedAt"] == before[c["Id"]] for c in after)
        if not all(report[key] for key in ("temporaryContainersRemoved", "temporaryVolumesRemoved", "existingContainersUnchanged")):
            report["status"] = "failed"
        (args.report_directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    assert report["status"] == "passed"
    print("Runtime data restore passed; disposable resources removed.")


if __name__ == "__main__":
    main()
