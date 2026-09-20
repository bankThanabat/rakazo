# Semantic memory audit implementation notes

Checked 2026-09-19. These are implementation findings, not live-provider acceptance.

The V1 learning bridge updates audited Markdown memory. Optional semantic providers
still have a separate save/recall path. Durable staff save/removal operations now
have an independent audit record and private inspection tools. Staff can now request
selective undo of a confirmed creation and restoration of a confirmed removal.
Direct reversal controls now use the same server-derived inverse; provider acknowledgements do not imply atomic restore.

## Current application boundary

`packages/adapter-kit/src/types.ts` now requires a trusted bot/scope and the complete
reviewed fact for removal. `packages/adapters/src/memory-tools.ts` binds approval to
that scope and the configured connection revision. The executor rechecks private
owner access and the latest configuration before dispatch. Serenity re-reads the
exact fact in an allowed entity, then requires a matching expiration receipt.
Supermemory retains exact memory-entry citations and performs a bounded, paginated
lookup in the approved container before deleting that one entry. Chunk IDs and
truncated snapshots are not offered as removable citations. Equal text in different
containers keeps separate identities. Lookup and deletion share a 15-second deadline;
lookup stops after 100 pages of 50 requested entries per container. Unsupported or
malformed inspection responses stop the operation before deletion.

Both adapters mark an unconfirmed deletion as uncertain. The executor persists that
state in the external-effect ledger, preventing replay of the same action after a
lost response or a worker restart. A new approval in another run is not a global
reconciliation mechanism; inspecting the provider before proposing another removal
remains necessary.

This does not provide provider-side compare-and-delete. An edit between the scoped
read and the unscoped delete can still race. The adapter also relies on the provider
honoring entity filters when its response omits entity metadata. Approval snapshots
remain in private chat/effect history; expiration is not proof of permanent erasure.

## Supermemory contract and remaining implementation

The current [official OpenAPI specification](https://api.supermemory.ai/openapi.json)
separates v4 memory entries from v3 documents:

- `POST /v4/memories` returns a source document ID and created memory entries,
  including each entry's ID and text. The adapter now preserves the memory-entry
  receipt and the actual returned text; a document ID is never a fact ID.
- `DELETE /v4/memories` requires a container tag and accepts an ID or content.
  Its response identifies the entry and confirms forgetting. The documented
  conflict response includes an already-forgotten case.
- `PATCH /v4/memories` creates a version and returns parent/root memory IDs.
- `POST /v4/memories/list` pages entries with versions, history, source documents
  and forgotten state. The adapter now uses this path internally for exact removal
  checks. The app inspector below displays locally retained audit records;
  browsing all current provider facts remains separate work.

Do not use a document ID as a memory-entry ID. Do not treat forgetting as physical
erasure, or assume an ID-plus-content request is an atomic comparison; the schema
only documents the two selectors as alternatives. Local compatible endpoints fail removal before mutation if they lack scoped listing.
Live conformance and connection-time capability checks remain open. Both list and
delete rely on the provider enforcing container filters.

## Durable saves and inspection

Save responses retain provider-confirmed IDs, namespaces, content and creation state.
New Supermemory receipts use format version one. Only the documented `201` create
response marks a new fact; other successful responses preserve the receipt with unknown
creation state. The current public OpenAPI describes this as direct memory creation
bypassing document ingestion. This is a contract inference that still needs live
conformance, particularly for deduplication and compatible endpoints.
Serenity only acknowledges an ID and opaque status, so its content and creation state
remain null. Shared writes retain successful receipts alongside uncertain destinations.
Blank or oversized content is rejected before dispatch instead of silently saving a
prefix. A malformed, oversized, interrupted or non-success Supermemory response after
dispatch is uncertain and must be inspected before another attempt.

The executor binds durable saves to the bot, effective scope, provider and connection
revision, then rechecks ownership and that binding before dispatch. Default-policy
saves atomically claim their effect. Within a run, the same fact and destination have
one effect identity even if the model changes the tool-call ID or reason. When policy
requests approval, the complete bound request is shown; redacted or oversized details
permit denial only. This does not make approval mandatory for every save.
Both save adapters independently reject a bot mismatch, unknown scope/source, or invalid
history generation before deriving a namespace or calling the provider.

`semantic_memory_mutations` records the intent before provider dispatch. An interrupted
worker leaves an uncertain record. Completed outcomes preserve the full request and
receipts independently of the source run. `memory_semantic_history` lists ten private
records per page; `memory_semantic_read` returns versioned 1,000-character chunks.
The version hashes the full authorized snapshot, so changes to outcomes or source
visibility cannot splice two snapshots. Readers recheck the owner and active bot.
The tools remain available after provider disconnection. Account export includes the
records; deleting the owner, Space or bot cascades their deletion. Source references
are hidden when the source run is no longer accessible.

Provider outcomes and execution replay state now commit in one database transaction.
An error after either update rolls back both. A late provider acknowledgement can settle
an effect that recovery already marked uncertain, without dispatching another write.
If the source run was deleted while the call was in flight, the surviving audit still
receives its outcome. A conflicting completed or denied effect is preserved and the
caller is told to inspect the audit. Account or bot erasure never recreates audit rows.

These records cover new durable staff saves/removals through the executor and
background history saves/purges described below. They do not backfill prior writes. If recording the intent fails, provider dispatch
does not start. A process can stop between the effect claim and audit creation; the
effect remains uncertain, but no provider call has occurred in that interval.

## Selective creation undo

`memory_semantic_undo` selects one receipt by original mutation ID, fact ID and entity.
The server loads its complete text and original scope/connection for mandatory one-time
approval. Model-supplied text or authority cannot define the reversal. The executor
rechecks current ownership, scope and connection, then the original audit receipt,
before the adapter re-reads the fact and removes only that unchanged ID in that entity.
The original creation remains intact; a new `undo_save` event links to it with the
reason, responsible bot, source run, reviewed fact and actual provider outcome.

Undo requires a version-one receipt, confirmed creation and complete content. Older
unversioned creation flags remain inspectable but cannot authorize undo. Serenity's
unknown creation/content cannot authorize deletion as a reversal. A successful sibling
of a partial shared save may be undone separately; an uncertain destination cannot.

A database uniqueness constraint reserves each original fact/entity before dispatch,
including across concurrent runs. Completed and uncertain reversals keep the reservation
after source-run deletion. A definite pre-dispatch failure releases it for another
review while retaining its failed audit event. Repeated requests return the existing
undo reference and outcome status. Account export includes the reversal link.

Approval continuation prompts contain only the public tool arguments. The executor
restores the full persisted approval, including server-only authority and content,
after the runtime validates the model call. Redacted approval details remain deny-only.
The complete semantic fact limit and serialized approval bound are described below. Malformed stored approvals stop before generating the continuation.
Undo does not replay any external business action.

## Remaining implementation

Staff still need reconciliation and complete review of redacted agent approvals
and oversized non-semantic changes. The restoration path below adds
evidence-based reversal chains. A receipt with unknown
creation state cannot safely be treated as a newly created fact and deleted as an undo.
A new normal save is a new effect; creation-undo reservations prevent repeat reversals,
but the audit does not provide general cross-run provider reconciliation.
Source withdrawal, connection replacement, account erasure and future
retrieval need end-to-end acceptance for that workflow. Current validation is offline;
no live provider memory was read or mutated. Owner/configuration checks and provider
calls are separate operations, so lifecycle changes can still race an in-flight call.

## Private app history

Bot settings now include a collapsed provider-memory history on web and native. Web
also supplies the Electron interface. The read API uses the same private owner,
Space membership and active bot checks as the staff tools. It works from retained
audit rows after disconnection and never contacts the memory provider. It does not
claim to display the provider's current state.

Each expanded event shows its recorded time, current bot display name, provider,
scope, reason and available before/after content. Creation is shown as previously
absent only with a version-one confirmed creation receipt. Opaque saves and unknown
removal outcomes show unavailable versions. Partial saves keep destinations separate;
an uncertain destination cannot establish its after version. Full requested text is
shown separately only when it differs from the recorded versions. Rendering treats
provider content as plain text. Binding revisions and owner identifiers are omitted
from this app projection; the existing chunked staff audit tool retains full records.

An undo links to its original event, including records outside the loaded page.
History is ordered by creation time and identity, paginated ten rows at a time, and
merged without duplicates when following such a link. Failed reads clear private
snapshots. A mounted bot identity owns each request lifetime, so a response from an
unmounted bot cannot replace another bot's history. A source link appears only while
the run and its private thread remain readable and belong to the same owner and bot.
The unique private-thread-per-bot constraint makes the bot route identify that source.
The audit stores bot identity, not a historical display-name snapshot.

New copy is disclosed only inside the history control. "Outcome unknown" and
"The provider outcome is unknown. Verify it before another change." distinguish an
unconfirmed external operation from success. "Not stored" and "Unavailable" distinguish
recorded absence from missing version evidence. Routine settings remain collapsed.

Verification can be repeated with `bash scripts/verify-semantic-history.sh`. Its
fixture generator writes synthetic saved, opaque and uncertain-undo audit records
only into the disposable test server. Browser checks use the real authenticated API
at desktop and phone widths, including full content, original-record navigation,
pagination, failed-read clearing, keyboard scrolling and side-panel stacking.
Component tests cover the native rendering path and shared asynchronous state, but
are not device acceptance. No local Electron E2E or live-provider action is run.

Remaining work includes reconciliation, redacted agent approval UX, oversized
non-semantic reviews, native device rendering and live-provider acceptance.

## Background conversation memory

Conversation compaction now reserves a semantic audit record before dispatching a
provider save. It retains the actual provider receipts, requested summary, prior
local summary, generation and source cursor. A background operation has a real
thread source and no fabricated agent run. The audit ID reserves the thread,
generation and cursor so concurrent attempts cannot dispatch the same write twice.
The local compaction cursor remains independent of the optional provider. Failure
to reserve evidence prevents transport; a lost response or failed outcome write
leaves the reserved result unknown.

Clearing a conversation also reserves an audit before removing provider history.
It targets only the generation that was cleared. A summary written after that clear
belongs to the following generation and remains available. When an old save finishes
late, a separate purge linked to that save removes the old generation again. Failed
or unconfirmed purges remain unknown and are not automatically replayed. Generation
purges do not supply individual fact snapshots, so the app does not invent their
before/after content. Serenity does not write conversation history and returns no
creation receipts for this path.

Reservation checks current private ownership, active bot, thread, connection revision
and generation in a transaction. Provider adapters also enforce the bot and valid
generation boundary before transport. A background save's source link disappears
when its generation is cleared or its private thread is no longer readable. Receipts
survive source deletion but cascade on account, Space or bot erasure. Clearing a
conversation intentionally retains its full summary snapshots in the private audit;
it does not erase all local conversation-derived content. The clear request also
returns success when best-effort provider cleanup fails. Background
history receipts cannot authorize durable-fact creation undo, whose adapters do not
remove history namespaces.

Run `bash scripts/verify-semantic-compaction.sh` for the deterministic offline checks.
The database suite exercises compaction, an authenticated clear route, concurrent
reservations, revoked access, lost responses, failed outcome persistence and a late
save after clear. It uses disposable PostgreSQL and synthetic provider outcomes.
There is no backfill, automatic reconciliation or selective history restoration.
Checks and provider calls remain separate, so lifecycle or connection changes can
still race transport. A failed cleanup can leave data at the former provider even
though the current conversation no longer recalls its generation. Full live-provider
and native acceptance remain open.

## Restoring a recorded removal

`memory_semantic_undo` now derives the inverse action from the retained event.
A confirmed creation still removes only that unchanged fact. A confirmed removal
can restore its complete recorded text only to its original durable destination.
The server requires a matching removal receipt, complete snapshot, known entity,
private ownership and unchanged provider binding. The caller cannot supply replacement
content or select another namespace. New removal receipts retain the actual matched
entity, including when the original request omitted it. Older records without a
known destination remain inspectable but cannot authorize restoration.

One-time approval includes the server-selected `restore` action and full snapshot.
The executor revalidates that action and content inside the durable reversal
reservation. Lost responses keep the reservation uncertain; a definite failure
before mutation releases it. A new `undo_forget` event preserves the original and
records the actual restored identity and provider outcome. Shared memory restoration
writes to one selected destination, without recreating a sibling that was not removed.

The [official Supermemory OpenAPI specification](https://api.supermemory.ai/openapi.json)
documents scoped direct creation and version history. The adapter uses bounded
listing to reject an active, changed or superseded original, then creates the
reviewed text in the original container. It preserves the returned memory ID rather
than assuming the old ID can be revived. If the provider returns different text,
the receipt remains available and the outcome is uncertain. Other facts are not
updated or removed. A version-one confirmed creation receipt can authorize undo of
that restoration; the linked audit chain remains intact.

Serenity checks scoped recall before writing, remembers the reviewed text in exactly
one entity and checks subsequent recall for the returned ID and complete text.
An acknowledgement without that confirmation remains uncertain. Its creation state
remains unknown, so a Serenity restoration cannot itself authorize creation undo.
Scoped semantic recall is not exhaustive proof of absence, and external changes can
race either adapter's inspection and write. These calls do not form a provider-side transaction or provide general reconciliation,
historical identity restoration or proof of physical erasure.
Semantic save, forget and undo approvals carry the full JSON request up to 100,000
serialized characters, covering a 10,000-character fact even when JSON escaping
expands it. The existing card preserves the complete fact, reason and destination.
Redacted details remain deny-only. This does not lift the 4,000-character limit for
Markdown memory reversals, learning proposals, skills or purchases; those workflows
still need a separate complete-review path when their payload exceeds that limit.

The deterministic checks are in `scripts/verify-semantic-restoration.sh`. They cover
adapter boundaries, database inverse derivation, reversal chains and authenticated
approval continuation through the real executor using synthetic provider state.
Successful restore journeys inspect later recall, including a selected shared
namespace. They do not establish live-provider, direct app-control or native acceptance.


`scripts/verify-semantic-approval-detail.sh` checks the larger semantic approval path.
Its executor journeys use synthetic 10,000-character facts for save, forget, creation
undo and removal restoration. They compare the persisted request and displayed
approval, then verify that resumed execution uses the approved fact despite changed
model arguments. Browser checks read the stored card after reload and scroll through
it at desktop and phone widths. These checks use offline providers and do not prove
native device usability or live-provider acceptance.


## Direct staff reversal review

Staff can select a recorded fact in bot settings, give a reason, preview its complete
inverse, and confirm removal or restoration. Web and native use the same request
state. The server derives content, destination and action from retained evidence;
the client cannot replace them. A preview hash binds the owner, original receipt,
reason, scope and connection revision. Apply rechecks that evidence before reserving
an uncertain audit event and again after resolving the provider for dispatch.
A lifecycle change after that check can still race the provider call.

A staff intent has a deterministic identity derived from its owner, bot and client
nonce. Concurrent copies of that request return the retained event, and a unique
reversal key prevents different requests from reversing the same fact again.
Completed and uncertain results keep that key. Definite failures retain their audit
but release the key for a new reviewed attempt. Confirmed staff reversals can be
reversed in turn; background history records remain excluded. Staff records retain
the owner and a staff source marker, without inventing an agent run or conversation
source link.

A lost apply response clears visible private snapshots and offers "Retry confirmation"
with the exact reviewed nonce. Explicit access or conflict errors discard that retry.
Reloading history also discards it. A successful retry reads the retained event; it
does not send the provider operation again. Provider disconnection can prevent the
apply endpoint from returning a cached result, but retained history remains readable.
These controls neither reconcile unknown provider outcomes nor restore unknown facts.

New copy appears only after selecting a fact or encountering a failed confirmation.
"Reason for undo", "Preview change", "Confirm removal" and "Confirm restoration"
identify the review steps. The full fact remains keyboard-scrollable in the existing
bounded version region. "Could not confirm the change. Retry or reload history."
provides recovery only when the confirmation response is ambiguous.

Run `bash scripts/verify-semantic-direct.sh` for types, shared/native component tests,
real database service checks, audit regressions and authenticated browser journeys.
The browser fixture uses the real Supermemory adapter against a loopback HTTP service,
including a completed provider write whose API response is deliberately dropped.
It verifies one provider write across a same-nonce retry, then restores the exact
10,000-character fact to the selected namespace. This is offline conformance evidence,
not live-provider or native-device acceptance.
