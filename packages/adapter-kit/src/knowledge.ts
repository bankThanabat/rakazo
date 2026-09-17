/** The service answered and refused the upload, so nothing was submitted. */
export class KnowledgeRejectedError extends Error {}

/** Provider keys and task IDs are backend data, never model-selected search scope. */
export interface KnowledgeProvider {
  /** Not idempotent: any failure other than KnowledgeRejectedError leaves the outcome unknown. */
  ingest(input: {
    key: string;
    mimeType: string;
    bytes: Uint8Array;
    signal: AbortSignal;
  }): Promise<string>;
  status(
    taskId: string,
    key: string,
    signal: AbortSignal,
  ): Promise<"processing" | "ready" | "failed">;
  search(
    query: string,
    keys: string[],
    signal: AbortSignal,
  ): Promise<
    Array<{
      key: string;
      text: string;
      page?: number;
    }>
  >;
  /** Cleanup repeats removal, so an absent document is success. */
  remove(key: string, signal: AbortSignal): Promise<void>;
}
