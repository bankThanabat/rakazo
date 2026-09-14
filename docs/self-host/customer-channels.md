# Customer conversations

Employees talk to Pi. Customer messages use the staff member's managed OpenRAG flow. The Customer inbox on web, Electron, and mobile supports takeover, manual replies, and resuming automatic replies. The user sees one staff identity.

## Deployment

1. Apply the Rakazo migrations and deploy the accompanying OpenRAG fork. Enable OpenRAG RBAC and keep its backend API key in an existing compatible connection. Grant `chat:use`, `flows:edit`, and `search:use` when using knowledge retrieval. The existing compatible-endpoint network policy applies to every request.
2. Set the existing `API_URL` to a Rakazo API address reachable from Langflow. The API serves `/api/customer-tools` for execution capabilities and `/api/customer-events/:channelId` for messaging webhooks. Use HTTPS for public deployment. The compose configuration includes the request-variable names used by customer tools; their values arrive per execution and must not be set as shared credentials.
3. Configure OpenConnector and connect the messaging/business accounts through the existing Integrations settings. For webhook providers, store their verification credentials using the existing encrypted secret workflow.

Pi calls `customer_configure` with the compatible connection ID, public instructions, optional published knowledge filter, and approved business workflows. OpenRAG automatically provisions a staff-associated flow from the shipped template. Nobody needs to create a flow or use the OpenRAG editor. Publication is deterministic and immutable; Rakazo activates the returned revision only after publication succeeds. Concurrent configuration changes cannot overwrite a newer revision.

`customer_instructions` publishes a new instruction revision while retaining existing grants. `customer_configure` and `customer_connect` require owner approval because they grant access or enable automatic replies. Pi requests missing credentials through the normal connection workflow. Customer messages and webhook-triggered Pi runs cannot invoke these management tools.

## Messaging

The same binding contract supports polling and authenticated webhooks. Provider-specific mappings are data, not routing branches. [Runnable mapping examples](customer-bindings.json) cover LINE, Instagram, and OpenConnector's normalized Telegram updates. Replace the uppercase placeholders with the connected account's identifiers and encrypted secret record IDs. LINE's example covers direct messages; group routing requires mapping the verified group/room ID as the thread identifier.

- LINE uses its channel secret and a base64 HMAC-SHA256 signature. Match `destination` against the connected bot's user ID from `get_bot_info`.
- Instagram uses the Meta app secret, `x-hub-signature-256`, and a separate verification token for subscription verification. Batched entries are filtered by the connected account ID before accepting messages. Register the returned URL for message events through the provider's setup workflow.
- Telegram polling uses `telegram.get_updates`. Its cursor is the largest normalized `updateId` plus one, including updates that do not contain text. The worker initializes that offset to zero and advances it only after persisting the accepted page. Disable Telegram webhook delivery before enabling polling.

Other providers can use scalar page cursors, batched or single-event payloads, HMAC-SHA256/SHA1 or token headers, timestamped signatures, and authenticated challenges. Pi inspects the connected action schemas and supplies the mapping. Unsupported non-text events are ignored; malformed text-message timestamps or identifiers stop checkpoint advancement. This is a text-message receiver, not attachment ingestion.

After connecting an account, choose **Set up incoming messages** on its Integrations page and select a staff assistant. Setup continues in that assistant's chat, using the secure credential and owner approval flows. Activating a customer channel enables automatic replies. Pi receives the callback URL from `customer_connect`; provider webhook registration is still necessary. Return to the account's connection page to copy the configured URL on web, Electron, or mobile. Channel owners and teammates with shared-channel access can see it independently of who connected the credentials. A shared signing secret requires an account filter. Requests are verified over the original bounded body before normalization. Duplicated event IDs are accepted once. Disabled channels, revoked accounts, stale configurations, and forged signatures cannot enqueue customer work.

## Business actions and knowledge

The managed flow contains the chat input, model, agent, output, and customer-tool component. It has no ingestion tools or direct OpenSearch access. Its native LangChain tools are discovered through a short-lived execution key that never enters model messages. Rakazo binds that key to the processing message, conversation generation, current grant policy, account, and expiration. Takeover, changed grants, account revocation, and turn completion deny subsequent tool calls.

A business grant has a name, description, input JSON schema, server-bound `connectionId`, and ordered steps. Steps specify an OpenConnector action, fixed input template, `read`/`write` effect, and optional result check. Exact placeholders reference `$input.field`, `$steps.step.field`, `$customerId`, or `$threadId`; customer input cannot replace the connection or authoritative identity.

For a refund workflow, configure these steps:

1. Read the requested order and check its customer identity equals `$customerId`.
2. Read promotion/eligibility data and check the required conditions, such as an active promotion or refundable status.
3. Refund the verified order using values from the earlier results, with a bounded input schema for any customer-supplied amount.

Every write workflow requires a preceding customer ownership check. Identity matching must use the sender identity recorded on the current inbound message by the messaging binding; when a commerce system uses another ID, the approved lookup must establish that association before acting. Each action still passes OpenConnector's schema and account-grant checks. The backend executes checks before writes even if the model skips instructions.

Calls and results are durable. Repeated equivalent calls within an execution return the confirmed result, including when a model produces a different call ID. Uncertain outcomes are never automatically replayed. Provider idempotency keys identify each workflow step. Business eligibility checks must also reject already-completed refunds across distinct customer requests.

`search_knowledge` appears only with an approved knowledge filter. The backend supplies that filter to OpenRAG; the model cannot expand it. Changed knowledge or action grants invalidate an active execution key immediately. Actions already admitted by an external provider may finish.

## History, reporting, and verification

Rakazo owns the durable transcript and supplies its latest 100 scoped records to a fresh upstream conversation. Internal staff history and memory are excluded. Pi can query confirmed reply counts, recent conversation evidence, and snapshots. Tool results remain in the customer execution ledger. Evidence samples are bounded and do not establish promotion attribution or sales by themselves.

Configuration changes cancel obsolete queued/processing work without transferring conversation ownership. Human takeover cancels automatic work and waits for admitted sends to finish. Failed or interrupted external execution requires human attention.

Run `pnpm test` for offline unit tests and `pnpm test:integration` for database journeys. The web journey is available through `pnpm test:e2e --spec=customer`; Electron shares the web UI and its native E2E suite belongs in CI. Run `uv run pytest tests/unit/api/test_customer_flow.py tests/unit/api/test_customer_publication.py -q` in the OpenRAG fork.

Provider subscription setup and a deployed account trial remain deployment checks. Retired native channels remain read-only and are never reactivated implicitly.

Group threads retain a separate sender identity on each inbound message. Business authorization uses that sender, never the first participant in the conversation. Automatic replies carry the same identity into send mappings; group bindings should address `$threadId`. Legacy messages without a recorded sender cannot execute business tools.
