import { Trans, useLingui } from "@lingui/react/macro";
import type { LearningEvidence as Evidence } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../lib/rpc";

export function LearningEvidence({
  botId,
  revisionId,
  taskId,
}: { botId: string } & (
  | { revisionId: string; taskId?: never }
  | { taskId: string; revisionId?: never }
)) {
  const { t } = useLingui();
  const [evidence, setEvidence] = useState<Evidence>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const read = () =>
    taskId
      ? rpc.learning.taskEvidence({ botId, taskId })
      : rpc.learning.evidence({ botId, revisionId: revisionId! });
  async function open() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setEvidence(await read());
    } catch {
      setEvidence(undefined);
      setError(t`Source unavailable or you no longer have access.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => (evidence ? setEvidence(undefined) : void open())}
      >
        {evidence ? <Trans>Hide source</Trans> : <Trans>View source</Trans>}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {evidence && (
        <div className="space-y-2">
          <p>{evidence.label}</p>
          {evidence.coverage && (
            <p className="text-muted-foreground">
              {evidence.kind === "social" ? (
                <Trans>Saved posts: {evidence.coverage.accepted}</Trans>
              ) : (
                <Trans>
                  {evidence.coverage.accepted} business replies · {evidence.coverage.skipped}{" "}
                  skipped · {evidence.coverage.duplicates} duplicates
                </Trans>
              )}
            </p>
          )}
          {evidence.windowEnd && (
            <p className="text-muted-foreground">
              <Trans>Evidence through {new Date(evidence.windowEnd).toLocaleString()}</Trans>
            </p>
          )}
          {evidence.withdrawn ? (
            <p role="status">
              <Trans>Source removed. It cannot be used for future learning.</Trans>
            </p>
          ) : (
            <>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">
                {evidence.content.slice(0, 16000)}
              </pre>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([evidence.content], {
                      type:
                        evidence.format === "csv" ? "text/csv;charset=utf-8" : "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `learning-source.${evidence.format}`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                {taskId || evidence.kind === "social" ? (
                  <Trans>Download source</Trans>
                ) : (
                  <Trans>Download original</Trans>
                )}
              </Button>
              {evidence.kind !== "conversation" && (
                <details>
                  <summary className="cursor-pointer">
                    <Trans>Remove source</Trans>
                  </summary>
                  <p className="py-2 text-muted-foreground">
                    {evidence.kind === "social" ? (
                      <Trans>
                        Deletes this saved copy. Source settings and learned documents stay
                        unchanged.
                      </Trans>
                    ) : (
                      <Trans>
                        Deletes the original import and stops future learning from it. Existing
                        documents keep their current content.
                      </Trans>
                    )}
                  </p>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await rpc.learning.withdrawSource({ botId, sourceId: evidence.sourceId });
                        setEvidence(await read());
                      } catch {
                        setError(t`Could not remove this source. Reload and try again.`);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {evidence.kind === "social" ? (
                      <Trans>Remove saved posts</Trans>
                    ) : (
                      <Trans>Remove imported source</Trans>
                    )}
                  </Button>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
