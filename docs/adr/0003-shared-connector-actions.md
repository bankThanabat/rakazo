---
status: accepted
date: 2026-09-17
---

# Shared connector actions

Pi staff agents and Langflow customer agents use Rakazo's existing OpenConnector
catalog, JSON schemas, action resolver, and executor. This applies to every app
in that catalog. Provider code stays in the adapter. OpenRAG remains the retrieval
service; neither upstream OpenRAG nor Langflow needs a source patch.

## Account policy

`Connection.actionPolicy` stores accepted `defaults` and user `overrides`, keyed
by stable provider action ID. `true` means Internal, usable by staff only. `false`
allows both staff and customer agents. The connection owner edits these settings.
Team members can inspect them. Staff approval requirements remain unchanged.
A stored policy that fails validation reads as empty. Settings list only the
actions Rakazo can execute, for staff and customer agents alike.

New and migrated connections start with an empty policy, which means every action
is internal. Users can change individual switches or preview and apply defaults.
The recommended Instagram defaults share `send_message`, `reply_to_comment`, and
`create_comment`. The provider adapter owns these recommendations and reports them
with its action list. All other actions default to internal. Applying defaults stores
a snapshot; adding an action to a provider catalog never grants customer access.
Resetting one action explicitly accepts its current recommended default.

## Execution

1. Rakazo creates a short-lived capability for the current customer turn.
2. The installed Langflow component fetches `/api/customer-tools`. The bridge uses
   the same OpenConnector discovery as Pi, with server-derived `actionAccess`.
3. Search and schema loading filter by the current account policy. The account
   scope consists of the channel connection and connections in configured business
   workflows. Setting an action to shared does not attach unrelated accounts. A
   disconnected account drops out of the scope; the turn keeps its other tools.
4. The customer agent selects an action with `openconnector_execute_tool`. Rakazo
   resolves it through the common provider resolver, validates inputs, reloads
   policy, and dispatches through the same adapter. A remote integration gateway
   carries this scope and independently verifies account ownership.
5. The execution ledger records the resolved account and action, reuses stable
   execution IDs, and rejects ambiguous replays. A workflow is recorded by name and
   account because its grant fixes the steps. Catalog reads pass the same liveness
   check and per-turn call limit, then always run against the current policy rather
   than returning an old cached result.

The customer cannot select its identity, space, execution capability, or credential
through tool arguments. The capability stops working when the channel's automatic
replies are turned off. Existing business workflows retain their ownership checks;
every workflow step must also be shared in the account policy. Sharing a raw action
authorizes that action on the scoped account, so users should keep broad actions
internal when their workflow needs narrower business rules.

For the channel's reply action, schema loading adds suggested recipient arguments.
Execution verifies them against the current conversation and generates the retry
key on the server. A successful explicit reply replaces automatic final-answer
delivery. An uncertain send triggers handoff without sending a second reply.
Changing policy blocks subsequent dispatches and cached-result replays; an external
request already in flight may still complete.

## Rollout and verification

Apply the `20260917000000_connector_action_policy` migration and regenerate Prisma.
Existing automatic customer replies require sharing the channel's send action.
Existing customer workflows require sharing each action they use. Account settings
are available on web, Electron's shared web UI, and native mobile.

Upgrade a remote integration gateway before the API. An older gateway ignores
`actionAccess`, so catalog search and schema loading would list internal actions to
the customer agent. Rakazo still checks the policy locally before every dispatch,
so those actions cannot run.

Run `pnpm test` for the deterministic unit suites. They cover policy reads,
customer scope, owner-only settings, reply-target checks, and catalog filtering.
The conversation and gateway conformance suites additionally require an isolated,
migrated PostgreSQL database:

```sh
VERIFY_DATABASE=1 DATABASE_URL=postgres://test:test@localhost:5432/test \
  pnpm exec vitest run --no-file-parallelism \
  packages/adapters/src/customer-conversations.postgres.test.ts \
  packages/adapters/src/integration-gateway.postgres.test.ts
```

Run `pnpm --filter @rakazo/web e2e open-connector.spec.ts` for the desktop-width
and phone-width browser flows. These tests use fake provider HTTP responses,
not live Meta credentials.
