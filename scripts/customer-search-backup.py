#!/usr/bin/env python3
"""Back up managed OpenSearch indices; restore only into an isolated empty node.

Application writers must be stopped for a consistent product backup. This command
captures search data only, not the core database, Langflow or OpenRAG files/keys.
"""

import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile
import uuid

spec = importlib.util.spec_from_file_location("deployment_backup", Path(__file__).with_name("deployment-backup.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
SnapshotError = core.SnapshotError
REPOSITORIES = "/usr/share/opensearch/snapshots"
SECURITY_INDEX = ".opendistro_security"


def bootstrap_index(name):
    # OpenRAG's pinned OpenSearch image creates these before any application starts.
    # Keep the new node's audit/configuration state; retain prior versions separately.
    return name == ".opensearch-sap-log-types-config" or bool(re.fullmatch(r"security-auditlog-\d{4}\.\d{2}\.\d{2}", name))


def validate_admin_certificate(certificate, key):
    if bool(certificate) != bool(key):
        raise SnapshotError("Supply both admin certificate and key paths inside the target container")
    if certificate and any(not re.fullmatch(r"/[^\x00-\x1f\x7f]+", path) for path in (certificate, key)):
        raise SnapshotError("Admin certificate and key must be absolute container paths without control characters")


class Search:
    def __init__(self, container, admin_certificate=None, admin_key=None):
        validate_admin_certificate(admin_certificate, admin_key)
        self.admin_certificate, self.admin_key = admin_certificate, admin_key
        details = json.loads(core.command(["docker", "inspect", container], operation="Inspect search node"))[0]
        if not details["State"]["Running"]:
            raise SnapshotError("Search node must be running")
        mounts = [m for m in details["Mounts"] if m["Destination"] == REPOSITORIES]
        if len(mounts) != 1 or mounts[0]["Type"] != "volume" or not mounts[0]["RW"]:
            raise SnapshotError("Search node needs the dedicated snapshot volume from customer-openrag.yml")
        self.container = details["Id"]
        self.image = details["Image"]
        self.data = mounts[0]
        self.isolated = details["HostConfig"]["NetworkMode"] == "none" and not details["HostConfig"]["PortBindings"]

    def request(self, method, path, body=None):
        # Credentials stay inside the selected container, in curl's stdin config.
        # TLS verification is skipped only for this container's loopback endpoint.
        script = r'''
set -eu
method=$1
request_path=$2
body=$3
configuration=
if [ -n "$4" ]; then
  test -r "$4" && test -r "$5"
  set -- --cert "$4" --key "$5"
else
  password=${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-${OPENSEARCH_PASSWORD:-}}
  test -n "$password"
  authorization=$(printf '%s' "admin:$password" | base64 | tr -d '\n')
  configuration=$(printf 'header = "Authorization: Basic %s"\n' "$authorization")
  set -- --config -
fi
printf '%s\n' "$configuration" |
  curl --silent --show-error --fail --insecure --noproxy '*' --max-time 240 \
    "$@" --request "$method" --header 'content-type: application/json' \
    --data-binary "$body" "https://127.0.0.1:9200$request_path"
'''
        value = core.command(["docker", "exec", self.container, "sh", "-c", script,
                              "search-backup", method, path, json.dumps(body) if body is not None else "",
                              self.admin_certificate or "", self.admin_key or ""],
                             operation="OpenSearch snapshot request", timeout=250)
        try:
            return json.loads(value)
        except (ValueError, TypeError) as error:
            raise SnapshotError("OpenSearch returned an invalid response") from error

    def indices(self):
        rows = self.request("GET", "/_cat/indices?format=json&expand_wildcards=all&h=index")
        return sorted(row["index"] for row in rows if row["index"] != SECURITY_INDEX)

    def directory(self, repository):
        if not re.fullmatch(r"deskazo-[a-f0-9]{32}", repository):
            raise SnapshotError("Invalid snapshot repository identity")
        return REPOSITORIES + "/" + repository

    def prepare(self, repository):
        directory = self.directory(repository)
        # The Docker-created volume root may be root-owned. Own only this new
        # directory, never recursively change an existing repository or data volume.
        uid = core.command(["docker", "exec", self.container, "id", "-u"], operation="Read search user").strip()
        gid = core.command(["docker", "exec", self.container, "id", "-g"], operation="Read search group").strip()
        if not uid.isdigit() or not gid.isdigit():
            raise SnapshotError("Search user identity is unavailable")
        core.helper(self.data, self.image, "mkdir", "-m", "700", directory, writable=True)
        core.helper(self.data, self.image, "chown", uid.decode() + ":" + gid.decode(), directory, writable=True)
        return directory

    def register(self, repository, readonly=False):
        result = self.request("PUT", "/_snapshot/" + repository, {
            "type": "fs", "settings": {"location": self.directory(repository), "readonly": readonly},
        })
        if result.get("acknowledged") is not True:
            raise SnapshotError("Snapshot repository registration was not confirmed")

    def unregister(self, repository):
        if self.request("DELETE", "/_snapshot/" + repository).get("acknowledged") is not True:
            raise SnapshotError("Snapshot repository removal was not confirmed")


def completed(value, expected_indices=None):
    if (not isinstance(value, dict) or value.get("state") != "SUCCESS"
            or value.get("snapshot") != "state"
            or not isinstance(value.get("uuid"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value["uuid"])
            or value.get("include_global_state") is not False
            or not isinstance(value.get("indices"), list)
            or any(not isinstance(name, str) or not name or name.startswith("-")
                   or any(character in name for character in ",/*?\x00") for name in value["indices"])
            or len(set(value["indices"])) != len(value["indices"])
            or SECURITY_INDEX in value["indices"]
            or value.get("failures") or not isinstance(value.get("shards"), dict)):
        raise SnapshotError("Search snapshot is incomplete or includes security state")
    shards = value["shards"]
    if (any(type(shards.get(key)) is not int or shards[key] < 0 for key in ("failed", "successful", "total"))
            or shards["failed"] != 0 or shards["successful"] != shards["total"]):
        raise SnapshotError("Search snapshot has incomplete shard coverage")
    if expected_indices is not None and sorted(value["indices"]) != expected_indices:
        raise SnapshotError("Search snapshot index coverage changed")
    return value


def verify(source):
    try:
        manifest = json.loads((source / "manifest.json").read_text())
        if (manifest.get("format") != "deskazo-search-1"
                or not re.fullmatch(r"deskazo-[a-f0-9]{32}", manifest["repository"])
                or not isinstance(manifest["image"], str)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", manifest["image"])
                or not isinstance(manifest["serverVersion"], str) or not manifest["serverVersion"]):
            raise SnapshotError("Invalid search snapshot metadata")
        completed(manifest["snapshot"])
        archive = source / "repository.tgz"
        if archive.is_symlink() or not archive.is_file() or core.digest(archive) != manifest["archiveSha256"]:
            raise SnapshotError("Search snapshot checksum verification failed")
        core.archive_paths(archive)
        with tarfile.open(archive, "r:gz") as entries:
            if any(not (entry.isfile() or entry.isdir()) for entry in entries):
                raise SnapshotError("Search snapshot archive must contain only files and directories")
        return manifest
    except (OSError, ValueError, TypeError, KeyError, AttributeError, tarfile.TarError) as error:
        raise SnapshotError("Search snapshot is incomplete or unreadable") from error


def backup(container, output):
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise SnapshotError("Snapshot destination already exists")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    search = Search(container)
    repository = "deskazo-" + uuid.uuid4().hex
    indices = search.indices()
    version = search.request("GET", "/")["version"]["number"]
    directory = search.prepare(repository)
    search.register(repository)
    # A failed/uncertain request retains its source repository for operator inspection.
    result = search.request("PUT", f"/_snapshot/{repository}/state?wait_for_completion=true", {
        "indices": ",".join(indices) if indices else "-*", "ignore_unavailable": False,
        "include_global_state": False, "partial": False,
    })
    snapshot = completed(result.get("snapshot"), indices)
    if search.indices() != indices:
        raise SnapshotError("Search indices changed during backup; stop writers and retry")
    search.unregister(repository)
    with tempfile.TemporaryDirectory(prefix=".search-snapshot-", dir=output.parent) as temporary:
        staging = Path(temporary)
        archive = staging / "repository.tgz"
        with archive.open("wb") as file:
            core.helper(search.data, search.image, "tar", "--numeric-owner", "-czf", "-", "-C", directory, ".", stdout=file)
        manifest = {"format": "deskazo-search-1", "repository": repository, "image": search.image,
                    "serverVersion": version, "snapshot": snapshot, "archiveSha256": core.digest(archive),
                    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        for file in staging.iterdir():
            file.chmod(0o600)
        verify(staging)
        if output.exists():
            raise SnapshotError("Snapshot destination appeared during backup")
        os.rename(staging, output)
    # Registration is removed before archiving. This unique directory is no longer
    # writable through OpenSearch and the verified portable artifact now owns it.
    core.helper(search.data, search.image, "rm", "-rf", "--", directory, writable=True)


def restore(container, source, *, admin_certificate=None, admin_key=None):
    validate_admin_certificate(admin_certificate, admin_key)
    manifest = verify(source)
    search = Search(container, admin_certificate, admin_key)
    if not search.isolated:
        raise SnapshotError("Restore requires a node with Docker networking disabled and no published ports")
    if search.image != manifest["image"] or search.request("GET", "/")["version"]["number"] != manifest["serverVersion"]:
        raise SnapshotError("Restore requires the original search image and version")
    existing = search.indices()
    if any(not bootstrap_index(name) for name in existing):
        raise SnapshotError("Restore requires an empty search node; existing indices are never removed")
    repository = manifest["repository"]
    directory = search.prepare(repository)
    with (source / "repository.tgz").open("rb") as file:
        core.helper(search.data, search.image, "tar", "-xzf", "-", "-C", directory,
                    "--numeric-owner", "--same-owner", "--same-permissions", writable=True, stdin=file)
    search.register(repository, readonly=True)
    snapshots = search.request("GET", f"/_snapshot/{repository}/state")["snapshots"]
    if len(snapshots) != 1:
        raise SnapshotError("Search repository has unexpected snapshot metadata")
    indices = sorted(manifest["snapshot"]["indices"])
    actual = completed(snapshots[0], indices)
    if actual["uuid"] != manifest["snapshot"]["uuid"]:
        raise SnapshotError("Search snapshot identity does not match its manifest")
    application = [name for name in indices if not bootstrap_index(name)]
    history = [name for name in indices if bootstrap_index(name)]
    history_prefix = "deskazo-restored-" + manifest["snapshot"]["uuid"].lower() + "-"
    for names, aliases, rename in [(application, True, {}), (history, False, {
            "rename_pattern": "^(.+)$", "rename_replacement": history_prefix + "$1"})]:
        if not names:
            continue
        result = search.request("POST", f"/_snapshot/{repository}/state/_restore?wait_for_completion=true", {
            "indices": ",".join(names), "include_global_state": False,
            "include_aliases": aliases, "ignore_unavailable": False, "partial": False, **rename,
        })
        shards = result.get("snapshot", {}).get("shards", {})
        if shards.get("failed") != 0 or shards.get("successful") != shards.get("total"):
            raise SnapshotError("Search restoration did not complete; keep this target isolated")
    expected = sorted(set(existing + application + [history_prefix + name for name in history]))
    if search.indices() != expected:
        raise SnapshotError("Restored search indices do not match the snapshot")
    search.unregister(repository)
    core.helper(search.data, search.image, "rm", "-rf", "--", directory, writable=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("backup", "restore", "verify"):
        item = commands.add_parser(action)
        if action != "verify":
            item.add_argument("--container", required=True)
        item.add_argument("--output" if action == "backup" else "--source", type=Path, required=True)
        if action == "restore":
            item.add_argument("--admin-certificate", help="Admin TLS certificate path inside the isolated target container")
            item.add_argument("--admin-key", help="Matching private key path inside the isolated target container")
    args = parser.parse_args()
    try:
        if args.action == "backup":
            backup(args.container, args.output)
        elif args.action == "restore":
            restore(args.container, args.source, admin_certificate=args.admin_certificate, admin_key=args.admin_key)
        else:
            verify(args.source)
    except SnapshotError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("Search snapshot verified." if args.action != "restore" else "Search data restored; prior audit/configuration indices retained under deskazo-restored-*. Keep the node isolated until the full deployment is reviewed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
