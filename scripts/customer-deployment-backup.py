#!/usr/bin/env python3
"""Capture core, customer runtimes and search during one stopped-writer window.

Stop external clients, host writers and deployment automation before use.
Search security/global configuration, images and external services remain separate.
"""

import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


runtimes = module("customer-runtime-backup")
search = module("customer-search-backup")
core = runtimes.core
ERRORS = (core.SnapshotError, search.SnapshotError)
COMPONENTS = {"core": core.verify, "runtimes": runtimes.verify, "search": search.verify}


def verify(source):
    try:
        manifest = json.loads((source / "manifest.json").read_text())
        if manifest["format"] != "deskazo-customer-deployment-1" or set(manifest["components"]) != set(COMPONENTS):
            raise core.SnapshotError("Incomplete coordinated snapshot")
        for name, validator in COMPONENTS.items():
            directory = source / name
            file = directory / "manifest.json"
            if directory.is_symlink() or file.is_symlink() or core.digest(file) != manifest["components"][name]:
                raise core.SnapshotError("Coordinated snapshot component mismatch")
            validator(directory)
        return manifest
    except (OSError, KeyError, ValueError, TypeError, AttributeError) as error:
        raise core.SnapshotError("Coordinated snapshot is incomplete or unreadable") from error


def backup(args):
    deployment = core.Deployment(args)
    output = Path(args.output).absolute()
    if output.exists() or output.is_symlink():
        raise core.SnapshotError("Choose a new coordinated snapshot destination")
    customer = runtimes.inspect([getattr(args, role) for role in runtimes.REQUIRED])
    customer_ids = [item["Id"] for item in customer]
    node = search.Search(args.search)
    with core.lock(deployment), runtimes.runtime_locks(customer_ids):
        containers, services, data, _ = deployment.resources()
        all_items = containers + customer + runtimes.inspect([node.container])
        if len({item["Id"] for item in all_items}) != len(all_items):
            raise core.SnapshotError("Core, customer runtimes and search must be distinct containers")
        if not services["postgres"]["State"]["Running"]:
            raise core.SnapshotError("Postgres must be running before capture")
        for role, item in zip(runtimes.REQUIRED, customer):
            runtimes.validate_runtime(role, item)
        mounts = [data, node.data] + [mount for item in customer for mount in item["Mounts"]]
        for mount in mounts:
            source = Path(mount["Source"])
            if output == source or source in output.parents:
                raise core.SnapshotError("Store snapshots outside captured data")
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        stopped = []
        published = False
        baseline = {item["Id"]: (item["Image"], item["Config"], item["State"]["StartedAt"]) for item in all_items}

        def stop(ids):
            for id in ids:
                if id in stopped:
                    raise core.SnapshotError("A stopped writer restarted during capture")
                if id not in baseline:
                    item = runtimes.inspect([id])[0]
                    baseline[id] = (item["Image"], item["Config"], item["State"]["StartedAt"])
                stopped.append(id)  # A lost Docker response may still mean stopped.
                core.command(["docker", "stop", "--time", "120", id], operation="Stop coordinated snapshot writer", timeout=150)

        def quiet():
            if core.running_writers(deployment, data):
                raise core.SnapshotError("Core writers restarted during coordinated capture")
            runtimes.assert_quiet(customer_ids, [mount for item in customer for mount in item["Mounts"]])
            core.require_exclusive_database(deployment)
            current = runtimes.inspect(list(baseline))
            for item in current:
                if baseline[item["Id"]] != (item["Image"], item["Config"], item["State"]["StartedAt"]):
                    raise core.SnapshotError("A coordinated snapshot container changed during capture")
            if {item["Id"] for item in deployment.containers()} != {item["Id"] for item in containers}:
                raise core.SnapshotError("Core deployment containers changed during capture")

        try:
            # Stop API/worker/supervisor first, then catch computers created during
            # their shutdown. Database and search remain available for snapshots.
            stop(core.running_writers(deployment, data))
            stop(core.running_writers(deployment, data))
            stop([item["Id"] for item in customer if item["State"]["Running"]])
            quiet()
            with tempfile.TemporaryDirectory(prefix=".customer-snapshot-", dir=output.parent) as temporary:
                staging = Path(temporary)
                started = datetime.datetime.now(datetime.timezone.utc).isoformat()
                core.capture(deployment, staging / "core")
                quiet()
                runtime_args = argparse.Namespace(**dict(zip(runtimes.REQUIRED, customer_ids)),
                                                  helper_image=services["postgres"]["Image"], output=str(staging / "runtimes"))
                runtimes.capture(runtime_args, customer_ids)
                quiet()
                search.backup(node.container, staging / "search")
                quiet()
                manifest = {"format": "deskazo-customer-deployment-1", "quiescedAt": started,
                            "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            "components": {name: core.digest(staging / name / "manifest.json") for name in COMPONENTS},
                            "exclusions": "Search security/global configuration, registry images, external services and host files outside captured mounts"}
                (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
                (staging / "manifest.json").chmod(0o600)
                verify(staging)
                if output.exists() or output.is_symlink():
                    raise core.SnapshotError("Snapshot destination appeared during capture")
                os.rename(staging, output)
                published = True
        finally:
            # Dependencies first; attempt every originally running container even
            # if another resume fails. Never start an originally stopped service.
            roles = dict(zip(runtimes.REQUIRED, customer_ids))
            groups = [[roles["connector"], roles["langflow"]], [roles["openrag"]],
                      [id for id in stopped if id not in customer_ids]]
            failed = False
            for group in groups:
                selected = [id for id in group if id in stopped]
                for id in selected:
                    try:
                        core.command(["docker", "start", id], operation="Resume coordinated snapshot writer", timeout=150)
                    except core.SnapshotError:
                        failed = True
                try:
                    core.wait_running(selected)
                except core.SnapshotError:
                    failed = True
            if failed:
                raise core.SnapshotError("Snapshot published, but service resumption needs attention" if published else "Capture failed, and service resumption needs attention")


def main():
    os.umask(0o077)
    def interrupted(_number, _frame):
        raise core.SnapshotError("Coordinated snapshot interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    capture = commands.add_parser("backup")
    capture.add_argument("--project", required=True)
    capture.add_argument("--compose", action="append", required=True)
    capture.add_argument("--env-file", required=True)
    for role in (*runtimes.REQUIRED, "search"):
        capture.add_argument("--" + role, required=True, help="Exact container name or ID")
    capture.add_argument("--output", required=True)
    commands.add_parser("verify").add_argument("--source", required=True)
    args = parser.parse_args()
    try:
        if args.action == "backup":
            backup(args)
        else:
            verify(Path(args.source))
    except (*ERRORS, OSError, ValueError) as error:
        print(str(error) if isinstance(error, ERRORS) else "Coordinated snapshot could not finish", file=sys.stderr)
        return 1
    print("Coordinated snapshot verified. Keep its component directories together and encrypt the off-host copy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
