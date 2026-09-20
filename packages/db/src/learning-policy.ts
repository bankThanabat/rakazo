import type { LearningTaskProposal } from "@rakazo/contracts";

/** Classification is model evidence; authority comes from the captured staff action. */
export function canApplyLearningAutomatically(
  task: { userId: string; importId: string | null; evidence: unknown },
  proposal: LearningTaskProposal,
) {
  if (
    task.evidence &&
    typeof task.evidence === "object" &&
    "reviewRequired" in task.evidence &&
    task.evidence.reviewRequired === true
  )
    return false;
  if (!proposal.supported || !proposal.publicSafe || proposal.changesBusinessRules) return false;
  // User skills affect every bot. A bot-specific correction cannot silently widen its reach.
  if (proposal.native?.scope === "user" && proposal.save.scope !== "space") return false;
  if (proposal.save.kind === "voice") return true;
  if (task.importId || !task.evidence || typeof task.evidence !== "object") return false;
  const evidence = task.evidence as Record<string, unknown>;
  return (
    evidence.correctedByUserId === task.userId &&
    typeof evidence.guidance === "string" &&
    evidence.guidance.trim().length > 0 &&
    (proposal.save.kind === "knowledge" || Boolean(proposal.native))
  );
}
