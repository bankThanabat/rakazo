import type { PrismaClient } from "@rakazo/db";
import { vi } from "vitest";
import { OpenConnector } from "./open-connector.js";
import type { OpenConnectorProvider } from "./open-connector-catalog.js";
import { EncryptedSecretStore } from "./secrets.js";

export const sampleAction = {
  id: "sample.send",
  service: "sample",
  execution: { locallyExecutable: true },
  description: "Send text",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string" },
      texts: { type: "array", items: { type: "string" } },
      retryKey: { type: "string" },
    },
    required: ["to", "texts"],
    additionalProperties: false,
  },
};
export const openConnectorTestConfig = {
  endpoint: "https://connector.example.test",
  apiKey: "fake-admin-token",
  identitySecret: "fake-identity-secret",
};

interface TestSecret {
  id: string;
  spaceId: string;
  userId: string;
  kind: string;
  ciphertext: string;
}

/** Reusable offline HTTP/persistence fixture for the adapter and authenticated RPC journeys. */
export function createOpenConnectorFixture(
  onAction?: (action: string, input: unknown, alias: string) => unknown,
) {
  const providers: OpenConnectorProvider[] = [
    {
      service: "sample",
      displayName: "Sample app",
      categories: ["Messaging"],
      auth: [{ type: "api_key", label: "API key" }],
      actions: [sampleAction],
    },
  ];
  const requests = new Map<string, { service: string; status: string; appId: string | null }>();
  const oauthConfigs = new Set<string>();
  const accounts = new Map<
    string,
    { id: string; service: string; connectionName: string; configured: boolean; scopes?: string[] }
  >();
  const tokens = new Map<
    string,
    { id: string; allowedActions: string[]; allowedConnections: string[]; allowedProxies: string[] }
  >();
  const records = new Map<string, TestSecret>();
  const sent: Array<{ alias: string; input: unknown; token: string }> = [];
  let ordinal = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://oomol.com") return Response.json({ items: [] });
    const headers = new Headers(init?.headers);
    const bearer = headers.get("authorization")?.replace("Bearer ", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.redirect !== "error") throw new Error("Credential redirects must be disabled");
    if (url.pathname.startsWith("/v1/actions/")) {
      const token = bearer && tokens.get(bearer);
      const alias = headers.get("x-oo-connector-alias") ?? "default";
      const actionId = decodeURIComponent(url.pathname.slice("/v1/actions/".length));
      const provider = providers.find((row) =>
        row.actions.some((action) => action.id === actionId),
      );
      const account =
        accounts.get(alias) ??
        (provider?.auth.some((auth) => auth.type === "no_auth")
          ? { id: `${provider.service}:${alias}` }
          : undefined);
      if (
        !token ||
        !account ||
        !token.allowedConnections.includes(account.id) ||
        !token.allowedActions.some((rule) => rule === actionId || rule === `${provider?.service}.*`)
      ) {
        return Response.json({ error: "connection_not_allowed" }, { status: 403 });
      }
      sent.push({ alias, input: body.input, token: bearer! });
      return Response.json({
        success: true,
        data: onAction
          ? await onAction(actionId, body.input, alias)
          : { sentMessages: [{ id: "message-1" }] },
      });
    }
    if (bearer !== openConnectorTestConfig.apiKey) return Response.json({}, { status: 401 });
    if (url.pathname === "/api/providers") return Response.json(providers);
    if (url.pathname.startsWith("/api/actions/"))
      return Response.json(
        providers
          .flatMap((row) => row.actions)
          .find((row) => row.id === decodeURIComponent(url.pathname.split("/").at(-1)!)),
      );
    if (url.pathname === "/api/oauth/configs")
      return Response.json(
        providers
          .filter((row) => row.auth.some((auth) => auth.type === "oauth2"))
          .map((row) => ({
            service: row.service,
            configured: oauthConfigs.has(row.service),
            expectedRedirectUri: "https://connector.example.test/oauth/callback",
          })),
      );
    if (url.pathname.startsWith("/api/oauth/configs/") && init?.method === "PUT") {
      oauthConfigs.add(url.pathname.split("/").at(-1)!);
      return Response.json({ configured: true });
    }
    if (url.pathname === "/v1/connection-capabilities" || headers.has("x-oo-connection-scope"))
      throw new Error("Removed fork API used");
    if (url.pathname.endsWith("/connect") && init?.method === "POST") {
      const target = url.pathname.includes("/by-id/")
        ? [...accounts.values()].find((row) => row.id === url.pathname.split("/").at(-2))
        : undefined;
      const service = target?.service ?? url.pathname.split("/").at(-2)!;
      const id = `request-${++ordinal}`;
      requests.set(id, {
        service,
        status: "initiated",
        appId: target?.id ?? null,
      });
      return Response.json({
        success: true,
        data: {
          connectionRequestId: id,
          authorizationUrl: `https://oauth.example.test/authorize?state=${id}`,
        },
      });
    }
    if (url.pathname.startsWith("/v1/connection-requests/")) {
      const request = requests.get(url.pathname.split("/").at(-1)!);
      if (!request || init?.method === "DELETE") return Response.json({}, { status: 404 });
      return Response.json({ success: true, data: request });
    }
    if (url.pathname.startsWith("/api/connections/") && init?.method === "PUT") {
      if (body.values.apiKey === "fake-invalid-token")
        return Response.json({ message: body.values.apiKey }, { status: 401 });
      const account = {
        id: accounts.get(body.connectionName)?.id ?? `account-${++ordinal}`,
        service: url.pathname.split("/").at(-1)!,
        connectionName: body.connectionName,
        configured: true,
      };
      if (account.connectionName.length > 64) return Response.json({}, { status: 400 });
      if (body.authType === "no_auth") account.id = `${account.service}:${account.connectionName}`;
      else accounts.set(account.connectionName, account);
      return Response.json(account);
    }
    if (url.pathname.startsWith("/v1/connections/by-id/")) {
      const account = [...accounts.values()].find(
        (row) => row.id === url.pathname.split("/").at(-1),
      );
      return account
        ? Response.json({
            success: true,
            data: {
              id: account.id,
              service: account.service,
              alias: account.connectionName,
              status: "active",
              scopes: account.scopes ?? [],
            },
          })
        : Response.json({}, { status: 404 });
    }
    if (url.pathname.startsWith("/api/connections/") && init?.method === "DELETE") {
      accounts.delete(url.searchParams.get("connectionName")!);
      return Response.json({ configured: false });
    }
    if (url.pathname === "/api/runtime-tokens" && init?.method === "POST") {
      const id = `grant-${++ordinal}`;
      const token = `fake-runtime-token-${ordinal}`;
      const record = { ...body, id };
      tokens.set(token, record);
      return Response.json({ token, record });
    }
    if (
      url.pathname.startsWith("/api/runtime-tokens/") &&
      ["DELETE", "PUT"].includes(init?.method ?? "")
    ) {
      const entry = [...tokens.entries()].find(
        ([, row]) => row.id === url.pathname.split("/").at(-1),
      );
      if (!entry) return Response.json({}, { status: 404 });
      if (init?.method === "PUT") {
        tokens.set(entry[0], { ...entry[1], ...body });
        return Response.json({ updated: true });
      }
      tokens.delete(entry[0]);
      return Response.json({ revoked: true });
    }
    throw new Error(`Unexpected offline request: ${url.pathname}`);
  });
  const secret = {
    create: vi.fn(async ({ data }: { data: TestSecret }) => {
      records.set(data.id, data);
      return data;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, string> }) =>
        [...records.values()].find((row) =>
          Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
        ) ?? null,
    ),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, string>; data: Partial<TestSecret> }) => {
        const matches = [...records.values()].filter((row) =>
          Object.entries(where).every(([key, value]) => row[key as keyof TestSecret] === value),
        );
        for (const row of matches) records.set(row.id, { ...row, ...data });
        return { count: matches.length };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
      const matches = [...records.values()].filter((row) =>
        Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
      );
      for (const row of matches) records.delete(row.id);
      return { count: matches.length };
    }),
  };
  const attempts = new Map<
    string,
    {
      id: string;
      ref: string;
      endpoint: string;
      spaceId: string;
      userId: string;
      service: string;
      createdAt: Date;
    }
  >();
  const openConnectorAttempt = {
    create: vi.fn(async ({ data }) => {
      const row = { ...data, createdAt: new Date() };
      attempts.set(row.id, row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }) => ({ count: Number(attempts.delete(where.id)) })),
    findMany: vi.fn(async ({ where }) =>
      [...attempts.values()].filter((row) => row.endpoint === where.endpoint),
    ),
  };
  const prisma = { secret, openConnectorAttempt } as unknown as Pick<
    PrismaClient,
    "secret" | "openConnectorAttempt"
  >;
  const secrets = new EncryptedSecretStore("fake-secret-storage-key");
  const adapter = new OpenConnector(openConnectorTestConfig, {
    prisma,
    secrets,
    fetch: fetcher,
  });
  function authorize(id: string, scopes: string[] = []) {
    const request = requests.get(id)!;
    if (request.status !== "initiated") return;
    const account = {
      scopes,
      id: request.appId ?? `account-${++ordinal}`,
      service: request.service,
      connectionName: `oauth-alias-${ordinal}`,
      configured: true,
    };
    const previous = [...accounts.values()].find((row) => row.id === request.appId);
    if (previous) account.connectionName = previous.connectionName;
    accounts.set(account.connectionName, account);
    request.appId = account.id;
    request.status = "connected";
  }
  return {
    adapter,
    fetcher,
    accounts,
    sent,
    tokens,
    records,
    prisma,
    secrets,
    secret,
    providers,
    requests,
    authorize,
    oauthConfigs,
  };
}
