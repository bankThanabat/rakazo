import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { optionalCatalogFeedProbe } from "../../lib/optional-catalog-feed";
import { rpc } from "../../lib/rpc";

type SourceKind = "mcp" | "api" | "graphql" | "executor" | "treg";
type AuthType = "none" | "bearer" | "header";

/** Rendered in this order; e2e locks it. */
const SOURCE_KINDS: SourceKind[] = ["mcp", "api", "graphql", "executor", "treg"];
const SOURCE_URL_PLACEHOLDER: Record<Exclude<SourceKind, "treg">, string> = {
  mcp: "https://example.com/mcp",
  executor: "https://executor.example/mcp",
  graphql: "https://example.com/graphql",
  api: "https://example.com/openapi.json",
};

/** Every connection path that is not the app catalog: tool sources, catalog feed, MCP servers, server providers. */
export function AdvancedSources({
  canConfigure,
  onOpenMcp,
  onNavigate,
  onBack,
}: {
  canConfigure: boolean;
  onOpenMcp?: () => void;
  onNavigate?: (path: string) => void;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [authName, setAuthName] = useState("x-api-key");
  const [hint, setHint] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedEnabled, setFeedEnabled] = useState(false);
  const [feedQuery, setFeedQuery] = useState("");
  const [feedResults, setFeedResults] = useState<IntegrationCatalogResult[]>([]);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedPending, setFeedPending] = useState(false);
  const [feedSearched, setFeedSearched] = useState(false);
  const tokenOnly = kind === "treg" || kind === "executor";

  useEffect(() => {
    void Promise.all([
      rpc.capabilities.list(),
      optionalCatalogFeedProbe(rpc.capabilities.catalogSearch({ query: "" })),
    ])
      .then(([installs, feed]) => {
        setSources(
          installs.filter(
            (install) =>
              install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
          ),
        );
        setFeedEnabled(feed.enabled);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t`Could not load tool sources`),
      );
  }, []);

  function kindLabel(value: SourceKind) {
    return value === "mcp"
      ? t`Add MCP server`
      : value === "api"
        ? t`Add OpenAPI`
        : value === "graphql"
          ? t`Add GraphQL`
          : value === "executor"
            ? t`Add Executor`
            : t`Add Treg`;
  }

  function beginSource(next: SourceKind) {
    setKind(next);
    setError(null);
    setHint(null);
    setName(next === "treg" ? "Treg" : next === "executor" ? "Executor" : "");
    setUrl(next === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setAuthType(next === "treg" || next === "executor" ? "bearer" : "none");
    setAuthName("x-api-key");
  }

  function beginCatalogSurface(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
  ) {
    if (!surface.source || (surface.kind !== "mcp" && surface.kind !== "openapi")) return;
    setKind(surface.kind === "mcp" ? "mcp" : "api");
    setName(result.name);
    setUrl(surface.source);
    setCredential("");
    setAuthType(surface.auth?.type ?? "none");
    setAuthName(surface.auth?.headerName ?? "x-api-key");
    setHint(surface.auth?.note ?? null);
    setError(null);
  }

  async function installSource() {
    if (!kind) return;
    setError(null);
    setPending("install-source");
    try {
      const auth = { type: authType, ...(authType === "header" ? { name: authName.trim() } : {}) };
      const install = await rpc.capabilities.install({
        kind: tokenOnly ? "mcp" : kind,
        name:
          name.trim() ||
          (kind === "treg"
            ? "Treg"
            : kind === "executor"
              ? "Executor"
              : kind === "graphql"
                ? "GraphQL"
                : "Custom connector"),
        source: url.trim(),
        credential: credential.trim() || undefined,
        config:
          kind === "treg"
            ? { preset: "treg", auth: { type: "bearer" } }
            : kind === "api"
              ? { openApi: true, auth }
              : kind === "graphql"
                ? { auth }
                : { preset: "custom", auth: kind === "executor" ? { type: "bearer" } : auth },
      });
      setCredential("");
      setKind(null);
      setSources((current) => [...current.filter((entry) => entry.id !== install.id), install]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not install connector`);
    } finally {
      setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    setPending(install.id);
    setError(null);
    try {
      await rpc.capabilities.remove({ id: install.id });
      setSources((current) => current.filter((source) => source.id !== install.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not remove connector`);
    } finally {
      setPending(null);
    }
  }

  async function searchFeed() {
    setFeedError(null);
    setFeedPending(true);
    setFeedSearched(false);
    setFeedResults([]);
    try {
      const response = await rpc.capabilities.catalogSearch({ query: feedQuery });
      setFeedResults(response.results);
      setFeedSearched(true);
    } catch (cause) {
      setFeedError(cause instanceof Error ? cause.message : t`Could not search catalog`);
    } finally {
      setFeedPending(false);
    }
  }

  return (
    <div data-testid="integrations-advanced" className="space-y-8 p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ms-1.5 sm:hidden"
          aria-label={t`Back to apps`}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <h2 className="text-base font-semibold text-foreground">
          <Trans>Advanced</Trans>
        </h2>
      </div>

      <section className="space-y-4">
        <h3 className="text-sm font-medium text-foreground">
          <Trans>Tool sources</Trans>
        </h3>
        {sources.length ? (
          <ul className="divide-y divide-border border-y border-border">
            {sources.map((source) => (
              <li key={source.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{source.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {source.kind.toUpperCase()} · {source.source} ·{" "}
                    {source.secretConfigured ? (
                      <Trans>credential saved</Trans>
                    ) : (
                      <Trans>no auth</Trans>
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending === source.id}
                  onClick={() => void removeSource(source)}
                >
                  {pending === source.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div data-testid="integrations-advanced-add" className="flex flex-wrap gap-2">
          {SOURCE_KINDS.map((value) => (
            <Button
              key={value}
              variant="outline"
              size="sm"
              aria-pressed={kind === value}
              onClick={() => beginSource(value)}
            >
              {kindLabel(value)}
            </Button>
          ))}
        </div>
        {kind ? (
          <form
            className="max-w-md space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void installSource();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={t`Display name`}
              placeholder={t`Display name`}
            />
            {kind !== "treg" ? (
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-label={t`Source URL`}
                placeholder={SOURCE_URL_PLACEHOLDER[kind]}
              />
            ) : null}
            {!tokenOnly ? (
              <NativeSelect
                className="w-full"
                aria-label={t`Authentication`}
                value={authType}
                onChange={(event) => setAuthType(event.target.value as AuthType)}
              >
                <NativeSelectOption value="none">
                  <Trans>No authentication</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="bearer">
                  <Trans>Bearer token</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="header">
                  <Trans>API key header</Trans>
                </NativeSelectOption>
              </NativeSelect>
            ) : null}
            {!tokenOnly && authType === "header" ? (
              <Input
                value={authName}
                onChange={(event) => setAuthName(event.target.value)}
                aria-label={t`Header name`}
                placeholder={t`Header name`}
              />
            ) : null}
            {tokenOnly || authType !== "none" ? (
              <Input
                type="password"
                autoComplete="new-password"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                aria-label={
                  kind === "treg"
                    ? t`Treg token`
                    : kind === "executor"
                      ? t`Executor token`
                      : t`Credential`
                }
                placeholder={
                  kind === "treg"
                    ? t`Treg token`
                    : kind === "executor"
                      ? t`Executor token`
                      : t`Credential`
                }
              />
            ) : null}
            <p className="text-xs leading-5 text-muted-foreground">
              <Trans>Credentials are encrypted and never sent to the model.</Trans>
            </p>
            {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending === "install-source"}>
                {pending === "install-source" ? (
                  <Trans>Verifying…</Trans>
                ) : (
                  <Trans>Verify and add</Trans>
                )}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setKind(null)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      {feedEnabled ? (
        <section data-testid="integrations-catalog-feed" className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">
            <Trans>Search by domain</Trans>
          </h3>
          <form
            className="flex max-w-md gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void searchFeed();
            }}
          >
            <Input
              value={feedQuery}
              disabled={feedPending}
              onChange={(event) => {
                setFeedQuery(event.target.value);
                setFeedResults([]);
                setFeedError(null);
                setFeedSearched(false);
              }}
              placeholder="github.com"
              aria-label={t`Integration domain`}
            />
            <Button
              type="submit"
              variant="outline"
              size="default"
              disabled={!feedQuery.trim() || feedPending}
            >
              {feedPending ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
            </Button>
          </form>
          {feedError ? <p className="text-sm text-destructive">{feedError}</p> : null}
          {feedSearched && !feedPending && feedResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No results</Trans>
            </p>
          ) : null}
          {feedResults.length ? (
            <ul className="divide-y divide-border border-y border-border">
              {feedResults.map((result) => (
                <li
                  key={`${result.domain}:${result.name}:${result.pageUrl ?? ""}`}
                  className="space-y-2 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {result.pageUrl ? (
                        <a
                          href={result.pageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline-offset-4 hover:underline"
                        >
                          {result.name}
                        </a>
                      ) : (
                        result.name
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{result.domain}</p>
                  </div>
                  {result.description ? (
                    <p className="text-sm leading-5 text-muted-foreground">{result.description}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {result.surfaces.map((surface) => {
                      const canAdd =
                        Boolean(surface.source) &&
                        (surface.kind === "mcp" || surface.kind === "openapi");
                      return (
                        <Button
                          key={`${result.domain}:${surface.slug}`}
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!canAdd}
                          title={canAdd ? undefined : t`Manual setup required`}
                          onClick={() => beginCatalogSurface(result, surface)}
                        >
                          {surface.kind.toUpperCase()} · {canAdd ? t`Add` : t`Manual`}
                        </Button>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {onOpenMcp || onNavigate ? (
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {onOpenMcp ? (
            <Button variant="link" size="sm" className="px-0" onClick={onOpenMcp}>
              <Trans>Manage MCP servers</Trans>
            </Button>
          ) : null}
          {onNavigate ? (
            <Button
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => onNavigate("/integrations/setup?mode=mcp")}
            >
              <Trans>Browse MCP servers</Trans>
            </Button>
          ) : null}
          {onNavigate && canConfigure ? (
            <Button
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => onNavigate("/integrations/setup")}
            >
              <Trans>Server providers</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
