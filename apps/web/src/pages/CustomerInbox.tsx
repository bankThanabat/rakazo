import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { usePolling } from "@rakazo/chat-ui/async-state";
import { useCustomerActions } from "@rakazo/chat-ui/customer-actions";
import { Button, cn, ProfileAvatar, Textarea } from "@rakazo/ui-web";
import { Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

export function useCustomerInbox(enabled: boolean, scope: string | undefined, query: string) {
  const [id, setId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "resolved" | "attention" | "all">("open");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setId(null);
  }, [scope]);
  useEffect(() => setOffset(0), [query, filter, scope]);
  const { data, error } = usePolling(
    () => rpc.customers.list({ query, state: filter, offset }),
    enabled ? `${scope}:${filter}:${query}:${offset}` : null,
    3000,
  );
  return {
    conversations: data ?? [],
    id,
    setId,
    error,
    filter,
    setFilter,
    query,
    offset,
    setOffset,
  };
}
type Inbox = ReturnType<typeof useCustomerInbox>;

export function CustomerSidebar({ inbox, onSelect }: { inbox: Inbox; onSelect: () => void }) {
  const visible = inbox.conversations;
  return (
    <>
      <fieldset className="flex flex-wrap gap-1 p-2" aria-label={t`Filter conversations`}>
        {(["open", "attention", "resolved", "all"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={inbox.filter === value ? "secondary" : "ghost"}
            aria-pressed={inbox.filter === value}
            onClick={() => inbox.setFilter(value)}
          >
            {value === "open"
              ? t`Open`
              : value === "attention"
                ? t`Needs attention`
                : value === "resolved"
                  ? t`Resolved`
                  : t`All`}
          </Button>
        ))}
      </fieldset>
      {inbox.error ? (
        <p role="alert" className="px-2.5 py-4 text-sm text-muted-foreground">
          <Trans>Could not load conversations</Trans>
        </p>
      ) : null}
      {visible.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => {
            inbox.setId(row.id);
            onSelect();
          }}
          className={cn(
            "flex w-full items-center gap-3 rounded-xl px-2.5 py-3 text-start hover:bg-sidebar-accent",
            inbox.id === row.id && "bg-sidebar-accent",
          )}
        >
          <ProfileAvatar url={row.avatarUrl} />
          <span className="min-w-0 flex-1">
            <span
              className={cn("block truncate text-sm", row.unread ? "font-bold" : "font-medium")}
            >
              {row.name}
              {row.unread ? (
                <span className="sr-only">
                  {" "}
                  <Trans>Unread</Trans>
                </span>
              ) : null}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {row.channelName} · {row.needsHuman ? <Trans>Needs attention</Trans> : row.preview}
            </span>
          </span>
        </button>
      ))}
      <div className="flex justify-between p-2">
        {inbox.offset > 0 && (
          <Button variant="ghost" onClick={() => inbox.setOffset(Math.max(0, inbox.offset - 200))}>
            <Trans>Previous</Trans>
          </Button>
        )}
        {visible.length === 200 && (
          <Button variant="ghost" onClick={() => inbox.setOffset(inbox.offset + 200)}>
            <Trans>Next</Trans>
          </Button>
        )}
      </div>
      {!visible.length && !inbox.error ? (
        <p className="px-2.5 py-6 text-sm text-muted-foreground">
          {inbox.query ? <Trans>No results</Trans> : <Trans>No customer conversations yet</Trans>}
        </p>
      ) : null}
    </>
  );
}
export function CustomerThread({
  id,
  onOpenNavigation,
  onAskAssistant,
}: {
  id: string | null;
  onOpenNavigation: () => void;
  onAskAssistant?: (id: string) => Promise<void>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const polling = usePolling(() => rpc.customers.snapshot({ id: id! }), id, 1500);
  const snapshot = polling.data;
  const [before, setBefore] = useState<number>();
  const [caseError, setCaseError] = useState(false);
  const history = usePolling(
    () => rpc.customers.snapshot({ id: id!, before }),
    before && id ? `${id}:${before}` : null,
    10000,
  );
  useEffect(() => {
    setBefore(undefined);
    setCaseError(false);
  }, [id]);
  useEffect(() => {
    pinned.current = true;
  }, [id]);
  const current = snapshot?.conversation.id === id ? snapshot : null;
  const displayed = before ? history.data : current;
  async function updateCase(input: {
    state?: "open" | "resolved";
    assigneeId?: string | null;
    read?: boolean;
  }) {
    if (!id) return;
    try {
      await rpc.customers.updateCase({ id, ...input });
      polling.refresh();
      setCaseError(false);
    } catch {
      setCaseError(true);
    }
  }
  useEffect(() => {
    if (id && current) void updateCase({ read: true });
  }, [id, current?.messages.at(-1)?.id]);
  const actions = useCustomerActions({
    id,
    nonce: () => crypto.randomUUID(),
    reply: rpc.customers.reply,
    setOwner: rpc.customers.setOwner,
    refresh: polling.refresh,
  });
  const lastMessageId = current?.messages.at(-1)?.id;
  useEffect(() => {
    if (scroll.current && pinned.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [lastMessageId]);
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-sidebar-border px-4 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={t`Open navigation`}
            onClick={onOpenNavigation}
          >
            <Menu />
          </Button>
          {current ? (
            <ProfileAvatar url={current.conversation.avatarUrl} className="size-8" />
          ) : null}
          <span className="truncate font-medium">{current?.conversation.name ?? t`Customer`}</span>
        </div>
        {current?.conversation.canReply ? (
          <Button
            variant="ghost"
            disabled={actions.busy}
            onClick={() =>
              void actions.setOwner(current.conversation.owner === "bot" ? "staff" : "bot")
            }
          >
            {current.conversation.owner === "bot" ? (
              <Trans>Take over</Trans>
            ) : (
              <Trans>Resume AI</Trans>
            )}
          </Button>
        ) : null}
      </div>
      {current && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void updateCase({
                state: current.conversation.state === "resolved" ? "open" : "resolved",
              })
            }
          >
            {current.conversation.state === "resolved" ? (
              <Trans>Reopen</Trans>
            ) : (
              <Trans>Resolve</Trans>
            )}
          </Button>
          {onAskAssistant && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (id) void onAskAssistant(id).catch(() => setCaseError(true));
              }}
            >
              <Trans>Ask assistant</Trans>
            </Button>
          )}
          {current.conversation.draft && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                actions.setBody(current.conversation.draft!);
                void actions.setOwner("staff");
              }}
            >
              <Trans>Use draft</Trans>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                const me = await rpc.me();
                await updateCase({ assigneeId: me.userId });
              } catch {
                setCaseError(true);
              }
            }}
          >
            <Trans>Assign to me</Trans>
          </Button>
        </div>
      )}
      {current?.conversation.handoffReason && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {current.conversation.handoffReason}
        </p>
      )}
      {caseError && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          <Trans>Could not update case</Trans>
        </p>
      )}
      <div
        ref={scroll}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="rk-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5"
        aria-live="polite"
      >
        {displayed?.before && (
          <Button variant="ghost" onClick={() => setBefore(displayed.before ?? undefined)}>
            <Trans>Earlier messages</Trans>
          </Button>
        )}
        {before && (
          <Button variant="ghost" onClick={() => setBefore(undefined)}>
            <Trans>Latest messages</Trans>
          </Button>
        )}
        {displayed?.messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-xl px-4 py-3 text-sm",
              message.role === "customer" ? "self-start bg-muted" : "self-end bg-card",
            )}
          >
            <p>{message.body}</p>
            {message.mediaUrl ? (
              <a
                href={message.mediaUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block underline"
              >
                <Trans>Attachment</Trans>
              </a>
            ) : null}
            {message.status === "failed" ? (
              <p className="mt-1 text-xs text-destructive">
                <Trans>Reply failed</Trans>
                {message.sentParts > 0 ? ` · ${message.sentParts} ${t`parts sent`}` : ""}
              </p>
            ) : null}
            {message.status === "cancelled" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>Cancelled</Trans>
              </p>
            ) : null}
            {message.role !== "customer" &&
            (message.status === "queued" || message.status === "sending") ? (
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>Sending…</Trans>
              </p>
            ) : null}
          </div>
        ))}
        {!!displayed?.actions.length && (
          <details className="text-sm text-muted-foreground">
            <summary>
              <Trans>Action history</Trans>
            </summary>
            {displayed.actions.map((action, index) => (
              <div key={`${action.createdAt}:${index}`}>
                <p>
                  {action.name} · {action.status}
                </p>
                {action.outcome && (
                  <pre className="whitespace-pre-wrap break-words text-xs">{action.outcome}</pre>
                )}
              </div>
            ))}
          </details>
        )}
      </div>
      {current?.conversation.canReply && current.conversation.owner === "staff" ? (
        <form
          className="flex items-end gap-2 border-t border-sidebar-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.send();
          }}
        >
          <Textarea
            aria-label={t`Reply to customer`}
            placeholder={t`Reply…`}
            value={actions.body}
            maxLength={16000}
            onChange={(event) => actions.setBody(event.target.value)}
            disabled={actions.busy}
            rows={2}
            className="max-h-40 min-h-10 flex-1"
          />
          <Button type="submit" disabled={actions.busy || !actions.body.trim()}>
            <Trans>Send</Trans>
          </Button>
        </form>
      ) : null}
      {actions.error ? (
        <p role="alert" className="px-5 py-2 text-sm text-destructive">
          <Trans>Could not save. Try again.</Trans>
        </p>
      ) : null}
      {polling.error ? (
        <p role="alert" className="px-5 py-2 text-sm text-destructive">
          <Trans>Could not update conversation</Trans>
        </p>
      ) : null}
    </>
  );
}
