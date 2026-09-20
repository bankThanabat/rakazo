import type { MessageBlock } from "@rakazo/contracts";
import { redactSecrets, toolRequiresExplicitApproval } from "@rakazo/core";
import { DOCUMENT_REVIEW_TOOLS } from "./approval-effect.js";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
// A semantic fact can contain 10,000 characters. JSON escaping can expand each
// character to six characters; leave room for the bound destination and reason too.
const MAX_SEMANTIC_APPROVAL_DETAIL_LENGTH = 100_000;
// Document reviews can include two 100,000-character versions plus the learning
// proposal. Allow worst-case JSON escaping while retaining a bounded stored card.
const MAX_DOCUMENT_APPROVAL_DETAIL_LENGTH = 1_500_000;
const SEMANTIC_REVIEW_TOOLS = new Set(["memory_semantic_undo", "forget_memory", "save_memory"]);
const MEMORY_REVIEW_TOOLS = new Set([...SEMANTIC_REVIEW_TOOLS, "memory_undo", "memory_restore"]);

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string; allowAlways?: boolean },
): MessageBlock {
  const summary = describeApprovalAction(toolName, args);
  const detail = formatApprovalDetail(toolName, args, options?.reviewReason);
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  const maxDetailLength = DOCUMENT_REVIEW_TOOLS.has(toolName)
    ? MAX_DOCUMENT_APPROVAL_DETAIL_LENGTH
    : SEMANTIC_REVIEW_TOOLS.has(toolName)
      ? MAX_SEMANTIC_APPROVAL_DETAIL_LENGTH
      : MAX_APPROVAL_DETAIL_LENGTH;
  // Consequential payloads must be reviewable in full.
  const cannotReview =
    (toolName.startsWith("customer_purchase_") ||
      toolName.startsWith("customer_alert_line_") ||
      toolName === "customer_assessment" ||
      toolName === "customer_learning_decide" ||
      MEMORY_REVIEW_TOOLS.has(toolName) ||
      toolName.startsWith("skill_")) &&
    (safeDetail !== detail ||
      Math.max(detail?.length ?? 0, safeDetail?.length ?? 0) > maxDetailLength);
  return {
    kind: "ask",
    approvalEffectId: effectId,
    ...(!cannotReview && toolName === "customer_learning_decide" && detail
      ? {
          approvalRequest: {
            tool: toolName,
            offset: detail.length - JSON.stringify(args, null, 2).length,
          },
        }
      : {}),
    text: truncate(
      redactSecrets(
        toolName === "create_space" ? `${summary}?` : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: cannotReview
      ? toolName === "customer_learning_decide"
        ? "Learning change details cannot be shown in full."
        : toolName.startsWith("skill_")
          ? "Skill change details cannot be shown in full. Edit the skill directly in settings."
          : MEMORY_REVIEW_TOOLS.has(toolName)
            ? "Memory change details cannot be shown in full."
            : toolName.startsWith("customer_alert_line_")
              ? "Alert destination details cannot be shown in full."
              : toolName === "customer_assessment"
                ? "Assessment settings cannot be shown in full."
                : "Purchase details cannot be shown in full. Use the merchant checkout."
      : safeDetail
        ? truncate(safeDetail, maxDetailLength)
        : undefined,
    status: "pending",
    actions: cannotReview
      ? [{ id: "deny", label: "Deny" }]
      : toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            ...((options?.allowAlways ?? !toolRequiresExplicitApproval(toolName))
              ? [{ id: "always", label: "Always allow this tool" }]
              : []),
            { id: "deny", label: "Deny" },
          ],
  };
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "customer_initialize") return "preparing customer replies";
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "customer_initialize") {
    lines.push(
      "Prepare basic customer instructions with this staff agent's selected model. Existing setup is kept. Enabling customer replies is a separate step.",
    );
    return lines.join("\n");
  }
  if (
    toolName.startsWith("customer_") ||
    MEMORY_REVIEW_TOOLS.has(toolName) ||
    toolName.startsWith("skill_")
  ) {
    lines.push(JSON.stringify(args, null, 2));
    return lines.join("\n");
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  for (const key of ["collection", "title", "to", "subject", "amount", "body"]) {
    const value = args[key];
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value)}`);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
