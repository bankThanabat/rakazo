import { isPlainHttpUrl } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";

export function gatewayAuthorizationUrl(endpoint: string): string | null {
  if (!isPlainHttpUrl(endpoint)) return null;
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/integration-gateway/authorize`;
  return url.toString();
}

export type ConnectionAuthorizationResult =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "cancelled" }
  | { status: "error"; message?: string };

/** Shared polling policy. Navigation cancels observation, never the remote authorization. */
export async function waitForConnectionAuthorization(
  complete: (signal: AbortSignal) => Promise<{ status: string }>,
  signal: AbortSignal,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<ConnectionAuthorizationResult> {
  try {
    const attempts = options.attempts ?? 300;
    for (let index = 0; index < attempts; index++) {
      if (signal.aborted) return { status: "cancelled" };
      const row = await complete(signal);
      if (signal.aborted) return { status: "cancelled" };
      if (row.status === "connected") return { status: "connected" };
      if (row.status === "error" || row.status === "revoked") return { status: "error" };
      if (index + 1 < attempts) await abortableDelay(options.intervalMs ?? 2000, signal);
    }
    return { status: "pending" };
  } catch (cause) {
    return signal.aborted
      ? { status: "cancelled" }
      : { status: "error", message: cause instanceof Error ? cause.message : undefined };
  }
}
