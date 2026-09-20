import type { AdapterContext, ConnectorCall, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { InstagramSendListInput, InstagramSendReconcileInput } from "@rakazo/contracts";
import { actionInternal, readActionPolicy, sharedActions } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { connectionAccessWhere, IsolationError } from "@rakazo/db";
import { assertConnectorActionAllowed } from "./connector-action-access.js";
import {
  instagramAccount,
  instagramAccountHash,
  instagramBindingHash,
} from "./instagram-comment-writes.js";
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
      if (event.type === "error") {
        if (event.dispatch === "not_started" && call.expectedAccountId !== undefined)
          throw new IsolationError();
        throw new Error("Connector action failed");
      }
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
    effect?: "read" | "write",
    expectedProviderRef?: string,
    signal?: AbortSignal,
    expectedAccountId?: string,
  ) {
    const row = await connection(actor, connectionId);
    if (expectedProviderRef !== undefined && row.providerRef !== expectedProviderRef)
      throw new Error("The linked provider account changed");
    const { provider, context } = await scope(actor, [row], executionId, audience);
    if (signal) context.signal = AbortSignal.any([context.signal, signal]);
    const call: ConnectorCall = {
      tool,
      executionId,
      connectionId,
      ...(expectedAccountId !== undefined ? { expectedAccountId } : {}),
      route: { connectorId: CONNECTOR_ID, resourceId: connectionId, toolName: tool },
      args,
    };
    assertConnectorActionAllowed(context, call.route!);
    if (audience === "customer" || effect !== undefined) {
      // A workflow's declaration cannot turn a connector write into a read and
      // bypass the durable operation ledger. Resolve again at dispatch time.
      const resolved = await provider.resolveCall?.(call, context);
      if (
        !effect ||
        !resolved ||
        (effect === "read") !== (resolved.tool.readOnly === true) ||
        resolved.call.route?.resourceId !== connectionId ||
        resolved.call.route?.toolName !== tool
      )
        throw new Error("Workflow step effect does not match the connected action");
      assertConnectorActionAllowed(context, resolved.call.route);
      return result(provider, resolved.call, context);
    }
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
  async function validateWorkflow(
    actor: Caller,
    connectionId: string,
    steps: Array<{ action: string; effect: "read" | "write" }>,
  ) {
    const row = await connection(actor, connectionId);
    const { provider, context } = await scope(actor, [row], "customer.workflow.validate", "staff");
    const actions = await provider.listActions?.(row.provider, context);
    for (const step of steps) {
      const action = actions?.find((action) => action.name === step.action);
      if (!action || (step.effect === "read") !== (action.readOnly === true))
        throw new Error("Workflow step effect does not match the connected action");
    }
  }
  async function commentWrites(actor: Caller, raw: unknown) {
    const input = InstagramSendListInput.parse(raw);
    const row = await connection(actor, input.connectionId);
    if (row.provider !== "instagram") throw new Error("Select an Instagram connection");
    const { provider, context } = await scope(actor, [row], "instagram.receipts", "staff");
    const account = await instagramAccount(provider, row.id, context);
    const current = await connection(actor, row.id);
    if (current.providerRef !== row.providerRef)
      throw new Error("The linked provider account changed");
    const rows = await prisma.instagramSend.findMany({
      where: {
        spaceId: actor.spaceId,
        bindingHash: instagramBindingHash(row.providerRef!),
        OR: [
          { accountHash: null },
          ...(account ? [{ accountHash: instagramAccountHash(account.id) }] : []),
        ],
        ...(input.cursor ? { id: { lt: input.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: 101,
      select: { id: true, action: true, targetId: true, externalId: true, createdAt: true },
    });
    return {
      items: rows
        .slice(0, 100)
        .map((write) => ({ ...write, status: write.externalId ? "confirmed" : "uncertain" })),
      nextCursor: rows.length > 100 ? rows[99]!.id : null,
    };
  }
  async function reconcileCommentWrite(actor: Caller, raw: unknown) {
    const input = InstagramSendReconcileInput.parse(raw);
    const row = await connection(actor, input.connectionId);
    if (row.provider !== "instagram") throw new Error("Select an Instagram connection");
    const receipt = await prisma.instagramSend.findFirst({
      where: {
        id: input.id,
        spaceId: actor.spaceId,
        bindingHash: instagramBindingHash(row.providerRef!),
      },
    });
    if (!receipt?.action) throw new Error("Instagram send is unavailable");
    const { provider, context } = await scope(actor, [row], "instagram.receipt", "staff");
    if (!provider.receipt) return { status: "uncertain" };
    const result = await provider.receipt(
      {
        connectionId: row.id,
        action: receipt.action,
        executionKey: receipt.executionKey,
        requestHash: receipt.requestHash,
      },
      context,
    );
    // Recheck access after the remote read before exposing its private result.
    const current = await connection(actor, row.id);
    if (current.providerRef !== row.providerRef)
      throw new Error("The linked provider account changed");
    return result;
  }
  return {
    commentWrites,
    reconcileCommentWrite,
    connection,
    execute,
    discover,
    resolveTool,
    executeTool,
    actionsAllowed,
    validateWorkflow,
  };
}
