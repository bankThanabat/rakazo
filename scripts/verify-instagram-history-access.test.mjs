import assert from "node:assert/strict";
import test from "node:test";
import { verifyHistoryAccess } from "./verify-instagram-history-access.mjs";

const privateSentinel = "synthetic-private-content-never-print";
const paging = {
  hasNextPage: true,
  hasPreviousPage: false,
  next: "https://example.test/private-token",
};
function fixture({
  empty = false,
  failed = false,
  wrongAccount = false,
  messageRows,
  pagination = false,
  cursor = "synthetic-first-cursor",
  repeatCursor = false,
  secondPageDenied = false,
} = {}) {
  const calls = [];
  const delays = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.ok(url.startsWith("http://127.0.0.1:3000/"));
    assert.equal(init.redirect, "error");
    const json = (body, status = 200) => Response.json(body, { status });
    if (url.endsWith("/api/connections")) {
      assert.equal(init.headers.authorization, "Bearer synthetic-admin");
      return json([
        {
          id: "synthetic-connection",
          service: "instagram",
          configured: true,
          connectionName: "synthetic-alias",
        },
      ]);
    }
    if (url.endsWith("/v1/connections/by-id/synthetic-connection"))
      return json({
        data: {
          service: wrongAccount ? "line" : "instagram",
          alias: "synthetic-alias",
          providerAccountId: "synthetic-account",
        },
      });
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer synthetic-runtime");
    assert.equal(init.headers["x-oo-connector-alias"], "synthetic-alias");
    assert.ok(url.endsWith("/for-account/synthetic-account"));
    const action = url.match(/\/instagram\.([^/]+)\//)?.[1];
    const input = JSON.parse(init.body).input;
    if (failed) return json({ success: false, error: privateSentinel }, 403);
    const item = (id) => ({
      id,
      text: privateSentinel,
      timestamp: "2026-01-01T00:00:00Z",
      createdTime: "2026-01-01T00:00:00Z",
      updatedTime: "2026-01-01T00:00:00Z",
    });
    const limit = pagination ? 20 : 1;
    const cases = {
      list_media: [{ limit }, "media", "synthetic-media"],
      list_media_comments: [{ mediaId: "synthetic-media", limit }, "comments", "synthetic-comment"],
      list_comment_replies: [
        { commentId: "synthetic-comment", limit },
        "comments",
        "synthetic-reply",
      ],
      list_conversations: [{ limit }, "conversations", "synthetic-conversation"],
      list_conversation_messages: [
        { conversationId: "synthetic-conversation", limit },
        "messages",
        "synthetic-message",
      ],
    };
    if (action === "get_message") {
      assert.deepEqual(input, { messageId: "synthetic-message" });
      return json({
        success: true,
        data: {
          message: {
            ...item("synthetic-message"),
            from: { id: "synthetic-account" },
            to: [{ id: "synthetic-customer" }],
          },
        },
      });
    }
    assert.ok(cases[action], "Only audited read actions may execute");
    const [expected, key, id] = cases[action];
    if (input.after !== undefined) {
      assert.ok(["list_conversations", "list_conversation_messages"].includes(action));
      assert.equal(input.after, cursor);
      expected.after = cursor;
    }
    assert.deepEqual(input, expected);
    if (input.after && secondPageDenied)
      return json({ success: false, error: privateSentinel }, 403);
    const rows =
      action === "list_conversation_messages" && messageRows !== undefined
        ? messageRows === null
          ? [null]
          : Array.from({ length: messageRows }, () => item(id))
        : empty
          ? []
          : [item(id)];
    return json({
      success: true,
      data: {
        [key]: rows,
        paging: pagination
          ? { ...paging, after: input.after && !repeatCursor ? "synthetic-second-cursor" : cursor }
          : paging,
      },
    });
  };
  return {
    calls,
    delays,
    run: () =>
      verifyHistoryAccess(
        "synthetic-admin",
        "synthetic-runtime",
        fetcher,
        async (ms) => {
          delays.push(ms);
        },
        pagination,
      ),
  };
}

test("uses bound runtime reads and provider-returned parent IDs; exports no content or credentials", async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.probePassed, true);
  assert.equal(report.accounts[0].checks.length, 6);
  assert.ok(report.accounts[0].checks.every((c) => c.result === "passed"));
  assert.deepEqual(f.delays, Array(6).fill(700));
  const output = JSON.stringify(report);
  for (const secret of [privateSentinel, "synthetic-", "private-token", "https://"])
    assert.ok(!output.includes(secret));
  assert.equal(f.calls.length, 8);
  assert.match(report.scope, /Not a complete history/);
});

test("empty pages retain unexercised child routes instead of claiming history coverage", async () => {
  const f = fixture({ empty: true });
  const report = await f.run();
  assert.equal(report.accounts[0].checks.filter((c) => c.result === "not_exercised").length, 4);
  assert.equal(f.calls.length, 4);
});

test("provider denials remain failures without leaking provider errors", async () => {
  const f = fixture({ failed: true });
  const report = await f.run();
  assert.equal(report.probePassed, false);
  assert.equal(report.accounts[0].checks.filter((c) => c.httpStatus === 403).length, 2);
  assert.ok(!JSON.stringify(report).includes(privateSentinel));
});

test("mismatched identity stops before any provider action", async () => {
  const f = fixture({ wrongAccount: true });
  await assert.rejects(f.run());
  assert.equal(f.calls.length, 2);
  assert.equal(f.delays.length, 0);
});

test("extra returned message references remain bounded and only one detail is read", async () => {
  const f = fixture({ messageRows: 2 });
  const report = await f.run();
  assert.equal(report.probePassed, true);
  assert.equal(report.accounts[0].checks[4].rows, 2);
  assert.equal(f.calls.filter((c) => c.url.includes("instagram.get_message/")).length, 1);
});

test("oversized and malformed message pages fail without reading a detail", async () => {
  for (const [messageRows, reason] of [
    [21, "response_row_limit_exceeded"],
    [null, "missing_item_id"],
  ]) {
    const f = fixture({ messageRows });
    const report = await f.run();
    assert.equal(report.probePassed, false);
    assert.equal(report.accounts[0].checks[4].reason, reason);
    assert.equal(f.calls.filter((c) => c.url.includes("instagram.get_message/")).length, 0);
  }
});

test("pagination follows one cursor per messaging edge and keeps only the first parent/detail", async () => {
  const f = fixture({ pagination: true });
  const report = await f.run();
  assert.equal(report.probePassed, true);
  const checks = report.accounts[0].checks;
  for (const action of ["list_conversations", "list_conversation_messages"]) {
    const pages = checks.filter((c) => c.action === `instagram.${action}`);
    assert.deepEqual(
      pages.map((c) => c.page),
      [1, 2],
    );
    assert.ok(pages.every((c) => c.morePages && c.cursorAdvanced));
  }
  assert.equal(checks.filter((c) => c.action === "instagram.get_message").length, 1);
  assert.equal(f.calls.length, 10);
  assert.deepEqual(f.delays, Array(8).fill(700));
  for (const secret of [privateSentinel, "synthetic-", "private-token", "https://"])
    assert.ok(!JSON.stringify(report).includes(secret));
});

test("invalid cursors stop paging and never appear in the report", async () => {
  for (const cursor of [undefined, "", "x".repeat(8193)]) {
    // null represents an absent provider cursor; undefined would select the fixture default.
    const f = fixture({ pagination: true, cursor: cursor ?? null });
    const report = await f.run();
    assert.equal(report.probePassed, false);
    assert.equal(
      report.accounts[0].checks.find((c) => c.action === "instagram.list_conversations").reason,
      "invalid_or_repeated_cursor",
    );
    assert.equal(f.calls.filter((c) => c.url.includes("instagram.list_conversations/")).length, 1);
    assert.equal(
      f.calls.filter((c) => c.url.includes("instagram.list_conversation_messages/")).length,
      0,
    );
    if (cursor) assert.ok(!JSON.stringify(report).includes(cursor));
  }
});

test("a repeated next cursor or second-page denial remains a failed probe", async () => {
  for (const option of [{ repeatCursor: true }, { secondPageDenied: true }]) {
    const f = fixture({ pagination: true, ...option });
    const report = await f.run();
    assert.equal(report.probePassed, false);
    assert.equal(f.calls.length, 10);
    const failures = report.accounts[0].checks.filter((c) => c.result === "failed");
    assert.equal(failures.length, 2);
    assert.ok(
      failures.every(
        (c) => c.reason === (option.repeatCursor ? "invalid_or_repeated_cursor" : "http_failure"),
      ),
    );
    assert.ok(!JSON.stringify(report).includes(privateSentinel));
  }
});
