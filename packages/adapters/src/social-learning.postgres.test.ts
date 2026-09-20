import { randomUUID } from "node:crypto";
import type {
  AgentRunRequest,
  AgentRuntime,
  ConnectorCall,
  JobPublisher,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import type { AccountExportRecord } from "@rakazo/db";
import {
  createDb,
  createLearning,
  provisionMessagingIdentity,
  publishLearningSummaries,
  writeAccountExport,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { processContinuedLearning } from "./continued-learning.js";
import { createCustomerConnector } from "./customer-connector.js";
import { createCustomerConversations } from "./customer-conversations.js";
import { instagramAccountHash, instagramBindingHash } from "./instagram-comment-writes.js";
import { instagramLearning } from "./instagram-learning.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { EncryptedSecretStore } from "./secrets.js";
import { createSocialLearning } from "./social-learning.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("social learning with PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let connectionId: string;
  let service: ReturnType<typeof createSocialLearning>;
  let integrations: IntegrationProviderSettings;
  let pages: Record<
    string,
    {
      media: Array<{ id: string; caption?: string; timestamp?: string }>;
      paging: { hasNextPage: boolean; after?: string };
    }
  >;
  let commentPages: Record<
    string,
    {
      comments: Array<{ id: string; text?: string; timestamp?: string; userId?: string }>;
      paging: { hasNextPage: boolean; after?: string };
    }
  >;
  let replyCapability: boolean;
  let messageCapability: boolean;
  let messagePages: Record<string, unknown>;
  let unreadableMessages: Set<string>;
  let identity: string;
  let beforePage: () => Promise<void>;
  let beforeModel: () => Promise<void>;
  let inference: Record<string, unknown>;
  let readOnly: boolean;
  const calls = vi.fn();
  const modelCalls = vi.fn();
  const actor = () => ({ userId: owner.userId, spaceId: owner.spaceId });
  const runtime = {
    async *run(request: AgentRunRequest) {
      modelCalls(request);
      await beforeModel();
      yield { type: "done" as const, text: JSON.stringify(inference) };
    },
  } satisfies Pick<AgentRuntime, "run">;
  const processTask = (id: string) =>
    processContinuedLearning(
      {
        prisma: db.prisma,
        runtime,
        resolveModel: async () => ({ provider: "test", id: "test" }),
      },
      id,
    );
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
    const connection = await db.prisma.connection.create({
      data: {
        ...actor(),
        provider: "instagram",
        connectorId: "open-connector",
        providerRef: "PRIVATE_BINDING_SENTINEL",
        displayName: "Synthetic business",
        status: "connected",
      },
    });
    connectionId = connection.id;
    identity = "owned-account";
    commentPages = {};
    replyCapability = true;
    messageCapability = true;
    messagePages = {};
    unreadableMessages = new Set();
    readOnly = true;
    beforePage = async () => {};
    beforeModel = async () => {};
    inference = {
      reusable: true,
      supported: true,
      publicSafe: true,
      changesBusinessRules: false,
      kind: "voice",
      scope: "space",
      title: "Brand voice",
      content: "Use short sentences.",
      conditions: "Business introductions",
      reason: "Owned post examples",
    };
    pages = {
      first: {
        media: [
          {
            id: "post-1",
            caption: "Hello from our studio.",
            timestamp: new Date(Date.now() - 86400000).toISOString(),
          },
        ],
        paging: { hasNextPage: false },
      },
    };
    calls.mockClear();
    modelCalls.mockClear();
    const provider = {
      listActions: async () =>
        [
          "instagram.get_current_user",
          "instagram.list_media",
          ...(messageCapability
            ? [
                "instagram.list_conversations",
                "instagram.list_conversation_messages",
                "instagram.get_message",
              ]
            : []),
          ...(replyCapability
            ? ["instagram.list_media_comments", "instagram.list_comment_replies"]
            : []),
        ].map((name) => ({
          name,
          readOnly,
          description: "Synthetic read",
          inputSchema: {},
        })),
      resolveCall: async (call: ConnectorCall) => ({
        call,
        tool: { name: call.tool, readOnly, description: "Synthetic read", inputSchema: {} },
      }),
      async *execute(call: ConnectorCall) {
        calls(call);
        if (call.expectedAccountId !== undefined && call.expectedAccountId !== identity) {
          yield { type: "error", message: "Provider account changed", dispatch: "not_started" };
          return;
        }
        if (call.tool === "instagram.get_current_user")
          yield {
            type: "result",
            data: { user: { id: identity, userId: identity, username: "synthetic" } },
          };
        else {
          if (
            call.tool === "instagram.get_message" &&
            unreadableMessages.has(String(call.args.messageId))
          ) {
            yield { type: "error", message: "PRIVATE_PROVIDER_ERROR", dispatch: "not_started" };
            return;
          }
          const page =
            call.tool === "instagram.list_media"
              ? pages[String(call.args.after ?? "first")]
              : call.tool === "instagram.list_conversations" ||
                  call.tool === "instagram.list_conversation_messages" ||
                  call.tool === "instagram.get_message"
                ? messagePages[
                    `${call.tool}:${call.args.conversationId ?? call.args.messageId ?? "all"}:${call.args.after ?? "first"}`
                  ]
                : commentPages[
                    `${call.tool}:${call.args.mediaId ?? call.args.commentId}:${call.args.after ?? "first"}`
                  ];
          await beforePage();
          yield { type: "result", data: page };
        }
      },
    } as unknown as ManagedConnectorProvider;
    integrations = { resolve: async () => provider } as unknown as IntegrationProviderSettings;
    const connector = createCustomerConnector({ prisma: db.prisma, integrations });
    service = createSocialLearning({
      prisma: db.prisma,
      connector,
      provider: (_name, execute, includeReplies, messages) =>
        instagramLearning(execute, includeReplies, messages),
    });
  });
  afterEach(async () => {
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });
  const configure = (
    expectedRevision = 0,
    scope = "bot",
    enabled = true,
    includeReplies = false,
    includeMessages = false,
  ) =>
    service.configure(actor(), owner.botId, {
      connectionId,
      expectedRevision,
      scope,
      enabled,
      includeReplies,
      includeMessages,
    });
  const task = () => db.prisma.learningTask.findFirstOrThrow({ where: { botId: owner.botId } });
  const feedRow = (id: string) => db.prisma.learningFeed.findUniqueOrThrow({ where: { id } });

  function messageFixture() {
    pages.first = { media: [], paging: { hasNextPage: false } };
    messagePages["instagram.list_conversations:all:first"] = {
      conversations: [{ id: "dm-thread" }],
      paging: { hasNextPage: false },
    };
    messagePages["instagram.list_conversation_messages:dm-thread:first"] = {
      messages: [{ id: "incoming" }, { id: "outgoing" }],
      paging: { hasNextPage: false },
    };
    for (const [id, from, to, hours, text] of [
      ["incoming", "customer", identity, 25, "PRIVATE_CUSTOMER_CONTEXT"],
      ["outgoing", identity, "customer", 24, "Hello from our team."],
    ] as const) {
      messagePages[`instagram.get_message:${id}:first`] = {
        message: {
          id,
          from: { id: from },
          to: [{ id: to }],
          createdTime: new Date(Date.now() - hours * 3600000).toISOString(),
          text,
        },
      };
    }
  }
  async function messageStep(id: string) {
    await db.prisma.learningFeed.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
    await service.process(id);
  }
  async function messageScan(id: string) {
    for (let step = 0; step < 20; step++) {
      await messageStep(id);
      const row = await feedRow(id);
      expect(row.error).toBeNull();
      if (row.completedAt) return row;
    }
    throw new Error("Synthetic scan did not finish");
  }

  it("requires explicit message consent and all message read capabilities", async () => {
    messageFixture();
    const initial = await configure();
    expect(initial.includeMessages).toBe(false);
    await service.process(initial.id);
    expect(calls.mock.calls.some(([call]) => call.tool === "instagram.list_conversations")).toBe(
      false,
    );
    messageCapability = false;
    await expect(configure(1, "bot", true, false, true)).rejects.toThrow();
    expect((await feedRow(initial.id)).includeMessages).toBe(false);
  });

  it.each(["bot", "space"])(
    "keeps DM context private and requires reviewed approval for %s voice",
    async (scope) => {
      messageFixture();
      const feed = await configure(0, scope, true, false, true);
      expect(await messageScan(feed.id)).toMatchObject({
        accepted: 1,
        coverage: { contextOnly: 1, reviewCandidates: 1 },
      });
      const queued = await task();
      expect(queued.evidence).toMatchObject({
        reviewRequired: true,
        posts: [
          {
            id: "instagram-message:outgoing",
            conversationId: "dm-thread",
            contextId: "incoming",
            context: "PRIVATE_CUSTOMER_CONTEXT",
            staffAuthorship: "unverified",
          },
        ],
      });
      const learning = createLearning(db.prisma);
      await processTask(queued.id);
      const detail = await learning.task(actor(), { botId: owner.botId, taskId: queued.id });
      expect(detail.task).toMatchObject({
        status: "review",
        proposal: { supported: false, save: { scope } },
      });
      expect(JSON.parse(modelCalls.mock.calls[0]![0].prompt)).toMatchObject({
        sourceKind: "unverified_account_messages",
      });
      expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
      // Even a stale or forged model classification cannot bypass authoritative task evidence.
      await db.prisma.learningTask.update({
        where: { id: queued.id },
        data: {
          status: "running",
          leaseToken: "synthetic",
          proposal: { ...detail.task.proposal!, supported: true },
        },
      });
      await expect(
        learning.applyAutomaticTask(actor(), {
          botId: owner.botId,
          taskId: queued.id,
          token: "synthetic",
        }),
      ).rejects.toThrow("staff review");
      await db.prisma.learningTask.update({
        where: { id: queued.id },
        data: {
          status: "review",
          leaseToken: null,
          proposal: detail.task.proposal!,
        },
      });
      await learning.decideTask(
        actor(),
        {
          botId: owner.botId,
          taskId: queued.id,
          decision: "approve",
          reason: "Reviewed original messages and endorsed this writing style",
          reviewedProposal: detail.task.proposal!,
        },
        owner.botId,
      );
      const state = await learning.state(actor(), owner.botId);
      expect(state.documents[0]).toMatchObject({
        scope,
        content: expect.stringContaining("Use short sentences."),
      });
      expect(state.documents[0]!.content).not.toContain("PRIVATE_CUSTOMER_CONTEXT");
      expect(
        await db.prisma.learningTaskReview.findFirst({ where: { taskId: queued.id } }),
      ).toMatchObject({ decision: "approve", userId: owner.userId });
      await learning.undo(
        actor(),
        {
          botId: owner.botId,
          documentId: state.documents[0]!.id,
          revision: 1,
          expectedRevision: 1,
          reason: "Undo reviewed voice",
        },
        owner.botId,
      );
      expect((await learning.state(actor(), owner.botId)).documents[0]!.content).toBe("");
      await service.remove(actor(), owner.botId, { id: feed.id, expectedRevision: 1 });
      expect(await db.prisma.learningTask.count({ where: { id: queued.id } })).toBe(0);
      expect(
        await db.prisma.learningImport.findUnique({ where: { id: queued.importId! } }),
      ).toBeNull();
    },
  );

  it("holds the initial preconnection date window across pages and advances only on a new scan", async () => {
    messageFixture();
    const connectedAt = new Date(Date.now() - 2 * 86400000);
    await db.prisma.connection.update({
      where: { id: connectionId },
      data: { createdAt: connectedAt },
    });
    const feed = await configure(0, "bot", true, false, true);
    expect(feed.windowEnd).toEqual(connectedAt);
    expect(feed.windowStart).toEqual(new Date(connectedAt.getTime() - 30 * 86400000));
    await messageStep(feed.id);
    expect((await feedRow(feed.id)).windowEnd).toEqual(connectedAt);
    expect(await messageScan(feed.id)).toMatchObject({ accepted: 0, windowEnd: connectedAt });
    await service.refresh(actor(), owner.botId, { id: feed.id });
    const refreshed = await messageScan(feed.id);
    expect(refreshed.accepted).toBe(1);
    expect(refreshed.windowEnd.getTime()).toBeGreaterThan(connectedAt.getTime());
  });

  it.each(["confirmed", "uncertain", "comment"])(
    "filters DM provenance without mixing comment receipts: %s",
    async (status) => {
      messageFixture();
      const receipt = await db.prisma.instagramSend.create({
        data: {
          spaceId: owner.spaceId,
          executionKey: "other-alias",
          requestHash: "synthetic-request",
          accountHash: instagramAccountHash(identity),
          targetId: "customer",
          action: status === "comment" ? "instagram.reply_to_comment" : "instagram.send_message",
          ...(status === "confirmed"
            ? { externalId: "outgoing", result: { messageId: "outgoing", recipientId: "customer" } }
            : {}),
        },
      });
      const feed = await configure(0, "bot", true, false, true);
      expect(await messageScan(feed.id)).toMatchObject({
        accepted: status === "comment" ? 1 : 0,
        coverage: {
          generated: status === "confirmed" ? 1 : 0,
          uncertain: status === "uncertain" ? 1 : 0,
        },
      });
      if (status === "uncertain") {
        expect(await db.prisma.learningFeedItem.count({ where: { feedId: feed.id } })).toBe(0);
        await db.prisma.instagramSend.update({
          where: { id: receipt.id },
          data: {
            externalId: "another-message",
            result: { messageId: "another-message", recipientId: "customer" },
          },
        });
        await service.refresh(actor(), owner.botId, { id: feed.id });
        expect(await messageScan(feed.id)).toMatchObject({
          accepted: 1,
          coverage: { uncertain: 0 },
        });
      }
    },
  );

  it("retries unavailable details once and recovers their evidence on a later scan", async () => {
    messageFixture();
    unreadableMessages.add("outgoing");
    const feed = await configure(0, "bot", true, false, true);
    expect(await messageScan(feed.id)).toMatchObject({ accepted: 0, coverage: { unavailable: 1 } });
    expect(
      calls.mock.calls.filter(
        ([call]) => call.tool === "instagram.get_message" && call.args.messageId === "outgoing",
      ),
    ).toHaveLength(2);
    expect(await db.prisma.learningFeedItem.count({ where: { feedId: feed.id } })).toBe(0);
    expect(JSON.stringify(await service.list(actor(), owner.botId))).not.toContain(
      "PRIVATE_PROVIDER_ERROR",
    );
    unreadableMessages.clear();
    await service.refresh(actor(), owner.botId, { id: feed.id });
    expect(await messageScan(feed.id)).toMatchObject({ accepted: 1, coverage: { unavailable: 0 } });
  });

  it.each(["consent", "disconnect", "identity"])(
    "prevents buffered DM content from becoming evidence after %s changes during the detail read",
    async (change) => {
      messageFixture();
      const feed = await configure(0, "bot", true, false, true);
      for (let i = 0; i < 4; i++) await messageStep(feed.id);
      expect((await feedRow(feed.id)).cursor).toContain("PRIVATE_CUSTOMER_CONTEXT");
      beforePage = async () => {
        if (change === "consent") await configure(1);
        if (change === "disconnect")
          await db.prisma.connection.update({
            where: { id: connectionId },
            data: { status: "revoked" },
          });
        if (change === "identity") identity = "another-account";
      };
      await messageStep(feed.id);
      expect((await feedRow(feed.id)).cursor).toBeNull();
      expect((await feedRow(feed.id)).visitedCursors).toEqual([]);
      expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
      expect(await db.prisma.learningImport.count({ where: { botId: owner.botId } })).toBe(0);
    },
  );

  it("clears a failed DM buffer while preserving completed evidence and the original window", async () => {
    messageFixture();
    messagePages["instagram.list_conversation_messages:dm-thread:first"] = {
      messages: [{ id: "incoming" }, { id: "outgoing" }],
      paging: { hasNextPage: true, after: "next" },
    };
    messagePages["instagram.list_conversation_messages:dm-thread:next"] = {
      messages: [{ id: "incoming-2" }, { id: "outgoing-2" }],
      paging: { hasNextPage: false },
    };
    for (const id of ["incoming", "outgoing"]) {
      const original = messagePages[`instagram.get_message:${id}:first`] as {
        message: Record<string, unknown>;
      };
      messagePages[`instagram.get_message:${id}-2:first`] = {
        message: { ...original.message, id: `${id}-2` },
      };
    }
    const feed = await configure(0, "bot", true, false, true);
    for (let i = 0; i < 7; i++) await messageStep(feed.id);
    const captured = await feedRow(feed.id);
    expect(captured.accepted).toBe(1);
    expect(captured.cursor).toContain("PRIVATE_CUSTOMER_CONTEXT");
    beforePage = async () => {
      identity = "unavailable-account";
    };
    await messageStep(feed.id);
    const failed = await feedRow(feed.id);
    expect(failed).toMatchObject({
      cursor: null,
      visitedCursors: [],
      accepted: 1,
      windowEnd: feed.windowEnd,
    });
    expect(failed.coverage).toMatchObject({ reviewCandidates: 1 });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(1);
    beforePage = async () => {};
    identity = "owned-account";
    expect(await messageScan(feed.id)).toMatchObject({
      accepted: 2,
      duplicates: 1,
      windowEnd: feed.windowEnd,
    });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(2);
  });

  it.each(["disconnect", "consent", "withdraw"])(
    "rejects a previously reviewed DM proposal after %s",
    async (change) => {
      messageFixture();
      const feed = await configure(0, "bot", true, false, true);
      await messageScan(feed.id);
      const queued = await task();
      await processTask(queued.id);
      const learning = createLearning(db.prisma);
      const detail = await learning.task(actor(), { botId: owner.botId, taskId: queued.id });
      if (change === "disconnect")
        await db.prisma.connection.update({
          where: { id: connectionId },
          data: { status: "revoked" },
        });
      if (change === "consent") await configure(1);
      if (change === "withdraw")
        await learning.withdraw(actor(), { botId: owner.botId, sourceId: queued.importId! });
      await expect(
        learning.decideTask(
          actor(),
          {
            botId: owner.botId,
            taskId: queued.id,
            decision: "approve",
            reason: "Review from before source changed",
            reviewedProposal: detail.task.proposal!,
          },
          owner.botId,
        ),
      ).rejects.toThrow();
      expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
    },
  );

  it("exports opted-in DM evidence only to its owner without runtime cursor contents", async () => {
    messageFixture();
    const feed = await configure(0, "bot", true, false, true);
    await messageScan(feed.id);
    await db.prisma.learningFeed.update({
      where: { id: feed.id },
      data: { cursor: "PRIVATE_CURSOR_SENTINEL" },
    });
    const rows: AccountExportRecord[] = [];
    await writeAccountExport(
      db.prisma,
      owner.userId,
      async (row) => {
        rows.push(row);
      },
      async () => "",
      new AbortController().signal,
    );
    expect(rows.find((row) => row.type === "learningFeed")!.data).toMatchObject({
      includeMessages: true,
      coverage: { reviewCandidates: 1 },
    });
    expect(rows.filter((row) => row.type === "learningImport")).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("PRIVATE_CUSTOMER_CONTEXT");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_CURSOR_SENTINEL");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_BINDING_SENTINEL");
    const other = await db.prisma.user.create({
      data: { id: randomUUID(), name: "Other staff", email: `${randomUUID()}@rakazo.test` },
    });
    try {
      const otherRows: AccountExportRecord[] = [];
      await writeAccountExport(
        db.prisma,
        other.id,
        async (row) => {
          otherRows.push(row);
        },
        async () => "",
        new AbortController().signal,
      );
      expect(JSON.stringify(otherRows)).not.toContain("PRIVATE_CUSTOMER_CONTEXT");
      await expect(
        createLearning(db.prisma).taskEvidence(
          { ...actor(), userId: other.id },
          { botId: owner.botId, taskId: (await task()).id },
        ),
      ).rejects.toThrow();
    } finally {
      await db.prisma.user.delete({ where: { id: other.id } });
    }
  });

  it("imports owned captions, applies only the approved scope, links private evidence and supports undo", async () => {
    const feed = await configure();
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ accepted: 1, skipped: 0, error: null });
    const queued = await task();
    expect(queued.conversationId).toBeNull();
    expect(queued.importId).toBeTruthy();
    await processTask(queued.id);
    expect(modelCalls.mock.calls[0]![0]).toMatchObject({ tools: [], allowBuiltinTools: false });
    expect(JSON.parse(modelCalls.mock.calls[0]![0].prompt)).toMatchObject({
      sourceKind: "social_posts",
    });
    const learning = createLearning(db.prisma);
    const state = await learning.state(actor(), owner.botId);
    expect(state.documents[0]).toMatchObject({
      scope: "bot",
      content: expect.stringContaining("Use short sentences."),
    });
    const revision = state.history[0]!;
    const evidence = await learning.evidence(actor(), {
      botId: owner.botId,
      revisionId: revision.id,
    });
    expect(evidence).toMatchObject({ kind: "social", coverage: { accepted: 1 }, withdrawn: false });
    expect(evidence.content).toContain("Hello from our studio.");
    await learning.undo(
      actor(),
      {
        botId: owner.botId,
        documentId: state.documents[0]!.id,
        revision: 1,
        expectedRevision: 1,
        reason: "Synthetic undo",
      },
      owner.botId,
    );
    expect((await learning.state(actor(), owner.botId)).documents[0]!.content).toBe("");
    await service.refresh(actor(), owner.botId, { id: feed.id });
    await service.process(feed.id);
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(1);
  });

  it("resumes pagination, excludes old/future or empty captions and detects edits without duplicating unchanged posts", async () => {
    pages.first!.paging = { hasNextPage: true, after: "next" };
    pages.next = {
      media: [
        pages.first!.media[0]!,
        {
          id: "old",
          caption: "Old",
          timestamp: new Date(Date.now() - 31 * 86400000).toISOString(),
        },
        {
          id: "future",
          caption: "Future",
          timestamp: new Date(Date.now() + 86400000).toISOString(),
        },
        { id: "blank", timestamp: new Date().toISOString() },
      ],
      paging: { hasNextPage: false },
    };
    const feed = await configure();
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ cursor: "next", completedAt: null });
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 1,
      skipped: 3,
      duplicates: 1,
      cursor: null,
      completedAt: expect.any(Date),
    });
    pages.first!.media[0]!.caption = "An edited introduction.";
    pages.first!.paging = { hasNextPage: false };
    await service.refresh(actor(), owner.botId, { id: feed.id });
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ cycle: 2, accepted: 1 });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(2);
  });

  function replyFixture() {
    pages.first = {
      media: [{ id: "old-post", timestamp: "2020-01-01T00:00:00Z" }],
      paging: { hasNextPage: false },
    };
    commentPages["instagram.list_media_comments:old-post:first"] = {
      comments: [
        { id: "old-parent", text: "Can I visit the studio?", timestamp: "2020-01-01T00:00:00Z" },
      ],
      paging: { hasNextPage: false },
    };
    commentPages["instagram.list_comment_replies:old-parent:first"] = {
      comments: [
        {
          id: "recent-reply",
          text: "Hello from our team.",
          userId: "app-author",
          timestamp: new Date(Date.now() - 86400000).toISOString(),
        },
      ],
      paging: { hasNextPage: false },
    };
  }

  it("excludes recorded generated reply IDs across account aliases without consuming markers", async () => {
    replyFixture();
    const generated = await db.prisma.instagramSend.create({
      data: {
        spaceId: owner.spaceId,
        executionKey: "other-connection-send",
        requestHash: "other-binding",
        externalId: "recent-reply",
        result: { commentId: "recent-reply", parentCommentId: "old-parent" },
      },
    });
    const feed = await configure(0, "bot", true, true);
    for (let page = 0; page < 3; page++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 0,
      coverage: { generated: 1, uncertain: 0, replyEarliest: null },
    });
    expect(await db.prisma.learningFeedItem.count({ where: { feedId: feed.id } })).toBe(0);
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    // Editing an automated reply must not make it a new human example.
    commentPages["instagram.list_comment_replies:old-parent:first"]!.comments[0]!.text =
      "Edited automated text";
    await service.refresh(actor(), owner.botId, { id: feed.id });
    for (let page = 0; page < 3; page++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ accepted: 0, coverage: { generated: 1 } });
    expect(await db.prisma.instagramSend.count({ where: { id: generated.id } })).toBe(1);
  });

  it.each([null, "recent-reply"])(
    "does not let a DM receipt suppress comment examples: %s",
    async (externalId) => {
      replyFixture();
      await db.prisma.instagramSend.create({
        data: {
          spaceId: owner.spaceId,
          executionKey: "dm-send",
          requestHash: "dm-request",
          action: "instagram.send_message",
          targetId: "customer",
          externalId,
          ...(externalId ? { result: { messageId: externalId, recipientId: "customer" } } : {}),
        },
      });
      const feed = await configure(0, "bot", true, true);
      for (let page = 0; page < 3; page++) await service.process(feed.id);
      expect(await feedRow(feed.id)).toMatchObject({
        accepted: 1,
        coverage: { generated: 0, uncertain: 0 },
      });
    },
  );

  it("holds replies for uncertain sends, keeps captions, and imports held rows after reconciliation", async () => {
    replyFixture();
    pages.first!.media[0]!.caption = "An owned caption.";
    pages.first!.media[0]!.timestamp = new Date(Date.now() - 86400000).toISOString();
    const pending = await db.prisma.instagramSend.create({
      data: {
        spaceId: owner.spaceId,
        executionKey: "a".repeat(64),
        requestHash: "b".repeat(64),
        bindingHash: instagramBindingHash("PRIVATE_BINDING_SENTINEL"),
        action: "instagram.reply_to_comment",
        targetId: "old-parent",
      },
    });
    const feed = await configure(0, "bot", true, true);
    for (let page = 0; page < 3; page++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 1,
      coverage: {
        uncertain: 1,
        generated: 0,
        replyEarliest: null,
        limitations: expect.arrayContaining([expect.stringContaining("uncertain outcome")]),
      },
    });
    expect(
      await db.prisma.learningFeedItem.count({
        where: { feedId: feed.id, externalId: "instagram-reply:recent-reply" },
      }),
    ).toBe(0);
    const recovery = createCustomerConnector({
      prisma: db.prisma,
      integrations: new IntegrationProviderSettings(
        db.prisma,
        new EncryptedSecretStore("test"),
        "test",
        {
          "open-connector": {
            receipt: async () => ({
              status: "confirmed",
              data: { commentId: "different-generated-reply", parentCommentId: "old-parent" },
            }),
          } as unknown as ManagedConnectorProvider,
        },
      ),
    });
    expect(
      await recovery.reconcileCommentWrite(actor(), { connectionId, id: pending.id }),
    ).toMatchObject({ status: "confirmed" });
    await service.refresh(actor(), owner.botId, { id: feed.id });
    for (let page = 0; page < 3; page++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 1,
      duplicates: 1,
      coverage: { uncertain: 0 },
    });
    expect(
      await db.prisma.learningFeedItem.count({
        where: { feedId: feed.id, externalId: "instagram-reply:recent-reply" },
      }),
    ).toBe(1);
  });

  it("does not let another Space's uncertain sends suppress this account's replies", async () => {
    replyFixture();
    const otherSpace = await db.prisma.space.create({
      data: {
        id: randomUUID(),
        name: "Other Space",
        organizationId: (await db.prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } }))
          .organizationId,
      },
    });
    try {
      await db.prisma.instagramSend.create({
        data: { spaceId: otherSpace.id, executionKey: "other", requestHash: "other" },
      });
      const feed = await configure(0, "bot", true, true);
      for (let page = 0; page < 3; page++) await service.process(feed.id);
      expect(await feedRow(feed.id)).toMatchObject({ accepted: 1, coverage: { uncertain: 0 } });
    } finally {
      await db.prisma.space.delete({ where: { id: otherSpace.id } });
    }
  });

  it.each(["confirmed", "uncertain"])(
    "matches %s sends for the same verified account across Spaces",
    async (state) => {
      replyFixture();
      const other = await db.prisma.space.create({
        data: {
          id: randomUUID(),
          name: "Other Space",
          organizationId: (
            await db.prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } })
          ).organizationId,
        },
      });
      try {
        await db.prisma.instagramSend.create({
          data: {
            spaceId: other.id,
            executionKey: "account-send",
            requestHash: "request",
            accountHash: instagramAccountHash(identity),
            ...(state === "confirmed"
              ? {
                  externalId: "recent-reply",
                  result: { commentId: "recent-reply", parentCommentId: "old-parent" },
                }
              : {}),
          },
        });
        const feed = await configure(0, "bot", true, true);
        calls.mockClear();
        for (let page = 0; page < 3; page++) await service.process(feed.id);
        expect(await feedRow(feed.id)).toMatchObject({
          accepted: 0,
          coverage: {
            generated: state === "confirmed" ? 1 : 0,
            uncertain: state === "uncertain" ? 1 : 0,
          },
        });
        expect(await db.prisma.learningFeedItem.count({ where: { feedId: feed.id } })).toBe(0);
        expect(calls.mock.calls.length).toBeGreaterThan(0);
        for (const [call] of calls.mock.calls) expect(call.expectedAccountId).toBe(identity);
      } finally {
        await db.prisma.space.delete({ where: { id: other.id } });
      }
    },
  );

  it("does not hold an unrelated verified account in the same Space", async () => {
    replyFixture();
    await db.prisma.instagramSend.create({
      data: {
        spaceId: owner.spaceId,
        executionKey: "unrelated",
        requestHash: "request",
        accountHash: instagramAccountHash("unrelated-account"),
      },
    });
    const feed = await configure(0, "bot", true, true);
    for (let page = 0; page < 3; page++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ accepted: 1, coverage: { uncertain: 0 } });
  });

  it("observes a pending dispatch written while a reply page is being fetched", async () => {
    replyFixture();
    const feed = await configure(0, "bot", true, true);
    await service.process(feed.id);
    await service.process(feed.id);
    beforePage = async () => {
      await db.prisma.instagramSend.create({
        data: { spaceId: owner.spaceId, executionKey: "concurrent-send", requestHash: "binding" },
      });
    };
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ accepted: 0, coverage: { uncertain: 1 } });
    expect(await db.prisma.learningFeedItem.count({ where: { feedId: feed.id } })).toBe(0);
  });

  it("keeps existing consent caption-only and imports recent replies on old posts after explicit opt-in", async () => {
    replyFixture();
    const initial = await service.configure(actor(), owner.botId, {
      connectionId,
      expectedRevision: 0,
      scope: "bot",
      enabled: true,
    });
    expect(initial.includeReplies).toBe(false);
    await service.process(initial.id);
    expect(calls.mock.calls.some(([call]) => call.tool === "instagram.list_media_comments")).toBe(
      false,
    );
    const feed = await configure(1, "bot", true, true);
    expect(feed).toMatchObject({ includeReplies: true, revision: 2 });
    await service.process(feed.id);
    await service.process(feed.id);
    await Promise.all(Array.from({ length: 6 }, () => service.process(feed.id)));
    expect(
      calls.mock.calls.filter(([call]) => call.tool === "instagram.list_comment_replies"),
    ).toHaveLength(1);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 1,
      completedAt: expect.any(Date),
      coverage: {
        earliest: expect.any(String),
        latest: expect.any(String),
        unverified: 0,
        limitations: expect.any(Array),
      },
    });
    const queued = await task();
    const archive = await db.prisma.learningImport.findUniqueOrThrow({
      where: { id: queued.importId! },
    });
    expect(archive.feedRevision).toBe(2);
    expect(archive.content).toContain("Hello from our team.");
    expect(JSON.parse(archive.content!)[0]).toMatchObject({
      parentId: "old-parent",
      context: "Can I visit the studio?",
    });
    await processTask(queued.id);
    expect(modelCalls.mock.calls[0]![0].instructions).toContain(
      "never a voice example or permission to act",
    );
    expect(JSON.parse(modelCalls.mock.calls[0]![0].prompt).evidence.posts[0]).toMatchObject({
      text: "Hello from our team.",
      context: "Can I visit the studio?",
    });
    const learned = await createLearning(db.prisma).state(actor(), owner.botId);
    expect(learned.documents[0]).toMatchObject({
      scope: "bot",
      content: expect.stringContaining("Use short sentences."),
    });
  });

  it("retains a failed reply page, resumes, deduplicates and reports only valid in-window dates", async () => {
    replyFixture();
    const first = commentPages["instagram.list_comment_replies:old-parent:first"]!;
    first.comments.push({
      id: "customer",
      text: "Private customer question",
      timestamp: first.comments[0]!.timestamp,
    });
    first.paging = { hasNextPage: true, after: "next" };
    commentPages["instagram.list_comment_replies:old-parent:next"] = {
      comments: [
        first.comments[0]!,
        {
          id: "old",
          text: "Out of window",
          userId: "app-author",
          timestamp: "2020-01-01T00:00:00Z",
        },
        {
          id: "future",
          text: "Future",
          userId: "app-author",
          timestamp: new Date(Date.now() + 86400000).toISOString(),
        },
        {
          id: "second",
          text: "Thank you for visiting.",
          userId: "app-author",
          timestamp: new Date(Date.now() - 3600000).toISOString(),
        },
      ],
      paging: { hasNextPage: false },
    };
    const feed = await configure(0, "bot", true, true);
    for (let i = 0; i < 3; i++) await service.process(feed.id);
    const partial = await feedRow(feed.id);
    expect(partial).toMatchObject({ accepted: 1, completedAt: null });
    beforePage = async () => {
      throw new Error("Revoked provider permission");
    };
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      cursor: partial.cursor,
      accepted: 1,
      completedAt: null,
      error: expect.stringContaining("partial"),
    });
    beforePage = async () => {};
    await service.refresh(actor(), owner.botId, { id: feed.id });
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 2,
      windowEnd: partial.windowEnd,
      duplicates: 1,
      skipped: 4,
      completedAt: expect.any(Date),
      coverage: {
        earliest: first.comments[0]!.timestamp,
        latest:
          commentPages["instagram.list_comment_replies:old-parent:next"]!.comments[3]!.timestamp,
        unverified: 1,
      },
    });
    const archives = await db.prisma.learningImport.findMany({ where: { feedId: feed.id } });
    expect(archives).toHaveLength(2);
    expect(JSON.stringify(archives)).not.toContain("Private customer question");
    expect(JSON.stringify(archives)).not.toContain("Out of window");
    await service.refresh(actor(), owner.botId, { id: feed.id });
    for (let i = 0; i < 4; i++) await service.process(feed.id);
    expect(await db.prisma.learningImport.count({ where: { feedId: feed.id } })).toBe(2);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 0,
      duplicates: 3,
      coverage: { earliest: first.comments[0]!.timestamp },
    });
  });

  it("skips oversized escaped reply evidence before consuming its marker and can learn a later valid import", async () => {
    replyFixture();
    const parent = commentPages["instagram.list_media_comments:old-post:first"]!.comments[0]!;
    const reply = commentPages["instagram.list_comment_replies:old-parent:first"]!.comments[0]!;
    parent.text = "\u0000".repeat(14000);
    reply.text = "\u0000".repeat(14000);
    const feed = await configure(0, "bot", true, true);
    for (let i = 0; i < 3; i++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 0,
      skipped: 2,
      coverage: { oversized: 1, earliest: null, replyEarliest: null },
    });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    expect(await db.prisma.learningFeedItem.count({ where: { feedId: feed.id } })).toBe(0);
    parent.text = "Can I visit?";
    reply.text = "Please visit our studio.";
    await service.refresh(actor(), owner.botId, { id: feed.id });
    for (let i = 0; i < 3; i++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ accepted: 1, coverage: { oversized: 0 } });
    const archives = await db.prisma.learningImport.findMany({ where: { feedId: feed.id } });
    expect(archives).toHaveLength(1);
    expect(archives[0]!.content!.length).toBeLessThanOrEqual(14000);
    await processTask((await task()).id);
    expect(modelCalls).toHaveBeenCalledTimes(1);
  });

  it("reports reply date coverage separately so older captions cannot imply older reply evidence", async () => {
    replyFixture();
    const captionAt = new Date(Date.now() - 20 * 86400000).toISOString();
    pages.first!.media[0] = {
      id: "old-post",
      caption: "A business caption.",
      timestamp: captionAt,
    };
    const replyAt =
      commentPages["instagram.list_comment_replies:old-parent:first"]!.comments[0]!.timestamp;
    const feed = await configure(0, "bot", true, true);
    for (let i = 0; i < 3; i++) await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      accepted: 2,
      coverage: {
        earliest: captionAt,
        latest: replyAt,
        replyEarliest: replyAt,
        replyLatest: replyAt,
      },
    });
  });

  it("reports its own page limit separately from provider coverage and never marks that scan complete", async () => {
    replyFixture();
    const feed = await configure(0, "bot", true, true);
    await service.process(feed.id);
    const checkpoint = await feedRow(feed.id);
    await db.prisma.learningFeed.update({
      where: { id: feed.id },
      data: { visitedCursors: Array.from({ length: 1000 }, (_, i) => `prior-${i}`) },
    });
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      cursor: checkpoint.cursor,
      completedAt: null,
      error: expect.stringContaining("page limit"),
    });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
  });

  it("refuses reply opt-in when the connector lacks the read action without creating a source", async () => {
    replyCapability = false;
    await expect(configure(0, "bot", true, true)).rejects.toThrow();
    expect(await db.prisma.learningFeed.count({ where: { botId: owner.botId } })).toBe(0);
    expect(calls).not.toHaveBeenCalled();
    expect((await configure()).includeReplies).toBe(false);
  });

  it("drops an in-flight reply when the owner removes reply consent", async () => {
    replyFixture();
    const feed = await configure(0, "bot", true, true);
    await service.process(feed.id);
    await service.process(feed.id);
    beforePage = async () => {
      await configure(1, "bot", true, false);
    };
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      includeReplies: false,
      revision: 2,
      accepted: 0,
      cursor: null,
    });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
  });

  it("starts its backfill 30 days before connection registration", async () => {
    const registered = new Date(Date.now() - 15 * 86400000);
    await db.prisma.connection.update({
      where: { id: connectionId },
      data: { createdAt: registered },
    });
    pages.first!.media[0]!.timestamp = new Date(Date.now() - 40 * 86400000).toISOString();
    const feed = await configure();
    expect(feed.windowStart.getTime()).toBe(registered.getTime() - 30 * 86400000);
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ accepted: 1 });
  });

  it("serializes duplicate jobs without holding a database connection during provider I/O", async () => {
    const feed = await configure();
    beforePage = async () => {
      await Promise.all(Array.from({ length: 6 }, () => db.prisma.bot.count()));
    };
    await Promise.all(Array.from({ length: 6 }, () => service.process(feed.id)));
    expect(calls.mock.calls.filter(([call]) => call.tool === "instagram.list_media")).toHaveLength(
      1,
    );
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(1);
  });

  it.each(["disable", "disconnect", "rebind", "archive", "pause", "delete-account", "remove"])(
    "discards a page after %s while reading",
    async (change) => {
      const feed = await configure();
      beforePage = async () => {
        if (change === "disable") await configure(1, "bot", false);
        if (change === "disconnect")
          await db.prisma.connection.update({
            where: { id: connectionId },
            data: { status: "revoked" },
          });
        if (change === "rebind")
          await db.prisma.connection.update({
            where: { id: connectionId },
            data: { providerRef: "OTHER_ACCOUNT" },
          });
        if (change === "archive")
          await db.prisma.bot.update({
            where: { id: owner.botId },
            data: { archivedAt: new Date() },
          });
        if (change === "pause")
          await createLearning(db.prisma).configure(actor(), {
            botId: owner.botId,
            enabled: false,
          });
        if (change === "delete-account")
          await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
        if (change === "remove")
          await service.remove(actor(), owner.botId, { id: feed.id, expectedRevision: 1 });
      };
      await service.process(feed.id);
      expect(await db.prisma.learningImport.count({ where: { botId: owner.botId } })).toBe(0);
      expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    },
  );

  it.each(["disable", "scope", "disconnect", "withdraw", "remove"])(
    "prevents model writes after %s during inference",
    async (change) => {
      const feed = await configure();
      await service.process(feed.id);
      const queued = await task();
      beforeModel = async () => {
        if (change === "disable") await configure(1, "bot", false);
        if (change === "scope") await configure(1, "space");
        if (change === "disconnect")
          await db.prisma.connection.update({
            where: { id: connectionId },
            data: { status: "revoked" },
          });
        if (change === "withdraw")
          await createLearning(db.prisma).withdraw(actor(), {
            botId: owner.botId,
            sourceId: queued.importId!,
          });
        if (change === "remove")
          await service.remove(actor(), owner.botId, { id: feed.id, expectedRevision: 1 });
      };
      await processTask(queued.id);
      expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
    },
  );

  it("keeps operational rules in review even if the model claims they are safe", async () => {
    const feed = await configure();
    await service.process(feed.id);
    inference.kind = "knowledge";
    await processTask((await task()).id);
    expect(await task()).toMatchObject({ status: "review", proposal: { supported: false } });
    expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
  });

  it("blocks changed account identity and unverified action effects before reading posts", async () => {
    const feed = await configure();
    identity = "other-account";
    await service.process(feed.id);
    expect(calls.mock.calls.filter(([call]) => call.tool === "instagram.list_media")).toHaveLength(
      0,
    );
    identity = "owned-account";
    readOnly = false;
    await expect(configure(1)).rejects.toThrow("effect");
    await service.refresh(actor(), owner.botId, { id: feed.id });
    await service.process(feed.id);
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
  });

  it("discards captions when remote account identity changes between identity and page reads", async () => {
    const feed = await configure();
    beforePage = async () => {
      identity = "different-authorized-account";
    };
    await service.process(feed.id);
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    expect(await feedRow(feed.id)).toMatchObject({
      error: expect.stringContaining("access was removed"),
    });
  });

  it("treats scope changes as prospective and rejects old proposals without relearning the same posts", async () => {
    const feed = await configure();
    await service.process(feed.id);
    const queued = await task();
    await configure(1, "space");
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ scope: "space", duplicates: 1, accepted: 0 });
    await processTask(queued.id);
    expect(modelCalls).not.toHaveBeenCalled();
    expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(1);
  });

  it("retries failed or expired leases and reports incomplete scans in one daily summary", async () => {
    const feed = await configure();
    beforePage = async () => {
      throw new Error("PRIVATE_ERROR_SENTINEL");
    };
    await service.process(feed.id);
    expect((await feedRow(feed.id)).error).not.toContain("PRIVATE_ERROR_SENTINEL");
    await publishLearningSummaries(db.prisma);
    await publishLearningSummaries(db.prisma);
    const summaries = await db.prisma.message.findMany({
      where: { botId: owner.botId, role: "bot" },
    });
    expect(
      summaries.filter((row) =>
        JSON.stringify(row.blocks).includes("source refreshes need attention"),
      ),
    ).toHaveLength(1);
    beforePage = async () => {};
    await db.prisma.learningFeed.update({
      where: { id: feed.id },
      data: { nextAttemptAt: new Date(0), leaseToken: "expired", leaseUntil: new Date(0) },
    });
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({ accepted: 1, error: null, leaseToken: null });
  });

  it("rejects cyclic pagination without claiming full coverage", async () => {
    const feed = await configure();
    pages.first!.paging = { hasNextPage: true, after: "a" };
    pages.a = { media: [], paging: { hasNextPage: true, after: "b" } };
    pages.b = { media: [], paging: { hasNextPage: true, after: "a" } };
    await service.process(feed.id);
    await service.process(feed.id);
    await service.process(feed.id);
    expect(await feedRow(feed.id)).toMatchObject({
      cursor: "b",
      completedAt: null,
      error: expect.stringContaining("partial"),
    });
  });

  it("removes captured evidence and proposals while retaining the document audit and duplicate markers", async () => {
    const feed = await configure();
    await service.process(feed.id);
    const queued = await task();
    await processTask(queued.id);
    const learning = createLearning(db.prisma);
    const revision = (await learning.state(actor(), owner.botId)).history[0]!;
    await learning.withdraw(actor(), { botId: owner.botId, sourceId: queued.importId! });
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    expect(
      await learning.evidence(actor(), { botId: owner.botId, revisionId: revision.id }),
    ).toMatchObject({ withdrawn: true, content: "" });
    await service.refresh(actor(), owner.botId, { id: feed.id });
    await service.process(feed.id);
    expect(await db.prisma.learningTask.count({ where: { botId: owner.botId } })).toBe(0);
    await service.remove(actor(), owner.botId, { id: feed.id, expectedRevision: 1 });
    expect(await db.prisma.learningImport.count({ where: { botId: owner.botId } })).toBe(0);
    expect(await db.prisma.learningFeedItem.count({ where: { feedId: feed.id } })).toBe(0);
    expect((await learning.state(actor(), owner.botId)).history).toHaveLength(1);
  });

  it("routes approved setup through reconciliation and the production background handler into the learning queue", async () => {
    const enqueue = vi.fn(async (_job: unknown) => undefined);
    const customers = createCustomerConversations({
      prisma: db.prisma,
      integrations,
      secrets: new EncryptedSecretStore("synthetic-test-key"),
      jobs: { enqueue } as unknown as JobPublisher,
    });
    await customers.manage(actor(), owner.botId, "learning_source_configure", {
      connectionId,
      scope: "bot",
      expectedRevision: 0,
      enabled: true,
    });
    const feed = await db.prisma.learningFeed.findFirstOrThrow({ where: { botId: owner.botId } });
    await customers.reconcile();
    expect(enqueue).toHaveBeenCalledWith({
      name: "learning.refresh",
      payload: { feedId: feed.id },
      replaceKey: `learning.refresh:${feed.id}`,
    });
    const handlers = createBackgroundJobHandlers({ customers } as Parameters<
      typeof createBackgroundJobHandlers
    >[0]);
    await dispatchBackgroundJob(handlers, "learning.refresh", { feedId: feed.id });
    const queued = await task();
    await customers.reconcile();
    expect(enqueue).toHaveBeenCalledWith({
      name: "learning.process",
      payload: { taskId: queued.id },
      replaceKey: `learning:${queued.id}`,
    });
    expect(await customers.manage(actor(), owner.botId, "learning_sources", {})).toMatchObject([
      { id: feed.id, accepted: 1 },
    ]);
    await customers.manage(actor(), owner.botId, "learning_source_remove", {
      id: feed.id,
      expectedRevision: 1,
    });
    expect(await db.prisma.learningFeed.count({ where: { id: feed.id } })).toBe(0);
  });

  it("enforces a source's approved scope even through the manual document save tool", async () => {
    const feed = await configure();
    await service.process(feed.id);
    const queued = await task();
    const learning = createLearning(db.prisma);
    const input = {
      botId: owner.botId,
      scope: "space" as const,
      kind: "voice" as const,
      key: "brand-voice",
      title: "Voice",
      content: "A manual addition",
      customerVisible: true,
      expectedRevision: 0,
      reason: "Synthetic edit",
      source: "Posts",
      sourceRef: { kind: "import" as const, id: queued.importId! },
    };
    await expect(learning.save(actor(), input)).rejects.toThrow("different learning scope");
    const other = await db.prisma.bot.create({
      data: { ...actor(), name: "Other bot", color: "blue" },
    });
    await expect(
      learning.save(actor(), { ...input, botId: other.id, scope: "bot" }),
    ).rejects.toThrow("different learning scope");
    expect(await db.prisma.learningDocument.count({ where: { spaceId: owner.spaceId } })).toBe(0);
  });

  it("updates shared voice while preserving an explicit bot override for future customer replies", async () => {
    const learning = createLearning(db.prisma);
    await learning.save(actor(), {
      botId: owner.botId,
      scope: "bot",
      kind: "voice",
      key: "brand-voice",
      title: "Bot voice",
      content: "Use formal wholesale wording.",
      customerVisible: true,
      expectedRevision: 0,
      reason: "Approved override",
      source: "Staff",
    });
    const feed = await configure(0, "space");
    await service.process(feed.id);
    await processTask((await task()).id);
    const state = await learning.state(actor(), owner.botId);
    expect(state.documents.find((doc) => doc.scope === "space")?.content).toContain(
      "Use short sentences.",
    );
    expect(state.documents.find((doc) => doc.scope === "bot")?.content).toBe(
      "Use formal wholesale wording.",
    );
    expect(await learning.customerContext(owner.spaceId, owner.botId)).toContain(
      "Use formal wholesale wording.",
    );
    expect(await learning.customerContext(owner.spaceId, owner.botId)).not.toContain(
      "Use short sentences.",
    );
  });

  it("exports owned feed evidence and tasks without runtime bindings or cursors", async () => {
    const feed = await configure();
    await service.process(feed.id);
    await db.prisma.learningFeed.update({
      where: { id: feed.id },
      data: { cursor: "PRIVATE_CURSOR_SENTINEL" },
    });
    const rows: AccountExportRecord[] = [];
    await writeAccountExport(
      db.prisma,
      owner.userId,
      async (row) => {
        rows.push(row);
      },
      async () => "",
      new AbortController().signal,
    );
    expect(rows.filter((row) => row.type === "learningFeed")).toHaveLength(1);
    expect(rows.find((row) => row.type === "learningFeed")!.data).toMatchObject({
      includeReplies: false,
      coverage: { earliest: pages.first!.media[0]!.timestamp },
    });
    expect(rows.filter((row) => row.type === "learningImport")).toHaveLength(1);
    expect(rows.filter((row) => row.type === "learningTask")).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("Hello from our studio.");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_BINDING_SENTINEL");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_CURSOR_SENTINEL");
  });

  it("enforces private bot ownership and rejects stale configuration revisions", async () => {
    const feed = await configure();
    await expect(configure()).rejects.toThrow("changed");
    const intruder = await db.prisma.user.create({
      data: { id: randomUUID(), name: "Other staff", email: `${randomUUID()}@rakazo.test` },
    });
    try {
      const { organizationId } = await db.prisma.space.findUniqueOrThrow({
        where: { id: owner.spaceId },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          userId: intruder.id,
          organizationId,
          role: "admin",
          createdAt: new Date(),
        },
      });
      // The organization-membership trigger also joins its default Space.
      expect(
        await db.prisma.spaceMember.count({
          where: { userId: intruder.id, spaceId: owner.spaceId },
        }),
      ).toBe(1);
      const other = { ...actor(), userId: intruder.id };
      await expect(service.list(other, owner.botId)).rejects.toThrow();
      await expect(service.refresh(other, owner.botId, { id: feed.id })).rejects.toThrow();
      await expect(
        service.remove(other, owner.botId, { id: feed.id, expectedRevision: 1 }),
      ).rejects.toThrow();
    } finally {
      await db.prisma.user.delete({ where: { id: intruder.id } });
    }
  });

  it("enforces exactly one task source and cascades feed deletion", async () => {
    const feed = await configure();
    await service.process(feed.id);
    const queued = await task();
    await expect(
      db.prisma.learningTask.update({ where: { id: queued.id }, data: { importId: null } }),
    ).rejects.toThrow();
    await db.prisma.connection.delete({ where: { id: connectionId } });
    expect(await db.prisma.learningFeed.count({ where: { id: feed.id } })).toBe(0);
    expect(await db.prisma.learningTask.count({ where: { id: queued.id } })).toBe(0);
  });
});
