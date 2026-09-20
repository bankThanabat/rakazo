# Deskazo history import defaults

Research date: 18 September 2026. Specification decisions only. No importer was
implemented, no merchant account was connected, and no live integration passed
acceptance in this research.

## Recommended V1 decision

Request the previous 30 days, ending at the recorded connection time for the
initial import. Keep that window fixed across retries and fallback uploads. Treat this
as Deskazo's requested range, not a provider guarantee. Import the business's own
comment replies and outgoing staff messages as brand-voice examples. Customer
messages supply conversation context only. Preserve timestamps, authorship and
source references; report missing dates, inaccessible threads and skipped records.

The onboarding result should say how many business replies were imported and the
actual earliest/latest timestamps. It must distinguish a successful empty result,
partial access and a failed import. A partial history can support a pilot once
the merchant reviews the examples and generated voice document. It cannot be
labelled a complete archive.

## Provider evidence and connector gaps

| Source | What the provider permits | Existing OpenConnector coverage | V1 decision |
| --- | --- | --- | --- |
| LINE OA messages | The Messaging API supplies new text through webhooks and provides no API to retrieve that text again. This rules out automatic pre-connection text backfill. [LINE receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/) | Five profile/push/broadcast actions; no history action. [Immutable action source](https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/line/actions.ts) | Import an authorized CSV export when available; otherwise approved examples and new conversations. Record Deskazo's own sends. Do not assume OA Manager or another vendor's staff replies appear in incoming webhooks. |
| LINE OA export | Thai official help documents individual chat CSV downloads and bulk history backup that can be created once per week. The Thai OA Chat Package can expose up to five years, excluding records before 1 January 2024. Availability and retained content still depend on the merchant account. [Thai LINE OA help](https://lineforbusiness.com/th/helpcenter/line-oa) | No export-download action established. | Merchant downloads the file; staff agent maps it into Deskazo's import fields with a preview. Filter by message time to the requested 30 days. Verify the actual Thai CSV layout in pilot. |
| Instagram comments | Meta supports managing comments on owned professional-account media. Its documented Facebook Login API uses cursor pagination and does not support result ordering; only insights support time-based pagination. [Meta's official API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) | `list_media_comments` explicitly returns top-level comments, not a complete reply tree. `reply_to_comment` writes a reply; it does not retrieve old replies. [Immutable action source](https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/instagram/actions.ts) | Validate and add retrieval of business-authored nested replies before claiming automatic brand-voice history import. Select replies by reply timestamp. A recent reply on an older post belongs in the 30-day range. Do not scan only recently published posts. |
| Instagram DMs | Meta's Conversations API documents conversation lists, message lists, sender and timestamp information, and past inbox syncing. Requests inactive for 30 days are excluded. Its documented Facebook Login path requires linked-Page permissions and Advanced Access for external customers. [Meta Conversations API](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a) | Existing connector uses Instagram Login and has send-message but no DM history action. The login paths have different authorization requirements. [Provider source](https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/instagram/definition.ts), [actions](https://github.com/oomol-lab/open-connector/blob/20f86718e7bb938c2d4380c8bbb335cbaebb94bc/src/providers/instagram/actions.ts) | Add and validate the history path for the chosen login flow. Import reachable messages within 30 days and declare exclusions. Do not promise all 30 days or an unlimited per-conversation archive. |

Meta's direct Conversations API pages could not be retrieved during this pass.
The accessible first-party collection does not establish a per-conversation
message ceiling for the connector's Instagram Login path. Treat that ceiling,
nested-reply completeness, pagination and account eligibility as pilot checks,
rather than filling the gaps with third-party claims.

## Fallback file contract

Choose UTF-8 CSV and a JSON array using the same record fields as the documented
V1 import formats. This is a Deskazo product decision, not a claim that all
providers export this schema or that an importer already exists.

| Field | Requirement |
| --- | --- |
| `thread_id` | Required stable identifier within the selected source account. |
| `message_id` | Required stable source ID, or an import-local ID generated from the source file and row when absent. |
| `sent_at` | Required ISO 8601 timestamp with offset. If the file omits a timezone, confirm the account timezone before import. |
| `author_role` | Required `business`, `customer` or `unknown`. Only verified `business` text becomes a voice example. |
| `text` | Required for V1 text history. Preserve Thai, emoji, quoted commas and multiline replies. |
| `reply_to_id`, `source_url` | Optional parent reference and original source link. |

Select the provider and account once per import, rather than asking the user to
repeat them in every row. Staff-assisted CSV column mapping must preview the
role, date and text interpretation before saving. Unknown authors or dates must
be flagged, never guessed silently. Reimporting the same file or overlapping API
history must not create duplicate examples. Keep the original import identifier
and row reference for audit and removal.

LINE OA CSV is the first provider-native mapping to validate. LINE's personal
consumer app also exports `.txt`, but this is a different product and not proof
of an OA archive format. [LINE text export](https://help.line.me/line/ios/?contentId=20007388).
Meta confirms that Instagram information can be downloaded through Accounts
Center, but this pass could not verify the current export schema from accessible
first-party documentation. Do not promise a universal Meta ZIP/HTML importer.
[Meta information downloads](https://about.fb.com/news/2023/10/manage-your-information-across-apps/).
Unsupported exports can be mapped to the documented CSV/JSON contract or reduced
to merchant-approved examples; no screenshot or PDF transcript parsing is a V1
requirement.

## First pilot acceptance gates

These are proposed release checks, not completed tests.

1. Connect a real authorized merchant account using the chosen app/login flow.
   Verify account identity, permissions and access to non-app-role customers.
2. Compare a merchant-reviewed sample with the source inbox. Include Thai text,
   emoji, an outgoing staff reply, a nested comment reply, a recent reply on an
   old post, and timestamps at both edges of the 30-day window.
3. For LINE, validate the merchant's actual CSV columns, timezone and author
   mapping. State API backfill is unavailable. Verify new incoming webhooks and
   Deskazo outgoing records separately from historical imports.
4. For Instagram, verify reachable conversation depth, nested replies and
   pagination with a busy thread. Record missing Requests and other exclusions.
5. Reimport overlapping data and interrupt/resume the import. Counts and learned
   examples must remain stable; pagination errors must produce a partial result.
6. Verify only authorized business replies shape shared voice. Source revocation
   stops refresh. Removal withdraws examples from future learning and marks
   affected learned changes for review. LINE recommends removing unsent content
   from storage and future use. [LINE unsend handling](https://developers.line.biz/en/docs/messaging-api/receiving-messages/#processing-on-receipt-of-unsend-event)
7. Merchant reviews the generated voice document and sample customer replies
   before enabling automatic replies. Audit the import range, source, mapping,
   skipped records and resulting document version without duplicating private
   message content in the audit log.


## Normalized import implementation update, 19 September 2026

Owner-approved `customer_learning_history_start` now consumes a private archive
created by `customer_learning_archive_import`. `customer_learning_histories` returns
its approved source/scope, fixed window, processed count, accepted replies, skipped
records, duplicates, dates and errors. A stopped job resumes with the same approved
arguments. A completed export does not establish complete provider coverage.

Inputs remain UTF-8 CSV or a JSON array, at most 10,000 rows and 1,000,000 characters.
Only `business` rows with a valid timezone-qualified timestamp, thread ID and text
inside the preceding 30 days are eligible. Message IDs must be strings when present.
Without one, thread ID and normalized reply timestamp identify the message. Text
changes produce new evidence. Thread and message IDs are limited to 1,000 characters;
individual text to 13,000, and serialized reply evidence to 14,000. Oversized records
are skipped before duplicate markers are written. Raw archives preserve extra source
fields, including parent references and source URLs. Thread IDs, message IDs and these extra fields stay out of model input; learning batches contain only reply dates and text.

The preview counts all eligible rows, while its text excerpt is limited to 14,000
characters. Each job processes up to 100 original row positions and atomically writes
private learning batches, message/content hashes and progress. The original archive
window never advances on retry. For connected sources, its end must equal the
connection creation timestamp. An offline source has an explicit stable key approved
by its owner, reused across overlapping exports. Scope and source cannot change when
resuming an existing job. Both inference and document writes recheck source access. Connected deduplication is scoped to the same local connection record and binding. Replacing that record creates a new namespace and can relearn overlapping exports; an old interrupted job cannot be rebound. Offline source keys remain stable across exports.

Historical replies are style evidence. They do not establish current prices or
commercial policies. Existing learning review, revision and undo paths apply.
Removing the archive erases raw content and captured tasks while retaining duplicate
hashes until bot deletion. Existing learned documents remain available for explicit
undo. The source settings tool reports this before approval.

This implementation does not establish compatibility with a native LINE CSV layout.
See [the native-export research](deskazo-line-history-import.md) for the remaining
schema and synthetic-sample gate. No real LINE history was imported in this work.
