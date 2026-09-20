import { LearningTaskProposalSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createCustomerInbox,
  createLearning,
  prepareNativeLearning,
  publishLearningSummaries,
} from "@rakazo/db";

/** Repeatable synthetic source and full proposals; no hosted inference or customer sends. */
export async function learningReviewFixture(prisma: PrismaClient, email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const bot = await prisma.bot.findFirstOrThrow({ where: { userId: user.id, archivedAt: null } });
  const actor = { userId: user.id, spaceId: bot.spaceId };
  await prisma.bot.update({ where: { id: bot.id }, data: { learningEnabled: false } });
  const channel = await prisma.customerChannel.create({
    data: {
      ...actor,
      botId: bot.id,
      provider: "web",
      accountId: `review-${bot.id}`,
      name: "Synthetic sizing shop",
      ciphertext: "",
    },
  });
  const inbox = createCustomerInbox(prisma);
  const conversationId = await inbox.receive(channel.id, {
    externalId: "sizing-question",
    externalThreadId: "sizing",
    customerId: "synthetic-shopper",
    name: "Test shopper",
    body: "How do I choose a size?",
  });
  await inbox.steer(actor, {
    id: conversationId,
    nonce: "sizing-review",
    guidance: "For sizing questions, ask for garment measurements. Do not infer body measurements.",
  });
  const initial = await prisma.learningTask.findFirstOrThrow({ where: { conversationId } });
  const tasks: Record<string, string> = {};
  for (const kind of ["memory", "skill"] as const) {
    const addition =
      kind === "memory"
        ? `${"Synthetic staff note: use the garment size chart and ask one question at a time.\n".repeat(65)}Final sizing condition: ask before making assumptions.`
        : "Ask which garment the shopper selected, then look up its current size chart.";
    const conditions = "The customer asks for help choosing a garment size.";
    const native = await prepareNativeLearning(prisma, actor, {
      botId: bot.id,
      kind,
      scope: "bot",
      addition,
      conditions,
    });
    const proposal = LearningTaskProposalSchema.parse({
      native,
      addition,
      supported: true,
      publicSafe: true,
      changesBusinessRules: false,
      conditions,
      save: {
        botId: bot.id,
        scope: "bot",
        kind,
        key: "customer-learning",
        title: kind === "memory" ? "Sizing memory" : "Sizing procedure",
        content: addition,
        customerVisible: false,
        expectedRevision: 0,
        reason: "Synthetic staff correction",
        source: "Staff sizing guidance",
        sourceRef: { kind: "conversation", id: conversationId },
      },
    });
    const task =
      kind === "memory"
        ? await prisma.learningTask.update({
            where: { id: initial.id },
            data: { status: "review", proposal, targetKind: kind },
          })
        : await prisma.learningTask.create({
            data: {
              ...actor,
              botId: bot.id,
              conversationId,
              sourceKey: "synthetic-skill-review",
              evidence: initial.evidence!,
              status: "review",
              proposal,
              targetKind: kind,
            },
          });
    tasks[kind] = task.id;
  }
  const learning = createLearning(prisma);
  const save = {
    botId: bot.id,
    scope: "bot" as const,
    kind: "knowledge" as const,
    key: "synthetic-sizing",
    title: "Sizing policy",
    content: "Ask before recommending a size.",
    customerVisible: false,
    expectedRevision: 0,
    reason: "Synthetic review",
    source: "Staff sizing guidance",
    sourceRef: { kind: "conversation" as const, id: conversationId },
  };
  const proposal = LearningTaskProposalSchema.parse({
    supported: true,
    publicSafe: true,
    changesBusinessRules: true,
    conditions: "Sizing questions",
    save,
  });
  const documentTask = await prisma.learningTask.create({
    data: {
      ...actor,
      botId: bot.id,
      conversationId,
      sourceKey: "synthetic-document-review",
      evidence: initial.evidence!,
      status: "review",
      proposal,
    },
  });
  await learning.decideTask(actor, {
    botId: bot.id,
    taskId: documentTask.id,
    decision: "approve",
    reviewedProposal: proposal,
    reason: "Synthetic approved policy",
  });
  tasks.document = documentTask.id;
  for (let index = 0; index < 11; index++)
    await prisma.learningTask.create({
      data: {
        ...actor,
        botId: bot.id,
        conversationId,
        sourceKey: `synthetic-old-${index}`,
        evidence: {},
        status: "rejected",
        proposal: { ...proposal, save: { ...save, title: `Earlier sizing update ${index + 1}` } },
        createdAt: new Date(Date.now() - (index + 1) * 60000),
      },
    });
  await publishLearningSummaries(prisma);
  return { botId: bot.id, tasks };
}
