import { randomUUID } from "node:crypto";
import type { AdapterPostableMessage, UserInfo, WebhookOptions } from "chat";
import * as z from "zod";
import { CustomerChatAdapter, parseCustomerJson, validSignature } from "./base.js";

const Payload = z.object({
  destination: z.string(),
  events: z.array(
    z.object({
      type: z.string(),
      webhookEventId: z.string().optional(),
      timestamp: z.number(),
      source: z.object({ type: z.string(), userId: z.string().optional() }),
      message: z
        .object({ id: z.string(), type: z.string(), text: z.string().optional() })
        .optional(),
    }),
  ),
});
export class LineCustomerAdapter extends CustomerChatAdapter {
  readonly name = "line";
  async getUser(userId: string): Promise<UserInfo> {
    const response = await this.fetcher(
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${this.credentials.accessToken}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("Customer profile unavailable");
    const profile = z
      .object({
        userId: z.literal(userId),
        displayName: z.string().trim().min(1).max(300),
        pictureUrl: z.string().optional(),
      })
      .parse(await response.json());
    return {
      userId,
      fullName: profile.displayName,
      userName: profile.displayName,
      avatarUrl: profile.pictureUrl,
      isBot: false,
    };
  }
  async handleWebhook(request: Request, options?: WebhookOptions) {
    const body = await request.text();
    if (
      !validSignature(
        this.credentials.channelSecret!,
        body,
        request.headers.get("x-line-signature"),
        "base64",
      )
    )
      return new Response("Unauthorized", { status: 401 });
    const parsed = Payload.safeParse(parseCustomerJson(body));
    if (!parsed.success || parsed.data.destination !== this.accountId)
      return new Response("Invalid destination", { status: 400 });
    return this.dispatch(
      parsed.data.events.flatMap((event) => {
        if (
          event.type !== "message" ||
          event.source.type !== "user" ||
          !event.source.userId ||
          !event.message
        )
          return [];
        return [
          {
            id: event.message.id,
            receiptId: event.webhookEventId ?? event.message.id,
            sender: event.source.userId,
            conversation: event.source.userId,
            timestamp: event.timestamp,
            text: event.message.text ?? `[${event.message.type} attachment]`,
          },
        ];
      }),
      options,
    );
  }
  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
    idempotencyKey: string = randomUUID(),
  ) {
    const text = this.text(message);
    let response: Response;
    try {
      response = await this.fetcher("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        body: JSON.stringify({
          to: this.decodeThreadId(threadId),
          messages: [{ type: "text", text }],
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials.accessToken}`,
          "X-Line-Retry-Key": idempotencyKey,
        },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
    } catch {
      throw new RetryableCustomerSendError();
    }
    if (response.status >= 500) throw new RetryableCustomerSendError();
    if (
      !response.ok &&
      !(response.status === 409 && response.headers.has("x-line-accepted-request-id"))
    )
      throw new Error(`Channel send failed (${response.status})`);
    try {
      const parsed = z
        .object({ sentMessages: z.array(z.object({ id: z.string() })).min(1) })
        .parse(await response.json());
      return this.sent(threadId, parsed.sentMessages[0]!.id, text);
    } catch {
      throw new RetryableCustomerSendError();
    }
  }
}

export class RetryableCustomerSendError extends Error {
  constructor() {
    super("Channel send outcome is unknown");
  }
}
