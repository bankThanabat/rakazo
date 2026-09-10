# Customer messaging

Customer channels use the existing Chat SDK integration. LINE, Instagram and TikTok use local adapters. No channel is required to run Rakazo.

Apply the database migrations, start the API, then open **Integrations → Channels → Connect channel**. Choose a provider, the receiving account, and the agent whose model will answer. Customer instructions apply only to this channel. Credentials are encrypted using the deployment's existing encryption key and never returned by the channel API.

Saving a channel does not register its webhook with the provider. Copy its Webhook URL into the provider configuration and enable incoming message delivery. The URL must reach the Rakazo API over public HTTPS. Set the deployment's existing `API_URL` to its public API origin; the channel API returns that origin with the generated `/api/v1/customers/channels/{id}/webhook` path on web, desktop and mobile.

| Provider | Account and setup |
| --- | --- |
| LINE | Use the bot user ID returned by the bot info API as Account ID, plus the channel access token and secret. Enable webhooks in LINE Developers. The provider's empty verification request is supported. Replies use push messages because a model response may outlive LINE's reply token. |
| Instagram | Use a professional account with Instagram Login, an Instagram User access token, app secret, verification token and supported Graph API version such as `v25.0`. Subscribe the account to message webhooks. This adapter uses `graph.instagram.com`; Facebook Login Page tokens are a different API variant. |
| TikTok | Requires an approved Business Messaging app and eligible business account. Use its business account ID, access token and client secret. Register `DIRECT_MESSAGE` events using the Business API. The adapter implements the inspected Business Messaging contract, but has not been validated with an approved live account. |

Provider setup links appear beside each saved webhook URL. See the [API research](../research/customer-channel-adapters.md) for permission requirements, source references and TikTok uncertainties. Token rotation is manual: connect the same provider/account again with the replacement credentials. Existing conversations switch to staff control and queued work is cancelled.

## Conversation behavior

Incoming direct messages create separate customer transcripts in the receiving channel's Space. Channel settings, inbox history, takeover, and replies all require the channel owner. Group messages do not activate customer agents. Staff conversations, computer access, internal tools, and CRM/ERP credentials are not included in customer model requests. The assigned agent supplies its model configuration; channel instructions and this customer's history supply the context.

The agent can call `request_human_handoff` to switch the conversation to staff control and mark it "Needs attention" in the inbox. This stops automatic replies; it does not send a separate notification. Resuming clears the flag.

**Take over** stops queued bot work and discards any unfinished generated answer. An outbound request already being sent may finish before takeover completes. Staff can then reply from the same transcript. **Resume bot** activates replies to new customer messages; it does not replay the backlog. Disconnecting cancels queued work. Reconnecting does not automatically resume existing conversations.

Webhook IDs are deduplicated in PostgreSQL. Work has per-conversation leases and generation checks, so multiple API processes cannot intentionally dispatch the same queued message. LINE pushes use a persisted UUID from the first attempt. Network failures and server errors retry with the same key, up to five attempts with exponential backoff, within 24 hours of the queued reply. An accepted duplicate response counts as sent. Other failed or interrupted sends require staff attention because the provider may have accepted a request whose response was lost. “Sent” records provider acceptance, not delivery or reading. Check the provider before manually repeating an ambiguous reply.

Instagram text replies use a 24-hour window from the provider's incoming-message timestamp. LINE uses a conservative seven-day limit. Templates, Instagram's human-agent extension and proactive campaigns are not implemented. Provider rejection, throttling, or an exhausted retry budget moves the conversation to staff control and marks it "Needs attention".

This version sends one text reply per turn, with a shared 900-character limit for staff and bot replies. It preserves supported incoming attachment links, but does not download protected media, upload attachments, transcribe audio, or handle calls. The bot is instructed to ask for a text description. TikTok and LINE non-text events appear as attachment placeholders. The inbox shows the most recent 200 conversations and 200 messages per conversation.

## Deferred scope

CRM/ERP tools are not available to customer runs. Adding them requires explicit customer access rules at the existing tool-provider boundary; the assigned agent's staff tool permissions do not authorize exposing business records to a customer. Per-run usage recording and outbound chunking are outside this implementation.

Customer processing uses the existing background-job queue and reconciliation loop in both API memory-worker and Graphile-worker deployments.

## Verification

Run `bash scripts/verify-customer-channels.sh`. It runs offline adapter conformance, isolated PostgreSQL workflow tests, and browser journeys with screenshots. Docker and the Playwright Chromium browser are required. `API_PORT` and `WEB_PORT` can override the test ports. The suite uses fake provider credentials and HTTP responses; it does not send customer messages or require a hosted account. Native mobile screens are typechecked separately. Live delivery, app approval and account-specific quotas still need verification with the selected provider.
