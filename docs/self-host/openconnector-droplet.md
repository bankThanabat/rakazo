# OpenConnector on a Droplet

Use [the Compose definition](../../infra/compose/openconnector-droplet.yml) to build an exact source revision of an OpenConnector fork. It uses SQLite and a persistent data volume, enables credential encryption and API authentication, and binds the application to the server's loopback interface.

## Prepare the server

Install Docker Engine and the Docker Compose plugin. Create `/opt/openconnector`, owned by the deployment administrator. Place the Compose definition there as `compose.yml` and extract a `git archive` of the chosen source commit into `/opt/openconnector/source`. Using a Git archive excludes local secrets, data, and uncommitted files.

Create `/opt/openconnector/.env` with mode `600`. Set:

```dotenv
OPENCONNECTOR_REVISION=REPLACE_WITH_SOURCE_COMMIT
OPENCONNECTOR_ORIGIN=http://localhost:3300
OOMOL_CONNECT_ENCRYPTION_KEY=REPLACE_WITH_RANDOM_SECRET
OOMOL_CONNECT_ADMIN_TOKEN=REPLACE_WITH_DIFFERENT_RANDOM_SECRET
OOMOL_CONNECT_RUNTIME_TOKEN=REPLACE_WITH_ANOTHER_RANDOM_SECRET
```

Generate each secret separately with `openssl rand -hex 32`. Keep these values on the server. Preserve the encryption key across restarts and updates; back it up securely with the database. The bootstrap runtime token has unrestricted connection access and must not be distributed to customers.

## Start and verify

From `/opt/openconnector`:

```sh
docker compose build connector
docker compose up -d --wait --wait-timeout 120
curl --fail http://127.0.0.1:3000/health
```

For private browser access, run this on the administrator's computer:

```sh
ssh -N -L 3300:127.0.0.1:3000 root@DROPLET_ADDRESS
```

Open `http://localhost:3300` and authenticate with the admin token. This tunnel setup is for initial private verification. Public OAuth callbacks and customer access need a separately configured HTTPS hostname and reverse proxy. Set `OPENCONNECTOR_ORIGIN` to that HTTPS origin and recreate the service when adding them.

Keep OpenConnector's administrative API behind trusted access. Hosting it does not supply Rakazo's customer authentication or connection-ownership checks. Webhook delivery is a separate planned Convoy deployment with PostgreSQL and Redis, as recorded in [ADR 0002](../adr/0002-convoy-webhook-relay.md).

## HTTPS through Cloudflare

Cloudflare proxying can remain enabled. Install Caddy using its [official Ubuntu packages](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). Copy [the Caddyfile template](../../infra/compose/Caddyfile.openconnector) to `/etc/caddy/Caddyfile`, replacing `connect.example.com` with the actual hostname. Allow inbound TCP ports 80 and 443 in any host and cloud firewalls; keep port 3000 bound to loopback.

The template uses the HTTP certificate challenge because Cloudflare terminates client TLS and cannot forward the TLS-ALPN challenge to Caddy. Cloudflare must let `/.well-known/acme-challenge/*` reach the origin on port 80 without authentication, challenges, or conflicting redirects. Caddy obtains and renews the certificate automatically.

Validate and reload:

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

After Caddy obtains a valid certificate, set Cloudflare's SSL/TLS mode to **Full (strict)**. Update `OPENCONNECTOR_ORIGIN` in the deployment environment to `https://connect.example.com`, using the actual hostname, then run `docker compose up -d --wait`. Preserve all existing secrets.

Verify the public health endpoint, browser console, and rejection of unauthenticated management requests. Check the origin certificate separately from Cloudflare's edge certificate. Never use Flexible mode for this configuration because Caddy redirects HTTP to HTTPS.

## Updates

Back up the database and encryption key before an update. Extract the next source revision into a fresh source directory, update `OPENCONNECTOR_REVISION`, then build and start again. Preserve the existing environment file and named volume. Do not use `docker compose down --volumes` for an update.
