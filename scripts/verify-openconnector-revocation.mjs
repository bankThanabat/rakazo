// Run inside the connector container so its existing admin token stays there:
// docker exec -i <connector-container> node --input-type=module < this-file
// Creates only a disposable token. Never prints credentials, IDs, URLs or account data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const endpoint = process.argv[2] ?? "http://127.0.0.1:3000";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Runs inside the deployed connector, outside Turbo.
const admin = process.env.OOMOL_CONNECT_ADMIN_TOKEN;
assert.ok(admin, "Connector admin authentication is required");
const request = (pathname, token, options = {}) =>
  fetch(new URL(pathname, endpoint), {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

let tokenId;
let deleted = false;
try {
  const created = await request("/api/runtime-tokens", admin, {
    method: "POST",
    body: JSON.stringify({
      name: `disposable-revocation-check-${randomUUID()}`,
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
    }),
  });
  assert.equal(created.status, 200, "Disposable token creation failed");
  const body = await created.json();
  tokenId = body.record?.id;
  assert.ok(typeof tokenId === "string" && tokenId.length > 0, "Missing cleanup identity");
  assert.ok(typeof body.token === "string", "Missing disposable token");
  const before = await request("/v1/actions", body.token);
  assert.equal(before.status, 200, "Disposable token was not admitted");
  await before.body?.cancel();
  const removed = await request(`/api/runtime-tokens/${encodeURIComponent(tokenId)}`, admin, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200, "Disposable token revocation failed");
  deleted = true;
  await removed.body?.cancel();
  const after = await request("/v1/actions", body.token);
  assert.equal(after.status, 401, "Revoked token still has access");
  await after.body?.cancel();
  const repeated = await request(`/api/runtime-tokens/${encodeURIComponent(tokenId)}`, admin, {
    method: "DELETE",
  });
  assert.ok([200, 404].includes(repeated.status), "Repeated revocation is not safe");
  await repeated.body?.cancel();
  console.log(
    JSON.stringify({
      passed: true,
      before: before.status,
      revoked: removed.status,
      after: after.status,
      repeated: repeated.status,
      disposableTokenRemoved: true,
    }),
  );
} finally {
  if (tokenId && !deleted) {
    const cleanup = await request(`/api/runtime-tokens/${encodeURIComponent(tokenId)}`, admin, {
      method: "DELETE",
    });
    assert.ok([200, 404].includes(cleanup.status), "Disposable token cleanup needs attention");
    await cleanup.body?.cancel();
  }
}
