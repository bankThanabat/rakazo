import type { AdapterPostableMessage, WebhookOptions } from "chat";
import * as z from "zod";
import { CustomerChatAdapter, parseCustomerJson, validSecret, validSignature } from "./base.js";

const Payload = z.object({
  object: z.literal("instagram"),
  entry: z.array(
    z.object({
      id: z.string(),
      messaging: z
        .array(
          z.object({
            sender: z.object({ id: z.string() }),
            recipient: z.object({ id: z.string() }),
            timestamp: z.number(),
            message: z
              .object({
                mid: z.string(),
                text: z.string().optional(),
                is_echo: z.boolean().optional(),
                is_deleted: z.boolean().optional(),
                attachments: z
                  .array(
                    z.object({
                      type: z.string(),
                      payload: z.object({ url: z.string().optional() }),
                    }),
                  )
                  .optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    }),
  ),
});
export class InstagramCustomerAdapter extends CustomerChatAdapter {
  readonly name = "instagram";
  async handleWebhook(request: Request, options?: WebhookOptions) {
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      return params.get("hub.mode") === "subscribe" &&
        validSecret(this.credentials.verifyToken!, params.get("hub.verify_token"))
        ? new Response(params.get("hub.challenge") ?? "")
        : new Response("Unauthorized", { status: 401 });
    }
    const body = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (
      !signature?.startsWith("sha256=") ||
      !validSignature(this.credentials.appSecret!, body, signature.slice("sha256=".length))
    )
      return new Response("Unauthorized", { status: 401 });
    const parsed = Payload.safeParse(parseCustomerJson(body));
    if (!parsed.success) return new Response("Invalid event", { status: 400 });
    return this.dispatch(
      parsed.data.entry
        .filter((entry) => entry.id === this.accountId)
        .flatMap((entry) =>
          (entry.messaging ?? []).flatMap((event) => {
            if (
              event.recipient.id !== this.accountId ||
              !event.message ||
              event.message.is_echo ||
              event.message.is_deleted ||
              (!event.message.text?.trim() && !event.message.attachments?.length)
            )
              return [];
            return [
              {
                id: event.message.mid,
                sender: event.sender.id,
                conversation: event.sender.id,
                timestamp: event.timestamp,
                text: event.message.text ?? "[Attachment]",
                mediaUrl: event.message.attachments?.[0]?.payload.url,
              },
            ];
          }),
        ),
      options,
    );
  }
  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const text = this.text(message);
    const result = await this.post(
      `https://graph.instagram.com/${this.credentials.apiVersion}/${this.accountId}/messages`,
      { recipient: { id: this.decodeThreadId(threadId) }, message: { text } },
      { Authorization: `Bearer ${this.credentials.accessToken}` },
    );
    return this.sent(threadId, z.object({ message_id: z.string() }).parse(result).message_id, text);
  }
}
