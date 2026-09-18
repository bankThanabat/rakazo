import type { CustomerIncomingTemplate } from "./customer-incoming.js";

export const instagramIncoming: CustomerIncomingTemplate = {
  managed: true,
  secrets: [
    { key: "appSecret", label: "Instagram app secret" },
    { key: "verifyToken", label: "Verify token" },
  ],
  account: { action: "instagram.get_current_user", path: ["user", "userId"] },
  binding: ({ account, secretIds }) => ({
    receive: {
      mode: "webhook",
      batchPath: ["entry"],
      items: ["messaging"],
      account: { path: ["id"], equals: account },
      webhook: {
        secretId: secretIds.appSecret!,
        verificationSecretId: secretIds.verifyToken!,
        header: "x-hub-signature-256",
        algorithm: "sha256",
        encoding: "hex",
        prefix: "sha256=",
      },
      incoming: { path: ["recipient", "id"], equals: account },
      nonText: "handoff",
      timestampFormat: "milliseconds",
      fields: {
        id: ["message", "mid"],
        threadId: ["sender", "id"],
        customerId: ["sender", "id"],
        body: ["message", "text"],
        timestamp: ["timestamp"],
      },
    },
    send: {
      action: "instagram.send_message",
      input: { recipientId: "$customerId", text: "$body" },
      textLimit: { max: 1000, unit: "utf8" },
    },
  }),
};
