# Catalog-driven OpenConnector integration

Status: generic catalog, authentication, account management and action dispatch implemented. LINE uses the same account and action adapter.

## Implemented interface

The existing Integrations page adds an OpenConnector section before Advanced. It uses the incumbent monochrome controls and semantic tokens. Browse opens searchable, category-filtered rows; results render in pages of 60. Details show account management and reveal credentials or OAuth setup only when needed. Phone-width web uses one column and full-width account labels. Back restores focus to the selected row. No new visual identity or font is introduced. Provider icons use an explicit icon URL, OpenConnector's public OOMOL icon mapping, then a homepage favicon. The mapping is cached for an hour with a bounded, unauthenticated fetch and a five-minute failure backoff; artwork is optional. Failed images fall back to initials. App icons retain their original colors on web, desktop, and mobile; mobile reuses its SVG-capable connector icon component.

Web and Electron share `OpenConnectorCatalog` and `OpenConnectorFields`. Expo has native controls consuming the same RPC contracts. Automatic-reply setup appears only for providers advertising incoming-message support. Mobile directs that setup to web or desktop; account and OAuth flows are available on mobile. Native visual behavior has not been simulator-verified.

The adapter is split into catalog/HTTP, encrypted account lifecycle, and lazy action dispatch. The only LINE-specific module is the incoming-channel translator injected by the composition root. Credentials never appear in the public connection DTO. Team members can use connections; the creator manages them. Native connectors retain their existing paths and do not depend on OpenConnector catalog availability.

The runtime grant uses exact action IDs and the exact remote account ID. Providers exceeding OpenConnector's 128-rule limit use a provider action pattern with the same exact account restriction and no proxy access. No-auth providers use OpenConnector's virtual account IDs. Empty executable action sets fail closed. Schema revisions are bound into resolved tool routes before approval.

OAuth requires the scoped-request and cancellation extension in `infra/open-connector-patches/scoped-oauth-requests.patch`. Cancelling a reconnect abandons authorization while preserving the existing account and token. Provider OAuth client configuration remains deployment-owner only. Pending authorization URLs are persisted with the encrypted grant and returned only to the creator. Opening a pending account resumes observation using shared polling behavior on web and mobile. Reconnect reuses an unfinished request or recovers its completed account before creating another request. Tool execution refreshes runtime policy without writing account lifecycle state.

Granted OAuth scopes are saved from the remote account. Catalog action requirements are checked before execution; missing permissions produce a reconnect requirement. The account list uses the last loaded catalog for this indicator and makes no remote request, so unavailable OpenConnector services do not delay native account listing.

Verification includes deterministic adapter/RPC tests, 1,500-provider pagination and focus tests, desktop/phone web connection journeys, and an upstream cancellation race test. A live catalog audit validates 1,498 providers and 16,921 action summaries; a temporary no-auth account validates live provisioning and cleanup. External provider calls and real OAuth consent require account credentials and are not implied by these checks.

The sections below record the design. Advanced metadata transports and native incoming-channel setup are outside this implementation. Catalog refresh happens on demand with a 30-second ETag cache, not a background sync. Reconnection and cleanup are explicit; a process crash between an upstream write and local persistence can still require operator cleanup.

## Objective and acceptance rule

Rakazo integrates with the OpenConnector protocol once. Apps and actions are catalog records, never branches in Rakazo application code. Adding an app or action to OpenConnector must require no Rakazo code change when it uses the supported protocol, authentication types and schema dialect. Catalog refresh makes it discoverable; normal account permissions and execution approvals still apply.

Keep Rakazo local and OpenConnector in its existing container. One OpenConnector deployment serves many Rakazo teams. A connected account is automatically available to its team; its creator manages credentials, reconnect and disconnect. OpenConnector remains optional.

Protocol changes are different from catalog additions. Unknown authentication types or required protocol features produce an explicit unsupported state. Additive metadata is tolerated. Unsupported schemas or transports must not silently become empty forms or executable tools.

## Preserve existing Rakazo connectors

Required constraint: this integration must not change Rakazo's existing native connector methods. Here, native means Rakazo's existing connector implementations, not the mobile platform.

- OpenConnector is an additional adapter registered under `open-connector`. Existing connectors keep their authentication, discovery, routing, execution, approvals and connection-management behavior.
- Do not migrate existing native connections to OpenConnector, change their sharing defaults, rewrite their credentials or require OpenConnector for them to work.
- Select the metadata-driven setup flow only for OpenConnector. Existing connector forms and OAuth flows keep their current paths. Reuse UI primitives without replacing other connectors' setup behavior.
- Keep provider identity in every catalog and tool route. The same app available through two connector implementations remains two distinct sources; do not deduplicate by app slug or silently prefer OpenConnector.
- Consume existing registry, lazy-catalog and secret-store interfaces as they are wherever possible. Any necessary shared contract extension must be optional, retain existing defaults and require no changes to existing adapter implementations. Do not change global tool limits or approval semantics for OpenConnector's sake.
- An unconfigured, unavailable or disabled OpenConnector must not prevent existing connectors from loading or executing. Keep its configuration, caches, failures and migrations scoped to its own records.

## Evidence from the installed implementation

A read-only audit of the running catalog returned 1,498 providers and 16,921 actions. Its metadata marks all those actions locally executable; that is a runtime declaration, not a live test of every external API. The screenshot's catalog count belongs to a different snapshot and must not be hardcoded.

The catalog advertises four authentication types: `no_auth`, `api_key`, `custom_credential`, and `oauth2`. Credential inputs are `text`, `password`, `textarea`, and `json`. No unknown auth or credential-input types appeared in the audit. Providers can advertise multiple auth options.

Relevant OpenConnector source, relative to its repository:

- `src/core/types.ts`: providers, auth fields, action input/output schemas, required scopes and async lifecycle metadata.
- `src/catalog-store.ts`: schema-free summaries, full schemas and runtime execution flags.
- `src/server/connect-server.ts`: catalog, action execution, runtime tokens, OAuth configuration and ETag handling.
- `src/server/api/connection-routes.ts`: generic connection and reconnect endpoints.
- `src/oauth/oauth-flow-service.ts`: OAuth requests, callback handling and token exchange.
- `src/server/storage/connection-request-store.ts`: persistent request state and supersession behavior.

Rakazo already has the required foundation: `ManagedConnectorProvider`, `ConnectorProvider.resolveCall`, `lazy-tool-catalog.ts`, encrypted secrets and the team-scoped connection access predicate. Reuse these through their existing interfaces. Any unavoidable extension must obey the preservation constraints above.

## Ownership

| Concern | Owner |
| --- | --- |
| Provider names, icons, categories and available auth options | OpenConnector catalog |
| Credential validation, refresh, provider SDKs and API translation | OpenConnector |
| Action IDs, parameter schemas and output schemas | OpenConnector catalog |
| Teams, membership, connection visibility and management permission | Rakazo |
| Bot access, approvals, account selection and execution audit | Rakazo |
| External access tokens and provider OAuth refresh tokens | OpenConnector encrypted store |
| OpenConnector administrator credential and scoped runtime grants | Rakazo encrypted store |

Browsers and mobile clients talk to Rakazo. Only Rakazo servers use OpenConnector management endpoints. Users follow provider OAuth authorization URLs when necessary; they never receive the OpenConnector administrator token or administrator console session.

## Catalog and connection experience

One catalog page lists every advertised app using its metadata. Search and category filters operate on cached summaries. The team-specific connected-account list is joined from Rakazo records, never inferred from another customer's OpenConnector connections.

Use a few meaningful states: Connect, Connected, Needs setup, Reconnect, Unavailable. A catalog entry is not proof that credentials, an OAuth client, deployment policy or an executor are ready. Resolve deployment capability and team account state separately. Do not mirror global Built-in account or Configured badges as if they belonged to the current team.

Fetch summaries using `GET /api/providers`, with ETag revalidation. Normalize them once and paginate/search through Rakazo. Fetch provider detail only when opening an app, and an action's full schema only when loading that tool. Cache public metadata by configured OpenConnector deployment and revision. Never share account state, tokens or account-specific search results through that cache.

OpenConnector authentication uses one schema-driven form shared at the contract level across web, Electron and mobile. Existing native connector setup flows remain unchanged:

| Catalog auth type | Generic flow |
| --- | --- |
| `no_auth` | Create a team-scoped activation record and action-scoped runtime grant. No external credential is requested. |
| `api_key` | Render the catalog's key label and extra fields; send structured values to the backend. |
| `custom_credential` | Render the catalog's complete field list, honoring required and secret flags. |
| `oauth2` | Ensure deployment OAuth client setup exists; start an account-specific request, open consent, and verify completion server-side. |

Render secret fields as protected inputs regardless of their suggested input type. Keep field IDs and values intact; do not invent per-provider names. JSON inputs are checked locally for syntax and validated authoritatively upstream. Provider descriptions and URLs remain untrusted display data, not executable HTML or instructions.

OAuth app registration is deployment-owner setup, distinct from an end user's account authorization. Expose its requirements from metadata. Some providers need additional per-authorization inputs; collect only documented fields. Provider scopes are displayed from authorization options and kept with the granted account state.

## Integrations page UX/UI

### Purpose and placement

Mode: Operate. A team member arrives to find an app, connect their account or inspect an existing team connection. Success is a verified account available to the team, with a clear recovery path when setup or authorization fails.

Add an OpenConnector section to the existing Integrations page, after the existing connector content and before Advanced. Preserve the current native connector entries, search behavior, setup screens and MCP entry point. Within the new section, show connected OpenConnector accounts and a **Browse apps** action. Open the catalog as a subview inside the existing page/overlay, with **Back** navigation; do not stack another modal or introduce a separate primary navigation destination.

This limits the initial page's work and keeps a large catalog from displacing existing integrations. Browser back and the visible Back control restore the prior query, filters, loaded result count, scroll position and keyboard focus. Changing teams resets account-specific state and cancels in-flight results from the previous team.

### Catalog layout

The subview has a compact header, search, filters and dense app rows. Match Rakazo's current monochrome typography, semantic tokens, border treatment and controls. Use supplied provider icons with the existing icon treatment and a name-initial fallback. No promotional hero, featured-app allowlist or manually maintained provider cards.

Illustrative structure; bracketed values come from live metadata:

```text
Integrations
  [Existing connector content remains in its current layout]

  OpenConnector                         Browse apps
  [Connected app]  [Account label]           Manage

  [Existing Advanced controls]

Browse apps subview
  Back  /  OpenConnector
  Search apps…
  All   Connected          Category: All

  [Icon] [App name]                         Connect
  [Icon] [App name]  [2 accounts]            Manage
  [Icon] [App name]  Needs setup             Details

                         Show more
```

- Search matches provider name, description and category. Use a debounced request with cancellation so old results cannot replace a newer query.
- **All** shows catalog apps. **Connected** shows only apps with accessible active accounts in the selected Rakazo team. Counts are dynamic and filtered; a provider count must not be presented as an account count.
- The category menu comes from catalog metadata. Default to alphabetical ordering; do not invent a recommendation ranking.
- Use two columns of compact rows when the container has room, one column on narrow screens. Each row contains icon, name, one relevant state and one primary action. Longer names wrap without hiding the action. Put descriptions and action counts in app details.
- Render a bounded result page using Rakazo's existing page-size constant and **Show more** control. Do not mount all providers or fetch all action schemas. Loading more keeps focus on the control and announces the added result count.
- Keep source identity visible through the OpenConnector subview/header. If OpenConnector accounts appear next to another connector's account for the same app, display **via OpenConnector** on those entries. Preserve separate source IDs and never merge their management controls.

### App details and account management

Opening an app replaces the catalog body with its detail view. Show Back, icon, name, a short catalog description if useful, and the connection action. Keep protocol IDs, server URLs, runtime tokens and execution internals out of the normal account flow.

Show existing team accounts first, identified by label and safe account identity returned by the backend. The creator can rename, reconnect and disconnect their account. Teammates can inspect its available actions and use it through existing Rakazo permissions; omit credential-management controls for them. **Add account** starts an independent connection without altering an existing account.

Make **Available actions** a collapsed disclosure with search and a dynamic count. Opening it loads action summaries; expanding one action loads its description and input schema. This is an inspection view, not a new manual tool runner or approval bypass. Unsupported or currently unavailable actions show the backend's safe reason.

**Automatic replies** appears only for an explicitly supported incoming-event capability. It is not a default section on every provider.

Disconnect confirmation identifies the exact account and explains that it becomes unavailable to the team. Do not offer a provider-wide destructive shortcut when it could remove accounts owned by other people. A failed remote cleanup leaves the account locally disconnected and displays the backend's retryable cleanup state only where relevant.

### Connection flow

1. Select **Connect** or **Add account**. If several supported auth methods are advertised, select the method using catalog labels. Do not choose based on a hardcoded app name or silently substitute API-key auth when OAuth is unavailable.
2. Display only the fields required by the selected method. Use persistent labels, optional field help, required-field validation and masked secret inputs. Additional optional fields sit behind **More options**. Keep the account label editable, with the app name as the initial value.
3. Before submitting credentials or opening consent, show **Available to everyone in this team.** This is the sharing decision already established for OpenConnector accounts; do not apply it to existing native connectors.
4. For API-key/custom credentials, submit once and show Connecting while the backend validates and provisions the account. Keep errors by the relevant fields. Clear secrets after success or leaving the flow; never refill saved credentials from the server.
5. For OAuth, **Continue** opens the provider's consent in the platform's authorization browser. The page shows **Waiting for authorization** with an option to reopen the same valid authorization URL. Cancel closes the local flow and marks its attempt abandoned; it must not disconnect another account. Expired or denied authorization offers **Try again** and starts a new attempt only when selected. Completion is confirmed by the backend, not by the callback URL alone.
6. For no-auth apps, **Enable** activates that provider for this team without showing a credential form.
7. On verified success, return to app details with the connected account visible and focus restored to its account row. Preserve catalog navigation state. Do not require a success modal.

OAuth deployment setup is shown only when required. A deployment owner sees **Set up OAuth** and metadata-driven client configuration in the existing OpenConnector server settings. Other users see **Admin setup required** with a concise explanation; do not display a dead Connect button or ask them for the server's administrator credential.

### States and recovery

| Situation | Visible behavior |
| --- | --- |
| Catalog loading | Bounded skeleton rows in the OpenConnector area; native connectors remain usable. |
| No matching apps | “No apps match your search.” and **Clear filters** when filters are active. |
| Connected filter is empty | “No connected apps yet.” and **Browse all apps**. |
| OpenConnector unconfigured | Owner sees **Set up OpenConnector**; others see **Admin setup required**. No empty global integrations page. |
| OpenConnector offline | Local error and **Retry**; retain known account labels. Do not claim an account was disconnected merely because status could not be fetched. |
| Cached catalog available | Retain browse results, indicate staleness beside the retry control, and revalidate availability before connecting or executing. |
| Credential rejected | Safe field/form error; preserve non-secret inputs. Never echo submitted secrets in messages or logs. |
| OAuth pending, denied or expired | Explicit per-attempt state and the corresponding reopen/retry action; no endless Connecting spinner. |
| Account requires reauthorization | Creator sees **Reconnect**; teammates see the state without a management action. |
| Missing executor, blocked provider or unknown auth type | **Unavailable** with a reason in details. Keep the rest of the catalog usable. |
| Membership or management permission changed | Refresh the account view, remove unavailable actions and reject stale submissions server-side. |

### Platform, accessibility and verification

Web and Electron share the same components. On mobile, use native navigation, sheets, menus, secure inputs and authorization sessions with the same shared contracts. Narrow web uses a single-column catalog, full-width fields and wrapping filter controls. Keep action targets comfortably touchable and avoid horizontal page scrolling.

Use existing Base UI/shadcn primitives on web, semantic tokens and existing AI/loading feedback where applicable. No new font, product color, nested card stack or decorative animation. Use visible keyboard focus, named search/filter controls, associated labels and errors, status announcements and focus restoration on navigation. Respect reduced motion. Localize all interface-owned copy; render provider metadata as supplied data.

Acceptance screenshots cover the catalog, app detail, credential form, OAuth pending, connected accounts, permission-limited account and unavailable-service states at desktop and phone widths. Interaction tests cover keyboard search and selection, filter reset, return-state restoration, duplicate-app source routing, multiple accounts, secret clearing and OAuth cancellation/expiry. Run the existing native-connector journeys with OpenConnector disabled and offline. Catalog rendering and form generation must also pass with an invented provider and action absent from Rakazo source.

The verification paragraph above states which of these scenarios have been exercised.

## Connection lifecycle and tenant isolation

Use the existing `Connection` record for local ownership and lifecycle. Store `connectorId`, catalog `provider`, `spaceId`, creator `userId`, sharing scope, display label and status. Persist a versioned internal provider reference containing the remote connection ID, alias, runtime grant reference and any pending connection-request ID. Secrets remain in the encrypted secret store; the public DTO does not expose internal references.

Keep the stored remote ID and alias authoritative. New generic connection endpoints generate their own aliases; do not require the existing LINE alias prefix for all future accounts. Fresh accounts use opaque aliases. Enforce isolation through authenticated local ownership plus an exact remote account grant, rather than treating alias shape as sufficient authorization.

For every connection operation:

1. Authenticate the Rakazo actor and resolve the team server-side.
2. Load the exact local connection with the required use or management permission.
3. Bind upstream requests to that local record. Never adopt a remote account ID supplied by the client.
4. Complete only the stored authorization request and expected provider. Do not mark a pending account connected because another account for the same app exists.
5. Mint a runtime token restricted to that remote account and the permitted actions. Disable general proxy access.
6. Persist the connected state after grant creation succeeds. Record provisioning phases so interrupted work can recover or clean up its exact orphan account and token.

Use `POST /v1/connections/:service/connect/api-key` and `/custom-credential` for credential connections. Use `/connect` and `GET /v1/connection-requests/:id` for OAuth after fixing the concurrency issue below. Reconnect targets `/v1/connections/by-id/:appId/connect...`. Obtain the remote alias from the verified account response. Existing administrative removal routes must use that exact stored alias.

Every call rechecks current team membership, connection status, bot access and authoritative action ownership. Resolve ambiguity between two accounts explicitly. Never fall back to OpenConnector's default account, deployment credentials or a marketplace account owned by the operator. For no-auth providers, allow only catalog-declared no-auth actions with action-restricted grants; a future auth requirement forces reconnection.

Disconnect first makes the local connection unusable, then revokes its runtime token and remote account. Persist failed cleanup for retry. Other teams' accounts remain untouched. Reconnect replaces only that account's credential; it must not broaden sharing or switch the action's target account.

### OAuth request isolation for the selected connection flow

The current connection routes set the owner to `local-admin`. The request store supersedes earlier pending requests for the same owner and service. Consequently, two customers authorizing the same app concurrently can invalidate each other's flow.

For the selected durable `/v1/.../connect` flow, before rollout add an administrator-only opaque connection-request scope to the generic start/status contract. Rakazo derives this scope from its persisted local connection ID; clients cannot choose it. Request supersession must apply only to reconnect attempts for that same connection. Fetching request status must verify the same scope. Keep callback state single-use and preserve OpenConnector's state/PKCE checks. This is one upstream protocol change, not a provider-specific OAuth implementation.

The older `POST /api/oauth/authorizations` route also supports an explicit connection alias and independent OAuth state. It can avoid shared-owner request supersession, but does not provide the same connection-request status lifecycle. Keep it as a documented alternative if avoiding an upstream patch is a rollout requirement; it needs separate completion, expiry and reconnect-race tests. Do not silently mix the two completion models.

Provider callbacks go to OpenConnector's `/oauth/callback`. For a local container, expose that callback through a stable public origin or a narrowly routed reverse proxy; the Rakazo return URL is a different endpoint. Exposing the callback must not expose the OpenConnector administrator console or management APIs.

Use a server-allowlisted return URI. Treat the return navigation as a notification only; Rakazo verifies the stored request status and resulting remote ID through its backend. Persist enough state to finish authorization after an API restart or closed browser tab.

## Generic tool discovery and execution

Reuse `lazy-tool-catalog.ts` and its search, load and execute controls. Agents initially see these small controls and their authorized account summaries. Search is restricted to enabled, accessible connections; a global catalog search must be filtered before results are exposed. Load only the selected action's schema.

The authoritative execution identity is `(deployment, localConnectionId, actionId)`. Preserve upstream action IDs exactly. Generate model-compatible tool names using the existing stable catalog identity mechanism, with collision checks; never recover routing by splitting a formatted tool name.

Before approval, `resolveCall` resolves a catalog wrapper to the actual action, account and schema. Approval binds the resolved action, arguments, account and schema revision. Revalidate before sending. A changed action schema invalidates stale preparation rather than silently changing the approved operation.

All actions use the same dispatcher:

```text
POST /v1/actions/{encoded actionId}
Authorization: Bearer <account-scoped runtime token>
x-oo-connector-alias: <verified account alias>

{"input": <schema-validated arguments>}
```

Preserve supported JSON Schema composition and nested values. Use a shared validator compatible with OpenConnector's schema dialect; remote references require explicit support and must never trigger arbitrary schema fetches. Keep credentials out of action arguments. Normalize the shared success/error envelope and retain execution IDs for audit without exposing secrets.

The inspected action schema has no universal read-only annotation. Therefore do not infer safety from action names, prefixes or descriptions. Unknown actions remain potentially mutating and follow Rakazo's existing approval policy. Trusted future protocol annotations can be added through one shared mapping. Discovery does not itself authorize execution.

Use existing artifact handling for files and structured results. If OpenConnector transit files are needed, add one server-side artifact bridge with explicit team ownership, size limits and expiry; never give clients broad transit-file management access. Async operations use declared `asyncLifecycle` action IDs through the same dispatcher and authorization checks. Do not add named-provider upload or polling branches.

Transport retries must distinguish an unaccepted request from an uncertain external side effect. Use the protocol's idempotency semantics where verified; its current cache can retain failures. Do not automatically repeat arbitrary writes or promise exactly-once external effects. New error codes retain a safe generic fallback with a diagnostic code.

## Future apps and actions

On catalog refresh:

1. New provider metadata becomes searchable without a release of Rakazo.
2. Its supported auth definitions produce the connection form automatically.
3. New actions become searchable for enabled accounts through their catalog `service` relationship.
4. Reconcile each runtime token's explicit action grants from the current catalog and saved permission policy. The current fixed list at connection creation would otherwise block newly added actions.
5. Keep exact remote account restrictions. Do not add global wildcards or automatically broaden a user's narrower action selection.
6. Newly required OAuth scopes produce a reconnect requirement. Removed actions disappear from discovery and are rejected at execution. Additional optional metadata does not break parsing.

No provider-specific action list, credential label, regex, safety heuristic, catalog card or endpoint path belongs in the generic adapter. The only necessary branches are protocol capabilities such as auth type and lifecycle state.

## Incoming events are a separate capability

An action catalog alone does not define webhook signatures, subscriptions or incoming-message semantics. Do not advertise automatic replies for every app merely because it exposes outbound actions.

Keep the current LINE inbound behavior in a separate channel adapter during migration. The generic OpenConnector action adapter must not import LINE parsing or reply formatting. Future inbound support requires a normalized event/subscription contract advertised by OpenConnector; one Rakazo event adapter can then consume that contract. New LINE accounts use the generic connection flow.

## Implementation sequence

1. Establish regression coverage for existing connector methods and keep their current interfaces and defaults. Add only optional OpenConnector capabilities where the current contract cannot represent its metadata-driven setup or connection-specific completion.
2. Generalize `packages/adapters/src/open-connector.ts`: catalog cache, all supported auth flows, scoped grants and one dispatcher. Reuse the existing secret store, registry and lazy catalog.
3. Fix and test OAuth request isolation in OpenConnector. Keep it as a small protocol change that can be contributed upstream.
4. Expand only the OpenConnector credential form into metadata-driven web/Electron and native mobile forms. Keep other connectors on their existing setup paths. Put OpenConnector deployment OAuth client setup behind owner settings.
5. Reconcile catalog changes and runtime grants. Reset old LINE references and retain isolated inbound channel behavior.
6. Run offline contract tests and a controlled account-connection smoke test per auth type. Roll out the generic adapter only after the future-provider test below passes.

## Verification contract

Existing-connector regression coverage is a release gate. Run their current authentication, discovery, execution, approval and disconnect tests with OpenConnector absent, enabled and unavailable. Test that the same app connected through a native adapter and OpenConnector routes to the explicitly selected adapter/account. Verify OpenConnector refresh and cleanup do not modify native connection records or secrets, and that existing personal/team sharing defaults remain unchanged. Verify failure isolation without adding OpenConnector as a prerequisite for any existing connector.

The decisive test injects a provider and action ID that do not exist in Rakazo source. Through the public adapter interface, it discovers the app, renders/validates its declared credentials, connects an account, loads its action schema and executes against a fake OpenConnector server. No fixture implementation may switch on those IDs. Then add another action after connection and verify catalog refresh, grant reconciliation and execution without reconnecting.

Cover all four auth types and all four credential-input types. Include multiple auth options, nested/composed action schemas, files and declared async lifecycle. Explicitly test unknown protocol features, absent executors, new scopes, stale schemas, removed actions and unavailable upstream service.

Isolation cases include two teams authorizing the same app concurrently, two accounts within one team, cross-team request/account injection, membership removal, revoked connections, expired OAuth requests, reconnect races, interrupted provisioning and cleanup. Verify default/operator accounts are never selected and that cached discovery cannot leak a different team's accounts.

A scale fixture with at least 1,500 providers and 17,000 actions must show bounded initial tool definitions and lazy schema fetches. Browser tests cover search, schema-driven forms, OAuth completion, reconnect and errors on desktop and narrow screens; native auth navigation gets its own platform checks.
