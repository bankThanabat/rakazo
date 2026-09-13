import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ConnectorAuthMethod, ConnectorCredentialField } from "@rakazo/contracts";
import { ConnectorCredentialFieldSchema } from "@rakazo/contracts";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";
import { readBodyCapped } from "./web-ssrf.js";

const Field = ConnectorCredentialFieldSchema;
const Auth = z.object({
  type: z.string(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(z.unknown()).optional(),
  extraFields: z.array(z.unknown()).optional(),
  clientConfigFields: z.array(z.unknown()).optional(),
  clientSetup: z.object({ docsUrl: z.string().optional() }).optional(),
  authorizationOptions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string(),
        required: z.boolean(),
        defaultSelected: z.boolean(),
      }),
    )
    .optional(),
});
export const OpenConnectorAction = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  description: z.string(),
  requiredScopes: z.array(z.string()).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  execution: z
    .object({ locallyExecutable: z.boolean(), noAuthRunnable: z.boolean().optional() })
    .optional(),
});
export const OpenConnectorProvider = z.object({
  service: z.string().min(1),
  displayName: z.string(),
  description: z.string().optional(),
  iconUrl: z.string().nullable().optional(),
  homepageUrl: z.string().optional(),
  categories: z.array(z.string()).default([]),
  auth: z.array(Auth),
  actions: z.array(OpenConnectorAction),
});
export type OpenConnectorProvider = z.infer<typeof OpenConnectorProvider>;
export type OpenConnectorAction = z.infer<typeof OpenConnectorAction>;

export function authMethods(provider: OpenConnectorProvider): ConnectorAuthMethod[] {
  return provider.auth.flatMap((auth) => {
    if (!["no_auth", "api_key", "custom_credential", "oauth2"].includes(auth.type)) return [];
    const rawFields =
      auth.type === "custom_credential"
        ? (auth.fields ?? [])
        : auth.type === "api_key"
          ? (auth.extraFields ?? [])
          : [];
    const parsed = z.array(Field).safeParse(rawFields);
    if (
      !parsed.success ||
      (auth.type === "oauth2" && !z.array(Field).safeParse(auth.clientConfigFields ?? []).success)
    )
      return [];
    const fields: ConnectorCredentialField[] =
      auth.type === "api_key"
        ? [
            {
              key: "apiKey",
              label: auth.label ?? "API key",
              inputType: "password",
              required: true,
              secret: true,
              placeholder: auth.placeholder,
              description: auth.description,
            },
            ...parsed.data,
          ]
        : parsed.data;
    return [
      {
        type: auth.type as ConnectorAuthMethod["type"],
        fields,
        authorizationOptions: auth.authorizationOptions,
      },
    ];
  });
}

export class OpenConnectorNotFound extends Error {}

export class OpenConnectorHttp {
  private cached?: { providers: OpenConnectorProvider[]; etag: string | null; until: number };
  private loading?: Promise<OpenConnectorProvider[]>;
  constructor(
    readonly config: { endpoint: string; apiKey: string },
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}
  async request(
    path: string,
    context: AdapterContext,
    init: RequestInit = {},
    token = this.config.apiKey,
  ): Promise<unknown> {
    const response = await this.fetch(path, context, init, token);
    if (response.status === 404 && init.method === "DELETE") return {};
    if (response.status === 404) throw new OpenConnectorNotFound("Connection is unavailable");
    if (!response.ok)
      throw new Error(
        "OpenConnector could not complete the request. Check the connection and try again.",
      );
    const value = await this.read(response, context);
    if (path.startsWith("/v1/") && !path.startsWith("/v1/actions/"))
      return z.object({ success: z.literal(true), data: z.unknown() }).parse(value).data;
    return value;
  }
  private async fetch(path: string, context: AdapterContext, init: RequestInit, token: string) {
    try {
      return await this.fetcher(`${this.config.endpoint.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: combineSignals(context.signal, AbortSignal.timeout(30000)),
      });
    } catch {
      throw new Error("Could not reach OpenConnector");
    }
  }
  private async read(response: Response, context: AdapterContext) {
    try {
      return JSON.parse(
        new TextDecoder().decode(await readBodyCapped(response, 32 * 1024 * 1024, context.signal)),
      );
    } catch {
      throw new Error("OpenConnector returned an invalid response");
    }
  }
  async catalog(context: AdapterContext) {
    if (this.cached && this.cached.until > Date.now()) return this.cached.providers;
    if (!this.loading)
      this.loading = this.load(context).finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }
  private async load(context: AdapterContext) {
    const response = await this.fetch(
      "/api/providers",
      context,
      { headers: this.cached?.etag ? { "if-none-match": this.cached.etag } : {} },
      this.config.apiKey,
    );
    if (response.status === 304 && this.cached) {
      this.cached.until = Date.now() + 30000;
      return this.cached.providers;
    }
    if (!response.ok) throw new Error("Could not load the OpenConnector catalog");
    const providers = z.array(OpenConnectorProvider).parse(await this.read(response, context));
    this.cached = { providers, etag: response.headers.get("etag"), until: Date.now() + 30000 };
    return providers;
  }
  cachedProvider(service: string) {
    return this.cached?.providers.find((provider) => provider.service === service);
  }
  async provider(service: string, context: AdapterContext) {
    const provider = (await this.catalog(context)).find((item) => item.service === service);
    if (!provider) throw new Error("This app is not in the OpenConnector catalog");
    return provider;
  }
  async action(id: string, service: string, context: AdapterContext) {
    const provider = await this.provider(service, context);
    const summary = provider.actions.find(
      (action) => action.id === id && action.service === service,
    );
    if (!summary?.execution?.locallyExecutable) throw new Error("This action is unavailable");
    const action = OpenConnectorAction.parse(
      summary.inputSchema
        ? summary
        : await this.request(`/api/actions/${encodeURIComponent(id)}`, context),
    );
    if (action.id !== id || action.service !== service || !action.inputSchema)
      throw new Error("Invalid action schema");
    return action;
  }
}
