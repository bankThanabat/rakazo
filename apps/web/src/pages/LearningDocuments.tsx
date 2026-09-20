import { Trans, useLingui } from "@lingui/react/macro";
import type {
  LearningArchive,
  LearningRestore,
  LearningSourceRef,
  LearningState,
  LearningUndoPreview,
} from "@rakazo/contracts";
import { Button, Input, Skeleton, Switch, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { LearningEvidence } from "./LearningEvidence";

type Document = LearningState["documents"][number];
export function LearningDocuments({ botId }: { botId: string }) {
  const { t } = useLingui();
  const fieldId = useId();
  const [state, setState] = useState<LearningState>();
  const [scope, setScope] = useState<"space" | "bot">("space");
  const [kind, setKind] = useState<Document["kind"]>("voice");
  const [key, setKey] = useState("brand-voice");
  const [title, setTitle] = useState(t`Brand voice`);
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("Staff instruction");
  const [sourceRef, setSourceRef] = useState<LearningSourceRef>();
  const [pendingImport, setPendingImport] = useState<LearningArchive>();
  const [visible, setVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<{ input: LearningRestore; preview: LearningUndoPreview }>();
  const [undoReason, setUndoReason] = useState("");
  const [preview, setPreview] = useState<
    Awaited<ReturnType<typeof rpc.learning.previewImport>> & { input: LearningArchive }
  >();
  const file = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const selected = state?.documents.find(
    (d) => d.scope === scope && d.kind === kind && d.key === key,
  );
  useEffect(() => {
    const current = ++generation.current;
    void rpc.learning
      .state({ botId })
      .then((next) => {
        if (current === generation.current) setState(next);
      })
      .catch(() => {
        if (current === generation.current) setError(t`Could not load learning. Try again.`);
      });
    return () => {
      generation.current++;
    };
  }, [botId, t]);
  useEffect(() => {
    setTitle(selected?.title ?? (kind === "voice" ? t`Brand voice` : ""));
    setContent(selected?.content ?? "");
    setVisible(selected?.customerVisible ?? kind === "voice");
    setReason("");
    setSource("Staff instruction");
    setPreview(undefined);
    setSourceRef(undefined);
    setPendingImport(undefined);
    setUndo(undefined);
    setUndoReason("");
  }, [selected?.id, selected?.revision, scope, kind, key, t]);
  async function run(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      const next = await rpc.learning.state({ botId });
      if (current === generation.current) {
        setState(next);
        setNotice(message);
      }
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : t`Could not save. Reload and try again.`);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function choose(doc: Document) {
    setScope(doc.scope);
    setKind(doc.kind);
    setKey(doc.key);
  }
  const editable = selected?.canEdit ?? (scope === "bot" || state?.canEditSpace);
  return (
    <section className="space-y-5 py-4" aria-label={t`Learning documents`}>
      {!state && !error ? <Skeleton className="h-24 w-full" /> : null}
      <fieldset className="flex gap-2" aria-label={t`Document scope`} disabled={busy}>
        <Button
          size="sm"
          variant={scope === "space" ? "secondary" : "ghost"}
          aria-pressed={scope === "space"}
          onClick={() => setScope("space")}
        >
          <Trans>Space default</Trans>
        </Button>
        <Button
          size="sm"
          variant={scope === "bot" ? "secondary" : "ghost"}
          aria-pressed={scope === "bot"}
          onClick={() => setScope("bot")}
        >
          <Trans>Bot override</Trans>
        </Button>
      </fieldset>
      <p className="text-sm text-muted-foreground">
        {scope === "space" ? (
          <Trans>Shared across this Space. Bot documents can override it.</Trans>
        ) : (
          <Trans>Applies to this bot. Clear an override to inherit the Space document.</Trans>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {state?.documents
          .filter((d) => d.scope === scope)
          .map((doc) => (
            <Button
              key={doc.id}
              size="sm"
              variant={selected?.id === doc.id ? "secondary" : "ghost"}
              disabled={busy}
              onClick={() => choose(doc)}
            >
              {doc.title}
            </Button>
          ))}
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            let evidence = sourceRef;
            if (pendingImport) {
              const archived = await rpc.learning.archive(pendingImport);
              evidence = { kind: "import", id: archived.sourceId };
              setSourceRef(evidence);
            }
            await rpc.learning.save({
              botId,
              scope,
              kind,
              key,
              title,
              content,
              reason,
              source,
              sourceRef: evidence,
              customerVisible: visible,
              expectedRevision: selected?.revision ?? 0,
            });
          }, t`Saved with an audit record.`);
        }}
      >
        <fieldset disabled={busy || !editable} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>
                <Trans>Type</Trans>
              </span>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-foreground"
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as Document["kind"];
                  setKind(next);
                  setKey(next === "voice" ? "brand-voice" : next);
                }}
              >
                <option value="voice">{t`Brand voice`}</option>
                <option value="knowledge">{t`Knowledge`}</option>
                <option value="memory">{t`Memory`}</option>
                <option value="skill">{t`Skill`}</option>
              </select>
            </label>
            <label htmlFor={`${fieldId}-title`} className="space-y-1 text-sm">
              <span>
                <Trans>Title</Trans>
              </span>
              <Input
                id={`${fieldId}-title`}
                value={title}
                maxLength={120}
                required
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
          </div>
          {kind !== "voice" && (
            <label htmlFor={`${fieldId}-key`} className="block space-y-1 text-sm">
              <span>
                <Trans>Document key</Trans>
              </span>
              <Input
                id={`${fieldId}-key`}
                value={key}
                pattern="[a-z0-9][a-z0-9-]{0,79}"
                required
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
          )}
          <label htmlFor={`${fieldId}-content`} className="block space-y-1 text-sm">
            <span>
              <Trans>Content</Trans>
            </span>
            <Textarea
              id={`${fieldId}-content`}
              value={content}
              maxLength={16000}
              rows={8}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t`Tone, preferred wording, examples, and situations where this guidance applies…`}
            />
          </label>
          <label
            htmlFor={`${fieldId}-visible`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>
              <Trans>Use in customer replies</Trans>
            </span>
            <Switch id={`${fieldId}-visible`} checked={visible} onCheckedChange={setVisible} />
          </label>
          <label htmlFor={`${fieldId}-reason`} className="block space-y-1 text-sm">
            <span>
              <Trans>Reason for change</Trans>
            </span>
            <Input
              id={`${fieldId}-reason`}
              value={reason}
              required
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer py-2">
              <Trans>Source and reply imports</Trans>
            </summary>
            <div className="space-y-3 py-3">
              <label htmlFor={`${fieldId}-source`} className="block space-y-1">
                <span>
                  <Trans>Source</Trans>
                </span>
                <Input
                  id={`${fieldId}-source`}
                  value={source}
                  maxLength={2000}
                  onChange={(e) => setSource(e.target.value)}
                />
              </label>
              <p className="text-muted-foreground">
                <Trans>
                  CSV or JSON: thread_id, sent_at with timezone, author_role, text. Review business
                  replies before sharing. Only the last 30 days are included.
                </Trans>
              </p>
              <input
                ref={file}
                type="file"
                accept=".csv,.json"
                className="hidden"
                onChange={async (e) => {
                  const selectedFile = e.target.files?.[0];
                  if (!selectedFile) return;
                  setError("");
                  if (selectedFile.size > 1_000_000) {
                    setError(t`Choose a file smaller than 1 MB.`);
                    return;
                  }
                  try {
                    const input: LearningArchive = {
                      botId,
                      format: selectedFile.name.endsWith(".json") ? "json" : "csv",
                      content: await selectedFile.text(),
                      source: source.slice(0, 200) || "Reply export",
                      windowEnd: new Date().toISOString(),
                    };
                    const next = await rpc.learning.previewImport(input);
                    setPreview({ ...next, input });
                  } catch {
                    setError(t`Could not preview this file. Check the columns and timestamps.`);
                  }
                  e.target.value = "";
                }}
              />
              <Button type="button" variant="outline" onClick={() => file.current?.click()}>
                <Trans>Preview reply import</Trans>
              </Button>
              {preview && (
                <div className="space-y-2" role="status">
                  <p>
                    <Trans>
                      {preview.accepted} business replies · {preview.skipped} skipped ·{" "}
                      {preview.duplicates} duplicates
                    </Trans>
                  </p>
                  {preview.earliest && (
                    <p className="text-muted-foreground">
                      {preview.earliest} – {preview.latest}
                    </p>
                  )}
                  {preview.errors.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">
                    {preview.content}
                  </pre>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!preview.accepted}
                    onClick={() => {
                      setContent(preview.content);
                      setPendingImport(preview.input);
                      setReason(t`Reviewed historical business replies`);
                      setPreview(undefined);
                    }}
                  >
                    <Trans>Use reviewed examples</Trans>
                  </Button>
                </div>
              )}
            </div>
          </details>
          <Button type="submit" disabled={!title.trim() || !reason.trim()}>
            {busy ? <Trans>Saving…</Trans> : <Trans>Save document</Trans>}
          </Button>
        </fieldset>
      </form>
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {undo && (
        <section aria-label={t`Review undo`} className="space-y-3 border-t border-border pt-4">
          <h3 className="font-medium">
            <Trans>Undo version {undo.input.revision}</Trans>
          </h3>
          {undo.preview.conflicts.length > 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>
                Later edits overlap this change. They are kept below. Review before applying.
              </Trans>
            </p>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer">
              <Trans>Compare versions</Trans>
            </summary>
            <div className="space-y-3 py-3">
              {(
                [
                  [t`Before this change`, undo.preview.before],
                  [t`After this change`, undo.preview.after],
                  [t`Current version`, undo.preview.current],
                ] as const
              ).map(([label, version]) => (
                <div key={label}>
                  <p className="font-medium">{label}</p>
                  <p>
                    {version.title} ·{" "}
                    {version.customerVisible ? t`Use in customer replies` : t`Staff only`}
                  </p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">
                    {version.content || t`Removed from use`}
                  </pre>
                </div>
              ))}
            </div>
          </details>
          <label htmlFor={`${fieldId}-undo-title`} className="block space-y-1 text-sm">
            <span>
              <Trans>Resulting title</Trans>
            </span>
            <Input
              id={`${fieldId}-undo-title`}
              value={undo.preview.proposed.title}
              disabled={busy}
              maxLength={120}
              onChange={(e) =>
                setUndo({
                  ...undo,
                  preview: {
                    ...undo.preview,
                    proposed: { ...undo.preview.proposed, title: e.target.value },
                  },
                })
              }
            />
          </label>
          <label htmlFor={`${fieldId}-undo-content`} className="block space-y-1 text-sm">
            <span>
              <Trans>Resulting content</Trans>
            </span>
            <Textarea
              id={`${fieldId}-undo-content`}
              value={undo.preview.proposed.content}
              disabled={busy}
              maxLength={16000}
              rows={6}
              onChange={(e) =>
                setUndo({
                  ...undo,
                  preview: {
                    ...undo.preview,
                    proposed: { ...undo.preview.proposed, content: e.target.value },
                  },
                })
              }
            />
          </label>
          <label
            htmlFor={`${fieldId}-undo-visible`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>
              <Trans>Use in customer replies after undo</Trans>
            </span>
            <Switch
              id={`${fieldId}-undo-visible`}
              disabled={busy}
              checked={undo.preview.proposed.customerVisible}
              onCheckedChange={(customerVisible) =>
                setUndo({
                  ...undo,
                  preview: {
                    ...undo.preview,
                    proposed: { ...undo.preview.proposed, customerVisible },
                  },
                })
              }
            />
          </label>
          <label htmlFor={`${fieldId}-undo-reason`} className="block space-y-1 text-sm">
            <span>
              <Trans>Reason for undo</Trans>
            </span>
            <Input
              id={`${fieldId}-undo-reason`}
              value={undoReason}
              disabled={busy}
              maxLength={1000}
              onChange={(e) => setUndoReason(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !undoReason.trim() || !undo.preview.proposed.title.trim()}
              onClick={() =>
                void run(async () => {
                  await rpc.learning.undo({
                    ...undo.input,
                    resolution: undo.preview.proposed,
                    reason: undoReason,
                  });
                  setUndo(undefined);
                }, t`Undone. Later edits and audit history are preserved.`)
              }
            >
              <Trans>Apply undo</Trans>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setUndo(undefined)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </section>
      )}
      <details className="border-t border-border pt-4 text-sm">
        <summary className="cursor-pointer">
          <Trans>Audit history</Trans>
        </summary>
        <div className="divide-y divide-border">
          {state?.history
            .filter((r) => r.documentId === selected?.id)
            .map((revision) => (
              <div key={revision.id} className="space-y-2 py-4">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <Trans>Version {revision.revision}</Trans> ·{" "}
                    {new Date(revision.createdAt).toLocaleString()}
                  </span>
                  {selected?.canEdit && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const input = {
                            botId,
                            documentId: selected.id,
                            revision: revision.revision,
                            expectedRevision: selected.revision,
                          };
                          const preview = await rpc.learning.previewUndo(input);
                          setUndo({ input, preview });
                          setUndoReason("");
                        }, "")
                      }
                    >
                      <Trans>Undo change</Trans>
                    </Button>
                  )}
                </div>
                <p>{revision.reason}</p>
                <p className="text-muted-foreground">{revision.actor}</p>
                <p className="text-muted-foreground">{revision.source}</p>
                {revision.hasEvidence && (
                  <LearningEvidence botId={botId} revisionId={revision.id} />
                )}
                <details>
                  <summary className="cursor-pointer">
                    <Trans>View content</Trans>
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words">
                    {revision.content || t`Removed from use`}
                  </pre>
                </details>
              </div>
            ))}
          {!selected && (
            <p className="py-4 text-muted-foreground">
              <Trans>Save a document to start its audit history.</Trans>
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
