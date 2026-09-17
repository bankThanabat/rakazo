import { Trans, useLingui } from "@lingui/react/macro";
import { connectorActionLabel, searchConnectorActions } from "@rakazo/core";
import { Input, Skeleton } from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

export function ActionsDisclosure({
  onOpenChange,
  children,
}: {
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details className="group" onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <Trans>Available actions</Trans>
      </summary>
      {children}
    </details>
  );
}

/** `actions` is null while loading. `control` renders each row's trailing controls. */
export function ActionList<T extends { name: string; description: string }>({
  actions,
  control,
}: {
  actions: T[] | null;
  control?: (action: T, label: string) => ReactNode;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  if (!actions) return <Skeleton className="h-10" />;
  if (!actions.length)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>No actions available.</Trans>
      </p>
    );
  return (
    <>
      {actions.length > 10 ? (
        <Input
          aria-label={t`Search actions`}
          placeholder={t`Search actions`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      <ul className="rk-scroll max-h-80 divide-y divide-border overflow-y-auto">
        {searchConnectorActions(actions, query).map((action) => {
          const label = connectorActionLabel(action.name);
          return (
            <li key={action.name} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{label}</p>
                {action.description ? (
                  <p className="break-words text-sm text-muted-foreground">{action.description}</p>
                ) : null}
              </div>
              {control?.(action, label)}
            </li>
          );
        })}
      </ul>
    </>
  );
}
