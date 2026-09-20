# Deskazo integrations: OpenConnector first, Thailand next

Research date: 18 September 2026. Research and specification only; no integration
implementation, provider account connection, or live customer action was performed.

## Decision

Use existing OpenConnector actions for the first complete merchant workflow.
Then extend OpenConnector for Thai services and missing channel capabilities,
keeping provider-specific work in the connector layer. Do not interpret this as
implementing all catalog apps before addressing the next high-demand gap.

Start with LINE OA and Instagram, Shopify Admin/Storefront or WooCommerce,
Google Sheets/Drive, optional HubSpot, and an invoice provider the pilot merchant
already uses. Xero and Invoice Ninja have invoice-creation actions; neither is
established here as a Thai tax-invoice solution. This is an achievable pilot
scope, not evidence of full Thai market coverage.

The strongest next-demand candidates are Facebook Pages/Messenger, Shopee,
TikTok Shop, Lazada, LINE SHOPPING, Thai accounting and stock tools, and local
B2C CRM. Several are entirely absent as native providers; others have a provider
entry but lack the needed operations. Do not force merchants to migrate stores
or accounting systems merely to fit the current catalog.

## What was inventoried

The repository pins OpenConnector at `493def090c95a92ee312b95594c489c9856a16af`.
The official upstream HEAD inspected was
`20f86718e7bb938c2d4380c8bbb335cbaebb94bc`, dated 18 September 2026.
The screenshots' five counts exactly match the pinned snapshot. This matches
catalog metadata; it does not identify the revision running on a deployed server.

| Screenshot category | Pinned providers | Current upstream providers | Relevant examples |
| --- | ---: | ---: | --- |
| E-commerce operations | 32 | 32 | Shopify Admin and Storefront, WooCommerce, BigCommerce, Adobe Commerce, BaseLinker, Cin7 Core, AfterShip, 17TRACK |
| Team collaboration | 171 | 172 | LINE, WhatsApp, Telegram, Gmail, Slack, Feishu, Intercom, Zendesk; Microsoft Teams is new upstream |
| Docs & knowledge | 11 | 11 | Google Drive, Google Docs, Notion, Dropbox, Box, Confluence |
| Marketing & growth | 185 | 185 | Instagram, HubSpot, Freshsales, Meta Ads, TikTok Business, Google Ads, Google Analytics, Mailchimp, Ayrshare |
| Data & analytics | 289 | 294 | BigQuery, Databricks, Metabase, Supabase, OneDrive, Xero |
| **These five categories** | **688** | **694** | Discovery groups, not verified end-to-end workflows |
| Entire catalog, including other categories | 1,502 | 1,516 | Full inventory checked to avoid false absence claims |

Counts come from importing every provider definition and running the upstream
scenario resolver, not from guessing categories by app name. The complete
[TSV inventory](deskazo-openconnector-catalog.tsv) records all 1,516 current
providers, their category, authentication types, action IDs, executor-file
presence, and immutable source links. Filter its `scenario` column for the five
categories above. [Pinned source][oc-pinned], [current source][oc-current],
[scenario rules][oc-scenarios].

CRM and invoicing are not confined to the five pictured categories. Google Sheets,
Excel, Airtable, Pipedrive, Invoice Ninja and Elorus are under Productivity; Xero is under
Data & analytics. The research includes these because the business workflow needs
them. A catalog category does not determine a tool's business role.

## Exact useful actions already inside OpenConnector

Counts below are current upstream action definitions. The shortlisted counts also
exist in the pinned revision unless noted. Executor files exist for these providers;
source inspection is not live API certification.

| Area | Provider and action count | What the current connector can contribute | Boundary to retain |
| --- | --- | --- | --- |
| Customer messaging | LINE, 5 | Bot/profile reads; push, multicast and broadcast text. [Actions][oc-line] | No prebuilt reply-token action, history fetch or incoming subscription action. Deskazo's existing LINE receive binding is a separate layer. LINE OA is not LINE SHOPPING. |
| Social and brand content | Instagram, 9 | Owned media and comments, comment creation/reply, DM send, publishing and insights. [Actions][oc-instagram] | No DM conversation-history action. Incoming delivery, subscriptions, account review and multi-account routing remain separate. |
| Regional messaging | WhatsApp, 17 | Send text/media/templates; profile, numbers, media and template operations. [Actions][oc-whatsapp] | No general chat-history import or incoming webhook setup action in this list. Complete the official Cloud API receive path before advertising the channel. |
| Messaging/alerts | Telegram, 50 | Send, polling, webhook configuration, chat and message operations. [Actions][oc-telegram] | Useful for configured human alerts or Telegram merchants; no evidence here makes it Thailand's primary shopping channel. |
| Owned stores | Shopify Admin, 26 | Products, variants, stock quantities, customers, orders, fulfillment and GraphQL. [Actions][oc-shopify-admin] | Use `shopify_admin`, not the legacy `shopify` connector. Explicit GraphQL operations still need scoped authorization. |
| Purchase assistance | Shopify Storefront, 8 | Product reads, cart creation, cart reads and adding lines. [Actions][oc-shopify-storefront] | A cart is not a confirmed paid order. Verify checkout handoff and order/payment confirmation separately. |
| Owned stores | WooCommerce, 26 | Products/variants, customers, orders/notes/status, coupons and media. [Actions][oc-woocommerce] | Plugin-specific behavior, tax documents and payment confirmation need merchant acceptance. |
| Existing OMS | BaseLinker, 6; Cin7 Core, 5 | BaseLinker inventory lists, warehouse/product lists, orders/events; Cin7 customer/product reads. [BaseLinker][oc-baselinker], [Cin7][oc-cin7] | These are bounded read workflows, not full stock reservation, invoicing or marketplace chat. Assess only when merchants already use them. |
| Delivery context | AfterShip, 9; 17TRACK, 4 | Shipment tracking lookup and registration. [AfterShip][oc-aftership], [17TRACK][oc-17track] | Delivery tracking does not establish carrier label purchasing or order fulfillment. |
| Sales/stock sheets | Google Sheets, 40; Excel, 31 | Read and write cells/rows; Sheets includes row lookup and upsert. [Sheets][oc-sheets], [Excel][oc-excel] | Configure file/table and field mappings. A spreadsheet is not automatically a transactional inventory system. |
| Knowledge documents | Google Drive, 43; Docs, 32; Notion, 25; Dropbox, 24 | Read selected documents, export/download and update content as supported. [Drive][oc-drive], [Docs][oc-docs], [Notion][oc-notion], [Dropbox][oc-dropbox] | Knowledge ingestion, source permissions, refresh and deletion still belong in Deskazo's workflow. |
| CRM | HubSpot, 26; Pipedrive, 27; Freshsales, 6 | HubSpot and Pipedrive contacts/companies/deals; Freshsales contact operations. [HubSpot][oc-hubspot], [Pipedrive][oc-pipedrive], [Freshsales][oc-freshsales] | Recommend HubSpot first when a CRM is wanted; do not make a CRM mandatory for merchants using Sheets. |
| Invoicing | Xero, 15; Invoice Ninja, 11; Elorus, 12 | Invoice creation/read plus contact/client operations. [Xero][oc-xero], [Invoice Ninja][oc-invoice], [Elorus][oc-elorus] | Validate the merchant's document type, country, tax setup, provider terms and retry behavior. No Thai tax compliance claim. |
| Marketing/reporting | Google Analytics, 28; Google Ads, 9; Mailchimp, 11 | Analytics reports, ads operations and email-marketing actions. [Analytics][oc-ga], [Ads][oc-ads], [Mailchimp][oc-mailchimp] | Later staff reporting; these do not unblock the reply-to-sale loop. |
| Data/reporting | BigQuery, 32; Metabase, 28; Supabase, 23; Databricks, 36 | Query or manage configured data sources. [BigQuery][oc-bigquery], [Metabase][oc-metabase], [Supabase][oc-supabase], [Databricks][oc-databricks] | Advanced existing-customer options, not four new V1 onboarding requirements. |

For all other providers in the five categories, use the full TSV rather than
interpreting this shortlist as the complete catalog.

### Important partial-coverage traps

- **Meta is ads-only here:** four actions for user, ad accounts, campaigns and
  insights. No prebuilt Facebook Page posts, public-comment replies or Messenger
  receive/send/history actions. [Source][oc-meta]
- **TikTok Business is ads/GMV Max here:** 15 actions plus a separate two-action
  MCP discovery/call wrapper. Neither establishes TikTok Shop orders or customer
  service, TikTok business DMs, or owned-video comment replies. [Source][oc-tiktok]
- **Legacy Shopify is content-only here:** its 13 actions handle shop/blog/page
  reads. Product, stock and order work is in Shopify Admin. [Source][oc-shopify]
- **Stripe has no invoice-creation action here:** its 18 actions cover account,
  customer, product and price operations. Stripe's broader API capabilities must
  not be attributed to this connector. [Source][oc-stripe]
- **Indirect mentions are not native merchant integrations:** Sorftime's Shopee
  product research, LinkFox/UnifAPI TikTok content reads and RedFox WeChat article
  discovery do not provide merchant orders, private chats or authoritative stock.
  [Sorftime][oc-sorftime], [LinkFox][oc-linkfox], [RedFox][oc-redfox]
- **Aggregators are also partial:** Unipile has six account/chat/message reads but
  no send action; Ayrshare has eleven posting/history/analytics actions but no
  messaging/comment actions; respond.io has thirteen contact/assignment operations
  but no customer send action. Their own products can offer more than these
  connector definitions. [Unipile][oc-unipile], [Ayrshare][oc-ayrshare],
  [respond.io][oc-respondio]. For example, Ayrshare itself documents messaging and
  comment APIs that would require connector extension. [Official API overview](https://app.ayrshare.com/docs/apis/overview)

## Thai demand and the missing pieces

Market demand and implementation readiness are different rankings. The Thai
MarTech survey identifies useful CRM, OMS and workplace candidates, but is a
survey of MarTech users, not a census of Deskazo's exact customer segment.
Provider customer totals also use different definitions. See the
[business-tools evidence](deskazo-thai-business-tools.md) for the original surveys,
API access requirements and accounting distinctions.

Momentum Works' 2025 Thai platform-GMV estimate places Shopee at 50%, TikTok Shop
at 32% and Lazada at 18%. That supports the marketplace sequence below; it does
not measure chat volume. [Original April 2026 report, country chart](https://thelowdown.momentum.asia/wp-content/uploads/2026/04/Embargoed-Press-release-Momentum-Works-Ecommerce-in-SEA-2026.pdf)

| Extension candidate | OpenConnector status | Why it matters and proposed next step |
| --- | --- | --- |
| Facebook Pages/Messenger | Native customer operations missing; Meta ads connector is partial | High Thai social-commerce relevance. Add owned posts/comments and Messenger as separate capabilities. Verify app review, business access and message windows. |
| Shopee | Native merchant connector absent; research-data providers do not count | First marketplace by the cited Thai GMV estimate. Establish current partner access, product/stock/order APIs and separate chat entitlement. |
| TikTok Shop and TikTok business messaging | Needed operations absent despite TikTok ads entries | Second Thai marketplace. Shop commerce/chat and non-Shop business DMs/comments use distinct APIs and access checks. |
| Lazada | Native provider absent | Third Thai marketplace. Commerce and IM chat have distinct application/permission paths. |
| LINE SHOPPING/MyShop | Native commerce provider absent; LINE Messaging exists | Relevant Thai SME commerce path with public product, stock, order, checkout-link and order-webhook APIs. Admin-issued merchant authorization is separate from OA messaging. [Official API](https://www.line-website.com/oaplus-public-api-doc-client/) |
| FlowAccount | Absent | First proposed Thai invoice extension because a local document workflow and public API are documented. This is a feasibility recommendation, not a verified market-share lead. |
| ZORT | Absent | First proposed Thai stock/OMS extension with documented API access and a partner authorization path. |
| PEAK | Absent | Alternative Thai invoice/accounting extension, driven by merchants' existing accounts and API plan eligibility. |
| Page365 | Absent | Strong Thai OMS survey signal; begin partner/API discovery early. General merchant API access was not established. |
| ChocoCRM | Absent | Strong Thai B2C CRM survey signal; validate supported partner API access before promising integration. |
| Readyplanet R-CRM | Absent | Local B2B CRM option. Documented lead intake/webhooks do not establish unrestricted CRM CRUD. |
| Shipnity, Sellsuki | Absent | Relevant local workflow candidates, but general independent-app API access needs confirmation. Customer-led discovery. |
| Zoho CRM/Bigin/Books, Salesforce, QuickBooks | Absent | Add for actual merchant demand, not assumed Thai SME leadership. Distinct apps require distinct connectors and entitlements. |
| Looker Studio | Absent | Thai dashboard demand exists, but use connected Sheets/GA4 or warehouse data first. Its API is not a universal dashboard-data reader. |

The [social/commerce report](deskazo-thai-social-commerce.md) supplies primary
market evidence and official API links for the channel/marketplace rows. The
[business-tools report](deskazo-thai-business-tools.md) supplies equivalent evidence
for the accounting, CRM, OMS and document rows. Absence was checked across all
1,516 provider IDs/names and relevant action names, not only the screenshot groups.

Other Thai survey winners such as Hootsuite, Wisesight/Zocial Eye, Taximail,
SMSMKT/ThaiBulkSMS, Tellscore, LnwShop and 2C2P are absent as native providers.
Their demand is relevant to their categories, but ads, influencer discovery,
social listening and broad marketing automation are not immediate requirements
for the customer-reply loop. Avoid importing an entire MarTech roadmap into V1.
[Original Thai survey results](https://contentshifu.com/news/thailands-martech-awards-2025/)

## Asia is several expansion decisions

| Market | Reuse or extension | Evidence and limit |
| --- | --- | --- |
| Thailand | LINE first; local commerce, invoices and stock extensions | LINE reports 54M Thai MAU as of March 2026. This is audience reach, not merchant market share. [LY Corporation](https://www.lycorp.co.jp/en/company/global/) |
| Japan/Taiwan | Reuse LINE, then assess local commerce/accounting | Same first-party report gives 100M Japan and 22M Taiwan MAU; this does not establish local API eligibility or accounting compatibility. [LY Corporation](https://www.lycorp.co.jp/en/company/global/) |
| Indonesia and other SEA markets | WhatsApp is already in OpenConnector; consider local commerce and Mekari Jurnal | Treat country-specific merchant demand as a gate. Do not infer uniform WhatsApp dominance across Asia. See companion reports. |
| Vietnam | Zalo OA is a missing native connector | VNG reports 81.3M Zalo MAU in H1 2026. Zalo publishes an OA OpenAPI entry point. Access, messaging policies and merchant fit need separate assessment. [VNG H1 2026](https://ir.vng.com.vn/en/financials/earnings-release/1h-2026), [Zalo developers](https://developers.zalo.me/) |
| Mainland China | Weixin customer service is missing; public-content research connectors are insufficient | Tencent's combined global Weixin/WeChat audience is not a Thai adoption measure. Upstream now includes Kingdee, but it was absent from the pinned snapshot and is not a default Thai accounting choice. [Tencent](https://www.tencent.com/products/weixin-wechat/), [Kingdee actions][oc-kingdee] |
| South Korea | Kakao business messaging would be a separate missing connector | Kakao's 2024 report gives 48.95M domestic MAU as of December 2024. Older audience evidence justifies later investigation, not a current API-readiness claim. [Kakao report](https://www.kakaocorp.com/media/esg-resource/pdf/Kakao_ESGReport2024_EN.pdf) |

## Rollout sequence

### Phase 1: prove the workflow with existing connectors

1. LINE OA and Instagram for a small supported pilot. Finish incoming delivery,
   account routing, comment handling and human takeover using the existing
   Deskazo channel infrastructure where applicable.
2. One store route per pilot: Shopify Admin plus Storefront, or WooCommerce.
3. Google Sheets and selected Drive/Docs files for stock/promotion inputs,
   brand-voice documents and configured sales logging.
4. Optional HubSpot destination. Optional Xero/Invoice Ninja invoicing only for
   merchants already using those providers and the verified document type.
5. Add GA4 or other reporting only after customer replies and sales work reliably.

Reuse catalog actions; complete Deskazo's workflow around them. The existing
Instagram gateway remains a single-account pilot per Meta app callback, and the
current generic receiver is text-only. Those are application limits to address
before promising a broad multi-business launch, even though actions exist.
[Gateway limits](../self-host/integration-gateway.md),
[channel receiver limits](../self-host/customer-channels.md)

### Phase 2: extend the connector layer for Thailand

- Start access applications/discovery for Facebook, Shopee, TikTok Shop and Lazada
  while Phase 1 is being validated. API approval can be the schedule dependency.
- Prioritize Facebook customer operations, then marketplace context in the
  Shopee/TikTok Shop/Lazada demand order, adjusted to the actual pilot merchants.
- Add LINE SHOPPING where the pilot sells through it.
- Add FlowAccount or PEAK and ZORT according to the merchant's current systems.
- Pursue Page365 and ChocoCRM partner access; do not substitute speculation for
  an API contract. Add other CRMs only for confirmed demand.

### Phase 3: country-specific expansion

Reuse proven LINE/WhatsApp capabilities where applicable. Add Zalo, local
accounting and other missing providers only after selecting a country and
confirming merchant demand and API access. Support narrow complete workflows
before widening the catalog.

## Product implications

- Say "available history" during brand-voice onboarding. LINE explicitly cannot
  re-fetch text messages through an API; accept approved examples or supported
  exports and learn from newly received conversations. Instagram's connector
  also lacks a DM-history action. [LINE receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages)
- Keep conversation transport, public-comment support, social-content ingestion,
  store operations and accounting separate in the capability model. Connecting
  one account does not prove all five are enabled.
- A provider is supported only after a real authorized receive, reply, lookup,
  steer/handoff, sale and configured downstream-write journey passes. Include
  reconnect, revoked access, provider quota and ambiguous-write recovery.
- Treat invoicing document type and local fiscal acceptance separately from an
  action named `create_invoice`. Never mark generic invoice creation as Thai
  e-tax compliance. See the official references in the business-tools report.

## Reproduce the inventory

The checker imports provider metadata only and does not load credentials or call
provider APIs. It writes a sorted TSV, rejects duplicate action IDs and provider-ID
mismatches, and checks a git checkout's revision and clean source state. Tested
with Node 26. A definition and an executor file are evidence of source presence,
not proof that every declared action has a live working executor.

```sh
git clone https://github.com/oomol-lab/open-connector.git /tmp/openconnector-inventory
git -C /tmp/openconnector-inventory checkout 20f86718e7bb938c2d4380c8bbb335cbaebb94bc
node scripts/inventory-openconnector.mjs /tmp/openconnector-inventory \
  20f86718e7bb938c2d4380c8bbb335cbaebb94bc \
  docs/research/deskazo-openconnector-catalog.tsv
```

Repeat against `493def090c95a92ee312b95594c489c9856a16af` for the pinned counts,
using a separate output file. An isolated archive of that commit was used in this
research. The first manually checked provider, Instagram, has nine actions; the
full generated inventory agrees. Two runs of the current snapshot produced
byte-identical TSV files. No full upstream test suite or live provider acceptance
was run.

## Customer workflow effect checks

Workflow declarations cannot establish whether a connected action changes state.
Rakazo checks the connector's `readOnly` metadata when publishing and dispatching
a workflow. Unknown actions are treated as writes. OpenConnector revalidates its
catalog before execution, and an effect or input-schema change invalidates an
already resolved call. A `304` uses the catalog body whose ETag was requested,
even when another refresh completes first. This still trusts the connector's
metadata and stable action contracts; it is not an atomic deployment handshake.

For older OpenConnector catalogs, sixteen fixed WooCommerce, Shopify Admin and
Sheets reads have a conservative fallback in
`packages/adapters/src/open-connector-effects.ts`. Explicit connector metadata
overrides that fallback, including `readOnly: false`. Generic GraphQL, bulk queries
and unaudited actions remain consequential.

The rerunnable source check executes those upstream handlers with synthetic
responses and injected fetchers. It checks that normal inputs and attempted
method/query overrides make only fixed GET requests or fixed Shopify GraphQL
queries. It passed 32 checks at each of revisions
`493def090c95a92ee312b95594c489c9856a16af` and
`72735772da86f62178acbb28ddc1d4d978f32109`. This checks handler behavior at those
revisions, not a live merchant account or every possible input. Use a clean source
checkout with its dependencies installed and rerun after connector upgrades:

```sh
node scripts/verify-openconnector-read-effects.mjs /path/to/open-connector
```

The same 32 checks also passed at source revision
`9e11b04c46df3cefad0bed1d4f2765e24d2ef126`. An image tag naming a source revision
does not prove that its running files match that source.

A write must use its ownership-checked operation key in its input. Dynamic write
values must come from preceding reads that each passed the customer ownership
check, or from authenticated customer/thread IDs. Direct model inputs, unchecked
read results and earlier write results are rejected. Stored workflows are checked
before they are offered or executed, so existing incompatible grants become
unavailable until revised. They are not silently rewritten.

These template rules do not know which provider field is the write target, whether
a literal setting selects another record, or whether a channel customer ID matches
the provider's identity namespace. Each enabled mapping still needs an authorized
merchant test of ownership rejection, actual target and amount, repeat requests,
and provider readback. A checked cart/customer record can supply submitted details;
unsupported writes must hand off to staff.

## Customer and merchant identity

A messaging participant ID and a merchant customer ID are separate namespaces.
`$customerId` remains the authenticated channel participant. `$providerCustomerId`
comes from an active, owner-approved link scoped to the conversation, participant
and provider connection. Numeric values remain safe integers; use strings for
provider IDs represented as strings. Do not convert or round IDs to make them match.

Staff reads `customer_snapshot` and selects the customer's message `senderId`,
including in group conversations. Use that value as `customerId` when inspecting
`customer_identity`. After independently verifying that the participant owns the
merchant account, request `customer_identity_set` with the inspected revision,
reason, typed provider ID, and the read-only action/input/path that returns it.
The backend checks current access, read-only metadata and exact returned value.
That proves the record exists, not that this participant owns it. A name, claimed
email, order number, guest customer ID or shared placeholder is not ownership proof.
The owner must approve each decision explicitly; always-allow rules cannot bypass it.

Customer workflows may check an ownership field against `$providerCustomerId`.
They are unavailable without an active link and recheck it before and after steps.
The final read returned to a customer must itself pass an ownership check. An
earlier owned record cannot authorize returning an unrelated final read. Writes
retain the checked-record input and duplicate-prevention requirements described
above. A customer ID is not a unique purchase ID and must not limit a customer to
one lifetime purchase or bypass duplicate protection for a repeated checkout.

Changing or revoking a link pauses the entire case and invalidates its current
execution. Review provider state and `customer_operations` before handing back.
An in-flight action may still dispatch or finish after invalidation; the final
authorization check and external dispatch are not one atomic operation. A retained
lease is reported as potentially in flight even after messages were cancelled.
New account references invalidate old links. Dispatch binds the selected provider
account, and receipt reuse includes the link identity, revision and account reference.
Changing the link cannot retrieve an old linked receipt or dispatch that operation
again. Read the current provider record or use staff recovery for uncertain work.

Set `identity: null` with the current revision to revoke, including after account
disconnection. History retains the actor, reason, typed value, action, selected
path, lookup-input hash and provider-account hash. Raw lookup inputs and provider
responses are not saved in the link. The limit permits 31 decisions and reserves
the 32nd for revocation. Afterwards the case requires staff handling. Links and
history are erased with their case or connection and included in authorized account
exports without the raw provider account reference. These links do not provide a
checkout session, payment settlement rule, or automatic identity verification.

If a shared connection becomes private to another owner, workflows fail closed.
The case owner also loses link inspection and revocation access; the inactive row
remains until case or connection deletion. Case-scoped revocation after access
withdrawal remains an open improvement. Provider customer merges, reassignment or
deletion can also invalidate ownership without changing the connection reference.
Each merchant needs a re-verification procedure before unattended writes.

A matching field in one record does not establish ownership of an entire returned
collection. Verify each configured read's filters and output scope against another
customer's records. Lookup hashes support audit comparison but do not prove
ownership or identify the deployed provider implementation.

## Interrupted purchase recovery

`customer_operations` shows the current attempt, retained receipt and review history.
It defaults to unresolved work. Use `status: completed` or `status: all` to include
past confirmations and pass `nextCursor` back as `cursor` to inspect older pages.
Staff must inspect the exact operation in the provider before requesting either
`customer_operation_confirm` or `customer_operation_retry`. Both require explicit
owner approval and the attempt number from the latest inspection; an always-allow
rule cannot bypass this decision.

Confirmation records an observed past success without dispatching. Retry records
the observed terminal failure status, provider reference and staff reason, then
authorizes one identical-input attempt in the original case. It neither resumes
the case nor dispatches the action. The next customer workflow execution must pass
its current ownership and eligibility checks. Concurrent calls claim only one
attempt. The provider idempotency key stays unchanged across attempts; if a provider
caches a terminal rejection under that key, recovery may still require staff work
in that provider. Never change the key or inputs just to bypass duplicate prevention.

A current-attempt confirmation can cancel an authorized retry before it dispatches.
An earlier attempt's delayed success or failure cannot replace a later attempt's
state. Decisions append to a bounded receipt history, with room for 31 retry
decisions and a final confirmation. The source case's deletion erases the receipt
and audit and makes any pending retry unavailable. Completed receipts expire after
30 days from completion or staff confirmation, while duplicate-prevention records
remain until Space deletion.

Failure status and provider references are owner-attested evidence, not an automated
provider-status verifier. A timeout, absent search result, pending action or cancelled
client request does not establish a terminal failure without effects. Before enabling
recovery for a merchant, verify the provider's authoritative status meanings,
idempotency scope and retention, readback behavior and rejection semantics. Offline
concurrency checks cannot establish these provider guarantees.

## WooCommerce purchase fixture

The [disposable purchase check](../../packages/testkit/fixtures/woocommerce/README.md)
uses real WordPress 7.1 and WooCommerce 11.1.0 with pinned image digests and plugin
checksum. It exercises the connector's REST handlers and the Store API with
synthetic products and customers on an isolated Docker network.

The tested connector source, `9e11b04c46df3cefad0bed1d4f2765e24d2ef126`, drops order
payment URLs and payment timestamps. The saved
[order-payment patch](../../infra/open-connector-patches/woocommerce-order-payment.patch)
preserves `paymentUrl`, `needsPayment`, `paymentMethod`, `paymentMethodTitle`,
`transactionId`, `datePaid` and `datePaidGmt`. These remain nullable provider facts.
The patch does not derive a paid flag from status or from `needsPayment: false`.
WooCommerce can record payment administratively, so a recorded date does not itself
prove gateway settlement. See the [official order fields](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/).

The fixture established these limits:

- Two identical REST order submissions with the same `Idempotency-Key` header
  create two distinct orders. The application ledger remains necessary, and an
  uncertain creation must not be retried on the assumption that this header deduplicates.
- Bank-transfer checkout returns a successful payment result while the order is
  `on-hold` with no paid date. Its `needsPayment` is false. Neither field alone
  establishes funds received.
- A separate anonymous cart cannot see the original cart's items. An invalid cart
  token yields a new empty cart on GET and cannot authorize a mutation without a
  nonce. The application must retain and protect the original cart capability.
- This pinned release returns `checkout-draft` with order ID zero for a new cart's
  checkout GET. Do not treat that placeholder as a durable order or operation key.
  Existing draft orders and other versions can behave differently.
- Checkout rejects an actual total above the submitted `expected_total` with a
  conflict. The value uses the currency's minor units. This version permits a lower
  total; it is an upper-bound check, not strict price equality.

The upstream source has no cart or checkout actions. An additional
[Store API patch](../../infra/open-connector-patches/woocommerce-store-api.patch)
now supplies eleven actions for cart creation/read, items, coupons, customer details,
shipping rates and checkout. The fixture exercises every action, confirms the exact
physical order through administrative readback, and verifies that an expired token
cannot silently select a replacement cart. Initial checkout testing exposed that
final addresses must accompany submission even after updating the cart; the action
contract now requires both address objects.

Store API requests send the cart capability without administrator credentials or
cookies, reject redirects and make one request without automatic retry. Responses
retain the provider's cart or checkout object and rotated token. Local JWT decoding
checks session continuity only; WooCommerce validates signatures. Do not expose
these capabilities or raw results to customer agents or general conversation logs.
The application now keeps token and provider payload custody in encrypted purchase
records, scoped to case, participant, connection and current provider account.
Start nonces and revision checks serialize the staff-managed cart; pending records
survive unknown results and block another cart. Every mutation requires explicit
owner approval. Missing connector actions fail before reservation. Readable checkout
quotes include variants and both addresses and are compared to fresh provider state.
Changed quotes require another approval. Formatted checkout input is limited to
3,500 characters; oversized or redacted approval details cannot be approved through
the card. Larger quotes need merchant checkout. Billing/shipping fields enter the
private staff model context and approval/effect history, whose retention and export
are independent of the customer case. Cart credentials and raw provider payloads
stay out of those histories. The existing staff-attested merchant identity link
does not own a guest cart. Website shoppers now confirm the exact quote through
an authenticated conversation; social-channel confirmation remains staff-verified. Reference-matched uncertain-checkout reconciliation is implemented below. Closing an old cart-only request erases
local capability custody, not the provider cart; attempted checkout cannot be closed.
Case deletion and retention preserve pending/uncertain purchase records. Account
cleanup and ordinary connection revocation now wait out recent attempts as described
below; intentional account erasure still removes private purchase state.

Checkout requires a maximum total in minor units and supports payment methods that
need no additional gateway payment data. It does not accept card details or create
accounts. Merchant payment configuration and gateway settlement require acceptance.
All new actions retain the application's conservative consequential classification;
even checkout GET can update draft state on some store versions. No customer grants
or hosted runtime were changed. See the
[official checkout contract](https://developer.woocommerce.com/docs/apis/store-api/resources-endpoints/checkout/)
[cart operations](https://developer.woocommerce.com/docs/apis/store-api/resources-endpoints/cart/)
and [cart token documentation](https://developer.woocommerce.com/docs/apis/store-api/cart-tokens/),
but verify against the installed version: the pinned source and response differed
from the checkout documentation's persisted-draft description.

### Checkout recovery and payment observations

The application stores a purchase reference in encrypted state before submitting
checkout, and sends `Deskazo purchase <purchase id>` as the provider's customer note.
The updated connector preserves `customerNote` in normalized order reads. This note
can appear in merchant/customer order views and emails and is editable by merchants
or plugins. It is an order reference, not a secret or proof of shopper identity.

After explicit owner approval, recovery reads the selected order and verifies that
reference plus items, addresses, currency, maximum total and payment method. A unique
account/order association prevents attaching one order twice. Database fences keep
late checkout responses and competing recovery decisions from replacing the resolved
record. Recovery records its observation and review identity without resubmission.
A confirmed order can then refresh its provider status using only a read-only action.
The cart quote remains the approved pre-checkout quote; the order observation carries
its current provider total and observation time.

`recorded_paid` requires a valid provider GMT paid timestamp, `needsPayment: false`
and processing/completed status. These are provider-recorded facts. WooCommerce
administrators can record payment by changing order status; this is not an independent
gateway settlement check. In the pinned fixture, `set_paid` alone is ignored for an
on-hold bank transfer because the order does not need payment. The fixture checks
that the paid timestamp stays absent, then explicitly marks the synthetic order
completed and reads the resulting recorded payment.

Missing/mismatched orders, rewritten notes and commercial/address changes fail
matching. Failed reads leave the prior timestamped observation unchanged. Neither
failure nor an absent search result authorizes another checkout. Older attempts
without the reference need merchant handling. Ordinary disconnect retains local
purchase state. Intentional account erasure removes it after the recovery window;
it does not cancel an order already accepted by the merchant.

## Evidence limits

There is no defensible single "most-used in Asia" list across these categories.
Thai survey rankings, messaging MAU, vendor customer claims and marketplace GMV
measure different things. Current provider-plan entitlements and production API
approval remain merchant-specific checks. The inventory and effect audit above use
source snapshots, so deployed action availability and behavior may differ. The
separate hosted runtime-token revocation check in the implementation status does
not establish merchant action acceptance.

For a deployment preflight, run `scripts/inspect-openconnector-acceptance.mjs` inside
the connector container. It makes only loopback GET requests using the container's
existing admin authentication. It reports aggregate catalog, execution-metadata
and configured-connection counts for the selected providers. Credentials, account
IDs, labels, profiles and connection names are not printed. Keep its output private.
Configured connections may be expired or unsuitable for testing; this check never
executes a merchant action or establishes provider acceptance.

[oc-pinned]: https://github.com/oomol-lab/open-connector/tree/493def090c95a92ee312b95594c489c9856a16af
[oc-current]: https://github.com/oomol-lab/open-connector/tree/20f86718e7bb938c2d4380c8bbb335cbaebb94bc
[oc-scenarios]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/core/provider-scenarios.ts
[oc-line]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/line/actions.ts
[oc-instagram]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/instagram/actions.ts
[oc-whatsapp]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/whatsapp/actions.ts
[oc-telegram]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/telegram/actions.ts
[oc-shopify-admin]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/shopify_admin/actions.ts
[oc-shopify-storefront]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/shopify_storefront/actions.ts
[oc-woocommerce]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/woocommerce/actions.ts
[oc-baselinker]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/baselinker/actions.ts
[oc-cin7]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/cin7_core/actions.ts
[oc-aftership]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/aftership/actions.ts
[oc-17track]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/17track/actions.ts
[oc-sheets]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/googlesheets/actions.ts
[oc-excel]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/excel/actions.ts
[oc-drive]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/googledrive/actions.ts
[oc-docs]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/googledocs/actions.ts
[oc-notion]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/notion/actions.ts
[oc-dropbox]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/dropbox/actions.ts
[oc-hubspot]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/hubspot/actions.ts
[oc-pipedrive]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/pipedrive/actions.ts
[oc-freshsales]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/freshsales/actions.ts
[oc-xero]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/xero/actions.ts
[oc-invoice]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/invoice_ninja/actions.ts
[oc-elorus]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/elorus/actions.ts
[oc-ga]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/google_analytics/actions.ts
[oc-ads]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/googleads/actions.ts
[oc-mailchimp]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/mailchimp/actions.ts
[oc-bigquery]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/google_bigquery/actions.ts
[oc-metabase]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/metabase/actions.ts
[oc-supabase]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/supabase/actions.ts
[oc-databricks]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/databricks/actions.ts
[oc-meta]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/meta/actions.ts
[oc-tiktok]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/tiktok_business/actions.ts
[oc-shopify]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/shopify/actions.ts
[oc-stripe]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/stripe/actions.ts
[oc-sorftime]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/sorftime_mcp/actions.ts
[oc-linkfox]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/linkfox/actions.ts
[oc-redfox]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/redfox/actions.ts
[oc-unipile]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/unipile/actions.ts
[oc-ayrshare]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/ayrshare/actions.ts
[oc-respondio]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/respond_io/actions.ts
[oc-kingdee]: https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/kingdee/actions.ts

## LINE staff alert verification

The optional staff destination uses OpenConnector's `line.get_bot_info` and
`line.send_push_text` actions. The former is now in the exact read-only allowlist;
`node scripts/verify-openconnector-read-effects.mjs <clean-source-checkout>` runs
the pinned upstream handler with networking disabled and checks that even extra
method/body arguments cannot change its fixed GET request.

LINE's [push-message documentation](https://developers.line.biz/en/reference/messaging-api/#send-push-message)
says an accepted request can still reach no recipient, including when the user
has blocked the Official Account. Setup therefore sends a random twelve-character
code and enables the destination only after the staff member supplies it and
approves the exact account and recipient. Codes expire in ten minutes, permit five
wrong attempts, and stay out of backend setup results and destination-export
records. The code staff submits enters the private staff chat and approval history
and follows that history's retention/export. A new test
has a new immutable binding ID; repeating its nonce never sends another message.
The staff member attests that a group contains only authorized staff. Deskazo does
not monitor later changes in the group's membership.

The [retry guidance](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)
requires a UUID retry key from the first request and limits deduplication to 24
hours. Every send uses a stable UUID derived from its durable operation. Unknown
push outcomes remain unconfirmed and are never automatically replayed. Only a
failed account read before push can be retried by this adapter. A code received
after a lost test response can still prove receipt while it remains valid.

The backend pins connection, provider reference, LINE bot account and recipient;
a database trigger prevents overwriting that binding. Each alert rechecks current
membership, destination enablement, connection scope and LINE bot identity. It
holds user, connection and destination locks through dispatch. Account deletion
uses the same user row; an unavailable lock rejects before sending, avoiding a
wait cycle with the scheduler's case locks. A changed account
requires a new test. Administrator changes outside Deskazo's locking boundary are
not a transaction shared with the LINE API.

Alert text contains only a generic attention reason and a normal authenticated
case link, with no login capability or customer message. Sign-in preserves the
case and Space; the usual case authorization controls access. App notification
opt-out and LINE enablement are independent, while quiet hours, acknowledgement,
reminders and owner escalation share the existing issue schedule.

Implementation tests use a scoped OpenConnector HTTP fixture and synthetic LINE
responses. No live LINE message or hosted deployment has been performed for this
slice; real receipt, staff-group setup and native-device acceptance remain open.


### Website shopper confirmation

Website checkout now requires a staff-approved review and a decision from that
conversation's visitor session. The review contains the exact cart revision,
items and variants, quantity, currency and total, shipping option, billing and
delivery details, and a provider-supplied payment-method label. Unknown payment
methods without a shopper-facing label require merchant checkout. The staff
agent's `customer_purchase_review` action has mandatory approval and cannot hide
or truncate details in its approval prompt. A review expires after 30 minutes.

The visitor can confirm or request changes. Confirmation does not submit an
order or payment: the staff checkout action still requires owner approval and
rechecks provider state. The visitor can withdraw confirmation while checkout
has not been claimed. A requested change needs a revised cart and a new review;
replaying either decision is idempotent. A new decision raises staff attention,
including after an earlier acknowledgement; a replay does not repeat that alert.
A changed quote, revoked or expired
session, disabled origin, or different payment method invalidates checkout.
Provider changes found during checkout require a fresh shopper review. An
already-dispatched order cannot be recalled by withdrawing agreement.

Review and decision writes serialize with cart edits and checkout. The API reads
current details after taking the case lock, so a concurrent edit cannot return
its old quote. Decisions append to the purchase history; session hashes and the
review binding remain encrypted with cart state and are excluded from staff
inspection and account export. The owner-approved addresses already follow the
private approval transcript's retention. Purchase history and encrypted state
follow existing case/account erasure.

This proves control of the website conversation, not ownership of a merchant
customer account. Social-channel shopper agreement remains independently
verified by staff. Do not claim an authenticated social confirmation flow or
live payment acceptance from the website tests. The support widget presents
`Confirm details` and `Request changes`, then says the order has not been placed;
those words distinguish agreement from an external purchase or payment outcome.


### Purchase lifetime during disconnect and account deletion

Reservations lock the acting user and connection owner briefly, reject pending
account deletion, and commit the attempt before transport. The purchase service
checks a 45-second deadline from reservation immediately before each provider call
and passes the remaining deadline to the connector. A suspended process cannot
start a later checkout step once that deadline expires.

Account deletion disables access immediately. Before revoking any provider or
erasing local data, its worker checks both purchases in the user's cases and
purchases using the user's connections. Creating, updating, submitting and uncertain
attempts younger than five minutes defer cleanup for another 30 seconds. Completed
attempts permit cleanup; abandoned reservations expire so a crashed worker cannot
block data erasure forever. Legacy attempts without a start timestamp use their
last update time. Ordinary disconnect uses the same check under the connection
lock and returns a conflict before changing local or remote authorization.

These checks assume synchronized deployment clocks and supported transport abort
behavior. A remote service may finish work after local cancellation. After five
minutes, intentional account erasure can remove the remaining recovery evidence;
inspect/export unresolved purchases before deleting an account. Disconnect retains
local purchase records but removes provider authorization, so further readback needs
a valid connection. No transaction holds a database connection across purchase
network calls. The rerunnable purchase, deletion and connector/API tests exercise
these boundaries with synthetic providers.


## Instagram caption learning

`customer_learning_source_configure` requires explicit owner approval for the selected
connection and bot/Space scope. The composition root enables the provider-neutral
social learning worker for Instagram owned captions. No provider SDK or credentials
are added to the learning contract. The two required actions are
`instagram.get_current_user` and `instagram.list_media`; the offline upstream read
verifier covers their fixed GET paths, including misleading write and account inputs.

One job saves one page, its deduplication markers, private evidence batches and queued
learning tasks in a single transaction. Network requests run outside transactions.
Leases permit crash recovery, and cursor hashes reject cycles. Scans stop with partial
coverage after 1,000 cursor pages. Captions outside the configured window, empty
captions and invalid dates are counted as skipped. The initial lower bound is connection
registration minus 30 days; each scan has a fixed upper bound. Later scans revisit
that window to detect new/edited accessible captions and run hourly after completion.
Backlogs, outages and provider limits can delay polling. Failures enter the existing
daily staff summary. Completion means the accessible caption scan ended, not a complete
archive of deleted posts, comment replies or messages.

The worker verifies the authorized account identity before and after each page, and
rechecks local binding, connection access, account-deletion markers, bot lifecycle,
source revision and lease before saving. These are discard guards: an external read
already authorized just before revocation or deletion may still begin or finish, but
its results cannot be persisted by a stale job. A remote account swap that changes back
between those identity reads cannot be proven absent; the provider does not return an
atomic account identity with each media page. Real provider acceptance remains open.

Only supported, public-safe style additions can apply automatically. Captions never
establish commercial rules or grant actions. Review, evidence, undo and rejection use
the existing learning pipeline. Reconfiguring or pausing a source invalidates old
unapplied proposals. Deduplication survives configuration changes, including scope
changes and resuming, so those changes are prospective. Removing a saved evidence
batch also erases its captured tasks but keeps deduplication; removing the whole source
clears both. Existing learned documents retain their audit and can be undone separately.
Raw captions remain private to the importing owner, are included in their account
export without transport bindings/cursors, and cascade with source, connection, bot,
Space or account row deletion. Disconnecting retains saved evidence but blocks future
use; source removal erases it. Explicit deletion of a source also removes its task rejection
history, so adding it again may relearn the same material.
