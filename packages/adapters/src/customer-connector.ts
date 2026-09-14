import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { connectionAccessWhere, IsolationError } from "@rakazo/db";
import type { IntegrationProviderSettings } from "./integration-provider-settings.js";

export function createCustomerConnector(deps: {
  prisma: PrismaClient;
  integrations: IntegrationProviderSettings;
}) {
  const { prisma } = deps;
  async function connection(actor: Pick<Actor, "userId" | "spaceId">, id: string) {
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
        connectorId: "open-connector",
        status: "connected",
      },
    });
    if (!row?.providerRef) throw new Error("Connect and authorize the messaging account first");
    return row;
  }

  async function execute(
    actor: Pick<Actor, "userId" | "spaceId">,
    connectionId: string,
    tool: string,
    args: Record<string, unknown>,
    executionId: string,
  ) {
    const row = await connection(actor, connectionId);
    const context: AdapterContext = {
      ...actor,
      operationId: executionId,
      traceId: executionId,
      signal: AbortSignal.timeout(20_000),
      connectedConnections: [
        {
          id: row.id,
          connectorId: row.connectorId,
          externalId: row.provider,
          displayName: row.displayName,
          providerRef: row.providerRef!,
        },
      ],
    };
    const provider = await deps.integrations.resolve("open-connector");
    if (!provider) throw new Error("Messaging integration is unavailable");
    let data: unknown;
    let completed = false;
    for await (const event of provider.execute(
      {
        tool,
        executionId,
        connectionId: row.id,
        route: { connectorId: row.connectorId, resourceId: row.id, toolName: tool },
        args,
      },
      context,
    )) {
      if (event.type === "error") throw new Error("Messaging action failed");
      if (event.type === "result") {
        data = event.data;
        completed = true;
      }
    }
    if (!completed) throw new Error("Messaging action did not confirm completion");
    return data;
  }

  return { connection, execute };
}
