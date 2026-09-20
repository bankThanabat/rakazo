#!/usr/bin/env -S pnpm exec tsx
/** Owned synthetic lab only. Revoke one disposable runtime token, reconnect via app RPC,
 * and verify app revocation removes access. Never changes the primary store connection.
 * Usage: pnpm exec tsx scripts/verify-deskazo-connection-recovery.mts <private-lab-directory>
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCustomerConnector } from "../packages/adapters/src/customer-connector.js";
import { IntegrationProviderSettings } from "../packages/adapters/src/integration-provider-settings.js";
import { EncryptedSecretStore } from "../packages/adapters/src/secrets.js";
import { createDb } from "../packages/db/src/index.js";

assert.ok(process.argv[2]);
const directory = resolve(process.argv[2]!);
const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
const save = (name: string, data: unknown) =>
  writeFileSync(resolve(directory, name), JSON.stringify(data, null, 2), { mode: 0o600 });
const env = read("environment.private.json");
const credentials = read("private.json");
const store = read("store.json");
assert.equal(env.WEB_ORIGIN, "http://127.0.0.1:5280");
assert.equal(new URL(env.DATABASE_URL).hostname, "127.0.0.1");
assert.equal(new URL(env.DATABASE_URL).port, "15434");
const stateFile = "connection-recovery-state.private.json";
const state = existsSync(resolve(directory, stateFile)) ? read(stateFile) : {};
const db = createDb(env.DATABASE_URL);
try {
  assert.equal(await db.prisma.user.count(), 1);
  const user = await db.prisma.user.findUniqueOrThrow({
    where: { email: "deskazo-v1@example.test" },
  });
  const member = await db.prisma.spaceMember.findFirstOrThrow({ where: { userId: user.id } });
  const actor = { userId: user.id, spaceId: member.spaceId };
  const secrets = new EncryptedSecretStore(env.ENCRYPTION_KEY);
  const configRow = await db.prisma.integrationProviderConfig.findUniqueOrThrow({
    where: { id: "open-connector" },
  });
  const config = JSON.parse(
    secrets.load(configRow.ciphertext, "integration-provider:open-connector"),
  );
  assert.equal(config.endpoint, "http://127.0.0.1:13000");
  const connector = createCustomerConnector({
    prisma: db.prisma,
    integrations: new IntegrationProviderSettings(db.prisma, secrets, env.ENCRYPTION_KEY),
  });
  const primary = await db.prisma.connection.findFirstOrThrow({
    where: {
      ...actor,
      provider: "woocommerce",
      displayName: "Synthetic Docker shop",
      status: "connected",
    },
  });
  const grantFor = async (id: string) => {
    const row = await db.prisma.connection.findUniqueOrThrow({ where: { id } });
    const secret = await db.prisma.secret.findUniqueOrThrow({ where: { id: row.providerRef! } });
    return JSON.parse(secrets.load(secret.ciphertext, row.providerRef!));
  };
  const primaryGrant = await grantFor(primary.id);
  const admin = async (path: string, method = "GET") =>
    fetch(`${config.endpoint}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  const accounts = await (await admin("/api/connections")).json();
  assert.equal(
    accounts.find((a: { id: string }) => a.id === primaryGrant.accountId)?.profile?.accountId,
    "https://store",
  );
  const product = async (id: string) => {
    const result = (await connector.execute(
      actor,
      id,
      "woocommerce.get_product",
      { productId: store.productId },
      randomUUID(),
      "staff",
      "read",
    )) as { sku: string };
    assert.equal(result.sku, "FIXTURE-ONLY");
  };
  await product(primary.id);
  const login = await fetch(`${env.WEB_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: env.WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: credentials.appPassword }),
  });
  assert.ok(login.ok);
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  const rpc = async (path: string, input: unknown = {}) => {
    const response = await fetch(`${env.WEB_ORIGIN}/rpc/${path}`, {
      method: "POST",
      headers: { cookie, origin: env.WEB_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `${path} returned ${response.status}`);
    return (await response.json()).json;
  };
  const auth = {
    type: "custom_credential",
    values: {
      storeUrl: "https://store",
      consumerKey: store.consumerKey,
      consumerSecret: store.consumerSecret,
    },
  };
  if (!state.connectionId) {
    const created = await rpc("connections/begin", {
      connectorId: "open-connector",
      provider: "woocommerce",
      displayName: "Disposable recovery check",
      auth,
    });
    state.connectionId = created.connectionId;
    save(stateFile, state);
    const completed = await rpc("connections/complete", { connectionId: state.connectionId });
    assert.equal(completed.status, "connected");
  }
  assert.notEqual(state.connectionId, primary.id);
  if (state.completed) {
    assert.equal(
      (await db.prisma.connection.findUniqueOrThrow({ where: { id: state.connectionId } })).status,
      "revoked",
    );
    await assert.rejects(product(state.connectionId), /Connect and authorize/);
    save("connection-recovery-recheck.json", {
      at: new Date().toISOString(),
      primaryReadable: true,
      disposableRevoked: true,
      note: "Existing completed case checked without connection lifecycle mutations",
    });
    console.log(
      "Completed recovery case reread; primary connection usable and disposable connection revoked.",
    );
  } else {
    if (!state.expired) {
      await product(state.connectionId);
      const grant = await grantFor(state.connectionId);
      assert.notEqual(grant.accountId, primaryGrant.accountId);
      assert.notEqual(grant.tokenId, primaryGrant.tokenId);
      state.oldTokenId = grant.tokenId;
      save(stateFile, state);
      const revoked = await admin(
        `/api/runtime-tokens/${encodeURIComponent(grant.tokenId)}`,
        "DELETE",
      );
      assert.ok([200, 404].includes(revoked.status));
      await revoked.body?.cancel();
      state.expired = true;
      save(stateFile, state);
    }
    await assert.rejects(product(state.connectionId), /Connector action failed|401|unauthorized/i);
    await rpc("connections/reconnect", { connectionId: state.connectionId, auth });
    await product(state.connectionId);
    const renewed = await grantFor(state.connectionId);
    assert.notEqual(
      renewed.tokenId,
      state.oldTokenId,
      "Explicit reconnect must replace a revoked runtime token",
    );
    assert.notEqual(renewed.tokenId, primaryGrant.tokenId);
    await rpc("connections/revoke", { connectionId: state.connectionId });
    await assert.rejects(product(state.connectionId), /Connect and authorize/);
    await rpc("connections/revoke", { connectionId: state.connectionId });
    const removed = await admin(`/v1/connections/by-id/${encodeURIComponent(renewed.accountId)}`);
    assert.equal(removed.status, 404);
    await removed.body?.cancel();
    await product(primary.id);
    assert.deepEqual(await grantFor(primary.id), primaryGrant);
    state.completed = true;
    save(stateFile, state);
    save("connection-recovery-receipt.json", {
      at: new Date().toISOString(),
      checks: [
        "revoked runtime token denies reads",
        "explicit app reconnect restores product read with a new runtime token",
        "app revocation denies reads and removes remote account",
        "repeat revocation is safe",
        "primary account and grant unchanged",
      ],
      scope:
        "Owned local synthetic store. Direct backend read with real API connection lifecycle. No OAuth expiry, social delivery or full journey claim.",
    });
    console.log(
      "Local connection failure, explicit reconnect, revocation and isolation checks passed.",
    );
  }
} finally {
  await db.prisma.$disconnect();
  await db.pool.end();
}
