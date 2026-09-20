import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../../lib/rpc";

export function GatewaySettings() {
  const fieldId = useId();
  const { t } = useLingui();
  const [values, setValues] = useState({
    endpoint: "",
    apiKey: "",
    projectId: "",
    callbackOrigin: "",
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  return (
    <details className="space-y-3 text-sm">
      <summary className="cursor-pointer">
        <Trans>Host a webhook gateway</Trans>
      </summary>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setStatus(null);
          void rpc.integrationSetup
            .gatewayConfigure(values)
            .then(() => {
              setValues({ ...values, apiKey: "" });
              setStatus(t`Saved`);
            })
            .catch(() => setStatus(t`Could not save relay settings`))
            .finally(() => setBusy(false));
        }}
      >
        {(
          [
            ["endpoint", t`Convoy URL`, "url"],
            ["apiKey", t`Project API key`, "password"],
            ["projectId", t`Project ID`, "text"],
            ["callbackOrigin", t`Public Deskazo API origin`, "url"],
          ] as const
        ).map(([key, label, type]) => (
          <label key={key} htmlFor={`${fieldId}-${key}`} className="block">
            {label}
            <Input
              id={`${fieldId}-${key}`}
              required
              type={type}
              value={values[key]}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setValues({ ...values, [key]: event.target.value })}
            />
          </label>
        ))}
        <Button disabled={busy} type="submit">
          <Trans>Save relay</Trans>
        </Button>
        {status ? <p role="status">{status}</p> : null}
      </form>
      <a href="/integrations/setup?mode=runtime" className="block underline">
        <Trans>Runtime keys</Trans>
      </a>
    </details>
  );
}
