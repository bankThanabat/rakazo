#!/usr/bin/env python3
"""Prove update failure and snapshot recovery in disposable, offline stacks.

Build the current application first:
  docker build -f infra/compose/Dockerfile -t rakazo/v1-recovery-check:local .
Then run this script. Images must already be cached. No host ports or credentials
are used. By default this proves manual snapshot recovery. With --updater-image,
it also exercises migration-aware image fallback through that cached updater.
It does not prove compatibility between arbitrary published releases.
Use --previous-image to first migrate real saved data from a specific cached
earlier release into --image, then exercise the existing failure/restore checks.
"""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

CLI = Path(__file__).with_name("deployment-backup.py")
EMAIL = "recovery@example.test"
PASSWORD = "synthetic-recovery-password-000000"
MIGRATION = "99991231235959_recovery_failure_fixture"


def run(args, *, expected_failure=False, timeout=240):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if expected_failure:
        assert result.returncode != 0, "Expected the injected migration to fail"
    elif result.returncode:
        raise RuntimeError(f"Disposable product recovery failed: {result.stderr[-4000:]}")
    return result.stdout.strip()


# Executed by the actual image's tsx and Prisma client, not host dependencies.
PROBE = r'''
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createDb } from './packages/db/src/client.ts';
import { EncryptedSecretStore } from './packages/adapters/src/secrets.ts';
(async () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL);
  try {
    const user = await prisma.user.findUniqueOrThrow({where:{email:'recovery@example.test'}});
    assert.equal(user.name, 'Recovery example');
    const store = new EncryptedSecretStore(process.env.ENCRYPTION_KEY);
    const id = 'recovery-example-secret';
    const plaintext = 'synthetic-provider-credential-never-sent';
    if (process.argv[1] === 'seed') {
      const space = await prisma.spaceMember.findFirstOrThrow({where:{userId:user.id}});
      await prisma.secret.create({data:{id,userId:user.id,kind:'model',ciphertext:store.seal(plaintext,id)}});
      await prisma.userModelCredential.create({data:{id:'recovery-example-model',userId:user.id,provider:'openai',label:'Recovery fixture',secretId:id}});
      await prisma.bot.create({data:{id:'recovery-example-bot',spaceId:space.spaceId,userId:user.id,name:'Recovery example',color:'blue',instructions:'Keep customer facts private.',thread:{create:{id:'recovery-example-thread',spaceId:space.spaceId,userId:user.id,nextMessageSeq:1,messages:{create:{seq:0,role:'user',blocks:[{type:'text',text:'Synthetic conversation retained.'}]}}}}}});
      await writeFile('/data/recovery-example.txt','Synthetic private file retained.',{mode:0o600});
    }
    const credential = await prisma.userModelCredential.findUniqueOrThrow({where:{id:'recovery-example-model'}});
    assert.equal(credential.secretId,id);
    const secret = await prisma.secret.findUniqueOrThrow({where:{id}});
    assert.notEqual(secret.ciphertext,plaintext);
    assert.equal(store.load(secret.ciphertext,id),plaintext);
    const bot = await prisma.bot.findUniqueOrThrow({where:{id:'recovery-example-bot'},include:{thread:{include:{messages:true}}}});
    assert.equal(bot.instructions,'Keep customer facts private.');
    assert.deepEqual(bot.thread.messages.map(m=>m.blocks),[[{type:'text',text:'Synthetic conversation retained.'}]]);
    assert.equal(await readFile('/data/recovery-example.txt','utf8'),'Synthetic private file retained.');
    const failures = await prisma.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
    assert.equal(failures.length,0);
    console.log('PASS: saved credential decrypts; bot, conversation, file and migration state checked (' + process.argv[1] + ')');
  } finally { await prisma.$disconnect(); await pool.end(); }
})().catch(e=>{console.error(e);process.exitCode=1});
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="rakazo/v1-recovery-check:local")
    parser.add_argument("--postgres-image", default="postgres:16")
    parser.add_argument("--previous-image", help="Cached earlier application image to verify before upgrading to --image")
    parser.add_argument("--updater-image", help="Also exercise the cached updater image against the failing update")
    parser.add_argument("--failure", choices=["failed-migration", "completed-migration", "startup-only"], default="failed-migration")
    args = parser.parse_args()
    if args.failure == "startup-only" and not args.updater_image:
        parser.error("startup-only requires --updater-image")
    if args.previous_image and args.updater_image:
        parser.error("previous-image verifies a direct upgrade; run updater fault checks separately")
    image = run(["docker", "image", "inspect", args.image, "--format", "{{.Id}}"])
    previous = run(["docker", "image", "inspect", args.previous_image, "--format", "{{.Id}}"] ) if args.previous_image else None
    if previous:
        assert previous != image, "Earlier and candidate images must differ"
    postgres = run(["docker", "image", "inspect", args.postgres_image, "--format", "{{.Id}}"])
    updater = run(["docker", "image", "inspect", args.updater_image, "--format", "{{.Id}}"] ) if args.updater_image else None
    if updater:
        assert json.loads(run(["docker", "image", "inspect", args.image]))[0]["RepoTags"], "Updater fixture requires a tagged base image to preserve it during alias cleanup"
    prefix = f"deskazo-product-recovery-{uuid.uuid4().hex[:12]}"
    source, target = f"{prefix}-source", f"{prefix}-target"
    broken_tag = f"{prefix}:sha-{'2' * 40}"
    baseline_tag = f"{prefix}:baseline"
    baseline_tagged = False
    fixture_container = f"{prefix}-fault-image"
    fixture_created = False
    with tempfile.TemporaryDirectory(prefix="deskazo-product-recovery-") as directory:
        root = Path(directory)
        env = root / ".env"
        env.write_text("ENCRYPTION_KEY=synthetic-encryption-key-for-recovery-only\n")
        if updater:
            env.write_text(env.read_text() + f"RECOVERY_IMAGE_PREFIX={prefix}\nRAKAZO_IMAGE_TAG=baseline\nRAKAZO_IMAGE_TAG_PREVIOUS=baseline\n")
        env.chmod(0o600)
        environment = {
            "NODE_ENV": "production", "DATABASE_URL": "postgresql://example:fake-password@postgres:5432/example",
            "ENCRYPTION_KEY": "${ENCRYPTION_KEY}", "BETTER_AUTH_SECRET": "synthetic-auth-secret-for-recovery-only",
            "SCREEN_PROXY_SECRET": "synthetic-screen-secret-for-recovery-only",
            "SANDBOX_SUPERVISOR_TOKEN": "synthetic-supervisor-secret-for-recovery-only",
            "BETTER_AUTH_URL": "http://127.0.0.1:3100", "WEB_ORIGIN": "http://127.0.0.1:3100",
            "API_HOST": "0.0.0.0", "DATA_DIR": "/data", "SIGNUPS_ENABLED": "true",
        }
        config = {
            "services": {
                "postgres": {"image": postgres, "pull_policy": "never", "environment": {
                    "POSTGRES_USER": "example", "POSTGRES_PASSWORD": "fake-password", "POSTGRES_DB": "example"},
                    "mem_limit": "256m", "memswap_limit": "256m", "cpus": 1,
                    "volumes": ["pgdata:/var/lib/postgresql/data"], "healthcheck": {
                        "test": ["CMD", "pg_isready", "-U", "example"], "interval": "1s", "timeout": "2s", "retries": 60}},
                "api": {"image": previous or image, "pull_policy": "never", "environment": environment, "volumes": ["appdata:/data"],
                    "mem_limit": "1536m", "memswap_limit": "1536m", "cpus": 2, "pids_limit": 256,
                    "command": ["bash", "-lc", "pnpm --filter @rakazo/db exec prisma migrate deploy && pnpm --filter @rakazo/api start"],
                    "depends_on": {"postgres": {"condition": "service_healthy"}},
                    "healthcheck": {"test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                                    "interval": "2s", "timeout": "2s", "retries": 90}},
                "worker": {"image": previous or image, "pull_policy": "never", "environment": environment, "volumes": ["appdata:/data"],
                           "mem_limit": "768m", "memswap_limit": "768m", "cpus": 1, "pids_limit": 256,
                           "command": ["pnpm", "--filter", "@rakazo/worker", "start"],
                           "depends_on": {"api": {"condition": "service_healthy"}}},
            },
            "volumes": {"pgdata": {}, "appdata": {}}, "networks": {"default": {"internal": True}},
        }
        if previous:
            # Earlier images may have a package-manager cache only readable by
            # root. Exercise their installed code without a registry bootstrap.
            config["services"]["api"]["command"] = ["bash", "-lc",
                "cd /app/packages/db && node node_modules/prisma/build/index.js migrate deploy && cd /app && node --import tsx apps/api/src/index.ts"]
            config["services"]["worker"]["command"] = ["node", "--import", "tsx", "apps/worker/src/index.ts"]
        if updater:
            reference = "${RECOVERY_IMAGE_PREFIX}:${RAKAZO_IMAGE_TAG}"
            config["services"]["api"]["image"] = reference
            config["services"]["worker"]["image"] = reference
            config["services"]["web"] = {
                "image": reference, "pull_policy": "never",
                "command": ["pnpm", "--filter", "@rakazo/web", "preview", "--host", "0.0.0.0"],
                "environment": {"API_PROXY_TARGET": "http://api:3100"},
                "depends_on": {"api": {"condition": "service_healthy"}},
            }
        compose_file = root / "compose.json"
        compose_file.write_text(json.dumps(config))

        def compose(project, *args, **kwargs):
            return run(["docker", "compose", "-p", project, "--env-file", str(env), "-f", str(compose_file), *args], **kwargs)

        def snapshot(project, action, *args):
            return run([sys.executable, str(CLI), action, "--project", project, "--env-file", str(env), "--compose", str(compose_file), *args])

        def sql(statement):
            return compose(source, "exec", "-T", "postgres", "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "example", "-d", "example", "-c", statement)

        def request(project, endpoint, payload=None, cookie=None):
            options = {"headers": {"content-type": "application/json", "origin": "http://127.0.0.1:3100"}}
            if payload is not None:
                options.update(method="POST", body=json.dumps(payload))
            if cookie:
                options["headers"]["cookie"] = cookie
            script = f"fetch({json.dumps('http://127.0.0.1:3100/api/auth/' + endpoint)},{json.dumps(options)}).then(async r=>{{if(!r.ok)throw Error('Auth status '+r.status+': '+await r.text());console.log(JSON.stringify({{cookie:r.headers.get('set-cookie'),body:await r.json()}}))}}).catch(e=>{{console.error(e);process.exitCode=1}})"
            return json.loads(compose(project, "exec", "-T", "api", "node", "-e", script))

        def probe(project, mode):
            executable = ["node", "--import", "tsx", "--input-type=module"] if previous else ["pnpm", "exec", "tsx"]
            print(compose(project, "exec", "-T", "api", *executable, "--eval", PROBE, mode), flush=True)

        try:
            if updater:
                run(["docker", "image", "tag", image, baseline_tag])
                baseline_tagged = True
            compose(source, "up", "-d", "--wait", "--wait-timeout", "200", "--pull", "never")
            signup = request(source, "sign-up/email", {"email": EMAIL, "password": PASSWORD, "name": "Recovery example"})
            original_user = signup["body"]["user"]["id"]
            cookie = signup["cookie"].split(";", 1)[0]
            assert request(source, "get-session", cookie=cookie)["body"]["user"]["id"] == original_user
            probe(source, "seed")
            if previous:
                migration_query = "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"
                before = set(sql(migration_query).splitlines())
                compose(source, "stop", "api", "worker")
                for service in ("api", "worker"):
                    config["services"][service]["image"] = image
                compose_file.write_text(json.dumps(config))
                compose(source, "up", "--detach", "--wait", "--wait-timeout", "200", "--pull", "never")
                for service in ("api", "worker"):
                    container = compose(source, "ps", "--quiet", service)
                    assert run(["docker", "inspect", container, "--format", "{{.Image}}"]) == image
                after = set(sql(migration_query).splitlines())
                assert before < after, "This check must exercise new migrations while retaining the prior migration history"
                assert request(source, "get-session", cookie=cookie)["body"]["user"]["id"] == original_user
                assert request(source, "sign-in/email", {"email": EMAIL, "password": PASSWORD})["body"]["user"]["id"] == original_user
                probe(source, "verify")
                print(f"PASS: earlier release data and original session/password survive {len(after - before)} new migrations into the candidate image", flush=True)
            saved = root / "snapshot"
            snapshot(source, "backup", "--output", str(saved))
            print("PASS: real application startup, migrations, signup and product snapshot", flush=True)

            # The fault commits a destructive data change before failing. Merely
            # switching images cannot undo it or Prisma's failed migration record.
            migration_dir = root / MIGRATION
            migration_dir.mkdir(mode=0o755)
            migration_dir.chmod(0o755)
            migration_file = migration_dir / "migration.sql"
            migration_file.write_text('BEGIN; UPDATE "user" SET name = \'Changed by failed migration\'; COMMIT;\n' + ('SELECT 1 / 0;\n' if args.failure == "failed-migration" else ''))
            migration_file.chmod(0o644)
            # A stopped container accepts an exact cached image ID on Docker's
            # classic and containerd stores. BuildKit's FROM may try a registry.
            run(["docker", "create", "--name", fixture_container, "--network", "none", "--pull", "never", image])
            fixture_created = True
            if args.failure != "startup-only":
                run(["docker", "cp", str(migration_dir), f"{fixture_container}:/app/packages/db/prisma/migrations/"])
            if args.failure != "failed-migration":
                fault = root / "index.ts"
                fault.write_text("throw new Error('Synthetic failure after completed migration');\n")
                fault.chmod(0o644)
                run(["docker", "cp", str(fault), f"{fixture_container}:/app/apps/api/src/index.ts"])
            run(["docker", "commit", fixture_container, broken_tag])
            broken_image = run(["docker", "image", "inspect", broken_tag, "--format", "{{.Id}}"])
            if updater:
                fixture = root / "updater-fixture.json"
                fixture.write_text(json.dumps({"directory": str(root), "project": source, "imagePrefix": prefix, "faultImage": broken_image, "failure": args.failure}))
                print(run(["docker", "run", "--rm", "--pull", "never", "--network", "none",
                    "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
                    "--mount", f"type=bind,source={root},target={root}",
                    updater, "pnpm", "exec", "tsx", "fixtures/migration-recovery.ts", str(fixture)]), flush=True)
                expected_running = {"postgres", "api", "worker", "web"} if args.failure == "startup-only" else {"postgres"}
                assert set(compose(source, "ps", "--services", "--status", "running").split()) == expected_running
            else:
                compose(source, "stop", "api", "worker")
                config["services"]["api"]["image"] = broken_image
                compose_file.write_text(json.dumps(config))
                compose(source, "up", "-d", "--wait", "--wait-timeout", "100", "--pull", "never", "api", expected_failure=True)
            state = "IS NULL" if args.failure == "failed-migration" else "IS NOT NULL"
            assert sql(f"SELECT count(*) FROM _prisma_migrations WHERE migration_name='{MIGRATION}' AND finished_at {state}") == ("0" if args.failure == "startup-only" else "1")
            source_name = "Recovery example" if args.failure == "startup-only" else "Changed by failed migration"
            assert sql('SELECT name FROM "user"') == source_name
            print(f"PASS: {args.failure} update recovery decision verified against database and running services", flush=True)

            config["services"]["api"]["image"] = "${RECOVERY_IMAGE_PREFIX}:${RAKAZO_IMAGE_TAG}" if updater else image
            compose_file.write_text(json.dumps(config))
            if not updater and args.failure == "failed-migration":
                compose(source, "up", "-d", "--wait", "--wait-timeout", "100", "--pull", "never", "api", expected_failure=True)
                api = compose(source, "ps", "--all", "--quiet", "api")
                assert run(["docker", "inspect", api, "--format", "{{.Image}}"]) == image
                logs = compose(source, "logs", "--no-color", "api")
                assert "P3009" in logs and MIGRATION in logs, "Prior image must fail on the unresolved migration"
                assert sql(f"SELECT count(*) FROM _prisma_migrations WHERE migration_name='{MIGRATION}' AND finished_at IS NULL AND rolled_back_at IS NULL") == "1"
                print("PASS: prior image alone cannot recover the failed migration", flush=True)
            assert sql('SELECT name FROM "user"') == source_name

            compose(target, "create", "--pull", "never")
            compose(target, "up", "-d", "--wait", "--pull", "never", "postgres")
            snapshot(target, "restore", "--source", str(saved))
            assert set(compose(target, "ps", "--services", "--status", "running").split()) == {"postgres"}
            compose(target, "up", "-d", "--wait", "--wait-timeout", "200", "--pull", "never")
            assert request(target, "get-session", cookie=cookie)["body"]["user"]["id"] == original_user
            signin = request(target, "sign-in/email", {"email": EMAIL, "password": PASSWORD})
            assert signin["body"]["user"]["id"] == original_user
            probe(target, "verify")
            assert sql('SELECT name FROM "user"') == source_name, "Snapshot recovery must leave the source untouched"
            print("PASS: restored application accepts its original session and password; source state preserved", flush=True)
        except Exception:
            for project in (source, target):
                print(compose(project, "logs", "--no-color", "--tail", "60", "api", "worker"), file=sys.stderr)
            raise
        finally:
            failures = []
            for project in (source, target):
                try:
                    compose(project, "down", "--volumes", "--remove-orphans")
                except Exception:
                    failures.append(project)
            if fixture_created:
                run(["docker", "rm", fixture_container])
            # Remove only this invocation's unique fault-image tag, never the supplied images.
            existing = run(["docker", "image", "ls", "--quiet", broken_tag])
            if existing:
                run(["docker", "image", "rm", broken_tag])
            if baseline_tagged:
                run(["docker", "image", "rm", baseline_tag])
            if failures:
                raise RuntimeError("Disposable stack cleanup failed: " + ", ".join(failures))
    print("Product update recovery checks passed.")


if __name__ == "__main__":
    main()
