import type { Prisma, PrismaClient } from "./client.js";
import { customerChannelAccessWhere } from "./customers.js";
import { connectionAccessWhere, IsolationError } from "./scope.js";

export type AccountExportRecord = { type: string; data: unknown };
export type AccountExportFile = {
  id: string;
  spaceId: string;
  userId: string;
  storageKey: string;
  hash?: string;
  size?: number;
};

export class AccountExportLimitError extends Error {}

function columns<K extends string>(...names: K[]): { [P in K]: true } {
  return Object.fromEntries(names.map((name) => [name, true])) as { [P in K]: true };
}

/** Export user-authored request content, not arbitrary legacy provider configuration. */
function cloudRequest(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
    ...(typeof value.repository === "string" ? { repository: value.repository } : {}),
    ...(typeof value.openPr === "boolean" ? { openPr: value.openPr } : {}),
    ...(Array.isArray(value.images)
      ? {
          images: value.images.flatMap((image) => {
            if (!image || typeof image !== "object" || Array.isArray(image)) return [];
            return [
              {
                ...(typeof image.url === "string" ? { url: image.url } : {}),
                ...(typeof image.data === "string" ? { data: image.data } : {}),
                ...(typeof image.mimeType === "string" ? { mimeType: image.mimeType } : {}),
              },
            ];
          }),
        }
      : {}),
  };
}

/** Explicit selections are intentional: adding a credential column must never export it. */
export async function writeAccountExport(
  prisma: PrismaClient,
  userId: string,
  write: (record: AccountExportRecord) => Promise<void>,
  readFile: (file: AccountExportFile) => Promise<string>,
  signal: AbortSignal,
) {
  const counts: Record<string, number> = {};
  let recordCount = 0;
  async function emit(type: string, data: unknown) {
    signal.throwIfAborted();
    if (++recordCount > 100_000) throw new AccountExportLimitError();
    await write({ type, data });
    counts[type] = (counts[type] ?? 0) + 1;
  }
  async function rows<T extends { id: string }>(
    type: string,
    fetch: (after: string | undefined) => Promise<T[]>,
    map: (row: T) => unknown | Promise<unknown> = (row) => row,
    pageSize = 100,
  ) {
    let after: string | undefined;
    while (true) {
      signal.throwIfAborted();
      const page = await fetch(after);
      for (const row of page) await emit(type, await map(row));
      if (page.length < pageSize) return;
      after = page.at(-1)!.id;
    }
  }
  // Keyset pages keep working memory bounded; one snapshot keeps related records consistent.
  const page = (after?: string) => ({
    take: 100,
    orderBy: { id: "asc" as const },
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
  await prisma.$transaction(
    async (db) => {
      const user = await db.user.findFirst({
        where: { id: userId, deletion: null },
        select: columns(
          "id",
          "name",
          "email",
          "emailVerified",
          "image",
          "avatarStyle",
          "createdAt",
          "updatedAt",
        ),
      });
      if (!user) throw new IsolationError();
      await emit("manifest", {
        format: "deskazo-account-export",
        version: 1,
        createdAt: new Date().toISOString(),
        encoding: "UTF-8 JSON Lines; each line has type and data; file contentBase64 is base64",
        scope:
          "Account profile, preferences, conversations, cloud-agent work, skills, learning, memory, files and accessible customer records in current spaces",
        limits: { records: 100_000, bytes: 104_857_600 },
        excluded: [
          "Credential stores, passwords, sessions and known authentication fields; secrets written into your own content are not redacted",
          "Other users' private records",
          "Runtime logs, execution internals, connector configuration, browser profiles and computer disks",
          "Data held only by external providers",
          "Superseded or removed knowledge originals",
        ],
      });
      await emit("account", user);
      await rows("modelConnection", (after) =>
        db.userModelCredential.findMany({
          ...page(after),
          where: { userId },
          select: columns("id", "provider", "label", "supportsImages", "createdAt"),
        }),
      );
      await rows("voiceConnection", (after) =>
        db.userVoiceCredential.findMany({
          ...page(after),
          where: { userId },
          select: columns("id", "provider", "createdAt"),
        }),
      );
      await rows(
        "membership",
        (after) =>
          db.spaceMember.findMany({
            ...page(after),
            where: { userId, space: { deletingAt: null } },
            select: {
              id: true,
              spaceId: true,
              role: true,
              createdAt: true,
              space: { select: columns("id", "organizationId", "name") },
            },
          }),
        async (membership) => {
          await space(membership.spaceId, db);
          return membership;
        },
      );
    },
    { isolationLevel: "RepeatableRead", timeout: 120_000 },
  );
  await emit("complete", { counts: { ...counts } });

  async function space(spaceId: string, db: Prisma.TransactionClient) {
    const actor = { userId, spaceId };
    const channel = customerChannelAccessWhere(actor);
    const conversation = { channel };
    const document: Prisma.LearningDocumentWhereInput = {
      spaceId,
      OR: [{ scopeKey: "space" }, { bot: { userId, spaceId } }],
    };
    const task: Prisma.LearningTaskWhereInput = {
      ...actor,
      OR: [{ conversation }, { import: { ...actor, bot: actor } }],
    };
    await rows("aiDataConsent", async (after) =>
      (
        await db.aiDataConsent.findMany({
          take: 100,
          orderBy: { recipientKey: "asc" },
          where: { ...actor, ...(after ? { recipientKey: { gt: after } } : {}) },
          select: { spaceId: true, recipientKey: true, version: true, grantedAt: true },
        })
      ).map((record) => ({ id: record.recipientKey, ...record })),
    );
    await rows("messagingIdentity", (after) =>
      db.messagingIdentity.findMany({
        ...page(after),
        where: actor,
        select: { id: true, spaceId: true, provider: true, address: true, createdAt: true },
      }),
    );
    await rows("bot", (after) =>
      db.bot.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "name",
          "title",
          "description",
          "instructions",
          "color",
          "pinned",
          "sectionId",
          "archivedAt",
          "parentBotId",
          "learningEnabled",
          "modelProvider",
          "modelId",
          "thinkingLevel",
          "voiceId",
          "autoSpeak",
          "teamChatRules",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows(
      "cloudAgent",
      (after) =>
        db.cloudAgent.findMany({
          ...page(after),
          // A request can contain several large image payloads.
          take: 1,
          where: actor,
          select: columns(
            "id",
            "spaceId",
            "botId",
            "threadId",
            "messageId",
            "remoteId",
            "latestRunId",
            "title",
            "status",
            "url",
            "branch",
            "prUrl",
            "launchRequest",
            "followup",
            "cancelRequested",
            "generation",
            "createdAt",
          ),
        }),
      (record) => ({
        ...record,
        launchRequest: cloudRequest(record.launchRequest),
        followup: cloudRequest(record.followup),
      }),
      1,
    );
    await rows("botSection", (after) =>
      db.botSection.findMany({
        ...page(after),
        where: actor,
        select: columns("id", "spaceId", "name", "position", "createdAt"),
      }),
    );
    await rows("group", (after) =>
      db.chatGroup.findMany({
        ...page(after),
        where: actor,
        select: columns("id", "spaceId", "name", "pinned", "archivedAt", "sectionId", "createdAt"),
      }),
    );
    await rows("groupMember", (after) =>
      db.chatGroupMember.findMany({
        ...page(after),
        where: { group: actor },
        select: columns("id", "groupId", "botId", "createdAt"),
      }),
    );
    await rows("thread", (after) =>
      db.thread.findMany({
        ...page(after),
        where: actor,
        select: columns("id", "spaceId", "botId", "groupId", "externalConversationId", "createdAt"),
      }),
    );
    await rows("externalConversation", (after) =>
      db.externalConversation.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "provider",
          "displayName",
          "participantNames",
          "teamChatRules",
          "createdAt",
        ),
      }),
    );
    await rows("externalMessage", (after) =>
      db.externalMessage.findMany({
        ...page(after),
        where: { externalConversation: actor },
        select: columns(
          "id",
          "externalConversationId",
          "senderName",
          "senderIsBot",
          "content",
          "kind",
          "status",
          "deliveredAt",
          "createdAt",
        ),
      }),
    );
    await rows("message", (after) =>
      db.message.findMany({
        ...page(after),
        where: { thread: actor },
        select: columns(
          "id",
          "threadId",
          "seq",
          "role",
          "blocks",
          "botId",
          "replyToMessageId",
          "createdAt",
        ),
      }),
    );
    await rows("task", (after) =>
      db.task.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "threadId",
          "prompt",
          "status",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("run", (after) =>
      db.run.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "taskId",
          "botId",
          "threadId",
          "status",
          "trigger",
          "modelProvider",
          "modelId",
          "startedAt",
          "completedAt",
          "createdAt",
        ),
      }),
    );
    await rows("routine", (after) =>
      db.routine.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "name",
          "prompt",
          "crons",
          "timezone",
          "active",
          "notify",
          "webhookEnabled",
          "githubEnabled",
          "messageProvider",
          "createdAt",
        ),
      }),
    );
    await rows("scratchpad", (after) =>
      db.scratchpadItem.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "title",
          "status",
          "notes",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("taughtSkill", (after) =>
      db.taughtSkill.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "name",
          "goal",
          "status",
          "playbook",
          "recording",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("skill", (after) =>
      db.agentSkill.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "name",
          "description",
          "content",
          "source",
          "revision",
          "removedAt",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("skillRevision", (after) =>
      db.agentSkillRevision.findMany({
        ...page(after),
        where: { skill: actor },
        select: columns(
          "id",
          "skillId",
          "revision",
          "content",
          "removed",
          "operation",
          "reason",
          "actorKind",
          "agentId",
          "sourceRunId",
          "sourceThreadId",
          "learningTaskId",
          "restoredFrom",
          "undoneRevision",
          "createdAt",
        ),
      }),
    );
    await rows("memory", (after) =>
      db.memoryDocument.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "scope",
          "path",
          "content",
          "revision",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("semanticMemoryMutation", (after) =>
      db.semanticMemoryMutation.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "sourceRunId",
          "sourceThreadId",
          "operation",
          "reversesId",
          "provider",
          "configurationRevision",
          "scope",
          "status",
          "request",
          "result",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("memoryRevision", (after) =>
      db.memoryRevision.findMany({
        ...page(after),
        where: { document: actor },
        select: columns(
          "id",
          "documentId",
          "revision",
          "content",
          "actorKind",
          "reason",
          "agentId",
          "restoredFrom",
          "undoneRevision",
          "sourceRunId",
          "sourceThreadId",
          "learningTaskId",
          "createdAt",
        ),
      }),
    );
    await rows("connection", (after) =>
      db.connection.findMany({
        ...page(after),
        where: connectionAccessWhere(actor),
        select: columns(
          "id",
          "spaceId",
          "scope",
          "connectorId",
          "provider",
          "displayName",
          "status",
          "actionPolicy",
          "createdAt",
        ),
      }),
    );
    await rows("notificationPreference", (after) =>
      db.notificationPreference.findMany({
        ...page(after),
        where: actor,
        select: columns("id", "spaceId", "finish", "help", "takeover", "customerQuietHours"),
      }),
    );
    await rows("customerAlertDestination", (after) =>
      db.customerAlertDestination.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "connectionId",
          "recipientId",
          "kind",
          "status",
          "verifiedAt",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("approvalRule", (after) =>
      db.actionApprovalRule.findMany({
        ...page(after),
        where: { spaceId, createdByUserId: userId },
        select: columns("id", "spaceId", "effect", "matchKind", "matchValue", "createdAt"),
      }),
    );
    await rows("autoReviewPreference", (after) =>
      db.actionAutoReviewPreference.findMany({
        ...page(after),
        where: actor,
        select: columns("id", "spaceId", "enabled"),
      }),
    );
    await rows("modelPreference", (after) =>
      db.spaceModelPreference.findMany({
        ...page(after),
        where: actor,
        select: columns("id", "spaceId", "credentialId", "modelId", "isDefault"),
      }),
    );
    await rows("voicePreference", (after) =>
      db.spaceVoicePreference.findMany({
        ...page(after),
        where: actor,
        select: columns("id", "spaceId", "credentialId", "voiceId", "isDefault"),
      }),
    );
    await rows("usage", (after) =>
      db.usageRecord.findMany({
        ...page(after),
        where: actor,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "runId",
          "provider",
          "model",
          "inputTokens",
          "outputTokens",
          "createdAt",
        ),
      }),
    );
    await rows(
      "file",
      (after) =>
        db.artifact.findMany({
          ...page(after),
          where: actor,
          select: columns(
            "id",
            "spaceId",
            "userId",
            "botId",
            "groupId",
            "name",
            "mimeType",
            "size",
            "hash",
            "storageKey",
            "createdAt",
          ),
        }),
      async ({ storageKey, ...file }) => ({
        ...file,
        contentBase64: await readFile({ ...file, storageKey }),
      }),
    );
    await rows("learningDocument", (after) =>
      db.learningDocument.findMany({
        ...page(after),
        where: document,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "scopeKey",
          "kind",
          "key",
          "title",
          "content",
          "customerVisible",
          "revision",
          "updatedAt",
        ),
      }),
    );
    await rows("learningRevision", (after) =>
      db.learningRevision.findMany({
        ...page(after),
        where: { document },
        select: columns(
          "id",
          "documentId",
          "revision",
          "title",
          "content",
          "customerVisible",
          "userId",
          "reason",
          "source",
          "restoredFrom",
          "createdAt",
        ),
      }),
    );
    await rows("learningFeed", (after) =>
      db.learningFeed.findMany({
        ...page(after),
        where: { ...actor, bot: actor },
        select: columns(
          "id",
          "spaceId",
          "botId",
          "connectionId",
          "label",
          "scope",
          "enabled",
          "includeReplies",
          "includeMessages",
          "coverage",
          "revision",
          "windowStart",
          "windowEnd",
          "lastCheckedAt",
          "completedAt",
          "accepted",
          "skipped",
          "duplicates",
          "error",
          "createdAt",
        ),
      }),
    );
    await rows("learningImport", (after) =>
      db.learningImport.findMany({
        ...page(after),
        where: { ...actor, bot: actor },
        select: columns(
          "id",
          "spaceId",
          "botId",
          "label",
          "format",
          "content",
          "coverage",
          "mapping",
          "timezoneOffset",
          "feedId",
          "feedRevision",
          "windowEnd",
          "withdrawnAt",
          "createdAt",
        ),
      }),
    );
    await rows("learningHistory", (after) =>
      db.learningHistory.findMany({
        ...page(after),
        where: { import: { ...actor, bot: actor } },
        select: columns(
          "id",
          "importId",
          "scope",
          "exportKey",
          "connectionId",
          "status",
          "accepted",
          "skipped",
          "duplicates",
          "earliest",
          "latest",
          "errors",
          "error",
          "completedAt",
          "createdAt",
        ),
      }),
    );
    await rows("learningTask", (after) =>
      db.learningTask.findMany({
        ...page(after),
        where: task,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "conversationId",
          "importId",
          "evidence",
          "status",
          "proposal",
          "rejectedAt",
          "documentId",
          "appliedRevision",
          "targetKind",
          "reviewedByUserId",
          "reviewReason",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("learningTaskReview", (after) =>
      db.learningTaskReview.findMany({
        ...page(after),
        where: { task },
        select: columns("id", "taskId", "userId", "decision", "reason", "createdAt"),
      }),
    );
    await rows("customerChannel", (after) =>
      db.customerChannel.findMany({
        ...page(after),
        where: channel,
        select: columns(
          "id",
          "spaceId",
          "botId",
          "provider",
          "name",
          "instructions",
          "enabled",
          "shared",
          "autoReplies",
          "websiteOrigins",
          "retentionDays",
          "createdAt",
        ),
      }),
    );
    await rows("customerConversation", (after) =>
      db.customerConversation.findMany({
        ...page(after),
        where: conversation,
        select: columns(
          "id",
          "channelId",
          "customerId",
          "name",
          "owner",
          "needsHuman",
          "state",
          "assigneeId",
          "handoffReason",
          "draftText",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("customerMessage", (after) =>
      db.customerMessage.findMany({
        ...page(after),
        where: { conversation },
        select: columns(
          "id",
          "conversationId",
          "seq",
          "role",
          "body",
          "mediaUrl",
          "status",
          "inReplyToSeq",
          "sentAt",
          "createdAt",
        ),
      }),
    );
    await rows("customerBehavior", async (after) =>
      (
        await db.customerBehavior.findMany({
          take: 100,
          orderBy: { botId: "asc" },
          where: { bot: actor, ...(after ? { botId: { gt: after } } : {}) },
          select: {
            botId: true,
            instructions: true,
            actions: true,
            modelId: true,
            revision: true,
            updatedAt: true,
          },
        })
      ).map((record) => ({ id: record.botId, ...record })),
    );
    await rows("customerAction", async (after) => {
      const [messageId, callId] = after ? (JSON.parse(after) as [string, string]) : [];
      return (
        await db.customerToolCall.findMany({
          take: 100,
          orderBy: [{ messageId: "asc" }, { callId: "asc" }],
          where: { message: { conversation } },
          ...(messageId && callId
            ? { cursor: { messageId_callId: { messageId, callId } }, skip: 1 }
            : {}),
          select: {
            messageId: true,
            callId: true,
            name: true,
            status: true,
            result: true,
            createdAt: true,
          },
        })
      ).map((record) => ({ id: JSON.stringify([record.messageId, record.callId]), ...record }));
    });
    await rows("customerGuidance", (after) =>
      db.customerGuidance.findMany({
        ...page(after),
        where: { conversation },
        select: columns("id", "conversationId", "userId", "content", "createdAt"),
      }),
    );
    await rows("customerAcknowledgement", (after) =>
      db.customerAcknowledgement.findMany({
        ...page(after),
        where: { conversation },
        select: columns("id", "conversationId", "userId", "generation", "customerSeq", "createdAt"),
      }),
    );
    await rows("customerRead", async (after) =>
      (
        await db.customerConversationRead.findMany({
          take: 100,
          orderBy: { conversationId: "asc" },
          where: { userId, conversation, ...(after ? { conversationId: { gt: after } } : {}) },
          select: { conversationId: true, seq: true },
        })
      ).map((record) => ({ id: record.conversationId, ...record })),
    );
    await rows("customerAlert", (after) =>
      db.customerAlertDelivery.findMany({
        ...page(after),
        where: { conversation },
        select: {
          id: true,
          conversationId: true,
          attentionId: true,
          stage: true,
          recipientId: true,
          provider: true,
          status: true,
          attempts: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    await rows("customerPurchase", (after) =>
      db.customerPurchase.findMany({
        ...page(after),
        where: { conversation, connection: connectionAccessWhere(actor) },
        select: columns(
          "id",
          "conversationId",
          "customerId",
          "connectionId",
          "paymentMethods",
          "status",
          "revision",
          "summary",
          "history",
          "actionKind",
          "actionStartedAt",
          "createdAt",
          "updatedAt",
        ),
      }),
    );
    await rows("customerIdentity", (after) =>
      db.customerIdentity.findMany({
        ...page(after),
        where: { conversation, connection: connectionAccessWhere(actor) },
        select: columns(
          "id",
          "conversationId",
          "customerId",
          "connectionId",
          "value",
          "revision",
          "history",
          "updatedAt",
        ),
      }),
    );
    await rows("customerOperationReceipt", async (after) =>
      (
        await db.customerOperationReceipt.findMany({
          take: 100,
          orderBy: { operationId: "asc" },
          where: { conversation, ...(after ? { operationId: { gt: after } } : {}) },
          select: {
            ...columns(
              "operationId",
              "conversationId",
              "connectionId",
              "action",
              "recordKey",
              "mapping",
              "result",
              "reviewedByUserId",
              "reviewedAt",
              "reviewReason",
              "providerReference",
              "reviewHistory",
              "createdAt",
            ),
            operation: { select: columns("status", "attempt", "createdAt", "updatedAt") },
          },
        })
      ).map((receipt) => ({ id: receipt.operationId, ...receipt })),
    );
    // Match the knowledge download's membership and owned-bot access. Only live
    // source revisions have originals; superseded revisions may already be erased.
    const source = {
      library: {
        spaceId,
        OR: [{ userId }, { space: { bots: { some: { userId, archivedAt: null } } } }],
      },
      deletedAt: null,
    };
    await rows(
      "knowledgeSource",
      (after) =>
        db.knowledgeSource.findMany({
          ...page(after),
          where: source,
          select: {
            id: true,
            name: true,
            internal: true,
            activeRevisionId: true,
            pendingRevisionId: true,
            createdAt: true,
            library: { select: columns("userId") },
          },
        }),
      async ({ library, ...record }) => {
        const ids = [record.activeRevisionId, record.pendingRevisionId].filter((id): id is string =>
          Boolean(id),
        );
        const files = await db.knowledgeRevision.findMany({
          where: { sourceId: record.id, id: { in: ids } },
          select: columns(
            "id",
            "sourceId",
            "name",
            "storageKey",
            "mimeType",
            "status",
            "createdAt",
          ),
        });
        if (files.length !== new Set(ids).size) throw new Error("Knowledge original is missing");
        for (const { storageKey, ...file } of files)
          await emit("knowledgeFile", {
            ...file,
            contentBase64: await readFile({
              id: file.id,
              spaceId,
              userId: library.userId,
              storageKey,
            }),
          });
        return record;
      },
    );
  }
}
