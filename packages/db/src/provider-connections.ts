import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

export async function lockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): Promise<void> {
  const scope = `space:${owner.spaceId}|user:${owner.userId}|connector:${connectorId}|provider:${provider}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connection-provider'), hashtext(${scope}))`;
}
