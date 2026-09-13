import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Connection } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export function ConnectionIncomingSetup({
  connection,
  activeBotId,
  onChange,
}: {
  connection: Connection;
  activeBotId?: string;
  onChange: (connection: Connection) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState(connection.incoming?.botId ?? activeBotId ?? "");
  const [origin, setOrigin] = useState(
    connection.incoming ? new URL(connection.incoming.webhookUrl).origin : "",
  );
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || connection.canManage === false) return;
    let active = true;
    void rpc.bots
      .list()
      .then((rows) => {
        if (active) setBots(rows);
      })
      .catch(() => {
        if (active) setError(t`Could not load bots. Close and reopen these settings to retry.`);
      });
    return () => {
      active = false;
    };
  }, [open, connection.canManage, t]);
  async function save() {
    setPending(true);
    setError(null);
    try {
      const incoming = await rpc.connections.incoming.save({
        connectionId: connection.id,
        botId,
        webhookOrigin: origin.trim(),
        ...(secret.trim() ? { channelSecret: secret.trim() } : {}),
      });
      setSecret("");
      onChange({ ...connection, incoming });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not save automatic replies.`);
    } finally {
      setPending(false);
    }
  }
  async function disable() {
    setPending(true);
    setError(null);
    try {
      await rpc.connections.incoming.disable({ connectionId: connection.id });
      onChange({ ...connection, incoming: undefined });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not disable automatic replies.`);
    } finally {
      setPending(false);
    }
  }
  const prefix = `incoming-${connection.id}`;
  return (
    <div className="min-w-0 border-t pt-3">
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Trans>Automatic replies</Trans>
        {connection.incoming ? (
          <span className="text-muted-foreground">
            <Trans>On</Trans>
          </span>
        ) : null}
      </Button>
      {open ? (
        <div className="mt-3 space-y-3">
          {connection.canManage !== false ? (
            <>
              <label className="block space-y-1 text-sm" htmlFor={`${prefix}-bot`}>
                <span>
                  <Trans>Reply with</Trans>
                </span>
                <NativeSelect
                  id={`${prefix}-bot`}
                  value={botId}
                  disabled={pending || Boolean(connection.incoming)}
                  onChange={(event) => setBotId(event.target.value)}
                >
                  <NativeSelectOption value="">{t`Select a bot`}</NativeSelectOption>
                  {bots.map((bot) => (
                    <NativeSelectOption key={bot.id} value={bot.id}>
                      {bot.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className="block space-y-1 text-sm" htmlFor={`${prefix}-origin`}>
                <span>
                  <Trans>Public HTTPS origin</Trans>
                </span>
                <Input
                  id={`${prefix}-origin`}
                  type="url"
                  placeholder="https://example.com"
                  value={origin}
                  disabled={pending}
                  onChange={(event) => setOrigin(event.target.value)}
                />
              </label>
              <label className="block space-y-1 text-sm" htmlFor={`${prefix}-secret`}>
                <span>
                  <Trans>Channel secret</Trans>
                </span>
                <Input
                  id={`${prefix}-secret`}
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  disabled={pending}
                  placeholder={connection.incoming ? t`Saved. Leave blank to keep it.` : undefined}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={
                    pending || !botId || !origin.trim() || (!connection.incoming && !secret.trim())
                  }
                  onClick={() => void save()}
                >
                  {pending ? (
                    <Trans>Saving…</Trans>
                  ) : connection.incoming ? (
                    <Trans>Save</Trans>
                  ) : (
                    <Trans>Enable replies</Trans>
                  )}
                </Button>
                {connection.incoming ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void disable()}
                  >
                    <Trans>Disable replies</Trans>
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Trans>The account owner manages automatic replies.</Trans>
            </p>
          )}
          {connection.incoming ? (
            <label className="block space-y-1 text-sm" htmlFor={`${prefix}-url`}>
              <span>
                <Trans>Webhook URL</Trans>
              </span>
              <Input
                id={`${prefix}-url`}
                readOnly
                value={connection.incoming.webhookUrl}
                onFocus={(event) => event.target.select()}
              />
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
