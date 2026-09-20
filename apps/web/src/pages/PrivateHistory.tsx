import { Trans, useLingui } from "@lingui/react/macro";
import type {
  PrivateHistory as History,
  PrivateHistoryApply,
  PrivateHistoryPreview,
  PrivateHistoryTarget,
  PrivateHistoryValue,
  PrivateHistoryVersion,
} from "@rakazo/contracts";
import { Button, Checkbox, Input, Skeleton, Switch, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { LearningEvidence } from "./LearningEvidence";

type Review = {
  input: Omit<PrivateHistoryApply, "reason" | "reviewed" | "resolveConflict">;
  preview: PrivateHistoryPreview;
};
/** Extend the existing editor: reveal history, compare versions, then review one explicit change. */
export function PrivateHistory({
  target,
  disabled = false,
  onApplied,
  onBusyChange,
}: {
  target: PrivateHistoryTarget;
  disabled?: boolean;
  onApplied: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<History>();
  const [selected, setSelected] = useState<{ revision: number; value: PrivateHistoryVersion }>();
  const [review, setReview] = useState<Review>();
  const [result, setResult] = useState<PrivateHistoryValue>({ content: "", removed: false });
  const [reason, setReason] = useState("");
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function run(work: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true;
    const current = generation.current;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch {
      if (current === generation.current)
        setError(t`Could not complete this review. Reload history and try again.`);
    } finally {
      running.current = false;
      onBusyChange?.(false);
      if (current === generation.current) setBusy(false);
    }
  }
  async function load(more = false) {
    const current = generation.current;
    const next = await rpc.privateHistory.history({
      ...target,
      beforeRevision: more ? (history?.nextBeforeRevision ?? undefined) : undefined,
    });
    if (current !== generation.current) return;
    if (more && next.revision !== history?.revision) throw new Error("Changed");
    setHistory(more ? { ...next, items: [...history!.items, ...next.items] } : next);
    if (!more) {
      setSelected(undefined);
      setReview(undefined);
    }
  }
  async function select(revision: number) {
    const current = generation.current;
    const value = await rpc.privateHistory.version({ ...target, revision });
    if (current !== generation.current) return;
    if (value.currentRevision !== history?.revision) throw new Error("Changed");
    setSelected({ revision, value });
    setReview(undefined);
  }
  async function preview(action: "undo" | "restore") {
    const current = generation.current;
    const input = {
      ...target,
      action,
      revision: selected!.revision,
      expectedRevision: history!.revision,
    };
    const value = await rpc.privateHistory.preview(input);
    if (current !== generation.current) return;
    setReview({ input, preview: value });
    setResult(value.proposed);
    setReason("");
    setResolved(false);
  }
  async function apply() {
    const current = generation.current;
    await rpc.privateHistory.apply({
      ...review!.input,
      reason,
      reviewed: result,
      resolveConflict: review!.preview.conflict && resolved,
    });
    if (current !== generation.current) return;
    setReview(undefined);
    setSelected(undefined);
    setNotice(t`Change saved.`);
    try {
      await onApplied();
      if (current === generation.current) await load();
    } catch {
      if (current === generation.current)
        setError(t`Change saved. Reload to see the latest version.`);
    }
  }
  const locked = busy || disabled;
  return (
    <div className="mt-3 text-sm" data-testid="private-history">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={locked}
        aria-expanded={open}
        aria-controls={id}
        title={disabled ? t`Save or cancel your draft first.` : undefined}
        onClick={() => {
          setOpen(!open);
          if (!open) void run(() => load());
        }}
      >
        <Trans>History</Trans>
      </Button>
      {open && (
        <section
          id={id}
          aria-label={t`Revision history`}
          className="mt-2 space-y-3 border-t border-border pt-3"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {history?.scope === "bot" ? t`Private to this bot` : t`Private across your bots`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => void run(() => load())}
            >
              <Trans>Reload history</Trans>
            </Button>
          </div>
          {busy && !history ? <Skeleton className="h-16" /> : null}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {history && !history.items.length && (
            <p className="text-muted-foreground">
              <Trans>No recorded changes yet.</Trans>
            </p>
          )}
          {history?.items.map((item) => (
            <article key={item.revision} className="border-b border-border pb-3">
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal px-0 text-start"
                disabled={locked}
                aria-expanded={selected?.revision === item.revision}
                onClick={() => void run(() => select(item.revision))}
              >
                <span className="min-w-0">
                  <span className="block">
                    <Trans>Version {item.revision}</Trans>
                  </span>
                  <span className="block break-words text-muted-foreground">
                    {item.actor} · {item.reason}
                  </span>
                  <time className="block text-xs text-muted-foreground" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </span>
              </Button>
              {selected?.revision === item.revision && (
                <div className="mt-3 space-y-3">
                  {item.sourceTarget && (item.sourceTarget.groupId || item.sourceTarget.botId) && (
                    <a
                      className="text-link underline underline-offset-4"
                      href={
                        item.sourceTarget.groupId
                          ? `/app/g/${encodeURIComponent(item.sourceTarget.groupId)}`
                          : `/app/${encodeURIComponent(item.sourceTarget.botId!)}`
                      }
                    >
                      <Trans>Source conversation</Trans>
                    </a>
                  )}
                  {item.learningSource && <LearningEvidence {...item.learningSource} />}
                  {selected.value.before ? (
                    <VersionText title={t`Before`} value={selected.value.before} />
                  ) : (
                    <p className="text-muted-foreground">
                      <Trans>Earlier content is unavailable.</Trans>
                    </p>
                  )}
                  <VersionText title={t`After`} value={selected.value.after} />
                  {!history.readOnly && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={locked || !item.canUndo || !selected.value.before}
                        onClick={() => void run(() => preview("undo"))}
                      >
                        <Trans>Undo change</Trans>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={locked}
                        onClick={() => void run(() => preview("restore"))}
                      >
                        <Trans>Restore version</Trans>
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
          {history?.nextBeforeRevision && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => void run(() => load(true))}
            >
              <Trans>Older changes</Trans>
            </Button>
          )}
          {review && (
            <form
              className="space-y-3 border-t border-border pt-4"
              aria-label={review.input.action === "undo" ? t`Review undo` : t`Review restore`}
              onSubmit={(event) => {
                event.preventDefault();
                void run(apply);
              }}
            >
              <h4 ref={reviewHeading} tabIndex={-1} className="font-medium">
                {review.input.action === "undo" ? t`Undo change` : t`Restore version`}
              </h4>
              {review.input.action === "restore" && (
                <p className="text-muted-foreground">
                  <Trans>Replaces the entire current version.</Trans>
                </p>
              )}
              <VersionText title={t`Current`} value={review.preview.current} />
              {review.preview.conflict ? (
                <>
                  <p role="status">
                    <Trans>Later edits overlap. Review the result before applying.</Trans>
                  </p>
                  <label htmlFor={`${id}-result`} className="block space-y-1">
                    <span>
                      <Trans>Result</Trans>
                    </span>
                    <Textarea
                      id={`${id}-result`}
                      value={result.content}
                      rows={8}
                      maxLength={100000}
                      disabled={locked}
                      onChange={(event) => {
                        setResult({ ...result, content: event.target.value });
                        setResolved(false);
                      }}
                    />
                  </label>
                  {target.kind === "skill" && (
                    <label
                      htmlFor={`${id}-available`}
                      className="flex items-center justify-between gap-3"
                    >
                      <span>
                        <Trans>Available to future runs</Trans>
                      </span>
                      <Switch
                        id={`${id}-available`}
                        checked={!result.removed}
                        disabled={locked}
                        onCheckedChange={(checked) => {
                          setResult({ ...result, removed: !checked });
                          setResolved(false);
                        }}
                      />
                    </label>
                  )}
                  <label htmlFor={`${id}-resolved`} className="flex items-center gap-2">
                    <Checkbox
                      id={`${id}-resolved`}
                      checked={resolved}
                      disabled={locked}
                      onCheckedChange={(checked) => setResolved(Boolean(checked))}
                    />
                    <span>
                      <Trans>I reviewed the overlapping changes</Trans>
                    </span>
                  </label>
                </>
              ) : (
                <VersionText title={t`Result`} value={result} />
              )}
              <label htmlFor={`${id}-reason`} className="block space-y-1">
                <span>
                  <Trans>Reason for change</Trans>
                </span>
                <Input
                  id={`${id}-reason`}
                  required
                  maxLength={1000}
                  value={reason}
                  disabled={locked}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={locked || !reason.trim() || (review.preview.conflict && !resolved)}
                >
                  <Trans>Apply change</Trans>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => setReview(undefined)}
                >
                  <Trans>Cancel review</Trans>
                </Button>
              </div>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
function VersionText({ title, value }: { title: string; value: PrivateHistoryValue }) {
  return (
    <div className="space-y-1">
      <h5 className="font-medium">{title}</h5>
      {value.removed && (
        <p className="text-muted-foreground">
          <Trans>Removed from future runs</Trans>
        </p>
      )}
      <pre
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans text-sm leading-relaxed"
        dir="auto"
      >
        {value.content || <Trans>Empty</Trans>}
      </pre>
    </div>
  );
}
