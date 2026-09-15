import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

/** Operator page issuing keys for customer runtimes. Web only: issuing and relay
 * configuration are one-time operator tasks, and the key must be copied into a
 * server's settings, so mobile has no equivalent screen by design. */
export function GatewayRuntimes() {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<Array<{ id: string; name: string; revokedAt: string | null }>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => rpc.integrationSetup.listRuntimes().then(setRows);
  useEffect(() => {
    void refresh().catch(() => setError(t`Could not load runtime keys`));
  }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Could not update runtime keys`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-xl space-y-4 px-6 py-12">
      <h1 className="text-2xl font-medium">
        <Trans>Runtime keys</Trans>
      </h1>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const created = await rpc.integrationSetup.createRuntime({ name });
            setToken(created.token);
            setName("");
          });
        }}
      >
        <Input
          aria-label={t`Runtime name`}
          placeholder={t`Runtime name`}
          value={name}
          required
          maxLength={100}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={busy || !name.trim()}>
          <Trans>Create key</Trans>
        </Button>
      </form>
      {token ? (
        <div className="space-y-2">
          <Input
            type="password"
            aria-label={t`Runtime key (shown once)`}
            value={token}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard
                .writeText(token)
                .catch(() => setError(t`Could not copy. Select the key and copy it manually.`));
            }}
          >
            <Trans>Copy key</Trans>
          </Button>
          <Button variant="ghost" onClick={() => setToken("")}>
            <Trans>Done</Trans>
          </Button>
        </div>
      ) : null}
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-center justify-between gap-3 border-b border-border py-3"
        >
          <span className="truncate">{row.name}</span>
          {row.revokedAt ? (
            <span className="text-sm text-muted-foreground">
              <Trans>Revoked</Trans>
            </span>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => rpc.integrationSetup.revokeRuntime({ id: row.id }))}
            >
              <Trans>Revoke</Trans>
            </Button>
          )}
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
