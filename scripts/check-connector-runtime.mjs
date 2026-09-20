// Runs only in a disposable, network-disabled verification stage with /app/data
// mounted as tmpfs. This file and its synthetic settings are not in the release image.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { actionChecks } from "./inspect-openconnector-acceptance.mjs";

const expected = { amd64: "x64", arm64: "arm64" }[process.argv[2]];
assert.ok(expected, "Specify the target architecture");
assert.equal(process.arch, expected, "Runtime executes the target architecture");
const server = spawn("/usr/local/bin/open-connector", ["serve"], {
  stdio: "inherit",
  env: {
    ...process.env,
    OOMOL_CONNECT_ADMIN_TOKEN: "synthetic-admin",
    OOMOL_CONNECT_RUNTIME_TOKEN: "synthetic-runtime",
    OOMOL_CONNECT_ENCRYPTION_KEY: "synthetic-isolated-encryption-key",
    OOMOL_CONNECT_ORIGIN: "http://127.0.0.1:3000",
    OOMOL_CONNECT_DATA_DIR: "/app/data",
  },
});
const stopped = new Promise((resolve) => {
  server.once("exit", resolve);
  server.once("error", resolve);
});
const request = (path, options = {}) =>
  fetch(`http://127.0.0.1:3000${path}`, {
    ...options,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
try {
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await request("/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Runtime became healthy");
  const headers = { authorization: "Bearer synthetic-admin" };
  const apiResponse = await request("/openapi.json", { headers });
  assert.equal(apiResponse.status, 200);
  const api = await apiResponse.json();
  assert.ok(api.paths["/v1/actions/{actionId}/for-account/{accountId}"].post);
  let checkedActions = 0;
  for (const [service, actions] of Object.entries(actionChecks)) {
    for (const action of actions) {
      const id = `${service}.${action}`;
      const response = await request(`/api/actions/${id}`, { headers });
      assert.equal(response.status, 200, id);
      const data = await response.json();
      assert.equal(data.id, id);
      assert.equal(data.execution.locallyExecutable, true, id);
      checkedActions++;
    }
  }
  const unauthorized = await request(
    "/v1/actions/instagram.reply_to_comment/for-account/synthetic-account",
    { method: "POST", headers: { "content-type": "application/json" }, body: '{"input":{}}' },
  );
  assert.equal(unauthorized.status, 401, "Account-bound actions require authentication");
  console.log(JSON.stringify({ runtime: "passed", architecture: process.arch, checkedActions }));
} finally {
  server.kill("SIGTERM");
  const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
  try {
    await stopped;
  } finally {
    clearTimeout(force);
  }
}
