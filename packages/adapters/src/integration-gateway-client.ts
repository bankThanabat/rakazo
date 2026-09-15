import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import type {
  ConnectorAuthInput,
  ConnectorSetup,
  GatewayCommand,
  GatewayDelivery,
  IncomingSetupResultSchema,
  WebhookVerification,
} from "@rakazo/contracts";
import { GatewayCommandSchema, GatewayDeliverySchema } from "@rakazo/contracts";
import { z } from "zod";
import { readBoundedText } from "./connector-http.js";

/** The only credential held by a customer runtime is its revocable gateway capability. */
export class IntegrationGatewayClient implements ManagedConnectorProvider {
  constructor(
    private readonly config: { endpoint: string; apiKey: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  describe() {
    return {
      id: "open-connector",
      contractVersion: "1",
      adapterVersion: "0.3.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  private connections(context: AdapterContext) {
    return (context.connectedConnections ?? [])
      .filter((row) => row.connectorId === "open-connector" && row.providerRef)
      .map((row) => ({
        ...row,
        connectorId: "open-connector" as const,
        providerRef: row.providerRef!,
      }));
  }
  async request<T>(command: GatewayCommand, signal: AbortSignal): Promise<T> {
    const response = await this.fetcher(
      `${this.config.endpoint.replace(/\/$/, "")}/api/integration-gateway`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(GatewayCommandSchema.parse(command)),
      },
    );
    if (!response.ok) throw new Error("Integration gateway could not complete the request");
    const body = await readBoundedText(response, 32 * 1024 * 1024);
    if (body.truncated) throw new Error("Gateway response is too large");
    const data = JSON.parse(body.text) as { data: T };
    return data.data;
  }
  catalog(
    context: AdapterContext,
    query?: string,
  ): ReturnType<ManagedConnectorProvider["catalog"]> {
    return this.request({ op: "catalog", query }, context.signal);
  }
  setup(provider: string, context: AdapterContext): Promise<ConnectorSetup> {
    return this.request({ op: "setup", provider }, context.signal);
  }
  listActions(
    provider: string,
    context: AdapterContext,
  ): Promise<Array<{ name: string; description: string }>> {
    return this.request({ op: "listActions", provider }, context.signal);
  }
  begin(
    request: Parameters<ManagedConnectorProvider["begin"]>[0],
    context: AdapterContext,
  ): ReturnType<ManagedConnectorProvider["begin"]> {
    return this.request(
      {
        op: "begin",
        provider: request.provider,
        auth: request.auth,
        credential: request.credential,
      },
      context.signal,
    );
  }
  async complete(request: { state: string }, context: AdapterContext) {
    const result = await this.pollConnection(request.state, context);
    if (!result) throw new Error("Authorization is pending");
    return result;
  }
  pollConnection(ref: string, context: AdapterContext): Promise<{ connectionRef: string } | null> {
    return this.request({ op: "poll", ref }, context.signal);
  }
  connectionStatus(
    ref: string,
    context: AdapterContext,
  ): Promise<{ authorizationUrl?: string; reconnectRequired?: boolean }> {
    return this.request({ op: "status", ref }, context.signal);
  }
  reconnect(
    ref: string,
    auth: ConnectorAuthInput,
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null }> {
    return this.request({ op: "reconnect", ref, auth }, context.signal);
  }
  cancelAuthorization(ref: string, context: AdapterContext): Promise<{ connected: boolean }> {
    return this.request({ op: "cancel", ref }, context.signal);
  }
  async revoke(ref: string, context: AdapterContext) {
    await this.request({ op: "revoke", ref }, context.signal);
  }
  async listConnectedExternalIds(context: AdapterContext) {
    return [...new Set(this.connections(context).map((row) => row.externalId))];
  }
  async connectionReady() {
    return false;
  }
  discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    return this.request({ op: "discover", connections: this.connections(context) }, context.signal);
  }
  resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): ReturnType<NonNullable<ManagedConnectorProvider["resolveCall"]>> {
    return this.request(
      {
        op: "resolve",
        call: call as Extract<GatewayCommand, { op: "resolve" }>["call"],
        connections: this.connections(context),
      },
      context.signal,
    );
  }
  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const events = await this.request<ConnectorEvent[]>(
      {
        op: "execute",
        call: call as Extract<GatewayCommand, { op: "execute" }>["call"],
        connections: this.connections(context),
      },
      context.signal,
    );
    yield* events;
  }
  incoming(
    ref: string,
    channelId: string,
    webhook: { webhookSecret: string; verification: WebhookVerification },
    context: AdapterContext,
  ): Promise<z.infer<typeof IncomingSetupResultSchema>> {
    return this.request({ op: "incoming", ref, channelId, ...webhook }, context.signal);
  }
  async deliveries(signal: AbortSignal): Promise<GatewayDelivery[]> {
    return z
      .array(GatewayDeliverySchema)
      .max(20)
      .parse(await this.request({ op: "deliveries" }, signal));
  }
  async acknowledge(id: string, signal: AbortSignal) {
    await this.request({ op: "ack", id }, signal);
  }
}
