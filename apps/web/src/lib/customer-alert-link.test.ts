import { describe, expect, it } from "vitest";
import { customerAlertPath, customerAlertTarget, safeSignInPath } from "./customer-alert-link";

describe("authenticated customer alert links", () => {
  it("preserves a case and Space through sign-in while dropping unrelated parameters", () => {
    const path = "/app?space=space-1&customer=case_2";
    expect(safeSignInPath(`${path}&next=https://outside.test`)).toBe(path);
    expect(customerAlertTarget(new URLSearchParams(path.split("?")[1]))).toEqual({
      spaceId: "space-1",
      conversationId: "case_2",
    });
    expect(safeSignInPath("/integrations/setup")).toBe("/integrations/setup");
  });
  it.each([
    null,
    "https://outside.test/app?space=a&customer=b",
    "//outside.test/app",
    "/app/../evil?space=a&customer=b",
    "/app?space=a&customer=%2F%2Foutside",
    "/app?space=a",
    `/app?space=${"a".repeat(129)}&customer=b`,
  ])("rejects unsafe or incomplete return destination %s", (path) => {
    expect(safeSignInPath(path)).toBe("/app");
  });
  it("ignores unrecognized parameters on the sign-in redirect", () => {
    expect(customerAlertPath(new URLSearchParams("next=https://outside.test"))).toBe("/app");
  });
});
