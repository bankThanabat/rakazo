import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CustomerRuntime } from "@rakazo/adapter-kit";
import { createDb, provisionMessagingIdentity, requestAccountDeletion } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountDeletionService } from "./account-deletion.js";
import { LocalArtifactStore } from "./artifacts.js";
import { createCustomerPublications } from "./customer-publications.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { EncryptedSecretStore } from "./secrets.js";
import { InMemoryJobQueue } from "./wakeup.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const config = {
  baseUrl: "https://runtime.example.test/api/v1",
  apiKey: "synthetic-runtime-key",
  knowledge: { baseUrl: "https://knowledge.example.test", apiKey: "unneeded-knowledge-key" },
};
describe.skipIf(!enabled)("durable customer publications", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let publications: ReturnType<typeof createCustomerPublications>;
  let remove: ReturnType<typeof vi.fn<NonNullable<CustomerRuntime["removePublication"]>>>;
  let existing: Set<string>;
  const secrets = new EncryptedSecretStore("synthetic-publication-encryption-key");
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
    existing = new Set();
    remove = vi.fn(async ({ publicationId, beforeRemove }) => {
      if (!existing.has(publicationId)) return "absent" as const;
      await beforeRemove?.();
      existing.delete(publicationId);
      return "removed" as const;
    });
    publications = createCustomerPublications({
      prisma: db.prisma,
      secrets,
      runtime: (snapshot) => {
        expect(snapshot).toEqual({ baseUrl: config.baseUrl, apiKey: config.apiKey });
        return { reply: async () => "unused", removePublication: remove };
      },
    });
  });
  afterEach(async () => {
    await db.prisma.customerBehavior.deleteMany({ where: { botId: owner.botId } });
    await db.prisma.customerPublication.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.organization.deleteMany({ where: { id: owner.spaceId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
  });
  const begin = () => publications.begin(owner, config);
  const read = (id: string) => db.prisma.customerPublication.findUnique({ where: { id } });
  async function due(id: string) {
    await db.prisma.customerPublication.update({
      where: { id },
      data: { nextAttemptAt: new Date(0), expiresAt: new Date(0), leaseUntil: null },
    });
  }
  async function published() {
    const receipt = await begin();
    await receipt.beforeDispatch();
    existing.add(receipt.id);
    await receipt.record(`flow:${receipt.id}`);
    return receipt;
  }
  async function adopt(receipt: Awaited<ReturnType<typeof published>>) {
    await db.prisma.$transaction(async (tx) => {
      await receipt.adopt(tx);
      await tx.customerBehavior.upsert({
        where: { botId: owner.botId },
        create: {
          botId: owner.botId,
          publicationId: receipt.id,
          flowId: `flow:${receipt.id}`,
          instructions: "Synthetic policy",
        },
        update: {
          publicationId: receipt.id,
          flowId: `flow:${receipt.id}`,
          revision: { increment: 1 },
        },
      });
    });
  }
  function credentialRuntime() {
    let revoked = false;
    const inspect = vi.fn(
      async (id: string, key?: string) => key !== "another-account-key" && existing.has(id),
    );
    const service = createCustomerPublications({
      prisma: db.prisma,
      secrets,
      runtime: (endpoint) => {
        const authorize = () => {
          if (revoked && endpoint.apiKey === config.apiKey)
            throw new Error("Private revoked-key details");
        };
        return {
          identity: async () => {
            authorize();
            return endpoint.apiKey === "another-account-key"
              ? "another-account"
              : "fixture-account";
          },
          inspectPublication: async ({ publicationId }) => {
            authorize();
            return inspect(publicationId, endpoint.apiKey);
          },
          removePublication: async (input) => {
            authorize();
            return remove(input);
          },
          reply: async () => "unused",
        };
      },
    });
    return {
      service,
      inspect,
      revoke: () => {
        revoked = true;
      },
    };
  }
  const replacement = { baseUrl: config.baseUrl, apiKey: "replacement-runtime-key" };
  async function snapshot(id: string) {
    const row = (await read(id))!;
    return JSON.parse(secrets.load(row.ciphertext, row.id));
  }
  it("repairs a revoked cleanup key within the recorded runtime principal", async () => {
    const credentials = credentialRuntime();
    publications = credentials.service;
    const receipt = await published();
    await receipt.finish();
    expect(await snapshot(receipt.id)).toMatchObject({ principal: "fixture-account" });
    credentials.revoke();
    await publications.reconcile();
    expect(await read(receipt.id)).toMatchObject({ status: "cleanup", confirmed: true });
    expect(await publications.recoverCredentials(replacement)).toEqual({
      refreshed: 1,
      unverified: 0,
      failed: 0,
    });
    expect(await snapshot(receipt.id)).toEqual({ ...replacement, principal: "fixture-account" });
    expect(credentials.inspect).not.toHaveBeenCalled();
    await publications.reconcile();
    expect(await read(receipt.id)).toBeNull();
  });
  it("accepts another principal only after it can read the exact managed flow", async () => {
    const credentials = credentialRuntime();
    publications = credentials.service;
    const receipt = await published();
    credentials.inspect.mockResolvedValueOnce(true);
    expect(
      await publications.recoverCredentials({ ...replacement, apiKey: "another-account-key" }),
    ).toEqual({ refreshed: 1, unverified: 0, failed: 0 });
    expect((await snapshot(receipt.id)).principal).toBe("another-account");
    expect(existing.has(receipt.id)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
  it("fences dispatch when a concurrent repair changed the encrypted snapshot", async () => {
    publications = credentialRuntime().service;
    const receipt = await begin();
    const changed = secrets.seal(
      JSON.stringify({ ...replacement, principal: "fixture-account" }),
      receipt.id,
    );
    await db.prisma.customerPublication.update({
      where: { id: receipt.id },
      data: { ciphertext: changed },
    });
    await expect(receipt.beforeDispatch()).rejects.toThrow("expired before dispatch");
    expect((await read(receipt.id))?.ciphertext).toBe(changed);
    await receipt.finish();
    expect(await read(receipt.id)).toBeNull();
  });
  it("releases a preparation when runtime identity verification fails before dispatch", async () => {
    const credentials = credentialRuntime();
    publications = credentials.service;
    const receipt = await begin();
    credentials.revoke();
    await expect(receipt.beforeDispatch()).rejects.toThrow();
    await receipt.finish();
    expect(await read(receipt.id)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not interpret another account's absence as cleanup confirmation", async () => {
    const credentials = credentialRuntime();
    publications = credentials.service;
    const receipt = await published();
    await receipt.finish();
    const before = await read(receipt.id);
    expect(
      await publications.recoverCredentials({ ...replacement, apiKey: "another-account-key" }),
    ).toEqual({ refreshed: 0, unverified: 1, failed: 0 });
    expect(await read(receipt.id)).toEqual(before);
    expect(existing.has(receipt.id)).toBe(true);
  });
  it.each([true, false])(
    "preserves confirmation state when rotating credentials for an absent flow (confirmed=%s)",
    async (confirmed) => {
      const credentials = credentialRuntime();
      publications = credentials.service;
      const receipt = confirmed ? await published() : await begin();
      if (!confirmed) await receipt.beforeDispatch();
      await receipt.finish();
      existing.delete(receipt.id);
      credentials.revoke();
      expect((await publications.recoverCredentials(replacement)).refreshed).toBe(1);
      await publications.reconcile();
      expect(await read(receipt.id)).toEqual(
        confirmed ? null : expect.objectContaining({ status: "uncertain", confirmed: false }),
      );
    },
  );
  it.each([true, false])(
    "repairs older records only after observing their exact flow (present=%s)",
    async (present) => {
      const receipt = await published();
      await receipt.finish();
      if (!present) existing.delete(receipt.id);
      const credentials = credentialRuntime();
      expect(await credentials.service.recoverCredentials(replacement)).toEqual({
        refreshed: Number(present),
        unverified: Number(!present),
        failed: 0,
      });
      expect(credentials.inspect).toHaveBeenCalledTimes(1);
      expect((await snapshot(receipt.id)).apiKey).toBe(
        present ? replacement.apiKey : config.apiKey,
      );
    },
  );
  it("leaves active behavior and reply leases unchanged during credential repair", async () => {
    publications = credentialRuntime().service;
    const receipt = await published();
    await adopt(receipt);
    await publications.use(owner, { publicationId: receipt.id, flowId: `flow:${receipt.id}` });
    const before = (await read(receipt.id))!;
    const behavior = await db.prisma.customerBehavior.findUnique({ where: { botId: owner.botId } });
    expect((await publications.recoverCredentials(replacement)).refreshed).toBe(1);
    expect(await read(receipt.id)).toMatchObject({
      status: "active",
      confirmed: true,
      inUseUntil: before.inUseUntil,
    });
    expect(await db.prisma.customerBehavior.findUnique({ where: { botId: owner.botId } })).toEqual(
      behavior,
    );
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not redirect credentials to a different saved endpoint", async () => {
    publications = credentialRuntime().service;
    const receipt = await published();
    const before = await read(receipt.id);
    expect(
      await publications.recoverCredentials({
        ...replacement,
        baseUrl: "https://different.example.test/api/v1",
      }),
    ).toEqual({ refreshed: 0, unverified: 0, failed: 0 });
    expect(await read(receipt.id)).toEqual(before);
  });
  it("does not overwrite a concurrently repaired encrypted snapshot", async () => {
    const receipt = await published();
    const credentials = credentialRuntime();
    const newer = secrets.seal(
      JSON.stringify({ ...replacement, apiKey: "newer-fixture-key" }),
      receipt.id,
    );
    credentials.inspect.mockImplementationOnce(async () => {
      await db.prisma.customerPublication.update({
        where: { id: receipt.id },
        data: { ciphertext: newer },
      });
      return true;
    });
    expect(await credentials.service.recoverCredentials(replacement)).toEqual({
      refreshed: 0,
      unverified: 1,
      failed: 0,
    });
    expect((await read(receipt.id))?.ciphertext).toBe(newer);
  });
  it("keeps provider failure diagnostics out of recovery output and leaves the receipt intact", async () => {
    const receipt = await published();
    const before = await read(receipt.id);
    const credentials = credentialRuntime();
    credentials.inspect.mockRejectedValueOnce(new Error("private-fixture-credential"));
    expect(await credentials.service.recoverCredentials(replacement)).toEqual({
      refreshed: 0,
      unverified: 0,
      failed: 1,
    });
    expect(await read(receipt.id)).toEqual(before);
  });
  it("persists encrypted cleanup access before dispatch, without knowledge credentials", async () => {
    const receipt = await begin();
    const row = (await read(receipt.id))!;
    expect(row).toMatchObject({
      userId: owner.userId,
      spaceId: owner.spaceId,
      botId: owner.botId,
      status: "preparing",
      confirmed: false,
      flowId: null,
    });
    expect(row.ciphertext).not.toContain(config.apiKey);
    expect(JSON.parse(secrets.load(row.ciphertext, row.id))).toEqual({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
    expect(() => secrets.load(row.ciphertext, randomUUID())).toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
  it("releases a known undispatched failure and fences an expired preparation", async () => {
    const failure = await begin();
    await failure.finish();
    expect(await read(failure.id)).toBeNull();
    const expired = await begin();
    await due(expired.id);
    await publications.reconcile();
    await expect(expired.beforeDispatch()).rejects.toThrow("expired");
    expect(await read(expired.id)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
  it("keeps a committed adoption when the caller handles a lost transaction response", async () => {
    const receipt = await published();
    await adopt(receipt);
    await receipt.finish();
    await due(receipt.id);
    await publications.reconcile();
    expect(await read(receipt.id)).toMatchObject({ status: "active", confirmed: true });
    expect(existing.has(receipt.id)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
  it("rolls back adoption with the behavior and cleans the unused flow", async () => {
    const receipt = await published();
    await expect(
      db.prisma.$transaction(async (tx) => {
        await receipt.adopt(tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await receipt.finish();
    await publications.reconcile();
    expect(await read(receipt.id)).toBeNull();
    expect(existing.has(receipt.id)).toBe(false);
  });
  it("retains an absent uncertain create and cleans it after a delayed appearance", async () => {
    const receipt = await begin();
    await receipt.beforeDispatch();
    await receipt.finish();
    await publications.reconcile();
    expect(await read(receipt.id)).toMatchObject({ status: "uncertain", confirmed: false });
    existing.add(receipt.id);
    await due(receipt.id);
    await publications.reconcile();
    expect(await read(receipt.id)).toBeNull();
    expect(existing.has(receipt.id)).toBe(false);
  });
  it("recovers an interrupted publisher after its deadline without allowing late adoption", async () => {
    const receipt = await begin();
    await receipt.beforeDispatch();
    existing.add(receipt.id);
    await due(receipt.id);
    await publications.reconcile();
    await expect(receipt.record(`flow:${receipt.id}`)).rejects.toThrow("recovery");
    expect(await read(receipt.id)).toBeNull();
  });
  it("remembers observed creation before a lost delete response, then accepts absence", async () => {
    const receipt = await begin();
    await receipt.beforeDispatch();
    existing.add(receipt.id);
    await receipt.finish();
    remove.mockImplementationOnce(async ({ publicationId, beforeRemove }) => {
      await beforeRemove?.();
      existing.delete(publicationId);
      throw new Error("private upstream details");
    });
    await publications.reconcile();
    expect(await read(receipt.id)).toMatchObject({ status: "cleanup", confirmed: true });
    expect(JSON.stringify(await read(receipt.id))).not.toContain("private upstream details");
    await due(receipt.id);
    await publications.reconcile();
    expect(await read(receipt.id)).toBeNull();
  });
  it("keeps cleanup retryable when credentials or the provider are unavailable", async () => {
    const receipt = await published();
    await receipt.finish();
    remove.mockRejectedValueOnce(new Error("offline"));
    await publications.reconcile();
    expect(await read(receipt.id)).toMatchObject({
      status: "cleanup",
      confirmed: true,
      claimId: null,
    });
    expect(existing.has(receipt.id)).toBe(true);
    await due(receipt.id);
    await publications.reconcile();
    expect(await read(receipt.id)).toBeNull();
  });
  it("preserves a superseded flow while a reply lease is live and rejects new use of it", async () => {
    const old = await published();
    await adopt(old);
    await publications.use(owner, { publicationId: old.id, flowId: `flow:${old.id}` });
    const replacement = await published();
    await adopt(replacement);
    await publications.reconcile();
    expect(existing.has(old.id)).toBe(true);
    await expect(
      publications.use(owner, { publicationId: old.id, flowId: `flow:${old.id}` }),
    ).rejects.toThrow("changed");
    await db.prisma.customerPublication.update({
      where: { id: old.id },
      data: { inUseUntil: new Date(0) },
    });
    await publications.reconcile();
    expect(await read(old.id)).toBeNull();
    expect(existing.has(replacement.id)).toBe(true);
  });
  it("survives Space deletion and cleans using its retained credential snapshot", async () => {
    const receipt = await published();
    await adopt(receipt);
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    expect(await read(receipt.id)).not.toBeNull();
    await publications.reconcile();
    expect(await read(receipt.id)).toBeNull();
  });
  it("claims cleanup once across concurrent reconcilers", async () => {
    const receipt = await published();
    await receipt.finish();
    await Promise.all([publications.reconcile(), publications.reconcile()]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await read(receipt.id)).toBeNull();
  });
  it("resumes a crashed cleaner and prevents a stale callback from deleting", async () => {
    const receipt = await published();
    await receipt.finish();
    remove.mockImplementationOnce(async ({ beforeRemove }) => {
      await db.prisma.customerPublication.update({
        where: { id: receipt.id },
        data: { claimId: "replacement", leaseUntil: new Date(0) },
      });
      await expect(beforeRemove?.()).rejects.toThrow("claim expired");
      throw new Error("old worker stopped");
    });
    await publications.reconcile();
    expect(existing.has(receipt.id)).toBe(true);
    expect(await read(receipt.id)).toMatchObject({ status: "cleaning", claimId: "replacement" });
    await publications.reconcile();
    expect(await read(receipt.id)).toBeNull();
  });
  it("retains account cleanup credentials until reply use and remote deletion finish", async () => {
    const receipt = await published();
    await adopt(receipt);
    await publications.use(owner, { publicationId: receipt.id, flowId: `flow:${receipt.id}` });
    const dataDir = await mkdtemp(path.join(tmpdir(), "customer-publication-deletion-"));
    const jobs = new InMemoryJobQueue();
    try {
      const deletion = createAccountDeletionService({
        prisma: db.prisma,
        sandbox: new FakeSandboxProvider(),
        home: new LocalAgentHomeStore(dataDir),
        artifacts: new LocalArtifactStore(dataDir),
        jobs,
        dataDir,
        integrations: { removeUserAccounts: async () => undefined },
        knowledge: { purge: async () => undefined },
        connectors: { managed: () => undefined },
        reconcileCustomerPublications: publications.reconcile,
      });
      await requestAccountDeletion(db.prisma, owner.userId);
      await expect(begin()).rejects.toThrow();
      await deletion.process(owner.userId);
      expect(await db.prisma.bot.findUnique({ where: { id: owner.botId } })).toBeNull();
      expect(
        await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
      ).toMatchObject({ errorCode: "customer_runtime_cleanup_pending" });
      expect(await read(receipt.id)).not.toBeNull();
      expect(remove).not.toHaveBeenCalled();
      await db.prisma.customerPublication.update({
        where: { id: receipt.id },
        data: { inUseUntil: new Date(0) },
      });
      await db.prisma.accountDeletion.update({
        where: { userId: owner.userId },
        data: { nextAttemptAt: new Date(0) },
      });
      await deletion.process(owner.userId);
      expect(await read(receipt.id)).toBeNull();
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
      expect(existing.has(receipt.id)).toBe(false);
    } finally {
      await jobs.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
