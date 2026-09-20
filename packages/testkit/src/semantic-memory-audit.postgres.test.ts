import { randomUUID } from "node:crypto";
import type { AdapterContext, SemanticMemorySaveResponse } from "@rakazo/adapter-kit";
import {
  SemanticMemoryDetailSchema,
  SemanticMemoryHistorySchema,
  SemanticMemoryUndoApprovedInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  beginSemanticMemoryMutation,
  createDb,
  createSemanticMemoryAudit,
  finishSemanticMemoryMutation,
  prepareSemanticMemoryUndo,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const receipt = {
  version: 1 as const,
  id: "fact-1",
  entity: "synthetic-entity",
  content: "Use metric units.",
  created: true,
};
const confirmed: SemanticMemorySaveResponse = { ok: true, value: [receipt] };

describe.skipIf(!enabled)("semantic provider outcome transaction", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let context: AdapterContext;
  let effectId: string;
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
    const actor = {
      userId: owner.userId,
      spaceId: owner.spaceId,
      botId: owner.botId,
      threadId: owner.threadId,
    };
    const task = await db.prisma.task.create({
      data: { ...actor, prompt: "Synthetic memory write", status: "running" },
    });
    const run = await db.prisma.run.create({
      data: { ...actor, taskId: task.id, status: "running", trigger: "user" },
    });
    context = {
      ...actor,
      runId: run.id,
      operationId: "memory-outcome",
      traceId: "memory-outcome",
      signal: new AbortController().signal,
    };
    const effect = await db.prisma.externalEffect.create({
      data: {
        spaceId: owner.spaceId,
        runId: run.id,
        kind: "save_memory",
        status: "executing",
        idempotencyKey: randomUUID(),
        request: {
          botId: owner.botId,
          scope: "isolated",
          provider: "supermemory",
          configurationRevision: "synthetic:1",
          content: receipt.content,
        },
      },
    });
    effectId = effect.id;
    await beginSemanticMemoryMutation(db.prisma, context, effectId);
  });
  afterEach(async () => {
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });
  const rows = async () => ({
    audit: await db.prisma.semanticMemoryMutation.findUnique({ where: { id: effectId } }),
    effect: await db.prisma.externalEffect.findUnique({ where: { id: effectId } }),
  });

  const binding = () => ({
    botId: owner.botId,
    scope: "isolated",
    provider: "supermemory",
    configurationRevision: "synthetic:1",
  });
  const undoInput = () => ({
    mutationId: effectId,
    id: receipt.id,
    entity: receipt.entity,
    reason: "Undo the recorded creation",
  });
  const prepareUndo = (raw = undoInput(), currentBinding = binding()) =>
    prepareSemanticMemoryUndo(db.prisma, context, currentBinding, raw);
  const undoExecution = async (request: Awaited<ReturnType<typeof prepareUndo>>) => {
    const source = await db.prisma.run.findFirstOrThrow({ where: { botId: owner.botId } });
    const run = await db.prisma.run.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: owner.botId,
        threadId: owner.threadId,
        taskId: source.taskId,
        status: "running",
        trigger: "user",
      },
    });
    const effect = await db.prisma.externalEffect.create({
      data: {
        spaceId: owner.spaceId,
        runId: run.id,
        kind: "memory_semantic_undo",
        status: "executing",
        idempotencyKey: randomUUID(),
        request,
      },
    });
    return { id: effect.id, context: { ...context, runId: run.id } };
  };
  const beginUndo = async (request: Awaited<ReturnType<typeof prepareUndo>>) => {
    const undo = await undoExecution(request);
    await beginSemanticMemoryMutation(db.prisma, undo.context, undo.id);
    return undo;
  };

  it("app history preserves full recorded versions without exposing binding secrets or source identity after deletion", async () => {
    const content = "Synthetic full fact. ".repeat(100);
    await finishSemanticMemoryMutation(db.prisma, context, effectId, {
      ok: true,
      value: [{ ...receipt, content }],
    });
    const audit = createSemanticMemoryAudit(db.prisma);
    const first = SemanticMemoryDetailSchema.parse(await audit.detail(context, effectId));
    expect(first.sourceThreadId).toBe(owner.threadId);
    expect(first.changes).toEqual([
      {
        id: receipt.id,
        entity: receipt.entity,
        before: { state: "absent", content: null },
        after: { state: "recorded", content },
      },
    ]);
    expect(JSON.stringify(first)).not.toContain("configurationRevision");
    expect(JSON.stringify(first)).not.toContain("sourceRunId");
    await db.prisma.run.delete({ where: { id: context.runId } });
    expect(await audit.detail(context, effectId)).toMatchObject({
      sourceThreadId: null,
      changes: first.changes,
    });
    expect(SemanticMemoryHistorySchema.parse(await audit.list(context)).items[0]?.id).toBe(
      effectId,
    );
  });
  it("app history never invents versions for opaque saves or unconfirmed removal", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, {
      ok: true,
      value: [{ ...receipt, version: undefined, created: null, content: null }],
    });
    const audit = createSemanticMemoryAudit(db.prisma);
    expect((await audit.detail(context, effectId)).changes[0]).toMatchObject({
      before: { state: "unknown" },
      after: { state: "unknown" },
    });
    await db.prisma.semanticMemoryMutation.update({
      where: { id: effectId },
      data: {
        operation: "forget",
        status: "uncertain",
        request: { id: receipt.id, expectedContent: receipt.content },
        result: { ok: false, uncertain: true },
      },
    });
    expect((await audit.detail(context, effectId)).changes[0]).toMatchObject({
      before: { state: "recorded", content: receipt.content },
      after: { state: "unknown" },
    });
    await db.prisma.semanticMemoryMutation.update({
      where: { id: effectId },
      data: {
        status: "completed",
        result: { ok: true, value: { id: receipt.id, expired: true } },
      },
    });
    expect((await audit.detail(context, effectId)).changes[0]?.after.state).toBe("absent");
  });
  it("app history keeps partial save destinations distinct", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, {
      ok: false,
      error: "Synthetic partial save",
      receipts: [receipt, { ...receipt, entity: "uncertain" }],
      uncertainEntities: ["uncertain"],
    });
    const view = await createSemanticMemoryAudit(db.prisma).detail(context, effectId);
    expect(view.status).toBe("uncertain");
    expect(view.changes[0]?.after.state).toBe("recorded");
    expect(view.changes[1]).toMatchObject({
      before: { state: "unknown" },
      after: { state: "unknown" },
    });
  });
  it("hides a retained run source if its thread no longer belongs to this bot", async () => {
    const bot = await db.prisma.bot.findUniqueOrThrow({ where: { id: owner.botId } });
    const alternate = await db.prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Alternate synthetic bot",
        color: bot.color,
      },
    });
    const thread = await db.prisma.thread.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: alternate.id,
      },
    });
    await db.prisma.run.update({ where: { id: context.runId }, data: { threadId: thread.id } });
    const audit = createSemanticMemoryAudit(db.prisma);
    expect((await audit.detail(context, effectId)).sourceThreadId).toBeNull();
    expect((await audit.read(context, { mutationId: effectId })).content).not.toContain(thread.id);
  });
  it("app history refuses foreign owners, bots, archived bots and revoked membership", async () => {
    const audit = createSemanticMemoryAudit(db.prisma);
    await expect(audit.detail({ ...context, userId: "foreign" }, effectId)).rejects.toThrow();
    await expect(audit.detail({ ...context, botId: "foreign" }, effectId)).rejects.toThrow();
    await db.prisma.bot.update({ where: { id: owner.botId }, data: { archivedAt: new Date() } });
    await expect(audit.detail(context, effectId)).rejects.toThrow();
    await db.prisma.bot.update({ where: { id: owner.botId }, data: { archivedAt: null } });
    await db.prisma.spaceMember.deleteMany({
      where: { userId: owner.userId, spaceId: owner.spaceId },
    });
    await expect(audit.detail(context, effectId)).rejects.toThrow();
    await expect(audit.list(context)).rejects.toThrow();
  });

  it("restores a confirmed removal, then reverses the restoration using its new receipt", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    const removed = await beginUndo(await prepareUndo());
    await finishSemanticMemoryMutation(db.prisma, removed.context, removed.id, {
      ok: true,
      value: { id: receipt.id, entity: receipt.entity, expired: true, reason: "Undo creation" },
    });
    const restoration = await prepareUndo({ ...undoInput(), mutationId: removed.id });
    expect(restoration).toMatchObject({ action: "restore", expectedContent: receipt.content });
    const restored = await beginUndo(restoration);
    const restoredReceipt = { ...receipt, id: "restored-fact" };
    await finishSemanticMemoryMutation(db.prisma, restored.context, restored.id, {
      ok: true,
      value: [restoredReceipt],
    });
    expect(
      await db.prisma.semanticMemoryMutation.findUnique({ where: { id: restored.id } }),
    ).toMatchObject({ operation: "undo_forget", reversesId: removed.id, status: "completed" });
    expect(await createSemanticMemoryAudit(db.prisma).detail(context, restored.id)).toMatchObject({
      reversesId: removed.id,
      changes: [
        {
          id: "restored-fact",
          before: { state: "absent" },
          after: { state: "recorded", content: receipt.content },
        },
      ],
    });
    expect(
      await prepareUndo({ ...undoInput(), mutationId: restored.id, id: restoredReceipt.id }),
    ).toMatchObject({ action: "forget", expectedContent: receipt.content });
    await expect(prepareUndo({ ...undoInput(), mutationId: removed.id })).rejects.toThrow(
      "already has",
    );
  });

  it.each([
    "uncertain",
    "failed",
    "missing-content",
    "wrong-receipt",
    "unknown-entity",
    "wrong-entity",
  ] as const)("rejects restoration with %s evidence", async (kind) => {
    await db.prisma.semanticMemoryMutation.update({
      where: { id: effectId },
      data: {
        operation: "forget",
        status: kind === "uncertain" || kind === "failed" ? kind : "completed",
        request: {
          id: receipt.id,
          ...(kind === "missing-content" ? {} : { expectedContent: receipt.content }),
          ...(kind === "unknown-entity"
            ? {}
            : { entity: kind === "wrong-entity" ? "foreign" : receipt.entity }),
        },
        result: {
          ok: true,
          value: { id: kind === "wrong-receipt" ? "foreign" : receipt.id, expired: true },
        },
      },
    });
    await expect(prepareUndo()).rejects.toThrow();
  });

  it("rechecks the reviewed inverse action before reserving a reversal", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    const undo = await undoExecution({ ...(await prepareUndo()), action: "restore" });
    await expect(beginSemanticMemoryMutation(db.prisma, undo.context, undo.id)).rejects.toThrow(
      "changed",
    );
  });

  it("undo binds recorded content, preserves its creation, and records the reversal in a later run", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    const request = await prepareSemanticMemoryUndo(db.prisma, context, binding(), {
      ...undoInput(),
      expectedContent: "Untrusted model text",
      botId: "foreign-bot",
    });
    expect(request).toEqual({
      ...undoInput(),
      ...binding(),
      action: "forget",
      expectedContent: receipt.content,
    });
    const undo = await beginUndo(request);
    const removed = {
      ok: true as const,
      value: { id: receipt.id, expired: true, reason: request.reason },
    };
    await finishSemanticMemoryMutation(db.prisma, undo.context, undo.id, removed);
    expect((await rows()).audit).toMatchObject({ status: "completed", result: confirmed });
    expect(
      await db.prisma.semanticMemoryMutation.findUnique({ where: { id: undo.id } }),
    ).toMatchObject({
      reversesId: effectId,
      operation: "undo_save",
      sourceRunId: undo.context.runId,
      request,
      result: removed,
      status: "completed",
      reversalKey: expect.any(String),
    });
    await expect(prepareUndo()).rejects.toMatchObject({
      previousUndo: { id: undo.id, status: "completed" },
    });
  });

  it("only one of two concurrent runs can reserve the same creation", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    const request = await prepareUndo();
    const first = await undoExecution(request);
    const second = await undoExecution(request);
    const outcomes = await Promise.allSettled(
      [first, second].map((undo) => beginSemanticMemoryMutation(db.prisma, undo.context, undo.id)),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await db.prisma.semanticMemoryMutation.count({ where: { reversesId: effectId } })).toBe(
      1,
    );
  });

  it("an uncertain undo stays reserved after its source run is deleted", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    const undo = await beginUndo(await prepareUndo());
    await finishSemanticMemoryMutation(db.prisma, undo.context, undo.id, {
      ok: false,
      error: "Lost response",
      uncertain: true,
    });
    await db.prisma.run.delete({ where: { id: undo.context.runId } });
    await expect(prepareUndo()).rejects.toMatchObject({
      previousUndo: { id: undo.id, status: "uncertain" },
    });
  });

  it("a definite failure permits a newly reviewed retry and retains the failed audit", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    const first = await beginUndo(await prepareUndo());
    await finishSemanticMemoryMutation(db.prisma, first.context, first.id, {
      ok: false,
      error: "Inspection unavailable; no dispatch",
    });
    const second = await beginUndo(await prepareUndo());
    expect(first.id).not.toBe(second.id);
    expect(
      await db.prisma.semanticMemoryMutation.findUnique({ where: { id: first.id } }),
    ).toMatchObject({ reversesId: effectId, status: "failed", reversalKey: null });
    expect(await db.prisma.semanticMemoryMutation.count({ where: { reversesId: effectId } })).toBe(
      2,
    );
  });

  it("reverses confirmed shared destinations separately while leaving an uncertain sibling alone", async () => {
    await db.prisma.semanticMemoryMutation.update({
      where: { id: effectId },
      data: { scope: "shared" },
    });
    const second = { ...receipt, entity: "second-entity" };
    await finishSemanticMemoryMutation(db.prisma, context, effectId, {
      ok: false,
      error: "Another destination uncertain",
      receipts: [receipt, second],
      uncertainEntities: ["unknown-entity"],
    });
    const shared = { ...binding(), scope: "shared" };
    const firstUndo = await beginUndo(await prepareUndo(undoInput(), shared));
    const secondUndo = await beginUndo(
      await prepareUndo({ ...undoInput(), entity: second.entity }, shared),
    );
    expect(firstUndo.id).not.toBe(secondUndo.id);
    await expect(prepareUndo({ ...undoInput(), entity: "unknown-entity" }, shared)).rejects.toThrow(
      "did not confirm",
    );
  });

  it.each([
    {
      name: "unqualified legacy creation",
      result: {
        ok: true,
        value: [
          { id: receipt.id, entity: receipt.entity, content: receipt.content, created: true },
        ],
      },
    },
    {
      name: "unknown creation state",
      result: { ok: true, value: [{ ...receipt, created: null }] },
    },
    { name: "unknown content", result: { ok: true, value: [{ ...receipt, content: null }] } },
    { name: "pre-existing fact", result: { ok: true, value: [{ ...receipt, created: false }] } },
    {
      name: "uncertain destination",
      result: { ok: false, receipts: [receipt], uncertainEntities: [receipt.entity] },
    },
    { name: "ambiguous duplicate receipts", result: { ok: true, value: [receipt, receipt] } },
  ])("refuses $name", async ({ result }) => {
    await db.prisma.semanticMemoryMutation.update({
      where: { id: effectId },
      data: { status: "completed", result },
    });
    await expect(prepareUndo()).rejects.toThrow("did not confirm");
  });

  it.each(["scope", "provider", "configurationRevision"])("rejects a changed %s", async (key) => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    await expect(
      prepareUndo(undoInput(), { ...binding(), [key]: key === "scope" ? "shared" : "changed" }),
    ).rejects.toThrow("changed");
  });

  it.each(["userId", "spaceId", "botId"])(
    "rejects another %s inspecting an undo source",
    async (key) => {
      await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
      await expect(
        prepareSemanticMemoryUndo(
          db.prisma,
          { ...context, [key]: "foreign-id" },
          binding(),
          undoInput(),
        ),
      ).rejects.toThrow();
    },
  );

  it("rechecks the exact reviewed content before reserving a reversal", async () => {
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    const request = SemanticMemoryUndoApprovedInput.parse({
      ...(await prepareUndo()),
      expectedContent: "Different fact",
    });
    const undo = await undoExecution(request);
    await expect(beginSemanticMemoryMutation(db.prisma, undo.context, undo.id)).rejects.toThrow(
      "content changed",
    );
    expect(await db.prisma.semanticMemoryMutation.count({ where: { reversesId: effectId } })).toBe(
      0,
    );
  });

  it.each([
    { name: "confirmed", result: confirmed, auditStatus: "completed", effectStatus: "completed" },
    {
      name: "definite failure",
      result: {
        ok: false,
        error: "Invalid fact",
        receipts: [],
        uncertainEntities: [],
      } as SemanticMemorySaveResponse,
      auditStatus: "failed",
      effectStatus: "completed",
    },
    {
      name: "partial",
      result: {
        ok: false,
        error: "Lost sibling response",
        receipts: [receipt],
        uncertainEntities: ["other-entity"],
      } as SemanticMemorySaveResponse,
      auditStatus: "uncertain",
      effectStatus: "uncertain",
    },
  ])(
    "commits $name evidence and replay state together",
    async ({ result, auditStatus, effectStatus }) => {
      const returned = await finishSemanticMemoryMutation(db.prisma, context, effectId, result);
      expect(await rows()).toMatchObject({
        audit: { status: auditStatus, result },
        effect: { status: effectStatus, result: returned },
      });
      if (effectStatus === "uncertain")
        expect(returned).toMatchObject({
          uncertain: true,
          receipts: [receipt],
          uncertainEntities: ["other-entity"],
        });
      await expect(
        finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed),
      ).rejects.toThrow("could not be recorded");
      expect(await rows()).toMatchObject({
        audit: { status: auditStatus, result },
        effect: { status: effectStatus, result: returned },
      });
    },
  );

  it("rolls both rows back when execution-state persistence fails after its SQL update", async () => {
    const failing = db.prisma.$extends({
      query: {
        externalEffect: {
          async updateMany({ args, query }) {
            await query(args);
            throw new Error("Synthetic commit interruption");
          },
        },
      },
    });
    await expect(
      finishSemanticMemoryMutation(
        failing as unknown as PrismaClient,
        context,
        effectId,
        confirmed,
      ),
    ).rejects.toThrow("Synthetic commit interruption");
    expect(await rows()).toMatchObject({
      audit: { status: "uncertain", result: null },
      effect: { status: "executing", result: null },
    });
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    expect(await rows()).toMatchObject({
      audit: { status: "completed", result: confirmed },
      effect: { status: "completed", result: confirmed },
    });
  });

  it("settles recovery uncertainty from a late acknowledgement without another provider call", async () => {
    await db.prisma.externalEffect.update({
      where: { id: effectId },
      data: { status: "uncertain", result: { uncertain: true } },
    });
    await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed);
    expect(await rows()).toMatchObject({
      audit: { status: "completed", result: confirmed },
      effect: { status: "completed", result: confirmed },
    });
  });

  it("retains a late receipt after its source run and execution ledger are removed", async () => {
    await db.prisma.run.delete({ where: { id: context.runId } });
    expect(await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed)).toEqual(
      confirmed,
    );
    expect(await rows()).toMatchObject({
      audit: { status: "completed", result: confirmed },
      effect: null,
    });
  });

  it.each(["denied", "completed"])("does not replace a concurrent %s decision", async (status) => {
    const prior = { error: "Synthetic concurrent decision" };
    await db.prisma.externalEffect.update({
      where: { id: effectId },
      data: { status, result: prior },
    });
    expect(
      await finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed),
    ).toMatchObject({ uncertain: true });
    expect(await rows()).toMatchObject({
      audit: { status: "completed", result: confirmed },
      effect: { status, result: prior },
    });
  });

  it.each(["botId", "runId", "spaceId", "userId"])(
    "rejects a different %s before recording any result",
    async (key) => {
      await expect(
        finishSemanticMemoryMutation(
          db.prisma,
          { ...context, [key]: "foreign-id" },
          effectId,
          confirmed,
        ),
      ).rejects.toThrow();
      expect(await rows()).toMatchObject({
        audit: { status: "uncertain", result: null },
        effect: { status: "executing", result: null },
      });
    },
  );

  it("does not recreate audit evidence after bot erasure", async () => {
    await db.prisma.bot.delete({ where: { id: owner.botId } });
    await expect(
      finishSemanticMemoryMutation(db.prisma, context, effectId, confirmed),
    ).rejects.toThrow();
    expect(await rows()).toEqual({ audit: null, effect: null });
  });
});
