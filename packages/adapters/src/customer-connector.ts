import type { AdapterContext, ConnectorCall, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { actionInternal, readActionPolicy, sharedActions } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { connectionAccessWhere, IsolationError } from "@rakazo/db";
import { assertConnectorActionAllowed } from "./connector-action-access.js";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";

type Caller = Pick<Actor, "userId" | "spaceId">;
/** Customer runs carry the account policy as `actionAccess`; staff runs are unrestricted. */
export type ConnectorAudience = "staff" | "customer";
const CONNECTOR_ID = "open-connector";

export function createCustomerConnector(deps: {
  prisma: PrismaClient;
  integrations: IntegrationProviderSettings;
}) {
  const { prisma } = deps;
  async function find(actor: Caller, id: string) {
    if (
      !(await prisma.spaceMember.findFirst({
        where: { userId: actor.userId, spaceId: actor.spaceId },
      }))
    )
      throw new IsolationError();
    const row = await prisma.connection.findFirst({
      where: {
        ...connectionAccessWhere(actor),
        id,
        connectorId: CONNECTOR_ID,
        status: "connected",
      },
    });
    return row?.providerRef ? row : null;
  }
  type Row = NonNullable<Awaited<ReturnType<typeof find>>>;
  async function connection(actor: Caller, id: string) {
    const row = await find(actor, id);
    if (!row) throw new Error("Connect and authorize the messaging account first");
    return row;
  }
  /** A disconnected account drops out of the scope, so only its actions become unavailable. */
  async function connected(actor: Caller, ids: string[]) {
    const rows = await Promise.all([...new Set(ids)].map((id) => find(actor, id)));
    return rows.filter((row) => row !== null);
  }

  async function scope(
    actor: Caller,
    rows: Row[],
    executionId: string,
    audience: ConnectorAudience,
  ) {
    const context: AdapterContext = {
      ...actor,
      operationId: executionId,
      traceId: executionId,
      signal: AbortSignal.timeout(20_000),
      connectedConnections: rows.map((row) => ({
        id: row.id,
        connectorId: row.connectorId,
        externalId: row.provider,
        displayName: row.displayName,
        providerRef: row.providerRef!,
      })),
      ...(audience === "customer" && {
        actionAccess: Object.fromEntries(
          rows.map((row) => [row.id, sharedActions(readActionPolicy(row.actionPolicy))]),
        ),
      }),
    };
    const provider = await deps.integrations.resolve(CONNECTOR_ID);
    if (!provider) throw new Error("Messaging integration is unavailable");
    return { context, provider };
  }

  async function result(
    provider: ManagedConnectorProvider,
    call: ConnectorCall,
    context: AdapterContext,
  ) {
    let data: unknown;
    let completed = false;
    for await (const event of provider.execute(call, context)) {
      if (event.type === "error") throw new Error("Connector action failed");
      if (event.type === "result") {
        data = event.data;
        completed = true;
      }
    }
    if (!completed) throw new Error("Connector action did not confirm completion");
    return data;
  }

  async function execute(
    actor: Caller,
    connectionId: string,
    tool: string,
    args: Record<string, unknown>,
    executionId: string,
    audience: ConnectorAudience = "staff",
  ) {
    const row = await connection(actor, connectionId);
    const { provider, context } = await scope(actor, [row], executionId, audience);
    const call: ConnectorCall = {
      tool,
      executionId,
      connectionId,
      route: { connectorId: CONNECTOR_ID, resourceId: connectionId, toolName: tool },
      args,
    };
    assertConnectorActionAllowed(context, call.route!);
    return result(provider, call, context);
  }

  // Pi and the customer bridge use the same provider discovery, schemas, resolver and executor.
  async function customerScope(actor: Caller, ids: string[], executionId: string) {
    return scope(actor, await connected(actor, ids), executionId, "customer");
  }
  async function discover(actor: Caller, ids: string[]) {
    const rows = await connected(actor, ids);
    if (!rows.length) return [];
    const { provider, context } = await scope(actor, rows, "customer.tools", "customer");
    return provider.discoverTools(context);
  }
  async function resolveTool(
    actor: Caller,
    ids: string[],
    name: string,
    args: Record<string, unknown>,
    executionId: string,
  ) {
    const { provider, context } = await customerScope(actor, ids, executionId);
    const tool = (await provider.discoverTools(context)).find((tool) => tool.name === name);
    if (!tool?.route) throw new Error("Customer tool is unavailable");
    const call: ConnectorCall = { tool: name, args, executionId, route: tool.route };
    const resolved = await provider.resolveCall?.(call, context);
    if (resolved) assertConnectorActionAllowed(context, resolved.call.route!);
    return { call: resolved?.call ?? call, tool: resolved?.tool ?? tool };
  }
  async function executeTool(actor: Caller, ids: string[], call: ConnectorCall) {
    // Reload the current policy immediately before dispatch, including after a cached discovery.
    const { provider, context } = await customerScope(actor, ids, call.executionId);
    if (call.route?.resourceId) assertConnectorActionAllowed(context, call.route);
    return result(provider, call, context);
  }
  async function actionsAllowed(actor: Caller, id: string, actions: string[]) {
    const row = await find(actor, id);
    if (!row) return false;
    const policy = readActionPolicy(row.actionPolicy);
    return actions.every((action) => !actionInternal(policy, action));
  }
  return { connection, execute, discover, resolveTool, executeTool, actionsAllowed };
}
