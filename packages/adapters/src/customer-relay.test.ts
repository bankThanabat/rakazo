import type { ConnectorEvent } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { GatewayCommandSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { setupCustomerIncoming } from "./customer-relay.js";
import { IntegrationGatewayClient } from "./integration-gateway-client.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

it("rechecks credentials after a failed verification and keeps accounts independent", async () => {
  const actor: Actor = {
    userId: "user-a",
    spaceId: "space-a",
    email: "user@example.test",
    isDeploymentOwner: false,
  };
  const account = (id: string) => ({
    id,
    ...actor,
    provider: "line",
    connectorId: "open-connector",
    providerRef: `ref-${id}`,
    displayName: "LINE",
    status: "connected",
  });
  const update = vi.fn();
  const tx = {
    $queryRaw: vi.fn(),
    connection: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => account(where.id),
    },
    customerChannel: {
      findUnique: async ({ where }: { where: { connectionId: string } }) => ({
        id: `channel-${where.connectionId}`,
        userId: actor.userId,
        botId: "bot",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      update,
    },
  };
  const prisma = {
    spaceMember: { findFirst: async () => ({}) },
    connection: { findFirst: async ({ where }: { where: { id: string } }) => account(where.id) },
    bot: { findFirst: async () => ({ id: "bot" }) },
    secret: { upsert: vi.fn() },
    $transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as PrismaClient;
  let valid = false;
  let lookups = 0;
  // OpenConnector retains both successes and failures under a global request key.
  const cached = new Map<string, { accountId: string; events: ConnectorEvent[] }>();
  const gateway = new IntegrationGatewayClient(
    { endpoint: "https://gateway.example.test", apiKey: "fake-gateway-token" },
    async (_url, init) => {
      const command = GatewayCommandSchema.parse(JSON.parse(String(init?.body)));
      if (command.op === "incoming")
        return Response.json({
          data: { id: command.channelId, webhookUrl: "https://relay.example.test/hook" },
        });
      if (command.op !== "execute") throw new Error("Unexpected command");
      const accountId = command.connections[0]!.id;
      const key = command.call.executionId;
      const previous = cached.get(key);
      if (previous)
        return Response.json({
          data:
            previous.accountId === accountId
              ? previous.events
              : [{ type: "error", message: "idempotency_key_conflict" }],
        });
      lookups++;
      const events: ConnectorEvent[] = valid
        ? [{ type: "result", data: { userId: `line-${accountId}` } }]
        : [{ type: "error", message: "invalid channel access token" }];
      cached.set(key, { accountId, events });
      return Response.json({ data: events });
    },
  );
  const deps = {
    prisma,
    secrets: new EncryptedSecretStore("fake-encryption-key"),
    integrations: { resolve: async () => gateway } as unknown as IntegrationProviderSettings,
  };
  const input = {
    connectionId: "account-a",
    botId: "bot",
    secrets: { channelSecret: "fake-secret" },
  };
  await expect(setupCustomerIncoming(deps, actor, input)).rejects.toThrow(
    "invalid channel access token",
  );
  valid = true;
  await expect(setupCustomerIncoming(deps, actor, input)).resolves.toMatchObject({
    id: "channel-account-a",
  });
  await expect(
    setupCustomerIncoming(deps, actor, { ...input, connectionId: "account-b" }),
  ).resolves.toMatchObject({ id: "channel-account-b" });
  expect(lookups).toBe(3);
  expect(update.mock.calls.map(([request]) => request.data.binding.receive.account.equals)).toEqual(
    ["line-account-a", "line-account-b"],
  );
});
