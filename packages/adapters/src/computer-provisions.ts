import { randomUUID } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requirePrivateOwner } from "@rakazo/db";
import { toComputerRef } from "./computer-support.js";

/** Register before dispatch; user/Space deletion cannot cascade this receipt away. */
export async function beginComputerProvision(
  prisma: PrismaClient,
  computer: { id: string; homeKey: string },
  context: AdapterContext,
  claim: Prisma.ComputerUpdateManyArgs,
) {
  const id = randomUUID();
  const claimed = await prisma
    .$transaction(async (tx) => {
      await requirePrivateOwner(tx, context);
      const result = await tx.computer.updateMany({
        ...claim,
        where: {
          AND: [
            claim.where ?? {},
            { spaceId: context.spaceId, OR: [{ scope: "team" }, { userId: context.userId }] },
          ],
        },
      });
      if (!result.count) return false;
      await tx.computerProvision.create({
        data: {
          id,
          computerId: computer.id,
          homeKey: computer.homeKey,
          userId: context.userId,
          spaceId: context.spaceId,
        },
      });
      return true;
    })
    .catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002")
        return false;
      throw error;
    });
  if (!claimed) return null;
  let cleanupKind: "stop" | "destroy" | "none" | undefined;
  return {
    async record(ref: ComputerRef, cleanup: "stop" | "destroy" | "none") {
      cleanupKind = cleanup;
      await prisma.computerProvision.update({
        where: { id },
        data: {
          kind: ref.kind,
          providerRef: ref.providerRef,
          cleanup,
        },
      });
    },
    async activate(update: Prisma.ComputerUpdateManyArgs) {
      return prisma.$transaction(async (tx) => {
        await requirePrivateOwner(tx, context);
        const receipt = await tx.computerProvision.findUniqueOrThrow({ where: { id } });
        if (receipt.status !== "active") throw new Error("Computer provisioning needs recovery");
        const result = await tx.computer.updateMany(update);
        if (result.count) await tx.computerProvision.delete({ where: { id } });
        return result;
      });
    },
    async finish(dispatched: boolean, returned: ComputerRef | undefined, cleanupFailed: boolean) {
      if (cleanupFailed || (dispatched && !returned)) {
        await prisma.computerProvision.update({
          where: { id },
          data: {
            status: cleanupFailed ? "cleanup" : "uncertain",
            ...(returned
              ? { kind: returned.kind, providerRef: returned.providerRef, cleanup: cleanupKind }
              : {}),
          },
        });
      } else {
        await prisma.computerProvision.delete({ where: { id } });
      }
    },
  };
}

/** Unknown allocation and stop outcomes retain their fence; only replay-safe deletion expires. */
export async function reconcileComputerProvisions(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  userId?: string,
) {
  const descriptor = deps.sandbox.describe();
  const eligible: Prisma.ComputerProvisionWhereInput[] = [{ status: "cleanup" }];
  if (descriptor.capabilities.replaySafeDestroy) {
    eligible.push({
      status: "cleaning",
      cleanup: "destroy",
      kind: descriptor.id,
      // Longer than the cooperative provider deadline. A late destroy must remain harmless.
      updatedAt: { lte: new Date(Date.now() - 120_000) },
    });
  }
  const rows = await deps.prisma.computerProvision.findMany({
    where: { OR: eligible, ...(userId ? { userId } : {}) },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
  for (const row of rows) {
    if (!row.providerRef || !row.kind || !row.cleanup) continue;
    const claimStamp = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
    const claimed = await deps.prisma.computerProvision.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: "cleaning", updatedAt: claimStamp },
    });
    if (!claimed.count) continue;
    const fence = { id: row.id, status: "cleaning", updatedAt: claimStamp };
    const context = {
      userId: row.userId,
      spaceId: row.spaceId,
      operationId: `provision-cleanup:${row.id}`,
      traceId: `provision-cleanup:${row.id}`,
      signal: AbortSignal.timeout(30_000),
    };
    try {
      const ref = toComputerRef({
        homeKey: row.homeKey,
        kind: row.kind,
        providerRef: row.providerRef,
      });
      if (row.cleanup === "destroy") await deps.sandbox.destroy(ref, context);
      else if (row.cleanup === "stop") await deps.sandbox.stop(ref, context);
      await deps.prisma.computerProvision.deleteMany({ where: fence });
    } catch {
      // Keep identity and ownership, without persisting provider errors or credentials.
      await deps.prisma.computerProvision.updateMany({
        where: fence,
        data: { status: "cleanup" },
      });
    }
  }
}
