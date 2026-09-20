// Run inside the connector container; credentials and account details stay there:
// docker exec -i <connector-container> node --input-type=module < this-file
// Only the two audited identity reads below may execute. No messages are sent.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const actions = { line: "get_bot_info", instagram: "get_current_user" };

async function boundedJson(response, maxBytes) {
  assert.ok(response.body, "Missing response body");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    assert.ok(bytes <= maxBytes, "Response exceeded the verification limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function verifyIdentities(admin, fetcher = fetch) {
  assert.ok(admin, "Connector admin authentication is required");
  const request = (path, init = {}) =>
    fetcher(`http://127.0.0.1:3000${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${admin}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  const response = await request("/api/connections");
  assert.ok(response.ok, "Connection inventory failed");
  const connections = await boundedJson(response, 4 * 1024 * 1024);
  assert.ok(Array.isArray(connections), "Connection inventory expected a list");
  const providers = [];
  for (const [service, action] of Object.entries(actions)) {
    const selected = connections.filter(
      (row) => row.service === service && row.configured === true,
    );
    assert.ok(selected.length <= 8, "Use a smaller explicitly selected test inventory");
    const checks = [];
    for (const connection of selected) {
      // Never let an absent alias silently select a different default account.
      assert.ok(
        typeof connection.connectionName === "string" && connection.connectionName.length > 0,
        "Connection alias missing",
      );
      try {
        const result = await request(`/v1/actions/${service}.${action}`, {
          method: "POST",
          headers: { "x-oo-connector-alias": connection.connectionName },
          body: JSON.stringify({ input: {} }),
        });
        if (!result.ok) {
          await result.body?.cancel();
          checks.push({ httpStatus: result.status, passed: false });
          continue;
        }
        const body = await boundedJson(result, 128 * 1024);
        const identity =
          service === "line" ? body.data?.userId : (body.data?.user?.userId ?? body.data?.user?.id);
        checks.push({
          httpStatus: result.status,
          passed:
            result.ok &&
            body.success === true &&
            typeof identity === "string" &&
            identity.length > 0,
        });
      } catch {
        // Provider errors can contain account identifiers, URLs or credentials.
        checks.push({ httpStatus: null, passed: false });
      }
    }
    providers.push({
      service,
      actionId: `${service}.${action}`,
      configuredConnections: selected.length,
      checks,
    });
  }
  return {
    readOnlyProviderActions: true,
    acceptance:
      "Identity reads only; receiving, sending, revocation and webhook delivery remain unverified",
    passed: providers.every(
      (provider) => provider.checks.length > 0 && provider.checks.every((check) => check.passed),
    ),
    providers,
  };
}

if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: The deployed connector owns this credential.
    const report = await verifyIdentities(process.env.OOMOL_CONNECT_ADMIN_TOKEN);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    console.error("Identity verification could not complete; no provider details were printed.");
    process.exitCode = 1;
  }
}
