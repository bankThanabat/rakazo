#!/usr/bin/env python3
"""Inspect or stop deployed Compose services without build sources or credentials."""

import argparse
import json
import re
import subprocess
import sys

PREFIX = "com.docker.compose."
# Stop application writers before local runtimes and persistent services.
DEPENDENCIES = ("langflow", "opensearch", "postgres")
INSPECT = ('{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},'
           '"running":{{json .State.Running}},"status":{{json .State.Status}},'
           '"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}}')


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, timeout=300).strip()


def containers(project):
    ids = docker("ps", "--all", "--quiet", "--filter", "label=" + PREFIX + "project=" + project).split()
    if not ids:
        return []
    items = [json.loads(line) for line in docker("inspect", "--format", INSPECT, *ids).splitlines()]
    selected = []
    for item in items:
        labels = item["labels"] or {}
        if (labels.get(PREFIX + "project") == project and labels.get(PREFIX + "service")
                and labels.get(PREFIX + "config-hash")
                and labels.get(PREFIX + "oneoff", "").lower() != "true"):
            item["service"] = labels[PREFIX + "service"]
            selected.append(item)
    return selected


def control(action, projects):
    if action == "ps":
        print("PROJECT\tSERVICE\tCONTAINER\tSTATE")
    for project in projects:
        items = containers(project)
        if action == "ps":
            for item in items:
                state = item["status"] + ("/" + item["health"] if item["health"] else "")
                print("\t".join((project, item["service"], item["name"].lstrip("/"), state)))
            continue
        groups = [[item for item in items if item["service"] not in DEPENDENCIES]]
        groups += [[item for item in items if item["service"] == name] for name in DEPENDENCIES]
        for priority, group in enumerate(groups):
            ids = [item["id"] for item in group if item["running"]]
            if ids:
                # Docker retains each container's configured stop grace period.
                # A failure aborts before stopping any dependent service.
                docker("stop", *ids)
                for item in containers(project):
                    rank = DEPENDENCIES.index(item["service"]) + 1 if item["service"] in DEPENDENCIES else 0
                    if item["running"] and rank <= priority:
                        raise RuntimeError("A stopped service is still running in " + project)
        if any(item["running"] for item in containers(project)):
            raise RuntimeError("Services remain running in " + project)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("ps", "stop"))
    parser.add_argument("projects", nargs="+")
    args = parser.parse_args()
    if not all(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", value) for value in args.projects):
        parser.error("Invalid Compose project name")
    control(args.action, args.projects)


if __name__ == "__main__":
    try:
        main()
    except (subprocess.SubprocessError, RuntimeError) as error:
        print("Stack control failed: " + str(error), file=sys.stderr)
        sys.exit(1)
