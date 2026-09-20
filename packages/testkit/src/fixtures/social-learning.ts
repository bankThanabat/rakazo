import type { PrismaClient } from "@rakazo/db";
import { createLearning } from "@rakazo/db";

/** Synthetic saved evidence for the browser journey. Ingestion has PostgreSQL conformance tests. */
export async function socialLearningFixture(prisma: PrismaClient, email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const bot = await prisma.bot.findFirstOrThrow({ where: { userId: user.id, archivedAt: null } });
  const actor = { userId: user.id, spaceId: bot.spaceId };
  const connection = await prisma.connection.create({
    data: {
      ...actor,
      connectorId: "open-connector",
      provider: "instagram",
      status: "connected",
      providerRef: "synthetic-instagram",
      displayName: "Synthetic studio",
    },
  });
  const now = new Date();
  const feed = await prisma.learningFeed.create({
    data: {
      ...actor,
      botId: bot.id,
      connectionId: connection.id,
      providerRef: connection.providerRef!,
      accountId: "synthetic-studio",
      label: "Instagram @synthetic_studio",
      scope: "space",
      windowStart: new Date(now.getTime() - 30 * 86400000),
      windowEnd: now,
    },
  });
  const archive = await prisma.learningImport.create({
    data: {
      ...actor,
      botId: bot.id,
      feedId: feed.id,
      feedRevision: 1,
      digest: feed.id,
      format: "json",
      label: feed.label,
      content: JSON.stringify(
        [{ id: "post-1", text: "A quiet morning in our studio.", publishedAt: now.toISOString() }],
        null,
        2,
      ),
      windowEnd: now,
      coverage: {
        accepted: 1,
        skipped: 0,
        duplicates: 0,
        earliest: now.toISOString(),
        latest: now.toISOString(),
        errors: [],
      },
    },
  });
  await createLearning(prisma).save(actor, {
    botId: bot.id,
    scope: "space",
    kind: "voice",
    key: "brand-voice",
    title: "Brand voice",
    content: "Use short, calm sentences.",
    customerVisible: true,
    expectedRevision: 0,
    source: "Authorized business posts",
    sourceRef: { kind: "import", id: archive.id },
    reason: "Synthetic post style",
  });
  // The fixture source is kept off the scheduled queue; browser removal uses the real API.
  await prisma.learningFeed.update({
    where: { id: feed.id },
    data: { nextAttemptAt: new Date(now.getTime() + 86400000) },
  });
}
