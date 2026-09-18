# Instagram through OpenConnector

Researched 2026-09-17. Rakazo source: `50f0350d52d87c2f978997586790a6ec75a877d9`. OpenConnector source: [`312b28b88c226edacaf29eabc042bbd52cf0ae7d`](https://github.com/oomol-lab/open-connector/tree/312b28b88c226edacaf29eabc042bbd52cf0ae7d). This is an implementation plan based on source inspection and official documentation. It does not establish the revision of a running deployment or live Meta approval.

## Recommendation

Use Rakazo's existing managed OpenConnector integration and upstream's `instagram` provider. A new Rakazo connector adapter or Meta SDK is unnecessary for the existing actions. Use Instagram Login for Business and Creator accounts. First connect an operator-owned test account and verify profile/media reads. The worktree now includes incoming customer messages for a single-account pilot. Reliable publishing remains a separate increment. Public customer onboarding also depends on Meta's access approval.

The older [OpenConnector adoption assessment](open-connector.md) predates the managed adapter now in this checkout. The current adapter already provides catalog discovery, OAuth setup, scoped account grants, action schema resolution, and HTTP execution with an idempotency key. [Rakazo adapter](../../packages/adapters/src/open-connector.ts), [account lifecycle](../../packages/adapters/src/open-connector-accounts.ts)

## What exists today

Upstream defines nine actions and matching runtime handlers. Every action requires `instagram_business_basic`; the table lists additional permissions. Presence in source does not prove success against a live account. [Action definitions](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/src/providers/instagram/actions.ts), [handlers](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/src/providers/instagram/runtime.ts)

| Actions, all prefixed `instagram.` | Additional permission | Boundary |
| --- | --- | --- |
| `get_current_user`, `list_media`, `get_media` | None | Connected professional account and its media |
| `list_media_comments`, `create_comment`, `reply_to_comment` | `instagram_business_manage_comments` | Top-level comments and explicit replies, no complete inbox or reply-tree synchronization |
| `get_media_insights` | `instagram_business_manage_insights` | Media insights; metric support depends on media type and Meta |
| `publish_media` | `instagram_business_content_publish` | Images, videos, Reels, and 2–10 item carousels; no Stories in this provider |
| `send_message` | `instagram_business_manage_messages` | Text reply to an Instagram-scoped recipient ID; 1,000 UTF-8 bytes |

The provider uses `graph.instagram.com` with Graph API `v25.0` in the inspected source. It exchanges the authorization code for a short-lived token, exchanges that for a long-lived token, and implements Instagram's nonstandard access-token refresh. Upstream explicitly excludes incoming webhooks, inbox synchronization, arbitrary recipient discovery, personal accounts, and cold outreach. [Runtime](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/src/providers/instagram/runtime.ts), [OAuth implementation](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/src/providers/instagram/oauth.ts), [provider guide](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/docs/instagram-oauth.md)

Rakazo now registers LINE and Instagram incoming templates. Instagram resolves the professional account from `user.userId`, verifies Meta signatures at the gateway, and delivers messages through the existing customer inbox. Web, Electron, and mobile offer staff assignment without exposing application credentials. The account's OAuth connection and its incoming webhook subscription remain separate setup steps. [Template](../../packages/adapters/src/customer-incoming-instagram.ts), [gateway](../../packages/adapters/src/integration-gateway.ts), [operator setup](../self-host/integration-gateway.md)

## Meta requirements

Instagram Login supports Business and Creator accounts without a linked Facebook Page. Facebook Login is a separate path with Page linkage, different permissions and tokens, and the `graph.facebook.com` host. Use the Instagram Login path already implemented upstream. Personal accounts are unsupported. [Meta Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/), [Meta Facebook Login collection](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login)

Standard Access covers accounts owned or managed by the app operator with the required dashboard roles/setup. Serving unrelated businesses requires Advanced Access, App Review, and Business Verification. Prepare working reviewer access, permission-specific use cases, test instructions and recordings, and required app settings including a privacy-policy URL. Self-hosting does not remove these requirements. [Meta access levels](https://developers.facebook.com/docs/instagram-platform/overview/), [App Review](https://developers.facebook.com/docs/instagram-platform/app-review/)

Meta's current references support the scope mapping above, including `instagram_business_manage_insights`; do not copy the older `business_*` scope aliases. [Publishing permissions](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Messaging permissions](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/), [Insights permissions](https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/)

Users must initiate DM conversations. Automated replies must stay within 24 hours of the user's message. The Human Agent extension is for human support and must not extend AI replies. This excludes cold outreach even when a token has messaging permission. [Meta messaging rules](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/), [Human Agent purpose](https://developers.facebook.com/docs/instagram-platform/overview/)

The app configures its webhook callback and fields; each account separately activates delivery through `POST /{IG_ID}/subscribed_apps` using its token. Meta says account-level field customization is unsupported, so filter unwanted fields locally. Live mode is required, and comments/live-comments webhooks require Advanced Access. POST signatures use the app secret and the `sha256=` prefix. Therefore a shared app should keep a shared callback and route verified account entries internally rather than replace its callback for each Rakazo customer. This routing choice is an architectural inference from Meta's documented configuration model. [Meta webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks/), [Instagram Login webhook setup](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/webhooks/)

Short-lived tokens last about one hour; long-lived tokens last about 60 days. Refresh requires an unexpired token at least 24 hours old. An expired token cannot be recovered by refresh. [Token exchange](https://developers.facebook.com/docs/instagram-platform/reference/access_token/), [Refresh requirements](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/)

Avoid hardcoding a publishing quota: Meta's publishing guide and quota reference give inconsistent numeric ceilings. Query the account's `content_publishing_limit` usage/configuration if adding quota handling. Media containers expire after 24 hours; publishing must finish within that lifetime. [Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Quota reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit/)

## Account setup

1. Confirm the deployed OpenConnector revision includes the inspected provider. Check the authenticated `/api/providers` catalog for `instagram`, OAuth metadata, and executable actions. Pin a tested source revision in the existing deployment flow.
2. Register the operator's Meta app, add the Instagram product, and configure Business Login for Instagram. Self-hosted OpenConnector does not supply a shared approved Meta app.
3. Read the exact `expectedRedirectUri` from `/api/oauth/configs`. Register that HTTPS URL with Meta. It ends in `/oauth/callback` and belongs to OpenConnector, not Rakazo's incoming webhook endpoint.
4. Store the Instagram App ID and App Secret in the existing server integration setup. Keep the admin credential and provider secrets behind the trusted backend. In the remote-gateway configuration, customers use a runtime key and the operator configures the OAuth app.
5. Start with `instagram_business_basic`. Upstream supports a nonempty `requestedScopes` subset in `PUT /api/oauth/configs/instagram`; its default is all five scopes. Rakazo's current `configureOAuth` method does not forward `requestedScopes`, so use the authenticated operator API for the pilot. If scope selection becomes product UI, extend the shared OAuth configuration contract rather than adding Instagram environment variables.
6. Connect through Rakazo's existing Integrations flow, then verify the selected account with `get_current_user` and `list_media`. Reauthorize when adding capabilities that require ungranted scopes.

These steps reuse the [deployment guide](../self-host/openconnector-droplet.md), [gateway setup](../self-host/integration-gateway.md), [Rakazo OAuth setup implementation](../../packages/adapters/src/open-connector-accounts.ts), and [upstream Instagram setup guide](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/docs/instagram-oauth.md).

## Incoming messages and customer agents

The implemented template binds the professional account, sender, message ID, timestamp, and body. It uses `instagram.send_message` with `recipientId: "$customerId"` and `text: "$body"`, preserves the 1,000-byte limit, and hands off non-text content. Tests cover account filtering, outgoing echoes, read receipts, attachments, and duplicate delivery. The profile's `user.userId` matches Meta's professional account ID; its `user.id` can be app-scoped. [Template](../../packages/adapters/src/customer-incoming-instagram.ts), [fixture tests](../../packages/adapters/src/customer-incoming.test.ts)

The cloud gateway answers the verification challenge and verifies the exact raw-body signature, including `sha256=`, with operator-owned credentials. It enqueues verified events directly into its existing PostgreSQL delivery queue. Customer runtimes poll and acknowledge that queue; Convoy remains the receiver for providers its verifier supports. Direct routes reject the bearer-only delivery path. Enabled route, account, runtime, and membership checks apply before acceptance and again when queueing. [HTTP handler](../../apps/api/src/integration-gateway-http.ts), [gateway tests](../../packages/adapters/src/integration-gateway-webhook.test.ts)

Application secrets live in encrypted operator settings. Remote runtime setup submits no app secret or verification token, and cannot override the signing configuration. Account owners see staff assignment and auto replies. The operator CLI reads credentials from stdin; it does not print them. [Settings](../../packages/adapters/src/customer-incoming-settings.ts), [CLI](../../scripts/configure-operator-settings.mts)

The callback is still route-specific. Shared-app fan-out and automatic account subscription are not implemented. This limits the current setup to a single-account pilot per app callback. Before onboarding independent accounts under one Meta app, add verified account routing and a narrow subscription operation using OpenConnector's stored token. Define reconnection, disconnection, and duplicate subscription behavior. Incoming comments need a separate mapping.

Keep automatic replies off on initial incoming setup. Rakazo's action policy starts internal; the owner must explicitly share actions with customer agents. Existing recommended defaults include `send_message`, `reply_to_comment`, and `create_comment`; a support pilot should share only the actions it needs. Existing reply-target checks bind sends to the current conversation. Add a backend check of the messaging window immediately before sending, including after offline delivery, and hand off expired or ambiguous sends. [Action policy ADR](../adr/0003-shared-connector-actions.md), [reply targeting](../../packages/adapters/src/customer-tool-reply.ts), [incoming setup](../../packages/adapters/src/customer-relay.ts)

## Publishing and token recovery

Video publishing is not ready to promise through the current synchronous path. Upstream can poll a media container once per minute for five minutes. Rakazo's OpenConnector HTTP client aborts after 30 seconds; remote gateway commands also run inside a transaction with a 120-second timeout. Raising one timeout would leave other boundaries unresolved. [Upstream polling](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/src/providers/instagram/runtime.ts), [HTTP client](../../packages/adapters/src/open-connector-catalog.ts), [gateway command transaction](../../packages/adapters/src/integration-gateway.ts)

Before enabling reliable publishing, use durable execution with a persisted operation/container ID and resumable status checks, or add separate create/status/publish operations upstream. Preserve the same execution ID across ambiguous retries. Rakazo currently replaces non-success HTTP responses with a generic error and does not expose upstream's safe `containerId`/`resumable` recovery details. Add a small provider-neutral structured error contract so recovery can inspect those details without exposing tokens. Never blindly create another post after a timeout. This is a proposed change, not existing behavior.

Publishing URLs must be fetchable by Meta; local files and private asset URLs cannot be passed as-is. Reuse an asset delivery mechanism whose access lasts through processing. Start verification with one image, then test video processing, carousel failure, and a lost publish response. [Upstream publishing guide](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/docs/instagram-oauth.md)

Upstream refreshes tokens when actions resolve credentials. Its guide warns that an account unused beyond the actual token lifetime may need reconnection. For a persistent support channel, verify proactive refresh or schedule credential maintenance before expiry; an idle channel should not silently lose its ability to reply. Do not implement token exchange in the frontend. [Upstream token lifecycle](https://github.com/oomol-lab/open-connector/blob/312b28b88c226edacaf29eabc042bbd52cf0ae7d/docs/instagram-oauth.md)

## Delivery sequence and acceptance

| Increment | Completion evidence |
| --- | --- |
| Connect and read | Operator-owned professional account authorizes with minimum scopes; profile/media reads succeed; reconnect, revoked grant, wrong account, and wrong workspace fail safely |
| Direct incoming pilot | Challenge and signature verification pass; only the bound account enters the inbox; staff text reply succeeds; duplicates and echoes cannot trigger duplicate replies |
| Cloud incoming | Verified app webhook fan-out, account subscriptions, secret ownership, durable delivery, offline recovery, and tenant isolation work end to end |
| Customer automation | Explicit action sharing, current-recipient enforcement, response-window checks, and uncertain-send handoff pass |
| Publishing | Public asset delivery and durable container recovery survive processing delays and lost responses without duplicate posts |
| Public onboarding | Meta approves the requested access; a professional account outside app roles completes the same flow |

Use deterministic fixtures for permissions, denied grants, webhook verification, account filtering, expiry, policy windows, and retry recovery. Extend the existing web integration E2E screen for changed setup controls and attach CI screenshots when implementing UI. Electron shares that web UI; verify native mobile setup against the same backend contract. Run live tests only with designated test accounts and explicit permission to post or send.

## Verification performed for this note

`python3 scripts/verify-instagram-research.py` passed nine source checks. It fetches the pinned public upstream files and checks the action/handler inventory, scopes, OAuth URLs, token flows, publishing timeout mismatch, registered Instagram template, gateway prefix verification, and existing send binding. It performs no authenticated provider calls. The checker intentionally fails when these inspected local facts change, prompting an update to this note.

Meta's documentation was read from its public English pages without account credentials. The research changed no deployment and called no authenticated provider API.


## Implementation status

A professional test account completes Instagram OAuth in OpenConnector and the read-only `get_current_user` action succeeds. That verifies account and application setup, not messaging, publishing, or incoming webhooks.

The connect form used to send `authorizationOptionIds: []` even when a provider declares no authorization options. The upstream connection API rejects that field with HTTP 400 (`This provider does not declare authorization options.`); the same request without it starts OAuth. The adapter now omits the field when the provider declares no options and preserves selections when it does. The fix is shared backend code, so web, Electron, and mobile all get it. A regression test fails before the fix and passes after. No database migration is required. [Account lifecycle](../../packages/adapters/src/open-connector-accounts.ts)

Managed webhook credentials live on the gateway; a remote runtime never sends them. Meta accepts the gateway route's callback challenge and the account webhook subscription can be enabled. App publication still needs a privacy-policy URL, and no real incoming DM or outgoing reply has been verified.

`pnpm exec tsx scripts/verify-instagram-gateway.mts` runs the gateway, webhook, incoming, relay, conversation, and HTTP suites against a disposable local database. They cover challenge handling, raw-byte signatures, duplicate events, route revocation, credential ownership, and signed delivery into the customer inbox. The web E2E test covers staff assignment with empty credential input and the absence of app-secret, verification-token, and callback fields.

Auto replies remain off on initial setup, matching LINE. Real delivery acceptance still requires a published Meta app and a fresh message from an eligible test account. Shared-app routing, automatic subscription, and publishing recovery remain open work.
