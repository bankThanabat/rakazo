import { Trans, useLingui } from "@lingui/react/macro";
import type { LearningApprovalReview } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";

export function LearningApprovalDetail({
  review,
  detail,
}: {
  review: LearningApprovalReview;
  detail: string;
}) {
  const { t } = useLingui();
  const [view, setView] = useState<"before" | "after" | "request">("after");
  const { proposal, native } = review;
  const labels = { before: t`Before`, after: t`After`, request: t`Request details` };
  const content =
    view === "request" ? detail : view === "before" ? native.beforeContent : native.content;
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-foreground">
      <h3 className="text-[15.5px] font-medium">
        {native.kind === "memory" ? t`Review memory change` : t`Review skill change`}
      </h3>
      <div className="break-words">
        <p>{proposal.save.title}</p>
        <p className="text-muted-foreground">
          {native.scope === "bot" ? t`Private to this bot` : t`Private across your bots`}
        </p>
        {native.kind === "memory" && (
          <p className="break-all text-muted-foreground">{native.path}</p>
        )}
      </div>
      <div>
        <p className="font-medium">
          <Trans>Applies when</Trans>
        </p>
        <p className="whitespace-pre-wrap break-words">{proposal.conditions}</p>
      </div>
      {review.reviewReason && (
        <p className="whitespace-pre-wrap break-words">{review.reviewReason}</p>
      )}
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
          <Trans>The source does not fully support this suggestion. Review the evidence.</Trans>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(["before", "after", "request"] as const).map((item) => (
          <Button
            key={item}
            variant={view === item ? "secondary" : "ghost"}
            aria-pressed={view === item}
            onClick={() => setView(item)}
          >
            {labels[item]}
          </Button>
        ))}
      </div>
      <section
        key={view}
        aria-label={labels[view]}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable review supports keyboard navigation.
        tabIndex={0}
        className={`max-h-72 overflow-auto whitespace-pre-wrap break-words bg-muted px-3.5 py-3 ${view === "request" ? "font-mono text-[12.5px]" : "text-[14px]"}`}
      >
        {content || t`Empty`}
      </section>
    </div>
  );
}
