import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { LocalAgentHomeStore } from "./home.js";

vi.mock("./computer-provisions.js", () => import("./computer-provisions.test-support.js"));

describe("cancelled computer provisioning", () => {
  it.each([
    { fresh: true, stage: "before" },
    ...[true, false].flatMap((fresh) =>
      ["provision", "prepare", "layout"].map((stage) => ({ fresh, stage })),
    ),
    { fresh: true, stage: "restore" },
  ])("cancels at $stage and cleans owned resources with fresh=$fresh", async ({ fresh, stage }) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "computer-cancel-"));
    const cancelled = new AbortController();
    const reason = new Error("Run cancelled during provisioning");
    if (stage === "before") cancelled.abort(reason);
    const context: AdapterContext = {
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      operationId: "provision-1",
      traceId: "trace-1",
      signal: cancelled.signal,
    };
    const ref = {
      id: "provider-1",
      providerRef: "provider-1",
      botId: "bot-1",
      kind: "fake" as const,
      fresh,
    };
    let running = true;
    const cleanup = vi.fn(async (_ref: unknown, ctx: AdapterContext) => {
      ctx.signal.throwIfAborted();
      running = false;
    });
    const releaseScreen = vi.fn(async (_ref: unknown, ctx: AdapterContext) =>
      ctx.signal.throwIfAborted(),
    );
    const prepare = vi.fn(async () => {
      if (stage === "prepare") cancelled.abort(reason);
    });
    const sandbox = {
      provision: vi.fn(async () => {
        // Several provider SDKs cannot cancel an allocation already accepted remotely.
        if (stage === "provision") cancelled.abort(reason);
        return ref;
      }),
      prepare,
      releaseScreen,
      destroy: vi.fn((ref: unknown, ctx: AdapterContext) => cleanup(ref, ctx)),
      stop: vi.fn((ref: unknown, ctx: AdapterContext) => cleanup(ref, ctx)),
      importWorkspace: vi.fn(async () => {
        if (stage === "restore") cancelled.abort(reason);
      }),
      execute: vi.fn(async function* () {
        if (stage === "layout") cancelled.abort(reason);
        yield { type: "exit", code: 0 };
      }),
    } as unknown as SandboxProvider;
    const updateMany = vi.fn(async (_input: unknown) => ({ count: 1 }));
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: fresh ? null : "provider-1",
          kind: "fake",
          scope: "team",
          state: "stopped",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00Z"),
        })),
        updateMany,
      },
    } as unknown as PrismaClient;
    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            dataDir,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBe(reason);
      if (stage === "before") {
        expect(sandbox.provision).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        return;
      }
      if (stage === "provision") expect(prepare).not.toHaveBeenCalled();
      expect(running).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(fresh ? sandbox.destroy : sandbox.stop).toHaveBeenCalledOnce();
      expect(fresh ? sandbox.stop : sandbox.destroy).not.toHaveBeenCalled();
      expect(releaseScreen).toHaveBeenCalledOnce();
      expect(cleanup.mock.calls[0]![1]).toMatchObject({
        ...context,
        signal: expect.any(AbortSignal),
      });
      expect(cleanup.mock.calls[0]![1].signal).not.toBe(context.signal);
      expect(
        updateMany.mock.calls.some(
          ([input]) => (input as { data?: { state?: string } }).data?.state === "running",
        ),
      ).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
