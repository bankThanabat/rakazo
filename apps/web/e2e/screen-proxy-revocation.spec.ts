import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { expect, test } from "@playwright/test";
import { sealScreenCapability } from "@rakazo/core/node/screen-capability";
import { createDb } from "../../../packages/db/src/client.js";

test.skip(
  !process.env.DATABASE_URL || !process.env.API_URL,
  "Run with the disposable E2E database harness",
);

for (const interactive of [false, true]) {
  for (const reason of ["membership removal", "sign-out"] as const) {
    test(`screen proxy closes an open socket after ${reason}, control=${interactive}`, async ({
      page,
      request,
      baseURL,
    }) => {
      const db = createDb(process.env.DATABASE_URL!);
      const sockets = new Set<Duplex>();
      const upstream = createServer((_req, response) => response.end("Synthetic screen"));
      upstream.on("upgrade", (req, socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        socket.on("end", () => socket.destroy());
        const accept = createHash("sha1")
          .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.write(Buffer.from([0x81, 2, 111, 107]));
      });
      try {
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        const origin = new URL(baseURL!).origin;
        const email = `screen-proxy-${randomUUID()}@rakazo.test`;
        const signup = await request.post(`${process.env.API_URL}/api/auth/sign-up/email`, {
          headers: { origin },
          data: { email, password: "password12", name: "Synthetic screen owner" },
        });
        expect(signup.status()).toBe(200);
        const created = await request.post(`${process.env.API_URL}/rpc/bots/create`, {
          headers: { origin },
          data: {
            json: {
              name: "Private screen",
              title: "",
              description: "",
              instructions: "",
              notifyOnFinish: false,
            },
          },
        });
        expect(created.status()).toBe(200);
        const { json: botResult } = await created.json();
        const bot = await db.prisma.bot.findUniqueOrThrow({
          where: { id: botResult.id },
          include: { computer: true },
        });
        const session = await db.prisma.session.findFirstOrThrow({ where: { userId: bot.userId } });
        const membership = await db.prisma.spaceMember.findUniqueOrThrow({
          where: { spaceId_userId: { spaceId: bot.spaceId, userId: bot.userId } },
        });
        const computer = await db.prisma.computer.update({
          where: { id: bot.computerId! },
          data: {
            state: "running",
            providerRef: "synthetic-screen",
            ...(interactive
              ? {
                  controlHolder: "user",
                  controlBotId: bot.id,
                  controlLeaseId: randomUUID(),
                  controlLeaseExpiresAt: new Date(Date.now() + 60_000),
                }
              : {}),
          },
        });
        const port = (upstream.address() as AddressInfo).port;
        const capability = sealScreenCapability(
          `http://127.0.0.1:${port}/embed.html?view_only=${!interactive}`,
          process.env.SCREEN_PROXY_SECRET!,
          origin,
          {
            spaceId: bot.spaceId,
            userId: bot.userId,
            sessionId: session.id,
            membershipId: membership.id,
            botId: bot.id,
            computerId: computer.id,
            botGeneration: bot.screenGeneration,
            computerGeneration: computer.screenGeneration,
            controlLeaseId: computer.controlLeaseId,
          },
        );
        expect((await request.get(capability)).status()).toBe(200);
        // Load the actual local origin so Chromium classifies the socket as same-network.
        await page.goto(origin);
        await page.evaluate(async (url) => {
          const target = new URL(url);
          target.protocol = "ws:";
          target.pathname = target.pathname.replace("/embed.html", "/websockify");
          const socket = new WebSocket(target);
          const state = window as unknown as { screenClosed: boolean };
          state.screenClosed = false;
          socket.onclose = () => {
            state.screenClosed = true;
          };
          await new Promise<void>((resolve, reject) => {
            socket.onmessage = () => resolve();
            socket.onerror = () => reject(new Error("Synthetic screen socket failed"));
          });
        }, capability);
        expect(sockets.size).toBe(1);
        if (reason === "membership removal") {
          await db.prisma.spaceMember.delete({ where: { id: membership.id } });
        } else {
          const logout = await request.post(`${process.env.API_URL}/api/auth/sign-out`, {
            headers: { origin },
            data: {},
          });
          expect(logout.status()).toBe(200);
        }
        expect((await request.get(capability)).status()).toBe(403);
        await expect
          .poll(
            () =>
              page.evaluate(() => (window as unknown as { screenClosed: boolean }).screenClosed),
            { timeout: 5000 },
          )
          .toBe(true);
        await expect.poll(() => sockets.size, { timeout: 5000 }).toBe(0);
      } finally {
        for (const socket of sockets) socket.destroy();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    });
  }
}
