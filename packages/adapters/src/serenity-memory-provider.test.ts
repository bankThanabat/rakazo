import type { AdapterContext, SemanticMemoryForgetRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  MemoryProviderDeploymentOwnerRequiredError,
  prepareSerenityConnection,
  SerenityMemoryProvider,
  sanitizeSerenityBrainLabel,
  serenityBotEntity,
  serenityRequiresDeploymentOwner,
  serenitySpaceEntity,
} from "./serenity-memory-provider.js";

/** Stable digest suffix for "Personal Brain" (case-folded). */
const PERSONAL_BRAIN = "personal-brain-7a024bf3";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

vi.mock("./serenity-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serenity-client.js")>();
  return {
    ...actual,
    probeSerenity: vi.fn(),
    recallSerenity: vi.fn(),
    rememberSerenity: vi.fn(),
    forgetSerenity: vi.fn(),
  };
});

import {
  forgetSerenity,
  probeSerenity,
  recallSerenity,
  rememberSerenity,
} from "./serenity-client.js";

const probeSerenityMock = vi.mocked(probeSerenity);
const recallSerenityMock = vi.mocked(recallSerenity);
const rememberSerenityMock = vi.mocked(rememberSerenity);
const forgetSerenityMock = vi.mocked(forgetSerenity);

afterEach(() => {
  vi.resetAllMocks();
});

function provider(allowWrites = true, brainLabel = "") {
  return new SerenityMemoryProvider({
    endpoint: "http://127.0.0.1:8787/mcp",
    token: "serenity_test_token",
    brainLabel,
    allowWrites,
  });
}

function removal(input: Partial<SemanticMemoryForgetRequest> = {}): SemanticMemoryForgetRequest {
  return {
    id: "fact-1",
    botId: "bot-1",
    scope: "isolated",
    expectedContent: "Use metric units.",
    ...input,
  };
}

function recallFact(id: string, fact: string, entitySlug?: string | null) {
  return {
    ok: true as const,
    value: [{ factId: id, fact, provenance: "owner correction", entitySlug }],
  };
}

describe("SerenityMemoryProvider", () => {
  it("keeps bot and space entity namespaces inside the adapter", () => {
    expect(serenityBotEntity("bot-1")).toBe("rakazo-bot/bot-1");
    expect(serenitySpaceEntity("workspace-1")).toBe("rakazo-space/workspace-1");
    expect(serenityBotEntity("bot-1", "Personal Brain")).toBe(`rakazo-bot/${PERSONAL_BRAIN}/bot-1`);
    expect(serenitySpaceEntity("workspace-1", "Personal Brain")).toBe(
      `rakazo-space/${PERSONAL_BRAIN}/workspace-1`,
    );
  });

  it("isolates labels that sanitize to the same slug", () => {
    const spaced = sanitizeSerenityBrainLabel("prod brain");
    const hyphenated = sanitizeSerenityBrainLabel("prod-brain");
    expect(spaced).toBe("prod-brain-886a332f");
    expect(hyphenated).toBe("prod-brain-0691dd31");
    expect(spaced).not.toBe(hyphenated);
    expect(serenityBotEntity("bot-1", "prod brain")).not.toBe(
      serenityBotEntity("bot-1", "prod-brain"),
    );
  });

  it("requires deployment owner for loopback, private DNS, and classified LAN hosts", () => {
    expect(serenityRequiresDeploymentOwner({ endpoint: "http://127.0.0.1:8787/mcp" })).toBe(true);
    expect(serenityRequiresDeploymentOwner({ endpoint: "https://serenity.internal/mcp" })).toBe(
      true,
    );
    expect(serenityRequiresDeploymentOwner({ endpoint: "https://serenity.example.test/mcp" })).toBe(
      false,
    );
    expect(
      serenityRequiresDeploymentOwner({
        endpoint: "https://serenity.example.test/mcp",
        endpointTrust: "private",
      }),
    ).toBe(true);
  });

  it("classifies private LAN DNS without probing", async () => {
    const classified = await classifySerenityConnectionSettings(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
      {
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(classified.endpointTrust).toBe("private");
    expect(serenityRequiresDeploymentOwner(classified)).toBe(true);
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("refuses private endpoints before probing when allowPrivateEndpoint is false", async () => {
    await expect(
      prepareSerenityConnection(
        { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
        { token: "serenity_test_token" },
        {
          resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
        },
        { allowPrivateEndpoint: false },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderDeploymentOwnerRequiredError);
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("stores private endpointTrust when HTTPS LAN DNS resolves privately", async () => {
    probeSerenityMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareSerenityConnection(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
      { token: "serenity_test_token" },
      {
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(prepared.settings.endpointTrust).toBe("private");
    expect(serenityRequiresDeploymentOwner(prepared.settings)).toBe(true);
  });

  it("probes before accepting a connection", async () => {
    probeSerenityMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareSerenityConnection(
      { endpoint: "http://127.0.0.1:8787", allowWrites: "false", brainLabel: "personal" },
      { token: "serenity_test_token" },
    );
    expect(prepared.settings.endpoint).toBe("http://127.0.0.1:8787/mcp");
    expect(prepared.settings.allowWrites).toBe("false");
    expect(prepared.credentials).toEqual({ token: "serenity_test_token" });
    expect(probeSerenityMock).toHaveBeenCalledOnce();
  });

  it("recalls isolated scope only against the bot entity", async () => {
    recallSerenityMock.mockResolvedValue({
      ok: true,
      value: [
        {
          factId: "fact-1",
          fact: "Prefer conventional commits.",
          provenance: "user told rakazo",
        },
      ],
    });

    const result = await provider().recall(
      { query: "commits", scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "Prefer conventional commits.",
          score: 1,
          id: "fact-1",
          provenance: "user told rakazo",
          entity: "rakazo-bot/bot-1",
        },
      ],
    });
    expect(recallSerenityMock).toHaveBeenCalledWith(
      "commits",
      expect.objectContaining({ endpoint: "http://127.0.0.1:8787/mcp" }),
      expect.objectContaining({ entity: "rakazo-bot/bot-1", limit: 5 }),
    );
  });

  it("mirrors shared durable saves to space and bot entities", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const result = await provider().save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: "fact-2",
          entity: "rakazo-space/workspace-1",
          content: null,
          created: null,
          providerStatus: "inserted",
        },
        {
          id: "fact-2",
          entity: "rakazo-bot/bot-1",
          content: null,
          created: null,
          providerStatus: "inserted",
        },
      ],
    });
    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      "rakazo-space/workspace-1",
      "rakazo-bot/bot-1",
    ]);
  });

  it("scopes shared durable saves by brain label when configured", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    await labeled.save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      `rakazo-space/${PERSONAL_BRAIN}/workspace-1`,
      `rakazo-bot/${PERSONAL_BRAIN}/bot-1`,
    ]);
  });

  it("retains the first acknowledgement when a mirrored save loses its response", async () => {
    rememberSerenityMock
      .mockResolvedValueOnce({ ok: true, value: { id: "shared-fact", status: "inserted" } })
      .mockResolvedValueOnce({ ok: false, error: "lost response" });
    expect(
      await provider().save(
        { content: "fact", scope: "shared", botId: "bot-1", source: { kind: "durable" } },
        context,
      ),
    ).toEqual({
      ok: false,
      error: "lost response",
      receipts: [
        {
          id: "shared-fact",
          entity: "rakazo-space/workspace-1",
          content: null,
          created: null,
          providerStatus: "inserted",
        },
      ],
      uncertainEntities: ["rakazo-bot/bot-1"],
    });
    expect(rememberSerenityMock).toHaveBeenCalledTimes(2);
  });

  it.each([" ", "x".repeat(10001)])(
    "rejects invalid save content before transport",
    async (content) => {
      expect(
        await provider().save(
          { content, scope: "shared", botId: "bot-1", source: { kind: "durable" } },
          context,
        ),
      ).toMatchObject({ ok: false, receipts: [], uncertainEntities: [] });
      expect(rememberSerenityMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an arbitrary fact id before any provider deletion", async () => {
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "another-business-fact", expired: true, reason: null },
    });
    recallSerenityMock.mockResolvedValue({ ok: true, value: [] });
    const result = await provider().forget(
      removal({ id: "another-business-fact", entity: "rakazo-bot/bot-1" }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("checks scope before deleting by id when the provider has no scoped delete", async () => {
    recallSerenityMock.mockResolvedValue(recallFact("fact-9", "Use metric units."));
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-9", expired: true, reason: null },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    await labeled.forget(
      removal({ id: "fact-9", entity: `rakazo-bot/${PERSONAL_BRAIN}/bot-1`, reason: "cleanup" }),
      context,
    );
    expect(forgetSerenityMock).toHaveBeenCalledWith(
      "fact-9",
      expect.objectContaining({ brainLabel: "Personal Brain" }),
      expect.objectContaining({ reason: "cleanup" }),
    );
    expect(forgetSerenityMock.mock.calls[0]?.[2]).not.toHaveProperty("entity");
  });

  it("blocks durable writes when allowWrites is off", async () => {
    const result = await provider(false).save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    expect(result.ok).toBe(false);
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("skips history compaction writes and purges", async () => {
    await expect(
      provider().save(
        {
          content: "summary",
          scope: "isolated",
          botId: "bot-1",
          source: { kind: "history", generation: 3 },
        },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [1, 2] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("keeps recall entity citations without forwarding them to Serenity forget", async () => {
    recallSerenityMock
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            factId: "fact-space-1",
            fact: "The team uses metric units.",
            provenance: "space policy",
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        value: [],
      });
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-space-1", expired: true, reason: null },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    const recalled = await labeled.recall(
      { query: "units", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );
    expect(recalled).toEqual({
      ok: true,
      value: [
        {
          memory: "The team uses metric units.",
          score: 1,
          id: "fact-space-1",
          provenance: "space policy",
          entity: `rakazo-space/${PERSONAL_BRAIN}/workspace-1`,
        },
      ],
    });

    const fact = recalled.ok ? recalled.value[0] : undefined;
    recallSerenityMock.mockResolvedValue(recallFact(fact!.id!, fact!.memory, fact!.entity));
    // Approval can resume in a new process with no in-memory recall state.
    const resumed = provider(true, "Personal Brain");
    await resumed.forget(
      removal({
        id: fact!.id!,
        expectedContent: fact!.memory,
        scope: "shared",
        entity: fact!.entity,
        reason: "cleanup",
      }),
      context,
    );
    expect(forgetSerenityMock).toHaveBeenCalledWith(
      "fact-space-1",
      expect.objectContaining({ brainLabel: "Personal Brain" }),
      expect.objectContaining({ reason: "cleanup" }),
    );
    expect(forgetSerenityMock.mock.calls[0]?.[2]).not.toHaveProperty("entity");
  });

  it("forgets the exact recalled fact when writes are enabled", async () => {
    recallSerenityMock.mockResolvedValue(recallFact("fact-1", "Use metric units."));
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested" },
    });
    const result = await provider().forget(removal({ reason: "user requested" }), context);
    expect(result).toEqual({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested", entity: "rakazo-bot/bot-1" },
    });
  });

  it.each([
    ["another bot", { entity: "rakazo-bot/bot-2" }],
    ["another space", { scope: "shared", entity: "rakazo-space/workspace-2" }],
    ["shared fact in isolated scope", { entity: "rakazo-space/workspace-1" }],
    ["missing reviewed text", { expectedContent: "" }],
    ["blank reviewed text", { expectedContent: "  " }],
    ["missing identity", { id: "" }],
    ["different executing bot", { botId: "bot-2" }],
  ] as const)("rejects %s without provider requests", async (_name, input) => {
    const result = await provider().forget(removal(input), context);
    expect(result.ok).toBe(false);
    expect(recallSerenityMock).not.toHaveBeenCalled();
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("rejects a citation from another brain label", async () => {
    const result = await provider(true, "Personal Brain").forget(
      removal({ entity: "rakazo-bot/bot-1" }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(recallSerenityMock).not.toHaveBeenCalled();
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it.each([
    ["changed content", "fact-1", "Use imperial units.", undefined],
    ["another fact", "fact-2", "Use metric units.", undefined],
    ["foreign entity", "fact-1", "Use metric units.", "rakazo-bot/bot-2"],
    ["unscoped fact", "fact-1", "Use metric units.", null],
  ] as const)("rejects %s returned by recall", async (_name, id, content, entity) => {
    recallSerenityMock.mockResolvedValue(recallFact(id, content, entity));
    const result = await provider().forget(removal(), context);
    expect(result.ok).toBe(false);
    expect(forgetSerenityMock).not.toHaveBeenCalled();
    expect(recallSerenityMock).toHaveBeenCalledWith(
      "Use metric units.",
      expect.anything(),
      expect.objectContaining({ entity: "rakazo-bot/bot-1", limit: 50 }),
    );
  });

  it("fails closed if the scoped read fails", async () => {
    recallSerenityMock.mockResolvedValue({ ok: false, error: "Unavailable" });
    expect((await provider().forget(removal(), context)).ok).toBe(false);
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("does not delete after cancellation while verifying the fact", async () => {
    const controller = new AbortController();
    recallSerenityMock.mockImplementation(async () => {
      controller.abort();
      return recallFact("fact-1", "Use metric units.");
    });
    await expect(
      provider().forget(removal(), { ...context, signal: controller.signal }),
    ).rejects.toThrow();
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("searches only authorized shared namespaces when the citation has no entity", async () => {
    recallSerenityMock
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValueOnce(recallFact("fact-1", "Use metric units.", "rakazo-bot/bot-1"));
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-1", expired: true, reason: null },
    });
    expect((await provider().forget(removal({ scope: "shared" }), context)).ok).toBe(true);
    expect(recallSerenityMock.mock.calls.map((call) => call[2].entity)).toEqual([
      "rakazo-space/workspace-1",
      "rakazo-bot/bot-1",
    ]);
    expect(forgetSerenityMock).toHaveBeenCalledOnce();
  });

  it.each([
    { id: "other-fact", expired: true, reason: null },
    { id: "fact-1", expired: false, reason: null },
  ])("does not report an unconfirmed deletion as success: %j", async (receipt) => {
    recallSerenityMock.mockResolvedValue(recallFact("fact-1", "Use metric units."));
    forgetSerenityMock.mockResolvedValue({ ok: true, value: receipt });
    expect(await provider().forget(removal(), context)).toEqual({
      ok: false,
      error: "The provider did not confirm this fact's removal. Inspect it before trying again.",
      uncertain: true,
    });
    expect(forgetSerenityMock).toHaveBeenCalledOnce();
  });

  it("does not read or delete while provider writes are disabled", async () => {
    expect((await provider(false).forget(removal(), context)).ok).toBe(false);
    expect(recallSerenityMock).not.toHaveBeenCalled();
    expect(forgetSerenityMock).not.toHaveBeenCalled();
  });

  it("createSerenityProvider builds a working adapter", () => {
    const created = createSerenityProvider(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "true" },
      { token: "serenity_test_token" },
    );
    expect(created.describe().id).toBe("serenity");
  });
});
