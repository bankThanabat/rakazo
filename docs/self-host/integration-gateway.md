# Rakazo integration gateway

The gateway is part of the Rakazo API. Deploying OpenConnector and Convoy alone
does not run it. Deploy this Rakazo revision and its database migration to the
cloud API and to customer runtimes before enabling gateway connections.

## Responsibilities

- OpenConnector stores provider credentials and executes actions. Its admin token
  stays on the cloud Rakazo API. Direct self-hosted OpenConnector remains supported.
- Convoy verifies supported provider signatures and retries delivery to the cloud API.
  The gateway verifies providers requiring prefixed signatures or a verification
  challenge directly, then stores them in the same durable delivery queue.
- Rakazo authorizes each runtime, provisions Convoy resources, stores incoming
  deliveries in PostgreSQL, and routes them to that runtime.
- The customer's Rakazo API polls outbound every five seconds. It acknowledges a
  cloud delivery after committing the local customer inbox. API processes must
  remain running for polling. Multiple API replicas can safely redeliver the same
  payload because the local inbox deduplicates provider event IDs.
- Rakazo owns chat and reply delivery. OpenRAG and Langflow remain local and are
  not involved in receiving messages or sending staff replies.

## Operator setup

1. Apply migrations with `pnpm --filter @rakazo/db migrate`. Restart the API and
   workers using the same revision. Back up the database before migrating.
2. On the cloud Rakazo instance, use **Server integrations → OpenConnector** to
   configure the private OpenConnector endpoint and admin token. Configure the
   provider OAuth applications there. Do not put that token in customer installs.
3. Open **Host a webhook gateway**. Supply the Convoy endpoint, existing incoming
   project's ID and project API key, and the public HTTPS origin of the Rakazo API.
   Settings are encrypted. Convoy configuration stays on this instance.
4. Route `/api/integration-gateway` and its subpaths to the Rakazo API through
   Caddy. Convoy must reach `/api/integration-gateway/deliver/:routeId` over HTTPS.
   Preserve its `Authorization` header. No customer machine needs a public port.
5. Use the normal Rakazo login and signup policy for cloud customers. A local
   deployment-owner flag never grants cloud operator privileges.

Convoy's incoming source verifier is derived from the provider's incoming template
(header, HMAC algorithm and encoding, or a static token). Convoy compares the decoded
header directly. Providers whose signatures carry a prefix or timestamp, or require
a verification challenge, instead use `/api/integration-gateway/webhook/:routeId`.
The gateway verifies the original request bytes before accepting an event. GET
answers a challenge only when its token matches the enabled route. These routes
reject bearer-only deliveries. The Convoy-to-Rakazo hop uses a separate random bearer for each route over TLS.
The bearer is configured as endpoint authentication, not taken from a provider
payload. Operator changes to Convoy authentication, source verification or route
names can break that guarantee; keep its console operator-only.

Convoy checks endpoint reachability with an unauthenticated HEAD request during
creation. The delivery handler answers HEAD and GET with an empty 204 response,
without looking up accounts or accepting events. POST still requires the route's
delivery secret and an enabled route.

### Shared VPS deployment

Use `infra/compose/gateway-droplet.yml` as `/opt/rakazo-gateway/compose.yml`, with
the Rakazo checkout at `/opt/rakazo-gateway/source`. Keep `.env` beside the Compose
file, readable only by the operator. Supply distinct random values for
`POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `SCREEN_PROXY_SECRET`
and `SANDBOX_SUPERVISOR_TOKEN`. Set `API_URL` and `WEB_ORIGIN` to the public gateway
origin. Keep these values and database backups outside the checkout.

Run `docker compose up -d --build`. The API applies migrations at startup and
listens only on host loopback port 3310. PostgreSQL has no published host port.
This deployment runs no model or sandbox and disables signup. Back up the
database before upgrading the source revision.

When sharing OpenConnector's hostname, replace its existing `reverse_proxy` block
with the handlers in `infra/compose/Caddyfile.gateway`. Keep the site's TLS
configuration. Validate and reload Caddy. Only the integration gateway paths go
to Rakazo; other paths continue to OpenConnector.

Use private administrative access to configure the gateway and issue runtime
keys. This minimal route configuration does not publish Rakazo's administration
UI or customer signup. A public onboarding deployment also needs authenticated
Rakazo web access as described above.

## Runtime setup

1. Sign in to cloud Rakazo and open `/integrations/setup?mode=runtime`.
2. Create a named runtime key. Copy its one-time value.
3. In the local Rakazo server's integration settings, choose **Rakazo gateway**.
   Enter the cloud Rakazo API origin and the runtime key. Mobile can configure
   the same backend and use its account connections. Key issuance and relay
   operator configuration use the web page.
4. Connect an account through Rakazo. Google and other OAuth providers use the
   operator's configured OAuth application. Customers cannot edit it.
5. For a messaging app with an incoming template, choose **Set up incoming
   messages** on the connected account, select an assistant, and enter the secrets
   the template asks for. These differ from the credentials used to connect the
   account (for LINE: the channel access token connects; the channel secret
   verifies webhooks).
6. Rakazo provisions the Convoy source, endpoint and subscription. Copy the
   resulting URL into the provider's webhook settings and verify it there. Rakazo
   does not change provider settings automatically.

Incoming templates live in `packages/adapters/src/customer-incoming-*.ts`, one file
per app, registered in `customer-incoming.ts`. Shared setup, relay, ingress and UI
code use the template. LINE uses account-owned secrets. Instagram uses operator-managed
application secrets and shows only staff assignment and reply controls after OAuth.

A runtime key represents one customer installation. Do not share it between
unrelated customers or clone it into independent databases. The cloud maps it to
its issuing user and workspace; the local server owns authorization among its
local users. Runtime keys can be revoked on the cloud page. Revocation blocks
cloud calls immediately; maintenance removes remote credentials and Convoy
resources afterward. Disconnecting an account also stops its relay.

## Instagram operator setup

Configure the Instagram OAuth application in OpenConnector. Configure its webhook
credentials once on the gateway, using the same application secret. The operator-only
script reads JSON from stdin and encrypts it in the existing settings store:

```sh
pnpm exec tsx scripts/configure-operator-settings.mts incoming-webhook instagram < /secure/webhook-settings.json
```

The input has `appSecret` and `verifyToken` string fields. Supply them through a
secret manager or a protected temporary file outside the checkout. Run with the
gateway's existing database and encryption environment. Never put the values in
shell arguments, source control, or a customer's account form. Direct deployments
configure these settings on their own Rakazo server. Remote runtimes send no
application credentials during incoming setup.

Assign staff to the connected account. Configure the resulting gateway route as
the Meta app callback, verify it with the operator's token, subscribe to `messages`,
and enable the account's webhook subscription in Meta. Publish the app and complete
Meta's required settings and access approval. OAuth alone does not enable delivery.
The route and callback are operator configuration; customer screens hide them.

This implementation supports a single-account pilot per Meta app callback. It does
not automatically subscribe accounts or fan out a shared callback across customer
routes. Do not replace an existing shared callback when adding another account.
Shared-app onboarding needs authenticated account routing and subscription lifecycle
support before serving multiple independent accounts.

## Receiving versus replying

New incoming channels receive messages with conversation ownership set to staff.
Connecting an account or provisioning a webhook does not enable automatic replies.
Staff replies use the binding's send action with the existing stable retry key, so
they never depend on an expiring webhook reply token.

Automatic replies still require published customer behavior and explicit approval
through `customer_channel` with `autoReplies: true`, or `customer_connect`.
Enabling the channel default affects new conversations. Existing conversations
remain staff-owned until explicitly transferred. Disabling automatic replies
moves current conversations to staff ownership.

Automatic replies use the stock Langflow runtime and unmodified OpenRAG knowledge
integration. Install the Rakazo Langflow component and republish old fork-based
behaviors using the [customer runtime migration guide](customer-v1.md).

## Recovery and limits

- Provisioning uses stable route names and recovers a lost create response by
  looking up existing Convoy resources. Retrying setup does not create another
  local channel or change its receive boundary.
- OAuth reconnect creates a fresh upstream account before replacing the binding.
  Cancellation removes the binding to the attempt. Maintenance deletes accounts
  created by late callbacks without touching the active account. Upstream itself
  does not cancel the authorization page.
- Cloud delivery is at least once. Local provider-event deduplication handles
  reconnects and lost acknowledgements. ACK clears the cloud payload; a compact
  receipt remains for replay deduplication.
- Requests are limited to 1 MiB and a runtime can have 1,000 unacknowledged
  deliveries. A full cloud inbox returns an error to Convoy so it retries.
  Delivery pulls contain up to 20 entries. Unacknowledged pulls wait 30 seconds
  before redelivery so a failed batch does not hide other pending deliveries.
- Runtime keys are limited to 10 active keys per cloud user/workspace. Each
  runtime can have 100 active accounts. Existing customer inbox message quotas
  still deliberately reject excess messages.
- Monitor PostgreSQL/Convoy disk use, failed deliveries, and customer runtime
  availability. Back up their databases and Rakazo's encryption key. No production
  throughput claim is implied by the small deployment smoke tests.

## Verification

`pnpm test:integration` runs `packages/adapters/src/integration-gateway.postgres.test.ts`
against a disposable PostgreSQL container with offline provider fixtures; pass
`--spec=<path>` to run only that suite. It never touches the configured application
database. Docker is required.

The test covers ownership denial, forged operator claims, interrupted provisioning,
invalid delivery authentication, offline persistence, duplicate delivery, failed
ACK recovery, staff-only receipt, manual replies and runtime revocation. Web tests
in `apps/web/e2e/open-connector.spec.ts` cover secret entry and the returned webhook
URL at desktop and phone widths. `scripts/verify-convoy.py` checks a deployed relay's
signature verification and retries. Production delivery still needs a real channel
test per provider after deployment.
