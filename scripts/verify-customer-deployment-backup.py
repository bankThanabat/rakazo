#!/usr/bin/env python3
"""Verify coordinated data capture using disposable PostgreSQL/OpenSearch and idle runtimes.

This checks the backup boundary and restored synthetic records, not actual
Langflow/OpenRAG application behavior or external provider reconciliation.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import uuid
from unittest.mock import patch
import importlib.util


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


snapshot = module("customer-deployment-backup")
runtime_fixture = module("verify-customer-runtime-backup")
search_fixture = module("verify-customer-search-backup")
core = snapshot.core


def docker(*args):
    return core.command(["docker", *args], operation="Disposable coordinated recovery", timeout=240).decode().strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-image", default="postgres:16")
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--search-image", required=True)
    parser.add_argument("--report-directory", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.report_directory.mkdir(mode=0o700)
    images = {name: json.loads(docker("image", "inspect", value))[0] for name, value in
              (("postgres", args.postgres_image), ("runtime", args.runtime_image), ("search", args.search_image))}
    assert not images["runtime"]["Config"].get("Volumes"), "Fixture runtime image must not declare volumes"
    prefix = "deskazo-coordinated-" + uuid.uuid4().hex
    projects = [prefix + "-core-source", prefix + "-core-target"]
    owned_containers, owned_volumes = [], []
    baseline_volumes = set(docker("volume", "ls", "--quiet").split())
    existing = docker("ps", "--quiet").split()
    before = {c["Id"]: c["State"]["StartedAt"] for c in snapshot.runtimes.inspect(existing)} if existing else {}
    report = {"status": "failed", "checks": [], "images": {name: item["Id"] for name, item in images.items()}}
    scripts = Path(__file__).resolve().parent
    names = ("verify-customer-deployment-backup", "customer-deployment-backup", "deployment-backup",
             "customer-runtime-backup", "customer-search-backup", "verify-customer-runtime-backup", "verify-customer-search-backup")
    report["sourceHashes"] = {name + ".py": hashlib.sha256((scripts / (name + ".py")).read_bytes()).hexdigest() for name in names}
    temporary = tempfile.TemporaryDirectory(prefix="coordinated-fixture-")
    root = Path(temporary.name)
    env = root / "fixture.env"
    env.write_text("ENCRYPTION_KEY=synthetic-coordinated-recovery\n")
    compose_file = root / "compose.json"
    idle = {"image": images["runtime"]["Id"], "pull_policy": "never", "init": True,
            "entrypoint": ["sleep"], "command": ["infinity"], "network_mode": "none",
            "mem_limit": "64m", "memswap_limit": "64m", "cpus": 0.25,
            "environment": {"DATA_DIR": "/data", "ENCRYPTION_KEY": "${ENCRYPTION_KEY}"},
            "volumes": ["appdata:/data"]}
    compose_file.write_text(json.dumps({"services": {
        "api": idle, "worker": idle,
        "postgres": {"image": images["postgres"]["Id"], "pull_policy": "never", "network_mode": "none",
                     "mem_limit": "256m", "memswap_limit": "256m", "cpus": 1,
                     "environment": {"POSTGRES_USER": "example", "POSTGRES_PASSWORD": "synthetic-password", "POSTGRES_DB": "example"},
                     "volumes": ["pgdata:/var/lib/postgresql/data"],
                     "healthcheck": {"test": ["CMD", "pg_isready", "-U", "example"], "interval": "1s", "timeout": "2s", "retries": 30}}},
        "volumes": {"appdata": {}, "pgdata": {}}}))

    def compose(project, *parts):
        return docker("compose", "--project-name", project, "--env-file", str(env), "-f", str(compose_file), *parts)

    def core_args(project):
        return argparse.Namespace(project=project, env_file=str(env), compose=[str(compose_file)])

    try:
        customers, sqlite_bytes = runtime_fixture.create_fixture(root, prefix, images["postgres"]["Id"], images["runtime"], owned_containers, owned_volumes)
        compose(projects[0], "create", "--pull", "never")
        compose(projects[0], "up", "--detach", "--wait", "--wait-timeout", "60", "--pull", "never", "postgres", "api")
        deployment = core.Deployment(core_args(projects[0]))
        _, services, data, _ = deployment.resources()
        marker = runtime_fixture.SECRET
        sql = root / "seed.sql"
        sql.write_text("CREATE TABLE recovery_epoch (value text); INSERT INTO recovery_epoch VALUES ('" + marker.replace("'", "''") + "');\n")
        with sql.open("rb") as file:
            core.postgres(deployment, 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"', stdin=file)
        core.helper(data, images["postgres"]["Id"], "sh", "-c", 'printf %s "$1" > /data/epoch.txt', "fixture", marker, writable=True)
        search_volumes = []
        for suffix in ("search-source-data", "search-source-repository", "search-target-data", "search-target-repository"):
            volume = prefix + "-" + suffix
            docker("volume", "create", volume)
            owned_volumes.append(volume)
            search_volumes.append(volume)
        source_name, target_name = prefix + "-search-source", prefix + "-search-target"
        owned_containers.append(source_name)
        source_search = search_fixture.start_node(images["search"]["Id"], source_name, search_volumes[0], search_volumes[1])
        source_search.request("PUT", "/coordinated-fixture", {"settings": {"number_of_shards": 1, "number_of_replicas": 0}})
        source_search.request("PUT", "/coordinated-fixture/_doc/epoch?refresh=true", {"value": marker, "allowed_users": ["fixture-owner"]})
        capture = core_args(projects[0])
        for role, container in customers.items():
            setattr(capture, role, container)
        capture.search = source_name
        capture.output = str(args.report_directory / "rejected")
        original_capture = core.capture
        def restart_during_capture(deployment, output):
            original_capture(deployment, output)
            docker("start", customers["connector"])
            docker("stop", "--time", "5", customers["connector"])
        print("Rejecting a fixture writer restart between component captures.", flush=True)
        with patch.object(core, "capture", restart_during_capture):
            try:
                snapshot.backup(capture)
                raise AssertionError("Restarted writer was accepted")
            except core.SnapshotError as error:
                assert "changed during capture" in str(error)
        assert not Path(capture.output).exists()
        assert all(c["State"]["Running"] for c in snapshot.runtimes.inspect(list(customers.values())))
        report["checks"].append("writer restart after core capture rejects unpublished bundle and resumes selected services")
        capture.output = str(args.report_directory / "snapshot")
        print("Capturing core, runtime files and search under one stopped-writer window.", flush=True)
        snapshot.backup(capture)
        bundle = Path(capture.output)
        snapshot.verify(bundle)
        assert bundle.stat().st_mode & 0o777 == 0o700
        assert (bundle / "manifest.json").stat().st_mode & 0o777 == 0o600
        current = deployment.resources()[1]
        assert current["api"]["State"]["Running"] and not current["worker"]["State"]["Running"]
        assert all(c["State"]["Running"] for c in snapshot.runtimes.inspect(list(customers.values())))
        report["checks"].append("atomic bound component artifact verifies; originally running writers resume and stopped worker remains stopped")
        compose(projects[1], "create", "--pull", "never")
        compose(projects[1], "up", "--detach", "--wait", "--wait-timeout", "60", "--pull", "never", "postgres")
        target_args = core_args(projects[1])
        target_args.source = str(bundle / "core")
        core.restore(target_args)
        restored_core = core.Deployment(target_args)
        value = core.postgres(restored_core, 'psql -XAt -U "$POSTGRES_USER" "$POSTGRES_DB" -c "SELECT value FROM recovery_epoch"').decode().strip()
        assert value == marker
        target_data = restored_core.resources()[2]
        assert core.helper(target_data, images["postgres"]["Id"], "cat", "/data/epoch.txt").decode() == marker
        target_runtime = args.report_directory / "restored-runtimes"
        snapshot.runtimes.restore(argparse.Namespace(source=str(bundle / "runtimes"), output=str(target_runtime)))
        restored_volumes = json.loads((target_runtime / "volumes.json").read_text())
        owned_volumes.extend(restored_volumes)
        for index, volume in enumerate(restored_volumes):
            mount = {"Type": "volume", "Name": volume, "Destination": "/restore"}
            content = core.helper(mount, images["postgres"]["Id"], "cat", "/restore/state.sqlite")
            assert content == sqlite_bytes
            file = root / f"restored-{index}.sqlite"
            file.write_bytes(content)
            with sqlite3.connect(file) as connection:
                assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                assert connection.execute("SELECT value FROM state").fetchone() == (marker,)
        # Source and target OpenSearch never run together, keeping memory bounded.
        docker("stop", "--time", "90", source_name)
        owned_containers.append(target_name)
        target_search = search_fixture.start_node(images["search"]["Id"], target_name, search_volumes[2], search_volumes[3])
        snapshot.search.restore(target_name, bundle / "search")
        assert target_search.request("GET", "/coordinated-fixture/_doc/epoch")["_source"] == {"value": marker, "allowed_users": ["fixture-owner"]}
        report["checks"].append("fresh core PostgreSQL/file, runtime SQLite and OpenSearch restores retain the same synthetic marker and search access fields")
        report["status"] = "passed"
    except Exception as error:
        report["failureType"] = type(error).__name__
        raise
    finally:
        for project in projects:
            subprocess.run(["docker", "compose", "--project-name", project, "--env-file", str(env), "-f", str(compose_file), "down", "--volumes"], capture_output=True, timeout=90)
        for name in owned_containers:
            subprocess.run(["docker", "rm", "--force", "--volumes", name], capture_output=True, timeout=45)
        for name in owned_volumes:
            subprocess.run(["docker", "volume", "rm", name], capture_output=True, timeout=45)
        report["temporaryContainersRemoved"] = not docker("ps", "--all", "--quiet", "--filter", "name=" + prefix)
        remaining = set(docker("volume", "ls", "--quiet").split())
        report["unexpectedNewVolumes"] = sorted(remaining - baseline_volumes)
        report["temporaryVolumesRemoved"] = not report["unexpectedNewVolumes"] and not remaining.intersection(owned_volumes)
        after = snapshot.runtimes.inspect(existing) if existing else []
        report["existingContainersUnchanged"] = all(c["State"]["Running"] and c["State"]["StartedAt"] == before[c["Id"]] for c in after)
        if not all(report[key] for key in ("temporaryContainersRemoved", "temporaryVolumesRemoved", "existingContainersUnchanged")):
            report["status"] = "failed"
        (args.report_directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        temporary.cleanup()
    assert report["status"] == "passed"
    print("Coordinated capture and component restores passed; disposable resources removed.")


if __name__ == "__main__":
    main()
