import { createHmac } from "node:crypto";
import type { CustomerProvider } from "@rakazo/contracts";

/** Provider HTTP boundary for deterministic channel conformance and inbox journeys. */
export class CustomerChannelEmulator {
  readonly sent: Array<{
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  readonly attempts: typeof this.sent = [];
  readonly accepted = new Map<string, string>();
  loseResponse = false;
  failSend = false;
  readonly profiles = new Map<string, { displayName: string; pictureUrl?: string }>();
  profileRequests = 0;
  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) {
      this.profileRequests++;
      const userId = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
      const profile = this.profiles.get(userId);
      return profile
        ? Response.json({ userId, ...profile })
        : Response.json({ message: "Not found" }, { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const headers = Object.fromEntries(new Headers(init?.headers));
    this.attempts.push({ url, body, headers });
    if (this.failSend) return Response.json({ error: "unavailable" }, { status: 503 });
    if (
      !url.startsWith("https://api.line.me/") &&
      !url.startsWith("https://graph.instagram.com/") &&
      !url.startsWith("https://business-api.tiktok.com/")
    )
      throw new Error("Unexpected customer provider URL");
    const retryKey = headers["x-line-retry-key"];
    if (retryKey && this.accepted.has(retryKey))
      return Response.json(
        { sentMessages: [{ id: this.accepted.get(retryKey) }] },
        { status: 409, headers: { "x-line-accepted-request-id": "accepted-request" } },
      );
    this.sent.push({ url, body, headers });
    const id = `sent-${this.sent.length}`;
    if (url.includes("api.line.me")) {
      if (retryKey) this.accepted.set(retryKey, id);
      if (this.loseResponse) throw new Error("Response lost after acceptance");
      return Response.json({ sentMessages: [{ id }] });
    }
    if (url.includes("graph.instagram.com")) return Response.json({ message_id: id });
    return Response.json({ code: 0, data: { message: { message_id: id } } });
  };
  request(
    provider: CustomerProvider,
    input: {
      url: string;
      accountId: string;
      secret: string;
      sender?: string;
      eventId?: string;
      messageId?: string;
      text?: string;
      timestamp?: number;
      mediaUrl?: string;
    },
  ) {
    const timestamp = input.timestamp ?? Date.now();
    const sender = input.sender ?? "customer-1";
    const id = input.eventId ?? "event-1";
    const text = input.text ?? "Hello";
    let payload: unknown;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider === "line")
      payload = {
        destination: input.accountId,
        events: [
          {
            type: "message",
            webhookEventId: id,
            timestamp,
            source: { type: "user", userId: sender },
            message: { id: input.messageId ?? id, type: "text", text },
          },
        ],
      };
    else if (provider === "instagram")
      payload = {
        object: "instagram",
        entry: [
          {
            id: input.accountId,
            messaging: [
              {
                sender: { id: sender },
                recipient: { id: input.accountId },
                timestamp,
                message: {
                  mid: id,
                  text,
                  ...(input.mediaUrl
                    ? { attachments: [{ type: "image", payload: { url: input.mediaUrl } }] }
                    : {}),
                },
              },
            ],
          },
        ],
      };
    else if (provider === "tiktok")
      payload = {
        event: "im_receive_msg",
        user_openid: input.accountId,
        content: JSON.stringify({
          conversation_id: `conversation-${sender}`,
          message_id: id,
          timestamp,
          type: "text",
          from: "Customer",
          from_user: { id: sender },
          to_user: { id: input.accountId },
          text: { body: text },
        }),
      };
    else throw new Error("Unsupported fixture provider");
    const body = JSON.stringify(payload);
    if (provider === "line")
      headers["x-line-signature"] = createHmac("sha256", input.secret)
        .update(body)
        .digest("base64");
    else if (provider === "instagram")
      headers["x-hub-signature-256"] =
        `sha256=${createHmac("sha256", input.secret).update(body).digest("hex")}`;
    else {
      const t = Math.floor(timestamp / 1000);
      headers["tiktok-signature"] =
        `t=${t},s=${createHmac("sha256", input.secret).update(`${t}.${body}`).digest("hex")}`;
    }
    return new Request(input.url, { method: "POST", headers, body });
  }
}
