#!/usr/bin/env python3
"""Recheck pinned public source facts behind the Instagram research. No credentials.

This checks source structure, not execution or live Meta API compatibility.
Requires network access to raw.githubusercontent.com; uses only the standard library.
"""

import json
from pathlib import Path
import re
from urllib.request import urlopen


REVISION = "312b28b88c226edacaf29eabc042bbd52cf0ae7d"
ROOT = Path(__file__).resolve().parents[1]
BASE = f"https://raw.githubusercontent.com/oomol-lab/open-connector/{REVISION}/"


def upstream(path):
    with urlopen(BASE + path, timeout=30) as response:
        return response.read().decode()


def local(path):
    return (ROOT / path).read_text()


def check(condition, description):
    if not condition:
        raise SystemExit(f"FAIL: {description}. Revisit the research note.")
    print(f"PASS: {description}")


actions = upstream("src/providers/instagram/actions.ts")
definition = upstream("src/providers/instagram/definition.ts")
runtime = upstream("src/providers/instagram/runtime.ts")
oauth = upstream("src/providers/instagram/oauth.ts")
names = set(re.findall(r'\bname: "([a-z_]+)"', actions))
expected = {
    "get_current_user", "list_media", "get_media", "list_media_comments",
    "get_media_insights", "publish_media", "create_comment", "reply_to_comment",
    "send_message",
}
check(names == expected, "Upstream declares exactly the nine documented actions")
check(all(re.search(rf"\b{name}(?:\(|:)", runtime) for name in expected),
      "Each declared action has a runtime handler entry")
check(set(re.findall(r'"(instagram_business_[a-z_]+)"', actions)) == {
    "instagram_business_basic", "instagram_business_manage_comments",
    "instagram_business_manage_insights", "instagram_business_content_publish",
    "instagram_business_manage_messages",
}, "Upstream declares the five Instagram Login permissions")
check('https://www.instagram.com/oauth/authorize' in definition
      and 'https://graph.instagram.com' in runtime,
      "Provider uses Instagram Login and the Instagram Graph host")
check('ig_exchange_token' in oauth and 'ig_refresh_token' in oauth,
      "Provider implements Instagram token exchange and refresh")
check('const pollIntervalMs = 60_000;' in runtime
      and 'const maxPollWaits = 5;' in runtime
      and 'AbortSignal.timeout(30000)' in local('packages/adapters/src/open-connector-catalog.ts'),
      "Five-minute upstream polling exceeds Rakazo's 30-second HTTP timeout")
check('instagram: instagramIncoming' in local('packages/adapters/src/customer-incoming.ts'),
      "Guided incoming setup registers Instagram")
binding = json.loads(local('docs/self-host/customer-bindings.json'))['instagram']
check(binding['receive']['webhook']['prefix'] == 'sha256='
      and 'if (verification.prefix || verification.timestamp)'
      in local('packages/adapters/src/convoy-relay.ts'),
      "Instagram signature requires the gateway verifier rather than Convoy HMAC")
check(binding['send']['action'] == 'instagram.send_message'
      and binding['send']['input'] == {'recipientId': '$customerId', 'text': '$body'},
      "Existing Instagram binding matches upstream send-message arguments")
print(f"Source checks complete at upstream {REVISION}; no live API calls or writes performed.")
