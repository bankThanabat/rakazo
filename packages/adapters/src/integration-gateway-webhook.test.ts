import { createHmac } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { IntegrationGateway } from "./integration-gateway.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

function fixture(direct = true) {
  const secrets = new EncryptedSecretStore("fixture-encryption");
  const route = {
    id: "route",
    enabled: true,
    account: {
      runtimeId: "runtime",
      revokedAt: null as Date | null,
      runtime: { revokedAt: null as Date | null, userId: "owner", spaceId: "space" },
    },
    ciphertext: secrets.seal(
      JSON.stringify({
        webhookSecret: "fixture-signing",
        deliveryToken: "fixture-delivery",
        ...(direct
          ? {
              verificationToken: "fixture-verify",
              verification: {
                header: "x-hub-signature-256",
                algorithm: "sha256",
                encoding: "hex",
                prefix: "sha256=",
              },
            }
          : {}),
      }),
      "route",
    ),
  };
  const deliveries = new Map<string, unknown>();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    gatewayRoute: { findUniqueOrThrow: vi.fn(async () => route) },
    gatewayDelivery: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => deliveries.get(where.id)),
      count: vi.fn(async () => deliveries.size),
      create: vi.fn(async ({ data }: { data: { id: string } }) => deliveries.set(data.id, data)),
    },
  };
  const prisma = {
    gatewayRoute: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === route.id ? route : null,
      ),
    },
    spaceMember: {
      findFirst: vi.fn(async () => ({
        userId: "owner",
        spaceId: "space",
        member: { user: { email: "fixture@example.test" } },
      })),
    },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (run: (db: typeof tx) => unknown) => run(tx)),
  };
  const gateway = new IntegrationGateway({
    prisma: prisma as unknown as PrismaClient,
    secrets,
    integrations: {} as IntegrationProviderSettings,
  });
  const raw = '{ "entry": [] }';
  const headers = new Headers({
    "x-hub-signature-256": `sha256=${createHmac("sha256", "fixture-signing").update(raw).digest("hex")}`,
  });
  return { gateway, route, prisma, tx, deliveries, raw, headers };
}

it("verifies Meta signatures over exact bytes and queues duplicates only once", async () => {
  const f = fixture();
  await f.gateway.challenge("route", "fixture-verify");
  await expect(f.gateway.challenge("route", "wrong")).rejects.toThrow();
  await expect(f.gateway.receiveWebhook("route", new Headers(), f.raw)).rejects.toThrow();
  await expect(f.gateway.receiveWebhook("route", f.headers, `${f.raw} `)).rejects.toThrow();
  expect(f.deliveries.size).toBe(0);
  await f.gateway.receiveWebhook("route", f.headers, f.raw);
  await f.gateway.receiveWebhook("route", f.headers, f.raw);
  expect(f.tx.gatewayDelivery.create).toHaveBeenCalledTimes(1);
  expect([...f.deliveries.values()]).toEqual([
    expect.objectContaining({ routeId: "route", payload: f.raw }),
  ]);
});

it("keeps direct signatures and relay bearer tokens separate", async () => {
  const direct = fixture();
  await expect(direct.gateway.receive("route", "fixture-delivery", direct.raw)).rejects.toThrow();
  const relay = fixture(false);
  await expect(relay.gateway.receiveWebhook("route", relay.headers, relay.raw)).rejects.toThrow();
  await expect(relay.gateway.challenge("route", "fixture-verify")).rejects.toThrow();
  await relay.gateway.receive("route", "fixture-delivery", relay.raw);
  expect(relay.deliveries.size).toBe(1);
});

it("rejects unknown routes, revoked runtimes and revocation racing signature verification", async () => {
  const f = fixture();
  await expect(f.gateway.receiveWebhook("other", f.headers, f.raw)).rejects.toThrow();
  f.route.account.runtime.revokedAt = new Date();
  await expect(f.gateway.receiveWebhook("route", f.headers, f.raw)).rejects.toThrow();
  f.route.account.runtime.revokedAt = null;
  f.tx.gatewayRoute.findUniqueOrThrow.mockImplementationOnce(async () => ({
    ...f.route,
    enabled: false,
  }));
  await expect(f.gateway.receiveWebhook("route", f.headers, f.raw)).rejects.toThrow();
  expect(f.deliveries.size).toBe(0);
});
