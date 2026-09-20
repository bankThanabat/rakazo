#!/usr/bin/env python3
"""Exercise stack controls on disposable local Compose services without published ports."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=60, stderr=subprocess.PIPE, **kwargs).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Cached immutable native image with /bin/sh")
    parser.add_argument("--report-directory", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.report_directory.mkdir(mode=0o700)
    endpoint = os.environ.get("DOCKER_HOST") if not os.environ.get("DOCKER_CONTEXT") else None
    endpoint = endpoint or json.loads(command(["docker", "context", "inspect"]))[0]["Endpoints"]["docker"]["Host"]
    assert endpoint.startswith(("unix://", "npipe://")), "Use a local disposable engine"
    image = json.loads(command(["docker", "image", "inspect", args.image]))[0]
    assert args.image == image["Id"], "Supply an immutable cached image ID"
    architecture = command(["docker", "info", "--format", "{{.Architecture}}"])
    assert image["Architecture"] == {"aarch64": "arm64", "x86_64": "amd64"}.get(architecture, architecture)
    root = Path(__file__).resolve().parent.parent
    prefix = "deskazo-stack-control-" + uuid.uuid4().hex
    projects = [prefix, prefix + "-other"]
    baseline = command(["docker", "ps", "--quiet"]).split()
    volumes = set(command(["docker", "volume", "ls", "--quiet"]).split())
    def states(ids):
        return {c["Id"]: [c["State"]["Running"], c["State"]["StartedAt"], c["State"].get("Health", {}).get("Status")]
                for c in json.loads(command(["docker", "inspect", *ids]))} if ids else {}
    before = states(baseline)
    service = {"image": args.image, "network_mode": "none", "mem_limit": "32m", "memswap_limit": "32m",
               "cpus": 0.5, "pids_limit": 32, "read_only": True,
               "tmpfs": [*list(image["Config"].get("Volumes") or {}), "/tmp:rw,size=1m"],
               "stop_grace_period": "3s", "labels": {"deskazo.stack-control": prefix},
               "healthcheck": {"test": ["CMD", "/bin/sh", "-c", "test -f /tmp/ready"], "interval": "1s", "timeout": "1s", "retries": 1},
               "entrypoint": ["/bin/sh", "-c", 'trap "exit 0" INT TERM; touch /tmp/ready; while :; do sleep 1 & wait $!; done']}
    services = {name: service for name in ("api", "langflow", "opensearch", "postgres")}
    services["worker"] = {**service, "entrypoint": ["/bin/true"], "healthcheck": {"disable": True}}
    config = json.dumps({"services": services})
    other_config = json.dumps({"services": {"api": service}})
    def compose(project, config, *options):
        return command(["docker", "compose", "--env-file", "/dev/null", "--project-name", project,
                        "--file", "-", *options], input=config)
    def project_items(project):
        ids = command(["docker", "ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=" + project]).split()
        return json.loads(command(["docker", "inspect", *ids])) if ids else []
    control = [sys.executable, str(root / "scripts/customer-stack-control.py")]
    report = {"status": "failed", "checks": [], "image": image["Id"],
              "sourceHashes": {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in
                               ("scripts/customer-stack.sh", "scripts/customer-stack-control.py",
                                "scripts/verify-customer-stack-control.py")}}
    try:
        compose(projects[0], config, "up", "--detach", "--pull", "never")
        compose(projects[1], other_config, "up", "--detach", "--pull", "never")
        compose(projects[0], config, "run", "--detach", "--no-deps", "--name", prefix + "-oneoff", "api")
        oneoff = next(c for c in project_items(projects[0]) if c["Name"] == "/" + prefix + "-oneoff")
        assert oneoff["Config"]["Labels"]["com.docker.compose.oneoff"] == "True"
        # Health verifies that the signal handlers and readiness markers exist.
        deadline = time.monotonic() + 20
        while True:
            initial = project_items(projects[0])
            assert len(initial) == 6
            if all(c["State"].get("Health", {}).get("Status") == "healthy" or
                   (c["Config"]["Labels"]["com.docker.compose.service"] == "worker" and c["State"]["Status"] == "exited") for c in initial):
                break
            assert time.monotonic() < deadline, "Fixture readiness timed out"
            time.sleep(0.2)
        assert all(not c["HostConfig"].get("PortBindings") and c["HostConfig"]["NetworkMode"] == "none" for c in initial)
        output = command([*control, "ps", projects[0]])
        assert prefix + "-oneoff" not in output and projects[1] not in output
        assert "running/healthy" in output and "exited" in output
        (args.report_directory / "before.txt").write_text(output + "\n")
        command([*control, "stop", projects[0]])
        final = project_items(projects[0])
        managed = {c["Config"]["Labels"]["com.docker.compose.service"]: c for c in final
                   if c["Config"]["Labels"]["com.docker.compose.oneoff"] == "False"}
        assert len(managed) == 5 and all(not c["State"]["Running"] and c["State"]["ExitCode"] == 0 for c in managed.values())
        order = [managed[name]["State"]["FinishedAt"] for name in ("api", "langflow", "opensearch", "postgres")]
        assert order == sorted(order) and len(set(order)) == 4
        assert states([oneoff["Id"]])[oneoff["Id"]][0]
        assert all(c["State"]["Running"] for c in project_items(projects[1]))
        output = command([*control, "ps", projects[0]])
        assert output.count("exited") == 5
        (args.report_directory / "after.txt").write_text(output + "\n")
        command([*control, "stop", projects[0]])
        assert [c["State"]["StartedAt"] for c in project_items(projects[0])] == [c["State"]["StartedAt"] for c in final]
        report["checks"] = ["ps selects managed services and reports exited state",
                            "application, Langflow, search and database stop gracefully in order",
                            "one-off and adjacent-project containers remain running",
                            "repeated stop does not restart any container"]
        report["status"] = "passed"
    except Exception as error:
        report["failureType"] = type(error).__name__
        report["failure"] = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            (args.report_directory / "failure-stderr.log").write_text(error.stderr or "")
        raise
    finally:
        report["fixtureStates"] = []
        for project in projects:
            for container in project_items(project):
                assert container["Config"]["Labels"].get("deskazo.stack-control") == prefix
                report["fixtureStates"].append({"project": project,
                    "service": container["Config"]["Labels"]["com.docker.compose.service"],
                    "oneoff": container["Config"]["Labels"]["com.docker.compose.oneoff"],
                    "running": container["State"]["Running"], "exitCode": container["State"]["ExitCode"],
                    "stopSignal": container["Config"].get("StopSignal")})
                command(["docker", "rm", "--force", "--volumes", container["Id"]])
        report["temporaryContainersRemoved"] = not any(project_items(p) for p in projects)
        report["existingContainersUnchanged"] = states(baseline) == before
        report["unexpectedNewVolumes"] = sorted(set(command(["docker", "volume", "ls", "--quiet"]).split()) - volumes)
        if not report["temporaryContainersRemoved"] or not report["existingContainersUnchanged"] or report["unexpectedNewVolumes"]:
            report["status"] = "failed"
        (args.report_directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    assert report["status"] == "passed"
    print("Stack controls passed on disposable Compose services; owned resources removed.")


if __name__ == "__main__":
    main()
