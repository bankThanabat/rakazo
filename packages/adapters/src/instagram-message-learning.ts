import type {
  SocialLearningExecute,
  SocialLearningProvider,
  SocialLearningWindow,
} from "@rakazo/adapter-kit";
import { z } from "zod";

const id = z.string().min(1).max(500);
const cursor = z.string().min(1).max(8192);
const paging = z.object({ hasNextPage: z.boolean(), after: cursor.optional() });
const participant = z.object({ id });
const message = z.object({
  id,
  createdTime: z.string().optional(),
  text: z.string().max(14000).optional(),
  from: participant.optional(),
  to: z.array(participant).max(20).optional(),
});
const stateSchema = z
  .object({
    version: z.literal(1),
    conversations: z.array(id).max(20),
    after: cursor.nullable(),
    messageAfter: cursor.nullable().optional(),
    references: z.array(id).max(20).optional(),
    messages: z.array(message).max(20).optional(),
    retry: z.literal(1).optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Page = Awaited<ReturnType<SocialLearningProvider["page"]>>;
const limitations = [
  "Meta exposes details for only the latest 20 messages per conversation and omits Requests inactive for 30 days. Cursor exhaustion does not prove complete history.",
  "Only text with a valid timestamp and unambiguous account direction is considered. Customer context is limited to the same reference page and matching recipient.",
  "Account direction does not prove staff authorship or exclude self-messages and outside automation. Every message-based suggestion requires staff review of the original evidence.",
];
function time(value?: string) {
  const parsed = z
    .string()
    .datetime({ offset: true })
    .safeParse(value?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return parsed.success ? new Date(parsed.data).toISOString() : undefined;
}
function after(page: z.infer<typeof paging>, previous?: string) {
  const next = page.hasNextPage ? page.after : null;
  if (next === undefined || next === previous)
    throw new Error("Instagram message pagination did not advance");
  return next;
}
function encode(state: State) {
  return !state.conversations.length && !state.after ? null : JSON.stringify(state);
}
function empty(state: State, extra: Partial<Page> = {}): Page {
  return {
    posts: [],
    skipped: 0,
    nextCursor: encode(state),
    limitations,
    reviewRequired: true,
    ...extra,
  };
}
function finish(state: State, accountId: string, window: SocialLearningWindow): Page {
  if (state.references?.length) return empty(state);
  const conversationId = state.conversations[0]!;
  let skipped = 0;
  let unverified = 0;
  let contextOnly = 0;
  const valid = (state.messages ?? [])
    .flatMap((item) => {
      const publishedAt = time(item.createdTime);
      if (
        !publishedAt ||
        !item.text?.trim() ||
        !item.from ||
        item.to?.length !== 1 ||
        item.from.id === item.to[0]!.id ||
        (item.from.id !== accountId && item.to[0]!.id !== accountId)
      ) {
        skipped++;
        unverified++;
        return [];
      }
      if (publishedAt < window.start || publishedAt > window.end) {
        skipped++;
        return [];
      }
      return [
        { ...item, publishedAt, text: item.text.trim(), from: item.from.id, to: item.to[0]!.id },
      ];
    })
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
  const posts: Page["posts"] = [];
  for (const item of valid) {
    if (item.from !== accountId) {
      contextOnly++;
      continue;
    }
    const context = valid.findLast(
      (other) =>
        other.from === item.to && other.to === accountId && other.publishedAt < item.publishedAt,
    );
    posts.push({
      id: `instagram-message:${item.id}`,
      conversationId,
      text: item.text,
      publishedAt: item.publishedAt,
      staffAuthorship: "unverified",
      ...(context ? { context: context.text, contextId: context.id } : {}),
    });
  }
  delete state.references;
  delete state.messages;
  delete state.retry;
  if (!state.messageAfter) {
    state.conversations.shift();
    delete state.messageAfter;
  }
  return empty(state, { posts, skipped, unverified, contextOnly });
}

/** One provider request per durable step. A twice-unreadable detail remains a coverage gap,
 * not a deletion claim. Future scans retry it because no evidence marker is written. */
export async function readInstagramMessages(
  execute: SocialLearningExecute,
  accountId: string,
  window: SocialLearningWindow,
  raw?: string,
): Promise<Page> {
  const start = time(window.start);
  const end = time(window.end);
  if (!start || !end || start > end) throw new Error("Invalid message history window");
  window = { start, end };
  if (raw && raw.length > 6000000) throw new Error("Instagram message cursor is too large");
  const state: State = raw
    ? stateSchema.parse(JSON.parse(raw))
    : { version: 1, conversations: [], after: null };
  if (!state.conversations.length) {
    if (state.references || state.messages || state.messageAfter || state.retry)
      throw new Error("Invalid Instagram message cursor");
    const result = z.object({ conversations: z.array(z.object({ id })).max(20), paging }).parse(
      await execute("instagram.list_conversations", {
        limit: 20,
        ...(state.after ? { after: state.after } : {}),
      }),
    );
    state.after = after(result.paging, state.after ?? undefined);
    state.conversations = result.conversations.map((item) => item.id);
    return empty(state);
  }
  if (!state.references) {
    if (state.messages || state.retry) throw new Error("Invalid Instagram message cursor");
    const result = z
      .object({
        messages: z.array(z.object({ id, createdTime: z.string().optional() })).max(20),
        paging,
      })
      .parse(
        await execute("instagram.list_conversation_messages", {
          conversationId: state.conversations[0],
          limit: 20,
          ...(state.messageAfter ? { after: state.messageAfter } : {}),
        }),
      );
    state.messageAfter = after(result.paging, state.messageAfter ?? undefined);
    // Use reference dates to avoid reading private content outside the approved window.
    // Missing reference dates can still be recovered from message details.
    state.references = result.messages
      .filter((item) => {
        const at = time(item.createdTime);
        return !at || (at >= window.start && at <= window.end);
      })
      .map((item) => item.id);
    const skipped = result.messages.length - state.references.length;
    state.messages = [];
    return { ...finish(state, accountId, window), skipped };
  }
  if (!state.references.length || !state.messages)
    throw new Error("Invalid Instagram message cursor");
  let detail: z.infer<typeof message>;
  try {
    detail = z
      .object({ message })
      .parse(await execute("instagram.get_message", { messageId: state.references[0] })).message;
    if (detail.id !== state.references[0]) throw new Error("Instagram returned another message");
  } catch {
    if (!state.retry) {
      state.retry = 1;
      return empty(state);
    }
    state.references.shift();
    delete state.retry;
    const page = finish(state, accountId, window);
    return {
      ...page,
      skipped: page.skipped + 1,
      unavailable: 1,
      limitations: [
        ...limitations,
        "Some message details could not be read after two attempts. Their cause is unknown; later scans retry these gaps.",
      ],
    };
  }
  state.references.shift();
  delete state.retry;
  const at = time(detail.createdTime);
  if (!at || at < start || at > end) {
    const page = finish(state, accountId, window);
    return {
      ...page,
      skipped: page.skipped + 1,
      unverified: (page.unverified ?? 0) + (at ? 0 : 1),
    };
  }
  state.messages.push(detail);
  return finish(state, accountId, window);
}
