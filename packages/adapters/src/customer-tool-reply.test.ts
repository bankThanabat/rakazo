import type { ConnectorCall } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { customerDeliveryId } from "./customer-mapping.js";
import { customerToolReply } from "./customer-tool-reply.js";

const binding = {
  receive: {
    items: ["messages"],
    incoming: { path: ["incoming"], equals: true },
    fields: {
      id: ["id"],
      threadId: ["thread"],
      customerId: ["user"],
      body: ["body"],
      timestamp: ["at"],
    },
  },
  send: {
    action: "sample.send",
    input: { to: "$threadId", texts: ["$body"], retryKey: "$messageId" },
  },
};
const recipient = { customerId: "customer", threadId: "thread" };
function call(): ConnectorCall {
  return {
    tool: "send",
    executionId: "customer.tool:message:call",
    route: { connectorId: "open-connector", toolName: "sample.send", resourceId: "account" },
    args: { to: "thread", texts: ["Hello"], retryKey: "model-key" },
  };
}
it("binds replies to the conversation and replaces the model retry key with a stable UUID", () => {
  const request = call();
  expect(customerToolReply(binding, "account", request, recipient)).toBe("Hello");
  expect(request.args.retryKey).toBe(customerDeliveryId(request.executionId, 0));
});
it("rejects foreign recipients and extra arguments", () => {
  const request = call();
  request.args.to = "another-thread";
  expect(() => customerToolReply(binding, "account", request, recipient)).toThrow("target");
  request.args.to = "thread";
  request.args.extra = "unapproved";
  expect(() => customerToolReply(binding, "account", request, recipient)).toThrow("Unexpected");
});
it("does not treat other actions as channel replies", () => {
  const request = call();
  request.route!.toolName = "sample.publish";
  expect(customerToolReply(binding, "account", request, recipient)).toBeNull();
});
