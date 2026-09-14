import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Textarea } from "@rakazo/ui-web";
import { MessageCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Transcript = {
  owner: string;
  needsHuman: boolean;
  state: string;
  before: number | null;
  messages: Array<{ id: string; seq: number; role: string; body: string }>;
};

/** Visitor-only client. Staff cookies, RPC, private history, and tools are never used here. */
export function SupportWidget() {
  const { t } = useLingui();
  const channel = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  const origin = new URLSearchParams(location.search).get("origin") ?? "";
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [data, setData] = useState<Transcript>();
  const [earlier, setEarlier] = useState<Transcript>();
  const [body, setBody] = useState("");
  const [error, setError] = useState(false);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef<Transcript | undefined>(undefined);
  const attempt = useRef<{ body: string; nonce: string } | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  function parentMessage(type: string, extra = {}) {
    if (/^https?:\/\//.test(origin) && window.parent !== window)
      window.parent.postMessage({ type, channel, ...extra }, origin);
  }
  async function request(path: string, input?: unknown) {
    const response = await fetch(`/api/customer-web/${encodeURIComponent(channel)}/${path}`, {
      credentials: "omit",
      method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    if (response.status === 401) setExpired(true);
    if (!response.ok) throw new Error("Support unavailable");
    return response.json();
  }
  async function loadTranscript(active = () => true) {
    const lastSeen = latest.current ? (latest.current.messages.at(-1)?.seq ?? 0) : undefined;
    const next: Transcript = await request("messages");
    const incoming = [...next.messages];
    let page = next;
    // A reconnect may span several pages. Fill the gap before moving the latest window.
    while (active() && lastSeen !== undefined && page.before && page.messages[0]!.seq > lastSeen) {
      page = await request(`messages?before=${page.before}`);
      incoming.push(...page.messages);
    }
    if (!active()) return;
    const previous = latest.current;
    latest.current = {
      ...next,
      before: previous ? previous.before : next.before,
      messages: [
        ...new Map(
          [...(previous?.messages ?? []), ...incoming].map((message) => [message.id, message]),
        ).values(),
      ].sort((a, b) => a.seq - b.seq),
    };
    setData(latest.current);
  }
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (
        event.source !== window.parent ||
        event.origin !== origin ||
        event.data?.channel !== channel
      )
        return;
      if (event.data.type === "support-session" && /^[A-Za-z0-9_-]{43}$/.test(event.data.token)) {
        setToken(event.data.token);
        setExpired(false);
        setError(false);
      }
      if (event.data.type === "support-error") setError(true);
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel, origin]);
  useEffect(() => {
    parentMessage("support-size", { open });
    if (open && !token) parentMessage("support-ready");
  }, [open, token]);
  useEffect(() => {
    if (!token || !open) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        await loadTranscript(() => active);
        if (active) {
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [token, open]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.at(-1)?.id]);
  async function send() {
    if (!token || busy || !body.trim()) return;
    setBusy(true);
    try {
      if (attempt.current?.body !== body.trim())
        attempt.current = { body: body.trim(), nonce: crypto.randomUUID() };
      await request("messages", attempt.current);
      await loadTranscript();
      setBody("");
      attempt.current = undefined;
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <Button
          className="size-14 rounded-full"
          aria-label={t`Open support`}
          onClick={() => setOpen(true)}
        >
          <MessageCircle />
        </Button>
      </div>
    );
  return (
    <section
      aria-label={t`Customer support`}
      className="flex h-dvh flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="font-medium">
          <Trans>Support</Trans>
        </h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Close support`}
          onClick={() => setOpen(false)}
        >
          <X />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-4" aria-live="polite">
        {!data?.messages.length && (
          <p className="text-sm text-muted-foreground">
            <Trans>How can we help?</Trans>
          </p>
        )}
        {(earlier ? earlier.before : data?.before) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const next = await request(
                  `messages?before=${earlier ? earlier.before : data?.before}`,
                );
                setEarlier((previous) => ({
                  ...next,
                  messages: [...next.messages, ...(previous?.messages ?? [])],
                }));
              } catch {
                setError(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trans>Earlier messages</Trans>
          </Button>
        )}
        {[
          ...new Map(
            [...(earlier?.messages ?? []), ...(data?.messages ?? [])].map((message) => [
              message.id,
              message,
            ]),
          ).values(),
        ].map((message) => (
          <div
            key={message.id}
            className={`mb-3 w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${message.role === "customer" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted"}`}
          >
            {message.body}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {data?.needsHuman ? (
        <p role="status" className="px-4 text-sm text-muted-foreground">
          <Trans>Waiting for support</Trans>
        </p>
      ) : data?.owner !== "staff" ? (
        <Button
          variant="ghost"
          disabled={!token || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await request("handoff", {});
              await loadTranscript();
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trans>Talk to a person</Trans>
        </Button>
      ) : null}
      {error && (
        <div role="alert" className="px-4 py-2 text-sm text-destructive">
          {expired ? (
            <Trans>Your session expired.</Trans>
          ) : (
            <Trans>Could not connect. Try again.</Trans>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              if (expired) {
                latest.current = undefined;
                setData(undefined);
                setEarlier(undefined);
                setToken("");
                attempt.current = undefined;
                parentMessage("support-reset");
              } else parentMessage("support-ready");
            }}
          >
            {expired ? <Trans>Start a new conversation</Trans> : <Trans>Reconnect</Trans>}
          </Button>
        </div>
      )}
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          aria-label={t`Message support`}
          placeholder={t`Message…`}
          rows={2}
          maxLength={16000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={busy}
        />
        <Button type="submit" disabled={!token || busy || !body.trim()}>
          <Trans>Send</Trans>
        </Button>
      </form>
    </section>
  );
}
