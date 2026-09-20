"""Offline snapshot guards: python3 scripts/customer-search-backup.test.py."""

import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("search_backup", Path(__file__).with_name("customer-search-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class SearchBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.snapshot = {"snapshot": "state", "uuid": "synthetic-id", "state": "SUCCESS",
                         "indices": ["documents"], "include_global_state": False,
                         "shards": {"total": 1, "successful": 1, "failed": 0}, "failures": []}
        self.manifest = {"format": "deskazo-search-1", "repository": "deskazo-" + "a" * 32,
                         "image": "sha256:" + "a" * 64, "serverVersion": "3.6.0", "snapshot": self.snapshot}
        self.archive()

    def archive(self, name="index-0", kind=tarfile.REGTYPE, link=""):
        archive = self.root / "repository.tgz"
        with tarfile.open(archive, "w:gz") as bundle:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = link
            bundle.addfile(member, io.BytesIO() if kind == tarfile.REGTYPE else None)
        self.manifest["archiveSha256"] = backup.core.digest(archive)
        self.write_manifest()

    def write_manifest(self):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))

    def test_valid_snapshot_can_move(self):
        backup.verify(self.root)
        moved = self.root / "moved"
        moved.mkdir()
        for file in list(self.root.iterdir()):
            if file != moved:
                file.rename(moved / file.name)
        backup.verify(moved)

    def test_corrupt_archive_rejected_before_docker(self):
        (self.root / "repository.tgz").write_bytes(b"corrupt")
        with patch.object(backup, "Search") as search:
            with self.assertRaisesRegex(backup.SnapshotError, "checksum"):
                backup.restore("target", self.root)
            search.assert_not_called()

    def test_unsafe_entries_rejected_before_docker(self):
        for name, kind, link in [("../outside", tarfile.REGTYPE, ""),
                                  ("pointer", tarfile.SYMTYPE, "/private"),
                                  ("device", tarfile.CHRTYPE, "")]:
            with self.subTest(name=name):
                self.archive(name, kind, link)
                with patch.object(backup, "Search") as search:
                    with self.assertRaises(backup.SnapshotError):
                        backup.restore("target", self.root)
                    search.assert_not_called()

    def test_security_global_or_partial_state_rejected(self):
        for field, value in [("include_global_state", True), ("indices", [backup.SECURITY_INDEX]),
                              ("state", "PARTIAL"), ("shards", {"failed": 1}),
                              ("failures", [{"reason": "synthetic"}])]:
            with self.subTest(field=field):
                original = self.snapshot[field]
                self.snapshot[field] = value
                self.write_manifest()
                with self.assertRaises(backup.SnapshotError):
                    backup.verify(self.root)
                self.snapshot[field] = original

    def test_invalid_repository_rejected(self):
        self.manifest["repository"] = "../../another-directory"
        self.write_manifest()
        with self.assertRaises(backup.SnapshotError):
            backup.verify(self.root)

    def test_malformed_snapshot_identity_and_coverage_rejected(self):
        for field, value in [("uuid", "../another-repository"), ("snapshot", "other-snapshot"),
                              ("indices", [1]), ("indices", ["documents", "documents"]),
                              ("indices", ["*"]), ("shards", []),
                              ("shards", {"failed": 0, "successful": 1, "total": 2})]:
            with self.subTest(field=field, value=value):
                original = self.snapshot[field]
                self.snapshot[field] = value
                self.write_manifest()
                with patch.object(backup, "Search") as search:
                    with self.assertRaises(backup.SnapshotError):
                        backup.restore("target", self.root)
                    search.assert_not_called()
                self.snapshot[field] = original

    def target(self):
        node = Mock(isolated=True, image=self.manifest["image"])
        node.request.return_value = {"version": {"number": self.manifest["serverVersion"]}}
        node.indices.return_value = []
        return node

    def test_connected_target_rejected_before_preparing_repository(self):
        node = self.target()
        node.isolated = False
        with patch.object(backup, "Search", return_value=node), self.assertRaisesRegex(backup.SnapshotError, "networking disabled"):
            backup.restore("target", self.root)
        node.prepare.assert_not_called()
        node.request.assert_not_called()

    def test_wrong_image_or_occupied_target_never_writes(self):
        for changed_image in (True, False):
            with self.subTest(changed_image=changed_image):
                node = self.target()
                if changed_image:
                    node.image = "sha256:other-image"
                else:
                    node.indices.return_value = ["existing-business-data"]
                with patch.object(backup, "Search", return_value=node), self.assertRaises(backup.SnapshotError):
                    backup.restore("target", self.root)
                node.prepare.assert_not_called()
                node.register.assert_not_called()

    def test_uncertain_create_preserves_source_repository(self):
        node = self.target()
        node.indices.return_value = ["documents"]
        def request(method, path, body=None):
            if method == "GET":
                return {"version": {"number": "3.6.0"}}
            raise backup.SnapshotError("Synthetic lost snapshot response")
        node.request.side_effect = request
        with patch.object(backup, "Search", return_value=node), patch.object(backup.core, "helper") as helper:
            with self.assertRaisesRegex(backup.SnapshotError, "lost snapshot response"):
                backup.backup("source", self.root / "new-snapshot")
            node.unregister.assert_not_called()
            helper.assert_not_called()
        self.assertFalse((self.root / "new-snapshot").exists())

    def test_invalid_admin_certificate_pair_rejected_before_docker(self):
        for certificate, key in [("/cert.pem", None), (None, "/key.pem"),
                                 ("relative.pem", "/key.pem"), ("/cert.pem\n", "/key.pem")]:
            with self.subTest(certificate=certificate, key=key), patch.object(backup.core, "command") as command:
                with self.assertRaises(backup.SnapshotError):
                    backup.restore("target", self.root, admin_certificate=certificate, admin_key=key)
                command.assert_not_called()

    def test_certificate_restore_still_refuses_connected_target(self):
        node = self.target()
        node.isolated = False
        with patch.object(backup, "Search", return_value=node), self.assertRaisesRegex(backup.SnapshotError, "networking disabled"):
            backup.restore("target", self.root, admin_certificate="/cert.pem", admin_key="/key.pem")
        node.request.assert_not_called()
        node.prepare.assert_not_called()

    def test_certificate_never_allows_restoring_security_configuration(self):
        self.snapshot["indices"] = [backup.SECURITY_INDEX]
        self.write_manifest()
        with patch.object(backup, "Search") as search, self.assertRaises(backup.SnapshotError):
            backup.restore("target", self.root, admin_certificate="/cert.pem", admin_key="/key.pem")
        search.assert_not_called()


if __name__ == "__main__":
    unittest.main()
