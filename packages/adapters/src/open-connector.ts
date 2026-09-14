import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import type { ConnectorAuthInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { redactConnectorPayload } from "./connector-safety.js";
import {
  CATALOG_EXECUTE,
  CATALOG_LOAD,
  CATALOG_SEARCH,
  catalogEntries,
  lazyCatalogTools,
  loadCatalogEntry,
  parseConnectorToolArgs,
  searchCatalog,
} from "./lazy-tool-catalog.js";
import { needsAuthorization, OpenConnectorAccounts } from "./open-connector-accounts.js";
import { authMethods, OpenConnectorHttp } from "./open-connector-catalog.js";
import { OpenConnectorIcons } from "./open-connector-icons.js";
import type { EncryptedSecretStore } from "./secrets.js";

/** Catalog-driven accounts and actions; provider translation belongs to OpenConnector. */
export class OpenConnector implements ManagedConnectorProvider {
  private readonly http: OpenConnectorHttp;
  private readonly accounts: OpenConnectorAccounts;
  private readonly icons: OpenConnectorIcons;
  constructor(
    private readonly config: { endpoint: string; apiKey: string; identitySecret: string },
    deps: {
      prisma: Pick<PrismaClient, "secret">;
      secrets: EncryptedSecretStore;
      fetch?: typeof fetch;
    },
  ) {
    this.http = new OpenConnectorHttp(config, deps.fetch);
    this.icons = new OpenConnectorIcons(deps.fetch);
    this.accounts = new OpenConnectorAccounts(this.http, {
      ...deps,
      identitySecret: config.identitySecret,
    });
  }
  describe() {
    return {
      id: "open-connector",
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const needle = query?.trim().toLowerCase();
    const [providers] = await Promise.all([this.http.catalog(context), this.icons.refresh()]);
    return providers
      .filter(
        (provider) =>
          !needle ||
          `${provider.displayName} ${provider.description ?? ""} ${provider.categories.join(" ")}`
            .toLowerCase()
            .includes(needle),
      )
      .map((provider) => ({
        connectorId: "open-connector",
        slug: provider.service,
        name: provider.displayName,
        description: provider.description,
        categories: provider.categories,
        logo: this.icons.resolve(provider),
        connected: false,
        noAuth: authMethods(provider).some((auth) => auth.type === "no_auth"),
        scope: "team",
        actionCount: provider.actions.length,
        availability:
          authMethods(provider).length &&
          provider.actions.some((action) => action.execution?.locallyExecutable)
            ? "available"
            : "unavailable",
      }));
  }
  async setup(provider: string, context: AdapterContext) {
    return this.accounts.setup(provider, context);
  }
  async configureOAuth(provider: string, values: Record<string, string>, context: AdapterContext) {
    await this.accounts.configureOAuth(provider, values, context);
  }
  async begin(request: Parameters<ManagedConnectorProvider["begin"]>[0], context: AdapterContext) {
    return this.accounts.begin(request.provider, request.auth, request.credential, context);
  }
  async complete(
    request: Parameters<ManagedConnectorProvider["complete"]>[0],
    context: AdapterContext,
  ) {
    const result = await this.accounts.poll(request.state, context);
    if (!result) throw new Error("Authorization is pending");
    return result;
  }
  async pollConnection(state: string, context: AdapterContext) {
    return this.accounts.poll(state, context);
  }
  async connectionReady(_context: AdapterContext, _externalId: string) {
    return false;
  }
  async listConnectedExternalIds(context: AdapterContext) {
    return [...new Set(this.connections(context).map((connection) => connection.externalId))];
  }
  connectionStatus(ref: string, context: AdapterContext) {
    return this.accounts.connectionStatus(ref, context);
  }
  async cancelAuthorization(ref: string, context: AdapterContext) {
    return this.accounts.cancelAuthorization(ref, context);
  }
  async reconnect(ref: string, auth: ConnectorAuthInput, context: AdapterContext) {
    return this.accounts.reconnect(ref, auth, context);
  }
  async revoke(ref: string, context: AdapterContext) {
    await this.accounts.revoke(ref, context);
  }
  private connections(context: AdapterContext) {
    return (context.connectedConnections ?? []).filter(
      (connection) =>
        connection.connectorId === "open-connector" &&
        connection.providerRef &&
        this.accounts.owns(connection.providerRef, context),
    );
  }
  private async entries(context: AdapterContext) {
    const providers = await this.http.catalog(context);
    return catalogEntries(
      this.connections(context).flatMap((connection) => {
        const provider = providers.find((item) => item.service === connection.externalId);
        return (provider?.actions ?? [])
          .filter(
            (action) =>
              action.service === connection.externalId && action.execution?.locallyExecutable,
          )
          .map((action) => ({
            name: `oc_${createHash("sha256").update(`${connection.id}:${action.id}`).digest("hex").slice(0, 32)}`,
            description: `${action.description} Account: ${connection.displayName}`,
            inputSchema: {},
            readOnly: false,
            route: {
              connectorId: "open-connector",
              toolName: action.id,
              resourceId: connection.id,
              catalogGroup: connection.displayName,
            },
          }));
      }),
    );
  }
  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!this.connections(context).length) return [];
    return lazyCatalogTools(
      "openconnector",
      "open-connector",
      "OpenConnector",
      await this.entries(context),
    );
  }
  async listActions(provider: string, context: AdapterContext) {
    return (await this.http.provider(provider, context)).actions.map((action) => ({
      name: action.id,
      description: action.description,
    }));
  }
  private async resolved(call: ConnectorCall, context: AdapterContext) {
    const connection = this.connections(context).find(
      (item) =>
        item.id === call.route?.resourceId && (!call.connectionId || item.id === call.connectionId),
    );
    if (!connection || call.route?.connectorId !== "open-connector")
      throw new Error("OpenConnector connection is not authorized");
    const action = await this.http.action(call.route.toolName, connection.externalId, context);
    const inputSchema = action.inputSchema!;
    const resourceRevision = createHash("sha256").update(JSON.stringify(inputSchema)).digest("hex");
    if (call.route.resourceRevision && call.route.resourceRevision !== resourceRevision)
      throw new Error("The action schema changed. Review the action again.");
    const route = { ...call.route, resourceRevision };
    const tool: ConnectorTool = {
      name: call.tool,
      description: action.description,
      inputSchema,
      readOnly: false,
      route,
    };
    return {
      connection,
      action,
      tool,
      call: { ...call, route, args: parseConnectorToolArgs(inputSchema, call.args) },
    };
  }
  async resolveCall(call: ConnectorCall, context: AdapterContext) {
    if (call.route?.toolName === CATALOG_EXECUTE && !call.route.resourceId) {
      const entry = loadCatalogEntry(await this.entries(context), call.args);
      const args = call.args.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Tool arguments must be an object");
      return this.resolved(
        {
          ...call,
          tool: entry.tool.name,
          route: entry.tool.route,
          args: args as Record<string, unknown>,
        },
        context,
      );
    }
    if (call.route?.resourceId) return this.resolved(call, context);
    return undefined;
  }
  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    try {
      if (!call.route?.resourceId) {
        const entries = await this.entries(context);
        if (call.route?.toolName === CATALOG_SEARCH) {
          yield { type: "result", data: searchCatalog(entries, call.args) };
          return;
        }
        if (call.route?.toolName === CATALOG_LOAD) {
          const entry = loadCatalogEntry(entries, call.args);
          const connection = this.connections(context).find(
            (item) => item.id === entry.tool.route?.resourceId,
          )!;
          const action = await this.http.action(
            entry.tool.route!.toolName,
            connection.externalId,
            context,
          );
          yield {
            type: "result",
            data: {
              id: call.args.id,
              name: entry.tool.name,
              description: action.description,
              inputSchema: action.inputSchema,
              outputSchema: action.outputSchema,
              readOnly: false,
            },
          };
          return;
        }
        throw new Error("Resolve the selected action before execution");
      }
      const resolved = await this.resolved(call, context);
      const ref = resolved.connection.providerRef!;
      const grant = await this.accounts.load(ref, context);
      if (
        !grant?.token ||
        !grant.accountId ||
        grant.requestId ||
        (grant.service && grant.service !== resolved.connection.externalId)
      )
        throw new Error("Connection is unavailable");
      if (needsAuthorization(grant, resolved.action))
        throw new Error("Reconnect this account to authorize the required permissions.");
      const current = await this.accounts.grant(
        ref,
        grant,
        await this.http.provider(resolved.connection.externalId, context),
        context,
        false,
      );
      const response = z.object({ success: z.literal(true), data: z.unknown() }).parse(
        await this.http.request(
          `/v1/actions/${encodeURIComponent(resolved.call.route!.toolName)}`,
          context,
          {
            method: "POST",
            headers: {
              "x-oo-connector-alias": current.alias ?? ref,
              "Idempotency-Key": resolved.call.executionId,
            },
            body: JSON.stringify({ input: resolved.call.args }),
          },
          current.token,
        ),
      );
      yield {
        type: "result",
        data: redactConnectorPayload(response.data, [this.config.apiKey, current.token!]),
      };
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "OpenConnector action failed",
      };
    }
  }
}
