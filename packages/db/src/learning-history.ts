import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { LearningHistoryListInput, LearningHistoryStartInput } from "@rakazo/contracts";
import { learningImportRows } from "@rakazo/core";
import type { LearningHistory, PrismaClient } from "./client.js";
import { requireLearningAccess } from "./learning-access.js";
import { requireLearningHistory } from "./learning-history-access.js";
import { requireLearningSource } from "./learning-sources.js";
import { connectionAccessWhere, IsolationError } from "./scope.js";

type ActorScope = Pick<Actor, "spaceId" | "userId">;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function progress(history: LearningHistory) {
  return {
    id: history.id,
    sourceId: history.importId,
    scope: history.scope,
    source: history.connectionId
      ? { kind: "connection", connectionId: history.connectionId }
      : { kind: "export", key: history.exportKey },
    status: history.status,
    processed: history.nextRow,
    accepted: history.accepted,
    skipped: history.skipped,
    duplicates: history.duplicates,
    earliest: history.earliest?.toISOString() ?? null,
    latest: history.latest?.toISOString() ?? null,
    errors: history.errors,
    error: history.error,
    completedAt: history.completedAt?.toISOString() ?? null,
  };
}

/** Each page commits evidence, duplicate markers and progress together, without external IO. */
export function createLearningHistory(prisma: PrismaClient) {
  return {
    async start(actor: ActorScope, botId: string, raw: unknown) {
      const input = LearningHistoryStartInput.parse(raw);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        const canEditSpace = await requireLearningAccess(tx, actor, botId);
        if (input.scope === "space" && !canEditSpace) throw new IsolationError();
        await requireLearningSource(tx, actor, { kind: "import", id: input.sourceId });
        const archive = await tx.learningImport.findUniqueOrThrow({
          where: { id: input.sourceId },
        });
        if (archive.botId !== botId || archive.feedId) throw new IsolationError();
        const connection =
          input.source.kind === "connection"
            ? await tx.connection.findFirst({
                where: {
                  ...connectionAccessWhere(actor),
                  id: input.source.connectionId,
                  status: "connected",
                },
              })
            : null;
        if (input.source.kind === "connection" && !connection?.providerRef)
          throw new IsolationError();
        if (connection && archive.windowEnd.getTime() !== connection.createdAt.getTime())
          throw new Error(
            "Use the connection creation timestamp as windowEnd before archiving this history.",
          );
        const sourceKey = digest(
          JSON.stringify(
            input.source.kind === "connection"
              ? ["connection", connection!.id, connection!.providerRef]
              : ["export", input.source.key.normalize("NFC")],
          ),
        );
        const previous = await tx.learningHistory.findUnique({ where: { importId: archive.id } });
        if (previous && (previous.sourceKey !== sourceKey || previous.scope !== input.scope))
          throw new Error(
            "This history already has an approved source and scope. They cannot change on resume.",
          );
        const history =
          previous ??
          (await tx.learningHistory.create({
            data: {
              importId: archive.id,
              scope: input.scope,
              sourceKey,
              exportKey: input.source.kind === "export" ? input.source.key.normalize("NFC") : null,
              connectionId: connection?.id,
              connectionOwnerId: connection?.userId,
              providerRef: connection?.providerRef,
            },
          }));
        await requireLearningHistory(tx, actor, history, botId);
        return progress(
          history.status === "failed"
            ? await tx.learningHistory.update({
                where: { id: history.id },
                data: {
                  status: "queued",
                  error: null,
                  summarizedAt: null,
                },
              })
            : history,
        );
      });
    },
    async list(actor: ActorScope, botId: string, raw: unknown = {}) {
      const { cursor } = LearningHistoryListInput.parse(raw);
      await requireLearningAccess(prisma, actor, botId);
      const owned = { import: { ...actor, botId } };
      if (cursor && !(await prisma.learningHistory.count({ where: { ...owned, id: cursor } })))
        throw new IsolationError();
      const histories = await prisma.learningHistory.findMany({
        where: owned,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 101,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { import: { select: { label: true, windowEnd: true, withdrawnAt: true } } },
      });
      return {
        items: histories.slice(0, 100).map((history) => ({
          ...progress(history),
          label: history.import.label,
          windowEnd: history.import.windowEnd.toISOString(),
          withdrawn: !!history.import.withdrawnAt,
        })),
        nextCursor: histories.length > 100 ? histories[99]!.id : null,
      };
    },
    due() {
      return prisma.learningHistory.findMany({
        where: {
          status: "queued",
          import: { withdrawnAt: null, bot: { archivedAt: null, learningEnabled: true } },
        },
        orderBy: { updatedAt: "asc" },
        take: 100,
        select: { id: true },
      });
    },
    async process(id: string) {
      const initial = await prisma.learningHistory.findUnique({
        where: { id },
        include: { import: true },
      });
      if (initial?.status !== "queued") return;
      let attemptVersion = initial.updatedAt;
      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${initial.import.spaceId} FOR UPDATE`;
            const history = await tx.learningHistory.findUnique({
              where: { id },
              include: { import: { include: { bot: true } } },
            });
            if (history?.status !== "queued") return;
            attemptVersion = history.updatedAt;
            const archive = history.import;
            if (!archive.bot.learningEnabled) return;
            const actor = { spaceId: archive.spaceId, userId: archive.userId };
            await requireLearningSource(tx, actor, { kind: "import", id: archive.id });
            const rows = learningImportRows({
              botId: archive.botId,
              format: archive.format,
              content: archive.content,
              mapping: archive.mapping ?? undefined,
              timezoneOffset: archive.timezoneOffset ?? undefined,
              source: archive.label,
              windowEnd: archive.windowEnd.toISOString(),
            });
            const end = Math.min(rows.length, history.nextRow + 100);
            let accepted = history.accepted,
              skipped = history.skipped,
              duplicates = history.duplicates;
            let earliest = history.earliest,
              latest = history.latest;
            const errors = [...history.errors];
            let batch: Array<{ sentAt: string; text: string }> = [];
            let batchIndex = 0;
            const flush = async () => {
              if (!batch.length) return;
              await tx.learningTask.create({
                data: {
                  ...actor,
                  botId: archive.botId,
                  importId: archive.id,
                  sourceKey: `history:${id}:${history.nextRow}:${batchIndex++}`,
                  evidence: { replies: batch },
                },
              });
              batch = [];
            };
            for (const { reply, error } of rows.slice(history.nextRow, end)) {
              if (!reply) {
                skipped++;
                if (error && errors.length < 20) errors.push(error);
                continue;
              }
              const inserted = await tx.learningHistoryItem.createMany({
                skipDuplicates: true,
                data: {
                  botId: archive.botId,
                  sourceKey: history.sourceKey,
                  identity: digest(
                    JSON.stringify([reply.threadId, reply.messageId ?? reply.sentAt]),
                  ),
                  digest: digest(reply.text),
                },
              });
              if (!inserted.count) {
                duplicates++;
                continue;
              }
              // Source identifiers stay in the original archive, outside model evidence.
              const evidence = { sentAt: reply.sentAt, text: reply.text };
              if (JSON.stringify([...batch, evidence]).length > 14000) await flush();
              batch.push(evidence);
              accepted++;
              const at = new Date(reply.sentAt);
              if (!earliest || at < earliest) earliest = at;
              if (!latest || at > latest) latest = at;
            }
            await flush();
            await tx.learningHistory.update({
              where: { id },
              data: {
                nextRow: end,
                accepted,
                skipped,
                duplicates,
                earliest,
                latest,
                errors,
                status: end === rows.length ? "complete" : "queued",
                completedAt: end === rows.length ? new Date() : null,
                summarizedAt: null,
              },
            });
          },
          { timeout: 15000 },
        );
      } catch {
        // No provider, archive contents or customer details in operational error messages.
        await prisma.learningHistory.updateMany({
          where: { id, status: "queued", updatedAt: attemptVersion },
          data: {
            status: "failed",
            error:
              "History import stopped. Check source access and the export, then explicitly resume.",
            summarizedAt: null,
          },
        });
      }
    },
  };
}
