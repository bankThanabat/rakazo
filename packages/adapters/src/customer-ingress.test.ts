import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { CustomerBindingSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { verifyCustomerWebhook } from "./customer-ingress.js";
import { customerPage } from "./customer-mapping.js";

const examples = JSON.parse(
  readFileSync(new URL("../../../docs/self-host/customer-bindings.json", import.meta.url), "utf8"),
);
const at = 1767312000000;
describe("real messaging payload contracts", () => {
  it("authenticates LINE text and ignores another account and non-message events", () => {
    const binding = CustomerBindingSchema.parse(examples.line);
    const raw = JSON.stringify({
      destination: "CONNECTED_BOT_USER_ID",
      events: [
        { type: "follow" },
        {
          webhookEventId: "event",
          type: "message",
          source: { userId: "customer" },
          message: { id: "message", type: "text", text: "Offer?" },
          timestamp: at,
        },
      ],
    });
    const verification = binding.receive.webhook!;
    const signature = createHmac("sha256", "fake-secret").update(raw).digest("base64");
    verifyCustomerWebhook(
      raw,
      new Headers({ "x-line-signature": signature }),
      verification,
      "fake-secret",
    );
    expect(() =>
      verifyCustomerWebhook(
        `${raw} `,
        new Headers({ "x-line-signature": signature }),
        verification,
        "fake-secret",
      ),
    ).toThrow();
    expect(customerPage(binding, JSON.parse(raw), new Date(0)).messages).toMatchObject([
      { customerId: "customer", body: "Offer?" },
    ]);
    expect(
      customerPage(binding, { ...JSON.parse(raw), destination: "other-account" }, new Date(0))
        .messages,
    ).toEqual([]);
  });
  it("filters batched Instagram accounts and verifies the Meta signature", () => {
    const binding = CustomerBindingSchema.parse(examples.instagram);
    const event = {
      sender: { id: "customer" },
      recipient: { id: "CONNECTED_INSTAGRAM_ACCOUNT_ID" },
      timestamp: at,
      message: { mid: "event", text: "Hello" },
    };
    const data = {
      entry: [
        { id: "other-account", messaging: [event] },
        { id: "CONNECTED_INSTAGRAM_ACCOUNT_ID", messaging: [event] },
      ],
    };
    const raw = JSON.stringify(data);
    verifyCustomerWebhook(
      raw,
      new Headers({
        "x-hub-signature-256": `sha256=${createHmac("sha256", "fake-secret").update(raw).digest("hex")}`,
      }),
      binding.receive.webhook!,
      "fake-secret",
    );
    expect(customerPage(binding, data, new Date(0)).messages).toHaveLength(1);
  });
  it("advances Telegram over complete normalized pages and unsupported updates", () => {
    const binding = CustomerBindingSchema.parse(examples.telegram);
    const updates = Array.from({ length: 100 }, (_, i) => ({
      updateId: i + 1,
      message: { from: { id: 7, isBot: false }, chat: { id: 8 }, text: "Hello", date: at / 1000 },
    }));
    const page = customerPage(binding, { updates: [...updates, { updateId: 101 }] }, new Date(0));
    expect(page.messages).toHaveLength(100);
    expect(page.cursor).toBe(102);
    expect(customerPage(binding, { updates: [] }, new Date(0)).cursor).toBeUndefined();
    expect(
      customerPage(binding, { updates: [{ ...updates[0], updateId: 102 }] }, new Date(0)).cursor,
    ).toBe(103);
  });
});
