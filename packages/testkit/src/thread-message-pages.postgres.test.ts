import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { ThreadMessagePage, ThreadSnapshot } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.js";
import { loadAllMessages } from "../../../apps/api/src/thread-message-pages.js";
import { buildApprovalAskBlock } from "../../adapters/src/approval-ask.js";
import { MemoryRestoreToolInput } from "../../contracts/src/memory-audit.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const mobileLimit = 16 * 1024 * 1024;

describe.skipIf(!enabled)("large history through authenticated RPC", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "thread-page-test-"));
    const { createApp } = await import("../../../apps/api/src/app.js");
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
  });
  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function raw(cookie: string, proc: string, input: unknown) {
    return handles.app.request(`/rpc/${proc}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(cookie: string, proc: string, input: unknown): Promise<T> {
    const response = await raw(cookie, proc, input);
    expect(response.status).toBe(200);
    // Use the same streaming response reader and byte ceiling as mobile RPC.
    const body = await readBoundedJsonResponse<{ json: T }>(response, mobileLimit);
    return body.json;
  }
  async function signup() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `page-${randomUUID()}@rakazo.test`,
        name: "Synthetic shop",
        password: "password12",
      }),
    });
    expect(response.status).toBe(200);
    const cookie = sessionCookieHeader(response);
    const actor = await rpc<{ userId: string; spaceId: string }>(cookie, "me", {});
    return { userId: actor.userId, spaceId: actor.spaceId, cookie };
  }

  it.each(["bot", "group"] as const)(
    "loads all full document cards in a %s conversation",
    async (kind) => {
      const { cookie, ...actor } = await signup();
      const outsider = await signup();
      const bot = await handles.prisma.bot.create({
        data: {
          ...actor,
          name: "Page fixture",
          color: "blue",
          learningEnabled: false,
          thread: { create: actor },
        },
        include: { thread: true },
      });
      let target: { botId: string } | { groupId: string } = { botId: bot.id };
      let threadId = bot.thread!.id;
      if (kind === "group") {
        const otherBot = await handles.prisma.bot.create({
          data: { ...actor, name: "Peer", color: "blue", learningEnabled: false },
        });
        const group = await handles.prisma.chatGroup.create({
          data: {
            ...actor,
            name: "Page group",
            thread: { create: actor },
            members: { create: [{ botId: bot.id }, { botId: otherBot.id }] },
          },
          include: { thread: true },
        });
        target = { groupId: group.id };
        threadId = group.thread!.id;
      }
      const block = buildApprovalAskBlock(
        "synthetic-effect",
        "memory_restore",
        MemoryRestoreToolInput.parse({
          documentId: "synthetic-document",
          revision: 1,
          expectedRevision: 2,
          reason: "Synthetic review",
          reviewedContent: "\u0001".repeat(100_000),
        }),
        [],
      );
      expect(block).toMatchObject({
        actions: expect.arrayContaining([{ id: "allow", label: "Allow once" }]),
      });
      const rows = Array.from({ length: 50 }, (_, index) => ({
        id: randomUUID(),
        threadId,
        seq: index,
        role: "bot",
        botId: bot.id,
        blocks: [block],
      }));
      await handles.prisma.message.createMany({ data: rows });
      await handles.prisma.thread.update({ where: { id: threadId }, data: { nextMessageSeq: 50 } });
      const snapshot = await rpc<ThreadSnapshot>(cookie, "threads/get", target);
      expect(snapshot.messages.length).toBeGreaterThan(0);
      expect(snapshot.messages.length).toBeLessThan(50);
      expect(snapshot.messages.at(-1)?.seq).toBe(49);
      const seen = [...snapshot.messages];
      let before = snapshot.olderCursor;
      while (before !== null && seen.length <= rows.length) {
        const page = await rpc<ThreadMessagePage>(cookie, "threads/messages", {
          ...target,
          before,
          includePeerReceipts: true,
        });
        expect(page.messages.length).toBeGreaterThan(0);
        if (page.olderCursor !== null) expect(page.olderCursor).toBeLessThan(before);
        seen.unshift(...page.messages);
        before = page.olderCursor;
      }
      expect(before).toBeNull();
      expect(seen.map((message) => message.id)).toEqual(rows.map((row) => row.id));
      for (const message of seen) expect(message.blocks).toEqual([block]);
      const around = await rpc<ThreadMessagePage>(cookie, "threads/messages", {
        ...target,
        around: { messageId: rows[25]!.id },
      });
      expect(around.messages.some((message) => message.id === rows[25]!.id)).toBe(true);
      expect(around.olderCursor).toBe(around.messages[0]!.seq);
      const exported = await loadAllMessages(handles.prisma, threadId, 500);
      expect(exported.map((message) => message.id)).toEqual(rows.map((row) => row.id));
      for (const message of exported) expect(message.blocks).toEqual([block]);
      // Paging and around lookups still authorize the owning conversation first.
      for (const proc of ["threads/get", "threads/messages"]) {
        const denied = await raw(outsider.cookie, proc, target);
        expect(denied.status).toBeGreaterThanOrEqual(400);
        expect(await denied.text()).not.toContain("synthetic-document");
      }
      const denied = await raw(outsider.cookie, "threads/messages", {
        ...target,
        around: { messageId: rows[25]!.id },
      });
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(await denied.text()).not.toContain("synthetic-document");
    },
  );
});
