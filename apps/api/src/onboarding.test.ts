import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, markAppConnected, promptFocus } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[] }>);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return { id: "posted" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));
function fixture(catalog: unknown[]) {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => [
        {
          id: "choice",
          blocks: [
            {
              kind: "choice",
              answerId: null,
              options: ["customers", "knowledge", "voice", "day"].map((id) => ({ id })),
            },
          ],
        },
      ]),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    connectors: { managedProviders: () => [{ catalog: async () => catalog }] },
  } as unknown as Parameters<typeof chooseFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}
describe("onboarding connection suggestions", () => {
  it.each([
    ["day", "customers"],
    ["customers", "day"],
  ])("rejects %s when the saved card only offers %s", async (requested, offered) => {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany.mockResolvedValueOnce([
      { id: "choice", blocks: [{ kind: "choice", answerId: null, options: [{ id: offered! }] }] },
    ]);
    await expect(chooseFocus(deps, actor, "bot", requested!)).rejects.toThrow("Resource not found");
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });
  it("starts with merchant tasks instead of unrelated app suggestions", async () => {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany.mockResolvedValueOnce([]);
    await promptFocus(deps, actor, "bot");
    expect(posted.flatMap((message) => message.blocks)).toEqual([
      {
        kind: "choice",
        question: "What would you like to set up first?",
        options: [
          { id: "customers", letter: "A", label: "Customer replies" },
          { id: "knowledge", letter: "B", label: "Products & policies" },
          { id: "voice", letter: "C", label: "My brand voice" },
        ],
      },
    ]);
  });
  it.each([
    ["customers", "Where do customers contact you, and which store do you use?"],
    [
      "knowledge",
      "Share your product catalog or policies. Which source has current prices and stock?",
    ],
    ["voice", "Share a few replies your business has written, or tell me which account has them."],
  ])(
    "collects the missing business context for %s before suggesting connections",
    async (id, text) => {
      const { deps, actor } = fixture([]);
      const providers = vi.spyOn(deps.connectors, "managedProviders");
      await chooseFocus(deps, actor, "bot", id!);
      expect(posted.flatMap((message) => message.blocks)).toEqual([{ kind: "text", text }]);
      expect(providers).not.toHaveBeenCalled();
      expect(deps.prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );
  it("does not invent authorization cards when no connector has an app catalog", async () => {
    const { deps, actor } = fixture([]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: "app_connect" }),
    );
    expect(posted.length).toBeGreaterThan(0);
  });
  it("uses the available connector and omits unavailable apps", async () => {
    const { deps, actor } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(
      posted
        .flatMap((message) => message.blocks)
        .filter((block) => (block as { kind: string }).kind === "app_connect"),
    ).toEqual([
      expect.objectContaining({ connectorId: "pipedream", provider: "slack", name: "Slack" }),
    ]);
  });
});

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, tx } = fixture([]);
  const blocks = ["composio", "pipedream"].map((connectorId) => ({
    kind: "app_connect",
    connectorId,
    provider: "slack",
    name: "Slack",
    status: "pending",
  }));
  deps.prisma.message = { findMany: vi.fn(async () => [{ id: "cards", blocks }]) } as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
});
