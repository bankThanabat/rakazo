import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createConnectionActionSettings } from "./connection-action-settings.js";

const context = (userId: string): AdapterContext => ({
  userId,
  spaceId: "space",
  operationId: "settings",
  traceId: "settings",
  signal: new AbortController().signal,
});
function fixture(actionPolicy: unknown) {
  const transaction = vi.fn();
  const settings = createConnectionActionSettings({
    prisma: {
      connection: {
        findFirst: async () => ({
          id: "account",
          userId: "owner",
          connectorId: "open-connector",
          provider: "sample",
          actionPolicy,
        }),
      },
      $transaction: transaction,
    } as unknown as PrismaClient,
    provider: () =>
      ({
        listActions: async () => [
          { name: "sample.send", description: "Send", sharedByDefault: true },
          { name: "sample.publish", description: "Publish" },
        ],
      }) as unknown as ManagedConnectorProvider,
  });
  return { settings, transaction };
}

it("lets a teammate inspect settings but only the owner change them", async () => {
  const { settings, transaction } = fixture({ overrides: { "sample.publish": false } });
  expect(await settings.list(context("teammate"), "account")).toEqual([
    {
      name: "sample.send",
      description: "Send",
      internal: true,
      defaultInternal: false,
      overridden: false,
      readOnly: false,
    },
    {
      name: "sample.publish",
      description: "Publish",
      internal: false,
      defaultInternal: true,
      overridden: true,
      readOnly: false,
    },
  ]);
  await expect(settings.configure(context("teammate"), "account", "defaults")).rejects.toThrow(
    IsolationError,
  );
  await expect(
    settings.configure(context("owner"), "account", { action: "sample.missing", internal: false }),
  ).rejects.toThrow("unavailable");
  expect(transaction).not.toHaveBeenCalled();
});

it("shows every action as internal when the stored policy is malformed", async () => {
  const { settings } = fixture({ defaults: { "sample.send": "false" } });
  expect((await settings.list(context("owner"), "account")).map((row) => row.internal)).toEqual([
    true,
    true,
  ]);
});
