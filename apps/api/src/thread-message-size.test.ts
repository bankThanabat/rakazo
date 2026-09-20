import type { Prisma, PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "../../../packages/adapters/src/approval-ask.js";
import { MemoryRestoreToolInput } from "../../../packages/contracts/src/memory-audit.js";
import { loadAllMessages, loadMessagePage } from "./thread-message-pages.js";

const mobileLimit = 16 * 1024 * 1024;
const pageBudget = 8 * 1024 * 1024;
const block = buildApprovalAskBlock(
  "synthetic-effect",
  "memory_restore",
  MemoryRestoreToolInput.parse({
    documentId: "synthetic-document",
    revision: 1,
    expectedRevision: 2,
    reason: "Synthetic review",
    reviewedContent: "\u0001".repeat(100_000),
  }),
  [],
);

function row(seq: number, blocks: Prisma.JsonValue = [block]) {
  return {
    id: `message-${seq}`,
    threadId: "thread-1",
    seq,
    role: "bot",
    blocks,
    botId: "bot-1",
    replyToMessageId: null,
    runId: null as string | null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function database(rows: ReturnType<typeof row>[]) {
  const matches = (value: number, seq?: { lt?: number; gte?: number; lte?: number }) =>
    (seq?.lt === undefined || value < seq.lt) &&
    (seq?.gte === undefined || value >= seq.gte) &&
    (seq?.lte === undefined || value <= seq.lte);
  return {
    message: {
      findMany: async ({ where, orderBy, take }: Prisma.MessageFindManyArgs) =>
        rows
          .filter((row) => matches(row.seq, where?.seq as Prisma.IntFilter))
          .sort((a, b) =>
            (orderBy as { seq: string }).seq === "asc" ? a.seq - b.seq : b.seq - a.seq,
          )
          .slice(0, take ?? rows.length),
      findFirst: async ({ where }: Prisma.MessageFindFirstArgs) =>
        rows.find((row) => row.id === where?.id) ?? null,
      count: async ({ where }: Prisma.MessageCountArgs) =>
        rows.filter((row) => matches(row.seq, where?.seq as Prisma.IntFilter)).length,
    },
    run: { findMany: async () => [{ id: "peer-run" }] },
  } as unknown as PrismaClient;
}

describe("large conversation pages", () => {
  it("pages complete approval cards below the mobile limit without gaps or repeats", async () => {
    expect(block).toMatchObject({
      actions: expect.arrayContaining([{ id: "allow", label: "Allow once" }]),
    });
    const rows = Array.from({ length: 50 }, (_, index) => row(index + 1));
    const prisma = database(rows);
    let before: number | undefined;
    const seen: number[] = [];
    do {
      const page = await loadMessagePage(prisma, "thread-1", before, 50);
      expect(Buffer.byteLength(JSON.stringify({ json: page }))).toBeLessThan(mobileLimit);
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(pageBudget);
      expect(page.messages.length).toBeGreaterThan(0);
      expect(page.messages.length).toBeLessThan(50);
      for (const message of page.messages) expect(message.blocks).toEqual([block]);
      seen.unshift(...page.messages.map((message) => message.seq));
      if (page.olderCursor !== null && before !== undefined)
        expect(page.olderCursor).toBeLessThan(before);
      before = page.olderCursor ?? undefined;
    } while (before !== undefined && seen.length <= rows.length);
    expect(seen).toEqual(rows.map((row) => row.seq));
    expect(before).toBeUndefined();
    expect((await loadAllMessages(prisma, "thread-1", 50)).map((message) => message.seq)).toEqual(
      seen,
    );
  });

  it.each([1, 25, 50])(
    "keeps the jump target %i and a correct older cursor when shrinking its window",
    async (target) => {
      const rows = Array.from({ length: 50 }, (_, index) => row(index + 1));
      const prisma = database(rows);
      const page = await loadMessagePage(prisma, "thread-1", undefined, 50, {
        messageId: `message-${target}`,
      });
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(pageBudget);
      expect(page.messages.some((message) => message.seq === target)).toBe(true);
      const first = page.messages[0]!.seq;
      expect(page.olderCursor).toBe(first === 1 ? null : first);
      expect(page.messages.map((message) => message.seq)).toEqual(
        Array.from({ length: page.messages.length }, (_, index) => first + index),
      );
      for (const message of page.messages) expect(message.blocks).toEqual([block]);
    },
  );

  it("counts UTF-8 bytes and preserves an indivisible message above the page budget", async () => {
    const huge = row(2, [{ kind: "text", text: "ก".repeat(3_000_000) }]);
    const prisma = database([row(1), huge, row(3)]);
    const latest = await loadMessagePage(prisma, "thread-1", undefined, 50);
    expect(latest.messages.map((message) => message.seq)).toEqual([3]);
    const older = await loadMessagePage(prisma, "thread-1", latest.olderCursor!, 50);
    expect(older.messages.map((message) => message.seq)).toEqual([2]);
    expect(older.messages[0]!.blocks).toEqual(huge.blocks);
    expect(older.olderCursor).toBe(2);
    const around = await loadMessagePage(prisma, "thread-1", undefined, 50, { seq: 2 });
    expect(around.messages.map((message) => message.seq)).toEqual([2]);
    expect(around.olderCursor).toBe(2);
  });

  it("pages sparse sequences without losing visible rows beside hidden peer activity", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => {
      const message = row(index * 3);
      if (index % 2) {
        message.runId = "peer-run";
        message.blocks = [{ kind: "steps", steps: [{ label: "Peer activity", count: 1 }] }];
      }
      return message;
    });
    const prisma = database(rows);
    const expected = rows.filter((row) => !row.runId).map((row) => row.seq);
    const seen: number[] = [];
    let before: number | undefined;
    do {
      const page = await loadMessagePage(prisma, "thread-1", before, 50);
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(pageBudget);
      seen.unshift(...page.messages.map((message) => message.seq));
      if (page.olderCursor !== null && before !== undefined)
        expect(page.olderCursor).toBeLessThan(before);
      before = page.olderCursor ?? undefined;
    } while (before !== undefined && seen.length <= rows.length);
    expect(before).toBeUndefined();
    expect(seen).toEqual(expected);
    expect((await loadAllMessages(prisma, "thread-1", 50)).map((message) => message.seq)).toEqual(
      rows.map((row) => row.seq),
    );
  });

  it("keeps scanning receipt-only windows without skipping the older visible message", async () => {
    const receipt = [
      {
        kind: "bot_message_received",
        fromBotId: "peer",
        fromBotName: "Peer",
        text: "ก".repeat(1_000_000),
      },
    ];
    const rows = [row(1), ...Array.from({ length: 10 }, (_, index) => row(index + 2, receipt))];
    const prisma = database(rows);
    const web = await loadMessagePage(prisma, "thread-1", undefined, 50);
    expect(web.messages.some((message) => message.seq === 1)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(web.messages))).toBeLessThanOrEqual(pageBudget);
    const mobile = await loadMessagePage(prisma, "thread-1", undefined, 50, undefined, false, true);
    expect(mobile.messages.map((message) => message.seq)).toEqual([10, 11]);
    expect(mobile.olderCursor).toBe(10);
  });
});
