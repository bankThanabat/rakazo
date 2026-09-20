#!/usr/bin/env -S pnpm exec tsx
/** Owned synthetic lab only. Exercises real Deskazo purchase state and HTTP visitor consent.
 * Usage: pnpm exec tsx scripts/verify-deskazo-woocommerce.mts <private-lab-directory> [run-name]
 * Add --lose-response after the run name to drop one real checkout response and verify recovery.
 * Requires the persistent local provider lab; never points at a merchant deployment.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCustomerConnector } from "../packages/adapters/src/customer-connector.js";
import { createCustomerPurchases } from "../packages/adapters/src/customer-purchases.js";
import { IntegrationProviderSettings } from "../packages/adapters/src/integration-provider-settings.js";
import { EncryptedSecretStore } from "../packages/adapters/src/secrets.js";
import { wooCommerceCheckout } from "../packages/adapters/src/woocommerce-checkout.js";
import { CustomerPurchaseSummary } from "../packages/contracts/src/customer-purchase.js";
import { createDb } from "../packages/db/src/index.js";

assert.ok(process.argv[2], "Provide the owned private lab directory");
const directory = resolve(process.argv[2]!);
const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
const save = (name: string, value: unknown) =>
  writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const env = read("environment.private.json");
const credentials = read("private.json");
const store = read("store.json");
const origin = env.WEB_ORIGIN as string;
assert.equal(new URL(origin).hostname, "127.0.0.1", "Only the owned loopback lab is allowed");
assert.equal(new URL(env.DATABASE_URL).hostname, "127.0.0.1");
assert.equal(new URL(env.DATABASE_URL).port, "15434");
const db = createDb(env.DATABASE_URL);
const runName = process.argv[3] ?? "default";
const loseResponse = process.argv[4] === "--lose-response";
assert.match(runName, /^[a-z0-9-]{1,40}$/);
const file = `deskazo-purchase-${runName}-state.private.json`;
const state = existsSync(resolve(directory, file)) ? read(file) : { nonce: randomUUID() };
const checks: string[] = [];
const dispatches: string[] = [];
try {
  assert.equal(await db.prisma.user.count(), 1, "This must be a dedicated synthetic database");
  const user = await db.prisma.user.findUniqueOrThrow({
    where: { email: "deskazo-v1@example.test" },
  });
  const member = await db.prisma.spaceMember.findFirstOrThrow({ where: { userId: user.id } });
  const actor = { userId: user.id, spaceId: member.spaceId };
  const login = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: credentials.appPassword }),
  });
  assert.ok(login.ok, "Synthetic owner authentication");
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const rpc = async (path: string, input: unknown) => {
    const response = await fetch(`${origin}/rpc/${path}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `Authenticated ${path} returned ${response.status}`);
    return (await response.json()).json;
  };
  if (!state.botId) {
    const bot = await rpc("bots/create", {
      name: "Synthetic checkout check",
      spawnKey: "owned-woocommerce-acceptance",
    });
    state.botId = bot.id;
    save(file, state);
  }
  const connection = await db.prisma.connection.findFirstOrThrow({
    where: { ...actor, provider: "woocommerce", status: "connected" },
  });
  const actions = await rpc("connections/actions", { connectionId: connection.id });
  assert.equal(
    actions.find((action: { name: string }) => action.name === "woocommerce.list_orders")?.readOnly,
    true,
    "The running API must load the audited order discovery classification",
  );
  checks.push("running API reports order discovery as read-only");
  const secrets = new EncryptedSecretStore(env.ENCRYPTION_KEY);
  const savedConfig = await db.prisma.integrationProviderConfig.findUniqueOrThrow({
    where: { id: "open-connector" },
  });
  const config = JSON.parse(
    secrets.load(savedConfig.ciphertext, "integration-provider:open-connector"),
  );
  assert.equal(
    config.endpoint,
    "http://127.0.0.1:13000",
    "Only the owned local connector is eligible",
  );
  const grantRow = await db.prisma.secret.findUniqueOrThrow({
    where: { id: connection.providerRef! },
  });
  const grant = JSON.parse(secrets.load(grantRow.ciphertext, connection.providerRef!));
  const accountsResponse = await fetch(`${config.endpoint}/api/connections`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(accountsResponse.ok);
  const accounts = await accountsResponse.json();
  assert.equal(
    accounts.find((account: { id: string }) => account.id === grant.accountId)?.profile?.accountId,
    "https://store",
    "Only the owned Docker store is eligible",
  );
  const integrations = new IntegrationProviderSettings(db.prisma, secrets, env.ENCRYPTION_KEY);
  const connector = createCustomerConnector({ prisma: db.prisma, integrations });
  const product = (await connector.execute(
    actor,
    connection.id,
    "woocommerce.get_product",
    { productId: store.productId },
    randomUUID(),
  )) as { sku: string };
  assert.equal(product.sku, "FIXTURE-ONLY", "Only the owned synthetic product is eligible");
  checks.push("product read through saved app connection");
  // Seed only the test channel: model-led setup is a separate acceptance gate.
  const channel = await db.prisma.customerChannel.upsert({
    where: { provider_accountId: { provider: "web", accountId: state.botId } },
    create: {
      ...actor,
      botId: state.botId,
      provider: "web",
      accountId: state.botId,
      name: "Synthetic checkout check",
      ciphertext: "",
      websiteOrigins: [origin],
      autoReplies: false,
    },
    update: {},
  });
  assert.equal(
    channel.autoReplies,
    false,
    "Automatic replies must stay disabled for this seeded check",
  );
  const visit = async (token: string | undefined, path: string, body?: unknown) => {
    const response = await fetch(`${origin}/api/customer-web/${channel.id}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return { response, body: await response.json() };
  };
  if (!state.visitor) {
    const session = await visit(undefined, "session", { name: "Synthetic shopper" });
    assert.ok(session.response.ok);
    state.visitor = session.body;
    save(file, state);
    const sent = await visit(state.visitor.token, "messages", {
      nonce: state.nonce,
      body: "Please quote one synthetic fixture product.",
    });
    assert.ok(sent.response.ok);
  }
  const conversation = await db.prisma.customerConversation.findUniqueOrThrow({
    where: { id: state.visitor.conversationId },
  });
  const purchases = createCustomerPurchases({
    prisma: db.prisma,
    secrets,
    connector: {
      ...connector,
      execute: async (...args: Parameters<typeof connector.execute>) => {
        dispatches.push(args[2]);
        const result = await connector.execute(...args);
        if (loseResponse && args[2] === "woocommerce.submit_checkout") {
          // Discard the response, including the order ID. Recovery must find it independently.
          throw new Error("Deliberately lost the confirmed provider response");
        }
        return result;
      },
    },
    provider: (name, execute) => {
      assert.equal(name, "woocommerce");
      return wooCommerceCheckout(execute);
    },
  });
  async function findOrder(purchaseId: string) {
    dispatches.push("woocommerce.list_orders");
    const list = (await connector.execute(
      actor,
      connection.id,
      "woocommerce.list_orders",
      { page: 1, perPage: 100 },
      randomUUID(),
      "staff",
      "read",
    )) as {
      orders: Array<{ id: number; customerNote: string | null }>;
      total: number;
      totalPages: number;
    };
    assert.ok(
      list.totalPages <= 1 && list.orders.length === list.total,
      "The owned fixture order inventory must fit in one complete page",
    );
    const matches = list.orders.filter(
      (order) => order.customerNote === `Deskazo purchase ${purchaseId}`,
    );
    assert.equal(matches.length, 1, "Exactly one provider order must have this purchase reference");
    return String(matches[0]!.id);
  }
  function unpaid(summary: unknown, expectedOrderId: string) {
    const order = CustomerPurchaseSummary.parse(summary).order;
    assert.equal(order?.id, expectedOrderId);
    assert.equal(order?.currency, "THB");
    assert.equal(order?.total, "12500");
    assert.equal(order?.status, "on-hold");
    assert.equal(order?.paymentStatus, "unconfirmed");
    assert.equal(order?.recordedPaidAt, null);
  }
  const startInput = {
    conversationId: conversation.id,
    connectionId: connection.id,
    customerId: conversation.customerId,
    nonce: state.nonce,
    paymentMethods: ["bacs"],
  };
  let purchase = await purchases.start(actor, state.botId, startInput);
  if (state.purchaseId)
    assert.equal(purchase.id, state.purchaseId, "Rerun must use the same durable purchase");
  state.purchaseId = purchase.id;
  save(file, state);
  if (purchase.status === "uncertain" && loseResponse) {
    const orderId = await findOrder(purchase.id);
    purchase = await purchases.reconcile(actor, state.botId, {
      id: purchase.id,
      expectedRevision: purchase.revision,
      orderId,
      reason: "Resume the owned synthetic lost-response check through provider readback",
    });
    checks.push("resumed uncertain purchase without repeating checkout");
  }
  if (purchase.status === "submitted") {
    const orderId = await findOrder(purchase.id);
    if (state.orderId)
      assert.equal(orderId, state.orderId, "Provider order must not change on reread");
    const observation = await purchases.status(actor, state.botId, { id: purchase.id });
    unpaid(observation.summary, orderId);
    state.orderId = orderId;
    save(file, state);
    assert.ok(
      dispatches.every((action) =>
        ["woocommerce.get_order", "woocommerce.list_orders"].includes(action),
      ),
    );
    save(`deskazo-purchase-${runName}-recheck.json`, {
      at: new Date().toISOString(),
      checks,
      status: purchase.status,
      observation,
      dispatches,
      note: "Existing purchase reread; no new checkout",
    });
    console.log("Existing Deskazo purchase reread without another checkout.");
  } else {
    assert.equal(purchase.status, "open", "Do not retry an uncertain purchase");
    const address = {
      firstName: "Synthetic",
      lastName: "Shopper",
      company: "",
      address1: "1 Test Street",
      address2: "",
      city: "Bangkok",
      state: "TH-10",
      postcode: "10100",
      country: "TH",
      email: "shopper@example.test",
      phone: "020000000",
    };
    if (CustomerPurchaseSummary.parse(purchase.summary).items.length === 0) {
      purchase = await purchases.update(actor, state.botId, {
        id: purchase.id,
        expectedRevision: purchase.revision,
        change: { kind: "add", productId: store.productId, quantity: 1 },
      });
    }
    if (!state.addressAdded) {
      purchase = await purchases.update(actor, state.botId, {
        id: purchase.id,
        expectedRevision: purchase.revision,
        change: { kind: "address", billing: address, shipping: address },
      });
      state.addressAdded = true;
      save(file, state);
    }
    const quoted = await purchases.quote(actor, state.botId, { id: purchase.id });
    assert.equal(quoted.quote.summary.total, "12500");
    assert.equal(quoted.quote.summary.currency, "THB");
    assert.equal(quoted.quote.summary.minorUnit, 2);
    const checkout = {
      id: purchase.id,
      expectedRevision: purchase.revision,
      quote: quoted.quote,
      paymentMethod: "bacs",
    };
    await assert.rejects(purchases.checkout(actor, state.botId, checkout), /shopper must confirm/);
    assert.ok(!dispatches.includes("woocommerce.submit_checkout"));
    checks.push("checkout blocked before shopper confirmation");
    const review = await purchases.requestReview(actor, state.botId, checkout);
    const pending = await visit(state.visitor.token, "purchases");
    assert.ok(pending.response.ok);
    assert.equal(pending.body.reviews[0].id, review.id);
    const stranger = await visit(undefined, "session", { name: "Different synthetic shopper" });
    const decision = { purchaseId: purchase.id, reviewId: review.id, decision: "confirmed" };
    assert.equal(
      (await visit(stranger.body.token, "purchases/decision", decision)).response.status,
      403,
    );
    checks.push("other visitor cannot confirm this purchase");
    for (let repeat = 0; repeat < 2; repeat++)
      assert.ok((await visit(state.visitor.token, "purchases/decision", decision)).response.ok);
    checks.push("authenticated shopper confirmation and replay");
    if (loseResponse) {
      await assert.rejects(
        purchases.checkout(actor, state.botId, checkout),
        /outcome is uncertain/,
      );
      const uncertain = await db.prisma.customerPurchase.findUniqueOrThrow({
        where: { id: purchase.id },
      });
      assert.equal(uncertain.status, "uncertain");
      await assert.rejects(
        purchases.checkout(actor, state.botId, checkout),
        /Purchase changed or is uncertain/,
      );
      await assert.rejects(
        purchases.start(actor, state.botId, { ...startInput, nonce: randomUUID() }),
        /already has an open or uncertain purchase/,
      );
      const recoveryInput = {
        id: purchase.id,
        expectedRevision: uncertain.revision,
        orderId: await findOrder(purchase.id),
        reason: "Recover the owned synthetic order after a deliberately lost response",
      };
      await assert.rejects(
        purchases.reconcile(actor, state.botId, {
          ...recoveryInput,
          orderId: String(read("purchase-receipt.json").orderId),
        }),
        /did not confirm/,
      );
      purchase = await purchases.reconcile(actor, state.botId, recoveryInput);
      checks.push(
        "lost response stays uncertain and blocks resubmission or a replacement cart",
        "wrong order rejected; exact order independently found by purchase reference and recovered",
      );
    } else {
      purchase = await purchases.checkout(actor, state.botId, checkout);
    }
    assert.equal(purchase.status, "submitted");
    await assert.rejects(
      purchases.checkout(actor, state.botId, checkout),
      /Purchase changed or is uncertain/,
    );
    assert.equal(dispatches.filter((action) => action === "woocommerce.submit_checkout").length, 1);
    checks.push("replayed checkout rejected before a second provider submission");
    const observation = await purchases.status(actor, state.botId, { id: purchase.id });
    const orderId = await findOrder(purchase.id);
    unpaid(observation.summary, orderId);
    state.orderId = orderId;
    save(file, state);
    checks.push("one matching order in the complete provider order inventory");
    checks.push("provider order remains unpaid; no fabricated payment confirmation");
    const report = {
      at: new Date().toISOString(),
      checks,
      dispatches,
      purchaseStatus: purchase.status,
      observation,
      scope:
        "Owned synthetic store. Real purchase service, saved connection and HTTP visitor consent. Seeded channel; no model-led setup, staff approval UI, payment gateway, hosted parity or complete journey claim.",
    };
    save(`deskazo-purchase-${runName}-receipt.json`, report);
    console.log(JSON.stringify({ checks, dispatches, purchaseStatus: purchase.status }));
  }
} finally {
  await db.prisma.$disconnect();
  await db.pool.end();
}
