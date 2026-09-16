#!/usr/bin/env python3
"""Run on the VPS beside compose.yml. Preserve secrets and bootstrap only once."""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="/opt/convoy")
    parser.add_argument("--origin", required=True)
    parser.add_argument("--admin-email", required=True)
    args = parser.parse_args()
    origin = urlparse(args.origin)
    if origin.scheme != "https" or not origin.hostname or origin.path not in ("", "/"):
        parser.error("origin must be an HTTPS origin without a path")
    if any(c in args.origin + args.admin_email for c in "\r\n"):
        parser.error("arguments must be single-line values")
    directory = Path(args.directory).resolve()
    if not (directory / "compose.yml").is_file():
        parser.error("place the Compose definition at directory/compose.yml first")
    os.umask(0o077)
    directory.chmod(0o700)
    os.chdir(directory)

    def run(*command, capture=False):
        return subprocess.run(command, check=True, text=True, capture_output=capture)

    def compose(*command, capture=False):
        return run("docker", "compose", *command, capture=capture)

    env_file = directory / ".env"
    if not env_file.exists():
        env = {"CONVOY_ORIGIN": args.origin.rstrip("/")}
        for key in ("POSTGRES_PASSWORD", "REDIS_PASSWORD", "CONVOY_JWT_SECRET", "CONVOY_JWT_REFRESH_SECRET"):
            env[key] = secrets.token_hex(32)
        with env_file.open("x") as stream:
            stream.write("".join(f"{key}={value}\n" for key, value in env.items()))
    else:
        env = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if "=" in line)
        if env.get("CONVOY_ORIGIN") != args.origin.rstrip("/"):
            parser.error("existing origin differs; update .env deliberately before rerunning")
    env_file.chmod(0o600)
    redis_config = directory / "redis.conf"
    redis_config.write_text(
        "bind 0.0.0.0\nprotected-mode yes\ndir /data\n"
        "appendonly yes\nappendfsync always\nmaxmemory 256mb\n"
        "maxmemory-policy noeviction\nsave 900 1\n"
        f"requirepass {env['REDIS_PASSWORD']}\n"
    )
    # The official Redis container drops privileges before reading this file.
    # The parent directory remains root-only on the host.
    redis_config.chmod(0o644)
    compose("config", "--quiet")
    compose("up", "-d", "--wait", "postgres", "redis")
    compose("run", "--rm", "--no-deps", "migrate")

    credentials = directory / "admin-bootstrap.json"
    count = compose("exec", "-T", "postgres", "psql", "-U", "convoy", "-d", "convoy", "-Atc",
                    "SELECT count(*) FROM convoy.users", capture=True).stdout.strip()
    if count == "0":
        if credentials.exists():
            raise SystemExit("Saved credentials exist but database is empty; restore the database first")
        # Capture output directly to a root-only file, including on partial failure.
        with credentials.open("x") as stream:
            result = subprocess.run(
                ["docker", "compose", "run", "--rm", "--no-deps", "server", "bootstrap",
                 "--email", args.admin_email, "--first-name", "Operator", "--last-name", "Admin"],
                stdout=stream, stderr=subprocess.PIPE, text=True,
            )
        if result.returncode:
            raise SystemExit("Bootstrap failed; inspect the private admin-bootstrap.json on the VPS")
        data = json.loads(credentials.read_text())
        if not data.get("password") or not data.get("organisation_id"):
            raise SystemExit("Bootstrap output incomplete; inspect the private credentials file")
    elif not credentials.exists():
        raise SystemExit("Existing users found without saved bootstrap credentials; inspect before continuing")
    credentials.chmod(0o600)
    compose("up", "-d", "--wait", "--wait-timeout", "180", "server", "agent")
    print("Convoy started. Administrator credentials remain in admin-bootstrap.json on the VPS.")


if __name__ == "__main__":
    main()
