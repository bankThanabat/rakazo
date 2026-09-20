import { createHash } from "node:crypto";
import type { Actor, LearningArchive, LearningSourceRef } from "@rakazo/contracts";
import {
  LearningArchiveInput,
  LearningEvidenceSchema,
  LearningSourceRefSchema,
} from "@rakazo/contracts";
import { canonicalLearningImport, previewLearningImport } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { customerChannelAccessWhere } from "./customers.js";
import { requireLearningAccess } from "./learning-access.js";
import { requireLearningFeed } from "./learning-feed-access.js";
import { requireLearningHistory } from "./learning-history-access.js";
import { privateOwner, requirePrivateOwner } from "./private-audit.js";
import { connectionAccessWhere, IsolationError } from "./scope.js";

type Scope = Pick<Actor, "spaceId" | "userId">;
type Db = PrismaClient | Prisma.TransactionClient;

function importAccessWhere(actor: Scope): Prisma.LearningImportWhereInput {
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    bot: { userId: actor.userId, archivedAt: null },
  };
}

/** Advertise evidence only when this staff member can still read its source. */
export async function readableLearningSources(db: Db, actor: Scope, refs: LearningSourceRef[]) {
  const [archives, conversations] = await Promise.all([
    db.learningImport.findMany({
      where: {
        ...importAccessWhere(actor),
        id: { in: refs.filter((ref) => ref.kind === "import").map((ref) => ref.id) },
      },
      select: { id: true },
    }),
    db.customerConversation.findMany({
      where: {
        channel: customerChannelAccessWhere(actor),
        id: { in: refs.filter((ref) => ref.kind === "conversation").map((ref) => ref.id) },
      },
      select: { id: true },
    }),
  ]);
  return new Set([
    ...archives.map(({ id }) => `import:${id}`),
    ...conversations.map(({ id }) => `conversation:${id}`),
  ]);
}

/** Recheck source authorization at use time; a stored reference grants no access. */
export async function requireLearningSource(
  db: Db,
  actor: Scope,
  ref: LearningSourceRef,
  active = true,
) {
  if (ref.kind === "import") {
    const archive = await db.learningImport.findFirst({
      where: {
        ...importAccessWhere(actor),
        id: ref.id,
      },
      include: { history: true },
    });
    if (!archive) throw new IsolationError();
    if (active && archive.withdrawnAt)
      throw new Error("This learning source was removed. Choose another source.");
    if (active && archive.feedId) {
      const feed = await requireLearningFeed(db, actor, archive.feedId);
      if (feed.revision !== archive.feedRevision)
        throw new Error(
          "The learning source changed. Use evidence from its current configuration.",
        );
      return { botId: feed.botId, scope: feed.scope };
    }
    if (active && archive.history)
      return requireLearningHistory(db, actor, archive.history, archive.botId);
    return;
  }
  const conversation = await db.customerConversation.findFirst({
    where: { id: ref.id, channel: customerChannelAccessWhere(actor) },
    include: { channel: true },
  });
  if (!conversation) throw new IsolationError();
  if (!active) return;
  const channel = conversation.channel;
  if (
    !channel.enabled ||
    (channel.provider !== "web" &&
      (!channel.connectionId ||
        !(await db.connection.findFirst({
          where: {
            id: channel.connectionId,
            status: "connected",
            ...connectionAccessWhere(actor),
          },
        }))))
  )
    throw new Error("This source is disconnected. Reconnect it before learning from it.");
}

export function createLearningSources(prisma: PrismaClient) {
  return {
    async archive(actor: Scope, raw: LearningArchive) {
      const input = LearningArchiveInput.parse(raw);
      const preview = previewLearningImport(input);
      if (!preview.accepted) throw new Error("No business replies in the selected 30-day window.");
      const digest = createHash("sha256").update(canonicalLearningImport(input)).digest("hex");
      // Samples are a transient private preview, never retained after source withdrawal.
      const {
        content: _,
        samples: _samples,
        mapping: _mapping,
        timezoneOffset: _timezone,
        ...coverage
      } = preview;
      const archive = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        await requireLearningAccess(tx, actor, input.botId);
        return tx.learningImport.upsert({
          where: {
            spaceId_botId_digest: {
              spaceId: actor.spaceId,
              botId: input.botId,
              digest,
            },
          },
          update: {},
          create: {
            spaceId: actor.spaceId,
            botId: input.botId,
            userId: actor.userId,
            digest,
            label: input.source,
            format: input.format,
            content: input.content,
            coverage,
            mapping: input.mapping,
            timezoneOffset: input.timezoneOffset,
            windowEnd: new Date(input.windowEnd),
          },
        });
      });
      // Reuploading identical rejected evidence must not silently reactivate it.
      if (archive.withdrawnAt)
        throw new Error("This import was removed. Use new evidence instead.");
      return {
        sourceId: archive.id,
        preview: previewLearningImport({
          ...input,
          format: archive.format,
          content: archive.content,
          mapping: archive.mapping ?? undefined,
          timezoneOffset: archive.timezoneOffset ?? undefined,
          windowEnd: archive.windowEnd.toISOString(),
        }),
      };
    },
    async taskEvidence(actor: Scope, input: { botId: string; taskId: string }) {
      return prisma.$transaction(async (tx) => {
        await requirePrivateOwner(tx, actor, input.botId);
        await requireLearningAccess(tx, actor, input.botId);
        const task = await tx.learningTask.findFirst({
          where: { id: input.taskId, ...privateOwner(actor), botId: input.botId },
          include: { import: true },
        });
        if (!task) throw new IsolationError();
        const ref = task.importId
          ? { kind: "import" as const, id: task.importId }
          : { kind: "conversation" as const, id: task.conversationId! };
        await requireLearningSource(tx, actor, ref, false);
        const withdrawn = Boolean(task.import?.withdrawnAt);
        return LearningEvidenceSchema.parse({
          kind: task.import?.feedId ? "social" : task.importId ? "import" : "conversation",
          sourceId: ref.id,
          label: task.import?.label ?? "Staff corrections and verified business replies",
          content: withdrawn ? "" : JSON.stringify(task.evidence, null, 2),
          format: "json",
          coverage: null,
          windowEnd: task.createdAt.toISOString(),
          withdrawn,
        });
      });
    },
    async evidence(actor: Scope, input: { botId: string; revisionId: string }) {
      await requireLearningAccess(prisma, actor, input.botId);
      const revision = await prisma.learningRevision.findFirst({
        where: {
          id: input.revisionId,
          document: {
            spaceId: actor.spaceId,
            scopeKey: { in: ["space", input.botId] },
          },
        },
      });
      const parsed = LearningSourceRefSchema.safeParse(revision?.sourceRef);
      if (!parsed.success) throw new IsolationError();
      const ref = parsed.data;
      await requireLearningSource(prisma, actor, ref, false);
      if (ref.kind === "import") {
        const archive = await prisma.learningImport.findUniqueOrThrow({
          where: { id: ref.id },
        });
        return LearningEvidenceSchema.parse({
          kind: archive.feedId ? "social" : "import",
          sourceId: archive.id,
          label: archive.label,
          content: archive.content ?? "",
          format: archive.format,
          coverage: archive.coverage,
          mapping: archive.mapping,
          timezoneOffset: archive.timezoneOffset,
          windowEnd: archive.windowEnd.toISOString(),
          withdrawn: Boolean(archive.withdrawnAt),
        });
      }
      // Fetch only evidence that existed when the revision was created. Later
      // replies cannot retroactively justify an older inference.
      const [messages, guidance] = await Promise.all([
        prisma.customerMessage.findMany({
          where: {
            conversationId: ref.id,
            createdAt: { lte: revision!.createdAt },
          },
          orderBy: { seq: "desc" },
          take: 100,
          select: {
            id: true,
            role: true,
            body: true,
            createdAt: true,
            status: true,
          },
        }),
        prisma.customerGuidance.findMany({
          where: {
            conversationId: ref.id,
            createdAt: { lte: revision!.createdAt },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, content: true, createdAt: true, userId: true },
        }),
      ]);
      return LearningEvidenceSchema.parse({
        kind: "conversation",
        sourceId: ref.id,
        label: "Customer conversation",
        content: JSON.stringify(
          {
            coverage: "Up to 100 messages and 20 staff corrections preceding this revision",
            messages: messages.reverse(),
            guidance: guidance.reverse(),
          },
          null,
          2,
        ),
        format: "json",
        coverage: null,
        windowEnd: revision!.createdAt.toISOString(),
        withdrawn: false,
      });
    },
    async withdraw(actor: Scope, input: { botId: string; sourceId: string }) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
        await requireLearningAccess(tx, actor, input.botId);
        await requireLearningSource(tx, actor, { kind: "import", id: input.sourceId }, false);
        await tx.learningTask.deleteMany({ where: { importId: input.sourceId } });
        await tx.learningHistory.updateMany({
          where: { importId: input.sourceId },
          data: { status: "cancelled", error: null },
        });
        await tx.learningImport.updateMany({
          where: {
            id: input.sourceId,
            userId: actor.userId,
            spaceId: actor.spaceId,
            withdrawnAt: null,
          },
          data: {
            content: null,
            mapping: Prisma.DbNull,
            timezoneOffset: null,
            withdrawnAt: new Date(),
          },
        });
      });
      return { removed: true as const };
    },
  };
}
