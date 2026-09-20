import type { MessageBlock } from "@rakazo/contracts";
import { LearningTaskDecisionToolInput } from "@rakazo/contracts";
import { isApprovalAskBlock } from "./action-approval.js";

/** Presentation only. The stored detail and approval action remain authoritative. */
export function learningApprovalReview(block: MessageBlock) {
  if (
    block.kind !== "ask" ||
    block.input === "secret" ||
    !isApprovalAskBlock(block) ||
    block.approvalRequest?.tool !== "customer_learning_decide" ||
    !block.detail
  )
    return undefined;
  const { offset } = block.approvalRequest;
  if (!Number.isInteger(offset) || offset < 0 || offset >= block.detail.length) return undefined;
  try {
    const parsed = LearningTaskDecisionToolInput.safeParse(JSON.parse(block.detail.slice(offset)));
    if (!parsed.success || parsed.data.decision !== "approve") return undefined;
    const proposal = parsed.data.reviewedProposal;
    if (!proposal?.native) return undefined;
    return {
      proposal,
      native: proposal.native,
      reason: parsed.data.reason,
      reviewReason: block.detail.slice(0, offset).trim(),
    };
  } catch {
    return undefined;
  }
}

export type LearningApprovalReview = NonNullable<ReturnType<typeof learningApprovalReview>>;
