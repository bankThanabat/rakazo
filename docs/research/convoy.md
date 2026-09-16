# Convoy self-hosting and webhook delivery

Checked 2026-09-15 against official documentation and stable release `v26.7.6`, commit `1b00315bfe04321cb0d0f1dbf6993bcb71b8f4c8`. The annotated tag object is `c0c9fd8c98d6195b7a71082bc76dd11732f64581`; it is not the source commit. Findings below are documentation and source inspection, not a capacity benchmark or an end-to-end LINE test. [Release](https://github.com/frain-dev/convoy/releases/tag/v26.7.6)

## Conclusion

Convoy supplies incoming webhook verification and HTTP delivery with retries. Deploy the Community edition for operator evaluation using PostgreSQL and Redis. The chosen two-core, 4 GiB VPS is below the published production sizing guidance. Installing it does not complete Rakazo's customer authentication, offline delivery, or customer runtime integration.

## Deployment baseline

- Use the official `getconvoy/convoy:v26.7.6` image and record its resolved digest in the deployment. Avoid moving `latest` tags. The release's Docker build workflow publishes the `getconvoy/convoy` repository. [Image workflow](https://github.com/frain-dev/convoy/blob/v26.7.6/.github/workflows/build-image.yml)
- The current release's local Compose starts PostgreSQL, Redis, a one-shot `migrate up`, then `server` and `agent`. Its older `configs/docker-compose.templ.yml` still contains separate worker/scheduler/ingest commands; use the current local example and release CLI as references. Server health is `/healthz` on port 5005, agent health on 5008. Replace demonstration credentials and keep databases off public ports. [Release Compose](https://github.com/frain-dev/convoy/blob/v26.7.6/configs/local/docker-compose.yml)
- PostgreSQL 15+ stores records; Redis 6+ provides the default queue and related state. PostgreSQL queue mode is experimental and paid, so Redis remains part of this Community deployment. The docs recommend 2 GB per server and agent replica, 4 GB for PostgreSQL, and 2–4 GB for Redis. A combined 4 GiB installation needs measured limits and disk/backlog monitoring; successful startup would only establish small-workload feasibility. [Architecture](https://www.getconvoy.io/docs/deployment/architecture), [Postgres queue](https://www.getconvoy.io/docs/product-manual/postgres-queue)
- Reuse the existing reverse proxy. Keep operator setup private until a unique administrator credential is established, disable public signup afterward, and generate independent JWT secrets. The release example enables signup and contains development JWT secrets; these are examples, not production defaults to reuse. [Example configuration](https://github.com/frain-dev/convoy/blob/v26.7.6/configs/local/convoy.json)

## Community edition and license

An empty license key with organization billing disabled constructs the local Community licenser without remote license validation. That path enforces one user, one organization, and two projects. It does not require a Convoy Cloud subscription. This is source inspection of the free license path, not a claim that every optional feature makes no external requests. [Release licenser](https://github.com/frain-dev/convoy/blob/v26.7.6/internal/pkg/license/service/licenser.go#L96)

Paid features include customer portal links, RBAC, metrics export, performance tuning, transformations, advanced filtering, and unlimited users/organizations/projects. Therefore a separate project for every Rakazo customer is not a Community deployment design. Keep Convoy operator credentials on Rakazo's trusted backend and implement customer ownership there. [Paid features](https://www.getconvoy.io/docs/business-and-enterprise/paid-features)

Automatic retention/partition dropping is documented as paid-only. Setting a retention period must not be presented as working Community cleanup. Monitor database growth and establish a supported retention plan before sustained ingestion. [Retention policy](https://www.getconvoy.io/docs/product-manual/retention-policy)

Convoy uses Elastic License 2.0, a source-available license with restrictions on providing substantial software functionality as a hosted service, bypassing license gates, and removing notices. Internal product use is different from selling Convoy access: Elastic's FAQ permits some embedded SaaS uses. That FAQ is explanatory and does not grant permission from Convoy. Rakazo's eventual customer-facing relay should have its exact feature exposure checked with Convoy before launch; neither a blanket SaaS prohibition nor unconditional permission follows from this research. [Release license](https://github.com/frain-dev/convoy/blob/v26.7.6/LICENSE), [ELv2 FAQ](https://www.elastic.co/licensing/elastic-license/faq)

## LINE ingestion

LINE signs the unchanged request body with the channel secret using HMAC-SHA256 and sends the Base64 signature in `X-Line-Signature`. [LINE signature verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

The release's generic HTTP source verifier supports this configuration:

| Field | Value |
| --- | --- |
| Verifier | `hmac` |
| Hash | `SHA256` |
| Encoding | `base64` |
| Header | `X-Line-Signature` |
| Secret | The channel's secret, supplied privately |
| Provider override | Omitted |

The handler tries raw-body verification first, and the verifier uses constant-time HMAC comparison. This indicates protocol compatibility without a custom LINE plugin. It still needs a signed test through the deployed proxy, rejection of tampered/missing signatures, and a real LINE webhook check. [Ingest handler](https://github.com/frain-dev/convoy/blob/v26.7.6/api/ingest.go#L189), [Verifier](https://github.com/frain-dev/convoy/blob/v26.7.6/pkg/verifier/verifier.go#L71)

## Delivery to customer machines

HTTP endpoints receive delivery attempts according to a configured retry schedule. A finite retry schedule does not guarantee delivery after arbitrary offline periods. [Retry schedule](https://www.getconvoy.io/docs/glossary/retry-schedule)

The published Convoy CLI documentation describes local debugging through streamed events. However, inspection of the selected release found no active WebSocket server or device/stream routes, despite leftover models and mocks. Treat the old CLI page as insufficient evidence of supported streaming in this release. Do not make it Rakazo's production delivery contract. [CLI documentation](https://www.getconvoy.io/docs/cli-file/convoy-cli), [Release routes](https://github.com/frain-dev/convoy/blob/v26.7.6/api/api.go), [Release source tree](https://github.com/frain-dev/convoy/tree/v26.7.6)

Rakazo still needs an authenticated route to machines behind NAT, tenant ownership checks, durable local acknowledgments, deduplication, and a replay policy for extended offline periods. Choose either a secured tunnel to a customer HTTP endpoint or a Rakazo delivery gateway accepting Convoy HTTP deliveries and serving authenticated outbound customer connections. Test process restarts and disconnection/reconnection before promising offline delivery. This is an architectural inference, not functionality demonstrated by this research.

## Deployment verification

The selected release was subsequently installed using the [Compose definition](../../infra/compose/convoy-droplet.yml) and [setup script](../../scripts/setup-convoy.py). The [verification script](../../scripts/verify-convoy.py) passed HTTPS and authentication checks, synthetic LINE-format signature rejection, delivery retry after HTTP 503, and queued-event delivery after Redis restart with the agent stopped. Test resources were removed afterward. The origin certificate was independently verified, and the existing OpenConnector health check remained successful. These results do not establish real LINE channel operation, customer isolation, long offline recovery, or production capacity.
