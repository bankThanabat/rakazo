import { createHmac } from "node:crypto";
import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { CustomerProviderSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { CustomerChannelEmulator } from "./emulator.js";
import { CUSTOMER_PROVIDERS, createCustomerChannelSurface } from "./index.js";

const context: AdapterContext = {
  userId: "owner",
  spaceId: "space",
  operationId: "operation",
  traceId: "trace",
  signal: new AbortController().signal,
};
const credentials = {
  accessToken: "test-access-token",
  channelSecret: "test-secret",
  appSecret: "test-secret",
  verifyToken: "test-verify-token",
  apiVersion: "v25.0",
  clientSecret: "test-secret",
};

it("resolves a LINE profile through the shared surface without sending messages", async () => {
  const emulator = new CustomerChannelEmulator();
  emulator.profiles.set("customer-1", {
    displayName: "Alex Customer",
    pictureUrl: "https://images.example.test/customer.png",
  });
  const surface = createCustomerChannelSurface(
    { provider: "line", accountId: "business-1", credentials },
    emulator.fetch,
  );
  expect(await surface.getUserProfile("line", "customer-1")).toEqual({
    name: "Alex Customer",
    avatarUrl: "https://images.example.test/customer.png",
  });
  expect(await surface.getUserProfile("instagram", "customer-1")).toBeNull();
  await expect(surface.getUserProfile("line", "missing")).rejects.toThrow(
    "Customer profile unavailable",
  );
  expect(emulator.sent).toHaveLength(0);
  await surface.shutdown();
});

it("rejects a LINE profile for a different user", async () => {
  const surface = createCustomerChannelSurface(
    { provider: "line", accountId: "business-1", credentials },
    async () => Response.json({ userId: "other", displayName: "Other" }),
  );
  await expect(surface.getUserProfile("line", "customer-1")).rejects.toThrow();
  await surface.shutdown();
});
for (const provider of ["line", "instagram", "tiktok"] as const) {
  describe(`${provider} Chat SDK conformance`, () => {
    it("verifies, normalizes and replies through the provider API", async () => {
      const emulator = new CustomerChannelEmulator();
      const surface = createCustomerChannelSurface(
        { provider, accountId: "business-1", credentials },
        emulator.fetch,
      );
      const received: MessagingInboundEvent[] = [];
      surface.onInbound(async (event) => {
        received.push(event);
      });
      const response = await surface.handleWebhook(
        provider,
        emulator.request(provider, {
          url: "https://example.test/webhook",
          accountId: "business-1",
          secret: "test-secret",
          text: "Order question",
        }),
      );
      expect(response?.status).toBe(200);
      expect(received).toHaveLength(1);
      const event = received[0]!;
      expect(event).toMatchObject({
        type: "message",
        content: "Order question",
        from: "customer-1",
        isDirect: true,
      });
      if (event.type !== "message") throw new Error("Expected message");
      const sent = await surface.sendToThread(
        { threadId: event.threadId, body: "How can I help?" },
        context,
      );
      expect(sent.handle).toBe("sent-1");
      const request = emulator.sent[0]!;
      expect(request.headers[provider === "tiktok" ? "access-token" : "authorization"]).toBe(
        provider === "tiktok" ? credentials.accessToken : `Bearer ${credentials.accessToken}`,
      );
      if (provider === "line")
        expect(request.headers["x-line-retry-key"]).toMatch(/^[0-9a-f-]{36}$/);
      if (provider === "line")
        expect(request).toMatchObject({
          url: "https://api.line.me/v2/bot/message/push",
          body: { to: "customer-1", messages: [{ type: "text", text: "How can I help?" }] },
        });
      if (provider === "instagram")
        expect(request.body).toEqual({
          recipient: { id: "customer-1" },
          message: { text: "How can I help?" },
        });
      if (provider === "tiktok")
        expect(request.body).toEqual({
          business_id: "business-1",
          recipient_type: "CONVERSATION",
          recipient: "conversation-customer-1",
          message_type: "TEXT",
          text: { body: "How can I help?" },
        });
      await surface.shutdown?.();
    });
    it("rejects invalid signatures without creating work", async () => {
      const emulator = new CustomerChannelEmulator();
      const surface = createCustomerChannelSurface(
        { provider, accountId: "business-1", credentials },
        emulator.fetch,
      );
      let count = 0;
      surface.onInbound(async () => {
        count++;
      });
      const response = await surface.handleWebhook(
        provider,
        emulator.request(provider, {
          url: "https://example.test/webhook",
          accountId: "business-1",
          secret: "wrong-secret",
        }),
      );
      expect(response?.status).toBe(401);
      expect(count).toBe(0);
    });
    it.each(["missing", "altered"])(
      "rejects %s authentication without creating work",
      async (kind) => {
        const emulator = new CustomerChannelEmulator();
        const surface = createCustomerChannelSurface(
          { provider, accountId: "business-1", credentials },
          emulator.fetch,
        );
        const received: MessagingInboundEvent[] = [];
        surface.onInbound(async (event) => {
          received.push(event);
        });
        const signed = emulator.request(provider, {
          url: "https://example.test",
          accountId: "business-1",
          secret: "test-secret",
        });
        const body = await signed.text();
        const response = await surface.handleWebhook(
          provider,
          new Request(signed.url, {
            method: "POST",
            headers: kind === "missing" ? {} : signed.headers,
            body: kind === "altered" ? `${body} ` : body,
          }),
        );
        expect(response?.status).toBe(401);
        expect(received).toHaveLength(0);
        await surface.shutdown?.();
      },
    );
    it("does not deliver another business's messages", async () => {
      const emulator = new CustomerChannelEmulator();
      const surface = createCustomerChannelSurface(
        { provider, accountId: "business-1", credentials },
        emulator.fetch,
      );
      let count = 0;
      surface.onInbound(async () => {
        count++;
      });
      await surface.handleWebhook(
        provider,
        emulator.request(provider, {
          url: "https://example.test/webhook",
          accountId: "another-business",
          secret: "test-secret",
        }),
      );
      expect(count).toBe(0);
    });
    it("allows a provider retry after the durable receiver fails", async () => {
      const emulator = new CustomerChannelEmulator();
      const surface = createCustomerChannelSurface(
        { provider, accountId: "business-1", credentials },
        emulator.fetch,
      );
      let attempts = 0;
      surface.onInbound(async () => {
        if (++attempts === 1) throw new Error("Temporary database failure");
      });
      const request = () =>
        emulator.request(provider, {
          url: "https://example.test",
          accountId: "business-1",
          secret: "test-secret",
        });
      expect((await surface.handleWebhook(provider, request()))?.status).toBe(500);
      expect((await surface.handleWebhook(provider, request()))?.status).toBe(200);
      expect(attempts).toBe(2);
      await surface.shutdown?.();
    });
    it("surfaces failed sends without inventing a delivery handle", async () => {
      const emulator = new CustomerChannelEmulator();
      emulator.failSend = true;
      const surface = createCustomerChannelSurface(
        { provider, accountId: "business-1", credentials },
        emulator.fetch,
      );
      await expect(
        surface.sendToThread(
          { threadId: `${provider}:business-1:customer-1`, body: "Hello" },
          context,
        ),
      ).rejects.toThrow();
    });
  });
}
it("accepts LINE's signed empty webhook verification", async () => {
  const surface = createCustomerChannelSurface({
    provider: "line",
    accountId: "business-1",
    credentials,
  });
  const body = JSON.stringify({ destination: "business-1", events: [] });
  const result = await surface.handleWebhook(
    "line",
    new Request("https://example.test", {
      method: "POST",
      body,
      headers: {
        "x-line-signature": createHmac("sha256", "test-secret").update(body).digest("base64"),
      },
    }),
  );
  expect(result?.status).toBe(200);
});
it("checks Instagram's verification token", async () => {
  const surface = createCustomerChannelSurface({
    provider: "instagram",
    accountId: "business-1",
    credentials,
  });
  const result = await surface.handleWebhook(
    "instagram",
    new Request(
      "https://example.test?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge",
    ),
  );
  expect(await result?.text()).toBe("challenge");
});
it("preserves Instagram media URLs for the authenticated customer transcript", async () => {
  const emulator = new CustomerChannelEmulator();
  const surface = createCustomerChannelSurface(
    { provider: "instagram", accountId: "business-1", credentials },
    emulator.fetch,
  );
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  await surface.handleWebhook(
    "instagram",
    emulator.request("instagram", {
      url: "https://example.test",
      accountId: "business-1",
      secret: "test-secret",
      mediaUrl: "https://images.example.test/photo.jpg",
    }),
  );
  expect(events[0]).toMatchObject({ mediaUrl: "https://images.example.test/photo.jpg" });
});
it("rejects expired and future TikTok signatures", async () => {
  const emulator = new CustomerChannelEmulator();
  const surface = createCustomerChannelSurface(
    { provider: "tiktok", accountId: "business-1", credentials },
    emulator.fetch,
  );
  for (const offset of [-3600000, 3600000]) {
    const result = await surface.handleWebhook(
      "tiktok",
      emulator.request("tiktok", {
        url: "https://example.test",
        accountId: "business-1",
        secret: "test-secret",
        timestamp: Date.now() + offset,
      }),
    );
    expect(result?.status).toBe(401);
  }
});

it("requires Instagram's sha256 algorithm prefix and ignores empty message events", async () => {
  const emulator = new CustomerChannelEmulator();
  const surface = createCustomerChannelSurface(
    { provider: "instagram", accountId: "business-1", credentials },
    emulator.fetch,
  );
  const received: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    received.push(event);
  });
  const original = emulator.request("instagram", {
    url: "https://example.test",
    accountId: "business-1",
    secret: "test-secret",
  });
  const body = await original.text();
  for (const prefix of ["", "sha1="]) {
    const result = await surface.handleWebhook(
      "instagram",
      new Request(original.url, {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256":
            prefix + createHmac("sha256", "test-secret").update(body).digest("hex"),
        },
      }),
    );
    expect(result?.status).toBe(401);
  }
  const payload = JSON.parse(body);
  delete payload.entry[0].messaging[0].message.text;
  const empty = JSON.stringify(payload);
  const response = await surface.handleWebhook(
    "instagram",
    new Request(original.url, {
      method: "POST",
      body: empty,
      headers: {
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(empty).digest("hex")}`,
      },
    }),
  );
  expect(response?.status).toBe(200);
  expect(received).toHaveLength(0);
  await surface.shutdown?.();
});

it("keeps LINE receipt and message identities separate and reuses a send retry key", async () => {
  const emulator = new CustomerChannelEmulator();
  const surface = createCustomerChannelSurface(
    { provider: "line", accountId: "business-1", credentials },
    emulator.fetch,
  );
  const received: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    received.push(event);
  });
  await surface.handleWebhook(
    "line",
    emulator.request("line", {
      url: "https://example.test",
      accountId: "business-1",
      secret: "test-secret",
      eventId: "receipt-1",
      messageId: "message-1",
    }),
  );
  expect(received[0]).toMatchObject({ handle: "message-1", receiptId: "receipt-1" });
  const request = {
    threadId: "line:business-1:customer-1",
    body: "Hello",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  };
  emulator.loseResponse = true;
  await expect(surface.sendToThread(request, context)).rejects.toThrow();
  expect(await surface.sendToThread(request, context)).toEqual({ handle: "sent-1" });
  expect(emulator.sent).toHaveLength(1);
  expect(emulator.attempts.map((request) => request.headers["x-line-retry-key"])).toEqual([
    request.idempotencyKey,
    request.idempotencyKey,
  ]);
  await surface.shutdown?.();
});

it("defines every contracted customer provider exactly once", () => {
  expect(CUSTOMER_PROVIDERS.map((provider) => provider.id).sort()).toEqual(
    [...CustomerProviderSchema.options].sort(),
  );
});
