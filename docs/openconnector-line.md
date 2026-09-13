# OpenConnector and LINE

Research date: 2026-09-11. The supplied local OpenConnector checkout uses OOMOL's provider and runtime interfaces. Its LINE action definitions, credential type, retry-key forwarding, and HTTP action endpoint were inspected locally and match the capabilities described below. The running service's version must be checked against this interface before deployment.

## Verified OpenConnector support

At commit `a5ab1e569e1781a96084cbcfa59ba72807b4e5b8`, OOMOL OpenConnector has five LINE actions: `line.get_bot_info`, `line.get_profile`, `line.send_push_text`, `line.send_multicast_text`, and `line.send_broadcast_text`. The send actions accept text only, with up to five messages of 5,000 characters each. Push accepts a user, group, or room ID. There is no reply action or incoming-event handler in these LINE provider files. [Action definitions](https://github.com/oomol-lab/open-connector/blob/a5ab1e569e1781a96084cbcfa59ba72807b4e5b8/src/providers/line/actions.ts), [executors](https://github.com/oomol-lab/open-connector/blob/a5ab1e569e1781a96084cbcfa59ba72807b4e5b8/src/providers/line/executors.ts).

The connection uses `api_key` credentials containing a LINE channel access token. Credential validation calls LINE's bot-info endpoint. A send action's optional `retryKey` must be a UUID and becomes `X-Line-Retry-Key`. The provider also offers an authenticated proxy to `https://api.line.me`. [Provider definition](https://github.com/oomol-lab/open-connector/blob/a5ab1e569e1781a96084cbcfa59ba72807b4e5b8/src/providers/line/definition.ts), [runtime](https://github.com/oomol-lab/open-connector/blob/a5ab1e569e1781a96084cbcfa59ba72807b4e5b8/src/providers/line/runtime.ts), [proxy](https://github.com/oomol-lab/open-connector/blob/a5ab1e569e1781a96084cbcfa59ba72807b4e5b8/src/providers/line/executors.ts).

Runtime calls can use `POST /v1/actions/line.send_push_text` with `{"input":{"to":"<recipient-id>","texts":["Hello"],"retryKey":"<uuid>"}}`. Authentication uses a runtime bearer token. A named connection is selected with `x-oo-connector-alias`. HTTP actions support `Idempotency-Key`; MCP `execute_action` does not. Completed failures are also replayed by HTTP idempotency, so retry policy must account for that behavior. Persistent tokens can restrict actions and connections; provider proxy access needs a separate grant. [Runtime API](https://github.com/oomol-lab/open-connector/blob/a5ab1e569e1781a96084cbcfa59ba72807b4e5b8/docs/runtime-api.md).

## LINE requirements

Create a LINE Official Account and enable Messaging API. The channel access token authorizes API calls. For incoming messages, also configure a public HTTPS webhook URL and use the channel secret to verify signatures. [Bot setup](https://developers.line.biz/en/docs/messaging-api/building-bot/).

Validate `X-Line-Signature` using HMAC-SHA256 over the unmodified request body with the channel secret before processing events. [Signature verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/).

LINE delivers events by webhook, not by polling. Accept batches and empty verification requests, acknowledge successful receipt with HTTP 200, process asynchronously, and deduplicate using `webhookEventId`. [Receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/), [webhook reference](https://developers.line.biz/en/reference/messaging-api/nojs/#webhooks).

Reply tokens work once and should be used immediately; use beyond one minute is not guaranteed. Long-running agent work therefore needs push delivery. Push recipients must be friends, joined groups/rooms, or users who messaged the bot in a one-to-one chat within seven days. HTTP 200 does not guarantee receipt by blocked users. [Reply and push reference](https://developers.line.biz/en/reference/messaging-api/nojs/#send-reply-message).

Reuse the same LINE retry key for a repeated logical send. LINE reports an already accepted retry with HTTP 409. OpenConnector's LINE runtime currently maps that response to an error rather than a successful delivery result. Handle this explicitly before enabling automatic retries. [LINE retry behavior](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/), [OpenConnector error handling](https://github.com/oomol-lab/open-connector/blob/a5ab1e569e1781a96084cbcfa59ba72807b4e5b8/src/providers/line/runtime.ts).

## Implemented Rakazo connector

A deployment owner configures one OpenConnector server in integration settings using its base URL and admin token. Each team member can then select LINE on the connectors page and supply the channel access token for their own LINE Official Account. This is a credential form, not LINE Login OAuth. Web and Electron share the same screen; mobile uses its native integrations screen.

Every successfully connected LINE account is automatically available to all current members of the Rakazo team, including members added later. Rakazo's `spaceId` is the team boundary. `Connection.userId` records the creator; the creator alone can rename or disconnect it. Existing integrations retain their user scope. The form discloses “Available to everyone in this team.” only when entering credentials, where it explains who receives access before the user connects.

Apply the connection-team-scope database migration before running the updated API and workers. No new environment variables are required. OpenConnector remains optional; configuration is encrypted in the existing integration provider settings.

### One server, many teams

OpenConnector itself has one administrator principal. Rakazo owns team authorization:

- Each connection gets an opaque, random alias with a keyed team prefix. It never uses OpenConnector's default connection or enumerates all customers' accounts.
- The channel token is sent server-to-server to OpenConnector, which validates and stores it. It is never written into Rakazo's connection rows, tool arguments, or provider references.
- Rakazo provisions a runtime token restricted to that exact remote connection ID and the LINE actions returned by the provider. Proxy access is disabled. The grant is encrypted in Rakazo's secret store; clients and agent tools never receive it.
- Runtime sends use the restricted token and explicit alias. The server admin token is used only for provisioning, verification, and removal. OpenConnector must remain a trusted deployment service; customers must not receive its admin token.
- One shared database predicate controls connection visibility in the API, connector mentions, and agent execution. Every query includes the authenticated team. The adapter also verifies the team alias and looks up its grant within that team before executing.
- Disconnect revokes the runtime token, deletes only that named remote connection, and removes the local grant. Other accounts and teams remain connected. Failed provisioning attempts clean up their remote grant and connection.

This provides account isolation, not dedicated compute or per-team rate limits. OpenConnector and LINE service availability and limits still apply to the shared deployment. Back up the OpenConnector credential store and Rakazo's database and encryption keys together. Changing the OpenConnector endpoint does not migrate existing accounts.

### Supported actions and validation

The adapter exposes the provider's LINE action schemas through Rakazo's existing connector tool and approval flow. All OpenConnector actions are conservatively treated as potentially mutating and use the existing approval policy. Requests are bounded and credential-bearing redirects are rejected. Upstream error bodies are not exposed because they may contain tokens.

The reusable offline HTTP fixture in `packages/adapters/src/open-connector-test-fixture.ts` verifies provisioning, encrypted grants, account-specific execution and removal. Adapter and authenticated RPC tests cover same-team use, cross-team denial, creator-only management, invalid credentials, sibling accounts, scoped runtime grants, and provisioning cleanup. Generic OpenConnector browser tests cover desktop and narrow web account setup and server configuration using fake credentials. A live LINE send still needs deployment credentials and an eligible test recipient.

The credential and connected-account screens reuse Rakazo's existing minimal, monochrome UI. Visual review found no material issues in the captured web screens at 1280px and 390px widths. Electron shares this web implementation. The native mobile screens passed type checking but have not been visually tested in a simulator.

## Incoming LINE conversations

In a connected account's settings on web or desktop, open **Automatic replies**, select an owned bot, enter the public HTTPS origin and the LINE channel secret from Basic settings, then enable replies. Copy the displayed webhook URL into LINE Developers, verify it, and enable **Use webhook**. The HTTPS endpoint must forward to the Rakazo API. Keep the local API, worker, OpenConnector container and tunnel running. A replacement quick tunnel requires updating the origin and LINE webhook URL. Mobile currently directs the owner to web or desktop for this setup.

The route is `POST /api/v1/connections/:connectionId/webhook`. The backend validates the HMAC-SHA256 signature over the original body using the encrypted channel secret. Valid empty verification requests return 200. Missing setup returns 404, invalid signatures return 401, and malformed signed payloads return 400. Requests are limited to 1 MiB. Only direct text messages are handled; groups and other event types are acknowledged without invoking a bot.

Only the connection creator can configure automatic replies, and the selected bot must belong to that creator in the same team. Each account and bot gets a separate bridge namespace; each LINE sender gets an isolated external conversation. The existing durable bridge deduplicates webhook event IDs, stores the incoming transcript and queues bot work asynchronously. A reply uses that account's restricted OpenConnector runtime grant. Disabling replies or disconnecting the account prevents subsequent sends.

Replies use push delivery and a stable account-specific retry UUID. This version retains the bridge's conservative delivery policy: an uncertain delivery is recorded as unconfirmed instead of being resent. It does not enable automatic send retries because the current OpenConnector runtime treats LINE's already-accepted 409 response as an error. Queueing and bot continuation recovery use the existing bridge behavior. Replies longer than five 5,000-unit text messages are truncated without splitting a Unicode surrogate pair.

Generic channel tests in `connection-channels.test.ts` cover encrypted setup, ownership/team boundaries, disable checks, and origin validation with a fake provider. LINE-specific webhook and reply tests are not included. Live verification requires the account owner to supply the channel secret locally and send a message in LINE.
