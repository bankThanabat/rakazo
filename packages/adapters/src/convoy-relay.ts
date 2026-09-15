import type { GatewayServerConfig, WebhookVerification } from "@rakazo/contracts";
import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

const resource = z.object({ uid: z.string(), name: z.string(), url: z.string().optional() });
/** Idempotent provisioning by a stable, opaque route name, including recovery
 * after the provider committed a create whose HTTP response was lost. */
export class ConvoyRelay {
  constructor(
    private readonly config: GatewayServerConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, method = "GET", body?: unknown) {
    const response = await this.fetcher(
      `${this.config.endpoint.replace(/\/$/, "")}/api/v1/projects/${encodeURIComponent(this.config.projectId)}${path}`,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (method === "DELETE" && (response.ok || response.status === 404)) return null;
    if (!response.ok) throw new Error("Webhook relay is unavailable");
    return z
      .object({ data: z.unknown() })
      .parse(JSON.parse(new TextDecoder().decode(await readBodyCapped(response, 2 * 1024 * 1024))))
      .data;
  }
  async verify() {
    const project = z.object({ type: z.literal("incoming") }).parse(await this.request(""));
    return project;
  }
  private async find(collection: string, name: string) {
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const data = z
        .object({
          content: z.array(resource),
          pagination: z.object({
            has_next_page: z.boolean(),
            next_page_cursor: z.string().optional(),
          }),
        })
        .parse(
          await this.request(
            `/${collection}?perPage=100${cursor ? `&next_page_cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        );
      const existing = data.content.find((row) => row.name === name);
      if (existing) return existing;
      if (!data.pagination.has_next_page) return null;
      if (!data.pagination.next_page_cursor || cursor === data.pagination.next_page_cursor) break;
      cursor = data.pagination.next_page_cursor;
    }
    throw new Error("Webhook relay pagination did not complete");
  }
  private async ensure(collection: string, name: string, fields: Record<string, unknown>) {
    return (
      (await this.find(collection, name)) ??
      resource.parse(await this.request(`/${collection}`, "POST", { name, ...fields }))
    );
  }
  async remove(id: string) {
    for (const collection of ["subscriptions", "endpoints", "sources"]) {
      const row = await this.find(collection, `rakazo-${id}`);
      if (row) await this.request(`/${collection}/${encodeURIComponent(row.uid)}`, "DELETE");
    }
  }
  /** Convoy decodes the signature header directly, so it can enforce plain HMAC or
   * static-token verification but not prefixed or timestamped signatures. */
  async provision(
    id: string,
    verification: WebhookVerification,
    secret: string,
    deliveryToken: string,
  ) {
    if (verification.prefix || verification.timestamp)
      throw new Error("Webhook relay cannot verify this app's signature format");
    const name = `rakazo-${id}`;
    const source = await this.ensure("sources", name, {
      type: "http",
      verifier:
        verification.algorithm === "token"
          ? {
              type: "api_key",
              api_key: { header_name: verification.header, header_value: secret },
            }
          : {
              type: "hmac",
              hmac: {
                hash: verification.algorithm.toUpperCase(),
                encoding: verification.encoding,
                header: verification.header,
                secret,
              },
            },
    });
    const endpoint = await this.ensure("endpoints", name, {
      url: new URL(`/api/integration-gateway/deliver/${id}`, this.config.callbackOrigin).href,
      http_timeout: 10,
      authentication: {
        type: "api_key",
        api_key: { header_name: "Authorization", header_value: `Bearer ${deliveryToken}` },
      },
    });
    const subscription = await this.ensure("subscriptions", name, {
      source_id: source.uid,
      endpoint_id: endpoint.uid,
    });
    if (!source.url) throw new Error("Webhook relay did not return an ingestion URL");
    return {
      sourceId: source.uid,
      endpointId: endpoint.uid,
      subscriptionId: subscription.uid,
      webhookUrl: source.url,
    };
  }
}
