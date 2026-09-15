---
status: accepted
date: 2026-09-15
---

# Use Convoy for the webhook relay

Use self-hosted Convoy to receive, persist, route, and retry webhook deliveries. Remove Kafka entirely from the planned deployment and integration requirements. Reusing Convoy's delivery machinery reduces custom relay code and avoids operating a second queue.

The planned cloud stack is Caddy, OpenConnector, Convoy server and agent, PostgreSQL, and Redis. Convoy uses Redis for its default task queue and PostgreSQL for storage; Kafka ingestion is optional and will not be configured. See [Convoy architecture](https://www.getconvoy.io/docs/deployment/architecture).

Rakazo continues to own customer authentication, provider-account ownership, and authorization. Delivery to customer machines must support outbound connections, offline recovery, and acknowledgments after durable local receipt. Convoy's debugging CLI is not evidence that these production requirements are met. OpenRAG, OpenSearch, Docling, and Langflow stay on the operator's machine as described in [ADR 0001](0001-customer-conversations-and-langflow-execution.md).

## Implementation status

Convoy Community v26.7.6 is deployed with PostgreSQL and Redis. The [deployment guide](../self-host/convoy-droplet.md) includes repeatable setup and verification scripts. HTTPS, administrator authentication, LINE-format signature rejection, HTTP retries, and recovery of a queued event after Redis restart were verified with synthetic data. The Rakazo [integration gateway](../self-host/integration-gateway.md) now implements runtime ownership, Convoy provisioning and outbound delivery into the local inbox. Database conformance tests cover cross-customer denial, failed acknowledgments and duplicate delivery. The gateway application changes still need deployment and a real LINE channel test. Measure the complete stack under expected traffic before making capacity claims for a small VPS.

Before public rollout, verify tenant isolation, provider signature checks, offline recovery, duplicate handling, retention, and restart durability. Confirm that the intended customer-facing use complies with Convoy's [Elastic License 2.0](https://github.com/frain-dev/convoy/blob/main/LICENSE), which restricts hosted services exposing substantial software functionality. This architecture decision does not establish license clearance.
