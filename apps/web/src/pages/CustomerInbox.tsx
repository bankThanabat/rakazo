import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAsyncAction, usePolling } from "@rakazo/chat-ui/async-state";
import { CUSTOMER_REPLY_MAX_LENGTH } from "@rakazo/contracts";
import { Button, cn, ProfileAvatar, Textarea } from "@rakazo/ui-web";
import { ArrowUp, Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

export function useCustomerInbox(enabled: boolean, scope: string | undefined) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(null);
  }, [scope]);
  const { data, error, refresh } = usePolling(
    () => rpc.customers.list(),
    enabled ? (scope ?? "") : null,
    3000,
  );
  return {
    conversations: data ?? [],
    id,
    setId,
    error,
    refresh,
  };
}
type Inbox = ReturnType<typeof useCustomerInbox>;

export function CustomerSidebar({
  inbox,
  query,
  onSelect,
}: {
  inbox: Inbox;
  query: string;
  onSelect: () => void;
}) {
  const visible = inbox.conversations.filter((row) =>
    `${row.name} ${row.preview} ${row.channelName}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
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
            <span className="block truncate text-sm font-medium">{row.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {row.channelName} · {row.needsHuman ? <Trans>Needs attention</Trans> : row.preview}
            </span>
          </span>
        </button>
      ))}
      {!visible.length && !inbox.error ? (
        <p className="px-2.5 py-6 text-sm text-muted-foreground">
          {query.trim() ? <Trans>No results</Trans> : <Trans>No customer conversations yet</Trans>}
        </p>
      ) : null}
    </>
  );
}
export function CustomerThread({
  id,
  onOpenNavigation,
  refresh,
}: {
  id: string | null;
  onOpenNavigation: () => void;
  refresh: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [body, setBody] = useState("");
  const nonce = useRef({ body: "", id: "" });
  const polling = usePolling(() => rpc.customers.snapshot({ id: id! }), id, 1500);
  const {
    busy,
    error: actionError,
    act,
  } = useAsyncAction(() => {
    polling.refresh();
    refresh();
  });
  const error = actionError || polling.error;
  const snapshot = polling.data;
  useEffect(() => {
    pinned.current = true;
    setBody("");
    nonce.current = { body: "", id: "" };
  }, [id]);
  const current = snapshot?.conversation.id === id ? snapshot : null;
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
        {current ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() =>
                rpc.customers.setOwner({
                  id: current.conversation.id,
                  owner: current.conversation.owner === "bot" ? "staff" : "bot",
                }),
              )
            }
          >
            {current.conversation.owner === "bot" ? (
              <Trans>Take over</Trans>
            ) : (
              <Trans>Resume bot</Trans>
            )}
          </Button>
        ) : null}
      </div>
      <div
        ref={scroll}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="rk-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5"
        aria-live="polite"
      >
        {current?.messages.map((message) => (
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
              </p>
            ) : null}
            {message.status === "cancelled" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>Cancelled</Trans>
              </p>
            ) : null}
            {message.role !== "customer" && message.status === "queued" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>Sending…</Trans>
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="px-5 py-2 text-sm text-destructive">
          <Trans>Could not update conversation</Trans>
        </p>
      ) : null}
      {current?.conversation.owner === "staff" ? (
        <form
          className="flex items-end gap-2 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!body.trim() || busy) return;
            const text = body;
            if (nonce.current.body !== text)
              nonce.current = { body: text, id: crypto.randomUUID() };
            void act(async () => {
              await rpc.customers.reply({
                id: current.conversation.id,
                body: text,
                clientNonce: nonce.current.id,
              });
              setBody("");
              nonce.current = { body: "", id: "" };
            });
          }}
        >
          <Textarea
            aria-label={t`Reply to customer`}
            placeholder={t`Reply to customer`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={CUSTOMER_REPLY_MAX_LENGTH}
            className="min-h-10 resize-none"
          />
          <Button type="submit" size="icon" disabled={busy || !body.trim()} aria-label={t`Send`}>
            <ArrowUp />
          </Button>
        </form>
      ) : null}
    </>
  );
}
