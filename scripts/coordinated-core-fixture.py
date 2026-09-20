"""Owned core application fixture for the coordinated OpenRAG recovery check."""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


product = module("verify-product-recovery")
snapshot = module("customer-deployment-backup")


class CoreFixture:
    def __init__(self, work, prefix, image, postgres, network, report):
        self.projects = {mode: prefix + "-core-" + mode for mode in ("source", "restored")}
        self.report = report
        self.env = work / "core.env"
        self.env.write_text("ENCRYPTION_KEY=synthetic-coordinated-core-recovery\n")
        self.config = work / "core-compose.json"
        environment = {
            "NODE_ENV": "production", "DATABASE_URL": "postgresql://example:fake-password@postgres:5432/example",
            "ENCRYPTION_KEY": "${ENCRYPTION_KEY}", "BETTER_AUTH_SECRET": "synthetic-auth-secret-for-recovery-only",
            "SCREEN_PROXY_SECRET": "synthetic-screen-secret-for-recovery-only",
            "SANDBOX_SUPERVISOR_TOKEN": "synthetic-supervisor-secret-for-recovery-only",
            "BETTER_AUTH_URL": "http://127.0.0.1:3100", "WEB_ORIGIN": "http://127.0.0.1:3100",
            "API_HOST": "0.0.0.0", "DATA_DIR": "/data", "SIGNUPS_ENABLED": "true",
        }
        shared = {"image": image, "pull_policy": "never", "environment": environment,
                  "volumes": ["appdata:/data"], "networks": ["default", "runtimes"],
                  "mem_limit": "768m", "memswap_limit": "768m", "cpus": 1, "pids_limit": 256}
        self.config.write_text(json.dumps({"services": {
            "postgres": {"image": postgres, "pull_policy": "never", "mem_limit": "256m", "memswap_limit": "256m",
                         "environment": {"POSTGRES_USER": "example", "POSTGRES_PASSWORD": "fake-password", "POSTGRES_DB": "example"},
                         "volumes": ["pgdata:/var/lib/postgresql/data"], "healthcheck": {
                             "test": ["CMD", "pg_isready", "-U", "example"], "interval": "1s", "timeout": "2s", "retries": 60}},
            "api": {**shared, "mem_limit": "1536m", "memswap_limit": "1536m",
                    "command": ["bash", "-lc", "pnpm --filter @rakazo/db exec prisma migrate deploy && pnpm --filter @rakazo/api start"],
                    "depends_on": {"postgres": {"condition": "service_healthy"}}, "healthcheck": {
                        "test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                        "interval": "2s", "timeout": "2s", "retries": 90}},
            "worker": {**shared, "command": ["pnpm", "--filter", "@rakazo/worker", "start"],
                       "depends_on": {"api": {"condition": "service_healthy"}}}},
            "volumes": {"pgdata": {}, "appdata": {}},
            "networks": {"default": {"internal": True}, "runtimes": {"external": True, "name": network}}}))
        self.cookie = None
        self.user = None

    def compose(self, mode, *args):
        result = subprocess.run(["docker", "compose", "--project-name", self.projects[mode], "--env-file", str(self.env),
                                 "-f", str(self.config), *args], capture_output=True, text=True, timeout=300)
        if result.returncode:
            (self.report / (mode + "-command-failure.log")).write_text(
                f"exit={result.returncode}\n" + result.stdout + result.stderr)
            raise RuntimeError("Disposable core command failed; inspect private command failure log")
        return result.stdout.strip()

    def args(self, mode):
        return argparse.Namespace(project=self.projects[mode], env_file=str(self.env), compose=[str(self.config)])

    def request(self, mode, endpoint, payload=None, cookie=None):
        options = {"headers": {"content-type": "application/json", "origin": "http://127.0.0.1:3100"}}
        if payload is not None:
            options.update(method="POST", body=json.dumps(payload))
        if cookie:
            options["headers"]["cookie"] = cookie
        code = "fetch(" + json.dumps("http://127.0.0.1:3100/api/auth/" + endpoint) + "," + json.dumps(options) + ").then(async r=>{if(!r.ok)throw Error('Auth status '+r.status);console.log(JSON.stringify({cookie:r.headers.get('set-cookie'),body:await r.json()}))}).catch(e=>{console.error(e);process.exitCode=1})"
        return json.loads(self.compose(mode, "exec", "-T", "api", "node", "-e", code))

    def start(self):
        self.compose("source", "up", "--detach", "--wait", "--wait-timeout", "200", "--pull", "never")
        response = self.request("source", "sign-up/email", {"email": product.EMAIL, "password": product.PASSWORD, "name": "Recovery example"})
        self.user = response["body"]["user"]["id"]
        self.cookie = response["cookie"].split(";", 1)[0]
        self.probe("source", "seed")

    def probe(self, mode, action):
        log = self.compose(mode, "exec", "-T", "api", "pnpm", "exec", "tsx", "--eval", product.PROBE, action)
        (self.report / (mode + "-core.log")).write_text(log + "\n")

    def knowledge(self, mode, state=None):
        # This checker executes inside the built application with its actual
        # Prisma client and adapters. Only seed receives runtime credentials.
        container = self.compose(mode, "ps", "--quiet", "api")
        script = Path(__file__).with_name("check-coordinated-core.mts")
        product.run(["docker", "cp", str(script), container + ":/app/scripts/check-coordinated-core.mts"])
        result = subprocess.run(["docker", "exec", "--interactive", container, "pnpm", "exec", "tsx", "scripts/check-coordinated-core.mts",
                                 "seed" if state else "check"], input=json.dumps(state or {}).encode(), capture_output=True, timeout=180)
        (self.report / (mode + "-core-knowledge.log")).write_bytes(result.stdout + result.stderr)
        assert result.returncode == 0, "Core knowledge recovery failed; inspect its private log"

    def capture(self, customers, search, output):
        args = self.args("source")
        for role, container in customers.items():
            setattr(args, role, container)
        args.search, args.output = search, str(output)
        snapshot.backup(args)
        snapshot.verify(output)
        self.compose("source", "stop")

    def restore(self, bundle):
        self.compose("restored", "create", "--pull", "never")
        self.compose("restored", "up", "--detach", "--wait", "--pull", "never", "postgres")
        args = self.args("restored")
        args.source = str(bundle / "core")
        snapshot.core.restore(args)
        assert self.compose("restored", "ps", "--services", "--status", "running").split() == ["postgres"]

    def verify(self):
        self.compose("restored", "up", "--detach", "--wait", "--wait-timeout", "200", "--pull", "never")
        assert self.request("restored", "get-session", cookie=self.cookie)["body"]["user"]["id"] == self.user
        assert self.request("restored", "sign-in/email", {"email": product.EMAIL, "password": product.PASSWORD})["body"]["user"]["id"] == self.user
        self.probe("restored", "verify")
        self.knowledge("restored")

    def cleanup(self):
        failures = []
        for mode in self.projects:
            try:
                (self.report / (mode + "-services.log")).write_text(self.compose(mode, "logs", "--no-color", "--tail", "80"))
                ids = self.compose(mode, "ps", "--all", "--quiet").split()
                if ids:
                    states = json.loads(product.run(["docker", "inspect", *ids]))
                    (self.report / (mode + "-states.json")).write_text(json.dumps(
                        [{"name": item["Name"], "state": item["State"]} for item in states], indent=2) + "\n")
            except Exception:
                failures.append(mode + " diagnostics")
            finally:
                try:
                    self.compose(mode, "down", "--volumes", "--remove-orphans")
                except Exception:
                    failures.append(mode + " cleanup")
        if failures:
            raise RuntimeError("Disposable core cleanup needs attention: " + ", ".join(failures))
