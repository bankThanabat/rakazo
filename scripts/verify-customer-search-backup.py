#!/usr/bin/env python3
"""Exercise search backup and fresh-node restore using synthetic disposable data."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

spec = importlib.util.spec_from_file_location("search_backup", Path(__file__).with_name("customer-search-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def docker(*args):
    return backup.core.command(["docker", *args], operation="Disposable search verification", timeout=180).decode().strip()


def start_node(image, container, data_volume, repository_volume):
    docker("run", "--detach", "--pull=never", "--name", container, "--network=none",
           "--memory=2g", "--memory-swap=2g", "--cpus=2", "--pids-limit=512",
           "--env", "discovery.type=single-node", "--env", "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m",
           "--env", "OPENSEARCH_INITIAL_ADMIN_PASSWORD=Synthetic-Search-Backup-23!",
           "--env", "path.repo=" + backup.REPOSITORIES,
           "--mount", f"type=volume,source={data_volume},target=/usr/share/opensearch/data",
           "--mount", f"type=volume,source={repository_volume},target={backup.REPOSITORIES}", image)
    node = backup.Search(container)
    deadline = time.monotonic() + 180
    while True:
        try:
            health = node.request("GET", "/_cluster/health?wait_for_status=yellow&timeout=2s")
            if health.get("status") in ("green", "yellow"):
                return node
        except backup.SnapshotError:
            pass
        if time.monotonic() > deadline:
            raise RuntimeError("Disposable OpenSearch did not become healthy")
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--report-directory", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image):
        parser.error("Use an already cached immutable image ID")
    os.umask(0o077)
    args.report_directory.mkdir(mode=0o700)
    prefix = "deskazo-search-check-" + uuid.uuid4().hex
    containers = [prefix + "-source", prefix + "-target"]
    volumes = [prefix + "-" + name for name in ("source-data", "source-repository", "target-data", "target-repository")]
    report = {"status": "failed", "image": args.image, "checks": []}
    scripts = Path(__file__).resolve().parent
    report["sourceHashes"] = {name: hashlib.sha256((scripts / name).read_bytes()).hexdigest()
                              for name in ("verify-customer-search-backup.py", "customer-search-backup.py", "deployment-backup.py")}
    existing = docker("ps", "--quiet").split()
    baseline = json.loads(docker("inspect", *existing)) if existing else []
    baseline = {item["Id"]: item["State"]["StartedAt"] for item in baseline}


    try:
        for volume in volumes:
            docker("volume", "create", volume)
        source = start_node(args.image, containers[0], volumes[0], volumes[1])
        report["serverVersion"] = source.request("GET", "/")["version"]["number"]
        print("Source node ready; creating synthetic knowledge and access metadata.", flush=True)
        properties = {"text": {"type": "text"}, "allowed_users": {"type": "keyword"},
                      "vector": {"type": "knn_vector", "dimension": 3, "method": {
                          "name": "disk_ann", "engine": "jvector", "space_type": "l2",
                          "parameters": {"ef_construction": 128, "m": 16}}}}
        source.request("PUT", "/documents-fixture", {
            "settings": {"number_of_shards": 1, "number_of_replicas": 0, "index.knn": True},
            "mappings": {"properties": properties}, "aliases": {"current-documents": {}},
        })
        document = {"text": "Synthetic shipping policy", "allowed_users": ["fixture-owner"], "vector": [1.0, 0.0, 0.0]}
        source.request("PUT", "/documents-fixture/_doc/example?refresh=true", document)
        source.request("PUT", "/knowledge_filters", {"settings": {"number_of_shards": 1, "number_of_replicas": 0}})
        source.request("PUT", "/knowledge_filters/_doc/example?refresh=true", {"name": "Synthetic scope", "owner": "fixture-owner"})
        source.request("PUT", "/.deskazo-hidden-fixture", {"settings": {"number_of_shards": 1, "number_of_replicas": 0, "index.hidden": True}})
        source.request("PUT", "/.deskazo-hidden-fixture/_doc/example?refresh=true", {"value": "Synthetic hidden state"})
        expected = source.indices()
        artifact = args.report_directory / "snapshot"
        backup.backup(containers[0], artifact)
        manifest = backup.verify(artifact)
        assert sorted(manifest["snapshot"]["indices"]) == expected
        assert backup.SECURITY_INDEX not in expected and ".deskazo-hidden-fixture" in expected
        assert artifact.stat().st_mode & 0o777 == 0o700
        assert all(file.stat().st_mode & 0o777 == 0o600 for file in artifact.iterdir())
        report["checks"].append("portable snapshot includes visible and hidden indices, excludes security/global state, uses private permissions")
        try:
            backup.restore(containers[0], artifact)
            raise AssertionError("Occupied source was accepted as restore target")
        except backup.SnapshotError as error:
            assert "empty search node" in str(error)
        report["checks"].append("occupied restore rejected without deleting source data")
        docker("stop", "--time", "90", containers[0])
        target = start_node(args.image, containers[1], volumes[2], volumes[3])
        bootstrap = target.indices()
        print("Fresh target ready; restoring the portable snapshot.", flush=True)
        backup.restore(containers[1], artifact)
        history_prefix = "deskazo-restored-" + manifest["snapshot"]["uuid"].lower() + "-"
        restored_indices = [history_prefix + name if backup.bootstrap_index(name) else name for name in expected]
        assert target.indices() == sorted(set(bootstrap + restored_indices))
        assert target.request("GET", "/current-documents/_doc/example")["_source"] == document
        restored = target.request("GET", "/documents-fixture/_mapping")
        assert restored["documents-fixture"]["mappings"]["properties"] == properties
        assert target.request("GET", "/knowledge_filters/_doc/example")["_source"]["owner"] == "fixture-owner"
        assert target.request("GET", "/.deskazo-hidden-fixture/_doc/example")["_source"]["value"] == "Synthetic hidden state"
        result = target.request("POST", "/current-documents/_search", {"query": {"knn": {"vector": {"vector": [1.0, 0.0, 0.0], "k": 1}}}})
        assert result["hits"]["hits"][0]["_id"] == "example"
        report["checks"].append("fresh-node restore preserves documents, access fields, mappings, alias, hidden state and vector search")
        report["status"] = "passed"
    except Exception as error:
        report["failureType"] = type(error).__name__
        if isinstance(error, (backup.SnapshotError, RuntimeError)):
            report["failure"] = str(error)
        raise
    finally:
        for name in containers:
            subprocess.run(["docker", "rm", "--force", name], capture_output=True, timeout=45)
        for name in volumes:
            subprocess.run(["docker", "volume", "rm", name], capture_output=True, timeout=45)
        report["temporaryContainersRemoved"] = not docker("ps", "--all", "--quiet", "--filter", "name=" + prefix)
        report["temporaryVolumesRemoved"] = not docker("volume", "ls", "--quiet", "--filter", "name=" + prefix)
        after = json.loads(docker("inspect", *existing)) if existing else []
        report["existingContainersUnchanged"] = all(item["State"]["Running"] and baseline[item["Id"]] == item["State"]["StartedAt"] for item in after)
        if not all(report[key] for key in ("temporaryContainersRemoved", "temporaryVolumesRemoved", "existingContainersUnchanged")):
            report["status"] = "failed"
        (args.report_directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    assert report["status"] == "passed"
    print("Search snapshot and fresh-node restore passed; owned resources removed.")


if __name__ == "__main__":
    main()
