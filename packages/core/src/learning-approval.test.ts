import { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { learningApprovalReview } from "./learning-approval.js";

const native = {
  kind: "memory",
  scope: "bot",
  path: "reviewed.md",
  expectedRevision: 1,
  beforeContent: "  ก่อน\n\tOriginal 👩🏽‍💻\n",
  content: "  หลัง\n\tRevised 👩🏽‍💻\n",
};
const proposal = {
  native,
  supported: false,
  publicSafe: false,
  changesBusinessRules: true,
  conditions: "When staff request it",
  save: {
    botId: "bot",
    scope: "bot",
    kind: "memory",
    key: "reviewed",
    title: "Guidance",
    content: "Summary",
    expectedRevision: 0,
    reason: "Correction",
    source: "Staff examples",
  },
};
function block(overrides = {}) {
  const request = {
    taskId: "task",
    decision: "approve",
    reason: "Review",
    reviewedProposal: proposal,
    ...overrides,
  };
  return MessageBlock.parse({
    kind: "ask",
    text: "Review",
    approvalEffectId: "effect",
    approvalRequest: { tool: "customer_learning_decide", offset: 0 },
    detail: JSON.stringify(request),
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  });
}

describe("learning approval presentation", () => {
  it("keeps exact native whitespace and Unicode and the proposal's warning flags", () => {
    const input = block();
    const original = JSON.stringify(input);
    const review = learningApprovalReview(input)!;
    expect(review.native).toEqual(native);
    expect(review.proposal).toMatchObject(proposal);
    expect(JSON.stringify(input)).toBe(original);
  });
  it.each(["memory", "skill"] as const)("reads a private user %s proposal", (kind) => {
    expect(
      learningApprovalReview(
        block({ reviewedProposal: { ...proposal, native: { ...native, kind, scope: "user" } } }),
      )?.native,
    ).toMatchObject({ kind, scope: "user" });
  });
  it("preserves the reason before the exact request without guessing where JSON begins", () => {
    const input = block();
    if (input.kind !== "ask") throw new Error("fixture");
    const prefix = 'Review {this} change.\n{"unrelated":"JSON"}\n';
    input.detail = prefix + input.detail;
    input.approvalRequest!.offset = prefix.length;
    const review = learningApprovalReview(input)!;
    expect(review.reviewReason).toBe(prefix.trim());
    expect(review.native).toEqual(native);
  });
  it.each(["reject", "retry"])("leaves %s decisions in their original presentation", (decision) => {
    expect(learningApprovalReview(block({ decision }))).toBeUndefined();
  });
  it.each([
    "legacy",
    "unrelated",
    "denied-only",
    "secret",
    "malformed",
    "offset",
    "negative",
    "fraction",
  ])("falls back for %s cards", (kind) => {
    const input = block();
    if (input.kind !== "ask") throw new Error("fixture");
    if (kind === "legacy") delete input.approvalRequest;
    if (kind === "unrelated") input.approvalRequest!.tool = "send_email";
    if (kind === "denied-only") input.actions = [{ id: "deny", label: "Deny" }];
    if (kind === "secret") input.input = "secret";
    if (kind === "malformed") input.detail += "…";
    if (kind === "offset") input.approvalRequest!.offset = input.detail!.length;
    if (kind === "negative") input.approvalRequest!.offset = -1;
    if (kind === "fraction") input.approvalRequest!.offset = 0.5;
    expect(learningApprovalReview(input)).toBeUndefined();
  });
  it("falls back when the native proposal is absent or invalid", () => {
    expect(
      learningApprovalReview(block({ reviewedProposal: { ...proposal, native: undefined } })),
    ).toBeUndefined();
    expect(
      learningApprovalReview(
        block({ reviewedProposal: { ...proposal, native: { ...native, scope: "space" } } }),
      ),
    ).toBeUndefined();
  });
  it("retains both maximum-length versions", () => {
    const version = "\u0001".repeat(100000);
    expect(
      learningApprovalReview(
        block({
          reviewedProposal: {
            ...proposal,
            native: { ...native, content: version, beforeContent: version },
          },
        }),
      )?.native.content,
    ).toBe(version);
  });
});
