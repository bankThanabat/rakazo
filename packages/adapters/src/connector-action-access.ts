import type { AdapterContext, ConnectorRoute } from "@rakazo/adapter-kit";

export function connectorActionAllowed(
  context: AdapterContext,
  connectionId: string,
  action: string,
) {
  return (
    context.actionAccess === undefined ||
    (Object.hasOwn(context.actionAccess, connectionId) &&
      context.actionAccess[connectionId]!.includes(action))
  );
}

export function assertConnectorActionAllowed(context: AdapterContext, route: ConnectorRoute) {
  if (!route.resourceId || !connectorActionAllowed(context, route.resourceId, route.toolName))
    throw new Error("Connector action is unavailable");
}
