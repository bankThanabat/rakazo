# Customer channel adapter contracts

Researched 2026-09-10 for Rakazo's custom Chat SDK adapters. This note distinguishes provider documentation from independently inspected Chatwoot implementation evidence. No live accounts or provider approvals were used. Chatwoot source was inspected at commit `9d8d46a3aff90e5d1532e476617bfb8855300150`; its implementation is a cross-check, not a substitute for approval or a live conformance test.

## LINE

A business creates a LINE Official Account and enables its Messaging API channel. Store its channel secret separately from its channel access token. The former verifies inbound requests; the latter authorizes outgoing API calls. [Account setup](https://developers.line.biz/en/docs/messaging-api/getting-started/)

Verify `x-line-signature` against Base64(HMAC-SHA256(channel secret, raw request body)). Verify the exact received bytes before JSON parsing. Missing or mismatched signatures must not enter message processing. LINE's webhook verification is a signed POST containing `{destination, events: []}`, which should receive HTTP 200; it is not a GET challenge. [Signature verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

Incoming payloads contain `destination` and `events[]`. A message event has `webhookEventId`, `timestamp`, `source`, and `message`; text messages expose `message.id`, `message.type = "text"`, and `message.text`. Sources distinguish user, group, and room IDs. Handle all events in a batch. Redelivery can repeat an event and arrive out of order; use `webhookEventId` for receipt deduplication and `message.id` for message identity. Text cannot subsequently be fetched from LINE. Media content uses `GET https://api-data.line.me/v2/bot/message/{messageId}/content` with the channel token. [Receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

Outgoing text uses `POST https://api.line.me/v2/bot/message/push`, `Authorization: Bearer <channel-token>`, JSON `{to, messages: [{type: "text", text}]}`. `to` is the source user/group/room ID. At most five message objects are allowed. The success payload includes `sentMessages[].id`. Image objects use `originalContentUrl` and `previewImageUrl`. Push is allowed for friends, joined groups/rooms, and non-friends who messaged the account within seven days. A 200 response does not prove customer delivery. The documented push limit is 2,000 requests/second. Reply messages instead use `/v2/bot/message/reply` with `replyToken`; that token is one-use and normally expires one minute after receiving its webhook. [API reference](https://developers.line.biz/en/reference/messaging-api/)

Assign a persistent UUID `X-Line-Retry-Key` on the first push attempt and reuse it for retries. A repeated accepted request returns 409 with the accepted request ID; push retries can also return the original sent message IDs. Retry keys last 24 hours. Do not add retry keys to the reply endpoint. [Retry semantics](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)

Implementation recommendation: use push for asynchronous bot/staff replies, rather than retaining a short-lived reply token. Scope recipient IDs to the configured connection. Retain a separate delivery state instead of interpreting provider acceptance as a read receipt.

## Instagram with Instagram Login

Use the Instagram Login API variant consistently: the host is `graph.instagram.com`, and the token is an Instagram User access token. Required messaging permissions include `instagram_business_basic` and `instagram_business_manage_messages`. Accounts must be professional accounts. Serving businesses the developer does not own/manage requires Advanced Access; Standard Access covers owned/managed accounts added to the app dashboard. Do not mix these credentials with the Facebook Login variant's Page tokens and `graph.facebook.com` host. [Meta's maintained API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-ab559ffb-8e2c-4b0a-b43a-5737b6d2f672)

Meta's webhook handshake accepts GET `hub.mode=subscribe`, validates `hub.verify_token`, and returns the plain `hub.challenge`. POST verification compares `X-Hub-Signature-256: sha256=<hex>` with HMAC-SHA256(app secret, raw body), using constant-time comparison. Verify the algorithm prefix as well as the digest. This is corroborated by Meta's own maintained webhook sample; the main Graph documentation returned HTTP 429 during this investigation. [Meta sample](https://github.com/fbsamples/messenger-platform-samples/blob/main/messenger-api/messenger-api-and-webhooks/app.py)

Chatwoot's Instagram fixtures show `entry[].messaging[]` containing `sender.id`, `recipient.id`, `timestamp`, and `message`. Message identity is `message.mid`; content can be `text` or `attachments[]` with `type` and `payload.url`. `message.is_echo`, `message.is_deleted`, and read notifications are distinct from new customer messages. Shared stories/reels have additional payload shapes. Validate the intended account and ignore outgoing echoes for bot activation. These are implementation observations, not newly verified provider schema guarantees. [Pinned fixtures](https://github.com/chatwoot/chatwoot/blob/9d8d46a3aff90e5d1532e476617bfb8855300150/spec/factories/instagram/instagram_message_create_event.rb), [pinned controller](https://github.com/chatwoot/chatwoot/blob/9d8d46a3aff90e5d1532e476617bfb8855300150/app/controllers/webhooks/instagram_controller.rb)

Send text with `POST https://graph.instagram.com/{api-version}/{ig-account-id}/messages`, Bearer authorization, and JSON `{recipient: {id: customerIGSID}, message: {text}}`. The returned identifiers are `recipient_id` and `message_id`. [Meta text request](https://www.postman.com/meta/instagram/request/1rgmhuk/text-message)

Media uses the same endpoint and recipient with `message.attachment = {type: "image" | "audio" | "video", payload: {url}}`. Keep the Graph API version configurable at the adapter connection boundary. [Meta media request examples](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-8365d531-b49f-4e07-8e76-19f8608947a3)

Conversations must be initiated by the Instagram customer. Group messaging is unsupported. API calls omit Requests-folder messages inactive for 30 days. [Meta Send API prerequisites](https://www.postman.com/meta/instagram/folder/uxudqu0/send-api)

The standard response window is 24 hours. The `HUMAN_AGENT` tag permits actual human support within seven days, requires the Human Agent permission, and explicitly excludes automated messages. Never attach that tag to AI replies. No current numeric Instagram messaging rate limit was verified in this investigation; handle provider throttling and do not substitute the unrelated content-publishing quota. [Meta Human Agent rules](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-af579d08-121e-4897-8f45-5fd41ace49df)

## TikTok Business Messaging

TikTok's public documentation navigation confirms Business Messaging access, security/privacy review, authentication, messaging limits, send/list/media APIs, and webhook configuration. The relevant dynamic document bodies were not readable in this research session. This does not prove they are universally private. Exact account/region eligibility and current numeric messaging limits remain unverified. The public official Business SDK tree inspected did not expose Business Messaging implementations. [Business documentation](https://business-api.tiktok.com/portal/docs?id=1832184403754242), [official SDK](https://github.com/tiktok/tiktok-business-api-sdk)

TikTok's official generic webhook contract uses `TikTok-Signature: t=<unix-seconds>,s=<hex-digest>`. Compute HMAC-SHA256(client secret, timestamp + "." + raw request body); verify the digest and reject stale timestamps. Chatwoot uses this same algorithm for Business Messaging, corroborating applicability. A bounded absolute clock-skew check is preferable to checking only old timestamps. [TikTok verification](https://developers.tiktok.com/docs/en/webhooks-verification), [pinned Chatwoot webhook](https://github.com/chatwoot/chatwoot/blob/9d8d46a3aff90e5d1532e476617bfb8855300150/app/controllers/webhooks/tiktok_controller.rb)

The generic webhook documentation requires HTTPS, immediate HTTP 200 acknowledgment, and idempotent handling because deliveries can repeat. Retries can continue for 72 hours. Confirm Business Messaging-specific retry behavior with the approved account before operational sign-off. [TikTok webhook delivery](https://developers.tiktok.com/docs/en/webhooks-overview)

Chatwoot's pinned client supplies the following independently inspectable wire contract. These details remain implementation evidence until tested against an approved TikTok business app. [Client source](https://github.com/chatwoot/chatwoot/blob/9d8d46a3aff90e5d1532e476617bfb8855300150/app/services/tiktok/client.rb)

- Base: `https://business-api.tiktok.com/open_api/v1.3`.
- Text: POST `/business/message/send/`, header `Access-Token`, JSON `{business_id, recipient_type: "CONVERSATION", recipient: conversationId, message_type: "TEXT", text: {body: text}}`.
- Success requires both HTTP success and JSON `code === 0`; sent ID is `data.message.message_id`.
- Images: multipart POST `/business/message/media/upload/` with `business_id`, `media_type: "IMAGE"`, and `file`; obtain `data.media_id`, then send `message_type: "IMAGE", image: {media_id}`.
- Query `/business/message/capabilities/get/` with business/conversation IDs, `conversation_type: "SINGLE"`, and JSON `capability_types: ["IMAGE_SEND"]`; inspect `data.capability_infos[].capability_result`.
- Download: POST `/business/message/media/download/` with business, conversation, message, and media IDs plus media type; response `data.download_url`.

Incoming Business Messaging events observed in Chatwoot use outer `{event, user_openid, content}`, where `content` is a JSON **string**. `user_openid` identifies the business account. `im_receive_msg` is incoming; `im_send_msg` is an outgoing echo/direct-app message; `im_mark_read_msg` is a read notification. [Event router](https://github.com/chatwoot/chatwoot/blob/9d8d46a3aff90e5d1532e476617bfb8855300150/app/jobs/webhooks/tiktok_events_job.rb)

Parsed message content has `conversation_id`, `message_id`, millisecond `timestamp`, lowercase `type`, `from`, `from_user.id`, `to`, and `to_user.id`. Text is `text.body`; images expose `image.media_id`; shared posts expose `share_post.embed_url`. Quote metadata is `referenced_message_info.referenced_message_id`. Check that the outer account and inner recipient belong to the configured connection before routing; deduplicate by connection plus message ID. [Message parser](https://github.com/chatwoot/chatwoot/blob/9d8d46a3aff90e5d1532e476617bfb8855300150/app/services/tiktok/message_service.rb)

Chatwoot's auth client requests `message.list.read`, `message.list.send`, and `message.list.manage` along with profile scopes. It exchanges authorization codes at `/tt_user/oauth2/token/` and refreshes at `/tt_user/oauth2/refresh_token/`. Both use JSON credentials in their own auth exchange, not the messaging `Access-Token` header. Its webhook registration uses `/business/webhook/update/` with `event_type: "DIRECT_MESSAGE"`. These are connection-setup observations; they do not establish that Rakazo's app has approval. [Auth source](https://github.com/chatwoot/chatwoot/blob/9d8d46a3aff90e5d1532e476617bfb8855300150/app/services/tiktok/auth_client.rb)

## Offline verification contract

The following are Rakazo implementation requirements, not claims about undocumented provider behavior:

1. Each adapter's fixture suite signs exact raw payload bytes and proves missing, altered, wrong-account, and replayed inputs cannot create customer messages.
2. Repeated provider messages create one durable customer message. Provider acceptance is distinct from delivery/read status.
3. Text and media fixtures assert complete outbound method, URL, authentication, payload, and response-ID mapping without network calls.
4. Unknown events and unsupported media degrade explicitly, without inventing text or silently promising successful delivery.
5. Customer identity and conversation keys include the business connection. Staff takeover suppresses pending bot sends even if model generation already began.
6. Instagram policy windows and TikTok eligibility are explicit deployment checks. Fixture success is not evidence of live platform approval.
