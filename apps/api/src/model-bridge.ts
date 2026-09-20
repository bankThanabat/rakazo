import type { ModelBridge } from "@rakazo/adapters";
import { ModelBridgeError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import { bearerToken, readBoundedBody } from "./http-body.js";

export function mountModelBridge(
  parent: Hono,
  bridge: ModelBridge,
  actorFor: (context: Context) => Promise<Actor | null>,
  trustedOrigin: (origin: string) => boolean,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    const status = error instanceof ModelBridgeError ? error.status : 502;
    const message =
      error instanceof ModelBridgeError ? error.message : "Model bridge is unavailable";
    return c.json({ error: { message, type: "model_bridge_error" } }, status);
  });
  const bearer = (c: Context) => bearerToken(c.req.header("authorization"));
  async function actor(c: Context) {
    const origin = c.req.header("origin");
    if (origin && !trustedOrigin(origin)) throw new ModelBridgeError(403, "Origin is not allowed");
    const current = await actorFor(c);
    if (!current) throw new ModelBridgeError(401, "Sign in to Deskazo");
    return { userId: current.userId, spaceId: current.spaceId };
  }
  async function json(c: Context, maxBytes: number) {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ModelBridgeError(400, "Expected application/json");
    }
    const body = await readBoundedBody(c.req.raw, maxBytes);
    if (body === null) throw new ModelBridgeError(400, "Request body is too large");
    try {
      return JSON.parse(body);
    } catch {
      throw new ModelBridgeError(400, "Invalid JSON");
    }
  }
  app.get("/grants", async (c) => c.json(await bridge.list(await actor(c))));
  app.post("/grants", async (c) => {
    const scope = await actor(c);
    return c.json(await bridge.create(scope, await json(c, 4096)), 201);
  });
  app.delete("/grants/:id", async (c) => {
    await bridge.revoke(await actor(c), c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/v1/models", async (c) => c.json(await bridge.models(bearer(c))));
  app.post("/v1/chat/completions", async (c) => {
    // Reject absent/invalid grants before buffering a potentially large body.
    const token = bearer(c);
    await bridge.models(token);
    return bridge.respond(token, await json(c, 1024 * 1024), c.req.raw.signal);
  });
  parent.route("/api/model-bridge", app);
}
