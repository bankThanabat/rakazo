import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountCustomerHttp } from "./customer-http.js";

describe("customer HTTP boundaries", () => {
  it("keeps execution bearer keys separate from browser sessions and verifies subscription challenges", async () => {
    const app = new Hono();
    const challenge = vi.fn(async (_id: string, token: string) => {
      if (token !== "fake-verify") throw new Error("denied");
    });
    const list = vi.fn(async (token: string) => {
      if (token !== "fake-execution") throw new Error("denied");
      return { tools: [] };
    });
    mountCustomerHttp(
      app,
      { challenge, receive: vi.fn(async () => ({ ok: true })) },
      { list, execute: vi.fn(async () => ({})) },
    );
    expect(
      (await app.request("/api/customer-tools", { headers: { cookie: "session=owner" } })).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/customer-tools", {
          headers: { authorization: "Bearer fake-execution" },
        })
      ).status,
    ).toBe(200);
    const accepted = await app.request(
      "/api/customer-events/channel?hub.mode=subscribe&hub.verify_token=fake-verify&hub.challenge=123",
    );
    expect(await accepted.text()).toBe("123");
    expect(
      (
        await app.request(
          "/api/customer-events/channel?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123",
        )
      ).status,
    ).toBe(403);
  });
});
