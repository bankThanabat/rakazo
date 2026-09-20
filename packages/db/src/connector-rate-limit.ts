import type { PrismaClient } from "./client.js";

/** Atomic admission across workers. Busy callers wait outside a database transaction. */
export async function takeConnectorPermit(
  db: Pick<PrismaClient, "$queryRaw">,
  key: string,
  intervalMs: number,
): Promise<number> {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 60000
  )
    throw new Error("Invalid connector rate limit");
  const admitted = await db.$queryRaw<Array<{ key: string }>>`
    INSERT INTO connector_rate_limits (key, "availableAt")
    VALUES (${key}, clock_timestamp() + ${intervalMs} * interval '1 millisecond')
    ON CONFLICT (key) DO UPDATE
      SET "availableAt" = clock_timestamp() + ${intervalMs} * interval '1 millisecond'
      WHERE connector_rate_limits."availableAt" <= clock_timestamp()
    RETURNING key`;
  if (admitted.length) return 0;
  // A separate statement sees a concurrent first insert after its transaction commits.
  const [row] = await db.$queryRaw<Array<{ retryMs: number }>>`
    SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("availableAt" - clock_timestamp())) * 1000))::int AS "retryMs"
    FROM connector_rate_limits WHERE key = ${key}`;
  return row?.retryMs ?? 1;
}

export async function deleteExpiredConnectorPermits(db: Pick<PrismaClient, "$executeRaw">) {
  // Use the same clock as admission, even when API/worker clocks disagree.
  return db.$executeRaw`
    DELETE FROM connector_rate_limits
    WHERE "availableAt" < clock_timestamp() - interval '1 day'`;
}
