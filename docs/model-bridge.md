# Reuse a Rakazo model connection in OpenRAG

The optional Rakazo model bridge lets a Langflow/OpenRAG flow use a model connection already saved in Rakazo, including subscription OAuth. It makes one model completion per request through Pi's provider adapters. Langflow keeps its agent loop, retrieval, and tool execution. The bridge does not run a Rakazo staff agent or expose its tools, memory, or instructions.

This adds a connection path. It does not replace OpenRAG login, its API authentication, existing model provider credentials, embeddings, or the Rakazo customer-runtime connection. Existing flows continue using their current providers until explicitly changed.

## Add the connection

1. With the user's existing Rakazo session, send `POST /api/model-bridge/grants` with `Content-Type: application/json` and the current `x-rakazo-space-id`. Select the user's saved model connection ID from Rakazo's existing `models.list` RPC and a model offered by that provider:

   ```json
   { "credentialId": "saved-connection-id", "modelId": "saved-model-id" }
   ```

   The response contains `id`, `apiKey`, `model`, and `basePath`. `apiKey` is a new bridge capability, not the subscription OAuth token. It is returned only at creation. No additional provider login occurs.

2. For the pinned OpenRAG customer stack, configure its chat gateway with the returned model and bridge key. Use the existing generic `custom_openai` provider, with `api_base` set to the Rakazo API origin plus `basePath`. The authenticated OpenRAG `POST /onboarding` request accepts:

   ```json
   {
     "llm_provider": "custom_openai",
     "llm_model": "saved-model-id",
     "provider_credentials": {
       "custom_openai": {
         "api_base": "https://rakazo.example.test/api/model-bridge/v1",
         "api_key": "bridge-key-placeholder"
       }
     }
   }
   ```

   To expose this provider in OpenRAG's UI, extend its `src/config/model_providers.yaml` through `OPENRAG_MODEL_PROVIDERS_CONFIG`, adding `custom_openai` with the granted model and the applicable run mode. Restart OpenRAG after changing the provider catalogue. Configure embeddings separately, for example with an existing local Ollama connection. The bridge serves chat only.

   Managed customer flows use the shipped OpenRAG LLM component. OpenRAG keeps the bridge key and injects short-lived callback tokens into Langflow. Apply the [customer-stack source patch](self-host/customer-v1.md#install-the-compatible-sources) and rebuild Langflow so the shipped customer-tools component is registered while custom-code restrictions remain enabled. Publish customer behavior through Rakazo to create a new flow revision.

   For a standalone Langflow flow, an OpenAI-compatible model component can call the bridge directly with the same base URL, bridge key, and model. Select Chat Completions and omit `seed`; the bridge rejects unsupported parameters.

3. Verify discovery with `GET <base>/models` using `Authorization: Bearer <bridge-key>`. It returns only the granted model. Start a fresh OpenRAG conversation to use the changed flow.

OpenRAG documents editing its embedded [Langflow flows](https://docs.openr.ag/agents/). Current Langflow documents the [OpenAI Compatible provider](https://docs.langflow.org/bundles-openai-compatible), including host allowlisting for private endpoints. The base URL must reach Rakazo from the process making the model request: the OpenRAG backend for managed flows, or Langflow for a direct connection. In a container, `localhost` refers to that container. Restrict any required Langflow host allowlist to the Rakazo host. Send bridge keys over HTTPS outside a trusted local connection.

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
