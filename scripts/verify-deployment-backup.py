#!/usr/bin/env python3
"""Exercise snapshot recovery using only disposable Compose projects and fake data.

Requires a locally cached PostgreSQL image. No published ports or real .env files.
Optional systemd verification requires Linux containers with private cgroup support
and access to the local Docker socket. It never installs units on the host.
"""

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


IDLE = ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done"]
CLI = Path(__file__).with_name("deployment-backup.py")
ROOT = CLI.parent.parent


def run(args, *, input=None, expected=None):
    result = subprocess.run(args, input=input, capture_output=True, text=True, timeout=180)
    if expected is not None:
        assert result.returncode != 0 and expected in result.stderr, (result.returncode, result.stderr)
    elif result.returncode:
        raise RuntimeError(f"Disposable recovery command failed: {result.stderr}")
    return result.stdout.strip()


def scheduled_backup(image, project, compose_file, env, snapshot):
    """Run the installed unit in a disposable systemd container against this fixture only.

    The container needs a private writable cgroup namespace and Docker socket access.
    docker.service checks the external daemon; this does not test daemon boot/recovery.
    No host checkout, environment file, backup directory or systemd unit is mounted.
    """
    name = f"{project}-scheduler"
    unit = "rakazo-backup.service"
    timer = "rakazo-backup.timer"

    def execute(*args, **kwargs):
        return run(["docker", "exec", name, *args], **kwargs)

    def install(source, destination):
        run(["docker", "cp", str(source), f"{name}:{destination}"])

    def write(destination, content):
        execute("python3", "-c", "from pathlib import Path; import sys; "
                "p=Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True); "
                "p.write_text(sys.argv[2]); p.chmod(0o600)", destination, content)

    def properties(service):
        return dict(line.split("=", 1) for line in execute(
            "systemctl", "show", service, "-p", "Result,ActiveState,ExecMainStartTimestampMonotonic,ExecMainStatus"
        ).splitlines())

    def wait_ready():
        deadline = time.monotonic() + 30
        while True:
            ready = subprocess.run(["docker", "exec", name, "systemctl", "show", "--property=SystemState"],
                                   capture_output=True, text=True, timeout=5)
            if ready.returncode == 0:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("Disposable systemd did not start: " + run(["docker", "logs", name]))
            time.sleep(0.25)

    def wait_backup(previous="0"):
        deadline = time.monotonic() + 60
        while True:
            state = properties(unit)
            if state["ExecMainStartTimestampMonotonic"] != previous and state["ActiveState"] in ("inactive", "failed"):
                assert state["Result"] == "success", execute("journalctl", "-u", unit, "--no-pager")
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("Calendar timer did not complete: " + execute("journalctl", "-u", unit, "--no-pager"))
            time.sleep(0.25)

    def snapshots():
        return set(execute("find", "/var/backups/rakazo", "-mindepth", "1", "-maxdepth", "1", "-type", "d").splitlines())

    try:
        run(["docker", "run", "-d", "--name", name, "--pull", "never", "--privileged",
             "--cgroupns=private", "--network=none", "--tmpfs", "/run", "--tmpfs", "/run/lock",
             "--tmpfs", "/tmp", "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock", image])
        wait_ready()
        assert execute("docker", "info", "--format", "{{.ID}}") == run(["docker", "info", "--format", "{{.ID}}"])
        execute("mkdir", "-p", "/srv/rakazo/scripts", "/srv/rakazo/infra/compose", "/var/backups", "/etc/rakazo")
        install(CLI, "/srv/rakazo/scripts/deployment-backup.py")
        install(compose_file, "/srv/rakazo/infra/compose/docker-compose.prod.yml")
        install(env, "/srv/rakazo/.env")
        install(ROOT / "infra/compose/backup-prod.sh", "/usr/local/sbin/rakazo-backup")
        execute("chmod", "755", "/usr/local/sbin/rakazo-backup")
        for filename in (unit, timer):
            install(ROOT / "infra/systemd" / filename, f"/etc/systemd/system/{filename}")
        write("/etc/systemd/system/docker.service", "[Service]\nType=oneshot\n"
              "ExecStart=/usr/local/bin/docker info\nRemainAfterExit=yes\n")
        write("/etc/rakazo/backup.env", f"COMPOSE_PROJECT_NAME={project}\n")
        execute("systemctl", "daemon-reload")
        execute("systemd-analyze", "verify", unit, timer)
        execute("systemctl", "enable", timer)
        assert execute("systemctl", "is-enabled", timer) == "enabled"
        assert "02:15:00" in execute("systemctl", "show", timer, "-p", "TimersCalendar")
        assert execute("systemctl", "show", timer, "-p", "Persistent", "--value") == "yes"
        assert execute("systemctl", "show", timer, "-p", "RandomizedDelayUSec", "--value") == "15min"
        execute("systemctl", "start", unit)
        assert properties(unit)["Result"] == "success"
        print("PASS: installed Linux service, default checkout, and production timer configuration", flush=True)

        # The documented custom path must fail closed without its writable override.
        custom = "/opt/example deployment"
        execute("cp", "-a", "/srv/rakazo", custom)
        write("/etc/rakazo/backup.env", f'COMPOSE_PROJECT_NAME={project}\nRAKAZO_DEPLOY_DIR="{custom}"\n')
        sentinel = "/var/backups/rakazo/20000101T000000Z/manifest.json"
        write(sentinel, "retain failed backup sentinel")
        execute("touch", "-d", "2000-01-01 UTC", "/var/backups/rakazo/20000101T000000Z")
        before = execute("find", "/var/backups/rakazo", "-name", "manifest.json")
        execute("systemctl", "start", unit, expected="failed")
        assert properties(unit)["Result"] == "exit-code"
        assert execute("find", "/var/backups/rakazo", "-name", "manifest.json") == before
        assert execute("cat", sentinel) == "retain failed backup sentinel"
        print("PASS: read-only custom checkout fails visibly and retains existing snapshots", flush=True)

        write(f"/etc/systemd/system/{unit}.d/checkout.conf", f'[Service]\nReadWritePaths="{custom}"\n')
        # Accelerate only the schedule. The shipped service, wrapper and CLI stay intact.
        trigger = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=8)
        write(f"/etc/systemd/system/{timer}.d/test-time.conf", "[Timer]\nOnCalendar=\nOnCalendar="
              + trigger.strftime("%Y-%m-%d %H:%M:%S UTC") + "\nRandomizedDelaySec=0\nAccuracySec=100ms\n")
        execute("systemctl", "daemon-reload")
        execute("systemctl", "reset-failed", unit)
        previous = properties(unit)["ExecMainStartTimestampMonotonic"]
        execute("systemctl", "start", timer)
        wait_backup(previous)
        execute("systemctl", "stop", timer)
        execute("test", "!", "-e", sentinel)
        before_restart = snapshots()
        assert len(before_restart) == 2
        scheduled = sorted(before_restart)[-1]
        execute("python3", f"{custom}/scripts/deployment-backup.py", "verify", scheduled)
        print("PASS: real calendar timer, custom checkout override, success-only rotation and verified snapshot", flush=True)

        # Preserve the actual timer stamp and root filesystem across PID 1 restarts.
        # Only the calendar/delay are overridden; no clock or stamp is fabricated.
        trigger = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=15)
        write(f"/etc/systemd/system/{timer}.d/test-time.conf", "[Timer]\nOnCalendar=\nOnCalendar="
              + trigger.strftime("%Y-%m-%d %H:%M:%S UTC") + "\nRandomizedDelaySec=0\nAccuracySec=100ms\n")
        execute("systemctl", "daemon-reload")
        execute("systemctl", "start", timer)
        run(["docker", "stop", "--time", "5", name])
        assert datetime.datetime.now(datetime.timezone.utc) < trigger, "Scheduler did not stop before the missed event"
        assert run(["docker", "inspect", name, "--format", "{{.State.Running}}"] ) == "false"
        remaining = (trigger - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        time.sleep(max(0, remaining) + 1)
        run(["docker", "start", name])
        wait_ready()
        wait_backup()
        recovered = snapshots() - before_restart
        assert len(recovered) == 1, "Missed event must create exactly one snapshot"
        scheduled = recovered.pop()
        execute("python3", f"{custom}/scripts/deployment-backup.py", "verify", scheduled)
        trigger_receipt = execute("systemctl", "show", timer, "-p", "LastTriggerUSec", "--value")
        assert trigger_receipt
        print("PASS: enabled persistent timer catches one missed event after scheduler restart", flush=True)

        # The same one-shot calendar is now consumed. A second boot must not replay it.
        run(["docker", "stop", "--time", "5", name])
        run(["docker", "start", name])
        wait_ready()
        execute("systemctl", "start", timer)
        time.sleep(2)
        assert execute("systemctl", "show", timer, "-p", "LastTriggerUSec", "--value") == trigger_receipt
        assert properties(unit)["ExecMainStartTimestampMonotonic"] == "0"
        assert snapshots() == before_restart | {scheduled}
        run(["docker", "cp", f"{name}:{scheduled}", str(snapshot)])
        print("PASS: another scheduler restart does not repeat the consumed backup; recovered snapshot selected for restore", flush=True)
    finally:
        run(["docker", "rm", "-f", name])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-image", default="postgres:16", help="Cached PostgreSQL 16 image")
    parser.add_argument("--systemd-image", help="Cached verification.Dockerfile image; runs a privileged disposable systemd container")
    args = parser.parse_args()
    if args.systemd_image:
        args.systemd_image = run(["docker", "image", "inspect", args.systemd_image, "--format", "{{.Id}}"])
    # Resolve the cached image before creating anything. The fixture never pulls.
    image = run(["docker", "image", "inspect", args.postgres_image, "--format", "{{.Id}}"])
    with tempfile.TemporaryDirectory(prefix="deskazo-recovery-") as temporary:
        root = Path(temporary)
        compose_file = root / "compose.json"
        environment = {"DATA_DIR": "/data", "ENCRYPTION_KEY": "${ENCRYPTION_KEY}",
                       "BETTER_AUTH_SECRET": "fake-auth-secret", "SCREEN_PROXY_SECRET": "fake-screen-secret",
                       "SANDBOX_SUPERVISOR_TOKEN": "fake-supervisor-token"}
        compose_file.write_text(json.dumps({
            "services": {
                "postgres": {"image": image, "pull_policy": "never",
                             "environment": {"POSTGRES_USER": "example", "POSTGRES_PASSWORD": "fake-password", "POSTGRES_DB": "example"},
                             "volumes": ["pgdata:/var/lib/postgresql/data"],
                             "healthcheck": {"test": ["CMD", "pg_isready", "-U", "example"], "interval": "1s", "timeout": "1s", "retries": 40}},
                "api": {"image": image, "pull_policy": "never", "command": IDLE,
                        "environment": environment, "volumes": ["appdata:/data"]},
                "worker": {"image": image, "pull_policy": "never", "command": IDLE, "volumes": ["appdata:/data"]},
            }, "volumes": {"pgdata": {}, "appdata": {}}
        }))
        env = root / ".env"
        env.write_text("ENCRYPTION_KEY=synthetic-key-retained-through-recovery\n")
        prefix = f"deskazo-recovery-{uuid.uuid4().hex[:12]}"
        projects = [f"{prefix}-source", f"{prefix}-target"]
        extra_containers = []

        def compose(project, *args, **kwargs):
            return run(["docker", "compose", "-p", project, "--env-file", str(env), "-f", str(compose_file), *args], **kwargs)

        def cli(project, action, *args, **kwargs):
            return run([sys.executable, str(CLI), action, "--project", project, "--env-file", str(env),
                        "--compose", str(compose_file), *args], **kwargs)

        def sql(project, statement):
            return compose(project, "exec", "-T", "postgres", "psql", "-XAt", "-v", "ON_ERROR_STOP=1",
                           "-U", "example", "-d", "example", "-c", statement)

        def running(project):
            return set(compose(project, "ps", "--services", "--status", "running").split())

        source, target = projects
        try:
            compose(source, "up", "-d", "--wait", "--pull", "never")
            compose(source, "stop", "worker")
            sql(source, "CREATE TABLE accounts(id integer PRIMARY KEY, name text, sealed_secret text); "
                        "INSERT INTO accounts VALUES (1, 'Example account', 'fake-sealed-secret');")
            compose(source, "exec", "-T", "api", "sh", "-c",
                    "mkdir -p /data/home; printf 'private memory\n' > /data/home/memory; "
                    "printf 'root-owned synthetic token\n' > /data/home/root-token; "
                    "chmod 600 /data/home/*; chown 1000:1000 /data/home/memory; "
                    "ln /data/home/memory /data/home/memory-copy; ln -s /tmp/example-browser /data/home/SingletonSocket")
            api_id = compose(source, "ps", "-q", "api")
            data = next(mount for mount in json.loads(run(["docker", "inspect", api_id]))[0]["Mounts"] if mount["Destination"] == "/data")
            # A computer outside Compose writes the same volume and must be paused too.
            computer = run(["docker", "run", "-d", "--pull", "never", "--network", "none", "--label", "rakazo.managed=true",
                            "--mount", f"type=volume,source={data['Name']},target=/home/rakazo", image, *IDLE])
            extra_containers.append(computer)
            # An unrelated container with access must cause rejection before any stop.
            unrelated = run(["docker", "run", "-d", "--pull", "never", "--network", "none",
                             "--mount", f"type=volume,source={data['Name']},target=/data", image, *IDLE])
            extra_containers.append(unrelated)
            cli(source, "backup", "--output", str(root / "rejected"), expected="unrelated container")
            assert running(source) == {"postgres", "api"}
            run(["docker", "rm", "-f", unrelated])
            extra_containers.remove(unrelated)
            print("PASS: unrelated writers rejected before stopping the deployment", flush=True)

            # Changed secrets on disk must not silently produce an unusable backup.
            env.write_text("ENCRYPTION_KEY=wrong-key\n")
            cli(source, "backup", "--output", str(root / "drift"), expected="differ")
            env.write_text("ENCRYPTION_KEY=synthetic-key-retained-through-recovery\n")
            snapshot = root / "snapshot"
            if args.systemd_image:
                scheduled_backup(args.systemd_image, source, compose_file, env, snapshot)
            else:
                cli(source, "backup", "--output", str(snapshot))
            assert running(source) == {"postgres", "api"}, "Previously stopped worker must remain stopped"
            assert run(["docker", "inspect", computer, "--format", "{{.State.Running}}"] ) == "true"
            assert snapshot.stat().st_mode & 0o777 == 0o700
            assert all(file.stat().st_mode & 0o777 == 0o600 for file in snapshot.iterdir())
            print("PASS: quiesced snapshot, private files, runtime configuration, and writer resumption", flush=True)
            moved = root / "moved-snapshot"
            snapshot.rename(moved)
            run([sys.executable, str(CLI), "verify", str(moved)])

            # Target containers are created but never started, except PostgreSQL.
            compose(target, "create", "--pull", "never")
            compose(target, "up", "-d", "--wait", "--pull", "never", "postgres")
            sql(target, "CREATE TABLE sentinel(value text); INSERT INTO sentinel VALUES ('keep me');")
            cli(target, "restore", "--source", str(moved), expected="database is not empty")
            assert sql(target, "SELECT value FROM sentinel") == "keep me"
            sql(target, "DROP TABLE sentinel")
            sql(target, "CREATE FUNCTION sentinel() RETURNS integer LANGUAGE SQL AS 'SELECT 1';")
            cli(target, "restore", "--source", str(moved), expected="database is not empty")
            assert sql(target, "SELECT sentinel()") == "1"
            sql(target, "DROP FUNCTION sentinel()")
            sql(target, "CREATE SCHEMA pgexample")
            cli(target, "restore", "--source", str(moved), expected="database is not empty")
            sql(target, "DROP SCHEMA pgexample")
            damaged = root / "damaged"
            shutil.copytree(moved, damaged)
            (damaged / "database.dump").write_bytes(b"corrupt")
            cli(target, "restore", "--source", str(damaged), expected="checksum")
            assert sql(target, "SELECT count(*) FROM pg_tables WHERE schemaname='public'") == "0"
            wrong_image = root / "wrong-image"
            shutil.copytree(moved, wrong_image)
            metadata = json.loads((wrong_image / "manifest.json").read_text())
            metadata["images"]["api"] = "sha256:wrong-version"
            (wrong_image / "manifest.json").write_text(json.dumps(metadata))
            cli(target, "restore", "--source", str(wrong_image), expected="images differ")
            target_api = compose(target, "ps", "--all", "-q", "api")
            target_data = next(mount for mount in json.loads(run(["docker", "inspect", target_api]))[0]["Mounts"] if mount["Destination"] == "/data")

            def target_files(script):
                return run(["docker", "run", "--rm", "--pull", "never", "--network", "none",
                            "--mount", f"type=volume,source={target_data['Name']},target=/data", image, "sh", "-c", script])

            target_files("printf 'keep me' > /data/sentinel")
            cli(target, "restore", "--source", str(moved), expected="application data is not empty")
            assert target_files("cat /data/sentinel") == "keep me"
            target_files("rm /data/sentinel")
            print("PASS: nonempty and corrupt restores rejected without target changes", flush=True)

            original_compose = compose_file.read_text()
            changed = json.loads(original_compose)
            changed["services"]["api"]["command"] = ["sleep", "infinity"]
            compose_file.write_text(json.dumps(changed))
            cli(target, "restore", "--source", str(moved), expected="configuration or secrets differ")
            compose_file.write_text(original_compose)

            env.write_text("ENCRYPTION_KEY=wrong-key\n")
            compose(target, "create", "--force-recreate", "--pull", "never", "api")
            cli(target, "restore", "--source", str(moved), expected="secrets differ")
            env.write_text("ENCRYPTION_KEY=synthetic-key-retained-through-recovery\n")
            compose(target, "create", "--force-recreate", "--pull", "never", "api")

            # A truncated custom dump can have an intact TOC. Its data restore
            # must roll back SQL and leave the partially restored target stopped.
            partial = root / "partial"
            shutil.copytree(moved, partial)
            dump = partial / "database.dump"
            dump.write_bytes(dump.read_bytes()[:-64])
            metadata = json.loads((partial / "manifest.json").read_text())
            metadata["files"][dump.name] = hashlib.sha256(dump.read_bytes()).hexdigest()
            (partial / "manifest.json").write_text(json.dumps(metadata))
            cli(target, "restore", "--source", str(partial), expected="PostgreSQL snapshot operation failed")
            assert running(target) == {"postgres"}
            assert sql(target, "SELECT count(*) FROM pg_tables WHERE schemaname='public'") == "0"
            assert target_files("cat /data/home/memory") == "private memory"
            cli(target, "restore", "--source", str(moved), expected="application data is not empty")
            compose(target, "down", "--volumes", "--remove-orphans")
            compose(target, "create", "--pull", "never")
            compose(target, "up", "-d", "--wait", "--pull", "never", "postgres")
            print("PASS: failed SQL restore rolls back and keeps a partial target stopped; recovery uses fresh volumes", flush=True)
            cli(target, "restore", "--source", str(moved))
            assert running(target) == {"postgres"}, "Restore must not replay external work"
            assert sql(target, "SELECT id || ':' || name || ':' || sealed_secret FROM accounts") == "1:Example account:fake-sealed-secret"
            compose(target, "start", "api")
            assert compose(target, "exec", "-T", "--user", "1000", "api", "cat", "/data/home/memory") == "private memory"
            assert compose(target, "exec", "-T", "api", "stat", "-c", "%u:%g:%a", "/data/home/memory", "/data/home/root-token") == "1000:1000:600\n0:0:600"
            assert compose(target, "exec", "-T", "api", "cat", "/data/home/root-token") == "root-owned synthetic token"
            assert compose(target, "exec", "-T", "api", "readlink", "/data/home/SingletonSocket") == "/tmp/example-browser"
            inodes = compose(target, "exec", "-T", "api", "stat", "-c", "%i", "/data/home/memory", "/data/home/memory-copy").splitlines()
            assert len(set(inodes)) == 1
            assert sql(source, "SELECT count(*) FROM accounts") == "1"
            print("PASS: database, private files, owners, modes and links recovered; application start stays manual", flush=True)
        finally:
            failures = []
            for container in extra_containers:
                try:
                    run(["docker", "rm", "-f", container])
                except Exception:
                    failures.append("computer cleanup")
            for project in projects:
                try:
                    compose(project, "down", "--volumes", "--remove-orphans")
                except Exception:
                    failures.append("project cleanup")
            if failures:
                raise RuntimeError("Disposable recovery cleanup failed: " + ", ".join(failures))
    print("Disposable core-deployment recovery checks passed.")


if __name__ == "__main__":
    main()
