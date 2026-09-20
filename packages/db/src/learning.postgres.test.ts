import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCustomerInbox,
  createCustomerRepos,
  createDb,
  createLearning,
  provisionMessagingIdentity,
} from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("learning and private steering with PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let stranger: typeof owner;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    const create = () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "test", address: randomUUID() },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
    owner = await create();
    stranger = await create();
  });
  afterEach(async () => {
    for (const actor of [owner, stranger]) {
      await db.prisma.space.delete({ where: { id: actor.spaceId } });
      await db.prisma.user.delete({ where: { id: actor.userId } });
    }
  });
  const doc = () => ({
    botId: owner.botId,
    scope: "space" as const,
    kind: "voice" as const,
    key: "brand-voice",
    title: "Brand voice",
    content: "Friendly Thai. No pressure.",
    expectedRevision: 0,
    reason: "Approved examples",
    source: "Synthetic staff replies",
    customerVisible: true,
  });
  it("persists versions, applies bot overrides, restores without rewriting audit, and rejects stale edits", async () => {
    const learning = createLearning(db.prisma);
    const first = await learning.save(owner, doc());
    await learning.save(owner, { ...doc(), scope: "bot", content: "Short and formal" });
    expect(await learning.customerContext(owner.spaceId, owner.botId)).toContain(
      "Short and formal",
    );
    expect(await learning.customerContext(owner.spaceId, owner.botId)).not.toContain(
      "Friendly Thai",
    );
    await learning.save(owner, { ...doc(), expectedRevision: 1, content: "Warm and clear" });
    await expect(learning.save(owner, { ...doc(), expectedRevision: 1 })).rejects.toThrow(
      "changed",
    );
    await learning.restore(owner, {
      botId: owner.botId,
      documentId: first.id,
      revision: 1,
      expectedRevision: 2,
    });
    const state = await learning.state(owner, owner.botId);
    expect(state.documents.find((d) => d.id === first.id)).toMatchObject({
      revision: 3,
      content: doc().content,
    });
    expect(state.history.filter((r) => r.documentId === first.id)).toHaveLength(3);
    await expect(learning.state(stranger, owner.botId)).rejects.toThrow();
    await expect(
      learning.restore(stranger, {
        botId: stranger.botId,
        documentId: first.id,
        revision: 1,
        expectedRevision: 3,
      }),
    ).rejects.toThrow();
  });
  it("serializes concurrent first writes and never sends private documents to customer execution", async () => {
    const learning = createLearning(db.prisma);
    const results = await Promise.allSettled([
      learning.save(owner, { ...doc(), customerVisible: false }),
      learning.save(owner, doc()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const state = await learning.state(owner, owner.botId);
    if (!state.documents[0]!.customerVisible)
      expect(await learning.customerContext(owner.spaceId, owner.botId)).toBe("");
    expect(state.history).toHaveLength(1);
  });
  it("selectively undoes a revision, audits its actor, and fences stale previews", async () => {
    const learning = createLearning(db.prisma);
    const first = await learning.save(owner, {
      ...doc(),
      content: "Formal\nAsk one question\nCheck stock",
    });
    await learning.save(owner, {
      ...doc(),
      expectedRevision: 1,
      content: "Friendly\nAsk one question\nCheck stock",
    });
    await learning.save(owner, {
      ...doc(),
      expectedRevision: 2,
      content: "Friendly\nAsk one question\nCheck current stock",
    });
    const input = { botId: owner.botId, documentId: first.id, revision: 2, expectedRevision: 3 };
    const preview = await learning.previewUndo(owner, input);
    expect(preview.proposed.content).toBe("Formal\nAsk one question\nCheck current stock");
    expect(preview.conflicts).toEqual([]);
    await expect(
      learning.previewUndo(stranger, { ...input, botId: stranger.botId }),
    ).rejects.toThrow();
    await learning.undo(owner, { ...input, reason: "Keep the approved tone" }, owner.botId);
    await expect(learning.undo(owner, { ...input, reason: "Duplicate retry" })).rejects.toThrow(
      "changed",
    );
    const state = await learning.state(owner, owner.botId);
    expect(state.documents[0]).toMatchObject({ revision: 4, content: preview.proposed.content });
    expect(state.history[0]).toMatchObject({
      reason: "Undo version 2: Keep the approved tone",
      restoredFrom: 1,
    });
    expect(state.history[0]!.actor).toMatch(/^Agent/);
    expect(state.history).toHaveLength(4);
    expect(await learning.customerContext(owner.spaceId, owner.botId)).toContain(
      "Check current stock",
    );
  });
  it("requires a reviewed resolution for overlapping edits and retains prior audit versions", async () => {
    const learning = createLearning(db.prisma);
    const first = await learning.save(owner, { ...doc(), content: "Formal" });
    await learning.save(owner, { ...doc(), expectedRevision: 1, content: "Friendly" });
    await learning.save(owner, { ...doc(), expectedRevision: 2, content: "Warm and concise" });
    const input = {
      botId: owner.botId,
      documentId: first.id,
      revision: 2,
      expectedRevision: 3,
      reason: "Reviewed the later correction",
    };
    const preview = await learning.previewUndo(owner, input);
    expect(preview.conflicts).toEqual(["content"]);
    expect(preview.proposed.content).toBe("Warm and concise");
    await expect(learning.undo(owner, input)).rejects.toThrow("overlap");
    await learning.undo(owner, {
      ...input,
      resolution: { ...preview.proposed, content: "Formal and concise" },
    });
    const state = await learning.state(owner, owner.botId);
    expect(state.history.find((r) => r.revision === 3)!.content).toBe("Warm and concise");
    expect(state.documents[0]!.content).toBe("Formal and concise");
  });
  async function conversation() {
    const channel = await db.prisma.customerChannel.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        provider: "web",
        accountId: randomUUID(),
        name: "Test shop",
        ciphertext: "",
        autoReplies: true,
      },
    });
    const inbox = createCustomerInbox(db.prisma);
    const id = await inbox.receive(channel.id, {
      externalId: "incoming",
      providerMessageId: "source-message",
      externalThreadId: "thread",
      customerId: "customer",
      name: "Test customer",
      body: "Is this available?",
    });
    return { id, inbox };
  }
  it("withdraws a message, cancels derived work, and prevents delayed replay without erasing action identities", async () => {
    const { id, inbox } = await conversation();
    const row = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } });
    const source = await db.prisma.customerMessage.findFirstOrThrow({
      where: { conversationId: id },
    });
    await inbox.steer(owner, { id, guidance: "Use a short answer", nonce: "before-withdrawal" });
    await db.prisma.customerToolCall.create({
      data: {
        messageId: source.id,
        callId: "read",
        requestHash: "read",
        name: "Read stock",
        status: "completed",
        result: { private: source.body },
        replyBody: source.body,
      },
    });
    await db.prisma.customerConversation.update({
      where: { id },
      data: {
        draftText: source.body,
        draftForSeq: 1,
      },
    });
    await db.prisma.customerMessage.create({
      data: {
        conversationId: id,
        seq: 2,
        role: "bot",
        body: source.body,
        status: "queued",
      },
    });
    await inbox.withdraw(row.channelId, {
      externalThreadId: "thread",
      providerMessageId: "source-message",
    });
    expect(await db.prisma.customerMessage.findUnique({ where: { id: source.id } })).toMatchObject({
      body: "",
      status: "withdrawn",
      executionKeyHash: null,
    });
    expect(
      await db.prisma.customerToolCall.findUnique({
        where: { messageId_callId: { messageId: source.id, callId: "read" } },
      }),
    ).toMatchObject({ status: "completed", result: null, replyBody: null });
    expect(await db.prisma.learningTask.count({ where: { conversationId: id } })).toBe(0);
    expect(await db.prisma.customerConversation.findUnique({ where: { id } })).toMatchObject({
      owner: "staff",
      needsHuman: true,
      draftText: null,
      draftForSeq: null,
    });
    const snapshot = await createCustomerRepos(db.prisma).snapshot(owner, id);
    expect(snapshot.messages.some((m) => m.id === source.id)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(source.body);
    const original = {
      externalId: "incoming",
      providerMessageId: "source-message",
      externalThreadId: "thread",
      customerId: "customer",
      name: "Customer",
      body: source.body,
    };
    await expect(inbox.receive(row.channelId, original)).rejects.toThrow("withdrawn");
    await expect(
      inbox.receive(row.channelId, { ...original, externalId: "redelivery" }),
    ).rejects.toThrow("withdrawn");
    await expect(
      inbox.receive(row.channelId, { ...original, externalThreadId: "other" }),
    ).resolves.toBeTypeOf("string");
    await inbox.steer(owner, { id, guidance: "Keep a short answer", nonce: "after-withdrawal" });
    expect(
      JSON.stringify(await db.prisma.learningTask.findMany({ where: { conversationId: id } })),
    ).not.toContain(source.body);
  });

  it("remembers out-of-order withdrawals without creating a case, and serializes receive races", async () => {
    const { id, inbox } = await conversation();
    const { channelId } = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } });
    const target = { externalThreadId: "not-yet-received", providerMessageId: "later" };
    await inbox.withdraw(channelId, target);
    await inbox.withdraw(channelId, target);
    expect(await db.prisma.customerConversation.count({ where: { channelId } })).toBe(1);
    const message = {
      ...target,
      externalId: "later-event",
      customerId: "customer",
      name: "Customer",
      body: "private text",
    };
    await expect(inbox.receive(channelId, message)).rejects.toThrow("withdrawn");
    const racing = { ...message, externalThreadId: "race", providerMessageId: "race" };
    const result = await Promise.allSettled([
      inbox.receive(channelId, racing),
      inbox.withdraw(channelId, racing),
    ]);
    expect(result[1]!.status).toBe("fulfilled");
    expect(
      await db.prisma.customerMessage.count({
        where: { conversation: { channelId }, body: "private text" },
      }),
    ).toBe(0);
    expect(await db.prisma.customerMessageWithdrawal.count({ where: { channelId } })).toBe(2);
    await db.prisma.customerChannel.delete({ where: { id: channelId } });
    expect(await db.prisma.customerMessageWithdrawal.count({ where: { channelId } })).toBe(0);
  });

  it("fences stale withdrawal mappings and scopes matching to the channel and thread", async () => {
    const { id, inbox } = await conversation();
    const { channelId } = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } });
    const target = { externalThreadId: "thread", providerMessageId: "source-message" };
    await expect(inbox.withdraw(channelId, target, new Date(0))).rejects.toThrow(
      "configuration changed",
    );
    expect(await db.prisma.customerMessageWithdrawal.count({ where: { channelId } })).toBe(0);
    await inbox.withdraw(channelId, { ...target, externalThreadId: "other" });
    expect(
      await db.prisma.customerMessage.findFirst({ where: { conversationId: id } }),
    ).toMatchObject({ body: "Is this available?" });
    await db.prisma.customerChannel.update({ where: { id: channelId }, data: { enabled: false } });
    await inbox.withdraw(channelId, target);
    expect(
      await db.prisma.customerMessage.findFirst({ where: { conversationId: id } }),
    ).toMatchObject({ body: "", status: "withdrawn" });
  });
  it("preserves idle ownership and earlier rejection history unrelated to a withdrawal", async () => {
    const { id, inbox } = await conversation();
    await inbox.steer(owner, { id, guidance: "Keep the previous wording", nonce: "earlier" });
    const previous = await db.prisma.learningTask.findFirstOrThrow({
      where: { conversationId: id },
    });
    await db.prisma.learningTask.update({
      where: { id: previous.id },
      data: { status: "rejected", rejectedAt: new Date(), inferenceKey: "rejected-inference" },
    });
    await db.prisma.learningTaskReview.create({
      data: {
        taskId: previous.id,
        userId: owner.userId,
        decision: "reject",
        reason: "Not our voice",
      },
    });
    const { channelId } = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } });
    await inbox.receive(channelId, {
      externalId: "later",
      providerMessageId: "later",
      externalThreadId: "thread",
      customerId: "customer",
      name: "Customer",
      body: "Withdraw this only",
    });
    await inbox.steer(owner, { id, guidance: "Later correction", nonce: "later" });
    await db.prisma.customerMessage.updateMany({
      where: { conversationId: id },
      data: { status: "received" },
    });
    await inbox.withdraw(channelId, { externalThreadId: "thread", providerMessageId: "later" });
    expect(await db.prisma.customerConversation.findUnique({ where: { id } })).toMatchObject({
      owner: "bot",
      needsHuman: false,
      handoffReason: null,
    });
    expect(await db.prisma.learningTask.findMany({ where: { conversationId: id } })).toMatchObject([
      { id: previous.id, inferenceKey: "rejected-inference", status: "rejected" },
    ]);
    expect(await db.prisma.learningTaskReview.count({ where: { taskId: previous.id } })).toBe(1);
    expect(
      await db.prisma.customerMessage.findFirst({
        where: { conversationId: id, externalId: "in:incoming" },
      }),
    ).toMatchObject({ body: "Is this available?" });
  });
  it("backfills a provider message handle on an authenticated legacy redelivery without duplicating it", async () => {
    const { id, inbox } = await conversation();
    const { channelId } = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } });
    await db.prisma.customerMessage.updateMany({
      where: { conversationId: id },
      data: { providerHandle: null },
    });
    const original = {
      externalId: "incoming",
      providerMessageId: "source-message",
      externalThreadId: "thread",
      customerId: "customer",
      name: "Test customer",
      body: "Is this available?",
    };
    await inbox.receive(channelId, original);
    expect(await db.prisma.customerMessage.count({ where: { conversationId: id } })).toBe(1);
    await expect(
      inbox.receive(channelId, { ...original, providerMessageId: "different" }),
    ).rejects.toThrow("already used");
    await inbox.withdraw(channelId, original);
    expect(
      await db.prisma.customerMessage.findFirst({ where: { conversationId: id } }),
    ).toMatchObject({ body: "", status: "withdrawn" });
  });
  async function teammate() {
    const { organizationId } = await db.prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
    });
    await db.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId: stranger.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const bot = await db.prisma.bot.create({
      data: { spaceId: owner.spaceId, userId: stranger.userId, name: "Teammate", color: "blue" },
    });
    return { spaceId: owner.spaceId, userId: stranger.userId, botId: bot.id };
  }
  it("archives original imports once, enforces private evidence access and retains removal coverage", async () => {
    const learning = createLearning(db.prisma);
    const input = {
      botId: owner.botId,
      format: "json" as const,
      source: "Synthetic shop export",
      windowEnd: "2026-09-18T00:00:00Z",
      content: JSON.stringify([
        {
          thread_id: "one",
          message_id: "reply",
          sent_at: "2026-09-17T00:00:00Z",
          author_role: "business",
          text: "ยินดีช่วยค่ะ",
        },
        {
          thread_id: "one",
          sent_at: "2026-09-17T00:00:00Z",
          author_role: "customer",
          text: "PRIVATE CUSTOMER FACT",
        },
      ]),
    };
    const archived = await learning.archive(owner, input);
    expect((await learning.archive(owner, input)).sourceId).toBe(archived.sourceId);
    expect(
      (await learning.archive(owner, { ...input, windowEnd: "2026-09-18T01:00:00Z" })).sourceId,
    ).toBe(archived.sourceId);
    expect(await db.prisma.learningImport.count({ where: { botId: owner.botId } })).toBe(1);
    const sourceRef = { kind: "import" as const, id: archived.sourceId };
    await learning.save(owner, { ...doc(), sourceRef });
    const state = await learning.state(owner, owner.botId);
    const revisionId = state.history[0]!.id;
    expect(state.history[0]!.hasEvidence).toBe(true);
    const evidence = await learning.evidence(owner, { botId: owner.botId, revisionId });
    expect(evidence.content).toBe(input.content);
    expect(evidence.coverage).toMatchObject({ accepted: 1, skipped: 1 });
    const peer = await teammate();
    expect((await learning.state(peer, peer.botId)).documents).toHaveLength(1);
    expect((await learning.state(peer, peer.botId)).history[0]!.hasEvidence).toBe(false);
    await expect(
      learning.undo(peer, {
        botId: peer.botId,
        documentId: state.documents[0]!.id,
        revision: 1,
        expectedRevision: 1,
        reason: "Member cannot change shared guidance",
      }),
    ).rejects.toThrow();
    await expect(learning.evidence(peer, { botId: peer.botId, revisionId })).rejects.toThrow();
    await expect(
      learning.save(peer, { ...doc(), botId: peer.botId, scope: "bot", sourceRef }),
    ).rejects.toThrow();
    await expect(
      learning.withdraw(peer, { botId: peer.botId, sourceId: archived.sourceId }),
    ).rejects.toThrow();
    await learning.withdraw(owner, { botId: owner.botId, sourceId: archived.sourceId });
    expect(await learning.evidence(owner, { botId: owner.botId, revisionId })).toMatchObject({
      withdrawn: true,
      content: "",
      coverage: { accepted: 1 },
    });
    await expect(
      learning.save(owner, { ...doc(), expectedRevision: 1, sourceRef }),
    ).rejects.toThrow("removed");
    await expect(learning.archive(owner, input)).rejects.toThrow("removed");
    await expect(
      learning.archive(owner, {
        ...input,
        content: JSON.stringify(JSON.parse(input.content).reverse(), null, 2),
      }),
    ).rejects.toThrow("removed");
    await expect(
      learning.archive(owner, { ...input, windowEnd: "2026-09-18T02:00:00Z" }),
    ).rejects.toThrow("removed");
    expect((await learning.state(owner, owner.botId)).documents[0]!.content).toBe(doc().content);
    await learning.undo(owner, {
      botId: owner.botId,
      documentId: state.documents[0]!.id,
      revision: 1,
      expectedRevision: 1,
      reason: "Remove derived examples too",
    });
    expect(await learning.customerContext(owner.spaceId, owner.botId)).toBe("");
  });
  it("rechecks original conversation permissions and stops learning from disabled channels", async () => {
    const { id, inbox } = await conversation();
    const learning = createLearning(db.prisma);
    await inbox.steer(owner, {
      id,
      nonce: "source",
      guidance: "Use short replies in this situation",
    });
    const sourceRef = { kind: "conversation" as const, id };
    await learning.save(owner, { ...doc(), sourceRef });
    const state = await learning.state(owner, owner.botId);
    const revisionId = state.history[0]!.id;
    expect((await learning.evidence(owner, { botId: owner.botId, revisionId })).content).toContain(
      "Use short replies",
    );
    const peer = await teammate();
    await expect(learning.evidence(peer, { botId: peer.botId, revisionId })).rejects.toThrow();
    const row = await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } });
    await db.prisma.customerChannel.update({
      where: { id: row.channelId },
      data: { shared: true },
    });
    expect((await learning.evidence(peer, { botId: peer.botId, revisionId })).kind).toBe(
      "conversation",
    );
    await db.prisma.customerChannel.update({
      where: { id: row.channelId },
      data: { shared: false, enabled: false },
    });
    await expect(learning.evidence(peer, { botId: peer.botId, revisionId })).rejects.toThrow();
    await expect(
      learning.save(owner, { ...doc(), expectedRevision: 1, sourceRef }),
    ).rejects.toThrow("disconnected");
    await db.prisma.customerConversation.delete({ where: { id } });
    await expect(learning.evidence(owner, { botId: owner.botId, revisionId })).rejects.toThrow();
    expect((await learning.state(owner, owner.botId)).history[0]!.hasEvidence).toBe(false);
    await expect(
      learning.save(owner, { ...doc(), expectedRevision: 1, sourceRef }),
    ).rejects.toThrow();
    await learning.undo(owner, {
      botId: owner.botId,
      documentId: state.documents[0]!.id,
      revision: 1,
      expectedRevision: 1,
      reason: "Remove guidance after its original case was deleted",
    });
    expect(await learning.customerContext(owner.spaceId, owner.botId)).toBe("");
    await learning.restore(owner, {
      botId: owner.botId,
      documentId: state.documents[0]!.id,
      revision: 1,
      expectedRevision: 2,
    });
    expect(await learning.customerContext(owner.spaceId, owner.botId)).toContain(doc().content);
  });
  it("steers a pending reply, deduplicates retries and keeps guidance out of customer messages", async () => {
    const { id, inbox } = await conversation();
    const input = {
      id,
      guidance: "Offer the blue SKU only in this conversation",
      nonce: "guidance",
    };
    expect(await inbox.steer(owner, input)).toEqual({
      applied: true,
      inFlight: false,
      queued: true,
    });
    await inbox.steer(owner, input);
    const snapshot = await createCustomerRepos(db.prisma).snapshot(owner, id);
    expect(snapshot.guidance).toHaveLength(1);
    expect(snapshot.messages.some((m) => m.body.includes("blue SKU"))).toBe(false);
    const message = await db.prisma.customerMessage.findFirstOrThrow({
      where: { conversationId: id },
    });
    expect(message).toMatchObject({ status: "queued", generation: 1 });
    await expect(inbox.steer(stranger, { ...input, nonce: "other" })).rejects.toThrow();
  });
  it("never replays a turn after a tool action or lets stale customer-visible knowledge dispatch", async () => {
    const { id, inbox } = await conversation();
    const message = await db.prisma.customerMessage.findFirstOrThrow({
      where: { conversationId: id },
    });
    await db.prisma.customerToolCall.create({
      data: {
        messageId: message.id,
        callId: "order",
        requestHash: "order",
        status: "completed",
        name: "Create order",
      },
    });
    expect(await inbox.steer(owner, { id, guidance: "Change the tone", nonce: "once" })).toEqual({
      applied: true,
      inFlight: true,
      queued: false,
    });
    expect(
      (await db.prisma.customerMessage.findUniqueOrThrow({ where: { id: message.id } })).status,
    ).toBe("cancelled");
    await createLearning(db.prisma).save(owner, doc());
    expect((await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } })).owner).toBe(
      "bot",
    );
  });
  it("raises attention for pending work when customer learning changes without pausing idle conversations", async () => {
    const { id } = await conversation();
    await createLearning(db.prisma).save(owner, doc());
    expect(await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { owner: "staff", needsHuman: true },
    );
    expect(
      await db.prisma.customerMessage.findFirstOrThrow({
        where: { conversationId: id, role: "customer" },
      }),
    ).toMatchObject({ status: "cancelled" });
  });
  it("deletes bot learning and its audit when the bot is removed, preserving shared Space guidance", async () => {
    const learning = createLearning(db.prisma);
    const shared = await learning.save(owner, doc());
    const override = await learning.save(owner, { ...doc(), scope: "bot" });
    await db.prisma.bot.delete({ where: { id: owner.botId } });
    expect(await db.prisma.learningDocument.findUnique({ where: { id: override.id } })).toBeNull();
    expect(await db.prisma.learningRevision.count({ where: { documentId: override.id } })).toBe(0);
    expect(
      await db.prisma.learningDocument.findUnique({ where: { id: shared.id } }),
    ).not.toBeNull();
  });
});
