#!/usr/bin/env python3
"""Offline safety tests for customer runtime capture and restore."""

import argparse
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runtime_backup", Path(__file__).with_name("customer-runtime-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
IMAGE = "sha256:" + "a" * 64


def runtimes():
    return {role: {"Id": str(index + 1) * 64, "Image": IMAGE, "State": {"Running": True},
                   "Config": {"WorkingDir": "/app", "Env": ["FIXTURE_SECRET=synthetic-$cash-${NOT_AN_ENV}"], "Cmd": ["sleep", "infinity"]},
                   "HostConfig": {"AutoRemove": False},
                   "Mounts": [{"Type": "volume", "Name": role + str(i), "Source": "/fake/" + role + str(i),
                               "Destination": path, "RW": True, "archive": "mount-0.tgz"}
                              for i, path in enumerate(sorted(paths))]}
            for index, (role, paths) in enumerate(backup.REQUIRED.items())}


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "snapshot"
        self.source.mkdir()
        self.archive = self.source / "mount-0.tgz"
        with tarfile.open(self.archive, "w:gz") as archive:
            info = tarfile.TarInfo("fixture.txt")
            info.size = 7
            archive.addfile(info, io.BytesIO(b"example"))
        self.manifest = {"format": "deskazo-runtimes-1", "helperImage": IMAGE,
                         "runtimes": runtimes(), "files": {self.archive.name: backup.core.digest(self.archive)}}
        self.save()
        self.args = argparse.Namespace(source=str(self.source), output=str(self.root / "restored"))

    def save(self):
        (self.source / "manifest.json").write_text(json.dumps(self.manifest))

    def test_complete_portable_snapshot(self):
        moved = self.root / "moved"
        self.source.rename(moved)
        self.assertEqual(backup.verify(moved)["format"], "deskazo-runtimes-1")

    def test_corruption_rejected_before_docker(self):
        self.archive.write_bytes(b"changed")
        with patch.object(backup.core, "command") as command, self.assertRaises(backup.Error):
            backup.restore(self.args)
        command.assert_not_called()

    def test_unsafe_archive_rejected_before_docker(self):
        with tarfile.open(self.archive, "w:gz") as archive:
            archive.addfile(tarfile.TarInfo("../outside"))
        self.manifest["files"][self.archive.name] = backup.core.digest(self.archive)
        self.save()
        with patch.object(backup.core, "command") as command, self.assertRaises(backup.Error):
            backup.restore(self.args)
        command.assert_not_called()

    def test_external_database_or_missing_mount_rejected(self):
        for role, env in [("connector", "OOMOL_CONNECT_DATABASE_URL=postgres://outside"),
                          ("langflow", "LANGFLOW_DATABASE_URL=postgres://outside"),
                          ("openrag", "DATABASE_URL=postgresql+asyncpg://outside/db"),
                          ("openrag", "DATABASE_URL=sqlite+aiosqlite:////outside/db"),
                          ("openrag", "OPENRAG_DATA_PATH=/outside"),
                          ("connector", "OOMOL_CONNECT_DATA_DIR=/outside"),
                          ("langflow", "LANGFLOW_DATABASE_URL=sqlite:////app/langflow-data/../outside")]:
            with self.subTest(role=role, env=env):
                item = copy.deepcopy(runtimes()[role])
                item["Config"]["Env"].append(env)
                with self.assertRaises(backup.Error):
                    backup.validate_runtime(role, item)
        item = runtimes()["openrag"]
        item["Mounts"].pop()
        with self.assertRaises(backup.Error):
            backup.validate_runtime("openrag", item)

    def test_archive_coverage_and_role_identity_required(self):
        original = copy.deepcopy(self.manifest)
        for change in (lambda: self.manifest["files"].clear(),
                       lambda: self.manifest["runtimes"].pop("connector"),
                       lambda: self.manifest["runtimes"]["langflow"].update(Image="latest")):
            self.manifest = copy.deepcopy(original)
            change()
            self.save()
            with self.assertRaises(backup.Error):
                backup.verify(self.source)

    def test_restore_fresh_volumes_no_network_no_start_and_literal_secrets(self):
        with patch.object(backup.core, "command", return_value=b"") as command, \
             patch.object(backup.core, "helper", return_value=b""):
            backup.restore(self.args)
        config = json.loads((Path(self.args.output) / "compose.json").read_text())
        self.assertEqual(len(config["volumes"]), 1)
        for service in config["services"].values():
            self.assertEqual(service["network_mode"], "none")
            self.assertNotIn("ports", service)
            self.assertEqual(service["environment"], ["FIXTURE_SECRET=synthetic-$$cash-$${NOT_AN_ENV}"])
        calls = [call.args[0] for call in command.call_args_list]
        self.assertTrue(all(args[1:3] == ["volume", "create"] for args in calls))
        self.assertEqual((Path(self.args.output) / "compose.json").stat().st_mode & 0o777, 0o600)

    def test_failed_extract_removes_only_owned_volume(self):
        with patch.object(backup.core, "command", return_value=b"") as command, \
             patch.object(backup.core, "helper", side_effect=[b"", backup.Error("fixture")]), self.assertRaises(backup.Error):
            backup.restore(self.args)
        calls = [call.args[0] for call in command.call_args_list]
        self.assertEqual(calls[0][-1], calls[1][-1])
        self.assertEqual(calls[1][1:3], ["volume", "rm"])
        self.assertFalse(Path(self.args.output).exists())

    def test_running_shared_writer_refused(self):
        item = runtimes()["connector"]
        stopped = {**item, "State": {"Running": False}}
        with patch.object(backup, "inspect", side_effect=[[stopped], [item]]), \
             patch.object(backup.core, "command", return_value=b"other"):
            with self.assertRaisesRegex(backup.Error, "Another running"):
                backup.assert_quiet([stopped["Id"]], item["Mounts"])

    def test_capture_failure_resumes_original_running_containers(self):
        items = list(runtimes().values())
        items[1]["State"]["Running"] = False
        args = argparse.Namespace(langflow="one", openrag="two", connector="three", helper_image=IMAGE, output=str(self.root / "capture"))
        with patch.object(backup, "inspect", return_value=items), \
             patch.object(backup.core, "command", return_value=json.dumps([{"Id": IMAGE}]).encode()) as command, \
             patch.object(backup, "assert_quiet", side_effect=backup.Error("fixture")), \
             patch.object(backup.core, "wait_running") as ready:
            with self.assertRaises(backup.Error):
                backup.capture(args, [item["Id"] for item in items])
        starts = [c.args[0][-1] for c in command.call_args_list if c.args[0][1] == "start"]
        self.assertEqual(starts, [items[0]["Id"], items[2]["Id"]])
        ready.assert_called_once_with(starts)
        self.assertFalse(Path(args.output).exists())

    def test_overlapping_capture_locks_refuse_a_second_operation(self):
        with backup.runtime_locks(["e" * 64, "f" * 64]):
            with self.assertRaisesRegex(backup.Error, "already running"):
                with backup.runtime_locks(["f" * 64]):
                    self.fail("Overlapping capture acquired the runtime lock")
        with backup.runtime_locks(["f" * 64]):
            pass

    def test_uncertain_stop_still_attempts_resume(self):
        items = list(runtimes().values())
        args = argparse.Namespace(langflow="one", openrag="two", connector="three", helper_image=IMAGE, output=str(self.root / "capture"))
        calls = []
        def command(values, **_kwargs):
            calls.append(values)
            if values[1] == "stop":
                raise backup.Error("Docker response lost after accepting stop")
            return json.dumps([{"Id": IMAGE}]).encode()
        with patch.object(backup, "inspect", return_value=items), \
             patch.object(backup.core, "command", side_effect=command), \
             patch.object(backup.core, "wait_running"):
            with self.assertRaises(backup.Error):
                backup.capture(args, [item["Id"] for item in items])
        self.assertEqual([c[-1] for c in calls if c[1] == "start"], [items[0]["Id"]])


if __name__ == "__main__":
    unittest.main()
