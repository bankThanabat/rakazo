/** Customer execution is separate from the internal staff computer and its tools. */
export interface CustomerRuntime {
  /** Stable authorization principal within this endpoint; contains no credential. */
  identity?(signal: AbortSignal): Promise<string>;
  /** Read-only verification of the exact managed publication and ownership markers. */
  inspectPublication?(request: {
    publicationId: string;
    staffId: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  publish?(request: {
    /** Allocated by the caller before dispatch so a lost response can be reconciled. */
    publicationId: string;
    staffId: string;
    instructions: string;
    knowledgeFilterId?: string;
    /** Await immediately before the create request, after read-only preparation. */
    beforeDispatch?: () => Promise<void>;
    signal: AbortSignal;
  }): Promise<string>;
  /** Call only after proving this publication is no longer active or in flight. */
  removePublication?(request: {
    publicationId: string;
    staffId: string;
    signal: AbortSignal;
    /** Await after finding the matching flow and before deletion, for crash recovery. */
    beforeRemove?: () => Promise<void>;
  }): Promise<"removed" | "absent">;
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
    customerContext?: string;
    model?: { baseUrl: string; apiKey: string; id: string };
    executionContext?: { endpoint: string; token: string };
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    signal: AbortSignal;
  }): Promise<string>;
}
