"""Offline safety checks: python3 scripts/deployment-backup.test.py."""

import argparse
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("deployment-backup.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, entries):
        file = self.root / "appdata.tgz"
        with tarfile.open(file, "w:gz") as archive:
            for name, kind, link in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = link
                archive.addfile(member, io.BytesIO() if kind == tarfile.REGTYPE else None)
        return file

    def fixture(self):
        self.archive([(".", tarfile.DIRTYPE, ""), ("home", tarfile.REGTYPE, "")])
        for name in ("database.dump", "environment.env", "compose.resolved.json"):
            (self.root / name).write_text("synthetic")
        (self.root / "compose.resolved.json").write_text(json.dumps({"services": {"api": {}, "postgres": {}}}))
        manifest = {"version": 1, "images": {"api": "sha256:example", "postgres": "sha256:example"},
                    "files": {file.name: snapshot.digest(file) for file in self.root.iterdir()}}
        self.manifest(manifest)
        return manifest

    def manifest(self, value):
        (self.root / "manifest.json").write_text(json.dumps(value))

    def test_complete_snapshot_and_moved_directory(self):
        self.fixture()
        snapshot.verify(self.root)
        moved = self.root / "moved"
        moved.mkdir()
        for file in list(self.root.iterdir()):
            if file != moved:
                file.rename(moved / file.name)
        snapshot.verify(moved)

    def test_missing_required_file_with_extra_file(self):
        manifest = self.fixture()
        del manifest["files"]["environment.env"]
        manifest["files"]["extra"] = "example"
        self.manifest(manifest)
        with self.assertRaisesRegex(snapshot.SnapshotError, "incomplete"):
            snapshot.verify(self.root)

    def test_malformed_metadata_is_reported_without_a_traceback(self):
        manifest = self.fixture()
        for bad in ([], {}, {**manifest, "images": []}, {**manifest, "files": []}):
            with self.subTest(bad=bad):
                self.manifest(bad)
                with self.assertRaises(snapshot.SnapshotError):
                    snapshot.verify(self.root)
        for config in ([], {}, {"services": {"api": [], "postgres": {}}}):
            file = self.root / "compose.resolved.json"
            file.write_text(json.dumps(config))
            manifest["files"][file.name] = snapshot.digest(file)
            self.manifest(manifest)
            with self.assertRaisesRegex(snapshot.SnapshotError, "configuration"):
                snapshot.verify(self.root)

    def test_waits_for_resumed_service_health_and_rejects_failure(self):
        with patch.object(snapshot, "command", side_effect=[
            b'[{"State":{"Running":true,"Health":{"Status":"starting"}}}]',
            b'[{"State":{"Running":true,"Health":{"Status":"healthy"}}}]',
            b'[{"State":{"Running":true,"Health":{"Status":"healthy"}}}]',
        ]), patch.object(snapshot.time, "sleep"):
            snapshot.wait_running(["api"])
        with patch.object(snapshot, "command", return_value=b'[{"State":{"Running":false}}]'), \
             patch.object(snapshot.time, "monotonic", side_effect=[0, 121]):
            with self.assertRaisesRegex(snapshot.SnapshotError, "ready"):
                snapshot.wait_running(["api"])

    def test_corrupt_file_or_replaced_symlink(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                file = self.root / "database.dump"
                file.unlink(missing_ok=True)
                self.fixture()
                if symlink:
                    file.unlink()
                    file.symlink_to(self.root / "environment.env")
                else:
                    file.write_text("corrupted")
                with self.assertRaisesRegex(snapshot.SnapshotError, "checksum"):
                    snapshot.verify(self.root)
                (self.root / "manifest.json").unlink()

    def test_unsafe_archive_members_in_either_order(self):
        cases = [
            [("../outside", tarfile.REGTYPE, "")],
            [("/outside", tarfile.REGTYPE, "")],
            [("home", tarfile.REGTYPE, ""), ("./home", tarfile.REGTYPE, "")],
            [("pipe", tarfile.FIFOTYPE, "")],
            [("link", tarfile.LNKTYPE, "../outside")],
            [("link", tarfile.SYMTYPE, "/tmp"), ("link/file", tarfile.REGTYPE, "")],
            [("link/file", tarfile.REGTYPE, ""), ("link", tarfile.SYMTYPE, "/tmp")],
        ]
        for entries in cases:
            with self.subTest(entries=entries), self.assertRaises(snapshot.SnapshotError):
                snapshot.archive_paths(self.archive(entries))

    def test_preserves_safe_hard_links_and_browser_runtime_symlinks(self):
        snapshot.archive_paths(self.archive([
            ("home", tarfile.REGTYPE, ""), ("copy", tarfile.LNKTYPE, "home"),
            ("SingletonSocket", tarfile.SYMTYPE, "/tmp/browser-example/socket"),
        ]))

    def test_helper_mounts_only_data_and_preserves_ownership(self):
        data = {"Type": "volume", "Name": "synthetic_appdata", "Destination": "/data"}
        with patch.object(snapshot, "command") as command:
            snapshot.helper(data, "synthetic-image", "tar", "-xzf", "-", writable=True, stdin=io.BytesIO())
        args = command.call_args.args[0]
        self.assertIn("--interactive", args)
        self.assertIn("CHOWN", args)
        self.assertIn("FOWNER", args)
        self.assertIn("type=volume,source=synthetic_appdata,target=/data", args)
        self.assertNotIn("--volumes-from", args)
        self.assertEqual(args[args.index("--network") + 1], "none")

    def test_writer_mount_overlap_in_both_directions(self):
        data = {"Source": "/srv/data"}
        for source in ("/srv", "/srv/data", "/srv/data/home"):
            self.assertTrue(snapshot.same_data({"Source": source}, data))
        self.assertFalse(snapshot.same_data({"Source": "/srv/other"}, data))
        self.assertTrue(snapshot.same_data({"Name": "appdata"}, {"Name": "appdata"}))

    @patch.object(snapshot, "wait_running")
    def test_backup_failure_resumes_only_previously_running_containers(self, _wait):
        env = self.root / ".env"
        env.write_text("EXAMPLE=fake")
        class Deployment:
            env_file = env

            def resources(self):
                return [], {"postgres": {"State": {"Running": True}}}, {"Source": "/synthetic-data"}, "/data"

        args = argparse.Namespace(output=str(self.root / "snapshot"))
        with patch.object(snapshot, "Deployment", return_value=Deployment()), \
             patch.object(snapshot, "running_writers", side_effect=[["api", "worker"], [], []]), \
             patch.object(snapshot, "command") as command, \
             patch.object(snapshot, "postgres", side_effect=snapshot.SnapshotError("dump failed")):
            with self.assertRaisesRegex(snapshot.SnapshotError, "dump failed"):
                snapshot.backup(args)
        starts = [call.args[0] for call in command.call_args_list if call.args[0][1] == "start"]
        self.assertEqual(starts, [["docker", "start", "api"], ["docker", "start", "worker"]])
        self.assertFalse(Path(args.output).exists())
        self.assertEqual(list(self.root.glob(".snapshot-*")), [])

    @patch.object(snapshot, "wait_running")
    def test_failed_stop_still_attempts_resume(self, _wait):
        env = self.root / ".env"
        env.write_text("EXAMPLE=fake")
        deployment = argparse.Namespace(env_file=env, resources=lambda: (
            [], {"postgres": {"State": {"Running": True}}}, {"Source": "/synthetic-data"}, "/data"))
        with patch.object(snapshot, "Deployment", return_value=deployment), \
             patch.object(snapshot, "running_writers", return_value=["api"]), \
             patch.object(snapshot, "command", side_effect=[snapshot.SnapshotError("stop timed out"), b""]) as command:
            with self.assertRaisesRegex(snapshot.SnapshotError, "stop timed out"):
                snapshot.backup(argparse.Namespace(output=str(self.root / "snapshot")))
        self.assertEqual(command.call_args.args[0], ["docker", "start", "api"])


if __name__ == "__main__":
    unittest.main()
