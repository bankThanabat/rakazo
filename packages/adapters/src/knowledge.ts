import { randomUUID } from "node:crypto";
import type { ArtifactStore, JobPublisher, KnowledgeProvider } from "@rakazo/adapter-kit";
import { KnowledgeRejectedError } from "@rakazo/adapter-kit";
import type { Actor, KnowledgeState } from "@rakazo/contracts";
import {
  KNOWLEDGE_MIME_TYPES,
  KnowledgeConfigureInput,
  KnowledgeSearchInput,
  KnowledgeStatus,
  KnowledgeUploadInput,
} from "@rakazo/contracts";
import { decodeAttachmentBase64 } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { handoffCustomer, IsolationError, Prisma } from "@rakazo/db";
import { knowledgeEndpoint, OpenRagKnowledgeProvider } from "./knowledge-openrag.js";
import type { EncryptedSecretStore } from "./secrets.js";

type Caller = Pick<Actor, "spaceId" | "userId">;
type Library = { id: string; spaceId: string; userId: string; baseUrl: string; ciphertext: string };
type SourceDb = Pick<Prisma.TransactionClient, "knowledgeSource">;
const maxCleanupAttempts = 12;
const extension = (mimeType: string) =>
  Object.entries(KNOWLEDGE_MIME_TYPES).find(([, type]) => type === mimeType)?.[0];

export type KnowledgeService = ReturnType<typeof createKnowledge>;
export function createKnowledge(deps: {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  secrets: EncryptedSecretStore;
  jobs: JobPublisher;
  provider?: (config: { baseUrl: string; apiKey: string }) => KnowledgeProvider;
}) {
  const { prisma } = deps;
  const provider = (library: Library) =>
    (deps.provider ?? ((config) => new OpenRagKnowledgeProvider(config)))({
      baseUrl: library.baseUrl,
      apiKey: deps.secrets.load(library.ciphertext, library.id),
    });
  const storageContext = (library: Library) => ({
    spaceId: library.spaceId,
    userId: library.userId,
    operationId: "knowledge",
    traceId: "knowledge",
    signal: AbortSignal.timeout(30_000),
  });
  async function assertMember(actor: Caller) {
    if (
      !(await prisma.spaceMember.count({
        where: { spaceId: actor.spaceId, userId: actor.userId, space: { deletingAt: null } },
      }))
    )
      throw new IsolationError();
  }
  async function ownedBot(actor: Caller, botId: string) {
    await assertMember(actor);
    const row = await prisma.bot.findFirst({
      where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
    });
    if (!row) throw new IsolationError();
    return row;
  }
  async function libraryFor(actor: Caller, owner = false) {
    await assertMember(actor);
    const library = await prisma.knowledgeLibrary.findUnique({ where: { spaceId: actor.spaceId } });
    if (!library || (owner && library.userId !== actor.userId)) throw new IsolationError();
    return library;
  }
  async function lockLibrary(tx: Prisma.TransactionClient, libraryId: string) {
    await tx.$queryRaw`SELECT id FROM knowledge_libraries WHERE id = ${libraryId} FOR UPDATE`;
  }
  async function handOffCustomers(tx: Prisma.TransactionClient, libraryId: string, botId?: string) {
    // Library -> conversations -> messages is the lock order for every policy mutation.
    const conversations = await tx.customerConversation.findMany({
      where: {
        owner: "bot",
        messages: { some: { status: { in: ["queued", "processing", "sending"] } } },
        channel: { bot: botId ? { id: botId } : { knowledgeLibraryId: libraryId } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    for (const conversation of conversations)
      await handoffCustomer(tx, conversation.id, "Knowledge access changed");
  }
  async function findSource(db: SourceDb, libraryId: string, sourceId: string) {
    const source = await db.knowledgeSource.findFirst({
      where: { id: sourceId, libraryId, deletedAt: null },
    });
    if (!source) throw new IsolationError();
    return source;
  }
  async function enqueue(revisionId: string) {
    await deps.jobs.enqueue({
      name: "knowledge.process",
      payload: { revisionId },
      replaceKey: `knowledge:${revisionId}`,
    });
  }
  async function state(actor: Caller, botId: string): Promise<KnowledgeState> {
    const agent = await ownedBot(actor, botId);
    const library = await prisma.knowledgeLibrary.findUnique({ where: { spaceId: actor.spaceId } });
    if (!library) return { configured: false, enabled: false, canManage: true, sources: [] };
    const sources = await prisma.knowledgeSource.findMany({
      where: { libraryId: library.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: { revisions: { orderBy: { createdAt: "desc" } } },
    });
    return {
      configured: true,
      enabled: agent.knowledgeLibraryId === library.id,
      canManage: library.userId === actor.userId,
      baseUrl: library.baseUrl,
      sources: sources.map((source) => {
        const revision =
          source.revisions.find((r) => r.id === source.pendingRevisionId) ??
          source.revisions.find((r) => r.id === source.activeRevisionId) ??
          source.revisions[0];
        return {
          id: source.id,
          name: source.name,
          internal: source.internal,
          activeRevisionId: source.activeRevisionId,
          status: KnowledgeStatus.parse(revision?.status ?? "failed"),
        };
      }),
    };
  }
  async function configure(actor: Caller, raw: unknown) {
    const input = KnowledgeConfigureInput.parse(raw);
    await ownedBot(actor, input.botId);
    const baseUrl = knowledgeEndpoint(input.baseUrl);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${actor.spaceId} FOR UPDATE`;
      const current = await tx.knowledgeLibrary.findUnique({ where: { spaceId: actor.spaceId } });
      if (current) {
        if (current.userId !== actor.userId) throw new IsolationError();
        await lockLibrary(tx, current.id);
        // Rebinding an existing index silently would strand revisions or change ownership.
        if (current.baseUrl !== baseUrl)
          throw new Error("Keep the current knowledge URL; migrate documents before changing it");
        await tx.knowledgeLibrary.update({
          where: { id: current.id },
          data: { ciphertext: deps.secrets.seal(input.apiKey, current.id) },
        });
      } else {
        const id = randomUUID();
        await tx.knowledgeLibrary.create({
          data: {
            id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            baseUrl,
            ciphertext: deps.secrets.seal(input.apiKey, id),
          },
        });
      }
    });
    return state(actor, input.botId);
  }
  async function attach(actor: Caller, botId: string, enabled: boolean) {
    await ownedBot(actor, botId);
    const library = await libraryFor(actor);
    await prisma.$transaction(async (tx) => {
      await lockLibrary(tx, library.id);
      await handOffCustomers(tx, library.id, botId);
      await tx.bot.update({
        where: { id: botId },
        data: { knowledgeLibraryId: enabled ? library.id : null },
      });
      if (enabled)
        await tx.customerBehavior.updateMany({
          where: { botId },
          data: { knowledgeFilterId: null, knowledge: Prisma.DbNull, revision: { increment: 1 } },
        });
    });
    return state(actor, botId);
  }
  async function upload(actor: Caller, raw: unknown) {
    const input = KnowledgeUploadInput.parse(raw);
    await ownedBot(actor, input.botId);
    const library = await libraryFor(actor, true);
    const bytes = decodeAttachmentBase64(input.contentBase64);
    const stored = await deps.artifacts.put(
      { name: input.name, mimeType: input.mimeType, bytes },
      storageContext(library),
    );
    const id = randomUUID();
    try {
      await prisma.$transaction(async (tx) => {
        await lockLibrary(tx, library.id);
        const source = input.sourceId
          ? await findSource(tx, library.id, input.sourceId)
          : await tx.knowledgeSource.create({ data: { libraryId: library.id, name: input.name } });
        await tx.knowledgeRevision.create({
          data: {
            id,
            sourceId: source.id,
            name: input.name,
            storageKey: stored.id,
            mimeType: input.mimeType,
            providerDocumentKey: `k_${id}.${extension(input.mimeType)}`,
          },
        });
        await tx.knowledgeSource.update({
          where: { id: source.id },
          data: { pendingRevisionId: id },
        });
      });
    } catch (error) {
      await deps.artifacts.remove(stored.id, storageContext(library));
      throw error;
    }
    // The durable queued row is also picked up by reconciliation if publishing fails.
    await enqueue(id).catch(() => undefined);
    return state(actor, input.botId);
  }
  async function updateSource(
    actor: Caller,
    botId: string,
    sourceId: string,
    data: Prisma.KnowledgeSourceUpdateInput,
    restricts: boolean,
  ) {
    await ownedBot(actor, botId);
    const library = await libraryFor(actor, true);
    await prisma.$transaction(async (tx) => {
      await lockLibrary(tx, library.id);
      const source = await findSource(tx, library.id, sourceId);
      // Only taking a shared source away from customers invalidates their conversations.
      if (restricts && !source.internal) await handOffCustomers(tx, library.id);
      await tx.knowledgeSource.update({ where: { id: source.id }, data });
    });
  }
  async function setInternal(actor: Caller, botId: string, sourceId: string, internal: boolean) {
    await updateSource(actor, botId, sourceId, { internal }, internal);
    return state(actor, botId);
  }
  async function remove(actor: Caller, botId: string, sourceId: string) {
    await updateSource(
      actor,
      botId,
      sourceId,
      { deletedAt: new Date(), activeRevisionId: null, pendingRevisionId: null },
      true,
    );
    const revisions = await prisma.knowledgeRevision.findMany({
      where: { sourceId },
      select: { id: true },
    });
    // Reconciliation picks up whatever a failed publication leaves behind.
    await Promise.all(revisions.map((r) => enqueue(r.id))).catch(() => undefined);
    return state(actor, botId);
  }
  async function search(
    actor: Caller,
    botId: string,
    audience: "staff" | "customer",
    query: string,
    signal: AbortSignal,
  ) {
    const input = KnowledgeSearchInput.parse({ query });
    const agent = await ownedBot(actor, botId);
    if (!agent.knowledgeLibraryId) throw new Error("No knowledge library is attached");
    const library = await libraryFor(actor);
    if (library.id !== agent.knowledgeLibraryId) throw new IsolationError();
    const sourceWhere = {
      libraryId: library.id,
      deletedAt: null,
      ...(audience === "customer" ? { internal: false } : {}),
    };
    const sources = await prisma.knowledgeSource.findMany({ where: sourceWhere });
    const revisions = await prisma.knowledgeRevision.findMany({
      where: {
        id: { in: sources.flatMap((s) => (s.activeRevisionId ? [s.activeRevisionId] : [])) },
        status: "ready",
      },
    });
    if (!revisions.length) return [];
    const hits = await provider(library).search(
      input.query,
      revisions.map((r) => r.providerDocumentKey),
      signal,
    );
    await ownedBot(actor, botId).then((current) => {
      if (current.knowledgeLibraryId !== library.id) throw new IsolationError();
    });
    const current = await prisma.knowledgeSource.findMany({ where: sourceWhere });
    return hits.map((hit) => {
      const revision = revisions.find((r) => r.providerDocumentKey === hit.key);
      const source =
        revision &&
        current.find((s) => s.id === revision.sourceId && s.activeRevisionId === revision.id);
      if (!source || !revision) throw new Error("Knowledge access changed; search again");
      return {
        sourceId: source.id,
        revisionId: revision.id,
        title: source.name,
        text: hit.text,
        ...(hit.page ? { page: hit.page } : {}),
      };
    });
  }
  async function download(actor: Caller, botId: string, sourceId: string) {
    await ownedBot(actor, botId);
    const library = await libraryFor(actor);
    const source = await findSource(prisma, library.id, sourceId);
    const id = source.activeRevisionId ?? source.pendingRevisionId;
    if (!id) throw new IsolationError();
    const revision = await prisma.knowledgeRevision.findFirst({ where: { id, sourceId } });
    if (!revision) throw new IsolationError();
    const bytes = await deps.artifacts.get(revision.storageKey, storageContext(library));
    return {
      name: revision.name,
      mimeType: revision.mimeType,
      contentBase64: Buffer.from(bytes).toString("base64"),
    };
  }
  async function process(revisionId: string) {
    const claimId = randomUUID();
    const claimed = await prisma.knowledgeRevision.updateMany({
      where: {
        id: revisionId,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        cleanupAttempts: { lt: maxCleanupAttempts },
        AND: [{ OR: [{ cleanupAfter: null }, { cleanupAfter: { lte: new Date() } }] }],
      },
      data: { claimId, leaseUntil: new Date(Date.now() + 90_000) },
    });
    if (!claimed.count) return;
    const revision = await prisma.knowledgeRevision.findUniqueOrThrow({
      where: { id: revisionId },
      include: { source: { include: { library: true } } },
    });
    const { source } = revision;
    const library = source.library;
    const signal = AbortSignal.timeout(60_000);
    const fence = { id: revision.id, claimId };
    try {
      const service = provider(library);
      // Deleting a source clears both pointers, so this also covers deleted sources.
      if (revision.id !== source.activeRevisionId && revision.id !== source.pendingRevisionId) {
        const attempts = revision.cleanupAttempts + 1;
        await prisma.knowledgeRevision.updateMany({
          where: fence,
          data: {
            cleanupAttempts: attempts,
            cleanupAfter: new Date(
              Date.now() + Math.min(15 * 60_000 * 2 ** (attempts - 1), 86_400_000),
            ),
            error:
              attempts >= maxCleanupAttempts
                ? "Cleanup paused. Inspect the upstream task and remove this revision manually."
                : revision.error,
          },
        });
        // An uncertain submission can finish after deletion. Retain its cleanup tombstone.
        const uncertain = Boolean(revision.submittedAt) && !revision.providerTaskId;
        if (
          revision.providerTaskId &&
          revision.status !== "ready" &&
          revision.status !== "failed" &&
          (await service.status(revision.providerTaskId, revision.providerDocumentKey, signal)) ===
            "processing"
        )
          return;
        await service.remove(revision.providerDocumentKey, signal);
        await deps.artifacts.remove(revision.storageKey, storageContext(library));
        if (!uncertain) await prisma.knowledgeRevision.deleteMany({ where: fence });
        return;
      }
      if (revision.status === "ready" || revision.status === "failed") return;
      if (!revision.providerTaskId) {
        if (revision.submittedAt) {
          // Submissions carry no idempotency key. Never repeat an uncertain upload.
          await prisma.knowledgeRevision.updateMany({
            where: fence,
            data: {
              status: "failed",
              error: "Upload outcome is unknown. Replace the document to retry.",
            },
          });
          return;
        }
        // Read first: a local failure leaves the revision queued for the next pass.
        const bytes = await deps.artifacts.get(revision.storageKey, storageContext(library));
        await prisma.knowledgeRevision.updateMany({
          where: fence,
          data: { status: "processing", submittedAt: new Date() },
        });
        try {
          const providerTaskId = await service.ingest({
            key: revision.providerDocumentKey,
            mimeType: revision.mimeType,
            bytes,
            signal,
          });
          await prisma.knowledgeRevision.updateMany({ where: fence, data: { providerTaskId } });
        } catch (error) {
          if (!(error instanceof KnowledgeRejectedError)) throw error;
          await prisma.knowledgeRevision.updateMany({
            where: fence,
            data: {
              status: "failed",
              submittedAt: null,
              error: "The knowledge service rejected this document. Replace it to retry.",
            },
          });
        }
        return;
      }
      const status = await service.status(
        revision.providerTaskId,
        revision.providerDocumentKey,
        signal,
      );
      if (status === "processing") return;
      await prisma.$transaction(async (tx) => {
        await lockLibrary(tx, library.id);
        const updated = await tx.knowledgeRevision.updateMany({
          where: fence,
          data: {
            status,
            error: status === "failed" ? "Document processing failed. Replace it to retry." : null,
          },
        });
        if (!updated.count || status !== "ready") return;
        const current = await tx.knowledgeSource.findFirst({
          where: { id: source.id, deletedAt: null, pendingRevisionId: revision.id },
        });
        if (!current) return;
        if (!current.internal && current.activeRevisionId) await handOffCustomers(tx, library.id);
        await tx.knowledgeSource.updateMany({
          where: { id: source.id, deletedAt: null, pendingRevisionId: revision.id },
          data: { activeRevisionId: revision.id, pendingRevisionId: null, name: revision.name },
        });
      });
    } finally {
      await prisma.knowledgeRevision.updateMany({
        where: fence,
        data: { claimId: null, leaseUntil: null },
      });
    }
  }
  async function reconcile() {
    // Unfinished revisions, plus every revision its source no longer points at.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT r.id FROM knowledge_revisions r
      JOIN knowledge_sources s ON s.id = r."sourceId"
      WHERE r."cleanupAttempts" < ${maxCleanupAttempts}
        AND (r.status IN ('queued', 'processing')
          OR (r.id IS DISTINCT FROM s."activeRevisionId"
            AND r.id IS DISTINCT FROM s."pendingRevisionId"))
        AND (r."leaseUntil" IS NULL OR r."leaseUntil" < now() AT TIME ZONE 'UTC')
        AND (r."cleanupAfter" IS NULL OR r."cleanupAfter" <= now() AT TIME ZONE 'UTC')
      ORDER BY r."updatedAt" ASC
      LIMIT 100`;
    await Promise.all(rows.map((r) => enqueue(r.id)));
  }
  /** Space deletion cascades these rows, so files and index entries go first. Repeatable. */
  async function purge(spaceId: string) {
    const library = await prisma.knowledgeLibrary.findUnique({ where: { spaceId } });
    if (!library) return;
    const revisions = await prisma.knowledgeRevision.findMany({
      where: { source: { libraryId: library.id } },
    });
    // An upload still indexing upstream would outlive its removal.
    if (revisions.some((r) => r.status === "processing"))
      throw new Error("Documents are still processing; try again shortly");
    // A partial purge leaves deleted sources that normal cleanup finishes.
    await prisma.knowledgeSource.updateMany({
      where: { libraryId: library.id },
      data: { deletedAt: new Date(), activeRevisionId: null, pendingRevisionId: null },
    });
    const service = provider(library);
    for (const revision of revisions) {
      await service.remove(revision.providerDocumentKey, AbortSignal.timeout(60_000));
      await deps.artifacts.remove(revision.storageKey, storageContext(library));
    }
  }
  return {
    state,
    configure,
    attach,
    upload,
    setInternal,
    remove,
    download,
    search,
    process,
    reconcile,
    purge,
  };
}
