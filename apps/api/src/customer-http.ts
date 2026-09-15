import type { createCustomerBusinessTools, createCustomerIngress } from "@rakazo/adapters";
import type { Context } from "hono";
import { Hono } from "hono";
import { bearerToken, readBoundedBody } from "./http-body.js";

/** Channel signatures and short-lived execution keys are independent of app sessions. */
export function mountCustomerHttp(
  parent: Hono,
  ingress: ReturnType<typeof createCustomerIngress>,
  tools: ReturnType<typeof createCustomerBusinessTools>,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.onError((_error, c) =>
    c.json({ error: "Customer request could not be verified or completed" }, 403),
  );
  const bearer = (c: Context) => bearerToken(c.req.header("authorization"));
  async function body(c: Context, limit: number) {
    const value = await readBoundedBody(c.req.raw, limit);
    if (value === null) throw new Error("Request too large");
    return value;
  }
  app.get("/customer-tools", async (c) => c.json(await tools.list(bearer(c))));
  app.post("/customer-tools", async (c) =>
    c.json(await tools.execute(bearer(c), JSON.parse(await body(c, 64_000)))),
  );
  app.get("/customer-events/:id", async (c) => {
    if (c.req.query("hub.mode") !== "subscribe") return c.body(null, 400);
    await ingress.challenge(c.req.param("id"), c.req.query("hub.verify_token") ?? "");
    return c.text((c.req.query("hub.challenge") ?? "").slice(0, 4000));
  });
  app.post("/customer-events/:id", async (c) => {
    return c.json(
      await ingress.receive(c.req.param("id"), c.req.raw.headers, await body(c, 1024 * 1024)),
    );
  });
  parent.route("/api", app);
}
