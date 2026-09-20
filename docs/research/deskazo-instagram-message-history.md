# Instagram conversation history evidence

Checked 19 September 2026 against primary Meta documentation and Meta's
generated SDK. No live account, token, or customer message was accessed.

Instagram Login supports conversation history reads, but message details are
limited to the 20 most recent messages in each conversation. Listing older
message IDs does not make their text accessible. This cannot promise the
complete 30 days requested by [V1](../deskazo-v1-spec.md). Import available
business replies, retain customer text only as context, and report the actual
coverage. The API does not establish which business replies were written by
human staff.
[Instagram Login conversations guide](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api?locale=en_US)

## Verified reads and access

All requests below use `graph.instagram.com`, an Instagram User access token
from someone who can manage the professional account's messages, and both
`instagram_business_basic` and `instagram_business_manage_messages`.
Standard Access covers owned or managed accounts added to the app; other
accounts require Advanced Access.

| Purpose | Documented request | Result |
| --- | --- | --- |
| List conversations | `GET /{version}/{IG_ID}/conversations?platform=instagram` or `/me/conversations` | Conversation IDs and `updated_time`. |
| Find a customer's conversation | Same endpoint with `user_id={customer_IGSID}` | Matching conversation ID. |
| List message references | `GET /{version}/{conversation_id}?fields=messages` | Nested `messages.data`, with IDs and `created_time`. |
| Read one message | `GET /{version}/{message_id}?fields=id,created_time,from,to,message` | Sender, recipients, creation time, and text when available. |

These are the guide's explicit operations. Its message-list examples identify
the first item as most recent, but do not state a complete ordering contract.
Some sample URLs mistakenly start fields with `&`; actual requests need `?`.
[Instagram Login conversations guide](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api?locale=en_US)

The linked shared reference also documents `GET /{conversation_id}/messages`.
It returns Message objects. Meta's `UnifiedThread.get_messages` SDK method
uses that edge, accepts requested fields, and returns an edge response.
This supports a separately paginated message-reference action. The shared
reference's Page token and Facebook scopes are for Facebook Login; use the
Instagram Login guide above for this connector's authentication.
[Conversation messages reference](https://developers.facebook.com/docs/graph-api/reference/conversation/messages?locale=en_US),
[Meta SDK](https://github.com/facebook/facebook-python-business-sdk/blob/500cfa19b9ba4b327e5c2f025863721ffc365c5f/facebook_business/adobjects/unifiedthread.py)

Individual detail reads are the documented path to message content. Field
expansion might combine reads, but no Instagram Login example inspected here
demonstrates complete expanded detail pages or bypasses the 20-message limit.
Use the explicit path first; do not advertise an expansion shortcut as tested.

The overview says Advanced Access requires App Review and Business
Verification. It also warns that some Standard Access features might not work
properly until Advanced Access is granted. These are runtime acceptance
requirements, not facts that offline fixtures can prove. Conversations API
rate limiting is 2 calls per second per professional account.
[Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview?locale=en_US)

## Message identity and direction

The message reference defines `from` as an object, and `to` as an object with
a `data` array. Each participant has an `id` and may have a `username`. A
customer's ID is Instagram-scoped; the business's ID is its professional
account ID. `created_time` is a datetime. Fields without data are omitted.
[Message fields](https://developers.facebook.com/docs/graph-api/reference/message?locale=en_US)

For Instagram Login, `/me.id` is app-scoped while `/me.user_id` is the
professional account ID, also named `IG_ID`. Keep both as opaque strings.
The inbound DM example uses the customer's IGSID for `from.id` and `IG_ID`
for `to.data[0].id`. These definitions support comparing DM participants with
the connected `/me.user_id`. Do not compare against either ID indiscriminately
or infer ownership from usernames. The separate
[comment ID caveat](deskazo-instagram-reply-history.md) does not establish DM
identity rules.
[Profile fields](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started?locale=en_US),
[DM example](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api?locale=en_US)

Proposed interpretation, derived from those definitions:

- Exact sender match with the professional account identifies an outbound
  business-account message. It does not identify a particular staff member.
- A different sender plus an exact professional-account recipient match
  identifies incoming context.
- Missing, contradictory, or malformed participant IDs leave direction
  unknown. Preserve the source values; exclude unknown rows from voice
  learning rather than guessing.

The conversation reference similarly types participants as customer scoped
IDs or professional account IDs. Its `is_owner` describes which app currently
controls replies, not who authored a historical message. Its `updated_time`
is when the latest message was added, not conversation creation time.
[Conversation reference](https://developers.facebook.com/docs/graph-api/reference/conversation?locale=en_US)

## Retention, pagination, and the fixed window

The 20-message detail ceiling is also stated in the shared conversation
reference. Older message queries can return an error saying the message was
deleted. That error alone does not prove a user deleted the message.
[Conversation limitations](https://developers.facebook.com/docs/graph-api/reference/conversation?locale=en_US)

Conversations in Requests that have been inactive for 30 days are omitted.
This is not a general 30-day retention rule for all folders, and it does not
guarantee 30 days of accessible details. Shares expose only their image/video
URL in the conversations guide.
[Instagram Login limitations](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api?locale=en_US)

Graph pagination can return short or empty pages with a next link. Stop on
absence of `next`, not an item count. Cursors can become invalid after items
change, so they are not permanent checkpoints. Keep provider paging URLs
inside the connector and expose opaque cursors plus `hasNextPage`.
[Graph pagination](https://developers.facebook.com/docs/graph-api/results?locale=en_US)

The Page conversations reference explicitly says time pagination is
unavailable. No Instagram Login source inspected here establishes `since` or
`until` filters, configurable chronological ordering, a numeric conversation
page maximum, or a total conversation ceiling. Do not invent those guarantees
from the message detail limit or copy Page-specific folder behavior.
[Page conversations reference](https://developers.facebook.com/docs/graph-api/reference/page/conversations?locale=en_US)

Implementation consequences for V1:

1. Fix the end at connection time and start 30 days earlier. Resume with the
   same boundaries. Filter individual message timestamps, not conversation
   creation dates or the date the importer runs.
2. Visit accessible conversations independently of age or list position. A
   recent business reply can belong to a years-old conversation. Do not stop
   the conversation scan when one item is old without verified ordering.
3. Page message references independently, then read eligible details with a
   bounded request budget. The detail ceiling applies at request time, so new
   activity may make previously eligible IDs unavailable during a run.
4. Deduplicate by stable provider message ID and conversation/account scope.
   Keep incomplete scans, unreturned details, malformed timestamps, and
   unsupported content visible as gaps. Exhausting accessible pages does not
   establish complete 30-day history.

## Attachments, deletion, and automation provenance

The shared message reference documents attachments, shares, reactions, and
story context. These are distinct from message text; attachment URLs and
template labels are not staff prose. The reference contains older Facebook
Login requirements, so availability of optional content fields still needs
Instagram Login acceptance. The first connector contract can import text only
and skip missing/empty text with a coverage reason.
[Message content fields](https://developers.facebook.com/docs/graph-api/reference/message?locale=en_US)

Instagram's webhook reference includes `is_deleted` and a `message_edit`
event. The Messenger Instagram webhook guide describes `is_echo` as a message
sent by the business. These are event fields; the inspected historical
Message reference does not promise them in GET responses. An echo identifies
outbound direction, not human authorship. No verified historical field names
the employee, originating app, automation, or AI model.
[Instagram webhook reference](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram?locale=en_US),
[Instagram Messaging webhooks](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks?locale=en_US)

Self Messaging allows one professional account to act as both business and
customer, with a separate scoped recipient ID. Meta documents `is_self` in
webhooks for this case. A business sender match therefore does not by itself
prove a genuine customer interaction. Historical self-message flags and
exclusion require live validation or an independently verified mapping.
[Self Messaging](https://developers.facebook.com/documentation/instagram-platform/self-messaging?locale=en_US)

Read access and send eligibility are separate capabilities. The messaging
guide's ordinary 24-hour reply window concerns sending, not a history read
retention limit. Reading through the API does not mark an inbox message read;
sending a reply does. The importer must remain read-only.
[Instagram Login messaging](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api?locale=en_US)

## Proposed small connector contract

Expose three read actions, with permission checks on every action:

| Action | Input | Normalized output |
| --- | --- | --- |
| `instagram.list_conversations` | `after?`, `before?`, `limit?` | `conversations: [{id, updatedTime?}]`, `paging` |
| `instagram.list_conversation_messages` | `conversationId`, `after?`, `before?`, `limit?` | `messages: [{id, createdTime?}]`, `paging` |
| `instagram.get_message` | `messageId` | `message: {id, createdTime?, text?, from?: {id, username?}, to?: [{id, username?}]}` |

This is a proposed contract. Enable imports only when the deployed connector
exposes the required actions and permissions. Reuse cursor metadata from other
Instagram list actions. A requested page size of 20 is a conservative local
choice, not Meta's documented page maximum. Preserve offset-bearing
timestamp strings; do not assume timezone from account locale. Keep identifiers
as strings, including nonnumeric message IDs. Missing text remains missing,
not a fabricated empty reply. Do not derive `staff`, `human`, or `automated`
inside the connector.

Separate reference pages from detail reads so a failed detail request does
not discard the conversation. Map auth and rate errors through the existing
provider error contract. A caller-supplied message ID is not evidence that it
belongs to the selected conversation; import only IDs discovered while
traversing that account's conversation and retain that association.

## Acceptance still needed

Use an authorized synthetic professional account to confirm both inbound and
outbound IDs against `/me.user_id`, the exact datetime forms, two conversation
pages, message-edge cursors, and detail behavior around the 20th and 21st
messages. Check a recent staff reply in an old conversation, a message sent in
Instagram itself, an automated message, a self-message, an attachment-only
message, edits, deletion, and permission revocation. Test Standard/Advanced
Access separately where applicable.

Offline tests can verify request construction and normalization with synthetic
fixtures. They cannot prove historical completeness, human authorship, or live
permission approval. Keep those distinctions in the import preview and use
reviewed examples when provenance or history is insufficient.
