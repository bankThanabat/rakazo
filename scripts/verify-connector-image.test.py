#!/usr/bin/env python3
"""Offline checks for the native image verifier's refusal and cleanup paths."""

import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verifier", Path(__file__).with_name("verify-connector-image.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class VerificationSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.archive = Path(self.temporary.name) / "image.tar"
        config = json.dumps({"os": "linux", "architecture": "amd64"}).encode()
        self.digest = "sha256:" + hashlib.sha256(config).hexdigest()
        with tarfile.open(self.archive, "w") as bundle:
            for name, value in [("config.json", config), ("manifest.json", json.dumps([
                {"Config": "config.json", "RepoTags": ["candidate:checked"], "Layers": []}
            ]).encode())]:
                member = tarfile.TarInfo(name)
                member.size = len(value)
                bundle.addfile(member, io.BytesIO(value))
        self.args = argparse.Namespace(archive=self.archive,
            sha256=hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            config_digest=self.digest, image="candidate:checked", existing_container="production")
        self.state = {"id": "production-id", "image": "old-image", "startedAt": "unchanged",
                      "running": True, "health": "healthy"}
        self.calls = []
        for obj, attribute, value in [(verifier.platform, "machine", "x86_64"),
                                      (verifier.platform, "system", "Linux"),
                                      (verifier, "service_state", self.state)]:
            context = patch.object(obj, attribute, return_value=value)
            context.start()
            self.addCleanup(context.stop)
        env = patch.dict(verifier.os.environ, {"DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONTEXT": ""})
        env.start()
        self.addCleanup(env.stop)
        original = Path.read_text
        read = patch.object(Path, "read_text", lambda path, *a, **kw:
            "MemAvailable: 3145728 kB\n" if str(path) == "/proc/meminfo" else original(path, *a, **kw))
        read.start()
        self.addCleanup(read.stop)
        disk = patch.object(verifier.shutil, "disk_usage", return_value=argparse.Namespace(free=10 * 1024**3))
        disk.start()
        self.addCleanup(disk.stop)

    def command(self, *args, **kwargs):
        self.calls.append(args)
        if args[1] == "info":
            return self.temporary.name
        if args[1] == "wait":
            return "137\n"
        return ""

    def test_remote_daemon_rejected_before_inspection(self):
        with patch.dict(verifier.os.environ, {"DOCKER_HOST": "tcp://elsewhere:2375"}), patch.object(verifier, "command") as command:
            with self.assertRaisesRegex(RuntimeError, "local Docker"):
                verifier.verify(self.args, {})
            command.assert_not_called()

    def test_changed_archive_never_loads(self):
        self.args.sha256 = "0" * 64
        with patch.object(verifier, "command", side_effect=self.command):
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                verifier.verify(self.args, {})
        self.assertFalse(any("load" in call for call in self.calls))

    def test_existing_tag_is_not_replaced(self):
        existing = argparse.Namespace(returncode=0, stdout=json.dumps([{"Id": "another-image"}]))
        with patch.object(verifier, "command", side_effect=self.command), patch.object(verifier.subprocess, "run", return_value=existing):
            with self.assertRaisesRegex(RuntimeError, "another image"):
                verifier.verify(self.args, {})
        self.assertFalse(any("load" in call for call in self.calls))

    def oci_manifest(self, config_digest=None):
        value = json.dumps({"schemaVersion": 2, "config": {
            "digest": config_digest or self.digest}, "layers": []}).encode()
        digest = "sha256:" + hashlib.sha256(value).hexdigest()
        index = json.dumps({"manifests": [{"digest": digest,
            "mediaType": "application/vnd.oci.image.manifest.v1+json"}]}).encode()
        with tarfile.open(self.archive, "a") as bundle:
            for name, content in [("index.json", index), ("blobs/sha256/" + digest[7:], value)]:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                bundle.addfile(member, io.BytesIO(content))
        self.args.sha256 = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        return digest

    def test_verified_manifest_id_reaches_runtime_creation(self):
        digest = self.oci_manifest()
        def command(*args, **kwargs):
            output = self.command(*args, **kwargs)
            if args[1] == "create":
                raise RuntimeError("Reached runtime creation")
            return output
        image = {"Id": digest, "Architecture": "amd64", "Os": "linux"}
        with patch.object(verifier, "command", side_effect=command), patch.object(verifier, "inspect", return_value=image), patch.object(verifier.subprocess, "run", return_value=argparse.Namespace(returncode=0, stdout=json.dumps([image]))):
            with self.assertRaisesRegex(RuntimeError, "Reached runtime creation"):
                verifier.verify(self.args, {})

    def test_manifest_for_another_config_never_loads(self):
        self.oci_manifest("sha256:" + "0" * 64)
        with patch.object(verifier, "command", side_effect=self.command), patch.object(verifier.subprocess, "run", return_value=argparse.Namespace(returncode=1)):
            with self.assertRaisesRegex(RuntimeError, "manifest"):
                verifier.verify(self.args, {})
        self.assertFalse(any("load" in call for call in self.calls))

    def test_failed_runtime_removes_only_owned_container(self):
        def inspect(kind, name):
            if kind == "image":
                return {"Id": self.digest, "Architecture": "amd64", "Os": "linux"}
            return {"HostConfig": {"NetworkMode": "none", "Memory": 768 * 1024**2,
                    "MemorySwap": 768 * 1024**2, "NanoCpus": 10**9,
                    "ReadonlyRootfs": True, "PortBindings": {}, "PidsLimit": 128,
                    "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges"],
                    "Tmpfs": {"/app/data": "", "/tmp": ""}},
                    "Mounts": [{"Type": "bind", "Destination": "/verification",
                                "Source": str(Path(verifier.__file__).resolve().parent), "RW": False}],
                    "State": {"OOMKilled": True, "Running": False}}
        report = {}
        with patch.object(verifier, "command", side_effect=self.command), patch.object(verifier, "inspect", side_effect=inspect), patch.object(verifier.subprocess, "run", return_value=argparse.Namespace(returncode=1)):
            with self.assertRaisesRegex(RuntimeError, "runtime check failed"):
                verifier.verify(self.args, report)
        removals = [call for call in self.calls if call[1] == "rm"]
        self.assertEqual(len(removals), 1)
        self.assertTrue(removals[0][-1].startswith("deskazo-connector-native-"))
        self.assertTrue(report["temporaryContainerRemoved"])
        self.assertTrue(report["existingServiceUnchanged"])
        self.assertFalse(any("production" in call for call in self.calls))

    def test_create_failure_preserves_error_and_still_checks_production(self):
        failure = subprocess.CalledProcessError(1, ["docker", "create"])
        def command(*args, **kwargs):
            output = self.command(*args, **kwargs)
            if args[1] == "create":
                raise failure
            if args[1] == "rm":
                self.assertFalse(kwargs["check"])
            return output
        image = {"Id": self.digest, "Architecture": "amd64", "Os": "linux"}
        report = {}
        with patch.object(verifier, "command", side_effect=command), patch.object(verifier, "inspect", return_value=image), patch.object(verifier.subprocess, "run", return_value=argparse.Namespace(returncode=1)), patch.object(verifier, "service_state", return_value=self.state) as service:
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                verifier.verify(self.args, report)
            self.assertIs(caught.exception, failure)
            self.assertEqual(service.call_count, 2)
        self.assertTrue(report["temporaryContainerRemoved"])
        self.assertTrue(report["existingServiceUnchanged"])

    def test_cleanup_failure_still_checks_production(self):
        def command(*args, **kwargs):
            self.command(*args, **kwargs)
            if args[1] == "info":
                return self.temporary.name
            if args[1] in ("create", "rm"):
                raise subprocess.TimeoutExpired(args, 30)
            if args[1] == "ps":
                return "owned-container-still-exists\n"
            return ""
        report = {}
        image = {"Id": self.digest, "Architecture": "amd64", "Os": "linux"}
        with patch.object(verifier, "command", side_effect=command), patch.object(verifier, "inspect", return_value=image), patch.object(verifier.subprocess, "run", return_value=argparse.Namespace(returncode=1)), patch.object(verifier, "service_state", return_value=self.state) as service:
            with self.assertRaisesRegex(RuntimeError, "cleanup"):
                verifier.verify(self.args, report)
            self.assertEqual(service.call_count, 2)
        self.assertFalse(report["temporaryContainerRemoved"])
        self.assertTrue(report["existingServiceUnchanged"])


if __name__ == "__main__":
    unittest.main()
