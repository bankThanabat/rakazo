import { Trans, useLingui } from "@lingui/react/macro";
import { useLearningReview } from "@rakazo/chat-ui/learning-review";
import type { LearningTaskDetail } from "@rakazo/contracts";
import { Button, Checkbox, Input, Skeleton, Switch, Textarea } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { LearningEvidence } from "./LearningEvidence";
import { PrivateHistory } from "./PrivateHistory";

export function LearningUpdates({
  botId,
  ids,
  disabled = false,
}: {
  botId: string;
  ids?: string[];
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const id = useId();
  const review = useLearningReview(rpc.learning, botId, ids);
  const [historyBusy, setHistoryBusy] = useState(false);
  const locked = review.busy || historyBusy || disabled;
  const detail = review.current;
  const task = detail?.task;
  const proposal = task?.proposal;
  const statuses = {
    review: t`Needs review`,
    applied: t`Applied`,
    rejected: t`Rejected`,
    failed: t`Could not finish`,
    cancelled: t`Cancelled`,
    ignored: t`No change needed`,
    queued: t`Queued`,
    running: t`Learning…`,
  };
  const decisions: Record<string, string> = {
    approve: t`Approved`,
    reject: t`Rejected`,
    retry: t`Learning restarted`,
    undo: t`Undone`,
    restore: t`Restored`,
  };
  const scopes = {
    space: t`Shared across this Space`,
    bot: t`This bot`,
    "private-bot": t`Private to this bot`,
    "private-user": t`Private across your bots`,
  };
  return (
    <section className="min-w-0 space-y-3 text-sm" data-testid="learning-updates">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={locked}
        aria-expanded={review.open}
        aria-controls={id}
        onClick={review.toggle}
      >
        <Trans>Learning updates</Trans>
      </Button>
      {review.open && (
        <div id={id} className="space-y-4 border-t border-border pt-3">
          <fieldset disabled={locked} className="min-w-0 space-y-4">
            <Button type="button" variant="ghost" size="sm" onClick={() => void review.refresh()}>
              <Trans>Reload updates</Trans>
            </Button>
            {!review.list && review.busy && <Skeleton className="h-20" />}
            {review.list?.items.length === 0 && (
              <p className="text-muted-foreground">
                <Trans>No learning updates.</Trans>
              </p>
            )}
            <div className="space-y-1">
              {review.list?.items.map((item) => (
                <Button
                  type="button"
                  key={item.id}
                  variant={item.id === task?.id ? "secondary" : "ghost"}
                  className="h-auto w-full justify-start whitespace-normal py-3 text-start"
                  aria-pressed={item.id === task?.id}
                  onClick={() => void review.select(item.id)}
                >
                  <span className="min-w-0 break-words">
                    <span className="block">{item.title || t`Learning update`}</span>
                    <span className="block text-xs text-muted-foreground">
                      {statuses[item.status]} · {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
            {review.list?.nextCursor && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void review.more()}>
                <Trans>Older updates</Trans>
              </Button>
            )}
            {detail && task && (
              <article
                className="min-w-0 space-y-4 border-t border-border pt-4"
                aria-label={t`Review learning update`}
              >
                <div>
                  <h3 className="break-words font-medium">
                    {proposal?.save.title || t`Learning update`}
                  </h3>
                  <p className="text-muted-foreground">
                    {statuses[task.status]} · {scopes[detail.scope]}
                  </p>
                </div>
                <LearningEvidence key={task.id} botId={botId} taskId={task.id} />
                {task.error && (
                  <p role="status" className="text-destructive">
                    {task.error}
                  </p>
                )}
                {proposal && (
                  <>
                    <div>
                      <h4 className="font-medium">
                        <Trans>Applies when</Trans>
                      </h4>
                      <p className="whitespace-pre-wrap break-words">{proposal.conditions}</p>
                    </div>
                    {proposal.changesBusinessRules && (
                      <p>
                        <Trans>Changes a business rule.</Trans>
                      </p>
                    )}
                    {!proposal.publicSafe && (
                      <p>
                        <Trans>Contains guidance for staff only.</Trans>
                      </p>
                    )}
                    {!proposal.supported && (
                      <p>
                        <Trans>
                          The source does not fully support this suggestion. Review the evidence.
                        </Trans>
                      </p>
                    )}
                    {detail.before ? (
                      <ReviewText
                        label={t`Before`}
                        version={detail.before}
                        privateScope={Boolean(proposal.native)}
                      />
                    ) : (
                      <p>
                        <Trans>Earlier content is unavailable.</Trans>
                      </p>
                    )}
                    {detail.after && (
                      <ReviewText
                        label={t`After`}
                        version={detail.after}
                        privateScope={Boolean(proposal.native)}
                      />
                    )}
                  </>
                )}
                {task.status === "review" && detail.stale && (
                  <p role="status">
                    <Trans>
                      The destination changed. Regenerate this proposal before approving it.
                    </Trans>
                  </p>
                )}
                {!review.undo &&
                  ["review", "failed", "rejected", "cancelled"].includes(task.status) && (
                    <>
                      <label htmlFor={`${id}-decision`} className="block space-y-2">
                        <span>
                          <Trans>Reason for decision</Trans>
                        </span>
                        <Input
                          id={`${id}-decision`}
                          value={review.reason}
                          maxLength={900}
                          onChange={(event) => review.setReason(event.target.value)}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {task.status === "review" && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={
                              !detail.canEdit ||
                              !review.reason.trim() ||
                              detail.stale ||
                              !detail.before ||
                              !proposal
                            }
                            onClick={() => void review.decide("approve")}
                          >
                            <Trans>Approve change</Trans>
                          </Button>
                        )}
                        {["review", "failed"].includes(task.status) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!review.reason.trim()}
                            onClick={() => void review.decide("reject")}
                          >
                            <Trans>Reject</Trans>
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={!review.reason.trim()}
                          onClick={() => void review.decide("retry")}
                        >
                          {task.status === "review" ? (
                            <Trans>Regenerate</Trans>
                          ) : (
                            <Trans>Retry learning</Trans>
                          )}
                        </Button>
                      </div>
                    </>
                  )}
                {task.documentId && task.appliedRevision && (
                  <>
                    <p className="text-muted-foreground">
                      <Trans>Applied version {task.appliedRevision}</Trans>
                    </p>
                    {task.targetKind !== "document" ? (
                      <PrivateHistory
                        key={`${task.targetKind}:${task.documentId}`}
                        target={{ kind: task.targetKind, id: task.documentId }}
                        disabled={disabled}
                        onApplied={review.refresh}
                        onBusyChange={setHistoryBusy}
                      />
                    ) : (
                      detail.canEdit &&
                      !review.undo && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => void review.prepareUndo()}
                        >
                          <Trans>Undo change</Trans>
                        </Button>
                      )
                    )}
                  </>
                )}
                {review.undo && (
                  <div className="space-y-3 border-t border-border pt-3">
                    <h4 className="font-medium">
                      <Trans>Review undo</Trans>
                    </h4>
                    <ReviewText label={t`Current`} version={review.undo.preview.current} />
                    {review.undo.preview.conflicts.length > 0 && (
                      <p>
                        <Trans>Later edits overlap. Review the result before applying.</Trans>
                      </p>
                    )}
                    <label htmlFor={`${id}-undo-title`} className="block space-y-2">
                      <span>
                        <Trans>Resulting title</Trans>
                      </span>
                      <Input
                        id={`${id}-undo-title`}
                        value={review.undo.preview.proposed.title}
                        maxLength={120}
                        onChange={(event) => review.changeUndo({ title: event.target.value })}
                      />
                    </label>
                    <label htmlFor={`${id}-undo-content`} className="block space-y-2">
                      <span>
                        <Trans>Resulting content</Trans>
                      </span>
                      <Textarea
                        id={`${id}-undo-content`}
                        value={review.undo.preview.proposed.content}
                        maxLength={16000}
                        rows={8}
                        onChange={(event) => review.changeUndo({ content: event.target.value })}
                      />
                    </label>
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`${id}-visible`}
                        checked={review.undo.preview.proposed.customerVisible}
                        onCheckedChange={(customerVisible) =>
                          review.changeUndo({ customerVisible })
                        }
                      />
                      <label htmlFor={`${id}-visible`}>
                        <Trans>Use in customer replies after undo</Trans>
                      </label>
                    </div>
                    {review.undo.preview.conflicts.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`${id}-resolved`}
                          checked={review.resolved}
                          onCheckedChange={(value) => review.setResolved(Boolean(value))}
                        />
                        <label htmlFor={`${id}-resolved`}>
                          <Trans>I reviewed the overlapping edits.</Trans>
                        </label>
                      </div>
                    )}
                    <label htmlFor={`${id}-undo-reason`} className="block space-y-2">
                      <span>
                        <Trans>Reason for undo</Trans>
                      </span>
                      <Input
                        id={`${id}-undo-reason`}
                        value={review.reason}
                        maxLength={900}
                        onChange={(event) => review.setReason(event.target.value)}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          !review.reason.trim() ||
                          !review.undo.preview.proposed.title.trim() ||
                          Boolean(review.undo.preview.conflicts.length && !review.resolved)
                        }
                        onClick={() => void review.applyUndo()}
                      >
                        <Trans>Apply undo</Trans>
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={review.cancelUndo}>
                        <Trans>Cancel review</Trans>
                      </Button>
                    </div>
                  </div>
                )}
                {task.reviews.length > 0 && (
                  <details>
                    <summary className="cursor-pointer py-2">
                      <Trans>Recent decisions</Trans>
                    </summary>
                    <ol className="space-y-3">
                      {task.reviews.map((entry, index) => (
                        <li
                          key={`${entry.createdAt}:${index}`}
                          className="border-t border-border pt-3"
                        >
                          <p className="whitespace-pre-wrap break-words">{entry.reason}</p>
                          <p className="text-xs text-muted-foreground">
                            {decisions[entry.decision] ?? entry.decision} ·{" "}
                            {new Date(entry.createdAt).toLocaleString()}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </article>
            )}
          </fieldset>
          {review.error && (
            <p role="alert" className="text-destructive">
              <Trans>Could not complete this review. Reload updates and try again.</Trans>
            </p>
          )}
          {review.notice && (
            <p role="status">
              {review.notice === "queued"
                ? t`Learning queued. Reload updates when it finishes.`
                : review.notice === "rejected"
                  ? t`Suggestion rejected.`
                  : t`Change saved.`}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ReviewText({
  label,
  version,
  privateScope = false,
}: {
  label: string;
  version: NonNullable<LearningTaskDetail["after"]>;
  privateScope?: boolean;
}) {
  const { t } = useLingui();
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="font-medium">{label}</h4>
      <p className="break-words text-muted-foreground">
        {version.title}
        {!privateScope && (
          <>
            {version.title ? " · " : ""}
            {version.customerVisible ? t`Use in customer replies` : t`Staff only`}
          </>
        )}
      </p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans leading-relaxed">
        {version.content || t`Empty`}
      </pre>
    </div>
  );
}
