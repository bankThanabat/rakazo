import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  claimAccountOrganizations,
  inFlightCustomerPurchases,
  lockProviderConnectionScope,
} from "@rakazo/db";
import { destroyBot } from "./child-bots.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { cleanupAccountCloudAgents } from "./cloud-agent-poll.js";
import type { ConnectorRegistry } from "./composio-connector.js";
import { reconcileComputerProvisions } from "./computer-provisions.js";
import { toComputerRef } from "./computer-support.js";
import { deletePushToken } from "./expo-push.js";
import { resolveAgentHomePath } from "./home.js";
import type { IntegrationGateway } from "./integration-gateway.js";
import type { KnowledgeService } from "./knowledge.js";
import { removePiUserSessions } from "./pi-session.js";

const leaseMs = 5 * 60_000;
export type AccountDeletionService = ReturnType<typeof createAccountDeletionService>;

export function createAccountDeletionService(deps: {
  prisma: PrismaClient;
  reconcileCustomerPublications?: (userId: string) => Promise<void>;
  cloudAgent?: CloudAgentConnection | null;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  artifacts: ArtifactStore;
  dataDir: string;
  integrations: Pick<IntegrationGateway, "removeUserAccounts">;
  knowledge: Pick<KnowledgeService, "purge">;
  connectors: Pick<ConnectorRegistry, "managed">;
}) {
  const { prisma } = deps;
  async function enqueue(userId: string) {
    await deps.jobs.enqueue({
      name: "account.delete",
      payload: { userId },
      replaceKey: `account-delete:${userId}`,
    });
  }
  async function reconcile() {
    await reconcileComputerProvisions(deps);
    const rows = await prisma.accountDeletion.findMany({
      where: {
        nextAttemptAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
      },
      orderBy: { nextAttemptAt: "asc" },
      take: 100,
      select: { userId: true },
    });
    await Promise.all(rows.map(({ userId }) => enqueue(userId)));
  }
  async function process(userId: string) {
    const claimId = randomUUID();
    const claimed = await prisma.accountDeletion.updateMany({
      where: {
        userId,
        nextAttemptAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
      },
      data: {
        claimId,
        leaseUntil: new Date(Date.now() + leaseMs),
        attempts: { increment: 1 },
        errorCode: null,
      },
    });
    if (!claimed.count) return;
    const fence = { userId, claimId };
    const stopped = new AbortController();
    let heartbeat: Promise<void> | undefined;
    const renew = async () => {
      stopped.signal.throwIfAborted();
      if (
        !(
          await prisma.accountDeletion.updateMany({
            where: fence,
            data: { leaseUntil: new Date(Date.now() + leaseMs) },
          })
        ).count
      )
        throw new Error("Account deletion claim expired");
    };
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = renew()
        .catch(() => stopped.abort())
        .finally(() => {
          heartbeat = undefined;
        });
    }, 30_000);
    timer.unref?.();
    const context = (spaceId: string) => ({
      userId,
      spaceId,
      operationId: `account-delete:${userId}`,
      traceId: `account-delete:${userId}`,
      signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(60_000)]),
    });
    try {
      await reconcileComputerProvisions(deps, userId);
      // The deletion request recorded its tombstone under the user lifecycle lock,
      // preventing new reservations. Give existing bounded calls time to record their result
      // before revoking credentials or cascading their encrypted recovery state.
      if (
        (await prisma.computerProvision.count({ where: { userId } })) ||
        (await prisma.customerPurchase.count({
          where: {
            ...inFlightCustomerPurchases(),
            OR: [{ conversation: { channel: { userId } } }, { connection: { userId } }],
          },
        }))
      ) {
        await prisma.accountDeletion.updateMany({
          where: fence,
          data: {
            claimId: null,
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 30_000),
          },
        });
        return;
      }
      if (
        !(await cleanupAccountCloudAgents(
          {
            prisma,
            jobs: deps.jobs,
            cloudAgent: deps.cloudAgent,
            // Account deletion has detached its cards; only cleanup state is retained.
            events: { notify: async () => undefined },
          },
          userId,
        ))
      ) {
        await prisma.accountDeletion.updateMany({
          where: fence,
          data: { claimId: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + 30_000) },
        });
        return;
      }
      await deps.integrations.removeUserAccounts(userId, stopped.signal);
      // Capture before marking revoked; a crash cannot discard the remote identity.
      const connections = await prisma.connection.findMany({ where: { userId } });
      for (const connection of connections) {
        await renew();
        await prisma.$transaction(async (tx) => {
          await lockProviderConnectionScope(
            tx,
            connection,
            connection.connectorId,
            connection.provider,
          );
          await lockClaim(tx, userId, claimId);
          const row = await tx.connection.findUnique({ where: { id: connection.id } });
          if (!row) return;
          await tx.accountDeletionResource.createMany({
            data: [
              {
                userId,
                kind: "connection",
                spaceId: row.spaceId,
                key: row.id,
                providerKind: row.connectorId,
                providerRef: row.providerRef || row.provider,
              },
            ],
            skipDuplicates: true,
          });
          await tx.connection.update({ where: { id: row.id }, data: { status: "revoked" } });
        });
      }
      for (const resource of await prisma.accountDeletionResource.findMany({
        where: { userId, kind: "connection" },
      })) {
        await renew();
        const connector = resource.providerKind && deps.connectors.managed(resource.providerKind);
        if (!connector || !resource.providerRef)
          throw new Error("Connector unavailable during cleanup");
        await connector.revoke(resource.providerRef, context(resource.spaceId));
        await prisma.$transaction(async (tx) => {
          await lockClaim(tx, userId, claimId);
          await tx.connection.deleteMany({ where: { id: resource.key, userId } });
          await tx.accountDeletionResource.deleteMany({
            where: { userId, kind: resource.kind, spaceId: resource.spaceId, key: resource.key },
          });
        });
      }
      const bots = await prisma.bot.findMany({ where: { userId } });
      for (const bot of bots) {
        await renew();
        // destroyBot records file/computer identities in the same transaction as
        // deleting bot rows. Its best-effort side effects cannot lose this work.
        await destroyBot(
          deps,
          bot,
          { ...context(bot.spaceId), botId: bot.id },
          { deleteMemories: true },
        );
      }
      await deps.reconcileCustomerPublications?.(userId);
      if (await prisma.customerPublication.count({ where: { userId } })) {
        await prisma.accountDeletion.updateMany({
          where: fence,
          data: {
            claimId: null,
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 30_000),
            errorCode: "customer_runtime_cleanup_pending",
          },
        });
        return;
      }
      const organizations = await prisma.accountDeletionResource.findMany({
        where: { userId, kind: "organization" },
      });
      for (const organization of organizations) {
        const spaces = await prisma.space.findMany({ where: { organizationId: organization.key } });
        for (const space of spaces) {
          await renew();
          await deps.knowledge.purge(space.id, stopped.signal);
        }
        await renew();
        await prisma.$transaction(async (tx) => {
          await lockClaim(tx, userId, claimId);
          await captureResources(
            tx,
            userId,
            { space: { organizationId: organization.key } },
            { space: { organizationId: organization.key } },
            { space: { organizationId: organization.key } },
          );
          // The membership trigger prevents joining after the original claim.
          if (
            await tx.member.count({
              where: { organizationId: organization.key, userId: { not: userId } },
            })
          )
            throw new Error("Organization membership changed");
          await tx.organization.deleteMany({ where: { id: organization.key } });
          await tx.accountDeletionResource.deleteMany({
            where: { userId, kind: "organization", key: organization.key },
          });
        });
      }
      await prisma.$transaction(async (tx) => {
        await lockClaim(tx, userId, claimId);
        // Group artifacts and team computers in surviving Spaces belong to the team.
        const artifacts = { userId, groupId: null };
        const computers = { userId, scope: "dedicated" };
        await captureResources(tx, userId, artifacts, computers, { userId });
        await tx.artifact.deleteMany({ where: artifacts });
        await tx.computer.deleteMany({ where: computers });
      });
      const resources = await prisma.accountDeletionResource.findMany({ where: { userId } });
      for (const resource of resources) {
        await renew();
        if (resource.kind === "artifact") {
          await deps.artifacts.remove(resource.key, context(resource.spaceId));
        } else if (resource.kind === "computer") {
          if (resource.providerRef) {
            await deps.sandbox.destroy(
              toComputerRef({
                homeKey: resource.key,
                kind: resource.providerKind!,
                providerRef: resource.providerRef,
              }),
              context(resource.spaceId),
            );
          }
          await rm(resolveAgentHomePath(deps.home, resource.key, deps.dataDir), {
            recursive: true,
            force: true,
          });
        } else throw new Error("Unknown account cleanup resource");
        await prisma.$transaction(async (tx) => {
          await lockClaim(tx, userId, claimId);
          await tx.accountDeletionResource.deleteMany({
            where: { userId, kind: resource.kind, spaceId: resource.spaceId, key: resource.key },
          });
        });
      }
      await renew();
      await removePiUserSessions(deps.dataDir, userId);
      await deletePushToken(deps.dataDir, userId);
      await prisma.$transaction(async (tx) => {
        await lockClaim(tx, userId, claimId);
        await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
        await claimAccountOrganizations(tx, userId);
        if (await tx.accountDeletionResource.count({ where: { userId, kind: "organization" } })) {
          // Another member may have left since the initial request. Persist the
          // newly private organization, then let the next pass clean it too.
          await tx.accountDeletion.update({
            where: { userId },
            data: { claimId: null, leaseUntil: null, nextAttemptAt: new Date() },
          });
          return;
        }
        if (
          (await tx.bot.count({ where: { userId } })) ||
          (await tx.botDeletion.count({
            where: {
              userId,
              OR: [{ artifactKeys: { isEmpty: false } }, { homeKey: { not: null } }],
            },
          })) ||
          (await tx.connection.count({ where: { userId } })) ||
          (await tx.cloudAgent.count({ where: { userId } })) ||
          (await tx.accountDeletionResource.count({ where: { userId } }))
        )
          throw new Error("Account cleanup still pending");
        await tx.deploymentSettings.updateMany({
          where: { ownerUserId: userId },
          data: { ownerUserId: null },
        });
        await tx.messagingIdentity.deleteMany({ where: { userId } });
        await tx.gatewayRuntime.deleteMany({ where: { userId } });
        await tx.accountDeletion.delete({ where: { userId } });
        await tx.user.delete({ where: { id: userId } });
      });
    } catch {
      // Never store provider error bodies, credentials or paths in deletion status.
      const row = await prisma.accountDeletion.findFirst({ where: fence });
      if (!row) return;
      await prisma.accountDeletion.updateMany({
        where: fence,
        data: {
          claimId: null,
          leaseUntil: null,
          errorCode: "cleanup_failed",
          nextAttemptAt: new Date(
            Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts - 1, 7)),
          ),
        },
      });
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
  }
  return { enqueue, process, reconcile };
}

async function lockClaim(tx: Prisma.TransactionClient, userId: string, claimId: string) {
  const rows = await tx.$queryRaw<Array<{ userId: string }>>`
    SELECT "userId" FROM account_deletions WHERE "userId" = ${userId} AND "claimId" = ${claimId} FOR UPDATE
  `;
  if (!rows.length) throw new Error("Account deletion claim expired");
}

async function captureResources(
  tx: Prisma.TransactionClient,
  userId: string,
  artifactWhere: Prisma.ArtifactWhereInput,
  computerWhere: Prisma.ComputerWhereInput,
  botDeletionWhere: Prisma.BotDeletionWhereInput,
) {
  const artifacts = await tx.artifact.findMany({ where: artifactWhere });
  const computers = await tx.computer.findMany({ where: computerWhere });
  const botDeletions = await tx.botDeletion.findMany({ where: botDeletionWhere });
  await tx.accountDeletionResource.createMany({
    data: [
      ...botDeletions.flatMap((bot) => [
        ...bot.artifactKeys.map((key) => ({ userId, kind: "artifact", spaceId: bot.spaceId, key })),
        ...(bot.homeKey
          ? [
              {
                userId,
                kind: "computer",
                spaceId: bot.spaceId,
                key: bot.homeKey,
                providerKind: bot.computerKind,
                providerRef: bot.providerRef,
              },
            ]
          : []),
      ]),
      ...artifacts.map((artifact) => ({
        userId,
        kind: "artifact",
        spaceId: artifact.spaceId,
        key: artifact.storageKey,
      })),
      ...computers.map((computer) => ({
        userId,
        kind: "computer",
        spaceId: computer.spaceId,
        key: computer.homeKey,
        providerKind: computer.kind,
        providerRef: computer.providerRef,
      })),
    ],
    skipDuplicates: true,
  });
  await tx.botDeletion.updateMany({
    where: { id: { in: botDeletions.map((bot) => bot.id) } },
    data: { artifactKeys: [], homeKey: null, computerKind: null, providerRef: null },
  });
}
