import { createHash, randomUUID } from "node:crypto";
import type { CustomerCheckoutExecute, CustomerCheckoutProvider } from "@rakazo/adapter-kit";
import {
  connectionAccessWhere,
  createCustomerInbox,
  createDb,
  provisionMessagingIdentity,
  purchaseDispatchMs,
  purchaseRecoveryMs,
  requestAccountDeletion,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { createCustomerConnector } from "./customer-connector.js";
import { createCustomerPurchases } from "./customer-purchases.js";
import { EncryptedSecretStore } from "./secrets.js";
import { wooCommerceCheckout } from "./woocommerce-checkout.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("durable customer purchases", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let conversationId: string;
  let connectionId: string;
  let cart: Record<string, unknown>;
  let execute: ReturnType<typeof vi.fn>;
  let preflight: ReturnType<typeof vi.fn>;
  let purchases: ReturnType<typeof createCustomerPurchases>;
  const secrets = new EncryptedSecretStore("synthetic-purchase-encryption-key");
  const input = () => ({
    conversationId,
    connectionId,
    customerId: "shopper",
    nonce: randomUUID(),
    paymentMethods: ["bacs"],
  });
  const service = (
    provider?: (name: string, execute: CustomerCheckoutExecute) => CustomerCheckoutProvider,
    client = db.prisma,
  ) =>
    createCustomerPurchases({
      prisma: client,
      secrets,
      connector: {
        connection: async (actor: { userId: string; spaceId: string }, id: string) => {
          if (
            !(await db.prisma.spaceMember.count({
              where: { userId: actor.userId, spaceId: actor.spaceId },
            }))
          )
            throw new Error("Denied");
          return db.prisma.connection.findFirstOrThrow({
            where: { id, status: "connected", ...connectionAccessWhere(actor) },
          });
        },
        execute,
        validateWorkflow: preflight,
      } as unknown as ReturnType<typeof createCustomerConnector>,
      provider: provider ?? ((_name, action) => wooCommerceCheckout(action)),
    });
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
    const channelConnection = await db.prisma.connection.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        provider: "line",
        connectorId: "open-connector",
        providerRef: "SYNTHETIC_LINE_ACCOUNT",
        displayName: "Customer LINE",
        status: "connected",
      },
    });
    const channel = await db.prisma.customerChannel.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        // Existing cases exercise staff-approved social checkout. Website consent has its own cases below.
        provider: "line",
        connectionId: channelConnection.id,
        binding: { providerRef: "SYNTHETIC_LINE_ACCOUNT" },
        accountId: randomUUID(),
        name: "Synthetic",
        ciphertext: "",
      },
    });
    conversationId = await createCustomerInbox(db.prisma).receive(channel.id, {
      externalId: "one",
      externalThreadId: "thread",
      customerId: "shopper",
      name: "Shopper",
      body: "A product",
    });
    connectionId = (
      await db.prisma.connection.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          provider: "woocommerce",
          connectorId: "open-connector",
          providerRef: "ACCOUNT_PRIVATE",
          displayName: "Store",
          status: "connected",
        },
      })
    ).id;
    cart = {
      items: [],
      totals: { currency_code: "THB", currency_minor_unit: 2, total_price: "12500" },
      needs_shipping: false,
      needs_payment: true,
      coupons: [],
      shipping_rates: [],
      billing_address: { email: "private-address-sentinel@example.test" },
      shipping_address: {},
    };
    execute = vi.fn(async (_actor, _id, action: string, args: Record<string, unknown>) => {
      if (action === "woocommerce.add_cart_item")
        cart.items = [
          { key: "cart-item", id: args.productId, name: "Product", quantity: args.quantity },
        ];
      if (action === "woocommerce.update_cart_item")
        cart.items = [{ key: "cart-item", id: 7, name: "Product", quantity: args.quantity }];
      if (action === "woocommerce.submit_checkout")
        return {
          cartToken: "ROTATED_CART_SECRET",
          checkout: {
            order_id: 29,
            status: "on-hold",
            order_key: "PRIVATE_ORDER_KEY",
            billing_address: { email: "private-address-sentinel@example.test" },
            payment_result: { payment_status: "success" },
          },
        };
      return {
        cartToken:
          action === "woocommerce.create_cart" ? "INITIAL_CART_SECRET" : "ROTATED_CART_SECRET",
        cart: structuredClone(cart),
      };
    });
    preflight = vi.fn(async () => {});
    purchases = service();
  });
  afterEach(async () => {
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });
  const start = () => purchases.start(owner, owner.botId, input());
  const add = (row: { id: string; revision: number }) =>
    purchases.update(owner, owner.botId, {
      id: row.id,
      expectedRevision: row.revision,
      change: { kind: "add", productId: 7, quantity: 1 },
    });

  async function websiteReview() {
    const conversation = await db.prisma.customerConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    await db.prisma.customerChannel.update({
      where: { id: conversation.channelId },
      data: { provider: "web", websiteOrigins: ["https://shop.example.test"] },
    });
    const token = randomUUID();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.prisma.customerVisitorSession.create({
      data: {
        tokenHash,
        conversationId,
        origin: "https://shop.example.test",
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const row = await add(await start());
    const quote = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    const checkout = { id: row.id, expectedRevision: row.revision, quote, paymentMethod: "bacs" };
    const review = await purchases.requestReview(owner, owner.botId, checkout);
    const decision = { purchaseId: row.id, reviewId: review.id, decision: "confirmed" as const };
    return { row, tokenHash, checkout, review, decision };
  }
  it("requires an authenticated website confirmation and keeps replayed decisions idempotent", async () => {
    const f = await websiteReview();
    await expect(purchases.checkout(owner, owner.botId, f.checkout)).rejects.toThrow(
      "shopper must confirm",
    );
    expect(await purchases.visitorReviews(f.tokenHash)).toMatchObject([
      {
        id: f.review.id,
        quote: f.checkout.quote,
        paymentMethodLabel: "Bank transfer",
        decision: null,
      },
    ]);
    expect(await purchases.requestReview(owner, owner.botId, f.checkout)).toEqual(f.review);
    await Promise.all([
      purchases.decideReview(f.tokenHash, f.decision),
      purchases.decideReview(f.tokenHash, f.decision),
    ]);
    expect((await purchases.quote(owner, owner.botId, { id: f.row.id })).review?.decision).toBe(
      "confirmed",
    );
    const state = await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: f.row.id } });
    expect(
      (state.history as Array<{ kind: string }>).filter((event) => event.kind === "shopper_review"),
    ).toHaveLength(1);
    expect(
      JSON.stringify(await purchases.inspect(owner, owner.botId, { conversationId })),
    ).not.toContain(f.tokenHash);
    const results = await Promise.allSettled([
      purchases.checkout(owner, owner.botId, f.checkout),
      purchases.checkout(owner, owner.botId, f.checkout),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(
      execute.mock.calls.filter((call) => call[2] === "woocommerce.submit_checkout"),
    ).toHaveLength(1);
    expect(await purchases.visitorReviews(f.tokenHash)).toEqual([]);
  });
  it("returns the recorded decision even when the review expires during its commit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      const f = await websiteReview();
      const client = db.prisma.$extends({
        query: {
          customerPurchase: {
            async update({ args, query }) {
              const result = await query(args);
              vi.setSystemTime(new Date(Date.parse(f.review.expiresAt) + 1));
              return result;
            },
          },
        },
      });
      const result = await service(undefined, client as unknown as typeof db.prisma).decideReview(
        f.tokenHash,
        f.decision,
      );
      expect(result).toMatchObject({ id: f.review.id, decision: "confirmed" });
      expect(await purchases.visitorReviews(f.tokenHash)).toEqual([]);
      await expect(purchases.checkout(owner, owner.botId, f.checkout)).rejects.toThrow(
        "shopper must confirm",
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not transfer consent to another payment method or edited quote", async () => {
    const f = await websiteReview();
    await purchases.decideReview(f.tokenHash, f.decision);
    await db.prisma.customerPurchase.update({
      where: { id: f.row.id },
      data: { paymentMethods: ["bacs", "cod"] },
    });
    await expect(
      purchases.checkout(owner, owner.botId, { ...f.checkout, paymentMethod: "cod" }),
    ).rejects.toThrow("shopper must confirm");
    const changed = {
      ...f.checkout,
      quote: { ...f.checkout.quote, summary: { ...f.checkout.quote.summary, total: "1" } },
    };
    await expect(purchases.requestReview(owner, owner.botId, changed)).rejects.toThrow("changed");
    await expect(purchases.checkout(owner, owner.botId, changed)).rejects.toThrow(
      "shopper must confirm",
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("allows shoppers to withdraw confirmation before checkout is claimed", async () => {
    const f = await websiteReview();
    await purchases.decideReview(f.tokenHash, f.decision);
    const confirmed = await db.prisma.customerConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(confirmed).toMatchObject({
      owner: "staff",
      needsHuman: true,
      handoffReason: "Shopper confirmed order details",
    });
    await purchases.decideReview(f.tokenHash, f.decision);
    expect(
      (await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: conversationId } }))
        .attentionId,
    ).toBe(confirmed.attentionId);
    await createCustomerInbox(db.prisma).updateCase(owner, {
      id: conversationId,
      acknowledge: true,
    });
    await purchases.decideReview(f.tokenHash, { ...f.decision, decision: "changes_requested" });
    const withdrawn = await db.prisma.customerConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(withdrawn).toMatchObject({
      needsHuman: true,
      acknowledgedAt: null,
      handoffReason: "Shopper requested changes to order details",
    });
    expect(withdrawn.attentionId).not.toBe(confirmed.attentionId);
    await expect(purchases.checkout(owner, owner.botId, f.checkout)).rejects.toThrow(
      "shopper must confirm",
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each(["changed", "submitting"])(
    "does not show a stale quote when a concurrent cart becomes %s",
    async (status) => {
      const f = await websiteReview();
      const client = await db.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT id FROM customer_conversations WHERE id = $1 FOR UPDATE", [
        conversationId,
      ]);
      const reading = purchases.visitorReviews(f.tokenHash);
      try {
        await vi.waitFor(async () => {
          const result = await db.pool.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%SELECT conversation.generation,%'`,
          );
          expect(result.rowCount).toBeGreaterThan(0);
        });
        const row = await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: f.row.id } });
        const state = JSON.parse(secrets.load(row.ciphertext!, `customer-purchase:${row.id}`));
        delete state.review;
        await client.query(
          "UPDATE customer_purchases SET revision = revision + 1, status = $2, ciphertext = $3 WHERE id = $1",
          [
            row.id,
            status === "changed" ? "open" : "submitting",
            secrets.seal(JSON.stringify(state), `customer-purchase:${row.id}`),
          ],
        );
        await client.query("COMMIT");
        expect(await reading).toEqual([]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
        await reading;
      }
    },
  );
  it("binds review to the participant session and refuses stale or invented review IDs", async () => {
    const f = await websiteReview();
    await expect(purchases.decideReview("other-session", f.decision)).rejects.toThrow();
    await expect(purchases.visitorReviews("other-session")).rejects.toThrow();
    await expect(
      purchases.decideReview(f.tokenHash, { ...f.decision, reviewId: randomUUID() }),
    ).rejects.toThrow("changed");
    await expect(
      purchases.decideReview(f.tokenHash, { ...f.decision, purchaseId: "other" }),
    ).rejects.toThrow();
    await expect(
      purchases.decideReview(f.tokenHash, { ...f.decision, quote: f.checkout.quote }),
    ).rejects.toThrow();
    const other = await db.prisma.customerConversation.create({
      data: {
        channelId: (
          await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: conversationId } })
        ).channelId,
        externalThreadId: "another-visitor",
        customerId: "another-visitor",
        name: "Other",
      },
    });
    await db.prisma.customerVisitorSession.create({
      data: {
        tokenHash: "another-session",
        conversationId: other.id,
        origin: "https://shop.example.test",
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    expect(await purchases.visitorReviews("another-session")).toEqual([]);
    await expect(purchases.decideReview("another-session", f.decision)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("refuses checkout after changes are requested and requires a fresh review after a cart update", async () => {
    const f = await websiteReview();
    await purchases.decideReview(f.tokenHash, { ...f.decision, decision: "changes_requested" });
    await expect(purchases.decideReview(f.tokenHash, f.decision)).rejects.toThrow(
      "already has a decision",
    );
    await expect(purchases.checkout(owner, owner.botId, f.checkout)).rejects.toThrow(
      "shopper must confirm",
    );
    await purchases.update(owner, owner.botId, {
      id: f.row.id,
      expectedRevision: f.row.revision,
      change: { kind: "quantity", key: "cart-item", quantity: 2 },
    });
    expect(await purchases.visitorReviews(f.tokenHash)).toEqual([]);
    await expect(purchases.decideReview(f.tokenHash, f.decision)).rejects.toThrow("changed");
    const nextQuote = await purchases.quote(owner, owner.botId, { id: f.row.id });
    const published = await purchases.requestReview(owner, owner.botId, {
      id: f.row.id,
      expectedRevision: nextQuote.expectedRevision,
      quote: nextQuote.quote,
      paymentMethod: "bacs",
    });
    expect(published.id).not.toBe(f.review.id);
  });
  it.each(["session", "origin", "quote", "connection", "account"])(
    "refuses a confirmed website checkout after %s becomes unavailable",
    async (reason) => {
      const f = await websiteReview();
      await purchases.decideReview(f.tokenHash, f.decision);
      if (reason === "session")
        await db.prisma.customerVisitorSession.update({
          where: { tokenHash: f.tokenHash },
          data: { expiresAt: new Date(0) },
        });
      if (reason === "origin")
        await db.prisma.customerChannel.updateMany({
          where: { userId: owner.userId },
          data: { websiteOrigins: [] },
        });
      if (reason === "quote") {
        const row = await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: f.row.id } });
        const state = JSON.parse(secrets.load(row.ciphertext!, `customer-purchase:${row.id}`));
        state.review.expiresAt = new Date(0).toISOString();
        await db.prisma.customerPurchase.update({
          where: { id: row.id },
          data: { ciphertext: secrets.seal(JSON.stringify(state), `customer-purchase:${row.id}`) },
        });
      }
      if (reason === "connection")
        await db.prisma.connection.update({
          where: { id: connectionId },
          data: { status: "revoked" },
        });
      if (reason === "account")
        await db.prisma.accountDeletion.create({ data: { userId: owner.userId } });
      try {
        await expect(purchases.checkout(owner, owner.botId, f.checkout)).rejects.toThrow();
      } finally {
        await db.prisma.accountDeletion.deleteMany({ where: { userId: owner.userId } });
      }
      expect(execute.mock.calls.some((call) => call[2] === "woocommerce.submit_checkout")).toBe(
        false,
      );
    },
  );
  it("requires fresh shopper consent after a provider price change and never treats confirmation as payment", async () => {
    const f = await websiteReview();
    await purchases.decideReview(f.tokenHash, f.decision);
    cart.totals = { currency_code: "THB", currency_minor_unit: 2, total_price: "14000" };
    const next = await purchases.checkout(owner, owner.botId, f.checkout);
    expect(next).toMatchObject({ status: "open", summary: { total: "14000" } });
    expect(await purchases.visitorReviews(f.tokenHash)).toEqual([]);
    const quote = await purchases.quote(owner, owner.botId, { id: f.row.id });
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: f.row.id,
        expectedRevision: next.revision,
        quote: quote.quote,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("shopper must confirm");
    expect(execute.mock.calls.some((call) => call[2] === "woocommerce.submit_checkout")).toBe(
      false,
    );
  });
  it("encrypts capabilities, rotates them durably and exposes only a purchase summary", async () => {
    const first = await start();
    const next = await add(first);
    const stored = await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.ciphertext).not.toContain("CART_SECRET");
    expect(secrets.load(stored.ciphertext!, `customer-purchase:${stored.id}`)).toContain(
      "ROTATED_CART_SECRET",
    );
    const inspected = await purchases.inspect(owner, owner.botId, { conversationId });
    expect(next).toMatchObject({
      status: "open",
      revision: 2,
      summary: { items: [{ id: 7, quantity: 1 }] },
    });
    for (const secret of [
      "CART_SECRET",
      "private-address-sentinel@example.test",
      "ACCOUNT_PRIVATE",
      "ciphertext",
      "privateData",
    ])
      expect(JSON.stringify({ first, next, inspected })).not.toContain(secret);
    expect(execute.mock.calls[1]?.[3]).toMatchObject({ cartToken: "INITIAL_CART_SECRET" });
    expect(
      await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: conversationId } }),
    ).toMatchObject({ owner: "staff", generation: 2 });
  });
  it("includes selected product variants in the approval quote", async () => {
    const row = await start();
    execute.mockImplementationOnce(async () => ({
      cartToken: "ROTATED_CART_SECRET",
      cart: {
        ...cart,
        items: [
          {
            key: "variant-item",
            id: 7,
            name: "Shirt",
            quantity: 1,
            variation: [{ attribute: "Size", value: "M" }],
          },
        ],
      },
    }));
    await add(row);
    expect(await purchases.quote(owner, owner.botId, { id: row.id })).toMatchObject({
      quote: { summary: { items: [{ variation: [{ attribute: "Size", value: "M" }] }] } },
    });
  });
  it("deduplicates a start nonce and rejects a changed request or second active purchase", async () => {
    const request = input();
    const first = await purchases.start(owner, owner.botId, request);
    expect(await purchases.start(owner, owner.botId, request)).toMatchObject({
      id: first.id,
      revision: 1,
    });
    await expect(
      purchases.start(owner, owner.botId, { ...request, paymentMethods: ["other"] }),
    ).rejects.toThrow("changed");
    await expect(start()).rejects.toThrow("already has");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("elects one concurrent creator even with different nonces", async () => {
    const results = await Promise.allSettled([start(), start()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent revisions and does not dispatch a stale approval", async () => {
    const first = await start();
    const results = await Promise.allSettled([add(first), add(first)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(add(first)).rejects.toThrow("changed");
  });
  it("retains unknown creation and never creates another cart after restart", async () => {
    execute.mockRejectedValueOnce(new Error("Lost provider receipt containing PRIVATE_SECRET"));
    const request = input();
    await expect(purchases.start(owner, owner.botId, request)).rejects.toThrow("uncertain");
    purchases = service();
    expect(await purchases.start(owner, owner.botId, request)).toMatchObject({
      status: "uncertain",
    });
    await expect(start()).rejects.toThrow("already has");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(await purchases.inspect(owner, owner.botId, { conversationId })),
    ).not.toContain("PRIVATE_SECRET");
  });
  it("does not replay a lost cart mutation or discard its previous encrypted state", async () => {
    const first = await start();
    execute.mockRejectedValueOnce(new Error("lost"));
    await expect(add(first)).rejects.toThrow("uncertain");
    const row = await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ status: "uncertain", revision: 2, actionKind: "add" });
    expect(secrets.load(row.ciphertext!, `customer-purchase:${row.id}`)).toContain(
      "INITIAL_CART_SECRET",
    );
    await expect(add({ ...first, revision: 2 })).rejects.toThrow("uncertain");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("submits the approved provider quote and keeps successful bank-transfer processing unconfirmed", async () => {
    const quote = await add(await start());
    const approved = (await purchases.quote(owner, owner.botId, { id: quote.id })).quote;
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: quote.id,
        expectedRevision: quote.revision,
        quote: approved,
        paymentMethod: "other",
      }),
    ).rejects.toThrow("not approved");
    const result = await purchases.checkout(owner, owner.botId, {
      id: quote.id,
      expectedRevision: quote.revision,
      quote: approved,
      paymentMethod: "bacs",
    });
    expect(result).toMatchObject({
      status: "submitted",
      summary: { order: { id: "29", status: "on-hold", paymentStatus: "unconfirmed" } },
    });
    expect(execute.mock.calls.at(-1)?.[3]).toMatchObject({
      expectedTotal: "12500",
      cartToken: "ROTATED_CART_SECRET",
      paymentMethod: "bacs",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ORDER_KEY");
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: quote.id,
        expectedRevision: quote.revision,
        quote: approved,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("changed");
    expect(
      execute.mock.calls.filter((call) => call[2] === "woocommerce.submit_checkout"),
    ).toHaveLength(1);
    expect(await start()).toMatchObject({ status: "open" });
  });
  it("persists a changed quote for a new approval before any checkout submission", async () => {
    const quote = await add(await start());
    const approved = (await purchases.quote(owner, owner.botId, { id: quote.id })).quote;
    cart.totals = { currency_code: "THB", currency_minor_unit: 2, total_price: "14000" };
    const result = await purchases.checkout(owner, owner.botId, {
      id: quote.id,
      expectedRevision: quote.revision,
      quote: approved,
      paymentMethod: "bacs",
    });
    expect(result).toMatchObject({ status: "open", revision: 3, summary: { total: "14000" } });
    expect(result.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ result: "review_required" })]),
    );
    expect(execute.mock.calls.some((call) => call[2] === "woocommerce.submit_checkout")).toBe(
      false,
    );
  });
  it("blocks after lost checkout receipt even when another nonce or service instance is used", async () => {
    const quote = await add(await start());
    const approved = (await purchases.quote(owner, owner.botId, { id: quote.id })).quote;
    execute
      .mockImplementationOnce(async () => ({ cartToken: "ROTATED_CART_SECRET", cart }))
      .mockRejectedValueOnce(new Error("Provider accepted but receipt lost"));
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: quote.id,
        expectedRevision: quote.revision,
        quote: approved,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("uncertain");
    purchases = service();
    await expect(start()).rejects.toThrow("already has");
    const [row] = (await purchases.inspect(owner, owner.botId, { conversationId })).purchases;
    expect(row).toMatchObject({ status: "uncertain", actionKind: "checkout", revision: 3 });
  });
  it("rejects foreign bots, unseen participants, disconnected accounts and in-flight customer work", async () => {
    await expect(purchases.start(owner, "other-bot", input())).rejects.toThrow();
    await expect(
      purchases.start(owner, owner.botId, { ...input(), customerId: "other-shopper" }),
    ).rejects.toThrow();
    await db.prisma.customerConversation.update({
      where: { id: conversationId },
      data: { leaseUntil: new Date(Date.now() + 60000) },
    });
    await expect(start()).rejects.toThrow("in flight");
    await db.prisma.connection.update({
      where: { id: connectionId },
      data: { status: "disconnected" },
    });
    await expect(start()).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects an account switch and a second participant before revealing or changing a cart", async () => {
    const first = await start();
    await db.prisma.connection.update({
      where: { id: connectionId },
      data: { providerRef: "other-account" },
    });
    await expect(add(first)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      purchases.inspect({ ...owner, spaceId: "other-space" }, owner.botId, { conversationId }),
    ).rejects.toThrow();
  });
  it("preserves a confirmed receipt but denies its return if staff guidance changes during dispatch", async () => {
    const first = await start();
    execute.mockImplementationOnce(async () => {
      await db.prisma.customerConversation.update({
        where: { id: conversationId },
        data: { generation: { increment: 1 } },
      });
      return { cartToken: "ROTATED_CART_SECRET", cart };
    });
    await expect(add(first)).rejects.toThrow("result was recorded");
    expect(
      await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ status: "open", revision: 2 });
  });
  it("dispatches four concurrent purchases through the production-size database pool", async () => {
    const conversation = await db.prisma.customerConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    const requests = [];
    for (let i = 0; i < 4; i++) {
      const id = await createCustomerInbox(db.prisma).receive(conversation.channelId, {
        externalId: `parallel-${i}`,
        externalThreadId: `parallel-${i}`,
        customerId: "shopper",
        name: "Shopper",
        body: "A product",
      });
      requests.push({ ...input(), conversationId: id });
    }
    let started = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    execute.mockImplementation(async () => {
      if (++started === 4) release();
      await ready;
      return { cartToken: "INITIAL_CART_SECRET", cart: structuredClone(cart) };
    });
    const results = await Promise.allSettled(
      requests.map((request) => purchases.start(owner, owner.botId, request)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it("revokes account access during checkout while preserving its final receipt", async () => {
    const row = await add(await start());
    const quote = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    execute
      .mockResolvedValueOnce({ cartToken: "ROTATED_CART_SECRET", cart: structuredClone(cart) })
      .mockImplementationOnce(async () => {
        await requestAccountDeletion(db.prisma, owner.userId);
        return { cartToken: "ROTATED_CART_SECRET", checkout: { order_id: 29, status: "on-hold" } };
      });
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: row.id,
        expectedRevision: row.revision,
        quote,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("result was recorded");
    expect(await db.prisma.customerPurchase.findUnique({ where: { id: row.id } })).toMatchObject({
      status: "submitted",
      providerOrderId: "29",
    });
    const before = execute.mock.calls.length;
    await expect(start()).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(before);
  });
  it("rejects deletion that wins between reservation and transport", async () => {
    purchases = service((_name, call) => ({
      ...wooCommerceCheckout(call),
      async create() {
        await requestAccountDeletion(db.prisma, owner.userId);
        return wooCommerceCheckout(call).create();
      },
    }));
    await expect(start()).rejects.toThrow("not dispatched");
    expect(execute).not.toHaveBeenCalled();
    expect(await db.prisma.customerPurchase.findFirst()).toMatchObject({
      status: "closed",
      actionId: null,
    });
  });
  it("does not reserve or dispatch when connection revocation wins its row lock", async () => {
    const client = await db.pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM connections WHERE id = $1 FOR UPDATE", [connectionId]);
    const pending = start().catch((error: Error) => error);
    try {
      await vi.waitFor(async () => {
        const waiting = await db.pool.query(
          `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%SELECT conversation.generation,%'`,
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      await client.query("UPDATE connections SET status = 'revoked' WHERE id = $1", [connectionId]);
      await client.query("COMMIT");
      expect(await pending).toBeInstanceOf(Error);
      expect(execute).not.toHaveBeenCalled();
      expect(await db.prisma.customerPurchase.count()).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pending;
    }
  });
  it.each(["before reservation", "before transport"])(
    "rejects a shared connection owner deletion %s",
    async (when) => {
      const otherId = randomUUID();
      await db.prisma.user.create({
        data: { id: otherId, name: "Other owner", email: `${otherId}@example.test` },
      });
      await db.prisma.connection.update({
        where: { id: connectionId },
        data: { userId: otherId, scope: "team" },
      });
      try {
        if (when === "before reservation") await requestAccountDeletion(db.prisma, otherId);
        else
          purchases = service((_name, call) => ({
            ...wooCommerceCheckout(call),
            async create() {
              await requestAccountDeletion(db.prisma, otherId);
              return wooCommerceCheckout(call).create();
            },
          }));
        await expect(start()).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
        expect(await db.prisma.customerPurchase.count({ where: { status: "creating" } })).toBe(0);
      } finally {
        await db.prisma.connection.update({
          where: { id: connectionId },
          data: { userId: owner.userId },
        });
        await db.prisma.accountDeletion.deleteMany({ where: { userId: otherId } });
        await db.prisma.user.delete({ where: { id: otherId } });
      }
    },
  );
  it("does not dispatch a suspended reservation after the cleanup window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      purchases = service((_name, call) => ({
        ...wooCommerceCheckout(call),
        async create() {
          vi.setSystemTime(Date.now() + purchaseRecoveryMs + 1);
          return wooCommerceCheckout(call).create();
        },
      }));
      await expect(start()).rejects.toThrow("not dispatched");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not submit after the dispatch deadline passes during quote refresh", async () => {
    const row = await add(await start());
    const quote = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      execute.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + purchaseDispatchMs + 1);
        return { cartToken: "ROTATED_CART_SECRET", cart: structuredClone(cart) };
      });
      await expect(
        purchases.checkout(owner, owner.botId, {
          id: row.id,
          expectedRevision: row.revision,
          quote,
          paymentMethod: "bacs",
        }),
      ).rejects.toThrow("uncertain");
      expect(execute.mock.calls.some((call) => call[2] === "woocommerce.submit_checkout")).toBe(
        false,
      );
      expect(await db.prisma.customerPurchase.findUnique({ where: { id: row.id } })).toMatchObject({
        status: "uncertain",
        actionKind: "checkout",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not dispatch when encrypted state is transplanted from another purchase", async () => {
    const first = await start();
    await db.prisma.customerPurchase.update({
      where: { id: first.id },
      data: { ciphertext: secrets.seal("{}", "customer-purchase:other") },
    });
    await expect(add(first)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing connector capability before reserving state", async () => {
    preflight.mockRejectedValueOnce(new Error("Missing Store API patch"));
    await expect(start()).rejects.toThrow("Missing Store API");
    expect(await db.prisma.customerPurchase.count()).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects local invalid item/rate selections and an empty checkout without stranding the cart", async () => {
    let row = await start();
    for (const change of [
      { kind: "quantity", key: "foreign", quantity: 1 },
      { kind: "shipping", packageId: 0, rateId: "foreign" },
    ]) {
      await expect(
        purchases.update(owner, owner.botId, {
          id: row.id,
          expectedRevision: row.revision,
          change,
        }),
      ).rejects.toThrow("not dispatched");
      row = (await purchases.inspect(owner, owner.botId, { conversationId })).purchases[0]!;
      expect(row.status).toBe("open");
    }
    const approved = await purchases.quote(owner, owner.botId, { id: row.id });
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: row.id,
        expectedRevision: row.revision,
        quote: approved.quote,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("not dispatched");
    expect(execute).toHaveBeenCalledTimes(1);
    const latest = (await purchases.inspect(owner, owner.botId, { conversationId })).purchases[0]!;
    expect(latest.status).toBe("open");
    expect(await add(latest)).toMatchObject({ status: "open" });
  });
  it("binds the human-readable quote and detects provider-side address changes", async () => {
    const row = await add(await start());
    const approved = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    expect(approved.billing.email).toBe("private-address-sentinel@example.test");
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: row.id,
        expectedRevision: row.revision,
        quote: { ...approved, summary: { ...approved.summary, total: "1" } },
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("not dispatched");
    expect(execute).toHaveBeenCalledTimes(2);
    cart.billing_address = { email: "changed@example.test" };
    const result = await purchases.checkout(owner, owner.botId, {
      id: row.id,
      expectedRevision: row.revision + 1,
      quote: approved,
      paymentMethod: "bacs",
    });
    expect(result.status).toBe("open");
    expect(execute.mock.calls.some((call) => call[2] === "woocommerce.submit_checkout")).toBe(
      false,
    );
    expect((await purchases.quote(owner, owner.botId, { id: row.id })).quote.billing.email).toBe(
      "changed@example.test",
    );
  });
  it("retires an abandoned cart locally, erases its capability and preserves an unresolved action's audit", async () => {
    const request = input();
    const first = await purchases.start(owner, owner.botId, request);
    execute.mockRejectedValueOnce(new Error("lost cart update"));
    await expect(add(first)).rejects.toThrow("uncertain");
    await expect(
      purchases.close(owner, owner.botId, {
        id: first.id,
        expectedRevision: 2,
        reason: "Shopper cancelled",
      }),
    ).rejects.toThrow("five minutes");
    await db.prisma.customerPurchase.update({
      where: { id: first.id },
      data: { actionStartedAt: new Date(0) },
    });
    const result = await purchases.close(owner, owner.botId, {
      id: first.id,
      expectedRevision: 2,
      reason: "Shopper cancelled",
    });
    expect(result).toMatchObject({ status: "closed", revision: 3 });
    expect(result.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          previousStatus: "uncertain",
          previousAction: expect.objectContaining({ kind: "add", inputHash: expect.any(String) }),
        }),
      ]),
    );
    expect(
      await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ ciphertext: null, activeKey: null });
    expect(await purchases.start(owner, owner.botId, request)).toMatchObject({ status: "closed" });
    expect(await start()).toMatchObject({ status: "open" });
  });
  it("cannot close an attempted checkout even after the provider timeout", async () => {
    const row = await add(await start());
    const approved = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    execute
      .mockImplementationOnce(async () => ({ cartToken: "ROTATED_CART_SECRET", cart }))
      .mockRejectedValueOnce(new Error("lost checkout"));
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: row.id,
        expectedRevision: row.revision,
        quote: approved,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("uncertain");
    await db.prisma.customerPurchase.update({
      where: { id: row.id },
      data: { actionStartedAt: new Date(0) },
    });
    await expect(
      purchases.close(owner, owner.botId, {
        id: row.id,
        expectedRevision: 3,
        reason: "Try another",
      }),
    ).rejects.toThrow("attempted checkout");
  });
  it("retains uncertainty when the provider succeeds but recording the new state rolls back", async () => {
    const first = await start();
    await db.prisma.$executeRawUnsafe(
      `CREATE FUNCTION reject_purchase_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status = 'updating' AND NEW.status = 'open' THEN RAISE EXCEPTION 'synthetic result failure'; END IF; RETURN NEW; END $$`,
    );
    await db.prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_purchase_result BEFORE UPDATE ON customer_purchases FOR EACH ROW EXECUTE FUNCTION reject_purchase_result()`,
    );
    try {
      await expect(add(first)).rejects.toThrow("uncertain");
      expect(cart.items).toEqual([{ key: "cart-item", id: 7, name: "Product", quantity: 1 }]);
      expect(
        await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: first.id } }),
      ).toMatchObject({ status: "uncertain", actionKind: "add" });
      await expect(add({ ...first, revision: 2 })).rejects.toThrow("uncertain");
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await db.prisma.$executeRawUnsafe(
        `DROP TRIGGER reject_purchase_result ON customer_purchases`,
      );
      await db.prisma.$executeRawUnsafe(`DROP FUNCTION reject_purchase_result()`);
    }
  });
  it("retains uncertainty when recording a refreshed checkout quote fails", async () => {
    const row = await add(await start());
    const approved = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    cart.billing_address = { email: "changed@example.test" };
    await db.prisma.$executeRawUnsafe(
      `CREATE FUNCTION reject_quote_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status = 'submitting' AND NEW.status = 'open' THEN RAISE EXCEPTION 'synthetic quote failure'; END IF; RETURN NEW; END $$`,
    );
    await db.prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_quote_result BEFORE UPDATE ON customer_purchases FOR EACH ROW EXECUTE FUNCTION reject_quote_result()`,
    );
    try {
      await expect(
        purchases.checkout(owner, owner.botId, {
          id: row.id,
          expectedRevision: row.revision,
          quote: approved,
          paymentMethod: "bacs",
        }),
      ).rejects.toThrow("uncertain");
      expect(
        await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ status: "uncertain", actionKind: "checkout" });
      expect(execute.mock.calls.map((call) => call[2])).not.toContain(
        "woocommerce.submit_checkout",
      );
    } finally {
      await db.prisma.$executeRawUnsafe(`DROP TRIGGER reject_quote_result ON customer_purchases`);
      await db.prisma.$executeRawUnsafe(`DROP FUNCTION reject_quote_result()`);
    }
  });
  it("paginates older unresolved purchases beyond the newest hundred", async () => {
    const first = await start();
    const row = await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: first.id } });
    await db.prisma.customerPurchase.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        ...row,
        paymentMethods: ["bacs"],
        summary: {},
        history: [],
        id: `closed-${index}`,
        status: "closed",
        ciphertext: null,
        activeKey: null,
        createdAt: new Date(row.createdAt.getTime() + index + 1),
      })),
    });
    const page = await purchases.inspect(owner, owner.botId, { conversationId });
    expect(page.purchases).toHaveLength(100);
    const older = await purchases.inspect(owner, owner.botId, {
      conversationId,
      cursor: page.nextCursor,
    });
    expect(older.purchases.map((purchase) => purchase.id)).toEqual([first.id]);
    expect(older.nextCursor).toBeNull();
    await expect(
      purchases.inspect(owner, owner.botId, { conversationId, cursor: "foreign-cursor" }),
    ).rejects.toThrow();
  });
  it("reserves a final abandon decision when checkout refresh reaches the history limit", async () => {
    const row = await add(await start());
    const quote = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    await db.prisma.customerPurchase.update({
      where: { id: row.id },
      data: { history: Array.from({ length: 100 }, () => ({ result: "confirmed" })) },
    });
    await expect(add(row)).rejects.toThrow("limit");
    cart.totals = { currency_code: "THB", currency_minor_unit: 2, total_price: "15000" };
    const refreshed = await purchases.checkout(owner, owner.botId, {
      id: row.id,
      expectedRevision: row.revision,
      quote,
      paymentMethod: "bacs",
    });
    expect(refreshed.status).toBe("open");
    const finalQuote = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: row.id,
        expectedRevision: refreshed.revision,
        quote: finalQuote,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("limit");
    const closed = await purchases.close(owner, owner.botId, {
      id: row.id,
      expectedRevision: refreshed.revision,
      reason: "Finish at merchant checkout",
    });
    expect(closed).toMatchObject({ status: "closed" });
    expect(closed.history).toHaveLength(102);
    expect(execute.mock.calls.map((call) => call[2])).not.toContain("woocommerce.submit_checkout");
  });
  async function loseCheckout() {
    const row = await add(await start());
    const quote = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    execute
      .mockImplementationOnce(async () => ({
        cartToken: "ROTATED_CART_SECRET",
        cart: structuredClone(cart),
      }))
      .mockRejectedValueOnce(new Error("Lost checkout response"));
    await expect(
      purchases.checkout(owner, owner.botId, {
        id: row.id,
        expectedRevision: row.revision,
        quote,
        paymentMethod: "bacs",
      }),
    ).rejects.toThrow("uncertain");
    return { id: row.id, revision: row.revision + 1 };
  }
  async function orderFor(id: string, overrides: Record<string, unknown> = {}) {
    const row = await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id } });
    const state = JSON.parse(secrets.load(row.ciphertext!, `customer-purchase:${id}`));
    return {
      id: 29,
      status: "on-hold",
      currency: "THB",
      total: "125.00",
      customerNote: `Deskazo purchase ${id}`,
      paymentMethod: "bacs",
      needsPayment: false,
      datePaidGmt: null,
      transactionId: null,
      billing: state.billing,
      shipping: state.shipping,
      lineItems: [{ productId: 7, variationId: 0, quantity: 1 }],
      ...overrides,
    };
  }
  const reconcile = (row: { id: string; revision: number }) =>
    purchases.reconcile(owner, owner.botId, {
      id: row.id,
      expectedRevision: row.revision,
      orderId: "29",
      reason: "Located the matching merchant order",
    });
  it("recovers a lost checkout receipt after restart by reading its exact purchase reference", async () => {
    const row = await loseCheckout();
    const submittedInput = execute.mock.calls.find(
      (call) => call[2] === "woocommerce.submit_checkout",
    )?.[3];
    expect(submittedInput).toMatchObject({ customerNote: `Deskazo purchase ${row.id}` });
    purchases = service();
    execute.mockResolvedValueOnce(await orderFor(row.id));
    const result = await reconcile(row);
    expect(result).toMatchObject({
      status: "submitted",
      summary: {
        order: {
          id: "29",
          paymentStatus: "unconfirmed",
          observedAt: expect.any(String),
          total: "12500",
        },
      },
    });
    expect(execute.mock.lastCall?.slice(2, 4)).toEqual(["woocommerce.get_order", { orderId: 29 }]);
    expect(execute.mock.lastCall?.[6]).toBe("read");
    expect(result.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "reconcile",
          observation: expect.objectContaining({
            id: "29",
            paymentStatus: "unconfirmed",
            observedAt: expect.any(String),
          }),
          previousAction: expect.objectContaining({
            id: expect.any(String),
            inputHash: expect.any(String),
          }),
        }),
      ]),
    );
    expect(
      await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ providerOrderId: "29", actionId: null, activeKey: null });
    await expect(reconcile(row)).rejects.toThrow("changed");
    expect(
      execute.mock.calls.filter((call) => call[2] === "woocommerce.submit_checkout"),
    ).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private-address-sentinel");
    expect(await start()).toMatchObject({ status: "open" });
  });
  it.each([
    { customerNote: "another-purchase" },
    { id: 30 },
    { status: "checkout-draft" },
    { currency: "USD" },
    { total: "126.00" },
    { paymentMethod: "card" },
    { lineItems: [{ productId: 7, variationId: 0, quantity: 2 }] },
    { billing: { email: "another@example.test" } },
    { total: "125.001" },
  ])("does not resolve checkout using mismatched provider evidence %j", async (overrides) => {
    const row = await loseCheckout();
    execute.mockResolvedValueOnce(await orderFor(row.id, overrides));
    await expect(reconcile(row)).rejects.toThrow("did not confirm");
    expect(
      await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: "uncertain", revision: row.revision, providerOrderId: null });
    expect(
      execute.mock.calls.filter((call) => call[2] === "woocommerce.submit_checkout"),
    ).toHaveLength(1);
  });
  it("refreshes provider payment facts without treating bank-transfer processing or stale dates as funds received", async () => {
    const row = await loseCheckout();
    execute.mockResolvedValueOnce(await orderFor(row.id));
    const recovered = await reconcile(row);
    const facts = {
      status: "processing",
      datePaidGmt: "2026-09-18T12:00:00",
      transactionId: "synthetic-transaction",
    };
    execute.mockResolvedValueOnce(await orderFor(row.id, facts));
    const paid = await purchases.status(owner, owner.botId, { id: row.id });
    expect(paid).toMatchObject({
      summary: {
        order: {
          paymentStatus: "recorded_paid",
          recordedPaidAt: "2026-09-18T12:00:00.000Z",
          transactionId: "synthetic-transaction",
        },
      },
    });
    expect(paid.history).toEqual(recovered.history);
    execute.mockResolvedValueOnce(await orderFor(row.id, { ...facts, status: "refunded" }));
    expect(await purchases.status(owner, owner.botId, { id: row.id })).toMatchObject({
      summary: { order: { status: "refunded", paymentStatus: "unconfirmed" } },
    });
    execute.mockRejectedValueOnce(new Error("read unavailable"));
    await expect(purchases.status(owner, owner.botId, { id: row.id })).rejects.toThrow(
      "did not confirm",
    );
    expect(
      execute.mock.calls.filter((call) => call[2] === "woocommerce.submit_checkout"),
    ).toHaveLength(1);
  });
  it.each([
    { status: "completed", datePaidGmt: null },
    { status: "on-hold", datePaidGmt: "2026-09-18T12:00:00" },
    { status: "processing", datePaidGmt: "2026-09-18T12:00:00", needsPayment: true },
    { status: "processing", datePaidGmt: "2026-09-18T12:00:00", needsPayment: null },
  ])("keeps incomplete or conflicting payment facts unconfirmed %j", async (facts) => {
    const row = await loseCheckout();
    execute.mockResolvedValueOnce(await orderFor(row.id, facts));
    expect(await reconcile(row)).toMatchObject({
      summary: { order: { paymentStatus: "unconfirmed" } },
    });
  });
  it("allows one of two concurrent recovery decisions and never retries checkout", async () => {
    const row = await loseCheckout();
    const order = await orderFor(row.id);
    execute.mockResolvedValueOnce(order).mockResolvedValueOnce(order);
    const results = await Promise.allSettled([reconcile(row), reconcile(row)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      execute.mock.calls.filter((call) => call[2] === "woocommerce.submit_checkout"),
    ).toHaveLength(1);
  });
  it("reconciles an abandoned worker while fencing its late checkout response", async () => {
    const row = await add(await start());
    const quote = (await purchases.quote(owner, owner.botId, { id: row.id })).quote;
    let signalStarted!: () => void;
    let releaseResponse!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const response = new Promise<unknown>((resolve) => {
      releaseResponse = resolve;
    });
    execute
      .mockResolvedValueOnce({ cartToken: "ROTATED_CART_SECRET", cart: structuredClone(cart) })
      .mockImplementationOnce(async () => {
        signalStarted();
        return response;
      });
    const pending = purchases
      .checkout(owner, owner.botId, {
        id: row.id,
        expectedRevision: row.revision,
        quote,
        paymentMethod: "bacs",
      })
      .catch((error: Error) => error);
    await started;
    await expect(reconcile({ ...row, revision: row.revision + 1 })).rejects.toThrow("five minutes");
    await db.prisma.customerPurchase.update({
      where: { id: row.id },
      data: { actionStartedAt: new Date(0) },
    });
    execute.mockResolvedValueOnce(await orderFor(row.id));
    await reconcile({ ...row, revision: row.revision + 1 });
    releaseResponse({
      cartToken: "ROTATED_CART_SECRET",
      checkout: { order_id: 29, status: "on-hold" },
    });
    expect(await pending).toBeInstanceOf(Error);
    expect(
      await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: "submitted", providerOrderId: "29", revision: row.revision + 2 });
  });
  it("keeps the unresolved action when recording recovery fails", async () => {
    const row = await loseCheckout();
    execute.mockResolvedValueOnce(await orderFor(row.id));
    await db.prisma.$executeRawUnsafe(
      `CREATE FUNCTION reject_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status = 'uncertain' AND NEW.status = 'submitted' THEN RAISE EXCEPTION 'synthetic recovery failure'; END IF; RETURN NEW; END $$`,
    );
    await db.prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_recovery BEFORE UPDATE ON customer_purchases FOR EACH ROW EXECUTE FUNCTION reject_recovery()`,
    );
    try {
      await expect(reconcile(row)).rejects.toThrow();
      expect(
        await db.prisma.customerPurchase.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ status: "uncertain", revision: row.revision, actionKind: "checkout" });
    } finally {
      await db.prisma.$executeRawUnsafe(`DROP TRIGGER reject_recovery ON customer_purchases`);
      await db.prisma.$executeRawUnsafe(`DROP FUNCTION reject_recovery()`);
    }
    execute.mockResolvedValueOnce(await orderFor(row.id));
    expect(await reconcile(row)).toMatchObject({ status: "submitted" });
  });
  it("can recover a resolved case on a disabled channel but not an account switched during lookup", async () => {
    const row = await loseCheckout();
    const order = await orderFor(row.id);
    const conversation = await db.prisma.customerConversation.update({
      where: { id: conversationId },
      data: { state: "resolved" },
    });
    await db.prisma.customerChannel.update({
      where: { id: conversation.channelId },
      data: { enabled: false },
    });
    execute.mockImplementationOnce(async () => {
      await db.prisma.connection.update({
        where: { id: connectionId },
        data: { providerRef: "changed-account" },
      });
      return order;
    });
    await expect(reconcile(row)).rejects.toThrow();
    await db.prisma.connection.update({
      where: { id: connectionId },
      data: { providerRef: "ACCOUNT_PRIVATE" },
    });
    execute.mockResolvedValueOnce(order);
    expect(await reconcile(row)).toMatchObject({ status: "submitted" });
  });
  it("rejects an adapter write during recovery before connector execution", async () => {
    const row = await loseCheckout();
    purchases = service((_name, call) => ({
      ...wooCommerceCheckout(call),
      async readOrder(state) {
        await call("woocommerce.submit_checkout", {}, "write");
        return state;
      },
    }));
    const before = execute.mock.calls.length;
    await expect(reconcile(row)).rejects.toThrow("did not confirm");
    expect(execute).toHaveBeenCalledTimes(before);
  });
  it("enforces one local association per connected provider order", async () => {
    const row = await loseCheckout();
    execute.mockResolvedValueOnce(await orderFor(row.id));
    await reconcile(row);
    await expect(
      db.prisma.customerPurchase.create({
        data: {
          id: "another-purchase",
          conversationId,
          customerId: "shopper",
          connectionId,
          providerRef: "ACCOUNT_PRIVATE",
          providerOrderId: "29",
          requestHash: "synthetic",
          paymentMethods: ["bacs"],
          status: "submitted",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
  it("keeps payment refresh available at the audit limit and denies foreign readers", async () => {
    const row = await loseCheckout();
    execute.mockResolvedValueOnce(await orderFor(row.id));
    await reconcile(row);
    await db.prisma.customerPurchase.update({
      where: { id: row.id },
      data: { history: Array.from({ length: 102 }, () => ({ kind: "synthetic-existing-review" })) },
    });
    execute.mockResolvedValueOnce(
      await orderFor(row.id, { status: "completed", datePaidGmt: "2026-09-18T12:00:00" }),
    );
    const refreshed = await purchases.status(owner, owner.botId, { id: row.id });
    expect(refreshed.history).toHaveLength(102);
    expect(refreshed.summary).toMatchObject({ order: { paymentStatus: "recorded_paid" } });
    const before = execute.mock.calls.length;
    await expect(
      purchases.status({ ...owner, spaceId: "foreign-space" }, owner.botId, { id: row.id }),
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(before);
  });
  it.each(["conversation", "connection"])(
    "erases cart secrets and audit with the %s",
    async (kind) => {
      await start();
      if (kind === "conversation")
        await db.prisma.customerConversation.delete({ where: { id: conversationId } });
      else await db.prisma.connection.delete({ where: { id: connectionId } });
      expect(await db.prisma.customerPurchase.count()).toBe(0);
    },
  );
});
