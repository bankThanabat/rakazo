import type { AdapterContext, ConnectorCall, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createCustomerConnector } from "./customer-connector.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";

const actor = { userId: "owner", spaceId: "space" };
function fixture(policies: Record<string, unknown>) {
  const contexts: AdapterContext[] = [];
  const executed: ConnectorCall[] = [];
  const provider = {
    async discoverTools(context: AdapterContext) {
      contexts.push(context);
      return [];
    },
    async *execute(call: ConnectorCall, context: AdapterContext) {
      contexts.push(context);
      executed.push(call);
      yield { type: "result" as const, data: { ok: true } };
    },
  } as unknown as ManagedConnectorProvider;
  const connector = createCustomerConnector({
    prisma: {
      spaceMember: { findFirst: vi.fn(async () => ({ id: "member" })) },
      connection: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          Object.hasOwn(policies, where.id)
            ? {
                id: where.id,
                connectorId: "open-connector",
                provider: "sample",
                displayName: where.id,
                providerRef: `ref-${where.id}`,
                actionPolicy: policies[where.id],
              }
            : null,
        ),
      },
    } as unknown as PrismaClient,
    integrations: { resolve: async () => provider } as unknown as IntegrationProviderSettings,
  });
  return { connector, contexts, executed };
}

it("gives a customer run only the shared actions and reads a malformed policy as empty", async () => {
  const f = fixture({
    channel: { defaults: { "sample.send": false, "sample.publish": true } },
    broken: { defaults: { "sample.send": "false" } },
  });
  await f.connector.discover(actor, ["channel", "broken"]);
  expect(f.contexts[0]!.actionAccess).toEqual({ channel: ["sample.send"], broken: [] });
  expect(await f.connector.actionsAllowed(actor, "channel", ["sample.send"])).toBe(true);
  expect(
    await f.connector.actionsAllowed(actor, "channel", ["sample.send", "sample.publish"]),
  ).toBe(false);
  expect(await f.connector.actionsAllowed(actor, "broken", ["sample.send"])).toBe(false);
});

it("drops a disconnected account from the scope instead of failing the turn", async () => {
  const f = fixture({ channel: { defaults: { "sample.send": false } } });
  await f.connector.discover(actor, ["channel", "disconnected"]);
  expect(f.contexts[0]!.connectedConnections!.map((row) => row.id)).toEqual(["channel"]);
  expect(await f.connector.actionsAllowed(actor, "disconnected", ["sample.send"])).toBe(false);
  expect(await f.connector.discover(actor, ["disconnected"])).toEqual([]);
});

it("blocks an internal action for customers before it reaches the provider", async () => {
  const f = fixture({ channel: { defaults: { "sample.send": false } } });
  await expect(
    f.connector.execute(actor, "channel", "sample.publish", {}, "execution", "customer"),
  ).rejects.toThrow("unavailable");
  expect(f.executed).toEqual([]);
  await f.connector.execute(actor, "channel", "sample.send", {}, "execution", "customer");
  await f.connector.execute(actor, "channel", "sample.publish", {}, "execution");
  expect(f.executed.map((call) => call.tool)).toEqual(["sample.send", "sample.publish"]);
  expect(f.contexts.at(-1)!.actionAccess).toBeUndefined();
});
