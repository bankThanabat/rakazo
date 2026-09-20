import { describe, expect, it, vi } from "vitest";
import { instagramLearning } from "./instagram-learning.js";

describe("Instagram learning adapter", () => {
  it("reads only owned captions, passes cursor with a bounded page and normalizes timezone offsets", async () => {
    const execute = vi.fn().mockResolvedValue({
      media: [
        { id: "one", caption: " Hello ", timestamp: "2026-09-18T13:00:00+0700" },
        { id: "two", timestamp: "2026-09-18T00:00:00Z" },
        { id: "three", caption: "No date", timestamp: "yesterday" },
      ],
      paging: { hasNextPage: true, after: "next" },
    });
    const page = await instagramLearning(execute).page("previous");
    expect(execute).toHaveBeenCalledExactlyOnceWith("instagram.list_media", {
      limit: 100,
      after: "previous",
    });
    expect(page).toEqual({
      posts: [{ id: "one", text: "Hello", publishedAt: "2026-09-18T06:00:00.000Z" }],
      skipped: 2,
      nextCursor: "next",
    });
  });
  it.each([{ hasNextPage: true }, { hasNextPage: true, after: "same" }])(
    "rejects broken pagination %j",
    async (paging) => {
      await expect(
        instagramLearning(async () => ({ media: [], paging })).page("same"),
      ).rejects.toThrow();
    },
  );
  it("pins the connected userId and requires a recognizable account profile", async () => {
    expect(
      await instagramLearning(async () => ({
        user: { id: "app-scoped", userId: "account", username: "shop" },
      })).identity(),
    ).toEqual({ id: "account", label: "Instagram @shop" });
    await expect(
      instagramLearning(async () => ({ user: { id: "account" } })).identity(),
    ).rejects.toThrow();
  });
  it("rejects oversized responses without silently truncating coverage", async () => {
    await expect(
      instagramLearning(async () => ({
        media: Array.from({ length: 101 }, () => ({ id: "a" })),
        paging: { hasNextPage: false },
      })).page(),
    ).rejects.toThrow();
    await expect(
      instagramLearning(async () => ({
        media: [{ id: "a", caption: "a".repeat(14001) }],
        paging: { hasNextPage: false },
      })).page(),
    ).rejects.toThrow();
  });
});

describe("opted-in Instagram reply traversal", () => {
  it("resumes all three pagination levels through empty pages without filtering old parents", async () => {
    const closed = { hasNextPage: false };
    const more = (after: string) => ({ hasNextPage: true, after });
    const old = "2020-01-01T00:00:00Z";
    const recent = "2026-09-19T13:00:00+0700";
    const requests: Array<[string, Record<string, unknown>, unknown]> = [
      [
        "instagram.list_media",
        { limit: 100 },
        {
          media: [{ id: "a", caption: "Old caption", timestamp: old }, { id: "b" }],
          paging: more("m2"),
        },
      ],
      [
        "instagram.list_media_comments",
        { mediaId: "a", limit: 50 },
        { comments: [{ id: "p1", timestamp: old }, { id: "p2" }], paging: more("c2") },
      ],
      [
        "instagram.list_comment_replies",
        { commentId: "p1", limit: 50 },
        {
          comments: [
            { id: "customer", text: "Customer", timestamp: recent },
            { id: "r1", text: " สวัสดีค่ะ ", timestamp: recent, userId: "app-user" },
          ],
          paging: more("r2"),
        },
      ],
      [
        "instagram.list_comment_replies",
        { commentId: "p1", limit: 50, after: "r2" },
        {
          comments: [
            { id: "r2", text: "Hello", timestamp: recent, userId: "app-user" },
            { id: "blank", text: " ", timestamp: recent, userId: "app-user" },
            { id: "undated", text: "No date", userId: "app-user" },
            {
              id: "impostor",
              text: "Wrong author",
              timestamp: recent,
              username: "shop",
              from: { id: "account" },
            },
          ],
          paging: closed,
        },
      ],
      [
        "instagram.list_comment_replies",
        { commentId: "p2", limit: 50 },
        { comments: [], paging: closed },
      ],
      [
        "instagram.list_media_comments",
        { mediaId: "a", limit: 50, after: "c2" },
        { comments: [], paging: more("c3") },
      ],
      [
        "instagram.list_media_comments",
        { mediaId: "a", limit: 50, after: "c3" },
        { comments: [{ id: "p3" }], paging: closed },
      ],
      [
        "instagram.list_comment_replies",
        { commentId: "p3", limit: 50 },
        {
          comments: [{ id: "r3", text: "Thanks", timestamp: recent, userId: "app-user" }],
          paging: closed,
        },
      ],
      [
        "instagram.list_media_comments",
        { mediaId: "b", limit: 50 },
        { comments: [], paging: closed },
      ],
      ["instagram.list_media", { limit: 100, after: "m2" }, { media: [], paging: more("m3") }],
      [
        "instagram.list_media",
        { limit: 100, after: "m3" },
        { media: [{ id: "c" }], paging: closed },
      ],
      [
        "instagram.list_media_comments",
        { mediaId: "c", limit: 50 },
        { comments: [{ id: "p4" }], paging: closed },
      ],
      [
        "instagram.list_comment_replies",
        { commentId: "p4", limit: 50 },
        { comments: [], paging: closed },
      ],
    ];
    const execute = vi.fn(async (action: string, input: Record<string, unknown>) => {
      const expected = requests[execute.mock.calls.length - 1]!;
      expect([action, input]).toEqual(expected.slice(0, 2));
      return expected[2];
    });
    let cursor: string | undefined;
    const posts: Array<{ id: string; text: string; publishedAt: string }> = [];
    let unverified = 0;
    for (let step = 0; step < requests.length; step++) {
      const page = await instagramLearning(execute, true).page(cursor);
      expect(execute).toHaveBeenCalledTimes(step + 1);
      posts.push(...page.posts);
      unverified += page.unverified ?? 0;
      expect(page.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("before delivery tracking or outside this app"),
        ]),
      );
      if (step < requests.length - 1) expect(page.nextCursor).toBeTruthy();
      else expect(page.nextCursor).toBeNull();
      cursor = page.nextCursor ?? undefined;
    }
    expect(posts.map((post) => post.id)).toEqual([
      "a",
      "instagram-reply:r1",
      "instagram-reply:r2",
      "instagram-reply:r3",
    ]);
    expect(posts[1]).toEqual({
      id: "instagram-reply:r1",
      text: "สวัสดีค่ะ",
      publishedAt: "2026-09-19T06:00:00.000Z",
      parentId: "p1",
    });
    expect(unverified).toBe(4);
  });

  it.each(["media", "comments", "replies"])(
    "rejects missing and repeated %s cursors",
    async (level) => {
      const state =
        level === "media"
          ? { version: 1, media: [], mediaAfter: "same" }
          : {
              version: 1,
              media: ["m"],
              mediaAfter: null,
              ...(level === "comments"
                ? { comments: { parents: [], after: "same" } }
                : { comments: { parents: [{ id: "p" }], after: null }, replyAfter: "same" }),
            };
      for (const paging of [{ hasNextPage: true }, { hasNextPage: true, after: "same" }]) {
        await expect(
          instagramLearning(async () => ({ media: [], comments: [], paging }), true).page(
            JSON.stringify(state),
          ),
        ).rejects.toThrow("pagination did not advance");
      }
    },
  );

  it("requires explicit opt-in and never reads provider data with malformed durable state", async () => {
    const execute = vi.fn();
    expect(instagramLearning(execute).actions.map((item) => item.action)).toEqual([
      "instagram.get_current_user",
      "instagram.list_media",
    ]);
    expect(instagramLearning(execute, true).actions.map((item) => item.action)).toContain(
      "instagram.list_comment_replies",
    );
    for (const cursor of [
      "bad",
      "x".repeat(6000001),
      JSON.stringify({ version: 2, media: [] }),
      JSON.stringify({ version: 1, media: [], mediaAfter: null, replyAfter: "invalid" }),
    ])
      await expect(instagramLearning(execute, true).page(cursor)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains full parent context through a large JSON-escaped durable cursor", async () => {
    const context = "\n".repeat(14000);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ media: [{ id: "m" }], paging: { hasNextPage: false } })
      .mockResolvedValueOnce({
        comments: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, text: context })),
        paging: { hasNextPage: false },
      })
      .mockResolvedValueOnce({
        comments: [
          {
            id: "r",
            text: "Business reply",
            userId: "app-user",
            timestamp: "2026-09-19T00:00:00Z",
          },
        ],
        paging: { hasNextPage: false },
      });
    const first = await instagramLearning(execute, true).page();
    const parents = await instagramLearning(execute, true).page(first.nextCursor!);
    expect(parents.nextCursor!.length).toBeGreaterThan(1000000);
    const replies = await instagramLearning(execute, true).page(parents.nextCursor!);
    expect(replies.posts[0]).toMatchObject({ parentId: "p0", context, text: "Business reply" });
    expect(replies.nextCursor).toBeTruthy();
  });

  it("keeps a failed reply page resumable rather than returning an empty completed scan", async () => {
    const cursor = JSON.stringify({
      version: 1,
      media: ["m"],
      mediaAfter: null,
      comments: { parents: [{ id: "p" }], after: null },
    });
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("Permission removed"))
      .mockResolvedValueOnce({ comments: [], paging: { hasNextPage: false } });
    await expect(instagramLearning(execute, true).page(cursor)).rejects.toThrow(
      "Permission removed",
    );
    expect((await instagramLearning(execute, true).page(cursor)).nextCursor).toBeNull();
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  });
});
