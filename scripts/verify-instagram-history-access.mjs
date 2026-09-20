// Run inside the connector container; credentials and provider content stay there.
// At most two messaging pages and one child per edge. No imports, learning, or provider writes.
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const actions = new Set([
  "list_media",
  "list_media_comments",
  "list_comment_replies",
  "list_conversations",
  "list_conversation_messages",
  "get_message",
]);

async function boundedJson(response) {
  assert.ok(response.body);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    assert.ok(bytes <= 1024 * 1024);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function verifyHistoryAccess(
  admin,
  runtime,
  fetcher = fetch,
  pause = setTimeout,
  pagination = false,
) {
  assert.ok(admin && runtime);
  const request = async (path, init = {}) => {
    const response = await fetcher(`http://127.0.0.1:3000${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${admin}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    return { status: response.status, body: await boundedJson(response) };
  };
  const inventory = await request("/api/connections");
  assert.equal(inventory.status, 200);
  assert.ok(Array.isArray(inventory.body));
  const selected = inventory.body.filter((c) => c.service === "instagram" && c.configured);
  assert.ok(selected.length > 0 && selected.length <= 4);
  const accounts = [];
  for (const connection of selected) {
    assert.ok(typeof connection.id === "string" && connection.id);
    assert.ok(typeof connection.connectionName === "string" && connection.connectionName);
    const identity = await request(`/v1/connections/by-id/${encodeURIComponent(connection.id)}`);
    assert.equal(identity.status, 200);
    const account = identity.body.data;
    assert.equal(account.service, "instagram");
    assert.equal(account.alias, connection.connectionName);
    assert.ok(typeof account.providerAccountId === "string" && account.providerAccountId);
    const checks = [];
    const invoke = async (action, input) => {
      assert.ok(actions.has(action));
      // Conservative pacing, including requests that fail. No provider paging URLs.
      await pause(700);
      const check = { action: `instagram.${action}`, result: "failed" };
      checks.push(check);
      try {
        const response = await request(
          `/v1/actions/instagram.${action}/for-account/${encodeURIComponent(account.providerAccountId)}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime}`,
              "x-oo-connector-alias": connection.connectionName,
            },
            body: JSON.stringify({ input }),
          },
        );
        check.httpStatus = response.status;
        if (response.status !== 200 || response.body.success !== true) {
          check.reason = response.status === 200 ? "provider_failure" : "http_failure";
          return null;
        }
        assert.ok(response.body.data && typeof response.body.data === "object");
        return { data: response.body.data, check };
      } catch {
        // Never return provider messages, IDs, credentials, URLs, text, or cursors.
        check.reason = "unreadable_response";
        return null;
      }
    };
    const page = async (action, input, key, dateKey, pageNumber = 1) => {
      const result = await invoke(action, { ...input, limit: pagination ? 20 : 1 });
      if (!result) return null;
      const { data, check } = result;
      if (pagination) check.page = pageNumber;
      check.rows = Array.isArray(data[key]) ? data[key].length : null;
      if (
        !Array.isArray(data[key]) ||
        data[key].length > 20 ||
        data[key].some((item) => typeof item?.id !== "string" || !item.id) ||
        typeof data.paging?.hasNextPage !== "boolean" ||
        typeof data.paging?.hasPreviousPage !== "boolean"
      ) {
        check.reason = !Array.isArray(data[key])
          ? "missing_rows"
          : data[key].length > 20
            ? "response_row_limit_exceeded"
            : data[key].some((item) => typeof item?.id !== "string" || !item.id)
              ? "missing_item_id"
              : "missing_pagination_flags";
        return null;
      }
      check.result = "passed";
      check.rows = data[key].length;
      check.morePages = data.paging.hasNextPage;
      check.rowsWithTimestamp = data[key].filter(
        (item) => typeof item[dateKey] === "string" && Number.isFinite(Date.parse(item[dateKey])),
      ).length;
      if (
        pagination &&
        ["list_conversations", "list_conversation_messages"].includes(action) &&
        data.paging.hasNextPage
      ) {
        const after = data.paging.after;
        if (typeof after !== "string" || !after || after.length > 8192 || after === input.after) {
          check.result = "failed";
          check.reason = "invalid_or_repeated_cursor";
          return null;
        }
        check.cursorAdvanced = true;
        if (pageNumber === 1) await page(action, { ...input, after }, key, dateKey, 2);
      }
      return data[key][0] ?? null;
    };
    const skipped = (action) =>
      checks.push({
        action: `instagram.${action}`,
        result: "not_exercised",
        reason: "no_parent_returned",
      });
    const media = await page("list_media", {}, "media", "timestamp");
    if (media) {
      const comment = await page(
        "list_media_comments",
        { mediaId: media.id },
        "comments",
        "timestamp",
      );
      if (comment)
        await page("list_comment_replies", { commentId: comment.id }, "comments", "timestamp");
      else skipped("list_comment_replies");
    } else {
      skipped("list_media_comments");
      skipped("list_comment_replies");
    }
    const conversation = await page("list_conversations", {}, "conversations", "updatedTime");
    if (conversation) {
      const reference = await page(
        "list_conversation_messages",
        { conversationId: conversation.id },
        "messages",
        "createdTime",
      );
      if (reference) {
        const result = await invoke("get_message", { messageId: reference.id });
        if (result?.data.message?.id === reference.id) {
          const { message } = result.data;
          Object.assign(result.check, {
            result: "passed",
            hasTimestamp:
              typeof message.createdTime === "string" &&
              Number.isFinite(Date.parse(message.createdTime)),
            hasText: typeof message.text === "string" && message.text.length > 0,
            hasSender: typeof message.from?.id === "string" && Boolean(message.from.id),
            hasRecipients:
              Array.isArray(message.to) &&
              message.to.length > 0 &&
              message.to.every((to) => typeof to.id === "string" && to.id),
            senderMatchesBusinessAccount: message.from?.id === account.providerAccountId,
          });
        }
      } else skipped("get_message");
    } else {
      skipped("list_conversation_messages");
      skipped("get_message");
    }
    accounts.push({ ordinal: accounts.length + 1, checks });
  }
  return {
    probePassed: accounts.every((a) => a.checks.every((c) => c.result !== "failed")),
    readOnlyProviderActions: true,
    accounts,
    scope: `${pagination ? "At most two pages for conversation/message references; one page for other edges" : "One page per edge"}, capped at 20 rows per page; only the first item is followed in each of two branches. Not a complete history, 30-day coverage, staff-authorship proof, import, or delivery check.`,
  };
}

if (
  !process.argv[1] ||
  process.argv[1] === "-" ||
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Connector-owned credentials stay inside its container.
    const admin = process.env.OOMOL_CONNECT_ADMIN_TOKEN;
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Bound execution uses the existing runtime credential.
    const runtime = process.env.OOMOL_CONNECT_RUNTIME_TOKEN;
    const result = await verifyHistoryAccess(
      admin,
      runtime,
      fetch,
      setTimeout,
      process.argv.includes("--pagination"),
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.probePassed) process.exitCode = 1;
  } catch {
    console.log(
      JSON.stringify({
        probePassed: false,
        error: "History preflight failed; provider details withheld.",
      }),
    );
    process.exitCode = 1;
  }
}
