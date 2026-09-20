import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createSemanticMemoryAudit, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSemanticMemoryReversal } from "../../../apps/api/src/semantic-memory-reversal.js";
import { SupermemoryMemoryProvider } from "../../adapters/src/supermemory-memory-provider.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("direct staff semantic reversal", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let context: AdapterContext;
  let provider: SupermemoryMemoryProvider;
  let service: ReturnType<typeof createSemanticMemoryReversal>;
  let resolve: ReturnType<typeof vi.fn>;
  let configurationRevision: string;
  let originalId: string;
  const content = "Private fact for complete owner review. ".repeat(200);
  const input = () => ({
    botId: owner.botId,
    mutationId: originalId,
    id: "original-fact",
    entity: `rakazo:${owner.botId}`,
    reason: "Staff correction",
  });
  const approved = async () => ({
    ...input(),
    ...(await service.preview(context, input())),
    clientNonce: randomUUID(),
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
    context = {
      ...owner,
      operationId: "staff-review",
      traceId: "staff-review",
      signal: new AbortController().signal,
    };
    const secret = await db.prisma.secret.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        kind: "memory",
        ciphertext: "synthetic-unused-secret",
      },
    });
    const config = await db.prisma.spaceMemoryConfig.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        provider: "supermemory",
        secretId: secret.id,
        settings: {},
      },
    });
    configurationRevision = `${config.id}:${config.updatedAt.toISOString()}`;
    provider = new SupermemoryMemoryProvider({
      baseUrl: "http://127.0.0.1:6767",
      apiKey: "synthetic-unused-key",
    });
    vi.spyOn(provider, "forget").mockResolvedValue({
      ok: true,
      value: { id: "original-fact", entity: input().entity, expired: true },
    });
    vi.spyOn(provider, "restore").mockResolvedValue({
      ok: true,
      value: [{ version: 1, id: "restored-fact", entity: input().entity, content, created: true }],
    });
    resolve = vi.fn(async () => ({
      provider,
      defaultScope: "isolated" as const,
      configurationRevision,
    }));
    service = createSemanticMemoryReversal(db.prisma, { resolve });
    originalId = randomUUID();
    await db.prisma.semanticMemoryMutation.create({
      data: {
        id: originalId,
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: owner.botId,
        sourceRunId: "retained-run",
        sourceThreadId: owner.threadId,
        provider: "supermemory",
        configurationRevision,
        scope: "isolated",
        operation: "save",
        status: "completed",
        request: { content },
        result: {
          ok: true,
          value: [
            { version: 1, id: "original-fact", entity: input().entity, content, created: true },
          ],
        },
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.prisma.space.deleteMany({ where: { id: owner.spaceId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
  });

  it("reviews the entire fact, then records staff removal and restoration with a new identity", async () => {
    const review = await approved();
    expect(review.content).toBe(content);
    expect(provider.forget).not.toHaveBeenCalled();
    const removed = await service.apply(context, review);
    expect(removed.status).toBe("completed");
    expect(provider.forget).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContent: content,
        entity: input().entity,
        reason: input().reason,
      }),
      expect.anything(),
    );
    const audit = await db.prisma.semanticMemoryMutation.findUniqueOrThrow({
      where: { id: removed.mutationId },
    });
    expect(audit).toMatchObject({
      sourceRunId: null,
      operation: "undo_save",
      reversesId: originalId,
      request: { source: { kind: "staff", reviewVersion: review.version } },
    });
    const restoreInput = { ...input(), mutationId: audit.id };
    const restoreReview = await service.preview(context, restoreInput);
    expect(restoreReview).toMatchObject({ action: "restore", content });
    const restored = await service.apply(context, {
      ...restoreInput,
      version: restoreReview.version,
      clientNonce: randomUUID(),
    });
    const detail = await createSemanticMemoryAudit(db.prisma).detail(context, restored.mutationId);
    expect(detail).toMatchObject({
      operation: "undo_forget",
      reversesId: audit.id,
      sourceThreadId: null,
      changes: [{ id: "restored-fact", after: { state: "recorded", content } }],
    });
    const again = await service.preview(context, {
      ...input(),
      mutationId: restored.mutationId,
      id: "restored-fact",
    });
    expect(again.action).toBe("forget");
    expect(await db.prisma.semanticMemoryMutation.count({ where: { id: originalId } })).toBe(1);
  });
  it("returns the same retained result for concurrent and later same-nonce requests", async () => {
    const review = await approved();
    const results = await Promise.all([
      service.apply(context, review),
      service.apply(context, review),
      service.apply(context, review),
    ]);
    expect(new Set(results.map((result) => result.mutationId)).size).toBe(1);
    expect(provider.forget).toHaveBeenCalledTimes(1);
    expect(await service.apply(context, review)).toMatchObject({
      mutationId: results[0]!.mutationId,
      status: "completed",
    });
    await expect(service.apply(context, { ...review, reason: "Different intent" })).rejects.toThrow(
      "already used",
    );
  });
  it("returns the winner when it commits between nonce lookup and reversal inspection", async () => {
    const review = await approved();
    let intervened = false;
    const racing = db.prisma.$extends({
      query: {
        semanticMemoryMutation: {
          async findUnique({ args, query }) {
            const result = await query(args);
            if (!intervened && String(args.where.id).startsWith("staff:") && !result) {
              intervened = true;
              await service.apply(context, review);
            }
            return result;
          },
        },
      },
    });
    const second = createSemanticMemoryReversal(racing as unknown as PrismaClient, { resolve });
    expect((await second.apply(context, review)).status).toBe("completed");
    expect(provider.forget).toHaveBeenCalledTimes(1);
  });
  it("allows only one dispatch when different nonces race for the same fact", async () => {
    const review = await approved();
    const results = await Promise.allSettled([
      service.apply(context, review),
      service.apply(context, { ...review, clientNonce: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(provider.forget).toHaveBeenCalledTimes(1);
  });
  it.each(["reason", "content", "configuration", "scope", "owner"])(
    "rejects a stale or unauthorized %s before dispatch",
    async (field) => {
      const review = await approved();
      if (field === "reason") review.reason = "Changed reason";
      if (field === "content")
        await db.prisma.semanticMemoryMutation.update({
          where: { id: originalId },
          data: {
            result: {
              ok: true,
              value: [
                {
                  version: 1,
                  id: "original-fact",
                  entity: input().entity,
                  content: "Newer text",
                  created: true,
                },
              ],
            },
          },
        });
      if (field === "configuration")
        await db.prisma.spaceMemoryConfig.update({
          where: { spaceId: owner.spaceId },
          data: { updatedAt: new Date("2040-01-01") },
        });
      if (field === "scope")
        await db.prisma.bot.update({ where: { id: owner.botId }, data: { memoryScope: "shared" } });
      await expect(
        service.apply(field === "owner" ? { ...context, userId: "another-user" } : context, review),
      ).rejects.toThrow();
      expect(provider.forget).not.toHaveBeenCalled();
    },
  );
  it.each(["configuration", "scope", "archive", "deletion"])(
    "rechecks %s after reserving and before provider transport",
    async (field) => {
      const review = await approved();
      resolve.mockClear();
      const usual = async () => ({
        provider,
        defaultScope: "isolated" as const,
        configurationRevision,
      });
      resolve.mockImplementationOnce(usual).mockImplementationOnce(async () => {
        if (field === "configuration")
          await db.prisma.spaceMemoryConfig.update({
            where: { spaceId: owner.spaceId },
            data: { updatedAt: new Date("2040-01-01") },
          });
        if (field === "scope")
          await db.prisma.bot.update({
            where: { id: owner.botId },
            data: { memoryScope: "shared" },
          });
        if (field === "archive")
          await db.prisma.bot.update({
            where: { id: owner.botId },
            data: { archivedAt: new Date() },
          });
        if (field === "deletion") await db.prisma.user.delete({ where: { id: owner.userId } });
        return usual();
      });
      if (field === "deletion") await expect(service.apply(context, review)).rejects.toThrow();
      else expect((await service.apply(context, review)).status).toBe("failed");
      expect(provider.forget).not.toHaveBeenCalled();
    },
  );
  it("retains an uncertain intent after a lost response and never retries it", async () => {
    const review = await approved();
    vi.mocked(provider.forget!).mockRejectedValue(new Error("Synthetic lost response"));
    const result = await service.apply(context, review);
    expect(result.status).toBe("uncertain");
    expect(await service.apply(context, review)).toEqual(result);
    await expect(service.preview(context, input())).rejects.toThrow("already has");
    expect(provider.forget).toHaveBeenCalledTimes(1);
  });
  it("releases only a definite failure for a newly reviewed attempt", async () => {
    const review = await approved();
    vi.mocked(provider.forget!).mockResolvedValueOnce({
      ok: false,
      error: "Fact changed",
    });
    expect((await service.apply(context, review)).status).toBe("failed");
    expect((await service.apply(context, review)).status).toBe("failed");
    expect((await service.apply(context, await approved())).status).toBe("completed");
    expect(provider.forget).toHaveBeenCalledTimes(2);
  });
  it("does not allow compaction records or missing provider capabilities", async () => {
    await db.prisma.semanticMemoryMutation.update({
      where: { id: originalId },
      data: { sourceRunId: null },
    });
    await expect(service.preview(context, input())).rejects.toThrow("Conversation summaries");
    await db.prisma.semanticMemoryMutation.update({
      where: { id: originalId },
      data: { sourceRunId: "retained-run" },
    });
    Object.defineProperty(provider, "forget", { value: undefined, configurable: true });
    await expect(service.preview(context, input())).rejects.toThrow("cannot reverse");
  });
});
