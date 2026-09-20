"""Offline checks for the fixed SSH verifier invocation and evidence receipt."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("verify-hosted-connector.py")
spec = importlib.util.spec_from_file_location("hosted_verifier", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HostedVerifierTest(unittest.TestCase):
    def invoke(self, mode, result):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "receipt"
            argv = [str(SCRIPT), "--host", "synthetic-host", "--container",
                    "synthetic-container", "--report-directory", str(report), *mode]
            with patch.object(sys, "argv", argv), patch.object(module.subprocess, "run", return_value=result) as run:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    code = module.main()
            return code, run.call_args_list, json.loads((report / "execution.json").read_text())

    def test_all_modes_execute_exact_audited_source_and_preserve_stdin_entrypoint(self):
        for mode, count, suffix in [([], 2, ["--input-type=module"]),
                                     (["--instagram-history"], 1, ["--input-type=module"]),
                                     (["--instagram-pagination"], 1, ["--input-type=module", "-", "--pagination"])]:
            with self.subTest(mode=mode):
                code, calls, receipts = self.invoke(mode, subprocess.CompletedProcess([], 0, b'{"passed":true}', b''))
                self.assertEqual(code, 0)
                self.assertEqual(len(calls), count)
                for call, receipt in zip(calls, receipts):
                    command = call.args[0]
                    self.assertIn("StrictHostKeyChecking=yes", command)
                    self.assertEqual(shlex.split(command[-1]), ["docker", "exec", "-i", "synthetic-container", "node", *suffix])
                    source = (SCRIPT.parent.parent / receipt["script"]).read_bytes()
                    self.assertEqual(call.kwargs["input"], source)
                    self.assertEqual(receipt["sha256"], hashlib.sha256(source).hexdigest())

    def test_empty_stdout_cannot_silently_pass(self):
        code, calls, receipts = self.invoke([], subprocess.CompletedProcess([], 0, b'', b'private-error'))
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(receipts[0]["report"])
        self.assertNotIn("private-error", json.dumps(receipts))


if __name__ == "__main__":
    unittest.main()
