import { Trans, useLingui } from "@lingui/react/macro";
import type { KnowledgeSource, KnowledgeState } from "@rakazo/contracts";
import {
  ATTACHMENT_MAX_BYTES,
  KNOWLEDGE_MIME_TYPES,
  KnowledgeUploadInput,
  knowledgeMimeType,
} from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Skeleton,
  Switch,
} from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

export function KnowledgeDocuments({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [deleting, setDeleting] = useState<KnowledgeSource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replace = useRef<string | undefined>(undefined);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (pending) return;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await rpc.knowledge.state({ botId });
        if (current !== generation.current) return;
        setState(next);
        if (
          next.sources.some(
            (source) => source.status === "processing" || source.status === "queued",
          )
        )
          timer = setTimeout(refresh, 3000);
      } catch {
        if (current === generation.current) setError(t`Could not load documents. Try again.`);
      }
    }
    void refresh();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [botId, pending, t]);

  async function run(action: () => Promise<KnowledgeState | undefined>) {
    if (pending) return;
    const current = generation.current;
    setPending(true);
    setError("");
    try {
      const next = await action();
      if (current === generation.current && next) setState(next);
    } catch {
      setError(t`Could not save the document change. Try again.`);
    } finally {
      setPending(false);
    }
  }
  function pick(sourceId?: string) {
    replace.current = sourceId;
    fileInput.current?.click();
  }
  async function upload(file: File) {
    const sourceId = replace.current;
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setError(t`Choose a file smaller than 10 MiB.`);
      return;
    }
    await run(async () => {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.readAsDataURL(file);
      });
      const mimeType = knowledgeMimeType(file.name, file.type);
      return rpc.knowledge.upload(
        KnowledgeUploadInput.parse({ botId, sourceId, name: file.name, mimeType, contentBase64 }),
      );
    });
  }
  function status(source: KnowledgeSource) {
    if (source.status === "ready") return t`Ready`;
    if (source.status === "failed")
      return source.activeRevisionId
        ? t`Update failed. Previous version is available.`
        : t`Processing failed. Replace the file to retry.`;
    return source.activeRevisionId ? t`Updating` : t`Processing`;
  }
  return (
    <div data-testid="knowledge-documents" className="space-y-4 py-3">
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
          <Button variant="ghost" onClick={() => void run(() => rpc.knowledge.state({ botId }))}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {!state && !error ? <Skeleton className="h-16 w-full" /> : null}
      {state ? (
        <>
          {state.configured ? (
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={`knowledge-enabled-${botId}`} className="text-sm">
                <Trans>Use shared knowledge</Trans>
              </label>
              <Switch
                id={`knowledge-enabled-${botId}`}
                checked={state.enabled}
                disabled={pending}
                onCheckedChange={(enabled) =>
                  void run(() => rpc.knowledge.attach({ botId, enabled }))
                }
              />
            </div>
          ) : null}
          {(!state.configured || connectionOpen) && state.canManage ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const next = await rpc.knowledge.configure({ botId, baseUrl, apiKey });
                  setApiKey("");
                  setConnectionOpen(false);
                  return next;
                });
              }}
            >
              <Input
                aria-label={t`Knowledge service URL`}
                placeholder={t`Knowledge service URL`}
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                disabled={pending}
              />
              <Input
                aria-label={t`API key`}
                placeholder={t`API key`}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
                disabled={pending}
              />
              <Button type="submit" disabled={pending}>
                <Trans>Connect knowledge</Trans>
              </Button>
            </form>
          ) : null}
          {state.configured ? (
            <>
              <div className="flex items-center justify-between gap-2">
                {state.canManage ? (
                  <Button variant="outline" disabled={pending} onClick={() => pick()}>
                    <Trans>Add document</Trans>
                  </Button>
                ) : (
                  <span />
                )}
                {state.canManage ? (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setBaseUrl(state.baseUrl ?? "");
                      setConnectionOpen(!connectionOpen);
                    }}
                  >
                    <Trans>Connection</Trans>
                  </Button>
                ) : null}
              </div>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept={Object.keys(KNOWLEDGE_MIME_TYPES)
                  .map((extension) => `.${extension}`)
                  .join(",")}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void upload(file);
                }}
              />
              {!state.sources.length ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>No documents yet.</Trans>
                </p>
              ) : null}
              <div className="divide-y divide-border">
                {state.sources.map((source) => (
                  <div key={source.id} className="space-y-2 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="break-words text-sm font-medium">{source.name}</div>
                        <div className="text-xs text-muted-foreground" role="status">
                          {status(source)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        <span aria-hidden="true">
                          <Trans>Internal</Trans>
                        </span>
                        <Switch
                          id={`internal-${source.id}`}
                          aria-label={t`Internal: ${source.name}`}
                          checked={source.internal}
                          disabled={pending || !state.canManage}
                          onCheckedChange={(internal) =>
                            void run(() =>
                              rpc.knowledge.visibility({ botId, sourceId: source.id, internal }),
                            )
                          }
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void run(async () => {
                            const file = await rpc.knowledge.download({
                              botId,
                              sourceId: source.id,
                            });
                            downloadArtifactBytes(
                              file.name,
                              file.mimeType,
                              decodeArtifactBase64(file.contentBase64),
                            );
                          })
                        }
                      >
                        <Trans>Download</Trans>
                      </Button>
                      {state.canManage ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => pick(source.id)}
                          >
                            <Trans>Replace</Trans>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setDeleting(source)}
                          >
                            <Trans>Delete</Trans>
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Delete document?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>{deleting?.name}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const sourceId = deleting?.id;
                setDeleting(null);
                if (sourceId) void run(() => rpc.knowledge.remove({ botId, sourceId }));
              }}
            >
              <Trans>Delete</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
