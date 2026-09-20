import { describe, expect, it } from "vitest";
import { purchaseAmount } from "../lib/customer-purchase-money";

describe("shopper quote money", () => {
  it.each([
    ["12500", 2, "125.00"],
    ["1", 2, "0.01"],
    ["0", 0, "0"],
    ["900719925474099301", 2, "9007199254740993.01"],
    ["1234567", 6, "1.234567"],
  ])("preserves %s with %s decimal places", (value, places, expected) => {
    expect(purchaseAmount(value, places)).toBe(expected);
  });
});
