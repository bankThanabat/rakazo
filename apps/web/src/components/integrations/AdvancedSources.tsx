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
/** Everything that differs per source kind; nothing else switches on it. */
const SOURCES: Record<
  SourceKind,
  {
    /** What the server installs; token-only kinds are MCP servers with a bearer token. */
    kind: "mcp" | "api" | "graphql";
    name: string;
    url?: string;
    placeholder?: string;
    tokenOnly?: boolean;
    config: (auth: { type: AuthType; name?: string }) => Record<string, unknown>;
  }
> = {
  mcp: {
    kind: "mcp",
    name: "Custom connector",
    placeholder: "https://example.com/mcp",
    config: (auth) => ({ preset: "custom", auth }),
  },
  api: {
    kind: "api",
    name: "Custom connector",
    placeholder: "https://example.com/openapi.json",
    config: (auth) => ({ openApi: true, auth }),
  },
  graphql: {
    kind: "graphql",
    name: "GraphQL",
    placeholder: "https://example.com/graphql",
    config: (auth) => ({ auth }),
  },
  executor: {
    kind: "mcp",
    name: "Executor",
    placeholder: "https://executor.example/mcp",
    tokenOnly: true,
    config: () => ({ preset: "custom", auth: { type: "bearer" } }),
  },
  treg: {
    kind: "mcp",
    name: "Treg",
    url: "https://treg.to/mcp/",
    tokenOnly: true,
    config: () => ({ preset: "treg", auth: { type: "bearer" } }),
  },
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
  const source = kind ? SOURCES[kind] : null;
  const tokenOnly = source?.tokenOnly ?? false;
  const labels: Record<SourceKind, string> = {
    mcp: t`Add MCP server`,
    api: t`Add OpenAPI`,
    graphql: t`Add GraphQL`,
    executor: t`Add Executor`,
    treg: t`Add Treg`,
  };
  const tokenLabels: Partial<Record<SourceKind, string>> = {
    treg: t`Treg token`,
    executor: t`Executor token`,
  };

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

  function beginSource(next: SourceKind) {
    const target = SOURCES[next];
    setKind(next);
    setError(null);
    setHint(null);
    setName(target.tokenOnly ? target.name : "");
    setUrl(target.url ?? "");
    setCredential("");
    setAuthType(target.tokenOnly ? "bearer" : "none");
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
    if (!kind || !source) return;
    setError(null);
    setPending("install-source");
    try {
      const auth = { type: authType, ...(authType === "header" ? { name: authName.trim() } : {}) };
      const install = await rpc.capabilities.install({
        kind: source.kind,
        name: name.trim() || source.name,
        source: url.trim(),
        credential: credential.trim() || undefined,
        config: source.config(auth),
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
              {labels[value]}
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
            {source?.url ? null : (
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-label={t`Source URL`}
                placeholder={source?.placeholder}
              />
            )}
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
                aria-label={tokenLabels[kind] ?? t`Credential`}
                placeholder={tokenLabels[kind] ?? t`Credential`}
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
