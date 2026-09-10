import { UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar.js";
import { cn } from "./lib/utils.js";

/** Decorative identity beside an already visible name. */
export function ProfileAvatar({ url, className }: { url: string | null; className?: string }) {
  return (
    <Avatar className={cn("size-10 shrink-0", className)} aria-hidden="true">
      {url ? <AvatarImage src={url} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback>
        <UserRound className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}
