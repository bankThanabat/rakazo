# Deployment privacy page

`infra/privacy/index.html` is a general policy template for a Rakazo deployment,
including connected apps, customer conversations, AI processing, and deletion
requests. It does not reuse the upstream website's company identity. Review its
statements against your operating practices before publishing. Use a monitored
contact address and maintain a process for responding to requests.

Create a private configuration outside the checkout:

```json
{
  "origin": "https://privacy.example.com",
  "operator": "Example operator",
  "email": "privacy@example.com",
  "date": "2026-09-17"
}
```

Build with:

```sh
python3 scripts/build-integration-policy.py --config /secure/privacy.json --output /tmp/privacy-site
```

The generator validates the configuration, escapes operator values, copies the
shared color tokens, and emits HTML, CSS, robots.txt, and a Caddy site configuration.
Rebuilding with the same input produces the same output. No JavaScript, analytics,
external font requests, forms, or application credentials are included.

Point the hostname's A record to the hosting server. Install `index.html`,
`policy.css`, `tokens.css`, and `robots.txt` under `/srv/rakazo-privacy`, readable
by Caddy. Install `site.caddy` separately in the directory imported by the main
Caddyfile. Keep the configuration and generated output outside source control.
Validate the complete configuration with `caddy validate --config /etc/caddy/Caddyfile`
before reloading Caddy. Back up any existing page and site configuration first.

Caddy obtains the HTTPS certificate automatically. The configuration uses HTTP
certificate validation so a proxied DNS record can work without forwarding the
TLS-ALPN challenge. The hostname must already resolve and port 80 must reach Caddy.
Use strict HTTPS between a reverse proxy and the origin.

Verify public HTTPS access to `/privacy` and `/data-deletion` without signing in.
Both routes serve the policy, whose `#data-deletion` section contains instructions.
Use `/privacy` as the app's privacy-policy URL and `/privacy#data-deletion` for data
deletion instructions. This publishes information only; it does not create an
automatic deletion callback or establish provider approval.
