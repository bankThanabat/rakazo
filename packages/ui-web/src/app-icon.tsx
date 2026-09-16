import { useState } from "react";
import { cn } from "./lib/utils.js";

/** App logo with a monogram fallback when the logo is missing or fails to load. */
export function AppIcon({
  item,
  className,
}: {
  item: { name: string; logo?: string | null };
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-sm font-medium text-foreground",
        className,
      )}
    >
      {item.logo && !failed ? (
        <img
          src={item.logo}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-[62%] object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        item.name.slice(0, 1)
      )}
    </span>
  );
}
