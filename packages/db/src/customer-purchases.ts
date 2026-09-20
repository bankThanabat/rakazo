import type { Prisma } from "./client.js";

// Calls stop well before deletion may clear an abandoned reservation. A remote
// provider can still finish an already accepted call after local cancellation.
export const purchaseDispatchMs = 45_000;
export const purchaseRecoveryMs = 5 * 60_000;

export function inFlightCustomerPurchases(now = new Date()): Prisma.CustomerPurchaseWhereInput {
  const cutoff = new Date(now.getTime() - purchaseRecoveryMs);
  return {
    status: { in: ["creating", "updating", "submitting", "uncertain"] },
    AND: [
      {
        OR: [
          { actionStartedAt: { gt: cutoff } },
          { actionStartedAt: null, updatedAt: { gt: cutoff } },
        ],
      },
    ],
  };
}
