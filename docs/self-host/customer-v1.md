# Customer support operations

Rakazo owns conversations, customer authorization, history, and reply delivery.
Local Langflow runs customer agents. OpenRAG provides document ingestion
and knowledge search. OpenConnector executes approved connected-service actions.
The optional cloud gateway and Convoy deliver messages to the local Rakazo runtime.

## Install the local stack

Supply OpenRAG and OpenConnector Git checkouts or symlinks at `apps/openrag` and
`infra/open-connector`. [customer-sources.json](../../infra/compose/customer-sources.json)
locks their upstream revisions and patches. Both checkouts must contain their
pinned commits; their current branches and local edits are left alone.

Before building, the script clones both locked commits into fresh temporary
directories. OpenRAG's checksum-locked patch makes hidden and missing knowledge
filters return the same safe HTTP 404 response. A missing filter index remains a
server failure with a safe error message. OpenConnector's patches cover WooCommerce
checkout and payment facts, Instagram comment and message-history reads, account-bound execution, and
a shared fixed Nodemailer dependency. The dependency patch removes older nested
Nodemailer copies without upgrading the mail clients to a new major version.
Build patches also bound compilation concurrency and separate native build work
from target-architecture dependencies. The script verifies each resulting Git tree
against the lock. Only those source files
enter the Docker build. Local credentials, untracked files and operator edits
are not copied. The image is tagged `rakazo-openconnector:<locked-tree>`; the
connector never substitutes the upstream `latest` image. The backend is tagged
`rakazo-openrag-backend:<locked-tree>` and also disables image pulling. OpenRAG
Compose resolves existing data paths against the operator checkout while all four
build contexts use the prepared source. The temporary source is
removed after the build, including on failure. Named data volumes are retained.
Startup runs the Compose projects in sequence; if a later project fails, an
earlier project can remain running. Inspect `customer-stack.sh ps` before recovery.
Inspection and `customer-stack.sh stop` use deployed Compose labels and require
only Docker, Python and the control scripts. They do not read environment files,
verify source locks or prepare build directories. Inspection includes stopped
services and health status. Stopping processes the core project first, then
OpenRAG and OpenConnector. Within each project it stops application containers
before Langflow, OpenSearch and PostgreSQL, retaining each container's configured
stop signal and grace period. A failed stop or detected restart aborts before
proceeding. Pause external deployment/restart automation first; these checks cannot
prevent another Docker client from restarting a service between checks. One-off
commands, unrelated projects and containers without Compose service metadata stay
untouched. These controls never remove containers or volumes.
The source lock fixes application code and dependency declarations. Docker base
images and registry resolution remain separate inputs; it does not promise a
byte-for-byte reproducible image.

For an isolated OpenRAG backend build from the locked commit and patch, run this on a local
Docker build machine with at least 4 GiB total and 3 GiB available memory:

```sh
node scripts/verify-openrag-image.mjs --report-directory=/private/checks/new-openrag-build
```

The report directory must not exist. The verifier exports the pinned source without
changing the operator checkout, builds for the engine's native architecture, and
checks 316 packaged entries against the source, including link targets, the
entrypoint and dependency lock. Its temporary builder is limited to 2 GiB and two
CPUs and is removed afterward with its cache. A passing image remains cached under
the tag and image ID in `result.json`. The build needs registry and package-network
access. It also runs five offline filter-error regressions against the packaged
backend. This does not prove backend startup, knowledge retrieval or restoration,
and does not deploy the image. To check real Compose path resolution without
starting containers, run `node scripts/verify-customer-openrag-compose.mjs`.
Base images and downloaded build tools still follow the upstream Dockerfile.

To verify inspection and graceful shutdown on disposable Compose services, run
`python3 scripts/verify-customer-stack-control.py --image sha256:<cached-native-image-id> --report-directory /private/checks/new-stack-control`.
The cached image must provide `/bin/sh`, `touch`, `sleep` and `true`. This check
uses only a local Docker engine, publishes no ports, and removes its own resources.
It does not stop the deployed customer stack.

Instagram message-history actions require message-management permission. They
return accessible conversation references and individual message details;
Meta limits details to the latest 20 messages per conversation. Account IDs do
not establish human authorship. Owners can explicitly enable `includeMessages`
in a learning source after deploying the patched connector and applying
`20260919220000_instagram_message_learning`. It defaults to false. The initial
scan uses the 30 days before connection; later scans can include newer messages.
Each suggestion requires review of its original messages before approval.
Customer text remains private context, and tracked app sends are excluded.
Uncertain sends hold candidate examples until their receipts are reconciled.
See the [history constraints](../research/deskazo-instagram-message-history.md).

The importer checkpoints one message-history request at a time and waits at
least one second between steps for each source. OpenConnector dispatch also
requires a shared PostgreSQL permit for the verified Instagram account, with
600 ms between admissions across aliases, bots, Spaces and workers. Apply
`20260919230000_connector_rate_limits` before updating the API and worker.
Direct reads and gateway history reads use the same gate within the deployment
database. Separate deployments and clients bypassing Rakazo do not share it.
Waiting reads can be cancelled and must pass current gateway authorization
before dispatch and before returning data. Inactive permit rows are removed
by connector maintenance after a day. Unreadable details receive one retry,
then appear as coverage gaps and are retried on a later scan. A failed page
clears temporary message text from its cursor; retries keep the approved date
window and deduplicate completed batches. Removing the source erases its private
archives and queued suggestions. Existing approved documents retain their audit
history and can be undone.

```sh
node scripts/customer-sources.mjs
scripts/customer-stack.sh up
scripts/customer-stack.sh ps
```

Create the ignored `.env`, `apps/openrag/.env`, and `infra/open-connector/.env` from
the respective examples first. Generate deployment secrets locally. The script
builds the verified sources in separate Compose projects on a shared network.
The OpenRAG administration UI defaults to port 3001 to avoid OpenConnector's 3000.
You can prepare the same connector source for a separately managed host:

```sh
node scripts/customer-sources.mjs --prepare-connector=/new/empty-parent/connector-source
```

The destination itself must not exist. The command prints the locked tree ID and
writes `rakazo-source.json` alongside the prepared source. Use that source as the
connector Docker build context. Keep deployment secrets outside it. Update the
connector before the Rakazo API and worker that require its new endpoint, and
apply Rakazo's database migrations before starting those versions. Back up state
and keep the previous image available as described in the recovery section.

Instagram DMs now use the same durable, account-bound send receipts as comments.
Migration `20260919210000_instagram_message_receipts` must run before the updated
API and worker: it allows confirmed message IDs while checking the intended
recipient. Existing comment receipts retain their physical table and column.
Missing confirmation remains uncertain and must be reconciled without resending.
This tracking does not identify human authors. DM history still requires the
separate source opt-in and staff review described above.

This starts dependencies; it does not prove that a model, document search, or channel
is usable.

The overlay mounts Rakazo's `infra/langflow/components/rakazo` directory read-only
under Langflow's existing `/app/custom_components`. This is a supported installed
extension, not a source patch. Keep `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` and
allow operator-installed component paths. Restart Langflow and republish behavior
after updating the component; restricted mode rejects flows containing older code.
The component requires the LFX 1.11.6 / LangChain 1.3 API used by the pinned OpenRAG
Langflow image. It uses the same LangChain agent engine as Langflow's stock Agent.

For an independently installed Langflow, place the `rakazo` directory under one
of its configured `LANGFLOW_COMPONENTS_PATH` roots. Preserve other components.
Disable tracing and request-body logging for these flows. The provided overlay
sets `LANGFLOW_DEACTIVATE_TRACING=true` and `LANGFLOW_LOG_TRACE_LOCALS=false`.
Transient secret inputs are never saved in published flow templates. Keep the
Langflow API private and restrict its API key to trusted operators.

## Connect and publish

For first-time messaging setup, the operator can configure a default customer
execution service once. Run this on the Rakazo server that owns the customer inbox,
with its database and encryption environment:

```sh
pnpm exec tsx scripts/configure-operator-settings.mts customer-replies < /secure/customer-runtime.json
```

The JSON input contains `baseUrl` for the Langflow API ending in `/api/v1` and
`apiKey`. Keep it outside the checkout and shell history. The settings are encrypted;
the server key is used only by the customer runtime adapter and is never copied to
staff-accessible named secrets or customer devices.

When staff are first assigned to a supported messaging account, Rakazo publishes
basic customer-reply instructions using the assistant's model selection or its
owner's Space default. It does not copy private staff instructions or add business
actions. Existing customer behavior is preserved, including during concurrent
setup attempts. Auto replies remain off until the owner enables them.

The staff assistant can also prepare this setup before connecting a channel.
After owner approval, `customer_initialize` uses the managed service and the
staff agent's selected model. It preserves existing behavior and creates no
channel or named service secret. The assistant can then customize public
instructions, review approved voice and knowledge, and use `customer_preview`
for private practice before the owner enables replies. A missing managed service
still requires operator setup; merchants do not need its internal credentials.

Missing model/service configuration or a publication failure leaves receiving
enabled and returns a setup error. After correcting the dependency, enable auto
replies to retry. Existing accounts without behavior use the same initialization
path when auto replies are enabled. Manual publishing below remains available for
custom instructions, service connections, and approved actions.

Use Rakazo's existing named-secret workflow for service keys. Ask the staff
assistant to call `request_secret` with a credential name, the service origin,
and `{type: "header", name: "x-api-key"}` authentication. Enter the key in the
protected form. `list_secrets` and `customer_inspect` expose names and destinations,
never secret values. Service credentials are scoped to that staff assistant.
Model settings remain exclusively for model connections.

| Connection | Compose base URL | Credential |
| --- | --- | --- |
| Customer execution | `http://rakazo-support-langflow.localhost:7860/api/v1` | Langflow API key |
| Knowledge | `http://rakazo-support-rag.localhost:8000/v1` | OpenRAG API key with `search:use` and `kf:read` |
| Customer model | Existing saved model connection | Existing API key, subscription OAuth, or compatible endpoint |

The base URLs above are internal service addresses. Host development needs
host-reachable addresses. Local HTTP credentials are permitted only for loopback, `.localhost` names, and
`host.docker.internal`. The runtime validates their resolved addresses stay private.
The existing endpoint network policy still applies;
public endpoints require explicit operator opt-in and HTTPS. OpenRAG's direct
backend uses `/v1`; its frontend proxy uses `/api/v1`.

1. Configure OpenRAG ingestion and embeddings through its normal settings. Connect
   its MCP tools when staff need to ingest documents or manage knowledge filters.
   Save a filter selecting explicit public support data sources.
2. Configure OpenConnector and the business/messaging accounts through Integrations,
   or use the [cloud integration gateway](integration-gateway.md).
3. Ask the staff assistant to publish customer behavior using `customer_configure`.
   Supply `runtime: {credential, baseUrl}` for Langflow, with the saved secret name
   and its API base URL. Select `modelCredentialId` and `modelId` for the model,
   public `instructions`, and approved `actions`. For knowledge, also supply
   `knowledge: {credential, baseUrl}` for OpenRAG and `knowledgeFilterId`.
4. Approve the behavior. Rakazo discovers its installed component from Langflow,
   creates a new flow, and activates the revision only after successful publication.
   Users do not need a flow ID or the flow editor. Instruction changes publish a
   new flow. Concurrent updates cannot overwrite a newer behavior revision.
5. Connect incoming messages. **Set up incoming messages** on a connected account
   provisions Convoy when using the gateway; paste the returned webhook URL into
   the provider's webhook settings and verify delivery. Receiving messages starts with automatic replies off. Explicitly enable
   them with `customer_channel` after testing behavior. Generic `customer_connect`
   enables automatic replies and requires approval.
6. Website support uses `customer_website` with approved HTTPS origins. Install the
   returned script. Visitor access is separate from staff login.

The [channel guide](customer-channels.md) explains provider mappings, grants,
handoff, and staff operations. A messaging sender ID is not automatically a CRM
customer ID. Approved workflows must establish the association before returning
customer records or making writes.

## Map historical reply exports

LINE's Messaging API cannot backfill chat text. Check native export availability
in the account before relying on a CSV import. Both bulk backup and per-chat
download required a paid OA Chat package on the inspected Thailand free-plan
account. Other accounts may have different entitlements. When export is
unavailable, use owner-approved voice examples and future authorized replies;
record the missing historical coverage. Do not upgrade a plan without approval.
The native LINE CSV layout remains unvalidated; see the
[native import evidence](../research/deskazo-line-history-import.md).

The staff agent can preview UTF-8 CSV or a JSON array with
`customer_learning_import`. Deskazo's default fields are `thread_id`, optional
`message_id`, `sent_at`, `author_role`, and `text`. For another flat layout,
supply exact field names and confirmed author values. This synthetic example
illustrates the mapping contract; it is not a native LINE export schema:

```json
{
  "mapping": {
    "threadId": "chat",
    "messageId": "id",
    "sentAt": "date",
    "authorRole": "sender",
    "text": "body",
    "businessValues": ["shop"],
    "customerValues": ["visitor"]
  },
  "timezoneOffset": "+07:00"
}
```

Confirm author values with the owner; a display name alone does not prove that
a reply came from the business. Unmapped authors remain unknown and cannot
become voice examples. The preview shows bounded row samples with conversation
IDs, converted dates and roles, plus counts across the whole export. Customer
text stays private context and is excluded from voice examples.

Dates with an explicit offset retain it. Offset-free dates must use ISO ordering,
such as `2026-09-18 10:00:00`, and require an owner-confirmed fixed UTC offset.
`Z` means UTC. Never infer an offset from the browser or account language.
The supplied offset must be correct for every local timestamp. If daylight-saving
or historical offset changes apply, supply explicit offsets per row before import.
IANA zone names and ambiguous formats such as `09/10/2026` are not interpreted.

After review, archive the same content and options with
`customer_learning_archive_import`, then approve `customer_learning_history_start`.
The original content, mapping, offset and initial window stay fixed across
reexports and resumed jobs. Equivalent normalized evidence reuses the archive;
it does not change an existing import's interpretation. Source removal erases
the content and mapping and stops its jobs, while duplicate hashes remain.
Account export includes the private source and its interpretation while retained.

Apply migration `20260920000000_learning_import_mapping` before updating the API
and worker. Repeat offline checks with
`bash scripts/verify-learning-import-mapping.sh`. A current authorized LINE OA
export is still needed to validate its actual columns, authorship and date format.

## Configure human-attention criteria

Ask the staff agent to configure Jev through `customer_assessment` after saving
a bearer credential for the assessment service. Optional `config.criteria`
contains additional merchant handoff conditions, such as asking staff about
wholesale orders of 50 or more items. The owner reviews the exact settings before
they are saved. Read `customer_inspect` before editing; an empty criteria string
clears additional conditions, and `config: null` disables the optional assessor.

Additional criteria can request a handoff but cannot cancel the built-in human
request, failed-help, verification or approval rules. Missing or low-confidence
assessment answers require staff review. Changing settings pauses active cases
and invalidates in-flight assessments; staff must explicitly return control.
Criteria are sent to the assessment provider with conversation context and kept
in the private staff decision audit with the selected model. They are not sent
in customer replies. Keep criteria within 2,000 characters; settings that cannot
be displayed in full for approval must be shortened or corrected first.

Run `bash scripts/verify-customer-assessment.sh` for the offline contract,
approval and PostgreSQL checks. These checks use a provider fixture and do not
establish live Jev accuracy on merchant conversations.

## Share connector actions

Open a connected account's **Available actions**. Leave **Internal** on for
Pi staff only, or turn it off to also allow the customer agent. **Use defaults**
previews the recommended shared actions before saving. Settings apply per account.

After upgrading, share the channel's send action before enabling automatic replies.
Also share every action used by an existing customer workflow. New actions remain
internal until explicitly configured. See [shared connector actions](../adr/0003-shared-connector-actions.md)
for execution scope and rollout details.

## Model bridge and knowledge scope

Each turn receives an expiring model-bridge capability for the approved connection
and model. Rakazo revokes it after execution; expiry also denies access after a
worker crash. Langflow receives no upstream model OAuth token or provider API key.
The bridge supplies completions while the agent loop stays in local Langflow.
The existing [standalone model bridge](../model-bridge.md) remains available.

Tool credentials are scoped to the processing message, current policy, and customer
identity. They are closure data, never model-visible arguments. The customer agent
has no staff computer, staff memory, ingestion tools, or direct OpenSearch access.

Knowledge search resolves the approved saved filter through the separate OpenRAG
credential. It rejects empty or wildcard sources, then sends the checked concrete
filters to stock `/v1/search`. The model can supply only a query. Trusted edits to
the saved filter affect later searches; keep filter editing restricted to the
publishers who may change customer-visible knowledge. OpenRAG enforces its own
API-key user's document access too.

## Migration from the old fork

Apply Rakazo's database migrations and update the API and worker together. Old
behavior rows are retained, but the new runtime rejects old fork flow references
and missing model selections. Republish each behavior with the separate Langflow,
model, and optional OpenRAG knowledge connections before resuming automatic replies.
A failed turn is handed to staff rather than silently using another model or flow.
Existing inbox history, channel mappings, and manual replies remain in Rakazo.

Remove old patched images only after the replacement passes an isolated test.
No `/customer/flows`, `/customer/search`, or custom OpenRAG chat extensions are used.
The tracked source patch and its installer have been removed.

## Recovery and retention

The agent gets at most 100 authorized transcript records and a fresh opaque Langflow
session for each turn. It does not write Langflow chat messages or use a persisted
agent checkpointer. External model providers and infrastructure logs have their own
retention; deleting a Rakazo conversation cannot erase those systems.

Uncertain tool outcomes and interrupted sends require staff investigation. Never
blindly replay writes. Per-turn deduplication is not business idempotency across
separate customer messages. Validate provider-side duplicate-operation protection
before enabling automated writes.

Back up Rakazo PostgreSQL and encryption keys, OpenConnector state and keys,
OpenRAG documents/configuration, Langflow flows, and OpenSearch snapshots. Restore
into an isolated stack with customer channels disabled first. `customer-stack.sh
stop` preserves volumes.

New customer publications have durable cleanup records with encrypted runtime
credentials. Background recovery removes unused flows after confirming they are
not the selected behavior and their reply-use lease has expired. Bot and Space
deletion preserve the records; account deletion waits for cleanup before discarding
the user. Keep the encryption key and runtime API access available throughout cleanup.
A create request with an uncertain outcome remains tracked even if its flow is not
yet visible. Revoked cleanup credentials or unresolved creation can delay account
deletion and require operator investigation. Do not manually discard those records
or reuse their flow IDs. The runtime metadata check and deletion are separate API
calls, so trusted operators must not repurpose managed flows during cleanup.

To restore cleanup access after a key is revoked or rotated, run the operator command
with the application's database and encryption-key environment:

```sh
pnpm exec tsx scripts/configure-operator-settings.mts customer-runtime-cleanup < runtime.json
```

The protected input file contains `{ "baseUrl": "https://runtime.example.com", "apiKey": "replacement-key" }`.
Keep this file outside the repository and remove it when no longer needed. The command
prints only `refreshed`, `unverified` and `failed` counts. It checks every recorded
publication on the exact endpoint, including active publications, and updates only
encrypted cleanup access and the next retry time. It does not change execution
settings, revoke old keys, remove flows, or bypass active-reply leases. The ordinary
reconciler performs cleanup afterward.

New Langflow publications record the account identity returned by `users/whoami`;
the configured API key must be able to read that endpoint before publishing.
A replacement key can restore access when its account identity matches the saved
identity. Otherwise, including older records without an identity, it must read the
exact flow and validate the managed staff and protocol markers. This fallback
trusts operator-supplied runtime access, including administrator access; those
markers are not an authorization secret. An absent flow without a matching saved
identity remains unverified. Even with restored access, absence does not resolve
an uncertain create that might still finish later. Re-run the command if records
were created or changed concurrently. Active execution credentials must be updated
through their existing settings separately.

Behaviors created before publication tracking have no cleanup record. Their flows
remain operator-managed; confirm both active references and in-flight executions
before removing them. This migration does not inventory or delete older orphan flows.

## Verification

```sh
pnpm test
node scripts/verify-customer-connector.mjs
pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts
```

The connector verifier builds the exact locked source using the upstream Dockerfile
instructions, then checks the patch tests, production health, action catalog and
authentication on the account-bound route. BuildKit test stages have provider
networking disabled. Runtime data lives in tmpfs. Image export depends on both
test stages passing; test helpers, fixtures and synthetic credentials stay out of
the final runtime image. The verifier removes its own builder, cache volume and
image tag on exit unless a successful runtime was explicitly retained. It never
starts the operator's Compose stack.
Build-time dependency downloads and the production dependency advisory check
require registry access. The verifier also runs the affected mail and network
restriction tests. This is build and
offline runtime verification, not live merchant acceptance.

The integration harness migrates a disposable PostgreSQL container, runs the
deterministic fixtures, and removes it. It never migrates the application's
configured database.

Using an isolated Python environment, install the tested dependency versions:

```sh
python -m pip install -r infra/langflow/requirements-test.txt
python -m unittest discover -s infra/langflow/tests -v
```

The component test loads the extension through the real LFX loader, rejects altered
source in restricted mode, and executes a single-node graph against synthetic local
model/tool endpoints. It covers fresh history, tool failure without replay, and
rejection of a system-role transcript injection. No paid model call is made.

For the combined staff setup and website delivery path, use an isolated review
Langflow on `127.0.0.1:17860`, with auto-login enabled and the current customer
component installed. Keep tracing disabled as above. The container must resolve
`host.docker.internal` to the host so it can reach authenticated execution callbacks;
Linux Docker requires the `host-gateway` mapping shown in the Compose stack.
The verifier uses no merchant credentials or paid model. It does not start or
reconfigure Langflow:

```sh
bash scripts/verify-customer-setup.sh
```

Each run creates a fresh report directory and disposable application database.
It drives preparation and website activation through staff tool approvals,
practices approved synthetic voice and policy through the installed Langflow,
then sends a synthetic visitor message twice with the same nonce and checks for
one reply. The staff and customer model responses are scripted; approved knowledge
is seeded rather than learned through merchant setup. This proves the execution
path, not natural-language setup or answer quality. The test removes its own flows
and temporary runtime key with readback checks and stops its local servers. Abrupt
process termination or an unresponsive runtime can interrupt that cleanup.

For read-only hosted preflight, use an existing trusted SSH host key and run:

```sh
python3 scripts/verify-hosted-connector.py \
  --host <ssh-host> --container <connector-container> \
  --report-directory <new-report-directory>
```

The verifier checks catalog capabilities and runs only LINE `get_bot_info` and
Instagram `get_current_user` for configured connections. It sends no messages.
Credentials stay in the connector container; reports contain fixed action IDs,
counts and outcomes, with hashes of the exact verifier source executed. The report
directory must be new. Successful identity reads do not verify webhooks, delivery,
history, revocation or checkout.

Build and check the locked connector for a target architecture before updating it:

```sh
node scripts/verify-customer-connector.mjs --platform=linux/amd64 --retain-runtime
```

Use `linux/arm64` for an ARM host. Run this command on a dedicated build machine
with at least 4 GiB of available memory in its local Docker VM. The verifier uses
a pinned BuildKit image and Dockerfile frontend in a fresh builder capped at
4 GiB and two CPUs. Each build step is capped at 3 GiB and two CPUs, without
additional swap. It checks the actual limits and nested target-architecture Node
execution before compilation. The locked build stage runs natively and copies
only TypeScript, catalog data and browser assets into the target runtime.
Production and test dependencies are installed separately for the target
architecture. Unit and runtime tests execute on that target, using emulation for
AMD64 on an ARM machine; this does not establish behavior on a native AMD64 CPU.
The compiler patch runs the three TypeScript projects sequentially to reduce peak
memory while preserving all checks and diagnostics. The build stage sets a 2 GiB
soft Go memory target for the TypeScript compiler, below the verifier's hard
3 GiB step limit; the runtime does not inherit this compiler setting.
Run `node scripts/verify-connector-typecheck.mjs`
to check its sequencing and error handling without compiling the catalog.

Remote Docker endpoints are rejected before preparing source or starting a build.
Do not build on the shared production host: catalog compilation can exhaust
available memory. Cancelling the verifier removes its owned builder container to
stop compilation, followed by its builder metadata and cache volume. It does not
prune shared Docker caches.
`--retain-runtime` keeps only a successfully checked runtime image and prints its
immutable image ID and tag. Omit it to remove the image after verification. Image
building and the dependency audit require registry access. Deployment, persistent
data backup and live acceptance are separate steps.

Before deployment, test the prepared image archive on matching native Linux hardware.
Copy the archive plus `scripts/verify-connector-image.py`,
`scripts/check-connector-runtime.mjs` and `scripts/inspect-openconnector-acceptance.mjs`
into a private staging directory on that host. Use the checksum, configuration
digest and image tag from the prepared artifact's verification record:

```sh
python3 verify-connector-image.py \
  --archive candidate.tar --sha256 <archive-sha256> \
  --config-digest sha256:<image-config-sha256> --image <candidate-tag> \
  --existing-container <running-connector-container> --report native-check.json
```

The verifier requires Python 3.11+, the local Docker daemon, a healthy existing
connector, at least 2 GiB of available memory and space for the imported image.
It does not compile source or replace the running service. It loads the checked
archive and runs the same health, catalog and authentication checks with synthetic
settings, networking disabled, temporary data, a read-only root filesystem,
768 MiB of memory without additional swap, and one CPU. It removes its own test
container and checks that the existing service's identity, image, start time and
health are unchanged. A candidate tag that already names another image is rejected.
The loaded image must match the configuration digest or an archived OCI manifest
whose content hash and configuration reference have both been verified.

Keep the resulting receipt with the build evidence. The imported candidate image
remains available for a separately approved rollout; remove the staging directory
after retaining the receipt. This verifies native runtime compatibility, not
provider permissions, live delivery, payment behavior or upgrade recovery.

## Coordinated customer data backup

Use `scripts/customer-deployment-backup.py` to capture the core database/files,
customer runtime state and search data in one maintenance window. Supply the exact
core Compose project/configuration and the four selected dependency containers:

```sh
python3 scripts/customer-deployment-backup.py backup \
  --project rakazo-support --compose infra/compose/docker-compose.yml \
  --compose infra/compose/customer-rakazo.yml --env-file .env \
  --langflow <langflow-container> --openrag <openrag-backend-container> \
  --connector <connector-container> --search <opensearch-container> \
  --output /private/backups/new-customer-snapshot
python3 scripts/customer-deployment-backup.py verify \
  --source /private/backups/new-customer-snapshot
```

Use the actual core Compose files and overlays for your installation. The component
requirements below still apply, including local runtime databases, persistent
mounts and the search repository volume. Keep external database/search clients,
host-side writers and deployment automation stopped for the entire operation.
The tool detects connected PostgreSQL clients and other container writers; it cannot
prevent an external client or host process from writing later.

The command stops core application writers and managed computers before the customer
runtimes. PostgreSQL and OpenSearch remain running. It checks writer state and
container identity/start times between captures, then publishes one private directory
whose manifest binds the `core`, `runtimes` and `search` component manifests. Keep
those directories together. A failed capture discards the incomplete bundle and
attempts to resume originally running services. An originally stopped service stays
stopped. Resumption starts Langflow before OpenRAG and checks declared health checks
between dependency groups; without a health check, only running state is verified.
Failed resumption remains an error even when the snapshot was successfully published.

Verify the outer bundle before using the component restore commands. Follow the
[core recovery procedure](../self-host.md#restore) for its `core` directory and the
isolated runtime/search procedures below for the other two. Restore matching
components into fresh targets and review the entire deployment before reconnecting
providers or starting pending work. Registry images, external services, OpenSearch
security/global configuration and host files outside captured mounts still require
separate recovery. Stopping local writers cannot freeze an external provider's
in-flight order or message; reconcile uncertain action receipts before resuming work.

The repeatable coordination check uses only cached images and disposable resources:

```sh
python3 scripts/customer-deployment-backup.test.py
python3 scripts/verify-customer-deployment-backup.py \
  --postgres-image <cached-postgres-image> --runtime-image <cached-fixture-image> \
  --search-image <cached-search-image> --report-directory /private/checks/new-coordinated-run
```

It rejects an injected writer restart, captures all three components, and restores
matching synthetic PostgreSQL, SQLite/file and OpenSearch records into fresh targets.
The runtime fixture image must support `sleep` and declare no volumes. This check
does not run the real customer applications or establish production-scale recovery.
The archive contains secrets; retain an encrypted off-host copy in restricted storage.

## Customer runtime files and database recovery

`scripts/customer-runtime-backup.py` captures the local Langflow, OpenRAG backend
and OpenConnector state together. It stops the three explicitly selected containers,
archives their persistent mounts and effective runtime configuration, then resumes
only containers that were running before capture. Use a maintenance window and
stop incoming work, external database clients, host-side file writers and parallel
deployment automation first. Other running containers that share writable data
mounts cause capture to fail. This command does not stop the Rakazo API or worker;
coordinate their database/files backup and the search snapshot in the same window.

```sh
python3 scripts/customer-runtime-backup.py backup \
  --langflow <langflow-container> --openrag <openrag-backend-container> \
  --connector <connector-container> --helper-image <cached-gnu-tar-image> \
  --output /private/backups/new-runtime-snapshot
python3 scripts/customer-runtime-backup.py verify \
  --source /private/backups/new-runtime-snapshot
```

The command requires Python 3.11+, Docker operator access and a cached helper image
with GNU `tar` and `find`, such as the deployment's PostgreSQL image. Keep the
original runtime images available too. It supports Langflow's SQLite database under
`/app/langflow-data`, OpenRAG's local SQLite database and OpenConnector's local
database. External database settings or configured data paths outside captured
mounts are refused and need their own coordinated backup. Shared mounts are archived once.
OpenRAG documents, keys, flows, configuration and data, including nested flow-backup
mounts, are included. Additional mounts must remain under `/app/`.

Artifacts contain customer data and effective environment secrets. Keep the entire
private directory encrypted off-host and never commit it. The checksums detect
corruption; they do not authenticate an untrusted artifact. Host loss or forced
termination can leave source services stopped. Inspect and resume the selected
containers after such an interruption.

```sh
python3 scripts/customer-runtime-backup.py restore \
  --source /private/backups/new-runtime-snapshot --output /private/recovery/new-runtime-target
```

Restore extracts into fresh named volumes and writes private `compose.json` and
`volumes.json` files. It never replaces source files or volumes and starts no
services. The generated services have networking disabled and no published ports.
It preserves shared mounts, file ownership, permissions and literal environment
values. Failed extraction removes volumes created by that restore attempt; failed
cleanup requires operator inspection. Successful restore leaves those volumes for
review, identified in `volumes.json`.

Before use, review the recovered database, files, secrets, image versions, service
limits and configuration alongside the matching core and search artifacts. The
generated Compose file deliberately requires an operator to supply the reviewed
network topology and operational settings for a complete deployment. Do not start
workers or reconnect providers until pending external actions have been reconciled.

Run `python3 scripts/customer-runtime-backup.test.py` for offline safety checks.
The disposable Docker check requires a cached fixture image with `sleep` and no
declared volumes, such as the checked OpenRAG Langflow image:

```sh
python3 scripts/verify-customer-runtime-backup.py \
  --helper-image <cached-gnu-tar-image> --runtime-image <cached-fixture-image> \
  --report-directory /private/checks/new-runtime-run
```

It exercises shared volumes, a nested bind and SQLite fixture records, verifies
exact secret preservation through Compose and cleans its own resources. It runs
`sleep` in the fixture image, so it does not prove restored Langflow/OpenRAG
application behavior or a coordinated whole-product recovery.

To check Langflow application recovery with the installed customer component, run:

```sh
python3 scripts/verify-langflow-recovery.py \
  --image sha256:<cached-langflow-image-id> --helper-image <cached-gnu-tar-image> \
  --report-directory /private/checks/new-langflow-run
```

This requires the repository's installed Node dependencies and a Langflow image with
no declared volumes. The verifier checks TypeScript and formatting, then creates a
synthetic account, API key and customer flow through the production adapter. It
executes the flow, captures runtime state, and starts the same image on fresh restored
volumes. The saved key must authenticate as the same account, the full saved flow
must match, and the installed customer component must execute again.

Source and target run sequentially with networking disabled, no published ports,
2 GiB memory and two CPUs each. Model and tool endpoints are synthetic loopback
services. The checker refuses containers without its exact fixture label or network
isolation; refusal probes use disposable containers. The verifier removes its own
containers, network and volumes and compares existing container start times. Keep
the private report directory untracked because it contains the synthetic key and
backup configuration. Reserve sufficient Docker memory and disk without stopping
existing services.

This checks the same-image SQLite Langflow recovery path. It does not establish
model quality, real tool or provider behavior, OpenRAG/backend recovery, production
restore duration, or recovery across image upgrades. The fixture supplies health
checks and resource limits separately from the generated restore configuration.

To verify OpenConnector application recovery, use a native Docker engine matching
the cached connector image's architecture:

```sh
python3 scripts/verify-connector-recovery.py \
  --image sha256:<cached-connector-image-id> --helper-image <cached-gnu-tar-image> \
  --report-directory /private/checks/new-connector-run
```

The verifier connects a synthetic HTTPS store through the connector's management
API, creates a token restricted to that account's product listing, and revokes a
second token. It backs up the real connector database and configuration, starts
the same image on fresh restored volumes, and checks the original account identity
and authenticated product read. The original token must still work, its excluded
action must still fail, and the revoked token must remain rejected.

The synthetic store runs on a uniquely owned internal Docker network without
external routing or published ports. The connector trusts only the fixture hostname
for private-address resolution and uses a generated certificate through its normal
CA setting. Production request guards remain enabled. Source and target run
sequentially, each limited to 768 MiB and two CPUs; the fixture store uses 128 MiB.
The driver checks ownership and network isolation before API requests, rejects
wrong-network probes, explicitly owns image-declared volumes, removes its resources,
and compares existing container start times and health. On Linux it requires at
least 2 GiB of available memory. It never builds an image or replaces a service.

Keep reports private and untracked; they contain synthetic credentials, runtime
tokens and backup configuration. This verifies a small same-image SQLite connector
restore against a synthetic store. Real provider revocation, OAuth refresh, incoming
webhooks, message delivery, purchase reconciliation and full deployment recovery
require separate acceptance checks.

## OpenRAG application recovery check

The disposable check below pairs the real backend's local SQLite/files snapshot
with its OpenSearch snapshot. Supply cached native images, using the pinned backend
image from `verify-openrag-image.mjs` above:

```sh
python3 scripts/verify-openrag-recovery.py \
  --backend-image sha256:<cached-backend-image-id> \
  --langflow-image sha256:<cached-langflow-image-id> \
  --search-image sha256:<cached-search-image-id> \
  --report-directory /private/checks/new-openrag-recovery
```

Run on a local Docker engine with enough free memory for a 1 GiB backend, 1 GiB
Langflow, 2 GiB search node and 64 MiB synthetic embedding server, in addition to
existing services. The report's parent
directory must exist. The fixture uses an owned internal network without published
ports, synthetic OSS no-auth management with RBAC enabled, and the image's real
index initializer. It stops backend and Langflow writers across both captures,
restores into fresh volumes, and waits for restored Langflow health before starting
the backend. It compares persisted user/role rows and RSA key files, reads the exact
saved filter using the original API key, and rechecks revoked-key and foreign-filter
denials. It configures the synthetic embedding endpoint through onboarding and
invokes the actual customer search adapter before capture and after restoration.
The adapter must return only the selected, authorized document from a three-document
corpus. A foreign-owned document shares its filename and matches the saved owner
filter, so the check also requires authenticated document-level isolation. Each
successful query must make exactly one embedding request. Revoked-key and private
filter attempts must stop before search and expose only the adapter's generic error.
The report records query counters and verifies all three restored documents.
Search security is recreated from the image's stock OSS configuration.
The fixture uses only its disposable node's bundled demo administrator certificate.
It removes its containers, network and volumes after the check.

This covers small same-image local SQLite/search recovery. It does not demonstrate
OAuth login, custom search-security recovery, ingestion, semantic ranking or answer quality,
external databases, live providers, upgrades or full deployment recovery. The
patched backend must return the same safe HTTP 404 body for hidden and missing
filters, before capture and after restoration. After all restore comparisons, the
check removes only its disposable target's filter index and requires a safe HTTP
500 response. Stored and
generated vectors are identical synthetic values. They prove the embedding-backed
request and access filters, not whether a real model retrieves useful knowledge.

Add `--core-image sha256:<cached-current-core-image-id>` to run the coordinated
application check. Build the current application with `infra/compose/Dockerfile`
first. This mode adds real API, worker and PostgreSQL services, signs in a synthetic
owner, stores encrypted runtime credentials and a customer behavior, and publishes
a real customer flow. It captures core data, runtime files and search through
`customer-deployment-backup.py` in one maintenance window, then restores fresh
volumes. The restored API must accept the original session and password, decrypt
the saved credentials, resolve the same flow and retrieve only the approved
knowledge through the production customer service.

Allow another 2.5 GiB for the core fixture's container limits. The source core
stops before its replacement starts. Runtime calls use fixed loopback proxies
inside the owned API container, forwarding only to the isolated fixture network;
no host ports or production URL-policy overrides are used. The original encryption
and authentication configuration is supplied to the restored deployment and must
match the snapshot. Recover that configuration along with the data in an actual
incident. The verifier script is copied into the test container for execution and
is not part of the restored private files.

The optional core check still uses an idle connector placeholder, synthetic
embedding vectors and a small dataset. It verifies the saved flow's presence and
ownership, not a model-generated customer reply or a consequential provider action.
It does not validate an operator's proxy setup, release-to-release compatibility,
external-provider reconciliation, or a full merchant acceptance journey.

## Search backup and isolated recovery

`scripts/customer-search-backup.py` captures the managed OpenSearch component.
Coordinate it with the core database/files backup and separate backups of Langflow,
OpenRAG configuration and keys, connector state, and security configuration. This
command does not produce a complete deployment backup. Stop application and
ingestion writers, including external clients, for the coordinated capture window.
OpenSearch snapshots capture shards at different times; matching index inventories
does not establish consistency with another database. See the
[OpenSearch snapshot guidance](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/).

The managed overlay configures `path.repo` and a dedicated named snapshot volume.
Existing installations need a planned OpenSearch container recreation to acquire
that configuration. Inspect the composed mounts first and preserve the data volume.
The command requires Python 3.11+, Docker operator access, the original image cached
locally, and working admin credentials in the selected container's environment.
Allow space for both the temporary repository and the portable archive.

```sh
python3 scripts/customer-search-backup.py backup \
  --container <running-search-container> --output /private/backups/new-search-snapshot
python3 scripts/customer-search-backup.py verify \
  --source /private/backups/new-search-snapshot
```

Use a new destination directory. The artifact contains private documents, access
metadata, vectors and hidden application records, which can include credentials.
Keep it encrypted in restricted off-host storage and never commit it. Verification
checks metadata, archive paths and checksums; it does not authenticate an artifact
from an untrusted source. Keep its manifest and archive together.

Prepare a separate running node with fresh data and snapshot volumes, the exact
original Docker image ID and server version, Docker `--network=none`, and no
published ports. Configure the same repository path and node credentials. Never
use the active node as a restore target.

```sh
python3 scripts/customer-search-backup.py restore \
  --container <isolated-fresh-search-container> --source /private/backups/new-search-snapshot
```

Snapshots from a running OpenRAG backend can include protected system indices such
as `.plugins-ml-config`. For these, explicitly supply an administrator TLS
certificate and its matching key, already available inside the isolated target:

```sh
python3 scripts/customer-search-backup.py restore \
  --container <isolated-fresh-search-container> --source /private/backups/new-search-snapshot \
  --admin-certificate /run/secrets/search-admin.pem --admin-key /run/secrets/search-admin-key.pem
```

These are container paths. The command does not copy or export the key, discover
certificates automatically, or fall back to a bundled demo identity. Both paths
are required when using certificate authentication. The isolation, empty-target,
image/version and security/global-state exclusions still apply. Keep system-index
protection enabled; do not drop protected application indices to make a restore pass.
See [OpenSearch system-index access](https://docs.opensearch.org/latest/security/configuration/system-indices/).

The command refuses existing application indices and never deletes target indices.
It restores application indices and aliases while preserving the fresh node's
bootstrap metadata. Previous audit indices and `.opensearch-sap-log-types-config`
are retained under `deskazo-restored-*` names without aliases for inspection. The allowlist is
specific to the checked OpenSearch image; review it when upgrading. Exact image-ID
matching can reject equivalent images represented differently by another Docker
storage backend.

Snapshots exclude `.opendistro_security` and global state. Recover and review
users, roles, certificates, templates, policies and runtime configuration separately.
Keep the restored node isolated until the complete deployment, document access and
application queries pass review. Attaching restored data to normal services is a
separate recovery step.

Failed or uncertain snapshot requests retain their repository for investigation.
Inspect snapshot status before removing anything; never purge an in-progress
repository. Successful capture removes its unique source repository after publishing
the verified artifact. If final cleanup fails, verify the published destination
before retrying. A failed restore can leave partial data and repository state;
keep that target isolated and use fresh volumes for another attempt.

The repeatable checks use synthetic data:

```sh
python3 scripts/customer-search-backup.test.py
python3 scripts/verify-customer-search-backup.py \
  --image sha256:<cached-search-image-id> --report-directory /private/checks/new-search-run
```

The real check runs source and target nodes sequentially, each limited to 2 GiB
and two CPUs with networking disabled. It verifies restored documents, access
fields, mappings, aliases, hidden state and vector search, removes its own resources,
and checks that previously running containers remain unchanged. Reserve sufficient
Docker memory and disk space without stopping existing services. This fixture does
not prove full OpenRAG recovery or production-sized restore duration.

Before accepting real customers, test a deployed receive → automatic reply → tool
lookup → handoff → staff reply journey. Include duplicate delivery, revoked
credentials, worker restart, and backup restore. These live-account and restore
checks are not established by the local conformance suite. Do not run desktop
Electron E2E on a maintainer's machine; use CI for native-window checks.
