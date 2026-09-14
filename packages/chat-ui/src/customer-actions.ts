import { useRef, useState } from "react";

/** Shared web/native composer: retain the nonce after network failure to make retry safe. */
export function useCustomerActions(options: {
  id: string | null;
  nonce: () => string;
  reply: (input: { id: string; body: string; nonce: string }) => Promise<unknown>;
  setOwner: (input: { id: string; owner: "staff" | "bot" }) => Promise<unknown>;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState({ id: options.id, body: "" });
  const [state, setState] = useState<{ id: string | null; busy: boolean; error: boolean }>({
    id: null,
    busy: false,
    error: false,
  });
  const pending = useRef(false);
  const attempt = useRef<{ id: string; body: string; nonce: string } | null>(null);
  const body = draft.id === options.id ? draft.body : "";
  async function act(operation: () => Promise<unknown>) {
    if (!options.id || pending.current) return;
    pending.current = true;
    setState({ id: options.id, busy: true, error: false });
    try {
      await operation();
      options.refresh();
      setState({ id: options.id, busy: false, error: false });
    } catch {
      setState({ id: options.id, busy: false, error: true });
    } finally {
      pending.current = false;
    }
  }
  return {
    body,
    setBody: (body: string) => setDraft({ id: options.id, body }),
    busy: state.id === options.id && state.busy,
    error: state.id === options.id && state.error,
    setOwner: (owner: "staff" | "bot") => act(() => options.setOwner({ id: options.id!, owner })),
    send: () => {
      if (!body.trim()) return;
      return act(async () => {
        if (attempt.current?.id !== options.id || attempt.current.body !== body.trim())
          attempt.current = { id: options.id!, body: body.trim(), nonce: options.nonce() };
        await options.reply(attempt.current);
        setDraft((current) =>
          current.id === options.id && current.body === body
            ? { id: options.id, body: "" }
            : current,
        );
        attempt.current = null;
      });
    },
  };
}
