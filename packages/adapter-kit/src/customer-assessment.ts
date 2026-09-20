export interface CustomerAssessmentProvider {
  assess(input: {
    messages: Array<{ role: string; content: string }>;
    /** Owner-approved additional reasons to hand off; cannot relax baseline rules. */
    criteria?: string;
    signal: AbortSignal;
  }): Promise<{
    needsHuman: boolean;
    reason: string;
    confidence: number;
  }>;
}
