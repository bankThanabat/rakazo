# Customer support v1 operations

Rakazo runs the staff assistant and inbox. OpenRAG runs the customer agent. OpenConnector owns external accounts and action translation. Configure connections, approve customer behavior, and publish revisions through Pi chat using the existing connection and approval cards.

## Install the compatible sources

The source directories can be checkouts or symlinks. Supply `apps/openrag` and `infra/open-connector` from repositories containing the exact revisions in [sources.json](../../patches/customer-stack/sources.json). An arbitrary upstream image does not include this fork's managed customer API. The lock deliberately contains no machine-specific paths or private repository URLs.

```sh
node scripts/customer-sources.mjs --apply
```

This verifies both revisions and the patch checksum, then applies the tracked OpenRAG patch if needed. Running it again is safe. It neither checks out another branch nor resets local edits. Extra tracked changes outside the release patch are rejected; use isolated pinned checkouts while other tasks edit the linked repositories. `--source-root=/path/to/checkouts` verifies an alternate directory tree. Keep the source artifacts with your release.

Create the three ignored configuration files from each project's examples: `.env`, `apps/openrag/.env`, and `infra/open-connector/.env`. Generate real encryption/auth/database secrets locally. Configure public HTTPS origins and the connector's administrative and runtime authentication. Keep management ports behind your trusted reverse proxy/firewall. Customer website origins are an explicit allowlist; staff login cookies never authenticate a visitor.

```sh
scripts/customer-stack.sh up
scripts/customer-stack.sh ps
```

The script builds verified sources and starts separate Compose projects on a shared service network. It defaults the OpenRAG administration UI to port 3001 to avoid the connector's port 3000. The OpenRAG overlay enables RBAC and its public API router and uses one worker. `API_URL` remains the public webhook origin; the overlay supplies `API_INTERNAL_URL` for scoped customer-tool callbacks. Configure OpenRAG at `http://rakazo-support-rag:8000/v1` and OpenConnector at `http://rakazo-support-connector:3000` when Rakazo runs in this stack. Host development needs host-reachable addresses instead. Configure the embedding and chat model through the existing OpenRAG connection settings; no particular hosted model vendor is required. To reuse a saved Pi subscription connection for chat, follow the [model bridge setup](../model-bridge.md). Embeddings require a separate connection.

`up` checks Compose health/startup, not whether every application integration is usable. Verify the OpenRAG model, ingestion, managed publication, and Langflow-to-Rakazo callback before enabling customer traffic. Pi should publish a small behavior and run an isolated test conversation. The browser end-to-end fixture uses real Rakazo APIs and PostgreSQL but does not prove a deployed OpenRAG model or external account works.

## Set up support in Pi chat

1. Ask Pi to connect your OpenConnector instance and business accounts. Complete the connection cards. Use separate service credentials with the required permissions; never paste secrets into an ordinary message.
2. Connect the OpenRAG compatible runtime and its MCP tools through the existing connection UI. Grant runtime publication `flows:edit`, chat `chat:use`, and knowledge search `search:use` as needed. Keep its API key limited to the support workspace.
3. Ask Pi to ingest the public support documents, inspect ingestion status, and save a filter selecting explicit data sources. Empty or wildcard-only filters are rejected for customer knowledge. Changes to a saved filter take effect on later searches; only trusted publishers should be able to edit it.
4. Ask Pi to configure the customer agent. It discovers OpenConnector action schemas and publishes the OpenRAG flow at runtime. You do not need a flow ID or flow editor. Approve public instructions, selected sources, and named workflows. Customer-specific reads and writes require a configured read that verifies ownership against the channel sender. Public-data reads require an explicit `public` audience grant. The account association and record/amount constraints belong in the approved workflow. A messaging sender ID is not automatically a CRM customer ID. For v1, enable automated writes only after testing that the approved workflow or provider rejects a repeated operation in a later customer message. Per-turn deduplication does not make a refund or other business write idempotent across customer turns. Without that proof, grant reads and hand writes to staff.
5. Ask Pi to connect LINE, Instagram, and Telegram using the [binding examples](customer-bindings.json) as starting points. Pi must inspect the installed action schemas and configure each account's signed webhook or polling subscription. The examples hand non-text messages to staff and split replies to their configured wire limits. Files and voice are handled in the original channel in v1.
6. Ask Pi to create website support with your approved HTTPS website origins. Install the returned script on those sites. Loopback HTTP origins are accepted for local testing. Visitor capabilities last seven days and are scoped to one case; removing an origin revokes its sessions.
7. Use `customer_channel` through Pi to explicitly enable team sharing, set quotas, or disable traffic. Existing channels remain private by default. Daily channel limits default to 1000 inbound messages, with 30 per customer per hour. Customer executions allow at most 16 business-tool calls. These bounds control activity; they are not currency-based spending limits.

## Handle cases

Messages over a quota are rejected. Polling and signed webhook batches continue with other senders; quota-rejected messages are not queued for later execution. Other receive failures retain the polling checkpoint for retry.

The Customer tab supports open/resolved cases, attention filters, unread state, server search, and paging. Staff can assign a shared case to themselves, take over, reply, resolve, reopen, and resume automation. A new message reopens a resolved case under staff ownership.

`request_human` transfers ownership transactionally, cancels obsolete queued work, records a reason, queues one acknowledgement, and marks the case for staff notification. New messages on a staff-owned case renew attention. Push delivery requires the existing notification provider and a registered device. The durable attention queue remains available if push fails.

Ask assistant opens the case's staff assistant when it belongs to you, otherwise your own assistant in the current space. Pi reads the authorized transcript/action history and calls `customer_knowledge` with the case identifier to search that case's approved sources. It can investigate using approved connections and save an editable draft. A draft expires when the conversation changes. Staff send from the inbox. Customer text is untrusted input and must never authorize new tools or expose private staff memory.

A failed/uncertain action or partial outbound send needs investigation. The case shows action status, bounded action results, the failure state, and confirmed part count. Check the original provider before retrying a write or resending delivered parts. There is no blind replay button. Use `customer_inspect` for connection/mapping errors and `customer_activity` for confirmed replies and waiting/failed counts.

## Retention and recovery

Retention is off by default. With explicit owner approval, `retentionDays` deletes resolved idle cases after that many days, including Rakazo transcripts, action ledgers, read state, and visitor capabilities. Pi can delete an individual resolved idle case with `customer_delete`; export its paginated snapshot before deletion if needed. Open cases and in-flight work are preserved.

Managed non-streaming customer execution avoids OpenRAG conversation persistence and disables the template's Langflow message storage. External providers, LLM infrastructure, tracing, and backups retain data according to their own settings. Rakazo deletion does not erase those stores.

Back up Rakazo PostgreSQL and its data directory together with its encryption key, OpenConnector's state/database and encryption key, OpenRAG's data/config/keys/flows/documents, Langflow state, and OpenSearch snapshots. Keep secrets separately encrypted. Restore into an isolated stack with customer channels disabled, verify decryption and knowledge retrieval, and inspect unfinished sends/actions before enabling traffic. `scripts/customer-stack.sh stop` preserves volumes. This procedure still needs a real restore rehearsal on the chosen deployment.

## Release verification

```sh
pnpm db:generate
pnpm check
pnpm lint
pnpm test
pnpm test:integration
apps/openrag/.venv/bin/python -m pytest apps/openrag/tests/unit/api/test_customer_flow.py apps/openrag/tests/unit/api/test_customer_publication.py -q
# CI/isolated browser runner:
pnpm test:e2e --spec=customer-website.spec.ts
```

The integration runner isolates each suite in a migrated PostgreSQL database. The browser test covers the widget, real staff inbox, handoff, assignment, reply delivery, resolution, and phone-width capture. Compare the channel bindings with the installed connector schemas before enabling them. Do not run the desktop Electron E2E suite on a maintainer's machine.

Before accepting real customers, record one successful receive/AI reply/tool lookup/handoff/staff reply/reconnect journey for each of LINE, Instagram, Telegram, and website support using the deployed services. Include an unknown question, rejected ownership check, expired account, duplicate webhook, long Unicode response, worker restart during a send, and backup restore. No live-account or restore acceptance is claimed by the offline checks.
