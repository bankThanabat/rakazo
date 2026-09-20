#!/usr/bin/env python3
"""Capture local customer runtimes together; prepare fresh isolated restore volumes."""

import argparse
import contextlib
import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import sys
import tarfile
import tempfile
import uuid

spec = importlib.util.spec_from_file_location("deployment_backup", Path(__file__).with_name("deployment-backup.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
Error = core.SnapshotError
REQUIRED = {"langflow": {"/app/langflow-data", "/app/flows"},
            "openrag": {"/app/openrag-documents", "/app/keys", "/app/flows", "/app/config", "/app/data"},
            "connector": {"/app/data"}}


def inspect(ids):
    return json.loads(core.command(["docker", "inspect", *ids], operation="Inspect customer runtimes"))


def environment(config):
    return dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)


def validate_runtime(role, item):
    mounts = item["Mounts"]
    destinations = [m["Destination"] for m in mounts]
    if len(set(destinations)) != len(destinations) or not REQUIRED[role].issubset(destinations):
        raise Error("Customer runtime is missing required persistent mounts")
    if any(m["Type"] not in ("volume", "bind") or not m["Destination"].startswith("/app/") for m in mounts):
        raise Error("Customer runtime has unsupported mounts; provide a separate recovery plan")
    env = environment(item["Config"])
    def covered(path):
        target = PurePosixPath(path)
        if not target.is_absolute():
            target = PurePosixPath(item["Config"].get("WorkingDir") or "/") / target
        return ".." not in target.parts and any(target == PurePosixPath(m) or PurePosixPath(m) in target.parents for m in destinations)
    if role == "connector":
        if env.get("OOMOL_CONNECT_DATABASE_URL"):
            raise Error("External connector databases require a separate coordinated backup")
        if not covered(env.get("OOMOL_CONNECT_DATA_DIR") or "/app/data"):
            raise Error("Connector data directory is outside captured mounts")
    if role == "openrag":
        url = env.get("DATABASE_URL")
        if url:
            match = re.fullmatch(r"sqlite(?:\+aiosqlite)?:///(/[^?%]+)", url)
            if not match or not covered(match[1]):
                raise Error("External OpenRAG databases require a separate coordinated backup")
        defaults = {"DOCUMENTS": "openrag-documents", "KEYS": "keys", "FLOWS": "flows", "CONFIG": "config", "DATA": "data"}
        for key, default in defaults.items():
            if not covered(env.get("OPENRAG_" + key + "_PATH") or default):
                raise Error("OpenRAG data directory is outside captured mounts")
        if not covered(env.get("OPENRAG_FLOWS_BACKUP_PATH") or (env.get("OPENRAG_FLOWS_PATH") or "flows") + "/backup"):
            raise Error("OpenRAG backup directory is outside captured mounts")
    if role == "langflow":
        url = env.get("LANGFLOW_DATABASE_URL", "sqlite:////app/langflow-data/langflow.db")
        if not url.startswith("sqlite:////app/langflow-data/") or ".." in PurePosixPath(url.split("?", 1)[0]).parts:
            raise Error("External Langflow databases require a separate coordinated backup")
    if item.get("State", {}).get("Paused") or item.get("State", {}).get("Restarting"):
        raise Error("Wait for a stable unpaused customer runtime before backup")
    if item["HostConfig"].get("AutoRemove"):
        raise Error("Auto-removing runtimes cannot be stopped for backup")


def assert_quiet(ids, mounts):
    if any(c["State"]["Running"] for c in inspect(ids)):
        raise Error("Customer runtimes restarted during capture")
    running = core.command(["docker", "ps", "--quiet"], operation="Find remaining data writers").decode().split()
    for container in inspect(running) if running else []:
        if any(m.get("RW") and core.same_data(m, data) for m in container["Mounts"] for data in mounts):
            raise Error("Another running container writes customer data; stop it before backup")


def verify(source):
    try:
        manifest = json.loads((source / "manifest.json").read_text())
        if manifest["format"] != "deskazo-runtimes-1" or set(manifest["runtimes"]) != set(REQUIRED):
            raise Error("Invalid customer runtime snapshot metadata")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", manifest["helperImage"]):
            raise Error("Invalid helper image identity")
        used = set()
        for role, item in manifest["runtimes"].items():
            validate_runtime(role, item)
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", item["Image"]):
                raise Error("Invalid runtime image identity")
            for mount in item["Mounts"]:
                key = mount["archive"]
                if not re.fullmatch(r"mount-[0-9]+\.tgz", key):
                    raise Error("Invalid archive identity")
                used.add(key)
        if used != set(manifest["files"]):
            raise Error("Snapshot archive coverage is incomplete")
        for name, digest in manifest["files"].items():
            file = source / name
            if file.is_symlink() or not file.is_file() or core.digest(file) != digest:
                raise Error("Customer runtime archive checksum mismatch")
            core.archive_paths(file)
        return manifest
    except (OSError, ValueError, TypeError, KeyError, AttributeError, tarfile.TarError) as error:
        raise Error("Customer runtime snapshot is incomplete or unreadable") from error


@contextlib.contextmanager
def runtime_locks(ids):
    root = Path(tempfile.gettempdir()) / ("deskazo-runtime-backup-" + str(os.getuid()))
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise Error("Runtime lock directory must be private")
    with contextlib.ExitStack() as stack:
        for id in sorted(ids):
            if not re.fullmatch(r"[a-f0-9]{64}", id):
                raise Error("Invalid runtime container identity")
            descriptor = os.open(root / id, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            stack.callback(os.close, descriptor)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Error("A customer runtime backup is already running") from error
        yield


def backup(args):
    ids = [item["Id"] for item in inspect([getattr(args, role) for role in REQUIRED])]
    with runtime_locks(ids):
        capture(args, ids)


def capture(args, locked_ids):
    output = Path(args.output).absolute()
    if output.exists() or output.is_symlink():
        raise Error("Choose a new snapshot destination")
    roles = {role: getattr(args, role) for role in REQUIRED}
    containers = inspect(list(roles.values()))
    if len({c["Id"] for c in containers}) != len(REQUIRED):
        raise Error("Select three distinct customer runtimes")
    if [c["Id"] for c in containers] != locked_ids:
        raise Error("Runtime names changed while acquiring backup locks")
    runtimes = dict(zip(roles, containers))
    for role, item in runtimes.items():
        validate_runtime(role, item)
    helper_image = json.loads(core.command(["docker", "image", "inspect", args.helper_image], operation="Inspect cached archive helper"))[0]["Id"]
    mounts = {}
    for item in runtimes.values():
        for mount in item["Mounts"]:
            source = Path(mount["Source"])
            if output == source or source in output.parents:
                raise Error("Store snapshots outside captured data")
            # Shared mounts keep one archive and one restored volume. Nested binds
            # remain separate mounts, preserving the original container view.
            key = (mount["Type"], mount.get("Name") if mount["Type"] == "volume" else mount["Source"])
            if key not in mounts:
                mounts[key] = {**mount, "archive": f"mount-{len(mounts)}.tgz"}
            mount["archive"] = mounts[key]["archive"]
    ids = [c["Id"] for c in containers]
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    stopped = []
    published = False
    try:
        for item in containers:
            if item["State"]["Running"]:
                stopped.append(item["Id"])
                core.command(["docker", "stop", "--time", "120", item["Id"]], operation="Stop customer runtime", timeout=150)
        assert_quiet(ids, mounts.values())
        with tempfile.TemporaryDirectory(prefix=".runtimes-", dir=output.parent) as temporary:
            staging = Path(temporary)
            for mount in mounts.values():
                with (staging / mount["archive"]).open("wb") as file:
                    core.helper(mount, helper_image, "tar", "--numeric-owner", "-czf", "-", "-C", mount["Destination"], ".", stdout=file)
            assert_quiet(ids, mounts.values())
            latest = inspect(ids)
            if any(a["Config"] != b["Config"] or a["Image"] != b["Image"] for a, b in zip(containers, latest)):
                raise Error("Customer runtime configuration changed during capture")
            # Include effective secrets, entrypoints and environment for recovery,
            # but not host networking, labels or unrelated container diagnostics.
            saved = {role: {"Image": item["Image"], "Config": item["Config"],
                            "HostConfig": {"AutoRemove": False}, "Mounts": item["Mounts"]}
                     for role, item in runtimes.items()}
            manifest = {"format": "deskazo-runtimes-1", "helperImage": helper_image, "runtimes": saved,
                        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        "files": {file.name: core.digest(file) for file in staging.iterdir()}}
            (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            for file in staging.iterdir():
                file.chmod(0o600)
            verify(staging)
            if output.exists() or output.is_symlink():
                raise Error("Snapshot destination appeared during capture")
            os.rename(staging, output)
            published = True
    finally:
        failures = []
        for id in stopped:
            try:
                core.command(["docker", "start", id], operation="Resume customer runtime", timeout=150)
            except Error:
                failures.append(id)
        if failures:
            raise Error("Snapshot published but resume failed" if published else "Capture failed and some runtimes could not resume")
        core.wait_running(stopped)


def restore(args):
    source = Path(args.source)
    manifest = verify(source)  # Validate before any Docker mutation.
    output = Path(args.output).absolute()
    if output.exists() or output.is_symlink():
        raise Error("Choose a new restore configuration directory")
    prefix = "deskazo-runtime-restore-" + uuid.uuid4().hex
    names = {archive: prefix + "-" + archive.removesuffix(".tgz") for archive in manifest["files"]}
    created = []
    try:
        # Explicitly create unique volumes, then require empty contents. No existing
        # deployment volume or host path is a possible extraction target.
        for archive, name in names.items():
            core.command(["docker", "volume", "create", "--label", "deskazo.recovery=" + prefix, name], operation="Create fresh recovery volume")
            created.append(name)
            mount = {"Type": "volume", "Name": name, "Destination": "/restore"}
            if core.helper(mount, manifest["helperImage"], "find", "/restore", "-mindepth", "1", "-print", "-quit").strip():
                raise Error("Fresh recovery volume is not empty")
            with (source / archive).open("rb") as file:
                core.helper(mount, manifest["helperImage"], "tar", "-xzf", "-", "-C", "/restore",
                            "--numeric-owner", "--same-owner", "--same-permissions", writable=True, stdin=file)
        config = {"name": prefix, "services": {}, "volumes": {name: {"external": True, "name": name} for name in names.values()}}
        for role, item in manifest["runtimes"].items():
            original = item["Config"]
            service = {"image": item["Image"], "pull_policy": "never", "network_mode": "none", "restart": "no",
                       "environment": original.get("Env", []), "volumes": [
                           {"type": "volume", "source": names[m["archive"]], "target": m["Destination"], "read_only": not m["RW"], "volume": {"nocopy": True}}
                           for m in item["Mounts"]]}
            for key, target in (("Entrypoint", "entrypoint"), ("Cmd", "command"), ("User", "user"), ("WorkingDir", "working_dir")):
                if original.get(key) is not None:
                    service[target] = original[key]
            config["services"][role] = service
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix=".restore-", dir=output.parent) as temporary:
            staging = Path(temporary)
            # Compose expands dollar signs even in JSON. Preserve runtime values
            # exactly, including passwords and shell commands containing dollars.
            def literal(value):
                if isinstance(value, str):
                    return value.replace("$", "$$")
                if isinstance(value, list):
                    return [literal(item) for item in value]
                if isinstance(value, dict):
                    return {key: literal(item) for key, item in value.items()}
                return value
            (staging / "compose.json").write_text(json.dumps(literal(config), indent=2) + "\n")
            (staging / "volumes.json").write_text(json.dumps(list(names.values()), indent=2) + "\n")
            for file in staging.iterdir():
                file.chmod(0o600)
            if output.exists() or output.is_symlink():
                raise Error("Restore destination appeared during extraction")
            os.rename(staging, output)
        created.clear()  # Published recovery now owns these volumes.
    finally:
        for name in created:
            core.command(["docker", "volume", "rm", name], operation="Remove failed recovery volume")


def main():
    os.umask(0o077)
    def interrupted(_number, _frame):
        raise Error("Customer runtime snapshot interrupted")
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    capture = commands.add_parser("backup")
    for role in REQUIRED:
        capture.add_argument("--" + role, required=True, help="Exact container name or ID")
    capture.add_argument("--helper-image", required=True, help="Cached image with GNU tar and find")
    capture.add_argument("--output", required=True)
    restore_parser = commands.add_parser("restore")
    restore_parser.add_argument("--source", required=True)
    restore_parser.add_argument("--output", required=True)
    commands.add_parser("verify").add_argument("--source", required=True)
    args = parser.parse_args()
    try:
        if args.action == "backup":
            backup(args)
        elif args.action == "restore":
            restore(args)
        else:
            verify(Path(args.source))
    except (Error, OSError, ValueError) as error:
        print(str(error) if isinstance(error, Error) else "Customer runtime recovery could not finish", file=sys.stderr)
        return 1
    print("Customer runtime snapshot verified." if args.action != "restore" else "Data restored into fresh volumes. Services remain unstarted and isolated; review the full deployment before use.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
