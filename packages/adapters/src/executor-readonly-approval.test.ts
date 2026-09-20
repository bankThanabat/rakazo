import type { AgentRunRequest, ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { buildSkillMd } from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import type * as AutoReviewModule from "./auto-review.js";
import { runAutoReviewJudge } from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

function fixture({
  name = "demo_get_item",
  catalog = false,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  trigger = "user",
  groupId = null as string | null,
  channel = false,
  prompt = "Read the item",
} = {}) {
  const tool: ConnectorTool = {
    name,
    description: "Read an item",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    route: { connectorId: "demo", resourceId: "resource-1", toolName: name },
  };
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    sourceMessageId: channel ? "source-message" : null,
    leaseFence: 0,
  };
  const externalEffect = {
    findMany: vi.fn(async () => effects.filter((effect) => effect.status === "approved")),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findFirst: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId })),
      count: vi.fn(async () => 1),
    },
    chatGroup: { findUnique: vi.fn(async () => null) },
    message: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({
        blocks: channel
          ? [{ kind: "channel_message", channelId: "group-channel", text: "Use a recipe" }]
          : [],
      })),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: {
      findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "skill-1",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
    },
    agentSkillRevision: { create: vi.fn(async () => ({})) },
    $transaction: async function <T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      return work(this);
    },
    $queryRaw: vi.fn(async () => [{ id: "owner" }]),
    accountDeletion: { count: vi.fn(async () => 0) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: autoReview })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let calls: Array<{ args: Record<string, unknown>; executionId: string }> = [
    {
      args:
        name === "memory_undo" || name === "memory_restore"
          ? {
              documentId: "memory-1",
              revision: 1,
              expectedRevision: 2,
              reason: "Review",
              reviewedContent: "Original fact",
            }
          : name === "customer_learning_decide"
            ? { taskId: "learning-task", decision: "reject", reason: "Not reusable" }
            : { id: "item-1" },
      executionId: "call-1",
    },
  ];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(
        catalog ? "demo_execute_tool" : name,
        catalog ? { id: `resource-1:${name}`, arguments: call.args } : call.args,
        call.executionId,
      );
      results.push(result);
      if (isApprovalPausedResult(result)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const manage = vi.fn(async () => ({ ok: true }));
  const executor = createRunExecutor({
    customers: { manage },
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () =>
        catalog
          ? [
              {
                name: "demo_execute_tool",
                description: "Execute a catalog tool",
                inputSchema: { type: "object" },
                route: { connectorId: "demo", toolName: "__catalog_execute" },
              },
            ]
          : [tool],
      resolveCall: async (call: ConnectorCall) =>
        catalog ? resolveCatalogCall(call, catalogEntries([tool])) : undefined,
      execute,
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    prisma,
    runtimeRun,
    manage,
    effects,
    results,
    execute,
    pauseRunForInput,
    setCalls(next: typeof calls) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("connector read-only metadata and approval enforcement", () => {
  beforeEach(() => {
    vi.mocked(runAutoReviewJudge).mockReset();
  });

  it("completes and deduplicates customer configuration effects", async () => {
    const f = fixture({ name: "customer_instructions" });
    f.setCalls([
      { args: { id: "item-1" }, executionId: "same-call" },
      { args: { id: "item-1" }, executionId: "same-call" },
    ]);
    await f.run();
    expect(f.manage).toHaveBeenCalledTimes(1);
    expect(f.effects[0]?.status).toBe("completed");
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it.each([
    "customer_purchases",
    "customer_purchase_quote",
    "customer_purchase_status",
    "customer_alert_line",
  ])("does not copy %s read results into external effects", async (name) => {
    const f = fixture({ name });
    await f.run();
    expect(f.manage).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(0);
    expect(f.results).toEqual([{ ok: true }]);
  });

  it.each(["memory_undo", "memory_restore"])(
    "rejects %s before approval when replacement text is absent",
    async (name) => {
      const f = fixture({ name });
      f.setCalls([
        {
          args: { documentId: "memory-1", revision: 1, expectedRevision: 2, reason: "Review" },
          executionId: "missing-text",
        },
      ]);
      await f.run();
      expect(f.effects).toHaveLength(0);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(f.results).toEqual([{ error: expect.stringContaining("reviewedContent") }]);
    },
  );

  it.each([
    "customer_operation_confirm",
    "customer_operation_retry",
    "customer_identity_set",
    "customer_purchase_close",
    "customer_purchase_start",
    "customer_purchase_update",
    "customer_purchase_checkout",
    "customer_purchase_review",
    "customer_purchase_reconcile",
    "customer_alert_line_test",
    "customer_alert_line_verify",
    "customer_alert_line_disable",
    "memory_undo",
    "memory_restore",
    "customer_learning_history_start",
    "customer_learning_source_configure",
    "customer_learning_source_remove",
    "customer_learning_decide",
    "customer_learning_remove_source",
  ])("requires a staff decision for %s even with an allow policy", async (name) => {
    const pending = fixture({ name });
    await pending.run();
    expect(pending.manage).not.toHaveBeenCalled();
    expect(pending.pauseRunForInput).toHaveBeenCalledOnce();
    const allowed = fixture({
      name,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
    });
    await allowed.run();
    expect(allowed.manage).not.toHaveBeenCalled();
    expect(allowed.pauseRunForInput).toHaveBeenCalledOnce();
  });

  it.each([
    "customer_notifications",
    "customer_learning_save",
    "customer_learning_undo",
    "customer_learning_restore",
    "customer_learning_archive_import",
    "customer_instructions",
    "customer_disconnect",
    "customer_steer",
  ])("applies configured automatic review to %s", async (name) => {
    vi.mocked(runAutoReviewJudge).mockResolvedValue({
      decision: "ask",
      reason: "Staff review needed",
      model: "scripted/checker",
    });
    const f = fixture({ name, autoReview: true });
    await f.run();
    expect(runAutoReviewJudge).toHaveBeenCalledOnce();
    expect(f.manage).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
  });

  it.each([
    "customer_configure",
    "customer_initialize",
    "customer_assessment",
    "customer_learning_configure",
  ])("requires owner approval for %s even with an allow rule", async (name) => {
    const f = fixture({
      name,
      autoReview: true,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
    });
    await f.run();
    expect(f.manage).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    expect(runAutoReviewJudge).not.toHaveBeenCalled();
  });

  it.each([
    { name: "customer_initialize", operation: "initialize", args: {} },
    {
      name: "customer_learning_configure",
      operation: "learning_configure",
      args: { enabled: false },
    },
  ])(
    "executes $name once after approval and reuses the result on retry",
    async ({ name, operation, args }) => {
      const f = fixture({ name });
      f.setCalls([{ args, executionId: "prepare" }]);
      await f.run();
      expect(f.manage).not.toHaveBeenCalled();
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.request).toEqual(args);
      f.effects[0]!.status = "approved";
      f.setCalls([
        { args, executionId: "approved-prepare" },
        { args, executionId: "retry-prepare" },
      ]);
      await f.run();
      expect(f.manage).toHaveBeenCalledOnce();
      expect(f.manage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", spaceId: "space-1" }),
        "bot-1",
        operation,
        args,
        expect.any(AbortSignal),
      );
      expect(f.results.slice(1)).toEqual([{ ok: true }, { ok: true }]);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    },
  );

  it.each(["shell", "write_file"])(
    "forces owner approval for webhook-triggered %s despite an allow rule",
    async (name) => {
      const f = fixture({
        name,
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    },
  );

  describe.each([false, true])("catalog = %s", (catalog) => {
    it.each(["tool", "connector"] as const)(
      "honors an explicit %s approval rule",
      async (matchKind) => {
        const f = fixture({
          catalog,
          autoReview: true,
          rules: [
            {
              effect: "require_approval",
              matchKind,
              matchValue: matchKind === "tool" ? "demo_get_item" : "demo",
            },
          ],
        });
        await f.run();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.pauseRunForInput).toHaveBeenCalledOnce();
        expect(f.pauseRunForInput).toHaveBeenCalledWith(
          expect.objectContaining({
            blocks: [expect.objectContaining({ kind: "ask", approvalEffectId: f.effects[0]!.id })],
          }),
        );
        expect(isApprovalPausedResult(f.results[0])).toBe(true);
        expect(runAutoReviewJudge).not.toHaveBeenCalled();
      },
    );

    it("replays the approved arguments once and returns the result on retry", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      f.setCalls([
        { args: { id: "model-reconstructed" }, executionId: "call-2" },
        { args: { id: "item-1" }, executionId: "call-3" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: { id: "item-1" },
          executionId: approvalEffectKey("run-1", "demo_get_item", { id: "item-1" }),
        }),
        expect.anything(),
      );
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.slice(1)).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("honors a persisted denial on a new tool call id", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "denied";
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toEqual({ error: "User denied this action." });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("consumes the saved approval after the user chooses always allow", async () => {
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("allows ordinary reads without approval or automatic review", async () => {
      const f = fixture({ catalog, autoReview: true });
      f.setCalls([
        { args: { id: "item-1" }, executionId: "call-1" },
        { args: { id: "item-1" }, executionId: "call-2" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.results).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    });

    it("keeps an explicit allow rule ahead of automatic review", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    });

    it("forces owner approval for webhook-triggered writes despite an allow rule", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
    });

    it.each(["ask", "error", "pass"] as const)(
      "honors automatic review %s despite a read-only hint",
      async (decision) => {
        vi.mocked(runAutoReviewJudge).mockResolvedValue({
          decision,
          reason: "Review result",
          model: "scripted/checker",
        });
        const f = fixture({ catalog, name: "demo_send_message", autoReview: true });
        await f.run();
        expect(runAutoReviewJudge).toHaveBeenCalledOnce();
        expect(f.effects[0]?.reviewDecision).toBe(decision);
        expect(f.execute).toHaveBeenCalledTimes(decision === "pass" ? 1 : 0);
        expect(f.pauseRunForInput).toHaveBeenCalledTimes(decision === "pass" ? 0 : 1);
      },
    );
  });
});

describe("private skill execution and consent", () => {
  beforeEach(() => {
    vi.mocked(runAutoReviewJudge).mockReset();
  });
  const content = buildSkillMd({
    name: "Private recipe",
    description: "Private recipe",
    body: "PRIVATE_SKILL_SENTINEL",
  });
  const args = { content, expectedRevision: 0, reason: "Save a reusable recipe" };
  it.each([
    { trigger: "user", groupId: "shared", channel: false },
    { trigger: "messaging", groupId: null, channel: true },
    { trigger: "webhook", groupId: null, channel: false },
  ])("excludes private skill catalog, injected text and direct calls for %o", async (options) => {
    const f = fixture({ ...options, name: "skill_read", prompt: "/Private recipe" });
    f.prisma.agentSkill.findMany.mockResolvedValue([
      {
        id: "private-skill",
        name: "Private recipe",
        description: "Private recipe",
        content,
        source: "user",
        revision: 1,
        removedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]);
    f.setCalls([{ args: { name: "Private recipe" }, executionId: "read-private" }]);
    await f.run();
    expect(f.prisma.agentSkill.findMany).not.toHaveBeenCalled();
    expect(f.prisma.taughtSkill.findMany).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.runtimeRun.mock.calls)).not.toContain("PRIVATE_SKILL_SENTINEL");
    expect(f.results[0]).toMatchObject({ error: expect.any(String) });
    expect(f.effects).toEqual([]);
  });
  it("denies routine skill mutations even when directly invoked", async () => {
    const f = fixture({ name: "skill_create", trigger: "routine" });
    f.setCalls([{ args, executionId: "save" }]);
    await f.run();
    expect(f.results[0]).toMatchObject({ error: expect.any(String) });
    expect(f.effects).toEqual([]);
    expect(f.prisma.agentSkill.create).not.toHaveBeenCalled();
  });
  it("validates complete skill writes before recording any approval", async () => {
    const f = fixture({ name: "skill_create" });
    f.setCalls([{ args: { name: "Partial" }, executionId: "save" }]);
    await f.run();
    expect(f.effects).toEqual([]);
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
  });
  it("binds full canonical content, requires explicit consent, restores approved args and deduplicates retries", async () => {
    const f = fixture({
      name: "skill_create",
      autoReview: true,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "skill_create" }],
    });
    f.setCalls([{ args, executionId: "save" }]);
    await f.run();
    expect(f.prisma.agentSkill.create).not.toHaveBeenCalled();
    expect(f.effects[0]).toMatchObject({ status: "intended", request: args });
    expect(f.pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            detail: JSON.stringify(args, null, 2),
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ],
      }),
    );
    expect(runAutoReviewJudge).not.toHaveBeenCalled();
    f.effects[0]!.status = "approved";
    f.setCalls([
      {
        args: { ...args, content: content.replace("SENTINEL", "MODIFIED") },
        executionId: "resume",
      },
      { args, executionId: "retry" },
    ]);
    await f.run();
    expect(f.prisma.agentSkill.create).toHaveBeenCalledOnce();
    expect(f.prisma.agentSkill.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ content }) }),
    );
    expect(f.prisma.agentSkillRevision.create).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.status).toBe("completed");
    expect(f.results.slice(1)).toEqual([
      { ok: true, skillId: "skill-1", revision: 1 },
      { ok: true, skillId: "skill-1", revision: 1 },
    ]);
  });
});

describe("private learning review execution", () => {
  it.each(["customer_learning_tasks", "customer_learning_decide"])(
    "denies %s directly in shared and external runs",
    async (name) => {
      for (const options of [
        { groupId: "shared" },
        { channel: true, trigger: "messaging" },
        { trigger: "webhook" },
      ]) {
        const f = fixture({ ...options, name });
        await f.run();
        expect(f.results[0]).toMatchObject({ error: expect.any(String) });
        expect(f.effects).toEqual([]);
      }
    },
  );
  it("denies unattended decisions and blind approval before recording an effect", async () => {
    for (const trigger of ["routine", "user"]) {
      const f = fixture({ name: "customer_learning_decide", trigger });
      f.setCalls([
        {
          args: { taskId: "task", decision: "approve", reason: "Blind approval" },
          executionId: "decide",
        },
      ]);
      await f.run();
      expect(f.results[0]).toMatchObject({ error: expect.any(String) });
      expect(f.effects).toEqual([]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    }
  });
});
