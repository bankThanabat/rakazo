import type { PrismaClient } from "@rakazo/db";
import { buildApprovalAskBlock } from "../../../adapters/src/approval-ask.js";

/** A pending synthetic card. Provider dispatch is covered by the executor integration suite. */
export async function semanticApprovalFixture(
  prisma: PrismaClient,
  email: string,
  variant: "semantic" | "document" = "semantic",
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const bot = await prisma.bot.findFirstOrThrow({ where: { userId: user.id, archivedAt: null } });
  const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
  const content =
    `Start of full fact.\n${"Use metric units.\n".repeat(600)}`.slice(0, 9982) +
    "\nEnd of full fact.";
  const document =
    `Start of full document.\n${"Keep the reviewed guidance.\n".repeat(4000)}`.slice(0, 99977) +
    "\nEnd of full document.";
  const toolName = variant === "document" ? "customer_learning_decide" : "memory_semantic_undo";
  const request =
    variant === "document"
      ? {
          taskId: "synthetic-learning",
          decision: "approve",
          reason: "Review the complete document",
          reviewedProposal: {
            native: {
              kind: "memory",
              scope: "bot",
              path: "reviewed.md",
              id: "synthetic-document",
              expectedRevision: 1,
              beforeContent: document.replace("Start", "Prior"),
              content: document,
            },
            supported: true,
            publicSafe: false,
            changesBusinessRules: false,
            conditions: "Private staff work",
            save: {
              botId: bot.id,
              scope: "bot",
              kind: "memory",
              key: "reviewed",
              title: "Reviewed guidance",
              content: "Use the reviewed correction",
              customerVisible: false,
              expectedRevision: 0,
              reason: "Staff correction",
              source: "Synthetic approved examples",
            },
          },
        }
      : {
          mutationId: "synthetic-removal",
          action: "restore",
          id: "synthetic-fact",
          entity: `rakazo:${bot.id}`,
          expectedContent: content,
          reason: "Restore the recorded preference",
          botId: bot.id,
          scope: "isolated",
          provider: "supermemory",
          configurationRevision: "synthetic:1",
        };
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        userId: user.id,
        threadId: thread.id,
        prompt: "Synthetic long memory review",
        status: "waiting_input",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        userId: user.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const effect = await tx.externalEffect.create({
      data: {
        spaceId: bot.spaceId,
        runId: run.id,
        kind: toolName,
        idempotencyKey: `synthetic:${run.id}`,
        status: "intended",
        request,
      },
    });
    const updated = await tx.thread.update({
      where: { id: thread.id },
      data: { nextMessageSeq: { increment: 1 } },
    });
    await tx.message.create({
      data: {
        threadId: thread.id,
        botId: bot.id,
        runId: run.id,
        role: "bot",
        seq: updated.nextMessageSeq - 1,
        blocks: [buildApprovalAskBlock(effect.id, effect.kind, request, [])],
      },
    });
  });
  return { botId: bot.id, request, toolName };
}
