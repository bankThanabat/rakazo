import type {
  Actor,
  LearningRestore,
  LearningSave,
  LearningTaskDecision,
  LearningTaskProposal,
  LearningUndo,
} from "@rakazo/contracts";
import {
  LearningRestoreInput,
  LearningSaveInput,
  LearningSourceRefSchema,
  LearningStateSchema,
  LearningTaskDecisionInput,
  LearningTaskProposalSchema,
  LearningUndoInput,
  LearningVersionSchema,
} from "@rakazo/contracts";
import { previewLearningUndo } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { handoffCustomer } from "./customer-inbox.js";
import { requireLearningAccess } from "./learning-access.js";
import { canApplyLearningAutomatically } from "./learning-policy.js";
import { checkLearningRejection } from "./learning-rejection.js";
import { createLearningReview, learningTaskView } from "./learning-review.js";
import {
  createLearningSources,
  readableLearningSources,
  requireLearningSource,
} from "./learning-sources.js";
import { applyNativeLearning } from "./native-learning.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = Pick<Actor, "spaceId" | "userId">;
export function createLearning(prisma: PrismaClient) {
  async function undoPreview(actor: Scope, raw: LearningRestore) {
    const input = LearningRestoreInput.parse(raw);
    const canEditSpace = await requireLearningAccess(prisma, actor, input.botId);
    const document = await prisma.learningDocument.findFirst({
      where: {
        id: input.documentId,
        spaceId: actor.spaceId,
        scopeKey: { in: ["space", input.botId] },
      },
    });
    if (!document || (document.scopeKey === "space" && !canEditSpace)) throw new IsolationError();
    if (document.revision !== input.expectedRevision)
      throw new Error("This document changed. Reload before undoing.");
    const after = await prisma.learningRevision.findUniqueOrThrow({
      where: {
        documentId_revision: {
          documentId: document.id,
          revision: input.revision,
        },
      },
    });
    const before =
      input.revision === 1
        ? { title: after.title, content: "", customerVisible: false }
        : await prisma.learningRevision.findUniqueOrThrow({
            where: {
              documentId_revision: {
                documentId: document.id,
                revision: input.revision - 1,
              },
            },
          });
    return {
      document,
      source: after.source,
      sourceRef: LearningSourceRefSchema.safeParse(after.sourceRef).data,
      preview: previewLearningUndo(
        LearningVersionSchema.parse(before),
        LearningVersionSchema.parse(after),
        LearningVersionSchema.parse(document),
      ),
    };
  }
  async function save(
    actor: Scope,
    raw: LearningSave,
    restoredFrom?: number,
    agentId?: string,
    taskGuard?: {
      taskId: string;
      token?: string;
      reviewReason?: string;
      baseline?: { documentId?: string; revision: number };
      reviewedProposal?: LearningTaskProposal;
    },
    undoneRevision?: number,
  ) {
    const input = LearningSaveInput.parse(raw);
    if (input.kind === "voice" && input.key !== "brand-voice")
      throw new Error("Use brand-voice as the voice document key");
    return prisma.$transaction(async (tx) => {
      // Space lock serializes first creation and revision changes, including restores.
      await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
      const canEditSpace = await requireLearningAccess(tx, actor, input.botId);
      if (input.scope === "space" && !canEditSpace) throw new IsolationError();
      if (taskGuard) {
        const bot = await tx.bot.findUniqueOrThrow({
          where: { id: input.botId },
        });
        if (taskGuard.token && !bot.learningEnabled)
          throw new Error("Automatic learning is paused.");
        if (taskGuard.baseline) {
          const baseline = await tx.learningDocument.findFirst({
            where: {
              spaceId: actor.spaceId,
              scopeKey: "space",
              kind: input.kind,
              key: input.key,
            },
          });
          if (
            (baseline?.revision ?? 0) !== taskGuard.baseline.revision ||
            (taskGuard.baseline.documentId && baseline?.id !== taskGuard.baseline.documentId)
          )
            throw new Error("The Space document changed. Regenerate this proposal.");
        }
        await tx.$queryRaw`SELECT id FROM learning_tasks WHERE id = ${taskGuard.taskId} FOR UPDATE`;
        const task = await tx.learningTask.findFirst({
          where: {
            id: taskGuard.taskId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: input.botId,
          },
        });
        if (
          !task ||
          (taskGuard.token
            ? task.status !== "running" ||
              task.leaseToken !== taskGuard.token ||
              !task.leaseUntil ||
              task.leaseUntil < new Date()
            : task.status !== "review")
        )
          throw new Error("This learning task changed. Reload before applying it.");
        if (
          !taskGuard.token &&
          JSON.stringify(LearningTaskProposalSchema.parse(task.proposal)) !==
            JSON.stringify(taskGuard.reviewedProposal)
        )
          throw new Error("This proposal changed. Review it again before approving.");
        const sourceRef = task.importId
          ? { kind: "import", id: task.importId }
          : { kind: "conversation", id: task.conversationId };
        if (input.sourceRef?.kind !== sourceRef.kind || input.sourceRef.id !== sourceRef.id)
          throw new Error("The learning source changed. Regenerate this proposal.");
        if (taskGuard.token) {
          if (!canApplyLearningAutomatically(task, LearningTaskProposalSchema.parse(task.proposal)))
            throw new Error("This correction requires staff review.");
          await checkLearningRejection(tx, task, input.scope);
        }
      }
      // Undo/restore uses an authorized document's recorded versions, not new
      // source evidence. Source removal must not make that document irreversible.
      if (input.sourceRef && restoredFrom === undefined) {
        const feed = await requireLearningSource(tx, actor, input.sourceRef);
        if (
          feed &&
          (feed.scope !== input.scope || (feed.scope === "bot" && feed.botId !== input.botId))
        )
          throw new Error("This source is approved for a different learning scope.");
      }
      const scopeKey = input.scope === "space" ? "space" : input.botId;
      const unique = {
        spaceId: actor.spaceId,
        scopeKey,
        kind: input.kind,
        key: input.key,
      };
      const current = await tx.learningDocument.findUnique({
        where: { spaceId_scopeKey_kind_key: unique },
      });
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new Error("This document changed. Reload before saving.");
      const data = {
        title: input.title,
        content: input.content,
        customerVisible: input.customerVisible,
        revision: input.expectedRevision + 1,
      };
      const document = await tx.learningDocument.upsert({
        where: { spaceId_scopeKey_kind_key: unique },
        create: { ...unique, ...data, botId: input.scope === "space" ? null : input.botId },
        update: data,
      });
      await tx.learningRevision.create({
        data: {
          documentId: document.id,
          ...data,
          userId: actor.userId,
          agentId,
          reason: input.reason,
          source: input.source,
          sourceRef: input.sourceRef,
          restoredFrom,
        },
      });
      if (undoneRevision !== undefined) {
        const tasks = await tx.learningTask.findMany({
          where: {
            targetKind: "document",
            documentId: document.id,
            appliedRevision: undoneRevision,
          },
          select: { id: true },
        });
        await tx.learningTask.updateMany({
          where: { id: { in: tasks.map((task) => task.id) } },
          data: {
            status: "rejected",
            rejectedAt: new Date(),
            reviewedByUserId: actor.userId,
            reviewReason: input.reason,
            summarizedAt: null,
          },
        });
        if (tasks.length)
          await tx.learningTaskReview.createMany({
            data: tasks.map((task) => ({
              taskId: task.id,
              userId: actor.userId,
              decision: "undo",
              reason: input.reason,
            })),
          });
      }
      if (taskGuard) {
        await tx.learningTask.update({
          where: { id: taskGuard.taskId },
          data: {
            status: "applied",
            rejectedAt: null,
            documentId: document.id,
            appliedRevision: document.revision,
            leaseToken: null,
            leaseUntil: null,
            error: null,
            summarizedAt: null,
          },
        });
        if (taskGuard.reviewReason)
          await tx.learningTaskReview.create({
            data: {
              taskId: taskGuard.taskId,
              userId: actor.userId,
              decision: "approve",
              reason: taskGuard.reviewReason,
            },
          });
      }
      if (input.customerVisible || current?.customerVisible) {
        // Idle conversations simply use the new version next turn. Pending work
        // needs review: replaying it could repeat an already dispatched action.
        const active = await tx.customerConversation.findMany({
          where: {
            owner: "bot",
            channel: {
              spaceId: actor.spaceId,
              ...(scopeKey === "space" ? {} : { botId: scopeKey }),
            },
            messages: {
              some: {
                status: { in: ["queued", "processing"] },
                role: { in: ["customer", "bot"] },
              },
            },
          },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        for (const conversation of active)
          await handoffCustomer(
            tx,
            conversation.id,
            "Learning changed during a reply. Review before resuming.",
          );
      }
      return { id: document.id, revision: document.revision };
    });
  }
  async function commitNative(
    actor: Scope,
    input: Pick<LearningTaskDecision, "botId" | "taskId" | "reviewedProposal"> & {
      reason?: string;
      token?: string;
    },
  ) {
    return withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
          await requirePrivateOwner(tx, actor, input.botId);
          await requireLearningAccess(tx, actor, input.botId);
          await tx.$queryRaw`SELECT id FROM learning_tasks WHERE id = ${input.taskId} FOR UPDATE`;
          const task = await tx.learningTask.findFirst({
            where: {
              id: input.taskId,
              ...privateOwner(actor),
              botId: input.botId,
              status: input.token ? "running" : "review",
            },
          });
          if (!task) throw new IsolationError();
          const proposal = LearningTaskProposalSchema.parse(task.proposal);
          if (
            !proposal.native ||
            (!input.token && JSON.stringify(proposal) !== JSON.stringify(input.reviewedProposal))
          )
            throw new Error("This proposal changed. Review it again before approving.");
          const automatic = Boolean(input.token);
          const reason = automatic ? proposal.save.reason : input.reason!;
          if (automatic) {
            const bot = await tx.bot.findUniqueOrThrow({ where: { id: task.botId } });
            if (
              !bot.learningEnabled ||
              task.leaseToken !== input.token ||
              !task.leaseUntil ||
              task.leaseUntil < new Date()
            )
              throw new Error("This learning task changed. Reload before applying it.");
            if (!canApplyLearningAutomatically(task, proposal))
              throw new Error("This correction requires staff review.");
            await checkLearningRejection(tx, task, proposal.save.scope, proposal.native!.scope);
          }
          const sourceRef = task.importId
            ? { kind: "import" as const, id: task.importId }
            : { kind: "conversation" as const, id: task.conversationId! };
          if (
            proposal.save.botId !== task.botId ||
            proposal.save.sourceRef?.kind !== sourceRef.kind ||
            proposal.save.sourceRef?.id !== sourceRef.id
          )
            throw new Error("The learning source changed. Regenerate this proposal.");
          const source = await requireLearningSource(tx, actor, sourceRef);
          if (
            source &&
            (source.scope !== proposal.save.scope ||
              (source.scope === "bot" && source.botId !== task.botId))
          )
            throw new Error("This source is approved for a different learning scope.");
          const saved = await applyNativeLearning(tx, actor, task, proposal, reason, automatic);
          await tx.learningTask.update({
            where: { id: task.id },
            data: {
              status: "applied",
              targetKind: saved.targetKind,
              documentId: saved.id,
              appliedRevision: saved.revision,
              rejectedAt: null,
              reviewedByUserId: automatic ? null : actor.userId,
              reviewReason: automatic ? null : reason,
              leaseToken: null,
              leaseUntil: null,
              error: null,
              summarizedAt: null,
            },
          });
          if (!automatic)
            await tx.learningTaskReview.create({
              data: {
                taskId: task.id,
                userId: actor.userId,
                decision: "approve",
                reason,
              },
            });
          return { status: "applied" as const, ...saved };
        },
        { isolationLevel: "Serializable" },
      ),
    );
  }
  return {
    ...createLearningSources(prisma),
    ...createLearningReview(prisma),
    save,
    async applyAutomaticTask(
      actor: Scope,
      input: { botId: string; taskId: string; token: string },
    ) {
      const task = await prisma.learningTask.findFirst({
        where: {
          ...privateOwner(actor),
          id: input.taskId,
          botId: input.botId,
          status: "running",
          leaseToken: input.token,
        },
      });
      if (!task) throw new IsolationError();
      const proposal = LearningTaskProposalSchema.parse(task.proposal);
      if (!canApplyLearningAutomatically(task, proposal))
        throw new Error("This correction requires staff review.");
      if (proposal.native) return commitNative(actor, input);
      return save(actor, proposal.save, undefined, task.botId, {
        taskId: task.id,
        token: input.token,
        baseline: proposal.baseline,
      });
    },
    async configure(actor: Scope, input: { botId: string; enabled?: boolean }) {
      return prisma.$transaction(async (tx) => {
        // Serialize pausing with an automatic document commit.
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        await requireLearningAccess(tx, actor, input.botId);
        if (input.enabled !== undefined)
          await tx.bot.update({
            where: { id: input.botId },
            data: { learningEnabled: input.enabled },
          });
        const bot = await tx.bot.findUniqueOrThrow({
          where: { id: input.botId },
        });
        return { enabled: bot.learningEnabled };
      });
    },
    async tasks(actor: Scope, botId: string) {
      return prisma.$transaction(async (tx) => {
        await requirePrivateOwner(tx, actor, botId);
        await requireLearningAccess(tx, actor, botId);
        const tasks = await tx.learningTask.findMany({
          where: { botId, spaceId: actor.spaceId, userId: actor.userId },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { reviews: { orderBy: { createdAt: "asc" } } },
        });
        return tasks.map(learningTaskView);
      });
    },
    async decideTask(actor: Scope, raw: LearningTaskDecision, agentId?: string) {
      const input = LearningTaskDecisionInput.parse(raw);
      await requireLearningAccess(prisma, actor, input.botId);
      if (input.decision === "approve") {
        const task = await prisma.learningTask.findFirst({
          where: {
            id: input.taskId,
            botId: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            status: "review",
          },
        });
        if (!task) throw new IsolationError();
        const proposal = LearningTaskProposalSchema.parse(task.proposal);
        if (proposal.native) return commitNative(actor, input);
        const saved = await save(
          actor,
          { ...proposal.save, reason: input.reason },
          undefined,
          agentId,
          {
            taskId: task.id,
            reviewReason: input.reason,
            baseline: proposal.baseline,
            reviewedProposal: input.reviewedProposal,
          },
        );
        return { status: "applied" as const, ...saved };
      }
      const taskId = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        await requirePrivateOwner(tx, actor, input.botId);
        await requireLearningAccess(tx, actor, input.botId);
        if (input.reviewedProposal || input.expectedStatus) {
          const snapshot = await tx.learningTask.findFirst({
            where: { ...privateOwner(actor), botId: input.botId, id: input.taskId },
            select: { proposal: true, status: true },
          });
          if (
            !snapshot ||
            (input.expectedStatus && input.expectedStatus !== snapshot.status) ||
            (input.reviewedProposal &&
              JSON.stringify(LearningTaskProposalSchema.parse(snapshot.proposal)) !==
                JSON.stringify(input.reviewedProposal))
          )
            throw new Error("This proposal changed. Review it again before deciding.");
        }
        if (input.decision === "retry") {
          const original = await tx.learningTask.findFirst({
            where: {
              ...privateOwner(actor),
              id: input.taskId,
              botId: input.botId,
              status: { in: ["review", "failed", "rejected", "cancelled"] },
            },
          });
          if (!original) throw new Error("This learning task changed. Reload before reviewing it.");
          // Applied revisions must keep the proposal they were approved from.
          if (original.appliedRevision !== null) {
            const sourceKey = `retry:${original.id}`;
            if (
              await tx.learningTask.findUnique({
                where: { botId_sourceKey: { botId: input.botId, sourceKey } },
              })
            )
              throw new Error("This task already has a retry. Review the newer task.");
            const ref = original.importId
              ? { kind: "import" as const, id: original.importId }
              : { kind: "conversation" as const, id: original.conversationId! };
            await requireLearningSource(tx, actor, ref);
            const review = { userId: actor.userId, decision: "retry", reason: input.reason };
            const next = await tx.learningTask.create({
              data: {
                ...privateOwner(actor),
                botId: input.botId,
                sourceKey,
                importId: original.importId,
                conversationId: original.conversationId,
                correctionKey: original.correctionKey,
                evidence: original.evidence ?? {},
                targetKind: original.targetKind,
                rejectionOverride: true,
                reviewedByUserId: actor.userId,
                reviewReason: input.reason,
                reviews: { create: review },
              },
            });
            await tx.learningTaskReview.create({ data: { ...review, taskId: original.id } });
            return next.id;
          }
        }
        const changed = await tx.learningTask.updateMany({
          where: {
            id: input.taskId,
            botId: input.botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            status: {
              in:
                input.decision === "retry"
                  ? ["review", "failed", "rejected", "cancelled"]
                  : ["review", "queued", "failed"],
            },
          },
          data: {
            status: input.decision === "retry" ? "queued" : "rejected",
            rejectedAt: input.decision === "retry" ? null : new Date(),
            rejectionOverride: input.decision === "retry",
            nextAttemptAt: new Date(),
            attempts: 0,
            reviewedByUserId: actor.userId,
            reviewReason: input.reason,
            error: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });
        if (changed.count !== 1)
          throw new Error("This learning task changed. Reload before reviewing it.");
        await tx.learningTaskReview.create({
          data: {
            taskId: input.taskId,
            userId: actor.userId,
            decision: input.decision,
            reason: input.reason,
          },
        });
        return input.taskId;
      });
      return {
        taskId,
        status: input.decision === "retry" ? ("queued" as const) : ("rejected" as const),
      };
    },
    async previewUndo(actor: Scope, input: LearningRestore) {
      return (await undoPreview(actor, input)).preview;
    },
    async undo(actor: Scope, raw: LearningUndo, agentId?: string) {
      const input = LearningUndoInput.parse(raw);
      const { document, source, sourceRef, preview } = await undoPreview(actor, input);
      if (preview.conflicts.length && !input.resolution)
        throw new Error("Later edits overlap this change. Review the undo before applying it.");
      const reviewedEdits =
        input.resolution &&
        (input.resolution.title !== preview.proposed.title ||
          input.resolution.content !== preview.proposed.content ||
          input.resolution.customerVisible !== preview.proposed.customerVisible);
      return save(
        actor,
        {
          botId: input.botId,
          scope: document.scopeKey === "space" ? "space" : "bot",
          kind: LearningSaveInput.shape.kind.parse(document.kind),
          key: document.key,
          ...(input.resolution ?? preview.proposed),
          expectedRevision: input.expectedRevision,
          reason: `Undo version ${input.revision}${reviewedEdits ? " with reviewed edits" : ""}: ${input.reason}`,
          source,
          sourceRef,
        },
        input.revision - 1,
        agentId,
        undefined,
        input.revision,
      );
    },
    async state(actor: Scope, botId: string) {
      const canEditSpace = await requireLearningAccess(prisma, actor, botId);
      const documents = await prisma.learningDocument.findMany({
        where: { spaceId: actor.spaceId, scopeKey: { in: ["space", botId] } },
        orderBy: [{ kind: "asc" }, { scopeKey: "asc" }, { key: "asc" }],
      });
      const history = await prisma.learningRevision.findMany({
        where: { documentId: { in: documents.map((d) => d.id) } },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const [people, agents, evidence] = await Promise.all([
        prisma.user.findMany({
          where: { id: { in: history.map((r) => r.userId) } },
          select: { id: true, name: true },
        }),
        prisma.bot.findMany({
          where: {
            spaceId: actor.spaceId,
            id: { in: history.flatMap((r) => (r.agentId ? [r.agentId] : [])) },
          },
          select: { id: true, name: true },
        }),
        readableLearningSources(
          prisma,
          actor,
          history.flatMap((revision) => {
            const ref = LearningSourceRefSchema.safeParse(revision.sourceRef);
            return ref.success ? [ref.data] : [];
          }),
        ),
      ]);
      return LearningStateSchema.parse({
        documents: documents.map((d) => ({
          ...d,
          scope: d.scopeKey === "space" ? "space" : "bot",
          canEdit: d.scopeKey !== "space" || canEditSpace,
          updatedAt: d.updatedAt.toISOString(),
        })),
        history: history.map((r) => {
          const ref = LearningSourceRefSchema.safeParse(r.sourceRef);
          return {
            ...r,
            hasEvidence: ref.success && evidence.has(`${ref.data.kind}:${ref.data.id}`),
            actor: r.agentId
              ? `Agent · ${agents.find((a) => a.id === r.agentId)?.name ?? "Former teammate"}`
              : `Staff · ${people.find((p) => p.id === r.userId)?.name ?? "Former member"}`,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        canEditSpace,
      });
    },
    async restore(
      actor: Scope,
      input: {
        botId: string;
        documentId: string;
        revision: number;
        expectedRevision: number;
      },
      agentId?: string,
    ) {
      await requireLearningAccess(prisma, actor, input.botId);
      const document = await prisma.learningDocument.findFirst({
        where: {
          id: input.documentId,
          spaceId: actor.spaceId,
          scopeKey: { in: ["space", input.botId] },
        },
      });
      if (!document) throw new IsolationError();
      const revision = await prisma.learningRevision.findUniqueOrThrow({
        where: {
          documentId_revision: {
            documentId: document.id,
            revision: input.revision,
          },
        },
      });
      return save(
        actor,
        LearningSaveInput.parse({
          botId: input.botId,
          scope: document.scopeKey === "space" ? "space" : "bot",
          kind: document.kind,
          key: document.key,
          title: revision.title,
          content: revision.content,
          customerVisible: revision.customerVisible,
          expectedRevision: input.expectedRevision,
          reason: `Restore version ${revision.revision}`,
          source: revision.source,
          sourceRef: LearningSourceRefSchema.safeParse(revision.sourceRef).data,
        }),
        revision.revision,
        agentId,
      );
    },
    /** Internal execution path. Caller has already authenticated the bot/channel. */
    async customerContext(spaceId: string, botId: string) {
      const rows = await prisma.learningDocument.findMany({
        where: { spaceId, scopeKey: { in: ["space", botId] } },
        orderBy: { key: "asc" },
      });
      const effective = new Map<string, (typeof rows)[number]>();
      for (const row of rows.filter((r) => r.scopeKey === "space"))
        effective.set(`${row.kind}:${row.key}`, row);
      for (const row of rows.filter((r) => r.scopeKey === botId && r.content))
        effective.set(`${row.kind}:${row.key}`, row);
      const text = [...effective.values()]
        .filter((r) => r.customerVisible && r.content)
        .map((r) =>
          JSON.stringify({
            kind: r.kind,
            title: r.title,
            version: r.revision,
            content: r.content,
          }),
        )
        .join("\n");
      if (text.length > 48000)
        throw new Error("Customer learning context is too large; narrow the shared documents");
      return text;
    },
  };
}
