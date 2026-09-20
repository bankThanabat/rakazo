import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "@rakazo/db";
import { takeConnectorPermit } from "@rakazo/db";
import { withAbort } from "./web-ssrf.js";

/** No future slots are reserved: a cancelled waiter cannot leave a queue behind. */
export async function waitForConnectorPermit(
  db: Pick<PrismaClient, "$queryRaw">,
  key: string,
  intervalMs: number,
  signal: AbortSignal,
  assertAccess?: () => Promise<void>,
) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  for (;;) {
    bounded.throwIfAborted();
    if (assertAccess) await withAbort(assertAccess(), bounded);
    bounded.throwIfAborted();
    // Prisma cannot cancel this SQL. Stop the caller promptly; a late admission
    // can waste one short slot but can never trigger a provider request.
    const retryMs = await withAbort(takeConnectorPermit(db, key, intervalMs), bounded);
    bounded.throwIfAborted();
    if (!retryMs) return;
    await delay(retryMs, undefined, { signal: bounded });
  }
}
