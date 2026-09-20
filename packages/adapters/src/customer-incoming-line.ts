import type { CustomerIncomingTemplate } from "./customer-incoming.js";

/** LINE Messaging API. Everything LINE-specific about receiving customer messages
 * lives here: the channel secret signs the raw body with HMAC-SHA256 (base64) in
 * `X-Line-Signature`, `destination` carries the bot user ID, group and room chats
 * have their own IDs, and staff replies use push messages with a stable retry key. */
export const lineIncoming: CustomerIncomingTemplate = {
  secrets: [{ key: "channelSecret", label: "Channel secret" }],
  account: { action: "line.get_bot_info", path: ["userId"] },
  binding: ({ account, secretIds }) => ({
    receive: {
      mode: "webhook",
      items: ["events"],
      account: { path: ["destination"], equals: account },
      webhook: {
        secretId: secretIds.channelSecret!,
        header: "X-Line-Signature",
        algorithm: "sha256",
        encoding: "base64",
      },
      incoming: { path: ["type"], equals: "message" },
      nonText: "handoff",
      withdrawal: {
        event: { path: ["type"], equals: "unsend" },
        messageId: ["unsend", "messageId"],
      },
      timestampFormat: "milliseconds",
      fields: {
        id: ["webhookEventId"],
        providerMessageId: ["message", "id"],
        threadId: [
          ["source", "groupId"],
          ["source", "roomId"],
          ["source", "userId"],
        ],
        customerId: ["source", "userId"],
        body: ["message", "text"],
        timestamp: ["timestamp"],
      },
    },
    send: {
      action: "line.send_push_text",
      input: { to: "$threadId", texts: ["$body"], retryKey: "$messageId" },
      textLimit: { max: 5000, unit: "characters" },
    },
  }),
};
