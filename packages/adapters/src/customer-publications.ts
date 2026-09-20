import { randomUUID } from "node:crypto";
import type { CustomerRuntime } from "@rakazo/adapter-kit";
import { CustomerServiceConnection } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requirePrivateOwner } from "@rakazo/db";
import { z } from "zod";
import type { CustomerRuntimeConfig } from "./customer-runtime.js";
import { LangflowCustomerRuntime } from "./customer-runtime.js";
import type { EncryptedSecretStore } from "./secrets.js";

type Owner = { userId: string; spaceId: string; botId: string };
const cleanupConfig = z.object({
  baseUrl: CustomerServiceConnection.shape.baseUrl,
  apiKey: z.string().optional(),
});
const cleanupSnapshot = cleanupConfig.extend({
  principal: z.string().trim().min(1).max(1000).optional(),
});

export function createCustomerPublications(deps: {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  runtime?: (config: CustomerRuntimeConfig) => CustomerRuntime;
}) {
  const { prisma, secrets } = deps;
  return {
    async begin(owner: Owner, config: CustomerRuntimeConfig) {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 30_000);
      const endpoint = cleanupConfig.parse(config);
      const ciphertext = secrets.seal(JSON.stringify(endpoint), id);
      await prisma.$transaction(async (tx) => {
        await requirePrivateOwner(tx, owner, owner.botId);
        await tx.customerPublication.create({
          data: {
            id,
            userId: owner.userId,
            spaceId: owner.spaceId,
            botId: owner.botId,
            expiresAt,
            // Cleanup never needs the separate knowledge credential or instructions.
            ciphertext,
          },
        });
      });
      let dispatched = false;
      return {
        id,
        async beforeDispatch() {
          const runtime = deps.runtime?.(endpoint) ?? new LangflowCustomerRuntime(endpoint);
          const principal = await runtime.identity?.(AbortSignal.timeout(10_000));
          const snapshot = cleanupSnapshot.parse({ ...endpoint, principal });
          if (
            !(
              await prisma.customerPublication.updateMany({
                where: { id, ciphertext, status: "preparing", expiresAt: { gt: new Date() } },
                data: {
                  status: "publishing",
                  ciphertext: secrets.seal(JSON.stringify(snapshot), id),
                },
              })
            ).count ||
            Date.now() >= expiresAt.getTime()
          )
            throw new Error("Customer publication expired before dispatch");
          dispatched = true;
        },
        async record(flowId: string) {
          if (
            !(
              await prisma.customerPublication.updateMany({
                where: { id, status: "publishing" },
                data: { status: "published", confirmed: true, flowId },
              })
            ).count
          )
            throw new Error("Customer publication needs recovery");
        },
        async adopt(tx: Prisma.TransactionClient) {
          if (
            !(
              await tx.customerPublication.updateMany({
                where: { id, status: "published", expiresAt: { gt: new Date() } },
                data: { status: "active" },
              })
            ).count
          )
            throw new Error("Customer publication needs recovery");
        },
        async finish() {
          // Never undo a possibly committed adoption after a lost database response.
          if (!dispatched) {
            await prisma.customerPublication.deleteMany({
              where: { id, status: { in: ["preparing", "publishing"] }, behavior: null },
            });
          } else {
            await prisma.customerPublication.updateMany({
              where: { id, status: { in: ["publishing", "published"] }, behavior: null },
              data: { status: "cleanup", nextAttemptAt: new Date() },
            });
          }
        },
      };
    },

    async use(owner: Owner, behavior: { publicationId: string | null; flowId: string }) {
      // Legacy behaviors remain usable; only tracked publications are automatically removed.
      const publicationId = behavior.publicationId;
      if (!publicationId) return;
      await prisma.$transaction(async (tx) => {
        await requirePrivateOwner(tx, owner, owner.botId);
        await tx.$queryRaw`SELECT id FROM customer_publications WHERE id = ${publicationId} FOR UPDATE`;
        const row = await tx.customerPublication.findFirst({
          where: {
            id: publicationId,
            userId: owner.userId,
            spaceId: owner.spaceId,
            botId: owner.botId,
            status: "active",
            behavior: { is: { botId: owner.botId, flowId: behavior.flowId } },
          },
        });
        if (!row) throw new Error("Customer behavior changed before execution");
        // Longer than the caller's 60-second request and the component's 55-second run.
        const until = new Date(Date.now() + 90_000);
        await tx.$executeRaw`UPDATE customer_publications SET "inUseUntil" = GREATEST("inUseUntil", ${until}) WHERE id = ${row.id}`;
      });
    },

    /** Operator-only credential repair. Never changes endpoints or deletes a remote flow. */
    async recoverCredentials(input: unknown) {
      const config = cleanupConfig
        .extend({ apiKey: z.string().trim().min(1).max(16_384) })
        .parse(input);
      const runtime = deps.runtime?.(config) ?? new LangflowCustomerRuntime(config);
      const principal = runtime.identity
        ? cleanupSnapshot.shape.principal
            .unwrap()
            .parse(await runtime.identity(AbortSignal.timeout(10_000)))
        : undefined;
      const result = { refreshed: 0, unverified: 0, failed: 0 };
      let after: string | undefined;
      while (true) {
        const rows = await prisma.customerPublication.findMany({
          where: after ? { id: { gt: after } } : {},
          orderBy: { id: "asc" },
          take: 100,
          select: { id: true, botId: true, ciphertext: true },
        });
        if (!rows.length) break;
        after = rows.at(-1)!.id;
        for (const row of rows) {
          try {
            const snapshot = cleanupSnapshot.parse(
              JSON.parse(secrets.load(row.ciphertext, row.id)),
            );
            if (snapshot.baseUrl.replace(/\/$/, "") !== config.baseUrl.replace(/\/$/, "")) continue;
            const samePrincipal = principal !== undefined && principal === snapshot.principal;
            if (
              !samePrincipal &&
              !(await runtime.inspectPublication?.({
                publicationId: row.id,
                staffId: row.botId,
                signal: AbortSignal.timeout(10_000),
              }))
            ) {
              result.unverified++;
              continue;
            }
            const changed = await prisma.customerPublication.updateMany({
              where: { id: row.id, ciphertext: row.ciphertext },
              data: {
                ciphertext: secrets.seal(JSON.stringify({ ...config, principal }), row.id),
                nextAttemptAt: new Date(),
              },
            });
            result.refreshed += changed.count;
            result.unverified += 1 - changed.count;
          } catch {
            // Provider diagnostics and stored secrets never become operator output.
            result.failed++;
          }
        }
      }
      return result;
    },

    async reconcile(userId?: string) {
      const now = new Date();
      const rows = await prisma.customerPublication.findMany({
        where: {
          ...(userId ? { userId } : {}),
          behavior: null,
          nextAttemptAt: { lte: now },
          AND: [
            { OR: [{ inUseUntil: null }, { inUseUntil: { lte: now } }] },
            { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
            {
              OR: [
                { status: { in: ["active", "cleanup", "uncertain", "cleaning"] } },
                { expiresAt: { lte: now } },
              ],
            },
          ],
        },
        orderBy: { nextAttemptAt: "asc" },
        take: 10,
        select: { id: true },
      });
      await Promise.all(
        rows.map(async (candidate) => {
          const claimId = randomUUID();
          const row = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM customer_publications WHERE id = ${candidate.id} FOR UPDATE`;
            const current = await tx.customerPublication.findUnique({
              where: { id: candidate.id },
              include: { behavior: { select: { botId: true } } },
            });
            const now = new Date();
            if (
              !current ||
              current.behavior ||
              (current.inUseUntil && current.inUseUntil > now) ||
              (current.leaseUntil && current.leaseUntil > now) ||
              current.nextAttemptAt > now ||
              (["preparing", "publishing", "published"].includes(current.status) &&
                current.expiresAt > now)
            )
              return null;
            if (current.status === "preparing") {
              // A late publisher's beforeDispatch compare-and-set now fails without an HTTP request.
              await tx.customerPublication.delete({ where: { id: current.id } });
              return null;
            }
            return tx.customerPublication.update({
              where: { id: current.id },
              data: { status: "cleaning", claimId, leaseUntil: new Date(Date.now() + 120_000) },
            });
          });
          if (!row) return;
          const fence = { id: row.id, status: "cleaning", claimId };
          try {
            const config = cleanupConfig.parse(JSON.parse(secrets.load(row.ciphertext, row.id)));
            const runtime = deps.runtime?.(config) ?? new LangflowCustomerRuntime(config);
            if (!runtime.removePublication)
              throw new Error("Customer runtime cleanup is unavailable");
            const result = await runtime.removePublication({
              publicationId: row.id,
              staffId: row.botId,
              signal: AbortSignal.timeout(30_000),
              beforeRemove: async () => {
                // If deletion's response or this process is lost, absence is now conclusive.
                if (
                  !(
                    await prisma.customerPublication.updateMany({
                      where: fence,
                      data: { confirmed: true },
                    })
                  ).count
                )
                  throw new Error("Customer publication cleanup claim expired");
              },
            });
            if (result !== "removed" && result !== "absent")
              throw new Error("Customer runtime cleanup did not confirm its outcome");
            const deleted = await prisma.customerPublication.deleteMany({
              where: { ...fence, ...(result === "absent" ? { confirmed: true } : {}) },
            });
            if (!deleted.count) {
              // An absent uncertain create can still arrive later. Never discard its identity.
              await prisma.customerPublication.updateMany({
                where: fence,
                data: {
                  status: "uncertain",
                  claimId: null,
                  leaseUntil: null,
                  nextAttemptAt: new Date(Date.now() + 60_000),
                },
              });
            }
          } catch {
            await prisma.customerPublication.updateMany({
              where: fence,
              data: {
                status: "cleanup",
                claimId: null,
                leaseUntil: null,
                nextAttemptAt: new Date(Date.now() + 60_000),
              },
            });
          }
        }),
      );
    },
  };
}
