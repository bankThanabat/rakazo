# Instagram comment reply history evidence

Checked 19 September 2026 against Meta's public documentation and the local
OpenConnector source at revision `72735772`. No account, token, or customer
content was accessed. The upstream source was read only.

Meta supports reading replies on owned media through Instagram Login. The
current OpenConnector Instagram provider does not expose that read operation.
It also lacks the strongest documented self-author field. These are concrete
gaps in the current import path, not proof that Meta lacks reply history.

## Verified API contract

Use an Instagram User access token with `instagram_business_basic` and
`instagram_business_manage_comments`, against `graph.instagram.com`. Standard
Access covers owned or managed professional accounts added to the app;
unrelated customers require Advanced Access. The shared moderation guide
explicitly lists both comments and replies read endpoints for Instagram Login.
[Meta comment moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation?locale=en_US)

| Read | Request | Data needed by the importer |
| --- | --- | --- |
| Connected identity | `GET /{version}/me?fields=id,user_id,username` | Keep both IDs and their meanings. |
| Owned media | `GET /{version}/{user_id}/media?fields=id,timestamp,permalink` | Media IDs provide the roots of the scan. |
| Top-level comments | `GET /{version}/{media_id}/comments?fields=id,text,timestamp,from{id,username},user{id},parent_id&limit=50` | Comment IDs and customer context. |
| Replies on each parent | `GET /{version}/{comment_id}/replies?fields=id,text,timestamp,from{id,username},user{id},parent_id&limit=50` | Independently page replies, then select business-authored rows. |

The table is a proposed request contract assembled from the references, not a
record of tested live calls. `50` is the documented comments page maximum and a
conservative requested replies page size, not a verified replies maximum.
Meta's Instagram Login guide documents `/me`, `user_id`, and owned-media reads.
[Getting started](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started?locale=en_US)

The media comments edge returns top-level comments only. Nested `replies` must
be explicitly expanded, so an unexpanded comments response is not a thread.
The comments maximum is 50 per query, and comments cannot be filtered by
timestamp. Current versions return comments newest first. These facts do not
establish any ordering of replies or recent activity on their parents.
[Media comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments?locale=en_US)

The replies edge returns comment objects. Replies to a reply attach to its
top-level parent. A deleted parent prevents reading its replies. Its reference
still contains Facebook Login permission examples; use the shared moderation
guide's Instagram Login requirements instead of copying those legacy scopes.
[Comment replies](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies?locale=en_US)

## Author identity needs an explicit mapping

| Field | Documented meaning | Safe use |
| --- | --- | --- |
| `/me.id` | App-scoped user ID. | Preserve separately. |
| `/me.user_id` | Professional account ID, also the account ID in webhooks. | Route owned-media requests. |
| Comment `from.id` | Instagram-scoped ID of the comment author. | Preserve as an author ID, without assuming equality with either profile ID. |
| Comment `user` | IG User ID, returned only when the app user created the comment. | Request and preserve this affirmative evidence of business authorship. |
| Comment `from.username` or `username` | Author's username. | Display/context only; do not use alone to establish business authorship. |

Profile ID definitions come from the Instagram Login guide. Comment author,
`user`, `parent_id`, and `timestamp` definitions come from the comment reference.
The timestamp is comment creation time in ISO 8601 form. The `user` field's
conditional presence is documented.
[Profile fields](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started?locale=en_US),
[Comment fields](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment?locale=en_US)

Meta's generated Python Business SDK types `IGComment.user` as `IGUser`, and
`get_replies` accepts requested fields and parses results as `IGComment`.
That supports requesting `user{id}` and preserving an optional normalized
`userId` from `user.id`. This is first-party schema evidence for an object
shape and shared reply fields. It is not a live Instagram Login response
sample, and field availability still depends on Meta's permissions and
conditional-return rules.
[Meta SDK comment schema](https://github.com/facebook/facebook-python-business-sdk/blob/c907eb8d6c3cf9c642cabf4b537c442c302c9076/facebook_business/adobjects/igcomment.py#L124)

Meta describes an Instagram-scoped ID as specific to a person and the
professional account they interact with. The login token-exchange example
also calls its `user_id` an Instagram-scoped user ID. That terminology does
not establish an equality rule between the token response, `/me.id`,
`/me.user_id`, and a self-authored reply's `from.id`.
[Scoped IDs](https://developers.facebook.com/documentation/instagram-platform/overview?locale=en_US),
[Login token exchange](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login?locale=en_US)

Implementation rule: do not silently accept either profile ID as a match for
`from.id`, or fall back to matching a username. Prefer the documented `user`
self-author signal once the provider exposes and validates it. If that field
is unavailable, leave ownership unresolved until an authorized synthetic
account check establishes the mapping. Never treat unresolved authors as
customer or business examples by default.

## Date windows and completeness

Inference from the endpoints: a recent reply can belong to an old comment on
an old post. Traverse all accessible media, all their top-level comments, and
all reply pages before filtering by each reply's timestamp. A post or parent
timestamp outside the requested window is not a safe stopping condition.
Capture one run end time and apply the same reply-time boundaries throughout.
Missing or invalid timestamps cannot establish inclusion in the window.

The user-media reference documents a ceiling of 10,000 most recently created
media, excludes Stories, and supports media `since`/`until` parameters. Its
permission examples are Facebook Login oriented; the Instagram Login guide
establishes the equivalent owned-media path. Do not promise complete account
history beyond that documented media ceiling or use a media date filter as a
reply date filter.
[User media](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media?locale=en_US)

Graph pagination uses opaque `before`/`after` cursors and a `next` link. Empty
or short pages can still have a next page. Stop when `next` disappears, not
when an item count is below the requested limit. Cursors can become invalid
after additions or deletions, and some edges return an error when their
cursor ceiling is reached. No numeric replies page or lifetime ceiling was
verified. Media, parent-comment, and reply continuation state must remain
separate. Never present an interrupted or capped scan as complete.
[Graph pagination](https://developers.facebook.com/docs/graph-api/results?locale=en_US)

Keep provider paging URLs inside the provider. Expose cursor values plus a
`hasNextPage` flag, as OpenConnector already does. Detect repeated cursors,
missing cursors when `hasNextPage` is true, page/request budgets, and provider
errors as incomplete coverage. Stable reply IDs permit deduplication after a
restart; a saved cursor alone is not a durable resume guarantee.

## Other coverage limits

The comment reference excludes age-gated media comments and restricted users'
comments unless the restriction is removed and the comments approved. Live
comments can only be read while the media is broadcasting. These are limits
on accessible history, not evidence that no reply ever existed.
[Comment limitations](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment?locale=en_US)

Instagram Login cannot access ads or tagging. Ad comments require a different
API path, so this importer covers organic comments on owned professional
media. Do not label it an import of all Instagram communication or DMs.
[Instagram Login limitations](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login?locale=en_US),
[Non-organic comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments?locale=en_US)

Meta recommends webhooks to reduce repeated polling. This helps future
collection, but does not establish a historical retention guarantee. A scan
can hit rate limits and must retain an incomplete result or retry state.
[Moderation guidance](https://developers.facebook.com/documentation/instagram-platform/comment-moderation?locale=en_US)

## Current OpenConnector gap and acceptance checks

At the inspected revision,
[`runtime.ts`](../../infra/open-connector/src/providers/instagram/runtime.ts)
contains `get_current_user`, `list_media`, and `list_media_comments`, plus a
write-only `reply_to_comment`. It requests `from{id,username}` and `parent_id`
but not `user`; its normalizer would also discard `user`. Credential validation
prefers `userId` over `id` for the connected account. The
[`action schemas`](../../infra/open-connector/src/providers/instagram/actions.ts)
contain no read-replies action or documented self-author output. The
[`provider guide`](../../infra/open-connector/docs/instagram-oauth.md)
already warns that top-level comments do not promise a complete reply tree.

The upstream addition needed is a read-only, cursor-paginated
`instagram.list_comment_replies` action and a normalized self-author signal
whose provenance is the documented `user` field. A local adapter can be built
and tested against that future contract, but the live capability must remain
unavailable while the connected provider lacks it. Do not work around the gap
by changing the meaning of `list_media_comments`.

Before enabling live imports, an authorized synthetic account check should
record `/me` IDs and both a known business reply and a known customer reply.
Verify the `user` field, `from.id`, and `parent_id` shapes; replies created in
Instagram itself; a second reply page; and a recent reply on an old post and
old parent. Use synthetic fixtures for offline tests. Such a check was not
performed in this research, so ID equality, endpoint-specific reply caps,
and a complete-history guarantee remain unverified.
