#!/usr/bin/env python3
"""Run the fixed read-only connector checks over SSH and retain source receipts.

Credentials remain in the connector container. No messages, merchant writes or
deployment changes are made. Requires an existing trusted SSH host key.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--report-directory', required=True, type=Path)
    history = parser.add_mutually_exclusive_group()
    history.add_argument('--instagram-history', action='store_true',
                         help='Probe bounded read-only history access instead of identity preflight')
    history.add_argument('--instagram-pagination', action='store_true',
                         help='Also follow at most one conversation/message reference cursor')
    args = parser.parse_args()
    args.report_directory.mkdir(mode=0o700)  # Never overwrite earlier evidence.
    scripts = Path(__file__).resolve().parent
    receipt = []
    checks = ('verify-instagram-history-access.mjs',) if args.instagram_history or args.instagram_pagination else (
        'inspect-openconnector-acceptance.mjs', 'verify-openconnector-identities.mjs')
    for filename in checks:
        source = (scripts / filename).read_bytes()
        # Execute the exact bytes hashed below, not a subsequently reread file.
        script_args = ['--pagination'] if args.instagram_pagination else []
        result = subprocess.run(
            ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
             '--', args.host, shlex.join(['docker', 'exec', '-i', args.container, 'node', '--input-type=module', *(['-', *script_args] if script_args else [])])],
            input=source, capture_output=True, timeout=900 if args.instagram_pagination else 600 if args.instagram_history else 400,
        )
        report = args.report_directory / (Path(filename).stem + '.json')
        record = {'script': 'scripts/' + filename, 'sha256': hashlib.sha256(source).hexdigest(),
                  'arguments': script_args, 'exitCode': result.returncode, 'report': report.name}
        # The audited scripts emit fixed fields only. Do not retain SSH/provider stderr.
        if result.stdout:
            report.write_text(json.dumps(json.loads(result.stdout), indent=2) + '\n')
            report.chmod(0o600)
        else:
            record['report'] = None
        receipt.append(record)
        receipt_file = args.report_directory / 'execution.json'
        receipt_file.write_text(json.dumps(receipt, indent=2) + '\n')
        receipt_file.chmod(0o600)
        if result.returncode or not result.stdout:
            print('Hosted connector check failed; inspect the retained execution receipt.', file=sys.stderr)
            return 1
    print('Read-only connector checks passed; source hashes and sanitized results retained.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
