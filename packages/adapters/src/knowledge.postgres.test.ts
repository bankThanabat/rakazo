import { randomUUID } from "node:crypto";
import type { ArtifactStore, JobPublisher, KnowledgeProvider } from "@rakazo/adapter-kit";
import { KnowledgeRejectedError } from "@rakazo/adapter-kit";
import { createDb, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createKnowledge } from "./knowledge.js";
import { createKnowledgeFixture } from "./knowledge-test-fixture.js";
import { EncryptedSecretStore } from "./secrets.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("shared knowledge persistence and access", () => {
  let db: ReturnType<typeof createDb>;
  let owners: Array<Awaited<ReturnType<typeof provisionMessagingIdentity>>>;
  let service: ReturnType<typeof createKnowledge>;
  let provider: KnowledgeProvider;
  let jobs: JobPublisher;
  let artifacts: ArtifactStore;
  let files = new Map<string, Uint8Array>();
  let indexed = new Map<string, string>();
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  beforeEach(() => {
    owners = [];
    files.clear();
    indexed.clear();
    const fixture = createKnowledgeFixture();
    provider = fixture.provider;
    jobs = fixture.jobs;
    files = fixture.files;
    indexed = fixture.indexed;
    artifacts = fixture.artifacts;
    service = createKnowledge({
      prisma: db.prisma,
      artifacts,
      secrets: new EncryptedSecretStore("fixture-key"),
      jobs,
      provider: () => provider,
    });
  });
  afterEach(async () => {
    for (const actor of owners) {
      await db.prisma.space.delete({ where: { id: actor.spaceId } });
      await db.prisma.user.delete({ where: { id: actor.userId } });
    }
  });
  async function setup() {
    const actor = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    owners.push(actor);
    await service.configure(actor, {
      botId: actor.botId,
      baseUrl: "http://localhost:8000/v1",
      apiKey: "fixture-rag-key",
    });
    await service.attach(actor, actor.botId, true);
    return actor;
  }
  async function upload(actor: Awaited<ReturnType<typeof setup>>, text: string, sourceId?: string) {
    await service.upload(actor, {
      botId: actor.botId,
      sourceId,
      name: "policy.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from(text).toString("base64"),
    });
    return db.prisma.knowledgeRevision.findFirstOrThrow({
      where: { source: { library: { spaceId: actor.spaceId } } },
      orderBy: { createdAt: "desc" },
    });
  }
  async function ready(id: string) {
    await service.process(id);
    await service.process(id);
  }
  const signal = () => AbortSignal.timeout(20_000);

  it("shares one revision according to Internal, rejects cross-space access and rechecks returned evidence", async () => {
    const actor = await setup();
    const other = await setup();
    const revision = await upload(actor, "Return within thirty days");
    await ready(revision.id);
    expect(await service.search(actor, actor.botId, "customer", "returns", signal())).toEqual([]);
    expect(await service.search(actor, actor.botId, "staff", "returns", signal())).toMatchObject([
      { revisionId: revision.id, text: "Return within thirty days" },
    ]);
    await expect(
      service.setInternal(other, other.botId, revision.sourceId, false),
    ).rejects.toThrow();
    await service.setInternal(actor, actor.botId, revision.sourceId, false);
    expect(await service.search(actor, actor.botId, "customer", "returns", signal())).toHaveLength(
      1,
    );
    expect(await service.search(other, other.botId, "customer", "returns", signal())).toEqual([]);
    vi.mocked(provider.search).mockImplementationOnce(async (_query, keys) => {
      await service.setInternal(actor, actor.botId, revision.sourceId, true);
      return [{ key: keys[0]!, text: "Return within thirty days" }];
    });
    await expect(
      service.search(actor, actor.botId, "customer", "returns", signal()),
    ).rejects.toThrow("access changed");
    await service.attach(actor, actor.botId, false);
    await expect(service.search(actor, actor.botId, "staff", "returns", signal())).rejects.toThrow(
      "attached",
    );
  });

  it("keeps the active revision when replacement fails and only activates the latest requested upload", async () => {
    const actor = await setup();
    const first = await upload(actor, "Original");
    await ready(first.id);
    const bad = await upload(actor, "Failed update", first.sourceId);
    await service.process(bad.id);
    vi.mocked(provider.status).mockResolvedValueOnce("failed");
    await service.process(bad.id);
    expect((await service.search(actor, actor.botId, "staff", "policy", signal()))[0]?.text).toBe(
      "Original",
    );
    const slow = await upload(actor, "Slow update", first.sourceId);
    const latest = await upload(actor, "Latest update", first.sourceId);
    await ready(latest.id);
    await ready(slow.id);
    expect((await service.search(actor, actor.botId, "staff", "policy", signal()))[0]?.text).toBe(
      "Latest update",
    );
    // Superseded, failed and out-of-order revisions are cleaned up while the source lives on.
    vi.mocked(jobs.enqueue).mockClear();
    await service.reconcile();
    expect(vi.mocked(jobs.enqueue).mock.calls.map(([job]) => job.payload)).toEqual(
      expect.arrayContaining([{ revisionId: first.id }, { revisionId: bad.id }]),
    );
    for (const revision of [first, bad]) await service.process(revision.id);
    expect(Array.from(indexed, ([name]) => name)).toEqual([latest.providerDocumentKey]);
    expect(files.size).toBe(1);
    await service.remove(actor, actor.botId, first.sourceId);
    expect(await service.search(actor, actor.botId, "staff", "policy", signal())).toEqual([]);
    for (const revision of [first, bad, slow, latest]) await service.process(revision.id);
    expect(indexed.size).toBe(0);
    expect(files.size).toBe(0);
  });

  it("does not resubmit an upload whose response was lost, and reconciles failed queue publication", async () => {
    const actor = await setup();
    vi.mocked(jobs.enqueue).mockRejectedValueOnce(new Error("queue offline"));
    const revision = await upload(actor, "Policy");
    await service.reconcile();
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    vi.mocked(provider.ingest).mockRejectedValueOnce(new Error("lost response"));
    await expect(service.process(revision.id)).rejects.toThrow("lost response");
    await service.process(revision.id);
    expect(provider.ingest).toHaveBeenCalledTimes(1);
    expect((await service.state(actor, actor.botId)).sources[0]?.status).toBe("failed");
    expect(await service.search(actor, actor.botId, "staff", "policy", signal())).toEqual([]);
    vi.mocked(jobs.enqueue).mockRejectedValueOnce(new Error("queue offline"));
    await expect(service.remove(actor, actor.botId, revision.sourceId)).resolves.toMatchObject({
      sources: [],
    });
    await service.process(revision.id);
    // The lost submission can finish after the first cleanup. Its tombstone must survive.
    indexed.set(revision.providerDocumentKey, "Late completion");
    vi.mocked(jobs.enqueue).mockClear();
    await service.reconcile();
    await service.process(revision.id);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(provider.remove).toHaveBeenCalledTimes(1);
    await db.prisma.knowledgeRevision.update({
      where: { id: revision.id },
      data: { cleanupAfter: null },
    });
    await service.process(revision.id);
    expect(indexed.size).toBe(0);
    expect(files.size).toBe(0);
    expect(await db.prisma.knowledgeRevision.count({ where: { id: revision.id } })).toBe(1);
    expect(provider.ingest).toHaveBeenCalledTimes(1);
    for (let attempt = 3; attempt <= 12; attempt++) {
      await db.prisma.knowledgeRevision.update({
        where: { id: revision.id },
        data: { cleanupAfter: null },
      });
      await service.process(revision.id);
    }
    expect(provider.remove).toHaveBeenCalledTimes(12);
    const terminal = await db.prisma.knowledgeRevision.findUniqueOrThrow({
      where: { id: revision.id },
    });
    expect(terminal.error).toContain("Cleanup paused");
    expect(terminal.cleanupAfter!.getTime()).toBeGreaterThan(Date.now());
    await db.prisma.knowledgeRevision.update({
      where: { id: revision.id },
      data: { cleanupAfter: null },
    });
    await service.reconcile();
    await service.process(revision.id);
    expect(provider.remove).toHaveBeenCalledTimes(12);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("retries a local read failure, records a definite rejection and purges a space", async () => {
    const actor = await setup();
    const revision = await upload(actor, "Policy");
    vi.spyOn(artifacts, "get").mockRejectedValueOnce(new Error("storage offline"));
    await expect(service.process(revision.id)).rejects.toThrow("storage offline");
    await ready(revision.id);
    expect((await service.state(actor, actor.botId)).sources[0]?.status).toBe("ready");
    vi.mocked(provider.ingest).mockRejectedValueOnce(new KnowledgeRejectedError());
    const rejected = await upload(actor, "Rejected");
    await service.process(rejected.id);
    expect(
      await db.prisma.knowledgeRevision.findUniqueOrThrow({ where: { id: rejected.id } }),
    ).toMatchObject({
      status: "failed",
      submittedAt: null,
      error: expect.stringContaining("rejected"),
    });
    await service.purge(actor.spaceId);
    expect(indexed.size).toBe(0);
    expect(files.size).toBe(0);
    expect(await service.state(actor, actor.botId)).toMatchObject({ sources: [] });
  });

  it("downloads the active revision with its original name and retries partial deletion", async () => {
    const actor = await setup();
    const first = await upload(actor, "Original");
    await ready(first.id);
    await service.upload(actor, {
      botId: actor.botId,
      sourceId: first.sourceId,
      name: "replacement.md",
      mimeType: "text/markdown",
      contentBase64: Buffer.from("# Replacement").toString("base64"),
    });
    const source = await db.prisma.knowledgeSource.findUniqueOrThrow({
      where: { id: first.sourceId },
    });
    expect(await service.download(actor, actor.botId, source.id)).toMatchObject({
      name: "policy.txt",
      mimeType: "text/plain",
    });
    await ready(source.pendingRevisionId!);
    expect(await service.download(actor, actor.botId, source.id)).toMatchObject({
      name: "replacement.md",
      mimeType: "text/markdown",
    });
    expect((await service.state(actor, actor.botId)).sources[0]?.name).toBe("replacement.md");
    await service.remove(actor, actor.botId, source.id);
    vi.spyOn(artifacts, "remove").mockRejectedValueOnce(new Error("storage offline"));
    await expect(service.process(first.id)).rejects.toThrow("storage offline");
    expect(indexed.has(first.providerDocumentKey)).toBe(false);
    await db.prisma.knowledgeRevision.update({
      where: { id: first.id },
      data: { cleanupAfter: null },
    });
    await service.process(first.id);
    expect(await db.prisma.knowledgeRevision.count({ where: { id: first.id } })).toBe(0);
    await service.process(source.pendingRevisionId!);
    expect(files.size).toBe(0);
  });
});
