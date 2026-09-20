import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef } from "@rakazo/adapter-kit";
import type { ThreadEvents } from "@rakazo/db";
import {
  computerScopeKey,
  createDb,
  provisionMessagingIdentity,
  requestAccountDeletion,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountDeletionService } from "./account-deletion.js";
import { LocalArtifactStore } from "./artifacts.js";
import { destroyBot } from "./child-bots.js";
import { provisionComputer, replaceComputer } from "./computer-lifecycle.js";
import { beginComputerProvision, reconcileComputerProvisions } from "./computer-provisions.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { NoneSandboxProvider } from "./none-sandbox.js";
import { InMemoryJobQueue } from "./wakeup.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(!enabled)("durable computer provisioning", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let deps: Parameters<typeof createAccountDeletionService>[0] & { events: ThreadEvents };
  let computerId: string;
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
    const dataDir = await mkdtemp(path.join(tmpdir(), "provision-receipts-"));
    deps = {
      prisma: db.prisma,
      sandbox: new FakeSandboxProvider(),
      home: new LocalAgentHomeStore(dataDir),
      jobs: new InMemoryJobQueue(),
      artifacts: new LocalArtifactStore(dataDir),
      dataDir,
      integrations: { removeUserAccounts: vi.fn(async () => undefined) },
      knowledge: { purge: vi.fn(async () => undefined) },
      connectors: { managed: () => undefined },
      events: {} as ThreadEvents,
    };
    const computer = await db.prisma.computer.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        scope: "dedicated",
        scopeKey: computerScopeKey("dedicated", owner.spaceId, owner.botId),
        homeKey: owner.botId,
        kind: "fake",
      },
    });
    computerId = computer.id;
    await db.prisma.bot.update({ where: { id: owner.botId }, data: { computerId } });
  });
  afterEach(async () => {
    await deps.jobs.close();
    await db.prisma.computerProvision.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.organization.deleteMany({ where: { id: owner.spaceId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
    await rm(deps.dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const context = () => ({
    ...owner,
    operationId: "fixture",
    traceId: "fixture",
    signal: new AbortController().signal,
  });
  it("does not leave uncertain provisioning when computers are disabled", async () => {
    deps.sandbox = new NoneSandboxProvider();
    await expect(provisionComputer(deps, computerId, context())).rejects.toThrow(
      "Computers unavailable",
    );
    expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(0);
    expect((await db.prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).state).toBe(
      "error",
    );

    deps.sandbox = new FakeSandboxProvider();
    await provisionComputer(deps, computerId, context());
    expect((await db.prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).state).toBe(
      "running",
    );
  });

  async function claim() {
    const computer = await db.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    return beginComputerProvision(db.prisma, computer, context(), {
      where: { id: computerId },
      data: { state: "booting" },
    });
  }
  async function retryDeletion() {
    await db.prisma.accountDeletion.update({
      where: { userId: owner.userId },
      data: { nextAttemptAt: new Date(0) },
    });
    await createAccountDeletionService(deps).process(owner.userId);
  }

  it("adopts a successful allocation and clears its receipt atomically", async () => {
    const ref = await provisionComputer(deps, computerId, context());
    expect(await db.prisma.computerProvision.count({ where: { userId: owner.userId } })).toBe(0);
    expect(await db.prisma.computer.findUnique({ where: { id: computerId } })).toMatchObject({
      state: "running",
      providerRef: ref.providerRef,
    });
  });

  it.each(["running", "stopped"])(
    "keeps a %s allocation and allows retry after restoring its provider",
    async (state) => {
      const original = deps.sandbox;
      const first = await provisionComputer(deps, computerId, context());
      await original.writeFile(
        first,
        { path: "notes.txt", content: Buffer.from("Existing work") },
        context(),
      );
      if (state === "stopped") {
        await original.stop(first, context());
        await db.prisma.computer.update({ where: { id: computerId }, data: { state } });
      }
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected provider call"));
      deps.sandbox = new DockerSandboxProvider("http://supervisor.example.test", "synthetic");
      await expect(provisionComputer(deps, computerId, context())).rejects.toThrow(
        "Computer provider does not match",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.prisma.computer.findUnique({ where: { id: computerId } })).toMatchObject({
        providerRef: first.providerRef,
        kind: first.kind,
      });
      expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(0);
      deps.sandbox = original;
      const resumed = await provisionComputer(deps, computerId, context());
      expect(resumed).toMatchObject({ providerRef: first.providerRef, fresh: false });
      expect(Buffer.from(await original.readFile(resumed, "notes.txt", context())).toString()).toBe(
        "Existing work",
      );
    },
  );

  it("retains the old reference on failed Recover teardown and retries without losing saved work", async () => {
    const first = await provisionComputer(deps, computerId, context());
    await deps.sandbox.writeFile(
      first,
      { path: "notes.txt", content: Buffer.from("Existing work") },
      context(),
    );
    const destroy = vi
      .spyOn(deps.sandbox, "destroy")
      .mockRejectedValue(new Error("Synthetic teardown outage"));
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(replaceComputer(deps, computerId, "recover", context())).rejects.toThrow(
      "Synthetic teardown outage",
    );
    expect(provision).not.toHaveBeenCalled();
    expect(await db.prisma.computer.findUnique({ where: { id: computerId } })).toMatchObject({
      providerRef: first.providerRef,
      state: "error",
    });
    destroy.mockRestore();
    const replaced = await replaceComputer(deps, computerId, "recover", context());
    expect(replaced.fresh).toBe(true);
    expect(
      Buffer.from(await deps.sandbox.readFile(replaced, "notes.txt", context())).toString(),
    ).toBe("Existing work");
  });

  it("retains a late allocation after bot removal and retries failed cleanup after restart", async () => {
    const entered = deferred();
    const release = deferred();
    const original = deps.sandbox.provision.bind(deps.sandbox);
    let allocated: ComputerRef | undefined;
    vi.spyOn(deps.sandbox, "provision").mockImplementation(async (request, ctx) => {
      allocated = await original(request, ctx);
      entered.resolve();
      await release.promise;
      return { ...allocated, fresh: true };
    });
    let outage = true;
    const destroy = vi.spyOn(deps.sandbox, "destroy").mockImplementation(async () => {
      if (outage) throw new Error("Synthetic cleanup failure");
    });
    const boot = provisionComputer(deps, computerId, context()).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      await requestAccountDeletion(db.prisma, owner.userId);
      await createAccountDeletionService(deps).process(owner.userId);
      expect(deps.integrations.removeUserAccounts).not.toHaveBeenCalled();
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
      const bot = await db.prisma.bot.findUniqueOrThrow({ where: { id: owner.botId } });
      await destroyBot(deps, bot, context(), { deleteMemories: true });
      expect(await db.prisma.computer.findUnique({ where: { id: computerId } })).toBeNull();
      expect(await db.prisma.computerProvision.count({ where: { userId: owner.userId } })).toBe(1);
    } finally {
      release.resolve();
    }
    expect(await boot).toBeInstanceOf(AggregateError);
    expect(await db.prisma.computerProvision.findUnique({ where: { computerId } })).toMatchObject({
      status: "cleanup",
      cleanup: "destroy",
      providerRef: allocated!.providerRef,
    });
    await retryDeletion();
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
    outage = false;
    await retryDeletion();
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: allocated!.providerRef }),
      expect.objectContaining({ userId: owner.userId, spaceId: owner.spaceId }),
    );
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
    expect(await db.prisma.computerProvision.count({ where: { userId: owner.userId } })).toBe(0);
  });

  it.each(["stopped", "running"])(
    "keeps an unknown outcome from %s and prevents a duplicate allocation",
    async (state) => {
      const existing =
        state === "running" ? await provisionComputer(deps, computerId, context()) : null;
      const provision = vi
        .spyOn(deps.sandbox, "provision")
        .mockRejectedValue(new Error("Lost response"));
      await expect(provisionComputer(deps, computerId, context())).rejects.toThrow("Lost response");
      expect(await db.prisma.computerProvision.findUnique({ where: { computerId } })).toMatchObject(
        {
          status: "uncertain",
          providerRef: null,
        },
      );
      await expect(provisionComputer(deps, computerId, context())).rejects.toThrow();
      expect(provision).toHaveBeenCalledOnce();
      expect(await db.prisma.computer.findUnique({ where: { id: computerId } })).toMatchObject({
        state: existing ? "running" : "error",
        providerRef: existing?.providerRef ?? null,
      });
      await requestAccountDeletion(db.prisma, owner.userId);
      await createAccountDeletionService(deps).process(owner.userId);
      expect(deps.integrations.removeUserAccounts).not.toHaveBeenCalled();
      expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
    },
  );

  it("rejects new provisioning after deletion was requested", async () => {
    await requestAccountDeletion(db.prisma, owner.userId);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, computerId, context())).rejects.toThrow();
    expect(provision).not.toHaveBeenCalled();
    expect(await db.prisma.computerProvision.count({ where: { userId: owner.userId } })).toBe(0);
  });

  it("rejects another account's computer before dispatch", async () => {
    const other = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    try {
      const provision = vi.spyOn(deps.sandbox, "provision");
      await expect(
        provisionComputer(deps, computerId, { ...context(), ...other }),
      ).rejects.toThrow();
      expect(provision).not.toHaveBeenCalled();
      expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(0);
      expect(await db.prisma.computer.findUnique({ where: { id: computerId } })).toMatchObject({
        state: "stopped",
      });
    } finally {
      await db.prisma.organization.deleteMany({ where: { id: other.spaceId } });
      await db.prisma.user.deleteMany({ where: { id: other.userId } });
    }
  });

  it("prevents cascading its owner or Space while provisioning is unresolved", async () => {
    await claim();
    await expect(db.prisma.user.delete({ where: { id: owner.userId } })).rejects.toMatchObject({
      code: "P2003",
    });
    await expect(db.prisma.space.delete({ where: { id: owner.spaceId } })).rejects.toMatchObject({
      code: "P2003",
    });
    expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(1);
  });

  it("admits only one cleanup worker and preserves its receipt until confirmation", async () => {
    const receipt = await claim();
    const ref = {
      id: "example",
      providerRef: "example",
      botId: owner.botId,
      kind: "fake" as const,
      fresh: true,
    };
    await receipt!.record(ref, "destroy");
    await receipt!.finish(true, ref, true);
    const entered = deferred();
    const release = deferred();
    const destroy = vi.spyOn(deps.sandbox, "destroy").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const first = reconcileComputerProvisions(deps);
    try {
      await entered.promise;
      await reconcileComputerProvisions(deps);
      expect(destroy).toHaveBeenCalledOnce();
      expect(await db.prisma.computerProvision.findUnique({ where: { computerId } })).toMatchObject(
        { status: "cleaning" },
      );
      await expect(claim()).resolves.toBeNull();
    } finally {
      release.resolve();
      await first;
    }
    expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(0);
  });

  async function failedCleanup(replaySafe = true, action: "stop" | "destroy" = "destroy") {
    const descriptor = deps.sandbox.describe();
    vi.spyOn(deps.sandbox, "describe").mockReturnValue({
      ...descriptor,
      capabilities: { ...descriptor.capabilities, replaySafeDestroy: replaySafe },
    });
    const receipt = await claim();
    const ref = {
      id: "old-allocation",
      providerRef: "old-allocation",
      botId: owner.botId,
      kind: "fake" as const,
    };
    await receipt!.record(ref, action);
    await receipt!.finish(true, ref, true);
  }

  it("recovers an expired deletion claim when replay cannot affect a later allocation", async () => {
    await failedCleanup();
    await db.prisma.computerProvision.update({
      where: { computerId },
      data: { status: "cleaning", updatedAt: new Date(0) },
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await reconcileComputerProvisions(deps);
    expect(destroy).toHaveBeenCalledOnce();
    expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(0);
  });

  it("resumes account deletion after an abandoned deletion claim expires", async () => {
    await failedCleanup();
    await db.prisma.computerProvision.update({
      where: { computerId },
      data: { status: "cleaning" },
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await requestAccountDeletion(db.prisma, owner.userId);
    await createAccountDeletionService(deps).process(owner.userId);
    expect(destroy).not.toHaveBeenCalled();
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    await retryDeletion();
    expect(destroy).toHaveBeenCalledOnce();
    expect(await db.prisma.user.findUnique({ where: { id: owner.userId } })).toBeNull();
  });

  it.each(["stop", "unsupported", "different-provider", "active", "uncertain", "fresh"] as const)(
    "does not reclaim %s cleanup",
    async (reason) => {
      await failedCleanup(reason !== "unsupported", reason === "stop" ? "stop" : "destroy");
      await db.prisma.computerProvision.update({
        where: { computerId },
        data: {
          status: reason === "active" || reason === "uncertain" ? reason : "cleaning",
          updatedAt: reason === "fresh" ? new Date() : new Date(0),
          ...(reason === "different-provider" ? { kind: "desktop" } : {}),
        },
      });
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      const stop = vi.spyOn(deps.sandbox, "stop");
      await reconcileComputerProvisions(deps);
      expect(destroy).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(1);
    },
  );

  it.each([
    { fails: false, afterCompletion: false },
    { fails: true, afterCompletion: false },
    { fails: false, afterCompletion: true },
    { fails: true, afterCompletion: true },
  ])("a stale cleanup worker cannot clear newer work %j", async ({ fails, afterCompletion }) => {
    await failedCleanup();
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    let calls = 0;
    vi.spyOn(deps.sandbox, "destroy").mockImplementation(async () => {
      const index = calls++;
      entered[index]!.resolve();
      await release[index]!.promise;
      if (!index && fails) throw new Error("Delayed failure");
    });
    const first = reconcileComputerProvisions(deps);
    let second: Promise<void> | undefined;
    try {
      await entered[0]!.promise;
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
      second = reconcileComputerProvisions(deps);
      // The call count is also the regression assertion; don't wait on a gate the old code never enters.
      await Promise.race([entered[1]!.promise, second]);
      expect(calls).toBe(2);
      const winner = await db.prisma.computerProvision.findUniqueOrThrow({
        where: { computerId },
      });
      if (afterCompletion) {
        release[1]!.resolve();
        await second;
        expect(await claim()).not.toBeNull();
      }
      release[0]!.resolve();
      await first;
      const current = await db.prisma.computerProvision.findUniqueOrThrow({
        where: { computerId },
      });
      if (afterCompletion) {
        expect(current.id).not.toBe(winner.id);
        expect(current.status).toBe("active");
      } else {
        expect(current).toMatchObject({ status: "cleaning", updatedAt: winner.updatedAt });
      }
      await expect(claim()).resolves.toBeNull();
    } finally {
      for (const gate of release) gate.resolve();
      await Promise.all([first, second]);
    }
    expect(await db.prisma.computerProvision.count({ where: { computerId } })).toBe(
      afterCompletion ? 1 : 0,
    );
  });
});
