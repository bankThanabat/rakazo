# Customer conversations

Employees talk to Pi. Customer messages use the staff member's managed local Langflow flow, with stock OpenRAG for knowledge. The Customer inbox on web, Electron, and mobile supports takeover, manual replies, and resuming automatic replies. The user sees one staff identity.

## Deployment

Follow the [local stack and migration guide](customer-v1.md). Configure separate
Langflow and OpenRAG destination-bound service credentials and select an existing saved model
connection. No OpenRAG or Langflow source modification is required.

The API serves `/api/customer-tools` for execution capabilities and
`/api/customer-events/:channelId` for signed messaging webhooks. Configure the
existing `API_INTERNAL_URL` for callbacks from local Langflow, or `API_URL` when
using a reachable HTTPS origin. Do not store a shared customer execution token.

Pi calls `customer_configure` with Langflow `runtime: {credential, baseUrl}`, `modelCredentialId`,
`modelId`, public instructions, and approved workflows. Knowledge additionally
uses `knowledge: {credential, baseUrl}` and a published `knowledgeFilterId`. Rakazo creates a
fresh Langflow flow from its installed component. Users do not need a flow ID or
flow editor. A failed publication leaves the active behavior unchanged.

`customer_instructions` publishes a new instruction revision while retaining existing grants. `customer_configure` and `customer_connect` require owner approval because they grant access or enable automatic replies. Pi requests missing credentials through the normal connection workflow. Customer messages and webhook-triggered Pi runs cannot invoke these management tools.

## Messaging

Conversation history, staff takeover, AI replies, and delivery state use the same
pipeline for every messaging connector. App-specific request fields belong in
connector action schemas and bindings. Supporting another app requires its
receive/send capabilities and a binding; it does not require a separate
conversation implementation.

Send mappings receive `$threadId`, `$customerId`, `$body`, and `$messageId`.
`$messageId` is a stable UUID for one outgoing message part, suitable for a
provider's retry-key field. Reprocessing that part preserves the key; other
messages and parts receive different keys. Providers without retry-key support
can omit it from their send mapping. This does not add deduplication to a provider
that lacks that capability.

The same binding contract supports polling and authenticated webhooks. Provider-specific mappings are data, not routing branches. [Runnable mapping examples](customer-bindings.json) cover LINE, Instagram, and OpenConnector's normalized Telegram updates. Replace the uppercase placeholders with the connected account's identifiers and encrypted secret record IDs. A field may list several paths; the first present one wins, which is how LINE routes group, room and direct chats to distinct threads.

- LINE uses its channel secret and a base64 HMAC-SHA256 signature. Match `destination` against the connected bot's user ID from `get_bot_info`.
- Instagram uses the Meta app secret, `x-hub-signature-256`, and a separate verification token for subscription verification. Batched entries are filtered by the connected account ID before accepting messages. Register the returned URL for message events through the provider's setup workflow.
- Telegram polling uses `telegram.get_updates`. Its cursor is the largest normalized `updateId` plus one, including updates that do not contain text. The worker initializes that offset to zero and advances it only after persisting the accepted page. Disable Telegram webhook delivery before enabling polling.

Other providers can use scalar page cursors, batched or single-event payloads, HMAC-SHA256/SHA1 or token headers, timestamped signatures, and authenticated challenges. Pi inspects the connected action schemas and supplies the mapping. Unsupported non-text events and items missing a mapped identifier are ignored; present but malformed timestamps or identifiers stop checkpoint advancement. This is a text-message receiver, not attachment ingestion.

Apps with an incoming template (`packages/adapters/src/customer-incoming-*.ts`)
offer **Set up incoming messages** on their connected account: select an assistant
and enter the secrets the template lists. Rakazo builds the binding from the
template, provisions the relay when a gateway is configured, and returns the
webhook URL to paste into the provider's settings. New incoming channels keep
automatic replies off until explicitly enabled. Other providers use the approved
`customer_connect` workflow and verified bindings.
Shared signing secrets require an account filter. Duplicate event IDs are accepted
once. Disabled channels, revoked accounts, and forged signatures cannot enqueue work.

## Business actions and knowledge

The managed flow contains one installed Rakazo component that runs the LangChain agent in Langflow with a model-bridge connection and approved tools. It has no ingestion tools or direct OpenSearch access. Its native LangChain tools are discovered through a short-lived execution key that never enters model messages. Rakazo binds that key to the processing message, conversation generation, current grant policy, account, and expiration. Takeover, changed grants, account revocation, and turn completion deny subsequent tool calls.

A business grant has a name, description, input JSON schema, server-bound `connectionId`, and ordered steps. Steps specify an OpenConnector action, fixed input template, `read`/`write` effect, and optional result check. Exact placeholders reference `$input.field`, `$steps.step.field`, `$customerId`, or `$threadId`; customer input cannot replace the connection or authoritative identity.

For a refund workflow, configure these steps:

1. Read the requested order and check its customer identity equals `$customerId`.
2. Read promotion/eligibility data and check the required conditions, such as an active promotion or refundable status.
3. Refund the verified order using values from the earlier results, with a bounded input schema for any customer-supplied amount.

Every write workflow requires a preceding customer ownership check. Identity matching must use the sender identity recorded on the current inbound message by the messaging binding; when a commerce system uses another ID, the approved lookup must establish that association before acting. Each action still passes OpenConnector's schema and account-grant checks. The backend executes checks before writes even if the model skips instructions.

Calls and results are durable. Repeated equivalent calls within an execution return the confirmed result, including when a model produces a different call ID. Uncertain outcomes are never automatically replayed. Provider idempotency keys identify each workflow step. Business eligibility checks must also reject already-completed refunds across distinct customer requests.

`search_knowledge` appears only with an approved knowledge filter. The backend resolves that saved filter, rejects empty or wildcard source lists, and supplies checked concrete filters to OpenRAG; the model cannot expand them. Trusted saved-filter edits affect subsequent searches. Changed knowledge or action grants invalidate an active execution key immediately. Actions already admitted by an external provider may finish.

## History, reporting, and verification

Rakazo owns the durable transcript and supplies its latest 100 scoped records to a fresh upstream conversation. Internal staff history and memory are excluded. Pi can query confirmed reply counts, recent conversation evidence, and snapshots. Tool results remain in the customer execution ledger. Evidence samples are bounded and do not establish promotion attribution or sales by themselves.

Configuration changes cancel obsolete queued/processing work without transferring conversation ownership. Human takeover cancels automatic work and waits for admitted sends to finish. Failed or interrupted external execution requires human attention.

Run `pnpm test` for offline unit tests and `pnpm test:integration` for database journeys. The web journey is available through `pnpm test:e2e --spec=customer`; Electron shares the web UI and its native E2E suite belongs in CI. Run the real LFX component test described in the local stack guide.

Provider subscription setup and a deployed account trial remain deployment checks. Retired native channels remain read-only and are never reactivated implicitly.

Group threads retain a separate sender identity on each inbound message. Business authorization uses that sender, never the first participant in the conversation. Automatic replies carry the same identity into send mappings; group bindings should address `$threadId`. Legacy messages without a recorded sender cannot execute business tools.
