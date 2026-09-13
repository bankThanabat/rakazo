import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lineReplyInput, parseLineWebhook } from "./line-webhook.js";

const secret = "fake-channel-secret";
const payload = {
  destination: "bot",
  events: [
    {
      type: "message",
      webhookEventId: "event-1",
      timestamp: 1000,
      source: { type: "user", userId: "Ucontact" },
      message: { type: "text", id: "message-1", text: "Hello" },
    },
  ],
};
function request(body = JSON.stringify(payload), key = secret) {
  return new Request("https://example.test/webhook", {
    method: "POST",
    headers: { "x-line-signature": createHmac("sha256", key).update(body).digest("base64") },
    body,
  });
}
describe("LINE incoming messages", () => {
  it("verifies original bytes and scopes identities to the connection", async () => {
    const result = await parseLineWebhook(request(), secret, "account-a");
    expect(result.status).toBe(200);
    expect(result.events).toEqual([
      expect.objectContaining({
        workspaceId: "account-a",
        eventId: "account-a:event-1",
        conversationId: "Ucontact",
        content: "Hello",
        kind: "direct",
      }),
    ]);
    const other = await parseLineWebhook(request(), secret, "account-b");
    expect(other.events[0]?.eventId).not.toBe(result.events[0]?.eventId);
  });
  it("rejects invalid signatures before parsing or routing", async () => {
    expect(
      (await parseLineWebhook(request("not-json", "wrong-secret"), secret, "account-a")).status,
    ).toBe(401);
    const unsigned = new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect((await parseLineWebhook(unsigned, secret, "account-a")).status).toBe(401);
  });
  it("accepts empty verification, ignores non-text/group events, and rejects malformed signed JSON", async () => {
    expect(await parseLineWebhook(request(JSON.stringify({ events: [] })), secret, "a")).toEqual({
      status: 200,
      events: [],
    });
    expect(
      (
        await parseLineWebhook(
          request(
            JSON.stringify({
              events: [
                { type: "follow" },
                { ...payload.events[0], source: { type: "group", groupId: "group" } },
              ],
            }),
          ),
          secret,
          "a",
        )
      ).events,
    ).toEqual([]);
    expect((await parseLineWebhook(request("not-json"), secret, "a")).status).toBe(400);
  });
  it("uses stable account-specific retry UUIDs and preserves unicode within LINE limits", () => {
    const first = lineReplyInput("a", {
      conversationId: "Ucontact",
      content: "😀".repeat(18000),
      replyThreadId: null,
      idempotencyKey: "delivery-1",
    });
    expect(first.retryKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.texts).toHaveLength(5);
    expect(first.texts.every((text) => text.length <= 5000 && !/[\uD800-\uDBFF]$/.test(text))).toBe(
      true,
    );
    expect(
      lineReplyInput("a", {
        conversationId: "Ucontact",
        content: "Hello",
        replyThreadId: null,
        idempotencyKey: "delivery-1",
      }).retryKey,
    ).toBe(first.retryKey);
    expect(
      lineReplyInput("b", {
        conversationId: "Ucontact",
        content: "Hello",
        replyThreadId: null,
        idempotencyKey: "delivery-1",
      }).retryKey,
    ).not.toBe(first.retryKey);
  });
});
