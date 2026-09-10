import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAsyncAction } from "@rakazo/chat-ui/async-state";
import type {
  Bot,
  CustomerChannel,
  CustomerProvider,
  CustomerProviderDefinition,
} from "@rakazo/contracts";
import { Button, Input, Label, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function CustomerChannelsPanel() {
  const [channels, setChannels] = useState<CustomerChannel[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<CustomerProviderDefinition[]>([]);
  const [provider, setProvider] = useState<CustomerProvider>("line");
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [botId, setBotId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const { busy, error, act } = useAsyncAction(refresh);
  async function refresh() {
    const [next, catalog, agents] = await Promise.all([
      rpc.customers.channels(),
      rpc.customers.providers(),
      rpc.bots.list(),
    ]);
    setChannels(next);
    setDefinitions(catalog);
    setBots(agents.filter((bot) => !bot.archivedAt));
  }
  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      await refresh();
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const definition = definitions.find((item) => item.id === provider);
  async function connect() {
    await act(async () => {
      const channel = await rpc.customers.connect({
        provider,
        name,
        accountId,
        botId: botId || bots[0]?.id || "",
        instructions,
        credentials,
      });
      setExpandedId(channel.id);
      setCredentials({});
      setAdding(false);
      setInstructions("");
      setName("");
      setAccountId("");
    });
  }
  if (loading)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  if (loadError)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not load channels</Trans>
        </p>
        <Button variant="outline" onClick={() => void load()}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  return (
    <div className="w-full max-w-2xl space-y-6">
      {channels.map((channel) => (
        <details
          key={channel.id}
          open={expandedId === channel.id}
          onToggle={(event) => {
            if (event.currentTarget.open) setExpandedId(channel.id);
            else setExpandedId((current) => (current === channel.id ? null : current));
          }}
          className="group border-b border-border pb-4"
        >
          <summary className="cursor-pointer rounded-md py-2 text-sm font-medium focus-visible:outline-ring">
            <span className="ml-2 inline-flex max-w-[85%] flex-col align-middle">
              <span className="break-words">{channel.name}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {definitions.find((item) => item.id === channel.provider)?.name ?? channel.provider}
                {" · "}
                {bots.find((bot) => bot.id === channel.botId)?.name ?? (
                  <Trans>Agent unavailable</Trans>
                )}
                {" · "}
                {channel.enabled ? <Trans>Connected</Trans> : <Trans>Not connected</Trans>}
              </span>
            </span>
          </summary>
          <div className="space-y-3 pt-3">
            <Label className="block space-y-1 text-xs text-muted-foreground">
              <span>
                <Trans>Webhook URL</Trans>
              </span>
              <Input
                readOnly
                value={channel.webhookUrl ?? channel.webhookPath}
                onFocus={(event) => event.target.select()}
              />
            </Label>
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <a
                href={definitions.find((item) => item.id === channel.provider)?.setupUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                <Trans>Setup guide</Trans>
              </a>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    rpc.customers.setChannelEnabled({ id: channel.id, enabled: !channel.enabled }),
                  )
                }
              >
                {channel.enabled ? <Trans>Disconnect</Trans> : <Trans>Reconnect</Trans>}
              </Button>
            </div>
          </div>
        </details>
      ))}
      {!channels.length && !adding ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No channels connected</Trans>
        </p>
      ) : null}
      {adding ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <Label className="block space-y-1 text-sm">
            <span>
              <Trans>Channel</Trans>
            </span>
            <NativeSelect
              aria-label={t`Channel`}
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as CustomerProvider);
                setCredentials({});
                setAccountId("");
              }}
              className="w-full"
            >
              {definitions.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <Label className="block space-y-1 text-sm">
            <span>
              <Trans>Name</Trans>
            </span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
            />
          </Label>
          <Label className="block space-y-1 text-sm">
            <span>{definition?.accountLabel}</span>
            <Input
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              required
              autoComplete="off"
            />
          </Label>
          <Label className="block space-y-1 text-sm">
            <span>
              <Trans>Agent</Trans>
            </span>
            <NativeSelect
              aria-label={t`Agent`}
              value={botId || bots[0]?.id || ""}
              onChange={(event) => setBotId(event.target.value)}
              className="w-full"
            >
              {bots.map((bot) => (
                <NativeSelectOption key={bot.id} value={bot.id}>
                  {bot.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <Label className="block space-y-1 text-sm">
            <span>
              <Trans>Customer instructions</Trans>
            </span>
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={12000}
            />
          </Label>
          {definition?.fields.map((field) => (
            <Label key={field.key} className="block space-y-1 text-sm">
              <span>{field.label}</span>
              <Input
                type={field.secret ? "password" : "text"}
                value={credentials[field.key] ?? ""}
                onChange={(event) =>
                  setCredentials((current) => ({ ...current, [field.key]: event.target.value }))
                }
                required
                autoComplete="off"
              />
            </Label>
          ))}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !bots.length}>
              {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setCredentials({});
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <Button
          disabled={busy || !bots.length || !definitions.length}
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden="true" />
          <Trans>Connect channel</Trans>
        </Button>
      )}
      {!bots.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Create an agent to connect a channel</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not save channel settings</Trans>
        </p>
      ) : null}
    </div>
  );
}
