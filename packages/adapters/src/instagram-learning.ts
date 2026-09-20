import type {
  SocialLearningExecute,
  SocialLearningProvider,
  SocialLearningWindow,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { readInstagramMessages } from "./instagram-message-learning.js";

const id = z.string().min(1).max(500);
const after = z.string().min(1).max(8192);
const paging = z.object({ hasNextPage: z.boolean(), after: after.optional() });
const mediaPage = z.object({
  media: z
    .array(
      z.object({ id, caption: z.string().max(14000).optional(), timestamp: z.string().optional() }),
    )
    .max(100),
  paging,
});
const commentsPage = z.object({
  comments: z
    .array(
      z.object({
        id,
        text: z.string().max(14000).optional(),
        timestamp: z.string().optional(),
        userId: id.optional(),
      }),
    )
    .max(50),
  paging,
});
const scanCursor = z
  .object({
    version: z.literal(1),
    media: z.array(id).max(100),
    mediaAfter: after.nullable(),
    comments: z
      .object({
        parents: z.array(z.object({ id, text: z.string().max(14000).optional() })).max(50),
        after: after.nullable(),
      })
      .strict()
      .optional(),
    replyAfter: after.optional(),
  })
  .strict();
type ScanCursor = z.infer<typeof scanCursor>;
const limitations = [
  "Only accessible organic replies on owned media are scanned. Deleted parents, restricted content, Stories, ads and DMs are excluded.",
  "Meta limits accessible media history. Finishing pagination does not prove complete account history.",
  "Replies without app-user author evidence or a valid timestamp are skipped; they are not business voice examples. Parent-comment context may be unavailable.",
  "Account authorship cannot distinguish human replies from automation sent before delivery tracking or outside this app.",
];

function nextPage(result: z.infer<typeof paging>, previous?: string) {
  const next = result.hasNextPage ? result.after : null;
  if (next === undefined || next === previous)
    throw new Error("Instagram pagination did not advance");
  return next;
}
function ownedText(postId: string, text?: string, timestamp?: string) {
  const date = z
    .string()
    .datetime({ offset: true })
    .safeParse(timestamp?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return text?.trim() && date.success
    ? [{ id: postId, text: text.trim(), publishedAt: new Date(date.data).toISOString() }]
    : [];
}
async function readMedia(execute: SocialLearningExecute, cursor?: string) {
  const result = mediaPage.parse(
    await execute("instagram.list_media", { limit: 100, ...(cursor ? { after: cursor } : {}) }),
  );
  const posts = result.media.flatMap((post) => ownedText(post.id, post.caption, post.timestamp));
  return {
    media: result.media.map((post) => post.id),
    posts,
    nextCursor: nextPage(result.paging, cursor),
    skipped: result.media.length - posts.length,
  };
}
function encodeCursor(state: ScanCursor) {
  // Exhaust empty reply/parent/media queues before selecting the next single request.
  if (state.comments && !state.comments.parents.length && !state.comments.after) {
    state.media.shift();
    delete state.comments;
  }
  if (!state.media.length && !state.mediaAfter) return null;
  return JSON.stringify(state);
}

/** Each call reads one edge page. The durable cursor retains all three traversal levels. */
async function readReplies(execute: SocialLearningExecute, cursor?: string) {
  if (cursor && cursor.length > 6000000) throw new Error("Instagram scan cursor is too large");
  const state = cursor ? scanCursor.parse(JSON.parse(cursor)) : undefined;
  if (!state?.media.length) {
    if (state && (state.comments || state.replyAfter || !state.mediaAfter))
      throw new Error("Invalid Instagram scan cursor");
    const result = await readMedia(execute, state?.mediaAfter ?? undefined);
    return {
      posts: result.posts,
      skipped: result.skipped,
      nextCursor: encodeCursor({ version: 1, media: result.media, mediaAfter: result.nextCursor }),
      limitations,
    };
  }
  if (!state.comments?.parents.length) {
    if (state.replyAfter) throw new Error("Invalid Instagram reply cursor");
    const previous = state.comments?.after ?? undefined;
    const result = commentsPage.parse(
      await execute("instagram.list_media_comments", {
        mediaId: state.media[0],
        limit: 50,
        ...(previous ? { after: previous } : {}),
      }),
    );
    state.comments = {
      parents: result.comments.map(({ id, text }) => ({ id, text })),
      after: nextPage(result.paging, previous),
    };
    return { posts: [], skipped: 0, nextCursor: encodeCursor(state), limitations };
  }
  const result = commentsPage.parse(
    await execute("instagram.list_comment_replies", {
      commentId: state.comments.parents[0]!.id,
      limit: 50,
      ...(state.replyAfter ? { after: state.replyAfter } : {}),
    }),
  );
  // Meta returns userId only for app-user authorship. Never substitute a username or from.id.
  const parent = state.comments.parents[0]!;
  const posts = result.comments.flatMap((reply) =>
    reply.userId
      ? ownedText(`instagram-reply:${reply.id}`, reply.text, reply.timestamp).map((post) => ({
          ...post,
          parentId: parent.id,
          ...(parent.text ? { context: parent.text } : {}),
        }))
      : [],
  );
  const next = nextPage(result.paging, state.replyAfter);
  if (next) state.replyAfter = next;
  else {
    state.comments.parents.shift();
    delete state.replyAfter;
  }
  const skipped = result.comments.length - posts.length;
  return { posts, skipped, unverified: skipped, nextCursor: encodeCursor(state), limitations };
}

/** Existing sources remain caption-only unless reply history is explicitly enabled. */
export function instagramLearning(
  execute: SocialLearningExecute,
  includeReplies = false,
  messages?: SocialLearningWindow,
): SocialLearningProvider {
  let accountId: string | undefined;
  const socialPage = async (cursor?: string) => {
    if (includeReplies) return readReplies(execute, cursor);
    const { posts, nextCursor, skipped } = await readMedia(execute, cursor);
    return { posts, nextCursor, skipped };
  };
  return {
    actions: [
      { action: "instagram.get_current_user", effect: "read" },
      { action: "instagram.list_media", effect: "read" },
      ...(includeReplies
        ? [
            { action: "instagram.list_media_comments", effect: "read" as const },
            { action: "instagram.list_comment_replies", effect: "read" as const },
          ]
        : []),
      ...(messages
        ? [
            { action: "instagram.list_conversations", effect: "read" as const },
            { action: "instagram.list_conversation_messages", effect: "read" as const },
            { action: "instagram.get_message", effect: "read" as const },
          ]
        : []),
    ],
    async identity() {
      const { user } = z
        .object({
          user: z.object({ id, userId: id.optional(), username: z.string().min(1).max(200) }),
        })
        .parse(await execute("instagram.get_current_user", {}));
      if (messages && !user.userId)
        throw new Error("Instagram professional account identity is required for messages");
      accountId = user.userId ?? user.id;
      return { id: accountId, label: `Instagram @${user.username}` };
    },
    async page(cursor) {
      if (!messages) return socialPage(cursor);
      if (!accountId) throw new Error("Verify the Instagram account before reading messages");
      if (cursor && cursor.length > 6000000) throw new Error("Instagram scan cursor is too large");
      const state = cursor
        ? z
            .object({
              version: z.literal(2),
              section: z.enum(["social", "messages"]),
              cursor: z.string().optional(),
            })
            .strict()
            .parse(JSON.parse(cursor))
        : { version: 2 as const, section: "social" as const };
      const page =
        state.section === "social"
          ? await socialPage(state.cursor)
          : await readInstagramMessages(execute, accountId, messages, state.cursor);
      const nextCursor = page.nextCursor
        ? JSON.stringify({ ...state, cursor: page.nextCursor })
        : state.section === "social"
          ? JSON.stringify({ version: 2, section: "messages" })
          : null;
      return { ...page, nextCursor };
    },
  };
}
