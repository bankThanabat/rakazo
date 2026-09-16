import { Trans, useLingui } from "@lingui/react/macro";
import type { Connection } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../../lib/rpc";

type Bot = { id: string; name: string };

/** Incoming-message controls for one connected account: enable it, then auto replies and staff. */
export function AccountIncoming({
  row,
  bots,
  defaultBotId,
  onError,
  onRefresh,
}: {
  row: Connection;
  bots: Bot[] | null;
  defaultBotId: string;
  onError: (message: string | null) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const id = useId();
  /** Survives a failed enable so nothing is retyped. */
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [botId, setBotId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const canManage = row.canManage !== false;
  const pendingSecrets = (row.incomingSecrets ?? []).filter((secret) => !secret.saved);
  const ready = pendingSecrets.every((secret) => secrets[secret.key]?.trim());

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    onError(null);
    try {
      await action();
      await onRefresh();
      return true;
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    const target = botId ?? defaultBotId;
    if (!target) {
      onError(t`Create an assistant first.`);
      return;
    }
    const ok = await run(
      () => rpc.connections.setupIncoming({ connectionId: row.id, botId: target, secrets }),
      t`Could not enable incoming messages.`,
    );
    if (ok) setSecrets({});
  }

  function configure(enabled: boolean, assignedBotId?: string) {
    void run(
      () =>
        rpc.connections.configureReplies({ connectionId: row.id, enabled, botId: assignedBotId }),
      t`Could not save auto replies.`,
    );
  }

  if (row.webhookUrl) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-sm font-medium">
          <Switch
            id={`${id}-replies`}
            checked={row.automaticReplies ?? false}
            disabled={!canManage || busy}
            onCheckedChange={(enabled) => configure(enabled)}
          />
          <label htmlFor={`${id}-replies`}>
            <Trans>Auto reply messages</Trans>
          </label>
        </div>
        {canManage ? (
          <div className="space-y-1.5">
            <label htmlFor={`${id}-staff`} className="block text-sm font-medium">
              <Trans>Assign staff</Trans>
            </label>
            <NativeSelect
              id={`${id}-staff`}
              value={row.replyBotId ?? ""}
              disabled={busy || !bots}
              onChange={(event) => configure(row.automaticReplies ?? false, event.target.value)}
            >
              {row.replyBotId && !bots?.some((bot) => bot.id === row.replyBotId) ? (
                <NativeSelectOption value={row.replyBotId}>{row.replyBotName}</NativeSelectOption>
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
        ) : null}
        <label htmlFor={`${id}-webhook`} className="block text-sm font-medium">
          <Trans>Webhook URL</Trans>
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-webhook`}
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
                setCopied(true);
              } catch {
                onError(t`Could not copy. Select and copy the URL manually.`);
              }
            }}
          >
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
        </div>
      </div>
    );
  }

  if (row.status !== "connected" || !row.incomingSecrets?.length || !canManage) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {bots && bots.length > 1 ? (
        <NativeSelect
          aria-label={t`Assign staff`}
          value={botId ?? defaultBotId}
          disabled={busy}
          onChange={(event) => setBotId(event.target.value)}
        >
          {bots.map((bot) => (
            <NativeSelectOption key={bot.id} value={bot.id}>
              {bot.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      {pendingSecrets.map((secret) => (
        <Input
          key={secret.key}
          aria-label={secret.label}
          placeholder={secret.label}
          type="password"
          autoComplete="new-password"
          value={secrets[secret.key] ?? ""}
          disabled={busy}
          className="h-8 basis-56"
          onChange={(event) =>
            setSecrets((current) => ({ ...current, [secret.key]: event.target.value }))
          }
          onBlur={() => {
            if (ready && !busy) void enable();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      ))}
      {pendingSecrets.length === 0 ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void enable()}>
          <Trans>Try again</Trans>
        </Button>
      ) : null}
    </div>
  );
}
