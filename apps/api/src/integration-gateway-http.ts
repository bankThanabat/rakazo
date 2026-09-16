import type { IntegrationGateway } from "@rakazo/adapters";
import { IsolationError } from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { bearerToken, readBoundedBody } from "./http-body.js";

export function mountIntegrationGateway(
  parent: Hono,
  gateway: IntegrationGateway,
  webOrigin?: string,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: "Integration request could not be completed" },
      error instanceof IsolationError ? 403 : 503,
    ),
  );
  if (webOrigin)
    app.get("/authorize", (c) =>
      c.redirect(new URL("/integrations/setup?mode=runtime", webOrigin).href),
    );
  const authenticated = async (
    c: Context,
    handle: (token: string, raw: string) => Promise<Response>,
  ) => {
    const raw = await readBoundedBody(c.req.raw, 1024 * 1024);
    if (raw === null) return c.body(null, 413);
    return handle(bearerToken(c.req.header("authorization")), raw);
  };
  app.post("/", (c) =>
    authenticated(c, async (token, raw) =>
      c.json({ data: await gateway.command(token, JSON.parse(raw), c.req.raw.signal) }),
    ),
  );
  // Convoy probes reachability before the route is enabled, without credentials.
  // Hono serves HEAD through GET. Neither accepts events; POST authenticates delivery.
  app.get("/deliver/:id", (c) => c.body(null, 204));
  app.post("/deliver/:id", (c) =>
    authenticated(c, async (token, raw) => {
      await gateway.receive(c.req.param("id"), token, raw);
      return c.json({ ok: true });
    }),
  );
  parent.route("/api/integration-gateway", app);
}
