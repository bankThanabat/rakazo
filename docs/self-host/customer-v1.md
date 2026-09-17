# Customer support operations

Rakazo owns conversations, customer authorization, history, and reply delivery.
Local Langflow runs customer agents. Unmodified OpenRAG provides document ingestion
and knowledge search. OpenConnector executes approved connected-service actions.
The optional cloud gateway and Convoy deliver messages to the local Rakazo runtime.

## Install the local stack

Use upstream OpenRAG and OpenConnector source trees matching
[customer-sources.json](../../infra/compose/customer-sources.json). Supply them as
`apps/openrag` and `infra/open-connector`, using checkouts or symlinks. The verifier
accepts a fork whose tree matches the pinned upstream tree. It never applies patches,
checks out branches, or resets files.

```sh
node scripts/customer-sources.mjs
scripts/customer-stack.sh up
scripts/customer-stack.sh ps
```

Create the ignored `.env`, `apps/openrag/.env`, and `infra/open-connector/.env` from
the respective examples first. Generate deployment secrets locally. The script
builds the verified sources in separate Compose projects on a shared network.
The OpenRAG administration UI defaults to port 3001 to avoid OpenConnector's 3000.
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
stop` preserves volumes. Failed or superseded publications can leave unused flows
in Langflow; remove them only after confirming no active behavior references them.

## Verification

```sh
pnpm test
pnpm test:integration --spec=packages/adapters/src/customer-conversations.postgres.test.ts
```

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

Before accepting real customers, test a deployed receive → automatic reply → tool
lookup → handoff → staff reply journey. Include duplicate delivery, revoked
credentials, worker restart, and backup restore. These live-account and restore
checks are not established by the local conformance suite. Do not run desktop
Electron E2E on a maintainer's machine; use CI for native-window checks.
