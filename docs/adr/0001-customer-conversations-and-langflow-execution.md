---
status: accepted
date: 2026-09-15
---

# Rakazo owns customer conversations; Langflow runs customer agents

Rakazo will own customer conversations and call customer-specific Langflow flows directly, bypassing OpenRAG's `/v1/chat` wrapper. OpenRAG will provide document ingestion and knowledge search. Customer-flow definitions and integration code will live in Rakazo so this workflow requires no source changes to OpenRAG or Langflow.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Rakazo | Conversation history, staff instructions, immutable behavior revisions, customer identity, authorization, tool grants, and reply delivery. |
| Langflow | Run the customer agent's reasoning, model calls, and approved tool calls. |
| OpenRAG | Ingest documents and provide knowledge through its supported search API. |
| OpenConnector | Execute connected-service actions authorized by Rakazo. |

OpenRAG and Langflow remain on the operator's machine in the planned deployment. Customer messages reach that machine through the cloud delivery service. Rakazo owning the conversation does not move agent execution into Rakazo's internal staff agent or into the cloud relay.

## Consequences

- Rakazo publishes and selects customer flows through Langflow's supported APIs. Flow publication must preserve immutable revisions so active turns keep their selected behavior.
- Rakazo must explicitly configure model connections, retrieval, execution credentials, session handling, and response parsing. OpenRAG's chat-wrapper settings and conversation handling do not automatically carry over. The optional Rakazo model bridge can supply model completions while Langflow retains the agent loop.
- Knowledge searches use OpenRAG's supported API, currently `POST /v1/search`. Rakazo derives the permitted knowledge scope from the approved behavior and authenticated execution. Customer input cannot select arbitrary filters or broaden access.
- Customer flows receive only approved customer tools. Rakazo checks ownership and grants on every business operation. Internal staff computer tools and administrative credentials are not available to the customer agent.
- Flow publication and runtime access remain backend operations. Credentials must not enter customer messages or model prompts.

## Implementation status

Implemented locally. The customer runtime publishes a new stock Langflow flow per
behavior revision and runs an operator-installed Rakazo component. The component
uses LangChain's agent engine, stateless history, scoped tool callbacks, and expiring
Rakazo model-bridge grants. OpenRAG retrieval uses its stock knowledge-filter and
search APIs with a separate credential.

The source patch installer is removed. See the [migration guide](../self-host/customer-v1.md).
Offline HTTP, PostgreSQL, and real LFX/LangChain component tests cover the new path.
Production deployment and a real provider/model acceptance journey remain required.

## Why

The earlier approach extended OpenRAG's chat wrapper to select customer flows and inject execution context. Calling Langflow directly keeps the agent in the intended engine and removes the need to maintain those OpenRAG patches, at the cost of explicitly managing the wrapper's relevant responsibilities in Rakazo. Moving the customer agent loop into Rakazo was considered and rejected for this design.
