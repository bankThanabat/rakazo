import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  MemoryDocumentSchema,
  MemoryDocumentsInput,
  MemoryHistoryInput,
  MemoryHistorySchema,
  MemoryReadInput,
  MemoryRestoreInput,
  MemoryUndoInput,
  MemoryUpdateInput,
} from "@rakazo/contracts";
import { previewContentUndo } from "@rakazo/core";
import type { MemoryDocument, Prisma, PrismaClient } from "./client.js";
import { rejectNativeLearning } from "./learning-rejection.js";
import {
  privateAuditProvenance,
  privateAuditTransaction,
  privateOwner,
  requirePrivateOwner,
} from "./private-audit.js";
import { IsolationError } from "./scope.js";

type Owner = Pick<Actor, "spaceId" | "userId">;
type Db = PrismaClient | Prisma.TransactionClient;

function documentView(doc: MemoryDocument) {
  return MemoryDocumentSchema.parse({ ...doc, updatedAt: doc.updatedAt.toISOString() });
}

/** One write path for agents, staff edits, imports and reversals of the effective memory. */
export async function commitMemory(
  prisma: PrismaClient | Prisma.TransactionClient,
  request: MemoryCommitRequest,
  context: AdapterContext,
): Promise<MemoryDocument> {
  if (
    !request.path.trim() ||
    request.path.length > 1000 ||
    request.content.length > 100000 ||
    (request.reason !== undefined && (!request.reason.trim() || request.reason.length > 1000)) ||
    (request.scope === "bot" && !request.botId) ||
    (request.scope === "user" && request.botId)
  )
    throw new Error("Invalid memory document");
  const owner = { spaceId: context.spaceId, userId: context.userId };
  return privateAuditTransaction(
    prisma,
    async (tx) => {
      await requirePrivateOwner(tx, owner, request.botId);

      const existing = await tx.memoryDocument.findFirst({
        where: {
          ...privateOwner(owner),
          scope: request.scope,
          botId: request.botId ?? null,
          path: request.path,
        },
      });
      if (
        request.expectedRevision !== undefined &&
        request.expectedRevision !== (existing?.revision ?? 0)
      )
        throw new Error("This memory changed. Reload before saving.");
      if (existing)
        await tx.memoryRevision.createMany({
          skipDuplicates: true,
          data: {
            documentId: existing.id,
            revision: existing.revision,
            content: existing.content,
            reason: "Existing memory snapshot",
            createdAt: existing.updatedAt,
          },
        });
      const document = existing
        ? await tx.memoryDocument.update({
            where: { id: existing.id },
            data: { content: request.content, revision: existing.revision + 1 },
          })
        : await tx.memoryDocument.create({
            data: {
              ...privateOwner(owner),
              scope: request.scope,
              botId: request.botId,
              path: request.path,
              content: request.content,
            },
          });
      const provenance = await privateAuditProvenance(tx, context, request);
      await tx.memoryRevision.create({
        data: {
          documentId: document.id,
          revision: document.revision,
          content: document.content,
          reason:
            request.reason?.trim() ??
            (provenance.sourceRunId ? "Saved from staff conversation" : "Edited memory"),
          ...provenance,
          restoredFrom: request.restoredFrom,
          undoneRevision: request.undoneRevision,
        },
      });
      await rejectNativeLearning(tx, owner, "memory", document.id, {
        reason: request.reason?.trim() ?? "Edited memory",
        removed: !request.content.trim(),
        restoredFrom: request.restoredFrom,
        undoneRevision: request.undoneRevision,
      });
      return document;
    },
    true,
  );
}

export async function readMemoryDocuments(
  prisma: PrismaClient,
  owner: Owner,
  filter: {
    scope?: "bot" | "user";
    botId?: string;
    path?: string;
    includeUser?: boolean;
  } = {},
) {
  return prisma.$transaction(async (tx) => {
    await requirePrivateOwner(tx, owner);
    return tx.memoryDocument.findMany({
      where: {
        ...privateOwner(owner),
        ...(filter.scope ? { scope: filter.scope } : {}),
        ...(filter.botId
          ? filter.includeUser
            ? { OR: [{ botId: filter.botId }, { scope: "user", botId: null }] }
            : { botId: filter.botId }
          : {}),
        ...(filter.path ? { path: filter.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });
}

export function createMemoryAudit(prisma: PrismaClient) {
  async function owned(db: Db, owner: Owner, documentId: string) {
    await requirePrivateOwner(db, owner);
    const doc = await db.memoryDocument.findFirst({
      where: { ...privateOwner(owner), id: documentId },
    });
    if (!doc) throw new IsolationError();
    return doc;
  }
  async function reversal(db: Db, owner: Owner, raw: unknown) {
    const input = MemoryRestoreInput.parse(raw);
    const document = await owned(db, owner, input.documentId);
    if (document.revision !== input.expectedRevision)
      throw new Error("This memory changed. Reload before reviewing it.");
    const after = await db.memoryRevision.findUnique({
      where: {
        documentId_revision: { documentId: document.id, revision: input.revision },
      },
    });
    if (!after) throw new Error("This memory version is unavailable.");
    return { input, document, after };
  }
  async function preview(db: Db, owner: Owner, raw: unknown) {
    const result = await reversal(db, owner, raw);
    const { input, document, after } = result;
    const before =
      input.revision === 1 && after.actorKind !== "unknown"
        ? { content: "" }
        : await db.memoryRevision.findUnique({
            where: {
              documentId_revision: { documentId: document.id, revision: input.revision - 1 },
            },
          });
    if (!before)
      throw new Error(
        "The preceding memory version is unavailable. Choose a known version to restore.",
      );
    const reverse = previewContentUndo(before.content, after.content, document.content);
    return {
      ...result,
      preview: {
        before: before.content,
        after: after.content,
        current: document.content,
        proposed: reverse.content,
        conflict: reverse.conflict,
      },
    };
  }
  async function apply(
    context: AdapterContext,
    document: MemoryDocument,
    input: {
      content: string;
      expectedRevision: number;
      reason: string;
      restoredFrom?: number;
      undoneRevision?: number;
    },
  ) {
    const saved = await commitMemory(
      prisma,
      {
        ...input,
        scope: document.scope as "user" | "bot",
        botId: document.botId ?? undefined,
        path: document.path,
        sourceRunId: context.runId,
      },
      context,
    );
    return documentView(saved);
  }
  return {
    async update(context: AdapterContext, raw: unknown) {
      const input = MemoryUpdateInput.parse(raw);
      const document = await prisma.$transaction((tx) => owned(tx, context, input.documentId));
      return apply(context, document, input);
    },
    async list(owner: Owner, botId: string, raw: unknown = {}) {
      const { cursor } = MemoryDocumentsInput.parse(raw);
      return prisma.$transaction(async (db) => {
        await requirePrivateOwner(db, owner);
        const where = { ...privateOwner(owner), OR: [{ botId }, { scope: "user", botId: null }] };
        if (cursor && !(await db.memoryDocument.count({ where: { ...where, id: cursor } })))
          throw new IsolationError();
        const rows = await db.memoryDocument.findMany({
          where,
          orderBy: { id: "asc" },
          take: 11,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, path: true, scope: true, revision: true },
        });
        return {
          items: rows.slice(0, 10).map((row) => ({
            ...row,
            path: row.path.slice(0, 128),
            pathTruncated: row.path.length > 128,
          })),
          nextCursor: rows.length > 10 ? rows[9]!.id : null,
        };
      });
    },
    async read(owner: Owner, raw: unknown) {
      const input = MemoryReadInput.parse(raw);
      return prisma.$transaction(async (db) => {
        const document = await owned(db, owner, input.documentId);
        const revision = input.revision ?? document.revision;
        const version =
          revision === document.revision
            ? document
            : await db.memoryRevision.findUnique({
                where: { documentId_revision: { documentId: document.id, revision } },
              });
        if (!version) throw new Error("This memory version is unavailable.");
        return {
          documentId: document.id,
          revision,
          content: version.content.slice(input.offset, input.offset + 1000),
          totalCharacters: version.content.length,
          nextOffset: input.offset + 1000 < version.content.length ? input.offset + 1000 : null,
        };
      });
    },
    async history(owner: Owner, raw: unknown) {
      const input = MemoryHistoryInput.parse(raw);
      return prisma.$transaction(async (db) => {
        const document = await owned(db, owner, input.documentId);
        const rows = await db.memoryRevision.findMany({
          where: {
            documentId: document.id,
            ...(input.beforeRevision ? { revision: { lt: input.beforeRevision } } : {}),
          },
          orderBy: { revision: "desc" },
          take: input.limit + 1,
          omit: { content: true },
        });
        const agents = await db.bot.findMany({
          where: {
            ...privateOwner(owner),
            id: { in: rows.flatMap((row) => (row.agentId ? [row.agentId] : [])) },
          },
          select: { id: true, name: true },
        });
        const threads = await db.thread.findMany({
          where: {
            ...privateOwner(owner),
            id: { in: rows.flatMap((row) => (row.sourceThreadId ? [row.sourceThreadId] : [])) },
          },
          select: { id: true },
        });
        const runs = await db.run.findMany({
          where: {
            ...privateOwner(owner),
            id: { in: rows.flatMap((row) => (row.sourceRunId ? [row.sourceRunId] : [])) },
          },
          select: { id: true },
        });
        return MemoryHistorySchema.parse({
          document: documentView(document),
          items: rows.slice(0, input.limit).map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
            actor: row.agentId
              ? `Agent · ${agents.find((agent) => agent.id === row.agentId)?.name ?? "Former teammate"}`
              : row.actorKind === "agent" || row.sourceRunId
                ? "Agent"
                : row.actorKind === "staff"
                  ? "Staff"
                  : "Unknown",
            sourceThreadId: threads.some((thread) => thread.id === row.sourceThreadId)
              ? row.sourceThreadId
              : null,
            sourceRunId: runs.some((run) => run.id === row.sourceRunId) ? row.sourceRunId : null,
          })),
          nextBeforeRevision: rows.length > input.limit ? rows[input.limit - 1]!.revision : null,
        });
      });
    },
    async version(owner: Owner, raw: unknown) {
      const input = MemoryReadInput.required({ revision: true }).parse(raw);
      return prisma.$transaction(async (db) => {
        const document = await owned(db, owner, input.documentId);
        const after = await db.memoryRevision.findUnique({
          where: { documentId_revision: { documentId: document.id, revision: input.revision } },
        });
        if (!after) throw new Error("This memory version is unavailable.");
        const before =
          after.revision === 1 && after.actorKind !== "unknown"
            ? { content: "" }
            : await db.memoryRevision.findUnique({
                where: {
                  documentId_revision: { documentId: document.id, revision: input.revision - 1 },
                },
              });
        const value = (item: { content: string }) => ({ content: item.content, removed: false });
        return {
          currentRevision: document.revision,
          before: before ? value(before) : null,
          after: value(after),
          current: value(document),
        };
      });
    },
    async previewUndo(owner: Owner, raw: unknown) {
      return (await prisma.$transaction((tx) => preview(tx, owner, raw))).preview;
    },
    async undo(context: AdapterContext, raw: unknown) {
      const input = MemoryUndoInput.parse(raw);
      const { document, preview: change } = await prisma.$transaction((tx) =>
        preview(tx, context, input),
      );
      if (change.conflict && input.resolution === undefined)
        throw new Error(
          "Later edits overlap this memory change. Review the proposed text before undoing.",
        );
      const content = input.resolution ?? change.proposed;
      if (input.reviewedContent !== undefined && input.reviewedContent !== content)
        throw new Error("The reviewed memory text does not match this change. Preview it again.");
      return apply(context, document, {
        content,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        undoneRevision: input.revision,
        restoredFrom: input.revision - 1,
      });
    },
    async restore(context: AdapterContext, raw: unknown) {
      const { input, document, after } = await prisma.$transaction((tx) =>
        reversal(tx, context, raw),
      );
      if (input.reviewedContent !== undefined && input.reviewedContent !== after.content)
        throw new Error("The reviewed memory text does not match this version. Read it again.");
      return apply(context, document, {
        content: after.content,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        restoredFrom: input.revision,
      });
    },
  };
}
