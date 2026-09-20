import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, pushTokenPath, savePushToken } from "@rakazo/adapters";
import { computerScopeKey } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!available)("account deletion with customer and learning data", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-account-deletion-"));
    await start();
  });
  async function start() {
    // Load the app only after the integration harness has configured its database.
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
    });
  }
  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function signup() {
    const email = `delete-${randomUUID()}@rakazo.test`;
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email,
        name: "Synthetic shop",
        password: "password12",
      }),
    });
    expect(response.status).toBe(200);
    const cookie = sessionCookieHeader(response);
    const me = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ json: {} }),
    });
    expect(me.status).toBe(200);
    const { json } = (await me.json()) as { json: { userId: string; spaceId: string } };
    return { ...json, cookie, email };
  }

  async function seed({ userId, spaceId }: { userId: string; spaceId: string }) {
    const actor = { userId, spaceId };
    const db = handles.prisma;
    const bot = await db.bot.create({
      data: { ...actor, name: "Synthetic support", color: "blue", learningEnabled: false },
    });
    const channel = await db.customerChannel.create({
      data: {
        ...actor,
        botId: bot.id,
        provider: "web",
        accountId: randomUUID(),
        name: "Synthetic shop",
        ciphertext: "",
        enabled: false,
      },
    });
    const conversation = await db.customerConversation.create({
      data: {
        channelId: channel.id,
        customerId: "synthetic-customer",
        externalThreadId: "synthetic-thread",
        name: "Synthetic customer",
        state: "resolved",
        owner: "staff",
        messages: { create: { seq: 1, role: "customer", body: "Sample question" } },
        guidance: {
          create: {
            userId: actor.userId,
            content: "Sample correction",
            inFlight: false,
            nonce: "fixture",
          },
        },
        acknowledgements: { create: { userId: actor.userId, generation: 1, customerSeq: 1 } },
        alertDeliveries: {
          create: {
            attentionId: randomUUID(),
            stage: 0,
            recipientId: actor.userId,
            provider: "fixture",
            status: "uncertain",
          },
        },
        reads: { create: { userId: actor.userId, seq: 1 } },
        visitorSessions: {
          create: { tokenHash: randomUUID(), origin, expiresAt: new Date("2030-01-01") },
        },
      },
    });
    const task = await db.learningTask.create({
      data: {
        ...actor,
        botId: bot.id,
        conversationId: conversation.id,
        sourceKey: "fixture",
        evidence: { correction: "Sample correction" },
        status: "rejected",
        proposal: { content: "Sample rejected inference" },
        rejectedAt: new Date(),
        reviews: {
          create: { userId: actor.userId, decision: "reject", reason: "One-off instruction" },
        },
      },
    });
    const archive = await db.learningImport.create({
      data: {
        ...actor,
        botId: bot.id,
        digest: randomUUID(),
        label: "Synthetic replies",
        format: "json",
        content: '[{"text":"Sample reply"}]',
        coverage: {},
        windowEnd: new Date(),
      },
    });
    const documents = await Promise.all(
      ["space", bot.id].map((scopeKey) =>
        db.learningDocument.create({
          data: {
            spaceId: actor.spaceId,
            botId: scopeKey === "space" ? null : bot.id,
            scopeKey,
            kind: "knowledge",
            key: `voice-${bot.id}`,
            title: "Voice",
            content: "Be clear",
            revisions: {
              create: {
                revision: 1,
                title: "Voice",
                content: "Be clear",
                customerVisible: false,
                userId: actor.userId,
                reason: "Approved example",
                source: "Synthetic replies",
                sourceRef: { kind: "import", id: archive.id },
              },
            },
          },
        }),
      ),
    );
    const operation = await db.customerOperation.create({
      data: {
        id: randomUUID(),
        spaceId: actor.spaceId,
        requestHash: "synthetic-hash",
        status: "uncertain",
        receipt: {
          create: {
            conversationId: conversation.id,
            connectionId: "synthetic-connection",
            action: "create_order",
            recordKey: "synthetic-order",
            mapping: {},
            result: { order: "synthetic-order" },
          },
        },
      },
    });
    const memory = await db.memoryDocument.create({
      data: {
        ...actor,
        scope: "user",
        path: `private-${bot.id}.md`,
        content: "Private preference",
        revisions: { create: { revision: 1, content: "Private preference" } },
      },
    });
    await db.notificationPreference.upsert({
      where: { spaceId_userId: actor },
      update: { customerQuietHours: { timeZone: "Asia/Bangkok", start: "22:00", end: "08:00" } },
      create: { ...actor, help: false },
    });
    await savePushToken(dataDir, actor.userId, "ExponentPushToken[synthetic]");
    return { bot, channel, conversation, task, archive, documents, operation, memory };
  }

  async function counts(fixture: Awaited<ReturnType<typeof seed>>) {
    const db = handles.prisma;
    const conversationId = fixture.conversation.id;
    const documentIds = fixture.documents.map(({ id }) => id);
    const queries = {
      bot: db.bot.count({ where: { id: fixture.bot.id } }),
      channel: db.customerChannel.count({ where: { id: fixture.channel.id } }),
      conversation: db.customerConversation.count({ where: { id: conversationId } }),
      messages: db.customerMessage.count({ where: { conversationId } }),
      guidance: db.customerGuidance.count({ where: { conversationId } }),
      acknowledgements: db.customerAcknowledgement.count({ where: { conversationId } }),
      deliveries: db.customerAlertDelivery.count({ where: { conversationId } }),
      reads: db.customerConversationRead.count({ where: { conversationId } }),
      visitors: db.customerVisitorSession.count({ where: { conversationId } }),
      tasks: db.learningTask.count({ where: { id: fixture.task.id } }),
      reviews: db.learningTaskReview.count({ where: { taskId: fixture.task.id } }),
      archive: db.learningImport.count({ where: { id: fixture.archive.id } }),
      documents: db.learningDocument.count({ where: { id: { in: documentIds } } }),
      revisions: db.learningRevision.count({ where: { documentId: { in: documentIds } } }),
      operations: db.customerOperation.count({ where: { id: fixture.operation.id } }),
      receipts: db.customerOperationReceipt.count({ where: { operationId: fixture.operation.id } }),
      memory: db.memoryDocument.count({ where: { id: fixture.memory.id } }),
      memoryRevisions: db.memoryRevision.count({ where: { documentId: fixture.memory.id } }),
      preferences: db.notificationPreference.count({ where: { userId: fixture.bot.userId } }),
    };
    return Object.fromEntries(
      await Promise.all(Object.entries(queries).map(async ([key, value]) => [key, await value])),
    );
  }

  it.each([false, true])(
    "deletes private V1 records and preserves other users, shared Space: %s",
    async (shared) => {
      const owner = await signup();
      const other = await signup();
      const db = handles.prisma;
      if (shared) {
        const space = await db.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
        await db.member.create({
          data: {
            id: randomUUID(),
            organizationId: space.organizationId,
            userId: other.userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
        await db.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: space.id, userId: other.userId } },
          update: { role: "owner" },
          create: {
            id: randomUUID(),
            organizationId: space.organizationId,
            spaceId: space.id,
            userId: other.userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
      }
      const removed = await seed(owner);
      const retained = await seed({ ...other, spaceId: shared ? owner.spaceId : other.spaceId });
      // A private read marker on a surviving shared case must be removed too.
      if (shared) {
        await db.customerConversationRead.create({
          data: { conversationId: retained.conversation.id, userId: owner.userId, seq: 1 },
        });
        await db.customerConversation.update({
          where: { id: retained.conversation.id },
          data: { assigneeId: owner.userId },
        });
      }
      const before = await counts(removed);
      expect(Object.values(before).every((count) => count > 0)).toBe(true);
      const retainedBefore = await counts(retained);
      const remove = (password: string) =>
        handles.app.request("/api/auth/delete-user", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: owner.cookie, origin },
          body: JSON.stringify({ password }),
        });
      expect((await remove("wrong-password")).status).toBeGreaterThanOrEqual(400);
      expect(await counts(removed)).toEqual(before);
      expect(await db.accountDeletion.count({ where: { userId: owner.userId } })).toBe(0);
      expect(existsSync(pushTokenPath(dataDir, owner.userId))).toBe(true);

      const response = await remove("password12");
      expect(response.status, await response.text()).toBe(202);
      await expect.poll(() => db.user.count({ where: { id: owner.userId } })).toBe(0);
      expect(await db.user.count({ where: { id: owner.userId } })).toBe(0);
      expect(await db.session.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await db.account.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await db.space.count({ where: { id: owner.spaceId } })).toBe(shared ? 1 : 0);
      const expected = Object.fromEntries(Object.keys(before).map((key) => [key, 0]));
      // Shared brand guidance and opaque duplicate-prevention records belong to the
      // business. Deleting one staff account must not erase them or repeat a sale.
      if (shared) Object.assign(expected, { documents: 1, revisions: 1, operations: 1 });
      expect(await counts(removed)).toEqual(expected);
      expect(await counts(retained)).toEqual({ ...retainedBefore, reads: 1 });
      if (shared) {
        // An already-authorized request cannot recreate private data after the
        // account disappears, even though the Space and shared case still exist.
        for (const write of [
          () =>
            db.memoryDocument.create({
              data: {
                userId: owner.userId,
                spaceId: owner.spaceId,
                scope: "user",
                path: "late.md",
                content: "Late write",
              },
            }),
          () =>
            db.notificationPreference.create({
              data: { userId: owner.userId, spaceId: owner.spaceId },
            }),
          () =>
            db.customerConversationRead.create({
              data: { userId: owner.userId, conversationId: retained.conversation.id },
            }),
          () =>
            db.customerConversation.update({
              where: { id: retained.conversation.id },
              data: { assigneeId: owner.userId },
            }),
        ])
          await expect(write()).rejects.toMatchObject({ code: "P2003" });
        expect(
          await db.customerConversation.findUnique({ where: { id: retained.conversation.id } }),
        ).toMatchObject({ assigneeId: null });
        const rpc = async (procedure: string, input: unknown) => {
          const response = await handles.app.request(`/rpc/learning/${procedure}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: other.cookie,
              origin,
              "x-rakazo-space-id": owner.spaceId,
            },
            body: JSON.stringify({ json: input }),
          });
          expect(response.status, await response.clone().text()).toBe(200);
          return (await response.json()).json;
        };
        const botId = retained.bot.id;
        const documentId = removed.documents[0]!.id;
        const state = await rpc("state", { botId });
        expect(
          state.history.find(
            (revision: { documentId: string }) => revision.documentId === documentId,
          ),
        ).toMatchObject({ hasEvidence: false });
        await rpc("undo", {
          botId,
          documentId,
          revision: 1,
          expectedRevision: 1,
          reason: "Remove the departed member's learned style",
        });
        expect(await db.learningDocument.findUnique({ where: { id: documentId } })).toMatchObject({
          content: "",
          revision: 2,
        });
        await rpc("restore", { botId, documentId, revision: 1, expectedRevision: 2 });
        expect(await db.learningDocument.findUnique({ where: { id: documentId } })).toMatchObject({
          content: "Be clear",
          revision: 3,
        });
        expect(await db.learningRevision.count({ where: { documentId } })).toBe(3);
      }
      expect(existsSync(pushTokenPath(dataDir, owner.userId))).toBe(false);
      expect(existsSync(pushTokenPath(dataDir, other.userId))).toBe(true);
      expect(
        (
          await handles.app.request("/rpc/me", {
            method: "POST",
            headers: { "content-type": "application/json", cookie: owner.cookie, origin },
            body: JSON.stringify({ json: {} }),
          })
        ).status,
      ).toBe(401);
    },
  );
  it("denies sessions while cleanup is pending and resumes after restarting the app", async () => {
    const owner = await signup();
    const fixture = await seed(owner);
    const db = handles.prisma;
    await db.computer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        scope: "dedicated",
        scopeKey: computerScopeKey("dedicated", owner.spaceId, fixture.bot.id),
        homeKey: randomUUID(),
        kind: "fake",
        providerRef: randomUUID(),
      },
    });
    const failure = vi
      .spyOn(handles.sandbox, "destroy")
      .mockRejectedValue(new Error("Synthetic provider unavailable"));
    try {
      const response = await handles.app.request("/api/auth/delete-user", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie, origin },
        body: JSON.stringify({ password: "password12" }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        success: true,
        message: "Account deletion requested",
      });
      await expect
        .poll(
          async () =>
            (await db.accountDeletion.findUnique({ where: { userId: owner.userId } }))?.errorCode,
        )
        .toBe("cleanup_failed");
      expect(await db.account.count({ where: { userId: owner.userId } })).toBe(1);
      expect(await db.session.count({ where: { userId: owner.userId } })).toBe(0);
      const signin = await handles.app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: owner.email, password: "password12" }),
      });
      expect(signin.status).toBe(403);
      expect(await db.session.count({ where: { userId: owner.userId } })).toBe(0);
      const oldSession = await handles.app.request("/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie, origin },
        body: JSON.stringify({ json: {} }),
      });
      expect(oldSession.status).toBe(401);
      await db.accountDeletion.update({
        where: { userId: owner.userId },
        data: { nextAttemptAt: new Date(0) },
      });
    } finally {
      failure.mockRestore();
    }
    await handles.stop();
    await start();
    await expect.poll(() => handles.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
    expect(await handles.prisma.accountDeletion.count({ where: { userId: owner.userId } })).toBe(0);
    expect(existsSync(pushTokenPath(dataDir, owner.userId))).toBe(false);
  });
});
