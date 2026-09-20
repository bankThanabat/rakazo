// Invoked only by verify-connector-recovery.py inside its isolated owned container.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const admin = "synthetic-recovery-admin";
const key = "synthetic-store-key";
const secret = "synthetic-store-secret-$cash";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Disposable container settings, outside Turbo.
const fixture = process.env.OOMOL_CONNECT_RECOVERY_FIXTURE;
assert.match(fixture ?? "", /^deskazo-connector-recovery-[a-f0-9]{32}$/);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Refuse real connector credentials.
assert.equal(process.env.OOMOL_CONNECT_ADMIN_TOKEN, admin);

if (process.argv[2] === "serve") {
  createServer(
    {
      key: readFileSync("/app/recovery-fixture/key.pem"),
      cert: readFileSync("/app/recovery-fixture/cert.pem"),
    },
    (request, response) => {
      const url = new URL(request.url, "https://recovery-store.example.test:8787");
      const allowed =
        request.method === "GET" &&
        url.pathname === "/wp-json/wc/v3/products" &&
        request.headers.authorization ===
          `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
      response.writeHead(allowed ? 200 : 403, {
        "content-type": "application/json",
        "x-wp-total": "1",
        "x-wp-totalpages": "1",
      });
      response.end(
        JSON.stringify(
          allowed
            ? [
                {
                  id: 17,
                  name: "Recovery product",
                  sku: "RECOVERY-17",
                  price: "123.00",
                  stock_quantity: 7,
                  stock_status: "instock",
                },
              ]
            : { error: "Synthetic fixture refused request" },
        ),
      );
    },
  ).listen(8787, "0.0.0.0");
} else {
  const input = JSON.parse(readFileSync(0, "utf8"));
  assert.equal(input.fixture, fixture);
  assert.ok(input.mode === "seed" || input.mode === "check");
  const request = async (path, { token = admin, method = "GET", body, status = 200 } = {}) => {
    const response = await fetch(`http://127.0.0.1:3000${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-oo-connector-alias": "synthetic-recovery-store",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    assert.equal(
      response.status,
      status,
      `Connector ${method} ${path} status: ${response.status === status ? "expected" : text.slice(0, 1000)}`,
    );
    assert.ok(text.length < 1_000_000);
    return JSON.parse(text);
  };
  let state = input.state;
  if (input.mode === "seed") {
    const account = await request("/api/connections/woocommerce", {
      method: "PUT",
      body: {
        authType: "custom_credential",
        connectionName: "synthetic-recovery-store",
        values: {
          storeUrl: "https://recovery-store.example.test:8787",
          consumerKey: key,
          consumerSecret: secret,
        },
      },
    });
    assert.equal(account.configured, true);
    const policy = {
      name: "Synthetic recovery grant",
      allowedActions: ["woocommerce.list_products"],
      blockedActions: [],
      allowedConnections: [account.id],
      allowedProxies: [],
    };
    const active = await request("/api/runtime-tokens", { method: "POST", body: policy });
    const revoked = await request("/api/runtime-tokens", {
      method: "POST",
      body: { ...policy, name: "Synthetic revoked grant" },
    });
    await request(`/api/runtime-tokens/${revoked.record.id}`, { method: "DELETE" });
    state = { accountId: account.id, activeToken: active.token, revokedToken: revoked.token };
  }
  const identity = await request(`/v1/connections/by-id/${state.accountId}`);
  assert.equal(identity.success, true);
  const account = identity.data;
  assert.equal(account.service, "woocommerce");
  assert.equal(account.alias, "synthetic-recovery-store");
  assert.equal(account.status, "active");
  assert.equal(account.providerAccountId, "https://recovery-store.example.test:8787");
  assert.ok(!JSON.stringify(account).includes(secret));
  const result = await request(
    `/v1/actions/woocommerce.list_products/for-account/${encodeURIComponent(account.providerAccountId)}`,
    {
      token: state.activeToken,
      method: "POST",
      body: { input: { sku: "RECOVERY-17" } },
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.data.products.length, 1);
  const product = result.data.products[0];
  assert.equal(product.id, 17);
  assert.equal(product.sku, "RECOVERY-17");
  assert.equal(product.price, "123.00");
  assert.equal(product.stockQuantity, 7);
  const denied = await request(
    `/v1/actions/woocommerce.get_product/for-account/${encodeURIComponent(account.providerAccountId)}`,
    {
      token: state.activeToken,
      method: "POST",
      body: { input: { productId: 17 } },
      status: 400,
    },
  );
  assert.equal(denied.success, false);
  assert.equal(denied.errorCode, "action_not_allowed");
  const changed = await request(
    "/v1/actions/woocommerce.list_products/for-account/wrong-provider-account",
    {
      token: state.activeToken,
      method: "POST",
      body: { input: {} },
      status: 409,
    },
  );
  assert.equal(changed.errorCode, "connection_changed");
  assert.equal(changed.meta.dispatch, "not_started");
  await request("/v1/actions", { token: state.revokedToken, status: 401 });
  console.log(
    JSON.stringify({
      state,
      identity: {
        id: account.id,
        service: account.service,
        alias: account.alias,
        providerAccountId: account.providerAccountId,
      },
      product,
      restrictedActionDenied: true,
      changedAccountDenied: true,
      revokedTokenDenied: true,
    }),
  );
}
