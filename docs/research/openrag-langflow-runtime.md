# Stock OpenRAG and Langflow customer runtime

Checked 2026-09-15. OpenRAG source inspected at upstream `5cf69da5`; its Langflow image uses `langflow-base` 0.11.6 and its exported agent records that version. Package metadata and the LFX 1.11.6 wheel were also inspected. Current Langflow documentation describes 1.12.x, so deployment checks must use the installed component catalog and exercise the installed runtime. This note records API and source findings, not a successful live customer conversation. [OpenRAG Dockerfile](https://github.com/langflow-ai/openrag/blob/5cf69da5/Dockerfile.langflow), [package metadata](https://pypi.org/pypi/langflow-base/0.11.6/json)

## OpenRAG retrieval

The direct backend route is `POST /v1/search`. The TypeScript SDK uses `/api/v1/search` through the frontend proxy. An adapter configured with the backend origin must use the direct path. Authentication is `X-API-Key`; the search permission is `search:use`. The handler resolves the API-key user and supplies that user's identity to the search service. [Routes](https://github.com/langflow-ai/openrag/blob/5cf69da5/src/app/routes/public_v1.py), [SDK client](https://github.com/langflow-ai/openrag/blob/5cf69da5/sdks/typescript/src/client.ts), [search handler](https://github.com/langflow-ai/openrag/blob/5cf69da5/src/api/v1/search.py)

Request:

```json
{
  "query": "What is the return policy?",
  "filter_id": "approved-filter",
  "limit": 5,
  "score_threshold": 0
}
```

Response:

```json
{
  "results": [
    {
      "filename": "returns.pdf",
      "text": "Returns are accepted within the stated period.",
      "score": 0.9,
      "page": 1,
      "mimetype": "application/pdf"
    }
  ]
}
```

`query` is required. `filters`, `filter_id` are optional; defaults are `limit=10`, `score_threshold=0`. Blank queries return 400. There is no customer-flow field, revision field, or execution bearer in this API. [Search schema and response](https://github.com/langflow-ai/openrag/blob/5cf69da5/src/api/v1/search.py)

**A saved filter is not an immutable authorization boundary.** Explicit inline filter dimensions override saved dimensions, and `filters: {}` clears the saved filtering. Supported saved dimensions are `data_sources`, `document_types`, `owners`, and `connector_types`; saved wildcard `*` removes that dimension. Consequently, Rakazo must derive scope from the approved behavior and never forward customer-selected filters. A filter identifier alone also does not prove the upstream filter is unchanged after approval. [Filter resolution](https://github.com/langflow-ai/openrag/blob/5cf69da5/src/api/v1/_filter_resolution.py)

The search service maps `data_sources` to `filename`, `document_types` to `mimetype`, and `owners` to `owner`. An explicit empty list matches nothing. An omitted dimension does not restrict search. It obtains the authenticated user's OpenSearch client; do not replace that with a shared administrator client and call the filters tenant isolation. [Search service](https://github.com/langflow-ai/openrag/blob/5cf69da5/src/services/search_service.py)

## Langflow publication and execution

All management requests below use the Langflow `x-api-key` header. API keys stay on the trusted Rakazo backend.

| Operation | Request |
| --- | --- |
| Create | `POST /api/v1/flows/` with `{name, description, data: {nodes, edges}, is_component: false}` |
| Inspect | `GET /api/v1/flows/{id}` |
| Modify | `PATCH /api/v1/flows/{id}` |
| Delete | `DELETE /api/v1/flows/{id}` |

Creation returns the flow object with its `id`. Rakazo should create a new flow per immutable behavior revision rather than patch the flow used by an active turn. This is a Rakazo policy; Langflow permits modifications. [Management API](https://docs.langflow.org/api-flows)

Run the saved flow with `POST /api/v1/run/{id}?stream=false`:

```json
{
  "output_type": "chat",
  "output_component": "RakazoCustomer-example",
  "session_id": "opaque-turn-session",
  "tweaks": {
    "RakazoCustomer-example": {
      "run_payload": "<backend-generated JSON>",
      "execution_token": "<short-lived bearer>"
    }
  }
}
```

These field names are a proposed Rakazo component contract. Stock Langflow provides the `tweaks` transport. The ordinary response is nested: `outputs[].outputs[].results.message.text`. Select the intended component explicitly and validate the result instead of searching arbitrary nested strings for a reply. [Run API](https://docs.langflow.org/api-flows-run)

Source inspection confirms `output_component` takes precedence over the output-type heuristic. Graph result collection accepts a requested vertex ID or display name even when the vertex is not a built-in Chat Output. Thus a single installed component with a `Message` output can be selected without Chat Input or Chat Output nodes. Omit `input_value` when the component gets all inputs through tweaks. The implementation's real LFX 1.11.6 test confirms a single installed component
runs in restricted mode. Its selected text output appears at
`outputs[].outputs[].outputs.message.message` with `type: "text"`; its `results`
object is empty. The adapter uses this tested output shape, rather than the usual
Chat Output node's `results.message.text`. [Run implementation](https://github.com/langflow-ai/langflow/blob/main/src/backend/base/langflow/api/v1/endpoints.py), [graph implementation](https://github.com/langflow-ai/langflow/blob/main/src/lfx/src/lfx/graph/graph/base.py)

## Installed component contract

Use an operator-installed Rakazo component in a category directory beneath `LANGFLOW_COMPONENTS_PATH`, including `__init__.py`. This extends Langflow through its supported loader; it does not change OpenRAG or Langflow source. Retain `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false`. The documented default permits components from operator-configured paths; `LANGFLOW_ALLOW_COMPONENTS_PATHS_OVERRIDE=false` disables that exception. [Component installation](https://docs.langflow.org/components-custom-components), [restricted component mode](https://docs.langflow.org/deployment-block-custom-components)

The authenticated `GET /api/v1/all` endpoint returns component categories plus auxiliary display-name metadata. The LFX 1.11.6 catalog loader contributes `{bundle_name: {namespaced_id: template}}`. A path-installed class is addressed as `ext:<bundle>:<PythonClassName>@extra`. The template includes `namespaced_id`, `bundle`, `extension`, `extension_version`, and the component's `name`. Obtain the template from the installed catalog and preserve its canonical key and code. Restricted mode validates component code against server template hashes; an invented template or altered code is not equivalent to an installed component. [Catalog endpoint](https://github.com/langflow-ai/langflow/blob/main/src/backend/base/langflow/api/v1/endpoints.py), [LFX package](https://pypi.org/project/lfx/1.11.6/), [catalog implementation](https://github.com/langflow-ai/langflow/blob/main/src/lfx/src/lfx/interface/components.py), [validation implementation](https://github.com/langflow-ai/langflow/blob/main/src/lfx/src/lfx/utils/flow_validation.py)

The minimum proposed graph has one node and no edges:

```text
data.nodes[0].id = stable node identifier
data.nodes[0].type = "genericNode"
data.nodes[0].position = {x: 0, y: 0}
data.nodes[0].data.id = same node identifier
data.nodes[0].data.type = canonical catalog key
data.nodes[0].data.node = complete installed catalog template
data.edges = []
```

For a `Component`, its template `_type` and output definitions must be retained. Normal multi-node graphs additionally need source/target handles with output and input types; do not guess these from display names. [Exported graph structure](https://docs.langflow.org/concepts-flows-import), [vertex parser](https://github.com/langflow-ai/langflow/blob/main/src/lfx/src/lfx/graph/vertex/base.py)

## Model bridge, credentials, and history

Langflow supports OpenAI-compatible model endpoints and can supply such a model to an agent. The stock OpenRAG model component itself uses `ChatOpenAI` with `base_url`, `api_key`, and model name. Rakazo's bridge can fill that protocol boundary while the customer agent loop continues inside Langflow. [Language model configuration](https://docs.langflow.org/components-models), [OpenRAG model component](https://github.com/langflow-ai/openrag/blob/5cf69da5/custom_components/openrag/openai_compatible_llm.py)

Proposed Rakazo boundary: construct the run request exclusively on the backend. Provide approved history/instructions plus short-lived execution and model-bridge tokens in secret inputs. The tool closure holds tokens and callback addresses outside the model-visible tool schema. Every callback resolves the execution and its approved grants again; customer/model arguments cannot choose tenant, conversation, credentials, callback URL, flow, or knowledge scope. Do not save transient tokens in flow templates or log request bodies. Secret input masking alone is not authorization.

Stock Langflow also supports request-local `X-LANGFLOW-GLOBAL-VAR-*` headers, which override environment values and are not persisted as globals. This is an alternative to secret tweaks, not a reason to accept arbitrary forwarded headers from public callers. [Run variables](https://docs.langflow.org/api-flows-run)

Rakazo owns history. A component using a fresh agent without a checkpointer must consume the authorized history Rakazo provides and avoid Langflow message storage. If built-in nodes are used instead, disable Chat Input/Output `should_store_message` and Agent `n_messages`; stock agent code explicitly treats zero messages as memory disabled. Never omit an opaque session ID: Langflow otherwise defaults to the flow ID. [Session behavior](https://docs.langflow.org/session-id), [stock exported agent](https://github.com/langflow-ai/openrag/blob/5cf69da5/flows/openrag_agent.json)

## Verification required

Exercise the installed component with real LFX/LangChain libraries, deterministic model/tool fixtures, and restricted component mode. Verify graph publication and selection, one model/tool cycle, scoped retrieval, malformed output rejection, token expiry/revocation, missing component behavior, history isolation, retries, and cancellation. Mock HTTP tests alone cannot establish that a Langflow graph is executable. Keep OpenRAG retrieval and Langflow execution credentials distinct. No source patches or custom OpenRAG routes are required by this design.
