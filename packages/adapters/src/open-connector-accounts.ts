import { createHmac, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ConnectorAuthInput, ConnectorSetup } from "@rakazo/contracts";
import { ConnectorCredentialFieldSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import type {
  OpenConnectorAction,
  OpenConnectorHttp,
  OpenConnectorProvider,
} from "./open-connector-catalog.js";
import { authMethods, OpenConnectorNotFound } from "./open-connector-catalog.js";
import type { EncryptedSecretStore } from "./secrets.js";

const Grant = z.object({
  token: z.string().optional(),
  tokenId: z.string().optional(),
  accountId: z.string().optional(),
  service: z.string().optional(),
  alias: z.string().optional(),
  requestId: z.string().optional(),
  authorizationUrl: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
  authType: z.string().optional(),
  actions: z.array(z.string()).optional(),
});
export type OpenConnectorGrant = z.infer<typeof Grant>;
export function needsAuthorization(grant: OpenConnectorGrant, action: OpenConnectorAction) {
  return (
    grant.authType === "oauth2" &&
    (action.requiredScopes ?? []).some((scope) => !grant.scopes?.includes(scope))
  );
}

const Account = z.object({
  id: z.string(),
  service: z.string(),
  alias: z.string(),
  status: z.string(),
  scopes: z.array(z.string()).default([]),
});
export class OpenConnectorAccounts {
  constructor(
    private readonly http: OpenConnectorHttp,
    private readonly deps: {
      prisma: Pick<PrismaClient, "secret">;
      secrets: EncryptedSecretStore;
      identitySecret: string;
    },
  ) {}
  private prefix(context: AdapterContext) {
    return `rkz_${createHmac("sha256", this.deps.identitySecret)
      .update(JSON.stringify([context.spaceId]))
      .digest("hex")
      .slice(0, 24)}_`;
  }
  owns(ref: string, context: AdapterContext) {
    const prefix = this.prefix(context);
    return ref.startsWith(prefix) && /^[a-f0-9]{32}$/.test(ref.slice(prefix.length));
  }
  private assert(ref: string, context: AdapterContext) {
    if (!this.owns(ref, context)) throw new Error("OpenConnector connection is not authorized");
  }
  async load(ref: string, context: AdapterContext) {
    this.assert(ref, context);
    const row = await this.deps.prisma.secret.findFirst({
      where: { id: ref, spaceId: context.spaceId, kind: "open-connector" },
    });
    return row ? Grant.parse(JSON.parse(this.deps.secrets.load(row.ciphertext, ref))) : undefined;
  }
  private async save(
    ref: string,
    grant: OpenConnectorGrant,
    context: AdapterContext,
    create = false,
  ) {
    const record = await this.deps.secrets.put(JSON.stringify(grant), context, ref);
    if (create)
      await this.deps.prisma.secret.create({
        data: {
          ...record,
          spaceId: context.spaceId,
          userId: context.userId,
          kind: "open-connector",
        },
      });
    else {
      const updated = await this.deps.prisma.secret.updateMany({
        where: { id: ref, spaceId: context.spaceId, kind: "open-connector" },
        data: { ciphertext: record.ciphertext },
      });
      if (!updated.count) throw new Error("Connection was removed");
    }
  }
  async setup(service: string, context: AdapterContext): Promise<ConnectorSetup> {
    const provider = await this.http.provider(service, context);
    const oauth = provider.auth.find((auth) => auth.type === "oauth2");
    let oauthConfigured = false;
    let oauthCallbackUrl: string | undefined;
    if (oauth) {
      const configs = z
        .array(
          z.object({
            service: z.string(),
            configured: z.boolean().optional(),
            expectedRedirectUri: z.string().optional(),
          }),
        )
        .parse(await this.http.request("/api/oauth/configs", context));
      const config = configs.find((item) => item.service === service);
      oauthConfigured = Boolean(config?.configured);
      oauthCallbackUrl = config?.expectedRedirectUri;
    }
    const fields = oauth?.clientConfigFields
      ? z.array(ConnectorCredentialFieldSchema).safeParse(oauth.clientConfigFields)
      : undefined;
    return {
      methods: authMethods(provider),
      oauthConfigured,
      oauthFields: fields?.success ? fields.data : [],
      oauthSetupUrl: oauth?.clientSetup?.docsUrl,
      oauthCallbackUrl,
    };
  }
  async configureOAuth(service: string, values: Record<string, string>, context: AdapterContext) {
    const provider = await this.http.provider(service, context);
    const oauth = provider.auth.find((auth) => auth.type === "oauth2");
    if (!oauth) throw new Error("This app does not support OAuth");
    const fields = z
      .array(ConnectorCredentialFieldSchema.extend({ location: z.string().optional() }))
      .parse(oauth.clientConfigFields ?? []);
    const extra: Record<string, string> = {};
    const secretExtra: Record<string, string> = {};
    for (const field of fields) {
      if (field.required && !values[field.key]?.trim()) throw new Error(`Enter ${field.label}`);
    }
    for (const field of fields)
      if (values[field.key] !== undefined)
        (field.secret || field.location === "secretExtra" ? secretExtra : extra)[field.key] =
          values[field.key]!;
    await this.http.request(`/api/oauth/configs/${encodeURIComponent(service)}`, context, {
      method: "PUT",
      body: JSON.stringify({
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        extra,
        secretExtra,
      }),
    });
  }
  async begin(
    service: string,
    auth: ConnectorAuthInput | undefined,
    credential: string | undefined,
    context: AdapterContext,
  ) {
    const provider = await this.http.provider(service, context);
    const selected =
      auth ??
      (credential
        ? { type: "api_key" as const, values: { apiKey: credential } }
        : authMethods(provider).length === 1 && authMethods(provider)[0]?.type === "no_auth"
          ? { type: "no_auth" as const, values: {} }
          : undefined);
    if (!selected) throw new Error("Choose an authentication method and enter its credentials");
    this.validate(provider, selected);
    const ref = `${this.prefix(context)}${randomUUID().replaceAll("-", "")}`;
    try {
      await this.save(ref, { service, alias: ref, authType: selected.type }, context, true);
      const authorizationUrl = await this.connect(ref, provider, selected, context);
      return { state: ref, scope: "team" as const, authorizationUrl };
    } catch {
      await this.revoke(ref, { ...context, signal: AbortSignal.timeout(10000) }).catch(
        () => undefined,
      );
      throw new Error("Could not connect this account. Check its setup and credentials.");
    }
  }
  private validate(provider: OpenConnectorProvider, auth: ConnectorAuthInput) {
    const method = authMethods(provider).find((item) => item.type === auth.type);
    if (!method) throw new Error("Authentication method is unsupported");
    const allowed = new Set(method.fields.map((field) => field.key));
    if (Object.keys(auth.values).some((key) => !allowed.has(key)))
      throw new Error("Unknown credential field");
    for (const field of method.fields) {
      const value = auth.values[field.key];
      if (field.required && !value?.trim()) throw new Error(`Enter ${field.label}`);
      if (field.inputType === "json" && value) {
        try {
          JSON.parse(value);
        } catch {
          throw new Error(`Enter valid JSON for ${field.label}`);
        }
      }
    }
  }
  async reconnect(ref: string, auth: ConnectorAuthInput, context: AdapterContext) {
    let grant = await this.load(ref, context);
    if (grant?.requestId) {
      const request = await this.requestStatus(ref, grant.requestId, context);
      if (request.status === "connected") {
        const completed = await this.poll(ref, context);
        if (!completed) throw new Error("Authorization is still being processed. Try again.");
        return { authorizationUrl: null };
      }
      if (request.status === "initiated") {
        if (grant.authorizationUrl) return { authorizationUrl: grant.authorizationUrl };
        throw new Error("Check or cancel the pending authorization before reconnecting.");
      }
      // Fence an expired attempt before replacing it, including an in-flight callback.
      await this.http.request(
        `/v1/connection-requests/${encodeURIComponent(grant.requestId)}`,
        context,
        { method: "DELETE", headers: { "x-oo-connection-scope": ref } },
      );
      grant = { ...grant, requestId: undefined, authorizationUrl: undefined };
      await this.save(ref, grant, context);
    }
    if (!grant) throw new Error("Connection is unavailable");
    const account =
      grant.accountId && grant.authType !== "no_auth"
        ? Account.parse(
            await this.http.request(
              `/v1/connections/by-id/${encodeURIComponent(grant.accountId)}`,
              context,
            ),
          )
        : undefined;
    const service = grant.service ?? account?.service;
    if (!service) throw new Error("Connection is unavailable");
    const provider = await this.http.provider(service, context);
    this.validate(provider, auth);
    if (grant.authType && grant.authType !== auth.type)
      throw new Error("Reconnect using the original authentication method");
    return { authorizationUrl: await this.connect(ref, provider, auth, context) };
  }
  private async connect(
    ref: string,
    provider: OpenConnectorProvider,
    auth: ConnectorAuthInput,
    context: AdapterContext,
  ) {
    const grant = await this.load(ref, context);
    if (!grant) throw new Error("Connection is unavailable");
    if (auth.type === "oauth2") {
      const capabilities = z
        .object({ scopedRequests: z.literal(true), cancelRequests: z.literal(true) })
        .parse(await this.http.request("/v1/connection-capabilities", context));
      if (!capabilities) throw new Error("OpenConnector needs scoped OAuth support");
      const path = grant.accountId
        ? `/v1/connections/by-id/${encodeURIComponent(grant.accountId)}/connect`
        : `/v1/connections/${encodeURIComponent(provider.service)}/connect`;
      const pending = z
        .object({ connectionRequestId: z.string(), authorizationUrl: z.string().url() })
        .parse(
          await this.http.request(path, context, {
            method: "POST",
            headers: { "x-oo-connection-scope": ref },
            body: JSON.stringify({ authorizationOptionIds: auth.authorizationOptionIds }),
          }),
        );
      try {
        await this.save(
          ref,
          {
            ...grant,
            requestId: pending.connectionRequestId,
            authorizationUrl: pending.authorizationUrl,
            authType: auth.type,
            service: provider.service,
          },
          context,
        );
      } catch (error) {
        await this.http.request(
          `/v1/connection-requests/${encodeURIComponent(pending.connectionRequestId)}`,
          context,
          { method: "DELETE", headers: { "x-oo-connection-scope": ref } },
        );
        throw error;
      }
      return pending.authorizationUrl;
    }
    const raw = z
      .object({
        id: z.string(),
        service: z.string(),
        connectionName: z.string(),
        configured: z.boolean(),
      })
      .parse(
        await this.http.request(
          `/api/connections/${encodeURIComponent(provider.service)}`,
          context,
          {
            method: "PUT",
            body: JSON.stringify({
              authType: auth.type,
              connectionName: grant.alias ?? ref,
              values: auth.values,
            }),
          },
        ),
      );
    if (
      raw.service !== provider.service ||
      raw.connectionName !== (grant.alias ?? ref) ||
      !raw.configured
    )
      throw new Error("Connection does not match its request");
    await this.grant(
      ref,
      {
        ...grant,
        service: provider.service,
        alias: raw.connectionName,
        accountId: raw.id,
        authType: auth.type,
      },
      provider,
      context,
    );
    return null;
  }
  private async requestStatus(ref: string, requestId: string, context: AdapterContext) {
    return z
      .object({ status: z.string(), appId: z.string().nullable(), service: z.string() })
      .parse(
        await this.http.request(
          `/v1/connection-requests/${encodeURIComponent(requestId)}`,
          context,
          { headers: { "x-oo-connection-scope": ref } },
        ),
      );
  }
  async connectionStatus(ref: string, context: AdapterContext) {
    const grant = await this.load(ref, context);
    // Listing local accounts must not wait for an optional connector service.
    const provider = grant?.service ? this.http.cachedProvider(grant.service) : undefined;
    return {
      authorizationUrl: grant?.requestId ? grant.authorizationUrl : undefined,
      reconnectRequired:
        Boolean(grant?.accountId) &&
        grant?.authType === "oauth2" &&
        Boolean(
          provider?.actions.some(
            (action) => action.execution?.locallyExecutable && needsAuthorization(grant, action),
          ),
        ),
    };
  }
  async poll(ref: string, context: AdapterContext) {
    let grant = await this.load(ref, context);
    if (!grant) throw new Error("Connection is unavailable");
    if (grant.requestId) {
      const request = await this.requestStatus(ref, grant.requestId, context);
      if (request.service !== grant.service)
        throw new Error("Authorization does not match the connection");
      if (request.status === "initiated") return null;
      if (request.status !== "connected" || !request.appId)
        throw new Error("Authorization expired or was denied. Try again.");
      grant = { ...grant, accountId: request.appId };
    }
    if (!grant.accountId) return null;
    if (grant.authType === "no_auth") return { connectionRef: ref };
    const account = Account.parse(
      await this.http.request(
        `/v1/connections/by-id/${encodeURIComponent(grant.accountId)}`,
        context,
      ),
    );
    if (account.status !== "active") return null;
    if (grant.service && account.service !== grant.service)
      throw new Error("Connection provider mismatch");
    if (!grant.requestId && account.alias !== (grant.alias ?? ref))
      throw new Error("Connection alias mismatch");
    await this.grant(
      ref,
      {
        ...grant,
        service: account.service,
        alias: account.alias,
        scopes: account.scopes,
        requestId: undefined,
        authorizationUrl: undefined,
      },
      await this.http.provider(account.service, context),
      context,
    );
    return { connectionRef: ref };
  }
  async grant(
    ref: string,
    grant: OpenConnectorGrant,
    provider: OpenConnectorProvider,
    context: AdapterContext,
    persist = true,
  ) {
    const actions = provider.actions
      .filter(
        (action) =>
          action.service === provider.service &&
          action.execution?.locallyExecutable &&
          (grant.authType !== "no_auth" || action.execution.noAuthRunnable) &&
          !needsAuthorization(grant, action),
      )
      .map((action) => action.id)
      .sort();
    if (!grant.accountId || (!actions.length && grant.authType !== "oauth2"))
      throw new Error("This account has no available actions");
    const policy = {
      allowedActions: actions.length > 128 ? [`${provider.service}.*`] : actions,
      blockedActions: actions.length ? [] : ["*"],
      allowedProxies: [],
      allowedConnections: grant.accountId ? [grant.accountId] : [],
    };
    if (grant.tokenId) {
      if (JSON.stringify(actions) !== JSON.stringify(grant.actions))
        await this.http.request(
          `/api/runtime-tokens/${encodeURIComponent(grant.tokenId)}`,
          context,
          { method: "PUT", body: JSON.stringify(policy) },
        );
    } else {
      const created = z.object({ token: z.string(), record: z.object({ id: z.string() }) }).parse(
        await this.http.request("/api/runtime-tokens", context, {
          method: "POST",
          body: JSON.stringify({ ...policy, name: ref }),
        }),
      );
      grant = { ...grant, token: created.token, tokenId: created.record.id };
      try {
        await this.save(ref, { ...grant, actions }, context);
        return { ...grant, actions };
      } catch (error) {
        await this.http
          .request(`/api/runtime-tokens/${encodeURIComponent(grant.tokenId!)}`, context, {
            method: "DELETE",
          })
          .catch(() => undefined);
        throw error;
      }
    }
    // Execution may refresh a remote policy, but must never overwrite lifecycle state.
    if (persist) await this.save(ref, { ...grant, actions }, context);
    return { ...grant, actions };
  }
  async cancelAuthorization(ref: string, context: AdapterContext) {
    const grant = await this.load(ref, context);
    if (!grant) return { connected: false };
    if (!grant.token || !grant.accountId) {
      await this.revoke(ref, context);
      return { connected: false };
    }
    if (grant.requestId) {
      await this.http.request(
        `/v1/connection-requests/${encodeURIComponent(grant.requestId)}`,
        context,
        { method: "DELETE", headers: { "x-oo-connection-scope": ref } },
      );
      await this.save(
        ref,
        { ...grant, requestId: undefined, authorizationUrl: undefined },
        context,
      );
    }
    return { connected: true };
  }
  async revoke(ref: string, context: AdapterContext) {
    const grant = await this.load(ref, context);
    if (!grant) return;
    if (grant.requestId) {
      await this.http.request(
        `/v1/connection-requests/${encodeURIComponent(grant.requestId)}`,
        context,
        { method: "DELETE", headers: { "x-oo-connection-scope": ref } },
      );
      const request = z.object({ appId: z.string().nullable() }).parse(
        await this.http
          .request(`/v1/connection-requests/${encodeURIComponent(grant.requestId)}`, context, {
            headers: { "x-oo-connection-scope": ref },
          })
          .catch((error) => {
            if (error instanceof OpenConnectorNotFound) return { appId: null };
            throw error;
          }),
      );
      if (request.appId) grant.accountId = request.appId;
    }
    if (grant.tokenId)
      await this.http.request(`/api/runtime-tokens/${encodeURIComponent(grant.tokenId)}`, context, {
        method: "DELETE",
      });
    if (grant.accountId && grant.authType !== "no_auth") {
      const raw = await this.http
        .request(`/v1/connections/by-id/${encodeURIComponent(grant.accountId)}`, context)
        .catch((error) => {
          if (error instanceof OpenConnectorNotFound) return null;
          throw error;
        });
      if (raw) {
        const account = Account.parse(raw);
        if (grant.service && account.service !== grant.service)
          throw new Error("Connection provider mismatch");
        await this.http.request(
          `/api/connections/${encodeURIComponent(account.service)}?connectionName=${encodeURIComponent(account.alias)}`,
          context,
          { method: "DELETE" },
        );
      }
    } else if (grant.service && grant.alias)
      await this.http.request(
        `/api/connections/${encodeURIComponent(grant.service)}?connectionName=${encodeURIComponent(grant.alias)}`,
        context,
        { method: "DELETE" },
      );
    await this.deps.prisma.secret.deleteMany({
      where: { id: ref, spaceId: context.spaceId, kind: "open-connector" },
    });
  }
}
