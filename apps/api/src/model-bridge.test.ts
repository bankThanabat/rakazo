import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  bridgeTestAccess,
  bridgeTestActor,
  bridgeTestModel,
  modelBridgeFixture,
} from "../../../packages/adapters/src/model-bridge-test-fixture.js";
import { mountModelBridge } from "./model-bridge.js";

function fixture() {
  const f = modelBridgeFixture();
  const app = new Hono();
  mountModelBridge(
    app,
    f.bridge,
    async (c) =>
      c.req.header("cookie") === "test-session=owner"
        ? { ...bridgeTestActor, email: "owner@example.test", isDeploymentOwner: true }
        : null,
    (origin) => origin === "https://app.example.test",
  );
  app.get("/other-provider", (c) => c.json({ auth: "unchanged" }));
  const grant = () =>
    app.request("/api/model-bridge/grants", {
      method: "POST",
      headers: {
        cookie: "test-session=owner",
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: JSON.stringify({ credentialId: "credential", modelId: bridgeTestModel }),
    });
  return { ...f, app, grant };
}

describe("optional model bridge HTTP API", () => {
  it("issues a scoped key with an existing Rakazo session and accepts it as an OpenAI bearer", async () => {
    const f = fixture();
    const created = await f.grant();
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const { apiKey, basePath, id } = await created.json();
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    expect((await f.app.request(`${basePath}/models`, { headers })).status).toBe(200);
    const response = await f.app.request(`${basePath}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: bridgeTestModel,
        messages: [{ role: "user", content: "Hours?" }],
        stream: true,
      }),
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("Open until six.");
    expect(text).not.toContain(bridgeTestAccess);
    expect(
      (
        await f.app.request(`/api/model-bridge/grants/${id}`, {
          method: "DELETE",
          headers: { cookie: "test-session=owner" },
        })
      ).status,
    ).toBe(204);
    expect((await f.app.request(`${basePath}/models`, { headers })).status).toBe(401);
    expect(await (await f.app.request("/other-provider")).json()).toEqual({ auth: "unchanged" });
  });

  it("never accepts a session cookie as a model key or a model key as a session", async () => {
    const f = fixture();
    const { apiKey, basePath } = await (await f.grant()).json();
    expect(
      (await f.app.request(`${basePath}/models`, { headers: { cookie: "test-session=owner" } }))
        .status,
    ).toBe(401);
    expect(
      (await f.app.request(`${basePath}/models`, { headers: { authorization: apiKey } })).status,
    ).toBe(401);
    expect(
      (
        await f.app.request("/api/model-bridge/grants", {
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).status,
    ).toBe(401);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("rejects cross-origin grants and oversized or malformed model requests", async () => {
    const f = fixture();
    const badOrigin = await f.app.request("/api/model-bridge/grants", {
      method: "POST",
      headers: {
        cookie: "test-session=owner",
        origin: "https://evil.example.test",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(badOrigin.status).toBe(403);
    const { apiKey, basePath } = await (await f.grant()).json();
    for (const body of [
      "not-json",
      JSON.stringify({ messages: [], secret: "private" }),
      " ".repeat(1024 * 1024 + 1),
    ]) {
      const response = await f.app.request(`${basePath}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private");
    }
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("returns sanitized model failures as HTTP errors and SSE error events", async () => {
    const f = fixture();
    const { apiKey, basePath } = await (await f.grant()).json();
    f.upstream.mockImplementation(
      async () => new Response(`secret ${bridgeTestAccess}`, { status: 400 }),
    );
    for (const stream of [false, true]) {
      const response = await f.app.request(`${basePath}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: bridgeTestModel,
          messages: [{ role: "user", content: "Hello" }],
          stream,
        }),
      });
      expect(response.status).toBe(stream ? 200 : 502);
      const body = await response.text();
      expect(body).toContain("Model request failed");
      expect(body).not.toContain(bridgeTestAccess);
      if (stream) expect(body).not.toContain("[DONE]");
    }
  });
});
