# Rakazo V1 specification

Status: draft. Scope: the whole Rakazo product across web, Electron, and mobile.
This document records product scope, not implementation or release readiness.

## Proposed core scope

The working V1 promise is to create an AI teammate, give it tools and context,
and keep its work under the user's control.

- Setup and onboarding through a first useful task.
- Saved, testable and revocable model connections.
- Persistent bots with editable instructions and history.
- Reliable conversations with attachments, cancellation and reconnect.
- Inspectable memory and searchable documents with source references.
- Browser, terminal and file tools, human takeover and computer recovery.
- A documented set of working integrations with connection revocation.
- Background routines with results, failure visibility and pause controls.
- Permissions, approvals, secret protection and isolation between users.
- Visibility into active work, results and requests for attention.
- Chat, results, approvals and stop controls on web, desktop and mobile.
- Account recovery, export, deletion, backup and restore.
- Versioned updates with a tested recovery path.
- Shared brand voice with per-bot overrides, specified below.

Customer support remains conditional scope. If advertised for V1, it must include
a verified incoming channel, automatic and manual replies, staff takeover,
customer-safe knowledge and actions, delivery status, duplicate protection and
isolation between businesses.

## Brand voice

### Confirmed scope

Brand voice is a V1 requirement. Configure a shared voice for each Space, with
individual bots able to override it. Implementation is deferred.

### Proposed behavior

- A voice describes writing style: tone, preferred wording, wording to avoid,
  and optional examples. It is separate from speech synthesis voice selection.
- Bots inherit their Space's voice by default. A bot's custom voice replaces the
  shared voice for that bot; returning to the Space default removes the override.
- Changes apply to subsequent work. Existing messages are not rewritten.
- Use the effective voice for generated writing, including customer replies where
  customer support is enabled. Do not copy private staff instructions or memory
  into customer agents.
- Style guidance does not grant tools, change permissions, authorize actions or
  override factual accuracy and safety requirements.
- Keep voice settings scoped to their Space. Use existing Space and bot ownership
  rules for editing, with equivalent access controls on every client.
- Web, Electron and mobile expose the same inheritance and override behavior.

### Acceptance criteria

1. Two bots without overrides use their Space's saved voice.
2. A bot with an override uses its custom voice while the other bot still inherits.
3. Editing the shared voice affects subsequent work by inheriting bots and leaves
   overrides intact.
4. Returning a bot to the default uses the latest shared voice.
5. With no shared voice or override, existing writing behavior is preserved.
6. Users cannot read or edit a voice through another Space's identifiers without
   authorized access, and bot overrides cannot be edited by unauthorized users.
7. Staff and customer generation receive the appropriate style without exposing
   private staff context to customer agents.

### Outside this addition

Website crawling to infer a voice, automatic learning from documents, multiple
named voice profiles, approval/version history, and voice cloning are not part
of this initial requirement. The form layout and storage design are undecided.

## Proposed deferrals

Voice calls, agent delegation, visual task recording, an extensive integration
catalog, every sandbox provider, full language parity and managed cloud hosting
are not proposed V1 requirements. This does not require removing existing features.
