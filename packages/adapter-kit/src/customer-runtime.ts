/** Customer execution is separate from the internal staff computer and its tools. */
export interface CustomerRuntime {
  publish?(request: {
    staffId: string;
    instructions: string;
    signal: AbortSignal;
  }): Promise<string>;
  search?(request: {
    query: string;
    knowledgeFilterId: string;
    signal: AbortSignal;
  }): Promise<unknown>;
  reply(request: {
    flowId: string;
    knowledgeFilterId?: string;
    instructions: string;
    conversationId: string;
    executionContext?: { endpoint: string; token: string };
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    signal: AbortSignal;
  }): Promise<string>;
}
