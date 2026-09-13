import type { ReactNode } from "react";
import { Card } from "./components/ui/card.js";

export function IntegrationCard({
  name,
  logo,
  icon,
  status,
  description,
  testId,
  children,
}: {
  name: string;
  logo?: string | null;
  icon?: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Card role="group" aria-label={name} data-testid={testId} className="min-w-0 gap-6 p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-muted">
          {logo ? (
            <img
              src={logo}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-8 object-contain grayscale"
            />
          ) : (
            (icon ?? <span className="text-lg font-semibold text-foreground">{name[0]}</span>)
          )}
        </div>
        <div className="min-w-0 space-y-2 self-center">
          <h3 className="break-words text-base font-semibold leading-snug">{name}</h3>
          {status}
        </div>
      </div>
      {description ? (
        <p className="break-words text-sm text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </Card>
  );
}
