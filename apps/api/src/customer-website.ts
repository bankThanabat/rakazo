import { createHash, randomBytes } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { createCustomerConversations } from "@rakazo/adapters";
import {
  CustomerHistoryInput,
  CustomerVisitorMessageInput,
  CustomerVisitorSessionInput,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createCustomerInbox, handoffCustomer } from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
class VisitorSessionError extends Error {}

/** Public visitors receive a random, expiring capability for exactly one conversation. */
export function mountCustomerWebsite(
  parent: Hono,
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    webOrigin: string;
    purchases?: Pick<
      ReturnType<typeof createCustomerConversations>,
      "visitorPurchaseReviews" | "decideVisitorPurchaseReview"
    >;
  },
) {
  const app = new Hono();
  const { prisma } = deps;
  app.onError((error, c) =>
    c.json(
      { error: "Support is unavailable. Please try again later." },
      error instanceof VisitorSessionError ? 401 : 403,
    ),
  );
  app.use("/:channel/*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("vary", "Origin");
    const origin =
      c.req.header("origin") ??
      (c.req.header("sec-fetch-site") === "same-origin" ? deps.webOrigin : "");
    const channel = await prisma.customerChannel.findFirst({
      where: {
        id: c.req.param("channel"),
        provider: "web",
        enabled: true,
        bot: { archivedAt: null },
      },
    });
    if (
      !channel ||
      !origin ||
      !(channel.websiteOrigins.includes(origin) || origin === deps.webOrigin)
    )
      return c.json({ error: "Support unavailable" }, 403);
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-methods", "GET, POST, OPTIONS");
    c.header("access-control-allow-headers", "authorization, content-type");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });
  async function session(token: string, channelId: string, origin: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new VisitorSessionError();
    const row = await prisma.customerVisitorSession.findUnique({
      where: { tokenHash: digest(token) },
      include: { conversation: { include: { channel: true } } },
    });
    if (
      !row ||
      row.expiresAt <= new Date() ||
      row.conversation.channelId !== channelId ||
      !row.conversation.channel.websiteOrigins.includes(row.origin) ||
      (origin !== row.origin && origin !== deps.webOrigin)
    )
      throw new VisitorSessionError();
    return row;
  }
  const auth = (c: Context) =>
    session(
      c.req.header("authorization")?.replace(/^Bearer /, "") ?? "",
      c.req.param("channel")!,
      c.req.header("origin") ??
        (c.req.header("sec-fetch-site") === "same-origin" ? deps.webOrigin : ""),
    );
  async function queue(id: string) {
    await deps.jobs
      .enqueue({
        name: "customer.process",
        payload: { conversationId: id },
        replaceKey: `customer.process:${id}`,
      })
      .catch(() => undefined);
  }
  app.post("/:channel/session", async (c) => {
    const origin = c.req.header("origin")!;
    const token = randomBytes(32).toString("base64url");
    const raw = await readBoundedBody(c.req.raw, 2000);
    if (raw === null) return c.body(null, 413);
    const input = CustomerVisitorSessionInput.parse(JSON.parse(raw || "{}"));
    const conversation = await prisma.$transaction(async (tx) => {
      const channelId = c.req.param("channel");
      await tx.$queryRaw`SELECT id FROM customer_channels WHERE id = ${channelId} FOR UPDATE`;
      const channel = await tx.customerChannel.findUniqueOrThrow({ where: { id: channelId } });
      if (
        !channel.enabled ||
        channel.provider !== "web" ||
        !channel.websiteOrigins.includes(origin)
      )
        throw new Error("Origin unavailable");
      // Bound anonymous session creation as well as message execution.
      const since = new Date(Date.now() - 86400000);
      if (
        (await tx.customerConversation.count({
          where: { channelId, createdAt: { gte: since } },
        })) >= channel.dailyMessageLimit
      )
        throw new Error("Session limit reached");
      const visitor = randomBytes(24).toString("base64url");
      return tx.customerConversation.create({
        data: {
          channelId,
          externalThreadId: visitor,
          customerId: visitor,
          name: input.name,
          visitorSessions: {
            create: {
              tokenHash: digest(token),
              origin,
              expiresAt: new Date(Date.now() + 7 * 86400000),
            },
          },
        },
      });
    });
    return c.json({ token, conversationId: conversation.id });
  });
  app.get("/:channel/messages", async (c) => {
    const { conversation } = await auth(c);
    const { before } = CustomerHistoryInput.parse({ before: c.req.query("before") });
    const messages = await prisma.customerMessage.findMany({
      where: {
        conversationId: conversation.id,
        OR: [{ role: "customer" }, { status: "sent" }],
        ...(before ? { seq: { lt: before } } : {}),
      },
      orderBy: { seq: "desc" },
      take: 100,
      select: { id: true, seq: true, role: true, body: true, createdAt: true },
    });
    messages.reverse();
    return c.json({
      owner: conversation.owner,
      needsHuman: conversation.needsHuman,
      state: conversation.state,
      messages,
      before: messages.length === 100 ? messages[0]!.seq : null,
    });
  });
  app.post("/:channel/messages", async (c) => {
    const { conversation } = await auth(c);
    const raw = await readBoundedBody(c.req.raw, 70000);
    if (raw === null) return c.body(null, 413);
    const input = CustomerVisitorMessageInput.parse(JSON.parse(raw));
    const id = await createCustomerInbox(prisma).receive(conversation.channelId, {
      externalId: input.nonce,
      externalThreadId: conversation.externalThreadId,
      customerId: conversation.customerId,
      name: conversation.name,
      body: input.body,
    });
    await queue(id);
    return c.json({ ok: true });
  });
  app.get("/:channel/purchases", async (c) => {
    const visitor = await auth(c);
    return c.json({
      reviews: (await deps.purchases?.visitorPurchaseReviews(visitor.tokenHash)) ?? [],
    });
  });
  app.post("/:channel/purchases/decision", async (c) => {
    const visitor = await auth(c);
    const raw = await readBoundedBody(c.req.raw, 2000);
    if (raw === null) return c.body(null, 413);
    if (!deps.purchases) return c.body(null, 503);
    const review = await deps.purchases.decideVisitorPurchaseReview(
      visitor.tokenHash,
      JSON.parse(raw),
    );
    await queue(visitor.conversationId);
    return c.json({ review });
  });
  app.post("/:channel/handoff", async (c) => {
    const { conversation } = await auth(c);
    await prisma.$transaction((tx) =>
      handoffCustomer(tx, conversation.id, "Customer requested a person"),
    );
    await queue(conversation.id);
    return c.json({ ok: true });
  });
  parent.route("/api/customer-web", app);
}
