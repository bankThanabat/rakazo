import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem, ConnectorSetup } from "@rakazo/contracts";
import { CONNECTION_CATALOG_PAGE_SIZE, waitForConnectionAuthorization } from "@rakazo/core";
import { Button, Input, NativeSelect, NativeSelectOption, Skeleton } from "@rakazo/ui-web";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { OpenConnectorFields } from "./OpenConnectorFields";

export function OpenConnectorCatalog({
  connections,
  onRefresh,
  onSetup,
}: {
  connections: Connection[];
  onRefresh: () => Promise<unknown>;
  onSetup: () => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [failedIcons, setFailedIcons] = useState(() => new Set<string>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [count, setCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [selected, setSelected] = useState<ConnectionCatalogItem | null>(null);
  const [setup, setSetup] = useState<ConnectorSetup | null>(null);
  const [method, setMethod] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ id: string; url: string } | null>(null);
  const [form, setForm] = useState(false);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [canConfigure, setCanConfigure] = useState(false);
  const [oauthValues, setOauthValues] = useState<Record<string, string>>({});
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);
  const [toolQuery, setToolQuery] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const accounts = connections.filter(
    (row) => row.connectorId === "open-connector" && row.status !== "revoked",
  );
  const selectedAccounts = accounts.filter((row) => row.provider === selected?.slug);
  const auth = setup?.methods.find((item) => item.type === method);
  useEffect(() => () => controller.current?.abort(), []);
  async function browse() {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const [items, settings] = await Promise.all([
        rpc.connections.catalog({ connectorId: "open-connector" }),
        rpc.integrationSetup.get(),
      ]);
      setCatalog(items);
      setCanConfigure(settings.canConfigure);
      await onRefresh();
      return items;
    } catch {
      setError(t`OpenConnector is unavailable. Try again.`);
    } finally {
      setLoading(false);
    }
  }
  async function detail(item: ConnectionCatalogItem) {
    controller.current?.abort();
    setAttempt(null);
    setPending(false);
    setSelected(item);
    setSetup(null);
    setValues({});
    setOauthValues({});
    setError(null);
    setTools([]);
    setForm(false);
    setReconnecting(null);
    setLabel(item.name);
    const current = new AbortController();
    controller.current = current;
    try {
      const [result, settings] = await Promise.all([
        rpc.connections.setup({ connectorId: "open-connector", provider: item.slug }),
        rpc.integrationSetup.get(),
      ]);
      if (current.signal.aborted) return;
      setSetup(result);
      setCanConfigure(settings.canConfigure);
      const first = result.methods[0];
      setMethod(first?.type ?? "");
      setScopes(
        first?.authorizationOptions
          ?.filter((option) => option.required || option.defaultSelected)
          .map((option) => option.id) ?? [],
      );
      const pendingAccount = accounts.find(
        (row) => row.provider === item.slug && row.status === "pending" && row.canManage !== false,
      );
      if (pendingAccount) void poll(pendingAccount.id, pendingAccount.authorizationUrl ?? "");
    } catch {
      if (!current.signal.aborted) setError(t`Could not load connection setup. Try again.`);
    }
  }
  useEffect(() => {
    if (!selected && returnFocus.current) {
      cardRefs.current.get(returnFocus.current)?.focus();
      returnFocus.current = null;
    }
  }, [selected]);
  function back() {
    returnFocus.current = selected?.slug ?? null;
    controller.current?.abort();
    setSelected(null);
    setValues({});
    setOauthValues({});
    setAttempt(null);
    setPending(false);
    setError(null);
  }
  async function poll(id: string, url: string) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setAttempt({ id, url });
    setPending(true);
    setError(null);
    const result = await waitForConnectionAuthorization(
      () => rpc.connections.complete({ connectionId: id }),
      current.signal,
    );
    if (result.status === "cancelled") return;
    setPending(false);
    if (result.status === "connected") {
      setAttempt(null);
      setForm(false);
      await onRefresh().catch(() => {
        if (!current.signal.aborted) setError(t`Could not refresh accounts. Try again.`);
      });
    } else {
      setError(
        result.status === "pending"
          ? t`Authorization is still pending. Check again or cancel.`
          : (result.message ?? t`Authorization failed.`),
      );
    }
  }
  async function connect() {
    if (!selected || !auth) return;
    setPending(true);
    setError(null);
    try {
      const input = { type: auth.type, values, authorizationOptionIds: scopes };
      const result = reconnecting
        ? {
            ...(await rpc.connections.reconnect({ connectionId: reconnecting, auth: input })),
            connectionId: reconnecting,
          }
        : await rpc.connections.begin({
            connectorId: "open-connector",
            provider: selected.slug,
            displayName: label.trim() || selected.name,
            auth: input,
          });
      setValues({});
      await onRefresh();
      if (result.authorizationUrl) {
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
        void poll(result.connectionId, result.authorizationUrl);
      } else {
        setForm(false);
        setReconnecting(null);
        setPending(false);
      }
    } catch (cause) {
      setValues({});
      setPending(false);
      setError(cause instanceof Error ? cause.message : t`Could not connect this account.`);
    }
  }
  async function cancel() {
    if (!attempt) return;
    controller.current?.abort();
    setPending(true);
    setError(null);
    try {
      await rpc.connections.cancel({ connectionId: attempt.id });
      setAttempt(null);
      setForm(false);
      setValues({});
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not cancel authorization.`);
    } finally {
      setPending(false);
    }
  }
  async function remove(id: string) {
    setPending(true);
    setError(null);
    try {
      await rpc.connections.revoke({ connectionId: id });
      controller.current?.abort();
      setAttempt(null);
      setRemoving(null);
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not disconnect the account.`);
    } finally {
      setPending(false);
    }
  }
  async function saveOAuth() {
    if (!selected) return;
    setPending(true);
    setError(null);
    try {
      await rpc.connections.configureOAuth({
        connectorId: "open-connector",
        provider: selected.slug,
        values: oauthValues,
      });
      setOauthValues({});
      setSetup(
        await rpc.connections.setup({ connectorId: "open-connector", provider: selected.slug }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save OAuth setup.`);
    } finally {
      setPending(false);
    }
  }
  function icon(item: ConnectionCatalogItem) {
    return (
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-sm">
        {item.logo && !failedIcons.has(item.logo) ? (
          <img
            src={item.logo}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-6 object-contain"
            onError={() => setFailedIcons((current) => new Set(current).add(item.logo!))}
          />
        ) : (
          item.name.slice(0, 1)
        )}
      </span>
    );
  }
  const visible = catalog.filter(
    (item) =>
      (!connectedOnly ||
        accounts.some((row) => row.provider === item.slug && row.status === "connected")) &&
      (!category || item.categories?.includes(category)) &&
      `${item.name} ${item.description ?? ""} ${item.categories?.join(" ") ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section
      className="mt-6 space-y-4 border-t pt-5"
      aria-label="OpenConnector"
      data-testid="openconnector-catalog"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">OpenConnector</h3>
        {!open ? (
          <Button variant="outline" size="sm" onClick={() => void browse()}>
            <Trans>Browse apps</Trans>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              back();
              setOpen(false);
            }}
          >
            <Trans>Close catalog</Trans>
          </Button>
        )}
      </div>
      {!open && accounts.length ? (
        <div className="divide-y">
          {accounts.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 break-words text-sm">{row.displayName}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void browse().then((items) => {
                    const item = items?.find((entry) => entry.slug === row.provider);
                    if (item) void detail(item);
                  });
                }}
              >
                <Trans>Manage</Trans>
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {open && !selected ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label={t`Search OpenConnector apps`}
              placeholder={t`Search apps…`}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
              className="min-w-0 flex-1"
            />
            <NativeSelect
              aria-label={t`Category`}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
            >
              <NativeSelectOption value="">{t`All categories`}</NativeSelectOption>
              {[...new Set(catalog.flatMap((item) => item.categories ?? []))].sort().map((name) => (
                <NativeSelectOption key={name} value={name}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={connectedOnly ? "ghost" : "secondary"}
              aria-pressed={!connectedOnly}
              onClick={() => {
                setConnectedOnly(false);
                setCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
            >
              <Trans>All</Trans>
            </Button>
            <Button
              size="sm"
              variant={connectedOnly ? "secondary" : "ghost"}
              aria-pressed={connectedOnly}
              onClick={() => {
                setConnectedOnly(true);
                setCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
            >
              <Trans>Connected</Trans>
            </Button>
            <span className="ml-auto self-center text-sm text-muted-foreground" aria-live="polite">
              {visible.length}
            </span>
          </div>
          {loading ? (
            <div role="status" className="grid gap-3 sm:grid-cols-2" aria-label={t`Loading apps`}>
              {[0, 1, 2, 3].map((id) => (
                <Skeleton key={id} className="h-14" />
              ))}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2">
              {visible.slice(0, count).map((item) => {
                const connected = accounts.filter(
                  (row) => row.provider === item.slug && row.status === "connected",
                );
                return (
                  <button
                    type="button"
                    key={item.slug}
                    ref={(node) => {
                      if (node) cardRefs.current.set(item.slug, node);
                      else cardRefs.current.delete(item.slug);
                    }}
                    onClick={() => void detail(item)}
                    className="flex min-w-0 items-center gap-3 rounded-lg p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={`${item.name}, ${accounts.some((row) => row.provider === item.slug) ? t`Manage` : t`Connect`}`}
                  >
                    {icon(item)}
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">{item.name}</span>
                      {connected.length ? (
                        <span className="text-xs text-muted-foreground">
                          <Plural value={connected.length} one="# account" other="# accounts" />
                        </span>
                      ) : item.availability === "unavailable" ? (
                        <span className="text-xs text-muted-foreground">
                          <Trans>Unavailable</Trans>
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          )}
          {!loading && !visible.length && !error ? (
            <div className="space-y-2 py-4 text-sm text-muted-foreground">
              <p>
                {connectedOnly ? (
                  <Trans>No connected apps yet.</Trans>
                ) : (
                  <Trans>No apps match your search.</Trans>
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setCategory("");
                  setConnectedOnly(false);
                }}
              >
                <Trans>Clear filters</Trans>
              </Button>
              {!catalog.length && canConfigure ? (
                <Button variant="outline" size="sm" onClick={onSetup}>
                  <Trans>Set up OpenConnector</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
          {visible.length > count ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCount(count + CONNECTION_CATALOG_PAGE_SIZE)}
            >
              <Trans>Show more</Trans>
            </Button>
          ) : null}
        </>
      ) : null}
      {open && selected ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" aria-label={t`Back to apps`} onClick={back}>
              <ArrowLeft />
            </Button>
            {icon(selected)}
            <h4 className="min-w-0 break-words text-base font-semibold">{selected.name}</h4>
          </div>
          {selected.description ? (
            <p className="max-w-prose text-sm text-muted-foreground">{selected.description}</p>
          ) : null}
          {selectedAccounts.map((row) => (
            <div key={row.id} className="space-y-2 border-b pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={t`Account label`}
                  defaultValue={row.displayName}
                  readOnly={row.canManage === false}
                  className="min-w-0 flex-1 basis-full sm:basis-auto"
                  onBlur={(event) => {
                    const displayName = event.target.value.trim();
                    if (row.canManage !== false && displayName && displayName !== row.displayName)
                      void rpc.connections
                        .rename({ connectionId: row.id, displayName })
                        .then(onRefresh)
                        .catch(() => setError(t`Could not rename the account.`));
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  {row.reconnectRequired
                    ? t`Reconnect required`
                    : row.status === "connected"
                      ? t`Connected`
                      : row.status === "error"
                        ? t`Needs attention`
                        : t`Pending`}
                </span>
                {row.canManage !== false ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setReconnecting(row.id);
                        setForm(true);
                        setValues({});
                      }}
                    >
                      <Trans>Reconnect</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setRemoving(row.id)}
                    >
                      <Trans>Disconnect</Trans>
                    </Button>
                  </>
                ) : null}
              </div>
              {removing === row.id ? (
                <div className="space-y-2 text-sm">
                  <p>
                    <Trans>Disconnect this account for everyone in the team?</Trans>
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => void remove(row.id)}
                    >
                      <Trans>Disconnect account</Trans>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                      <Trans>Cancel</Trans>
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
          {!setup && !error ? <Skeleton className="h-24" /> : null}
          {setup && !form && selected.availability !== "unavailable" ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setReconnecting(null);
                setForm(true);
                setValues({});
              }}
            >
              {selectedAccounts.length ? <Trans>Add account</Trans> : <Trans>Connect</Trans>}
            </Button>
          ) : null}
          {selected.availability === "unavailable" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>This app is unavailable on this OpenConnector server.</Trans>
            </p>
          ) : null}
          {form && setup && !attempt ? (
            <form
              className="max-w-lg space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              {setup.methods.length > 1 ? (
                <NativeSelect
                  aria-label={t`Authentication method`}
                  value={method}
                  disabled={pending}
                  onChange={(event) => {
                    setMethod(event.target.value);
                    setValues({});
                    setScopes(
                      setup.methods
                        .find((item) => item.type === event.target.value)
                        ?.authorizationOptions?.filter(
                          (option) => option.required || option.defaultSelected,
                        )
                        .map((option) => option.id) ?? [],
                    );
                  }}
                >
                  {setup.methods.map((item) => (
                    <NativeSelectOption key={item.type} value={item.type}>
                      {item.type === "oauth2"
                        ? t`OAuth`
                        : item.type === "api_key"
                          ? t`API key`
                          : item.type === "custom_credential"
                            ? t`Credentials`
                            : t`No authentication`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
              {!reconnecting ? (
                <label htmlFor={`${formId}-name`} className="block space-y-1 text-sm">
                  <span>
                    <Trans>Account name</Trans>
                  </span>
                  <Input
                    id={`${formId}-name`}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    disabled={pending}
                    required
                  />
                </label>
              ) : null}
              {auth?.type === "oauth2" && !setup.oauthConfigured ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    <Trans>Admin setup required</Trans>
                  </p>
                  {canConfigure ? (
                    <>
                      <OpenConnectorFields
                        fields={[
                          {
                            key: "clientId",
                            label: t`Client ID`,
                            inputType: "text",
                            required: true,
                            secret: false,
                          },
                          {
                            key: "clientSecret",
                            label: t`Client secret`,
                            inputType: "password",
                            required: false,
                            secret: true,
                          },
                          ...(setup.oauthFields ?? []),
                        ]}
                        values={oauthValues}
                        onChange={setOauthValues}
                        disabled={pending}
                      />
                      {setup.oauthCallbackUrl ? (
                        <label htmlFor={`${formId}-callback`} className="block space-y-1 text-sm">
                          <span>
                            <Trans>OAuth callback URL</Trans>
                          </span>
                          <Input
                            readOnly
                            id={`${formId}-callback`}
                            value={setup.oauthCallbackUrl}
                            onFocus={(event) => event.target.select()}
                          />
                        </label>
                      ) : null}
                      {setup.oauthSetupUrl ? (
                        <a
                          className="text-sm underline"
                          href={setup.oauthSetupUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Trans>OAuth setup instructions</Trans>
                        </a>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        disabled={pending || !oauthValues.clientId}
                        onClick={() => void saveOAuth()}
                      >
                        <Trans>Save OAuth setup</Trans>
                      </Button>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      <Trans>
                        A deployment administrator must configure this app’s OAuth client.
                      </Trans>
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <OpenConnectorFields
                    fields={auth?.fields ?? []}
                    values={values}
                    onChange={setValues}
                    disabled={pending}
                  />
                  {auth?.authorizationOptions?.map((option) => (
                    <label key={option.id} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={scopes.includes(option.id)}
                        disabled={option.required || pending}
                        onChange={(event) =>
                          setScopes((current) =>
                            event.target.checked
                              ? [...current, option.id]
                              : current.filter((id) => id !== option.id),
                          )
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                  <p className="text-sm text-muted-foreground">
                    <Trans>Available to everyone in this team.</Trans>
                  </p>
                  <Button type="submit" size="sm" disabled={pending || !auth}>
                    {pending ? (
                      <Trans>Connecting…</Trans>
                    ) : auth?.type === "oauth2" ? (
                      <Trans>Continue</Trans>
                    ) : auth?.type === "no_auth" ? (
                      <Trans>Enable</Trans>
                    ) : (
                      <Trans>Connect account</Trans>
                    )}
                  </Button>
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setForm(false);
                  setValues({});
                  setOauthValues({});
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            </form>
          ) : null}
          {attempt ? (
            <div className="space-y-3">
              <p className="text-sm" role="status">
                <Trans>Waiting for authorization</Trans>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!attempt.url}
                  onClick={() => window.open(attempt.url, "_blank", "noopener,noreferrer")}
                >
                  <Trans>Open authorization</Trans>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void poll(attempt.id, attempt.url)}
                >
                  <Trans>Check again</Trans>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void cancel()}>
                  <Trans>Cancel authorization</Trans>
                </Button>
              </div>
            </div>
          ) : null}
          {selectedAccounts.some((row) => row.status === "connected") ? (
            <details
              onToggle={(event) => {
                if (event.currentTarget.open)
                  void rpc.connections
                    .tools({ connectorId: "open-connector", provider: selected.slug })
                    .then(setTools)
                    .catch(() => setError(t`Could not load actions.`));
              }}
            >
              <summary className="cursor-pointer text-sm">
                <Trans>Available actions</Trans>
              </summary>
              <Input
                className="my-3"
                aria-label={t`Search actions`}
                value={toolQuery}
                onChange={(event) => setToolQuery(event.target.value)}
              />
              <div className="max-h-64 overflow-auto">
                {tools
                  .filter((tool) =>
                    `${tool.name} ${tool.description}`
                      .toLowerCase()
                      .includes(toolQuery.toLowerCase()),
                  )
                  .map((tool) => (
                    <div key={tool.name} className="border-b py-2">
                      <p className="break-words text-sm font-medium">{tool.name}</p>
                      <p className="text-sm text-muted-foreground">{tool.description}</p>
                    </div>
                  ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void (selected ? detail(selected) : browse())}
          >
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
