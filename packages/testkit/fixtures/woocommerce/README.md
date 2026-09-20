# Disposable WooCommerce purchase check

From the repository root, run the driver against an OpenConnector checkout with
the order-payment and Store API patches applied. Docker Engine, Compose and a compatible Node.js
runtime and this workspace's installed development dependencies are required. Use a separate source checkout so other work is preserved.

```sh
WOO_ACCEPTANCE_SOURCE="$(mktemp -d "${TMPDIR:-/tmp}/deskazo-woo-source.XXXXXX")"
git clone https://github.com/oomol-lab/open-connector.git "$WOO_ACCEPTANCE_SOURCE"
git -C "$WOO_ACCEPTANCE_SOURCE" checkout 9e11b04c46df3cefad0bed1d4f2765e24d2ef126
git -C "$WOO_ACCEPTANCE_SOURCE" apply "$PWD/infra/open-connector-patches/woocommerce-order-payment.patch"
git -C "$WOO_ACCEPTANCE_SOURCE" apply "$PWD/infra/open-connector-patches/woocommerce-store-api.patch"
(cd "$WOO_ACCEPTANCE_SOURCE" && npm ci && npm run generate:catalog && npm run fix-check && npm test -- src/providers/woocommerce/order-payment.test.ts src/providers/woocommerce/store-api.test.ts)
node scripts/verify-woocommerce-patches.mjs "$WOO_ACCEPTANCE_SOURCE"
node scripts/verify-woocommerce-purchase.mjs "$WOO_ACCEPTANCE_SOURCE"
```

The driver downloads WooCommerce 11.1.0 from the official distribution and verifies
its fixed SHA-256. Compose pins WordPress, WP-CLI and MariaDB images by digest.
The observed WordPress version is 7.1. Only the plugin ZIP is cached under the
ignored `test-report` directory. Temporary API keys stay in memory and the
disposable database. No credentials or customer capability URLs are printed.

Each run uses a random Compose project, an internal network, private volumes and
no host ports. WordPress HTTP requests and email are disabled. The test transport
runs HTTP inside the owned container and simulates TLS termination for REST Basic
authentication. Production URL validation, DNS checks and TLS remain unchanged and
are not exercised here. The `finally` block removes the project's containers,
network and volumes and verifies their absence. SIGINT and SIGTERM abort active
commands before cleanup. An uncatchable process termination or unavailable Docker
daemon may require removing the project named in the startup line manually.

The check uses real WooCommerce HTTP handlers to verify current product data,
order creation, cart separation, invalid cart capabilities, an increased checkout
total, bank-transfer checkout, order readback and the connector's payment fields.
The connector actions also exercise item addition, quantity changes, removal,
coupons, customer details, shipping-rate selection and delivery-inclusive totals.
The submitted physical order is checked through the separate administrative order
read. All eleven Store API actions pass their input and output contracts.
The driver also loads the application's WooCommerce checkout adapter. It loses one
real checkout response deliberately, recovers through the exact saved order note,
rejects a wrong reference, and refreshes provider payment facts without resubmission.
It verifies that `set_paid` is ignored for an on-hold bank transfer with no payment
needed, then explicitly marks the synthetic order completed. No gateway is charged.
An administrative fixture mutation records a synthetic transaction and paid date.
It does not charge a gateway or establish actual funds received.

The report records the source revision and hashes of six provider files, including
both test modules, plus hashes of the application adapter, purchase contracts and
canonical JSON helper used by the application check. It rejects unrelated tracked changes and untracked source files.
The patch verifier applies both patches in a fresh disposable checkout and compares
all six hashes with the tested source. Its optional `--write` regenerates the Store
API patch against the pinned revision plus the existing payment patch, then verifies
both together. This does not change the supplied source checkout.
No deployment is performed. A release must include the patch in its reviewed
source commit before the deployment guide's `git archive` step; that command
excludes uncommitted changes.

This is provider acceptance for a pinned local fixture. Deskazo's authenticated
customer confirmation workflow, gateway payments, invoice creation, full recovery
across account/connection deletion and hosted runtime parity need separate acceptance. The Store API actions
return secret cart capabilities and private provider payloads. They are not enabled
for customer agents. Backend custody, redaction, serialized token rotation and a
durable purchase lifecycle must precede customer use. The current checkout action
supports methods needing no additional payment data, and never accepts card details
or creates a customer account. A bank-transfer success result still means unpaid.
