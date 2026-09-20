export interface SocialLearningWindow {
  start: string;
  end: string;
}
/** Account-owned text is not proof of human authorship. Context is never a voice example. */
export interface SocialLearningProvider {
  actions: Array<{ action: string; effect: "read" }>;
  identity(): Promise<{ id: string; label: string }>;
  page(cursor?: string): Promise<{
    posts: Array<{
      id: string;
      text: string;
      publishedAt: string;
      parentId?: string;
      context?: string;
      contextId?: string;
      conversationId?: string;
      staffAuthorship?: "unverified";
    }>;
    nextCursor: string | null;
    skipped: number;
    unverified?: number;
    unavailable?: number;
    contextOnly?: number;
    reviewRequired?: boolean;
    limitations?: string[];
  }>;
}
export type SocialLearningExecute = (
  action: string,
  input: Record<string, unknown>,
) => Promise<unknown>;
