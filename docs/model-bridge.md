# Reuse a Rakazo model connection in OpenRAG

The optional Rakazo model bridge lets a Langflow/OpenRAG flow use a model connection already saved in Rakazo, including subscription OAuth. It makes one model completion per request through Pi's provider adapters. Langflow keeps its agent loop, retrieval, and tool execution. The bridge does not run a Rakazo staff agent or expose its tools, memory, or instructions.

This adds a connection path. It does not replace OpenRAG login, its API authentication, existing model provider credentials, embeddings, or the Rakazo customer-runtime connection. Existing flows continue using their current providers until explicitly changed.

## Add the connection

1. With the user's existing Rakazo session, send `POST /api/model-bridge/grants` with `Content-Type: application/json` and the current `x-rakazo-space-id`. Select the user's saved model connection ID from Rakazo's existing `models.list` RPC and a model offered by that provider:

   ```json
   { "credentialId": "saved-connection-id", "modelId": "saved-model-id" }
   ```

   The response contains `id`, `apiKey`, `model`, and `basePath`. `apiKey` is a new bridge capability, not the subscription OAuth token. It is returned only at creation. No additional provider login occurs.

2. In OpenRAG, open **Edit in Langflow**. Add an **OpenAI Compatible** model provider with the Rakazo API origin plus the returned `basePath`, for example `https://rakazo.example.test/api/model-bridge/v1`. Use the returned bridge `apiKey` in its API-key field. Select the returned model for the intended flow's language-model input. Keep other flows and the embedding provider unchanged.

   On older bundled Langflow versions without the OpenAI Compatible registry entry, use an OpenAI language-model component with the same API base, API key, and model name, and connect its language-model output to the Agent's custom model input. Use Chat Completions, not the Responses API. OpenRAG's standard OpenAI settings alone may not expose a custom base URL.

3. Verify discovery with `GET <base>/models` using `Authorization: Bearer <bridge-key>`. It returns only the granted model. Start a fresh OpenRAG conversation to use the changed flow.

OpenRAG documents editing its embedded [Langflow flows](https://docs.openr.ag/agents/). Current Langflow documents the [OpenAI Compatible provider](https://docs.langflow.org/bundles-openai-compatible), including host allowlisting for private endpoints. For containers, the base URL must reach Rakazo from the Langflow container; `localhost` refers to that container. Restrict any required Langflow host allowlist to the Rakazo host. Send bridge keys over HTTPS outside a trusted local connection.

If a Langflow installation only permits one generic compatible-provider entry, use a separate model component for this path instead of overwriting an existing provider. Store each user's bridge key separately; a global provider in a shared Langflow workspace would make that user's subscription available to other flows with access to it.

## Contract and limits

- `GET /api/model-bridge/v1/models` discovers the single granted model.
- `POST /api/model-bridge/v1/chat/completions` accepts text messages, system/developer instructions, function tools, assistant tool calls, and matching tool results. Both JSON and SSE responses are supported, including streaming usage metadata.
- Supported controls are `temperature`, `max_tokens` or `max_completion_tokens` up to 8,192, `reasoning_effort`, `tool_choice: auto | none`, `n: 1`, and `response_format: {type: text}`. Omitted token limits are capped at 8,192 and the provider model limit. The provider may impose its own limits.
- Images, embeddings, provider-native tools, forced tool selection, structured-output guarantees, and arbitrary provider parameters are rejected rather than silently changed. Configure embeddings separately.
- Request bodies are limited to 1 MiB, model requests time out after two minutes, and each API process admits at most two simultaneous bridge requests per saved connection. This is a concurrency bound, not a distributed quota or spending limit. Subscription limits still apply.
- The bridge does not automatically retry failed model requests. Provider failures become generic errors without provider response bodies or credentials. Disconnecting a streaming client cancels its upstream request.

## Authorization and revocation

Only an authenticated Rakazo user can create/list/revoke their own workspace's grants. Model endpoints require the separate bearer key; session cookies do not authorize model requests. Each key is restricted to one connection and model. Every new request checks current workspace membership and connection ownership.

OAuth access and refresh tokens stay encrypted in Rakazo. The shared credential loader refreshes and persists them through the same path used by internal Pi turns. It never falls back to the deployment model key for bridge requests. Existing process-local credential refresh serialization is shared with Pi; this does not add cross-process refresh locking.

List grants with `GET /api/model-bridge/grants` and revoke one with `DELETE /api/model-bridge/grants/<id>`, using the same Rakazo session. Listing never returns bridge keys or OAuth tokens. Revocation, removing workspace membership, or deleting the saved model connection denies subsequent requests. Already admitted requests may complete. Grant records use the existing encrypted secret store, so no database migration is required.

## Verification

Run `pnpm exec vitest run packages/adapters/src/model-bridge.test.ts apps/api/src/model-bridge.test.ts` for offline provider and HTTP tests. These cover tool calls, streaming, OAuth refresh persistence, ownership, revocation, cancellation, and sanitized errors using synthetic provider responses. No subscription credentials or paid model requests are used.

Saved compatible endpoints register their configured model before grant validation, so custom model IDs need not appear in Pi’s static catalog. Keyless local endpoints use the same local-model credential convention as Pi; bridge requests never borrow a deployment provider key.
