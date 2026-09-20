import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSkillMd, expandSkillReferencesInPrompt, parseSkillMd } from "@rakazo/core";
import type { AccountExportRecord } from "@rakazo/db";
import {
  createAgentSkillStore,
  createDb,
  provisionMessagingIdentity,
  writeAccountExport,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentSkillsService } from "../../../apps/api/src/agent-skills.js";
import {
  invokeSkillTool,
  listAgentSkillRecords,
  parseSkillMutation,
  validateSkillMutation,
} from "../../adapters/src/skill-tools.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const content = (body: string, name = "Review", description = "Review a patch") =>
  buildSkillMd({ name, description, body, frontmatter: { compatibility: "offline" } });
describe.skipIf(!enabled)("private executable skill audit", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let store: ReturnType<typeof createAgentSkillStore>;
  const actor = () => ({ userId: owner.userId, spaceId: owner.spaceId });
  const input = (skillId: string, revision: number, expectedRevision: number) => ({
    skillId,
    revision,
    expectedRevision,
    reason: "Synthetic correction",
  });
  const create = (body = "Greeting: hello\n\nDelivery: verify", name = "Review") =>
    store.create(actor(), { content: content(body, name), reason: "Reusable review" });
  const identity = () =>
    provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    owner = await identity();
    store = createAgentSkillStore(db.prisma, ["Interrogate"]);
  });
  afterEach(async () => {
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.space.deleteMany({ where: { id: owner.spaceId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
  });
  it("selectively reverses an edit and executes the current recipe with later unrelated changes", async () => {
    const first = await create();
    await store.update(actor(), {
      skillId: first.id,
      expectedRevision: 1,
      body: "Greeting: welcome\n\nDelivery: verify",
    });
    await store.update(actor(), {
      skillId: first.id,
      expectedRevision: 2,
      body: "Greeting: welcome\n\nDelivery: ask staff",
    });
    const change = await store.previewUndo(actor(), input(first.id, 2, 3));
    expect(change).toMatchObject({
      conflict: false,
      proposed: { removed: false, content: content("Greeting: hello\n\nDelivery: ask staff") },
    });
    await store.undo(actor(), {
      ...input(first.id, 2, 3),
      reviewedContent: change.proposed.content,
      reviewedRemoved: false,
    });
    const future = expandSkillReferencesInPrompt(
      "Use @Review for this",
      await listAgentSkillRecords(db.prisma, actor()),
    );
    expect(future).toContain("Greeting: hello");
    expect(future).toContain("Delivery: ask staff");
    expect(future).not.toContain("welcome");
    expect((await store.history(actor(), { skillId: first.id })).items[0]).toMatchObject({
      revision: 4,
      operation: "undo",
      actor: "Staff",
      undoneRevision: 2,
      restoredFrom: 1,
    });
  });
  it("requires explicit resolutions for overlap, including undo of an edited creation", async () => {
    const first = await create("Hello");
    await store.update(actor(), { skillId: first.id, expectedRevision: 1, body: "Welcome" });
    await store.update(actor(), { skillId: first.id, expectedRevision: 2, body: "Good day" });
    expect(await store.previewUndo(actor(), input(first.id, 2, 3))).toMatchObject({
      conflict: true,
    });
    await expect(store.undo(actor(), input(first.id, 2, 3))).rejects.toThrow("overlap");
    await expect(store.undo(actor(), input(first.id, 1, 3))).rejects.toThrow("overlap");
    const resolution = { content: content("Hello, good day"), removed: false };
    await store.undo(actor(), {
      ...input(first.id, 2, 3),
      resolution,
      reviewedContent: resolution.content,
      reviewedRemoved: false,
    });
    expect((await store.get(actor(), first.id)).content).toBe(resolution.content);
    await expect(
      store.update(actor(), { skillId: first.id, expectedRevision: 3, body: "Stale" }),
    ).rejects.toThrow("changed");
    await expect(store.restore(actor(), input(first.id, 1, 3))).rejects.toThrow("changed");
  });
  it("removes executable recipes immediately while keeping history and allows undo or restore", async () => {
    const first = await create("Only recipe");
    await store.remove(actor(), {
      skillId: first.id,
      expectedRevision: 1,
      reviewedContent: first.content,
    });
    expect(
      (await listAgentSkillRecords(db.prisma, actor())).some((row) => row.id === first.id),
    ).toBe(false);
    expect(
      expandSkillReferencesInPrompt("Use @Review", await listAgentSkillRecords(db.prisma, actor())),
    ).not.toContain("Only recipe");
    expect((await store.listHistory(actor(), { includeRemoved: true })).items).toContainEqual(
      expect.objectContaining({ id: first.id, removed: true }),
    );
    expect((await store.history(actor(), { skillId: first.id })).items).toHaveLength(2);
    await store.undo(actor(), input(first.id, 2, 2));
    expect((await store.get(actor(), first.id)).revision).toBe(3);
    await store.undo(actor(), input(first.id, 1, 3));
    await expect(store.get(actor(), first.id)).rejects.toThrow();
    await store.restore(actor(), input(first.id, 1, 4));
    expect((await store.get(actor(), first.id)).revision).toBe(5);
  });
  it("does not overwrite a replacement with the same name during restoration", async () => {
    const first = await create();
    await store.remove(actor(), { skillId: first.id, expectedRevision: 1 });
    const replacement = await create("New recipe", "review");
    await expect(store.restore(actor(), input(first.id, 1, 2))).rejects.toThrow("already exists");
    expect((await store.get(actor(), replacement.id)).content).toContain("New recipe");
    expect((await store.history(actor(), { skillId: first.id })).revision).toBe(2);
  });
  it("records exact reviewed historical text without silently reformatting it", async () => {
    const legacyText =
      "---\nname: Review\ndescription: >-\n  Review a patch\n---\n\nUnformatted legacy body\n";
    const legacy = await db.prisma.agentSkill.create({
      data: {
        ...actor(),
        name: "Review",
        description: "Review a patch",
        content: legacyText,
        source: "user",
      },
    });
    await store.update(actor(), { skillId: legacy.id, expectedRevision: 1, body: "New body" });
    await expect(store.undo(actor(), input(legacy.id, 1, 2))).rejects.toThrow("preceding");
    await expect(
      store.restore(actor(), { ...input(legacy.id, 1, 2), reviewedContent: "Wrong text" }),
    ).rejects.toThrow("reviewed");
    await validateSkillMutation(db.prisma, actor(), "skill_restore", {
      ...input(legacy.id, 1, 2),
      reviewedContent: legacyText,
      reviewedRemoved: false,
    });
    await invokeSkillTool(db.prisma, actor(), "skill_restore", {
      ...input(legacy.id, 1, 2),
      reviewedContent: legacyText,
      reviewedRemoved: false,
    });
    expect((await store.get(actor(), legacy.id)).content).toBe(legacyText);
  });
  it("uses the same store through API and tools, preserves frontmatter, and binds tool content and revisions", async () => {
    const api = createAgentSkillsService(db.prisma);
    const staff = { ...actor(), email: "synthetic@example.test", isDeploymentOwner: false };
    const first = await api.create(staff, { content: content("First") });
    await api.update(staff, { skillId: first.id, expectedRevision: 1, body: "Second" });
    const proposed = parseSkillMutation("skill_update", {
      skillId: first.id,
      expectedRevision: 2,
      content: content("Third", "Renamed"),
      reason: "Rename recipe",
    });
    await validateSkillMutation(db.prisma, actor(), "skill_update", proposed);
    await invokeSkillTool(db.prisma, actor(), "skill_update", proposed);
    const row = await api.get(staff, { skillId: first.id });
    expect(row).toMatchObject({ revision: 3, name: "Renamed" });
    expect(parseSkillMd(row.content)).toMatchObject({ frontmatter: { compatibility: "offline" } });
    await expect(
      invokeSkillTool(db.prisma, actor(), "skill_delete", {
        skillId: first.id,
        expectedRevision: 3,
        reviewedContent: "Wrong",
        reason: "Remove",
      }),
    ).rejects.toThrow("reviewed");
    await api.remove(staff, { skillId: first.id, expectedRevision: 3 });
    expect(
      (await store.history(actor(), { skillId: first.id })).items.map((entry) => entry.operation),
    ).toEqual(["remove", "update", "update", "create"]);
  });
  it.each(["plugin", "builtin"])(
    "rejects %s writes and preserves legacy builtin shadows",
    async (source) => {
      const row = await db.prisma.agentSkill.create({
        data: {
          ...actor(),
          name: " Interrogate ",
          description: "Legacy recipe",
          content: content("Legacy", "Interrogate"),
          source,
        },
      });
      expect(
        (await listAgentSkillRecords(db.prisma, actor())).find(
          (skill) => skill.name.trim() === "Interrogate",
        ),
      ).toMatchObject({ id: row.id, readOnly: true });
      await expect(
        store.update(actor(), { skillId: row.id, expectedRevision: 1, body: "Wrong" }),
      ).rejects.toThrow("read-only");
      await expect(store.remove(actor(), { skillId: row.id, expectedRevision: 1 })).rejects.toThrow(
        "read-only",
      );
      await expect(
        store.create(actor(), { content: content("Wrong", "interrogate") }),
      ).rejects.toThrow("builtin");
    },
  );
  it("keeps legacy user shadows editable, without allowing new builtin-name collisions", async () => {
    const row = await db.prisma.agentSkill.create({
      data: {
        ...actor(),
        name: " Interrogate ",
        description: "Legacy",
        content: content("Legacy", "Interrogate"),
        source: "user",
      },
    });
    await store.update(actor(), { skillId: row.id, expectedRevision: 1, body: "Updated" });
    expect(
      (await listAgentSkillRecords(db.prisma, actor())).find(
        (skill) => skill.name === "Interrogate",
      ),
    ).toMatchObject({ id: row.id, readOnly: false });
    const other = await create();
    await expect(
      store.update(actor(), { skillId: other.id, expectedRevision: 1, name: "Interrogate" }),
    ).rejects.toThrow("builtin");
  });
  it("pins chunk reads to a revision, bounds history previews and traverses removed documents", async () => {
    const first = await create("A".repeat(6000));
    const read = await invokeSkillTool(db.prisma, actor(), "skill_read", { skillId: first.id });
    expect(read).toMatchObject({ revision: 1, nextOffset: 1000 });
    await store.update(actor(), { skillId: first.id, expectedRevision: 1, body: "B".repeat(6000) });
    expect(
      await invokeSkillTool(db.prisma, actor(), "skill_read", {
        skillId: first.id,
        revision: 1,
        offset: 1000,
      }),
    ).toMatchObject({ content: "A".repeat(1000) });
    const preview = await invokeSkillTool(db.prisma, actor(), "skill_preview_undo", {
      skillId: first.id,
      expectedRevision: 2,
      revision: 2,
    });
    expect(JSON.stringify(preview).length).toBeLessThan(2000);
    for (let index = 0; index < 11; index++) await create("Other", `Other ${index}`);
    const page = await store.listHistory(actor(), {});
    expect(page.items).toHaveLength(10);
    expect((await store.listHistory(actor(), { cursor: page.nextCursor })).items).toHaveLength(2);
    await expect(
      validateSkillMutation(db.prisma, actor(), "skill_restore", {
        ...input(first.id, 1, 2),
        reviewedContent: first.content.slice(0, 1000),
        reviewedRemoved: false,
      }),
    ).rejects.toThrow("reviewed");
  });
  it.each(["membership", "deletion"])(
    "revokes reads and writes after %s removal",
    async (change) => {
      const first = await create();
      if (change === "membership") await db.prisma.spaceMember.deleteMany({ where: actor() });
      else await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
      for (const operation of [
        () => store.list(actor()),
        () => store.listHistory(actor(), {}),
        () => store.get(actor(), first.id),
        () => store.history(actor(), { skillId: first.id }),
        () => store.readVersion(actor(), { skillId: first.id }),
        () => create("Wrong"),
        () => store.update(actor(), { skillId: first.id, expectedRevision: 1, body: "Wrong" }),
        () => store.remove(actor(), { skillId: first.id, expectedRevision: 1 }),
        () => store.restore(actor(), input(first.id, 1, 1)),
        () => store.undo(actor(), input(first.id, 1, 1)),
        () => listAgentSkillRecords(db.prisma, actor()),
      ])
        await expect(operation()).rejects.toThrow();
      expect(
        (await db.prisma.agentSkill.findUniqueOrThrow({ where: { id: first.id } })).revision,
      ).toBe(1);
    },
  );
  it("enforces ownership and rejects forged or archived agent provenance", async () => {
    const first = await create();
    const other = await identity();
    try {
      const foreign = { userId: other.userId, spaceId: other.spaceId };
      for (const operation of [
        () => store.history(foreign, { skillId: first.id }),
        () => store.readVersion(foreign, { skillId: first.id }),
        () => store.undo(foreign, input(first.id, 1, 1)),
        () => store.restore(foreign, input(first.id, 1, 1)),
        () => store.update(foreign, { skillId: first.id, expectedRevision: 1, body: "Wrong" }),
        () => store.remove(foreign, { skillId: first.id, expectedRevision: 1 }),
        () => store.listHistory(foreign, { cursor: first.id }),
      ])
        await expect(operation()).rejects.toThrow();
      expect(
        (await listAgentSkillRecords(db.prisma, foreign)).some((row) => row.id === first.id),
      ).toBe(false);
      await expect(
        store.create({ ...actor(), botId: other.botId }, { content: content("Wrong") }),
      ).rejects.toThrow();
      await expect(
        store.create({ ...actor(), runId: "missing-run" }, { content: content("Wrong") }),
      ).rejects.toThrow();
      await db.prisma.bot.update({ where: { id: owner.botId }, data: { archivedAt: new Date() } });
      await expect(
        store.create({ ...actor(), botId: owner.botId }, { content: content("Wrong") }),
      ).rejects.toThrow();
    } finally {
      await db.prisma.space.delete({ where: { id: other.spaceId } });
      await db.prisma.user.delete({ where: { id: other.userId } });
    }
  });
  it("records actual run provenance, includes revisions in export and cascades account deletion", async () => {
    const thread = await db.prisma.thread.findFirstOrThrow({ where: { botId: owner.botId } });
    const task = await db.prisma.task.create({
      data: {
        ...actor(),
        botId: owner.botId,
        threadId: thread.id,
        prompt: "Synthetic skill correction",
        status: "completed",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        ...actor(),
        botId: owner.botId,
        threadId: thread.id,
        taskId: task.id,
        trigger: "user",
        status: "completed",
      },
    });
    const first = await store.create(
      { ...actor(), botId: owner.botId, runId: run.id },
      { content: content("Synthetic source") },
    );
    expect((await store.history(actor(), { skillId: first.id })).items[0]).toMatchObject({
      actor: expect.stringContaining("Agent"),
      sourceRunId: run.id,
      sourceThreadId: thread.id,
    });
    const records: AccountExportRecord[] = [];
    await writeAccountExport(
      db.prisma,
      owner.userId,
      async (record) => {
        records.push(record);
      },
      async () => "",
      new AbortController().signal,
    );
    expect(records).toContainEqual({
      type: "skillRevision",
      data: expect.objectContaining({ skillId: first.id, revision: 1, content: first.content }),
    });
    await db.prisma.user.delete({ where: { id: owner.userId } });
    expect(await db.prisma.agentSkill.count({ where: { id: first.id } })).toBe(0);
    expect(await db.prisma.agentSkillRevision.count({ where: { skillId: first.id } })).toBe(0);
  });
  it("prevents ambiguous names beside whitespace-padded legacy recipes", async () => {
    await db.prisma.agentSkill.create({
      data: {
        ...actor(),
        name: " Review ",
        description: "Legacy",
        content: content("Legacy"),
        source: "user",
      },
    });
    await expect(create()).rejects.toThrow("already exists");
    const other = await create("Other", "Different");
    await expect(
      store.update(actor(), { skillId: other.id, expectedRevision: 1, name: "Review" }),
    ).rejects.toThrow("already exists");
  });

  it("rolls back content when audit persistence fails", async () => {
    const first = await create();
    const failing = db.prisma.$extends({
      query: {
        agentSkillRevision: {
          async create() {
            throw new Error("Synthetic audit failure");
          },
        },
      },
    });
    await expect(
      createAgentSkillStore(failing as typeof db.prisma, []).update(actor(), {
        skillId: first.id,
        expectedRevision: 1,
        body: "Wrong",
      }),
    ).rejects.toThrow("audit failure");
    expect((await store.get(actor(), first.id)).content).toBe(first.content);
    expect(await db.prisma.agentSkillRevision.count({ where: { skillId: first.id } })).toBe(1);
  });
  it("serializes concurrent updates and first creates without duplicate history", async () => {
    const first = await create();
    const updates = await Promise.allSettled(
      ["Left", "Right"].map((body) =>
        store.update(actor(), { skillId: first.id, expectedRevision: 1, body }),
      ),
    );
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.history(actor(), { skillId: first.id })).items).toHaveLength(2);
    const creates = await Promise.allSettled(
      ["Left", "Right"].map((body) => create(body, "Concurrent")),
    );
    expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.prisma.agentSkill.count({ where: { ...actor(), name: "Concurrent" } })).toBe(1);
  });
  it("migrates populated skills, removes orphans, seeds only known versions and enforces active-name uniqueness", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        'CREATE TEMP TABLE "user" (id TEXT PRIMARY KEY); CREATE TEMP TABLE agent_skills (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "spaceId" TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE UNIQUE INDEX "agent_skills_spaceId_userId_name_lower_key" ON agent_skills ("spaceId", "userId", lower(name));',
      );
      await client.query(
        `INSERT INTO "user" VALUES ('owner'); INSERT INTO agent_skills (id,"userId","spaceId",name,content) VALUES ('legacy','owner','space','Recipe','Known current'), ('orphan','missing','space','Orphan','Inaccessible');`,
      );
      const migration = readFileSync(
        new URL(
          "../../db/prisma/migrations/20260919120000_agent_skill_audit/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ).replace("CREATE TABLE agent_skill_revisions", "CREATE TEMP TABLE agent_skill_revisions");
      await client.query(migration);
      expect((await client.query("SELECT id, revision FROM agent_skills")).rows).toEqual([
        { id: "legacy", revision: 1 },
      ]);
      expect(
        (await client.query("SELECT content, operation FROM agent_skill_revisions")).rows,
      ).toEqual([{ content: "Known current", operation: "baseline" }]);
      await client.query(
        `UPDATE agent_skills SET "removedAt"=CURRENT_TIMESTAMP WHERE id='legacy'; INSERT INTO agent_skills (id,"userId","spaceId",name,content) VALUES ('replacement','owner','space','RECIPE','New current');`,
      );
      await client.query("SAVEPOINT restore_conflict");
      await expect(
        client.query(`UPDATE agent_skills SET "removedAt"=NULL WHERE id='legacy'`),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT restore_conflict");
      await client.query(`DELETE FROM "user" WHERE id='owner'`);
      expect((await client.query("SELECT * FROM agent_skill_revisions")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM agent_skills")).rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
