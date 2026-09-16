# Convoy on a small VPS

This installs the operator-managed Community edition selected in [ADR 0002](../adr/0002-convoy-webhook-relay.md). It uses PostgreSQL and Redis, with no Kafka. Read the [research](../research/convoy.md) for edition limits, licensing, and the remaining customer-machine delivery work.

## Install

Requirements: Docker Engine with Compose, Python 3, Caddy, a DNS record pointing at the VPS, and inbound ports 80 and 443. Cloudflare proxying with Full (strict) is supported.

Create `/opt/convoy` with mode `700`. Copy these files to the server:

- [Compose definition](../../infra/compose/convoy-droplet.yml) to `/opt/convoy/compose.yml`.
- [Setup script](../../scripts/setup-convoy.py) to `/opt/convoy/setup-convoy.py`.
- [Verification script](../../scripts/verify-convoy.py) to `/opt/convoy/verify-convoy.py`.

Run as the deployment administrator, replacing the example origin and login email:

```sh
python3 /opt/convoy/setup-convoy.py \
  --origin https://convoy.example.com \
  --admin-email admin@example.com
```

The script generates independent database, Redis, and JWT secrets, migrates the database, and bootstraps one administrator before starting the web services. Secrets and the generated login password stay in `/opt/convoy/.env` and `/opt/convoy/admin-bootstrap.json`, both mode `600`. Rerunning preserves those secrets and skips account creation when an account already exists. Do not delete the bootstrap file or database to repeat onboarding.

The bootstrap email is the login identifier. Use an address you control if configuring email later. SMTP and password-reset email delivery are not configured by this installation.

The Redis configuration contains its password. It is readable inside the Redis container, with the parent deployment directory restricted to root on the host. Only ports 5005 and 5008 bind to host loopback. PostgreSQL and Redis have no published host ports. Public signup and product analytics are disabled.

## HTTPS

Copy [the Caddy template](../../infra/compose/Caddyfile.convoy) to `/etc/caddy/conf.d/convoy.caddy` and replace `convoy.example.com`. Add this line once to `/etc/caddy/Caddyfile`, preserving existing sites:

```caddy
import /etc/caddy/conf.d/*.caddy
```

Validate and reload:

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

The template routes `/ingest/*` and portal event operations to the agent; the dashboard and management API go to the server. It uses the HTTP certificate challenge through Cloudflare. Caddy retries if DNS is not ready yet.

To retrieve your login in your own VPS terminal:

```sh
python3 -c 'import json; d=json.load(open("/opt/convoy/admin-bootstrap.json")); print("Email:", d["email"]); print("Password:", d["password"])'
```

Keep the login and administrator API tokens on trusted systems. They are not customer credentials.

## Verify the initial deployment

Run this only on the initial idle installation. It creates a disposable project and a temporary HTTPS callback, stops the agent, and restarts Redis. It interrupts webhook ingestion while testing recovery, so do not run it against active customer traffic.

```sh
python3 /opt/convoy/verify-convoy.py \
  --origin https://convoy.example.com \
  --caddy-site /etc/caddy/conf.d/convoy.caddy \
  --initial-deployment
```

The script checks HTTPS, denied unauthenticated access, rejected default credentials, signup configuration, LINE-format HMAC verification, retry after an HTTP 503 response, and recovery of an event queued before Redis restarts. It uses the control-plane ingestion route while the agent is stopped. The normal public ingestion route is unavailable during that pause. It removes the synthetic project and callback afterward; soft-deleted test records may remain in the database.

These checks do not validate a real LINE channel, customer tenant isolation, arbitrary offline periods, or capacity under load. Use `/healthz` and `docker compose ps` for routine checks.

## Operations and limits

- Images are pinned by release and digest. The Compose limits total container memory to 2.5 GiB across the four running services. These limits are an initial small-workload configuration, below Convoy's documented production sizing, and must be measured under expected traffic.
- Redis uses persistent storage, `appendfsync always`, and `noeviction`. The queue has a 256 MiB memory budget and rejects writes when full. This is a durability/throughput tradeoff, not unlimited offline storage.
- Community supports one user, one organization, and two projects. Automatic retention cleanup and customer portals are paid features. Plan a supported retention approach and monitor disk growth before sustained ingestion. Do not bypass license checks to enable cleanup or other paid capabilities.
- The built-in destination block list excludes local/private networks and cloud metadata addresses. Delivery to customer machines needs the separately designed authenticated gateway or tunnel; do not disable these protections globally.
- Database and queue volumes persist across container replacement. Back up PostgreSQL, Redis, deployment configuration, and credentials to storage outside this VPS before upgrades. A single VPS and its local volumes provide no redundancy.
- For updates, back up first, review release migrations, change the image pin, and rerun setup during a maintenance window. Do not use `docker compose down --volumes`. Restore from a tested backup if an incompatible migration needs rollback.

Convoy is the HTTP webhook gateway. Rakazo still owns customer identity, provider-account mapping, authorization, local durable acknowledgment, and offline replay. Installing this stack does not implement those product features.
