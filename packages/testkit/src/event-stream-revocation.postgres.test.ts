import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryRealtimeFanout, PostgresRealtimeFanout } from "@rakazo/adapters";
import { createDb, createThreadEvents } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!enabled).each(["memory", "postgres"] as const)(
  "authenticated event stream revocation via %s",
  (transport) => {
    let handles: Awaited<ReturnType<typeof createApp>>;
    let realtime: InMemoryRealtimeFanout | PostgresRealtimeFanout;
    let publisher: ReturnType<typeof createDb> | undefined;
    let dataDir: string;

    beforeAll(async () => {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-stream-revocation-"));
      if (transport === "postgres") {
        publisher = createDb(process.env.DATABASE_URL!);
        realtime = new PostgresRealtimeFanout({
          connectionString: process.env.DATABASE_URL!,
          publisher: publisher.pool,
        });
      } else realtime = new InMemoryRealtimeFanout();
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        realtime,
      });
    });
    afterAll(async () => {
      await handles?.stop();
      await publisher?.prisma.$disconnect();
      await publisher?.pool.end();
      rmSync(dataDir, { recursive: true, force: true });
    });

    async function owner(group = false) {
      const email = `stream-${randomUUID()}@rakazo.test`;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email,
          password: "password12",
          name: "Stream owner",
        }),
      });
      expect(signup.status).toBe(200);
      const cookie = sessionCookieHeader(signup);
      const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
      const bot = await rpc<{ id: string }>(cookie, "bots/create", {
        name: "Private stream",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      let target: { botId: string } | { groupId: string } = { botId: bot.id };
      if (group) {
        const peer = await rpc<{ id: string }>(cookie, "bots/create", {
          name: "Private peer",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        });
        const created = await rpc<{ id: string }>(cookie, "groups/create", {
          name: "Private group",
          botIds: [bot.id, peer.id],
        });
        target = { groupId: created.id };
      }
      const thread = await handles.prisma.thread.findUniqueOrThrow({ where: target });
      return { cookie, email, ...me, botId: bot.id, threadId: thread.id, target };
    }

    async function raw(
      cookie: string,
      procedure: string,
      body = {},
      spaceId?: string,
      signal?: AbortSignal,
      bearer?: string,
    ) {
      return handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }),
          ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
        },
        body: JSON.stringify({ json: body }),
        signal,
      });
    }
    async function rpc<T>(
      cookie: string,
      procedure: string,
      body = {},
      spaceId?: string,
    ): Promise<T> {
      const response = await raw(cookie, procedure, body, spaceId);
      expect(response.status).toBe(200);
      return ((await response.json()) as { json: T }).json;
    }

    async function open(actor: Awaited<ReturnType<typeof owner>>, cursor: number, bearer?: string) {
      const abort = new AbortController();
      const response = await raw(
        actor.cookie,
        "threads/subscribe",
        { ...actor.target, cursor },
        actor.spaceId,
        abort.signal,
        bearer,
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const read = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Stream did not settle")), 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      return { abort, reader, read, decoder };
    }
    async function readUntil(stream: Awaited<ReturnType<typeof open>>, marker: string) {
      let text = "";
      while (!text.includes(marker)) {
        const chunk = await stream.read();
        expect(chunk.done, text).toBe(false);
        text += stream.decoder.decode(chunk.value);
      }
      return text;
    }
    function append(actor: Awaited<ReturnType<typeof owner>>, text: string) {
      return createThreadEvents(handles.prisma, realtime).append({
        spaceId: actor.spaceId,
        threadId: actor.threadId,
        botId: actor.botId,
        type: "thread.progress",
        payload: { text },
      });
    }

    it.each(
      [false, true].flatMap((group) =>
        [
          "membership removal",
          "session revocation",
          "session expiry",
          "archive",
          "removal during event query",
        ].map((reason) => ({ group, reason })),
      ),
    )(
      "withholds private events after $reason and denies reconnect, group=$group",
      async ({ reason, group }) => {
        const actor = await owner(group);
        const initial = await append(actor, "Before access revocation");
        const { abort, reader, read, decoder } = await open(actor, initial.seq - 1);
        let restoreQuery = () => {};
        try {
          let before = "";
          while (!before.includes("Before access revocation")) {
            const chunk = await read();
            expect(chunk.done, before).toBe(false);
            before += decoder.decode(chunk.value);
          }
          const revokeMembership = () =>
            handles.prisma.spaceMember.delete({
              where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
            });
          const marker = `Private after revocation ${randomUUID()}`;
          if (reason === "membership removal") await revokeMembership();
          else if (reason === "removal during event query") {
            const find = handles.prisma.event.findMany.bind(handles.prisma.event);
            const spy = vi.spyOn(handles.prisma.event, "findMany").mockImplementation((async (
              args,
            ) => {
              const rows = await find(args);
              if (rows.some((row) => JSON.stringify(row.payload).includes(marker)))
                await revokeMembership();
              return rows;
            }) as typeof find);
            restoreQuery = () => spy.mockRestore();
          } else if (reason === "session expiry") {
            await handles.prisma.session.updateMany({
              where: { userId: actor.userId },
              data: { expiresAt: new Date(0) },
            });
          } else if (reason === "archive") {
            await rpc(actor.cookie, group ? "groups/archive" : "bots/archive", actor.target);
          } else {
            const signedOut = await handles.app.request("/api/auth/sign-out", {
              method: "POST",
              headers: { cookie: actor.cookie, origin, "content-type": "application/json" },
              body: "{}",
            });
            expect(signedOut.status).toBe(200);
          }
          await append(actor, marker);
          let after = "";
          for (;;) {
            const chunk = await read();
            if (chunk.done) break;
            after += decoder.decode(chunk.value);
            expect(after).not.toContain(marker);
          }
          expect(after).toMatch(/error|forbidden|unauthorized|not.found/i);
          const reconnect = await raw(
            actor.cookie,
            "threads/subscribe",
            { ...actor.target, cursor: initial.seq },
            actor.spaceId,
          );
          if (reason === "archive") expect(await reconnect.text()).toMatch(/error|not.found/i);
          else expect(reconnect.status).toBe(401);
        } finally {
          restoreQuery();
          abort.abort();
          await reader.cancel();
        }
      },
    );
    it("revokes a native bearer-authenticated stream and denies its reconnect", async () => {
      const actor = await owner();
      const session = await handles.prisma.session.findFirstOrThrow({
        where: { userId: actor.userId },
      });
      const initial = await append(actor, "Ready with bearer authentication");
      const stream = await open(actor, initial.seq - 1, session.token);
      try {
        await readUntil(stream, "Ready with bearer authentication");
        await handles.prisma.spaceMember.delete({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        });
        const marker = `Private bearer event ${randomUUID()}`;
        await append(actor, marker);
        let denied = "";
        for (;;) {
          const chunk = await stream.read();
          if (chunk.done) break;
          denied += stream.decoder.decode(chunk.value);
          expect(denied).not.toContain(marker);
        }
        expect(denied).toMatch(/error|forbidden/i);
        const reconnect = await raw(
          "",
          "threads/subscribe",
          { ...actor.target, cursor: initial.seq },
          actor.spaceId,
          undefined,
          session.token,
        );
        expect(reconnect.status).toBe(401);
      } finally {
        stream.abort.abort();
        await stream.reader.cancel();
      }
    });

    it("closes a revoked quiet stream when catch-up wakes without any new event", async () => {
      const actor = await owner();
      const initial = await append(actor, "Ready before quiet revocation");
      const stream = await open(actor, initial.seq - 1);
      try {
        await readUntil(stream, "Ready before quiet revocation");
        await handles.prisma.spaceMember.delete({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        });
        // Same catch-up path as the idle timer, without a 30-second wall-clock wait.
        await realtime.publish(`thread:${actor.threadId}`, "");
        let denied = "";
        for (;;) {
          const chunk = await stream.read();
          if (chunk.done) break;
          denied += stream.decoder.decode(chunk.value);
        }
        expect(denied).toMatch(/error|forbidden/i);
        expect(await handles.prisma.event.count({ where: { threadId: actor.threadId } })).toBe(1);
      } finally {
        stream.abort.abort();
        await stream.reader.cancel();
      }
    });

    it.each(["another Space", "another session"])(
      "keeps %s connected when access to the first stream ends",
      async (remaining) => {
        const actor = await owner();
        let other = actor;
        if (remaining === "another session") {
          const login = await handles.app.request("/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ email: actor.email, password: "password12" }),
          });
          expect(login.status).toBe(200);
          other = { ...actor, cookie: sessionCookieHeader(login) };
        } else {
          const space = await rpc<{ id: string }>(actor.cookie, "spaces/create", {
            name: "Retained access",
          });
          const bot = await rpc<{ id: string }>(
            actor.cookie,
            "bots/create",
            {
              name: "Retained stream",
              title: "",
              description: "",
              instructions: "",
              notifyOnFinish: false,
            },
            space.id,
          );
          const thread = await handles.prisma.thread.findUniqueOrThrow({
            where: { botId: bot.id },
          });
          other = {
            ...actor,
            spaceId: space.id,
            botId: bot.id,
            threadId: thread.id,
            target: { botId: bot.id },
          };
        }
        const initial = await append(actor, "Ready before revocation");
        const otherInitial =
          other.threadId === actor.threadId
            ? initial
            : await append(other, "Ready before revocation");
        const first = await open(actor, initial.seq - 1);
        const second = await open(other, otherInitial.seq - 1);
        try {
          await readUntil(first, "Ready before revocation");
          await readUntil(second, "Ready before revocation");
          if (remaining === "another Space") {
            await handles.prisma.spaceMember.delete({
              where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
            });
          } else {
            const logout = await handles.app.request("/api/auth/sign-out", {
              method: "POST",
              headers: { "content-type": "application/json", origin, cookie: actor.cookie },
              body: "{}",
            });
            expect(logout.status).toBe(200);
          }
          const marker = `Only authorized streams receive ${randomUUID()}`;
          await append(actor, marker);
          if (other.threadId !== actor.threadId) await append(other, marker);
          expect(await readUntil(second, marker)).toContain(marker);
          let denied = "";
          for (;;) {
            const chunk = await first.read();
            if (chunk.done) break;
            denied += first.decoder.decode(chunk.value);
            expect(denied).not.toContain(marker);
          }
          expect(denied).toMatch(/error|forbidden/i);
        } finally {
          first.abort.abort();
          second.abort.abort();
          await Promise.all([first.reader.cancel(), second.reader.cancel()]);
        }
      },
    );
  },
);
