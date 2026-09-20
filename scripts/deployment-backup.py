#!/usr/bin/env python3
"""Consistent core-deployment snapshots. Requires Python 3.11+ and Docker Compose."""

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import signal
import subprocess
import sys
import tarfile
import tempfile
import time


class SnapshotError(Exception):
    pass


RUNTIME_SECRETS = ("ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "SCREEN_PROXY_SECRET", "SANDBOX_SUPERVISOR_TOKEN")


def command(args, *, operation, stdin=None, stdout=None, timeout=300):
    """Never echo arguments or Docker stderr: resolved configuration contains secrets."""
    try:
        result = subprocess.run(args, stdin=stdin, stdout=stdout or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SnapshotError(f"{operation} could not finish") from error
    if result.returncode:
        raise SnapshotError(f"{operation} failed; inspect this deployment with Docker")
    return result.stdout or b""


def digest(file):
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def archive_paths(file):
    """Reject extraction through links or outside the otherwise empty data volume."""
    entries = {}
    with tarfile.open(file, "r:gz") as archive:
        for entry in archive:
            name = PurePosixPath(entry.name)
            if name.is_absolute() or ".." in name.parts:
                raise SnapshotError("Snapshot archive contains an unsafe path")
            key = str(name)
            if key in entries or not (entry.isfile() or entry.isdir() or entry.issym() or entry.islnk()):
                raise SnapshotError("Snapshot archive contains a duplicate or unsupported entry")
            entries[key] = entry
    for name, entry in entries.items():
        for parent in PurePosixPath(name).parents:
            ancestor = entries.get(str(parent))
            if ancestor and not ancestor.isdir():
                raise SnapshotError("Snapshot archive would extract through a link")
        if entry.islnk():
            target = PurePosixPath(entry.linkname)
            original = entries.get(str(target))
            if target.is_absolute() or ".." in target.parts or not original or not original.isfile():
                raise SnapshotError("Snapshot archive contains an unsafe hard link")
    # Symlinks themselves are preserved, including browser runtime links into /tmp.
    # No member may be extracted through one; the helper also has a read-only root.


def verify(source):
    try:
        manifest = json.loads((source / "manifest.json").read_text())
        if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict) or not isinstance(manifest.get("images"), dict):
            raise SnapshotError("Unsupported or incomplete snapshot")
        if manifest["version"] != 1 or not {
            "database.dump", "appdata.tgz", "environment.env", "compose.resolved.json"
        }.issubset(manifest["files"]):
            raise SnapshotError("Unsupported or incomplete snapshot")
        if not {"api", "postgres"}.issubset(manifest["images"]):
            raise SnapshotError("Snapshot has no deployment image identities")
        if not all(isinstance(value, str) and value for value in manifest["images"].values()):
            raise SnapshotError("Snapshot has invalid deployment image identities")
        for name, expected in manifest["files"].items():
            if Path(name).name != name or name in (".", ".."):
                raise SnapshotError("Invalid snapshot file name")
            file = source / name
            if file.is_symlink() or not file.is_file() or digest(file) != expected:
                raise SnapshotError("Snapshot checksum verification failed")
        archive_paths(source / "appdata.tgz")
        config = json.loads((source / "compose.resolved.json").read_text())
        services = config.get("services") if isinstance(config, dict) else None
        if not isinstance(services, dict) or not {"api", "postgres"}.issubset(services) or any(
            not isinstance(service, dict) or not isinstance(service.get("environment", {}), dict)
            for service in services.values()
        ):
            raise SnapshotError("Snapshot has invalid deployment configuration")
        return manifest
    except (OSError, KeyError, TypeError, ValueError, tarfile.TarError) as error:
        raise SnapshotError("Snapshot is incomplete or unreadable") from error


class Deployment:
    def __init__(self, args):
        self.env_file = Path(args.env_file).resolve(strict=True)
        self.files = [Path(file).resolve(strict=True) for file in args.compose]
        self.env_content = self.env_file.read_bytes()
        self.compose_contents = [file.read_bytes() for file in self.files]
        self.compose = ["docker", "compose", "--project-name", args.project,
                        "--env-file", str(self.env_file)]
        for file in self.files:
            self.compose += ["--file", str(file)]
        self.config = json.loads(command([*self.compose, "config", "--format", "json"],
                                         operation="Resolve deployment configuration"))
        if self.env_file.read_bytes() != self.env_content or any(
            file.read_bytes() != content for file, content in zip(self.files, self.compose_contents)
        ):
            raise SnapshotError("Deployment configuration changed while resolving the snapshot")
        if not {"api", "postgres"}.issubset(self.config["services"]):
            raise SnapshotError("The deployment must contain api and postgres services")

    def run(self, *args, **kwargs):
        return command([*self.compose, *args], **kwargs)

    def containers(self):
        ids = self.run("ps", "--all", "--quiet", operation="Find deployment containers").split()
        if not ids:
            return []
        return json.loads(command(["docker", "inspect", *[id.decode() for id in ids]],
                                  operation="Inspect deployment containers"))

    def resources(self):
        containers = self.containers()
        services = {c["Config"]["Labels"]["com.docker.compose.service"]: c for c in containers}
        if "api" not in services or "postgres" not in services:
            raise SnapshotError("Create the deployment containers before taking or restoring a snapshot")
        for name, container in services.items():
            expected_env = self.config["services"][name].get("environment", {})
            actual_env = dict(item.split("=", 1) for item in container["Config"]["Env"] if "=" in item)
            if any(actual_env.get(key) != value for key, value in expected_env.items()):
                raise SnapshotError("Created containers differ from Compose configuration; reconcile them before snapshot operations")
        api = services["api"]
        data_dir = self.config["services"]["api"].get("environment", {}).get("DATA_DIR", "/data")
        expected = self.config["services"]["api"].get("environment", {})
        actual = dict(item.split("=", 1) for item in api["Config"]["Env"] if "=" in item)
        if actual.get("DATA_DIR", "/data") != data_dir or any(
            actual.get(key) != expected.get(key) for key in RUNTIME_SECRETS
        ):
            raise SnapshotError("Created API configuration differs from Compose; reconcile it before taking or restoring a snapshot")
        mounts = [mount for mount in api["Mounts"] if mount["Destination"] == data_dir]
        if len(mounts) != 1 or mounts[0]["Type"] not in ("volume", "bind"):
            raise SnapshotError("DATA_DIR must have its own persistent mount")
        if any(PurePosixPath(data_dir) in PurePosixPath(mount["Destination"]).parents for mount in api["Mounts"]):
            raise SnapshotError("Nested DATA_DIR mounts need a separate recovery plan")
        return containers, services, mounts[0], data_dir


def same_data(mount, data):
    if data.get("Name") and mount.get("Name") == data["Name"]:
        return True
    source = PurePosixPath(mount.get("Source", "/missing"))
    target = PurePosixPath(data["Source"])
    return source == target or target in source.parents or source in target.parents


def running_writers(deployment, data):
    own = {container["Id"]: container for container in deployment.containers()}
    ids = command(["docker", "ps", "--quiet"], operation="Find data writers").split()
    containers = json.loads(command(["docker", "inspect", *[id.decode() for id in ids]],
                                    operation="Inspect data writers")) if ids else []
    writers = []
    for container in containers:
        labels = container["Config"].get("Labels") or {}
        if container["Id"] in own:
            if labels.get("com.docker.compose.service") != "postgres":
                writers.append(container["Id"])
        elif any(mount.get("RW") and same_data(mount, data) for mount in container["Mounts"]):
            if labels.get("rakazo.managed") != "true":
                raise SnapshotError("An unrelated container writes to application data; stop it before continuing")
            writers.append(container["Id"])
    return writers


def helper(data, image, *args, writable=False, stdin=None, stdout=None):
    # Mount only the data root, never an API container's other host mounts.
    source = data.get("Name") if data["Type"] == "volume" else data["Source"]
    mount = f"type={data['Type']},source={source},target={data['Destination']}"
    if "," in source or "," in data["Destination"]:
        raise SnapshotError("Data mount paths containing commas are unsupported")
    if not writable:
        mount += ",readonly"
    return command(["docker", "run", "--rm", "--pull", "never", "--network", "none",
                    "--read-only", "--user", "0", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE",
                    *(["--cap-add", "CHOWN", "--cap-add", "FOWNER"] if writable else []),
                    *(["--interactive"] if stdin is not None else []), "--mount", mount,
                    "--entrypoint", args[0], image, *args[1:]],
                   operation="Read or restore application files", stdin=stdin, stdout=stdout)


def postgres(deployment, script, *, stdin=None, stdout=None):
    return deployment.run("exec", "-T", "postgres", "sh", "-c", script,
                          operation="PostgreSQL snapshot operation", stdin=stdin, stdout=stdout)


def require_exclusive_database(deployment):
    clients = postgres(deployment, 'psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                       '-c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() '
                       "AND backend_type = 'client backend' AND pid <> pg_backend_pid();\"").strip()
    if clients != b"0":
        raise SnapshotError("Other clients are connected to the database; keep external clients disconnected during recovery operations")


def wait_running(ids):
    """Wait for declared health checks; services without one must remain running."""
    deadline = time.monotonic() + 120
    ready_once = False
    while ids:
        containers = json.loads(command(["docker", "inspect", *ids], operation="Check resumed services"))
        ready = all(c["State"]["Running"] and c["State"].get("Health", {}).get("Status", "healthy") == "healthy"
                    for c in containers) and len(containers) == len(ids)
        if ready and ready_once:
            return
        ready_once = ready
        if time.monotonic() >= deadline:
            raise SnapshotError("Resumed services did not become ready")
        time.sleep(1)


@contextlib.contextmanager
def lock(deployment):
    # Serialize this tool's backup/restore calls. The updater is also stopped with
    # the other project services; operators must not run a parallel Compose deploy.
    file = deployment.env_file.parent / ".deskazo-snapshot.lock"
    descriptor = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SnapshotError("A snapshot operation is already running") from error
        yield
    finally:
        os.close(descriptor)


def backup(args):
    deployment = Deployment(args)
    with lock(deployment):
        capture(deployment, Path(args.output))
    print("Snapshot verified and services resumed. It contains secrets; store an encrypted copy off-host.")


def capture(deployment, output):
    """Capture core state while the caller holds the deployment lock."""
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise SnapshotError("Snapshot destination already exists; choose a new directory")
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=output.parent) as temporary:
        directory = Path(temporary)
        _, services, data, data_dir = deployment.resources()
        data_source = Path(data["Source"])
        if output == data_source or data_source in output.parents:
            raise SnapshotError("Store snapshots outside application data")
        if not services["postgres"]["State"]["Running"]:
            raise SnapshotError("Postgres must be running before backup")
        writers = running_writers(deployment, data)
        stopped = []
        published = False
        try:
            # Record each container before stopping it, including when Docker's
            # client fails after the daemon has already accepted the stop.
            for id in writers:
                stopped.append(id)
                command(["docker", "stop", "--time", "60", id], operation="Stop deployment writers", timeout=90)
            # A supervisor can finish creating a computer while it shuts down.
            for id in running_writers(deployment, data):
                stopped.append(id)
                command(["docker", "stop", "--time", "60", id], operation="Stop remaining data writers", timeout=90)
            if running_writers(deployment, data):
                raise SnapshotError("Data writers restarted during backup; stop parallel deployment automation")
            require_exclusive_database(deployment)
            with (directory / "database.dump").open("wb") as destination:
                postgres(deployment, 'pg_dump --format=custom --no-owner --no-privileges '
                         '--lock-wait-timeout=30000 -U "$POSTGRES_USER" "$POSTGRES_DB"', stdout=destination)
            with (directory / "appdata.tgz").open("wb") as destination:
                helper(data, services["postgres"]["Image"], "tar", "--numeric-owner", "-czf", "-", "-C", data_dir, ".", stdout=destination)
            if running_writers(deployment, data):
                raise SnapshotError("Data writers restarted during backup; snapshot discarded")
            require_exclusive_database(deployment)
            (directory / "environment.env").write_bytes(deployment.env_content)
            (directory / "compose.resolved.json").write_text(json.dumps(deployment.config, indent=2))
            for index, content in enumerate(deployment.compose_contents):
                (directory / f"compose-{index}.yml").write_bytes(content)
            manifest = {
                "version": 1,
                "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "images": {name: container["Image"] for name, container in services.items()},
                "files": {file.name: digest(file) for file in directory.iterdir()},
                "scope": "Core PostgreSQL database, DATA_DIR, environment and Compose configuration",
                "external": "Provider databases, hosted sandboxes, registry images and TLS certificates require their own recovery plan",
            }
            (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
            for file in directory.iterdir():
                file.chmod(0o600)
            verify(directory)
            with (directory / "database.dump").open("rb") as source:
                postgres(deployment, "pg_restore --list", stdin=source)
            if output.exists():
                raise SnapshotError("Snapshot destination appeared while backup was running")
            os.rename(directory, output)
            published = True
        finally:
            failures = []
            for id in stopped:
                try:
                    command(["docker", "start", id], operation="Resume stopped container", timeout=90)
                except SnapshotError:
                    failures.append(id)
            if failures:
                state = "Snapshot is valid" if published else "Backup failed"
                raise SnapshotError(f"{state}, but some stopped containers could not resume; inspect the deployment")
            try:
                wait_running(stopped)
            except SnapshotError as error:
                state = "Snapshot is valid" if published else "Backup failed"
                raise SnapshotError(f"{state}, but resumed services are not ready; inspect the deployment") from error


def restore(args):
    source = Path(args.source).resolve(strict=True)
    manifest = verify(source)
    deployment = Deployment(args)
    with lock(deployment):
        _, services, data, data_dir = deployment.resources()
        if running_writers(deployment, data):
            raise SnapshotError("Stop application services and managed computers before restore; only Postgres may run")
        if not services["postgres"]["State"]["Running"]:
            raise SnapshotError("Start only Postgres before restore")
        for name, image in manifest["images"].items():
            if name not in services or services[name]["Image"] != image:
                raise SnapshotError("Target container images differ from the snapshot; restore the same version before upgrading")
        original = json.loads((source / "compose.resolved.json").read_text())
        if deployment.env_content != (source / "environment.env").read_bytes() or original["services"] != deployment.config["services"]:
            raise SnapshotError("Runtime configuration or secrets differ from the snapshot; recover the original environment before restore")
        require_exclusive_database(deployment)
        # Require a genuinely empty target, rather than deleting live data or merging
        # old files with the snapshot. All validation runs before the first write.
        empty_query = """WITH namespaces AS (
            SELECT oid FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
        ) SELECT
            (SELECT count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM namespaces)) +
            (SELECT count(*) FROM pg_proc WHERE pronamespace IN (SELECT oid FROM namespaces)) +
            (SELECT count(*) FROM pg_type WHERE typnamespace IN (SELECT oid FROM namespaces)) +
            (SELECT count(*) FROM pg_namespace WHERE oid IN (SELECT oid FROM namespaces) AND nspname <> 'public') +
            (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') +
            (SELECT count(*) FROM pg_event_trigger) + (SELECT count(*) FROM pg_foreign_server) +
            (SELECT count(*) FROM pg_largeobject_metadata) + (SELECT count(*) FROM pg_publication);"""
        objects = postgres(deployment, 'psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                           '-c "' + empty_query + '"').strip()
        if objects != b"0":
            raise SnapshotError("Target database is not empty")
        files = helper(data, services["postgres"]["Image"], "find", data_dir, "-mindepth", "1", "-print", "-quit").strip()
        if files:
            raise SnapshotError("Target application data is not empty")
        with (source / "database.dump").open("rb") as dump:
            postgres(deployment, "pg_restore --list", stdin=dump)
        # Files first: if extraction fails the database stays empty. Any failure
        # leaves this target stopped for inspection; it is never auto-started.
        with (source / "appdata.tgz").open("rb") as archive:
            helper(data, services["postgres"]["Image"], "tar", "-xzf", "-", "-C", data_dir,
                   "--numeric-owner", "--same-owner", "--same-permissions", writable=True, stdin=archive)
        with (source / "database.dump").open("rb") as dump:
            postgres(deployment, 'pg_restore --exit-on-error --single-transaction --no-owner --no-privileges '
                     '-U "$POSTGRES_USER" -d "$POSTGRES_DB"', stdin=dump)
        print("Restore verified. Application services remain stopped. Review pending work and external providers before starting them.")


def main():
    os.umask(0o077)
    # Normal termination still resumes writers through backup's finally block.
    # SIGKILL or a lost host cannot execute cleanup; operators must restart them.
    def interrupted(_number, _frame):
        raise SnapshotError("Snapshot interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="action", required=True)
    for action in ("backup", "restore"):
        sub = subcommands.add_parser(action)
        sub.add_argument("--project", required=True, help="Exact Docker Compose project name")
        sub.add_argument("--compose", action="append", required=True, help="Compose file, repeat for overlays")
        sub.add_argument("--env-file", required=True)
        sub.add_argument("--output" if action == "backup" else "--source", required=True)
    subcommands.add_parser("verify").add_argument("source")
    args = parser.parse_args()
    try:
        if args.action == "verify":
            verify(Path(args.source))
            print("Snapshot checksums and archive paths verified.")
        elif args.action == "backup":
            backup(args)
        else:
            restore(args)
    except (SnapshotError, OSError, ValueError) as error:
        # Do not print OSError paths or raw subprocess output containing credentials.
        print(str(error) if isinstance(error, SnapshotError) else "Snapshot operation could not finish", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
