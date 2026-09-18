#!/usr/bin/env python3
"""Build a static deployment policy using operator data kept outside the checkout."""
import argparse
from datetime import date
from html import escape
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--config", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
config = json.loads(args.config.read_text())
required = {"origin", "operator", "email", "date"}
if set(config) != required or any(not isinstance(v, str) or not v.strip() for v in config.values()):
    parser.error("Config needs nonempty origin, operator, email, and date strings")
origin = urlsplit(config["origin"])
if (origin.scheme != "https" or not origin.hostname or origin.netloc != origin.hostname
        or origin.path not in ("", "/") or origin.query or origin.fragment
        or not re.fullmatch(r"[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?", origin.hostname)):
    parser.error("origin must be an HTTPS hostname without a path, port, or credentials")
if not re.fullmatch(r"[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", config["email"]):
    parser.error("email must be a public contact address")
date.fromisoformat(config["date"])
config["origin"] = config["origin"].rstrip("/")
root = Path(__file__).resolve().parents[1]
template = (root / "infra/privacy/index.html").read_text()
rendered = re.sub(r"\{\{(\w+)\}\}", lambda m: escape(config[m[1]], quote=True), template)
if "{{" in rendered:
    parser.error("Unresolved template value")
args.output.mkdir(parents=True, exist_ok=True)
(args.output / "index.html").write_text(rendered)
shutil.copyfile(root / "infra/privacy/policy.css", args.output / "policy.css")
shutil.copyfile(root / "packages/ui-tokens/src/tokens.css", args.output / "tokens.css")
(args.output / "robots.txt").write_text("User-agent: *\nAllow: /\n")
(args.output / "site.caddy").write_text(f'''{origin.hostname} {{
    tls {{
        issuer acme {{
            disable_tlsalpn_challenge
        }}
    }}
    root * /srv/rakazo-privacy
    header {{
        Cache-Control "public, max-age=300, no-transform"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
        Content-Security-Policy "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }}
    @policy path / /privacy /privacy/ /data-deletion /data-deletion/
    rewrite @policy /index.html
    file_server
}}
''')
print("Built policy and Caddy site configuration")
