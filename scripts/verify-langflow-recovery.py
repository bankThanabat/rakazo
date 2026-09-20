#!/usr/bin/env python3
"""Restore a real Langflow customer flow with its account and API key into fresh volumes."""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


fixture = module("verify-customer-runtime-backup")
backup = fixture.backup
MODEL = r'''
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def respond(self, code, value):
        body=json.dumps(value).encode()
        self.send_response(code)
        self.send_header('content-type','application/json')
        self.send_header('content-length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path!='/tools' or self.headers.get('Authorization')!='Bearer synthetic-execution-token':
            return self.respond(403, {})
        self.respond(200, {'tools': []})
    def do_POST(self):
        if self.path!='/v1/chat/completions' or self.headers.get('Authorization')!='Bearer synthetic-model-key':
            return self.respond(403, {})
        value=json.loads(self.rfile.read(int(self.headers['content-length'])))
        assert value['model']=='recovery-model'
        assert any(m['role']=='system' and 'synthetic recovery result' in m['content'] for m in value['messages'])
        self.respond(200, {'id':'recovery-completion','object':'chat.completion','created':1,'model':'recovery-model',
            'choices':[{'index':0,'message':{'role':'assistant','content':'Synthetic recovered customer reply.'},'finish_reason':'stop'}],
            'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}})
ThreadingHTTPServer(('127.0.0.1',8787),Handler).serve_forever()
'''
HEALTH = "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/health_check',timeout=3)\""


def docker(*args):
    return backup.core.command(["docker", *args], operation="Disposable Langflow recovery", timeout=240).decode().strip()


def ready(container):
    deadline = time.monotonic() + 180
    while True:
        item = backup.inspect([container])[0]
        if not item["State"]["Running"]:
            raise RuntimeError("Disposable Langflow stopped before readiness")
        if item["State"].get("Health", {}).get("Status") == "healthy":
            return
        if time.monotonic() > deadline:
            raise RuntimeError("Disposable Langflow did not become ready")
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--helper-image", default="postgres:16")
    parser.add_argument("--report-directory", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.report_directory = args.report_directory.absolute()
    args.report_directory.mkdir(mode=0o700)
    root = Path(__file__).resolve().parent.parent
    image = json.loads(docker("image", "inspect", args.image))[0]
    assert not image["Config"].get("Volumes")
    helper = json.loads(docker("image", "inspect", args.helper_image))[0]["Id"]
    prefix = "deskazo-langflow-recovery-" + uuid.uuid4().hex
    owned_containers, owned_volumes = [], []
    target_config = None
    target = None
    owned_network = None
    baseline_volumes = set(docker("volume", "ls", "--quiet").split())
    existing = docker("ps", "--quiet").split()
    before = {c["Id"]: c["State"]["StartedAt"] for c in backup.inspect(existing)} if existing else {}
    report = {"status": "failed", "image": image["Id"], "checks": []}
    files = ['scripts/verify-langflow-recovery.py','scripts/check-langflow-recovery.mts','scripts/customer-runtime-backup.py',
             'scripts/deployment-backup.py','scripts/verify-customer-runtime-backup.py','packages/adapters/src/customer-runtime.ts',
             'infra/langflow/components/rakazo/customer_agent.py']
    report['sourceHashes'] = {name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files}
    temporary = tempfile.TemporaryDirectory(prefix="langflow-recovery-fixture-")
    work = Path(temporary.name)
    try:
        types = args.report_directory/'types.json'
        types.write_text(json.dumps({'extends':str(root/'tsconfig.base.json'),
            'compilerOptions':{'noEmit':True,'lib':['ES2023','DOM','DOM.Iterable']},
            'include':[str(root/'scripts/check-langflow-recovery.mts')]}))
        for name, command in [('types',['pnpm','exec','tsc','--project',str(types)]),
                              ('style',['pnpm','exec','biome','check','scripts/check-langflow-recovery.mts'])]:
            with (args.report_directory/(name+'.log')).open('wb') as output:
                subprocess.run(command,cwd=root,stdout=output,stderr=subprocess.STDOUT,timeout=120,check=True)
        report['checks'].append('TypeScript and formatting checks passed')
        customers, _ = fixture.create_fixture(work, prefix, helper, image, owned_containers, owned_volumes)
        state=args.report_directory/'state.json'
        def check(mode, container, expected_error=None):
            log=args.report_directory/((expected_error or mode).replace(' ','-')+'.log')
            with log.open('wb') as output:
                result=subprocess.run(['pnpm','exec','tsx','scripts/check-langflow-recovery.mts',mode,container,str(state),prefix],
                                      cwd=root,stdout=output,stderr=subprocess.STDOUT,timeout=240)
            if expected_error:
                assert result.returncode != 0 and expected_error in log.read_text() and not state.exists()
            else:
                assert result.returncode==0, 'Langflow adapter recovery check failed; inspect private phase log'
        check('seed',customers['langflow'],'Fixture ownership required')
        owned_network=prefix+'-internal'
        docker('network','create','--internal',owned_network)
        probe=prefix+'-probe'
        owned_containers.append(probe)
        docker('run','--detach','--pull=never','--name',probe,'--network',owned_network,
               '--label','deskazo.langflow-recovery='+prefix,'--memory=64m','--memory-swap=64m',
               '--entrypoint','sleep',image['Id'],'600')
        check('seed',probe,'Fixture network isolation required')
        docker('rm','--force',probe)
        report['checks'].append('checker refuses unlabeled and network-connected owned probes before API mutation')
        original = backup.inspect([customers['langflow']])[0]
        docker('rm','--force',customers['langflow'])
        model = work/'model'
        model.mkdir()
        (model/'model.py').write_text(MODEL)
        mounts=[]
        for mount in original['Mounts']:
            mounts += ['--mount',f"type=volume,source={mount['Name']},target={mount['Destination']},volume-nocopy"]
        mounts += ['--mount',f'type=bind,source={model},target=/app/recovery-fixture,readonly',
                   '--mount',f'type=bind,source={root}/infra/langflow/components/rakazo,target=/app/custom_components/rakazo,readonly']
        environment={
            'LANGFLOW_AUTO_LOGIN':'true','LANGFLOW_SUPERUSER':'recovery-fixture',
            'LANGFLOW_SUPERUSER_PASSWORD':'Synthetic-Recovery-Password-23!',
            'LANGFLOW_SECRET_KEY':base64.urlsafe_b64encode(os.urandom(32)).decode(),
            'LANGFLOW_CONFIG_DIR':'/app/langflow-data','LANGFLOW_DATABASE_URL':'sqlite:////app/langflow-data/langflow.db?timeout=60',
            'LANGFLOW_DEACTIVATE_TRACING':'true','LANGFLOW_LOG_TRACE_LOCALS':'false','LANGFLOW_LOG_LEVEL':'ERROR',
            'LANGFLOW_ALLOW_CUSTOM_COMPONENTS':'false','DO_NOT_TRACK':'true',
        }
        env_args=[value for key,value in environment.items() for value in ('--env',key+'='+value)]
        docker('run','--detach','--pull=never','--name',customers['langflow'],'--network=none',
               '--label','deskazo.langflow-recovery='+prefix,
               '--memory=2g','--memory-swap=2g','--cpus=2','--pids-limit=512',
               '--health-cmd',HEALTH,'--health-interval=3s','--health-timeout=5s','--health-retries=60',
               *mounts,*env_args,image['Id'])
        ready(customers['langflow'])
        print('Source Langflow ready; publishing and executing the real customer component.',flush=True)
        docker('exec','--detach',customers['langflow'],'python','/app/recovery-fixture/model.py')
        check('seed',customers['langflow'])
        report['checks'].append('real adapter publishes and executes installed customer component against synthetic loopback model/tools')
        artifact=args.report_directory/'snapshot'
        backup.backup(argparse.Namespace(**customers,helper_image=helper,output=str(artifact)))
        ready(customers['langflow'])
        backup.verify(artifact)
        docker('stop','--time','90',customers['langflow'])
        restored=args.report_directory/'restored'
        backup.restore(argparse.Namespace(source=str(artifact),output=str(restored)))
        owned_volumes.extend(json.loads((restored/'volumes.json').read_text()))
        target_config=str(restored/'compose.json')
        limits=args.report_directory/'fixture-limits.json'
        limits.write_text(json.dumps({'services':{'langflow':{'mem_limit':'2g','memswap_limit':'2g','cpus':2,'pids_limit':512,
            'labels':{'deskazo.langflow-recovery':prefix},
            'healthcheck':{'test':['CMD-SHELL',HEALTH],'interval':'3s','timeout':'5s','retries':60}}}}))
        docker('compose','--env-file','/dev/null','-f',target_config,'-f',str(limits),'up','--detach','--no-deps','--pull','never','langflow')
        target=docker('compose','--env-file','/dev/null','-f',target_config,'ps','--quiet','langflow')
        ready(target)
        print('Restored Langflow ready; checking saved account, API key, flow and execution.',flush=True)
        docker('exec','--detach',target,'python','/app/recovery-fixture/model.py')
        check('check',target)
        details=backup.inspect([target])[0]
        assert details['HostConfig']['NetworkMode']=='none' and not details['HostConfig']['PortBindings']
        assert details['Image']==image['Id']
        report['checks'].append('fresh restored Langflow accepts saved API key, retains account identity and exact saved flow, and executes the customer component again')
        report['status']='passed'
    except Exception as error:
        report['failureType']=type(error).__name__
        raise
    finally:
        # Retain only bounded fixture diagnostics; all values here are synthetic.
        report['fixtureStatesBeforeCleanup']={}
        for name in [*owned_containers,*([target] if target else [])]:
            value=subprocess.run(['docker','inspect','--format','{{json .State}}',name],capture_output=True,timeout=20)
            if value.returncode==0:
                status=json.loads(value.stdout)
                report['fixtureStatesBeforeCleanup'][name]={key:status[key] for key in ('Running','OOMKilled','ExitCode')}
        if target:
            logs=subprocess.run(['docker','logs','--tail','100',target],capture_output=True,timeout=20)
            (args.report_directory/'target-container.log').write_bytes(logs.stdout+logs.stderr)
        for name in owned_containers:
            logs=subprocess.run(['docker','logs','--tail','100',name],capture_output=True,timeout=20)
            if name.endswith('-langflow'):
                (args.report_directory/'source-container.log').write_bytes(logs.stdout+logs.stderr)
        if target_config:
            subprocess.run(['docker','compose','--env-file','/dev/null','-f',target_config,'down','--volumes'],capture_output=True,timeout=90)
        for name in owned_containers:
            subprocess.run(['docker','rm','--force','--volumes',name],capture_output=True,timeout=45)
        if owned_network:
            subprocess.run(['docker','network','rm',owned_network],capture_output=True,timeout=30)
        report['temporaryNetworkRemoved']=not docker('network','ls','--quiet','--filter','name='+prefix)
        for name in owned_volumes:
            subprocess.run(['docker','volume','rm',name],capture_output=True,timeout=45)
        report['temporaryContainersRemoved']=not docker('ps','--all','--quiet','--filter','name='+prefix)
        if target_config:
            report['temporaryContainersRemoved']=report['temporaryContainersRemoved'] and not docker('compose','--env-file','/dev/null','-f',target_config,'ps','--all','--quiet')
        remaining=set(docker('volume','ls','--quiet').split())
        report['unexpectedNewVolumes']=sorted(remaining-baseline_volumes)
        report['temporaryVolumesRemoved']=not report['unexpectedNewVolumes'] and not remaining.intersection(owned_volumes)
        after=backup.inspect(existing) if existing else []
        report['existingContainersUnchanged']=all(c['State']['Running'] and c['State']['StartedAt']==before[c['Id']] for c in after)
        if not all(report[key] for key in ('temporaryContainersRemoved','temporaryVolumesRemoved','temporaryNetworkRemoved','existingContainersUnchanged')):
            report['status']='failed'
        (args.report_directory/'result.json').write_text(json.dumps(report,indent=2)+'\n')
        temporary.cleanup()
    assert report['status']=='passed'
    print('Real Langflow application recovery passed; owned resources removed.',flush=True)


if __name__=='__main__':
    main()
