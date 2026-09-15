#!/usr/bin/env python3
"""VPS deployment smoke test using a disposable project and an HTTPS callback.

Requires the idle initial deployment. Temporarily stops the agent and restarts
Redis to check queue recovery. Never run while customer traffic is active.
"""

import argparse
import base64
import collections
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import urllib.error
import urllib.request
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="/opt/convoy")
    parser.add_argument("--origin", required=True)
    parser.add_argument("--caddy-site", required=True)
    parser.add_argument("--initial-deployment", action="store_true", required=True)
    args = parser.parse_args()
    os.chdir(args.directory)
    credentials = json.loads(Path("admin-bootstrap.json").read_text())
    site = Path(args.caddy_site)
    original = site.read_text()
    host = urlparse(args.origin).hostname
    header = f"{host} {{\n"
    if header not in original:
        raise SystemExit("Caddy site does not match the supplied origin")
    token = ""

    def request(method, path, payload=None, headers=None, expected=(200, 201, 202), auth=True, origin=None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode() if payload is not None else None
        req_headers = {"Content-Type": "application/json", "User-Agent": "curl/8.0"}
        if auth and token:
            req_headers["Authorization"] = f"Bearer {token}"
        req_headers.update(headers or {})
        req = urllib.request.Request((origin or args.origin) + path, data=body, headers=req_headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        raw = response.read()
        if response.status not in expected:
            # Do not print response bodies, which can contain credentials.
            raise RuntimeError(f"{method} {path.split('?')[0]} returned HTTP {response.status}")
        return json.loads(raw) if raw else {}

    def compose(*command):
        subprocess.run(["docker", "compose", *command], check=True, stdout=subprocess.DEVNULL)

    def reload_caddy():
        subprocess.run(["caddy", "validate", "--config", "/etc/caddy/Caddyfile"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        subprocess.run(["systemctl", "reload", "caddy"], check=True)

    request("GET", "/healthz", auth=False)
    request("GET", "/api/v1/projects", auth=False, expected=(401,))
    request("POST", "/ui/auth/login", {"username": "superuser@default.com", "password": "default"},
            auth=False, expected=(403,))
    request("POST", "/ui/auth/register", {
        "first_name": "Synthetic", "last_name": "Probe", "email": "probe@example.com",
        "password": secrets.token_urlsafe(32), "org_name": "Disposable probe",
    }, auth=False, expected=(400, 403))
    login = request("POST", "/ui/auth/login", {"username": credentials["email"], "password": credentials["password"]}, auth=False)
    token = login["data"]["token"]["access_token"]
    configuration = request("GET", "/ui/configuration")["data"]
    if isinstance(configuration, list) and len(configuration) == 1:
        configuration = configuration[0]
    if configuration.get("is_signup_enabled") is not False:
        raise RuntimeError("Signup is not disabled in the effective instance configuration")
    print("PASS HTTPS health, authentication, disabled signup, default-login rejection", flush=True)

    marker = secrets.token_hex(12)
    callback_path = f"/__deployment_probe/{marker}"
    attempts = collections.Counter()
    delivered = threading.Event()
    secret = secrets.token_hex(32)

    class Receiver(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_HEAD(self):
            self.send_response(200 if self.path == callback_path else 404)
            self.end_headers()

        do_GET = do_HEAD

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if self.path != callback_path:
                self.send_error(404)
                return
            try:
                data = json.loads(body)
            except ValueError:
                data = {}
            kind = data.get("probe")
            status = 200
            if data.get("marker") == marker:
                attempts[kind] += 1
                if kind == "retry" and attempts[kind] == 1:
                    status = 503
                else:
                    delivered.set()
            self.send_response(status)
            self.end_headers()

    receiver = ThreadingHTTPServer(("127.0.0.1", 5010), Receiver)
    threading.Thread(target=receiver.serve_forever, daemon=True).start()
    temporary = original.replace(header, header + f"\thandle {callback_path} {{\n\t\treverse_proxy 127.0.0.1:5010\n\t}}\n", 1)
    project_path = None
    agent_stopped = False
    try:
        site.write_text(temporary)
        reload_caddy()
        org = credentials["organisation_id"]
        result = request("POST", f"/ui/organisations/{org}/projects", {
            "name": "Deployment verification " + marker, "type": "incoming",
            "config": {"strategy": {"type": "linear", "duration": 5, "retry_count": 3}},
        })
        project_id = result["data"]["project"]["uid"]
        project_path = f"/api/v1/projects/{project_id}"
        source = request("POST", project_path + "/sources", {
            "name": "Synthetic LINE signature", "type": "http",
            "verifier": {"type": "hmac", "hmac": {
                "hash": "SHA256", "encoding": "base64", "header": "X-Line-Signature", "secret": secret,
            }},
        })["data"]
        endpoint = request("POST", project_path + "/endpoints", {
            "name": "Synthetic callback", "url": args.origin + callback_path,
            "support_email": "probe@example.com", "http_timeout": 10,
        })["data"]
        request("POST", project_path + "/subscriptions", {
            "name": "Synthetic delivery", "source_id": source["uid"], "endpoint_id": endpoint["uid"],
        })
        ingest_path = urlparse(source["url"]).path

        def ingest(kind, valid=True, origin=None):
            payload = json.dumps({"probe": kind, "marker": marker}).encode()
            signature = base64.b64encode(hmac.digest(secret.encode(), payload, hashlib.sha256)).decode()
            return request("POST", ingest_path, payload,
                           {"X-Line-Signature": signature if valid else "invalid"},
                           expected=(200, 201, 202) if valid else (400, 401, 403), auth=False, origin=origin)

        ingest("invalid", valid=False)
        ingest("retry")
        if not delivered.wait(55) or attempts["retry"] < 2:
            raise RuntimeError("Delivery retry did not reach the synthetic receiver")
        print("PASS LINE-format signature rejection and HTTP retry after 503", flush=True)
        delivered.clear()
        compose("stop", "agent")
        agent_stopped = True
        # The control plane also exposes ingestion. Enqueue there while the
        # agent, which normally serves public ingestion and delivery, is stopped.
        ingest("restart", origin="http://127.0.0.1:5005")
        compose("restart", "redis")
        compose("up", "-d", "--wait", "redis")
        compose("up", "-d", "--wait", "agent")
        agent_stopped = False
        if not delivered.wait(55) or attempts["restart"] < 1:
            raise RuntimeError("Queued event was not delivered after queue restart")
        if attempts["invalid"]:
            raise RuntimeError("Invalidly signed payload reached the callback")
        print("PASS queued event survived Redis restart and agent reconnection", flush=True)
    finally:
        if agent_stopped:
            compose("up", "-d", "--wait", "agent")
        try:
            if project_path:
                request("DELETE", project_path, expected=(200, 202, 204))
        finally:
            if site.read_text() == temporary:
                site.write_text(original)
                reload_caddy()
            else:
                raise RuntimeError("Caddy site changed concurrently; remove the deployment probe manually")
            receiver.shutdown()
            receiver.server_close()
    print("PASS temporary project and callback removed", flush=True)


if __name__ == "__main__":
    main()
