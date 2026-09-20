#!/usr/bin/env node
// Usage: node scripts/verify-woocommerce-purchase.mjs /path/to/open-connector
// Docker required. Uses real WooCommerce with synthetic data, no external payments.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.argv[2], "Provide an OpenConnector source checkout");
const source = resolve(process.argv[2]);
const plugin = resolve(root, "test-report/deskazo-v1/woocommerce-fixture/woocommerce.11.1.0.zip");
const pluginHash = "6bae9bf74d722b6deb15f049687c311cfafc26e3a5d8fa55ac6ea4b9a3a8df19";
const project = `deskazo-woo-${randomBytes(6).toString("hex")}`;
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort());
const compose = async (args, { cleanup = false, input } = {}) => {
  const pending = exec(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      resolve(root, "packages/testkit/fixtures/woocommerce/compose.yml"),
      ...args,
    ],
    {
      env: { ...process.env, WOO_FIXTURE_PLUGIN: plugin },
      signal: cleanup ? undefined : controller.signal,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (input !== undefined) pending.child.stdin.end(input);
  return (await pending).stdout.trim();
};
const wp = (...args) => compose(["run", "--rm", "-T", "cli", "wp", ...args]);
const allowedChanges = [
  "actions.ts",
  "runtime.ts",
  "order-payment.test.ts",
  "store-actions.ts",
  "store-runtime.ts",
  "store-api.test.ts",
].map((file) => `src/providers/woocommerce/${file}`);
const changedFiles = (await exec("git", ["-C", source, "diff", "HEAD", "--name-only"])).stdout
  .trim()
  .split("\n")
  .filter(Boolean);
assert.ok(
  changedFiles.every((file) => allowedChanges.includes(file)),
  "Use an upstream checkout with only the reviewed WooCommerce changes",
);
const untrackedSource = (
  await exec("git", ["-C", source, "ls-files", "--others", "--exclude-standard", "--", "src"])
).stdout
  .trim()
  .split("\n")
  .filter(Boolean);
assert.ok(
  untrackedSource.every((file) => allowedChanges.includes(file)),
  "No unrelated untracked upstream source",
);
const report = {
  status: "failed",
  sourceRevision: (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim(),
  providerDiff:
    (await exec("git", ["-C", source, "diff", "--", "src/providers/woocommerce"])).stdout.length >
    0,
  providerFiles: Object.fromEntries(
    await Promise.all(
      [
        "actions.ts",
        "runtime.ts",
        "order-payment.test.ts",
        "store-actions.ts",
        "store-runtime.ts",
        "store-api.test.ts",
      ].map(async (file) => {
        try {
          return [
            file,
            createHash("sha256")
              .update(await readFile(resolve(source, "src/providers/woocommerce", file)))
              .digest("hex"),
          ];
        } catch (error) {
          if (error.code === "ENOENT" && file === "order-payment.test.ts") return [file, null];
          throw error;
        }
      }),
    ),
  ),
  applicationAdapterFiles: Object.fromEntries(
    await Promise.all(
      [
        "packages/adapters/src/woocommerce-checkout.ts",
        "packages/contracts/src/customer-purchase.ts",
        "packages/core/src/approval-effect-key.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  ),
  pluginSha256: pluginHash,
  transport:
    "Injected exact synthetic HTTPS origin to HTTP inside isolated container; no host ports, TLS or SSRF acceptance",
  payments: "Offline bank transfer and administrator-recorded fixture payment only; no money moved",
  checks: [],
};
const check = (name, condition) => {
  assert.ok(condition, name);
  report.checks.push(name);
};

await mkdir(dirname(plugin), { recursive: true });
let archive;
try {
  archive = await readFile(plugin);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.error("Downloading pinned WooCommerce fixture plugin");
  const response = await fetch("https://downloads.wordpress.org/plugin/woocommerce.11.1.0.zip", {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
  });
  assert.ok(response.ok, "Official plugin download succeeded");
  archive = Buffer.from(await response.arrayBuffer());
}
assert.equal(
  createHash("sha256").update(archive).digest("hex"),
  pluginHash,
  "Pinned plugin checksum",
);
await writeFile(plugin, archive);

try {
  console.error(`Starting disposable WooCommerce store ${project}`);
  await compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
  await wp(
    "core",
    "install",
    "--url=https://store.example.test",
    "--title=Disposable fixture",
    "--admin_user=fixture-admin",
    "--admin_password=disposable-fixture-admin-password",
    "--admin_email=admin@example.test",
    "--skip-email",
  );
  await wp("plugin", "install", "/fixture/woocommerce.zip", "--activate");
  await wp("rewrite", "structure", "/%postname%/", "--hard");
  const seed = JSON.parse(await wp("eval-file", "/fixture/seed.php"));
  report.wordpressVersion = seed.wordpressVersion;
  report.woocommerceVersion = seed.woocommerceVersion;
  const origin = "https://store.example.test";
  // Only this owned origin is mapped. No production network policy is relaxed.
  const fetcher = async (target, init = {}) => {
    const url = new URL(String(target));
    assert.equal(url.origin, origin, "Provider stays on the fixture store");
    const result = JSON.parse(
      await compose(["exec", "-T", "wordpress", "php", "/fixture/request.php"], {
        input: JSON.stringify({
          path: `${url.pathname}${url.search}`,
          method: init.method ?? "GET",
          headers: [...new Headers(init.headers)].map(([key, value]) => `${key}: ${value}`),
          body: init.body ?? null,
        }),
      }),
    );
    assert.ok(result.status < 300 || result.status >= 400, "Fixture requests must not redirect");
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  const { woocommerceActionHandlers: handlers, resolveWooCommerceCredentialContext } = await import(
    pathToFileURL(resolve(source, "src/providers/woocommerce/runtime.ts")).href
  );
  const context = resolveWooCommerceCredentialContext(
    {
      storeUrl: origin,
      consumerKey: seed.consumerKey,
      consumerSecret: seed.consumerSecret,
    },
    fetcher,
  );
  const api = async (path, options = {}) => {
    const response = await fetcher(`${origin}/wp-json${path}`, options);
    const data = await response.json();
    assert.ok(
      response.ok,
      `Fixture ${options.method ?? "GET"} ${path} HTTP ${response.status}: ${data.code ?? "ok"}`,
    );
    return { data, response };
  };
  const auth = {
    authorization: `Basic ${Buffer.from(`${seed.consumerKey}:${seed.consumerSecret}`).toString("base64")}`,
  };
  const rawOrder = async (id) => (await api(`/wc/v3/orders/${id}`, { headers: auth })).data;
  console.error("Checking real provider order and checkout behavior");
  const product = await handlers.get_product({ productId: seed.productId }, context);
  check(
    "Current product price and stock",
    product.price === "125.00" && product.stockQuantity === 10,
  );
  const input = {
    customerId: seed.customerId,
    lineItems: [{ productId: seed.productId, quantity: 1 }],
  };
  const order = await handlers.create_order(input, context);
  const pending = await rawOrder(order.id);
  check(
    "REST order exists without claiming payment",
    pending.status === "pending" && pending.date_paid === null && pending.needs_payment === true,
  );
  check("Created order retains the selected customer", order.customerId === seed.customerId);
  const paymentUrl = new URL(pending.payment_url);
  check(
    "WooCommerce supplies the exact order's payment URL",
    paymentUrl.origin === origin &&
      paymentUrl.pathname === `/checkout/order-pay/${order.id}/` &&
      paymentUrl.searchParams.get("key") === pending.order_key &&
      paymentUrl.searchParams.get("pay_for_order") === "true",
  );

  const idempotentHeaders = {
    ...auth,
    "content-type": "application/json",
    "idempotency-key": "fixture-repeated-request",
  };
  const repeatedBody = JSON.stringify({
    line_items: [{ product_id: seed.productId, quantity: 1 }],
  });
  const first = await api("/wc/v3/orders", {
    method: "POST",
    headers: idempotentHeaders,
    body: repeatedBody,
  });
  const second = await api("/wc/v3/orders", {
    method: "POST",
    headers: idempotentHeaders,
    body: repeatedBody,
  });
  check(
    "WooCommerce REST creates distinct orders for repeated idempotency headers",
    first.data.id !== second.data.id,
  );

  const cart = await api("/wc/store/v1/cart");
  const cartToken = cart.response.headers.get("cart-token");
  assert.ok(cartToken, "Store API returns a cart capability");
  const cartHeaders = { "cart-token": cartToken, "content-type": "application/json" };
  await api("/wc/store/v1/cart/add-item", {
    method: "POST",
    headers: cartHeaders,
    body: JSON.stringify({ id: seed.productId, quantity: 1 }),
  });
  const separateCart = await api("/wc/store/v1/cart");
  check("Another cart cannot see the first cart's items", separateCart.data.items.length === 0);
  const badToken = await fetcher(`${origin}/wp-json/wc/store/v1/cart`, {
    headers: { "cart-token": "invalid-fixture-token" },
  });
  check(
    "Invalid cart capability reveals only a new empty cart",
    badToken.status === 200 && (await badToken.json()).items.length === 0,
  );
  const badWrite = await fetcher(`${origin}/wp-json/wc/store/v1/cart/add-item`, {
    method: "POST",
    headers: { "cart-token": "invalid-fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ id: seed.productId, quantity: 1 }),
  });
  check(
    "Invalid cart capability cannot authorize a write",
    badWrite.status === 401 || badWrite.status === 403,
  );
  const draft = await api("/wc/store/v1/checkout", { headers: cartHeaders });
  check(
    "Pinned checkout GET returns an unpersisted draft for a new cart",
    draft.data.status === "checkout-draft" && draft.data.order_id === 0,
  );
  const billing = {
    first_name: "Fixture",
    last_name: "Customer",
    address_1: "1 Example Road",
    city: "Bangkok",
    state: "TH-10",
    postcode: "10200",
    country: "TH",
    email: "customer@example.test",
    phone: "020000000",
  };
  const changedTotal = await fetcher(`${origin}/wp-json/wc/store/v1/checkout`, {
    method: "POST",
    headers: cartHeaders,
    body: JSON.stringify({
      billing_address: billing,
      payment_method: "bacs",
      expected_total: "12400",
    }),
  });
  const changedTotalBody = await changedTotal.json();
  check(
    "Checkout rejects a total above the customer's confirmed amount",
    changedTotal.status === 409 &&
      changedTotalBody.code === "woocommerce_rest_checkout_total_mismatch",
  );
  const checkout = await api("/wc/store/v1/checkout", {
    method: "POST",
    headers: cartHeaders,
    body: JSON.stringify({
      billing_address: billing,
      payment_method: "bacs",
      expected_total: "12600",
    }),
  });
  const awaitingTransfer = await rawOrder(checkout.data.order_id);
  check(
    "Checkout accepts an actual total below the submitted maximum",
    awaitingTransfer.total === "125.00",
  );
  check(
    "Successful checkout is still awaiting bank transfer",
    checkout.data.payment_result.payment_status === "success" &&
      awaitingTransfer.status === "on-hold" &&
      awaitingTransfer.date_paid === null,
  );
  const transferRead = await handlers.get_order({ orderId: checkout.data.order_id }, context);
  check(
    "Connector does not confuse an on-hold transfer with payment",
    transferRead.status === "on-hold" &&
      transferRead.needsPayment === false &&
      transferRead.datePaidGmt === null &&
      transferRead.paymentMethod === "bacs",
  );

  // Administrative fixture mutation is a recorded payment, not a gateway charge.
  await api(`/wc/v3/orders/${order.id}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ transaction_id: "fixture-recorded-transfer" }),
  });
  const paid = await handlers.update_order(
    { orderId: order.id, setPaid: true, paymentMethod: "bacs" },
    context,
  );
  const paidRaw = await rawOrder(order.id);
  check(
    "Administrative payment fixture has a recorded timestamp",
    typeof paidRaw.date_paid_gmt === "string" && paidRaw.needs_payment === false,
  );
  const reread = await handlers.get_order({ orderId: order.id }, context);
  check("Connector retains payment URL", order.paymentUrl === pending.payment_url);
  check(
    "Connector retains unpaid state without inventing a timestamp",
    order.needsPayment === true && order.datePaidGmt === null,
  );
  check(
    "Connector retains current recorded payment facts",
    paid.datePaidGmt === paidRaw.date_paid_gmt &&
      reread.datePaidGmt === paidRaw.date_paid_gmt &&
      reread.needsPayment === false,
  );
  check(
    "Connector preserves payment method and transaction fields",
    reread.paymentMethod === "bacs" &&
      paidRaw.payment_method === "bacs" &&
      reread.transactionId === "fixture-recorded-transfer" &&
      paidRaw.transaction_id === "fixture-recorded-transfer",
  );
  console.error("Checking connector cart, delivery and checkout actions");
  const { woocommerceStoreActions } = await import(
    pathToFileURL(resolve(source, "src/providers/woocommerce/store-actions.ts")).href
  );
  const sourceRequire = createRequire(resolve(source, "package.json"));
  const { Validator } = await import(
    pathToFileURL(sourceRequire.resolve("@cfworker/json-schema")).href
  );
  const storeAction = async (name, input) => {
    const action = woocommerceStoreActions.find((action) => action.name === name);
    assert.ok(action, "Selected Store API action is in the catalog");
    assert.ok(
      new Validator(action.inputSchema).validate(input).valid,
      "Store action input satisfies its contract",
    );
    const output = await handlers[name](input, context);
    assert.ok(
      new Validator(action.outputSchema).validate(output).valid,
      "Store action output satisfies its contract",
    );
    return output;
  };
  const created = await storeAction("create_cart", {});
  const isolated = await storeAction("create_cart", {});
  check(
    "Connector creates independent empty guest carts",
    created.cart.items.length === 0 &&
      isolated.cart.items.length === 0 &&
      created.cartToken !== isolated.cartToken,
  );
  let capability = created.cartToken;
  const cartAction = async (name, input = {}) => {
    const result = await storeAction(name, { cartToken: capability, ...input });
    capability = result.cartToken;
    return result.cart ?? result.checkout;
  };
  let storeCart = await cartAction("add_cart_item", {
    productId: seed.physicalProductId,
    quantity: 1,
  });
  const itemKey = storeCart.items[0].key;
  check(
    "Connector adds the current shippable product",
    storeCart.items[0].id === seed.physicalProductId &&
      storeCart.items[0].quantity === 1 &&
      storeCart.needs_shipping === true,
  );
  storeCart = await cartAction("update_cart_item", { key: itemKey, quantity: 2 });
  check(
    "Connector sets quantity and recalculates prices",
    storeCart.items[0].quantity === 2 && storeCart.totals.total_items === "9800",
  );
  storeCart = await cartAction("apply_cart_coupon", { code: "fixture-ten" });
  check(
    "Connector applies current promotion rules",
    storeCart.coupons[0].code === "fixture-ten" && storeCart.totals.total_discount === "980",
  );
  storeCart = await cartAction("remove_cart_coupon", { code: "fixture-ten" });
  check(
    "Connector removes promotion and refreshes totals",
    storeCart.coupons.length === 0 && storeCart.totals.total_discount === "0",
  );
  storeCart = await cartAction("update_cart_customer", {
    billingAddress: billing,
    shippingAddress: billing,
  });
  check(
    "Connector updates shopper details and obtains shipping rates",
    storeCart.shipping_address.city === "Bangkok" && storeCart.shipping_rates.length > 0,
  );
  const shippingPackage = storeCart.shipping_rates[0];
  const rate = shippingPackage.shipping_rates.find((rate) => rate.rate_id.startsWith("flat_rate:"));
  assert.ok(rate, "Fixture shipping rate is available");
  storeCart = await cartAction("select_cart_shipping_rate", {
    packageId: shippingPackage.package_id,
    rateId: rate.rate_id,
  });
  check(
    "Connector selects provider shipping with current minor-unit total",
    storeCart.shipping_rates[0].shipping_rates.some(
      (entry) => entry.rate_id === rate.rate_id && entry.selected,
    ) &&
      storeCart.totals.total_shipping === "2000" &&
      storeCart.totals.total_price === "11800" &&
      storeCart.totals.currency_code === "THB",
  );
  storeCart = await cartAction("remove_cart_item", { key: itemKey });
  check("Connector removes cart items", storeCart.items.length === 0);
  storeCart = await cartAction("add_cart_item", { productId: seed.physicalProductId, quantity: 1 });
  check(
    "Connector returns current delivery-inclusive total after rebuilding cart",
    storeCart.totals.total_price === "6900",
  );
  const rereadCart = await cartAction("get_cart");
  const otherCart = await storeAction("get_cart", { cartToken: isolated.cartToken });
  check(
    "Connector reads only the selected cart",
    rereadCart.items.length === 1 && otherCart.cart.items.length === 0,
  );
  // The signature is deliberately invalid; WooCommerce GET silently creates a new session.
  const parts = capability.split(".");
  const expiredPayload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  expiredPayload.exp = 1;
  const expired = `${parts[0]}.${Buffer.from(JSON.stringify(expiredPayload)).toString("base64url")}.${parts[2]}`;
  await assert.rejects(() => storeAction("get_cart", { cartToken: expired }), /expired or changed/);
  check("Connector rejects silent cart replacement for expired capabilities", true);
  const checkoutState = await cartAction("get_checkout");
  check(
    "Connector reads checkout draft without claiming persisted order",
    checkoutState.status === "checkout-draft" && checkoutState.order_id === 0,
  );
  await assert.rejects(
    () =>
      cartAction("submit_checkout", {
        billingAddress: billing,
        shippingAddress: billing,
        paymentMethod: "bacs",
        expectedTotal: "6800",
      }),
    /status 409/,
  );
  check("Connector enforces the confirmed maximum at checkout", true);
  const submitted = await cartAction("submit_checkout", {
    billingAddress: billing,
    shippingAddress: billing,
    paymentMethod: "bacs",
    expectedTotal: "6900",
  });
  const submittedOrder = await handlers.get_order({ orderId: submitted.order_id }, context);
  check(
    "Connector checkout creates the exact shippable order",
    submitted.order_id > 0 &&
      submittedOrder.id === submitted.order_id &&
      submittedOrder.total === "69.00" &&
      submittedOrder.lineItems[0].productId === seed.physicalProductId &&
      submittedOrder.lineItems[0].quantity === 1,
  );
  check(
    "Connector checkout and order readback keep bank transfer unpaid",
    submitted.payment_result.payment_status === "success" &&
      submittedOrder.status === "on-hold" &&
      submittedOrder.datePaidGmt === null &&
      submittedOrder.paymentMethod === "bacs",
  );
  const { wooCommerceCheckout } = await tsImport(
    "../packages/adapters/src/woocommerce-checkout.ts",
    import.meta.url,
  );
  const appCalls = [];
  let lostOrderId;
  const app = wooCommerceCheckout(async (action, input, effect) => {
    const name = action.slice("woocommerce.".length);
    appCalls.push({ name, effect });
    const result = await handlers[name](input, context);
    if (name === "submit_checkout") {
      lostOrderId = result.checkout.order_id;
      throw new Error("Synthetic lost checkout response");
    }
    return result;
  });
  let appState = await app.create();
  appState = await app.update(appState, { kind: "add", productId: seed.productId, quantity: 1 });
  const appAddress = {
    firstName: billing.first_name,
    lastName: billing.last_name,
    company: "",
    address1: billing.address_1,
    address2: billing.address_2 ?? "",
    city: billing.city,
    state: billing.state,
    postcode: billing.postcode,
    country: billing.country,
    email: billing.email,
    phone: billing.phone,
  };
  appState = await app.update(appState, {
    kind: "address",
    billing: appAddress,
    shipping: appAddress,
  });
  appState.checkoutAttempt = { reference: "synthetic-app-purchase", paymentMethod: "bacs" };
  await assert.rejects(() => app.submit(appState, "bacs"), /Synthetic lost checkout response/);
  check(
    "Application adapter dispatches a checkout whose response is lost",
    Number.isSafeInteger(lostOrderId),
  );
  const recovered = await app.readOrder(appState, String(lostOrderId));
  check(
    "Application recovery verifies the real saved purchase reference",
    recovered.summary.order.id === String(lostOrderId) &&
      (await rawOrder(lostOrderId)).customer_note === "Deskazo purchase synthetic-app-purchase",
  );
  check(
    "Application readback does not infer payment from successful BACS checkout",
    recovered.summary.order.paymentStatus === "unconfirmed" &&
      recovered.summary.order.recordedPaidAt === null,
  );
  await assert.rejects(
    () =>
      app.readOrder(
        {
          ...appState,
          checkoutAttempt: { ...appState.checkoutAttempt, reference: "another-purchase" },
        },
        String(lostOrderId),
      ),
    /does not match/,
  );
  check("Application recovery rejects another purchase reference", true);
  await handlers.update_order(
    { orderId: lostOrderId, setPaid: true, paymentMethod: "bacs" },
    context,
  );
  const unchanged = await app.readOrder(recovered, String(lostOrderId));
  check(
    "WooCommerce ignores set_paid on an on-hold transfer that does not need payment",
    unchanged.summary.order.paymentStatus === "unconfirmed" &&
      unchanged.summary.order.status === "on-hold" &&
      unchanged.summary.order.needsPayment === false &&
      unchanged.summary.order.recordedPaidAt === null &&
      (await rawOrder(lostOrderId)).date_paid_gmt === null,
  );
  // This is a fixture administrator marking payment recorded, not a gateway charge.
  await handlers.update_order({ orderId: lostOrderId, status: "completed" }, context);
  const recorded = await app.readOrder(recovered, String(lostOrderId));
  check(
    "Application refresh reports a provider-recorded payment with timestamp",
    recorded.summary.order.paymentStatus === "recorded_paid" &&
      typeof recorded.summary.order.recordedPaidAt === "string",
  );
  check(
    "Recovery and payment refresh never repeat checkout or write to the provider",
    appCalls.filter((call) => call.name === "submit_checkout").length === 1 &&
      appCalls.filter((call) => call.name === "get_order").every((call) => call.effect === "read"),
  );
  report.status = "passed";
} finally {
  console.error("Removing disposable store containers, network and volumes");
  await compose(["down", "--volumes", "--remove-orphans"], { cleanup: true });
  for (const args of [
    ["ps", "-aq"],
    ["volume", "ls", "-q"],
    ["network", "ls", "-q"],
  ]) {
    const remaining = await exec("docker", [
      ...args,
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    assert.equal(remaining.stdout.trim(), "", "No disposable project resources remain");
  }
  report.cleanup = "verified";
  console.log(JSON.stringify(report, null, 2));
}
