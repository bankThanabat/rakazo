import { createHash } from "node:crypto";
import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { createOpenConnectorFixture, sampleAction } from "./open-connector-test-fixture.js";

const actions = ["list_conversations", "list_conversation_messages", "get_message", "list_media"];
async function fixture(userId = "owner", spaceId = "space") {
  const f = createOpenConnectorFixture();
  f.providers[0] = {
    ...f.providers[0]!,
    service: "instagram",
    actions: actions.map((name) => ({
      ...sampleAction,
      service: "instagram",
      id: `instagram.${name}`,
      readOnly: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })),
  };
  const context: AdapterContext = {
    userId,
    spaceId,
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const { state } = await f.adapter.begin(
    { provider: "instagram", credential: "fake", redirectUrl: "https://example.test" },
    context,
  );
  context.connectedConnections = [
    {
      id: "connection",
      connectorId: "open-connector",
      externalId: "instagram",
      displayName: "Synthetic",
      providerRef: state,
    },
  ];
  async function execute(action = "list_conversations", expectedAccountId?: string) {
    const events: ConnectorEvent[] = [];
    for await (const event of f.adapter.execute(
      {
        tool: `instagram.${action}`,
        executionId: "read",
        args: {},
        expectedAccountId,
        route: {
          connectorId: "open-connector",
          resourceId: "connection",
          toolName: `instagram.${action}`,
        },
      },
      context,
    ))
      events.push(event);
    return events;
  }
  return { ...f, context, execute };
}

describe("Instagram history admission at dispatch", () => {
  it("uses the same verified account bucket across actions, aliases, owners and Spaces", async () => {
    const left = await fixture();
    const right = await fixture("another-owner", "another-space");
    for (const action of actions.slice(0, 3))
      expect(await left.execute(action)).toMatchObject([{ type: "result" }]);
    expect(await right.execute()).toMatchObject([{ type: "result" }]);
    const key = createHash("sha256")
      .update(JSON.stringify(["instagram", "instagram-account", "conversation-reads"]))
      .digest("hex");
    const calls = [...left.rateQuery.mock.calls, ...right.rateQuery.mock.calls];
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call[1] === key && call[2] === 600)).toBe(true);
    expect(
      left.fetcher.mock.calls
        .filter(([url]) => String(url).includes("/v1/actions/"))
        .every(([url]) => String(url).endsWith("/for-account/instagram-account")),
    ).toBe(true);
    await left.execute("list_media");
    expect(left.rateQuery).toHaveBeenCalledTimes(3);
  });

  it("rejects a wrong expected account before taking any permit", async () => {
    const f = await fixture();
    expect(await f.execute("get_message", "different-account")).toMatchObject([
      { type: "error", dispatch: "not_started" },
    ]);
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it("cancels a busy caller without sending or consuming a future slot", async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.context.signal = abort.signal;
    f.rateQuery.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      abort.abort();
      return [{ retryMs: 10000 }];
    });
    expect(await f.execute()).toMatchObject([{ type: "error" }]);
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.sent).toHaveLength(0);
  });

  it("rechecks admission after waiting and binds dispatch against an account changed meanwhile", async () => {
    const f = await fixture();
    f.rateQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ retryMs: 1 }])
      .mockImplementationOnce(async () => {
        [...f.accounts.values()][0]!.providerAccountId = "replacement";
        return [{ key: "permit" }];
      });
    expect(await f.execute()).toMatchObject([{ type: "error", dispatch: "not_started" }]);
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(f.sent).toHaveLength(0);
  });

  it("fails closed when admission storage fails", async () => {
    const f = await fixture();
    f.rateQuery.mockRejectedValueOnce(new Error("Synthetic database unavailable"));
    expect(await f.execute()).toMatchObject([{ type: "error" }]);
    expect(f.sent).toHaveLength(0);
  });

  it("returns cancellation while SQL is pending and never dispatches its late permit", async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.context.signal = abort.signal;
    let finish!: (result: unknown) => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.rateQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const request = f.execute();
    await pending;
    abort.abort();
    expect(await request).toMatchObject([{ type: "error" }]);
    finish([{ key: "late-permit" }]);
    await Promise.resolve();
    expect(f.sent).toHaveLength(0);
    expect(f.rateQuery).toHaveBeenCalledTimes(1);
  });
});
