// Run only in an isolated candidate image with no network and these scripts mounted read-only.
// Uses the shipped authentication middleware and fake provider responses to check the rollout probe.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createLocalAuthMiddleware } from "/app/src/server/api/auth.ts";

const { Hono } = createRequire("/app/package.json")("hono");
const admin = "synthetic-routing-admin";
const runtime = "synthetic-routing-runtime";
process.env.OOMOL_CONNECT_ADMIN_TOKEN = admin;
process.env.OOMOL_CONNECT_RUNTIME_TOKEN = runtime;
const app = new Hono();
app.use("*", createLocalAuthMiddleware({ adminToken: admin, runtimeToken: runtime }));
const connections = ["line", "instagram"].map((service) => ({
  id: `${service}:synthetic`,
  service,
  configured: true,
  connectionName: "synthetic",
}));
app.get("/api/connections", (context) => context.json(connections));
app.get("/v1/connections/by-id/:id", (context) => {
  const connection = connections.find((item) => item.id === context.req.param("id"));
  assert.ok(connection);
  return context.json({
    success: true,
    data: {
      service: connection.service,
      alias: connection.connectionName,
      providerAccountId: "synthetic-account",
    },
  });
});
app.post("/v1/actions/:action/for-account/:account", (context) => {
  assert.ok(
    ["line.get_bot_info", "instagram.get_current_user"].includes(context.req.param("action")),
  );
  if (context.req.param("account") !== "synthetic-account")
    return context.json(
      { success: false, errorCode: "connection_changed", meta: { dispatch: "not_started" } },
      409,
    );
  return context.json({ success: true, data: {} });
});
const statuses = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  assert.equal(url.origin, "http://127.0.0.1:3000");
  const response = await app.request(url, init);
  statuses.push({ accountBound: url.pathname.includes("/for-account/"), status: response.status });
  return response;
};
await import("./verify-connector-account-routing.mjs");
console.log(JSON.stringify({ shippedAuthMiddleware: true, network: "none", statuses }));
