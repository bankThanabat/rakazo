import { createHash, randomUUID } from "node:crypto";
import type {
  SocialLearningExecute,
  SocialLearningProvider,
  SocialLearningWindow,
} from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  LearningFeedConfigureInput,
  LearningFeedRefreshInput,
  LearningFeedRemoveInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, requireLearningAccess, requireLearningFeed } from "@rakazo/db";
import { z } from "zod";
import type { createCustomerConnector } from "./customer-connector.js";
import { instagramAccountHash } from "./instagram-comment-writes.js";

type Scope = Pick<Actor, "spaceId" | "userId">;
const hour = 3600000;
const evidenceLimit = 14000;
class LearningPaginationError extends Error {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scanCoverage = z.object({
  earliest: z.string().nullable().default(null),
  latest: z.string().nullable().default(null),
  replyEarliest: z.string().nullable().default(null),
  replyLatest: z.string().nullable().default(null),
  messageEarliest: z.string().nullable().default(null),
  messageLatest: z.string().nullable().default(null),
  reviewCandidates: z.number().int().nonnegative().default(0),
  unavailable: z.number().int().nonnegative().default(0),
  contextOnly: z.number().int().nonnegative().default(0),
  unverified: z.number().int().nonnegative().default(0),
  oversized: z.number().int().nonnegative().default(0),
  generated: z.number().int().nonnegative().default(0),
  uncertain: z.number().int().nonnegative().default(0),
  limitations: z.array(z.string()).default([]),
});
const visible = {
  id: true,
  connectionId: true,
  label: true,
  scope: true,
  enabled: true,
  includeReplies: true,
  includeMessages: true,
  coverage: true,
  revision: true,
  windowStart: true,
  windowEnd: true,
  cycle: true,
  lastCheckedAt: true,
  completedAt: true,
  nextAttemptAt: true,
  accepted: true,
  skipped: true,
  duplicates: true,
  error: true,
} as const;

/** One durable page per job. Provider I/O never occupies a database transaction. */
export function createSocialLearning(deps: {
  prisma: PrismaClient;
  connector: ReturnType<typeof createCustomerConnector>;
  provider: (
    name: string,
    execute: SocialLearningExecute,
    includeReplies: boolean,
    messages?: SocialLearningWindow,
  ) => SocialLearningProvider;
}) {
  const { prisma, connector } = deps;
  function provider(
    actor: Scope,
    connection: { id: string; provider: string; providerRef: string | null },
    includeReplies: boolean,
    accountId?: string,
    messages?: SocialLearningWindow,
  ) {
    return deps.provider(
      connection.provider,
      (action, input) =>
        connector.execute(
          actor,
          connection.id,
          action,
          input,
          `learning:${randomUUID()}`,
          "staff",
          "read",
          connection.providerRef!,
          undefined,
          accountId,
        ),
      includeReplies,
      messages,
    );
  }
  async function owned(actor: Scope, botId: string, id: string) {
    await requireLearningAccess(prisma, actor, botId);
    return prisma.learningFeed.findFirstOrThrow({
      where: { id, botId, spaceId: actor.spaceId, userId: actor.userId },
    });
  }
  return {
    async list(actor: Scope, botId: string) {
      await requireLearningAccess(prisma, actor, botId);
      return prisma.learningFeed.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, botId },
        select: visible,
        orderBy: { createdAt: "asc" },
      });
    },
    async configure(actor: Scope, botId: string, raw: unknown) {
      const input = LearningFeedConfigureInput.parse(raw);
      const canEdit = await requireLearningAccess(prisma, actor, botId);
      if (input.scope === "space" && !canEdit) throw new IsolationError();
      // Pausing still works after disconnect, without contacting the provider.
      const connection = input.enabled
        ? await connector.connection(actor, input.connectionId)
        : null;
      const adapter = connection
        ? provider(
            actor,
            connection,
            input.includeReplies,
            undefined,
            input.includeMessages
              ? {
                  start: new Date(connection.createdAt.getTime() - 30 * 86400000).toISOString(),
                  end: connection.createdAt.toISOString(),
                }
              : undefined,
          )
        : null;
      if (adapter) await connector.validateWorkflow(actor, input.connectionId, adapter.actions);
      const identity = adapter ? await adapter.identity() : null;
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        const canEditSpace = await requireLearningAccess(tx, actor, botId);
        if (input.scope === "space" && !canEditSpace) throw new IsolationError();
        const existing = await tx.learningFeed.findUnique({
          where: { botId_connectionId: { botId, connectionId: input.connectionId } },
        });
        if ((existing?.revision ?? 0) !== input.expectedRevision)
          throw new Error("Learning source changed. Inspect it again.");
        if (!input.enabled) {
          if (!existing || existing.userId !== actor.userId) throw new IsolationError();
          return tx.learningFeed.update({
            where: { id: existing.id },
            data: {
              enabled: false,
              revision: { increment: 1 },
              leaseToken: null,
              leaseUntil: null,
            },
            select: visible,
          });
        }
        if (!connection || !identity || !connection.providerRef) throw new IsolationError();
        if (
          existing &&
          (existing.userId !== actor.userId ||
            existing.providerRef !== connection.providerRef ||
            existing.accountId !== identity.id)
        )
          throw new Error(
            "The linked account changed. Remove this learning source before adding the new account.",
          );
        const now = new Date();
        const data = {
          scope: input.scope,
          enabled: true,
          includeReplies: input.includeReplies,
          includeMessages: input.includeMessages,
          coverage: scanCoverage.parse({}),
          label: identity.label,
          cursor: null,
          visitedCursors: [],
          // An opted-in message import starts with the fixed pre-connection window.
          // Later completed-scan refreshes advance the end for continued learning.
          windowEnd: input.includeMessages ? connection.createdAt : now,
          nextAttemptAt: now,
          completedAt: null,
          error: null,
          leaseToken: null,
          leaseUntil: null,
          accepted: 0,
          skipped: 0,
          duplicates: 0,
        };
        const feed = existing
          ? await tx.learningFeed.update({
              where: { id: existing.id },
              data: { ...data, revision: { increment: 1 }, cycle: { increment: 1 } },
            })
          : await tx.learningFeed.create({
              data: {
                ...data,
                spaceId: actor.spaceId,
                userId: actor.userId,
                botId,
                connectionId: connection.id,
                providerRef: connection.providerRef,
                accountId: identity.id,
                windowStart: new Date(connection.createdAt.getTime() - 30 * 86400000),
              },
            });
        // Checks current connection binding, membership and deletion tombstones under locks.
        await requireLearningFeed(tx, actor, feed.id);
        return tx.learningFeed.findUniqueOrThrow({ where: { id: feed.id }, select: visible });
      });
    },
    async refresh(actor: Scope, botId: string, raw: unknown) {
      const { id } = LearningFeedRefreshInput.parse(raw);
      await owned(actor, botId, id);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        await requireLearningFeed(tx, actor, id);
        // A running page retains its lease and cursor. Reconciliation will resume it.
        await tx.learningFeed.update({ where: { id }, data: { nextAttemptAt: new Date() } });
        return { queued: true };
      });
    },
    async remove(actor: Scope, botId: string, raw: unknown) {
      const input = LearningFeedRemoveInput.parse(raw);
      await owned(actor, botId, input.id);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        await requireLearningAccess(tx, actor, botId);
        const result = await tx.learningFeed.deleteMany({
          where: {
            id: input.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            revision: input.expectedRevision,
          },
        });
        if (!result.count) throw new Error("Learning source changed. Inspect it again.");
        return { removed: true };
      });
    },
    async due() {
      return prisma.learningFeed.findMany({
        where: {
          enabled: true,
          bot: { archivedAt: null, learningEnabled: true },
          nextAttemptAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        select: { id: true },
        orderBy: { nextAttemptAt: "asc" },
        take: 100,
      });
    },
    async process(id: string) {
      const now = new Date();
      const token = randomUUID();
      const claimed = await prisma.learningFeed.updateMany({
        where: {
          id,
          enabled: true,
          bot: { archivedAt: null, learningEnabled: true },
          nextAttemptAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
        data: { leaseToken: token, leaseUntil: new Date(now.getTime() + 120000) },
      });
      if (!claimed.count) return;
      const feed = await prisma.learningFeed.findUnique({ where: { id } });
      if (!feed || feed.leaseToken !== token) return;
      const actor = { spaceId: feed.spaceId, userId: feed.userId };
      const owns = { id, revision: feed.revision, leaseToken: token };
      try {
        const authorized = await requireLearningFeed(prisma, actor, id);
        const restart = Boolean(feed.completedAt);
        const cursor = restart ? undefined : (feed.cursor ?? undefined);
        const windowEnd = restart ? now : feed.windowEnd;
        const adapter = provider(
          actor,
          authorized.connection,
          feed.includeReplies,
          feed.accountId,
          feed.includeMessages
            ? { start: feed.windowStart.toISOString(), end: windowEnd.toISOString() }
            : undefined,
        );
        const identity = await adapter.identity();
        if (identity.id !== feed.accountId) throw new IsolationError();
        const visited = restart ? [] : feed.visitedCursors;
        const page = await adapter.page(cursor);
        // Reauthorization can replace remote credentials without changing our local reference.
        if ((await adapter.identity()).id !== feed.accountId) throw new IsolationError();
        if (page.nextCursor && visited.includes(hash(page.nextCursor)))
          throw new LearningPaginationError(
            "Source pagination repeated. Coverage is partial. Review this source.",
          );
        if (page.nextCursor && visited.length >= 1000)
          throw new LearningPaginationError(
            "Source scan reached its page limit. Coverage is partial. Review this source.",
          );
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
          if (
            !(await tx.learningFeed.count({
              where: {
                ...owns,
                leaseUntil: { gt: new Date() },
                bot: { learningEnabled: true, archivedAt: null },
              },
            }))
          )
            return;
          await requireLearningFeed(tx, actor, id);
          let accepted = 0;
          let skipped = page.skipped;
          let duplicates = 0;
          const coverage = scanCoverage.parse(restart ? {} : feed.coverage);
          coverage.unverified += page.unverified ?? 0;
          coverage.unavailable += page.unavailable ?? 0;
          coverage.contextOnly += page.contextOnly ?? 0;
          coverage.limitations = [
            ...new Set([...coverage.limitations, ...(page.limitations ?? [])]),
          ];
          const replyIds =
            authorized.connection.provider === "instagram"
              ? page.posts
                  .filter((post) => post.parentId && post.id.startsWith("instagram-reply:"))
                  .map((post) => post.id.slice("instagram-reply:".length))
              : [];
          // Verified account receipts match across Spaces and aliases. Legacy receipts cannot
          // be assigned a historical account, so they retain their conservative Space-wide hold.
          const accountWrites = {
            AND: [
              {
                OR: [
                  { action: null },
                  { action: { in: ["instagram.create_comment", "instagram.reply_to_comment"] } },
                ],
              },
            ],
            OR: [
              { accountHash: instagramAccountHash(feed.accountId) },
              { spaceId: actor.spaceId, accountHash: null },
            ],
          };
          const writes = replyIds.length
            ? await tx.instagramSend.findMany({
                where: { ...accountWrites, externalId: { in: replyIds } },
                select: { externalId: true },
              })
            : [];
          const generated = new Set(writes.map((write) => write.externalId));
          const uncertain = replyIds.length
            ? Boolean(
                await tx.instagramSend.findFirst({
                  where: { ...accountWrites, externalId: null },
                  select: { id: true },
                }),
              )
            : false;
          const messageIds =
            authorized.connection.provider === "instagram"
              ? page.posts
                  .filter((post) => post.id.startsWith("instagram-message:"))
                  .map((post) => post.id.slice("instagram-message:".length))
              : [];
          const messageWrites = {
            action: "instagram.send_message",
            OR: [
              { accountHash: instagramAccountHash(feed.accountId) },
              { spaceId: actor.spaceId, accountHash: null },
            ],
          };
          const generatedMessages = new Set(
            messageIds.length
              ? (
                  await tx.instagramSend.findMany({
                    where: { ...messageWrites, externalId: { in: messageIds } },
                    select: { externalId: true },
                  })
                ).map((row) => row.externalId)
              : [],
          );
          const uncertainMessages = messageIds.length
            ? Boolean(
                await tx.instagramSend.findFirst({
                  where: { ...messageWrites, externalId: null },
                  select: { id: true },
                }),
              )
            : false;
          const needsReview = page.reviewRequired || messageIds.length > 0;
          let batch: typeof page.posts = [];
          let length = 2;
          async function flush() {
            if (!batch.length) return;
            const content = JSON.stringify(batch);
            const times = batch.map((post) => post.publishedAt).sort();
            const archive = await tx.learningImport.create({
              data: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                botId: feed!.botId,
                feedId: id,
                feedRevision: feed!.revision,
                digest: hash(`${id}:${content}`),
                label: feed!.label,
                format: "json",
                content,
                windowEnd,
                coverage: {
                  accepted: batch.length,
                  skipped: 0,
                  duplicates: 0,
                  earliest: times[0],
                  latest: times.at(-1),
                  errors: [],
                },
              },
            });
            await tx.learningTask.create({
              data: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                botId: feed!.botId,
                importId: archive.id,
                sourceKey: hash(`social:${archive.id}`),
                evidence: {
                  posts: batch,
                  ...(needsReview
                    ? {
                        reviewRequired: true,
                        authorship:
                          "Instagram identifies the business account, not human staff. Review original messages before approving any suggestion.",
                      }
                    : {}),
                },
              },
            });
            batch = [];
            length = 2;
          }
          for (const post of page.posts) {
            const at = Date.parse(post.publishedAt);
            if (
              !Number.isFinite(at) ||
              at < feed.windowStart.getTime() ||
              at > windowEnd.getTime()
            ) {
              skipped++;
              continue;
            }
            const isMessage = post.id.startsWith("instagram-message:");
            if (
              isMessage &&
              (generatedMessages.has(post.id.slice("instagram-message:".length)) ||
                uncertainMessages)
            ) {
              skipped++;
              if (generatedMessages.has(post.id.slice("instagram-message:".length)))
                coverage.generated++;
              else {
                coverage.uncertain++;
                const limitation =
                  "Message examples are held while a send for this account, or a send with unknown account identity in this Space, has an uncertain outcome.";
                if (!coverage.limitations.includes(limitation))
                  coverage.limitations.push(limitation);
              }
              continue;
            }
            if (post.parentId && post.id.startsWith("instagram-reply:")) {
              if (generated.has(post.id.slice("instagram-reply:".length))) {
                skipped++;
                coverage.generated++;
                continue;
              }
              if (uncertain) {
                skipped++;
                coverage.uncertain++;
                const limitation =
                  "Reply examples are held while a send for this account, or a send with unknown account identity in this Space, has an uncertain outcome.";
                if (!coverage.limitations.includes(limitation))
                  coverage.limitations.push(limitation);
                continue;
              }
            }
            const size = JSON.stringify(post).length;
            if (size + 2 > evidenceLimit) {
              skipped++;
              coverage.oversized++;
              continue;
            }
            if (!coverage.earliest || post.publishedAt < coverage.earliest)
              coverage.earliest = post.publishedAt;
            if (!coverage.latest || post.publishedAt > coverage.latest)
              coverage.latest = post.publishedAt;
            if (post.parentId) {
              if (!coverage.replyEarliest || post.publishedAt < coverage.replyEarliest)
                coverage.replyEarliest = post.publishedAt;
              if (!coverage.replyLatest || post.publishedAt > coverage.replyLatest)
                coverage.replyLatest = post.publishedAt;
            }
            if (isMessage) {
              if (!coverage.messageEarliest || post.publishedAt < coverage.messageEarliest)
                coverage.messageEarliest = post.publishedAt;
              if (!coverage.messageLatest || post.publishedAt > coverage.messageLatest)
                coverage.messageLatest = post.publishedAt;
            }
            const marker = await tx.learningFeedItem.createMany({
              skipDuplicates: true,
              data: {
                feedId: id,
                externalId: post.id,
                digest: hash(post.text),
              },
            });
            if (!marker.count) {
              duplicates++;
              continue;
            }
            if (length + size + (batch.length ? 1 : 0) > evidenceLimit) await flush();
            length += size + (batch.length ? 1 : 0);
            batch.push(post);
            accepted++;
            if (needsReview) coverage.reviewCandidates++;
          }
          await flush();
          await tx.learningFeed.update({
            where: { id },
            data: {
              cursor: page.nextCursor,
              coverage,
              visitedCursors: page.nextCursor ? [...visited, hash(page.nextCursor)] : [],
              windowEnd,
              cycle: { increment: restart ? 1 : 0 },
              completedAt: page.nextCursor ? null : now,
              lastCheckedAt: now,
              nextAttemptAt: new Date(
                Date.now() + (page.nextCursor ? (feed.includeMessages ? 1000 : 0) : hour),
              ),
              accepted: restart ? accepted : { increment: accepted },
              skipped: restart ? skipped : { increment: skipped },
              duplicates: restart ? duplicates : { increment: duplicates },
              error: null,
              summarizedAt: null,
              leaseToken: null,
              leaseUntil: null,
            },
          });
        });
      } catch (error) {
        await prisma.learningFeed.updateMany({
          where: owns,
          data: {
            // A failed read can mean revoked remote access. Never retain DM text
            // buffered in a cursor after an error whose cause we cannot verify.
            // Retry the same approved window; committed batches retain their markers.
            ...(feed.includeMessages
              ? {
                  cursor: null,
                  visitedCursors: [],
                  coverage: {
                    ...scanCoverage.parse(feed.coverage),
                    limitations: [
                      ...new Set([
                        ...scanCoverage.parse(feed.coverage).limitations,
                        "A failed page cleared temporary message text. Retrying restarts this scan within its approved window; skipped and context counts may include rereads.",
                      ]),
                    ],
                  },
                }
              : {}),
            error:
              error instanceof LearningPaginationError
                ? error.message
                : error instanceof IsolationError
                  ? "Source access was removed. Reconnect or remove this source."
                  : "Source refresh could not finish. Coverage is partial. Retry or review this connection.",
            nextAttemptAt: new Date(Date.now() + hour),
            summarizedAt: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });
      }
    },
  };
}
