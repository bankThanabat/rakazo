import { randomUUID } from "node:crypto";
import { PrivateHistorySchema, PrivateHistoryVersionSchema } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import {
  createAgentSkillStore,
  createDb,
  createPrivateHistory,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "../../memory/src/index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("native private history review", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let history: ReturnType<typeof createPrivateHistory>;
  let skills: ReturnType<typeof createAgentSkillStore>;
  const actor = () => ({ userId: owner.userId, spaceId: owner.spaceId });
  const context = () => ({
    ...actor(),
    operationId: "review-test",
    traceId: "review-test",
    signal: new AbortController().signal,
  });
  const skillContent = (body: string) =>
    buildSkillMd({ name: "Review", description: "Synthetic recipe", body });
  const commit = (content: string, expectedRevision?: number) =>
    new MarkdownMemoryStore(db.prisma).commit(
      {
        scope: "bot",
        botId: owner.botId,
        path: "history.md",
        content,
        expectedRevision,
        reason: "Synthetic correction",
      },
      context(),
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
    history = createPrivateHistory(db.prisma, []);
    skills = createAgentSkillStore(db.prisma, []);
  });
  afterEach(async () => {
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });
  it("reviews complete memory versions and applies selective undo without discarding later facts", async () => {
    const suffix = "Synthetic context ".repeat(100);
    const first = await commit(`Greeting: hello\n\nDelivery: verify\n\n${suffix}`);
    await commit(`Greeting: welcome\n\nDelivery: verify\n\n${suffix}`, 1);
    await commit(`Greeting: welcome\n\nDelivery: ask staff\n\n${suffix}`, 2);
    const target = { kind: "memory", id: first.id };
    const meta = PrivateHistorySchema.parse(await history.history(actor(), target));
    expect(meta).toMatchObject({ scope: "bot", botId: owner.botId, revision: 3, readOnly: false });
    const versions = PrivateHistoryVersionSchema.parse(
      await history.version(actor(), { ...target, revision: 2 }),
    );
    expect(versions.before?.content).toBe(first.content);
    expect(versions.after.content.length).toBeGreaterThan(1000);
    const input = {
      ...target,
      revision: 2,
      expectedRevision: 3,
      action: "undo",
      reason: "Correct greeting",
    };
    const preview = await history.preview(actor(), input);
    expect(preview).toMatchObject({
      conflict: false,
      proposed: { content: `Greeting: hello\n\nDelivery: ask staff\n\n${suffix}`, removed: false },
    });
    await expect(
      history.apply(context(), { ...input, reviewed: { ...preview.proposed, content: "Wrong" } }),
    ).rejects.toThrow("reviewed");
    expect(await history.apply(context(), { ...input, reviewed: preview.proposed })).toMatchObject({
      revision: 4,
      ...preview.proposed,
    });
    await expect(
      history.apply(context(), { ...input, reviewed: preview.proposed }),
    ).rejects.toThrow("changed");
  });
  it("refuses to invent before-content for a legacy memory baseline at revision one", async () => {
    const first = await commit("Known content");
    await db.prisma.memoryRevision.update({
      where: { documentId_revision: { documentId: first.id, revision: 1 } },
      data: { actorKind: "unknown", reason: "Imported baseline" },
    });
    const target = { kind: "memory", id: first.id, revision: 1, expectedRevision: 1 };
    expect((await history.history(actor(), target)).items[0]?.canUndo).toBe(false);
    expect((await history.version(actor(), target)).before).toBeNull();
    await expect(history.preview(actor(), { ...target, action: "undo" })).rejects.toThrow(
      "preceding",
    );
    expect(await history.preview(actor(), { ...target, action: "restore" })).toMatchObject({
      proposed: { content: "Known content" },
    });
  });
  it("requires an acknowledged full resolution for overlapping changes", async () => {
    const first = await skills.create(actor(), { content: skillContent("Hello") });
    await skills.update(actor(), { skillId: first.id, expectedRevision: 1, body: "Welcome" });
    await skills.update(actor(), { skillId: first.id, expectedRevision: 2, body: "Good day" });
    const input = {
      kind: "skill",
      id: first.id,
      revision: 2,
      expectedRevision: 3,
      action: "undo",
      reason: "Combine greetings",
    };
    expect((await history.preview(actor(), input)).conflict).toBe(true);
    const reviewed = { content: skillContent("Hello, good day"), removed: false };
    await expect(history.apply(context(), { ...input, reviewed })).rejects.toThrow("overlap");
    expect(
      await history.apply(context(), { ...input, reviewed, resolveConflict: true }),
    ).toMatchObject({ revision: 4, ...reviewed });
    expect((await skills.history(actor(), { skillId: first.id })).items[0]).toMatchObject({
      operation: "undo",
      reason: input.reason,
    });
  });
  it("lists only removed skills and restores the exact selected full version", async () => {
    const first = await skills.create(actor(), {
      content: skillContent("Old recipe ".repeat(100)),
    });
    await skills.remove(actor(), { skillId: first.id, expectedRevision: 1 });
    await skills.create(actor(), { name: "Active", description: "Current", body: "Active recipe" });
    expect((await skills.listHistory(actor(), { removedOnly: true })).items).toEqual([
      expect.objectContaining({ id: first.id, removed: true }),
    ]);
    const input = {
      kind: "skill",
      id: first.id,
      revision: 1,
      expectedRevision: 2,
      action: "restore",
      reason: "Use reviewed recipe",
    };
    const version = await history.version(actor(), input);
    expect(version).toMatchObject({
      before: { content: "", removed: true },
      after: { content: first.content, removed: false },
      current: { removed: true },
    });
    const preview = await history.preview(actor(), input);
    expect(await history.apply(context(), { ...input, reviewed: preview.proposed })).toMatchObject({
      revision: 3,
      content: first.content,
      removed: false,
    });
    expect((await skills.listHistory(actor(), { removedOnly: true })).items).toEqual([]);
  });
  it("retains missing predecessors and read-only provider ownership", async () => {
    const first = await skills.create(actor(), { content: skillContent("First") });
    await skills.update(actor(), { skillId: first.id, expectedRevision: 1, body: "Second" });
    await db.prisma.agentSkillRevision.delete({
      where: { skillId_revision: { skillId: first.id, revision: 1 } },
    });
    const target = {
      kind: "skill",
      id: first.id,
      revision: 2,
      expectedRevision: 2,
      action: "restore",
      reason: "No write",
    };
    expect((await history.version(actor(), target)).before).toBeNull();
    await db.prisma.agentSkill.update({ where: { id: first.id }, data: { source: "plugin" } });
    expect(await history.history(actor(), target)).toMatchObject({ readOnly: true });
    const preview = await history.preview(actor(), target);
    await expect(
      history.apply(context(), { ...target, reviewed: preview.proposed }),
    ).rejects.toThrow("read-only");
  });
  it.each(["membership", "deletion"])(
    "rechecks access for source targets after %s changes between reads",
    async (revocation) => {
      const first = await commit("Private fact");
      const thread = await db.prisma.thread.findFirstOrThrow({
        where: { ...actor(), botId: owner.botId },
      });
      await db.prisma.memoryRevision.update({
        where: { documentId_revision: { documentId: first.id, revision: 1 } },
        data: { sourceThreadId: thread.id },
      });
      const target = { kind: "memory", id: first.id };
      expect((await history.history(actor(), target)).items[0]?.sourceTarget).toMatchObject({
        botId: owner.botId,
        groupId: null,
      });
      const original = db.prisma.$transaction.bind(db.prisma);
      let transactions = 0;
      const revokeBetweenReads = new Proxy(db.prisma, {
        get(client, property, receiver) {
          if (property !== "$transaction") return Reflect.get(client, property, receiver);
          return async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (++transactions === 1) {
              if (revocation === "membership")
                await db.prisma.spaceMember.deleteMany({ where: { ...actor() } });
              else await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
            }
            return result;
          };
        },
      });
      await expect(
        createPrivateHistory(revokeBetweenReads, []).history(actor(), target),
      ).rejects.toThrow();
    },
  );
  it("checks owner and pending deletion on complete-version reads and mutations", async () => {
    const first = await skills.create(actor(), { content: skillContent("Private") });
    const target = {
      kind: "skill",
      id: first.id,
      revision: 1,
      expectedRevision: 1,
      action: "restore",
      reason: "Review",
      reviewed: { content: first.content, removed: false },
    };
    const foreign = { ...context(), userId: randomUUID() };
    for (const operation of [history.history, history.version, history.preview, history.apply]) {
      await expect(operation(foreign, target)).rejects.toThrow();
    }
    await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
    for (const operation of [history.history, history.version, history.preview, history.apply]) {
      await expect(operation(context(), target)).rejects.toThrow();
    }
  });
});
