import type { AdapterContext, ConnectorCall, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createCustomerConnector } from "./customer-connector.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";

const actor = { userId: "owner", spaceId: "space" };
function fixture(policies: Record<string, unknown>, readOnly?: boolean) {
  const contexts: AdapterContext[] = [];
  const executed: ConnectorCall[] = [];
  const provider = {
    async resolveCall(call: ConnectorCall) {
      return {
        call,
        tool: { name: call.tool, description: "Synthetic action", inputSchema: {}, readOnly },
      };
    },
    async listActions() {
      return [{ name: "sample.send", description: "Synthetic action", readOnly }];
    },
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
  return { connector, contexts, executed, provider };
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
  await f.connector.execute(actor, "channel", "sample.send", {}, "execution", "customer", "write");
  await f.connector.execute(actor, "channel", "sample.publish", {}, "execution");
  expect(f.executed.map((call) => call.tool)).toEqual(["sample.send", "sample.publish"]);
  expect(f.contexts.at(-1)!.actionAccess).toBeUndefined();
});

it.each([false, undefined])(
  "rejects a declared read when readOnly is %s before dispatch",
  async (readOnly) => {
    const f = fixture({ channel: { defaults: { "sample.send": false } } }, readOnly);
    await expect(
      f.connector.execute(actor, "channel", "sample.send", {}, "execution", "customer", "read"),
    ).rejects.toThrow("effect");
    await expect(
      f.connector.execute(actor, "channel", "sample.send", {}, "identity", "staff", "read"),
    ).rejects.toThrow("effect");
    await expect(
      f.connector.validateWorkflow(actor, "channel", [{ action: "sample.send", effect: "read" }]),
    ).rejects.toThrow("effect");
    expect(f.executed).toEqual([]);
  },
);

it("uses current provider metadata for reads and rejects a resolver that changes the target", async () => {
  const f = fixture({ channel: { defaults: { "sample.send": false } } }, true);
  await expect(
    f.connector.execute(
      actor,
      "channel",
      "sample.send",
      {},
      "identity",
      "customer",
      "read",
      "replaced-account",
    ),
  ).rejects.toThrow("account changed");
  expect(f.executed).toHaveLength(0);
  await f.connector.validateWorkflow(actor, "channel", [{ action: "sample.send", effect: "read" }]);
  await f.connector.execute(actor, "channel", "sample.send", {}, "read", "customer", "read");
  await expect(
    f.connector.execute(actor, "channel", "sample.send", {}, "write", "customer", "write"),
  ).rejects.toThrow("effect");
  f.provider.resolveCall = async (call) => ({
    call: { ...call, route: { ...call.route!, resourceId: "another-account" } },
    tool: { name: call.tool, description: "Synthetic action", inputSchema: {}, readOnly: true },
  });
  await expect(
    f.connector.execute(actor, "channel", "sample.send", {}, "changed", "customer", "read"),
  ).rejects.toThrow("effect");
  expect(f.executed).toHaveLength(1);
});
