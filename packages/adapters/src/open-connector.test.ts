import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenConnector } from "./open-connector.js";
import {
  lineTestAction as action,
  createOpenConnectorFixture as fixture,
} from "./open-connector-test-fixture.js";

const owner: AdapterContext = {
  spaceId: "space-a",
  userId: "user-a",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};

async function connect(adapter: OpenConnector, context = owner, credential = "fake-line-token") {
  return adapter.begin(
    { provider: "line", redirectUrl: "https://example.test/app", credential },
    context,
  );
}
function connected(state: string, context = owner): AdapterContext {
  return {
    ...context,
    connectedConnections: [
      {
        id: "connection-1",
        connectorId: "open-connector",
        externalId: "line",
        displayName: "Support",
        providerRef: state,
      },
    ],
  };
}
function call(): ConnectorCall {
  return {
    tool: action.id,
    args: { to: "fake-recipient", texts: ["Hello"] },
    executionId: "execution-1",
    route: { connectorId: "open-connector", toolName: action.id, resourceId: "connection-1" },
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

afterEach(() => vi.useRealTimers());

describe("OpenConnector accounts", () => {
  it("connects, discovers and sends through the exact owned account, then disconnects it", async () => {
    const f = fixture();
    const catalog = await f.adapter.catalog(owner);
    expect(catalog[0]).toMatchObject({ slug: "line", scope: "team", availability: "available" });
    const { state, authorizationUrl } = await connect(f.adapter);
    expect(authorizationUrl).toBeNull();
    expect(await f.adapter.complete({ state }, owner)).toEqual({ connectionRef: state });
    const context = connected(state);
    expect(await f.adapter.discoverTools(context)).toHaveLength(3);
    expect(await collect(f.adapter.execute(call(), context))).toEqual([
      {
        type: "result",
        data: { sentMessages: [{ id: "message-1" }] },
      },
    ]);
    expect(f.sent).toEqual([
      { alias: state, input: call().args, token: expect.stringMatching(/^fake-runtime-token-/) },
    ]);
    expect(JSON.stringify([...f.records.values()])).not.toContain("fake-runtime-token-");
    expect([...f.tokens.values()][0]).toMatchObject({
      allowedConnections: [f.accounts.get(state)!.id],
      allowedActions: [action.id],
      allowedProxies: [],
    });
    await f.adapter.revoke(state, owner);
    expect(await f.adapter.listConnectedExternalIds(owner)).toEqual([]);
    expect(await collect(f.adapter.execute(call(), context))).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
    expect(f.sent).toHaveLength(1);
  });

  it.each([{ spaceId: "other-space" }, { spaceId: "other-space", userId: "other-user" }])(
    "rejects a foreign connection in %j",
    async (scope) => {
      const f = fixture();
      const { state } = await connect(f.adapter);
      const other = { ...owner, ...scope };
      expect(await f.adapter.listConnectedExternalIds(other)).toEqual([]);
      expect(await f.adapter.discoverTools(connected(state, other))).toEqual([]);
      f.fetcher.mockClear();
      await expect(f.adapter.complete({ state }, other)).rejects.toThrow("not authorized");
      await expect(f.adapter.revoke(state, other)).rejects.toThrow("not authorized");
      expect(await collect(f.adapter.execute(call(), connected(state, other)))).toEqual([
        { type: "error", message: "OpenConnector connection is not authorized" },
      ]);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it("lets another member of the same team discover and use the account", async () => {
    const f = fixture();
    const { state, scope } = await connect(f.adapter);
    expect(scope).toBe("team");
    const teammate = connected(state, { ...owner, userId: "teammate" });
    expect(await f.adapter.listConnectedExternalIds(teammate)).toEqual(["line"]);
    expect(await f.adapter.discoverTools(teammate)).toHaveLength(3);
    expect(await collect(f.adapter.execute(call(), teammate))).toEqual([
      expect.objectContaining({ type: "result" }),
    ]);
    expect(f.sent[0]?.alias).toBe(state);
  });

  it("uses a runtime grant that cannot select a sibling account", async () => {
    const f = fixture();
    await connect(f.adapter);
    const second = await connect(f.adapter);
    const token = [...f.tokens.keys()][0]!;
    const response = await f.fetcher(
      "https://connector.example.test/v1/actions/line.send_push_text",
      {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "x-oo-connector-alias": second.state },
        body: JSON.stringify({ input: call().args }),
      },
    );
    expect(response.status).toBe(403);
    expect(f.sent).toEqual([]);
  });

  it("keeps sibling accounts independent and does not reconcile a pending account from another alias", async () => {
    const f = fixture();
    const first = await connect(f.adapter);
    const second = await connect(f.adapter);
    expect(first.state).not.toBe(second.state);
    expect((await f.adapter.catalog(owner))[0]?.connected).toBe(false);
    expect(await f.adapter.connectionReady(owner, "line")).toBe(false);
    await f.adapter.revoke(first.state, owner);
    await expect(f.adapter.complete({ state: second.state }, owner)).resolves.toEqual({
      connectionRef: second.state,
    });
  });

  it("rejects default aliases, missing credentials, and actions from another provider before sending", async () => {
    const f = fixture();
    await expect(f.adapter.revoke("default", owner)).rejects.toThrow("not authorized");
    await expect(connect(f.adapter, owner, "")).rejects.toThrow("Choose an authentication");
    const { state } = await connect(f.adapter);
    const request = call();
    request.route!.toolName = "gmail.send_email";
    expect(await collect(f.adapter.execute(request, connected(state)))).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
    expect(f.sent).toEqual([]);
  });

  it("does not expose a token echoed by upstream validation errors", async () => {
    const f = fixture();
    await expect(connect(f.adapter, owner, "fake-invalid-token")).rejects.toThrow(
      "Could not connect this account",
    );
    expect(f.accounts.size).toBe(0);
  });
});

describe("catalog-driven authentication", () => {
  it.each(["api_key", "custom_credential", "no_auth"] as const)(
    "connects a previously unknown provider using %s",
    async (type) => {
      const f = fixture();
      f.providers.push({
        service: "future-app",
        displayName: "Future app",
        categories: [],
        auth: [
          {
            type,
            fields:
              type === "custom_credential"
                ? [
                    {
                      key: "password",
                      label: "Password",
                      inputType: "password",
                      required: true,
                      secret: true,
                    },
                  ]
                : undefined,
          },
        ],
        actions: [
          {
            id: "future-app.work",
            service: "future-app",
            description: "Work",
            execution: { locallyExecutable: true, noAuthRunnable: type === "no_auth" },
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      });
      const setup = await f.adapter.setup("future-app", owner);
      expect(setup.methods[0]?.type).toBe(type);
      const values: Record<string, string> =
        type === "api_key"
          ? { apiKey: "fake-key" }
          : type === "custom_credential"
            ? { password: "fake-password" }
            : {};
      const { state } = await f.adapter.begin(
        { provider: "future-app", redirectUrl: "https://app.example.test", auth: { type, values } },
        owner,
      );
      const context = connected(state);
      context.connectedConnections![0]!.externalId = "future-app";
      const request = call();
      request.route!.toolName = "future-app.work";
      request.args = { value: "test" };
      expect(await collect(f.adapter.execute(request, context))).toEqual([
        expect.objectContaining({ type: "result" }),
      ]);
      request.args = { value: 123 };
      expect(await collect(f.adapter.execute(request, context))).toEqual([
        expect.objectContaining({ type: "error" }),
      ]);
      expect(f.sent).toHaveLength(1);
    },
  );
  it("keeps concurrent OAuth requests independent, cancels precisely, and reconnects the same account", async () => {
    const f = fixture();
    f.providers[0]!.auth = [{ type: "oauth2" }];
    const auth = { type: "oauth2" as const, values: {} };
    const first = await f.adapter.begin(
      { provider: "line", redirectUrl: "https://app.example.test", auth },
      owner,
    );
    const second = await f.adapter.begin(
      { provider: "line", redirectUrl: "https://app.example.test", auth },
      owner,
    );
    expect(await f.adapter.pollConnection(first.state, owner)).toBeNull();
    await f.adapter.revoke(first.state, owner);
    const ids = [...f.requests.keys()];
    f.authorize(ids[0]!);
    expect(f.accounts.size).toBe(0);
    f.authorize(ids[1]!);
    await f.adapter.complete({ state: second.state }, owner);
    const accountId = [...f.accounts.values()][0]!.id;
    await f.adapter.reconnect(second.state, auth, owner);
    f.authorize([...f.requests.keys()].at(-1)!);
    await f.adapter.complete({ state: second.state }, owner);
    expect([...f.tokens.values()][0]!.allowedConnections).toEqual([accountId]);
    await f.adapter.revoke(second.state, owner);
    await f.adapter.revoke(second.state, owner);
    expect(f.accounts.size).toBe(0);
    expect(f.tokens.size).toBe(0);
  });
  it("picks up new actions after catalog refresh and keeps the grant restricted to its account", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { state } = await connect(f.adapter);
    const context = connected(state);
    await f.adapter.catalog(owner);
    f.providers[0]!.actions.push({ ...action, id: "line.new_action" });
    vi.advanceTimersByTime(31000);
    const request = call();
    request.route!.toolName = "line.new_action";
    expect(await collect(f.adapter.execute(request, context))).toEqual([
      expect.objectContaining({ type: "result" }),
    ]);
    expect([...f.tokens.values()][0]).toMatchObject({
      allowedActions: ["line.new_action", action.id],
      allowedConnections: [f.accounts.get(state)!.id],
      allowedProxies: [],
    });
  });
  it("cleans up remote resources if saving a newly minted grant fails", async () => {
    const f = fixture();
    f.secret.updateMany.mockRejectedValueOnce(new Error("offline database"));
    await expect(connect(f.adapter)).rejects.toThrow("Could not connect");
    expect(f.tokens.size).toBe(0);
    expect(f.accounts.size).toBe(0);
    expect(f.records.size).toBe(0);
  });
  it("marks unknown authentication metadata unavailable", async () => {
    const f = fixture();
    f.providers[0]!.auth = [{ type: "future-auth" }];
    expect((await f.adapter.catalog(owner))[0]?.availability).toBe("unavailable");
    await expect(connect(f.adapter)).rejects.toThrow("unsupported");
  });
});

it("cancels OAuth reconnect without deleting the existing team account", async () => {
  const f = fixture();
  f.providers[0]!.auth = [{ type: "oauth2" }];
  const auth = { type: "oauth2" as const, values: {} };
  const first = await f.adapter.begin(
    { provider: "line", redirectUrl: "https://example.test", auth },
    owner,
  );
  f.authorize([...f.requests.keys()][0]!);
  await f.adapter.complete({ state: first.state }, owner);
  const token = [...f.tokens.keys()][0];
  const account = [...f.accounts.values()][0];
  await f.adapter.reconnect(first.state, auth, owner);
  expect(await f.adapter.cancelAuthorization(first.state, owner)).toEqual({ connected: true });
  f.authorize([...f.requests.keys()].at(-1)!);
  expect([...f.tokens.keys()]).toEqual([token]);
  expect([...f.accounts.values()]).toEqual([account]);
  expect(await collect(f.adapter.execute(call(), connected(first.state)))).toEqual([
    expect.objectContaining({ type: "result" }),
  ]);
});

it("supports providers larger than the runtime token rule limit without granting another provider", async () => {
  const f = fixture();
  f.providers[0]!.actions = Array.from({ length: 129 }, (_, index) => ({
    ...action,
    id: `line.action_${index}`,
  }));
  const { state } = await connect(f.adapter);
  await f.adapter.complete({ state }, owner);
  expect([...f.tokens.values()][0]).toMatchObject({
    allowedActions: ["line.*"],
    allowedConnections: [f.accounts.get(state)!.id],
    allowedProxies: [],
  });
});

it("rejects execution when the schema changed after authorization", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const { state } = await connect(f.adapter);
  const context = connected(state);
  const resolved = await f.adapter.resolveCall(call(), context);
  expect(resolved).toBeDefined();
  f.providers[0]!.actions[0]!.inputSchema = {
    type: "object",
    properties: { different: { type: "string" } },
  };
  vi.advanceTimersByTime(31000);
  expect(await collect(f.adapter.execute(resolved!.call, context))).toEqual([
    { type: "error", message: "The action schema changed. Review the action again." },
  ]);
  expect(f.sent).toHaveLength(0);
});

async function oauthFixture() {
  const f = fixture();
  f.providers[0]!.auth = [{ type: "oauth2" }];
  const auth = { type: "oauth2" as const, values: {} };
  const started = await f.adapter.begin(
    { provider: "line", redirectUrl: "https://app.example.test", auth },
    owner,
  );
  return { ...f, auth, ...started };
}

it("execution cannot erase a reconnect request, even during a runtime policy refresh", async () => {
  vi.useFakeTimers();
  const f = await oauthFixture();
  f.authorize([...f.requests.keys()][0]!);
  await f.adapter.complete({ state: f.state }, owner);
  f.providers[0]!.actions.push({ ...action, id: "line.new_action" });
  vi.advanceTimersByTime(31000);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    if (String(input).includes("/api/runtime-tokens/") && init?.method === "PUT") {
      entered();
      await blocked;
    }
    return original(input, init);
  });
  const executing = collect(f.adapter.execute(call(), connected(f.state)));
  await waiting;
  await f.adapter.reconnect(f.state, f.auth, owner);
  const requestId = [...f.requests.keys()].at(-1)!;
  release();
  await executing;
  await f.adapter.cancelAuthorization(f.state, owner);
  expect(f.requests.get(requestId)!.status).toBe("failed");
  f.authorize(requestId);
  expect(f.accounts.size).toBe(1);
});

it("recovers a completed OAuth attempt before reconnect can replace it", async () => {
  const f = await oauthFixture();
  f.authorize([...f.requests.keys()][0]!);
  expect(await f.adapter.reconnect(f.state, f.auth, owner)).toEqual({ authorizationUrl: null });
  expect(f.requests.size).toBe(1);
  expect(await f.adapter.cancelAuthorization(f.state, owner)).toEqual({ connected: true });
  await f.adapter.revoke(f.state, owner);
  expect(f.accounts.size).toBe(0);
  expect(f.records.size).toBe(0);
});

it("resumes a pending OAuth attempt without creating another remote request", async () => {
  const f = await oauthFixture();
  expect(await f.adapter.reconnect(f.state, f.auth, owner)).toEqual({
    authorizationUrl: f.authorizationUrl,
  });
  expect(f.requests.size).toBe(1);
});

it("requires reconnect when a refreshed OAuth action needs a scope the account did not grant", async () => {
  vi.useFakeTimers();
  const f = await oauthFixture();
  f.authorize([...f.requests.keys()][0]!);
  await f.adapter.complete({ state: f.state }, owner);
  f.providers[0]!.actions = [{ ...action, requiredScopes: ["messages.write"] }];
  vi.advanceTimersByTime(31000);
  expect(await collect(f.adapter.execute(call(), connected(f.state)))).toEqual([
    expect.objectContaining({ type: "error", message: expect.stringContaining("Reconnect") }),
  ]);
  expect(f.sent).toHaveLength(0);
  expect(await f.adapter.connectionStatus(f.state, owner)).toMatchObject({
    reconnectRequired: true,
  });
  await f.adapter.reconnect(f.state, f.auth, owner);
  f.authorize([...f.requests.keys()].at(-1)!, ["messages.write"]);
  await f.adapter.complete({ state: f.state }, owner);
  expect(await f.adapter.connectionStatus(f.state, owner)).toMatchObject({
    reconnectRequired: false,
  });
  expect(await collect(f.adapter.execute(call(), connected(f.state)))).toEqual([
    expect.objectContaining({ type: "result" }),
  ]);
});
