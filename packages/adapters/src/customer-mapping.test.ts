import { CustomerBindingSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { customerField, customerInput, customerPage } from "./customer-mapping.js";

const customerTestBinding = CustomerBindingSchema.parse({
  receive: {
    action: "sample.list",
    input: { cursor: "$cursor", since: "$since" },
    items: ["messages"],
    cursor: ["cursor"],
    incoming: { path: ["direction"], equals: "incoming" },
    fields: {
      id: ["id"],
      threadId: ["thread"],
      customerId: ["sender"],
      body: ["text"],
      timestamp: ["at"],
    },
  },
  send: {
    action: "sample.send",
    input: { to: "$threadId", texts: ["$body"], retryKey: "$messageId" },
  },
});
const message = {
  id: "message",
  thread: "thread",
  sender: "customer",
  text: "hello",
  at: "2026-01-02T00:00:00Z",
  direction: "incoming",
};
describe("messaging action mappings", () => {
  it("ignores old messages and echoes and orders a page before accepting its checkpoint", () => {
    const result = customerPage(
      customerTestBinding,
      {
        cursor: "page-two",
        messages: [
          { ...message, id: "later", at: "2026-01-03T00:00:00Z" },
          message,
          { ...message, id: "old", at: "2025-01-01T00:00:00Z" },
          { ...message, id: "echo", direction: "outgoing" },
        ],
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result.messages.map((m) => m.externalId)).toEqual(["message", "later"]);
    expect(result.cursor).toBe("page-two");
  });
  it("does not interpret message content, expressions or prototype properties", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal untrusted input must remain unevaluated.
    const body = "${process.env.SECRET} $cursor";
    expect(
      customerInput(customerTestBinding.send.input, {
        threadId: "thread",
        body,
        messageId: "message",
      }),
    ).toEqual({ to: "thread", texts: [body], retryKey: "message" });
    expect(() => customerInput({ value: "$unknown" }, {})).toThrow();
    expect(() => customerField({}, ["constructor"])).toThrow();
    expect(() => customerInput(JSON.parse('{"__proto__":1}'), {})).toThrow();
  });
  it("rejects malformed input instead of advancing the cursor past lost messages", () => {
    expect(() =>
      customerPage(
        customerTestBinding,
        { cursor: "next", messages: [{ ...message, at: "invalid" }] },
        new Date(0),
      ),
    ).toThrow();
    expect(() =>
      customerPage(
        customerTestBinding,
        { cursor: "next", messages: [{ ...message, text: "" }] },
        new Date(0),
      ),
    ).toThrow();
  });
  it("accepts an omitted terminal cursor but rejects a malformed checkpoint", () => {
    expect(customerPage(customerTestBinding, { messages: [] }, new Date(0)).cursor).toBeNull();
    expect(() =>
      customerPage(customerTestBinding, { messages: [], cursor: {} }, new Date(0)),
    ).toThrow();
  });
});
