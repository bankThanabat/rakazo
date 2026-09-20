# LINE OA native history import evidence

Public documentation checked 19 September 2026. The selected Thailand OA was
inspected in its authenticated web interface on 20 September 2026. No customer
export was collected.

The existence of a native LINE Official Account chat CSV export is verified.
Its exact file schema is still unverified. The public sources below describe
download controls and retention, but the investigation found no authoritative
CSV sample or field specification. Deskazo's normalized CSV/JSON contract must
not be presented as LINE's native format.

## Selected account export availability

The selected account showed the free plan. In its English web interface,
Chat settings → Basic marked Chat history backup as an upgrade and stated that
an OA Chat package subscription was required. The conversation menu also marked
Download chat history as an upgrade. Selecting it opened a subscription prompt
listing chat history download as a paid feature; closing the prompt returned to
the conversation without a download.

This establishes the export restriction for this account, not for every region
or plan. Neither export route supplied a CSV, so column names, encoding,
authorship and timezone remain unverified. The account plan and settings were
unchanged, and no message was sent. Opening the existing chat cleared its unread
badge as part of normal inbox navigation.

The user requires free options unless they approve a charge. Continue with
approved voice examples and future authorized replies. Do not scrape the inbox
into a purported native export or infer staff authorship from outbound bubbles.
Native CSV validation requires an authorized existing export, another account
with an available export, or explicit approval for the necessary subscription.
Keep that acceptance gate open; the fallback does not prove native compatibility.

## Verified behavior and coverage limits

| Evidence | Consequence for Deskazo |
| --- | --- |
| Taiwan's OA help describes web Manager → Chats → Chat settings → Basic → Chat history backup → Create new → Download. Generation is limited to once weekly; an existing file can be downloaded repeatedly. The same page describes six-month free retention and up to five years with a Chat plan. [Official help](https://help2.line.me/official_account_tw/ios/?contentId=20024280&lang=en) | A connected Messaging API credential does not establish export availability. Keep file selection and entitlement separate from connection success. |
| The Japanese chat-settings manual, updated 30 October 2025, says the backup control requires Chat Pro, covers up to five years, and includes at most 100,000 chat rooms ordered by their latest update. [Current Japanese manual](https://www.lycbiz.com/jp/manual/OfficialAccountManager/chat-various-settings/) | This is a chat-room cap, not a verified message cap. A successful download does not prove complete account coverage. |
| Taiwan's Chat plan FAQ also refers to 100,000 rooms and says paid five-year history reaches back no earlier than 1 January 2024. [Taiwan FAQ](https://tw.linebiz.com/faq/chat-advanced-plan/cm-04/) | Record the account region and observed coverage. Do not promise five years, or even the requested 30 days, for every account. |
| Thai help documents a per-chat CSV download and weekly bulk backup. Its UTF-8/Shift-JIS statement concerns Q&A uploads, not history exports. [Thai OA help](https://lineforbusiness.com/th/helpcenter/line-oa) | Per-chat and bulk samples both need validation. The Q&A encoding statement cannot establish chat-export encoding. |
| An older Thai-hosted English manual shows the per-chat download control on PDF page 13 and describes two-month text retention. [Older manual](https://lineforbusiness.com/files/LineOA_Level3.2_How%20to%20Manage%20Chat%20Effectively_compressed.pdf) | The screenshot and explanation establish a download workflow, not CSV columns. Its old retention figure must not override current regional documentation. |
| LINE's Messaging API supplies incoming text in webhook events; no API retrieves that text again afterward. [Receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/) | Messaging API connection cannot backfill historical text. Use an authorized export or approved examples, then learn from newly recorded conversations. |

The search-index excerpt for the newer [Thai OA manual](https://lineforbusiness.com/files/%E0%B8%84%E0%B8%B9%E0%B9%88%E0%B8%A1%E0%B8%B7%E0%B8%AD%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B9%83%E0%B8%8A%E0%B9%89%E0%B8%87%E0%B8%B2%E0%B8%99%20LINE%20Official%20Account%20.pdf)
describes a 100,000-message limit. Direct retrieval failed in this investigation.
That wording conflicts with the Japanese and Taiwan room limit. It is not enough
evidence for a global cap in the importer.

## Native mapping remains open

| Required detail | Status |
| --- | --- |
| CSV header names, column order, preamble or metadata rows | No verified native example found. |
| Encoding, BOM, delimiter and multiline quoting | Unverified for history exports. UTF-8 is Deskazo's accepted format, not a confirmed LINE export guarantee. |
| Date grammar, offset presence and timezone source | Unverified. Never derive timezone from browser locale or account language. |
| Business/customer/system author markers | Unverified. Display names alone cannot safely establish authorship. |
| Stable message ID and reply-parent ID | Presence and semantics unverified. Do not invent a provider message ID. |
| Thread identity and account identity | Unverified, including whether bulk export uses separate files or a thread column. |
| Attachments, stickers, deleted/unsent records, unread records and automatic replies | Native row representations and inclusion rules unverified. |
| Single-chat versus bulk export equivalence | Unverified. |

Official chat analytics describes counts such as inbound messages and active
rooms. Those fields describe analytics CSV, not transcript records.
[Chat analytics manual](https://www.lycbiz.com/jp/manual/OfficialAccountManager/insight_chat/)
Consumer LINE text backups, LMessage or other vendor formats, and Deskazo's own
normalized JSON are also insufficient evidence for a native OA mapping.

## Evidence needed to close the V1 native-export check

Obtain a current, authorized OA export containing synthetic conversations, with
account region, interface language, export mode and timezone recorded. Preserve
the original bytes privately while inspecting encoding, header and preamble.
Do not commit a customer archive.

Compare exported rows with the OA inbox for a business reply, customer message,
two different threads, Thai text, emoji, a quoted comma and multiline text. Include
a message on each side of the requested window boundary. Establish how the export
represents non-text and deleted records before deciding whether to skip them.
Confirm author roles and timezone in the import preview. Preserve available
provider identifiers and explicitly label any generated import-local identities.

Then create a synthetic fixture with the observed native layout and test mapping,
overlapping reimports and interrupted resume. Record actual accepted dates and
skipped records. Until that evidence exists, retain the native LINE mapping as
unvalidated while supporting the separately documented Deskazo format.
