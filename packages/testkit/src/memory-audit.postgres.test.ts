import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { AccountExportRecord } from "@rakazo/db";
import {
  createDb,
  createMemoryAudit,
  provisionMessagingIdentity,
  readMemoryDocuments,
  writeAccountExport,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAgentMemoryContext } from "../../adapters/src/memory-context.js";
import { memoryHistoryForTool, memoryUndoPreviewForTool } from "../../adapters/src/memory-tools.js";
import { MarkdownMemoryStore } from "../../memory/src/index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("private Markdown memory audit", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let store: MarkdownMemoryStore;
  let audit: ReturnType<typeof createMemoryAudit>;
  const actor = () => ({ userId: owner.userId, spaceId: owner.spaceId });
  const context = (): AdapterContext => ({
    ...actor(),
    operationId: "memory-test",
    traceId: "memory-test",
    signal: new AbortController().signal,
  });
  const commit = (content: string, expectedRevision?: number) =>
    store.commit(
      {
        scope: "bot",
        botId: owner.botId,
        path: "reviewed-memory.md",
        content,
        expectedRevision,
        reason: "Synthetic staff correction",
      },
      context(),
    );
  const revisionInput = (documentId: string, revision: number, expectedRevision: number) => ({
    documentId,
    revision,
    expectedRevision,
    reason: "Reviewed correction",
  });
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
    store = new MarkdownMemoryStore(db.prisma);
    audit = createMemoryAudit(db.prisma);
  });
  afterEach(async () => {
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });

  it("selectively undoes a correction while preserving a later fact in actual future memory context", async () => {
    const first = await commit("Greeting: hello\n\nDelivery: verify provider");
    await commit("Greeting: welcome\n\nDelivery: verify provider", 1);
    await commit("Greeting: welcome\n\nDelivery: ask staff", 2);
    const input = revisionInput(first.id, 2, 3);
    expect(await audit.previewUndo(actor(), input)).toMatchObject({
      conflict: false,
      proposed: "Greeting: hello\n\nDelivery: ask staff",
    });
    const restored = await audit.undo(context(), input);
    expect(restored).toMatchObject({
      revision: 4,
      content: "Greeting: hello\n\nDelivery: ask staff",
    });
    const future = await loadAgentMemoryContext(store, owner.botId, context());
    expect(future).toContain("Greeting: hello");
    expect(future).toContain("Delivery: ask staff");
    expect(future).not.toContain("Greeting: welcome");
    expect((await audit.history(actor(), { documentId: first.id })).items[0]).toMatchObject({
      revision: 4,
      undoneRevision: 2,
      restoredFrom: 1,
      actor: "Staff",
      reason: input.reason,
    });
  });

  it("requires reviewed resolution for overlapping edits and refuses stale edits and reversals", async () => {
    const first = await commit("Greeting: hello");
    await commit("Greeting: welcome", 1);
    await commit("Greeting: good day", 2);
    const input = revisionInput(first.id, 2, 3);
    expect(await audit.previewUndo(actor(), input)).toMatchObject({
      conflict: true,
      proposed: "Greeting: good day",
    });
    await expect(audit.undo(context(), input)).rejects.toThrow("overlap");
    await expect(
      audit.update(context(), {
        documentId: first.id,
        content: "Lost update",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("changed");
    await audit.undo(context(), { ...input, resolution: "Greeting: hello, good day" });
    await expect(audit.restore(context(), input)).rejects.toThrow("changed");
    expect(
      (
        await store.read(
          { scope: "bot", botId: owner.botId, path: "reviewed-memory.md" },
          context(),
        )
      ).documents[0]!.content,
    ).toBe("Greeting: hello, good day");
  });

  it("restores a known version as a new event and can undo a first creation", async () => {
    const first = await commit("First fact");
    await commit("Later fact", 1);
    await audit.restore(context(), revisionInput(first.id, 1, 2));
    expect(
      (await audit.history(actor(), { documentId: first.id })).items.map((item) => item.revision),
    ).toEqual([3, 2, 1]);
    await audit.undo(context(), revisionInput(first.id, 1, 3));
    expect(
      await store.search({ query: "First fact", scope: "bot", botId: owner.botId }, context()),
    ).toEqual([]);
    const history = await audit.history(actor(), { documentId: first.id });
    expect(history.items[0]).toMatchObject({ undoneRevision: 1 });
    expect(await audit.read(actor(), { documentId: first.id })).toMatchObject({ content: "" });
    expect(await audit.read(actor(), { documentId: first.id, revision: 1 })).toMatchObject({
      content: "First fact",
    });
  });

  it("does not invent unknown legacy predecessors and snapshots the first edited value", async () => {
    const legacy = await db.prisma.memoryDocument.create({
      data: {
        ...actor(),
        botId: owner.botId,
        scope: "bot",
        path: "legacy.md",
        content: "Known legacy text",
        revision: 8,
      },
    });
    await audit.update(context(), {
      documentId: legacy.id,
      content: "Current text",
      expectedRevision: 8,
    });
    const history = await audit.history(actor(), { documentId: legacy.id });
    expect(history.items).toMatchObject([
      { revision: 9, actor: "Staff" },
      { revision: 8, actor: "Unknown" },
    ]);
    await expect(audit.previewUndo(actor(), revisionInput(legacy.id, 8, 9))).rejects.toThrow(
      "preceding",
    );
    await audit.restore(context(), revisionInput(legacy.id, 8, 9));
    expect((await audit.read(actor(), { documentId: legacy.id })).content).toBe(
      "Known legacy text",
    );
  });

  it("records agent/run/thread provenance for ordinary writes and tool reversals", async () => {
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId: owner.botId } });
    const task = await db.prisma.task.create({
      data: {
        ...actor(),
        botId: owner.botId,
        threadId: thread.id,
        prompt: "Synthetic memory correction",
        status: "completed",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        ...actor(),
        botId: owner.botId,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    const agentContext = { ...context(), botId: owner.botId, runId: run.id };
    const first = await store.commit(
      {
        scope: "bot",
        botId: owner.botId,
        path: "agent.md",
        content: "A fact",
        reason: "Staff asked to remember",
        sourceRunId: run.id,
        sourceThreadId: thread.id,
      },
      agentContext,
    );
    await audit.undo(agentContext, revisionInput(first.id, 1, 1));
    const history = await audit.history(actor(), { documentId: first.id });
    expect(history.items).toHaveLength(2);
    for (const item of history.items)
      expect(item).toMatchObject({
        actor: expect.stringContaining("Agent"),
        sourceRunId: run.id,
        sourceThreadId: thread.id,
      });
    await audit.update(context(), {
      documentId: first.id,
      expectedRevision: 2,
      content: "Staff edit",
    });
    expect((await audit.history(actor(), { documentId: first.id })).items[0]).toMatchObject({
      actor: "Staff",
      sourceRunId: null,
      sourceThreadId: null,
    });
  });

  it("paginates immutable history and includes audit metadata in the account export", async () => {
    const first = await commit("Version one");
    for (let revision = 2; revision <= 52; revision++)
      await commit(`Version ${revision}`, revision - 1);
    const page = await audit.history(actor(), { documentId: first.id });
    expect(page.items).toHaveLength(50);
    const next = await audit.history(actor(), {
      documentId: first.id,
      beforeRevision: page.nextBeforeRevision,
    });
    expect(next.items.map((row) => row.revision)).toEqual([2, 1]);
    expect(next.nextBeforeRevision).toBeNull();
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
    expect(records.filter((record) => record.type === "memoryRevision")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            documentId: first.id,
            reason: "Synthetic staff correction",
            actorKind: "staff",
          }),
        }),
      ]),
    );
  });

  it("exports both bot and user Markdown when scope is all", async () => {
    await commit("Bot fact");
    await store.commit(
      { scope: "user", path: "shared-personal.md", content: "Private user fact" },
      context(),
    );
    const files = [];
    for await (const file of store.exportMarkdown({ scope: "all" }, context())) files.push(file);
    const text = files.map((file) => new TextDecoder().decode(file.content)).join("\n");
    expect(text).toContain("Bot fact");
    expect(text).toContain("Private user fact");
  });

  it.each(["membership", "deletion"])(
    "blocks every memory read and mutation after %s access removal",
    async (change) => {
      const first = await commit("PRIVATE_MEMORY_SENTINEL");
      const member = await db.prisma.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: actor() },
      });
      if (change === "membership") await db.prisma.spaceMember.delete({ where: { id: member.id } });
      else await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
      const checks = [
        () => store.read({ scope: "bot", botId: owner.botId }, context()),
        () => store.search({ query: "PRIVATE", scope: "all" }, context()),
        () => readMemoryDocuments(db.prisma, actor()),
        () => audit.history(actor(), { documentId: first.id }),
        () => audit.list(context(), owner.botId),
        () => audit.read(context(), { documentId: first.id }),
        () => audit.previewUndo(actor(), revisionInput(first.id, 1, 1)),
        () => audit.undo(context(), revisionInput(first.id, 1, 1)),
        () => audit.restore(context(), revisionInput(first.id, 1, 1)),
        () => audit.update(context(), { documentId: first.id, content: "No", expectedRevision: 1 }),
        () => commit("No", 1),
        async () => {
          for await (const _file of store.exportMarkdown({ scope: "all" }, context())) {
            /* drain */
          }
        },
      ];
      for (const check of checks) await expect(check()).rejects.toThrow();
      expect(
        (await db.prisma.memoryDocument.findUniqueOrThrow({ where: { id: first.id } })).revision,
      ).toBe(1);
    },
  );

  it("does not expose or mutate another owner's memory or attach it to their bot", async () => {
    const other = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    try {
      const first = await commit("Private fact");
      const foreign = { ...context(), userId: other.userId, spaceId: other.spaceId };
      await expect(audit.history(foreign, { documentId: first.id })).rejects.toThrow();
      await expect(audit.undo(foreign, revisionInput(first.id, 1, 1))).rejects.toThrow();
      await expect(
        store.commit(
          { scope: "bot", botId: other.botId, path: "wrong-bot.md", content: "No" },
          context(),
        ),
      ).rejects.toThrow();
      expect(await readMemoryDocuments(db.prisma, foreign, { botId: owner.botId })).toEqual([]);
    } finally {
      await db.prisma.space.delete({ where: { id: other.spaceId } });
      await db.prisma.user.delete({ where: { id: other.userId } });
    }
  });

  it("rolls back an undo when its audit write fails", async () => {
    const first = await commit("Original fact");
    await commit("Edited fact", 1);
    const failing = db.prisma.$extends({
      query: {
        memoryRevision: {
          async create() {
            throw new Error("Synthetic audit failure");
          },
        },
      },
    });
    await expect(
      createMemoryAudit(failing as typeof db.prisma).undo(context(), revisionInput(first.id, 2, 2)),
    ).rejects.toThrow("audit failure");
    expect(
      (await db.prisma.memoryDocument.findUniqueOrThrow({ where: { id: first.id } })).content,
    ).toBe("Edited fact");
    expect(await db.prisma.memoryRevision.count({ where: { documentId: first.id } })).toBe(2);
  });
  it("bounds tool lists, history and chunks while preserving cursors and complete historical content", async () => {
    const content = "\u0001".repeat(100000);
    const first = await commit(content);
    for (let version = 2; version <= 5; version++) await commit(content, version - 1);
    for (let i = 0; i < 12; i++)
      await store.commit(
        { scope: "bot", botId: owner.botId, path: `${i}${"\u0001".repeat(990)}`, content },
        context(),
      );
    const page = await audit.list(context(), owner.botId);
    expect(page.items).toHaveLength(10);
    expect(JSON.stringify(page).length).toBeLessThan(12000);
    const next = await audit.list(context(), owner.botId, { cursor: page.nextCursor });
    expect(new Set([...page.items, ...next.items].map((item) => item.id)).size).toBe(15);
    expect(next.nextCursor).toBeNull();
    const history = memoryHistoryForTool(
      await audit.history(context(), { documentId: first.id, limit: 3 }),
    );
    expect(history.items).toHaveLength(3);
    expect(history.nextBeforeRevision).toBe(3);
    expect(JSON.stringify(history).length).toBeLessThan(12000);
    let combined = "";
    let offset = 0;
    do {
      const part = await audit.read(context(), { documentId: first.id, revision: 1, offset });
      expect(JSON.stringify(part).length).toBeLessThan(12000);
      combined += part.content;
      if (part.nextOffset === null) break;
      offset = part.nextOffset;
    } while (offset < content.length);
    expect(combined).toBe(content);
    const input = revisionInput(first.id, 1, 5);
    const preview = memoryUndoPreviewForTool(await audit.previewUndo(context(), input), {
      ...input,
      field: "before",
    });
    expect(preview).toMatchObject({ field: "before", content: "", nextOffset: null });
    expect(JSON.stringify(preview).length).toBeLessThan(12000);
  });

  it("rejects invented and foreign provenance without appending a document or revision", async () => {
    const first = await commit("Original fact");
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { botId: owner.botId } });
    const task = await db.prisma.task.create({
      data: {
        ...actor(),
        botId: owner.botId,
        threadId: thread.id,
        prompt: "Audit",
        status: "completed",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        ...actor(),
        botId: owner.botId,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
      },
    });
    const other = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    try {
      const otherThread = await db.prisma.thread.findUniqueOrThrow({
        where: { botId: other.botId },
      });
      for (const provenance of [
        { sourceRunId: "missing-run" },
        { sourceThreadId: "missing-thread" },
        { sourceRunId: run.id, sourceThreadId: otherThread.id },
        { sourceThreadId: otherThread.id },
      ])
        await expect(
          store.commit(
            {
              scope: "bot",
              botId: owner.botId,
              path: "reviewed-memory.md",
              content: "No",
              ...provenance,
            },
            context(),
          ),
        ).rejects.toThrow();
      await expect(
        store.commit(
          {
            scope: "bot",
            botId: other.botId,
            path: "foreign.md",
            content: "No",
            sourceRunId: run.id,
          },
          { ...context(), spaceId: other.spaceId, userId: other.userId },
        ),
      ).rejects.toThrow();
      expect((await audit.read(context(), { documentId: first.id })).revision).toBe(1);
      expect(await db.prisma.memoryRevision.count({ where: { documentId: first.id } })).toBe(1);
    } finally {
      await db.prisma.space.delete({ where: { id: other.spaceId } });
      await db.prisma.user.delete({ where: { id: other.userId } });
    }
  });

  it("rejects memory writes while bot archival holds its lock", async () => {
    const first = await commit("Original fact");
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('UPDATE bots SET "archivedAt" = CURRENT_TIMESTAMP WHERE id = $1', [
        owner.botId,
      ]);
      await expect(commit("No", 1)).rejects.toThrow();
      await client.query("COMMIT");
      await expect(audit.undo(context(), revisionInput(first.id, 1, 1))).rejects.toThrow();
      expect((await audit.read(context(), { documentId: first.id })).revision).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("holds lifecycle locks until a memory read finishes", async () => {
    const first = await commit("Original fact");
    const guarded = db.prisma.$extends({
      query: {
        memoryDocument: {
          async findFirst({ args, query }) {
            const client = await db.pool.connect();
            try {
              await client.query("BEGIN");
              await expect(
                client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE NOWAIT', [
                  owner.userId,
                ]),
              ).rejects.toMatchObject({ code: "55P03" });
              await client.query("ROLLBACK");
              await client.query("BEGIN");
              await expect(
                client.query(
                  'SELECT id FROM space_members WHERE "spaceId" = $1 AND "userId" = $2 FOR UPDATE NOWAIT',
                  [owner.spaceId, owner.userId],
                ),
              ).rejects.toMatchObject({ code: "55P03" });
            } finally {
              await client.query("ROLLBACK");
              client.release();
            }
            return query(args);
          },
        },
      },
    });
    expect(
      (
        await createMemoryAudit(guarded as typeof db.prisma).read(context(), {
          documentId: first.id,
        })
      ).content,
    ).toBe("Original fact");
  });

  it("requires reversal content to match the exact approved replacement", async () => {
    const first = await commit("Original fact");
    await commit("Incorrect fact", 1);
    const input = revisionInput(first.id, 2, 2);
    await expect(
      audit.undo(context(), { ...input, reviewedContent: "Different fact" }),
    ).rejects.toThrow("reviewed memory text");
    await expect(
      audit.restore(context(), { ...input, revision: 1, reviewedContent: "Different fact" }),
    ).rejects.toThrow("reviewed memory text");
    expect((await audit.read(context(), { documentId: first.id })).revision).toBe(2);
    expect(
      await audit.undo(context(), { ...input, reviewedContent: "Original fact" }),
    ).toMatchObject({ content: "Original fact", revision: 3 });
  });
});
