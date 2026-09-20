import type {
  SemanticMemoryDetail,
  SemanticMemoryHistory,
  SemanticMemoryReversalApply,
  SemanticMemoryReversalInput,
  SemanticMemoryReversalPreview,
  SemanticMemoryReversalResult,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

/** Shared request lifetime for web and native history. Mount with the bot's identity as key. */
export function useSemanticHistory(api: {
  history: (cursor?: string) => Promise<SemanticMemoryHistory>;
  detail: (id: string) => Promise<SemanticMemoryDetail>;
  botId: string;
  nonce: () => string;
  preview: (input: SemanticMemoryReversalInput) => Promise<SemanticMemoryReversalPreview>;
  apply: (input: SemanticMemoryReversalApply) => Promise<SemanticMemoryReversalResult>;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<SemanticMemoryHistory>();
  const [detail, setDetail] = useState<SemanticMemoryDetail>();
  const [draft, setDraft] = useState<{ id: string; entity: string; reason: string }>();
  const [review, setReview] = useState<{
    input: SemanticMemoryReversalApply;
    value: SemanticMemoryReversalPreview;
  }>();
  const [reviewError, setReviewError] = useState<string>();
  const [pending, setPending] = useState<SemanticMemoryReversalApply>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      running.current = false;
    },
    [],
  );
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true;
    const token = ++generation.current;
    const current = () => token === generation.current;
    setBusy(true);
    setError(false);
    setReviewError(undefined);
    try {
      await work(current);
    } catch (cause) {
      if (current()) {
        // A failed read may mean access was revoked. Do not keep private snapshots on screen.
        setPage(undefined);
        setDetail(undefined);
        setDraft(undefined);
        setReview(undefined);
        if (
          cause instanceof Error &&
          "code" in cause &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT"].includes(String(cause.code))
        )
          setPending(undefined);
        setError(true);
        if (cause instanceof Error && "code" in cause && cause.code === "CONFLICT")
          setReviewError(cause.message);
      }
    } finally {
      if (current()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  function load(more = false) {
    return run(async (current) => {
      setDetail(undefined);
      setDraft(undefined);
      setReview(undefined);
      setPending(undefined);
      if (!more) setPage(undefined);
      const next = await api.history(more ? (page?.nextCursor ?? undefined) : undefined);
      if (!current()) return;
      setPage(more && page ? { ...next, items: merge(page.items, next.items) } : next);
    });
  }
  function select(id: string) {
    return run(async (current) => {
      setDetail(undefined);
      setDraft(undefined);
      setReview(undefined);
      setPending(undefined);
      const value = await api.detail(id);
      if (!current()) return;
      setDetail(value);
      setPage((previous) =>
        previous
          ? {
              ...previous,
              items: merge(previous.items, [value]),
            }
          : previous,
      );
    });
  }
  function toggle() {
    if (running.current) return;
    setOpen(!open);
    if (!open) void load();
    else {
      setPage(undefined);
      setDetail(undefined);
      setDraft(undefined);
      setReview(undefined);
      setPending(undefined);
      setError(false);
    }
  }
  function startReview(change: SemanticMemoryDetail["changes"][number]) {
    if (running.current || !change.entity) return;
    setDraft({ id: change.id, entity: change.entity, reason: "" });
    setReview(undefined);
  }
  function setReason(reason: string) {
    if (running.current) return;
    setDraft((value) => (value ? { ...value, reason } : value));
    setReview(undefined);
  }
  function cancelReview() {
    if (running.current) return;
    setDraft(undefined);
    setReview(undefined);
  }
  function preview() {
    if (!draft?.reason.trim() || !detail) return;
    const input = {
      ...draft,
      reason: draft.reason.trim(),
      botId: api.botId,
      mutationId: detail.id,
    };
    return run(async (current) => {
      setReview(undefined);
      const value = await api.preview(input);
      if (current())
        setReview({ input: { ...input, version: value.version, clientNonce: api.nonce() }, value });
    });
  }
  function apply() {
    const input = review?.input ?? pending;
    if (!input) return;
    return run(async (current) => {
      // Keep the same intent after a lost response; retrying must not dispatch a new write.
      setPending(input);
      const result = await api.apply(input);
      if (!current()) return;
      setPending(undefined);
      setReview(undefined);
      setDraft(undefined);
      const value = await api.detail(result.mutationId);
      if (!current()) return;
      setDetail(value);
      setPage((previous) =>
        previous
          ? { ...previous, items: merge(previous.items, [value]) }
          : { items: [value], nextCursor: null },
      );
    });
  }
  const requestedContent =
    detail?.requestedContent != null &&
    !detail.changes.some(
      (change) =>
        change.before.content === detail.requestedContent ||
        change.after.content === detail.requestedContent,
    )
      ? detail.requestedContent
      : null;
  return {
    open,
    page,
    detail,
    requestedContent,
    busy,
    error,
    reviewError,
    load,
    select,
    toggle,
    draft,
    review,
    pending,
    startReview,
    setReason,
    cancelReview,
    preview,
    apply,
  };
}

function merge(first: SemanticMemoryHistory["items"], second: SemanticMemoryHistory["items"]) {
  return [...new Map([...first, ...second].map((item) => [item.id, item])).values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}
