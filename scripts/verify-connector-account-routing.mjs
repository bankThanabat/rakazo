// Read-only checks inside the deployed connector. Never prints identities or credentials.
import assert from "node:assert/strict";

try {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: The deployed connector owns this credential.
  const admin = process.env.OOMOL_CONNECT_ADMIN_TOKEN;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Use execution credentials for account-bound actions.
  const runtime = process.env.OOMOL_CONNECT_RUNTIME_TOKEN;
  assert.ok(admin && runtime);
  const request = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:3000${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${admin}`,
        "content-type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    const text = await response.text();
    assert.ok(text.length < 4 * 1024 * 1024);
    return { status: response.status, body: JSON.parse(text) };
  };
  const connections = await request("/api/connections");
  assert.equal(connections.status, 200);
  const results = [];
  const selected = connections.body.filter(
    (item) => ["line", "instagram"].includes(item.service) && item.configured,
  );
  assert.ok(selected.length > 0 && selected.length <= 16);
  for (const connection of selected) {
    const identity = await request(`/v1/connections/by-id/${encodeURIComponent(connection.id)}`);
    assert.equal(identity.status, 200);
    const account = identity.body.data;
    assert.equal(account.service, connection.service);
    assert.equal(account.alias, connection.connectionName);
    assert.ok(account.providerAccountId);
    const action = connection.service === "line" ? "get_bot_info" : "get_current_user";
    const invoke = (expected) =>
      request(
        `/v1/actions/${connection.service}.${action}/for-account/${encodeURIComponent(expected)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime}`,
            "x-oo-connector-alias": connection.connectionName,
          },
          body: JSON.stringify({ input: {} }),
        },
      );
    const correct = await invoke(account.providerAccountId);
    assert.equal(correct.status, 200);
    assert.equal(correct.body.success, true);
    const wrong = await invoke("synthetic-rollout-nonmatching-account");
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.errorCode, "connection_changed");
    assert.equal(wrong.body.meta.dispatch, "not_started");
    results.push({
      service: connection.service,
      identity: "passed",
      wrongAccount: "blocked before dispatch",
    });
  }
  const denied = await request("/v1/connections/by-id/synthetic-account", {
    headers: { authorization: "Bearer synthetic-invalid-rollout-token" },
  });
  assert.equal(denied.status, 401);
  console.log(
    JSON.stringify({
      passed: true,
      readOnlyProviderActions: true,
      accounts: results,
      unauthenticatedAccountRead: "denied",
    }),
  );
} catch {
  console.error("Account routing check failed; provider details withheld.");
  process.exitCode = 1;
}
