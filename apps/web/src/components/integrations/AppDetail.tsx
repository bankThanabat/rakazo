import { Trans, useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem, ConnectorSetup } from "@rakazo/contracts";
import { humanizeToolName, waitForConnectionAuthorization } from "@rakazo/core";
import {
  Button,
  cn,
  Input,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Switch,
} from "@rakazo/ui-web";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { AppIcon } from "./AppIcon";
import { OpenConnectorFields } from "./OpenConnectorFields";

/** Only OpenConnector exposes a setup contract (credential forms, reconnect, cancel). Other connectors authorize in a popup. */
const SETUP_CONNECTOR = "open-connector";

type Tool = { name: string; description: string };

function nextAccountLabel(name: string, existing: number) {
  return existing ? `${name} ${existing + 1}` : name;
}

function defaultScopes(setup: ConnectorSetup, type: string) {
  return (
    setup.methods
      .find((entry) => entry.type === type)
      ?.authorizationOptions?.filter((option) => option.required || option.defaultSelected)
      .map((option) => option.id) ?? []
  );
}

export function AppDetail({
  item,
  accounts,
  canConfigure,
  activeBotId,
  onRefresh,
  onBack,
}: {
  item: ConnectionCatalogItem;
  /** Accounts for this app that are not revoked. */
  accounts: Connection[];
  canConfigure: boolean;
  activeBotId?: string;
  onRefresh: () => Promise<unknown>;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const managedSetup = item.connectorId === SETUP_CONNECTOR;
  const [setup, setSetup] = useState<ConnectorSetup | null>(null);
  const [method, setMethod] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [oauthValues, setOauthValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [form, setForm] = useState(false);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ id: string; url: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [copiedWebhook, setCopiedWebhook] = useState<string | null>(null);
  const [incomingValues, setIncomingValues] = useState<Record<string, string>>({});
  /** Per-account incoming-message drafts. They survive a failed enable so nothing is retyped. */
  const [incomingDrafts, setIncomingDrafts] = useState<
    Record<string, { botId?: string; secrets: Record<string, string> }>
  >({});
  const [savingReplies, setSavingReplies] = useState<string | null>(null);
  const [enabling, setEnabling] = useState<string | null>(null);
  const [bots, setBots] = useState<Array<{ id: string; name: string }> | null>(null);
  const botsRequested = useRef(false);
  const [botId, setBotId] = useState("");
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  /** Incoming-message secrets entered in the connect form, applied once the account is connected. */
  const incomingDraft = useRef<{ botId: string; secrets: Record<string, string> } | null>(null);
  const auth = setup?.methods.find((entry) => entry.type === method);
  const incomingFields = reconnecting ? [] : (setup?.incomingSecrets ?? []);
  const unavailable = item.availability === "unavailable";
  const connected = accounts.some((row) => row.status === "connected");
  const awaitingIncoming = accounts.filter(
    (row) =>
      row.status === "connected" &&
      row.incomingSecrets?.length &&
      !row.webhookUrl &&
      row.canManage !== false,
  );

  useEffect(() => {
    if (managedSetup) void loadSetup();
    const pendingAccount = accounts.find(
      (row) => row.status === "pending" && row.canManage !== false,
    );
    if (pendingAccount) void poll(pendingAccount.id, pendingAccount.authorizationUrl ?? "");
    return () => controller.current?.abort();
  }, []);

  useEffect(() => {
    if (awaitingIncoming.length || accounts.some((row) => row.webhookUrl)) ensureBots();
  }, [awaitingIncoming.length, accounts.some((row) => row.webhookUrl)]);

  function ensureBots() {
    if (botsRequested.current) return;
    botsRequested.current = true;
    void rpc.bots
      .list()
      .then((rows) => {
        setBots(rows);
        setBotId(rows.find((bot) => bot.id === activeBotId)?.id ?? rows[0]?.id ?? "");
      })
      .catch(() => {
        botsRequested.current = false;
        setError(t`Could not load assistants. Try again.`);
      });
  }

  async function loadSetup() {
    setError(null);
    try {
      const result = await rpc.connections.setup({
        connectorId: item.connectorId,
        provider: item.slug,
      });
      setSetup(result);
      selectMethod(result, result.methods[0]?.type ?? "");
      // First connection: go straight to the fields instead of asking for a click first.
      if (!accounts.length && !unavailable) openForm(null, result);
    } catch {
      setError(t`Could not load connection setup. Try again.`);
    }
  }

  function selectMethod(result: ConnectorSetup, type: string) {
    setMethod(type);
    setValues({});
    setScopes(defaultScopes(result, type));
  }

  function openForm(reconnectId: string | null, current = setup) {
    setRemoving(null);
    setReconnecting(reconnectId);
    setValues({});
    setLabel(nextAccountLabel(item.name, accounts.length));
    setForm(true);
    if (!reconnectId && current?.incomingSecrets?.length) ensureBots();
  }

  function closeForm() {
    setForm(false);
    setReconnecting(null);
    setValues({});
    setOauthValues({});
    setIncomingValues({});
  }

  async function finishConnected(connectionId: string) {
    closeForm();
    if (activeBotId) {
      void rpc.onboarding
        .appConnected({ botId: activeBotId, provider: item.slug, connectorId: item.connectorId })
        .catch(() => undefined);
    }
    const incoming = incomingDraft.current;
    incomingDraft.current = null;
    if (incoming) await enableIncoming({ connectionId, ...incoming });
    await onRefresh().catch(() => setError(t`Could not refresh accounts. Try again.`));
  }

  /** Enables incoming messages. A failure keeps the entered values in the account row for a retry. */
  async function enableIncoming(draft: {
    connectionId: string;
    botId: string;
    secrets: Record<string, string>;
  }) {
    setEnabling(draft.connectionId);
    setError(null);
    try {
      await rpc.connections.setupIncoming(draft);
      setIncomingDrafts(({ [draft.connectionId]: _done, ...rest }) => rest);
      return true;
    } catch (cause) {
      setIncomingDrafts((current) => ({
        ...current,
        [draft.connectionId]: { botId: draft.botId, secrets: draft.secrets },
      }));
      setError(cause instanceof Error ? cause.message : t`Could not enable incoming messages.`);
      return false;
    } finally {
      setEnabling(null);
    }
  }

  async function toggleIncoming(row: Connection) {
    const draft = incomingDrafts[row.id];
    const target = draft?.botId ?? botId;
    if (!target) {
      setError(t`Create an assistant first.`);
      return;
    }
    const ok = await enableIncoming({
      connectionId: row.id,
      botId: target,
      secrets: draft?.secrets ?? {},
    });
    if (ok) await onRefresh().catch(() => undefined);
  }

  async function configureReplies(row: Connection, enabled: boolean, assignedBotId?: string) {
    setSavingReplies(row.id);
    setError(null);
    try {
      await rpc.connections.configureReplies({
        connectionId: row.id,
        enabled,
        botId: assignedBotId,
      });
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save auto replies.`);
    } finally {
      setSavingReplies(null);
    }
  }

  function updateDraft(id: string, patch: { botId?: string; secret?: [string, string] }) {
    setIncomingDrafts((current) => {
      const draft = current[id] ?? { secrets: {} };
      return {
        ...current,
        [id]: {
          botId: patch.botId ?? draft.botId,
          secrets: patch.secret
            ? { ...draft.secrets, [patch.secret[0]]: patch.secret[1] }
            : draft.secrets,
        },
      };
    });
  }

  function submitIncoming(row: Connection) {
    if (incomingReady(row) && !enabling) void toggleIncoming(row);
  }

  function incomingReady(row: Connection) {
    return (row.incomingSecrets ?? []).every(
      (secret) => secret.saved || incomingDrafts[row.id]?.secrets[secret.key]?.trim(),
    );
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
      await finishConnected(id);
    } else {
      setError(
        result.status === "pending"
          ? t`Authorization is still pending. Check again or cancel.`
          : (result.message ?? t`Authorization failed.`),
      );
    }
  }

  async function connect(reconnectId = reconnecting) {
    setPending(true);
    setError(null);
    try {
      const authInput =
        managedSetup && auth
          ? { type: auth.type, values, authorizationOptionIds: scopes }
          : undefined;
      incomingDraft.current =
        !reconnectId && incomingFields.length ? { botId, secrets: incomingValues } : null;
      const result =
        reconnectId && authInput
          ? {
              ...(await rpc.connections.reconnect({ connectionId: reconnectId, auth: authInput })),
              connectionId: reconnectId,
            }
          : await rpc.connections.begin({
              connectorId: item.connectorId,
              provider: item.slug,
              displayName: form
                ? label.trim() || item.name
                : nextAccountLabel(item.name, accounts.length),
              ...(authInput ? { auth: authInput } : {}),
            });
      setValues({});
      if (result.authorizationUrl) {
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
        await onRefresh();
        void poll(result.connectionId, result.authorizationUrl);
      } else if (managedSetup || item.noAuth) {
        setPending(false);
        await finishConnected(result.connectionId);
      } else {
        void poll(result.connectionId, "");
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
    incomingDraft.current = null;
    setPending(true);
    setError(null);
    try {
      await rpc.connections.cancel({ connectionId: attempt.id });
      setAttempt(null);
      closeForm();
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

  function rename(row: Connection, value: string) {
    const displayName = value.trim();
    if (row.canManage === false || !displayName || displayName === row.displayName) return;
    void rpc.connections
      .rename({ connectionId: row.id, displayName })
      .then(onRefresh)
      .catch(() => setError(t`Could not rename the account.`));
  }

  async function saveOAuth() {
    setPending(true);
    setError(null);
    try {
      await rpc.connections.configureOAuth({
        connectorId: item.connectorId,
        provider: item.slug,
        values: oauthValues,
      });
      setOauthValues({});
      setSetup(await rpc.connections.setup({ connectorId: item.connectorId, provider: item.slug }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save OAuth setup.`);
    } finally {
      setPending(false);
    }
  }

  function loadTools() {
    if (tools) return;
    void rpc.connections
      .tools({ connectorId: item.connectorId, provider: item.slug })
      .then(setTools)
      .catch(() => setError(t`Could not load actions.`));
  }

  function accountStatus(row: Connection) {
    if (row.reconnectRequired) return t`Reconnect required`;
    if (row.status === "error") return t`Needs attention`;
    if (row.status === "pending") return t`Pending`;
    return null;
  }

  const needsAdmin = auth?.type === "oauth2" && setup && !setup.oauthConfigured;
  // Reconnecting re-submits credentials; only OAuth can do that without retyping a secret.
  const canReconnect = managedSetup && (setup?.methods.some((m) => m.type === "oauth2") ?? false);
  const quickReconnect =
    setup?.methods.length === 1 && auth?.type === "oauth2" && !auth.fields.length && !needsAdmin;
  const reconnectTarget = accounts.find((row) => row.id === reconnecting);
  const formReady =
    (reconnecting || !accounts.length || Boolean(label.trim())) &&
    (auth?.fields ?? []).every((field) => !field.required || values[field.key]?.trim()) &&
    incomingFields.every((secret) => incomingValues[secret.key]?.trim()) &&
    (!incomingFields.length || Boolean(botId));
  const visibleTools =
    tools?.filter((tool) =>
      `${tool.name} ${tool.description}`.toLowerCase().includes(toolQuery.toLowerCase()),
    ) ?? [];

  return (
    <div data-testid="connection-detail" className="space-y-6 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ms-1.5 mt-1.5 sm:hidden"
          aria-label={t`Back to apps`}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <AppIcon item={item} className="size-10 rounded-xl" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">{item.name}</h2>
          {item.description ? (
            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
          ) : null}
        </div>
        {unavailable ? null : managedSetup && !setup && !error ? (
          <Skeleton className="mt-0.5 h-8 w-24 shrink-0" />
        ) : !form && !attempt && (!managedSetup || setup) ? (
          <Button
            className="mt-0.5 shrink-0"
            disabled={pending}
            onClick={() => (managedSetup ? openForm(null) : void connect())}
          >
            {pending ? (
              <Trans>Connecting…</Trans>
            ) : accounts.length ? (
              <Trans>Add account</Trans>
            ) : (
              <Trans>Connect</Trans>
            )}
          </Button>
        ) : null}
      </div>

      {accounts.length ? (
        <ul className="divide-y divide-border border-y border-border">
          {accounts.map((row) => {
            const status = accountStatus(row);
            return (
              <li key={row.id} className="space-y-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={t`Account label`}
                    defaultValue={row.displayName}
                    readOnly={row.canManage === false}
                    className={cn(
                      "h-8 min-w-0 flex-1 basis-32 border-transparent bg-transparent px-1.5 text-sm font-medium dark:bg-transparent",
                      row.canManage !== false && "hover:border-input focus-visible:border-ring",
                    )}
                    onBlur={(event) => rename(row, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  {status ? (
                    <span
                      className={cn(
                        "text-xs",
                        row.status === "pending" ? "text-muted-foreground" : "text-warning",
                      )}
                    >
                      {status}
                    </span>
                  ) : null}
                  {row.canManage !== false ? (
                    <span className="flex shrink-0 gap-1">
                      {canReconnect || row.reconnectRequired ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending || !setup}
                          onClick={() => (quickReconnect ? void connect(row.id) : openForm(row.id))}
                        >
                          <Trans>Reconnect</Trans>
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          closeForm();
                          setRemoving(row.id);
                        }}
                      >
                        <Trans>Disconnect</Trans>
                      </Button>
                    </span>
                  ) : null}
                </div>
                {row.webhookUrl ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-3 text-sm font-medium">
                        <Switch
                          id={`${formId}-${row.id}-replies`}
                          aria-describedby={`${formId}-${row.id}-replies-help`}
                          checked={row.automaticReplies ?? false}
                          disabled={row.canManage === false || savingReplies !== null}
                          onCheckedChange={(enabled) => void configureReplies(row, enabled)}
                        />
                        <label htmlFor={`${formId}-${row.id}-replies`}>
                          <Trans>Auto reply messages</Trans>
                        </label>
                      </div>
                      <p
                        id={`${formId}-${row.id}-replies-help`}
                        className="text-sm text-muted-foreground"
                      >
                        <Trans>When off, messages still arrive in your inbox.</Trans>
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label
                        htmlFor={`${formId}-${row.id}-staff`}
                        className="block text-sm font-medium"
                      >
                        <Trans>Assign staff</Trans>
                      </label>
                      <NativeSelect
                        id={`${formId}-${row.id}-staff`}
                        value={row.replyBotId ?? ""}
                        disabled={row.canManage === false || savingReplies !== null || !bots}
                        onChange={(event) =>
                          void configureReplies(
                            row,
                            row.automaticReplies ?? false,
                            event.target.value,
                          )
                        }
                      >
                        {row.replyBotId && !bots?.some((bot) => bot.id === row.replyBotId) ? (
                          <NativeSelectOption value={row.replyBotId}>
                            {row.replyBotName}
                          </NativeSelectOption>
                        ) : null}
                        {!row.replyBotId ? (
                          <NativeSelectOption value="">{t`Choose staff`}</NativeSelectOption>
                        ) : null}
                        {bots?.map((bot) => (
                          <NativeSelectOption key={bot.id} value={bot.id}>
                            {bot.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <label
                      htmlFor={`${formId}-${row.id}-webhook`}
                      className="block text-sm font-medium"
                    >
                      <Trans>Webhook URL</Trans>
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`${formId}-${row.id}-webhook`}
                        value={row.webhookUrl}
                        readOnly
                        className="h-8 min-w-0 flex-1"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(row.webhookUrl!);
                            setCopiedWebhook(row.webhookUrl!);
                          } catch {
                            setError(t`Could not copy. Select and copy the URL manually.`);
                          }
                        }}
                      >
                        {copiedWebhook === row.webhookUrl ? (
                          <Trans>Copied</Trans>
                        ) : (
                          <Trans>Copy</Trans>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : row.status === "connected" &&
                  row.incomingSecrets?.length &&
                  row.canManage !== false ? (
                  <div className="flex flex-wrap gap-2">
                    {bots && bots.length > 1 ? (
                      <NativeSelect
                        aria-label={t`Assign staff`}
                        value={incomingDrafts[row.id]?.botId ?? botId}
                        disabled={enabling !== null}
                        onChange={(event) => updateDraft(row.id, { botId: event.target.value })}
                      >
                        {bots.map((bot) => (
                          <NativeSelectOption key={bot.id} value={bot.id}>
                            {bot.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    ) : null}
                    {row.incomingSecrets
                      .filter((secret) => !secret.saved)
                      .map((secret) => (
                        <Input
                          key={secret.key}
                          aria-label={secret.label}
                          placeholder={secret.label}
                          type="password"
                          autoComplete="new-password"
                          value={incomingDrafts[row.id]?.secrets[secret.key] ?? ""}
                          disabled={enabling !== null}
                          className="h-8 basis-56"
                          onChange={(event) =>
                            updateDraft(row.id, { secret: [secret.key, event.target.value] })
                          }
                          onBlur={() => submitIncoming(row)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                        />
                      ))}
                    {row.incomingSecrets.every((secret) => secret.saved) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={enabling !== null}
                        onClick={() => void toggleIncoming(row)}
                      >
                        <Trans>Try again</Trans>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {removing === row.id ? (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span>
                      {item.scope === "team" ? (
                        <Trans>Disconnect this account for everyone in the team?</Trans>
                      ) : (
                        <Trans>Disconnect this account?</Trans>
                      )}
                    </span>
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
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {unavailable ? (
        <p className="text-sm text-muted-foreground">
          <Trans>This app is unavailable on this OpenConnector server.</Trans>
        </p>
      ) : null}

      {form && setup && !attempt ? (
        <form
          noValidate
          className="max-w-md space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (formReady) void connect();
          }}
        >
          {reconnectTarget || accounts.length ? (
            <h3 className="text-sm font-medium text-foreground">
              {reconnectTarget ? (
                <Trans>Reconnect {reconnectTarget.displayName}</Trans>
              ) : (
                <Trans>Add account</Trans>
              )}
            </h3>
          ) : null}
          {setup.methods.length > 1 ? (
            <NativeSelect
              aria-label={t`Authentication method`}
              value={method}
              disabled={pending}
              onChange={(event) => selectMethod(setup, event.target.value)}
            >
              {setup.methods.map((entry) => (
                <NativeSelectOption key={entry.type} value={entry.type}>
                  {entry.type === "oauth2"
                    ? t`OAuth`
                    : entry.type === "api_key"
                      ? t`API key`
                      : entry.type === "custom_credential"
                        ? t`Credentials`
                        : t`No authentication`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {!reconnecting && accounts.length ? (
            <label htmlFor={`${formId}-name`} className="block space-y-1.5 text-sm">
              <span className="font-medium">
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
          {needsAdmin ? (
            <div className="space-y-3">
              <p className="text-sm">
                <Trans>Admin setup required</Trans>
              </p>
              {canConfigure && !setup.oauthManaged ? (
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
                    <label htmlFor={`${formId}-callback`} className="block space-y-1.5 text-sm">
                      <span className="font-medium">
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
                      className="block text-sm underline underline-offset-4"
                      href={setup.oauthSetupUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Trans>OAuth setup instructions</Trans>
                    </a>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>A deployment administrator must configure this app’s OAuth client.</Trans>
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
              {incomingFields.length ? (
                <OpenConnectorFields
                  fields={incomingFields.map((secret) => ({
                    key: secret.key,
                    label: secret.label,
                    inputType: "password" as const,
                    required: true,
                    secret: true,
                  }))}
                  values={incomingValues}
                  onChange={setIncomingValues}
                  disabled={pending}
                />
              ) : null}
              {incomingFields.length && bots && bots.length > 1 ? (
                <label htmlFor={`${formId}-bot`} className="block space-y-1.5 text-sm">
                  <span className="font-medium">
                    <Trans>Assign staff</Trans>
                  </span>
                  <NativeSelect
                    id={`${formId}-bot`}
                    className="w-full"
                    value={botId}
                    disabled={pending}
                    onChange={(event) => setBotId(event.target.value)}
                  >
                    {bots.map((bot) => (
                      <NativeSelectOption key={bot.id} value={bot.id}>
                        {bot.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              ) : null}
              {auth?.authorizationOptions?.map((option) => (
                <label key={option.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-primary"
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
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {needsAdmin ? (
              canConfigure && !setup.oauthManaged ? (
                <Button
                  type="button"
                  disabled={pending || !oauthValues.clientId}
                  onClick={() => void saveOAuth()}
                >
                  <Trans>Save OAuth setup</Trans>
                </Button>
              ) : null
            ) : (
              <Button type="submit" disabled={pending || !auth || !formReady}>
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
            )}
            <Button type="button" variant="ghost" disabled={pending} onClick={closeForm}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
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
            <Button variant="outline" size="sm" onClick={() => void poll(attempt.id, attempt.url)}>
              <Trans>Check again</Trans>
            </Button>
            {managedSetup ? (
              <Button variant="ghost" size="sm" onClick={() => void cancel()}>
                <Trans>Cancel authorization</Trans>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {managedSetup && !setup ? (
            <Button variant="outline" size="sm" onClick={() => void loadSetup()}>
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}

      {connected ? (
        <details
          className="group"
          onToggle={(event) => {
            if (event.currentTarget.open) loadTools();
          }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
            />
            <span>
              <Trans>Available actions</Trans>
            </span>
          </summary>
          <div className="mt-3 space-y-3">
            {tools && tools.length > 10 ? (
              <Input
                aria-label={t`Search actions`}
                placeholder={t`Search actions`}
                value={toolQuery}
                onChange={(event) => setToolQuery(event.target.value)}
                className="h-8"
              />
            ) : null}
            {!tools ? (
              <Skeleton className="h-10" />
            ) : tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No actions available.</Trans>
              </p>
            ) : (
              <ul className="rk-scroll max-h-64 divide-y divide-border overflow-y-auto">
                {visibleTools.map((tool) => (
                  <li key={tool.name} className="py-2">
                    <p className="break-words text-sm font-medium text-foreground">
                      {humanizeToolName(tool.name)}
                    </p>
                    {tool.description ? (
                      <p className="text-sm text-muted-foreground">{tool.description}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}
