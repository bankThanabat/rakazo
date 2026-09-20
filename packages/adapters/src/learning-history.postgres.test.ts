import { randomUUID } from "node:crypto";
import type { AgentRunRequest, JobPublisher } from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import type { AccountExportRecord } from "@rakazo/db";
import {
  createDb,
  createLearning,
  createLearningHistory,
  provisionMessagingIdentity,
  publishLearningSummaries,
  writeAccountExport,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { processContinuedLearning } from "./continued-learning.js";
import { createCustomerConversations } from "./customer-conversations.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("resumable historical replies with PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let connection: Awaited<ReturnType<typeof db.prisma.connection.create>>;
  let service: ReturnType<typeof createLearningHistory>;
  const actor = () => ({ userId: owner.userId, spaceId: owner.spaceId });
  const replies = (count = 1, offset = 0) =>
    Array.from({ length: count }, (_, index) => ({
      thread_id: "old-thread",
      message_id: `message-${index + offset}`,
      sent_at: new Date(connection.createdAt.getTime() - 86400000).toISOString(),
      author_role: "business",
      text: `Hello from the synthetic shop. Reply ${index + offset}.`,
    }));
  const archive = (rows = replies(), windowEnd = connection.createdAt.toISOString()) =>
    createLearning(db.prisma).archive(actor(), {
      botId: owner.botId,
      format: "json",
      source: "Synthetic replies",
      content: JSON.stringify(rows),
      windowEnd,
    });
  const start = async (rows = replies()) => {
    const saved = await archive(rows);
    return service.start(actor(), owner.botId, {
      sourceId: saved.sourceId,
      scope: "bot",
      source: { kind: "connection", connectionId: connection.id },
    });
  };
  const state = (id: string) => db.prisma.learningHistory.findUniqueOrThrow({ where: { id } });
  const task = () => db.prisma.learningTask.findFirstOrThrow({ where: { botId: owner.botId } });
  const processTask = (id: string, before = async () => {}, kind = "voice") => {
    const calls = vi.fn();
    const promise = processContinuedLearning(
      {
        prisma: db.prisma,
        resolveModel: async () => ({ provider: "test", id: "test" }),
        runtime: {
          async *run(request: AgentRunRequest) {
            calls(request);
            await before();
            yield {
              type: "done" as const,
              text: JSON.stringify({
                reusable: true,
                supported: true,
                publicSafe: true,
                changesBusinessRules: false,
                kind,
                scope: "space",
                title: "Voice",
                content: "Use short sentences.",
                conditions: "Business greetings",
                reason: "Reviewed replies",
              }),
            };
          },
        },
      },
      id,
    );
    return { calls, promise };
  };
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    owner = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    connection = await db.prisma.connection.create({
      data: {
        ...actor(),
        provider: "line",
        connectorId: "open-connector",
        providerRef: "PRIVATE_HISTORY_BINDING",
        displayName: "Synthetic shop",
        status: "connected",
      },
    });
    service = createLearningHistory(db.prisma);
  });
  afterEach(async () => {
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });

  it("processes more than a preview across resumable pages and concurrent jobs exactly once", async () => {
    const rows = replies(205).map((row) => ({ ...row, text: row.text + "hello ".repeat(30) }));
    const saved = await archive(rows);
    expect(saved.preview.accepted).toBe(205);
    expect(saved.preview.content.length).toBeLessThanOrEqual(14000);
    const history = await start(rows);
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({
      nextRow: 100,
      accepted: 100,
      status: "queued",
    });
    await Promise.all([
      service.process(history.id),
      service.process(history.id),
      service.process(history.id),
    ]);
    expect(await state(history.id)).toMatchObject({
      nextRow: 205,
      accepted: 205,
      status: "complete",
    });
    expect(await db.prisma.learningHistoryItem.count({ where: { botId: owner.botId } })).toBe(205);
    const tasks = await db.prisma.learningTask.findMany({ where: { importId: saved.sourceId } });
    const evidence = tasks.flatMap((item) => (item.evidence as { replies: unknown[] }).replies);
    expect(evidence).toHaveLength(205);
    expect(tasks.every((item) => JSON.stringify(item.evidence).length < 14100)).toBe(true);
    expect((await start(rows)).id).toBe(history.id);
  });

  it("finishes an import page while its learning summary is waiting to publish", async () => {
    const history = await start(replies(105));
    await service.process(history.id);
    await db.prisma.learningTask.updateMany({
      where: { importId: history.sourceId },
      data: { status: "failed" },
    });
    const blocker = await db.pool.connect();
    let summary: Promise<void> | undefined;
    let importing: Promise<void> | undefined;
    const blocked = async () =>
      Number(
        (
          await db.pool.query(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          )
        ).rows[0].count,
      );
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM bots WHERE id = $1 FOR UPDATE", [owner.botId]);
      summary = publishLearningSummaries(db.prisma);
      await vi.waitFor(async () => expect(await blocked()).toBe(1));
      importing = service.process(history.id);
      await vi.waitFor(async () => expect(await blocked()).toBe(2));
      await blocker.query("COMMIT");
      await Promise.all([summary, importing]);
      expect(await state(history.id)).toMatchObject({
        status: "complete",
        accepted: 105,
        duplicates: 0,
      });
      expect(await db.prisma.learningHistoryItem.count({ where: { botId: owner.botId } })).toBe(
        105,
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([summary, importing]);
    }
  });

  it("skips oversized serialized evidence before recording duplicate markers", async () => {
    const oversized = {
      ...replies()[0]!,
      thread_id: "t".repeat(1000),
      message_id: "m".repeat(1000),
      text: "x".repeat(13000),
    };
    const first = await start([oversized, ...replies()]);
    await service.process(first.id);
    expect(await state(first.id)).toMatchObject({ accepted: 1, skipped: 1, duplicates: 0 });
    const next = await start([oversized, ...replies(1, 4)]);
    await service.process(next.id);
    expect(await state(next.id)).toMatchObject({ accepted: 1, skipped: 1, duplicates: 0 });
    expect(await db.prisma.learningHistoryItem.count({ where: { botId: owner.botId } })).toBe(2);
  });

  it("deduplicates overlapping exports but retains edited replies and source IDs", async () => {
    const first = await start(replies(2));
    await service.process(first.id);
    const overlap = await start([
      ...replies(3).reverse(),
      { ...replies()[0]!, text: "Edited business reply" },
    ]);
    await service.process(overlap.id);
    expect(await state(overlap.id)).toMatchObject({ accepted: 2, duplicates: 2 });
    const tasks = await db.prisma.learningTask.findMany({ where: { importId: overlap.sourceId } });
    expect(JSON.stringify(tasks.map((item) => item.evidence))).not.toContain("messageId");
    const original = await db.prisma.learningImport.findUniqueOrThrow({
      where: { id: overlap.sourceId },
    });
    expect(original.content).toContain('"message_id":"message-0"');
  });

  it("uses reply dates on old threads, skips unknown authors and keeps its original window", async () => {
    const rows = replies(4);
    rows[1]!.author_role = "customer";
    rows[2]!.sent_at = new Date(connection.createdAt.getTime() - 31 * 86400000).toISOString();
    rows[3]!.sent_at = "2026-09-18 10:00";
    const history = await start(rows);
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({ accepted: 1, skipped: 3, duplicates: 0 });
    const repeated = await archive(
      rows,
      new Date(connection.createdAt.getTime() + 86400000).toISOString(),
    );
    expect(repeated.sourceId).toBe(history.sourceId);
    expect((await service.list(actor(), owner.botId)).items[0]!.windowEnd).toBe(
      connection.createdAt.toISOString(),
    );
    const bad = await archive(
      replies(1, 50),
      new Date(connection.createdAt.getTime() + 1).toISOString(),
    );
    await expect(
      service.start(actor(), owner.botId, {
        sourceId: bad.sourceId,
        scope: "bot",
        source: { kind: "connection", connectionId: connection.id },
      }),
    ).rejects.toThrow("windowEnd");
  });

  it("rolls back markers, tasks and cursor when a page write fails, then explicitly resumes", async () => {
    const history = await start(replies(2));
    const failing = db.prisma.$extends({
      query: {
        learningTask: {
          async create() {
            throw new Error("Synthetic write failure");
          },
        },
      },
    });
    await createLearningHistory(failing as typeof db.prisma).process(history.id);
    expect(await state(history.id)).toMatchObject({ status: "failed", nextRow: 0, accepted: 0 });
    expect(await db.prisma.learningHistoryItem.count({ where: { botId: owner.botId } })).toBe(0);
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    await start(replies(2));
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({ status: "complete", accepted: 2 });
  });

  it("records failure against the page read under lock after another worker advances the cursor", async () => {
    const history = await start(replies(101));
    let firstRead = true;
    const interleaved = db.prisma.$extends({
      query: {
        learningHistory: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (firstRead) {
              firstRead = false;
              await service.process(history.id);
            }
            return row;
          },
        },
        learningTask: {
          async create() {
            throw new Error("Synthetic second-page failure");
          },
        },
      },
    });
    await createLearningHistory(interleaved as typeof db.prisma).process(history.id);
    expect(await state(history.id)).toMatchObject({
      status: "failed",
      nextRow: 100,
      accepted: 100,
    });
    expect(await db.prisma.learningHistoryItem.count({ where: { botId: owner.botId } })).toBe(100);
    await start(replies(101));
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({
      status: "complete",
      nextRow: 101,
      accepted: 101,
    });
  });

  it("pauses batches with bot learning and resumes without changing the approved scope", async () => {
    const history = await start();
    await createLearning(db.prisma).configure(actor(), { botId: owner.botId, enabled: false });
    await service.process(history.id);
    expect(await service.due()).not.toContainEqual({ id: history.id });
    expect(await state(history.id)).toMatchObject({ nextRow: 0 });
    await expect(
      service.start(actor(), owner.botId, {
        sourceId: history.sourceId,
        scope: "space",
        source: { kind: "connection", connectionId: connection.id },
      }),
    ).rejects.toThrow("cannot change");
    await createLearning(db.prisma).configure(actor(), { botId: owner.botId, enabled: true });
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({ accepted: 1 });
  });

  it.each(["revoke", "delete", "rebind", "deletion"])(
    "blocks queued history after %s",
    async (change) => {
      const history = await start();
      if (change === "revoke")
        await db.prisma.connection.update({
          where: { id: connection.id },
          data: { status: "revoked" },
        });
      if (change === "delete") await db.prisma.connection.delete({ where: { id: connection.id } });
      if (change === "rebind")
        await db.prisma.connection.update({
          where: { id: connection.id },
          data: { providerRef: "another-account" },
        });
      if (change === "deletion")
        await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
      await service.process(history.id);
      expect(await state(history.id)).toMatchObject({ status: "failed", nextRow: 0 });
      expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    },
  );

  it.each(["revoke", "withdraw", "pause", "deletion"])(
    "rejects a model write after %s during inference",
    async (change) => {
      const history = await start();
      await service.process(history.id);
      const work = processTask((await task()).id, async () => {
        if (change === "revoke")
          await db.prisma.connection.update({
            where: { id: connection.id },
            data: { status: "revoked" },
          });
        if (change === "withdraw")
          await createLearning(db.prisma).withdraw(actor(), {
            botId: owner.botId,
            sourceId: history.sourceId,
          });
        if (change === "pause")
          await createLearning(db.prisma).configure(actor(), {
            botId: owner.botId,
            enabled: false,
          });
        if (change === "deletion")
          await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
      });
      await work.promise;
      expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
    },
  );

  it("applies only the approved scope with original evidence and audit, while operational facts need review", async () => {
    const history = await start();
    await service.process(history.id);
    const work = processTask((await task()).id);
    await work.promise;
    expect(JSON.parse(work.calls.mock.calls[0]![0].prompt)).toMatchObject({
      sourceKind: "business_replies",
    });
    expect(work.calls.mock.calls[0]![0].prompt).not.toContain("old-thread");
    expect(work.calls.mock.calls[0]![0].prompt).not.toContain("message-0");
    const learning = createLearning(db.prisma);
    const learned = await learning.state(actor(), owner.botId);
    expect(learned.documents).toMatchObject([{ scope: "bot", kind: "voice", revision: 1 }]);
    expect(
      await learning.evidence(actor(), { botId: owner.botId, revisionId: learned.history[0]!.id }),
    ).toMatchObject({ sourceId: history.sourceId, withdrawn: false });
    const next = await start(replies(1, 4));
    await service.process(next.id);
    const nextTask = await db.prisma.learningTask.findFirstOrThrow({
      where: { importId: next.sourceId },
    });
    await processTask(nextTask.id, async () => {}, "knowledge").promise;
    expect(
      await db.prisma.learningTask.findUniqueOrThrow({ where: { id: nextTask.id } }),
    ).toMatchObject({ status: "review", proposal: { supported: false } });
  });

  it("enforces the approved scope through manual saves too", async () => {
    const history = await start();
    await expect(
      createLearning(db.prisma).save(actor(), {
        botId: owner.botId,
        scope: "space",
        kind: "voice",
        key: "brand-voice",
        title: "Voice",
        content: "Use short sentences.",
        customerVisible: true,
        expectedRevision: 0,
        reason: "Reviewed",
        source: "Replies",
        sourceRef: { kind: "import", id: history.sourceId },
      }),
    ).rejects.toThrow();
    expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
  });

  it.each(["private", "owner-deletion"])(
    "stops a shared connection import after %s",
    async (change) => {
      const other = await provisionMessagingIdentity(
        db.prisma,
        { provider: "test", address: randomUUID() },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
      try {
        await db.prisma.connection.update({
          where: { id: connection.id },
          data: { userId: other.userId, scope: "team" },
        });
        const history = await start(replies(101));
        await service.process(history.id);
        expect(await state(history.id)).toMatchObject({ nextRow: 100, accepted: 100 });
        if (change === "private")
          await db.prisma.connection.update({
            where: { id: connection.id },
            data: { scope: "user" },
          });
        else await db.prisma.accountDeletion.create({ data: { userId: other.userId } });
        await service.process(history.id);
        expect(await state(history.id)).toMatchObject({
          status: "failed",
          nextRow: 100,
          accepted: 100,
        });
        await processTask((await task()).id).promise;
        expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(
          0,
        );
      } finally {
        await db.prisma.connection.update({
          where: { id: connection.id },
          data: { userId: owner.userId },
        });
        await db.prisma.accountDeletion.deleteMany({ where: { userId: other.userId } });
        await db.prisma.space.delete({ where: { id: other.spaceId } });
        await db.prisma.user.delete({ where: { id: other.userId } });
      }
    },
  );

  it("deduplicates JSON and multiline CSV reexports in the same source namespace", async () => {
    const rows = replies().map((row) => ({ ...row, text: "Hello, shop\nยินดีค่ะ" }));
    const history = await start(rows);
    await service.process(history.id);
    const saved = await createLearning(db.prisma).archive(actor(), {
      botId: owner.botId,
      format: "csv",
      source: "Synthetic reexport",
      windowEnd: connection.createdAt.toISOString(),
      content: `thread_id,message_id,sent_at,author_role,text\nold-thread,message-0,${rows[0]!.sent_at},business,"Hello, shop\nยินดีค่ะ"\nold-thread,message-2,${rows[0]!.sent_at},business,Welcome`,
    });
    const next = await service.start(actor(), owner.botId, {
      sourceId: saved.sourceId,
      scope: "bot",
      source: { kind: "connection", connectionId: connection.id },
    });
    await service.process(next.id);
    expect(await state(next.id)).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it("retains mapped interpretation across reexports and resumed jobs, then erases it on withdrawal", async () => {
    const learning = createLearning(db.prisma);
    const rows = replies(205);
    const mapping = {
      threadId: "chat",
      messageId: "id",
      sentAt: "date",
      authorRole: "sender",
      text: "body",
      businessValues: ["Synthetic staff label"],
      customerValues: ["visitor"],
    };
    const content = JSON.stringify(
      rows.map((row) => ({
        chat: row.thread_id,
        id: row.message_id,
        date: new Date(Date.parse(row.sent_at) + 7 * 3600000).toISOString().slice(0, -1),
        sender: "Synthetic staff label",
        body: row.text,
      })),
    );
    const saved = await learning.archive(actor(), {
      botId: owner.botId,
      format: "json",
      source: "Synthetic mapped export",
      content,
      mapping,
      timezoneOffset: "+07:00",
      windowEnd: connection.createdAt.toISOString(),
    });
    expect(saved.preview).toMatchObject({ accepted: 205, mapping, timezoneOffset: "+07:00" });
    expect(saved.preview.samples).toHaveLength(10);
    // Equivalent normalized evidence reuses the original archive and its saved options.
    const repeated = await archive(
      rows,
      new Date(connection.createdAt.getTime() + 86400000).toISOString(),
    );
    expect(repeated.sourceId).toBe(saved.sourceId);
    expect(repeated.preview).toMatchObject({ accepted: 205, mapping, timezoneOffset: "+07:00" });
    const startInput = {
      sourceId: saved.sourceId,
      scope: "bot",
      source: { kind: "connection", connectionId: connection.id },
    };
    const history = await service.start(actor(), owner.botId, startInput);
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({ nextRow: 100, accepted: 100 });
    await createLearningHistory(db.prisma).start(actor(), owner.botId, startInput);
    await createLearningHistory(db.prisma).process(history.id);
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({
      status: "complete",
      accepted: 205,
      duplicates: 0,
      earliest: new Date(rows[0]!.sent_at),
    });
    const stored = await db.prisma.learningImport.findUniqueOrThrow({
      where: { id: saved.sourceId },
    });
    expect(stored).toMatchObject({
      content,
      mapping,
      timezoneOffset: "+07:00",
      windowEnd: connection.createdAt,
    });
    expect(stored.coverage).not.toHaveProperty("samples");
    expect(stored.coverage).not.toHaveProperty("mapping");
    const records: AccountExportRecord[] = [];
    await writeAccountExport(
      db.prisma,
      owner.userId,
      async (record) => {
        records.push(record);
      },
      async () => "",
      new AbortController().signal,
    );
    expect(JSON.stringify(records)).toContain('"businessValues":["Synthetic staff label"]');
    await learning.save(actor(), {
      botId: owner.botId,
      scope: "bot",
      kind: "voice",
      key: "brand-voice",
      title: "Voice",
      content: "Use short replies.",
      customerVisible: true,
      expectedRevision: 0,
      reason: "Reviewed synthetic replies",
      source: "Synthetic import",
      sourceRef: { kind: "import", id: saved.sourceId },
    });
    const revisionId = (await learning.state(actor(), owner.botId)).history[0]!.id;
    expect(await learning.evidence(actor(), { botId: owner.botId, revisionId })).toMatchObject({
      content,
      mapping,
      timezoneOffset: "+07:00",
    });
    await learning.withdraw(actor(), { botId: owner.botId, sourceId: saved.sourceId });
    expect(
      await db.prisma.learningImport.findUniqueOrThrow({ where: { id: saved.sourceId } }),
    ).toMatchObject({ content: null, mapping: null, timezoneOffset: null });
    expect(await learning.evidence(actor(), { botId: owner.botId, revisionId })).toMatchObject({
      withdrawn: true,
      content: "",
      mapping: null,
      timezoneOffset: null,
    });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
  });

  it("erases original and queued evidence on withdrawal but preserves cross-export deduplication", async () => {
    const history = await start(replies(2));
    await service.process(history.id);
    await createLearning(db.prisma).withdraw(actor(), {
      botId: owner.botId,
      sourceId: history.sourceId,
    });
    expect(await state(history.id)).toMatchObject({ status: "cancelled" });
    expect(
      await db.prisma.learningImport.findUniqueOrThrow({ where: { id: history.sourceId } }),
    ).toMatchObject({ content: null });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    const next = await start(replies(3));
    await service.process(next.id);
    expect(await state(next.id)).toMatchObject({ accepted: 1, duplicates: 2 });
  });

  it("supports offline source namespaces without granting other staff access", async () => {
    const saved = await archive();
    const history = await service.start(actor(), owner.botId, {
      sourceId: saved.sourceId,
      scope: "space",
      source: { kind: "export", key: "synthetic-line-oa" },
    });
    await service.process(history.id);
    expect(await state(history.id)).toMatchObject({ accepted: 1, connectionId: null });
    await expect(
      service.list({ ...actor(), userId: "different-staff" }, owner.botId),
    ).rejects.toThrow();
    await expect(
      service.start({ ...actor(), userId: "different-staff" }, owner.botId, {
        sourceId: saved.sourceId,
        scope: "bot",
        source: { kind: "export", key: "synthetic-line-oa" },
      }),
    ).rejects.toThrow();
  });

  it("pages through older import jobs without exposing another owner's cursor", async () => {
    const archives = Array.from({ length: 101 }, (_, index) => ({
      id: `archive-${owner.botId}-${index}`,
      ...actor(),
      botId: owner.botId,
      digest: String(index),
      label: "Synthetic page",
      format: "json",
      content: "[]",
      coverage: {},
      windowEnd: connection.createdAt,
    }));
    await db.prisma.learningImport.createMany({ data: archives });
    await db.prisma.learningHistory.createMany({
      data: archives.map((item, index) => ({
        id: `history-${owner.botId}-${String(index).padStart(3, "0")}`,
        importId: item.id,
        scope: "bot",
        sourceKey: "synthetic",
        exportKey: "synthetic",
        status: "failed",
      })),
    });
    const first = await service.list(actor(), owner.botId);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const last = await service.list(actor(), owner.botId, { cursor: first.nextCursor });
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(101);
    await expect(
      service.list(actor(), owner.botId, { cursor: "unowned-history" }),
    ).rejects.toThrow();
  });

  it("routes approved setup through production reconciliation, background jobs, summary and account export", async () => {
    const saved = await archive();
    const enqueue = vi.fn(async (_job: unknown) => undefined);
    const customers = createCustomerConversations({
      prisma: db.prisma,
      integrations: {} as IntegrationProviderSettings,
      secrets: new EncryptedSecretStore("synthetic-test-key"),
      jobs: { enqueue } as unknown as JobPublisher,
    });
    const history = (await customers.manage(actor(), owner.botId, "learning_history_start", {
      sourceId: saved.sourceId,
      scope: "bot",
      source: { kind: "connection", connectionId: connection.id },
    })) as { id: string };
    await customers.reconcile();
    expect(enqueue).toHaveBeenCalledWith({
      name: "learning.import",
      payload: { historyId: history.id },
      replaceKey: `learning.import:${history.id}`,
    });
    const handlers = createBackgroundJobHandlers({ prisma: db.prisma } as Parameters<
      typeof createBackgroundJobHandlers
    >[0]);
    await dispatchBackgroundJob(handlers, "learning.import", { historyId: history.id });
    await customers.reconcile();
    expect(enqueue).toHaveBeenCalledWith({
      name: "learning.process",
      payload: { taskId: (await task()).id },
      replaceKey: `learning:${(await task()).id}`,
    });
    expect(await customers.manage(actor(), owner.botId, "learning_histories", {})).toMatchObject({
      items: [{ accepted: 1, status: "complete" }],
      nextCursor: null,
    });
    await publishLearningSummaries(db.prisma);
    expect(await state(history.id)).toMatchObject({ summarizedAt: expect.any(Date) });
    const records: AccountExportRecord[] = [];
    await writeAccountExport(
      db.prisma,
      owner.userId,
      async (record) => {
        records.push(record);
      },
      async () => "",
      new AbortController().signal,
    );
    const exported = JSON.stringify(records);
    expect(exported).toContain('"learningHistory"');
    expect(exported).not.toContain("PRIVATE_HISTORY_BINDING");
  });
});
