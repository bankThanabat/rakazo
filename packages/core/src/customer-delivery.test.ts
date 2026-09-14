import { describe, expect, it } from "vitest";
import { customerReplyParts } from "./customer-delivery.js";

describe("customer delivery", () => {
  it("preserves Unicode text and fits every UTF-8 payload", () => {
    const body = "สวัสดี 🙂 中文\n".repeat(500);
    const parts = customerReplyParts(body, { max: 1000, unit: "utf8" });
    expect(parts.join("")).toBe(body);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => new TextEncoder().encode(part).length <= 1000)).toBe(true);
    expect(parts.some((part) => part.includes("\ufffd"))).toBe(false);
  });
  it("handles exact boundaries without an empty send", () => {
    expect(customerReplyParts("abcd".repeat(2), { max: 4, unit: "characters" })).toEqual([
      "abcd",
      "abcd",
    ]);
    expect(customerReplyParts("", { max: 4, unit: "characters" })).toEqual([]);
  });
});
