import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const dispatch = vi.hoisted(() => ({ resolve: vi.fn(), send: vi.fn(), teaching: vi.fn() }));
vi.mock("./thread-target.js", () => ({
  resolveThreadTarget: dispatch.resolve,
  sendThreadMessage: dispatch.send,
  reactToThreadMessage: vi.fn(),
  setThreadUnreadState: vi.fn(),
  stopThreadRuns: vi.fn(),
  threadHead: vi.fn(),
  threadSnapshot: vi.fn(),
}));
vi.mock("./taught-skills.js", () => ({
  assertTeachingSendAllowed: dispatch.teaching,
  createTaughtSkillsService: () => ({}),
}));

const actor: Actor = {
  userId: "staff",
  spaceId: "space",
  email: "staff@example.test",
  isDeploymentOwner: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  dispatch.resolve.mockResolvedValue({ kind: "bot", botId: "case-bot", threadId: "staff-thread" });
  dispatch.send.mockResolvedValue({ taskId: "task", runId: "run", seq: 1 });
});
function fixture() {
  const prisma = {
    spaceMember: {
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => ({ spaceId: actor.spaceId })),
    },
    connection: {
      findFirst: vi.fn(async () => ({ id: "line-account", providerRef: "fake-reference" })),
    },
    customerConversation: { findFirst: vi.fn(async () => ({ channel: { botId: "case-bot" } })) },
    bot: {
      findFirst: vi.fn(async () => ({ id: "case-bot", name: "Support" })),
      findMany: vi.fn(async () => [
        { id: "unrelated", name: "Other" },
        { id: "case-bot", name: "Support" },
      ]),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
  };
  const env = { agentRuntime: "scripted" };
  const handler = new RPCHandler(
    createRouter({ prisma, env, integrationSettings: {} } as unknown as RouterDeps),
  );
  const request = (identity: Actor | null = actor) =>
    handler.handle(
      new Request("http://localhost/rpc/customers/investigate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { id: "case", clientNonce: "retry-safe-nonce", botId: "unrelated" },
        }),
      }),
      { prefix: "/rpc", context: { actor: identity } },
    );
  const setupIncoming = () =>
    handler.handle(
      new Request("https://staff.example.test/rpc/connections/setupIncoming", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectionId: "line-account",
            botId: "case-bot",
            clientNonce: "setup-nonce",
            text: "untrusted replacement",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
  return { prisma, env, request, setupIncoming };
}

it("rejects the old chat-based setup request without a channel secret", async () => {
  const f = fixture();
  expect((await f.setupIncoming()).response.status).toBe(400);
  expect(dispatch.send).not.toHaveBeenCalled();
});

it("sends a server-prepared case request through the normal staff admission checks", async () => {
  const f = fixture();
  const { response } = await f.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ json: { botId: "case-bot", name: "Support" } });
  expect(dispatch.resolve).toHaveBeenCalledWith(
    f.prisma,
    actor,
    expect.objectContaining({ botId: "case-bot" }),
  );
  expect(dispatch.teaching).toHaveBeenCalledWith(f.prisma, actor.spaceId, "case-bot");
  expect(dispatch.send).toHaveBeenCalledWith(
    expect.anything(),
    actor,
    expect.objectContaining({ threadId: "staff-thread" }),
    {
      botId: "case-bot",
      clientNonce: "retry-safe-nonce",
      text: expect.stringContaining('customer case "case"'),
    },
  );
});

it("denies anonymous and non-member investigation before dispatch", async () => {
  const f = fixture();
  expect((await f.request(null)).response.status).toBe(401);
  f.prisma.spaceMember.count.mockResolvedValue(0);
  expect((await f.request()).response.status).toBeGreaterThanOrEqual(400);
  expect(dispatch.send).not.toHaveBeenCalled();
});

it("requires a model and respects teaching admission", async () => {
  const f = fixture();
  f.env.agentRuntime = "pi";
  expect((await f.request()).response.status).toBe(400);
  expect(dispatch.send).not.toHaveBeenCalled();
  f.env.agentRuntime = "scripted";
  dispatch.teaching.mockRejectedValue(new Error("Teaching in progress"));
  expect((await f.request()).response.status).toBeGreaterThanOrEqual(400);
  expect(dispatch.send).not.toHaveBeenCalled();
});
