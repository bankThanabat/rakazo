import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { actionInternal, readActionPolicy } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { connectionAccessWhere, IsolationError } from "@rakazo/db";

export function createConnectionActionSettings(deps: {
  prisma: PrismaClient;
  provider: (id: string) => ManagedConnectorProvider | undefined;
}) {
  async function load(context: AdapterContext, connectionId: string, ownerOnly = false) {
    const row = await deps.prisma.connection.findFirst({
      where: { ...connectionAccessWhere(context), id: connectionId, status: "connected" },
    });
    if (!row || (ownerOnly && row.userId !== context.userId)) throw new IsolationError();
    const provider = deps.provider(row.connectorId);
    if (!provider?.listActions)
      throw new Error("Action settings are unavailable for this connector");
    return { row, actions: await provider.listActions(row.provider, context) };
  }
  return {
    async list(context: AdapterContext, connectionId: string) {
      const { row, actions } = await load(context, connectionId);
      const policy = readActionPolicy(row.actionPolicy);
      return actions.map((action) => ({
        name: action.name,
        description: action.description,
        internal: actionInternal(policy, action.name),
        defaultInternal: !action.sharedByDefault,
        overridden: Object.hasOwn(policy.overrides, action.name),
      }));
    },
    async configure(
      context: AdapterContext,
      connectionId: string,
      change: { action: string; internal: boolean | null } | "defaults",
    ) {
      const { row, actions } = await load(context, connectionId, true);
      const changed =
        change === "defaults" ? undefined : actions.find((a) => a.name === change.action);
      if (change !== "defaults" && !changed) throw new Error("Action is unavailable");
      await deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM connections WHERE id = ${connectionId} FOR UPDATE`;
        const current = await tx.connection.findFirst({
          where: {
            id: connectionId,
            userId: context.userId,
            spaceId: context.spaceId,
            status: "connected",
          },
        });
        if (!current || current.providerRef !== row.providerRef) throw new IsolationError();
        const policy = readActionPolicy(current.actionPolicy);
        if (change === "defaults") {
          policy.defaults = Object.fromEntries(actions.map((a) => [a.name, !a.sharedByDefault]));
          policy.overrides = {};
        } else if (change.internal === null) {
          policy.defaults[change.action] = !changed!.sharedByDefault;
          delete policy.overrides[change.action];
        } else {
          policy.overrides[change.action] = change.internal;
        }
        await tx.connection.update({ where: { id: connectionId }, data: { actionPolicy: policy } });
      });
      return { ok: true as const };
    },
  };
}
