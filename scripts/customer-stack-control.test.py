"""Offline checks for source-independent stack controls."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("control", Path(__file__).with_name("customer-stack-control.py"))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


def item(service, **updates):
    return {"id": service + "-id", "name": "/synthetic-" + service, "service": service,
            "running": True, "status": "running", "health": None, **updates}


class StackControlTests(unittest.TestCase):
    def test_only_exact_project_managed_non_oneoff_services_are_selected(self):
        labels = {control.PREFIX + "project": "synthetic", control.PREFIX + "service": "api",
                  control.PREFIX + "config-hash": "synthetic-hash", control.PREFIX + "oneoff": "False"}
        records = [item("selected", labels=labels),
                   item("other", labels={**labels, control.PREFIX + "project": "synthetic-other"}),
                   item("oneoff", labels={**labels, control.PREFIX + "oneoff": "True"}),
                   item("unmanaged", labels={**labels, control.PREFIX + "config-hash": ""})]
        with patch.object(control, "docker", side_effect=["ids", "\n".join(map(json.dumps, records))]) as docker:
            self.assertEqual([c["id"] for c in control.containers("synthetic")], ["selected-id"])
            self.assertEqual(docker.call_args_list[0].args,
                             ("ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=synthetic"))

    def test_stop_preserves_grace_and_stops_writers_before_dependencies(self):
        records = [item(name) for name in ("postgres", "api", "worker", "langflow", "opensearch")]
        calls = []
        def docker(*args):
            calls.append(args)
            for record in records:
                if record["id"] in args[1:]: record["running"] = False
        with patch.object(control, "containers", return_value=records), patch.object(control, "docker", side_effect=docker):
            control.control("stop", ["synthetic"])
        self.assertEqual(calls, [("stop", "api-id", "worker-id"), ("stop", "langflow-id"),
                                 ("stop", "opensearch-id"), ("stop", "postgres-id")])

    def test_stop_failure_preserves_dependencies_and_later_projects(self):
        with patch.object(control, "containers", return_value=[item("api"), item("postgres")]) as containers, \
             patch.object(control, "docker", side_effect=subprocess.CalledProcessError(1, ["docker", "stop"])) as docker:
            with self.assertRaises(subprocess.CalledProcessError):
                control.control("stop", ["synthetic", "other"])
            docker.assert_called_once_with("stop", "api-id")
            containers.assert_called_once_with("synthetic")

    def test_restart_after_stop_prevents_dependency_shutdown(self):
        with patch.object(control, "containers", return_value=[item("api"), item("postgres")]), \
             patch.object(control, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "still running"):
                control.control("stop", ["synthetic"])
            docker.assert_called_once_with("stop", "api-id")

    def test_ps_reports_stopped_and_unhealthy_services_without_mutation(self):
        output = io.StringIO()
        with patch.object(control, "containers", return_value=[item("api", health="unhealthy"),
                  item("worker", running=False, status="exited")]), \
             patch.object(control, "docker") as docker, contextlib.redirect_stdout(output):
            control.control("ps", ["synthetic"])
        self.assertIn("running/unhealthy", output.getvalue())
        self.assertIn("exited", output.getvalue())
        docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
