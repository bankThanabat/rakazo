import {
  CUSTOMER_PURCHASE_APPROVAL_MAX_LENGTH,
  CustomerPurchaseCheckoutInput,
  LearningTaskDecisionToolInput,
  MemoryRestoreToolInput,
  MemoryUndoToolInput,
  SkillRemoveToolInput,
  SkillRestoreToolInput,
  SkillUndoToolInput,
  SkillWriteToolInput,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import { parseSkillMutation } from "./skill-tools.js";

describe("buildApprovalAskBlock", () => {
  it("explains preparation separately from enabling customer replies", () => {
    expect(buildApprovalAskBlock("effect", "customer_initialize", {}, [])).toMatchObject({
      text: "Review before preparing customer replies",
      detail:
        "Prepare basic customer instructions with this staff agent's selected model. Existing setup is kept. Enabling customer replies is a separate step.",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });
  it.each([
    "customer_alert_line_test",
    "customer_alert_line_verify",
    "customer_alert_line_disable",
  ])("requires an explicit readable destination approval for %s", (name) => {
    const input = {
      id: "destination",
      connectionId: "account",
      recipient: { kind: "private_group", recipientId: "C11111111111111111111111111111111" },
    };
    const block = buildApprovalAskBlock("effect", name, input, []);
    expect(block).toMatchObject({
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).toContain(input.recipient.recipientId);
    const hidden = buildApprovalAskBlock("effect", name, input, [input.recipient.recipientId]);
    expect(hidden).toMatchObject({ actions: [{ id: "deny", label: "Deny" }] });
  });
  it("shows customer approval details without offering a mandatory-gate bypass", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "customer_assessment",
      {
        config: {
          baseUrl: "https://assessment.example.test/v1",
          model: "test",
          credential: "test_key",
          criteria: "Ask staff about wholesale orders of 50 or more items.",
        },
      },
      [],
    );
    expect(block).toMatchObject({
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("https://assessment.example.test/v1");
    expect(block.detail).toContain("Ask staff about wholesale orders of 50 or more items.");
    const unattended = buildApprovalAskBlock("effect-2", "shell", { command: "echo test" }, [], {
      allowAlways: false,
    });
    expect(JSON.stringify(unattended)).not.toContain('"always"');
  });
  it("denies assessment changes when complete settings cannot be reviewed", () => {
    const config = {
      provider: "jev",
      credential: "assessment",
      baseUrl: "https://assessment.example.test/v1",
      criteria: '"'.repeat(2000),
    };
    const oversized = buildApprovalAskBlock("effect", "customer_assessment", { config }, []);
    expect(oversized).toMatchObject({
      actions: [{ id: "deny", label: "Deny" }],
      detail: "Assessment settings cannot be shown in full.",
    });
    const redacted = buildApprovalAskBlock(
      "effect",
      "customer_assessment",
      { config: { ...config, criteria: "Ask staff about private-wholesale-policy." } },
      ["private-wholesale-policy"],
    );
    expect(redacted).toMatchObject({ actions: [{ id: "deny", label: "Deny" }] });
  });
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });
});

describe("purchase approval completeness", () => {
  it("shows the entire largest accepted checkout, including both addresses and payment", () => {
    const input = CustomerPurchaseCheckoutInput.parse({
      id: "purchase-test",
      expectedRevision: 2,
      quote: {
        summary: {
          items: Array.from({ length: 5 }, (_, index) => ({
            key: `item-${index}`,
            id: index + 1,
            name: "",
            quantity: 1,
          })),
          currency: "THB",
          minorUnit: 2,
          total: "12500",
          needsShipping: true,
          needsPayment: true,
          coupons: [],
          shippingRates: [],
        },
        billing: { address1: "Billing sentinel" },
        shipping: { address1: "Shipping sentinel" },
      },
      paymentMethod: "bacs",
    });
    for (const item of input.quote.summary.items) {
      const remaining =
        CUSTOMER_PURCHASE_APPROVAL_MAX_LENGTH - JSON.stringify(input, null, 2).length;
      item.name = "x".repeat(Math.min(1000, remaining));
    }
    expect(JSON.stringify(input, null, 2)).toHaveLength(CUSTOMER_PURCHASE_APPROVAL_MAX_LENGTH);
    expect(CustomerPurchaseCheckoutInput.safeParse(input).success).toBe(true);
    const block = buildApprovalAskBlock("purchase-effect", "customer_purchase_checkout", input, []);
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(block.detail).toBe(JSON.stringify(input, null, 2));
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    input.quote.summary.items[4]!.name += "x";
    expect(CustomerPurchaseCheckoutInput.safeParse(input).success).toBe(false);
  });
  it.each(["checkout", "review", "update", "start", "close"])(
    "offers only deny when %s details cannot fit",
    (operation) => {
      const block = buildApprovalAskBlock(
        "purchase-effect",
        `customer_purchase_${operation}`,
        { value: "x".repeat(4000) },
        [],
        { allowAlways: true },
      );
      if (block.kind !== "ask") throw new Error("expected ask");
      expect(block.actions).toEqual([{ id: "deny", label: "Deny" }]);
      expect(block.detail).toContain("cannot be shown in full");
    },
  );
  it("cannot approve purchase fields hidden by secret redaction", () => {
    const block = buildApprovalAskBlock(
      "purchase-effect",
      "customer_purchase_checkout",
      { quote: { billing: { address1: "collision" } }, paymentMethod: "bacs" },
      ["collision"],
    );
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(block.actions).toEqual([{ id: "deny", label: "Deny" }]);
    expect(block.detail).not.toContain("collision");
  });
  it("does not let a long review reason hide checkout fields", () => {
    const block = buildApprovalAskBlock(
      "purchase-effect",
      "customer_purchase_checkout",
      { paymentMethod: "bacs" },
      [],
      { reviewReason: "x".repeat(4000) },
    );
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(block.actions).toEqual([{ id: "deny", label: "Deny" }]);
  });
});

describe("memory reversal approval completeness", () => {
  it.each(["memory_undo", "memory_restore"])("shows the exact replacement for %s", (name) => {
    const input = {
      documentId: "memory-test",
      revision: 2,
      expectedRevision: 4,
      reason: "Remove an incorrect fact",
      reviewedContent: "Keep the later verified fact",
    };
    const block = buildApprovalAskBlock("memory-effect", name, input, []);
    expect(block).toMatchObject({
      detail: JSON.stringify(input, null, 2),
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });
  it.each(["oversized", "redacted"])("cannot approve a %s replacement", (kind) => {
    const reviewedContent = kind === "oversized" ? "x".repeat(1_500_000) : "private-sentinel";
    const block = buildApprovalAskBlock(
      "memory-effect",
      "memory_undo",
      {
        documentId: "memory-test",
        revision: 2,
        expectedRevision: 3,
        reason: "Review",
        reviewedContent,
      },
      kind === "redacted" ? [reviewedContent] : [],
    );
    expect(block).toMatchObject({
      detail: "Memory change details cannot be shown in full.",
      actions: [{ id: "deny", label: "Deny" }],
    });
  });
});

describe("learning proposal approval completeness", () => {
  it("shows the entire exact proposal and never offers permanent approval", () => {
    const input = {
      taskId: "task",
      decision: "approve",
      reason: "Reviewed",
      reviewedProposal: {
        native: {
          kind: "memory",
          scope: "user",
          beforeContent: "Private baseline",
          content: "Private baseline and learned fact",
        },
        conditions: "Staff work",
      },
    };
    expect(
      buildApprovalAskBlock("learning-effect", "customer_learning_decide", input, []),
    ).toMatchObject({
      detail: JSON.stringify(input, null, 2),
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });
  it.each(["oversized", "redacted"])(
    "denies a %s proposal whose complete text cannot be shown",
    (kind) => {
      const content = kind === "oversized" ? "x".repeat(1_500_000) : "PRIVATE_BASELINE_SENTINEL";
      expect(
        buildApprovalAskBlock(
          "learning-effect",
          "customer_learning_decide",
          { reviewedProposal: { native: { content } } },
          kind === "redacted" ? [content] : [],
        ),
      ).toMatchObject({
        detail: "Learning change details cannot be shown in full.",
        actions: [{ id: "deny", label: "Deny" }],
      });
    },
  );
});

describe.each(["forget_memory", "save_memory", "memory_semantic_undo"])(
  "%s approval",
  (toolName) => {
    it("shows the full fact with the existing approval choices", () => {
      const input = {
        ...(toolName === "save_memory"
          ? { content: "Use metric units." }
          : { id: "fact-1", expectedContent: "Use metric units." }),
        provider: "supermemory",
        scope: "isolated",
        botId: "bot-1",
        configurationRevision: "config-1:revision-1",
        reason: "Replace obsolete guidance",
      };
      expect(buildApprovalAskBlock("effect", toolName, input, [])).toMatchObject({
        detail: JSON.stringify(input, null, 2),
        actions: [
          { id: "allow", label: "Allow once" },
          ...(toolName === "save_memory"
            ? [{ id: "always", label: "Always allow this tool" }]
            : []),
          { id: "deny", label: "Deny" },
        ],
      });
    });
    it.each(["oversized", "redacted"])("refuses a %s removal snapshot", (kind) => {
      const content = kind === "oversized" ? "x".repeat(100000) : "secret-sentinel";
      expect(
        buildApprovalAskBlock(
          "effect",
          toolName,
          {
            ...(toolName === "save_memory"
              ? { content }
              : { id: "fact-1", expectedContent: content }),
          },
          kind === "redacted" ? [content] : [],
        ),
      ).toMatchObject({
        detail: "Memory change details cannot be shown in full.",
        actions: [{ id: "deny", label: "Deny" }],
      });
    });
  },
);

describe("large semantic approval details", () => {
  it.each(["save_memory", "forget_memory", "memory_semantic_undo"])(
    "keeps the complete escaped 10,000-character fact and binding for %s",
    (toolName) => {
      const content = `Start${"\u0001".repeat(9992)}End`;
      const input = {
        ...(toolName === "save_memory" ? { content } : { expectedContent: content }),
        id: "i".repeat(500),
        entity: "e".repeat(500),
        mutationId: "m".repeat(500),
        action: "restore",
        provider: "supermemory",
        scope: "shared",
        botId: "bot-1",
        configurationRevision: "c".repeat(500),
        reason: "r".repeat(1000),
      };
      const block = buildApprovalAskBlock("effect", toolName, input, []);
      if (block.kind !== "ask") throw new Error("expected ask");
      expect(content).toHaveLength(10000);
      expect(block.detail!.length).toBeGreaterThan(60000);
      expect(JSON.parse(block.detail!)).toEqual(input);
      expect(block.actions).toContainEqual({ id: "allow", label: "Allow once" });
      const hidden = buildApprovalAskBlock("effect", toolName, input, ["Start"]);
      expect(hidden).toMatchObject({ actions: [{ id: "deny", label: "Deny" }] });
    },
  );
  it("does not lift unrelated consequential approval limits", () => {
    for (const name of ["customer_purchase_checkout", "customer_alert_line_setup"]) {
      expect(
        buildApprovalAskBlock("effect", name, { content: "x".repeat(4000) }, []),
      ).toMatchObject({ actions: [{ id: "deny", label: "Deny" }] });
    }
  });
});

describe("complete document approval details", () => {
  it.each([
    "memory_undo",
    "memory_restore",
    "skill_create",
    "skill_update",
    "skill_delete",
    "skill_undo",
    "skill_restore",
    "customer_learning_decide",
  ])("preserves escaped full versions for %s without permanent approval", (name) => {
    const prefix = name.startsWith("skill_")
      ? "---\nname: Reviewed\ndescription: Reviewed\n---\n\nStart"
      : "Start";
    const content = `${prefix}${"\u0001".repeat(100000 - prefix.length - 3)}End`;
    const common = { reason: "Review", revision: 1, expectedRevision: 2, reviewedContent: content };
    const input =
      name === "customer_learning_decide"
        ? LearningTaskDecisionToolInput.parse({
            taskId: "task",
            decision: "approve",
            reason: "\u0001".repeat(900),
            reviewedProposal: {
              native: {
                kind: "memory",
                scope: "bot",
                path: "reviewed.md",
                expectedRevision: 1,
                beforeContent: content,
                content,
              },
              addition: "\u0001".repeat(13000),
              supported: true,
              publicSafe: false,
              changesBusinessRules: false,
              save: {
                botId: "bot",
                scope: "bot",
                kind: "memory",
                key: "reviewed",
                title: "Reviewed",
                expectedRevision: 0,
                content: "\u0001".repeat(16000),
                source: "\u0001".repeat(2000),
                reason: "\u0001".repeat(1000),
              },
              conditions: "\u0001".repeat(2000),
            },
          })
        : name === "memory_undo"
          ? MemoryUndoToolInput.parse({ ...common, documentId: "memory", resolution: content })
          : name === "memory_restore"
            ? MemoryRestoreToolInput.parse({ ...common, documentId: "memory" })
            : name === "skill_create" || name === "skill_update"
              ? SkillWriteToolInput.parse({
                  content,
                  expectedRevision: name === "skill_create" ? 0 : 1,
                  ...(name === "skill_update" ? { skillId: "skill" } : {}),
                  reason: "Review",
                })
              : name === "skill_delete"
                ? SkillRemoveToolInput.parse({ ...common, skillId: "skill" })
                : name === "skill_undo"
                  ? SkillUndoToolInput.parse({
                      ...common,
                      skillId: "skill",
                      reviewedRemoved: false,
                      resolution: { content, removed: false },
                    })
                  : SkillRestoreToolInput.parse({
                      ...common,
                      skillId: "skill",
                      reviewedRemoved: false,
                    });
    const parsed = name.startsWith("skill_") ? parseSkillMutation(name, input) : input;
    const block = buildApprovalAskBlock("effect", name, parsed, []);
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(content).toHaveLength(100000);
    expect(block.detail!.length).toBeGreaterThan(599_000);
    if (name === "customer_learning_decide")
      expect(block.detail!.length).toBeGreaterThan(1_390_000);
    expect(JSON.parse(block.detail!)).toEqual(parsed);
    expect(block.actions).toEqual([
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ]);
    expect(buildApprovalAskBlock("effect", name, parsed, ["Start"])).toMatchObject({
      actions: [{ id: "deny", label: "Deny" }],
    });
  });
});

describe("learning request presentation metadata", () => {
  it.each([undefined, 'Review {the change}.\n{"not":"the request"}'])(
    "locates the original JSON request after an optional reason",
    (reviewReason) => {
      const input = { taskId: "task", decision: "approve" };
      const block = buildApprovalAskBlock("effect", "customer_learning_decide", input, [], {
        reviewReason,
      });
      if (block.kind !== "ask") throw new Error("Expected ask");
      expect(block.approvalRequest?.tool).toBe("customer_learning_decide");
      expect(JSON.parse(block.detail!.slice(block.approvalRequest!.offset))).toEqual(input);
    },
  );
  it("does not attach readable request metadata after redaction", () => {
    const block = buildApprovalAskBlock(
      "effect",
      "customer_learning_decide",
      { reason: "secret-value" },
      ["secret-value"],
    );
    expect(block).not.toHaveProperty("approvalRequest");
  });
});
