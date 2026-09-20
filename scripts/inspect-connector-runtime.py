#!/usr/bin/env python3
"""Compare deployed connector source hashes with prepared and upstream source.

Read-only SSH inspection. Reports code paths and hashes, never environment,
connection data or credentials. Build output and installed dependencies are not
compared; this is a source drift check, not an image reproducibility claim.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess


INSPECT = r"""
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files = {};
async function visit(path) {
  for (const entry of await readdir('/app/' + path, {withFileTypes:true})) {
    const name = path + '/' + entry.name;
    if (entry.isDirectory()) await visit(name);
    else if (entry.isFile()) files[name] = createHash('sha256').update(await readFile('/app/' + name)).digest('hex');
    else throw Error('Unexpected source link');
  }
}
await visit('src');
await visit('migrations');
for (const name of ['package.json', 'package-lock.json', 'scripts/healthcheck.ts', 'scripts/ensure-generated.ts', 'scripts/runtime-data.ts']) {
  files[name] = createHash('sha256').update(await readFile('/app/' + name)).digest('hex');
}
files['docker/entrypoint.sh'] = createHash('sha256').update(await readFile('/usr/local/bin/open-connector')).digest('hex');
console.log(JSON.stringify(files));
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--container', required=True)
    parser.add_argument('--prepared-source', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    lock = json.loads((args.prepared_source / 'rakazo-source.json').read_text())
    remote = subprocess.run(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
         '--', args.host, shlex.join(['docker', 'exec', '-i', args.container, 'node', '--input-type=module'])],
        input=INSPECT, capture_output=True, text=True, check=True, timeout=90,
    )
    actual = json.loads(remote.stdout)
    expected = {str(path.relative_to(args.prepared_source)) for folder in ('src', 'migrations')
                for path in (args.prepared_source / folder).rglob('*') if path.is_file()}
    expected.update(['package.json', 'package-lock.json', 'scripts/healthcheck.ts',
                     'scripts/ensure-generated.ts', 'scripts/runtime-data.ts', 'docker/entrypoint.sh'])
    generated = {'src/providers/action-contracts.generated.ts',
                 'src/providers/registry.cloudflare.generated.ts', 'src/providers/registry.generated.ts'}
    actual = {name: value for name, value in actual.items() if name not in generated}
    expected -= generated
    differences = []
    for name in sorted(expected | actual.keys()):
        # Never follow remote-supplied paths outside the prepared source.
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('Invalid source path')
        file = args.prepared_source / name
        wanted = hashlib.sha256(file.read_bytes()).hexdigest() if name in expected else None
        if actual.get(name) == wanted:
            continue
        base = subprocess.run(['git', '-C', str(root / lock['path']), 'show', f"{lock['revision']}:{name}"],
                              capture_output=True, check=False)
        original = hashlib.sha256(base.stdout).hexdigest() if base.returncode == 0 else None
        differences.append({'path': name, 'presentInRuntime': name in actual,
                            'presentInPreparedSource': name in expected,
                            'runtimeMatchesUpstream': actual.get(name) == original})
    print(json.dumps({'readOnly': True, 'preparedTree': lock['tree'],
                      'comparedPaths': len(expected | actual.keys()), 'differences': differences,
                      'migrationFilesMatch': not any(d['path'].startswith('migrations/') for d in differences),
                      'scope': 'Source hashes only; generated output and installed dependencies excluded'}, indent=2))


if __name__ == '__main__':
    main()
