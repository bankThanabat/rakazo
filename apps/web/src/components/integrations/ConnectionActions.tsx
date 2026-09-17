import { Trans, useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionAction } from "@rakazo/contracts";
import { connectorActionLabel } from "@rakazo/core";
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
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTrigger,
  Switch,
} from "@rakazo/ui-web";
import { CircleHelp, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { ActionList, ActionsSection } from "./ActionList";

export function ConnectionActions({ accounts }: { accounts: Connection[] }) {
  const { t } = useLingui();
  const [selected, setSelected] = useState(accounts[0]?.id ?? "");
  const account = accounts.find((row) => row.id === selected) ?? accounts[0];
  const connectionId = account?.id;
  const [actions, setActions] = useState<ConnectionAction[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmDefaults, setConfirmDefaults] = useState(false);
  const sharedDefaults = actions?.filter((action) => !action.defaultInternal) ?? [];
  useEffect(() => {
    if (!connectionId) return;
    let current = true;
    setActions(null);
    setError(null);
    void rpc.connections
      .actions({ connectionId })
      .then((rows) => {
        if (current) setActions(rows);
      })
      .catch(() => {
        if (current) setError(t`Could not load actions.`);
      });
    return () => {
      current = false;
    };
  }, [connectionId, revision]);

  async function configure(change?: { action: string; internal: boolean }) {
    if (!connectionId || pending || account?.canManage === false) return;
    setPending(true);
    setError(null);
    try {
      if (change) await rpc.connections.configureAction({ connectionId, ...change });
      else await rpc.connections.applyActionDefaults({ connectionId });
      setRevision((value) => value + 1);
    } catch {
      setError(t`Could not save action settings. Try again.`);
    } finally {
      setPending(false);
    }
  }
  if (!account) return null;
  return (
    <ActionsSection
      action={
        account.canManage !== false ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Reset to default`}
            title={t`Reset to default`}
            disabled={pending || !actions?.length}
            onClick={() => setConfirmDefaults(true)}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : null
      }
    >
      <div className="space-y-3">
        {accounts.length > 1 ? (
          <NativeSelect
            aria-label={t`Account`}
            value={connectionId}
            disabled={pending}
            onChange={(event) => setSelected(event.target.value)}
          >
            {accounts.map((row) => (
              <NativeSelectOption key={row.id} value={row.id}>
                {row.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {error ? (
          <div className="flex items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        {actions || !error ? (
          <ActionList
            actions={actions}
            controlHeading={
              <Popover>
                <PopoverTrigger
                  aria-label={t`What is Internal?`}
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-w-16 gap-1 px-1 text-xs text-muted-foreground"
                    />
                  }
                >
                  <span>
                    <Trans>Internal</Trans>
                  </span>
                  <CircleHelp aria-hidden="true" className="size-3.5" />
                </PopoverTrigger>
                <PopoverContent align="end" aria-label={t`What is Internal?`}>
                  <PopoverDescription>
                    <Trans>
                      Internal is for staff only. Turn it off to also allow customer agents.
                    </Trans>
                  </PopoverDescription>
                </PopoverContent>
              </Popover>
            }
            control={(action, label) => (
              <div className="flex min-h-9 min-w-16 shrink-0 items-center justify-center">
                <Switch
                  aria-label={t`Internal: ${label}`}
                  checked={action.internal}
                  disabled={pending || account.canManage === false}
                  onCheckedChange={(internal) => void configure({ action: action.name, internal })}
                />
              </div>
            )}
          />
        ) : null}
      </div>
      <AlertDialog open={confirmDefaults} onOpenChange={setConfirmDefaults}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Reset to default</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {sharedDefaults.length ? (
                <Trans>
                  Customer agents will have access to these actions. All other actions will be
                  internal.
                </Trans>
              ) : (
                <Trans>All actions will be internal.</Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {sharedDefaults.length ? (
            <ul className="max-h-60 overflow-y-auto text-sm">
              {sharedDefaults.map((action) => (
                <li key={action.name}>{connectorActionLabel(action.name)}</li>
              ))}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDefaults(false);
                void configure();
              }}
            >
              <Trans>Reset to default</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ActionsSection>
  );
}
