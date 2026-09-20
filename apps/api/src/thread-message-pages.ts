import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { isPeerReceiptBlocks } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

type MessageDb = PrismaClient | Prisma.TransactionClient;

// Leave room below mobile's 16 MiB RPC limit for snapshot metadata and live events.
// Messages are indivisible: an unusually large single message travels alone.
const MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;

function fitMessageWindow(messages: ThreadMessage[], targetSeq?: number): ThreadMessage[] {
  const sizes = messages.map((message) => Buffer.byteLength(JSON.stringify(message)) + 1);
  let bytes = 1 + sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  let end = messages.length;
  // Remove only the ends, preserving chronological continuity and the jump target.
  while (bytes > MESSAGE_PAGE_BYTES && end - start > 1) {
    if (
      targetSeq === undefined ||
      Math.abs(messages[start]!.seq - targetSeq) > Math.abs(messages[end - 1]!.seq - targetSeq)
    ) {
      bytes -= sizes[start++]!;
    } else {
      bytes -= sizes[--end]!;
    }
  }
  return messages.slice(start, end);
}

export async function loadMessagePage(
  prisma: MessageDb,
  threadId: string,
  before: number | undefined,
  pageSize: number,
  around?: { messageId?: string; seq?: number },
  includePeerRuns = false,
  includePeerReceipts = false,
): Promise<ThreadMessagePage> {
  if (around) {
    let targetSeq = around.seq;
    if (targetSeq === undefined && around.messageId) {
      const row = await prisma.message.findFirst({
        where: { id: around.messageId, threadId },
        select: { seq: true },
      });
      targetSeq = row?.seq;
    }
    if (targetSeq !== undefined) {
      const half = Math.floor(pageSize / 2);
      const minSeq = Math.max(0, targetSeq - half);
      const maxSeq = targetSeq + half;
      const rows = await prisma.message.findMany({
        where: { threadId, seq: { gte: minSeq, lte: maxSeq } },
        orderBy: { seq: "asc" },
        take: pageSize,
      });
      // Peer text/activity stays out of the normal transcript (including the
      // around target). Receipts remain via withoutPeerRunMessages; full peer
      // history belongs in the bot-messages overlay (includePeerRuns).
      const visibleRows = includePeerRuns ? rows : await withoutPeerRunMessages(prisma, rows);
      const messages = fitMessageWindow(visibleRows.map(toThreadMessage), targetSeq);
      const first = messages[0] ?? rows[0];
      const hasOlder = first
        ? (await prisma.message.count({ where: { threadId, seq: { lt: first.seq } } })) > 0
        : false;
      return {
        threadId,
        messages,
        olderCursor: hasOlder ? (first?.seq ?? null) : null,
      };
    }
  }

  let cursor = before;
  while (true) {
    const rows = await prisma.message.findMany({
      where: {
        threadId,
        ...(cursor === undefined ? {} : { seq: { lt: cursor } }),
      },
      orderBy: { seq: "desc" },
      take: pageSize + 1,
    });
    const pageRows = rows.slice(0, pageSize).reverse();
    const visibleRows = includePeerRuns ? pageRows : await withoutPeerRunMessages(prisma, pageRows);
    const messages = fitMessageWindow(visibleRows.map(toThreadMessage));
    const trimmed = messages.length < visibleRows.length;
    const hasOlder = rows.length > pageSize || trimmed;
    const firstSeq = trimmed ? messages[0]?.seq : pageRows[0]?.seq;
    // Web hides receipts client-side, so its receipt-only pages keep scanning.
    // Mobile explicitly retains them and must receive each page for pagination.
    const hasSubstantive = messages.some((message) => !isPeerReceiptBlocks(message.blocks));
    if (hasSubstantive || includePeerReceipts || !hasOlder || includePeerRuns) {
      return {
        threadId,
        messages,
        olderCursor: hasOlder ? (firstSeq ?? null) : null,
      };
    }
    // TODO: only rescan when a raw page is entirely peer output. Consider a run relation if
    // long peer-only histories make this path hot.
    cursor = firstSeq;
  }
}

export async function loadAllMessages(
  prisma: PrismaClient,
  threadId: string,
  pageSize: number,
): Promise<ThreadMessage[]> {
  const pages: ThreadMessage[][] = [];
  let before: number | undefined;
  do {
    const page = await loadMessagePage(prisma, threadId, before, pageSize, undefined, true);
    pages.push(page.messages);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return pages.reverse().flat();
}

async function withoutPeerRunMessages<T extends { runId: string | null; blocks: Prisma.JsonValue }>(
  prisma: MessageDb,
  rows: T[],
): Promise<T[]> {
  const runIds = [...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))];
  if (runIds.length === 0) return rows;
  const peerRuns = await prisma.run.findMany({
    where: { id: { in: runIds }, trigger: "bot_message" },
    select: { id: true },
  });
  const peerRunIds = new Set(peerRuns.map((run) => run.id));
  return rows.filter((row) => {
    if (!row.runId || !peerRunIds.has(row.runId)) return true;
    // Keep peer receipts (chips), ask cards, and the bot's own text reply.
    const blocks = row.blocks as MessageBlock[];
    return blocks.some(
      (block) =>
        block.kind === "bot_message_sent" ||
        block.kind === "bot_message_received" ||
        block.kind === "ask" ||
        block.kind === "text",
    );
  });
}

export async function isPeerRun(
  prisma: MessageDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let peerRun = cache.get(runId);
  if (!peerRun) {
    peerRun = prisma.run
      .findUnique({ where: { id: runId }, select: { trigger: true } })
      .then((run) => run?.trigger === "bot_message");
    cache.set(runId, peerRun);
  }
  return peerRun;
}

/** Peer-run SSE events that must still reach an open thread (terminals, waits, receipts, asks, text). */
export function shouldForwardPeerThreadEvent(event: {
  type: string;
  payload: { blocks?: unknown };
}): boolean {
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested"
  ) {
    return true;
  }
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  const blocks = event.payload.blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        "kind" in block &&
        (block.kind === "bot_message_received" ||
          block.kind === "bot_message_sent" ||
          block.kind === "ask" ||
          block.kind === "text"),
    )
  );
}

function toThreadMessage(row: {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  runId: string | null;
  createdAt: Date;
}): ThreadMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as ThreadMessage["role"],
    blocks: row.blocks as ThreadMessage["blocks"],
    botId: row.botId ?? undefined,
    replyToMessageId: row.replyToMessageId ?? undefined,
    runId: row.runId ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}
