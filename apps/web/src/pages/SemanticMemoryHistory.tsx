import { Trans, useLingui } from "@lingui/react/macro";
import { useSemanticHistory } from "@rakazo/chat-ui/semantic-history";
import type { SemanticMemoryDetail } from "@rakazo/contracts";
import { Button, Input, Skeleton } from "@rakazo/ui-web";
import { useEffect, useId, useRef } from "react";
import { rpc } from "../lib/rpc";

export function SemanticMemoryHistory({ botId }: { botId: string }) {
  const { t } = useLingui();
  const region = useId();
  const history = useSemanticHistory({
    botId,
    nonce: () => crypto.randomUUID(),
    preview: (input) => rpc.semanticMemory.preview(input),
    apply: (input) => rpc.semanticMemory.apply(input),
    history: (cursor) => rpc.semanticMemory.history({ botId, cursor }),
    detail: (mutationId) => rpc.semanticMemory.detail({ botId, mutationId }),
  });
  const operation = (value: string) =>
    value === "save"
      ? t`Save memory`
      : value === "forget"
        ? t`Remove memory`
        : value === "undo_save"
          ? t`Undo memory save`
          : value === "undo_forget"
            ? t`Restore memory`
            : t`Memory change`;
  const status = (value: string) =>
    value === "completed" ? t`Confirmed` : value === "failed" ? t`Failed` : t`Outcome unknown`;
  const selected = history.detail;
  const reasonInput = useRef<HTMLInputElement>(null);
  const reviewRegion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (history.draft) reasonInput.current?.focus();
  }, [history.draft?.id, history.draft?.entity]);
  useEffect(() => {
    if (history.review) reviewRegion.current?.focus();
  }, [history.review]);
  const selectedButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!selected?.id) return;
    selectedButton.current?.focus({ preventScroll: true });
    selectedButton.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);
  return (
    <div className="mt-3 text-sm" data-testid="semantic-memory-history">
      <Button
        variant="ghost"
        type="button"
        disabled={history.busy}
        aria-expanded={history.open}
        aria-controls={region}
        onClick={history.toggle}
      >
        <Trans>Provider memory history</Trans>
      </Button>
      {history.open && (
        <section
          id={region}
          aria-label={t`Provider memory history`}
          aria-busy={history.busy}
          className="mt-2 space-y-3 border-t border-border pt-3"
        >
          <Button
            variant="ghost"
            type="button"
            disabled={history.busy}
            onClick={() => void history.load()}
          >
            <Trans>Reload history</Trans>
          </Button>
          {history.busy && <Skeleton className="h-10" />}
          {history.error && (
            <p role="alert" className="text-destructive">
              {history.reviewError ??
                (history.pending
                  ? t`Could not confirm the change. Retry or reload history.`
                  : t`Could not load history. Try again.`)}
            </p>
          )}
          {history.pending && !history.review && (
            <Button disabled={history.busy} onClick={() => void history.apply()}>
              <Trans>Retry confirmation</Trans>
            </Button>
          )}
          {history.page?.items.length === 0 && (
            <p className="text-muted-foreground">
              <Trans>No recorded changes yet.</Trans>
            </p>
          )}
          {history.page?.items.map((item) => (
            <article key={item.id} className="border-b border-border pb-3">
              <Button
                type="button"
                variant="ghost"
                disabled={history.busy}
                ref={selected?.id === item.id ? selectedButton : undefined}
                aria-expanded={selected?.id === item.id}
                className="h-auto w-full justify-start whitespace-normal px-2.5 py-3 text-start"
                onClick={() => void history.select(item.id)}
              >
                <span className="min-w-0 space-y-1">
                  <span className="block">
                    {operation(item.operation)} · {status(item.status)}
                  </span>
                  <time className="block text-xs text-muted-foreground" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </span>
              </Button>
              {selected?.id === item.id && (
                <div className="mt-3 space-y-4 px-2.5">
                  <p className="break-words text-muted-foreground" dir="auto">
                    {selected.botName} · {selected.provider} ·{" "}
                    {selected.scope === "shared"
                      ? t`Private across your bots`
                      : t`Private to this bot`}
                  </p>
                  {selected.reason && (
                    <p className="whitespace-pre-wrap break-words" dir="auto">
                      {selected.reason}
                    </p>
                  )}
                  {selected.status !== "completed" && selected.status !== "failed" && (
                    <p role="status">
                      <Trans>
                        The provider outcome is unknown. Verify it before another change.
                      </Trans>
                    </p>
                  )}
                  {selected.sourceThreadId && (
                    <a
                      className="text-link underline underline-offset-4"
                      href={`/app/${encodeURIComponent(botId)}`}
                    >
                      <Trans>Source conversation</Trans>
                    </a>
                  )}
                  {selected.reversesId && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={history.busy}
                      onClick={() => void history.select(selected.reversesId!)}
                    >
                      <Trans>Original change</Trans>
                    </Button>
                  )}
                  {history.requestedContent !== null && (
                    <Version
                      title={t`Requested content`}
                      value={{ state: "recorded", content: history.requestedContent }}
                    />
                  )}
                  {!selected.changes.length && (
                    <p className="text-muted-foreground">
                      <Trans>Recorded versions are unavailable.</Trans>
                    </p>
                  )}
                  {selected.changes.map((change, index) => (
                    <div
                      key={`${change.id}:${index}`}
                      className="space-y-3 border-t border-border pt-3"
                    >
                      <p className="break-all text-xs text-muted-foreground" dir="auto">
                        {change.id}
                        {change.entity ? ` · ${change.entity}` : ""}
                      </p>
                      <Version title={t`Before`} value={change.before} />
                      <Version title={t`After`} value={change.after} />
                      {change.entity &&
                        (history.draft?.id === change.id &&
                        history.draft.entity === change.entity ? (
                          <div className="space-y-3">
                            <label htmlFor={`${region}-undo-reason`} className="block space-y-1">
                              <span>
                                <Trans>Reason for undo</Trans>
                              </span>
                              <Input
                                id={`${region}-undo-reason`}
                                ref={reasonInput}
                                value={history.draft.reason}
                                maxLength={1000}
                                disabled={history.busy}
                                onChange={(event) => history.setReason(event.target.value)}
                              />
                            </label>
                            {history.review ? (
                              <div ref={reviewRegion} tabIndex={-1} className="space-y-3">
                                <Version
                                  title={
                                    history.review.value.action === "restore"
                                      ? t`Restore this fact`
                                      : t`Remove this fact`
                                  }
                                  value={{
                                    state: "recorded",
                                    content: history.review.value.content,
                                  }}
                                />
                                <Button
                                  disabled={history.busy}
                                  onClick={() => void history.apply()}
                                >
                                  {history.review.value.action === "restore"
                                    ? t`Confirm restoration`
                                    : t`Confirm removal`}
                                </Button>
                              </div>
                            ) : (
                              <Button
                                disabled={history.busy || !history.draft.reason.trim()}
                                onClick={() => void history.preview()}
                              >
                                <Trans>Preview change</Trans>
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              disabled={history.busy}
                              onClick={history.cancelReview}
                            >
                              <Trans>Cancel</Trans>
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            disabled={history.busy}
                            onClick={() => history.startReview(change)}
                          >
                            <Trans>Review undo</Trans>
                          </Button>
                        ))}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
          {history.page?.nextCursor && (
            <Button
              type="button"
              variant="ghost"
              disabled={history.busy}
              onClick={() => void history.load(true)}
            >
              <Trans>Older changes</Trans>
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
function Version({
  title,
  value,
}: {
  title: string;
  value: SemanticMemoryDetail["changes"][number]["before"];
}) {
  const { t } = useLingui();
  return (
    <div>
      <p className="mb-1 font-medium">{title}</p>
      <section
        tabIndex={value.state === "recorded" ? 0 : undefined}
        aria-label={title}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        dir="auto"
      >
        {value.state === "recorded"
          ? value.content
          : value.state === "absent"
            ? t`Not stored`
            : t`Unavailable`}
      </section>
    </div>
  );
}
