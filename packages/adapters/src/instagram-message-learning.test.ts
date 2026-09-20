import type { SocialLearningWindow } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { instagramLearning } from "./instagram-learning.js";
import { readInstagramMessages } from "./instagram-message-learning.js";

const window: SocialLearningWindow = {
  start: "2026-08-20T00:00:00.000Z",
  end: "2026-09-19T00:00:00.000Z",
};
const closed = { hasNextPage: false };
const more = (after: string) => ({ hasNextPage: true, after });
const detail = (id: string, from: string, to: string, createdTime: string, text = id) => ({
  message: { id, from: { id: from }, to: [{ id: to }], createdTime, text },
});

describe("Instagram message learning traversal", () => {
  it("resumes empty pages, older conversations and unordered messages with recipient-matched private context", async () => {
    const requests: Array<[string, Record<string, unknown>, unknown]> = [
      ["instagram.list_conversations", { limit: 20 }, { conversations: [], paging: more("c2") }],
      [
        "instagram.list_conversations",
        { limit: 20, after: "c2" },
        { conversations: [{ id: "old-thread", updatedTime: "2020-01-01" }], paging: closed },
      ],
      [
        "instagram.list_conversation_messages",
        { conversationId: "old-thread", limit: 20 },
        { messages: [], paging: more("m2") },
      ],
      [
        "instagram.list_conversation_messages",
        { conversationId: "old-thread", limit: 20, after: "m2" },
        { messages: ["out", "in", "other", "wrong", "self"].map((id) => ({ id })), paging: closed },
      ],
      [
        "instagram.get_message",
        { messageId: "out" },
        detail("out", "business", "customer", "2026-09-18T12:00:00+0000", "Hello from staff?"),
      ],
      [
        "instagram.get_message",
        { messageId: "in" },
        detail(
          "in",
          "customer",
          "business",
          "2026-09-18T11:00:00+0000",
          "PRIVATE_CUSTOMER_CONTEXT",
        ),
      ],
      [
        "instagram.get_message",
        { messageId: "other" },
        detail(
          "other",
          "another-customer",
          "business",
          "2026-09-18T11:59:00+0000",
          "UNRELATED_CONTEXT",
        ),
      ],
      [
        "instagram.get_message",
        { messageId: "wrong" },
        detail("wrong", "stranger", "stranger-2", "2026-09-18T10:00:00Z"),
      ],
      [
        "instagram.get_message",
        { messageId: "self" },
        detail("self", "business", "business", "2026-09-18T10:00:00Z"),
      ],
    ];
    const execute = vi.fn(async (action, input) => {
      const next = requests.shift()!;
      expect([action, input]).toEqual(next.slice(0, 2));
      return next[2];
    });
    let cursor: string | undefined;
    const pages = [];
    do {
      const page = await readInstagramMessages(execute, "business", window, cursor);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < 20);
    expect(requests).toEqual([]);
    expect(pages.flatMap((page) => page.posts)).toEqual([
      {
        id: "instagram-message:out",
        conversationId: "old-thread",
        text: "Hello from staff?",
        publishedAt: "2026-09-18T12:00:00.000Z",
        staffAuthorship: "unverified",
        context: "PRIVATE_CUSTOMER_CONTEXT",
        contextId: "in",
      },
    ]);
    expect(pages.at(-1)).toMatchObject({
      reviewRequired: true,
      contextOnly: 2,
      skipped: 2,
      unverified: 2,
      nextCursor: null,
    });
    expect(pages.every((page) => page.reviewRequired)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(9);
  });

  it("keeps one failed detail queued, then records a gap and continues without claiming deletion", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ conversations: [{ id: "thread" }], paging: closed })
      .mockResolvedValueOnce({ messages: [{ id: "missing" }, { id: "out" }], paging: closed })
      .mockRejectedValueOnce(new Error("HTTP private error"))
      .mockRejectedValueOnce(new Error("Different private error"))
      .mockResolvedValueOnce(detail("out", "business", "customer", "2026-09-18T12:00:00Z"));
    let cursor: string | undefined;
    const pages = [];
    for (let i = 0; i < 5; i++) {
      const page = await readInstagramMessages(execute, "business", window, cursor);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    }
    expect(execute.mock.calls.slice(2)).toEqual([
      ["instagram.get_message", { messageId: "missing" }],
      ["instagram.get_message", { messageId: "missing" }],
      ["instagram.get_message", { messageId: "out" }],
    ]);
    expect(pages[2]).toMatchObject({ skipped: 0 });
    expect(pages[3]).toMatchObject({ skipped: 1, unavailable: 1 });
    expect(JSON.stringify(pages)).not.toContain("private error");
    expect(pages[4]).toMatchObject({ nextCursor: null, posts: [{ id: "instagram-message:out" }] });
  });

  it("filters known out-of-window references before reading text and discards out-of-window details before checkpointing", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ conversations: [{ id: "thread" }], paging: closed })
      .mockResolvedValueOnce({
        messages: [
          { id: "old", createdTime: "2020-01-01T00:00:00Z" },
          { id: "future", createdTime: "2026-09-20T00:00:00Z" },
          { id: "unknown" },
          { id: "current" },
        ],
        paging: closed,
      })
      .mockResolvedValueOnce(
        detail("unknown", "business", "customer", "2020-01-01T00:00:00Z", "OUTSIDE_PRIVATE"),
      )
      .mockResolvedValueOnce(detail("current", "business", "customer", "2026-09-18T12:00:00Z"));
    let cursor: string | undefined;
    const pages = [];
    for (let i = 0; i < 4; i++) {
      const page = await readInstagramMessages(execute, "business", window, cursor);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    }
    expect(
      execute.mock.calls
        .filter(([action]) => action === "instagram.get_message")
        .map(([, input]) => input.messageId),
    ).toEqual(["unknown", "current"]);
    expect(pages.reduce((n, page) => n + page.skipped, 0)).toBe(3);
    expect(JSON.stringify(pages)).not.toContain("OUTSIDE_PRIVATE");
    expect(pages.at(-1)?.posts).toHaveLength(1);
  });

  it("does not guess dates or identities, use names as account evidence, or invent text", async () => {
    const values = [
      { id: "no-date", text: "hello", from: { id: "business" }, to: [{ id: "customer" }] },
      {
        id: "no-author",
        text: "hello",
        createdTime: "2026-09-18T00:00:00Z",
        from: { username: "business" },
      },
      {
        id: "media",
        createdTime: "2026-09-18T00:00:00Z",
        from: { id: "business" },
        to: [{ id: "customer" }],
      },
    ];
    const execute = vi.fn(async (action, input) =>
      action === "instagram.list_conversations"
        ? { conversations: [{ id: "thread" }], paging: closed }
        : action === "instagram.list_conversation_messages"
          ? { messages: values.map(({ id }) => ({ id })), paging: closed }
          : { message: values.find((item) => item.id === input.messageId) },
    );
    let cursor: string | undefined;
    const pages = [];
    do {
      const page = await readInstagramMessages(execute, "business", window, cursor);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < 20);
    expect(pages.flatMap((page) => page.posts)).toEqual([]);
    expect(pages.reduce((n, page) => n + page.skipped, 0)).toBe(3);
  });

  it.each([{ hasNextPage: true }, { hasNextPage: true, after: "same" }])(
    "rejects broken conversation pagination %j",
    async (paging) => {
      await expect(
        readInstagramMessages(
          async () => ({ conversations: [], paging }),
          "business",
          window,
          JSON.stringify({ version: 1, conversations: [], after: "same" }),
        ),
      ).rejects.toThrow("did not advance");
    },
  );

  it("requires professional user_id and explicit opt-in, preserving the legacy caption cursor", async () => {
    const execute = vi.fn(async (action) =>
      action === "instagram.get_current_user"
        ? { user: { id: "app-scoped", username: "shop" } }
        : { media: [], paging: closed },
    );
    const legacy = instagramLearning(execute);
    expect(legacy.actions.some((item) => item.action === "instagram.get_message")).toBe(false);
    expect(await legacy.page()).toMatchObject({ nextCursor: null });
    const opted = instagramLearning(execute, false, window);
    await expect(opted.identity()).rejects.toThrow("professional account identity");
    await expect(opted.page()).rejects.toThrow("Verify");
  });
});
