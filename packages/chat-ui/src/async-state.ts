import { useCallback, useEffect, useRef, useState } from "react";

export function useAsyncAction(after?: () => unknown) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function act(operation: () => Promise<unknown>) {
    setBusy(true);
    setError(false);
    try {
      await operation();
      await after?.();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, act };
}

/** Scope changes hide old data immediately; late responses cannot replace the new scope. */
export function usePolling<T>(load: () => Promise<T>, key: string | null, interval: number) {
  const loader = useRef(load);
  loader.current = load;
  const [result, setResult] = useState<{ key: string; data: T }>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await loader.current();
        if (!cancelled) {
          setResult({ key: key!, data });
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
      if (!cancelled) timer = setTimeout(poll, interval);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, interval, revision]);
  return { data: result?.key === key ? result.data : undefined, error, refresh };
}
