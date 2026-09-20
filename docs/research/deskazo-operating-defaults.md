# Deskazo V1 operating defaults

Researched 2026-09-18. These are specification decisions, not implemented or
live-tested capabilities. Exact intervals and thresholds below are Deskazo
starting choices, not vendor recommendations or measured service guarantees.

## Escalation

TypeSafe recommends separate, narrow questions and application logic that
combines their answers. Choice and Score return confidence; Noul does not.
Confidence summarizes the answer distribution, not the probability that a
customer answer is correct. TypeSafe advises tuning thresholds against the
domain and consequences of errors. See the official
[introduction](https://docs.typesafe.ai/introduction),
[confidence guide](https://docs.typesafe.ai/confidence), and
[routing pattern](https://docs.typesafe.ai/patterns/confidence-routing).

Decision: use Jev to assess human requests, unresolved frustration, and whether
the available evidence supports further help. Enforce permission checks and
known provider failures in application logic. Begin with a 0.80 confidence
threshold for judgments needed to continue autonomously. Below that, ask one
safe clarification if missing customer information can resolve the issue;
otherwise ask staff. A confident decision that human help is needed must still
escalate. Validate the threshold on Thai and English merchant cases before
enabling unattended replies.

Intercom's documented handoff patterns include explicit human requests,
repetition, frustration, and rule-based escalation. Its guidance warns that
broad sentiment rules can produce unnecessary handoffs. Its procedure approvals
also separate asking a teammate for input from transferring the conversation.
These are evidence for useful workflow patterns, not a dependency on Intercom.
Sources: [escalation guidance](https://www.intercom.com/help/en/articles/12396892-manage-fin-ai-agent-s-escalation-guidance-and-rules)
and [procedure approvals](https://www.intercom.com/help/en/articles/14468561-human-in-the-loop-approvals-for-fin-procedures).

Decision: immediately hand off on an explicit human request or staff takeover.
Ask staff when required approval is missing, evidence conflicts, a consequential
provider outcome is uncertain, or two attempts fail to solve the same issue.
Mild frustration alone permits one useful attempt; continued dissatisfaction
gets human attention. Never resume merely because a timer expired.

## Alerts

LINE supports push messages to eligible users and groups. Group use requires
allowing the bot to join, adding it to the group, and obtaining the group ID
through a webhook. Only one Official Account can be in a group, and every member
can see group messages. LINE Notify ended on 2025-03-31; the documented
replacement is the Messaging API. Sources:
[sending messages](https://developers.line.biz/en/docs/messaging-api/sending-messages/),
[group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/), and
[Notify termination](https://developers.line.biz/en/news/2025/04/01/line-notify/).

Decision: the Deskazo attention inbox is authoritative. Notify the assigned
staff member, defaulting to the Space owner, through enabled app notifications.
Offer an explicitly linked staff LINE recipient or private staff group as the
first external destination, using existing OpenConnector push support. Send a
minimal reason and authenticated conversation link, not a customer transcript.
Do not infer staff identity from a LINE display name or treat a group reply as
approval. Verify the destination with a test alert during setup.

Send an alert immediately, remind once after 10 unacknowledged minutes, and
notify the owner after 30 if a different staff member was assigned. Deduplicate
the alert, stop reminders on acknowledgement, and honor configured quiet hours.
An unacknowledged item stays visible even if external delivery fails. These
intervals are a simple starting policy, not a promised human response time.

## Learning and undo

LangChain's memory documentation distinguishes per-conversation state from
memory shared across conversations. It describes updating during a response
versus background processing, noting the latency cost of the former and the
freshness tradeoff of the latter. It also describes revising instructions from
feedback. This supports separating immediate steering from longer-lived
learning; it does not require adopting LangChain.
[Official memory overview](https://docs.langchain.com/oss/python/concepts/memory).

Decision: apply steering before the next undispatched action. Queue reusable
learning after explicit staff corrections or conversation resolution, targeting
completion within five minutes while services are healthy. Ingest new social
content through supported events; otherwise check hourly, respecting provider
limits. Provide a manual refresh through the staff agent. Keep stock, prices,
and promotion validity tied to current business data rather than that schedule.

Authorized corrections and supported style changes may update automatically.
Ambiguous generalizations remain suggestions; changes to commercial rules,
tools, or permissions need the existing approval policy. Skills here include
editable instructions and procedures, not unreviewed executable code. Do not
train on the agent's own replies as if they were independent staff feedback.

Show one daily in-app summary when learning changed something, with source,
before/after, affected scope, and undo available on demand. Log each mutation
and its effective version. Undo changes future behavior and removes rejected
learning from retrieval without replaying messages, orders, or payments. If
later edits overlap, present a selective reversal for review. Suppress the same
rejected inference from the same source until new evidence or staff direction
justifies reconsideration.

## Verification required before release

Research can select defaults but cannot certify real account permissions,
webhook delivery, messaging windows, or checkout behavior. Run the acceptance
journeys in the spec with connected test accounts and a consenting pilot
merchant before labelling a provider supported. Verify Thai-language escalation,
quiet hours, notification failure, scoped learning, undo, and retry recovery.

See [history import defaults](deskazo-history-import-defaults.md) for the
30-day import and fallback-format decision, and the
[integration inventory](deskazo-integrations.md) for action-level coverage.
