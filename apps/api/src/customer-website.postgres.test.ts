import { createHash, randomUUID } from "node:crypto";
import { createDb, provisionMessagingIdentity } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountCustomerWebsite } from "./customer-website.js";

describe.skipIf(process.env.VERIFY_DATABASE !== "1" || !process.env.DATABASE_URL)(
  "website visitor isolation",
  () => {
    let db: ReturnType<typeof createDb>;
    const owners: Awaited<ReturnType<typeof provisionMessagingIdentity>>[] = [];
    beforeAll(() => {
      db = createDb(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      await db?.prisma.$disconnect();
      await db?.pool.end();
    });
    afterEach(async () => {
      for (const owner of owners.splice(0)) {
        await db.prisma.space.delete({ where: { id: owner.spaceId } });
        await db.prisma.user.delete({ where: { id: owner.userId } });
      }
    });
    async function fixture() {
      const owner = await provisionMessagingIdentity(
        db.prisma,
        { provider: "test", address: randomUUID() },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
      owners.push(owner);
      const channel = await db.prisma.customerChannel.create({
        data: {
          userId: owner.userId,
          spaceId: owner.spaceId,
          botId: owner.botId,
          provider: "web",
          accountId: randomUUID(),
          name: "Support",
          ciphertext: "",
          websiteOrigins: ["https://shop.example.test"],
          dailyMessageLimit: 10,
        },
      });
      const app = new Hono();
      const enqueue = vi.fn(async () => undefined);
      const purchases = {
        visitorPurchaseReviews: vi.fn(async (_hash: string) => []),
        decideVisitorPurchaseReview: vi.fn(async (_hash: string, _input: unknown) => ({
          id: randomUUID(),
          purchaseId: "purchase",
          revision: 1,
          paymentMethod: "bacs",
          paymentMethodLabel: "Bank transfer",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          decision: "confirmed" as const,
          quote: {
            billing: {},
            shipping: {},
            summary: {
              items: [],
              currency: "THB",
              minorUnit: 2,
              total: "0",
              needsShipping: false,
              needsPayment: false,
              coupons: [],
              shippingRates: [],
            },
          },
        })),
      };
      mountCustomerWebsite(app, {
        prisma: db.prisma,
        jobs: { enqueue },
        webOrigin: "https://support.example.test",
        purchases,
      });
      const request = (path: string, options: RequestInit = {}) =>
        app.request(`/api/customer-web/${channel.id}/${path}`, {
          ...options,
          headers: { origin: "https://shop.example.test", ...options.headers },
        });
      const response = await request("session", { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      const session = (await response.json()) as { token: string; conversationId: string };
      return { app, request, session, channel, enqueue, purchases };
    }
    it("passes only the authenticated visitor identity to purchase reviews and rejects expired or foreign credentials", async () => {
      const f = await fixture();
      const headers = { authorization: `Bearer ${f.session.token}` };
      const digest = createHash("sha256").update(f.session.token).digest("hex");
      expect((await f.request("purchases", { headers })).status).toBe(200);
      expect(f.purchases.visitorPurchaseReviews).toHaveBeenCalledWith(digest);
      const input = { purchaseId: "purchase", reviewId: randomUUID(), decision: "confirmed" };
      expect(
        (
          await f.request("purchases/decision", {
            method: "POST",
            headers,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(200);
      expect(f.purchases.decideVisitorPurchaseReview).toHaveBeenCalledWith(digest, input);
      expect(
        (await f.request("purchases/decision", { method: "POST", body: JSON.stringify(input) }))
          .status,
      ).toBe(401);
      const foreign = await fixture();
      expect(
        (
          await foreign.request("purchases/decision", {
            method: "POST",
            headers,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(401);
      expect(foreign.purchases.decideVisitorPurchaseReview).not.toHaveBeenCalled();
      await db.prisma.customerVisitorSession.update({
        where: { tokenHash: digest },
        data: { expiresAt: new Date(0) },
      });
      expect((await f.request("purchases", { headers })).status).toBe(401);
      expect(
        (
          await f.request("purchases/decision", {
            method: "POST",
            headers,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(401);
      expect(f.purchases.decideVisitorPurchaseReview).toHaveBeenCalledOnce();
    });
    it("separates visitors, hides internal execution state, and deduplicates sends", async () => {
      const f = await fixture();
      const other = (await (await f.request("session", { method: "POST", body: "{}" })).json()) as {
        token: string;
      };
      const input = { body: "Need help", nonce: randomUUID() };
      const headers = { authorization: `Bearer ${f.session.token}` };
      for (let i = 0; i < 2; i++)
        expect(
          (await f.request("messages", { method: "POST", headers, body: JSON.stringify(input) }))
            .status,
        ).toBe(200);
      const own = await (await f.request("messages", { headers })).json();
      expect(own.messages).toHaveLength(1);
      expect(own.messages[0].body).toBe("Need help");
      expect(own.messages[0]).not.toHaveProperty("executionKeyHash");
      expect(
        (
          await f.request("messages", {
            method: "POST",
            headers,
            body: JSON.stringify({ ...input, body: "Different message" }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await (
            await f.request("messages", { headers: { authorization: `Bearer ${other.token}` } })
          ).json()
        ).messages,
      ).toEqual([]);
      expect((await f.request("messages")).status).toBe(401);
      expect(f.enqueue).toHaveBeenCalled();
    });
    it("rejects foreign origins, expired tokens and cross-channel token use", async () => {
      const a = await fixture();
      const b = await fixture();
      expect(
        (
          await a.request("session", {
            method: "POST",
            headers: { origin: "https://evil.example.test" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (await b.request("messages", { headers: { authorization: `Bearer ${a.session.token}` } }))
          .status,
      ).toBe(401);
      await db.prisma.customerVisitorSession.updateMany({
        where: { conversationId: a.session.conversationId },
        data: { expiresAt: new Date(0) },
      });
      expect(
        (await a.request("messages", { headers: { authorization: `Bearer ${a.session.token}` } }))
          .status,
      ).toBe(401);
    });
    it("handoff is durable and cannot queue duplicate acknowledgements", async () => {
      const f = await fixture();
      for (let i = 0; i < 2; i++)
        expect(
          (
            await f.request("handoff", {
              method: "POST",
              headers: { authorization: `Bearer ${f.session.token}` },
              body: "{}",
            })
          ).status,
        ).toBe(200);
      expect(
        await db.prisma.customerConversation.findUnique({
          where: { id: f.session.conversationId },
        }),
      ).toMatchObject({ owner: "staff", needsHuman: true });
      expect(
        await db.prisma.customerMessage.count({
          where: { conversationId: f.session.conversationId, role: "system" },
        }),
      ).toBe(1);
    });
    it("enforces quotas atomically and revokes an origin even through the support iframe", async () => {
      const f = await fixture();
      const headers = { authorization: `Bearer ${f.session.token}` };
      await db.prisma.customerChannel.update({
        where: { id: f.channel.id },
        data: { hourlyCustomerLimit: 1 },
      });
      const responses = await Promise.all(
        ["First", "Second"].map((body) =>
          f.request("messages", {
            method: "POST",
            headers,
            body: JSON.stringify({ body, nonce: randomUUID() }),
          }),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
      await db.prisma.customerChannel.update({
        where: { id: f.channel.id },
        data: { websiteOrigins: [] },
      });
      expect(
        (
          await f.request("messages", {
            headers: { ...headers, origin: "https://support.example.test" },
          })
        ).status,
      ).toBe(401);
    });
  },
);
