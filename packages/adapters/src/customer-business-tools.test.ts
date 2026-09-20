import { describe, expect, it } from "vitest";
import { customerWorkflowInput, validateCustomerGrants } from "./customer-business-tools.js";

describe("customer workflow grants", () => {
  it("does not let an owned read authorize returning another unchecked record", () => {
    const grant = {
      name: "details",
      description: "Customer details",
      connectionId: "account",
      inputSchema: { type: "object" },
      steps: [
        {
          name: "owned",
          action: "customer.get",
          effect: "read",
          input: {},
          check: { path: ["id"], equals: "$providerCustomerId" },
        },
        { name: "other", action: "orders.get", effect: "read", input: { id: "$input.orderId" } },
      ],
    };
    expect(() => validateCustomerGrants([grant])).toThrow("returned customer record");
  });
  it("accepts a linked merchant namespace without allowing model identity substitution", () => {
    const grant = {
      name: "order",
      description: "Owned order",
      connectionId: "merchant",
      inputSchema: { type: "object" },
      steps: [
        {
          name: "owner",
          action: "orders.get",
          effect: "read",
          input: { customer: "$providerCustomerId" },
          check: { path: ["customerId"], equals: "$providerCustomerId" },
        },
      ],
    };
    expect(() => validateCustomerGrants([grant])).not.toThrow();
    expect(() =>
      validateCustomerGrants([
        {
          ...grant,
          steps: [
            {
              ...grant.steps[0],
              check: { path: ["customerId"], equals: "$input.providerCustomerId" },
            },
          ],
        },
      ]),
    ).toThrow("ownership");
    expect(
      customerWorkflowInput(
        { id: "$providerCustomerId" },
        { providerCustomerId: 7, input: { providerCustomerId: 99 } },
      ),
    ).toEqual({ id: 7 });
  });
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
  it("requires write identity to come from the checked provider record", () => {
    const grant = {
      name: "invoice",
      description: "Invoice",
      connectionId: "account",
      inputSchema: { type: "object" },
      steps: [
        {
          name: "owner",
          action: "orders.get",
          input: {},
          effect: "read",
          check: { path: ["customerId"], equals: "$customerId" },
        },
        { name: "write", action: "invoices.create", input: {}, effect: "write" },
      ],
    };
    expect(() => validateCustomerGrants([grant])).toThrow("operationKey");
    expect(() =>
      validateCustomerGrants([
        {
          ...grant,
          steps: [grant.steps[0], { ...grant.steps[1], operationKey: "$input.orderId" }],
        },
      ]),
    ).toThrow();
    expect(() =>
      validateCustomerGrants([
        {
          ...grant,
          steps: [
            grant.steps[0],
            {
              ...grant.steps[1],
              input: { orderId: "$steps.owner.id" },
              operationKey: "$steps.owner.id",
              receipt: { id: ["id"] },
            },
          ],
        },
      ]),
    ).not.toThrow();
    for (const input of [
      { orderId: "$input.otherOrder" },
      { checkedId: "$steps.owner.id", orderId: "$input.otherOrder" },
      { checkedId: "$steps.owner.id", body: [{ amount: "$input.amount" }] },
      { orderId: "$steps.owner.id", value: "$steps.later.value" },
      { orderId: "$steps.owner.id", value: "$steps.write.value" },
      { orderId: "$steps.owner.id", value: "$steps.unchecked.id" },
    ]) {
      expect(() =>
        validateCustomerGrants([
          {
            ...grant,
            steps: [
              grant.steps[0],
              { name: "unchecked", action: "orders.get", input: {}, effect: "read" },
              {
                ...grant.steps[1],
                input,
                operationKey: "$steps.owner.id",
                receipt: { id: ["id"] },
              },
            ],
          },
        ]),
      ).toThrow();
    }
  });
});
