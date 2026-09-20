import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";

/** Synthetic retained receipts, intentionally disconnected from any live memory provider. */
export async function semanticHistoryFixture(prisma: PrismaClient, email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const bot = await prisma.bot.findFirstOrThrow({ where: { userId: user.id, archivedAt: null } });
  const originalId = randomUUID();
  const undoId = randomUUID();
  const content =
    "Synthetic example: ask which delivery date the shopper needs.\n" +
    "Keep customer details private. ".repeat(50) +
    "End of recorded fact.";
  const base = {
    spaceId: bot.spaceId,
    userId: user.id,
    botId: bot.id,
    sourceRunId: "deleted-synthetic-run",
    sourceThreadId: "deleted-synthetic-thread",
    provider: "supermemory",
    configurationRevision: "synthetic:1",
    scope: "isolated",
  };
  await prisma.semanticMemoryMutation.create({
    data: {
      ...base,
      id: originalId,
      operation: "save",
      status: "completed",
      createdAt: new Date("2026-01-01T12:00:00Z"),
      request: { content, reason: "Synthetic staff correction" },
      result: {
        ok: true,
        value: [
          { version: 1, id: "synthetic-fact", entity: "synthetic-bot", content, created: true },
        ],
      },
    },
  });
  for (let i = 0; i < 10; i++) {
    await prisma.semanticMemoryMutation.create({
      data: {
        ...base,
        id: randomUUID(),
        operation: "save",
        status: "completed",
        createdAt: new Date(Date.UTC(2026, 0, 2 + i, 12)),
        request: { content: `Synthetic preference ${i + 1}`, reason: "Synthetic history entry" },
        result: {
          ok: true,
          value: [{ id: `synthetic-${i}`, entity: "synthetic-bot", content: null, created: null }],
        },
      },
    });
  }
  await prisma.semanticMemoryMutation.create({
    data: {
      ...base,
      id: undoId,
      operation: "undo_save",
      status: "uncertain",
      reversesId: originalId,
      createdAt: new Date("2026-01-15T12:00:00Z"),
      request: {
        id: "synthetic-fact",
        entity: "synthetic-bot",
        expectedContent: content,
        reason: "Synthetic undo awaiting confirmation",
      },
      result: { ok: false, error: "Synthetic lost response", uncertain: true },
    },
  });
  return { botId: bot.id, originalId, undoId, content };
}
