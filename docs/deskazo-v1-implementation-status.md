# Deskazo V1 implementation status

2026-09-20. Work in progress against [the V1 target](deskazo-v1-spec.md).
This is not a release-readiness claim.

## Implemented in this change

- Shared Space learning documents and bot overrides for voice, knowledge, memory,
  and skill instructions. Changes use revision checks and append audit records
  with the human or agent, source description, reason, content, and restore origin.
- Authorized staff can edit and restore documents from web and native mobile code.
  Staff agents can inspect, save, and restore them through tools. Customer execution
  receives only the effective documents marked for customer replies.
- Revision-specific undo previews preserve later edits. Overlapping fields require
  a reviewed resolution. Applying undo appends an audit revision and rejects stale
  previews. Web, native mobile code, and staff tools share this behavior.
- Learning revisions can link to original conversations and private imported reply
  archives. Evidence reads recheck the original source permissions. Imports retain
  raw CSV/JSON and their original coverage; removal erases raw content and blocks
  further learning from that source. Identical exports share an archive identity.
- Normalized UTF-8 CSV/JSON reply preview filters to the last 30 days, separates
  business authorship, deduplicates input, and reports exclusions. Preview counts
  cover the export even when its displayed text is truncated. Owner-approved imports
  process 100 rows per background job with persistent progress and message/content
  deduplication across overlapping exports from the same source. Scope, source and
  window stay fixed on resume. Connected sources pin the account binding and the
  original connection timestamp; offline exports use an approved stable source key.
  Each page commits duplicate markers, private evidence tasks and progress together.
  Revocation, account deletion, bot pause and source withdrawal stop new learning.
  Withdrawal erases raw evidence/tasks but retains duplicate hashes until bot deletion.
  Staff tools expose coverage and explicit resume, with daily completion/failure
  summaries and account-export metadata. Native LINE CSV mapping still requires a
  verified schema. Instagram comment and DM imports are implemented; complete
  live history coverage remains unverified.
- Owner-approved Instagram caption sources now feed continued learning. Source tools
  inspect coverage, configure bot/Space scope, pause, request refresh and remove a source.
  The initial window starts 30 days before connection registration and runs through
  setup. Hourly scans cover that same starting point through the scan time, with one
  durable cursor page per job and post/content deduplication. Edited captions are new
  evidence. Later extensions add comment replies and explicitly opted-in message
  history with authorship review, described below.
  Configuration changes invalidate unapplied proposals and preserve deduplication,
  so scope changes and resuming affect only new or edited posts. Removing a source
  erases its private archives/tasks; existing documents and revision history remain.
  Web, Electron's web UI and native mobile code distinguish saved posts from imported
  replies and can remove a saved batch without changing source settings.
- Staff corrections and resolved cases with sent human replies queue continued learning.
  The worker uses the configured model without tools, preserves conditions and existing
  guidance, and automatically applies supported, public-safe voice additions and
  noncommercial reusable owner corrections. Ambiguous, imported nonvoice, other-staff,
  and scope-widening corrections require review. Pause, leases, source access, document revisions,
  and inherited Space baselines are checked before applying changes.
- Learning tasks retain reviews and support explicit retry. Exact rejected inferences
  are blocked across bots for shared Space guidance; related corrections require review.
  Undo of a directly linked learned revision records a rejection. Normalized hashes
  enforce exact matches; paraphrase avoidance also depends on model instructions.
  Source-case deletion removes captured task evidence and its review records.
- Staff receives a daily summary of learning changes, review needs, and failures in
  the bot thread. The reconciler discovers queued work every 30 seconds during normal
  operation; model calls time out after one minute. Backlogs and downtime can delay work.
- Private conversation steering invalidates undispatched work, records guidance,
  and distinguishes actions that may already have left the application. Existing
  takeover, assignment, handback, and human reply flows remain in use.
- Optional Jev assessment adapter evaluates human requests, unresolved issues, and
  evidence support. Known human requests and unavailable assessments take a human
  attention path. Tests cover late results after steering. Live playground checks
  exposed unnecessary escalation for routine sizing questions. Clarified assessment
  wording passes the sampled Thai and English sizing cases without lowering the
  confidence floor. A rebuilt app then completed live Jev assessment for routine
  Thai sizing and a disputed payment. The first continued to Luna; the second
  requested verified information and delivered a Thai handoff acknowledgement.
  Jev now uses the shared connector transport rather than the model-server public
  endpoint gate. Broader and repeated quality evaluation remains open.
- Staff inspection exposes this Space's selected model IDs alongside provider names,
  preventing a provider label from hiding the chosen model.
- Customer transcript transport preserves multiline replies and literal backslashes
  through Langflow's text-input decoding. Real component tests cover later turns.
- Customer business writes require a provider record key from an ownership-checked
  read and an explicit scalar receipt mapping. A durable operation ledger prevents
  repeated writes across turns and concurrent calls. Changed inputs and uncertain
  outcomes require staff review. Raw connector business actions cannot bypass the
  workflow. Current eligibility is checked again before a stored receipt is reused.
- Workflow read/write declarations must match connector metadata at publication
  and dispatch. Unknown actions remain consequential. OpenConnector revalidates
  metadata before execution; effect changes invalidate previous resolutions.
  Sixteen fixed WooCommerce, Shopify Admin and Sheets reads have an audited
  fallback for connector versions without effect metadata. Stored workflows obey
  the same rules. Write inputs must include their checked record key; dynamic
  values must come from ownership-checked reads or authenticated customer scope.
  These checks do not establish provider field semantics or validate literal
  settings. Owner-approved mappings still need merchant acceptance before use.
- Cross-turn receipts are bounded and separate from duplicate-prevention tombstones.
  Deleting the source case removes the receipt and recovery context; reconciliation
  expires completed receipts 30 days after completion. Pending recovery context follows case
  retention. Tombstones remain until Space deletion.
  A stored receipt proves the past operation, not current payment/order status. Other case transcript and
  tool history follow the channel's retention settings.
- A pinned disposable WooCommerce check now exercises real provider HTTP behavior.
  It exposed dropped payment links and timestamps; a portable OpenConnector patch
  preserves those nullable facts, with offline contract tests. Bank-transfer checkout
  remains unpaid even when its payment result says success, and duplicate REST
  creation is not prevented by an idempotency header. The approved connector
  rollout includes this patch.
  An additional connector patch now adds eleven cart/checkout actions, exercised
  through a real shippable order with coupons, delivery rates and current totals.
  The actions return secret cart capabilities and are not customer-enabled. Backend
  custody, a staff purchase lifecycle and website shopper confirmation are implemented below;
  recovery of missing/unmatched orders and real gateway payment acceptance remain open.
- Staff tools now create, inspect, update, quote, submit and abandon case-bound guest
  carts through a shared checkout-provider interface. WooCommerce is the first adapter.
  Cart capabilities and full provider payloads stay encrypted in backend purchase state.
  Start nonces prevent replay, revisions serialize updates, and durable pending records
  block replacement after an unknown outcome. Missing connector actions fail before a
  purchase is reserved. Each mutation requires explicit owner approval and pauses the case.
  Checkout binds a readable quote with variants, quantities, currency, total, delivery
  rates and both addresses. The provider cart is read again before submission; any
  change requires review. The complete formatted input must fit 3,500 characters, and
  approval cards deny requests that would truncate or redact purchase details.
  Larger carts require merchant checkout. Addresses intentionally enter the private
  staff model context, approval transcript and effect request; those copies follow
  staff-run retention/export and are not erased merely by deleting the customer case.
  Inspection/export of purchase records omit capabilities and addresses. A submitted
  order never implies confirmed payment. Local failures before dispatch keep the cart
  usable; ambiguous calls remain blocked. Staff can abandon old cart-only attempts,
  retaining their audit identity, but cannot close an attempted checkout. Case deletion
  and retention skip pending/uncertain purchases. Account deletion and connection
  revocation now defer cleanup of recent attempts, as described below. Intentional
  account erasure after the recovery window still removes private purchase state.
  Authenticated social-channel confirmation and
  real merchant acceptance remain open.
- Checkout now stores a purchase reference before dispatch and writes it to the
  WooCommerce order note. Staff can resolve a lost checkout response by selecting
  the provider order after explicit owner approval. A read-only lookup must match
  its reference, items, addresses, currency, maximum amount and payment method.
  Resolution stores the provider observation and staff audit, associates the order
  uniquely with the account, and fences late responses. It never repeats checkout.
  Repeated status reads update timestamped provider facts without growing review
  history. A paid date, no payment needed and processing/completed status produce
  `recorded_paid`, meaning the provider recorded payment; this is not independent
  gateway settlement evidence. Bank-transfer processing success alone stays unconfirmed.
  The purchase reference is in a customer-visible, merchant-editable order note.
  Missing or rewritten references, changed order details, and older unreferenced
  attempts fail matching and require merchant handling. A failed refresh retains
  the previous observation and timestamp; it does not make them current. Missing
  orders still cannot authorize retry. Recovery after intentional account erasure,
  authenticated social confirmation and real merchant/gateway acceptance remain open.
- Purchase reservation briefly locks both the acting user and the connection owner,
  then rejects either account's pending deletion. A shared connection cannot bypass
  its owner's deletion request. Every provider call rechecks access and a 45-second
  deadline measured from reservation. Account deletion disables access immediately,
  but defers all provider cleanup while a creating, updating, submitting or uncertain
  purchase is less than five minutes old. A completed call permits cleanup; a crashed
  attempt ages out so deletion can finish. Ordinary disconnect rejects recent attempts
  before changing local status or revoking the provider, and retains purchase state
  after disconnect. These controls use short transactions and the durable reservation;
  four simultaneous provider calls pass with the production-size four-connection pool.
  Deployment clocks must agree. Cancellation cannot retract a remotely accepted call,
  and intentional account erasure after the recovery window removes local recovery data.
- Staff can link a case participant to a typed merchant customer ID after explicit
  owner approval. The backend verifies an exact record through a declared read-only
  action; ownership is staff-attested. Workflows can use `$providerCustomerId` and
  recheck its case, participant, connection and current account reference. A final
  customer read must itself pass ownership validation. Changes pause and invalidate
  the case; in-flight external actions may still dispatch or finish and need review.
  Linked receipt reuse includes the link revision and account. Review history,
  protected revocation at the history limit, account export and case/connection
  deletion are implemented. The staff snapshot exposes each message's sender ID
  so group participants can be selected correctly. This does not implement checkout
  creation, automatic identity proof or merchant-specific payment confirmation.
- Staff can record verified past success for an uncertain operation, with a provider
  reference, reason and immutable review identity. This never retries the external
  action. Model-initiated confirmations, learning review decisions and assessment
  configuration require owner approval, including when an always-allow rule exists.
- After checking a terminal provider failure without effects, the owner can authorize
  one retry with identical inputs in the original case. Approval does not dispatch.
  The next workflow execution rechecks current ownership and eligibility and uses
  the same provider idempotency key. Attempt numbers reject stale approvals and late
  responses; a fresh confirmation can cancel an approved retry before dispatch.
  Inspection defaults to unresolved work and paginates older operations, so recent
  completed purchases cannot hide a case that needs recovery.
  Recovery decisions append bounded history, included in account exports and erased
  with the receipt. Legacy confirmations migrate into that history. A timeout or
  missing record does not establish failure. Failure evidence is owner-attested;
  live provider status meanings and idempotency behavior still need acceptance.
- Reversible customer configuration/learning changes participate in configured
  automatic review. Source removal requires owner approval. Mandatory approval
  cards now omit an ineffective always-allow option and show customer parameters;
  this final card change has offline tests and awaits live UI acceptance.
- Customer help notifications honor saved opt-outs and target the assigned live
  member or an eligible owner. Shared cases no longer broadcast to every member.
  Dispatch now holds case, channel, bot and recipient membership locks; competing
  workers skip the claimed case. PostgreSQL checks cover stale cases, held locks,
  failure retry and deduplication within each issue's notification stage.
- Each notification stage has an independent durable dispatch record for each
  configured provider, committed before the provider calls. Confirmed rejections
  retry without repeating another provider's accepted send. The provider set stays
  fixed for that stage; replacements take effect at the next stage, and removing a
  failed provider retains a visible terminal failure instead of redirecting its retry.
  Unknown sends and abandoned dispatches remain unconfirmed and are not blindly
  resent. A real
  database rollback after a synthetic provider acceptance verifies this recovery.
  Accepted, skipped, failed and uncertain outcomes appear in the case history.
  Current failures and unconfirmed delivery are visible on web and mobile without
  clearing the escalation. Browser screenshots cover desktop and narrow web views;
  native device acceptance remains open. Provider error bodies are not exposed.
  Optional LINE staff destinations now have approved test-code setup, confirmation
  and disable tools. Immutable account/recipient bindings prevent retargeting a
  retry. App opt-out is independent of verified LINE enablement; quiet hours cover
  both. Alert links preserve the case through sign-in and require normal case
  access. Live LINE and native-device acceptance remain open.
- Human alerts now retain a durable issue identity and start time, remind once at
  ten minutes, and notify the owner after thirty minutes when another member is
  assigned. Acknowledgement, a staff reply, resolution and handback cancel pending
  reminders. Later customer messages and steering preserve the original clock.
  Staff can configure personal quiet hours and help notifications through the
  staff agent. Staff and owner schedules are independent, so a quiet or failing
  assignee destination does not block owner escalation. Quiet-hour changes revisit
  deferred notifications; an overdue initial alert and reminder are combined to
  avoid a burst when quiet hours end. Database and daylight-saving boundary tests
  pass; these checks use a notification fixture, not live push delivery.
- Staff can acknowledge a case without resolving it or resuming AI. The backend
  records staff identity, timestamp and conversation version, preserves acknowledgement
  across further messages in that issue, and resets it for a new issue after a reply.
  Web has a passing browser journey and screenshot; mobile has implementation and
  TypeScript verification, with device acceptance still pending. Conversation deletion
  also deletes acknowledgement records.
- Bot learning overrides and their revision history now cascade with bot deletion;
  shared Space guidance remains available to the other bots.
- Authenticated account deletion removes the new customer cases, alert history,
  imports, learning tasks/reviews, bot overrides and operation receipts. Private
  memory/history, notification preferences and read markers follow database-owned
  account cascades when a shared Space survives; cases are unassigned from the
  deleted member. These constraints reject late writes by deleted accounts. Upgrade
  migrations enforce new writes before cleaning and validating existing orphans.
  Shared guidance, its audit history and opaque duplicate-prevention records remain
  with that business. Deleted private evidence stays deleted. Authorized remaining
  owners can undo/restore recorded guidance, and evidence controls appear only for
  sources the viewer can still access. New learning that cites a source still
  rechecks its availability and access.
- Account deletion now accepts a durable request, revokes account access and disables
  bot/customer work before cleanup. The worker retains credentials and resource
  identities through failures, renews its claim during slow providers, and resumes
  after restart. Artifact/sandbox failures, a lost worker lease and a rolled-back
  final account deletion have PostgreSQL coverage. Ordinary connector revocation
  and private-Space knowledge cleanup run before their local records disappear.
  Newly private organizations are revisited; membership and resource-write guards
  prevent the tested late-write and last-member-removal races. New bot deletion
  records retain failed cleanup identities for a later account deletion to recover.
  Successful bot cleanup clears those identities.
- Retention reconciliation removes expired resolved idle cases and their captured
  learning evidence/reviews, notification history, private receipts and visitor
  sessions. Open, recent, leased and sending cases remain. Completed operation
  receipts expire after thirty days; uncertain receipts remain while their case
  remains. Opaque duplicate-prevention records and approved shared guidance survive
  case expiry. Deleted evidence is inaccessible, without blocking guidance undo.
- Account settings now offer a JSON Lines export on web, Electron's shared UI and
  mobile. It includes profile/preferences, private conversations and imports,
  skills, memory/history, accessible customer records and current knowledge files.
  Files are embedded as base64. Explicit column selections exclude credential
  stores and authentication fields; secrets entered into user content are not
  redacted. Other users' private records, runtime internals, connector configuration,
  computer disks and external-only data are outside this export's scope.
  Database snapshots, pagination, private/shared access, credential exclusions,
  missing/corrupt files, concurrent requests and limit/retry behavior have passing
  PostgreSQL tests. A successful response is sent only after generation finishes.
  The server unlinks its temporary file before writing private data, so a process
  crash cannot leave a named archive behind.
  Exports are bounded to 100 MiB, 100,000 records and a two-minute database snapshot,
  with one concurrent export per account and two per API process. Large accounts
  and slow storage still need operational acceptance. File reads share the snapshot
  deadline; slow downloads occupy the process-local slots until streaming ends.
  Browser journeys cover
  downloading and error recovery at desktop and phone widths. Native unit tests
  and TypeScript pass; device and Electron acceptance remain open. Android keeps
  successful shares in app cache so the receiving app can read them; exports over
  one day old are removed on the next export, or earlier by system cache eviction.
- Deployment snapshots now pause Compose services and managed computers, save the
  core database, application files and private deployment configuration, verify
  hashes and archive paths, then resume previously running containers. The production
  timer wrapper uses the same command. Restore requires matching images and service
  configuration, rejects occupied targets, preserves file ownership and leaves
  application services stopped for review of pending external work. Eleven offline
  safety checks and a disposable Docker recovery journey pass, including private
  files, links, restart behavior, wrong-key/version and corruption rejection,
  table/function/file conflicts, and SQL failure with fresh-target recovery.
  These are trusted operator snapshots; hashes do not authenticate them. Host writers
  and external database clients must remain disconnected. Files and SQL are not
  restored in one transaction. Real app-login/provider recovery, Linux systemd,
  large-volume recovery and upgrade acceptance remain open.
- A disposable live-app runner, offline verification script, and standalone HTML
  evidence generator make the exercised work reproducible.

## Verification boundary

ChatGPT subscription sign-in with GPT-5.6 Luna has been exercised in the running
application. Live model tests use synthetic shop and customer content. The customer
runtime is real Langflow and the application database is disposable PostgreSQL.
Separate offline tests use explicitly identified model/provider fixtures.

The local evidence report belongs under `test-report/deskazo-v1/report.html` and
embeds selected screenshots. Logs and account state are deliberately not tracked.
Use `scripts/verify-deskazo-v1.sh` for offline checks and the existing Python
Langflow component suite for the transport regression. Local tests do not establish
production-provider readiness.

## Remaining V1 acceptance work

V1 is not ready for sign-off. The seven real-provider journeys in the
[specification](deskazo-v1-spec.md#acceptance-journeys) remain the release gates.
The local tests below support implementation checks; they do not replace those
journeys or the detailed requirements elsewhere in the specification.

| Acceptance journey | Current evidence | What still needs to happen |
| --- | --- | --- |
| 1. New business setup | Guided entry choices, managed preparation, private practice and website activation are implemented. The combined app/Pi/Langflow journey passes with scripted model decisions and seeded knowledge. | Run model-led setup with the selected merchant accounts, authorized history or fallback examples, actual product sources and owner review, without developer intervention. Validate a real LINE OA CSV layout. |
| 2. Grounded chat and comments | Private practice and website delivery pass through real Langflow. Current-data grants, public/private separation and Instagram send receipts have offline coverage. | Demonstrate current SKU/promotion answers and public-safe comment delivery on the selected store and social accounts. |
| 3. Steering, learning and undo | A controlled live Luna journey exercised correction, voice learning, later application and undo/rejection. Database and client checks cover private memory, skills, review and reversal. | Repeat on real provider conversations with the merchant's conditions, audit evidence and restored subsequent behavior. Broader semantic quality remains model-dependent. |
| 4. Human attention and takeover | Inbox controls pass on web, iOS and Android. Backend tests cover assignment, reminders, quiet hours, acknowledgement and delivery failures. Two live Jev cases and earlier playground samples exist. | Verify real channel takeover without double replies, linked LINE alert delivery and broader Thai/English Jev cases, including owner-configured criteria. |
| 5. Purchase and configured records | Owned Docker WooCommerce now passes Deskazo backend checkout with authenticated website confirmation, cross-visitor rejection, lost-response reconciliation and retry blocking. Offline tests cover staff approvals and downstream deduplication. | Select the real pilot store and optional record/invoice destinations; verify actual payment/order facts, mappings, authorization, readback and interrupted-request recovery. No store or Sheets connection is configured on the inspected hosted connector. |
| 6. New social content and voice exceptions | Instagram caption, reply and opted-in DM learning have offline coverage, including privacy, authorship review, exceptions and shared pacing. The required connector history actions are now deployed. | Demonstrate an authorized content update with real provider permissions. Confirm bot exceptions and commercial rules remain unchanged. |
| 7. Failure and recovery | A real local WooCommerce checkout response was deliberately dropped; Deskazo held the purchase uncertain and recovered the exact order without resubmission. Revoking a disposable local connection token now denies reads; explicit app reconnection restores access, and app revocation removes the remote account without affecting the primary grant. Offline tests cover interrupted work; disposable deployment checks cover failed migrations and update recovery. | Demonstrate selected merchant connection, knowledge and worker failures without fabricated answers or duplicated provider actions. Local token revocation is not OAuth expiry or worker-death acceptance. |

| Supporting area | Verified scope and remaining acceptance |
| --- | --- |
| History and learning sources | Normalized CSV/JSON mapping, confirmed timezone offsets, fixed windows, pagination, resume and deduplication are implemented. Both Instagram connections passed bounded conversation/message reads through the deployed connector. Media lists were empty, leaving comments/replies unexercised. Native LINE CSV validation and complete history coverage remain open. Customer text and account authorship do not establish staff authorship. |
| Memory, skills and privacy | Semantic-provider audit, bounded full-proposal review, large histories, undo/restoration, source permissions and native controls have local coverage. Live provider reconciliation, deletion/retention behavior and model generalization still require acceptance. |
| Account and data ownership | Large exports, cloud-agent cleanup, durable sandbox cleanup, membership revocation, stream/screen revocation and password recovery have local coverage. Hosted load, real external-provider erasure and full-product backup/restore acceptance remain open. |
| Clients | Web journeys, unsigned iOS simulator checks and four Android emulator journeys pass. Product display-name and installation-identity checks are complete locally. Hosted Linux Electron smoke now passes; its manual run retained no screenshots. Physical-device behavior, signed upgrades and hosted native macOS screenshot checks remain unverified. |
| Release operations | Failed-migration recovery, startup recovery, coordinated update shutdown and installed Linux backup timer/restoration have disposable-environment coverage. The persistent timer also catches a missed event after its disposable scheduler restarts without repeating it on another restart. Published-version compatibility, full host/Docker reboot, live provider reconnection and large deployments remain unverified. |
| Hosted connector | The approved locked image is deployed with the four Instagram history actions and eleven WooCommerce cart/checkout actions. All four configured LINE/Instagram connections pass account-bound identity reads and reject a mismatched account before dispatch. Catalog entries and identity reads do not establish receive/send, history, checkout or payment acceptance. |

The pilot LINE account has been selected and matched to the existing connections.
Inspection of its Thailand free-plan web interface confirmed that both bulk chat
backup and per-chat history download require a paid OA Chat package. No export
was obtained or subscription purchased. Approved examples and future authorized
replies remain the free fallback; the native CSV validation gate remains open.
See [the account-specific export evidence](research/deskazo-line-history-import.md#selected-account-export-availability).
An owned Docker WooCommerce store is connected in the persistent local verification
workspace. A real merchant store configuration and permission to message a dedicated
test recipient remain pending. The selected ChatGPT subscription is now connected
in Firefox. A private staff run using GPT-5.6 Luna completed with one verified reply;
the local Docker computer provider is configured and running. This connection check
does not establish the seven merchant acceptance journeys. Local models are no longer a
prerequisite. Earlier local-model evidence below remains historical. The user requires free options or a free
tier and explicit approval before new charges. The approved connector rollout
does not authorize real customer sends or merchant writes. Do not enable unattended customer sales or claim
complete V1 readiness until the applicable acceptance gates have evidence.

The hosted preflight is repeatable with `scripts/verify-hosted-connector.py`.
The deployed source now matches all 6,154 checked paths of the prepared source,
including migrations. This is source-drift evidence, not proof of installed
dependency or generated-image equivalence. The locked build passes 241 focused
tests with provider networking disabled. The approved rollout completed after
one verifier failure and successful rollback; its result, private-backup checks,
account-routing checks and source hashes are under
`test-report/deskazo-v1/checks/connector-rollout-approved`. Earlier evidence remains
under `test-report/deskazo-v1/checks/acceptance-audit-*`.

Before that successful rollout, an AMD64 preparation attempt did not pass. Local emulation failed
before npm ran. Compilation on the shared host then exhausted available memory,
new SSH checks timed out and the connector became unhealthy. Cancelling the build
client did not stop its compiler process group. Stopping that identified group
recovered memory and connector health without changing the production image or
restarting it. Fresh catalog and all four identity reads passed; no containers or
tagged images from the failed verifier remained. Broad Docker caches were left
alone. The verifier now rejects remote Docker endpoints and bounds subprocess
lifetimes; nine focused tests and the revised local ARM64 build with 241 cases
pass. At that checkpoint, AMD64 verification was still open and no deployment
had occurred. The later verification and approved rollout supersede that hold.

The subsequent local verifier uses its own pinned BuildKit container, checked
3 GiB/two-CPU build-step limits, a 4 GiB builder limit, and forced removal of the
owned builder on cancellation. Capped compilation failed with concurrent checks,
with sequential checks under emulation, and with sequential native compilation.
Native compilation passes after a build-only 2 GiB Go memory target was added.
The eight-patch source uses tree `093e342d1ce5daa5f3dc86344a74089a8b5ef5ef`.
Only architecture-neutral source/catalog/browser output crosses from the native
build stage; target dependencies, unit tests and runtime are separate AMD64 stages.
An initial target test stage omitted a referenced TypeScript project and failed
before executing tests. After correcting the fixture, all 241 tests pass as AMD64
processes, and the AMD64 runtime passes health, 24 action-catalog checks and
account-bound authentication checks with provider networking disabled. Export is
gated on both stages. The verified image is retained locally; its builder, cache
volume and intermediate containers are removed. These checks use emulation on an
ARM build machine, not a native AMD64 CPU, and do not establish provider delivery.
The hosted service remains on its original image; a fresh SSH preflight confirms
healthy services and four successful LINE/Instagram identity reads. Evidence is
under `test-report/deskazo-v1/checks/amd64-*`.

Latest acknowledgement verification: 55 customer PostgreSQL checks and one Chromium journey passed. DB/web/server types and direct mobile TypeScript passed. The standard mobile check reported newer Expo patch versions; dependency alignment remains to be checked.

Alert scheduling verification: 67 customer PostgreSQL checks, two migration checks
and 83 focused unit checks passed. The broader unit suite passed 4,218 tests with
273 skipped before the final quiet-hour refinements; the 67 database checks cover
those final refinements. Direct mobile TypeScript passed. No native device or live
push-provider acceptance is claimed by these checks.

Alert delivery verification: 72 customer PostgreSQL checks, 24 Expo adapter checks,
and the Chromium website-to-staff journey passed. Web/API/worker/database/adapter/
testkit types and direct mobile TypeScript passed. Desktop and narrow-web screenshots
show failed and unconfirmed staff notifications. The provider in these checks is
synthetic; no live push or native-device acceptance is claimed.

Data ownership verification: two authenticated deletion journeys, ten learning
database checks, three migration checks, five memory commit checks and 73 customer
database checks passed. Fixtures use disposable PostgreSQL and synthetic content.
The deletion journeys cover wrong passwords, private/shared Spaces, other-user
isolation, late-write rejection and shared-guidance undo/restore after source removal.
Desktop and narrow-web learning journeys, fourteen focused unit checks, and
database/auth/memory/adapter/API/testkit/web types also passed. Type checks were
rerun after Prisma generation finished to avoid reading partially generated files.
Those earlier checks did not cover interrupted deletion. The later recovery checks
below add that coverage for the exercised resources; external data erasure still
requires live provider verification.

Alert dispatch holds database locks during the bounded provider request. Slow
delivery can delay case and access changes. A lost acceptance receipt now remains
unconfirmed instead of replaying the stage. A crash before the network call can
therefore leave an unsent notification unconfirmed; the inbox and later scheduled
stages still work. Expo acceptance is not device delivery, and Expo's downstream
service can deliver more than once. See [Expo's delivery guarantees](https://docs.expo.dev/push-notifications/sending-notifications/).

Interrupted-deletion verification: eleven focused PostgreSQL checks pass, including
file and sandbox failures after database removal, connector rejection, expired and
competing worker claims, heartbeat loss, final-transaction rollback, earlier bot
cleanup failure, and a membership DELETE blocked at real database locks during
account finalization. Three authenticated journeys cover private/shared deletion,
wrong passwords, denied sessions while pending, and recovery after restarting the
app. Providers in these checks are synthetic. The broader regression run passed
4,228 unit checks. After the final bot-cleanup and membership-removal refinements,
all 258 integration checks across 29 suites, 51 focused unit checks, and types for
database/auth/adapters/API/worker/testkit passed. Two authorization fixtures now
remove their signup-only organization instead of orphaning its last membership.

The hosted OpenConnector runtime-token check also passed: a disposable token could
read runtime action metadata before revocation, received HTTP 401 afterward, and
repeated revocation returned HTTP 404. The token was removed. This verifies hosted
token invalidation, not third-party OAuth revocation or account-data erasure.
`scripts/verify-openconnector-revocation.mjs` reruns this isolated check inside the
connector container without printing credentials or account data.

Customer action-effect verification: 75 customer PostgreSQL checks and the gateway
journey passed, including rejected write-as-read declarations and unowned dynamic
write inputs. The broader unit suite passed 4,242 tests with 304 skipped. A final
conditional-cache race fix then passed 42 focused checks. Contracts, adapter-kit,
adapters, API, web and testkit types and direct mobile TypeScript passed. The
upstream source check exercised sixteen read handlers with two inputs each at both
audited revisions. These checks use synthetic provider responses; live merchant
ownership, checkout, payment and invoice acceptance remain open. See the
[effect audit and reproduction command](research/deskazo-integrations.md#customer-workflow-effect-checks).

Purchase retry verification: the broader regression checkpoint passed 4,244 unit
tests, with 311 database/opt-in tests skipped there. All 274 integration checks
across 30 suites then passed, including current eligibility before an approved
retry, no dispatch on approval, late-attempt fencing, audit migration, completed
receipt retention and scoped account export. After adding paginated inspection,
all 14 operation database checks and 80 focused unit checks passed. Contracts,
core, database, adapters, API, worker, testkit, web and direct mobile types passed.
Static checks are clean. Provider responses in these tests are synthetic;
authoritative live failure readback and provider idempotency acceptance remain open.

WooCommerce fixture verification: eighteen real-store checks pass against WordPress
7.1 and WooCommerce 11.1.0 with the local connector patch. Seventeen upstream unit
and source-guard checks, catalog generation, lint, format and TypeScript passed.
The fixture verifies order readback, isolated carts, increased-total rejection and
preservation of a synthetic recorded payment. No gateway charge, hosted deployment,
customer-to-merchant identity mapping or application checkout journey was tested.
See the [reproduction steps](../packages/testkit/fixtures/woocommerce/README.md) and
[provider findings](research/deskazo-integrations.md#woocommerce-purchase-fixture).

Customer identity verification: the broader checkpoints passed 4,247 unit tests
with 328 skipped, and 291 integration checks across 31 suites. The final sender-ID
DTO and tool wording changed during that integration run. After all code changes,
80 customer workflow database checks, 78 focused checks, static analysis, types for
all eight affected workspace packages and direct mobile TypeScript passed. These
checks use controlled provider fixtures. Staff still attests merchant ownership;
live identity lifecycle, application checkout and gateway acceptance remain open.
Revocation after a shared connection becomes inaccessible also remains open, though
workflow access fails closed. No hosted deployment was performed for this slice.

Store API verification: 33 real-store checks now pass, including all eleven new
connector actions and independent readback of a physical order with shipping.
Bank-transfer checkout remains unpaid. Forty-two upstream unit/source-guard checks,
catalog generation, formatting, lint and all upstream TypeScript projects passed.
The patch verifier reproduces all six tested provider files from the pinned base
and the two saved patches. Disposable containers, volumes and networks were removed
and their absence verified. The transport simulates TLS inside the isolated fixture;
production TLS, gateway payments, hosted parity and the application customer journey
remain unverified. No hosted deployment or customer action grants were changed.

Staff purchase custody verification: the broad checkpoint passed 4,259 unit tests
with 353 database/opt-in skips, followed by 317 integration checks across 32 suites.
These include 25 purchase-state cases and the composed staff-tool/OpenConnector
adapter journey, all with synthetic provider responses. After the final approval
redaction and case-retention guards, 59 approval/executor checks and 85 workflow
database checks passed. Nine workspace package type checks, direct mobile TypeScript,
and the 18-file static check are clean. Pending/uncertain case records survive ordinary
case deletion and retention; account/connection deletion recovery remains open.
These earlier checks predate website shopper confirmation. They do not establish
hosted deployment, a real gateway charge or live merchant checkout. The approval detail limit and deny-only
fallback have offline coverage; their web/native rendering still needs acceptance.

Purchase recovery verification: the broad checkpoint passed 4,262 unit tests with
379 database/opt-in skips and all 341 integration checks across 32 suites. Both
normal and lost-response checkout paths passed through the scoped OpenConnector
adapter. After the final immutable observation audit and security regressions,
47 purchase database checks and 87 approval/executor checks passed. Nine workspace
package type checks, direct mobile TypeScript and the 12-file static check are clean.
The disposable real WooCommerce run passed 40 checks, including the application
adapter losing a real checkout response, reference-matched recovery, wrong-reference
rejection and provider payment refresh without resubmission. Cleanup was verified.
The connector's 36 focused tests, catalog generation, lint, format and TypeScript
passed; the saved patches reproduce all six tested provider files. The real check
also records hashes of its application adapter and direct contract/JSON helpers.
Provider payment in this fixture is administratively recorded, not a gateway charge.
These earlier checks predate website shopper confirmation. They do not establish
hosted deployment or recovery across account/connection deletion.

Independent alert-provider verification: 354 integration checks passed across 32
suites. The final customer workflow run passed 97 checks, including eleven new
cases for independent retries, lost receipt commits, competing workers,
acknowledgement between sends, provider changes, quiet hours and a populated
incremental migration using the saved SQL. Existing accepted and retryable failed
receipts survive the upgrade unchanged; duplicate receipts for the same provider
remain prohibited. Twelve workspace type-check tasks passed and the four-file
static check is clean. All provider sends were synthetic. Production remains on
the app notification adapter. LINE setup, immutable account/recipient binding,
recipient verification and authenticated links remain open. Migration lock duration
and slow-provider throughput have not been measured. No hosted deployment occurred.


LINE staff-alert verification: 380 integration checks passed across 33 suites,
including 25 LINE setup/delivery cases and the existing 97 customer workflow
checks. Account-deletion race tests prove that an in-flight send holds the user
lock until completion and deletion-first setup/verification stops before another
send. The unit suite passed 4,278 checks with 416 database/opt-in skips. The
Chromium journey covers sign-in from an alert link, desktop and narrow layouts,
and refusal to expose the case to an unrelated account. Seven affected package
type checks, direct mobile TypeScript, 24-file static checks and diff checks passed.
The upstream fixed-read verifier passed 34 checks with networking disabled.
The V1 verification script includes the LINE PostgreSQL suite.
All LINE responses remain synthetic. Test codes submitted by staff follow normal
private chat/approval retention; private-group membership is attested at setup,
not monitored afterward. Provider acceptance is not a delivery receipt. Live
LINE, staff-agent setup acceptance, native device behavior and slow-provider
throughput remain open. No hosted deployment or real LINE message occurred.


Website shopper confirmation verification: the broad checkpoint passed 393
integration checks across 33 suites before the final response and staff-attention
refinements. The final focused runs passed 61 purchase database cases and five
website API cases. The unit checkpoint passed 4,285 tests with 433 database/opt-in
skips. Eight affected package type checks, direct mobile TypeScript, 21-file static
checks, shell syntax and diff checks passed. The final Chromium journey covers
quote revision, keyboard confirmation, reload, withdrawal, renewed staff attention
after acknowledgement, and isolation from an unrelated visitor. Saved captures
show desktop and narrow shopper layouts and the staff attention state.

Independent implementation and UI reviews found no remaining blocker within this
website flow. Confirmation creates no order or payment; staff still approve the
exact checkout. The visitor session establishes control of the conversation, not
merchant customer identity. Social-channel confirmation, live merchant/gateway
acceptance, account/connection deletion recovery and native acceptance remain open.
All provider responses in these checks were synthetic. No hosted deployment or real
message, order or payment occurred.


Purchase lifecycle verification: all 412 integration checks across 33 suites passed,
including 69 purchase database cases, 19 account-deletion cases and 10 connector/API
journeys. The unit checkpoint passed 4,285 checks with 449 database/opt-in skips.
Five affected package type checks, eight-file static checks, diff checks and shell
syntax checks passed. These include concurrent dispatch with a four-connection
pool, both deletion orderings, shared connection-owner deletion, deadline expiry,
cleanup deferral before every provider, purchase-state retention after disconnect, and delayed
revocation through the authenticated API. The first long-transaction implementation
was discarded after a four-purchase regression reproduced pool starvation. Its
passing narrower checks are superseded by the short-transaction implementation.
The first API fixture failed by passing extra session fields to Prisma; the corrected
fixture selects the owner scope explicitly. All provider actions were synthetic.


Social learning checkpoint, 2026-09-19: the complete offline integration run passed
442 checks across 34 suites, including 29 social learning cases and a populated
legacy-task migration. The final unit run passed 4,292 checks with 480
checks skipped. Four browser journeys passed at desktop and narrow widths, including
saved-post download/removal and the existing import/undo workflow. Eight workspace
packages passed type checks; native mobile TypeScript and both mobile translation
catalogs passed. The upstream fixed-read verifier passed 38 checks, including the two
Instagram read handlers. Evidence is retained locally under
`test-report/deskazo-v1/checks/social-learning-*` and the rerunnable verification script
includes the new database and browser cases. Initial test-fixture and browser-selector
failures are retained separately. These checks used synthetic data; they do not establish
live Instagram acceptance or native device behavior.

## Resumable reply-import verification, 19 September 2026

The normalized-history queue passes 24 PostgreSQL cases covering bounded pages,
concurrent jobs, page rollback, explicit resume after an interleaved failure,
fixed reply-time windows, overlapping JSON/CSV exports, edited replies, oversized
rows, source withdrawal, private/shared connection revocation, connection-owner
and actor deletion, scope enforcement, model writes, account export, summaries,
production job dispatch and pagination past 100 imports. The original source IDs
remain in private archives; model batches contain reply dates and text only.

The incumbent integration run passed 443 cases across 34 suites, including an
additive migration test against populated archives. The new import suite adds 24
cases. All four existing learning/evidence browser journeys passed at desktop and
narrow widths. Eight package type checks and mobile TypeScript passed. The unit
suite passed 4,295 cases with 503 skipped; a final 70-case parser, approval and job
run covers subsequent edits. Verification logs are under
`test-report/deskazo-v1/checks/history-*`, and the rerunnable V1 verification script
and default integration list include the new suite.

Initial failed runs remain recorded. They exposed fixture mistakes in account
export arguments, connection-scope spelling and the pagination response assertion.
Independent review also prompted fixes for oversized-row marker ordering, failure
version tracking after concurrent progress, model identifier minimization, and
inspection of older imports. These regression cases pass in the final focused run.

Connected duplicate detection is scoped to one local connection record and binding.
Replacing that record can relearn overlapping exports; interrupted jobs cannot be
rebound. Offline keys must remain stable for the same source. Native LINE export
headers, timezone/authorship mapping and real-account acceptance remain unverified.
The staff-agent setup flow, live model quality and native devices still need live
acceptance. This work does not establish complete provider history or full V1
readiness and does not deploy the branch.


## Private Markdown memory audit, 19 September 2026

The native Markdown store now shares one atomic commit path for agent writes,
staff edits, imports and reversals. Revisions record reason, actor and validated
run/thread provenance. New content is limited to 100,000 characters per document.
Undo selectively reverses one edit; conflicting later edits
require reviewed replacement text. Restoring a known version replaces the whole
document and records a new event. Both operations affect subsequent native memory
retrieval and preserve the original history.

Owner, membership and deletion checks cover native reads, search, export and
mutations. Write transactions also hold the bot's lifecycle lock. Live `remember`
calls and authenticated edits/reversals require an expected revision. Internal
imports and the deterministic scripted test runtime retain the older optional
revision behavior. The editor keeps the revision from when its draft was opened.

Staff tools are private-conversation-only. Lists and history return bounded
metadata; content and undo-preview fields use 1,000-character chunks. Historical
reads pin the revision. Tool reversals require the complete replacement text in
the approval request and compare it with the selected/computed result before
writing. Oversized or redacted approval details offer only Deny. Larger reversals
remain available through the authenticated API, without a new dedicated UI yet.

The migration preserves each legacy document's known current version when missing.
It cannot reconstruct older content or authors. Default documents created outside
the store receive an unknown baseline on their first edit. Clearing a document
removes its effective text but keeps audit history; it is not data erasure.
Semantic-provider memory, executable skills, automatic rejection of re-proposed
native memory and full continued-learning integration remain separate V1 work.


Verification for this slice passed 486 integration cases across 36 isolated suites,
including 16 memory-audit cases, six concurrency/rollback cases, populated migration
coverage and authenticated API journeys. The full unit suite passed 4,312 cases
with 524 database or environment-dependent cases skipped. Nine package type checks,
mobile TypeScript, scoped formatting/lint, diff checks and the existing browser
memory/skills journey passed. The browser regression keeps a stale draft open
while export refreshes the list, then verifies that saving it cannot replace the
newer memory. Logs are under `test-report/deskazo-v1/checks/memory-audit-*`.

The preserved failed runs exposed owner-context spreading into database filters,
fixture assumptions about provisioned documents and signup, cross-package test
placement, and the pg adapter's commit-time serialization error. The shared retry
helper now recognizes that specific rolled-back conflict and keeps its three-attempt
limit. Unknown or connection-loss errors are not retried. Native device, live model,
large-account and migration-load acceptance remain unverified for this slice.


## Private executable skill audit, 19 September 2026

User-created SKILL.md recipes now share one atomic write path across authenticated
API edits and staff tools. Creation, replacement, removal, selective undo and full
restoration append versions with reason, actor and validated run/thread provenance.
Removal retains history while excluding the recipe from the active catalog.
Restoration refuses name collisions and retains the exact reviewed historical text.
Legacy rows receive a snapshot of their known current content, without inventing
past authors or missing predecessors. Account export includes skill revisions, and
account deletion cascades through both current records and history.

Staff skill mutations require explicit approval of the complete proposed text and
current revision. Approval replay restores the original arguments; completed
retries return the prior result. The approval card offers only Deny when details
are redacted or exceed its display limit. Large edits remain available through the
existing editor and authenticated API. Selective undo requires an explicit complete
resolution when later edits overlap. Authenticated creation checks name absence in
the transaction; the tool also requires expectedRevision zero.

Private AgentSkill catalogs, injected instructions and inspection tools are excluded
from group, messaging-channel and webhook runs. Mutations additionally require a
user-triggered private staff conversation. The separate bot-specific taught-playbook
feature retains its existing behavior. Routine queueing preserves skill references;
actual execution resolves current active recipes. Injected instructions have a
combined 24,000-character limit and fail before model execution rather than being
truncated. Tool content and preview reads use revision-pinned 1,000-character chunks.

The shared owner/provenance guard was extracted from native Markdown memory and is
covered by the existing memory regressions. The history UI is described below.
Automatic rejection of re-proposed recipes, the continued-learning bridge,
semantic-provider memory audit and live/native acceptance remain open. Changing a recipe does not
replay past external actions or retract instructions already read by a running agent.
This slice does not establish full V1 readiness.

Verification passed 503 integration cases across 37 isolated suites, followed by
all 18 focused skill cases after adding the legacy-name collision regression.
Those cases cover populated migration, ownership and lifecycle removal, atomic
rollback, concurrent edits/creation, version-pinned reads, exact restoration,
API/tool parity, export and account erasure. The full unit suite passed 4,320 cases
with 542 environment-dependent cases skipped; the final approval/privacy subset
passed 78 cases. Ten package type checks, mobile TypeScript, 28-file lint/format,
diff and shell syntax checks passed. The browser memory/skills journey passed,
including a stale skill draft that cannot overwrite a newer version and audit
history retained after removal. Logs are under
`test-report/deskazo-v1/checks/skill-audit-*`.

Preserved failed runs capture test-fixture corrections: missing task/run status,
oversize test input built with an already-validating helper, incomplete executor
mocks, a shared review spy that needed resetting, and an invalid approval-rule enum.
The first browser run was interrupted after its new stale-save assertion passed
because the test waited for Close instead of Cancel; the corrected run passed.
No hosted integration, native device or deployment acceptance is claimed here.


## Private history review controls, 19 September 2026

The existing web memory and skill editors now reveal revision history on request.
Each change shows its actor, reason, timestamp, before/after text and an accessible
source conversation when one remains available. Undo previews the selective result;
restore explicitly replaces the whole version. Both require a reason and the reviewed
result. Overlapping edits require an editable resolution and acknowledgement.
Expected revisions prevent a concurrent change from being overwritten. Unsaved drafts
and pending review requests lock conflicting editor controls. Removed skills remain
accessible through a separate history list and can be restored without inventing a
new recipe. The former “Shared documents” label now says “Your memory” because these
records belong to the current user, even when shared across that user's bots.

The native app exposes bot memory history in advanced bot settings and cross-bot
memory and skill history in account settings. Both clients use the same authenticated
review contract and audited stores. Full bounded versions are returned only for this
explicit editor review; agent-tool content remains chunked. Source-link lookup rechecks
membership and pending account deletion in its own guarded transaction. Unknown legacy
memory baselines have no invented before-content and cannot be selectively undone.

Native controls compile but have not been rendered or exercised on a device. Native
screen-reader, keyboard, scrolling and pending-request behavior remain acceptance work.
Web catalogs include the new strings; untranslated locales use source-text fallback.
This implements a review UI, not the continued-learning bridge or semantic-provider audit.

Verification: all 510 integration cases across 38 isolated suites passed before the
source-lookup review fix; the final focused suite then passed all eight cases,
including membership revocation and account deletion between reads. Both web
journeys passed, covering existing editors and the complete review flow with
concurrent writes, overlap, pending controls and removed-skill restoration.
Desktop and 390px captures passed independent visual review at that web scope.
The final focused unit run passed 18 cases, including native effect replay with
mocked controls. Six package checks, native TypeScript, 21-file lint/format,
frozen offline lockfile validation, whitespace and shell syntax checks passed.
The native lifecycle test is not a rendered-device test. Logs and explicit command
exit codes are in `test-report/deskazo-v1/checks/native-history-*`; screenshots and
design review records are local verification artifacts. No Electron e2e ran locally.


## Native continued-learning destinations, 19 September 2026

This records the earlier backend checkpoint. The app-review and summary gaps noted
here were closed by the full learning review checkpoint below.

Staff-correction proposals for memory and executable skills now prepare full before
and after text against the actual private stores. Approval checks the exact proposal,
current revision, owner, membership and source permissions before committing native
content, its audit revision and the task decision in one transaction. Concurrent
approvals create one revision. A failed decision write rolls the native change back.
The revision records the approving staff member; the linked task retains the proposing
bot and the explicit review. No native change applies automatically.

Memory currently targets `customer-learning.md`, either private to this bot or private
to its owner across bots. Skills append to the owner's `Customer handling` recipe.
These destinations are not shared Space documents or customer instructions. Existing
native text is added after inference and never sent into the shared-document inference
prompt. Customer-facing handling guidance still uses approved learning documents.
Social caption and reply-history inference remains restricted to writing style.
Legacy generic memory/skill documents are retained; this change does not migrate them.

Selective undo rejects the directly linked inference while preserving independent
later edits. Full restore rejects linked additions newer than the restored version;
clearing memory or removing the recipe rejects its applied learning tasks. Audit text
survives deletion of the source task. An explicit retry of a previously applied task
creates one new task, preserving the original approved proposal and inference identity.
Repeated retries of that parent direct staff to the newer task. Never-applied failures
retain their existing retry behavior. Exact rejection checks use the actual private
scope and owner; semantic rejection across paraphrases remains model-dependent.

Private task inspection and decisions are unavailable in group, messaging-channel and
webhook runs, and unattended runs cannot decide a task. Chat approval requires the
complete reviewed proposal and permits only one-time consent. A proposal hidden by
redaction or exceeding the approval card's display limit is denied. Full-proposal app
review remains required work, so there is not yet a UI route for those large proposals.

The authenticated task-evidence endpoint returns the captured evidence, excluding later
conversation messages. Native history includes source-task associations only while the
owner can still access the bot and source. Account export includes the native target
kind and revision-to-task links. Web/native history has not yet connected these new
source associations, and the daily summary is still plain text.

Verification: the focused PostgreSQL suite passed 34 cases after fixing the approval
actor and immutable retry findings from independent review. Approval and executor unit
checks passed 136 cases across three suites. Six package checks and native TypeScript
passed. The final full integration run passed 531 cases across 38 isolated suites.
The no-write static check passed for 24 touched files, and frozen offline lockfile
validation passed. Evidence and command exit codes are under
`test-report/deskazo-v1/checks/native-learning-*`. Independent cross-model review
found no remaining material blocker in this bounded backend change after the two
audit fixes. The review is in `native-learning-review.md` alongside the checks.

This is a backend checkpoint within the full V1 goal. Review UI, daily expandable
summaries, semantic-provider audit, wider skill selection, live model/provider acceptance
and rendered native-device verification remain open. No hosted deployment or customer
message was sent in this checkpoint.


## Full learning review and daily summary checkpoint

Learning updates now open from bot learning settings and the daily staff summary on
web, Electron's shared web UI, and native mobile. Lists load ten metadata rows at a
time; choosing an update loads the full before/after proposal, actual destination
scope, captured source evidence, conditions, and the twenty most recent decisions.
The database and account export retain the full decision trail. Native memory and
skill changes open the existing private revision history; ordinary learned documents
support selective undo with overlap review. Routine summaries stay in private staff
threads and are suppressed after membership loss or account-deletion requests.

App approval, rejection, and regeneration include the displayed proposal and task
status. The server compares these preconditions before changing a task. Approval
always requires a complete proposal. Explicit task-level staff-tool rejection and
retry remain compatible without the optional snapshot preconditions. Space edit
permission gates approval and undo; the bot owner can still reject or regenerate a
shared proposal after losing Space edit permission. Successful decisions clear the
old controls before reloading, including when that reload fails.

Verification: 537 PostgreSQL integration cases passed across 38 isolated suites.
The focused continued-learning suite passed 40 cases. Fifteen controller, native
component, and localization cases passed; approval-policy checks passed 93 cases.
Seven package TypeScript checks, native TypeScript, the 28-file static check, and
frozen offline lockfile validation passed. Browser journeys passed at 1280px and
390px, covering complete proposal text, source evidence, required reasons, pending
locks, native-memory approval, skill rejection, document undo, and pagination.
Command results and failures corrected along the way are recorded under
`test-report/deskazo-v1/checks/learning-review-*`. The translation generator is
`scripts/update-learning-review-locales.py`; a second run made no changes, and the
Chinese/Russian catalogs pass placeholder and chrome-coverage tests. Translation
quality still needs native-speaker review.

Independent cross-model review found no remaining blocker in this bounded change.
The web finish review found no material issue in the supplied captures. Its sole
native source finding was a touch-target floor below Android's minimum; both new
native button styles now use 48 units, and the reviewer scored that fix resolved.
This verdict does not establish native device acceptance.

This completes a bounded app-review workflow, not V1 as a whole. No native-device
render, keyboard, touch, or accessibility-service acceptance is claimed. Broader
skill targeting, automatic authorized learning beyond voice, semantic-provider
memory auditing, live model/provider journeys, and remaining release acceptance
stay open. No hosted deployment or customer message was sent in this checkpoint.

## Automatic owner corrections and relevant native targets

Supported, public-safe, noncommercial reusable corrections captured from the bot
owner can now update knowledge, private Markdown memory and user-created skills
automatically. Voice retains its existing approved-source behavior. Corrections
from other staff, imported nonvoice evidence, resolved-case generalizations,
conflicting guidance and uncertain judgments remain suggestions. A correction
classified for one bot cannot automatically change an owner-wide skill. Learned
changes record the responsible agent without inventing a human approval record.

A separate model stage selects relevant writable targets from paged owner-scoped
metadata. A valid selection survives later pages with no better match. The chosen
private content enters only a separate compatibility check, never shared voice
inference. Built-in and plugin skills remain read-only. With no applicable target,
the existing customer-learning memory or Customer handling skill is used. All
stages share one sixty-second deadline and bounded JSON output.

The commit transaction rechecks ownership, membership, deletion, pause, source
access, source identity, lease ownership and expiry, actual scope, rejection history
and the target revision/content. Automatic knowledge, memory and skill changes
reuse the existing audit, review display and undo/rejection paths.

Verification: 557 PostgreSQL cases passed across 38 isolated suites, including
60 focused continued-learning cases. Ninety-nine unit cases, seven package type
checks and the nine-file static check passed. Command results are recorded in
`test-report/deskazo-v1/checks/automatic-learning-command-results.json`. Independent
review found and verified fixes for lost early-page selections and automatic
bot-to-owner scope widening. Final cross-model evidence review found no bounded blocker; see
`test-report/deskazo-v1/checks/automatic-learning-independent.md`. No UI code changed
in this checkpoint; earlier browser evidence does not establish native acceptance.

Live models still determine semantic safety, relevance and compatibility. Large
catalogs or target content may exceed the deadline or context budget and fail
instead of applying. Semantic-provider audit, native device and real-provider
journeys remain open. This supersedes the automatic-learning and native-targeting
gaps in the historical checkpoints above, not the remaining V1 acceptance gates.

## Scoped semantic-memory removal checkpoint

Semantic fact removal now requires a complete reviewed fact and mandatory one-time
approval in a private staff conversation. The server supplies the bot, effective
scope and nonsecret connection revision. Model-supplied authority cannot change
those values. The approval card shows the entire bound request; redacted or oversized
requests offer only denial. A resumed worker uses the persisted approved request,
then rechecks current owner access, bot scope and connection configuration before
calling the provider. Local pre-dispatch failures settle the operation without
claiming an external deletion or leaving it executing.

Serenity performs a fresh recall within the allowed namespace and requires both
the same fact ID and unchanged content before its ID-only delete. An out-of-scope
citation, unavailable or changed fact, failed read, or cancellation prevents the
call. A successful receipt must identify that fact and confirm expiration.
The read and delete are separate provider calls, so a concurrent provider edit can
still race. Provider expiration does not prove permanent erasure. The full fact
also remains in the private approval/effect history under its existing retention.

Verification: the final full integration run passed 564 cases across 39 isolated
suites, including seven real-executor approval journeys. The focused unit run passed
222 cases across eight files. Five package type checks and the seventeen-file static
check passed after the final replay-settlement edit. Independent code review found
no remaining bounded blocker after fixing provider receipts, connection binding
and pre-dispatch failure settlement. Command results and corrected fixture failures
are recorded in `test-report/deskazo-v1/checks/semantic-memory-access-command-results.json`.
Final cross-model evidence audit found no bounded blocker. Its remaining provider,
retention and removal-UI limits are recorded in
`test-report/deskazo-v1/checks/semantic-memory-access-independent.md`.

This closes a bounded authorization and recovery flaw; it does not complete the
semantic-memory audit/undo workflow. Oversized or redacted facts still need a full
removal UI. Provider mutation receipts, audit history, undo, erasure, and live
conformance remain open. Current provider API findings are recorded in
[semantic memory audit notes](research/deskazo-semantic-memory-audit.md).


## Supermemory removal and uncertain effects checkpoint

Supermemory now carries full memory-entry IDs and container citations through recall.
Document chunks and truncated text remain read-only citations. Removal uses the same
private-owner approval boundary as Serenity, validates the allowed durable container,
then pages current memory entries until it finds the exact reviewed ID and content.
Only that entry is deleted. A single 15-second deadline covers inspection and delete,
with a maximum of 100 inspection pages per container. Missing, changed, forgotten or
non-current facts and unavailable inspection APIs fail before deletion.

Both Supermemory and Serenity now distinguish an unconfirmed deletion from a definite
pre-dispatch failure. The executor stores unconfirmed actions as uncertain. Repeated
calls for the same effect return that state without dispatching another deletion.
Offline approval integration cases cover both adapters, one-time allow and deny,
content/scope/configuration changes, unavailable dispatch, lost responses, wrong
receipts, provider errors and repeated calls after uncertain results.

This does not close the semantic mutation audit and undo gap. Save receipts, partial
shared writes, complete staff history inspection and recovery still need work. Provider
read/delete races, actual container-filter conformance, cross-run reconciliation and
large/redacted-fact review remain open. Forgetting is not proof of physical erasure.

Final verification passed: 577 integration cases across 39 suites, 222 focused unit
cases across nine files, three package typechecks, and nine-file static checks.
The isolated approval fixture includes 20 cases across both real adapters with
synthetic provider responses. No live semantic memory was read or mutated. Terminal
results are recorded in
`test-report/deskazo-v1/checks/supermemory-removal-command-results.json`.
Independent review found and prompted the uncertainty-persistence fix; its bounded
re-review found no blocker. See
`test-report/deskazo-v1/checks/supermemory-removal-independent.md` for remaining limits.


## Semantic save receipts and independent audit checkpoint

New durable staff saves retain provider receipts. Supermemory keeps confirmed entry
IDs and returned content; Serenity retains the acknowledged ID/status with unknown
content and creation state. Shared saves preserve successful receipts even when a
sibling destination is uncertain. Invalid or oversized input fails before dispatch.
Unconfirmed dispatched writes remain uncertain in the effect ledger, with receipts
and affected destinations retained. Default-policy saves now claim their effect and
use a stable per-run fact/destination identity. Changing a tool-call ID or reason
cannot replay an uncertain save. Policy-requested save approval shows the full bound
content and destination; redacted or oversized details are deny-only.

Each new executor save/removal creates an independent private audit record before
provider dispatch and records the outcome afterward. Source-run deletion preserves
the record but hides inaccessible source links. Staff agents can inspect ten entries
per history page and full versioned JSON in 1,000-character chunks. Account export
includes the records, and owner/Space/bot deletion removes them. The audit-inclusive
fixture covers source deletion, snapshot invalidation, isolation, pagination, export
and account deletion in addition to provider outcome and replay behavior.

The audit store does not backfill historical writes or cover history-compaction writes.
Web/native semantic history controls, undo, cross-run reconciliation, large/redacted
approval UX and live provider/lifecycle acceptance remain open. This checkpoint does
not claim semantic learning or all V1 requirements complete.

Final verification passed: 603 integration cases across 39 suites, including 46
save/removal approval, default-policy and audit scenarios; 298 unit cases across ten
files; five package typechecks; and 22-file static checks. The command results retain
earlier failed fixture and regression checkpoints with their causes in
`test-report/deskazo-v1/checks/semantic-memory-writes-command-results.json`.
The independent review is recorded in
`test-report/deskazo-v1/checks/semantic-memory-writes-independent.md`.
No live semantic provider data was read or changed.

## Semantic outcome consistency checkpoint

Semantic save/removal receipts and their execution state now commit in one transaction.
A database failure cannot leave a newly confirmed audit receipt beside an executing
effect. Late acknowledgements can settle a recovery worker's uncertainty without
another provider call. Source-run deletion retains the late receipt; account or bot
erasure does not recreate the audit. Concurrent completed or denied decisions remain
unchanged, and the caller is directed to inspect the provider evidence.

Both save adapters now reject mismatched bot authority, unknown scopes or sources,
and invalid history generations before transport. The new PostgreSQL regression
suite runs in the normal integration harness and proves rollback even when a failure
is injected after the execution-row SQL update.

These changes close the separate-commit and adapter-save-guard findings from the
previous review. They do not complete semantic undo/history UI, compaction auditing,
cross-run reconciliation, or native and live-provider acceptance. Lifecycle changes
can still race an external call after the authorization transaction has committed.

Verification passed: 616 integration cases across 40 isolated suites, including the
13 new outcome cases; 135 unit cases across five files; four package typechecks;
and the eight-file static check. Terminal results are recorded in
`test-report/deskazo-v1/checks/semantic-memory-outcomes-command-results.json`.
The independent review is at
`test-report/deskazo-v1/checks/semantic-memory-outcomes-independent.md`.
No live provider, browser, native-device or Electron acceptance ran in this checkpoint.

## Selective semantic creation undo checkpoint

Staff can now ask to undo one recorded semantic-memory creation. The server resolves
the exact fact and original destination from a versioned creation receipt and shows
the complete request for one-time approval. Dispatch rechecks owner access, current
scope and connection, the original receipt, and the provider's current fact content.
An `undo_save` audit event records the result and links to the preserved creation.
The reversal changes future provider retrieval without replaying business actions.

Each original fact/entity has one durable reversal reservation across runs. A definite
pre-dispatch failure permits a fresh reviewed attempt; completed or uncertain removal
keeps the reservation, even if the undo's source run is deleted. Confirmed destinations
from a partial shared save can be reversed individually. Unknown or unversioned creation
receipts cannot authorize deletion. Supermemory version-one receipts mark creation only
for the documented `201` response. Serenity's creation state remains unknown.

Resumed semantic actions now give the model only public-schema arguments, while the
executor restores the complete persisted approval. Malformed stored approvals stop
before any raw server-bound request is formatted for the model. This avoids validation failures
caused by asking the model to repeat server-only scope and connection fields.

Restoring removed semantic facts, undo of an undo, dedicated web/native history controls,
large/redacted approval UX, compaction auditing and live provider acceptance remain open.
Provider read/delete races and lifecycle changes during transport remain possible.

Verification: the full integration run passed 644 cases across 40 suites, including
31 audit cases. After the final continuation-prompt change, all 56 focused approval
journeys passed again, including actual adapter recall before and after undo against
synthetic provider state. The final unit run passed 269 cases across eight files;
six package typechecks and nineteen-file static checks passed. Command evidence and
earlier failed fixture checkpoints remain in
`test-report/deskazo-v1/checks/semantic-memory-undo-command-results.json`.
The independent review is recorded in
`test-report/deskazo-v1/checks/semantic-memory-undo-independent.md`.
These are offline checks, not live-provider or native-device acceptance.

## Private provider-memory history checkpoint

The web/Electron shared interface and native bot settings now expose retained
provider-memory audit records. Staff can inspect available before/after versions,
reason, recorded time, provider, scope and current bot identity. Missing evidence
stays unavailable; an unconfirmed provider result stays unknown. Following an undo's
original record also works beyond the loaded page without duplicating history rows.

The API restricts each read to the private owner, current Space membership and active
bot. Source navigation requires the retained run's thread to belong to that same
owner and bot. Disconnection does not erase local audit access. A failed read clears
private snapshots, and late responses from an unmounted bot cannot overwrite another
bot's view. The app reads local evidence without querying or changing provider data.

Independent UI review identified and prompted fixes for the phone composer covering
the side panel, focus transfer to an original record, and keyboard scrolling of long
snapshots. Browser assertions verify those behaviors at 1280 and 390 pixels against
an actual authenticated API and synthetic retained records. Native component coverage
and typechecks do not replace device evidence. No booted simulator or connected
Android device was available for this checkpoint; Electron E2E was not run locally.

The repeatable check is `bash scripts/verify-semantic-history.sh`. It passed 36
PostgreSQL audit cases, 56 approval journeys, 13 component/state tests across five
files, six package typechecks, the mobile typecheck and two browser journeys. The
final focused browser rerun includes the accessibility and stacking assertions.
Static checks cover nineteen changed source/test files, with a final two-file recheck.
Logs, the initial missing-test-dependency failure and the rejected mismatch fixture
are retained under `test-report/deskazo-v1/checks/semantic-history-*`.

Direct reviewed reversal controls, restoration of removed semantic facts, undo of an
undo, compaction audit coverage, reconciliation, large/redacted approval UX and real
provider/native acceptance remain open. This checkpoint adds inspection; it does not
establish V1 completion or current-provider-state conformance.

The existing bot creation/edit/deletion browser journey also passed after the shell
stacking correction. The independent UI reviewer scored all three reported fixes
resolved; that verdict is limited to those fixes. Final code/evidence review found
no material blocker in the inspection changes. See
`test-report/deskazo-v1/checks/semantic-history-independent.md` and
`test-report/deskazo-v1/checks/semantic-history-ui-review.md` for acceptance limits.

## Background semantic-memory audit checkpoint

Conversation compaction and history purges now retain dispatch intents and provider
outcomes in the same private semantic history as explicit memory actions. Background
records identify the real thread and generation without inventing a run. Owner,
active-bot, source and connection checks happen before dispatch. A duplicate cursor
cannot authorize another provider save; missing responses and failed outcome writes
remain unknown. Local summary generation still works without an external provider.

The clear route now purges only the generation it cleared. The database clear API
returns that old generation, so the caller explicitly distinguishes it from the new
one. A late save receives its own cleanup record after the initial clear purge.
Neither cleanup may target the current generation. Source links disappear after
clear, while full summary snapshots remain inspectable in the private audit. Clear
does not erase those snapshots and returns success if best-effort provider cleanup
fails. Account, Space and bot erasure
still cascade those records. Background history receipts cannot authorize the
separate durable-fact creation-undo path.

`bash scripts/verify-semantic-compaction.sh` passed six package typechecks, 195 unit
cases across five files, 17 new PostgreSQL cases and 36 existing audit cases. The
new cases cover an authenticated clear request, concurrent reservations, revocation,
source/account deletion, uncertain outcomes and save/clear interleaving. The first
fixture setup failures and the clear-generation integration failure are retained
beside the final logs under `test-report/deskazo-v1/checks/semantic-compaction-*`.
The generation failure was fixed before the passing run. Static checks pass on the
sixteen changed source/test files after export ordering was corrected. A final
provider-adapter unit run passed 200 cases across six files; the verifier now includes
that additional Supermemory provider suite.

This closes new external compaction-save and history-purge audit coverage. It does
not backfill previous writes, audit every local summary mutation, reconcile unknown
provider state, or provide selective history restoration. Direct reviewed reversal
controls, removed-fact restoration, undo of an undo, large/redacted approval UX and
live-provider/native acceptance remain open. Provider calls can still race lifecycle
or connection changes after reservation; failed cleanup may leave data in a former
provider. No live memory call, hosted deployment, commit or pull request was made.

The full integration regression then passed 666 cases across 41 suites, including
the new nullable-source migration and existing approval, account lifecycle/export
and product journeys. Every verification process started for this checkpoint is
terminal. `test-report/deskazo-v1/checks/semantic-compaction-command-results.json`
records command outcomes, including the earlier failures. The independent review
records the remaining acceptance limits in
`test-report/deskazo-v1/checks/semantic-compaction-independent.md`.

## Semantic removal restoration checkpoint

The staff-agent `memory_semantic_undo` tool now reverses confirmed removals as well
as confirmed creations. The server derives the inverse action, full recorded text
and exact destination from the private audit. Mandatory one-time approval includes
that bound action and snapshot. The executor checks it again before reserving the
reversal and dispatching a provider call. The original event is preserved, and an
`undo_forget` event records the actual restored ID and provider outcome.

Restoration writes only the selected original destination, including shared memory.
It does not mirror into another namespace or modify unrelated facts. Supermemory
checks bounded provider listings and refuses active, changed or superseded originals.
A confirmed new creation receipt can itself be undone. Serenity confirms the returned
fact through scoped recall, while leaving creation state unknown. Its restored fact
therefore cannot authorize creation undo. Missing post-save confirmation remains an
uncertain outcome with its acknowledgement retained. New removal receipts include
the actual entity; older records without a known destination cannot authorize restore.

The repeatable scoped check is `bash scripts/verify-semantic-restoration.sh`. It passed
six package typechecks, 214 unit cases across eight files, 44 PostgreSQL audit cases
and 82 authenticated approval journeys. Those journeys cover both adapters, denied
approval, changed scope/connection, lost responses and future recall after restore.
Shared-destination cases verify that one removal does not recreate its sibling.
Static checks pass on sixteen changed source/test files. Earlier receipt-shape,
fixture-provenance, JSON-order and namespace-fixture failures remain in the local
check logs rather than being reported as passing product evidence.

The current history inspector displays these linked events and recorded versions;
direct app reversal controls remain open. Large or redacted approval payloads still
lack a complete review path. Provider reads and writes are not atomic against later
external edits or lifecycle/configuration changes. Serenity recall is not exhaustive
absence proof, and its unknown creation state limits reversal chains. Live-provider,
native and release acceptance remain open. No live memory call, hosted deployment,
commit or pull request was made for this checkpoint.

Restoration logs and failed checkpoints are under
`test-report/deskazo-v1/checks/semantic-restore-*`. The scoped independent review is
`test-report/deskazo-v1/checks/semantic-restore-independent.md`; its remaining limits
are part of the acceptance boundary, not proof of complete V1 readiness.

The full integration regression passed 700 cases across 41 suites after these
changes. All verification processes for this checkpoint are terminal. The structured
command record is `test-report/deskazo-v1/checks/semantic-restore-command-results.json`.
The separate trail audit checks every evidence path and records the absence of a
workspace transcript; it does not substitute for live-provider acceptance.

## Complete semantic fact approval checkpoint

Semantic save, forget and undo approvals now show the full bound request for a
10,000-character fact. The serialized detail limit is 100,000 characters so JSON
escaping and destination metadata do not prematurely reject a valid fact. The
approval still uses the persisted effect request when execution resumes, including
when the model supplies different arguments. Redaction remains deny-only, and the
limits for Markdown memory reversals, learning proposals, skills and purchases have
not changed.

The repeatable check is `bash scripts/verify-semantic-approval-detail.sh`. It combines
approval formatting and replay unit cases, authenticated executor journeys with
10,000-character facts, and browser checks at desktop and phone widths. The browser
fixture exercises the actual stored approval card and reload behavior; provider
execution is covered separately by offline integration fixtures. No live provider,
Electron or native device acceptance is implied.

The first verification attempts found a testkit import boundary error and two
multiline prompt assertion errors. Their logs remain under
`test-report/deskazo-v1/checks/semantic-approval-detail-*`. The final prompt assertion
decodes multipart text and compares parsed replay arguments, avoiding differences
in JSON escaping. Direct app reversal controls, raw review of redacted payloads,
large non-semantic approvals, provider reconciliation and live/native release
acceptance remain open.

Final checks passed: 53 unit cases, 89 authenticated executor journeys, two large-card
browser cases, two existing approval-flow browser cases, three package typechecks and
seven-file static validation. The web card now uses the full message-column width
instead of applying a second 74% cap, and its named scroll region supports keyboard
review. Desktop and phone screenshots were inspected. The final browser fixtures
verify complete text after reload, Home/End scrolling, action availability and stopped
state. Native large-card usability remains unverified. The structured check record is
`test-report/deskazo-v1/checks/semantic-approval-detail-command-results.json`.


## Direct semantic reversal checkpoint

Bot settings now let an authorized staff owner review and reverse one recorded
provider-memory fact without asking an agent to run a tool. Staff enter a reason,
review the complete proposed removal or restoration, and confirm it. The server
derives the inverse from retained receipts and binds the review to its content,
destination, owner and connection revision. It rechecks those facts before transport.
The new audit event records its staff source and links to the unchanged original.
Confirmed staff reversals can themselves be reversed when their receipts support it.

Web and native share request lifetime and recovery. A lost response clears displayed
private snapshots but retains the exact confirmation for retry. The retry returns the
same audit event without another provider write. Known access or conflict errors
remove the pending request. A reload reads retained history even after disconnection.
New action copy appears inside an expanded fact, and recovery copy only after failure.

`bash scripts/verify-semantic-direct.sh` passed seven package typechecks, direct mobile
TypeScript, 22 shared/native/localization unit cases, 16 database service cases,
44 existing audit cases and four browser journeys. The browser tests use the actual
authenticated API and Supermemory adapter against a loopback provider. At both
1280px and 390px, they remove and restore a 10,000-character fact, drop a successful
apply response, retry the identical payload, and verify one provider write. The
original event remains in history. Review and post-restoration navigation screenshots
were inspected at both widths. Thirteen changed source/test files pass static checks;
the one manual UI detector pass reported no findings.

The initial type check rejected an invalid definite-failure response property, and
an initial browser locator omitted the timestamp in a button's accessible name.
Both were corrected and their failure logs retained. Independent review also found
and resolved a stale provider-resolution gap, concurrent reservation errors and
loss of the client nonce after a missing response. The verification logs and screenshots
are under `test-report/deskazo-v1/checks/semantic-direct-*`.

Native device rendering, live-provider conformance, provider reconciliation and
redacted agent approval review remain open. Database validation and provider transport
are separate, so lifecycle or external fact changes can still race a call. Account
erasure may remove an audit while transport is in flight. The direct controls do not
provide provider-side atomicity, physical-erasure proof or undo for unknown receipts.
V1 remains incomplete.

The broader offline integration regression also passed all 723 cases across
42 suites, including the existing executor approvals, background compaction,
account lifecycle and customer workflows. All owned verification processes are
terminal. The structured record is
`test-report/deskazo-v1/checks/semantic-direct-command-results.json`; the independent
review is `test-report/deskazo-v1/checks/semantic-direct-independent.md`.


## Full document approval checkpoint

Staff-agent approvals now retain complete memory, skill and learning document
requests up to 1,500,000 JavaScript string characters. The bound accounts for two
100,000-character document versions, proposal metadata and JSON escaping. The
larger bound applies to eight explicit document tools. Semantic fact reviews keep
their existing limit, and unrelated consequential actions keep their smaller limit.
Secret redaction or an over-bound request still removes approval actions. The server
continues to replay the exact persisted request and check revisions and proposal
content before writing.

`bash scripts/verify-document-approval.sh` passed 131 unit cases, 19 authenticated
executor journeys, six browser cases, three package typechecks and mobile TypeScript.
The boundary cases parse real tool schemas and include an escaped learning request
above 1.39 million characters. Executor journeys cover all eight tools, allow and
deny, selected stale changes, and attempted model argument substitution after review.
The browser tests retain and reload both full document versions at desktop and phone
widths, reach the end with the keyboard, and check stopped approvals. The first two
integration attempts failed because of fixture setup errors; their logs are retained.
The previous 723-case integration regression predates this checkpoint and was not
repeated here.

A real iOS simulator Release build exposed a blank document body that browser tests
missed. Splitting the same document into text views of at most 2,000 Unicode code
points fixed rendering. The scroll region stays bounded and approval buttons remain
visible. Splitting preserves the source string, including newlines and surrogate
pairs; it adds visual wrapping at chunk boundaries. Each chunk remains selectable, but selection cannot span chunk boundaries. Stopping
the synthetic run removes both approval actions and shows its inactive state.
The native paint failure cannot be reproduced by the existing DOM-based component
tests; the retained simulator before/after captures are the regression evidence.
The native review server is repeatable through
`pnpm exec tsx packages/testkit/src/cli/native-review.ts`, using a disposable database,
synthetic account and loopback backend. It does not contact a real model or provider.

Native touch scrolling and visible end-of-document reachability remain unverified.
Simulator drag automation also behaved like a tap on the existing settings screen;
removing text selection did not change that result and was reverted. Rendering the
first part and seeing the action buttons is narrower evidence than complete device
acceptance. Maximum escaped cards and repeated large-card history/export loads also
remain untested in the UI. Approval continuation still embeds the full request in a
model prompt, so the formatter bound does not establish compatibility with a real
model's context window. Redacted approval review, provider reconciliation and the
remaining live/native/release acceptance work stay open. V1 remains incomplete.


## Bounded document approval replay checkpoint

After staff approve a document change, the model can now call
`apply_approved_document` with an empty object. The server resolves that call to
the next retained document approval and restores its complete request. Document
contents no longer appear in the approval continuation prompt. The underlying
memory, skill or learning operation still performs its existing authorization,
revision, proposal-content and duplicate-effect checks. This applies to the same
eight explicit document tools supported by full document review.

The replay helper is exposed only when the run has an approved document operation
whose original tool remains available. It rejects supplied arguments, an empty
queue, an unavailable underlying tool and skipping an earlier approval. Connector
tools cannot claim its reserved built-in name. The ordinary runtime still owns
tool dispatch, error reporting and completion auditing. A host-side replay before
the runtime was considered but not implemented. Staff still approve the full
stored card; the helper grants no new permission.

`bash scripts/verify-document-replay.sh` provides the sequential offline check.
The focused results pass 150 unit cases and 23 authenticated executor journeys,
including a learning review with more than one million JSON characters, malformed
helper arguments followed by a valid retry, a duplicate call after consumption,
and two retained skill approvals applied in order. The FIFO fixture seeds its
second approved effect in the disposable database; it does not claim to test a
second approval UI interaction. Every first model request lacks the helper, and
denied cases never gain it. Unavailable-tool and mixed-tool FIFO behavior are
covered at the replay resolver boundary, not by live-provider tests.

The first executor run had three assertion failures because its 30,000-character
whole-prompt bound excluded the existing 32 KiB memory context. The corrected
check proves that the complete document is absent and the fixture's prompt text
stays below 45,000 characters. Another run rejected an extra field in the new
FIFO fixture before execution; the fixture was corrected. Both failure logs are
retained under `test-report/deskazo-v1/checks/document-replay-*`. The first full
regression attempt failed before tests when Docker did not bind the disposable
database port in time; its log is retained separately.

This removes document duplication from approval continuation; it does not prove
that every configured model can hold all ordinary instructions, memory, history
and tool schemas. The model must still issue the small replay call. A read-only synthetic probe using the real approval formatter and page loader
returns 35,025,453 response bytes for 50 valid large cards. That exceeds mobile's
16,777,216-byte RPC limit. Conversation pages need byte-aware pagination; this is
a reproduced defect, not a load-test signoff. The probe and result are retained
as `test-report/deskazo-v1/checks/probe-document-history.ts` and
`test-report/deskazo-v1/checks/document-history-probe.json`. Large exports, native
touch scrolling, real-provider and release acceptance also remain open. V1 is
incomplete.

The final full offline regression passed 746 cases across 43 suites. Six changed
source/test files pass static validation, and shell syntax and diff checks pass.
All owned verification processes are terminal. The structured record is
`test-report/deskazo-v1/checks/document-replay-command-results.json`; independent
review is `test-report/deskazo-v1/checks/document-replay-independent.md`.

## Large document history pagination checkpoint

Conversation history now applies an 8 MiB serialized UTF-8 budget to persisted
messages, in addition to the existing message-count limit. Complete messages and
approval details remain intact. Ordinary pages retain the newest contiguous
window and return a cursor that includes every omitted older message on later
pages. Around-message pages retain the requested visible message and shrink
the surrounding window. Peer filtering, receipt-only rescans and chronological
export traversal continue to use the same loader.

The original synthetic reproduction now returns 11 complete cards and 7,705,648
serialized response bytes, down from 50 cards and 35,025,453 bytes. Seven focused
regression cases cover complete traversal, jumps at both ends and the middle,
UTF-8 sizing, indivisible messages, receipt-only pages and sparse sequences beside
hidden peer activity. The original six size regressions failed before the fix.
All 163 selected API, web and mobile unit cases pass after the fix.

Two authenticated database journeys seed 50 valid full-document cards in bot and
group conversations. They read snapshots and every older page through the same
bounded JSON response reader used by mobile, verify every original message and
card, retain an around-message target, and verify the chronological export
loader. They also confirm another workspace cannot read the cards. The first
integration attempt passed the size/content checks but failed a test assumption
that isolation errors return HTTP 404. These existing routes return HTTP 500;
the test now follows the existing authorization suite's denial contract and
checks that the error contains no document content. This phase does not change
that error mapping. The failure log is retained.

The selected conversation, search and authorization regressions also pass: 55
database integration cases including the two new journeys. API and testkit
typechecks, static validation, shell syntax and diff checks pass. All owned
verification processes are terminal. The repeatable check is
`bash scripts/verify-document-history.sh`. Structured command results and the
independent review are under `test-report/deskazo-v1/checks/document-history-*`.

The page budget is not a universal response-size guarantee. A single message
larger than the budget travels alone to avoid losing or truncating content; an
arbitrary stored message above mobile's 16 MiB limit remains unreadable there.
Snapshot metadata and live-event projections are outside this persisted-message
budget. Database queries still fetch a count-limited batch before applying the
byte budget. Export traversal is lossless, but the complete export is still
assembled in memory and is not a bounded or streamed mobile download. This phase
does not establish native touch scrolling, device memory behavior, live provider
acceptance or release readiness. V1 remains incomplete.

## Native review retry and hosted identity checkpoint

A fresh disposable backend and the retained iOS Release build reproduced the
long document's visible beginning and approval controls. Simulator wheel and
drag input still did not move the document pane, including after raising the
window. Accessibility field replacement completed synthetic sign-in after typed
input dropped characters. No mobile source was changed in this retry. The
screenshot is retained as `checks/native-scroll-retry.jpg` under the local V1
report. Touch scrolling and visible end-of-document acceptance remain unproven;
the simulator and disposable backend were stopped afterward.

The hosted connector and relay services are healthy. Read-only inventory found
configured LINE and Instagram accounts, but no store, CRM, Sheets or invoicing
connections. `scripts/verify-openconnector-identities.mjs` then executed only
`line.get_bot_info` and `instagram.get_current_user` against the configured
accounts. The live identity reads returned HTTP 200 with valid identity fields.
Credentials, account identifiers, aliases and response details stayed inside the
connector host; the retained report contains only provider names, counts,
statuses and pass/fail values. The connector may record its normal read audit.

Five offline verifier tests cover fixed action selection, explicit account
aliases, missing configuration, suppression of provider/transport details and
cancellation of oversized responses. Inventory reads are capped at 4 MiB and
identity responses at 128 KiB.
Testkit types and static checks pass. The verifier is an identity-access check,
not acceptance of messages, comments, webhook delivery, revocation, commerce,
CRM or invoices. Dedicated test accounts and a store sandbox have been requested
before testing those journeys. No messages were sent, customer records written,
permissions expanded or hosted services redeployed in this phase.

## Instagram reply-read connector patch

The saved `infra/open-connector-patches/instagram-comment-replies.patch` adds
`instagram.list_comment_replies` to the hosted connector source revision. It
reads one reply page with a fixed GET request, reuses comment normalization and
cursor handling, and requires the existing basic and comment-management scopes.
The new reply read requests Meta's `user{id}` field; normalization retains its
optional ID as `userId`. Existing top-level reads retain their
original field request to avoid introducing a new field-compatibility risk.
Neither read infers authorship from a username or compares scoped comment IDs
with profile IDs. The source evidence and API limits are recorded
in `docs/research/deskazo-instagram-reply-history.md`.

`node scripts/verify-instagram-replies.mjs infra/open-connector` reproduces the
patch in a disposable checkout of revision `9e11b04c`, generates the catalog,
runs the upstream lint, format and three TypeScript projects, checks that fixes
leave the patch unchanged, and runs eight offline real-handler tests. Those
checks pass. Tests cover separate reply pages, author evidence, safe cursor
output, fixed read requests, input validation and permission/deletion/rate-limit
errors. An initial typecheck caught an overly broad edit in the write-comment
handler; that edit was corrected before the saved patch and reproduction run.
The final diff leaves write handlers unchanged. The verifier reuses the supplied
checkout's installed dependencies; it pins source and patch, not the dependency
installation.

This patch is not deployed or included automatically in the pinned customer
build. The shared upstream checkout remains unchanged. Existing learning feeds
remain caption-only. Durable traversal of media, parent comments and reply
pages, explicit owner opt-in, per-run coverage and live synthetic-account
acceptance still need implementation or verification. The documented author
field is supported by Meta's reference and SDK schema, but its Instagram Login
wire shape has not been checked against a live test account. Recent replies on
old posts require scanning accessible old media and comments; media age is not
a safe cutoff. Media ceilings, deleted parents, permissions and missing author
or date fields prevent a universal complete-history claim. V1 remains open.

## Owner-approved, resumable Instagram reply learning

Social learning now supports `includeReplies` through the existing owner-approved
source configuration. The contract and migration default it to false, preserving
caption-only sources. The setting is visible in source inspection and account
exports. Enabling replies validates all required actions before creating or
changing the source; a connector without `instagram.list_comment_replies` fails
before any history is read. Existing scope, revision, account-binding, revocation,
lease and private-evidence checks also protect reply reads and learning tasks.
Changing consent while a reply request is in flight discards its result.

Each job reads one media, parent-comment or reply page. Its private durable cursor
keeps all three pagination levels, including empty pages that still have a next
cursor. Old media and parents remain traversable; the learning service filters
business reply timestamps against the original scan window. Retries preserve
that window and cursor. Stable reply IDs and text digests suppress duplicates
across retries and refreshes. Missing author evidence, text or valid dates are
skipped. A username or scoped author ID never substitutes for Meta's app-user
`userId` evidence. A scan that repeats a cursor or reaches the local page limit
reports partial coverage instead of completion.

Business reply text is the voice example. Its parent comment is retained as
separate private, unverified context and the learning instructions explicitly
exclude that context as a voice example or permission to act. Unrelated customer
replies are not archived as examples. Batches account for serialized context as
well as reply text. The bounded cursor retains full parent text, including a
large JSON-escaped page. Oversized serialized records are skipped and counted before a deduplication
marker is inserted. A later valid import can still learn those records; no
context or reply text is silently truncated.

Source coverage now reports aggregate and separate reply-specific in-window
dates, unverified/oversized skipped replies
and access limitations, including absent parent context. Scan completion covers
accessible pagination, not all historical communication. Provider ceilings,
deleted or restricted content, Stories, ads and DMs limit what this path covers.
The original connection-relative start remains fixed and continued scans can
include newer content within the owner's approved source.

`bash scripts/verify-instagram-learning.sh` passes 36 PostgreSQL integration cases,
47 unit cases, and adapters/contracts/db/testkit typechecks. It also reproduces
the saved connector patch, passes eight upstream reply tests and checks 42 fixed
read executions across 21 audited actions. The read verifier accepts clean source
or the exact saved Instagram patch and records the raw patch digest. An earlier
report hashed trimmed patch text; the final report matches the saved artifact.
An initial context test passed at runtime but failed its nullable archive-field
typecheck; the assertion was corrected and the entire check was rerun. Failure
and final evidence remain under `test-report/deskazo-v1/checks/instagram-learning-*`.

No hosted services or live accounts were changed. The shared upstream checkout
is clean. The connector patch and database migration still need deployment;
synthetic-account validation must prove the reply author field and live traversal
before acceptance. The verifier reuses installed connector dependencies.
The app-user field proves account authorship, not whether a human or automation
wrote a reply. Excluding this product's own generated replies from hourly learning
still needs delivery-ID reconciliation before live activation. Instagram DM
history, native LINE export mapping, broader live provider journeys,
native interaction checks and release acceptance remain open. V1 is incomplete.

## Instagram comment dispatch provenance

The integration settings layer now records a private receipt before dispatching
`instagram.create_comment` or `instagram.reply_to_comment`. It resolves the current
action and checks its access policy first. The receipt precedes the external
execute request, including a customer runtime's request to its hosted gateway.
Both staff and customer tools use this boundary. Receipts store request digests
and confirmed provider IDs, without reply text, credentials or user IDs. They
survive connection and run deletion and are removed with their Space. They are
execution internals, excluded from account exports under the existing export
policy.

A unique execution key prevents concurrent duplicate sends. Confirmed retries
return the stored ID result after fresh action resolution and request/binding
validation, even after upstream idempotency retention expires. A missing,
malformed, conflicting or lost response leaves the receipt uncertain and prevents
blind resending. Returned parent or media IDs must match the requested target
before a result can become confirmed. The database must commit that confirmation
before the caller receives success.

Reply learning excludes confirmed app-sent comment IDs across connection aliases
within a Space, including edited versions of those replies. It counts these
exclusions separately from unverified and oversized rows. When a send remains
uncertain, it holds reply examples in that Space and reports the coverage gap;
captions still import. Held rows do not consume deduplication markers and can be
imported after reconciliation and a later scan. The learning transaction also
observes receipts committed during the provider page fetch.

`bash scripts/verify-instagram-provenance.sh` passes 17 dispatch PostgreSQL cases,
40 social-learning cases, the existing gateway lifecycle case, 28 unit cases and
adapters/db typechecks. Dispatch cases cover both comment actions, customer
policy, concurrency, replay after upstream key expiry, changed requests and
bindings, response loss, persistence failures, target mismatch, gateway transport
and deletion. The verifier runs database suites sequentially against isolated
databases. Initial failures were an invalid synthetic policy and two stale unit
expectations; those logs are retained alongside final evidence under
`test-report/deskazo-v1/checks/instagram-provenance-*`. Independent review found
the missing target check, which was fixed and regression-tested before the final
verification run.

This is not complete automation provenance or live acceptance. There is no
supported reconciliation operation yet for uncertain receipts. The current hold
is Space-wide rather than account-specific. Sharing the same Instagram account
across Spaces, historical app sends from before receipt tracking, and automation
outside this app still need an explicit provenance policy and evidence. Account
authorship alone does not prove human authorship; source coverage says so. No
hosted service or live account was changed. The database migration and connector
patch remain undeployed, and the broader V1 acceptance gaps above remain open.

## Recovering confirmed Instagram sends after a lost gateway response

Staff can now inspect tracked sends with `customer_instagram_sends` and request
evidence recovery with `customer_instagram_send_reconcile`. Both use current
connection access. Inspection returns up to 100 records per page with a cursor,
action, target, timestamp, provider comment ID and confirmed/uncertain status.
Pagination follows record IDs, without a chronological-order guarantee. Reply
text, execution keys, request digests and binding hashes are not exposed.
Reconciliation checks connection access again after the remote read before
returning a private result.

The connector contract and authenticated gateway protocol now support a receipt
read. Recovery checks Space, execution key, request digest, connection binding,
action and target against durable records. A confirmed gateway receipt can
confirm a local send whose response was lost, without calling the provider's
execute action again. Concurrent recovery cannot overwrite an already confirmed
result. Retrying the exact original execution can also recover its confirmation;
this does not bypass the surrounding customer-operation or workflow journals.
Staff reconciliation does not resume conversations or retry unrelated actions.

Missing, malformed, mismatched or still-uncertain evidence never proves that a
send failed. It cannot clear the local hold or authorize a resend. Direct
OpenConnector requests currently have no remote receipt reader, so their
uncertain outcomes remain unresolved. Old gateway versions also cannot supply
the new receipt operation. The migration adds routing metadata for new receipts;
older unbound receipts can acquire that metadata only when the exact original
request is presented again. They are not included in connection-specific staff
inspection until bound.

`bash scripts/verify-instagram-reconciliation.sh` passes 27 PostgreSQL dispatch
and recovery cases, 40 learning cases, the expanded gateway lifecycle case, 53
unit cases and adapter-kit/contracts/adapters/db typechecks. The gateway test
exercises the real client, server and OpenConnector adapter with synthetic
provider responses: the hosted execute succeeds, its transport response is lost,
and the staff tool recovers the receipt with only one provider send. Other checks
cover wrong targets and digests, missing evidence, action restrictions, tenant
isolation, changed bindings, revocation during a read and 105-row pagination.
The learning test now uses the supported reconciliation method to release its
hold and import previously withheld reply examples on a later scan.

An initial typecheck found the optional wrapper method was accessed after
narrowing to the concrete OpenConnector class. The gateway now captures the
wrapped method before that narrowing. The first full verifier then passed its
runtime tests but found widened status types in two synthetic mocks; explicit
provider-contract types fixed those tests. Final and retained failure evidence
are under `test-report/deskazo-v1/checks/instagram-reconciliation-*`.

This closes recovery for confirmed gateway sends, not every uncertain external
outcome. Account identity, account-specific holds, same-account cross-Space
provenance, historical and outside-app automation, live provider validation and
deployment remain open. Nothing was sent to a live account or deployed in this
phase. The full V1 objective remains incomplete.

## Instagram account-bound execution and learning

New Instagram comment sends require a verified provider account identity. The
adapter reads it from the owned connection's management record, validates the
service and alias, and sends through an account-bound endpoint. The companion
`infra/open-connector-patches/account-bound-actions.patch` checks the resolved
credential snapshot before loading an executor and rechecks the runtime's
connection grant. It rejects unverified and Marketplace identities. The expected
account is part of the idempotency fingerprint. A completed same-key replay
returns its historical result after reauthorization without executing again;
a fresh request for the old account is rejected.

Receipts store a hash of the verified account, without reply text or credentials.
Confirmed and uncertain receipts for that account apply across Spaces and
connection aliases. Another verified account's uncertain sends no longer hold
this account's reply examples. Legacy receipts keep their conservative Space-wide
hold and are never assigned a historical account from today's connection. Send
inspection and recovery check the current account before returning a known-account
receipt. Every learning identity, media, comment and reply read now carries the
feed's expected account through the same guarded endpoint.

A credential change after identity lookup can reject a send before dispatch.
Only that server-side guard creates an explicit `meta.dispatch: "not_started"`
marker. The adapter accepts it only with the exact structured account-change 409
response on the guarded route. The hosted and local receipt wrappers can each
remove their own newly inserted, unconfirmed claim. They never release a previous
uncertain claim or infer non-dispatch from a provider error message, generic 409,
or lost response. A provider error using the same error code does not receive
this marker. Missing identity capability prevents new comment dispatch entirely.

Verification:

- `CHECK_PREFIX=instagram-account-binding bash scripts/verify-instagram-reconciliation.sh`
  passes 34 receipt, 43 learning and one expanded gateway PostgreSQL test, 86 unit
  tests and four package typechecks. Tests cover same-account receipts across
  Spaces, unrelated accounts, legacy holds, account changes on replay and reads,
  and a credential swap after both gateway and local receipts are inserted.
  That gateway case sends nothing and leaves neither new receipt behind.
  Receipt listing rechecks connection access after identity I/O, with revocation
  and rebinding regressions.
- `node scripts/verify-account-bound-actions.mjs <installed-upstream-checkout>`
  creates a disposable checkout at the pinned patch base, applies the saved guard,
  runs lint, format and typechecks, and verifies fixes leave the patch unchanged.
  All 126 guard, policy, HTTP and idempotency tests pass. It also applies the
  separate Instagram reply patch, repeats upstream checks, and passes its eight
  handler tests. The shared upstream checkout is unchanged.

This supersedes the account-specific hold and same-account cross-Space gaps in
the previous phase. It does not prove historical or outside-app automation
provenance, live author-field behavior, or a direct provider send's lost outcome.
The account guard patch and database migration have not been deployed. The hosted
connector must support the new endpoint before these sends and learning refreshes
can succeed; there is no unguarded fallback. No live messages or comments were
sent. Full V1 acceptance remains incomplete.

## Shipping the required connector source

The customer stack previously locked an older unpatched OpenConnector tree, so
its normal build could not deliver the implemented checkout and Instagram
capabilities. The source lock now records the tested upstream commit, ordered
checksums for the five V1 patches, and the final patched Git tree. Source
preparation clones that exact commit into a new directory, applies the already
verified patch bytes, checks the index tree, and removes Git metadata. It rejects
an existing destination or altered patch and never copies operator edits,
untracked files or credentials. `rakazo-source.json` records what was prepared.

`customer-stack.sh up` builds from this temporary connector source with the
upstream Dockerfile, tags the image by the locked tree, and prevents fallback to
an unpatched pulled image. It cleans temporary source on success or failure and
keeps the existing Compose project and named data volume. The same preparation
command is documented for separately managed connector hosts. OpenRAG's existing
unmodified-source check is retained. The current local OpenRAG checkout differs
from that lock, so its full-stack preflight still rejects it; no operator checkout
was reset and the operator stack was not started.

Verification now includes eight deterministic source and shell tests. They cover
source edits, ignored credentials, patch checksum and final-tree mismatches,
existing destinations, OpenRAG verification and cleanup after both successful and
failed stack builds. The suite is also wired into the repository's unit runner.
`node scripts/verify-customer-connector.mjs` builds the locked connector's real
Docker images, runs all 215 combined guard, idempotency, Instagram, WooCommerce and mail
tests in the build image, and starts an isolated production image. It verifies
health, the executable reply/checkout catalog, and authentication on the guarded
route. Compose resolution proves that its build context and image tag match the
prepared source and that connector state remains on a named volume. Provider
networking is disabled for the test and runtime containers. Test-only setup and
migration files omitted from upstream's build stage are mounted read-only from
the locked source; the production stage uses its own copied migrations.

The production install initially reported advisories from two nested Nodemailer
versions. A fifth patch makes the mail clients reuse the existing fixed direct
Nodemailer dependency, removing those two old lockfile entries without changing
the mail clients' major versions. This addresses the reported parser and content
resolution advisories, including the [maintainer's address-parser advisory](https://github.com/advisories/GHSA-2x7j-588g-ccc2).
The final build and production dependency audit report zero known advisories at
verification time; this is not a permanent safety claim or an operating-system
image audit. The verifier checks the registry again on each run. Source trees
are locked; Docker base images and registry resolution remain external inputs.
Multi-project stack startup is sequential and can leave an earlier dependency
running if a later project fails; only temporary source cleanup is automatic.

This closes source delivery for these connector capabilities. It is source and
image-build evidence, not a hosted deployment, whole-stack upgrade/restore test,
or live merchant acceptance. The tested containers and image tags were removed.
The database migrations and compatible connector/API/worker still need a
coordinated deployment. Full V1 acceptance remains incomplete.

## Instagram message-history reads

The connector source lock now includes a sixth patch with
`instagram.list_conversations`, `instagram.list_conversation_messages`, and
`instagram.get_message`. The first two return cursor pages of references; the
third reads one message separately so an unavailable detail does not erase its
reference page. Each action makes one fixed GET with the existing OAuth context
and message-management scopes. Conversation lists use the connected account;
caller input cannot override the account, host, HTTP method, or requested fields.
Message details retain raw participant IDs and text when present. They do not
invent human authorship, webhook flags, attachment prose, or a missing date.
Provider permission, throttling and unavailable-message responses remain errors.

The read-effect verifier now prepares the complete locked connector source in a
temporary directory before importing its handlers. Its argument supplies only
installed dependencies, not source code to trust. It regenerates the registry,
checks all 24 declared read actions with 48 fixed-request cases, then removes the
temporary source. The original single-patch reply verifier still tests that
patch independently; its read-effect step now checks the current full release.

Verification passed 34 Instagram handler cases, upstream lint and typechecks,
48 read-effect cases, and 37 application cases. The production-image verifier
passed 241 connector cases across 11 files, confirmed a healthy isolated runtime
with all three new actions, and reported zero current production dependency
advisories. Its test and runtime containers had provider networking disabled.
The verifier removed its containers and image tags. No hosted deployment or
live account history read was performed. Independent review corrected a schema
portability issue: Meta's raw `+0000` timestamps must not advertise RFC3339
`date-time`. The catalog now declares raw strings, and schema tests cover that
contract. The final image check includes this correction.

These actions close the missing connector read capability, not automatic DM
learning. Existing social sources remain caption/reply-only. Meta exposes details
for only the latest 20 messages per conversation, omits inactive Requests older
than 30 days, and does not prove that a business message was written by human
staff. See the [primary-source research](research/deskazo-instagram-message-history.md).
An importer still needs explicit consent, fixed-window coverage, durable traversal,
known automated-send exclusion and review of uncertain authorship. Live API access,
identity semantics and provider retention remain acceptance checks.

## Durable Instagram DM send receipts

The existing Instagram receipt path now also wraps `instagram.send_message`.
It requires a verified account, pins that account at dispatch, persists the
claim before provider I/O, and stores a validated message ID and recipient only
after completion. Optional thread IDs are retained; text and extra provider
fields are stripped. Failed, missing, malformed, or unstored confirmation leaves
the receipt uncertain. Reusing that execution cannot send again. A matching
gateway receipt can confirm the outcome without invoking the send action.

The Prisma model is now `InstagramSend`, with a generic `externalId` mapped onto
the existing physical `commentId` column in `instagram_comment_writes`. The
symbol rename is captured in a rerunnable codemod. A new migration extends the
database confirmation check for a DM's message ID and recipient, preserving
historical comment records and leaving unknown historical account identity null.
Apply that migration before the updated API and worker. The earlier connector
account guard must also be deployed before guarded DM delivery can succeed.

Staff inspection uses the existing `customer_instagram_sends` and reconcile
tools for both comments and DMs. It reports the action, target, generic external
ID and outcome within the selected accessible account binding. Comment learning
now considers only comment actions and legacy records without an action, so a
message receipt cannot suppress a comment with the same opaque ID or hold comment
examples unnecessarily.

The shared module deliberately tracks all app-dispatched DMs. A staff tool call
does not by itself prove human authorship. Human inbox replies retain their
existing conversation learning path; these receipts prevent rediscovered app
output from becoming fresh unverified evidence. The history importer, explicit
DM-source consent and coverage traversal remain to be implemented. Historical
automation from other apps remains unknown. Direct connector outcomes without
matching durable confirmation remain uncertain. No live message or deployment
was performed in this phase.

Verification passed 47 receipt PostgreSQL cases, 45 social-learning cases and the
gateway/inbox journey, plus 86 unit cases and four package typechecks. The
gateway journey recovers a lost DM response without a second provider send and
records a real staff-inbox delivery through the application path. A separate
upgrade case creates the legacy table from its migration, inserts a comment
receipt, applies the new constraint and confirms that the old ID and null
identity survive while a new DM confirmation succeeds. Its tables and foreign
key target are temporary and rolled back. The codemod rerun changes zero files.

## Opted-in Instagram message learning

Learning sources now accept `includeMessages`, default false. Setup verifies all
three message-read capabilities and the professional account identity. The first
scan fixes its window to the 30 days before connection, including when resumed;
completed-scan refreshes can include newer messages. The importer traverses
conversation pages, reference pages and individual details with one history
request per durable step. Missing details get one retry before becoming reported
coverage gaps. They remain eligible for a later scan. Undated, out-of-window,
empty and ambiguous-direction messages cannot become voice examples.

Outbound account text becomes a candidate, with matching earlier customer text
from the same reference page retained only as private context. Each candidate
records its conversation, message ID and unverified staff authorship. Known app
sends are excluded across verified account aliases; uncertain sends hold
candidates without consuming duplicate markers. The receipt is persisted before
dispatch, so later confirmation cannot bypass this capture-time check.

Every message-based suggestion requires staff review, even if the inference
model labels it supported. Original messages remain available through the existing
private evidence view. Review records the exact proposal, chosen scope and staff
reason; approval can be undone. Source changes are rechecked at inference and
final write. Owner exports include the opt-in and private evidence, excluding
provider bindings and traversal cursors. Source removal deletes private archives
and tasks while retaining approved document audit history.

Independent review found that failed authorization checks initially retained
private text buffered in the cursor. Failed message pages now clear the cursor
and visited state while preserving coverage backed by committed batches. Retries
retain the approved window and existing duplicate markers. Skipped/context
counts can include rereads, which the source coverage explicitly reports.

Run `bash scripts/verify-instagram-message-learning.sh` for the sequential offline
PostgreSQL, adapter and type checks. Final verification passed 128 PostgreSQL
cases, 51 unit cases and four package typechecks. This includes a partially
committed scan that loses access, clears its private buffer and resumes in the
same window without duplicating tasks. Evidence and the independent review are
under `test-report/deskazo-v1/checks/instagram-dm-history-*`.

Live Instagram Login identity, permission and pagination acceptance remains open.
Account direction cannot establish human authorship or distinguish historical
outside automation and self-messages. Staff must inspect the original messages
before endorsing voice. No complete 30-day archive is claimed: Meta limits
message details, inaccessible Requests remain gaps, and the local scan stops at
1,000 steps with partial coverage. Per-source pacing is not an account-wide rate
limiter across multiple bots or Spaces. This implementation has not been deployed
or exercised against customer messages. V1 remains incomplete.

## Shared Instagram history pacing

The three Instagram history reads now acquire a PostgreSQL permit keyed by the
verified professional account and history-read bucket. Admission has a 600 ms
interval across aliases, owners, Spaces and worker processes sharing that
database. The check sits immediately before OpenConnector HTTP dispatch, after
credential preparation. It also binds the request to that verified account so
credentials replaced while waiting cannot redirect the read. Busy callers do
not reserve future slots. The table stores only a hashed key and next admission
time; connector maintenance removes entries inactive for a day using database
time. The timestamp has a timezone so different database sessions agree.

Review caught a pool-starvation risk in the first implementation: gateway
commands held transaction connections while admission requested another. Gateway
history reads now finish their short authorization transaction before waiting
or making the external request. Current membership, runtime and account access
are rechecked before admission attempts and before returning private data.
Other gateway operations retain their existing transaction behavior. Revocation
cannot cancel an already-issued remote read atomically, but its result is
withheld when access has been revoked.

Waiting has a 20-second limit and observes cancellation, including while its
Prisma call is pending. Prisma itself does not cancel that SQL: late completion
can waste one short permit interval, but cannot dispatch a cancelled request.
Database failure prevents history dispatch. This limiter coordinates direct
reads and gateway traffic within the deployment database; independent deployments
and external clients do not share it. Provider-side limits can still apply.

Verification covers atomic admission across three database clients with different
session timezones, independent account buckets, cleanup and a gateway with only
one database connection. Two runtime owners can have an in-flight read and a
waiting request without starving the pool. The waiting request can cancel;
runtime/account revocation blocks dispatch; revocation during provider I/O hides
the private result. Existing gateway and social-learning regressions remain green.
Final counts are 70 PostgreSQL cases, 58 unit cases and four package typechecks.
Initial test-double type errors and the final test-cast failure are retained in
the evidence logs, with corrected targeted results alongside them.

Run `bash scripts/verify-instagram-account-pacing.sh` to repeat the offline checks.
Evidence and independent review are under
`test-report/deskazo-v1/checks/instagram-rate-*`. Apply migration
`20260919230000_connector_rate_limits` before updating the API and worker.
No deployment or live Instagram access was performed; V1 acceptance remains open.

## Application recovery after a failed migration

`scripts/verify-product-recovery.py` runs the built application with PostgreSQL
and the worker in disposable stacks with no published ports or external network
access. It creates a synthetic account, encrypted model credential, bot,
conversation and private file, then takes a deployment snapshot. An injected
migration commits a data change before failing. Starting the prior image still
fails with Prisma P3009 and preserves the changed data, so image rollback alone
is not treated as recovery.

The verifier restores into fresh volumes using the original image and
configuration. Application services remain stopped until explicitly started.
The restored API accepts the original session and password; the saved credential
decrypts, and the bot instructions, conversation, private file and successful
migration state match the snapshot. The failed source remains unchanged.

This exposed a real offline-startup failure: the Docker build cached pnpm for
root, while runtime `USER node` tried downloading it again. The application image
now shares `COREPACK_HOME=/opt/corepack` between build and runtime. Local test
reports and decision trails are also excluded from the Docker build context.
The application-image PR validation workflow now runs this recovery check after
loading its built image. Hosted CI execution remains pending.

This proves manual snapshot recovery from the current image and a synthetic
migration fault, not compatibility between published versions, updater-sidecar
recovery, external provider reconnection, or exactly-once external effects after
restoring older data. Those remain V1 release gates. See the recovery commands
and limits in `docs/self-host.md`; evidence is under
`test-report/deskazo-v1/checks/product-recovery-*`.

## Coordinated upgrade shutdown

A real Compose check found that an unchanged worker can remain running while a
new API starts and migrates. The shared update plan now prepares images first,
then stops every configured update service, then recreates without rebuilding.
Manual upgrade commands use the same order. Download/build failure leaves
services running; an unsuccessful stop prevents startup and reports that manual
recovery is needed. A failed recreate must stop the new services before the
updater can restore the previous checkout and try its cached image.

`scripts/verify-upgrade-ordering.py` runs the actual shared plan against an API
and unchanged worker in an isolated Docker project. Before the fix the worker
was reachable during API startup; afterward it was not. The verifier is wired
into application-image PR validation. Local evidence also covers 159 unit cases
across core, updater and API, plus core/updater typechecks. It includes build,
initial-stop and failed-update-stop failures, and restoring fork configuration
before attempting recovery. Evidence is in
`test-report/deskazo-v1/checks/upgrade-ordering-*`.

The stop applies to configured services with stable Compose names. External
writers and removed or renamed services need a manual cutover. This does not
establish schema compatibility of automatic image fallback, reverse migrations,
or complete published-release upgrade acceptance. The separately tested
snapshot recovery path remains necessary after failed database changes.

## Migration-aware update recovery

The updater now probes Prisma migration history through the selected cached API
image before startup and after a failed recreate. Forward updates require every
applied migration to retain its name and SQL checksum in the target image; new
pending migrations are allowed. Explicit rollback requires a complete match
before stopping services and checks again after shutdown.

Automatic fallback requires unchanged database identity and ordered migration
history, plus an exact match against the previous image's migration SQL. Failed
or newly completed migrations leave application services stopped for snapshot
recovery or a compatible forward fix. A startup failure without migration changes
can still recover the previous image. The probe uses read-only SQL and records
only hashes of non-secret database identity and migration metadata.

`scripts/verify-product-recovery.py --updater-image <cached-updater-image>`
exercises the actual updater and Docker commands. The verifier replaces release
lookup and registry download with a checked cached fixture image. It covers a
failed migration, a completed migration followed by startup failure, and a startup
failure without migrations. Each scenario also restores a snapshot into fresh
volumes and checks the original session, password, encrypted credential, bot,
conversation and private file. The application-image PR workflow now builds the
updater and runs all three variants alongside manual snapshot recovery and the
upgrade-ordering check.

Local verification passed all three real-updater scenarios and the standalone
manual recovery case, 175 unit cases, and core/updater typechecks. The test fixture
typing error and its successful corrected check are retained in the evidence.
No disposable fixture containers, volumes, networks or image tags remained.

This gate does not prove compatibility of data changes outside migrations, stop
external database writers, or establish compatibility between published releases.
Hosted CI and full V1 release acceptance remain pending. Evidence and independent
review are retained under `test-report/deskazo-v1/checks/migration-fallback-*`.

## Owner-configured escalation criteria

The V1 spec requires Jev to assess business escalation criteria. The previous
adapter sent only conversation history and fixed questions. `customer_assessment`
now accepts optional owner-approved `criteria`, up to 2,000 characters. The staff
agent can inspect them through `customer_inspect`, change them after approval,
or clear them with an empty string. Existing configurations keep their prior
behavior through an empty default. No database migration is required.

Jev receives a separate typed question for configured criteria. Its answer can
add a handoff but cannot cancel the built-in human-request, failed-help or
authoritative-information decisions. A missing answer fails assessment; a
low-confidence answer requires staff attention. The private decision record
preserves the exact criteria, provider and model used. Criteria go to the
assessment provider, not into customer messages.

Changes use the existing mandatory owner approval and conversation invalidation.
A late result cannot continue customer work after the configuration changes;
explicit handback is required. Approval offers no allow action if the full
settings are redacted or exceed the display limit. This also handles JSON
escaping that expands otherwise valid criteria beyond that limit.

`bash scripts/verify-customer-assessment.sh` repeats the offline checks. Final
evidence covers 68 unit cases, 99 PostgreSQL cases and three package typechecks.
Tests cover saved criteria, staff inspection, private audit, no criteria in
outbound messages, and a settings change during a pending assessment followed
by handback using the new criteria. Logs and cross-model review are retained
under `test-report/deskazo-v1/checks/assessment-criteria-*`.

The existing Jev browser verification session was inaccessible while the Mac was
locked. No new live assessment was run. These fixtures prove configuration and
decision plumbing, not Jev's classification quality on Thai or English merchant
conversations. Live custom-rule evaluation and full V1 acceptance remain open.

## Explicit history field and timezone mapping

The importer previously required Deskazo's field names and timestamps that
already carried an offset. Staff tools now accept a reviewed flat-field mapping
and explicit business/customer author values. Unknown values are not voice
examples. Preview includes bounded row samples for dates, conversation grouping
and authorship, plus counts over all rows. UTF-8 BOMs and quoted multiline CSV
are supported; duplicate headers and absent mapped CSV fields are rejected.

Local ISO timestamps require an owner-confirmed fixed UTC offset. Existing
offsets remain unchanged, and ambiguous dates are rejected. This is not an IANA
timezone or daylight-saving resolver. Exports spanning offset changes need
explicit offsets per row. No current native LINE layout is inferred from these
synthetic examples.

The same parser drives preview, canonical evidence identity and background pages.
A private archive stores its original content, mapping, offset and fixed window.
Equivalent normalized reexports reuse that archive and its saved options. A
205-message PostgreSQL journey verifies resumed pages without duplicate learning,
private evidence, account export and erasure of mapping with source withdrawal.
Preview text samples are not retained in coverage metadata. Apply migration
`20260920000000_learning_import_mapping` before updating API and worker.

Repeat checks with `bash scripts/verify-learning-import-mapping.sh`. Evidence
and review are under `test-report/deskazo-v1/checks/import-mapping-*`. The first
typecheck caught a d3 overload inference issue, and the first database run caught
a fixture using an invalid voice-document key. The API check also caught widened
author-role literals in preview output. All were corrected; final evidence covers
17 unit cases, 42 PostgreSQL cases and seven package/client typechecks. Real LINE
export validation and staff/browser/native acceptance remain open.


## Linux scheduled backup verification

The existing core-deployment verifier now accepts `--systemd-image` and runs the
supplied production backup wrapper and service under actual Debian systemd in a
disposable container. It checks the shipped nightly UTC schedule, persistent flag
and randomized delay, then accelerates a calendar trigger for the test. No host
unit, deployment, credentials or backup directory is changed. The container has a
private cgroup namespace and Docker socket access; every mutable deployment is a
uniquely named synthetic fixture.

Two local Docker runs passed. The installed service succeeds at `/srv/rakazo`.
A custom path without its writable override fails visibly and preserves previous
snapshots. Adding the documented override lets the timer complete a backup and
rotate only old timestamp directories after success. The resulting snapshot
restores database values, private files, ownership, modes and links into fresh
volumes. Previously stopped workers remain stopped; active managed writers resume.
The existing corruption, nonempty-target and failed-SQL recovery checks also pass.
The wrapper unit suite passes all 19 cases.

Reproduce with `infra/systemd/verification.Dockerfile` and
`scripts/verify-deployment-backup.py --systemd-image <cached-test-image>` as documented
in `docs/self-host.md`. The release workflow now runs this check on pull requests
and manual dispatch. Hosted CI has not run for this working-tree change. Evidence:
`test-report/deskazo-v1/checks/scheduled-backup-final.log` and
`test-report/deskazo-v1/checks/scheduled-backup-unit.log`.

This proves the installed service, calendar activation and recovery of its
synthetic snapshot. It does not prove host reboot recovery, persistent catch-up,
large deployments or native Linux-host compatibility outside this container.
The fixture's `docker.service` checks an already running external daemon. Full
application recovery is covered separately; no live merchant/provider workflow
ran here. V1 remains incomplete.

## Provisioning cancellation cleanup

Cancelled computer setup now checks cancellation before provisioning and between
provider preparation, workspace restoration, layout and activation. If a provider
returns an allocation after cancellation, rollback uses an independent 30-second
abort signal while retaining the same owner, Space and correlation context. It
destroys a fresh allocation or stops an owned resumed computer. Reconnecting to
an already running computer still preserves that existing workspace.

The regression first reproduced cleanup failing immediately because it inherited
the cancelled run signal. Eight new cases cover cancellation before dispatch and
late completion of provisioning, preparation, restore and layout. All 88 focused
cancellation, lifecycle, bot lifecycle and workspace unit cases pass, along with
adapter TypeScript and static checks. Run:

```bash
pnpm exec vitest run packages/adapters/src/computer-provision-cancellation.test.ts packages/adapters/src/computer-lifecycle.test.ts packages/adapters/src/child-bots.test.ts packages/adapters/src/computer-workspace.test.ts
pnpm --filter @rakazo/adapters check
```

Evidence is under `test-report/deskazo-v1/checks/provision-cancel-*`. These are
controlled provider/database fixtures, not live provider erasure checks. The
cleanup timeout depends on adapters honoring cancellation. In-flight account
removal, process loss before a provider response, and durable recovery after a
late cleanup failure remain open; this change does not establish complete
account deletion. Live Jev browser checks also remain blocked by the locked Mac.

## E2B teardown confirmation and account cleanup retry

E2B pause and deletion now use the SDK's direct control-plane methods by sandbox
ID. Teardown no longer reconnects, which could resume a paused computer, and no
longer suppresses provider failures. A confirmed missing sandbox counts as cleaned
up; an already paused sandbox counts as stopped. Authentication, rate-limit and
server failures propagate, preserving the handle and durable cleanup identity for
retry. Both calls receive the caller's cancellation signal and a 30-second request
timeout. The broader sandbox-loss heuristic is not used to confirm data erasure.

Two regression tests first reproduced false success from the previous pause and
uncached deletion paths. The installed SDK was then exercised against local HTTP
fixtures for success, missing resources, already-paused state, authentication,
rate-limit and server failures, with both cached and uncached handles. Those tests
verify the exact pause/delete requests, absence of reconnects and successful retry.
The final focused run passes 126 cases; adapter TypeScript and static checks pass.

The 20-case account-deletion PostgreSQL suite includes an E2B outage followed by
an adapter/service restart. It verifies that the account and sandbox cleanup
identity remain while deletion fails, and that a subsequent confirmed deletion
removes the account. The database case uses the real adapter with a controlled SDK;
the separate HTTP cases use the real SDK. No hosted E2B allocation or deletion was
performed. Evidence: `test-report/deskazo-v1/checks/e2b-teardown-*`.

This fixes confirmation and retry for known sandbox identities. It does not solve
allocations that finish after account/bot rows have already been removed, or
process loss before an allocation identity is persisted. Durable in-flight
provisioning remains required work. V1 remains incomplete.

## Durable provisioning and late cleanup

Migration `20260920010000_computer_provisions` adds a provisioning record before
each provider call. Admission checks the caller's account and Space membership,
rejects an account pending deletion, and claims the computer in the same
transaction as creating the record. The record survives bot/computer removal and
prevents cascading away its owner or Space. The returned provider identity is
saved before workspace setup. Successful activation removes the record in the
same transaction as adopting the computer.

Failed cleanup retains the provider identity and required cleanup action.
Reconciliation claims one cleanup attempt at a time and removes the record only
after the provider confirms success. Account deletion waits for unresolved
provisioning before revoking credentials or deleting data. Controlled PostgreSQL
tests exercise deletion requested during provisioning, bot removal, a late
allocation, failed cleanup, and a successful retry through a new deletion service.

Eight PostgreSQL cases pass, including successful adoption, unknown outcomes on
new and running computers, duplicate allocation prevention, cross-account
rejection, deletion admission, restrictive foreign keys and concurrent cleanup.
The existing 20-case account-deletion suite and 171 focused unit cases also pass.
Unit lifecycle fixtures isolate allocation rollback from receipt persistence;
the PostgreSQL cases exercise the real receipt implementation. An old unit case
that retried an unknown provision outcome now checks retry after preparation
failure; the database cases explicitly verify that unknown provision outcomes
block retry. Evidence: `test-report/deskazo-v1/checks/provision-receipts-*`.

Run the receipt journey with:

```bash
pnpm test:integration --spec=packages/adapters/src/computer-provisions.postgres.test.ts
```

This is partial recovery. Active or uncertain records, including a provider
exception before returning an identity, have no inspection or resolution flow
yet. A process crash while cleanup is claimed also leaves its record pending.
These records deliberately have no automatic expiry; unresolved records block
further provisioning and account deletion. Settled cleanup retries use fake
provider behavior, not live vendor erasure, and require continued reconciliation.
Provider-aware recovery, operational visibility and live acceptance remain
required before calling the lifecycle complete. V1 remains incomplete.

## Docker deletion confirmation

The Docker supervisor no longer treats every failed deletion as a missing
container. A Docker inspection or removal failure now returns a failure to the
adapter; invalid or mismatched computer ownership returns 403. Only Docker's
numeric 404 confirms that the container is absent. Screen assignments are cleared
after removal succeeds. The adapter already propagates non-404 errors, so failed
cleanup retains the account and its durable remote cleanup identity for retry.

The initial route regressions reproduced seven incorrect responses across daemon
failures, removal failure and ownership rejection. The focused 82-case unit run
passes. Two added PostgreSQL journeys exercise supervisor 403/500 responses, retain
the account and Docker cleanup identity, then complete deletion through a new
adapter/service after success. All 22 account-deletion cases pass. These database
tests use the real adapter with controlled HTTP responses. Local bot files may be
removed before remote cleanup succeeds; they are not asserted to remain pending.

An opt-in test also exercised the real Docker client and local daemon with a
running disposable container. Wrong owner/Space requests left it running; the
correct owner removed it; a repeated request confirmed absence. The fixture has
no mounts, published ports or network access and was removed. Run it against a
test daemon with a cached `busybox:1` image, setting `DOCKER_HOST` if needed:

```bash
VERIFY_DOCKER_DELETION=1 pnpm exec vitest run infra/sandboxes/supervisor/src/computer-deletion.docker.test.ts
```

Evidence is under `test-report/deskazo-v1/checks/docker-teardown-*`. Supervisor and
adapter type checks and targeted static checks pass. Per-bot network teardown
still uses best-effort cleanup; this test does not verify a production network or
volume topology. Unknown allocation recovery and the other V1 acceptance gates
remain open.

## Recovery of interrupted allocation deletion

Provisioning cleanup can now reclaim a deletion attempt whose claim is at least
two minutes old, but only when the configured adapter explicitly advertises
`replaySafeDestroy` and the record's provider kind matches that adapter. The
capability requires immutable allocation identity: a delayed deletion replay must
not affect a later allocation. Docker and E2B opt in. E2B documents a unique
sandbox ID and deletion by that ID in its
[SDK contract](https://e2b.dev/docs/sdk-reference/js-sdk/v2.6.2/sandbox).
This is a provider contract, not evidence of hosted E2B acceptance.

The existing record timestamp is the claim token, so no new migration is needed.
Claiming compares the observed status and timestamp; completion and failure both
compare the exact newly assigned token. A stale worker cannot clear a newer
cleanup claim or a new provisioning record. The two-minute threshold permits
retry; safety comes from the allocation identity and fenced database writes.
Stopping a resumed computer does not have the same guarantee and is not reclaimed.

Three initial PostgreSQL regressions reproduced stuck expired claims. Expanded
coverage passes 20 cases, including a new deletion service resuming account
cleanup, stale success/failure before and after a newer worker completes, and
refusal to reclaim active, uncertain, stop, unsupported, different-provider or
fresh claims. The existing 22 account-deletion cases and 85 focused sandbox unit
cases pass. Contract, adapter and supervisor type/static checks pass.

The real Docker fixture now recreates a running container under the same workspace
identity and name after deleting its predecessor. Replaying deletion of the old
container returns absence and leaves the replacement running. Both disposable
containers are removed. Evidence is under
`test-report/deskazo-v1/checks/provision-cleanup-lease-*`.

Active and uncertain allocations, interrupted stop operations and adapters without
the replay guarantee still need a recovery/inspection flow. Cleanup requires
continued reconciliation, and Docker network teardown remains best effort.
Full V1 acceptance is still incomplete.

## Cleanup after changing sandbox provider

Sandbox stop and deletion now reject references belonging to another provider
before contacting an SDK or network endpoint or changing local state. The shared
guard covers Docker, E2B, Daytona, Box, desktop and fake adapters; the host wrapper
reaches the same checks through its selected concrete adapter. The unavailable
provider already fails closed. Emulators keep their declared provider kind in
both the returned reference and stored allocation, allowing the same guard to
run in offline conformance tests.

Eight new regressions first failed, including a foreign reference with the same
textual ID as an existing allocation. The focused 121-case sandbox suite now
passes. Two new PostgreSQL journeys configure Docker while retaining an E2B
cleanup identity. Both ordinary account cleanup and pending provisioning cleanup
retain their account and remote identity without contacting Docker. Restoring
the matching adapter allows cleanup to finish. The full runs pass 24 account
deletion and 20 provisioning cases, along with adapter types and static checks.

`scripts/guard-sandbox-cleanup.py` applies the same boundary check to each concrete
adapter. It matches the hand-edited Docker example and is idempotent. Evidence is
under `test-report/deskazo-v1/checks/cleanup-provider-kind-*`.

These tests use local providers and controlled SDK/HTTP fixtures. Provider-kind
matching does not identify a credential or endpoint change within the same kind.
Retaining old resources during provisioning across a provider change, recovering
unknown allocations, and live provider erasure remain required audit work. V1
remains incomplete.

## Preserving allocations during provider changes and recovery

An existing allocation reference now requires its matching provider kind during
provisioning. All concrete adapters reject a missing or foreign kind before
dispatch. This rejection has a distinct type so the lifecycle can release its
unused provisioning reservation while retaining the old computer reference.
Restoring the original provider permits another attempt; a known local rejection
does not leave an uncertain remote allocation record.

The Docker/host wrapper reconnects existing computers to their recorded provider.
The host preference selects the provider after lifecycle teardown has cleared the
old reference, or when creating a new computer. Changing that preference alone
therefore preserves an existing computer and its live workspace.

All replacement modes, including Recover, now require successful provider deletion
before clearing the old reference. Previously Recover continued after deletion
failed. A failed attempt retains its reference for retry. A database journey
checks that retry restores the checkpoint captured before the failed teardown.

The initial focused regressions failed ten cases across provider mismatches,
host-preference changes and failed Recover teardown. The final sandbox/lifecycle
unit run passes 206 cases. Real PostgreSQL runs pass 23 provisioning and 24
account-deletion cases. The new database cases retain live files and references
when a running or stopped computer encounters a provider mismatch, release the
unused reservation, and reconnect after restoring the provider. Adapter,
contract, API and worker type checks and targeted static checks pass.

The extended `scripts/guard-sandbox-cleanup.py` applies both cleanup and reconnect
guards. It matches the hand-edited Docker example and leaves formatted files
unchanged on rerun. Evidence is under
`test-report/deskazo-v1/checks/provision-provider-switch-*`.

Provider-instance binding within one kind, automatic cross-cloud migration and
recovery of unknown allocations remain open. Provider calls in these tests use
controlled SDK/HTTP fixtures. This does not establish full V1 acceptance.

## Large account export acceptance

`bash scripts/verify-large-account-export.sh` creates an isolated PostgreSQL
database and runs the authenticated export route against synthetic accounts.
The volume cases are opt-in so routine tests do not generate large archives.

A successful archive exceeds 80 MiB and contains 20,000 messages across 200
database pages. The test parses the response incrementally, checks every message
ID, sequence and multilingual body, validates the completion counts, and matches
the received byte count to Content-Length. Separate cases exceed the 100,000
record cap and the 100 MiB byte cap through accumulated message content. Both
return 413 without a download header, then allow a complete export after the
fixture is reduced. The record cap counts every exported record type, not just
messages.

A concurrent-mutation case deletes the cursor row and every remaining message,
then inserts a new message after the first page. Export still returns all 205
original snapshot messages exactly once. The pre-existing access, credential
exclusion, file integrity, concurrency and edit-snapshot cases also pass. The
final suite passes 11 cases, with testkit types and targeted static checks passing.
Evidence is under `test-report/deskazo-v1/checks/large-account-export-*`.

This verifies local content and limit behavior, not peak memory, disk usage,
hosted proxy timeouts, slow storage, interrupted downloads or concurrent load.
Accounts beyond the existing caps still need an export path. Native device and
Electron acceptance remain open.

The preceding provider-instance investigation confirmed that current records
contain only a provider kind and reference. Binding existing references to the
currently configured credentials would assume ownership without proving it.
Provider-instance binding and an explicit migration path for legacy references
remain open; this phase does not change provider routing.

## Mobile dependency alignment and native launch

The standard mobile check rejected eight Expo packages that were one patch behind
the installed SDK's expected versions. The mobile manifest and lockfile now pin
those expected versions. `expo install --check` and mobile TypeScript pass.
All 254 mobile unit cases across 33 files pass, and Expo exports both iOS and
Android Hermes bundles.

After CocoaPods installation, an unsigned iOS Release build succeeds with Xcode
26.4 for the simulator. The built app was installed and launched in a fresh
iPhone 17 Pro simulator running iOS 26.4. Its process remained alive through the
capture, and visual inspection shows the sign-up form with name, email, password,
sign-up, sign-in and custom-server controls. The temporary simulator was shut
down and deleted; removal was checked against the simulator inventory.

`bash scripts/verify-mobile-readiness.sh` repeats compatibility, types, unit and
bundle checks. `VERIFY_IOS_BUILD=1` additionally installs pods and builds an
existing local Expo iOS prebuild. `bash scripts/capture-ios-launch.sh` captures
that build in a disposable simulator for visual inspection. Evidence is under
`test-report/deskazo-v1/checks/mobile-readiness-*`, including the launch PNG and
binary/screenshot digests.

This proves compilation and initial rendering, not native sign-in, customer
conversations, steering, approvals, notifications or account actions. Android
native compilation, physical devices, signed distribution and clean hosted
builds remain unverified. The capture still shows the old product name. The
branding audit also found Electron user-data paths derived from app metadata;
branding changes remain pending an identity and stored-data migration review.


## Native account interaction and password-sheet repair

A real iOS account flow exposed the current-password field beneath the native
sheet header. The field could not receive the test input, leaving submission
disabled. Automatic scroll content insets move all three fields below the header.
The native flow reproduces the failure before the fix and passes afterward.

The passing Maestro 2.6.1 run uses a fresh iPhone 17 Pro simulator on iOS 26.4 and
the disposable local review server. It verifies custom-server selection, sign-in,
password-confirmation mismatch, password change, sign-out, sign-in with the new
password and session restoration after an app restart. A separate local HTTP
probe rejects the old password with 401 and accepts the new password with 200.
The password mismatch and restored-session screenshots were visually inspected.

The simulator build now uses ad-hoc signing. Disabling signing omitted the
simulator entitlement setup needed by SecureStore during server selection.
Earlier references to an unsigned build describe `CODE_SIGNING_ALLOWED=NO`;
the linked binary still had an ad-hoc signature. Simulator entitlements are
embedded Mach-O sections, so the empty `codesign` entitlement dictionary alone
did not establish whether they were present. The app's credential guards remain
unchanged.

`scripts/verify-ios-flow.sh` repeats the native test in its own disposable
simulator; `apps/mobile/e2e/README.md` documents server setup and cleanup.
The shared sign-in helper also corrects the old smoke flow's initial-screen
assumption. The broader smoke flow has not passed end to end in this phase.

The final account run passes one flow with no failures. Native rebuild, mobile
TypeScript, shell syntax and diff checks pass. Owned simulators and the isolated
server were cleaned up. Evidence is under
`test-report/deskazo-v1/native-interaction-account-r9` and
`test-report/deskazo-v1/checks/native-interaction-*`, with separate binary digests
for the signing correction and the later sheet fix.

This is one simulator account journey with synthetic data. Same-install restart
does not prove reinstall, upgrade, physical-device or distribution behavior.
Light appearance, large Dynamic Type, tablets, Android and broader customer,
approval, provider and notification workflows remain unverified here. Product
branding still requires its separate identity and stored-data migration review.


## Native customer attention and control

The native iOS app now has a repeatable customer conversation acceptance flow in
`apps/mobile/.maestro/customer.yaml`. It opens the customer inbox, reviews the
handoff reason and customer message, acknowledges and assigns the case, saves
private guidance, sends a staff reply, returns control to the agent, takes over
again, and resolves the case. Native control assertions verify that the staff
composer disappears under agent ownership and returns after takeover.

The disposable server's `--customer` mode seeds one synthetic web-channel case.
On shutdown it checks the database for the acknowledgement and assignment,
exactly one saved guidance record, absence of that guidance text from public
messages, exactly one sent staff reply, resolution under staff ownership and
cleared attention timers. The partial second attempt deliberately fails this
state check, while the completed third attempt passes all seven checks and exits
successfully. The native run passes one flow with zero failures in 59 seconds.

The first two attempts identified test selectors that did not account for iOS
combining avatar labels and input placeholders with accessible names. Those
selectors now match the observed native text. No product UI code changed in this
phase. The shared simulator runner also records the tested app binary hash.
Screenshots of the staff reply, agent control and resolved staff case were
visually inspected. Static checks, shell syntax and diff checks pass; all three
temporary simulators and both disposable fixture servers were cleaned up.

Evidence lives in `test-report/deskazo-v1/native-customer-r3` and
`test-report/deskazo-v1/checks/native-customer-*`. The README documents how to run
the flow and require both Maestro and server verification to succeed.

This establishes one happy-path native control journey on an iOS 26.4 simulator
in dark appearance. The channel has automatic replies disabled. It does not
prove model application of guidance, prevention of an already-dispatched send,
real-provider delivery, retry/concurrency behavior, notifications, physical
devices, Android, tablets, light appearance or large Dynamic Type. The privacy
check covers the saved guidance text in conversation messages, not every possible
source of private information. Those acceptance areas remain open.


## Native long-approval navigation

Long native approval reviews now offer "Beginning" and "End" controls above the
bounded scroll area. They appear only when detail exceeds 2,000 characters. This
keeps short cards unchanged while allowing staff to reach the ends of large
reviews without hundreds of swipes. Both controls have minimum 44-by-44-point
touch targets and translated Russian and Chinese labels. The existing selectable
Unicode text chunks and approval actions are preserved.

The baseline native touch search could not reach the final metadata within two
minutes; iOS reported 517 scroll pages for the synthetic review. The new controls
pass a native journey from end to beginning and back to end, followed by denial.
The final iOS 26.4 simulator run passes one flow with zero failures in 40 seconds.
Screenshots visibly show the final source field and closing braces, and the return
to the initial request fields. Both decision controls remain available before denial.

An independent authenticated API check confirms both 99,999-character document
versions, their beginning and ending markers, the saved denial and an unchanged
hash of the complete 207,967-character review before and after the action.
`scripts/verify-native-approval.py` and `apps/mobile/.maestro/approval.yaml` make
these checks repeatable; setup is documented in the mobile E2E README. The final
native rebuild, mobile TypeScript, 15 locale tests, static checks and shell/Python
syntax checks pass. All temporary simulators and review servers were cleaned up.
Evidence is under `test-report/deskazo-v1/native-approval-r3` and
`test-report/deskazo-v1/checks/native-approval-*`.

This replaces the earlier lack of native end reachability evidence with explicit
navigation evidence. It does not prove manual traversal of every scroll page,
selection across chunks, readable before/after comparison, approval execution,
provider writes, maximum escaped payload performance or broader device and
appearance coverage. This phase still used raw JSON; the following phase adds
readable versions. V1 remains incomplete.


## Readable memory and skill approvals

New staff approval cards for native memory and skill learning changes default to
an "After" view, with "Before" and "Request details" controls. Web and Electron
share the web renderer; mobile uses selectable text chunks and the existing
"Beginning" and "End" navigation. The title, private scope, memory path,
conditions, review reason and applicable proposal warnings remain visible above
the content. Empty versions show "Empty". The complete original request remains
available, including source, reason, revisions and other proposal fields.

The shared parser requires an explicit tool marker and the recorded JSON offset,
then validates the stored request. This supports approval-reason prefixes without
guessing where the request starts. Legacy cards, other tools, malformed requests,
secret inputs and deny-only redacted cards keep their existing presentation.
The change does not modify approval actions, stored request bytes or execution.
Three new review labels are translated in all nine web and both mobile catalogs;
`scripts/update-approval-review-locales.py` adds them without changing unrelated
entries, and a second run leaves all eleven catalogs unchanged.

Verification passes 64 focused parser/formatter tests, 15 mobile locale tests,
23 authenticated executor cases, six Chromium journeys, the affected packages'
types, static checks and an ad-hoc iOS simulator build. The browser journeys
compare exact complete Before/After text, navigate to each end and beginning,
retain the full request across reload, and exercise stop controls at 390 and
1280 pixels. The executor cases cover approval, denial, stale versions,
substitution, retry ordering and escaped content.

The final native journey passes with zero failures in 53 seconds on iOS 26.4.
It scrolls the conversation to inspect the approval context, opens and dismisses
the heading's message menu, then visits both
99,999-character versions, their visible endings, the raw request's beginning
and end, and denies the request. Screenshots confirm the content is painted.
An authenticated API check confirms the saved denial and an unchanged hash of
the full 207,967-character request. Both the installed executable and JavaScript bundle match the final build, with
hashes retained. The runner now records and compares both files automatically.
The first native attempt failed because the test expected the title within the
initial bottom-aligned viewport; the second explicitly verifies outer scrolling.
A final source check also restored the heading's long-press and accessibility
message actions. The final native flow includes that regression check. All three
temporary simulators and both fixture servers were cleaned up.

Reproduce the offline checks with `bash scripts/verify-readable-approval.sh` and
the native flow documented in `apps/mobile/e2e/README.md`. Evidence is under
`test-report/deskazo-v1/readable-approval-web`, `readable-approval-native-r3` and
`checks/readable-approval-*`.

The native card can exceed the viewport, so its context requires scrolling up
from the latest message bottom. These views expose complete versions rather
than highlighting semantic differences. They do not establish comprehension of
large changes, native Allow execution, VoiceOver, large Dynamic Type, physical
devices, Android or Electron runtime acceptance. V1 remains incomplete.


## Space-member execution revocation checkpoint

Removing a Space membership, including through the authenticated organization-leave
route, now cancels that member's active runs and running attempts, cancels their
tasks, clears leases, and pauses active routines in the same database transaction.
Other members and other Spaces retain their work. History, terminal outcomes and
external-effect receipts remain intact. Rejoining does not resume cancelled work.
New runs and routine activation lock the current membership until commit, so work
created concurrently with removal is either cancelled or rejected. The migration
also retires existing orphan work and adds member-scoped indexes before backfill.

The executor checks its current lease at tool entry, after asynchronous approval
preparation, and after claiming an effect. Real callback regressions reproduced
fake connector writes after removal during model work, effect creation and effect
claiming; all three now stop before dispatch. A claimed receipt remains retained
for conservative recovery. These checks do not recall already-dispatched work.

Verification passed 27 executor lifecycle tests, four PostgreSQL migration/race
cases, 23 document-approval journeys, 27 account-deletion cases and 147 focused
executor/approval unit tests, plus three package type checks. The database cases
observe actual blocking in both insertion/removal orders and verify the intended
indexes through query plans in a Space with 10,000 additional members. Reproduce
with `bash scripts/verify-member-revocation.sh`; retained results are under
`test-report/deskazo-v1/checks/member-revocation-*`.

This proves the covered run/routine and generic connector paths. Built-in provider,
customer-send, computer and cloud-agent dispatch after their own asynchronous
preparation still need audit. Other provider streams, screens, downloaded resources, shared credentials and
eventual data erasure remain open; authenticated thread streams are covered below. The test fixture does
not establish production migration duration or immediate remote cancellation.


## Authenticated thread stream revocation checkpoint

An open thread subscription now binds the exact session that authenticated it.
Before each event delivery, the API rechecks the session's existence and expiry,
current Space membership, pending account deletion, and the original bot/group
and thread ownership and archive state. A separate valid session or another Space
keeps its own access. Revoked callers cannot reconnect while access is absent.
The same check runs on the existing catch-up loop, so a quiet unauthorized stream
closes on its next notification or the 30-second periodic catch-up. No extra timer
or access cache was added. A failure releases the realtime subscription.

Before the fix, authenticated API regressions delivered a newly committed private
event after membership removal and after sign-out. Final coverage passes 28 stream
cases using both in-memory and real PostgreSQL notifications, including bot/group
conversations, session expiry, archiving, removal during the event query, another
session/Space retaining access, an empty catch-up wake, and native bearer auth.
Fifteen authorization cases, a real PostgreSQL listener disconnect/reconnect case,
and 77 event/router/realtime/client-subscription unit cases also pass. Three package
type checks and six-file static checks pass. Reproduce with
`bash scripts/verify-stream-revocation.sh`; retained results are under
`test-report/deskazo-v1/checks/stream-revocation-*`.

The idle timeout is tested with a shortened interval in the event-generator unit
case; the API quiet-stream case explicitly wakes catch-up without a new event.
These checks do not establish production stream load, revoke data already sent or
buffered in the transport, or cover computer screens/control, ordinary downloads,
provider streams, or other long-lived sessions. Events remain stored under the
existing retention policy. Built-in provider execution revocation and complete V1
acceptance remain open.


## Proxied computer-screen revocation checkpoint

HTTP(S) screen capabilities now bind the issuing session, Space, user, and exact
membership record as well as the existing bot/computer generations and control
lease. Issuance checks the live session and membership. Target resolution checks
them again, including session expiry and pending account deletion, before serving
assets or opening a WebSocket. Signing out revokes that session's links while
another valid session retains its own. Leaving and rejoining does not revive old
links. Capabilities issued before these identity fields existed are rejected;
clients must request a new screen URL.

The existing proxy authorization watcher also closes active HTTP/WebSocket
streams when a subsequent check denies access. It checks every second and bounds
the authority request at two seconds. This is periodic revocation, with scheduling,
in-flight requests and network buffers contributing delay. It cannot retract
screen data already delivered or input already forwarded.

Ten real PostgreSQL/API cases cover view/control links across membership removal,
sign-out, expiry, rejoin and separate-session access. Four Chromium cases exercise
the real API and Vite proxy with synthetic screen upstreams: replay returns 403,
the browser socket closes, and the upstream socket closes after removal/sign-out.
Eight existing development/preview browser isolation cases, three related
computer/takeover journeys and 66 focused unit cases also pass. Four package type
checks and ten-file static checks pass. Reproduce with
`bash scripts/verify-screen-revocation.sh`; evidence is under
`test-report/deskazo-v1/checks/screen-revocation-*`.

This covers proxied HTTP(S) screens. Native desktop screen transport, other
resources/provider operations, production load and live sandbox-provider
acceptance remain open. No hosted deployment or real provider account was changed.


## Computer dispatch after revocation checkpoint

Computer observation/input and page-browser navigation/snapshot/input now recheck
the current run lease after their asynchronous teaching-session lookup. Removing
Space membership, stopping the run, or replacing the worker's lease during that
lookup prevents the pending provider call. The existing lease check aborts the
worker and preserves the database's cancellation or replacement state.

The corrected baseline reproduced all five provider calls after membership had
been removed. Twenty PostgreSQL executor cases now cover those five tools with
an active membership, removed membership, authenticated Stop, and replaced lease.
They check the database state before dispatch and provider call counts afterward.
All 47 lifecycle cases, 167 related unit cases, two package type checks and the
two-file static check pass. Browser results are synthetic and computer operations
use the fake sandbox; these are offline dispatch tests, not live-provider acceptance.
Reproduce with `bash scripts/verify-computer-dispatch.sh`; retained evidence is
under `test-report/deskazo-v1/checks/computer-dispatch-*`.

This closes the asynchronous teaching-lookup gap. It does not recall operations
already dispatched or make database authorization and remote dispatch atomic.
Other asynchronous provider preparation paths, native desktop transport and full
V1 provider acceptance remain open. No hosted service or real customer data was
changed.


## Cloud-agent cleanup during account deletion

Account deletion now fences active cloud-agent intents and retains the account
and cleanup identities until known remote work reaches a terminal state. The
worker removes undispatched intents and terminal local records, cancels running
remote work, and only then continues credential, bot and account cleanup. Active
poll leases defer cleanup; version checks preserve cancellation across late
provider responses. The API and worker use their existing bound cloud provider.
A new database guard rejects cloud records after the deletion request, and
transactional owner checks prevent new launch/follow-up intents during deletion.
The user index supports bounded cleanup batches.

For a launch with a lost response, revoked work now uses optional read-only
recovery by the original idempotency key. Cursor and the offline emulator support
this contract. Cleanup never retries a create merely to discover its identity.
An unsupported recovery, unobservable launch, missing original credential binding
or failed provider call retains the records and reports cleanup failure. A
provider still cancelling or a worker still holding its lease remains pending.
Lost follow-up responses are reconciled and cancelled without resending the reply.
Normal, still-authorized launch recovery retains its existing idempotent replay.

The baseline reproduced eight failures: cloud records survived local account
erasure and cancellation failures did not delay deletion. The final checks pass
36 account-cleanup cases, 20 cloud lifecycle cases, three authenticated deletion
cases and 74 unit cases. Five package type checks and twelve-file static checks
pass. Reproduce with `bash scripts/verify-cloud-account-cleanup.sh`; retained logs
are under `test-report/deskazo-v1/checks/cloud-account-*`.

This proves active-run cancellation and local record cleanup with PostgreSQL and
synthetic providers. It does not erase agent history, prompts or artifacts retained
by the external cloud provider, nor prove live provider cancellation. Missing or
changed credentials and unobservable launches can require operator intervention.
Previously orphaned records from already-erased accounts and cloud-agent export
coverage need separate review. No hosted deployment changed; full V1 remains open.


## Cloud-agent export and legacy orphan cleanup

Account exports now include the owner's cloud-agent work in their current Spaces,
including records retained after the original bot or thread was deleted. The
export contains task/result identity, status, links, pending cancellation and
supported prompt, repository and image fields. Explicit column and JSON-field
selections exclude credential bindings, leases, operation keys and arbitrary
legacy request configuration. User-authored content and permitted URLs remain
unredacted, as the export manifest already explains. External images are not fetched.
Cloud records are read one at a time because a request can contain several large
image payloads; the existing complete-before-download and archive limits apply.

The cloud reconciler now removes safe legacy records only when their user no
longer exists. Missing membership, bot or chat alone does not authorize erasure.
It deletes at most 100 records per pass, skips locked rows and active poll leases,
and can remove undispatched or confirmed-terminal local records without a provider.
Running and ambiguous remote work retains its identity. With the original provider
binding available, existing recovery cancels it; a later pass removes terminal
local records. Unobservable launches are retained without repeating creation.

The baseline omitted all 205 seeded owned export records and failed five orphan
cleanup cases. Final checks pass twelve export cases with large archives enabled,
28 cloud lifecycle cases and 36 account-cleanup cases. The new coverage includes
205-record export pagination, neighbor isolation, field filtering, 205-record cleanup
batches, a concurrent row lock, active leases, and accepted/lost/uncertain launches.
Three package type checks and four-file static checks pass. Reproduce with
`bash scripts/verify-cloud-ownership.sh`; evidence is under
`test-report/deskazo-v1/checks/cloud-ownership-*`.

Per-record export queries and orphan-scan cost still need production-scale acceptance;
the deletion limit does not bound the scan. Signed URLs or secrets deliberately
included in user content may appear in an export. Local cleanup does not erase
provider-retained history, and missing bindings or unresolved remote outcomes can
retain orphan recovery records indefinitely. No hosted data was changed. Full V1
and live-provider acceptance remain open.

## Broad offline regression checkpoint

The broad unit run exposed seven stale test failures after the accumulated V1
changes. Skill precedence tests now provide the empty learning-history lookup
required by removal. Skill approval tests assert that a full 100,000-character
review remains visible, while oversized or redacted reviews remain deny-only.
The memory rollback fixture now constructs a minimal invalid foreign-key insert,
avoiding incompatible Prisma relation inputs while preserving the real database
rollback and retry assertions. These repairs change tests only.

The default integration selection now includes five previously omitted offline
PostgreSQL suites for computer provisioning, Instagram comment provenance,
Instagram gateway admission, knowledge persistence, and connector rate limits.
This makes those checks part of future `pnpm test:integration` runs.

Verification passed 4,677 unit tests, ten shared package type checks, mobile type
checking, and four-file static checks. The original 47 integration suites passed
880 tests; the five added suites passed another 83 tests when run individually
with `pnpm test:integration --spec=<file>`. The combined 52-suite command was not
rerun. Three opt-in large-export integration cases remain skipped by default and
passed in the preceding cloud-ownership phase. The unit run also reports 997
skips; these are not validation of their skipped behavior. An initial unsupported
comma-separated `--spec` attempt ran no tests and supplies no evidence.

Evidence is retained under `test-report/deskazo-v1/checks/v1-regression-*`.
This checkpoint covers deterministic offline checks, not live-provider acceptance,
physical-device behavior, maximum-size approval rendering performance, or hosted
recovery and production load. No hosted data changed. Full V1 remains open.

## Customer work after membership removal

Removing a channel owner's Space membership now disables their customer channels
in the same database transaction. This also applies to organization-membership
cascades and membership identity changes. Poll leases are revoked, conversation
generations advance, reminders stop, and queued or processing customer/staff
messages are cancelled. Existing leases, dispatched sends, delivered messages,
failed outcomes and receipts remain available for outcome recording and review.
A later rejoin does not revive the old execution or automatically enable replies.
Other owners and other Spaces remain unchanged.

New enabled channels and later activation require a locked current membership.
The guard skips incompatible membership locks to reject activation while removal
is in progress, avoiding a reproduced channel/membership lock cycle. A conflicting
strong lock on otherwise valid membership can therefore require the caller to
retry. The migration also retires legacy orphan channels without deleting history.

The initial reproduction had three failures and one active-member control pass:
website execution tokens remained usable after removal/rejoin, and a queued staff
reply was sent. The final affected checks pass 154 PostgreSQL tests across six
suites, three package type checks and four-file static checks. They include real
row-lock races, orphan backfill, neighbor isolation, organization cascades, channel
reactivation, customer callbacks, website behavior, and account cleanup. Two
fixture corrections were needed: organization removal must leave another member,
and a channel's replacement owner must actually belong to that Space. PostgreSQL
already creates default-Space membership when an organization member is added.

Reproduce with `bash scripts/verify-customer-membership.sh`. Its constituent
commands completed across the initial run and corrected cleanup run; the entire
script was not rerun after the final test-fixture correction. Evidence is under
`test-report/deskazo-v1/checks/customer-membership-*`.

This prevents new use of revoked customer execution authority. It cannot retract
requests already accepted by external providers. Large-channel migration and
membership-removal latency still need production-scale validation. No hosted
migration or customer action was performed. Full V1 acceptance remains open.

## Practice customer situations before enabling replies

Staff can now call `customer_preview` with a sample message before enabling a
real channel. It runs the current customer processor with approved voice,
customer knowledge, escalation assessment and configured public read-only
workflows. The result includes the sample reply or handoff, behavior revision,
assessment and action outcomes. Customer-specific reads, business writes and
raw connector actions are unavailable. A preview sends no customer messages or
staff alerts and supplies no continued-learning evidence.

Practice runs use private temporary channels excluded from customer inboxes,
activity and ordinary background processing. The backend deletes their local
records after returning the result or an error. Reconciliation removes records
left by a crashed worker after five minutes, up to 100 per pass. Stopping the
staff run aborts the request and discards late results. Membership removal,
including removal followed by rejoining, and behavior changes invalidate the
result. A real channel's enabled state remains unchanged.

Ten focused PostgreSQL cases pass. The full customer-conversation, website and
continued-learning suites pass 179 cases, followed by 4,677 unit tests, seven
package type checks and static checks of twelve files. The unit suite reports
1,017 skipped tests, which do not validate their skipped behavior. Its initial
failure came from a connection-list mock that did not evaluate the new provider
exclusion filter. The corrected test also verifies that practice channels are
hidden while real channel metadata remains visible. Initial preview fixtures
needed the designated brand-voice key and explicitly published knowledge.

Reproduce with `bash scripts/verify-customer-preview.sh`. The initial run passed
all three PostgreSQL suites, then stopped at the unit mock failure. The corrected
unit suite and remaining checks passed separately; the whole script was not
rerun. Evidence is under `test-report/deskazo-v1/checks/customer-preview-*`.

Samples and returned results remain in the staff conversation. Configured model,
assessment, knowledge and public read providers can receive data and consume
quota; local cleanup does not erase provider retention or recall completed
reads. Read-only guarantees rely on correct provider metadata and behavior.
Crash cleanup depends on reconciliation availability. Live staff-agent setup,
provider delivery, merchant checkout and physical-device acceptance remain open.
No hosted data changed. Full V1 remains in progress.

## Merchant setup in the staff conversation

New staff conversations offer Customer replies, Products & policies, and My
brand voice. Selecting a task asks for the missing business context before
suggesting accounts or making external calls. Existing saved choices retain
their prior behavior. The backend accepts only an option on the exact pending
card and commits the answer, follow-up question and events together. Staff runs
with customer tools receive guidance to inspect existing setup, review authorized
voice and knowledge, try customer previews, and request approval before enabling
replies. That guidance does not establish model compliance or live activation.

Native threads now render these choices using the existing answer controls,
including dismissal, retry after a failed save, and persisted selection. Before
this change they requested choice messages but did not render their controls.
The shared native answer controls now have button semantics and a minimum
48-point touch target.

Final verification passes 4,688 unit tests, including 14 focused API/mobile cases,
four package type checks and ten-file static checks. The unit run reports 1,017
skips. Eleven affected browser cases pass across the final constituent runs,
covering all three choices at desktop and narrow widths, reload, dismissal,
retry, and message actions. The iPhone 17 Pro simulator flow passes selection
and relaunch with the saved answer inside the reopened conversation. The iOS
build and Android bundle also pass. These checks use synthetic local accounts.

The retained failures matter: review found and tests reproduced cross-generation
choice IDs being accepted; the backend now rejects them. Browser helpers needed
scoped selectors and explicit menu-open observation before Escape. Native flows
needed the current quick-create path and the bot-prefixed accessibility label.
One passing native attempt matched an inbox preview, so it was not accepted as
proof of reopening the conversation. A subsequent attempt stopped during the
launch animation without an app crash report; the final isolated flow waits for
that animation and checks the reopened thread explicitly. Repeated startup under
load is not established by that pass.

Run `bash scripts/verify-merchant-onboarding.sh` for the unit, type, static and
browser checks. Native instructions are in `apps/mobile/e2e/README.md`. The
verification script's commands completed across the initial run and focused
corrections; the entire wrapper was not rerun. Evidence is retained under
`test-report/deskazo-v1/checks/merchant-onboarding-*`, with web and native captures
in the corresponding report directories. Disposable databases and simulators
were removed. Live model-led setup through merchant authorization and activation,
Android/iPad runtime checks and physical-device acceptance remain open. No hosted
data changed. Full V1 remains in progress.

## Deskazo display name and installation identity

Application copy, sign-in screens, translated catalogs, customer/staff messages,
email templates, browser manifests, native app labels, desktop setup and release
artifacts now use Deskazo. The public website and installer messages use the same
name. The welcome screen scales its wordmark and text at narrow widths; browser
checks reproduced clipping at 390 pixels before that correction.

Existing wire names, server addresses, package and bundle IDs, URI schemes,
secure-storage keys, desktop partitions and deployment variables retain their
identities. Desktop startup explicitly keeps its internal runtime name and
profile directory while menus, windows and packaging use Deskazo. This preserves
the names Electron uses for existing profiles and OS keys; the filesystem test
proves saved setup and opaque cookie files remain reachable, not that a signed
upgrade decrypts real cookies. See Electron's [keychain identity discussion](https://github.com/electron/electron/issues/40430).
The iOS project is generated from the renamed app configuration. Prior generated
project files were retained locally before regeneration. The old and new builds
have matching bundle IDs and URL handlers.

The repeatable copy migration is `scripts/rename-product-display.py`, checked
against a manually edited HTML page before applying it. Its check mode reports
remaining eligible replacements. An initial mixed-case repository URL fixture
was incorrectly rewritten; URL preservation and the restored fixture are now
covered by the passing regression run. Historical documentation, repository
addresses and technical names remain distinct from the display name.

Verification so far: 4,689 unit tests pass with 1,017 skips, seven package checks
pass, and the final web check/build pass. Six browser cases cover names, saved
preferences, logout and password recovery; four further cases cover the corrected
welcome screen in English and Russian at wide/narrow sizes. Two marketing cases,
the installer smoke check, Android bundle export, iOS simulator compilation and
unsigned macOS packaging pass. The package contains the final built web index.
Customer component metadata retains its wire type and parses as valid Python;
this is not a new live Langflow runtime check. Marketing's first Playwright start
stopped when Astro daemonized; the verified daemon was reused and then stopped.

Run `bash scripts/verify-product-name.sh` for core regression and browser checks.
Mobile upgrade instructions are in `apps/mobile/e2e/README.md`. Evidence is under
`test-report/deskazo-v1/checks/product-name-*`. The wrapper has not been executed
as one run; its constituent commands have passed. Signed desktop keychain and
updater continuity, Android native runtime, App Store upgrades and real-device
acceptance remain open. No release was published or hosted service changed.

The corrected two-stage iPhone simulator upgrade also passes. It signs in on the
previous Rakazo binary using the test server, installs the new Deskazo binary
without uninstalling, and opens the authenticated conversation without entering
credentials again. Executable and JavaScript bundle comparisons confirm both
installed builds match their source artifacts. The final screenshot is inside
the reopened conversation, rather than an inbox preview. The initial native
attempt failed only because an exact text selector excluded the grouped inbox
accessibility label; its failed report is retained. This proves that local
simulator session/server settings survived this pair of builds. It does not
prove signed distribution or physical-device keychain continuity.

## Android native acceptance

The arm64 Android release build now compiles from the current Expo configuration.
The first build generated a new ignored native project and completed 957 Gradle
tasks. Compiled metadata confirms the Deskazo label, existing `com.rakazo.app`
identity and embedded arm64 code. The local review manifest allows HTTP for the
fixture and disables OTA updates so downloaded code cannot replace the bundle
under test. This APK is for disposable review devices, not distribution.

`scripts/build-android-review.sh` contains the build recipe; the manual Android
screenshot workflow reuses it with x86_64 and includes it in the APK cache key.
That remote workflow has not run for these changes. Subsequent local builds can
reuse the ignored generated native tree.

`scripts/verify-android-flow.sh` creates a unique headless emulator, verifies its
name before installing, compares installed APK bytes with the built APK, and
removes its own AVD afterward. It requires a fresh report directory for each
attempt. The first onboarding run stopped at Android's notification permission
dialog despite the launch permission setting. The shared sign-in flow now
dismisses that optional system dialog. The retry passes merchant choice,
follow-up and relaunch assertions. Its final screenshot shows the saved answer
and question inside the reopened conversation.

Reproduction instructions are in `apps/mobile/e2e/README.md`; retained attempts
are under `test-report/deskazo-v1/android-native-*`. This does not close
physical-device, tablet, signed-upgrade, live-provider or full V1 acceptance.

Customer control passes the Android UI journey for acknowledgement, assignment,
private guidance, one staff reply, agent handback, takeover and resolution.
All seven database assertions pass after the flow: acknowledgement, assignment,
one saved guidance entry, guidance excluded from customer messages, exactly one
sent staff reply, resolution under staff control and cleared attention alerts.
The controlled server shutdown returned interrupt status 130; its verification
message and state JSON establish the checks separately from that wrapper status.
Long approval review also passes. Two retained attempts exposed iOS-only test assumptions:
Android dismisses the native message menu with Back, and its conversation scroll
can place the version tabs above the viewport. The shared flow now handles both.
Inspected screenshots show document endings, the complete request's final source
field and the denied state. The API verifies both 99,999-character document
versions and an unchanged review hash after denial. Approval execution and real
provider writes were not exercised.

Account recovery passes on a fresh fixture after two retained test failures. The
original numeric selector tapped the account row behind Android's password sheet;
the test now targets the submit control below the confirmation field. Android
also displayed its notification prompt again after the new-password sign-in, so
the flow handles that optional prompt there as well. The final run checks the
mismatch error, successful update, sign-out, new-password sign-in and restored
session after relaunch. The final shared flow changes have not been rerun on iOS.

Four Android journeys pass on the API 36 Google Play arm64 emulator. All nine
attempts retain their results, and each installed APK matches the built bytes.
All owned AVDs and disposable databases were removed; the existing devices and
four persistent containers remain. The aggregate evidence is
`test-report/deskazo-v1/checks/android-native-verification.json`, with customer
state and approval hashes in adjacent `android-native-*` files. Shell syntax,
report-directory rejection checks and diff whitespace checks pass. The broader
unit suite was not rerun for these test/script changes. Remote screenshot CI,
other Android versions, physical-device behavior, signed upgrades and live
merchant delivery remain open. No hosted service or customer account changed.

The clipped system-bar glyphs in some initial captures were subsequently
reproduced in Android Settings before Deskazo launched. Direct ADB screenshots
also contain the clipping. On this fresh API 36 image, the system status-bar window
requests 63 pixels while the camera cutout has a 128-pixel top inset. Rotating
Settings and returning to portrait refreshes the window to 128 pixels. The same
APK then renders complete glyphs in Settings and Deskazo, with the cutout retained.
This isolates the observed issue to emulator system-UI initialization rather than
a Deskazo layout change or a Maestro-only screenshot problem.

The owned-emulator runner now performs that reset and requires its window geometry
to pass before starting an app flow. `scripts/verify-android-system-bars.py`
rejects the original mismatch and accepts the corrected window. The offline
`system-bars.yaml` flow compares Settings and Deskazo before/after keyboard use
and app relaunch. The integrated preflight and comparison pass with matching
initial/final geometry. The original password recovery flow also passes after
preparation, including the mismatch form and relaunch. Its screenshots and direct
ADB capture show complete glyphs, and final geometry remains 128 pixels.
`ANDROID_SYSTEM_BAR_RESET=0` exists only to reproduce the emulator issue and does
not establish visual acceptance. Results are under
`test-report/deskazo-v1/android-system-bars-*`. No app rendering code changed.
These checks target the selected portrait emulator and do not prove all pixels,
other system images, physical devices or complete Android visual acceptance.

All six diagnostic attempts retain their evidence, including the initial wrong
relaunch expectation and rejected orientation command. The geometry verifier
rejects the captured 63-pixel baseline and accepts the corrected runs. Shell and
Python syntax checks pass. Owned emulators and the synthetic account database
were removed, with the original devices and persistent services preserved. The
fixture's exit 130 records its controlled interrupt. Reproduction instructions
and the distinction between diagnostic opt-out and acceptance are in the mobile
E2E README. No hosted service or real account changed.

## Staff preparation before customer activation

The backend already supported preparing customer behavior with an operator-managed
runtime and the staff agent's selected model. The staff tool catalog did not expose
that operation, so conversational setup instead required the custom runtime's
service connection details. `customer_initialize` now exposes the existing operation
with mandatory one-time approval. The onboarding instructions direct staff to it
before private samples and reserve `customer_configure` for custom services and
business workflows. Operator setup is still required when the managed service is
missing; this change does not install that service.

Preparation creates no customer channel, enables no replies and preserves existing
behavior. Runtime keys stay in encrypted operator settings. Approved public
instructions can then be customized and exercised through `customer_preview`.
The approval explains preparation and says enabling replies is a separate step.

`bash scripts/verify-customer-preparation.sh` checks the approval gate, customer
database behavior, types and formatting. The final unit run passes 147 cases,
including explicit approval despite an allow rule and a resumed execution that
reuses its result on retry. The PostgreSQL suite passes 124 cases, including a new
staff agent with no channel or named secrets, customized instructions, private
practice without sends or notifications, and preservation on repeat initialization.
Core and adapter type checks, formatting, shell syntax and diff whitespace pass.
External runtimes and models in these tests are synthetic. These checks do not
establish live model-led setup, Langflow publication or merchant delivery.

Independent review found that the existing behavior-publication path could save
a result after caller cancellation or Space membership removal. Initialization,
configuration and instruction updates now pass cancellation to the runtime and
reject a late result. Publication captures the original membership record and
locks/rechecks authorization before saving; removal followed by rejoining does
not revive the operation. Nine deterministic race cases failed before the fix
and pass afterward. A remote runtime that ignores cancellation may retain an
unused flow, but Deskazo does not activate it. A cancellation arriving after the
final transaction check may be too late to prevent that transaction's commit.

A read-only hosted connector preflight found configured LINE and Instagram
connections, but no configured store or Google Sheets connection from the selected
shortlist. Catalog and configuration counts establish neither authorization health
nor provider acceptance. Real-provider onboarding, purchase and other V1 acceptance
journeys remain open. No hosted configuration or real customer account changed.

## Customer setup through the installed runtime

The opt-in `customer-setup-langflow.postgres.test.ts` now exercises the real
application, Pi executor, disposable PostgreSQL, installed local Langflow and
model bridge together. A new staff agent requests managed preparation, waits for
owner approval, privately practices with approved synthetic voice and shipping
policy, and requests separate approval to enable a website channel. Assertions
check that behavior and channels do not exist before their respective approvals.
No named runtime secret is created for the staff agent.

The practice result reaches the staff conversation. After activation, a synthetic
website visitor receives the reply through the public visitor API. Sending the
same nonce twice produces one stored customer message and one reply. The customer
model request contains the approved policy and voice, excludes the private staff
sentinel and runtime key, and never exposes that runtime key in staff history.
These are checks for the supplied fixture values, not a general privacy proof.

The first attempt failed because the scripted staff reply omitted the practice
text that the test expected in history. The corrected test asserts the actual
tool result before displaying it. The expanded delivery journey and final wrapper
pass. `scripts/verify-customer-setup.sh` keeps each attempt in a fresh report
directory, checks the new test and its imports with TypeScript, and checks formatting.
The final report is under `test-report/deskazo-v1/checks/customer-setup-runtime-final`.
Runtime flow and temporary API-key deletion are verified by readback; the app,
callback server, model fixture and disposable database are stopped afterward.

The installed runtime is real, but model decisions and replies are scripted and
approved knowledge is seeded. This does not establish live model-led merchant
setup, provider authorization, social delivery, product/stock freshness, purchases,
or model answer quality. It covers successful execution and normal cleanup, not
crashes or an unresponsive runtime. The callback listener accepts only the
production routes protected by execution tokens. The Mac remains locked, so no
interactive browser or native acceptance is claimed. No production code changed
in this verification step, and no hosted service or real customer account changed.


## Docker command directory normalization

The Docker adapter now validates command directories after removing its virtual
workspace prefix, matching the Box and E2B adapters. Previously, prefixed paths
containing parent segments reached the supervisor; the adapter now rejects them
before making the request. Six new cases cover rejection and valid-directory
behavior. All 68 targeted adapter tests, the adapter package typecheck including
the changed test file, and formatting checks pass. This is an adapter validation
fix, not evidence of a host or cross-account escape.

Natural-model customer setup remains unverified. The inspected model configuration
had no usable API key, and its loopback endpoint was unavailable; no new live-model
run occurred. A model connection has been requested. Customer-runtime publication
cleanup also remains incomplete: failed, superseded or deleted configurations can
leave remote definitions. Cleanup must distinguish unused publications from an
uncertain commit or an in-flight active revision.

## Recoverable customer-runtime publication identity

The customer runtime now receives its publication ID before dispatch. The Langflow
adapter creates that exact private flow and rejects an unexpected returned ID.
It also exposes guarded removal that verifies the flow ID, staff marker and protocol
marker before deleting, treats a missing flow as already removed, and preserves
failed or merely accepted deletion attempts as errors. Neither operation dispatches
when its signal is already cancelled.

`scripts/verify-customer-publication.sh` runs 26 deterministic unit cases, a real
local Langflow conformance test, both affected package typechecks and formatting.
The real test discards a successful create response, retrieves the flow by its
preallocated ID, proves a repeated create cannot overwrite it, refuses a different
staff marker, removes the matching flow, and repeats removal after absence. Its
temporary API key is removed and checked afterward. The existing real application,
PostgreSQL and local Langflow customer-setup journey also passes with the new ID.
The model in that journey remains scripted. All 124 customer-conversation
integration cases also pass, including cancellation and membership-revocation
checks. Malformed cleanup metadata produces a generic error rather than exposing
the upstream response.

This is a prerequisite for durable cleanup, not completed automatic recovery.
The metadata check and deletion are separate requests in a trusted Langflow
tenant, not an atomic guard against another credential holder changing the flow.
The caller does not yet persist a publication receipt, and no production path calls
the removal operation. Interrupted, superseded and deleted configurations can
still leave unused flows. Durable adoption and execution fences, encrypted recovery
credentials, worker reconciliation and deletion integration remain to implement.
An absent flow immediately after a network timeout is not proof that remote
creation cannot complete later; the conformance test covers a response lost after
creation, not a delayed server commit. Reports are under
`test-report/deskazo-v1/checks/runtime-publication`.

## Durable cleanup for tracked customer publications

New publications now persist their identity and encrypted runtime cleanup access
before dispatch. The provider awaits durable admission immediately before create;
publication adoption commits with the selected behavior. A failed finalizer cannot
remove a committed adoption. Cleanup records survive bot and Space deletion, while
account deletion retains the user until these records are resolved.

Background recovery checks that a flow is not selected by any behavior, waits for
its reply-use lease, and claims cleanup before contacting the runtime. Replies
record a 90-second lease before the existing 60-second request to the component,
whose own execution limit is 55 seconds. Cleanup persists the observation of an
existing flow before deleting it, so a lost deletion response can be reconciled
from absence. An absent uncertain create remains tracked for a later appearance.
Each pass handles at most ten concurrent requests with 30-second request signals.

Verification covers 13 new PostgreSQL recovery cases, 124 customer-conversation
cases, 36 account-deletion cases and 28 runtime unit cases. The cancellation and
membership-revocation cases now assert that rejected publications retain confirmed
cleanup records. The installed local Langflow conformance test passes. The full
application setup journey, using a scripted model and disposable PostgreSQL,
now also deletes its bot through the application API, verifies that the runtime
flow remains during its lease, expires that database lease explicitly, and checks
that reconciliation removes both the remote flow and its local record. A direct
authenticated runtime read returns 404 afterward. This tests lease decisions, not
a 90-second wall-clock wait or a live model's answers.

The first recovery-suite failure was an assertion expecting unrelated messaging
profile fields. The first expanded setup run placed cleanup assertions inside the
setup helper before the behavior existed. Both test mistakes were corrected and
the affected suites rerun successfully. The initial typecheck also caught a nullable
ID captured by a closure; the ID is now narrowed before the transaction callback.
All five affected package typechecks and the 13-file formatting check pass.
The full wrapper stopped at the setup-test failure; its preceding suites passed,
and the corrected setup, typechecks and formatting were then run separately.
`scripts/verify-customer-publication.sh` reproduces these checks sequentially.
Evidence is under `test-report/deskazo-v1/checks/durable-publications`.

Coverage remains limited to publications created with the new tracking protocol.
Older behaviors and orphan flows are not inventoried or automatically removed.
Unresolved creation or permanently revoked cleanup credentials require operator
investigation and can keep account deletion pending. Remote metadata validation
and deletion remain separate API calls within a trusted runtime tenant. The lease
safety argument depends on the enforced execution bounds and unique, never-reused
publication IDs. No hosted deployment or live-provider acceptance is claimed.

## Restoring customer-runtime cleanup credentials

New Langflow publications now save the runtime account identity with encrypted
cleanup access before dispatch. Admission compares the original ciphertext, so a
concurrent credential repair cannot be overwritten. Langflow API keys must be able
to read `users/whoami`; failure stops publication before the create request.

The operator settings command now accepts `customer-runtime-cleanup` and replacement
endpoint/key JSON through stdin. It considers all receipts on the same endpoint,
including active receipts. A matching recorded account identity permits replacement;
otherwise it requires a positive read of the exact flow with matching staff and
protocol markers. The latter is an operator trust rule and also permits privileged
runtime administrators. Absence alone cannot authorize repair under another account.
Each replacement compares the previous ciphertext and preserves confirmation,
publication state, active behavior and leases. It updates only encrypted cleanup
access and retry time, returning counts without secrets or provider diagnostics.

Verification passes 26 PostgreSQL publication cases, 124 customer-conversation
cases, 36 account-deletion cases, 30 runtime unit cases and one installed-Langflow
conformance case. Cases cover revoked keys, mismatched accounts,
older records without identity, confirmed versus uncertain absence, active replies,
endpoint mismatch, concurrent repairs and publication admission failure. The real
application journey verifies the saved account identity, removes its bot, revokes
the original runtime key, observes cleanup remain pending, then invokes the actual
operator CLI with a replacement key. Ordinary reconciliation removes the flow and
receipt, and an authenticated read returns 404. This journey uses a scripted model
and explicitly expires the recorded reply lease; it is not live-model acceptance
or a wall-clock lease test. Temporary test keys are removed with readback checks.

Five affected package typechecks, the setup test's explicit typecheck and the
14-file formatting check pass. Checks ran individually; the complete publication
wrapper was not rerun in this phase. Its formatting targets now include the operator
command. Evidence is under
`test-report/deskazo-v1/checks/publication-credentials`.

Repair changes cleanup credentials only. Execution settings and provider key
revocation remain separate operations. Missing flows without a matching recorded
identity remain unverified, and uncertain creates remain tracked after repair.
Older untracked flows still require inventory and operator handling. The command's
identity and flow reads are point-in-time checks, and concurrent new records may
need another pass. V1 live-provider acceptance and hosted deployment remain open.

## Native connector candidate verification

The prepared AMD64 connector image now passes the runtime check on a native
AMD64 Linux host. The archive checksum matches the retained build artifact, and
the loaded image matches its verified OCI manifest. That manifest's content hash
and reference to the expected configuration digest are checked before use.
The existing runtime checker is byte-identical to the one used during the build.

The temporary container had networking disabled, a read-only root filesystem,
temporary data mounts, 768 MiB of memory without additional swap, one CPU and no
production data mounts. Health, 24 catalog actions and rejection of an unauthenticated
account-bound action pass. The verifier removes its own container and proves the
running connector's ID, image, start time and healthy status are unchanged.
The loaded candidate image remains available for a later approved rollout.
The staging directory and transferred files are removed. All seven existing
containers report healthy, and fresh read-only identity checks pass for both LINE
and both Instagram connections on the original production image.

`scripts/verify-connector-image.py` reproduces this check without compiling on the
host. Eight offline tests cover remote-daemon refusal, archive mismatch, candidate
tag protection, both Docker image ID representations, a manifest referring to the
wrong configuration, runtime failure, creation failure and failed cleanup.
Review caught cleanup masking a failed container creation; absence is now checked
independently and the production comparison is always attempted after image loading.
The first native attempt then stopped before container creation because this
Docker backend reports a manifest ID rather than a configuration ID. Regression
fixtures reproduce that rejection; the corrected verifier accepts only identities
cryptographically bound to the checked archive. The native rerun passes.

Evidence is under `test-report/deskazo-v1/checks/native-connector`. This validates
native runtime compatibility, catalog presence and the tested authentication route.
It does not validate provider permissions, history, delivery, payment, migrations
against production state or rollback. No running service was replaced or restarted;
hosted rollout and the seven real-provider acceptance journeys remain open.

## Managed search component recovery

The customer OpenRAG overlay now declares a dedicated snapshot volume and repository
path. A Python operator command creates a complete filesystem snapshot of visible
and hidden OpenSearch indices, excluding security and global state, then verifies
and exports the repository with a checksum manifest and private permissions. It
retains uncertain operations for investigation instead of deleting their files.
Successful capture removes only its unique source repository after publication.

Restore requires the original image and server version, fresh application data,
Docker networking disabled and no published ports. It refuses occupied targets,
preserves fresh-node bootstrap indices, and retains previous audit/plugin metadata
under renamed indices without aliases. The first real attempt revealed that the
pinned image creates bootstrap indices on a fresh node; it stopped safely and
removed all owned test resources. The corrected fresh-node guard preserves those
indices instead of requiring an impossible completely empty inventory.

Nine offline cases pass, including malformed metadata, archive corruption and unsafe
members, security/global/partial state, connected or occupied targets, image mismatch,
and retention after an uncertain snapshot request. The final real OpenSearch 3.6.0
check passes snapshot export and fresh-node restore with document and access-field
readback, exact mappings, aliases, hidden state and JVector search. Executed source
hashes are recorded. Owned containers and volumes were removed and all four existing
development containers remained running with unchanged start times. Evidence is
under `test-report/deskazo-v1/checks/search-backup`.

This is component recovery only. Application writers must be stopped for a
coordinated capture; index-name equality does not prove document or cross-database
consistency. Core state, Langflow/OpenRAG files and keys, connector state, security
configuration and global settings still need coordinated recovery. Image identity
portability, production-sized data, full application readback and hosted recovery
remain unproven. No persistent service was reconfigured, restarted or deployed.

## Customer runtime state recovery

`scripts/customer-runtime-backup.py` now captures the local Langflow, OpenRAG backend
and OpenConnector runtimes together. It locks the selected container identities,
stops their processes, rejects other container writers to the captured mounts,
archives shared mounts once, and saves effective environment and image identities
with private permissions. It resumes only the containers that were originally
running, including an attempt to resume after an uncertain Docker stop response.
It refuses external databases and configured state paths outside the captured
mounts. Review found the initial OpenRAG external-database omission; that guard and
path-override regressions were added before the passing Docker run.

Restore verifies the artifact before creating fresh UUID-named volumes. It writes
an unstarted Compose configuration with networking disabled and no published ports,
preserving shared mounts, numeric file ownership and literal environment values.
Failed extraction cleans the volumes allocated by that attempt. The source
deployment's files and volumes are never restore targets. Checksums detect
corruption, not malicious replacement of both artifact and manifest.

Eleven offline cases pass. The final disposable Docker check captures and restores
SQLite fixture records and files across shared named volumes and a nested bind,
checks SQLite integrity and exact content, and creates stopped containers from the
generated Compose to verify actual secret values and networking. Earlier fixture
failures exposed an in-memory stream without a subprocess file descriptor and a
helper image that implicitly created three anonymous volumes. Docker event evidence
bound those volumes to the fixture before their removal. The verifier now requires
an image with no declared volumes and checks its final volume inventory against the
baseline. An init process avoids waiting for the entire shutdown grace period when
the fixture's sleep process is PID 1. Another assertion incorrectly treated Compose's
serialized dollar escaping as the effective value; direct container inspection
proves the runtime value instead.

Final owned-container and volume cleanup passes, with no unexpected new volumes and
all four persistent development containers unchanged. Executed source hashes are
recorded under `test-report/deskazo-v1/checks/runtime-backup`. The fixture runs sleep
in a cached image and uses synthetic SQLite data; it does not prove Langflow or
OpenRAG application recovery, a production-sized dataset, or live provider behavior.
Core PostgreSQL/files, OpenSearch data and security/global configuration still need
coordinated capture and full-application recovery verification. No hosted service
was stopped or changed.

## Coordinated customer data capture

`scripts/customer-deployment-backup.py` now holds the core deployment and selected
runtime locks across one maintenance window. It stops core writers and late-created
managed computers before customer runtimes, then captures core PostgreSQL/files,
runtime files and search data while those writers remain stopped. It checks for
remaining writers, database clients, configuration changes and container restarts
between components. One private parent manifest binds the three component manifests;
verification checks that binding and invokes each component's existing validator.
Failed capture discards the unpublished bundle and attempts service resumption.

The core backup now exposes its existing capture operation under the caller's lock,
allowing the wrapper to reuse it without releasing the lock between components.
Standalone core behavior retains its existing checks and passes the real disposable
recovery suite, including unrelated writers, changed configuration, empty-target
guards, SQL rollback, private files, numeric owners, modes and symlinks. All four
offline suites pass, totaling 39 cases. Review caught the initial reversed runtime
restart order; regression assertions fail before the fix and pass after Langflow
starts before OpenRAG. Dependency groups check declared health, or running state
when a service has no health check, while failed resumes remain visible.

The new Docker verifier reuses runtime and search fixture creation. It deliberately
restarts and stops a runtime after core capture, proves that the changed start time
rejects the bundle and resumes the selected services, then completes a clean capture.
Fresh PostgreSQL, runtime SQLite/file and OpenSearch restores retain the same
synthetic marker and search access fields. The originally stopped worker remains
stopped. Owned containers and volumes are removed, no unexpected new volumes remain,
and all four persistent development containers keep their original start times.
Seven executed source hashes are recorded under
`test-report/deskazo-v1/checks/coordinated-backup`.

This closes coordination of the captured local data, subject to keeping external
clients and host writers disconnected. It does not freeze external provider actions,
restore OpenSearch security/global configuration, or recover uncaptured host state.
The runtime fixtures execute sleep rather than the actual customer applications.
Full application recovery, production-sized data, provider reconciliation, hosted
rollout and the real-provider V1 acceptance journeys remain open.

## Langflow application recovery

`scripts/verify-langflow-recovery.py` now exercises the real Langflow application
before and after runtime backup restoration. It uses the production customer
runtime adapter to create an API key, identify the account, publish a flow containing
the installed customer component and execute it against synthetic loopback services.
After capture, it stops the source and starts the same image on fresh restored
volumes. The original key authenticates as the same account, the complete saved flow
response matches, and the customer component returns the expected reply again.

The initial fixture used an invalid Fernet encryption key and then exposed missing
TypeScript input/library declarations. Those were corrected. A subsequent request
failure came from decoding the compressed component catalog in the Docker HTTP
bridge. Bounded gzip decoding fixed that bridge. These were fixture defects;
the application adapter and backup implementation were unchanged in this phase.

The checker requires the exact disposable fixture label, disabled networking and
no published ports before any API request. The final run includes refusal probes
for unlabeled and network-connected owned containers, plus TypeScript and formatting
checks. Source and target each use two CPUs and 2 GiB memory, sequentially. All
owned containers, network and volumes were removed, no unexpected new volumes
remained, and all four existing containers retained their start times. Seven
executed source hashes and private receipts are retained under
`test-report/deskazo-v1/checks/langflow-recovery/encoding-fixed`.

This proves a small same-image SQLite Langflow recovery with a fixed synthetic
model reply and empty tool catalog. It does not prove model quality, actual tool
actions, channel delivery, OpenRAG backend or OpenConnector application recovery,
large data, image upgrades or full product recovery. The fixture supplies health
checks and resource limits through a test overlay. Hosted deployment and the seven
real-provider acceptance journeys remain open.

## OpenConnector application recovery

`scripts/verify-connector-recovery.py` now verifies a real connector database restore
with a synthetic HTTPS store. Through the connector's normal management API, it
creates an encrypted store connection, an account-scoped product-read token and a
second token that it revokes. It captures runtime state, stops the source, starts
the same image with fresh restored volumes, and checks the original account,
provider identity, token and authenticated product result. An excluded action still
returns `action_not_allowed`, a changed provider identity is rejected before
dispatch, and the revoked token remains unauthorized.

The final check passed on native AMD64 hardware with the prepared candidate image.
It made no deployment change. Source and target ran sequentially at 768 MiB and two
CPUs each; the synthetic store used 128 MiB. A uniquely labeled internal Docker
network had no external routing or published ports. The fixture used the existing
trusted-host and CA settings for one synthetic hostname. It did not disable TLS
verification or change the connector's request guards. Ownership and wrong-network
refusal probes passed before API calls. Five executed source hashes match current
sources in `test-report/deskazo-v1/checks/connector-recovery/health-fixed`.

Earlier attempts exposed fixture problems: an AMD64 image could not execute on the
local ARM engine, loopback store requests were blocked, v1 responses needed their
data envelope, and account-bound calls required the connection alias and provider
identity. The first successful source read then exposed inherited application
health checks on idle placeholder containers. Those placeholders now disable
health checks, while real source and target connectors must become healthy. The
shared fixture explicitly owns image-declared application volumes. Its final
standalone runtime restore regression passes, and a separate mismatch check proves
architecture refusal before fixture creation.

Final cleanup removed every owned container, network and volume, with no unexpected
new volumes. All seven existing hosted containers retained start times and health
states. Local formatting and the shared runtime fixture regression passed. This
is a small same-image SQLite application recovery proof against a synthetic store,
not merchant acceptance. OAuth refresh, incoming webhooks, real writes, purchase
reconciliation, OpenRAG backend recovery, full deployment recovery and V1 provider
acceptance remain open.


## Pinned OpenRAG backend packaging

The downloaded backend image differed from the locked OpenRAG commit, so it was
not used as release evidence. `scripts/verify-openrag-image.mjs` now exports the
locked commit into a clean directory and builds its unchanged backend Dockerfile
with a temporary native-architecture builder limited to 2 GiB and two CPUs.
Source preparation supports unpatched pins without resetting the operator checkout
or copying its ignored and untracked files. Nine source-preparation cases pass.

The first image build succeeded, but the verifier rejected committed upstream
symlinks. The corrected comparison checks exact link targets without following
them, and the second build passes all 316 packaged-entry comparisons, including
the entrypoint and unchanged dependency lock. Both runs removed their temporary
containers and volumes and preserved existing running-container state. The passing
ARM64 image remains cached for the next isolated application check. Receipts are
in `test-report/deskazo-v1/checks/openrag-recovery/pinned-image-links`.

This is a packaging prerequisite. Base images, downloaded build tools and package
registry access remain inputs to the upstream Dockerfile. No startup, authorization,
knowledge readback, backup/restore or cross-version claim follows from this check.
OpenRAG application recovery and full V1 acceptance remain open. No hosted service
was changed.


## Paired OpenRAG application recovery

`scripts/verify-openrag-recovery.py` now runs the pinned real backend with real
Langflow and OpenSearch on a disposable internal network. Its source creates API
keys and an explicit saved filter through the real APIs, revokes a second key,
and checks that a foreign-owned filter is hidden. It stops backend and Langflow
writers while capturing runtime files/SQLite and the search snapshot, then restores
both into fresh volumes. Restored user and role rows and RSA files match exactly;
the original key reads the same filter, and missing/revoked keys and private-filter
access remain denied. Langflow health must pass while the restored backend is still
stopped, before backend startup. The source and target use synthetic OSS no-auth
management with RBAC enabled, not real OAuth users.

This application check exposed a restore gap missed by the earlier synthetic
search-only fixture: OpenRAG creates protected `.plugins-ml-config` state that
password-authenticated restoration cannot restore. The search restore command now
accepts explicit administrator certificate/key paths inside the isolated target.
It preserves the protected index and retains its existing artifact, image/version,
empty-target, network, security-index and global-state guards. Twelve search guard
cases pass. The application run passes with certificate authentication; its owned
resources were removed and existing running-container state stayed unchanged.
Evidence is in `test-report/deskazo-v1/checks/openrag-application/certificate`.

Earlier retained runs exposed fixture setup omissions: a single-node deployment
must use its Compose node-count setting, and API keys need the actual post-onboarding
index mappings. The fixture now applies both without replacing backend code. The
upstream also maps a DLS-hidden document's OpenSearch not-found exception to HTTP
500 and exposes the internal error string. This remains a defect; verification
requires the exact denial and absence of a filter payload, with an admin read proving
the foreign document exists. It is not claimed as correct HTTP error handling.

The check recreates stock OSS search security separately, as security/global state
is intentionally excluded from the snapshot. Custom security, OAuth login,
ingestion, real embedding providers, retrieval quality, external databases, cross-version recovery,
large data, provider reconciliation and full deployment/V1 acceptance remain open.
No hosted service changed.

## Scoped knowledge retrieval after recovery

The paired OpenRAG check now invokes the actual `LangflowCustomerRuntime.search`
adapter before capture and after restoration. It configures a private synthetic
embedding endpoint through the backend's onboarding API and seeds three documents.
The selected document is returned with a positive score. An unselected document is
excluded by the saved filter, and a foreign-owned document with the selected filename
is excluded by authenticated document-level access. The saved filter includes both
owners, so it cannot hide a failure of that access check.

Both source and restored queries pass. The exact-query embedding counter advances
from zero to one, then one to two. Revoked-key and private-filter attempts fail
before search with only the adapter's generic error. The fresh restore also passes
exact readback of all three documents, user/role and RSA-file comparisons, and the
original key/filter checks. TypeScript and formatting checks pass. All owned
resources were removed; existing containers stayed unchanged. Evidence is in
`test-report/deskazo-v1/checks/openrag-retrieval/framed`.

Two retained attempts failed before retrieval. Fresh installations require the
onboarding API before ordinary settings updates, and upstream imports write logs
to stdout before the vector-mapping JSON. The fixture now uses onboarding and
requires exactly one explicitly marked JSON record. Both failed attempts cleaned
up their resources.

Every stored and generated vector is the same synthetic value. This proves
embedding-backed requests, saved provider configuration and scoped access after
recovery. It does not prove semantic relevance, ranking, ingestion or real model
quality. This run used the unpatched backend's hidden-filter HTTP 500 response;
the subsequent patch and recovery check below replace that behavior with a safe
404. Live-provider acceptance and full V1 sign-off remain open.

## Hidden knowledge-filter error recovery

OpenRAG's service previously converted a typed `NotFoundError` to text. The API's
string matcher missed it and returned HTTP 500 with internal search details.
The checksum-locked patch catches that exception and returns the existing missing
filter result only when its document payload explicitly says `found: false`.
Hidden and absent filters now have the same safe HTTP 404 body. A missing index
or unrecognized search 404 remains a server failure with a safe error message.
The operator's upstream checkout is preserved.

Five offline regressions exercise the real service and API handler with synthetic
search responses. The hidden-filter case fails against the original image and
passes with the patch; visible filters, authentication failures and unrelated
transport failures retain their expected statuses. The first patch also collapsed
index failures into 404. Independent review caught this; the added regression
reproduced it before the predicate was narrowed. The native backend build
matches all 316 packaged source entries and passes these regressions. A real
paired runtime/search restore then passes the safe-404 checks, fixed-vector scoped
retrieval, credential/filter recovery and access denials. Each successful search
makes one embedding request. Removing only the restored fixture's filter index
then produces the expected safe server error, rather than a missing-document 404.
Owned resources were removed and existing containers
stayed unchanged. Receipts are under
`test-report/deskazo-v1/checks/openrag-filter-errors`.

The managed stack now prepares OpenRAG from the pinned commit and locked patch,
as it already does for OpenConnector. All four OpenRAG build contexts use prepared
files; Compose resolves existing mounts against the operator directory. The backend
image uses its locked source-tree tag and disables pulling. Ten source/stack tests
cover preparation, dirty checkouts and cleanup after either dependency build fails.
The real Compose resolver also verifies unchanged existing mounts and the prepared
build contexts without starting services.

This closes the observed hidden-filter error defect. Other backend error handling,
real semantic quality, live-provider acceptance and full V1 sign-off remain separate
work. Nothing was deployed to the hosted connector or existing local services.

## Stack controls without build inputs

`customer-stack.sh ps` and `stop` now inspect deployed Compose metadata directly.
They work when dependency checkouts, source locks or environment files are
unavailable. Startup still verifies and prepares the locked build sources.
Inspection reports stopped services and health status. Stopping processes the
core project before OpenRAG and OpenConnector; within each project, application
containers stop before Langflow, OpenSearch and PostgreSQL. Docker retains each
container's configured stop signal and grace period. Detected stop failures or
restarts abort before proceeding to dependencies. These controls remove no data.

Twelve source/wrapper tests and five control tests pass through the testkit suite.
The offline cases cover exact-project selection, one-off exclusion, shutdown
order, dependency preservation after failure, detected restarts and inspection.
A real disposable Compose check passes graceful shutdown order, retained already-
stopped state, healthy/stopped inspection, and isolation from a one-off container
and an adjacent project. All owned resources were removed and existing containers
were unchanged. Evidence is under `test-report/deskazo-v1/checks/stack-control`.

Retained failed attempts exposed two fixture details. Docker templates must handle
the absence of health metadata, and the cached PostgreSQL image sends SIGINT while
the initial synthetic process handled only SIGTERM. The lookup and fixture signal
handler are corrected. An empty Compose configuration was also rejected as an
implementation approach because its stop command succeeded without stopping real
services.

Shutdown-failure and restart cases have offline coverage. Concurrent external
Docker administration can still race the checks; pause deployment/restart
automation before stopping the stack. One-off commands and containers without
Compose service metadata remain outside these controls. This check does not
establish production drain behavior or live-provider V1 acceptance.

### Application-owned worker termination

The Graphile job adapter now leaves OS signal handling to the worker application.
Graphile's default handler drains jobs and then re-signals the process, which
terminated the worker before its remaining asynchronous cleanup could finish.
The application already stops the job host before closing connectors, realtime
and its shared database pool. The adapter now respects that ownership.

Two child-process regressions exercise SIGTERM and SIGINT with actual Graphile
jobs in a disposable PostgreSQL database. Both reproduced signal termination
before the fix. Both now confirm active-job completion, host drain, subsequent
asynchronous cleanup with the database still usable, and normal process exit.
All 23 targeted queue and lifecycle cases and the adapters typecheck pass. The existing integration
suite includes these PostgreSQL tests. Receipts are under
`test-report/deskazo-v1/checks/worker-signals`.

These checks use a controlled application owner around the real job adapter.
They do not establish full worker startup-failure cleanup, repeated fatal-event
handling, recovery after forced termination, or real customer-action deduplication.
Full application and live-provider V1 acceptance remain open.

### Worker startup cancellation and interrupted history imports

The actual worker now registers shutdown before starting its connector and job
host. Stopping cancels database-capacity retry delays, waits for an in-flight
start, and shares one cleanup promise between callers. Shutdown during startup
does not start reconciliation or report readiness afterward. An actual-process
regression reproduced SIGTERM bypassing cleanup during PostgreSQL capacity
retries before this change; that case now exits normally.

Process-level recovery testing also exposed a deadlock between history imports
and learning summaries. Imports lock the Space before inserting records that
reference the bot. Summaries previously locked the bot before writing events
that reference the Space. Summaries now take the same Space-then-bot lock order.
A controlled contention regression reproduces the former import failure and
passes after the correction, alongside all 26 history tests.

The real worker entrypoint passes three isolated PostgreSQL checks: shutdown
during capacity retries, recovery after SIGTERM, and recovery after SIGKILL.
Both recovery cases stop after the first 100 replies of a 205-reply import. A
fresh worker completes the remaining pages with 205 distinct persisted records,
zero reported duplicates, and the original import window. The process suite is
included in the integration runner. Worker, database and adapters typechecks pass.
Receipts are under `test-report/deskazo-v1/checks/worker-lifecycle`.

The fixtures use synthetic history and no model or provider credentials. They
establish recovery between committed import pages, not recovery after an
external send or purchase. In-flight database connection attempts retain their
existing timeout/retry bounds; startup cancellation does not guarantee a fixed
shutdown duration. Mixed repeated signals, cleanup failures, and the remaining
real-provider V1 journeys still need acceptance evidence.

### Interrupted customer-send confirmation

Recovery now records `execution_uncertain` when a worker leaves a customer
message in processing or sending state. Outgoing messages with that code show
"Delivery unconfirmed" in web, Electron's shared web UI, and mobile. The label
replaces "Reply failed" only when the outcome is unknown, because claiming
failure could encourage a duplicate send. It stays next to the affected message;
no additional persistent explanation is needed. Inbound and legacy unclassified
failures retain their existing wording.

A regression starts the actual worker against a disposable PostgreSQL database
and a local connector emulator. It kills the worker after the emulator records
the send but before confirmation returns. A replacement worker raises staff
attention, and repeated submission plus queue delivery leave exactly one send.
The test advances only the fixture's expired lease to avoid a two-minute wait.
It reproduced the missing uncertainty code before the fix.

All four worker-process cases, 15 focused rendering/delivery/localization cases,
the customer browser journey, and core, adapters, web and mobile typechecks pass.
The browser journey captures desktop and narrow-width screenshots of the label.
Receipts are under `test-report/deskazo-v1/checks/worker-send-recovery`.

This proves recovery against a controlled HTTP connector, not a real messenger
or purchase provider. Native mobile and Electron runtime inspection, real-time
lease expiry, and the remaining live-provider acceptance journeys remain open.

### Coordinated core and knowledge application recovery

The OpenRAG recovery verifier now accepts a current core application image. It
starts real API, worker and PostgreSQL services alongside real Langflow, OpenRAG
and search. A synthetic owner signs in, saves encrypted credentials and customer
behavior, publishes a customer flow and searches approved knowledge through the
production customer service. One coordinated backup captures core data, runtime
files and search while their writers are stopped.

The fresh restored application accepts the original session and password,
decrypts its saved credentials, resolves the original flow and retrieves only
the approved document. The original conversation, private file and migration
state survive. Both workers report readiness. Runtime account roles, RSA keys,
filter scope and search documents match; revoked keys and foreign filters remain
denied. All owned containers, volumes and networks were removed, and the four
existing development services retained their original start times and health.
The eight offline coordination checks, both TypeScript checkers and Python syntax
checks pass. Six core source hashes match the built image; all twelve recorded
verifier/runtime source hashes match the executed files.

Initial fixture attempts exposed an undersized API memory limit, TypeScript eval
import resolution and unsupported HTTP Docker-hostname configuration. The final
check executes a normal TypeScript file and uses fixed loopback proxies to the
owned internal runtimes. Production URL and credential guards are unchanged.
Receipts, including failed attempts, are under
`test-report/deskazo-v1/checks/coordinated-application-recovery`.

This is a small same-image coordinated restore using the original encryption
and authentication configuration. The connector remains an idle placeholder;
the saved flow is inspected rather than executed, and embedding vectors are
synthetic. Operator proxy configuration, real provider reconciliation, changed
release compatibility and the complete merchant acceptance journeys remain open.

### Earlier-image migration compatibility

The recovery verifier now accepts `--previous-image` to seed saved application
data under an earlier cached image before switching API and worker to the current
build. The tested earlier image is labeled revision
`2241538afc9276054c5e1be390891b7a59496394`. Its account, encrypted credential,
instructions, conversation and private file survive 60 additional migrations.
The original session and password work after the image change.

The verifier then snapshots that upgraded state, injects a migration that commits
a data change before failing, and proves that switching images alone does not
repair it. A fresh-volume restore recovers the upgraded snapshot, including the
original login and saved data, while leaving the damaged source untouched. Both
fixture attempts were cleaned up, including their projects, volumes, networks
and temporary fault image; the four existing development services were unchanged.
Receipts and source hashes are under `test-report/deskazo-v1/checks/release-upgrade`.

The first attempt exposed the earlier image's package-manager launcher trying to
download pnpm on an isolated network. The successful compatibility run uses each
immutable image's installed Node, Prisma and tsx directly. It does not verify the
normal package-manager launch path for either image. Encryption and authentication
configuration remain fixed. This proves one selected image pair with synthetic
core records, not every release, signed distribution, downgrade compatibility,
large databases, provider migration or the updater's deployment flow. The recovery
snapshot is taken after the successful forward migration.

### Approved hosted connector rollout

The prepared native AMD64 connector image is now deployed and pinned by immutable
image ID. The update preserves the original environment, loopback port, restart
policy and data volume. The six other hosted services were unchanged. Private
backups retain the prior image, Compose configuration, environment and stopped
data volume; their checksums were verified. No new paid services were created.

Before cutover, the exact archive and native runtime passed the selected 24-action
catalog, health and authentication checks. After cutover, the four configured
LINE/Instagram connections passed identity reads through their account-bound
routes. Mismatched account IDs returned a rejection before dispatch, and an
invalid management token was denied. The four Instagram history actions and
eleven WooCommerce cart/checkout actions are now available in the deployed
catalog. All 6,154 checked source paths match the locked prepared source.

The first attempt rolled back successfully because the new rollout verifier used
an administrator token on a runtime-only action route. An isolated regression
using the candidate's actual authentication middleware reproduced that rejection
with distinct synthetic credentials. The corrected verifier uses runtime
credentials for actions and administrator credentials for management reads.
Production authentication and the approved image were unchanged. The second
attempt passed every gate and pinned the image; both attempts remain recorded.

The user-selected LINE account was identified in Chrome, matched to both existing
LINE connections and confirmed to be on the free plan. No messages, comments,
orders, invoices or merchant records were sent or created. Live history coverage,
channel delivery, the pilot store, merchant model configuration and the seven
merchant acceptance journeys remain open. Rollout receipts are under
`test-report/deskazo-v1/checks/connector-rollout-approved`.

### Free local inference

Qwen 3.5 9B is downloaded locally and served by Ollama with cloud features disabled
on loopback. An opt-in check saves a keyless OpenAI-compatible connection through
the authenticated application, runs the real Pi executor, and checks tool events,
the saved Thai file content and the final reply. With a 65,536-token server and
connection context, the task called both `write_file` and `read_file` and passed in
about 51 seconds. Three local completion requests produced no truncation warnings.

The first two attempts failed the requested readback. Their 16,384-token server
configuration truncated a roughly 23,500-token staff prompt to 8,194 tokens.
Enabling reasoning alone did not fix this. Those failures remain in the evidence;
the later pass does not establish broad model reliability or merchant readiness.

Run `bash scripts/verify-local-model.sh` with the local server already available.
The check uses disposable PostgreSQL, a synthetic account and the fake sandbox.
It verifies tool orchestration and application persistence, not a native computer
or live merchant workflow. It does not connect the merchant workspace, install a
startup service or send provider messages. The current model server runs in a
task terminal and needs restarting if that process ends. Receipts and the restart
command are under `test-report/deskazo-v1/checks/free-local-model`.

### Local customer setup verification

The existing app/Pi/Langflow customer journey now has an opt-in local-model mode
through `scripts/verify-customer-local-model.sh`. It uses synthetic approved voice
and shipping knowledge, exact stored-effect approval checks, a private Thai
preview, and website delivery with duplicate-request prevention. Each attempt
records its model digest, executed source hashes, staff messages, tool calls,
model-bridge replies and cleanup result. The scripted version still passes.

The local 9B model completed the functional steps but repeatedly exposed internal
configuration details in ordinary setup replies. One earlier attempt called the
learning toggle and reported an unrequested pause; its disposed database prevents
confirming the final setting. Automatic-learning changes now require explicit
owner approval, even with an always-allow rule or automatic review. Focused tests
reproduce the previous bypass and verify approval, execution and replay behavior.
Shared guidance also limits private setup to the requested work.

The guarded local attempt made no learning-toggle call or effect and left learning
enabled. It produced grounded Thai practice and website replies but exposed
internal configuration and incorrectly described saved knowledge as missing.
Those failures remain recorded under `test-report/deskazo-v1/checks/customer-local-model`.

Preparation and public-instruction updates now return the preparation outcome and
actual approved customer knowledge instead of the raw runtime record. Inspection
reports effective learning documents, document-library attachment, and legacy
search configuration separately. A missing legacy search connection no longer
stands in for missing knowledge. Effective documents reuse the exact customer
reply selection, including bot overrides and exclusion of private documents.
Technical inspection and custom configuration remain available.

Knowledge is read again after publication completes. A deterministic regression
changes the shipping document and detaches the library during publication; the
result reflects both changes. All 126 customer-service cases, TypeScript and the
scripted app/Pi/Langflow journey pass. The fresh reads are not an atomic snapshot
across later edits, and library attachment does not establish source readiness.

Two local-model reruns correctly recognized the saved voice and shipping policy
and omitted runtime endpoints and credential names. Both still printed an
internal tool name. The final run also made an unverified widget-greeting claim,
so local-model customer setup remains unqualified. A larger free local model is
still downloading; no result or reliability claim is made for it. No paid
inference or merchant-model configuration was introduced. A later inspection of
the selected Chrome account confirmed that native LINE export requires a paid
OA Chat package on its current free plan. Native export validation remains open.
The seven live merchant journeys remain open. Current private receipts are under
`test-report/deskazo-v1/checks/customer-setup-results`.

### Bounded Instagram history access

A read-only probe through the approved hosted connector verifies conversation
listing, message-reference listing and one message detail for each configured
Instagram connection. Message details include text, timestamp, sender and
recipients. No content, provider IDs, credentials or cursors are retained by the
probe; only counts and field-presence results leave the connector container.

The provider returned two message references despite a requested limit of one.
The probe now accepts at most 20 rows and follows only the first item per edge;
six offline safeguards pass, with the earlier failed live runs retained. Media
listing returned no rows, so comment and reply access remain unverified. More
conversation and message pages exist and were not followed. This establishes
bounded read access, not complete history, human authorship, learning import,
customer delivery or merchant acceptance. No hosted code or configuration was
changed. Receipts are under `test-report/deskazo-v1/checks/instagram-history-access`.

### Negated requests for human help

The direct handoff shortcut previously treated phrases such as "do not connect
me to a human" as requests for staff and skipped assessment. Supported negated
Thai and English request clauses now continue through configured assessment,
which can still require staff for other reasons. Fresh affirmative requests
retain immediate handoff even when the assessment provider is unavailable.

Review rejected two earlier approaches: scanning all prior text suppressed
unrelated affirmative requests, while a modifier list missed ordinary negated
phrases. The final shortcut uses sentence, contrast and fresh-intent boundaries,
with an explicit affirmative "cannot wait to" case. It remains a bounded language
heuristic; broader Thai and English merchant evaluation is still required.

All 109 focused unit cases, 134 customer-conversation PostgreSQL cases and the
adapter typecheck pass. Process tests verify assessment invocation, continued
policy-exception handoff and immediate affirmative handoff without a runtime
reply. No live customer message or paid model call was made. Retained failures,
final source hashes and review are under `test-report/deskazo-v1/checks/handoff-negation`.

### Combined offline checkpoint

Before the LINE withdrawal change, the worktree passed 4,745 unit tests, with
1,073 opt-in cases skipped. All 22 workspace checks passed, including two cached
tasks. That offline integration run passed 1,036 tests across 55 suites against
disposable PostgreSQL.

An inventory found three existing offline database suites omitted from that
runner and therefore skipped by the standard CI commands. Messaging, structured
mentions and activity-list suites pass another 21 tests in separate isolated
runs. Their three paths are now included in the default integration runner,
which selects 58 suites. This checkpoint comprises the 55-suite run and three
separate runs, not a combined post-edit run or hosted CI result.

The integration job now allows 20 minutes instead of 10. The 55 test processes
alone took 408 seconds locally, excluding runner, database and CI setup overhead.
The runner passes TypeScript and formatting checks, and the workflow parses.
The original four local services remain unchanged and no test containers remain.
Product source stayed unchanged during these checks; only the runner selection,
CI timeout and status documentation changed afterward. Live-provider journeys,
native LINE export, model qualification and release acceptance remain open.
Receipts are under `test-report/deskazo-v1/checks/offline-checkpoint`.

A subsequent combined run after the LINE withdrawal migration exposed a gateway
test fixture missing LINE's provider message ID. The isolated test reproduced
the failure and passed after that one-line fixture correction; production code
was unchanged. The corrected default runner then passed all 58 suites and 1,066
tests in one invocation, including the three formerly omitted suites. Total local
runner time was 462 seconds. The selected inventory of 1,669 source and
configuration files remained unchanged during that run. All four prior local
services retained their running states and start times, and no test containers
remained. Style checks passed for the changed fixture. The failed run, isolated
red/green checks, exact file inventory and terminal combined results are retained
under `test-report/deskazo-v1/checks/integration-58`. This verifies the local default
integration command, not hosted CI timing or the real-provider acceptance gates.

### Bounded Instagram message pagination

A follow-up read-only probe requested 20 rows and followed at most one next cursor
for each messaging list. Both configured aliases returned one conversation with
no next page, then four message references and an empty next message page. One
first-page message detail per alias was readable. Message cursor continuation is
verified for this sample; conversation pagination remains unexercised. Empty media
lists still leave comments and replies unverified.

Nine offline probe tests and two runner tests pass. The runner preserves the stdin
entrypoint for every mode and rejects empty output. Deployed source matches the
approved copy, the hosted image and restart state are unchanged, and only fixed
counts and field-presence checks leave the connector. No paid service, provider
write, learning import or customer delivery occurred. Full history, staff authorship
and the seven real-provider acceptance journeys remain open. Chrome is still
blocked by the Mac lock screen. Receipts are under
`test-report/deskazo-v1/checks/instagram-pagination`.

### LINE message withdrawal

The built-in LINE binding previously ignored unsend events and retained only the
webhook event ID. It now also records the provider message ID and maps authenticated
withdrawals through a shared receive contract. Channel-scoped identity hashes stop
delayed originals from returning, including reversed events in one webhook batch.
Withdrawal clears the matched message text/media, execution credentials, pending
drafts and captured learning proposals that include that message. Known older
learning decisions remain. Customer runtime history, staff snapshots and subsequent
learning omit withdrawn rows. Tool identities remain while result content is cleared,
including when a dispatched send completes afterward. That send cannot be recalled.

Idle conversations keep their owner. Active or uncertain work, other pending
messages and drafts require staff review before resuming. Paused channels can still
accept authenticated withdrawals. The migration upgrades only the exact old built-in
LINE mapping and preserves custom mappings. An original event redelivery can fill a
missing provider message ID; otherwise historical rows cannot be matched retrospectively.

All 244 focused offline checks and three package typechecks pass. These include
migration preservation, signed ingress, ordering and replay, an in-flight reply,
interrupted learning, unchanged unrelated review history and a dispatched-send result.
The original services remain unchanged and disposable test containers are removed.
Run `scripts/verify-line-withdrawal.sh` with a new evidence directory to repeat them.

This has not been deployed or verified with real LINE events. Already sent replies,
applied learning revisions, private staff records, runtime/gateway logs and backups
have separate retention boundaries; this is not complete erasure across the product.
Custom mappings, native LINE export and full V1 provider acceptance remain open.
Receipts are under `test-report/deskazo-v1/checks/line-withdrawal`.

### Free self-hosted provider setup (2026-09-20)

The owner authorized free provider registration and Docker self-hosting. A separate,
persistent local environment now runs the target worktree with PostgreSQL,
WooCommerce, and OpenConnector. The store is connected through authenticated
Deskazo settings. Credentials remain in ignored private setup files or encrypted
application storage. Existing services and the hosted connector were preserved.

An authenticated connector check passed product readback, cart creation, item
addition, customer details, checkout, and order readback over verified private TLS.
The synthetic THB 125 bank-transfer order remains on hold and unpaid. This is local
provider acceptance, not a real merchant/payment-gateway or complete customer
confirmation journey. The rerunnable setup and receipts are under the ignored
`test-report/deskazo-v1/free-providers/` directory.

The model direction changed to the owner's ChatGPT subscription. GPT-5.6 Luna is
selected in the local app. Firefox is signed into OpenAI, and the final device-code
grant awaits the owner's confirmation required by the computer-use tool. No model reply is claimed for this environment. The large
local model download is no longer a prerequisite; its owned daemon was stopped.


### Deskazo purchase service with real WooCommerce (2026-09-20)

The local provider check now includes Deskazo's durable purchase service, the saved
Space-scoped connection, and authenticated website visitor HTTP endpoints. It
rejects checkout before shopper confirmation and rejects confirmation by another
visitor. Repeated valid confirmation is harmless. Replayed checkout is rejected
before a second provider submission; a later driver run only rereads the order.

A controlled fault drops one successful WooCommerce checkout response before
Deskazo receives it. The purchase becomes uncertain, blocks resubmission and a
replacement cart, rejects an unrelated existing order, then recovers the exact
order through read-only reconciliation. The driver discards the order ID with the
response, then independently finds exactly one matching purchase reference in the
complete provider order inventory. Provider readback reports THB 125, on hold,
and payment unconfirmed, without a recorded paid date. No gateway funds move.

Run `pnpm exec tsx scripts/verify-deskazo-woocommerce.mts <private-lab-directory>
<run-name> --lose-response` against the owned local provider lab. The driver checks
the synthetic database, local connector endpoint and private Docker store identity
before writes, preserves its state, and only reconciles an uncertain purchase
through order discovery and readback. It never repeats an uncertain checkout.
New run names create separate synthetic cases and consume fixture stock. Its
initial assertion incorrectly expected a success receipt for a stale checkout
replay; the driver now checks the service's deliberate rejection and proves one
provider submission. No product implementation was changed for that correction.

The verified run and subsequent read-only rerun are recorded under the ignored
`test-report/deskazo-v1/free-providers/deskazo-purchase-reference-final-*` files.
Order discovery initially stopped at the app's effect guard because the connector
omits read-only metadata for `woocommerce.list_orders`. Its fixed GET handler now
joins the exact audited fallback list. The locked-source audit passes 50 handler
checks, including hostile input overrides; explicit consequential metadata still
wins. Ten adapter unit checks pass. The existing uncertain purchase was recovered
without another checkout, then a fresh fault case passed with independent order
discovery. This source change is exercised by the verifier; the running API and
worker had not yet been restarted at that checkpoint; the following checkpoint
loads and verifies it through the running API.
This check seeds a synthetic channel and calls the staff backend service directly;
it does not verify model-led setup, the staff approval UI, a real payment gateway,
worker process death, social delivery, or a complete merchant acceptance journey.

### Explicit connection recovery after runtime token revocation (2026-09-20)

The owned local API and worker were gracefully restarted with the current source.
The purchase verifier now checks the running API's action metadata before its
read-only rerun. It confirms `woocommerce.list_orders` is read-only and preserves
the same submitted, unpaid order. The web process and original Docker services
remain unchanged.

A separate disposable WooCommerce connection exposed a recovery bug. After its
runtime token was revoked, reads failed as expected, but the authenticated app's
reconnect route reported success while retaining that unusable token. The offline
regression reproduced the failure. Fresh account authorization now checks the
runtime-token policy and replaces a missing token only on a confirmed 404.
Execution and ordinary polling cannot restore revoked access. Authorization and
server failures propagate rather than creating another token. Completed OAuth
authorization uses the same recovery rule; pending or cancelled authorization
does not establish new access.

The original failed case now passes through real local app RPC and OpenConnector:
reconnect restores a product read using a new token, app revocation removes the
disposable remote account and blocks reads, repeated revocation is harmless, and
the primary account's encrypted grant contents remain unchanged. The completed
case reruns without connection lifecycle mutations. Run
`pnpm exec tsx scripts/verify-deskazo-connection-recovery.mts <private-lab-directory>`
against the owned lab. The driver preserves its disposable case for recovery.

This verifies runtime-token revocation on the synthetic local store, not merchant
OAuth expiry or social reconnection. Reconnect is not an atomic remote operation:
credentials may have changed before a later token-policy failure. Such a failure
still reports failure and does not restore a token. Model access, actual payment,
staff UI, worker-death and complete provider journeys remain acceptance work.

### Live Jev owner criteria and negated human requests (2026-09-20)

Six synthetic cases ran in the official Jev playground through Firefox, using
the current adapter's questions. Existing monthly credits covered the bounded
check; the account showed no purchases and automatic recharge off. No account,
credential, payment method or paid plan was created.

The configured rule asks staff to handle orders of at least 50 units. Jev
`jev-1.13.0` distinguished 49 from 50 in both Thai and English. It also classified
both explicit refusals of human help as not requesting a human. All six configured
rule answers matched the synthetic expectations. The two 49-unit cases returned
"yes" for safe continuation but only 0.72 confidence, so the adapter's unchanged
0.80 threshold routes them to staff. The other four final outcomes matched the
desired fixture outcomes.

These two conservative handoffs remain quality follow-ups, not established
classification defects. The cases ask about available sizes, and the assessment
state contains conversation text without live catalog/tool context. The desired
no-handoff labels have not been adjudicated by a merchant. Do not lower the
threshold just to pass them. Repeated evaluations with merchant cases and actual
knowledge availability remain necessary before unattended use.

`scripts/prepare-jev-acceptance.mts` generates the requests directly through the
adapter without network calls. An optional observations file replays the visible
playground JSON through the actual decision code and exits nonzero for mismatched
outcomes. The six prepared requests, observations and replay report live under
the ignored `test-report/deskazo-v1/checks/jev-configured-live/` directory. Request
hashes identify prepared source/content, not captured browser traffic. Each case
ran once; this does not establish statistical quality, app integration, real
channel takeover, alert delivery or complete V1 acceptance.

### Full local release checks after connection recovery (2026-09-20)

Root `pnpm check` completed all 22 tasks successfully, with two cache hits.
`pnpm run test --maxWorkers=4` passed 4,751 tests across 440 files and skipped
1,082 tests across 67 files. These skips include database and opt-in provider
checks; this command does not replace the earlier combined integration result.
Root `pnpm build` completed five tasks successfully without cache hits.
No Electron windows or desktop E2E suite were launched.

Root lint initially failed on the customer-binding JSON example's formatting and
two console calls in the disposable updater recovery fixture. Formatting the
example and preserving the fixture output through `process.stdout.write` cleared
those errors. The Biome schema now matches the installed version. Lint passes
with 26 warnings and six informational diagnostics; this is not a warning-free
result. The first unit invocation used an unsupported pnpm argument position,
ran no tests and was retained separately before the corrected invocation.

Command receipts, logs and selected final source hashes are frozen under
`test-report/deskazo-v1/checks/release-current/checkpoint/`. These are post-run
snapshots, not proof that the whole worktree was immutable during execution.
The lint-only edits occurred while unit tests were running. A narrow screen of
677 changed or nonignored untracked paths found no known private identifier or
private-key marker; it does not replace a full public-content review. No commit,
pull request or hosted CI run was created by this checkpoint. Model authorization,
provider journeys and the other V1 acceptance gates remain open.

A subsequent run resolved the overlapping-edit and incomplete test-summary gaps.
All four commands passed with identical before/after inventories of 1,942 tracked
and nonignored paths. The full unit JSON accounts for 5,836 assertions: 4,751
passed, 1,082 skipped and three pending large-account-export cases. Typecheck
reused 19 cached tasks and build reused three; the earlier uncached build remains
separate evidence. Final receipts and frozen copies are under
`test-report/deskazo-v1/checks/release-current/final/checkpoint/`. The source
inventory records symlink destinations, not unlisted target contents. The narrow
public-content screen now retains its runner, patterns and 677-file hash inventory.
This paragraph was added after the checks; no product code changed afterward.
Hosted CI, opt-in checks and live acceptance remain separate requirements.

### Backup catch-up after scheduler downtime (2026-09-20)

The extended `scripts/verify-deployment-backup.py` stops its disposable Linux
systemd container before a scheduled backup, waits past that event, and starts
the same container again. The installed persistent timer creates exactly one
new, verified snapshot. A second restart preserves the trigger receipt and does
not run the backup service again. The test changes only the calendar and delay;
the shipped service, backup wrapper and backup command remain in use.

The recovered snapshot passes the existing restore checks for database contents,
private files, owners, modes, hard links and symbolic links. Application startup
after restore remains manual. The run exits successfully, removes its disposable
containers and volumes, and leaves all pre-existing running containers at their
original start times. Source hashes and command evidence are under
`test-report/deskazo-v1/checks/backup-catchup/`.

This exercises scheduler process restart with its filesystem and persistent timer
stamp retained. The Docker daemon and host kernel remain running. Full host boot,
Docker recovery, power-loss durability, production-size data and external-provider
reconciliation remain unverified. ChatGPT authorization and the seven live-provider
acceptance journeys remain open.
The stop is graceful and happens before the event. Multiple missed daily intervals,
production randomized delay and interruption during an active backup are not
exercised. The optional verifier uses a privileged container with the Docker socket;
its generated projects and synthetic data define the test's scope.

### First hosted CI checkpoint and clean-checkout startup (2026-09-20)

The first hosted run passed root lint, typecheck, unit tests, production builds,
the Linux Electron smoke suite and Langflow checks. Integration and web E2E both
failed before tests started: top-level harness imports loaded the Prisma client
before the harness could generate it. Local runs already had that generated file,
so they did not expose the startup ordering error.

The harness now loads database-dependent E2E fixtures after Prisma generation and
only in E2E mode. A subprocess regression blocks generated-client imports to
represent a clean checkout without removing files used by running applications.
It reproduced the original module-loading failure and now reaches argument
validation. The focused regression, testkit typecheck and lint pass. Hosted rerun
acceptance was pending at this checkpoint; the result below verifies the complete
offline integration and browser runs.

Manual CI defaults now disable artifact retention and dependency/browser cache
writes. The completed first run confirms both upload steps skipped, no artifacts
retained, and deployment/mobile publication skipped. PR and main-branch behavior
is unchanged. This checkpoint is available on the implementation branch; no PR,
merge or production deployment was created. The seven live-provider journeys and
ChatGPT authorization remain open.

### Hosted CI passes after the startup repair (2026-09-20)

[The hosted run for `1908f8a0`](https://github.com/bankThanabat/rakazo/actions/runs/35506441380)
completed successfully. All seven validation jobs passed: lint, typecheck,
production builds with Linux Electron smoke, unit tests, Langflow, PostgreSQL
journeys and web E2E. The integration run completed 58 suites with 1,066 passing
assertions. All 160 product browser tests and both homepage tests passed. This
verifies generation and migration before fixture loading on a clean runner.

Both artifact upload steps were skipped and the run retained zero artifacts.
Deployment and mobile publication were also skipped. The manual run therefore
does not provide retained CI screenshots or a published release. Logs and the
final run receipt are retained locally under
`test-report/deskazo-v1/checks/ci-bootstrap/`.

These checks use synthetic accounts and offline provider substitutes. They do
not complete the seven real-provider acceptance journeys, opt-in provider checks,
physical-device or signed-upgrade acceptance. ChatGPT authorization and a dedicated
LINE recipient for authorized test messages remain pending. This status update
was written after the tested commit and changes documentation only.

### ChatGPT connection and disabled-computer recovery (2026-09-20)

Firefox now shows the subscription connected with GPT-5.6 Luna active. A private
synthetic staff message completed through `openai-codex` and produced exactly one
persisted reply, also visible after a browser reload. LINE continues to use Chrome;
all other browser work uses Firefox. No customer message or merchant write was sent.

This check exposed two disabled-computer failures. The thread response rejected
`kind: none`, preventing the conversation from loading. The shared status contract
now accepts that disabled state and hides screen and update controls. Separately,
the disabled provider's local rejection left an uncertain provisioning record.
Its typed error now clears that record because no allocation was dispatched;
unknown provider outcomes retain their existing protection against duplicate allocation.

The status regression failed before the fix. Afterward, 98 focused unit tests and
24 PostgreSQL provisioning tests passed. The provisioning regression verifies both
receipt cleanup and a later successful provider change. Contracts, adapters, API,
web and mobile typechecks passed. The running thread endpoint returned success after
the repair. The earlier hosted CI result predates these changes.

The local verification deployment now has a Docker supervisor and a computer image
built from this worktree. Its ports are published only on loopback. Recovering the
original run required removing two exact fixture receipts whose requests had been
rejected before allocation: the disabled provider and an initially invalid host
supervisor network setting. This was a bounded local repair, not a general migration
for uncertain external outcomes. The corrected setup completed the original run.

Evidence is retained locally under `test-report/deskazo-v1/checks/firefox-model/`.
The model-access blocker is cleared. Authorized LINE test recipients, merchant
workflow configuration, and the remaining real-provider journeys are still open.

### Connected product read and stream recovery (2026-09-20)

The guided product setup was exercised in Firefox with the connected ChatGPT
subscription and the owned synthetic WooCommerce store. The staff agent found the
requested SKU and reported a name and price that matched a separate provider read.
It identified currency as unavailable in its selected catalog response instead of
inventing it. The public Store API exposed the currency separately; full source
coverage and merchant onboarding remain unverified.

This exposed a web proxy failure after an API restart. The upstream event stream
closed, but Vite kept the browser response open, so the conversation stopped updating
while sidebar polling continued. Both development and preview proxies now close
the downstream response on upstream errors. The existing client then reconnects.
A real HTTP regression failed before the fix and passed afterward, including a
subsequent successful request. Eight focused proxy/subscription tests, web
typechecking and lint passed. A live Firefox check confirmed automatic reconnection
after an API/worker restart and displayed a new model reply without reloading.

Local evidence is in `test-report/deskazo-v1/checks/model-product-setup/`.
This verifies a private product read and local stream recovery, not LINE delivery,
merchant checkout, worker interruption during a provider write, or V1 completion.

### Storefront currency coverage (2026-09-20)

The WooCommerce connector now exposes `get_store_product`, a fixed read of the
published product endpoint. It returns provider storefront prices together with
currency and minor-unit metadata, sale/range data and availability. Existing admin
catalog descriptions point to this action when currency is needed. It does not
create a cart or send administrator credentials, cookies or cart capabilities.
The result represents the default storefront context, not a shopper-specific
checkout quote. Unavailable products and provider failures remain errors.

Twelve new boundary cases first failed because the action was absent. All 46
Store API and order/payment tests then passed, along with five action-effect tests
and 52 offline read-effect checks. A live request through the local connector
returned the synthetic SKU's current price with THB and two minor-unit decimals.
The disposable real-WooCommerce verifier passed 41 checks, including this read and
the existing checkout/recovery cases, and removed its containers and volumes.
Its payment fixture uses administrative confirmation, not an external payment gateway.

The patch verifier now reproduces and checks the complete release tree and can
refresh the Store API patch and source lock together. The locked connector tree
is now `f044e7762a521ad765c8dd6cd8376eebd0db5548`. This updates the local verification
connector and release sources; the hosted connector remains on its earlier tree.
Evidence is retained under `test-report/deskazo-v1/checks/product-currency/`.
The connected subscription model completed a private staff prompt through the
authenticated application API and returned the product with `THB` and `125.00`.
The receipt records nine tool calls, including two connector executions; it does
not capture their action arguments. The Mac was locked during this checkpoint,
so Firefox verification remains pending. This does not complete customer-channel
delivery or merchant acceptance.
