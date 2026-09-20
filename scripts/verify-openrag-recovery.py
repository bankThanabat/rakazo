#!/usr/bin/env python3
"""Exercise paired OpenRAG runtime/search recovery with isolated synthetic state."""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
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
search_fixture = module("verify-customer-search-backup")
search_backup = search_fixture.backup
LABEL = "deskazo.openrag-recovery"
QUERY = "parcel departure schedule"
KNOWLEDGE = "Synthetic orders leave the warehouse in two days."
EMBEDDINGS = r'''
import json
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
queries=[]
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self,status,body):
        data=json.dumps(body).encode()
        self.send_response(status)
        self.send_header('content-type','application/json')
        self.send_header('content-length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.respond(200,{'queries':queries}) if self.path=='/metrics' else self.respond(404,{})
    def do_POST(self):
        if self.path!='/v1/embeddings' or self.headers.get('Authorization')!='Bearer synthetic-embedding-key':
            return self.respond(403,{})
        value=json.loads(self.rfile.read(int(self.headers['content-length'])))
        if value['model']!='text-embedding-3-small': return self.respond(400,{})
        inputs=value['input'] if isinstance(value['input'],list) else [value['input']]
        queries.extend(inputs)
        self.respond(200,{'object':'list','model':value['model'],
            'data':[{'object':'embedding','index':i,'embedding':[1.0,0.0,0.0]} for i in range(len(inputs))],
            'usage':{'prompt_tokens':len(inputs),'total_tokens':len(inputs)}})
ThreadingHTTPServer(('0.0.0.0',8787),Handler).serve_forever()
'''
HTTP = r'''
import json,sys,urllib.request,urllib.error
value=json.load(sys.stdin)
assert value['port'] in (8000,7860,8787)
request=urllib.request.Request('http://127.0.0.1:'+str(value['port'])+value['path'],
    method=value['method'],headers={'content-type':'application/json',**value.get('headers',{})},
    data=json.dumps(value['body']).encode() if 'body' in value else None)
try:
    response=urllib.request.urlopen(request,timeout=20)
except urllib.error.HTTPError as error:
    response=error
raw=response.read(2000000)
try: body=json.loads(raw)
except ValueError: body={'nonJsonResponse':True}
print(json.dumps({'status':response.status,'body':body}))
'''


def docker(*args, input=None):
    result = subprocess.run(["docker", *args], input=input, capture_output=True, timeout=300)
    if result.returncode:
        raise RuntimeError("Disposable Docker operation failed: " + result.stderr.decode()[-2000:])
    return result.stdout.decode().strip()


def owned(container, prefix, network):
    item = backup.inspect([container])[0]
    assert (item["Config"].get("Labels") or {}).get(LABEL) == prefix, "Fixture ownership required"
    assert not item["HostConfig"].get("PortBindings"), "Fixture ports must remain private"
    assert set(item["NetworkSettings"]["Networks"]) == {network}, "Fixture network isolation required"
    info = json.loads(docker("network", "inspect", network))[0]
    assert info["Internal"] and (info.get("Labels") or {}).get(LABEL) == prefix
    return item


def request(container, prefix, network, method, path, body=None, key=None, port=8000):
    owned(container, prefix, network)
    value = {"method": method, "path": path, "port": port}
    if body is not None:
        value["body"] = body
    if key:
        value["headers"] = {"X-API-Key": key}
    return json.loads(docker("exec", "--interactive", container, "/app/.venv/bin/python", "-c", HTTP,
                             input=json.dumps(value).encode()))


def ready(container, prefix, network, port=8000):
    deadline = time.monotonic() + 240
    while True:
        assert owned(container, prefix, network)["State"]["Running"], "Backend stopped before readiness"
        try:
            if request(container, prefix, network, "GET", "/health" if port == 8000 else "/health_check", port=port)["status"] == 200:
                return
        except RuntimeError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("OpenRAG readiness timed out")
        time.sleep(2)



def persisted_state(container, prefix, network):
    owned(container, prefix, network)
    code = """import hashlib,json,sqlite3
from pathlib import Path
connection=sqlite3.connect('file:/app/data/openrag.db?mode=ro',uri=True)
result={}
for table in ('users','user_roles'):
    rows=connection.execute('SELECT * FROM '+table+' ORDER BY 1,2').fetchall()
    assert rows, table+' must contain persisted account state'
    data=json.dumps(rows,default=lambda value:value.hex(),sort_keys=True).encode()
    result[table]={'rows':len(rows),'sha256':hashlib.sha256(data).hexdigest()}
for name in ('private_key.pem','public_key.pem'):
    result[name]=hashlib.sha256((Path('/app/keys')/name).read_bytes()).hexdigest()
print(json.dumps(result))
"""
    return json.loads(docker("exec", container, "/app/.venv/bin/python", "-c", code))


def configure_search(node, backend, prefix, network):
    # Install the image's unchanged OSS auth configuration on this owned node.
    # Security/global state is intentionally outside the search snapshot.
    owned(backend, prefix, network)
    node_info = backup.inspect([node.container])[0]
    assert node_info["Name"].lstrip("/").startswith(prefix + "-search-")
    assert set(node_info["NetworkSettings"]["Networks"]) == {network}
    config = docker("exec", backend, "cat", "/app/securityconfig/config.yml")
    docker("exec", "--interactive", node.container, "sh", "-c", "cat > /tmp/recovery-security.yml",
           input=config.encode())
    docker("exec", node.container, "sh", "-c",
           "/usr/share/opensearch/plugins/opensearch-security/tools/securityadmin.sh "
           "-f /tmp/recovery-security.yml -t config -icl -nhnv "
           "-cacert /usr/share/opensearch/config/root-ca.pem "
           "-cert /usr/share/opensearch/config/kirk.pem "
           "-key /usr/share/opensearch/config/kirk-key.pem")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-image", required=True)
    parser.add_argument("--langflow-image", required=True)
    parser.add_argument("--search-image", required=True)
    parser.add_argument("--helper-image", default="postgres:16")
    parser.add_argument("--core-image", help="Also capture and restore the real core application in the coordinated bundle")
    parser.add_argument("--report-directory", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.report_directory = args.report_directory.absolute()
    args.report_directory.mkdir(mode=0o700)
    for value in (args.backend_image, args.langflow_image, args.search_image, *([args.core_image] if args.core_image else [])):
        assert re.fullmatch(r"sha256:[a-f0-9]{64}", value), "Use cached immutable image IDs"
    endpoint = os.environ.get("DOCKER_HOST") if not os.environ.get("DOCKER_CONTEXT") else None
    endpoint = endpoint or json.loads(docker("context", "inspect"))[0]["Endpoints"]["docker"]["Host"]
    assert endpoint.startswith(("unix://", "npipe://")), "Use a local disposable Docker engine"
    images = {role: json.loads(docker("image", "inspect", value))[0] for role, value in (
        ("backend", args.backend_image), ("langflow", args.langflow_image),
        ("search", args.search_image), ("helper", args.helper_image))}
    if args.core_image:
        images["core"] = json.loads(docker("image", "inspect", args.core_image))[0]
    architecture = docker("info", "--format", "{{.Architecture}}")
    architecture = {"aarch64": "arm64", "x86_64": "amd64"}.get(architecture, architecture)
    assert all(item["Architecture"] == architecture for item in images.values()), "Native images required"
    assert not images["backend"]["Config"].get("Volumes") and not images["langflow"]["Config"].get("Volumes")
    prefix = "deskazo-openrag-recovery-" + uuid.uuid4().hex
    network = prefix + "-internal"
    containers, volumes = [], []
    target_config = None
    core_fixture = None
    existing = docker("ps", "--quiet").split()
    def existing_states():
        return {c["Id"]: {key: c["State"].get(key) for key in ("Running", "StartedAt", "Health")}
                for c in backup.inspect(existing)} if existing else {}
    before = existing_states()
    baseline_volumes = set(docker("volume", "ls", "--quiet").split())
    report = {"status": "failed", "images": {role: item["Id"] for role, item in images.items()}, "checks": []}
    root = Path(__file__).resolve().parent.parent
    files = ["verify-openrag-recovery.py", "check-openrag-retrieval.mts", "customer-runtime-backup.py", "customer-search-backup.py",
             "verify-customer-runtime-backup.py", "verify-customer-search-backup.py", "deployment-backup.py"]
    if args.core_image:
        files += ["coordinated-core-fixture.py", "check-coordinated-core.mts", "verify-product-recovery.py", "customer-deployment-backup.py"]
    report["sourceHashes"] = {"scripts/" + name: hashlib.sha256((root / "scripts" / name).read_bytes()).hexdigest() for name in files}
    report["sourceHashes"]["packages/adapters/src/customer-runtime.ts"] = hashlib.sha256((root / "packages/adapters/src/customer-runtime.ts").read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="openrag-recovery-") as temporary:
        work = Path(temporary)
        try:
            types = args.report_directory / "types.json"
            types.write_text(json.dumps({"extends": str(root / "tsconfig.base.json"),
                "compilerOptions": {"noEmit": True, "lib": ["ES2023", "DOM", "DOM.Iterable"]},
                "include": [str(root / "scripts/check-openrag-retrieval.mts"),
                            *([str(root / "scripts/check-coordinated-core.mts")] if args.core_image else [])]}))
            for name, command in [("types", ["pnpm", "exec", "tsc", "--project", str(types)]),
                                  ("style", ["pnpm", "exec", "biome", "check", "scripts/check-openrag-retrieval.mts"])]:
                with (args.report_directory / (name + ".log")).open("wb") as output:
                    subprocess.run(command, cwd=root, stdout=output, stderr=subprocess.STDOUT, timeout=120, check=True)
            customers, _ = fixture.create_fixture(work, prefix, images["helper"]["Id"], images["backend"], containers, volumes)
            # The checker must refuse an existing unowned fixture before API calls.
            try:
                request(customers["openrag"], prefix, network, "POST", "/keys", {"name": "must-not-exist"})
                raise AssertionError("Unowned fixture accepted")
            except AssertionError as error:
                assert str(error) == "Fixture ownership required"
            docker("network", "create", "--internal", "--label", LABEL + "=" + prefix, network)
            embedding_server = prefix + "-embeddings"
            containers.append(embedding_server)
            docker("run", "--detach", "--pull=never", "--name", embedding_server,
                   "--network", network, "--network-alias", "embeddings", "--label", LABEL + "=" + prefix,
                   "--memory=64m", "--memory-swap=64m", "--cpus=0.5", "--pids-limit=32",
                   "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                   "--entrypoint", "/app/.venv/bin/python", images["backend"]["Id"], "-u", "-c", EMBEDDINGS)
            originals = {role: backup.inspect([customers[role]])[0] for role in ("langflow", "openrag")}
            for role in originals:
                docker("rm", "--force", customers[role])
            flow_mount = next(m for m in originals["openrag"]["Mounts"] if m["Destination"] == "/app/flows")
            backup.core.helper({**flow_mount, "Destination": "/seed"}, images["backend"]["Id"],
                               "cp", "-a", "/app/flows/.", "/seed/", writable=True)
            def mounts(item):
                result = []
                for m in item["Mounts"]:
                    source = m["Name"] if m["Type"] == "volume" else m["Source"]
                    result += ["--mount", f"type={m['Type']},source={source},target={m['Destination']}" + (",volume-nocopy" if m["Type"] == "volume" else "")]
                return result
            langflow_env = {
                "LANGFLOW_AUTO_LOGIN": "true", "LANGFLOW_SUPERUSER": "recovery-fixture",
                "LANGFLOW_SUPERUSER_PASSWORD": "Synthetic-Recovery-Password-23!",
                "LANGFLOW_SECRET_KEY": base64.urlsafe_b64encode(os.urandom(32)).decode(),
                "LANGFLOW_CONFIG_DIR": "/app/langflow-data",
                "LANGFLOW_DATABASE_URL": "sqlite:////app/langflow-data/langflow.db?timeout=60",
                "LANGFLOW_DEACTIVATE_TRACING": "true", "LANGFLOW_LOG_TRACE_LOCALS": "false",
                "LANGFLOW_LOG_LEVEL": "ERROR", "LANGFLOW_ALLOW_CUSTOM_COMPONENTS": "false", "DO_NOT_TRACK": "true",
            }
            def env_args(values):
                return [part for key, value in values.items() for part in ("--env", key + "=" + value)]
            common = ["--detach", "--pull=never", "--network", network, "--label", LABEL + "=" + prefix,
                      "--memory=1g", "--memory-swap=1g", "--cpus=2", "--pids-limit=512"]
            docker("run", *common, "--name", customers["langflow"], "--network-alias", "langflow",
                   *mounts(originals["langflow"]),
                   *(["--mount", f"type=bind,source={root}/infra/langflow/components/rakazo,target=/app/custom_components/rakazo,readonly"] if args.core_image else []),
                   *env_args(langflow_env), images["langflow"]["Id"])
            ready(customers["langflow"], prefix, network, port=7860)
            def start_search(suffix):
                name = prefix + "-search-" + suffix
                containers.append(name)
                data, repository = name + "-data", name + "-repository"
                for volume in (data, repository):
                    volumes.append(volume)
                    docker("volume", "create", volume)
                return search_fixture.start_node(images["search"]["Id"], name, data, repository)
            source_search = start_search("source")
            docker("network", "disconnect", "none", source_search.container)
            docker("network", "connect", "--alias", "opensearch", network, source_search.container)
            backend_env = {
                "OPENSEARCH_HOST": "opensearch", "OPENSEARCH_PORT": "9200", "OPENSEARCH_USERNAME": "admin",
                "OPENSEARCH_NODE_COUNT_CHECK_ENABLED": "false",
                "OPENSEARCH_PASSWORD": "Synthetic-Search-Backup-23!", "LANGFLOW_URL": "http://langflow:7860",
                "LANGFLOW_AUTO_LOGIN": "true", "LANGFLOW_SUPERUSER": langflow_env["LANGFLOW_SUPERUSER"],
                "LANGFLOW_SUPERUSER_PASSWORD": langflow_env["LANGFLOW_SUPERUSER_PASSWORD"],
                "SESSION_SECRET": base64.urlsafe_b64encode(os.urandom(32)).decode(),
                "OPENRAG_ENCRYPTION_KEY": base64.urlsafe_b64encode(os.urandom(32)).decode(),
                "OPENRAG_ENFORCE_PREREQUISITES": "true", "OPENRAG_RBAC_ENFORCE": "true",
                "OPENRAG_RUN_MODE": "oss", "UVICORN_WORKERS": "1", "CACHE_BACKEND": "memory",
                "INGEST_SAMPLE_DATA": "false", "FETCH_OPENRAG_DOCS_AT_STARTUP": "false", "DO_NOT_TRACK": "true",
            }
            docker("run", *common, "--name", customers["openrag"], "--network-alias", "openrag-backend",
                   *mounts(originals["openrag"]), *env_args(backend_env), images["backend"]["Id"])
            ready(customers["openrag"], prefix, network)
            configure_search(source_search, customers["openrag"], prefix, network)
            # Use the real post-onboarding index initializer before API keys are
            # created. Auto-created text mappings cannot perform exact hash lookup.
            initialize = """import asyncio,sys
sys.path.insert(0,'/app/src')
from config.settings import clients,get_opensearch_username,get_opensearch_password
from utils.opensearch_init import init_index
async def run():
    clients.opensearch=clients.create_basic_opensearch_client(get_opensearch_username(),get_opensearch_password())
    try: await init_index()
    finally: await clients.opensearch.close()
asyncio.run(run())
"""
            output = docker("exec", customers["openrag"], "/app/.venv/bin/python", "-c", initialize)
            (args.report_directory / "index-initialization.log").write_text(output)
            mapping = source_search.request("GET", "/api_keys/_mapping")
            assert mapping["api_keys"]["mappings"]["properties"]["key_hash"]["type"] == "keyword"
            print("Source backend ready; checking synthetic keys and saved knowledge scope.", flush=True)
            def api(container, method, path, body=None, key=None, status=200):
                result = request(container, prefix, network, method, path, body, key)
                assert result["status"] == status, f"{method} {path}: expected {status}, got {result['status']}: {result['body']}"
                return result["body"]
            source = customers["openrag"]
            user = api(source, "GET", "/users/me")
            assert user["rbac_enforced"] is True and "kf:read" in user["permissions"]
            api(source, "POST", "/onboarding", {"provider_credentials": {
                "openai": {"api_key": "synthetic-embedding-key", "api_base": "http://embeddings:8787/v1"}}})
            # Reuse the image's real vector field mapping for this tiny synthetic
            # corpus. This tests retrieval and recovery, not ingestion quality.
            mapping_code = """import sys,json
sys.path.insert(0,'/app/src')
from utils.embedding_fields import get_embedding_field_name,build_knn_vector_field
print('RECOVERY_VECTOR='+json.dumps({'field':get_embedding_field_name('openai:text-embedding-3-small'),'mapping':build_knn_vector_field(3)}))
"""
            mapping_output = docker("exec", source, "/app/.venv/bin/python", "-c", mapping_code)
            vector_lines = [line.removeprefix("RECOVERY_VECTOR=") for line in mapping_output.splitlines()
                            if line.startswith("RECOVERY_VECTOR=")]
            assert len(vector_lines) == 1, "Expected exactly one vector mapping result"
            vector = json.loads(vector_lines[0])
            source_search.request("PUT", "/documents/_mapping", {"properties": {vector["field"]: vector["mapping"]}})
            document = {"document_id": "synthetic-selected", "filename": "synthetic-policy.txt", "text": KNOWLEDGE,
                        "page": 1, "mimetype": "text/plain", "owner": "anonymous", "connector_type": "manual",
                        "allowed_users": [], "allowed_groups": [], "allowed_principals": [],
                        "embedding_model": "text-embedding-3-small", "embedding_provider": "openai",
                        "embedding_space_id": "openai:text-embedding-3-small", "embedding_dimensions": 3,
                        vector["field"]: [1.0, 0.0, 0.0]}
            documents = {"selected": document,
                "unselected": {**document, "document_id": "synthetic-unselected", "filename": "unselected-policy.txt", "text": "Unselected synthetic facts must not be returned."},
                "private": {**document, "document_id": "synthetic-private", "owner": "different-fixture-owner", "text": "Private synthetic facts must not be returned."}}
            for identity, value in documents.items():
                source_search.request("PUT", f"/documents/_doc/{identity}?refresh=true", value)
            active = api(source, "POST", "/keys", {"name": "Synthetic recovery active"})
            revoked = api(source, "POST", "/keys", {"name": "Synthetic recovery revoked"})
            api(source, "DELETE", "/keys/" + revoked["key_id"])
            created = api(source, "POST", "/v1/knowledge-filters", {
                "name": "Synthetic recovery policy", "description": "Private synthetic policy scope",
                "queryData": {"query": "synthetic shipping", "limit": 7, "scoreThreshold": 0.4,
                              "filters": {"data_sources": ["synthetic-policy.txt"], "document_types": ["text/plain"],
                                          "owners": ["anonymous", "different-fixture-owner"], "connector_types": ["manual"]}},
            }, active["api_key"], 201)
            filter_id = created["id"]
            expected = api(source, "GET", "/v1/knowledge-filters/" + filter_id, key=active["api_key"])
            foreign = {**created["filter"], "id": "foreign-private", "owner": "different-fixture-owner", "allowed_users": [], "allowed_groups": []}
            source_search.request("PUT", "/knowledge_filters/_doc/foreign-private?refresh=true", foreign)
            state = args.report_directory / "retrieval-state.json"
            state.write_text(json.dumps({"fixture": prefix, "key": active["api_key"], "revokedKey": revoked["api_key"],
                                        "filterId": filter_id, "query": QUERY, "text": KNOWLEDGE}))
            def retrieval(container, phase):
                owned(container, prefix, network)
                before_queries = request(embedding_server, prefix, network, "GET", "/metrics", port=8787)["body"]["queries"].count(QUERY)
                with (args.report_directory / (phase + "-retrieval.log")).open("wb") as output:
                    subprocess.run(["pnpm", "exec", "tsx", "scripts/check-openrag-retrieval.mts", container, str(state), prefix],
                                   cwd=root, stdout=output, stderr=subprocess.STDOUT, timeout=120, check=True)
                after_queries = request(embedding_server, prefix, network, "GET", "/metrics", port=8787)["body"]["queries"].count(QUERY)
                report.setdefault("embeddingQueries", {})[phase] = {"before": before_queries, "after": after_queries}
                assert after_queries == before_queries + 1, "Query must use the embedding provider exactly once"
                report["checks"].append(phase + " customer adapter performs scoped semantic retrieval; revoked/private filters fail before search")
            def check(container):
                assert api(container, "GET", "/users/me") == user
                assert api(container, "GET", "/v1/knowledge-filters/" + filter_id, key=active["api_key"]) == expected
                api(container, "GET", "/v1/knowledge-filters/" + filter_id, key=revoked["api_key"], status=401)
                api(container, "GET", "/v1/knowledge-filters/" + filter_id, status=401)
                # A hidden document and an absent document have the same safe
                # response. Prove the foreign document exists via the admin node.
                denied = api(container, "GET", "/v1/knowledge-filters/foreign-private", key=active["api_key"], status=404)
                missing = api(container, "GET", "/v1/knowledge-filters/missing-synthetic-filter", key=active["api_key"], status=404)
                assert denied == missing == {"success": False, "error": "Knowledge filter not found"}
            assert source_search.request("GET", "/knowledge_filters/_doc/foreign-private")["_source"] == foreign
            check(source)
            retrieval(source, "source")
            report["checks"].append("hidden and missing filters return identical safe HTTP 404 responses")
            report["checks"].append("real source backend enforces API keys, revoked-key rejection and private-filter isolation with RBAC enabled")
            saved_state = persisted_state(source, prefix, network)
            report["persistedState"] = saved_state
            if args.core_image:
                core_fixture = module("coordinated-core-fixture").CoreFixture(
                    work, prefix, images["core"]["Id"], images["helper"]["Id"], network, args.report_directory)
                core_fixture.start()
                core_fixture.knowledge("source", json.loads(state.read_text()))
                report["checks"].append("source core signs in, saves a real customer flow and reads scoped knowledge using encrypted database credentials")
                bundle = args.report_directory / "coordinated-snapshot"
                core_fixture.capture(customers, source_search.container, bundle)
                runtime_snapshot, search_snapshot = bundle / "runtimes", bundle / "search"
                docker("stop", "--time", "90", source, customers["langflow"])
                core_fixture.restore(bundle)
                report["checks"].append("one coordinated bundle restores core PostgreSQL/files while restored application writers remain stopped")
            else:
                # Keep both application writers stopped across the paired captures.
                docker("stop", "--time", "90", source, customers["langflow"])
                runtime_snapshot, search_snapshot = args.report_directory / "runtime-snapshot", args.report_directory / "search-snapshot"
                backup.backup(argparse.Namespace(**customers, helper_image=images["helper"]["Id"], output=str(runtime_snapshot)))
                assert not any(c["State"]["Running"] for c in backup.inspect([source, customers["langflow"]]))
                search_backup.backup(source_search.container, search_snapshot)
            docker("stop", "--time", "90", source_search.container)
            for name in (source, customers["langflow"], source_search.container):
                docker("network", "disconnect", network, name)
            restored = args.report_directory / "restored"
            backup.restore(argparse.Namespace(source=str(runtime_snapshot), output=str(restored)))
            volumes.extend(json.loads((restored / "volumes.json").read_text()))
            target_config = str(restored / "compose.json")
            target_search = start_search("target")
            search_backup.restore(target_search.container, search_snapshot,
                                  admin_certificate="/usr/share/opensearch/config/kirk.pem",
                                  admin_key="/usr/share/opensearch/config/kirk-key.pem")
            docker("network", "disconnect", "none", target_search.container)
            docker("network", "connect", "--alias", "opensearch", network, target_search.container)
            limits = args.report_directory / "fixture-limits.json"
            limits.write_text(json.dumps({"services": {role: {
                "mem_limit": "1g", "memswap_limit": "1g", "cpus": 2, "pids_limit": 512,
                "labels": {LABEL: prefix},
            } for role in ("langflow", "openrag")}}))
            # Restore output remains isolated. Connect only the two new owned
            # containers to the owned network before starting their applications.
            docker("compose", "--env-file", "/dev/null", "-f", target_config, "-f", str(limits), "create", "--pull", "never", "langflow", "openrag")
            targets = {}
            for role, alias in (("langflow", "langflow"), ("openrag", "openrag-backend")):
                name = docker("compose", "--env-file", "/dev/null", "-f", target_config, "ps", "--all", "--quiet", role)
                targets[role] = name
                containers.append(name)
                docker("network", "disconnect", "none", name)
                docker("network", "connect", "--alias", alias, network, name)
            assert not any(item["State"]["Running"] for item in backup.inspect(list(targets.values())))
            docker("start", targets["langflow"])
            ready(targets["langflow"], prefix, network, port=7860)
            assert not backup.inspect([targets["openrag"]])[0]["State"]["Running"]
            report["checks"].append("restored backend stays stopped until the restored Langflow health endpoint succeeds")
            docker("start", targets["openrag"])
            ready(targets["openrag"], prefix, network)
            assert persisted_state(targets["openrag"], prefix, network) == saved_state
            report["checks"].append("restored users, user-role rows and RSA key files exactly match the saved state")
            configure_search(target_search, targets["openrag"], prefix, network)
            print("Restored backend ready; checking original key, account permissions and exact saved filter.", flush=True)
            assert target_search.request("GET", "/knowledge_filters/_doc/foreign-private")["_source"] == foreign
            for identity, value in documents.items():
                assert target_search.request("GET", f"/documents/_doc/{identity}")["_source"] == value
            check(targets["openrag"])
            retrieval(targets["openrag"], "restored")
            report["checks"].append("fresh paired runtime/search restore preserves account permissions, active API key and exact saved filter; revoked and foreign access remain denied")
            if core_fixture:
                core_fixture.verify()
                report["checks"].append("restored real core accepts original session/password and resolves saved flow plus scoped knowledge from restored credentials")
            # Destroy only the disposable target's filter index after all restore
            # comparisons. An infrastructure failure must not look like a missing
            # document, and must not expose the search server's error details.
            target_search.request("DELETE", "/knowledge_filters")
            unavailable = api(targets["openrag"], "GET", "/v1/knowledge-filters/" + filter_id,
                              key=active["api_key"], status=500)
            assert unavailable == {"success": False, "error": "Knowledge filter lookup failed"}
            report["checks"].append("missing filter index remains a safe server failure instead of a document-not-found response")
            report["status"] = "passed"
        except Exception as error:
            report["failureType"] = type(error).__name__
            report["failure"] = str(error)
            raise
        finally:
            if core_fixture:
                try:
                    core_fixture.cleanup()
                except Exception as error:
                    report["coreCleanupFailure"] = type(error).__name__
            for index, name in enumerate(containers):
                result = subprocess.run(["docker", "logs", "--tail", "120", name], capture_output=True, timeout=20)
                if result.returncode == 0:
                    (args.report_directory / f"container-{index}.log").write_bytes(result.stdout + result.stderr)
            for name in containers:
                subprocess.run(["docker", "rm", "--force", "--volumes", name], capture_output=True, timeout=45)
            if target_config:
                subprocess.run(["docker", "compose", "--env-file", "/dev/null", "-f", target_config, "down"], capture_output=True, timeout=60)
            subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=30)
            for name in volumes:
                subprocess.run(["docker", "volume", "rm", name], capture_output=True, timeout=45)
            report["temporaryContainersRemoved"] = all(subprocess.run(["docker", "inspect", name], capture_output=True, timeout=20).returncode != 0 for name in containers)
            report["temporaryNetworkRemoved"] = not docker("network", "ls", "--quiet", "--filter", "name=" + prefix)
            report["unexpectedNewVolumes"] = sorted(set(docker("volume", "ls", "--quiet").split()) - baseline_volumes)
            after = existing_states()
            # Health logs change on every probe; compare status only.
            for states in (before, after):
                for item in states.values():
                    item["Health"] = (item["Health"] or {}).get("Status")
            report["existingContainersUnchanged"] = before == after
            if report.get("coreCleanupFailure") or not report["temporaryContainersRemoved"] or not report["temporaryNetworkRemoved"] or report["unexpectedNewVolumes"] or not report["existingContainersUnchanged"]:
                report["status"] = "failed"
            (args.report_directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    assert report["status"] == "passed"
    print("Paired OpenRAG application recovery passed; owned resources removed.", flush=True)


if __name__ == "__main__":
    main()
