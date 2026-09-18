import { readFileSync } from "node:fs";
import { CustomerBindingSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { customerIncomingTemplate } from "./customer-incoming.js";
import { instagramIncoming } from "./customer-incoming-instagram.js";
import { lineIncoming } from "./customer-incoming-line.js";
import { customerPage } from "./customer-mapping.js";

const examples = JSON.parse(
  readFileSync(new URL("../../../docs/self-host/customer-bindings.json", import.meta.url), "utf8"),
);
const templates = { line: lineIncoming, instagram: instagramIncoming };

/** Every registered incoming template must satisfy the same contract so shared
 * setup, relay and ingress code can stay provider-agnostic. */
describe.each(Object.entries(templates))("incoming template %s", (provider, template) => {
  const secretIds = Object.fromEntries(
    template.secrets.map((secret) => [secret.key, `secret:${secret.key}`]),
  );
  const binding = CustomerBindingSchema.parse(
    template.binding({ account: "connected-account", secretIds }),
  );
  it("is registered and declares at least one secret", () => {
    expect(customerIncomingTemplate(provider)).toBe(template);
    expect(template.secrets.length).toBeGreaterThan(0);
    expect(new Set(template.secrets.map((secret) => secret.key)).size).toBe(
      template.secrets.length,
    );
  });
  it("builds a webhook binding whose signing secret is one of the declared secrets", () => {
    expect(binding.receive.mode).toBe("webhook");
    expect(Object.values(secretIds)).toContain(binding.receive.webhook?.secretId);
  });
  it("filters payloads by the verified account when it declares an account lookup", () => {
    if (template.account) expect(binding.receive.account?.equals).toBe("connected-account");
  });
  it("maps the same way as the documented manual example", () => {
    const documented = CustomerBindingSchema.parse(examples[provider]);
    expect(binding.receive.fields).toEqual(documented.receive.fields);
    expect(binding.send.action).toBe(documented.send.action);
  });
});

it("maps Instagram DMs and attachments, excluding other accounts, echoes and read receipts", () => {
  const binding = CustomerBindingSchema.parse(
    instagramIncoming.binding({
      account: "business",
      secretIds: { appSecret: "secret", verifyToken: "verify" },
    }),
  );
  const dm = {
    sender: { id: "customer" },
    recipient: { id: "business" },
    timestamp: 1767312000000,
    message: { mid: "dm", text: "Hello" },
  };
  const payload = {
    entry: [
      { id: "other-business", messaging: [dm] },
      {
        id: "business",
        messaging: [
          dm,
          { ...dm, message: { mid: "attachment", attachments: [{}] } },
          {
            ...dm,
            sender: { id: "business" },
            recipient: { id: "customer" },
            message: { mid: "echo", is_echo: true, text: "Reply" },
          },
          {
            sender: dm.sender,
            recipient: dm.recipient,
            timestamp: dm.timestamp,
            read: { mid: "dm" },
          },
        ],
      },
    ],
  };
  expect(
    customerPage(binding, payload, new Date(0)).messages.map((m) => [m.externalId, m.unsupported]),
  ).toEqual([
    ["attachment", true],
    ["dm", false],
  ]);
});

it("routes LINE group, room and direct chats to distinct threads and skips senders LINE withholds", () => {
  const binding = CustomerBindingSchema.parse(
    lineIncoming.binding({ account: "bot", secretIds: { channelSecret: "secret" } }),
  );
  const event = (source: Record<string, string>, id: string) => ({
    webhookEventId: id,
    type: "message",
    timestamp: 1767312000000,
    source,
    message: { type: "text", text: id },
  });
  const page = customerPage(
    binding,
    {
      destination: "bot",
      events: [
        event({ type: "user", userId: "u1" }, "direct"),
        event({ type: "group", groupId: "g1", userId: "u1" }, "group"),
        event({ type: "room", roomId: "r1", userId: "u2" }, "room"),
        event({ type: "group", groupId: "g1" }, "anonymous"),
      ],
    },
    new Date(0),
  );
  expect(page.messages.map((message) => [message.externalId, message.externalThreadId])).toEqual([
    ["direct", "u1"],
    ["group", "g1"],
    ["room", "r1"],
  ]);
});
