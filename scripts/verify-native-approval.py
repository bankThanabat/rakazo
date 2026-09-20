#!/usr/bin/env python3
"""Verify the retained synthetic approval through the same authenticated API as mobile."""
import argparse
import hashlib
import http.cookiejar
import json
from pathlib import Path
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("state", choices=["pending", "denied"])
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
checks = root / "test-report/deskazo-v1/checks"
fixture = json.loads((checks / "native-review-fixture.json").read_text())
origin = fixture["origin"]
assert urllib.parse.urlsplit(origin).hostname == "127.0.0.1", "Use the disposable local server"
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def post(route, data):
    request = urllib.request.Request(origin + route, data=json.dumps(data).encode(), headers={
        "content-type": "application/json", "origin": origin,
    })
    with client.open(request) as response:
        return json.load(response)


post("/api/auth/sign-in/email", {"email": fixture["email"], "password": fixture["password"]})
snapshot = post("/rpc/threads/get", {"json": {"botId": fixture["botId"]}})["json"]
cards = [block for message in snapshot["messages"] for block in message["blocks"]
         if block["kind"] == "ask" and block.get("approvalEffectId")]
assert len(cards) == 1, "Expected exactly one synthetic approval"
card = cards[0]
detail = card["detail"]
request = json.loads(detail)
proposal = request["reviewedProposal"]["native"]
assert proposal["beforeContent"].startswith("Prior of full document.")
assert proposal["content"].startswith("Start of full document.")
assert len(proposal["beforeContent"]) == len(proposal["content"]) == 99999
assert all(proposal[key].endswith("End of full document.") for key in ["beforeContent", "content"])
assert card["status"] == ("pending" if args.state == "pending" else "answered")
if args.state == "denied":
    assert card["answer"] == "deny"
result = {"state": args.state, "detail_characters": len(detail),
          "detail_sha256": hashlib.sha256(detail.encode()).hexdigest(),
          "before_characters": len(proposal["beforeContent"]),
          "after_characters": len(proposal["content"])}
if args.state == "denied":
    before = json.loads((checks / "native-approval-pending.json").read_text())
    assert result["detail_sha256"] == before["detail_sha256"], "Retained review changed"
(checks / f"native-approval-{args.state}.json").write_text(json.dumps(result, indent=2) + "\n")
print(f"Native approval {args.state} verified.")
