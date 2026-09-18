import type { IntegrationGateway } from "@rakazo/adapters";
import { IsolationError } from "@rakazo/db";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { mountIntegrationGateway } from "./integration-gateway-http.js";

it("verifies challenge tokens and forwards raw webhook bytes without treating probes as events", async () => {
  const challenge = vi.fn(async (_id: string, token: string) => {
    if (token !== "fixture-verify") throw new IsolationError();
  });
  const receiveWebhook = vi.fn(async () => undefined);
  const app = new Hono();
  mountIntegrationGateway(app, { challenge, receiveWebhook } as unknown as IntegrationGateway);
  const path = "/api/integration-gateway/webhook/route";
  expect((await app.request(path)).status).toBe(400);
  expect(
    (await app.request(`${path}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`))
      .status,
  ).toBe(403);
  const response = await app.request(
    `${path}?hub.mode=subscribe&hub.verify_token=fixture-verify&hub.challenge=42`,
  );
  expect(await response.text()).toBe("42");
  expect(receiveWebhook).not.toHaveBeenCalled();
  const raw = '{ "entry": [] }';
  expect(
    (
      await app.request(path, {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": "fixture-signature" },
      })
    ).status,
  ).toBe(200);
  expect(receiveWebhook).toHaveBeenCalledWith("route", expect.any(Headers), raw);
  expect(
    (await app.request(path, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status,
  ).toBe(413);
  expect(receiveWebhook).toHaveBeenCalledTimes(1);
});

it("answers Convoy's unauthenticated HEAD probe without accepting a delivery", async () => {
  const receive = vi.fn(async () => {
    throw new IsolationError();
  });
  const app = new Hono();
  mountIntegrationGateway(app, { receive } as unknown as IntegrationGateway);
  const path = "/api/integration-gateway/deliver/pending-route";
  const probe = await app.request(path, { method: "HEAD" });
  expect(probe.status).toBe(204);
  expect(await probe.text()).toBe("");
  expect(probe.headers.get("cache-control")).toBe("no-store");
  expect(receive).not.toHaveBeenCalled();
  expect((await app.request(path, { method: "POST", body: "{}" })).status).toBe(403);
});

it("uses only bearer authentication, preserves delivery bytes and rejects oversized requests before dispatch", async () => {
  const command = vi.fn(async (token: string) => {
    if (token !== "fixture-runtime") throw new IsolationError();
    return [];
  });
  const receive = vi.fn(async (_id: string, token: string) => {
    if (token !== "fixture-delivery") throw new IsolationError();
  });
  const app = new Hono();
  mountIntegrationGateway(
    app,
    { command, receive } as unknown as IntegrationGateway,
    "https://web.example.test",
  );
  const authorize = await app.request("/api/integration-gateway/authorize");
  expect(authorize.headers.get("location")).toBe(
    "https://web.example.test/integrations/setup?mode=runtime",
  );
  const send = (path: string, body: string, token?: string) =>
    app.request(`/api/integration-gateway${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
  expect((await send("", '{"op":"deliveries"}')).status).toBe(403);
  expect((await send("", '{"op":"deliveries"}', "fixture-runtime")).status).toBe(200);
  const raw = '{ "text": "hello\\nworld" }';
  expect((await send("/deliver/route-a", raw, "fixture-delivery")).status).toBe(200);
  expect(receive).toHaveBeenCalledWith("route-a", "fixture-delivery", raw);
  receive.mockClear();
  expect(
    (await send("/deliver/route-a", "x".repeat(1024 * 1024 + 1), "fixture-delivery")).status,
  ).toBe(413);
  expect(receive).not.toHaveBeenCalled();
  receive.mockRejectedValueOnce(new Error("Database unavailable"));
  const failed = await send("/deliver/route-a", raw, "fixture-delivery");
  expect(failed.status).toBe(503);
  expect(failed.headers.get("cache-control")).toBe("no-store");
});
