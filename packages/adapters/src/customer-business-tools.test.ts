import { describe, expect, it } from "vitest";
import { customerWorkflowInput, validateCustomerGrants } from "./customer-business-tools.js";

describe("customer workflow grants", () => {
  it("rejects writes without a preceding ownership check", () => {
    expect(() =>
      validateCustomerGrants([
        {
          name: "refund",
          description: "Refund",
          connectionId: "account",
          inputSchema: { type: "object" },
          steps: [{ name: "refund", action: "payments.refund", input: {}, effect: "write" }],
        },
      ]),
    ).toThrow("ownership");
  });
  it("binds model inputs and earlier results without allowing replacement of server scope", () => {
    expect(
      customerWorkflowInput(
        { customer: "$customerId", order: "$input.order", amount: "$steps.lookup.total" },
        {
          customerId: "verified-customer",
          input: { order: "order", customerId: "attacker" },
          steps: { lookup: { total: 20 } },
        },
      ),
    ).toEqual({ customer: "verified-customer", order: "order", amount: 20 });
    expect(() => customerWorkflowInput({ bad: "$input.__proto__" }, { input: {} })).toThrow();
  });
});
