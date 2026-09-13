# OpenConnector and Rakazo

OpenConnector is a plausible optional integration backend for Rakazo. It manages app credentials, OAuth flows, action definitions, and execution through MCP or HTTP. Its smallest useful evaluation is a self-hosted MCP connection. Making its apps appear in Rakazo's managed Integrations catalog requires an adapter, and a shared deployment needs explicit account isolation. Rakazo's Pi agent runtime can stay in place. This is an adoption assessment based on the code below, not a completed integration.

Research date: 2026-09-10. Upstream snapshot: [`4d7d59de1f6d474a1afb6194de008a0affc08b10`](https://github.com/oomol-lab/open-connector/tree/4d7d59de1f6d474a1afb6194de008a0affc08b10). Rakazo snapshot: `2241538afc9276054c5e1be390891b7a59496394`. Findings distinguish source inspection, documentation claims, and recommendations. No provider credentials or live provider actions were used.

## What it does

The project describes itself as an alternative to Composio and Pipedream. It offers a Node/Docker runtime, optional hosted service, web console, MCP endpoint, HTTP API, and OpenAPI document. The separate Connector SDK is described as a thin HTTP client. These are ways to access a connector gateway, not an agent reasoning loop. [Upstream overview](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/README.md#L18-L81)

The inspected execution path is:

```text
Rakazo's agent chooses an action
  → connector adapter or registered MCP server
  → OpenConnector authenticates the runtime caller
  → action and connection policies select permitted work
  → connection service resolves the account credential
  → lazy provider executor validates input and calls the provider
  → result and execution ID return to Rakazo
```

Provider definitions hold metadata and action schemas. A generated catalog separates discovery from runtime imports; the provider loader imports executor modules only when needed. HTTP and MCP share `ActionRunner`, which evaluates action policy and connection access before resolving execution credentials. Input validation runs before the executor. The runner records timing, action ID, connection ID, token ID, policy, and summarized input/output. Audit persistence failure does not invalidate an already completed action. [Catalog](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/catalog-store.ts#L14-L31), [lazy loader](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/providers/provider-loader.ts#L17-L80), [execution boundary](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/server/actions/action-runner.ts#L75-L173), [input validation](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/core/execution.ts#L11-L39)

## Catalog coverage and actual execution

The README claims over 1,000 providers and 10,000 prebuilt actions. Counting the pinned checkout found **1,482 provider `definition.ts` files and 1,482 corresponding `executors.ts` files**. This confirms a substantial implementation catalog. It does not establish the exact action total or that every action succeeds against today's provider API. [README claim](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/README.md#L18-L20), [provider source directory](https://github.com/oomol-lab/open-connector/tree/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/providers)

For example, GitHub defines both OAuth and API-key authentication, selectable OAuth capabilities, and a concrete action catalog. The catalog includes repository, issue, pull request, workflow, file, and release operations. This is more useful evidence than a provider logo count. [GitHub definition](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/providers/github/definition.ts#L13-L87), [GitHub action inputs](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/providers/github/actions.ts#L27-L174)

The project itself separates catalog presence, local executability, and verification against an external API. Its runtime can return `executor_unavailable` for an action without a local executor. Therefore, evaluate the exact actions Rakazo needs rather than treating the headline count as verified coverage. Optional Marketplace configuration can route supported actions to a managed remote executor; local and managed execution should be evaluated separately. [Verification policy](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/verification.md#L1-L13), [unavailable executor](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/core/execution.ts#L5-L24), [Marketplace](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/marketplace.md#L1-L11)

## Discovery and calling tools

OpenConnector always exposes five MCP tools:

| Tool | Purpose |
| --- | --- |
| `list_apps` | Browse providers and connection summaries |
| `list_connections` | Find accounts visible to the runtime token |
| `search_actions` | Search action metadata, optionally within a provider |
| `get_action_guide` | Read one action's parameters and execution example |
| `execute_action` | Call an action using `actionId`, `input`, and optional `connectionName` |

This is a fixed discovery design, independent of Rakazo's 20-tool threshold. Rakazo would initially see five tools from this server; thousands of downstream actions stay behind `execute_action`. Action search uses MiniSearch with provider, action-name, and description fields, with fuzzy/prefix search support. It does not require embeddings or a hosted search service. The MCP transport handles stateless Streamable HTTP POST requests with JSON responses. [Tool definitions and transport](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/mcp.ts#L60-L183), [search implementation](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/core/action-search.ts#L1-L38)

HTTP clients can discover `/v1/actions`, inspect `/v1/actions/:actionId`, and POST an input object to that action. Account selection uses `x-oo-connector-alias`, the `alias` query parameter, or supported equivalent fields. Omitting the selector chooses the provider's default connection; named connections do not silently fall back. `/openapi.json` supports API importers. [Runtime API](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/runtime-api.md#L7-L18), [account selection](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/runtime-api.md#L161-L192)

HTTP action calls support a durable `Idempotency-Key` mechanism with a 24-hour replay window. MCP `execute_action` does not accept that key. This matters if Rakazo retries a write after an ambiguous transport failure. The HTTP namespace is runtime-wide, so a future adapter should generate unpredictable operation keys and preserve them across retries. The documentation explicitly does not promise provider-side exactly-once execution. [Retry contract](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/runtime-api.md#L187-L227)

## Authentication and credential ownership

For self-hosted OAuth, the operator registers OAuth apps with providers and configures client credentials in OpenConnector. Its management API starts authorization and returns an authorization URL plus a connection request ID. A client opens the URL and polls that request for completion. Callback state is claimed or consumed, expired state is rejected, and PKCE is used when the provider definition enables it. Stored credentials support refresh through shared and provider-specific OAuth implementations. Hosted OOMOL advertises managed OAuth apps; that convenience is a hosted-service property. [Connection flow](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/programmatic-connections.md#L24-L80), [OAuth code](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/oauth/oauth-flow-service.ts#L190-L301), [refresh](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/oauth/oauth-credential-refresh-service.ts#L1-L89), [hosting distinction](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/README.md#L29-L35)

The gateway owns provider secrets. Rakazo can hold a restricted gateway token and account reference instead of the upstream access token. Encryption at rest is **optional**: `createSecretCodec` selects AES-256-GCM when an encryption key exists and plaintext otherwise. Persistent runtime tokens use random secret values with stored SHA-256 hashes. Admin authentication and runtime authentication are separate, optional settings. A fresh instance without configured authentication accepts local management requests. [Secret codec](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/server/secrets/secret-codec.ts#L12-L56), [runtime tokens](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/server/storage/runtime-token-service.ts#L60-L116), [management auth](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/programmatic-connections.md#L8-L22)

## Isolation and policy limits

The open runtime has one administrator principal. Connection management literally uses `owner = "local-admin"`; it does not map requests to Rakazo users or spaces. JWT verification authenticates a caller but does not translate JWT claims into action policies. Bootstrap tokens and JWTs do not have stored connection grants. This prevents treating a shared instance as a ready-made SaaS tenancy layer. [Single owner](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/server/api/connection-routes.ts#L22-L50), [JWT limitations](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/configuration.md#L105-L136), [connection grants](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/runtime-api.md#L25-L39)

Persistent tokens provide useful execution restrictions, with asymmetric defaults:

| Token field | Empty value means |
| --- | --- |
| `allowedActions` | No token-level action allowlist restriction |
| `allowedConnections` | All connections, subject to other applicable checks |
| `allowedProxies` | No provider proxy access |

Nonempty connection grants match stable opaque IDs. Action blocks override allows, and deployment, runtime, and token action rules intersect. The HTTP provider proxy has separate permissions, so blocking actions does not by itself block raw proxy requests. Eight offline assertions against the actual policy class confirmed these defaults, exact action/account restrictions, and deployment-block precedence. [Policy implementation](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/core/action-policy.ts#L92-L207)

For Rakazo, the generic `execute_action` is the main approval concern. Allowing that MCP tool allows every downstream action permitted by its gateway token. A production adapter should resolve the nested `actionId` and account before Rakazo approval, then enforce the same selection during execution. OpenConnector's MCP instructions ask the model to obtain explicit intent for writes, but prose instructions cannot replace backend authorization. [MCP instructions and arguments](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/mcp.ts#L39-L120), [Rakazo resolution contract](https://github.com/elie222/rakazo/blob/2241538afc9276054c5e1be390891b7a59496394/packages/adapter-kit/src/interfaces.ts#L157-L188)

Provider HTTP helpers implement SSRF checks for URLs, redirects, and resolved addresses. Private-network access is an explicit option intended for a controlled single-tenant runtime. This is useful defense, not evidence that every one of the provider implementations has been security-audited. [Egress helper](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/providers/provider-runtime.ts#L33-L79), [private-network configuration](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/configuration.md#L181-L211)

## Deployment and maturity evidence

The supplied Docker image uses Node 24. Self-hosting defaults to SQLite plus local files; PostgreSQL and S3-compatible transit storage support shared infrastructure. PostgreSQL requires explicit migrations. The Compose file exposes port 3000 and passes through optional auth and encryption settings, so a shared deployment needs those settings supplied deliberately. The repository declares Apache-2.0 licensing; provider marks and third-party assets retain their owners' rights. [Dockerfile](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docker/Dockerfile#L1-L35), [Compose](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docker-compose.yml#L1-L30), [database operations](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/docs/configuration.md#L68-L106), [license notice](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/NOTICE.md#L1-L10)

The package declares version 1.5.0. CI defines linting, formatting, typechecking, and Vitest with PostgreSQL available. The pinned `src` tree contains 191 `.test.ts` files, including MCP, OAuth, policy, storage, and provider tests. These are evidence of engineering checks, not a reported green CI run or live certification of every integration. This research did not install dependencies or run the full upstream suite. [Package](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/package.json#L1-L26), [CI](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/.github/workflows/ci.yml#L29-L80), [MCP tests](https://github.com/oomol-lab/open-connector/blob/4d7d59de1f6d474a1afb6194de008a0affc08b10/src/mcp.test.ts#L1-L40)

## Adoption assessment

Start with one operator-owned instance, one account, an explicit action allowlist, and an exact connection grant. Register its `/mcp` endpoint through Rakazo's existing MCP setup and verify discovery, a read, a denied action, a denied account, and a user-approved write. Registered MCP already supports Streamable HTTP, secrets, and bot assignment. Its localhost-capable path is distinct from installed remote MCP sources, which require public HTTPS. [MCP setup](https://github.com/elie222/rakazo/blob/2241538afc9276054c5e1be390891b7a59496394/apps/web/src/components/integrations/IntegrationSetup.tsx#L104-L126), [registered server validation](https://github.com/elie222/rakazo/blob/2241538afc9276054c5e1be390891b7a59496394/packages/contracts/src/mcp.ts#L16-L31), [remote source restriction](https://github.com/elie222/rakazo/blob/2241538afc9276054c5e1be390891b7a59496394/packages/adapters/src/remote-mcp.ts#L122-L144)

For the managed Integrations screen, implement the existing `ManagedConnectorProvider` contract for catalog, connection lifecycle, discovery, resolution, and execution. The current provider ID schema accepts only Composio and Pipedream, so adding an MCP endpoint alone will not populate that app catalog. Keep user/space ownership and approval decisions in Rakazo; keep gateway protocol and credential translation in the adapter. Pi remains the agent runtime. [Managed contract](https://github.com/elie222/rakazo/blob/2241538afc9276054c5e1be390891b7a59496394/packages/adapter-kit/src/interfaces.ts#L157-L188), [provider settings](https://github.com/elie222/rakazo/blob/2241538afc9276054c5e1be390891b7a59496394/packages/contracts/src/integration-settings.ts#L3-L16), [Pi dependencies](https://github.com/elie222/rakazo/blob/2241538afc9276054c5e1be390891b7a59496394/packages/adapters/package.json#L22-L23)

Before adoption, settle shared-instance OAuth request ownership, cancellation/supersession behavior, account revocation and stale grants, write retry semantics, and action-level approval presentation. Test the specific target providers against disposable accounts when authorized. These are integration acceptance criteria, not claims that the project has failed those tests.

## Reproduce this research

Run the repository's accompanying checker:

```sh
python3 scripts/verify-open-connector-research.py
```

It checks pinned source availability and citation line bounds. The eight policy assertions were a separate direct Node execution against the pinned policy module, not part of this checker. To independently reproduce the source inventory from an upstream checkout at the recorded commit:

```sh
rg --files src/providers | rg '/definition.ts$' | wc -l
rg --files src/providers | rg '/executors.ts$' | wc -l
rg --files src | rg '\.test\.ts$' | wc -l
```

The inspected files are linked beside their claims. Remaining unverified facts are exact loaded action/executor totals, live provider compatibility, current hosted-service behavior, full upstream test results, and Rakazo-to-OpenConnector transport compatibility in a running deployment.
