#!/usr/bin/env python3
"""Offline coordination and artifact-binding checks."""

import argparse
import contextlib
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("coordinated", Path(__file__).with_name("customer-deployment-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class CoordinationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.roles = {role: str(index + 1) * 64 for index, role in enumerate(["api", "postgres", "worker", "langflow", "openrag", "connector", "search"])}
        self.states = {id: {"Id": id, "Image": "sha256:" + "a" * 64, "Config": {"Env": []},
                           "State": {"Running": role != "worker", "StartedAt": "original"}, "Mounts": []}
                       for role, id in self.roles.items()}
        self.events = []
        self.args = argparse.Namespace(project="fixture", compose=[], env_file="unused", output=str(self.root / "snapshot"),
                                       **{role: self.roles[role] for role in ("langflow", "openrag", "connector", "search")})
        self.data = {"Type": "volume", "Source": "/fixture/data", "Name": "data", "Destination": "/data"}
        test = self
        class Deployment:
            def __init__(self, _args):
                pass
            def containers(self):
                return test.inspect([test.roles[r] for r in ("api", "postgres", "worker")])
            def resources(self):
                items = self.containers()
                return items, dict(zip(("api", "postgres", "worker"), items)), test.data, "/data"
        self.deployment_class = Deployment
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        patches = [patch.object(backup.core, "Deployment", Deployment),
                   patch.object(backup.core, "lock", lambda _: contextlib.nullcontext()),
                   patch.object(backup.runtimes, "runtime_locks", lambda _: contextlib.nullcontext()),
                   patch.object(backup.runtimes, "inspect", self.inspect),
                   patch.object(backup.runtimes, "validate_runtime"),
                   patch.object(backup.search, "Search", return_value=argparse.Namespace(container=self.roles["search"], data={**self.data, "Source": "/fixture/search"})),
                   patch.object(backup.core, "running_writers", lambda *_: [self.roles[r] for r in ("api", "worker") if self.states[self.roles[r]]["State"]["Running"]]),
                   patch.object(backup.runtimes, "assert_quiet", self.quiet),
                   patch.object(backup.core, "require_exclusive_database"),
                   patch.object(backup.core, "command", self.command),
                   patch.object(backup.core, "wait_running", self.ready),
                   patch.object(backup.core, "capture", lambda _deployment, output: self.capture("core", output)),
                   patch.object(backup.runtimes, "capture", lambda args, _ids: self.capture("runtimes", Path(args.output))),
                   patch.object(backup.search, "backup", lambda _id, output: self.capture("search", output)),
                   patch.dict(backup.COMPONENTS, {name: lambda _: None for name in backup.COMPONENTS})]
        for item in patches:
            self.stack.enter_context(item)

    def inspect(self, ids):
        return [copy.deepcopy(self.states[id]) for id in ids]

    def command(self, values, **_kwargs):
        action, id = values[1], values[-1]
        self.events.append((action, id))
        self.states[id]["State"]["Running"] = action == "start"
        return b""

    def quiet(self, ids, _mounts):
        if any(self.states[id]["State"]["Running"] for id in ids):
            raise backup.core.SnapshotError("Customer runtime still running")

    def ready(self, ids):
        self.assertTrue(all(self.states[id]["State"]["Running"] for id in ids))

    def capture(self, name, output):
        self.assertFalse(any(self.states[self.roles[r]]["State"]["Running"] for r in ("api", "worker", "langflow", "openrag", "connector")))
        self.events.append(("capture", name))
        output.mkdir()
        (output / "manifest.json").write_text(json.dumps({"component": name}))

    def test_all_components_share_one_stopped_writer_window(self):
        backup.backup(self.args)
        self.assertEqual([e[1] for e in self.events if e[0] == "capture"], ["core", "runtimes", "search"])
        last_capture = max(i for i, e in enumerate(self.events) if e[0] == "capture")
        self.assertTrue(all(i > last_capture for i, e in enumerate(self.events) if e[0] == "start"))
        self.assertEqual([e[1] for e in self.events if e[0] == "start"], [self.roles[r] for r in ("connector", "langflow", "openrag", "api")])
        self.assertFalse(self.states[self.roles["worker"]]["State"]["Running"])
        self.assertEqual(set(backup.verify(Path(self.args.output))["components"]), set(backup.COMPONENTS))

    def test_component_failure_discards_bundle_and_resumes_writers(self):
        with patch.object(backup.search, "backup", side_effect=backup.search.SnapshotError("fixture failure")):
            with self.assertRaises(backup.search.SnapshotError):
                backup.backup(self.args)
        self.assertFalse(Path(self.args.output).exists())
        self.assertFalse(list(self.root.glob(".customer-snapshot-*")))
        self.assertEqual([e[1] for e in self.events if e[0] == "start"], [self.roles[r] for r in ("connector", "langflow", "openrag", "api")])
        self.assertTrue(all(self.states[self.roles[r]]["State"]["Running"] for r in ("api", "langflow", "openrag", "connector")))

    def test_changed_start_time_discards_capture_even_if_runtime_stopped_again(self):
        def capture(_deployment, output):
            self.capture("core", output)
            self.states[self.roles["connector"]]["State"]["StartedAt"] = "restarted"
        with patch.object(backup.core, "capture", capture), self.assertRaisesRegex(backup.core.SnapshotError, "changed"):
            backup.backup(self.args)
        self.assertFalse(Path(self.args.output).exists())
        self.assertNotIn(("capture", "runtimes"), self.events)

    def test_uncertain_stop_response_still_attempts_resume(self):
        def command(values, **kwargs):
            result = self.command(values, **kwargs)
            if values[1] == "stop":
                raise backup.core.SnapshotError("Lost response")
            return result
        with patch.object(backup.core, "command", command), self.assertRaises(backup.core.SnapshotError):
            backup.backup(self.args)
        self.assertEqual(self.events, [("stop", self.roles["api"]), ("start", self.roles["api"])])

    def test_resume_failure_preserves_valid_published_bundle(self):
        def command(values, **kwargs):
            if values[1] == "start" and values[-1] == self.roles["connector"]:
                raise backup.core.SnapshotError("Could not resume")
            return self.command(values, **kwargs)
        with patch.object(backup.core, "command", command), patch.object(backup.core, "wait_running"), \
             self.assertRaisesRegex(backup.core.SnapshotError, "Snapshot published"):
            backup.backup(self.args)
        backup.verify(Path(self.args.output))
        self.assertTrue(self.states[self.roles["api"]]["State"]["Running"])
        self.assertTrue(self.states[self.roles["langflow"]]["State"]["Running"])

    def test_customer_originally_stopped_is_not_started(self):
        self.states[self.roles["openrag"]]["State"]["Running"] = False
        backup.backup(self.args)
        self.assertNotIn(("start", self.roles["openrag"]), self.events)

    def test_replaced_component_is_rejected(self):
        backup.backup(self.args)
        (Path(self.args.output) / "core/manifest.json").write_text('{"component":"different capture"}')
        with self.assertRaisesRegex(backup.core.SnapshotError, "mismatch"):
            backup.verify(Path(self.args.output))

    def test_shared_identity_or_existing_output_refused_before_stop(self):
        self.args.search = self.roles["api"]
        with patch.object(backup.search, "Search", return_value=argparse.Namespace(container=self.roles["api"], data=self.data)):
            with self.assertRaisesRegex(backup.core.SnapshotError, "distinct"):
                backup.backup(self.args)
        self.assertEqual(self.events, [])
        Path(self.args.output).mkdir()
        with self.assertRaises(backup.core.SnapshotError):
            backup.backup(self.args)
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main()
