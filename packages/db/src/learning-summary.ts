import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Daily, non-urgent summaries are durable staff messages, never customer messages. */
export async function publishLearningSummaries(prisma: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - 86400000);
  const statuses = ["applied", "review", "failed"];
  const bots = await prisma.bot.findMany({
    where: {
      archivedAt: null,
      AND: [
        {
          OR: [
            {
              learningImports: {
                some: { history: { status: { in: ["complete", "failed"] }, summarizedAt: null } },
              },
            },
            { learningTasks: { some: { status: { in: statuses }, summarizedAt: null } } },
            {
              learningFeeds: { some: { enabled: true, error: { not: null }, summarizedAt: null } },
            },
          ],
        },
      ],
      OR: [{ learningSummaryAt: null }, { learningSummaryAt: { lte: cutoff } }],
    },
    orderBy: { id: "asc" },
    take: 100,
    select: { id: true, spaceId: true },
  });
  for (const { id, spaceId } of bots)
    await withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Imports lock the Space before inserting rows that reference the bot.
          // Use the same order before publishing messages that reference the Space.
          await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${spaceId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM bots WHERE id = ${id} FOR UPDATE`;
          const bot = await tx.bot.findUniqueOrThrow({ where: { id }, include: { thread: true } });
          if (
            !bot.thread ||
            bot.thread.groupId ||
            bot.thread.userId !== bot.userId ||
            bot.archivedAt ||
            (bot.learningSummaryAt && bot.learningSummaryAt > cutoff)
          )
            return;
          if (
            !(await tx.spaceMember.count({ where: { spaceId: bot.spaceId, userId: bot.userId } }))
          )
            return;
          if (await tx.accountDeletion.count({ where: { userId: bot.userId } })) return;
          const tasks = await tx.learningTask.findMany({
            where: {
              botId: id,
              userId: bot.userId,
              spaceId: bot.spaceId,
              status: { in: statuses },
              summarizedAt: null,
            },
            orderBy: { createdAt: "asc" },
            take: 500,
            select: { id: true, status: true },
          });
          const feeds = await tx.learningFeed.findMany({
            where: {
              botId: id,
              enabled: true,
              error: { not: null },
              summarizedAt: null,
            },
            select: { id: true },
          });
          const histories = await tx.learningHistory.findMany({
            where: {
              import: { botId: id },
              status: { in: ["complete", "failed"] },
              summarizedAt: null,
            },
            select: { id: true, status: true, accepted: true, skipped: true, duplicates: true },
            orderBy: { createdAt: "asc" },
            take: 100,
          });
          if (!tasks.length && !feeds.length && !histories.length) return;
          const historySummary = histories.length
            ? `\n\nReply imports: ${histories.reduce((sum, item) => sum + item.accepted, 0)} accepted · ${histories.reduce((sum, item) => sum + item.skipped, 0)} skipped · ${histories.reduce((sum, item) => sum + item.duplicates, 0)} duplicates · ${histories.filter((item) => item.status === "failed").length} stopped. Coverage is limited to the supplied exports.`
            : "";
          const count = (status: string) => tasks.filter((task) => task.status === status).length;
          const blocks: MessageBlock[] = [
            {
              kind: "text",
              text: `Learning update\n\n${count("applied")} applied · ${count("review")} need review · ${count("failed")} could not finish${feeds.length ? ` · ${feeds.length} source refreshes need attention` : ""}${historySummary}`,
            },
          ];
          if (tasks.length)
            blocks.push({
              kind: "learning_updates",
              botId: id,
              taskIds: tasks.map((task) => task.id),
            });
          const message = await createThreadMessageInTransaction(tx, {
            threadId: bot.thread.id,
            botId: id,
            role: "bot",
            blocks,
          });
          await appendEventInTransaction(tx, {
            spaceId: bot.spaceId,
            threadId: bot.thread.id,
            botId: id,
            type: "thread.message.created",
            payload: { messageId: message.id, role: "bot", blocks },
          });
          await tx.learningTask.updateMany({
            where: { id: { in: tasks.map((task) => task.id) } },
            data: { summarizedAt: now },
          });
          await tx.learningFeed.updateMany({
            where: { id: { in: feeds.map((feed) => feed.id) } },
            data: { summarizedAt: now },
          });
          await tx.learningHistory.updateMany({
            where: { id: { in: histories.map((history) => history.id) } },
            data: { summarizedAt: now },
          });
          await tx.bot.update({ where: { id }, data: { learningSummaryAt: now } });
        },
        { isolationLevel: "Serializable" },
      ),
    );
}
