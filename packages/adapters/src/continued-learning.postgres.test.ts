import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { LearningTaskProposalSchema } from "@rakazo/contracts";
import { buildSkillMd, expandSkillReferencesInPrompt } from "@rakazo/core";
import {
  checkLearningRejection,
  createAgentSkillStore,
  createCustomerInbox,
  createDb,
  createLearning,
  createMemoryAudit,
  createPrivateHistory,
  provisionMessagingIdentity,
  publishLearningSummaries,
  writeAccountExport,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { processContinuedLearning } from "./continued-learning.js";
import { learningCompatibilityInstructions, learningTargetInstructions } from "./learning-model.js";
import { loadAgentMemoryContext } from "./memory-context.js";
import { listAgentSkillRecords } from "./skill-tools.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("continued learning with PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let conversationId: string;
  let channelId: string;
  let response: object;
  let beforeResult: () => Promise<void>;
  let beforeCompatibility: () => Promise<void>;
  let compatible: boolean;
  let targetPicker: (request: AgentRunRequest) => string | null;
  const calls = vi.fn<(request: AgentRunRequest) => void>();
  const runtime = {
    async *run(request: AgentRunRequest) {
      calls(request);
      if (request.instructions === learningTargetInstructions) {
        yield { type: "done" as const, text: JSON.stringify({ targetId: targetPicker(request) }) };
        return;
      }
      if (request.instructions === learningCompatibilityInstructions) {
        await beforeCompatibility();
        yield { type: "done" as const, text: JSON.stringify({ compatible }) };
        return;
      }
      await beforeResult();
      yield { type: "done" as const, text: JSON.stringify(response) };
    },
  } satisfies Pick<AgentRuntime, "run">;
  const process = (id: string) =>
    processContinuedLearning(
      {
        prisma: db.prisma,
        runtime,
        resolveModel: async () => ({ provider: "test", id: "test" }),
      },
      id,
    );
  beforeAll(() => {
    db = createDb(globalThis.process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    calls.mockClear();
    beforeResult = async () => {};
    beforeCompatibility = async () => {};
    compatible = true;
    targetPicker = () => null;
    response = {
      reusable: true,
      supported: true,
      publicSafe: true,
      changesBusinessRules: false,
      kind: "voice",
      scope: "space",
      title: "Brand voice",
      content: "Ask one short question at a time.",
      conditions: "Customer sizing questions",
      reason: "Staff correction",
    };
    owner = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    const channel = await db.prisma.customerChannel.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        provider: "web",
        accountId: randomUUID(),
        name: "Synthetic shop",
        ciphertext: "",
      },
    });
    channelId = channel.id;
    conversationId = await createCustomerInbox(db.prisma).receive(channel.id, {
      externalId: "one",
      providerMessageId: "source-message",
      externalThreadId: "thread",
      customerId: "synthetic",
      name: "Test shopper",
      body: "Which size?",
    });
  });
  afterEach(async () => {
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });
  async function correction(nonce = "first") {
    await createCustomerInbox(db.prisma).steer(owner, {
      id: conversationId,
      nonce,
      guidance: "Ask one short question at a time for sizing.",
    });
    return db.prisma.learningTask.findFirstOrThrow({
      where: { conversationId },
    });
  }
  const reviewed = async (id: string) =>
    LearningTaskProposalSchema.parse(
      (await db.prisma.learningTask.findUniqueOrThrow({ where: { id } })).proposal,
    );
  const context = () => ({
    userId: owner.userId,
    spaceId: owner.spaceId,
    operationId: "native-learning-test",
    traceId: "native-learning-test",
    signal: new AbortController().signal,
  });
  const approve = async (
    taskId: string,
    reason = "Reviewed private destination and complete content",
  ) =>
    createLearning(db.prisma).decideTask(owner, {
      botId: owner.botId,
      taskId,
      decision: "approve",
      reason,
      reviewedProposal: await reviewed(taskId),
    });
  it("does not save an inference after its message source is withdrawn during generation", async () => {
    const task = await correction();
    beforeResult = async () => {
      await createCustomerInbox(db.prisma).withdraw(channelId, {
        externalThreadId: "thread",
        providerMessageId: "source-message",
      });
    };
    await process(task.id);
    expect(await db.prisma.learningTask.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
    expect(await db.prisma.customerMessage.findFirst({ where: { conversationId } })).toMatchObject({
      body: "",
      status: "withdrawn",
    });
  });
  it.each(["knowledge", "memory", "skill"] as const)(
    "automatically applies an authorized reusable %s correction with agent provenance",
    async (kind) => {
      response = { ...response, kind, scope: kind === "skill" ? "space" : "bot" };
      const task = await correction();
      await Promise.all([process(task.id), process(task.id)]);
      const saved = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(saved).toMatchObject({
        status: "applied",
        targetKind: kind === "knowledge" ? "document" : kind,
        appliedRevision: 1,
        reviewedByUserId: null,
      });
      expect(
        await db.prisma.learningTaskReview.count({
          where: { taskId: task.id, decision: "approve" },
        }),
      ).toBe(0);
      if (kind === "memory") {
        expect(
          await db.prisma.memoryRevision.findFirst({ where: { learningTaskId: task.id } }),
        ).toMatchObject({ actorKind: "agent", agentId: owner.botId });
        expect(
          await loadAgentMemoryContext(new MarkdownMemoryStore(db.prisma), owner.botId, context()),
        ).toContain("Customer sizing questions");
        await createMemoryAudit(db.prisma).undo(context(), {
          documentId: saved.documentId!,
          revision: 1,
          expectedRevision: 1,
          reason: "Not reusable",
        });
      } else if (kind === "skill") {
        expect(
          await db.prisma.agentSkillRevision.findFirst({ where: { learningTaskId: task.id } }),
        ).toMatchObject({ actorKind: "agent", agentId: owner.botId });
        const skill = await createAgentSkillStore(db.prisma, []).get(context(), saved.documentId!);
        expect(skill!.content).toContain("Customer sizing questions");
        await createAgentSkillStore(db.prisma, []).undo(context(), {
          skillId: saved.documentId!,
          revision: 1,
          expectedRevision: 1,
          reason: "Not reusable",
        });
      } else {
        expect(
          await db.prisma.learningRevision.findFirst({ where: { documentId: saved.documentId! } }),
        ).toMatchObject({ agentId: owner.botId });
        await createLearning(db.prisma).undo(owner, {
          botId: owner.botId,
          documentId: saved.documentId!,
          revision: 1,
          expectedRevision: 1,
          reason: "Not reusable",
        });
      }
      expect(
        (await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } })).status,
      ).toBe("rejected");
    },
  );
  it.each([
    "other-author",
    "resolved-case",
    "private",
    "commercial",
    "unsupported",
    "conflict",
    "bot-scope",
  ])("holds a %s native correction for review", async (reason) => {
    response = {
      ...response,
      kind: "skill",
      scope: reason === "bot-scope" ? "bot" : "space",
      publicSafe: reason !== "private",
      changesBusinessRules: reason === "commercial",
      supported: reason !== "unsupported",
    };
    compatible = reason !== "conflict";
    const task = await correction();
    if (reason === "other-author" || reason === "resolved-case")
      await db.prisma.learningTask.update({
        where: { id: task.id },
        data: {
          evidence: {
            ...(task.evidence as object),
            ...(reason === "other-author"
              ? { correctedByUserId: "another-staff-member" }
              : { guidance: null, resolved: true }),
          },
        },
      });
    await process(task.id);
    expect(
      (await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("review");
    expect(await db.prisma.agentSkill.count({ where: { userId: owner.userId } })).toBe(0);
  });
  it.each(["pause", "source", "membership", "deletion", "lease", "expiry"])(
    "fences an automatic native write after %s changes during private review",
    async (change) => {
      response = { ...response, kind: "memory", scope: "bot" };
      const task = await correction();
      beforeCompatibility = async () => {
        if (change === "pause")
          await createLearning(db.prisma).configure(owner, { botId: owner.botId, enabled: false });
        if (change === "source")
          await db.prisma.customerChannel.update({
            where: { id: channelId },
            data: { enabled: false },
          });
        if (change === "membership")
          await db.prisma.spaceMember.deleteMany({
            where: { spaceId: owner.spaceId, userId: owner.userId },
          });
        if (change === "deletion")
          await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
        if (change === "expiry")
          await db.prisma.learningTask.update({
            where: { id: task.id },
            data: { leaseUntil: new Date(0) },
          });
        if (change === "lease")
          await db.prisma.learningTask.update({
            where: { id: task.id },
            data: { leaseToken: "new-worker", leaseUntil: new Date(Date.now() + 120000) },
          });
      };
      try {
        await process(task.id);
        expect(await db.prisma.memoryRevision.count({ where: { learningTaskId: task.id } })).toBe(
          0,
        );
        expect(
          (await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } })).status,
        ).not.toBe("applied");
      } finally {
        await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
      }
    },
  );
  it.each([0, 54])(
    "retains the relevant skill at index %i across paged target selection without leaking its body into shared inference",
    async (targetIndex) => {
      const content = buildSkillMd({
        name: "Garment fit",
        description: "Choosing a garment size",
        body: "Private baseline: prefer garment measurements.",
      });
      await db.prisma.agentSkill.createMany({
        data: Array.from({ length: 55 }, (_, index) => ({
          id: `sizing-${index.toString().padStart(3, "0")}-${owner.botId}`,
          userId: owner.userId,
          spaceId: owner.spaceId,
          name: index === targetIndex ? "Garment fit" : `Other recipe ${index}`,
          description: index === targetIndex ? "Choosing a garment size" : "Unrelated",
          source: "user",
          content:
            index === targetIndex
              ? content
              : buildSkillMd({
                  name: `Other recipe ${index}`,
                  description: "Unrelated",
                  body: "Other task",
                }),
        })),
      });
      const id = `sizing-${targetIndex.toString().padStart(3, "0")}-${owner.botId}`;
      targetPicker = (request) => {
        const { candidates, previousSelection } = JSON.parse(request.prompt) as {
          candidates: Array<{ id: string; name: string }>;
          previousSelection?: string;
        };
        // Later pages may report no new match; this must preserve the earlier selection.
        return previousSelection
          ? null
          : (candidates.find((item) => item.name === "Garment fit")?.id ?? null);
      };
      response = { ...response, kind: "skill", scope: "space" };
      const task = await correction();
      await process(task.id);
      const saved = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(saved).toMatchObject({ status: "applied", documentId: id, appliedRevision: 2 });
      expect(
        calls.mock.calls.filter(([request]) => request.instructions === learningTargetInstructions),
      ).toHaveLength(2);
      expect(calls.mock.calls[0]![0].prompt).not.toContain("Private baseline");
      expect((await createAgentSkillStore(db.prisma, []).get(context(), id))!.content).toContain(
        "Private baseline",
      );
      expect(
        await db.prisma.agentSkill.count({
          where: { userId: owner.userId, name: "Customer handling" },
        }),
      ).toBe(0);
    },
  );
  it("selects an existing bot memory and preserves a staff edit made during compatibility review", async () => {
    const store = new MarkdownMemoryStore(db.prisma);
    await store.commit(
      { scope: "bot", botId: owner.botId, path: "sizing.md", content: "Original sizing notes." },
      context(),
    );
    const document = await db.prisma.memoryDocument.findFirstOrThrow({
      where: { botId: owner.botId, path: "sizing.md" },
    });
    targetPicker = () => document.id;
    response = { ...response, kind: "memory", scope: "bot" };
    const task = await correction();
    beforeCompatibility = async () => {
      await store.commit(
        {
          scope: "bot",
          botId: owner.botId,
          path: "sizing.md",
          content: "New staff measurements.",
          expectedRevision: document.revision,
        },
        context(),
      );
    };
    await process(task.id);
    expect((await reviewed(task.id)).native).toMatchObject({
      id: document.id,
      path: "sizing.md",
      beforeContent: "Original sizing notes.",
    });
    expect(
      (await db.prisma.memoryDocument.findUniqueOrThrow({ where: { id: document.id } })).content,
    ).toBe("New staff measurements.");
    expect(await db.prisma.memoryRevision.count({ where: { learningTaskId: task.id } })).toBe(0);
    expect(
      (await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("failed");
  });
  it("rejects a target outside the listed private scope", async () => {
    await new MarkdownMemoryStore(db.prisma).commit(
      { scope: "bot", botId: owner.botId, path: "sizing.md", content: "Staff notes" },
      context(),
    );
    targetPicker = () => "unlisted-target";
    response = { ...response, kind: "memory", scope: "bot" };
    const task = await correction();
    await process(task.id);
    expect(
      (await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("failed");
    expect(await db.prisma.memoryRevision.count({ where: { learningTaskId: task.id } })).toBe(0);
  });
  it("pages review metadata without bodies and scopes daily-summary ids and cursors", async () => {
    response = { ...response, publicSafe: false, kind: "memory", scope: "bot" };
    const original = await correction();
    await process(original.id);
    const proposal = await reviewed(original.id);
    const ids = [original.id];
    for (let index = 0; index < 12; index++) {
      const copy = await db.prisma.learningTask.create({
        data: {
          userId: owner.userId,
          spaceId: owner.spaceId,
          botId: owner.botId,
          conversationId,
          sourceKey: `page-${index}`,
          evidence: {},
          status: "review",
          proposal,
          createdAt: new Date(1700000000000 + index),
        },
      });
      ids.push(copy.id);
    }
    const learning = createLearning(db.prisma);
    const first = await learning.taskList(owner, { botId: owner.botId });
    await db.prisma.learningTaskReview.createMany({
      data: Array.from({ length: 25 }, (_, index) => ({
        taskId: original.id,
        userId: owner.userId,
        decision: "retry",
        reason: `Decision ${index}`,
        createdAt: new Date(1700000000000 + index),
      })),
    });
    const selected = await learning.task(owner, { botId: owner.botId, taskId: original.id });
    expect(selected.task.reviews).toHaveLength(20);
    expect(selected.task.reviews[0]!.reason).toBe("Decision 5");
    expect(selected.task.reviews.at(-1)!.reason).toBe("Decision 24");
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBe(first.items[9]!.id);
    expect(first.items[0]).not.toHaveProperty("proposal");
    expect(JSON.stringify(first)).not.toContain("Ask one short question");
    const second = await learning.taskList(owner, {
      botId: owner.botId,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(13);
    const subset = await learning.taskList(owner, { botId: owner.botId, ids: [ids[1]!, ids[2]!] });
    expect(subset.items.map((item) => item.id).sort()).toEqual([ids[1]!, ids[2]!].sort());
    expect((await learning.taskList(owner, { botId: owner.botId, ids: [] })).items).toEqual([]);
    await expect(
      learning.taskList(owner, { botId: owner.botId, ids: [original.id], cursor: ids[1] }),
    ).rejects.toThrow();
    await expect(
      learning.taskList({ ...owner, userId: "another-owner" }, { botId: owner.botId }),
    ).rejects.toThrow();
    await expect(
      learning.task(
        { ...owner, userId: "another-owner" },
        { botId: owner.botId, taskId: original.id },
      ),
    ).rejects.toThrow();
  });
  it.each(["memory", "skill"] as const)(
    "shows the complete %s proposal and rejects old consent after regeneration",
    async (kind) => {
      response = {
        ...response,
        kind,
        publicSafe: false,
        scope: "bot",
        content: "Sizing detail. ".repeat(400) + "Last condition.",
      };
      const task = await correction();
      await process(task.id);
      const learning = createLearning(db.prisma);
      const original = await learning.task(owner, { botId: owner.botId, taskId: task.id });
      expect(original).toMatchObject({
        scope: kind === "memory" ? "private-bot" : "private-user",
        stale: false,
        canEdit: true,
        before: { content: "" },
      });
      expect(original.after!.content.length).toBeGreaterThan(4000);
      expect(original.after!.content).toContain("Last condition.");
      await learning.decideTask(owner, {
        botId: owner.botId,
        taskId: task.id,
        decision: "retry",
        reason: "Refresh the destination",
      });
      response = { ...response, content: "Use the refreshed sizing guidance." };
      await process(task.id);
      await expect(
        learning.decideTask(owner, {
          botId: owner.botId,
          taskId: task.id,
          decision: "approve",
          reason: "Old consent",
          reviewedProposal: original.task.proposal!,
        }),
      ).rejects.toThrow("proposal changed");
      for (const decision of ["reject", "retry"] as const)
        await expect(
          learning.decideTask(owner, {
            botId: owner.botId,
            taskId: task.id,
            decision,
            reason: "Old decision",
            reviewedProposal: original.task.proposal!,
          }),
        ).rejects.toThrow("proposal changed");
      const refreshed = await learning.task(owner, { botId: owner.botId, taskId: task.id });
      expect(refreshed.after!.content).toContain("refreshed sizing guidance");
      await approve(task.id);
      expect(
        (await learning.task(owner, { botId: owner.botId, taskId: task.id })).task.status,
      ).toBe("applied");
      expect(refreshed.task.reviews).toContainEqual(
        expect.objectContaining({ decision: "retry", reason: "Refresh the destination" }),
      );
    },
  );
  it("shows the historical document baseline after later edits make a proposal stale", async () => {
    const learning = createLearning(db.prisma);
    const baseline = {
      botId: owner.botId,
      scope: "space" as const,
      kind: "knowledge" as const,
      key: "sizing-policy",
      title: "Sizing policy",
      content: "Original sizing policy.",
      customerVisible: false,
      expectedRevision: 0,
      reason: "Initial policy",
      source: "Staff instruction",
    };
    const saved = await learning.save(owner, baseline);
    response = {
      ...response,
      kind: "knowledge",
      changesBusinessRules: true,
      title: "Sizing policy",
      content: "New sizing policy.",
    };
    const task = await correction();
    await process(task.id);
    const proposal = await reviewed(task.id);
    // Use the exact reviewed target, independently of the inference key generator.
    await db.prisma.learningTask.update({
      where: { id: task.id },
      data: {
        proposal: {
          ...proposal,
          save: { ...proposal.save, key: baseline.key, expectedRevision: 1 },
        },
      },
    });
    await learning.save(owner, {
      ...baseline,
      expectedRevision: saved.revision,
      content: "Later staff policy.",
      reason: "Later edit",
    });
    const detail = await learning.task(owner, { botId: owner.botId, taskId: task.id });
    expect(detail).toMatchObject({
      stale: true,
      currentRevision: 2,
      before: { content: baseline.content },
      after: { content: expect.stringContaining("New sizing policy.") },
    });
  });
  it.each(["membership", "deletion"])(
    "denies review reads and summary delivery after %s revocation",
    async (revocation) => {
      response = { ...response, publicSafe: false, kind: "memory" };
      const task = await correction();
      await process(task.id);
      if (revocation === "membership")
        await db.prisma.spaceMember.deleteMany({
          where: { spaceId: owner.spaceId, userId: owner.userId },
        });
      else await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
      try {
        const learning = createLearning(db.prisma);
        await expect(learning.taskList(owner, { botId: owner.botId })).rejects.toThrow();
        await expect(
          learning.task(owner, { botId: owner.botId, taskId: task.id }),
        ).rejects.toThrow();
        await publishLearningSummaries(db.prisma);
        expect(await db.prisma.message.count({ where: { botId: owner.botId, role: "bot" } })).toBe(
          0,
        );
      } finally {
        await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
      }
    },
  );
  it("captures corrections durably, applies supported style once and records source and conditions", async () => {
    await createLearning(db.prisma).save(owner, {
      botId: owner.botId,
      scope: "space",
      kind: "voice",
      key: "brand-voice",
      title: "Voice",
      content: "Never pressure the customer.",
      customerVisible: true,
      expectedRevision: 0,
      reason: "Approved baseline",
      source: "Staff instruction",
    });
    const task = await correction();
    await correction("duplicate-evidence");
    expect(await db.prisma.learningTask.count({ where: { conversationId } })).toBe(1);
    await process(task.id);
    await process(task.id);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]![0]).toMatchObject({
      tools: [],
      allowBuiltinTools: false,
    });
    const state = await createLearning(db.prisma).state(owner, owner.botId);
    expect(state.documents[0]!.content).toContain("Applies when: Customer sizing questions");
    expect(state.documents[0]!.content).toContain("Never pressure the customer.");
    expect(state.history).toHaveLength(2);
    expect(state.history[0]).toMatchObject({
      hasEvidence: true,
      actor: expect.stringMatching(/^Agent/),
    });
    expect(
      await db.prisma.learningTask.findUniqueOrThrow({
        where: { id: task.id },
      }),
    ).toMatchObject({
      status: "applied",
      appliedRevision: 2,
      leaseToken: null,
    });
  });
  it("holds operational proposals for staff review and remembers rejection until explicit retry", async () => {
    response = {
      ...response,
      kind: "knowledge",
      changesBusinessRules: true,
      supported: false,
    };
    const task = await correction();
    await process(task.id);
    const learning = createLearning(db.prisma);
    expect((await learning.state(owner, owner.botId)).documents).toEqual([]);
    expect((await learning.tasks(owner, owner.botId))[0]!.status).toBe("review");
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: task.id,
      decision: "reject",
      reason: "This is a one-off exception",
    });
    await correction("repeat-after-rejection");
    await process(task.id);
    expect(calls).toHaveBeenCalledTimes(1);
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: task.id,
      decision: "retry",
      reason: "Reconsider this evidence",
    });
    await process(task.id);
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: task.id,
      decision: "approve",
      reviewedProposal: await reviewed(task.id),
      reason: "Reviewed the proposed conditions",
    });
    expect((await learning.state(owner, owner.botId)).history).toHaveLength(1);
    expect(
      (
        await db.prisma.learningTaskReview.findMany({
          where: { taskId: task.id },
          orderBy: { createdAt: "asc" },
        })
      ).map((r) => r.decision),
    ).toEqual(["reject", "retry", "approve"]);
  });
  it("fences late model results after a worker loses its lease", async () => {
    const task = await correction();
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeResult = async () => {
      ready();
      await pending;
    };
    const running = process(task.id);
    await entered;
    await process(task.id);
    expect(calls).toHaveBeenCalledTimes(1);
    await db.prisma.learningTask.update({
      where: { id: task.id },
      data: { leaseToken: "replacement-worker" },
    });
    release();
    await running;
    expect((await createLearning(db.prisma).state(owner, owner.botId)).documents).toEqual([]);
    expect(
      (
        await db.prisma.learningTask.findUniqueOrThrow({
          where: { id: task.id },
        })
      ).leaseToken,
    ).toBe("replacement-worker");
  });
  it("keeps last valid learning when the model fails and never learns after source disconnect", async () => {
    const learning = createLearning(db.prisma);
    await learning.save(owner, {
      botId: owner.botId,
      scope: "space",
      kind: "voice",
      key: "brand-voice",
      title: "Voice",
      content: "Approved voice",
      customerVisible: true,
      expectedRevision: 0,
      source: "Staff instruction",
      reason: "Baseline",
    });
    const task = await correction();
    response = { malformed: true };
    await process(task.id);
    expect((await learning.state(owner, owner.botId)).documents[0]!.content).toBe("Approved voice");
    expect((await learning.tasks(owner, owner.botId))[0]!.status).toBe("failed");
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: task.id,
      decision: "retry",
      reason: "Retry after reconnect",
    });
    await db.prisma.customerChannel.update({
      where: { id: channelId },
      data: { enabled: false },
    });
    await process(task.id);
    expect(calls).toHaveBeenCalledTimes(1);
  });
  it("queues resolved cases only when there are sent human replies, not agent output alone", async () => {
    const inbox = createCustomerInbox(db.prisma);
    await inbox.updateCase(owner, { id: conversationId, state: "resolved" });
    expect(await db.prisma.learningTask.count({ where: { conversationId } })).toBe(0);
    await inbox.updateCase(owner, { id: conversationId, state: "open" });
    await db.prisma.customerMessage.create({
      data: {
        conversationId,
        externalId: "human",
        seq: 2,
        role: "staff",
        body: "Here is the verified answer",
        status: "sent",
      },
    });
    await inbox.updateCase(owner, { id: conversationId, state: "resolved" });
    expect(await db.prisma.learningTask.count({ where: { conversationId } })).toBe(1);
  });
  it("pauses queued work and produces one durable daily summary without urgent notifications", async () => {
    const task = await correction();
    const learning = createLearning(db.prisma);
    await learning.configure(owner, { botId: owner.botId, enabled: false });
    await process(task.id);
    expect(calls).not.toHaveBeenCalled();
    await learning.configure(owner, { botId: owner.botId, enabled: true });
    await process(task.id);
    const now = new Date();
    await Promise.all([
      publishLearningSummaries(db.prisma, now),
      publishLearningSummaries(db.prisma, now),
    ]);
    const messages = () =>
      db.prisma.message.findMany({
        where: { botId: owner.botId, role: "bot" },
      });
    expect(await messages()).toHaveLength(1);
    expect(JSON.stringify((await messages())[0]!.blocks)).toContain("1 applied");
    expect((await messages())[0]!.blocks).toContainEqual({
      kind: "learning_updates",
      botId: owner.botId,
      taskIds: [task.id],
    });
    expect(
      await db.prisma.event.count({
        where: { botId: owner.botId, type: "thread.message.created" },
      }),
    ).toBe(1);
    await db.prisma.learningTask.update({
      where: { id: task.id },
      data: { status: "failed", summarizedAt: null },
    });
    await publishLearningSummaries(db.prisma, now);
    expect(await messages()).toHaveLength(1);
    await publishLearningSummaries(db.prisma, new Date(now.getTime() + 86400001));
    expect(await messages()).toHaveLength(2);
  });
  it("does not overwrite a staff edit made while inference was running", async () => {
    const task = await correction();
    const learning = createLearning(db.prisma);
    beforeResult = async () => {
      await learning.save(owner, {
        botId: owner.botId,
        scope: "space",
        kind: "voice",
        key: "brand-voice",
        title: "Staff voice",
        content: "Keep this newer instruction",
        customerVisible: true,
        expectedRevision: 0,
        reason: "Live staff correction",
        source: "Staff instruction",
      });
    };
    await process(task.id);
    const state = await learning.state(owner, owner.botId);
    expect(state.documents[0]!.content).toBe("Keep this newer instruction");
    expect(state.history).toHaveLength(1);
    expect((await learning.tasks(owner, owner.botId))[0]!.status).toBe("failed");
  });
  it("preserves private Space guidance when creating a bot override", async () => {
    const learning = createLearning(db.prisma);
    await learning.save(owner, {
      botId: owner.botId,
      scope: "space",
      kind: "voice",
      key: "brand-voice",
      title: "Private voice draft",
      content: "Private staff wording draft",
      customerVisible: false,
      expectedRevision: 0,
      reason: "Draft only",
      source: "Staff instruction",
    });
    response = { ...response, scope: "bot" };
    const task = await correction();
    await process(task.id);
    const state = await learning.state(owner, owner.botId);
    expect(state.documents.find((doc) => doc.scope === "bot")).toMatchObject({
      customerVisible: false,
      content: expect.stringContaining("Private staff wording draft"),
    });
    expect(await learning.customerContext(owner.spaceId, owner.botId)).toBe("");
  });
  it("fences inherited Space changes and a pause made during inference", async () => {
    const learning = createLearning(db.prisma);
    const original = {
      botId: owner.botId,
      scope: "space" as const,
      kind: "voice" as const,
      key: "brand-voice",
      title: "Voice",
      content: "Original shared voice",
      customerVisible: true,
      expectedRevision: 0,
      reason: "Baseline",
      source: "Staff instruction",
    };
    await learning.save(owner, original);
    response = { ...response, scope: "bot" };
    const task = await correction();
    beforeResult = async () => {
      await learning.save(owner, {
        ...original,
        content: "New shared voice",
        expectedRevision: 1,
      });
    };
    await process(task.id);
    expect((await learning.state(owner, owner.botId)).documents).toHaveLength(1);
    expect((await learning.tasks(owner, owner.botId))[0]!.status).toBe("failed");
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: task.id,
      decision: "retry",
      reason: "Use the updated baseline",
    });
    beforeResult = async () => {
      await learning.configure(owner, { botId: owner.botId, enabled: false });
    };
    await process(task.id);
    expect((await learning.state(owner, owner.botId)).documents).toHaveLength(1);
  });
  it("rejects a new bot override if a Space baseline appeared during inference", async () => {
    const learning = createLearning(db.prisma);
    response = { ...response, scope: "bot" };
    const task = await correction();
    beforeResult = async () => {
      await learning.save(owner, {
        botId: owner.botId,
        scope: "space",
        kind: "voice",
        key: "brand-voice",
        title: "New baseline",
        content: "Keep this shared rule",
        customerVisible: true,
        expectedRevision: 0,
        reason: "Staff update",
        source: "Staff instruction",
      });
    };
    await process(task.id);
    expect((await learning.state(owner, owner.botId)).documents).toHaveLength(1);
    expect((await learning.tasks(owner, owner.botId))[0]!.status).toBe("failed");
  });
  it("records the correcting human and removes captured evidence when a case is deleted", async () => {
    const task = await correction();
    expect(task.evidence).toMatchObject({ correctedByUserId: owner.userId });
    response = { ...response, supported: false };
    await process(task.id);
    await createLearning(db.prisma).decideTask(owner, {
      botId: owner.botId,
      taskId: task.id,
      decision: "reject",
      reason: "Not reusable",
    });
    expect(await db.prisma.learningTaskReview.count({ where: { taskId: task.id } })).toBe(1);
    await db.prisma.customerConversation.delete({
      where: { id: conversationId },
    });
    expect(await db.prisma.learningTask.count({ where: { id: task.id } })).toBe(0);
    expect(await db.prisma.learningTaskReview.count({ where: { taskId: task.id } })).toBe(0);
    await process(task.id);
    expect(calls).toHaveBeenCalledTimes(1);
  });
  it("does not relearn rejected guidance after new messages change the evidence snapshot", async () => {
    const learning = createLearning(db.prisma);
    response = { ...response, supported: false };
    const first = await correction();
    await process(first.id);
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: first.id,
      decision: "reject",
      reason: "One-off instruction",
    });
    await createCustomerInbox(db.prisma).receive(channelId, {
      externalId: "two",
      externalThreadId: "thread",
      customerId: "synthetic",
      name: "Test shopper",
      body: "Thanks",
    });
    await correction("new-evidence");
    const second = await db.prisma.learningTask.findFirstOrThrow({
      where: { conversationId, id: { not: first.id } },
    });
    response = {
      ...response,
      supported: true,
      content: "A differently worded version of the correction.",
    };
    await process(second.id);
    expect((await learning.state(owner, owner.botId)).documents).toHaveLength(0);
    expect(
      await db.prisma.learningTask.findUniqueOrThrow({
        where: { id: second.id },
      }),
    ).toMatchObject({ status: "review" });
    expect(calls.mock.calls[1]![0].prompt).toContain("One-off instruction");
  });
  it("undoing learned guidance prevents the same inference from being applied again", async () => {
    const learning = createLearning(db.prisma);
    const first = await correction();
    await process(first.id);
    const doc = (await learning.state(owner, owner.botId)).documents[0]!;
    await learning.undo(owner, {
      botId: owner.botId,
      documentId: doc.id,
      revision: 1,
      expectedRevision: 1,
      reason: "Do not use this rule again",
    });
    await createCustomerInbox(db.prisma).steer(owner, {
      id: conversationId,
      nonce: "different-correction",
      guidance: "Use a short sizing question.",
    });
    const second = await db.prisma.learningTask.findFirstOrThrow({
      where: { conversationId, id: { not: first.id } },
    });
    await process(second.id);
    expect((await learning.state(owner, owner.botId)).documents[0]).toMatchObject({
      revision: 2,
      content: "",
    });
    expect(
      await db.prisma.learningTask.findUniqueOrThrow({
        where: { id: second.id },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await db.prisma.learningTaskReview.findFirstOrThrow({
        where: { taskId: first.id },
      }),
    ).toMatchObject({ decision: "undo", userId: owner.userId });
  });
  it("allows an explicit retry of a task blocked by another rejected inference", async () => {
    const learning = createLearning(db.prisma);
    response = { ...response, supported: false };
    const first = await correction();
    await process(first.id);
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: first.id,
      decision: "reject",
      reason: "Not now",
    });
    await createCustomerInbox(db.prisma).receive(channelId, {
      externalId: "two",
      externalThreadId: "thread",
      customerId: "synthetic",
      name: "Test shopper",
      body: "Thanks",
    });
    await correction("new-snapshot");
    const second = await db.prisma.learningTask.findFirstOrThrow({
      where: { conversationId, id: { not: first.id } },
    });
    response = { ...response, supported: true };
    await process(second.id);
    expect(
      (await learning.tasks(owner, owner.botId)).find((task) => task.id === second.id)?.status,
    ).toBe("rejected");
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: second.id,
      decision: "retry",
      reason: "Reconsider this rule now",
    });
    await process(second.id);
    expect(
      (await learning.tasks(owner, owner.botId)).find((task) => task.id === second.id)?.status,
    ).toBe("applied");
    expect(calls.mock.calls.at(-1)![0].prompt).toContain('"reconsiderRejected":true');
  });
  it("shares rejected Space inferences across bots but keeps bot overrides isolated", async () => {
    const learning = createLearning(db.prisma);
    response = { ...response, supported: false };
    const task = await correction();
    await process(task.id);
    await learning.decideTask(owner, {
      botId: owner.botId,
      taskId: task.id,
      decision: "reject",
      reason: "Not our shared voice",
    });
    const rejected = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
    const otherBot = { ...rejected, botId: "another-bot", correctionKey: null };
    await expect(checkLearningRejection(db.prisma, otherBot, "space")).rejects.toThrow(
      "Previously rejected",
    );
    await expect(checkLearningRejection(db.prisma, otherBot, "bot")).resolves.toBeUndefined();
  });
  it.each(["memory", "skill"] as const)(
    "applies reviewed %s learning to the actual private store and rejects its undone inference",
    async (kind) => {
      response = { ...response, publicSafe: false, kind, scope: "bot" };
      const task = await correction();
      await process(task.id);
      const proposal = await reviewed(task.id);
      expect(proposal.native).toMatchObject({
        kind,
        scope: kind === "skill" ? "user" : "bot",
        expectedRevision: 0,
        beforeContent: "",
      });
      expect(proposal.save.customerVisible).toBe(false);
      expect(
        await db.prisma.memoryDocument.count({
          where: { path: "customer-learning.md", userId: owner.userId },
        }),
      ).toBe(0);
      expect(await db.prisma.agentSkill.count({ where: { userId: owner.userId } })).toBe(0);
      const applied = await approve(task.id);
      expect(applied.status).toBe("applied");
      const savedTask = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(savedTask).toMatchObject({
        targetKind: kind,
        appliedRevision: 1,
        botId: owner.botId,
        reviewedByUserId: owner.userId,
      });
      expect(
        await db.prisma.learningTaskReview.findFirst({
          where: { taskId: task.id, decision: "approve" },
        }),
      ).toMatchObject({ userId: owner.userId });
      expect((await createLearning(db.prisma).state(owner, owner.botId)).documents).toEqual([]);
      expect(await createLearning(db.prisma).customerContext(owner.spaceId, owner.botId)).toBe("");
      const exported: Array<{ type: string; data: unknown }> = [];
      await writeAccountExport(
        db.prisma,
        owner.userId,
        async (record) => {
          exported.push(record);
        },
        async () => "",
        new AbortController().signal,
      );
      expect(exported.find((record) => record.type === "learningTask")?.data).toMatchObject({
        id: task.id,
        targetKind: kind,
        appliedRevision: 1,
      });
      expect(
        exported.find(
          (record) => record.type === (kind === "memory" ? "memoryRevision" : "skillRevision"),
        )?.data,
      ).toMatchObject({ learningTaskId: task.id, content: proposal.native!.content });
      const id = savedTask.documentId!;
      expect(
        (await createPrivateHistory(db.prisma, []).history(context(), { kind, id })).items[0],
      ).toMatchObject({
        learningSource: { botId: owner.botId, taskId: task.id },
      });
      if (kind === "memory") {
        const future = await loadAgentMemoryContext(
          new MarkdownMemoryStore(db.prisma),
          owner.botId,
          context(),
        );
        expect(future).toContain("Customer sizing questions");
        expect(future).toContain("Ask one short question");
        expect(
          await db.prisma.memoryRevision.findFirst({ where: { documentId: id } }),
        ).toMatchObject({ learningTaskId: task.id, actorKind: "staff", agentId: null });
        await createMemoryAudit(db.prisma).undo(context(), {
          documentId: id,
          revision: 1,
          expectedRevision: 1,
          reason: "Not reusable",
        });
        expect(
          await loadAgentMemoryContext(new MarkdownMemoryStore(db.prisma), owner.botId, context()),
        ).not.toContain("Ask one short question");
      } else {
        const catalog = await listAgentSkillRecords(db.prisma, context());
        const recipe = catalog.find((entry) => entry.id === id)!;
        expect(recipe.content).toContain("Customer sizing questions");
        expect(expandSkillReferencesInPrompt(`Use @${recipe.name}`, catalog)).toContain(
          "Ask one short question",
        );
        expect(
          await db.prisma.agentSkillRevision.findFirst({ where: { skillId: id } }),
        ).toMatchObject({ learningTaskId: task.id, actorKind: "staff", agentId: null });
        await createAgentSkillStore(db.prisma, []).undo(context(), {
          skillId: id,
          revision: 1,
          expectedRevision: 1,
          reason: "Not reusable",
        });
        expect(
          (await listAgentSkillRecords(db.prisma, context())).some((entry) => entry.id === id),
        ).toBe(false);
      }
      const rejected = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(rejected).toMatchObject({ status: "rejected", reviewReason: "Not reusable" });
      expect(
        (await createPrivateHistory(db.prisma, []).history(context(), { kind, id })).items[0],
      ).toMatchObject({ learningSource: null });
      await expect(
        checkLearningRejection(db.prisma, rejected, "bot", proposal.native!.scope),
      ).rejects.toThrow("Previously rejected");
      expect(
        (
          await createLearning(db.prisma).taskEvidence(owner, {
            botId: owner.botId,
            taskId: task.id,
          })
        ).content,
      ).toContain("Ask one short question at a time for sizing");
      await expect(
        checkLearningRejection(
          db.prisma,
          { ...rejected, userId: "another-owner" },
          "space",
          "user",
        ),
      ).resolves.toBeUndefined();
    },
  );
  it("preserves a private memory baseline without putting it into the inference prompt and rejects a concurrent edit", async () => {
    await new MarkdownMemoryStore(db.prisma).commit(
      {
        scope: "bot",
        botId: owner.botId,
        path: "customer-learning.md",
        content: "Private staff note",
        expectedRevision: 0,
      },
      context(),
    );
    response = { ...response, publicSafe: false, kind: "memory", scope: "bot" };
    const task = await correction();
    await process(task.id);
    const proposal = await reviewed(task.id);
    expect(proposal.native).toMatchObject({
      beforeContent: "Private staff note",
      content: expect.stringContaining("Private staff note"),
    });
    expect(calls.mock.calls[0]![0].prompt).not.toContain("Private staff note");
    await new MarkdownMemoryStore(db.prisma).commit(
      {
        scope: "bot",
        botId: owner.botId,
        path: "customer-learning.md",
        content: "New private note",
        expectedRevision: 1,
      },
      context(),
    );
    await expect(approve(task.id)).rejects.toThrow("changed");
    expect(
      (await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("review");
    expect(await db.prisma.memoryRevision.count({ where: { learningTaskId: task.id } })).toBe(0);
  });
  it("binds approval to the exact proposal and rolls native content back when recording the decision fails", async () => {
    response = { ...response, publicSafe: false, kind: "skill" };
    const task = await correction();
    await process(task.id);
    const proposal = await reviewed(task.id);
    await expect(
      createLearning(db.prisma).decideTask(owner, {
        botId: owner.botId,
        taskId: task.id,
        decision: "approve",
        reason: "Blind approval",
      }),
    ).rejects.toThrow("Review the complete");
    await db.prisma.learningTask.update({
      where: { id: task.id },
      data: { proposal: { ...proposal, conditions: "Changed conditions" } },
    });
    await expect(
      createLearning(db.prisma).decideTask(owner, {
        botId: owner.botId,
        taskId: task.id,
        decision: "approve",
        reason: "Old review",
        reviewedProposal: proposal,
      }),
    ).rejects.toThrow("proposal changed");
    const client = new Proxy(db.prisma, {
      get(target, key, receiver) {
        if (key !== "$transaction") return Reflect.get(target, key, receiver);
        return (work: (tx: unknown) => unknown, options: object) =>
          target.$transaction(
            async (tx) =>
              work(
                new Proxy(tx, {
                  get(inner, property, childReceiver) {
                    if (property !== "learningTaskReview")
                      return Reflect.get(inner, property, childReceiver);
                    return {
                      ...inner.learningTaskReview,
                      create: async () => {
                        throw new Error("Injected decision failure");
                      },
                    };
                  },
                }),
              ),
            options,
          );
      },
    });
    await expect(
      createLearning(client).decideTask(owner, {
        botId: owner.botId,
        taskId: task.id,
        decision: "approve",
        reason: "Review with rollback",
        reviewedProposal: await reviewed(task.id),
      }),
    ).rejects.toThrow("Injected decision failure");
    expect(await db.prisma.agentSkill.count({ where: { userId: owner.userId } })).toBe(0);
    expect(await db.prisma.agentSkillRevision.count({ where: { learningTaskId: task.id } })).toBe(
      0,
    );
    expect(
      (await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("review");
  });
  it.each(["disconnect", "membership", "deletion"])(
    "refuses native approval after %s revokes access",
    async (revocation) => {
      response = { ...response, publicSafe: false, kind: "memory", scope: "bot" };
      const task = await correction();
      await process(task.id);
      if (revocation === "disconnect")
        await db.prisma.customerChannel.update({
          where: { id: channelId },
          data: { enabled: false },
        });
      if (revocation === "membership")
        await db.prisma.spaceMember.deleteMany({
          where: { spaceId: owner.spaceId, userId: owner.userId },
        });
      if (revocation === "deletion")
        await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
      try {
        await expect(approve(task.id)).rejects.toThrow();
      } finally {
        await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
      }
      expect(await db.prisma.memoryRevision.count({ where: { learningTaskId: task.id } })).toBe(0);
    },
  );
  it.each(["memory", "skill"] as const)(
    "serializes duplicate %s approvals into one native revision",
    async (kind) => {
      response = { ...response, publicSafe: false, kind, scope: "bot" };
      const task = await correction();
      await process(task.id);
      const results = await Promise.allSettled([approve(task.id), approve(task.id)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(
        await db.prisma.learningTaskReview.count({
          where: { taskId: task.id, decision: "approve" },
        }),
      ).toBe(1);
      const revisions =
        kind === "memory"
          ? await db.prisma.memoryRevision.count({ where: { learningTaskId: task.id } })
          : await db.prisma.agentSkillRevision.count({ where: { learningTaskId: task.id } });
      expect(revisions).toBe(1);
    },
  );
  it.each([
    ["memory", "undo"],
    ["memory", "restore"],
    ["memory", "remove"],
    ["skill", "undo"],
    ["skill", "restore"],
    ["skill", "remove"],
  ] as const)(
    "rejects a learned %s inference after %s and preserves the immutable source version",
    async (kind, action) => {
      const memories = new MarkdownMemoryStore(db.prisma);
      const skills = createAgentSkillStore(db.prisma, []);
      const baseline =
        kind === "memory"
          ? "Existing staff instruction."
          : buildSkillMd({
              name: "Customer handling",
              description: "Staff procedure",
              body: "Existing staff instruction.",
            });
      const initial =
        kind === "memory"
          ? await memories.commit(
              {
                scope: "bot",
                botId: owner.botId,
                path: "customer-learning.md",
                content: baseline,
                expectedRevision: 0,
              },
              context(),
            )
          : await skills.create(context(), { content: baseline, reason: "Initial procedure" });
      response = { ...response, publicSafe: false, kind, scope: "bot" };
      const task = await correction();
      await process(task.id);
      const proposal = await reviewed(task.id);
      expect(proposal.native).toMatchObject({
        id: initial.id,
        beforeContent: baseline,
        expectedRevision: 1,
      });
      await approve(task.id);
      const withLater = proposal.native!.content.replace(
        "Existing staff instruction.",
        "Manual follow-up.\nExisting staff instruction.",
      );
      if (kind === "memory")
        await memories.commit(
          {
            scope: "bot",
            botId: owner.botId,
            path: "customer-learning.md",
            content: withLater,
            expectedRevision: 2,
          },
          context(),
        );
      else
        await skills.update(context(), {
          skillId: initial.id,
          content: withLater,
          expectedRevision: 2,
          reason: "Independent later edit",
        });
      const history = createPrivateHistory(db.prisma, []);
      if (action === "remove") {
        if (kind === "memory")
          await memories.commit(
            {
              scope: "bot",
              botId: owner.botId,
              path: "customer-learning.md",
              content: "",
              expectedRevision: 3,
              reason: "Discard learning",
            },
            context(),
          );
        else
          await skills.remove(context(), {
            skillId: initial.id,
            expectedRevision: 3,
            reason: "Discard learning",
          });
      } else {
        const input = {
          kind,
          id: initial.id,
          action,
          revision: action === "undo" ? 2 : 1,
          expectedRevision: 3,
        };
        const preview = await history.preview(context(), input);
        expect(preview.conflict).toBe(false);
        expect(preview.proposed.content).not.toContain("Ask one short question");
        if (action === "undo") expect(preview.proposed.content).toContain("Manual follow-up.");
        else expect(preview.proposed.content).toBe(baseline);
        await history.apply(context(), {
          ...input,
          reviewed: preview.proposed,
          reason: "Discard learning",
        });
      }
      const rejected = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(rejected).toMatchObject({ status: "rejected", reviewReason: "Discard learning" });
      const version = await history.version(context(), { kind, id: initial.id, revision: 2 });
      expect(version.after.content).toBe(proposal.native!.content);
      expect(version.currentRevision).toBe(4);
      expect(
        (await history.history(context(), { kind, id: initial.id })).items.find(
          (item) => item.revision === 2,
        )?.learningSource,
      ).toEqual({ botId: owner.botId, taskId: task.id });
      await expect(
        checkLearningRejection(db.prisma, rejected, "bot", proposal.native!.scope),
      ).rejects.toThrow("Previously rejected");
      await db.prisma.learningTask.delete({ where: { id: task.id } });
      expect(
        (await history.version(context(), { kind, id: initial.id, revision: 2 })).after.content,
      ).toBe(proposal.native!.content);
      expect(
        (await history.history(context(), { kind, id: initial.id })).items.find(
          (item) => item.revision === 2,
        )?.learningSource,
      ).toBeNull();
    },
  );
  it("returns only the captured source evidence and enforces task ownership after proposal creation", async () => {
    response = { ...response, publicSafe: false, kind: "memory", scope: "bot" };
    const task = await correction();
    await process(task.id);
    await createCustomerInbox(db.prisma).receive(channelId, {
      externalId: "later",
      externalThreadId: "thread",
      customerId: "synthetic",
      name: "Test shopper",
      body: "LATER_SOURCE_SENTINEL",
    });
    const learning = createLearning(db.prisma);
    expect(
      (await learning.taskEvidence(owner, { botId: owner.botId, taskId: task.id })).content,
    ).not.toContain("LATER_SOURCE_SENTINEL");
    const stranger = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    try {
      const { organizationId } = await db.prisma.space.findUniqueOrThrow({
        where: { id: owner.spaceId },
      });
      const membership = {
        organizationId,
        userId: stranger.userId,
        role: "member",
        createdAt: new Date(),
      };
      await db.prisma.member.create({ data: { ...membership, id: randomUUID() } });
      await db.prisma.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: owner.spaceId, userId: stranger.userId } },
      });
      const foreignBot = await db.prisma.bot.create({
        data: { spaceId: owner.spaceId, userId: stranger.userId, name: "Teammate", color: "blue" },
      });
      const foreign = { ...stranger, spaceId: owner.spaceId, botId: foreignBot.id };
      await expect(
        learning.taskEvidence(foreign, { botId: foreign.botId, taskId: task.id }),
      ).rejects.toThrow();
      await expect(learning.tasks(foreign, owner.botId)).rejects.toThrow();
      await expect(
        learning.decideTask(foreign, {
          botId: owner.botId,
          taskId: task.id,
          decision: "approve",
          reviewedProposal: await reviewed(task.id),
          reason: "Foreign review",
        }),
      ).rejects.toThrow();
      await approve(task.id);
      const saved = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
      await db.prisma.customerChannel.update({
        where: { id: channelId },
        data: { userId: stranger.userId },
      });
      await expect(
        learning.taskEvidence(owner, { botId: owner.botId, taskId: task.id }),
      ).rejects.toThrow();
      expect(
        (
          await createPrivateHistory(db.prisma, []).history(context(), {
            kind: "memory",
            id: saved.documentId!,
          })
        ).items[0]?.learningSource,
      ).toBeNull();
    } finally {
      await db.prisma.customerChannel.update({
        where: { id: channelId },
        data: { userId: owner.userId },
      });
      await db.prisma.spaceMember.deleteMany({
        where: { spaceId: owner.spaceId, userId: stranger.userId },
      });
      await db.prisma.space.delete({ where: { id: stranger.spaceId } });
      await db.prisma.user.delete({ where: { id: stranger.userId } });
    }
  });
  it("uses the actual private skill scope when blocking rejected inferences", async () => {
    response = { ...response, publicSafe: false, kind: "skill", scope: "bot" };
    const first = await correction();
    await process(first.id);
    await createLearning(db.prisma).decideTask(owner, {
      botId: owner.botId,
      taskId: first.id,
      decision: "reject",
      reason: "Not a reusable staff procedure",
    });
    const sibling = await db.prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Sibling staff bot",
        color: "blue",
      },
    });
    await db.prisma.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, botId: sibling.id },
    });
    const next = await db.prisma.learningTask.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: sibling.id,
        conversationId,
        sourceKey: "independent-evidence",
        evidence: first.evidence!,
      },
    });
    response = { ...response, scope: "space" };
    await process(next.id);
    expect(
      await db.prisma.learningTask.findUniqueOrThrow({ where: { id: next.id } }),
    ).toMatchObject({ targetKind: "skill", status: "rejected" });
    expect(calls.mock.calls.at(-1)![0].prompt).not.toContain("Not a reusable staff procedure");
  });
  it.each(["memory", "skill"] as const)(
    "retries undone %s learning in a new task without rewriting the approved proposal",
    async (kind) => {
      response = { ...response, publicSafe: false, kind, scope: "bot" };
      const task = await correction();
      await process(task.id);
      const originalProposal = await reviewed(task.id);
      await approve(task.id);
      const original = await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } });
      const history = createPrivateHistory(db.prisma, []);
      const undo = {
        kind,
        id: original.documentId!,
        revision: 1,
        expectedRevision: 1,
        action: "undo" as const,
      };
      const preview = await history.preview(context(), undo);
      await history.apply(context(), {
        ...undo,
        reviewed: preview.proposed,
        reason: "Reconsider learning",
      });
      const learning = createLearning(db.prisma);
      const retry = {
        botId: owner.botId,
        taskId: task.id,
        decision: "retry" as const,
        reason: "Explicitly reconsider with a narrower condition",
      };
      const results = await Promise.allSettled([
        learning.decideTask(owner, retry),
        learning.decideTask(owner, retry),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      expect(successful).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const result = successful[0]!.value;
      if (result.status !== "queued") throw new Error("Expected queued retry");
      const nextId = result.taskId;
      expect(nextId).not.toBe(task.id);
      response = { ...response, conditions: "Only staff follow-up with explicit sizing evidence" };
      await process(nextId);
      expect(
        await db.prisma.learningTask.findUniqueOrThrow({ where: { id: nextId } }),
      ).toMatchObject({ status: "review", rejectionOverride: true });
      await approve(nextId);
      expect(await reviewed(task.id)).toEqual(originalProposal);
      expect(
        await db.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({
        status: "rejected",
        documentId: original.documentId,
        appliedRevision: 1,
        inferenceKey: original.inferenceKey,
      });
      expect(
        (await history.history(context(), { kind, id: original.documentId! })).items.find(
          (item) => item.revision === 1,
        )?.learningSource?.taskId,
      ).toBe(task.id);
    },
  );
});
