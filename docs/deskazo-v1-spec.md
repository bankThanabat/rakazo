# Deskazo V1 specification

Status: V1 target specification. Implementation is in progress; requirements below
are acceptance criteria, not claims of completed or live-provider-verified behavior.

## Product and audience

Deskazo is an AI admin team for small and medium e-commerce businesses that
cannot keep up with customer chats and comments. It helps answer customers in
the business's voice, assist purchases, bring in a human when needed, and finish
the configured administrative work after a sale.

The owner manages the system by talking to a staff agent. The staff agent helps
configure customer agents, tools, knowledge, and business rules. Customer agents
handle customer-facing conversations using that approved setup.

The main experience must work without asking a business owner to understand
agent infrastructure, edit prompts, or build workflows in a separate editor.
Focused forms remain appropriate for credentials, account authorization, and
reviewing consequential changes.

## Core journey

1. Install Deskazo and complete guided setup with the staff agent.
2. Connect the business's online store and selected social media accounts.
3. Let the staff agent learn the brand's writing style from authorized social
   posts, the business's past social-media comment replies, and past replies in
   messaging apps the user connects, covering the 30 days before connection.
   Accept approved examples or supported exports when a provider cannot supply
   that history, and show any gaps in coverage.
4. Upload or connect product information, SKUs, stock, promotions, and relevant
   business policies. Confirm which sources are current and authoritative.
5. Review the learned voice and try sample customer situations before enabling
   customer replies.
6. Start responding to incoming chats and comments, answer product questions,
   and help customers progress toward a purchase.
7. Alert a human when attention is needed. Let the human steer the active
   customer agent or take over the conversation.
8. Help close the sale using the connected provider's checkout, payment
   confirmation, and order-creation structure, configured with details the user
   supplies through the staff agent. Report confirmed outcomes; do not treat a
   customer's interest as a completed sale.
9. Create an invoice when a human requests it or an explicitly configured rule
   authorizes it.
10. Enter the configured information into a CRM or Google Sheet when the owner
    has enabled that destination and mapping.
11. Learn from updated social content and human steering so future conversations
    handle similar situations better.

## Core V1 features

| Must-have | Minimum V1 behavior |
| --- | --- |
| Staff agent as the control interface | Configure customer agents, connected tools, knowledge, reply behavior, and automation through conversation. Show what changed and make missing setup actionable. |
| Store and social connections | Connect a deliberately small, verified set of store and social providers. Support the receiving and sending capabilities needed for chats and comments, plus reconnect and revocation. |
| Brand voice as knowledge documents | Derive editable brand voice documents from authorized social posts, the business's historical comment replies, and its replies in connected messaging apps. Include tone, preferred wording, things to avoid, and examples. Share documents across a Space, with bot-specific document overrides. |
| Product and business knowledge | Upload or connect product details, SKUs, stock, promotions, and policies. Use current authorized sources for changing facts, and identify missing or stale information instead of inventing an answer. |
| Customer chats and comments | Maintain conversation context and reply in the effective brand voice. Keep public comments distinct from private conversations and avoid exposing private customer or order details publicly. |
| Human attention and takeover | Use Jev to assess whether a conversation needs human attention, subject to configured escalation rules. Surface the conversation, reason for escalation, and relevant context. Let a human respond, stop automatic replies, and explicitly return control to the customer agent. |
| Runtime steering | Accept private staff guidance during an active customer conversation and apply it before the next response or action that has not already been dispatched. Show whether guidance was applied or arrived too late for an in-flight action. |
| Sales assistance | Answer questions, explain suitable products and active promotions, and complete checkout, payment confirmation, and order creation according to the connected provider's structure and user-supplied configuration. Track confirmed results and unresolved steps. |
| Conditional invoicing | Issue an invoice only on an authorized human request or under a configured rule. Verify required order details and avoid duplicate invoices on retry. |
| Optional CRM and Google Sheets updates | Write only when configured, using the selected destination and fields. Show failed or uncertain writes and avoid duplicating records when retrying. |
| Continued learning and audit log | Learn from authorized new social content, business replies, and human steering. Update relevant knowledge, memory, and skills within the authorized scope. Record every learned change in an inspectable audit log and support undo. Apply learning to future similar situations without silently expanding business permissions. |

## Brand voice and learning behavior

Brand voice lives in knowledge documents that the business can inspect, edit,
replace, or remove. The staff agent maintains those documents; the user does
not need to maintain a separate collection of hidden writing-style settings.
Bots inherit their Space's designated voice documents unless they have an
explicit document override.

Historical reply sources include the business's own replies to social-media
comments and its staff's replies in messaging apps the user connects. The initial
import window is the 30 days before connection. Import available history within
that window and the connection's authorized access. This is a product requirement,
not a guarantee that every provider exposes 30 days of history. Show the actual
date coverage and any gaps. When history is unavailable, use approved examples
or supported exports and learn from new
conversations received after connection. Customer messages provide context for
the business's replies; they are not examples of the brand's voice.

V1 history imports accept UTF-8 CSV and JSON using Deskazo's documented message
format. The staff agent helps map fields and previews dates, conversation
grouping, and business/customer authorship before import. Require a timestamp,
conversation ID, author role, and message text; preserve source and message IDs
where available. Confirm the timezone for exports without an offset. Filter by
reply timestamp, including recent replies on older posts, to the 30-day window.
Deduplicate repeat imports and report skipped records. Keep the original window
fixed when resuming an interrupted initial import.
Undated examples can be approved as voice knowledge, but do not count as history.

Use LINE OA chat CSV exports as the first native-export mapping to validate;
LINE's Messaging API cannot backfill text history. For Instagram, retrieve
available comments, business replies, and conversations only through supported
actions and permissions. Existing connector actions do not yet cover all of
those reads. Do not promise a complete 30-day archive or accept arbitrary native
ZIP/HTML archives as though they were the documented JSON format. Show these
limits during setup and allow learning from approved examples and future replies.

Social content and historical conversations are learning inputs, not instructions
that can grant tools or change permissions. Learn from the business's own replies
and authorized staff corrections. Customer statements do not establish company
policy. Keep customer-specific facts and private staff information out of shared
brand voice documents.

Separate writing style from operational facts and business rules. Learning a
friendlier way to reply must not change a price, extend a promotion, approve a
refund, or enable invoice creation. Stock and promotion answers use their current
business sources, not an old social post or an example in a voice document.

Steering has two effects: guidance for the active conversation and learning for
future similar situations. Preserve the situation and conditions attached to a
correction. A one-off discount must not become a standing discount policy.
Learning covers knowledge documents, memory, and all applicable agent skills,
including voice documents and customer-agent handling guidance. The staff agent
may update these within the business's authorized scope; changing permissions
or commercial rules requires the applicable authorization.

Every learning-driven creation, update, removal, and undo must have an audit
record. Record when it happened, the responsible agent or human, source evidence,
reason, affected document, memory, or skill, Space or bot scope, and the before
and after versions. Let authorized staff inspect changes and restore a previous
version. Preserve the original audit record and record the undo as a new event.
Restrict source evidence to staff authorized to view the original conversation.

Removing a source or disconnecting an account stops future learning from it.
Do not overwrite bot-specific voice documents when refreshing the Space default.
Changes affect subsequent work; they do not rewrite previously sent messages.

### Learning defaults

| Input | Default timing and behavior |
| --- | --- |
| Live human steering | Apply before the next undispatched reply or action. Preserve the correction's conditions. |
| Staff corrections and resolved conversations | Queue background learning immediately, targeting completion within five minutes while services are healthy. Learn from staff-authored replies and verified outcomes; agent output alone is not new evidence. |
| Connected social content | Process supported change events as they arrive; otherwise check hourly within provider limits. Allow a refresh request through the staff agent. |
| Stock, price, promotion, payment, and order facts | Use the current authoritative provider data when answering or acting. The learning schedule does not establish freshness for these facts. |

Automatically apply supported style changes and authorized reusable corrections.
Keep ambiguous generalizations as suggestions for staff review. Skills include
editable instructions and procedures; changing executable tools or permissions
follows the existing approval policy. Failed refreshes retain the last valid
version and show the last successful update and the failure.

When changes exist, show a daily learning summary in the staff conversation.
Expand an item to inspect its source, before/after, scope, and audit history, or
undo it. Also support these actions by asking the staff agent. Keep routine
learning out of urgent human-attention alerts unless a conflict blocks work.
Undo updates the effective version and retrieval for future work. If later edits
overlap, show a selective reversal for review rather than discarding those edits.
Do not reapply the same rejected inference from the same source without new
evidence or explicit staff direction. Undo never replays external actions.

## Escalation assessment

Use [TypeSafe's Jev](https://docs.typesafe.ai/introduction) as the selected
escalation assessment provider. Jev evaluates typed questions against supplied
state and returns structured results. Deskazo supplies relevant conversation
context and the business's escalation criteria, then uses the assessment with
configured rules to decide when human attention is needed.

Deskazo owns alert delivery, takeover, and resume. Jev's assessment does not
grant permission for customer-facing actions or replace configured approvals.
Keep the provider behind an adapter so the core product can run without a
required hosted service. If assessment is unavailable, show the failure and
request human attention for work that depends on that assessment.

### Initial escalation rules

| Situation | Default response |
| --- | --- |
| Customer explicitly requests a human, or staff takes over | Hand off immediately and stop automatic customer replies. |
| A required approval is missing, a policy exception is requested, or payment/order outcome is uncertain | Pause the affected action and ask staff for guidance or approval. |
| Authoritative information is missing or contradictory | Ask one useful clarification if the customer can resolve it; otherwise ask staff. Never invent stock, policy, or payment status. |
| Two attempts fail to resolve the same issue, or frustration continues after one useful attempt | Request human attention with a summary of what has already been tried. Mild frustration alone does not force a handoff. |
| Jev is unavailable or a necessary judgment remains uncertain | Ask one safe clarification when it can resolve the uncertainty; otherwise pause and ask staff. |

Ask Jev separate questions about human requests, unresolved frustration, and
whether the evidence supports further help. Application rules enforce known
permission and provider failures regardless of the model's answer. Start with
0.80 confidence for judgments required to continue automatically; lower
confidence follows the clarification or staff path above. A confident assessment
that help is needed still escalates. This is an initial tuning value, not an
80% correctness claim. Validate on Thai and English merchant cases before
unattended use, including clear human requests and harmless routine questions.

Keep requests for staff guidance distinct from full takeover. Send a brief
customer acknowledgement when channel rules permit, with no invented response
deadline. A waiting conversation resumes only after authorized guidance or an
explicit handback, never just because time passed. Record the triggering rule,
assessment, conversation version, assignment, acknowledgement, and resolution.

### Human alerts

Use Deskazo's shared attention inbox across web, desktop, and mobile. Assign
the conversation to its designated staff member, defaulting to the Space owner,
and send enabled app notifications. The first optional external destination is
a linked staff LINE account or private staff group using the Messaging API.
Verify the recipient with a test alert during setup; keep staff destinations
separate from customer conversations. External alerts contain a minimal reason
and an authenticated link. Staff review, steer, approve, or take over in Deskazo.

Alert immediately, remind once after 10 unacknowledged minutes, and notify the
owner after 30 minutes if another staff member was assigned. Honor configured
quiet hours for notifications and defer reminders until those hours end; the
inbox item remains visible immediately. Deduplicate alerts for the same issue
and stop reminders on acknowledgement. External delivery failures stay visible
in Deskazo and do not clear the escalation. No configured external destination
is required for the inbox to work.

## Purchase completion

The user connects the providers used by their business and supplies the required
workflow details through the staff agent. Checkout, payment confirmation, and
order creation follow those providers' supported structure, required fields,
step order, and status meanings. The staff agent maps the user's details to the
connected capabilities and identifies missing information before enabling the
workflow.

Use provider-confirmed results to establish payment and order status. User-supplied
configuration defines how the workflow operates; it does not establish that a
particular payment succeeded or an order exists. Show unsupported steps or
uncertain outcomes and request human attention. Avoid duplicate orders and
downstream actions when retrying or recovering interrupted work.

## Supporting V1 capabilities

These capabilities support the customer-conversation workflow. They should not
compete with it for attention during onboarding or everyday use.

| Capability | Minimum V1 behavior |
| --- | --- |
| Setup and model connections | Complete a first useful task without developer assistance. Save, test, change, and revoke model credentials; support documented providers and an OpenAI-compatible endpoint. |
| Persistent teammates and conversations | Create, configure, archive, and delete agents. Preserve instructions and history across restarts. Support streaming, attachments, cancellation, failure recovery, and reconnect without lost or duplicated messages. |
| Memory and documents | Remember preferences, search uploaded documents, identify sources, and let authorized users inspect and remove stored information. |
| Computer and file tools | Provide browser, terminal, and file work through at least one supported sandbox, with human takeover and recovery, when needed by a configured business workflow. |
| Background routines | Schedule work and knowledge refresh, inspect outcomes, pause routines, and recover after downtime without duplicate consequential actions. |
| Permissions and approvals | Isolate businesses and users, protect secrets, and enforce configured approvals before side effects. Style and learning never bypass these controls. |
| Work visibility | Show active work, completed results, failures, and requests for human attention. Distinguish confirmed success from an uncertain external outcome. |
| Web, desktop, and mobile | Access conversations, results, alerts, steering, approvals, and stop controls across all three. Advanced setup may remain web-only where clearly indicated. |
| Account and data ownership | Sign in and out, recover access, export data, delete accounts, and back up and restore the deployment. |
| Safe updates | Install versioned releases, migrate data, and provide a tested recovery path after a failed update. |

## Experience principles

- When implementation convenience conflicts with user delight, choose delight.
- Justify every feature, control, and option by the business workflow it serves.
- Ship less and ship better. A polished small set of supported workflows takes
  priority over a broad but unreliable feature catalog.
- Prototype before committing to a design. Use throwaway prototypes to settle
  interaction decisions before production implementation.
- Get transitions, alignment, spacing, feedback, and error states right.
- Tighten the core loop: customer message, useful reply, human help when needed,
  confirmed outcome, and better handling next time.
- Treat the next engineer maintaining the system as a user too. Explain changes
  from both the business user's and maintainer's perspectives.
- Foundations serve the experience. Foundational dependencies determine the order
  of work; the intended user experience determines the target.

## Acceptance journeys

Before V1 sign-off, demonstrate these journeys with the selected real providers:

1. A new business connects its accounts, reviews learned brand voice, supplies
   product knowledge, and enables replies without developer intervention.
2. A customer asks about a SKU or promotion and receives a grounded answer in
   the brand's voice through chat or a public-safe comment reply.
3. A human steers an active conversation; subsequent replies follow the guidance.
   A later similar situation uses the learned guidance under the same conditions.
   Staff can inspect the resulting knowledge, memory, or skill change in the
   audit log, undo it, and verify that subsequent work uses the restored version.
4. A situation needing human judgment generates an actionable alert. Takeover
   stops new automatic replies, and explicit resume returns control safely.
5. A purchase follows the connected provider's structure and user-supplied
   configuration through checkout, payment confirmation, and order creation.
   Provider results establish the outcome. Order creation, invoicing, and CRM or
   Sheets writes happen only when authorized and configured, without duplicates
   under retries.
6. A new social post updates relevant voice knowledge without overriding bot
   exceptions, changing commercial rules, or exposing customer information.
7. An expired connection, unavailable knowledge source, or interrupted worker
   produces a recoverable state without fabricated answers or duplicate actions.

## Integration rollout

Use existing OpenConnector capabilities first, then extend OpenConnector for
missing services and actions used by Thai and regional merchants. Complete a
small merchant workflow before broadening the catalog. A listed provider is not
automatically supported for receiving messages, replying, importing history,
checking stock, or issuing invoices.

The initial validation shortlist is LINE OA and Instagram; Shopify Admin plus
Storefront or WooCommerce; Google Sheets/Drive; optional HubSpot; and an invoice
provider the merchant already uses, such as Xero or Invoice Ninja. This is a
research shortlist, not a promise of production support or Thai tax compliance.

Thai extension candidates include Facebook Pages/Messenger, Shopee, TikTok Shop,
Lazada, LINE SHOPPING, FlowAccount, ZORT and PEAK. Begin API-access discovery for
Page365 and ChocoCRM. Priorities depend on the pilot merchants' existing systems
and the exact provider permissions available. Other Asian markets need their
own channel and accounting choices.

See the [integration research and rollout plan](research/deskazo-integrations.md)
for all five catalog categories, exact action coverage, adoption evidence,
regional gaps and the reproducible source inventory.

## Provider acceptance before release

The defaults above settle the remaining product choices. Research does not
establish live provider acceptance. Validate LINE OA first, then Instagram for
the comment workflow. Use Shopify Admin/Storefront for a pilot already on
Shopify, or WooCommerce for a pilot already on WooCommerce; do not require a
merchant to move stores. Google Sheets is the first optional record destination.
Validate CRM and invoicing only for a provider the pilot actually uses.

Before marking a capability supported, demonstrate authorization, receive/read,
authorized send/write, history coverage or fallback import, revocation, and
recovery without duplicates. For social channels, include staff-authored reply
attribution, provider messaging restrictions, and takeover without double replies.
For commerce, include current SKU/stock, configured checkout, confirmed payment
and order status, and an interrupted request with an uncertain outcome. For
CRM/invoices, verify field mapping, approval rules, and retry deduplication.

Treat history access, reply delivery, and checkout as separate capabilities so
an unavailable archive does not disable an otherwise verified channel. A pilot
may start with approved voice examples; V1 sign-off still requires the applicable
acceptance journeys above, including comments. Keep unverified capabilities
unavailable and show the specific setup or access requirement.

See [operating-default research](research/deskazo-operating-defaults.md) and
[history-import research](research/deskazo-history-import-defaults.md) for the
evidence and limits behind these decisions. Refresh intervals, reminder times,
and the Jev threshold are initial product defaults to validate during the pilot.
