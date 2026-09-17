import { Trans, useLingui } from "@lingui/react/macro";
import { connectorActionLabel, searchConnectorActions } from "@rakazo/core";
import { Input, Skeleton } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useState } from "react";

export function ActionsSection({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">
          <Trans>Available actions</Trans>
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** `actions` is null while loading. `control` renders each row's trailing controls. */
export function ActionList<T extends { name: string; description: string }>({
  actions,
  control,
  controlHeading,
}: {
  actions: T[] | null;
  control?: (action: T, label: string) => ReactNode;
  controlHeading?: ReactNode;
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
      <div className="rk-scroll max-h-80 overflow-y-auto">
        {controlHeading ? (
          <div className="sticky top-0 z-10 flex justify-end bg-card py-1 text-xs text-muted-foreground">
            <span className="min-w-16 text-center">{controlHeading}</span>
          </div>
        ) : null}
        <ul className="divide-y divide-border">
          {searchConnectorActions(actions, query).map((action) => {
            const label = connectorActionLabel(action.name);
            return (
              <li key={action.name} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{label}</p>
                  {action.description ? (
                    <p className="break-words text-sm text-muted-foreground">
                      {action.description}
                    </p>
                  ) : null}
                </div>
                {control?.(action, label)}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
