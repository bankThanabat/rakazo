#!/usr/bin/env python3
"""Check the real Compose update plan against an unchanged worker in an offline stack.

Requires a cached application image. Only this run's
unique project is created/deleted; no published ports or real credentials.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180, cwd=ROOT)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='rakazo/v1-recovery-check:local')
    args = parser.parse_args()
    image = run(['docker', 'image', 'inspect', args.image, '--format', '{{.Id}}'])
    project = 'deskazo-upgrade-order-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='deskazo-upgrade-order-') as directory:
        file = Path(directory) / 'compose.json'
        worker = "require('node:http').createServer((q,r)=>r.end('old-worker')).listen(4100,'0.0.0.0')"
        api = """(async()=>{
          let overlap=false;
          if(process.env.REVISION==='next') {
            try { overlap=(await fetch('http://worker:4100',{signal:AbortSignal.timeout(2000)})).ok; } catch {}
          }
          require('node:http').createServer((q,r)=>r.end(JSON.stringify({revision:process.env.REVISION,overlap}))).listen(3100,'0.0.0.0');
        })().catch(e=>{console.error(e);process.exit(1)})"""
        def health(port):
            return {'test':['CMD','node','-e',f"fetch('http://127.0.0.1:{port}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                    'interval':'1s','timeout':'2s','retries':30}
        config = {'services':{
            'api':{'image':image,'pull_policy':'never','command':['node','-e',api],
                   'environment':{'REVISION':'old'},'healthcheck':health(3100)},
            # Deliberately unchanged between revisions, as an overlay-pinned worker can be.
            'worker':{'image':image,'pull_policy':'never','command':['node','-e',worker],
                      'depends_on':{'api':{'condition':'service_healthy'}},'healthcheck':health(4100)},
        },'networks':{'default':{'internal':True}}}
        file.write_text(json.dumps(config))
        base=['docker','compose','-p',project,'--file',str(file)]
        try:
            run([*base,'up','-d','--wait','--pull','never'])
            config['services']['api']['environment']['REVISION']='next'
            file.write_text(json.dumps(config))
            target={'projectName':project,'composeFiles':[str(file)],'services':['api','worker']}
            code="import {composeUpdatePlan} from './packages/core/src/compose-update.ts';console.log(JSON.stringify(composeUpdatePlan("+json.dumps({'strategy':'pull','target':target})+")))"
            plan=json.loads(run(['docker','run','--rm','--pull','never','--network','none',
                '--mount',f'type=bind,source={ROOT / "packages/core/src"},target=/app/packages/core/src,readonly',
                image,'pnpm','exec','tsx','--eval',code]))
            # Images are already cached. Exercise the actual lifecycle commands,
            # omitting only registry download, which the isolated fixture cannot use.
            for step in plan:
                if step['id'] != 'pull':
                    run([step['command'],*step['args']])
            probe="fetch('http://127.0.0.1:3100').then(r=>r.text()).then(console.log)"
            observed=json.loads(run([*base,'exec','-T','api','node','-e',probe]))
            print(json.dumps({'lifecycle':[s['id'] for s in plan if s['id']!='pull'],'observed':observed}),flush=True)
            assert observed == {'revision':'next','overlap':False}, 'Old worker remained active during API migration/startup'
            print('PASS: all targeted services stop before the new API starts, including unchanged workers')
        finally:
            run([*base,'down','--volumes','--remove-orphans'])


if __name__ == '__main__':
    main()
