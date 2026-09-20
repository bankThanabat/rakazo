import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentRuntime,
  JobPublisher,
  SemanticMemorySaveResponse,
} from "@rakazo/adapter-kit";
import {
  beginSemanticHistoryMutation,
  createDb,
  createSemanticMemoryAudit,
  createThreadEvents,
  finishSemanticHistoryMutation,
  prepareSemanticMemoryUndo,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import type { ConfiguredMemoryProvider } from "../../adapters/src/memory-provider-factory.js";
import { SpaceMemoryProviderResolver } from "../../adapters/src/memory-provider-factory.js";
import { purgeSemanticHistory } from "../../adapters/src/semantic-history-purge.js";
import { SupermemoryMemoryProvider } from "../../adapters/src/supermemory-memory-provider.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const content = "Synthetic conversation summary.";
const receipt = {
  version: 1 as const,
  id: "summary-1",
  entity: "synthetic-history",
  content,
  created: true,
};
const confirmed: SemanticMemorySaveResponse = { ok: true, value: [receipt] };

describe.skipIf(!enabled)("background semantic history evidence", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let context: AdapterContext;
  let configured: ConfiguredMemoryProvider;
  let provider: SupermemoryMemoryProvider;
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
      operationId: "history-test",
      traceId: "history-test",
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
        spaceId: owner.spaceId,
        userId: owner.userId,
        provider: "supermemory",
        settings: {},
        secretId: secret.id,
      },
    });
    provider = new SupermemoryMemoryProvider({
      baseUrl: "http://127.0.0.1:6767",
      apiKey: "synthetic-unused-key",
    });
    vi.spyOn(provider, "save").mockResolvedValue(confirmed);
    vi.spyOn(provider, "purgeHistory").mockResolvedValue({ ok: true, value: undefined });
    configured = {
      provider,
      defaultScope: "isolated",
      configurationRevision: `${config.id}:${config.updatedAt.toISOString()}`,
    };
    await db.prisma.message.createMany({
      data: Array.from({ length: 50 }, (_, seq) => ({
        threadId: owner.threadId,
        seq,
        role: "user",
        blocks: [{ kind: "text", text: `Synthetic message ${seq}` }],
      })),
    });
    await db.prisma.thread.update({ where: { id: owner.threadId }, data: { nextMessageSeq: 50 } });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.prisma.space.deleteMany({ where: { id: owner.spaceId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
  });
  const binding = () => ({
    botId: owner.botId,
    scope: "isolated",
    provider: "supermemory",
    configurationRevision: configured.configurationRevision,
  });
  const intent = () => ({
    kind: "save" as const,
    threadId: owner.threadId,
    generation: 0,
    throughSeq: 49,
    content,
    previousSummary: null,
  });
  const storeLocal = () =>
    db.prisma.thread.update({
      where: { id: owner.threadId },
      data: { historyCompactedUpToSeq: 49, historyCompactionSummary: content },
    });
  const rows = () =>
    db.prisma.semanticMemoryMutation.findMany({
      where: { botId: owner.botId },
      orderBy: { createdAt: "asc" },
    });
  const clear = () =>
    createThreadEvents(db.prisma).clearThread({
      spaceId: owner.spaceId,
      botId: owner.botId,
      threadId: owner.threadId,
    });
  const compact = () =>
    compactHistory(
      {
        prisma: db.prisma,
        runtime: {
          describe: () => ({
            id: "synthetic",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { compaction: true },
          }),
          run: async function* () {
            yield { type: "done", text: content };
          },
        } as unknown as AgentRuntime,
        jobs: { enqueue: vi.fn() } as unknown as JobPublisher,
        memoryProviders: { resolve: async () => configured },
        resolveModel: async () => ({ provider: "synthetic", id: "synthetic" }),
      },
      owner.threadId,
    );

  it("records full provider receipts and real source provenance without a fabricated run", async () => {
    await compact();
    const [row] = await rows();
    expect(row).toMatchObject({
      sourceRunId: null,
      sourceThreadId: owner.threadId,
      status: "completed",
      result: confirmed,
      request: {
        source: { kind: "history", generation: 0 },
        throughSeq: 49,
        content,
        previousSummary: null,
      },
    });
    const audit = createSemanticMemoryAudit(db.prisma);
    expect(await audit.detail(context, row!.id)).toMatchObject({
      sourceThreadId: owner.threadId,
      requestedContent: content,
      changes: [{ before: { state: "absent" }, after: { state: "recorded", content } }],
    });
    expect((await audit.list(context)).items).toHaveLength(1);
    await compact();
    expect(provider.save).toHaveBeenCalledTimes(1);
    await expect(
      prepareSemanticMemoryUndo(db.prisma, context, binding(), {
        mutationId: row!.id,
        id: receipt.id,
        entity: receipt.entity,
        reason: "Remove summary",
      }),
    ).rejects.toThrow("Conversation summaries belong to history");
    await clear();
    expect(await audit.detail(context, row!.id)).toMatchObject({
      sourceThreadId: null,
      requestedContent: content,
    });
    const raw = await audit.read(context, { mutationId: row!.id });
    expect(raw.content).toContain('"sourceThreadId": null');
    expect(raw.content).toContain('"sourceRunId": null');
  });

  it("reserves only one concurrent dispatch and rejects retry after a missing response", async () => {
    await storeLocal();
    const attempts = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        beginSemanticHistoryMutation(db.prisma, context, binding(), intent()),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(await rows()).toMatchObject([{ status: "uncertain", result: null }]);
    await expect(
      beginSemanticHistoryMutation(db.prisma, context, binding(), intent()),
    ).rejects.toThrow();
  });

  it.each(["throw", "definite-failure", "uncertain", "outcome-storage-failure"] as const)(
    "retains %s without replaying a provider write",
    async (outcome) => {
      if (outcome === "throw")
        vi.mocked(provider.save).mockRejectedValueOnce(new Error("Lost response"));
      if (outcome === "definite-failure")
        vi.mocked(provider.save).mockResolvedValueOnce({
          ok: false,
          error: "Rejected",
          receipts: [],
          uncertainEntities: [],
        });
      if (outcome === "uncertain")
        vi.mocked(provider.save).mockResolvedValueOnce({
          ok: false,
          error: "Partial",
          receipts: [receipt],
          uncertainEntities: [receipt.entity],
        });
      if (outcome === "outcome-storage-failure")
        vi.spyOn(db.prisma.semanticMemoryMutation, "updateMany").mockRejectedValueOnce(
          new Error("Synthetic write failure"),
        );
      await compact();
      expect(await rows()).toMatchObject([
        { status: outcome === "definite-failure" ? "failed" : "uncertain" },
      ]);
      await compact();
      expect(provider.save).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "archived",
    "membership-revoked",
    "connection-replaced",
    "generation-changed",
    "cursor-changed",
    "wrong-owner",
  ] as const)("blocks reservation after %s", async (change) => {
    await storeLocal();
    if (change === "archived")
      await db.prisma.bot.update({ where: { id: owner.botId }, data: { archivedAt: new Date() } });
    if (change === "membership-revoked")
      await db.prisma.spaceMember.deleteMany({
        where: { spaceId: owner.spaceId, userId: owner.userId },
      });
    if (change === "connection-replaced")
      await db.prisma.spaceMemoryConfig.update({
        where: { spaceId: owner.spaceId },
        data: { updatedAt: new Date("2030-01-01") },
      });
    if (change === "generation-changed") await clear();
    if (change === "cursor-changed")
      await db.prisma.thread.update({
        where: { id: owner.threadId },
        data: { historyCompactedUpToSeq: 48 },
      });
    await expect(
      beginSemanticHistoryMutation(
        db.prisma,
        change === "wrong-owner" ? { ...context, userId: "other-user" } : context,
        binding(),
        intent(),
      ),
    ).rejects.toThrow();
    expect(await rows()).toEqual([]);
    expect(provider.save).not.toHaveBeenCalled();
  });

  it("keeps audit evidence when its source is deleted, and never recreates it after account erasure", async () => {
    await storeLocal();
    const id = await beginSemanticHistoryMutation(db.prisma, context, binding(), intent());
    await db.prisma.thread.delete({ where: { id: owner.threadId } });
    await finishSemanticHistoryMutation(db.prisma, context, id, confirmed);
    expect(await createSemanticMemoryAudit(db.prisma).detail(context, id)).toMatchObject({
      sourceThreadId: null,
      status: "completed",
    });
    await db.prisma.user.delete({ where: { id: owner.userId } });
    await expect(
      finishSemanticHistoryMutation(db.prisma, context, id, confirmed),
    ).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it("audits clear and a separate late-save purge, preserving the new generation", async () => {
    vi.mocked(provider.save).mockImplementationOnce(async () => {
      const { historyCompactionGeneration: clearedGeneration } = await clear();
      await purgeSemanticHistory(db.prisma, configured, context, {
        threadId: owner.threadId,
        generation: clearedGeneration + 1,
        generations: [clearedGeneration],
      });
      // A new generation can receive a summary while the old save is still awaiting its receipt.
      await db.prisma.thread.update({
        where: { id: owner.threadId },
        data: { historyCompactionSummary: "New conversation summary" },
      });
      return confirmed;
    });
    await compact();
    const recorded = await rows();
    expect(recorded).toHaveLength(3);
    expect(recorded.map((row) => row.operation)).toEqual(["save", "forget", "forget"]);
    expect(recorded[2]?.request).toMatchObject({ afterSaveId: recorded[0]!.id, generations: [0] });
    expect(recorded.every((row) => row.status === "completed")).toBe(true);
    expect(provider.purgeHistory).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(provider.purgeHistory).mock.calls)
      expect(request.generations).toEqual([0]);
    expect(await db.prisma.thread.findUnique({ where: { id: owner.threadId } })).toMatchObject({
      historyCompactionGeneration: 1,
      historyCompactionSummary: "New conversation summary",
    });
    await expect(
      purgeSemanticHistory(db.prisma, configured, context, {
        threadId: owner.threadId,
        generation: 1,
        generations: [1],
      }),
    ).rejects.toThrow();
    expect(provider.purgeHistory).toHaveBeenCalledTimes(2);
  });

  it("retains an unconfirmed purge and prevents automatic replay", async () => {
    await clear();
    vi.mocked(provider.purgeHistory).mockRejectedValueOnce(new Error("Response lost"));
    const input = { threadId: owner.threadId, generation: 1, generations: [0] };
    expect(await purgeSemanticHistory(db.prisma, configured, context, input)).toMatchObject({
      ok: false,
    });
    expect(await rows()).toMatchObject([
      { operation: "forget", status: "uncertain", result: { ok: false } },
    ]);
    await expect(purgeSemanticHistory(db.prisma, configured, context, input)).rejects.toThrow();
    expect(provider.purgeHistory).toHaveBeenCalledTimes(1);
  });

  it("cannot use a late-save receipt to purge a different generation", async () => {
    await storeLocal();
    const afterSaveId = await beginSemanticHistoryMutation(db.prisma, context, binding(), intent());
    await clear();
    await clear();
    await expect(
      purgeSemanticHistory(db.prisma, configured, context, {
        threadId: owner.threadId,
        generation: 2,
        generations: [1],
        afterSaveId,
      }),
    ).rejects.toThrow();
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });
});

// Exercise the real authenticated clear route, including provider resolution after clear.
it.skipIf(!enabled)(
  "clear RPC audits only the previous generation even when a new summary arrives",
  async () => {
    const origin = "http://127.0.0.1:5173";
    const dataDir = await mkdtemp(path.join(tmpdir(), "semantic-clear-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "synthetic-memory-encryption",
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `memory-clear-${randomUUID()}@example.test`,
          password: "password12",
          name: "Memory clear fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json: T };
        expect(response.ok, JSON.stringify(body)).toBe(true);
        return body.json;
      };
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Memory clear fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      const secret = await handles.prisma.secret.create({
        data: {
          userId: thread.userId,
          spaceId: thread.spaceId,
          kind: "memory",
          ciphertext: "synthetic-unused-secret",
        },
      });
      const config = await handles.prisma.spaceMemoryConfig.create({
        data: {
          userId: thread.userId,
          spaceId: thread.spaceId,
          provider: "supermemory",
          settings: {},
          secretId: secret.id,
        },
      });
      const provider = new SupermemoryMemoryProvider({
        baseUrl: "http://127.0.0.1:6767",
        apiKey: "synthetic-unused-key",
      });
      const purge = vi.spyOn(provider, "purgeHistory").mockImplementation(async (request) => {
        expect(request.generations).toEqual([0]);
        expect(
          await handles.prisma.semanticMemoryMutation.findFirst({ where: { botId: bot.id } }),
        ).toMatchObject({ status: "uncertain", result: null, operation: "forget" });
        return { ok: true, value: undefined };
      });
      vi.spyOn(SpaceMemoryProviderResolver.prototype, "resolve").mockImplementation(async () => {
        await handles.prisma.thread.update({
          where: { id: thread.id },
          data: { historyCompactionSummary: "New-generation summary" },
        });
        return {
          provider,
          defaultScope: "isolated",
          configurationRevision: `${config.id}:${config.updatedAt.toISOString()}`,
        };
      });
      expect(await rpc("threads/clear", { botId: bot.id })).toEqual({ ok: true });
      expect(purge).toHaveBeenCalledTimes(1);
      expect(
        await handles.prisma.semanticMemoryMutation.findFirst({ where: { botId: bot.id } }),
      ).toMatchObject({ status: "completed", sourceRunId: null, request: { generations: [0] } });
      expect(await handles.prisma.thread.findUnique({ where: { id: thread.id } })).toMatchObject({
        historyCompactionGeneration: 1,
        historyCompactionSummary: "New-generation summary",
      });
    } finally {
      vi.restoreAllMocks();
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
