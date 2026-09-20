import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SCREEN_TARGET_ENDPOINT } from "@rakazo/core/node/screen-capability";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const proxySecret = "synthetic-screen-proxy-secret";

describe.skipIf(!enabled)("screen capability access revocation", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-screen-revocation-"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      screenProxySecret: proxySecret,
    });
    vi.spyOn(handles.sandbox, "connectScreen").mockResolvedValue({
      url: "http://127.0.0.1:49152/embed.html",
      mimeType: "text/html",
      close: async () => {},
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await handles?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });
  async function rpc<T>(cookie: string, procedure: string, body = {}) {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: body }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { json: T }).json;
  }
  async function owner(interactive: boolean) {
    const email = `screen-${randomUUID()}@rakazo.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, name: "Screen owner", password: "password12" }),
    });
    expect(signup.status).toBe(200);
    const cookie = sessionCookieHeader(signup);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Private computer",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const stored = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
    expect(stored.computerId).not.toBeNull();
    await handles.prisma.computer.update({
      where: { id: stored.computerId! },
      data: {
        state: "running",
        providerRef: "synthetic-screen-provider",
        ...(interactive
          ? {
              controlHolder: "user",
              controlLeaseId: randomUUID(),
              controlBotId: bot.id,
              controlLeaseExpiresAt: new Date(Date.now() + 60_000),
            }
          : {}),
      },
    });
    return { ...me, cookie, email, botId: bot.id };
  }
  async function screen(actor: Awaited<ReturnType<typeof owner>>) {
    const { url } = await rpc<{ url: string }>(actor.cookie, "computer/screenUrl", {
      botId: actor.botId,
    });
    expect(url).toContain("/novnc/session/");
    return new URL(url).pathname;
  }
  const resolve = (capability: string) =>
    handles.app.request(SCREEN_TARGET_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${proxySecret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: capability }),
    });

  it.each(
    [false, true].flatMap((interactive) =>
      ["membership removal", "sign-out", "session expiry"].map((reason) => ({
        interactive,
        reason,
      })),
    ),
  )(
    "rejects an issued capability after $reason, interactive=$interactive",
    async ({ interactive, reason }) => {
      const actor = await owner(interactive);
      const capability = await screen(actor);
      const before = await resolve(capability);
      expect(before.status).toBe(200);
      expect(await before.json()).toMatchObject({ interactive });
      if (reason === "membership removal") {
        await handles.prisma.spaceMember.delete({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        });
      } else if (reason === "session expiry") {
        await handles.prisma.session.updateMany({
          where: { userId: actor.userId },
          data: { expiresAt: new Date(0) },
        });
      } else {
        const response = await handles.app.request("/api/auth/sign-out", {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie: actor.cookie },
          body: "{}",
        });
        expect(response.status).toBe(200);
      }
      expect((await resolve(capability)).status).toBe(403);
      expect((await resolve(capability.replace("/embed.html", "/websockify"))).status).toBe(403);
    },
  );
  it.each([false, true])(
    "does not revive an old link after rejoining, interactive=%s",
    async (interactive) => {
      const actor = await owner(interactive);
      const old = await screen(actor);
      const membership = await handles.prisma.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      });
      await handles.prisma.spaceMember.delete({ where: { id: membership.id } });
      await handles.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          createdAt: new Date(),
          spaceId: actor.spaceId,
          userId: actor.userId,
          organizationId: membership.organizationId,
        },
      });
      expect((await resolve(old)).status).toBe(403);
      expect((await resolve(await screen(actor))).status).toBe(200);
    },
  );

  it.each([false, true])(
    "keeps another session's link valid after sign-out, interactive=%s",
    async (interactive) => {
      const actor = await owner(interactive);
      const old = await screen(actor);
      const login = await handles.app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: actor.email, password: "password12" }),
      });
      expect(login.status).toBe(200);
      const other = await screen({ ...actor, cookie: sessionCookieHeader(login) });
      const logout = await handles.app.request("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: actor.cookie },
        body: "{}",
      });
      expect(logout.status).toBe(200);
      expect((await resolve(old)).status).toBe(403);
      expect((await resolve(other)).status).toBe(200);
    },
  );
});
