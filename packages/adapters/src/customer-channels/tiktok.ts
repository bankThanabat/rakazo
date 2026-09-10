import type { AdapterPostableMessage, WebhookOptions } from "chat";
import * as z from "zod";
import { CustomerChatAdapter, parseCustomerJson, validSignature } from "./base.js";

const Envelope = z.object({ event: z.string(), user_openid: z.string(), content: z.string() });
const Content = z.object({
  conversation_id: z.string(),
  message_id: z.string(),
  timestamp: z.number(),
  type: z.string(),
  from: z.string().optional(),
  from_user: z.object({ id: z.string() }),
  to_user: z.object({ id: z.string() }),
  text: z.object({ body: z.string() }).optional(),
});
export class TikTokCustomerAdapter extends CustomerChatAdapter {
  readonly name = "tiktok";
  async handleWebhook(request: Request, options?: WebhookOptions) {
    const body = await request.text();
    const signature = request.headers.get("tiktok-signature") ?? "";
    const parts = Object.fromEntries(signature.split(",").map((part) => part.trim().split("=")));
    const timestamp = Number(parts.t);
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 300 ||
      !validSignature(this.credentials.clientSecret!, `${parts.t}.${body}`, parts.s ?? null)
    )
      return new Response("Unauthorized", { status: 401 });
    const envelope = Envelope.safeParse(parseCustomerJson(body));
    if (!envelope.success || envelope.data.user_openid !== this.accountId)
      return new Response("Invalid destination", { status: 400 });
    if (envelope.data.event !== "im_receive_msg") return new Response("OK");
    const parsed = Content.safeParse(parseCustomerJson(envelope.data.content));
    if (!parsed.success || parsed.data.to_user.id !== this.accountId)
      return new Response("Invalid recipient", { status: 400 });
    const event = parsed.data;
    return this.dispatch(
      [
        {
          id: event.message_id,
          sender: event.from_user.id,
          conversation: event.conversation_id,
          name: event.from,
          timestamp: event.timestamp,
          text: event.text?.body ?? `[${event.type} attachment]`,
        },
      ],
      options,
    );
  }
  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const text = this.text(message);
    const result = await this.post(
      "https://business-api.tiktok.com/open_api/v1.3/business/message/send/",
      {
        business_id: this.accountId,
        recipient_type: "CONVERSATION",
        recipient: this.decodeThreadId(threadId),
        message_type: "TEXT",
        text: { body: text },
      },
      { "Access-Token": this.credentials.accessToken! },
    );
    const parsed = z
      .object({
        code: z.literal(0),
        data: z.object({ message: z.object({ message_id: z.string() }) }),
      })
      .parse(result);
    return this.sent(threadId, parsed.data.message.message_id, text);
  }
}
