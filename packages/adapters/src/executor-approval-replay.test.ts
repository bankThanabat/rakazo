import type { ConnectorTool } from "@rakazo/adapter-kit";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it } from "vitest";
import {
  approvedCatalogReplay,
  approvedDocumentReplayName,
  approvedReplayArgs,
  boundDirectApprovalRequest,
  catalogApprovalRequest,
  createApprovedEffectReplayQueue,
  DOCUMENT_REVIEW_TOOLS,
  documentApprovalReplayTool,
} from "./approval-effect.js";
import {
  APPROVED_EFFECT_REPLAY_ORDER,
  approvalReplayEffectToolName,
  buildApprovalContinuation,
} from "./executor.js";
import {
  catalogEntries,
  disambiguateInstalledToolNames,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";

describe("executor approval replay", () => {
  it.each([...DOCUMENT_REVIEW_TOOLS])(
    "resumes %s without returning its document to the model",
    (kind) => {
      const request = { content: "Private document".repeat(100_000) };
      const effects = [{ kind, request }];
      const formatted: unknown[] = [];
      const prompt = buildApprovalContinuation(effects, (value) => {
        formatted.push(value);
        return JSON.stringify(value);
      });
      expect(prompt).toContain(`${documentApprovalReplayTool.name}: {}`);
      expect(prompt!.length).toBeLessThan(1000);
      expect(formatted).toEqual([]);
      const queue = createApprovedEffectReplayQueue(effects);
      expect(approvedDocumentReplayName(queue, {}, new Set([kind]))).toBe(kind);
      expect(queue.take(kind)).toBe(request);
      expect(approvedDocumentReplayName(queue, {}, new Set([kind]))).toBeUndefined();
    },
  );

  it("rejects document replay substitution, unavailable tools, and skipping an earlier approval", () => {
    const queue = createApprovedEffectReplayQueue([
      { kind: "skill_update", request: { content: "Reviewed" } },
    ]);
    expect(
      approvedDocumentReplayName(queue, { content: "Unapproved" }, new Set(["skill_update"])),
    ).toBeUndefined();
    expect(approvedDocumentReplayName(queue, {}, new Set())).toBeUndefined();
    expect(queue.nextToolName()).toBe("skill_update");
    const ordered = createApprovedEffectReplayQueue([
      { kind: "create_space", request: { name: "Reviewed space" } },
      { kind: "skill_update", request: { content: "Reviewed" } },
    ]);
    expect(
      approvedDocumentReplayName(ordered, {}, new Set(["create_space", "skill_update"])),
    ).toBeUndefined();
    expect(ordered.nextToolName()).toBe("create_space");
  });

  it("keeps repeated document approvals distinct and consumes them in order", () => {
    const first = { content: "First reviewed version", expectedRevision: 1 };
    const second = { content: "Second reviewed version", expectedRevision: 2 };
    const effects = [
      { kind: "skill_update", request: first },
      { kind: "skill_update", request: second },
    ];
    const queue = createApprovedEffectReplayQueue(effects);
    const exposed = new Set(["skill_update"]);
    expect(
      buildApprovalContinuation(effects, JSON.stringify)?.match(/apply_approved_document: \{\}/g),
    ).toHaveLength(2);
    expect(approvedDocumentReplayName(queue, {}, exposed)).toBe("skill_update");
    expect(queue.take("skill_update")).toBe(first);
    expect(approvedDocumentReplayName(queue, {}, exposed)).toBe("skill_update");
    expect(queue.take("skill_update")).toBe(second);
    expect(approvedDocumentReplayName(queue, {}, exposed)).toBeUndefined();
    expect(queue.assertDrained).not.toThrow();
  });

  it("refuses a malformed stored semantic approval before formatting server-only fields", () => {
    const formatted: unknown[] = [];
    expect(() =>
      buildApprovalContinuation(
        [
          {
            kind: "memory_semantic_undo",
            request: {
              mutationId: "original",
              entity: "namespace",
              reason: "Owner request",
              expectedContent: "Private server-owned fact",
              botId: "bound-bot",
            },
          },
        ],
        (request) => {
          formatted.push(request);
          return JSON.stringify(request);
        },
      ),
    ).toThrow();
    expect(formatted).toEqual([]);
  });

  it.each([
    { kind: "save_memory", input: { content: "Reviewed fact", reason: "Owner request" } },
    {
      kind: "forget_memory",
      input: {
        id: "fact",
        entity: "namespace",
        expectedContent: "Reviewed fact",
        reason: "Owner request",
      },
    },
    {
      kind: "memory_semantic_undo",
      input: { mutationId: "original", id: "fact", entity: "namespace", reason: "Owner request" },
    },
  ])(
    "gives $kind schema-valid model arguments while retaining its complete approved request",
    ({ kind, input }) => {
      const request = {
        ...input,
        botId: "bound-bot",
        scope: "isolated",
        provider: "bound-provider",
        configurationRevision: "bound-revision",
        ...(kind === "memory_semantic_undo"
          ? { expectedContent: "Server-owned receipt content" }
          : {}),
      };
      const effects = [{ kind, request }];
      const continuation = buildApprovalContinuation(effects, JSON.stringify);
      const call = continuation!.split("\n").at(-1)!;
      expect(call).toMatch(new RegExp(`^${kind}: `));
      expect(JSON.parse(call.slice(kind.length + 2))).toEqual(input);
      expect(continuation).not.toContain("bound-bot");
      expect(continuation).not.toContain("Server-owned receipt content");
      const queue = createApprovedEffectReplayQueue(effects);
      expect(
        approvedReplayArgs(queue.take(kind), { id: "model-replacement" }, "__rakazoCatalogTool"),
      ).toEqual(request);
    },
  );

  it.each([
    ["MCP", "install-mcp", "notes.write"],
    ["API", "install-api", "createContact"],
  ])("replays a pre-namespaced installed %s approval", (_kind, resourceId, toolName) => {
    const [tool] = disambiguateInstalledToolNames([
      {
        name: toolName,
        description: toolName,
        inputSchema: { type: "object" },
        route: { connectorId: "installed", resourceId, toolName },
      },
    ]);
    const request = catalogApprovalRequest(
      "installed_execute_tool",
      { id: `${resourceId}:${toolName}`, arguments: {} },
      "__rakazoCatalogTool",
    );
    const queue = createApprovedEffectReplayQueue([{ kind: toolName, request }]);

    expect(tool!.name).toBe(toolName);
    expect(queue.take(tool!.name)).toEqual(request);
    expect(queue.assertDrained).not.toThrow();
  });

  it("lists and replays every approved request in FIFO order when a tool repeats", () => {
    const effects = [
      { kind: "destination.write", request: { sequence: 1 } },
      { kind: "destination.write", request: { sequence: 2 } },
    ];

    const continuation = buildApprovalContinuation(effects, JSON.stringify);
    expect(continuation).toContain(
      "Call each listed approved request exactly once, in the listed order",
    );
    expect(continuation?.indexOf('{"sequence":1}')).toBeLessThan(
      continuation?.indexOf('{"sequence":2}') ?? -1,
    );

    const queue = createApprovedEffectReplayQueue(effects);
    expect(queue.take("destination.write")).toEqual({ sequence: 1 });
    expect(queue.assertDrained).toThrow("Approved tool requests were not fully replayed");
    expect(queue.take("destination.write")).toEqual({ sequence: 2 });
    expect(queue.take("destination.write")).toBeUndefined();
    expect(queue.assertDrained).not.toThrow();
  });

  it("uses a stable secondary key when approval timestamps match", () => {
    expect(APPROVED_EFFECT_REPLAY_ORDER).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("replays an approved lazy tool through the exposed catalog executor", () => {
    const continuation = buildApprovalContinuation(
      [
        {
          kind: "mcp__demo__send_message",
          request: catalogApprovalRequest(
            "mcp_execute_tool",
            { id: "server-1:send_message", arguments: { text: "approved exactly" } },
            "__rakazoCatalogTool",
          ),
        },
      ],
      JSON.stringify,
    );

    expect(continuation).toContain(
      'mcp_execute_tool: {"id":"server-1:send_message","arguments":{"text":"approved exactly"}}',
    );
    expect(continuation).not.toContain("__rakazoCatalogTool");
  });

  it("renders a direct tool continuation when a catalog approval's wrapper is no longer exposed", () => {
    const request = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:notes.write", arguments: { text: "approved exactly" } },
      "__rakazoCatalogTool",
    );
    const stillCatalog = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["installed_execute_tool", "installed_search_tools"]) },
    );
    const afterShrink = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["notes.write"]) },
    );
    const afterShrinkUniquified = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["installed__install-A__notes.write"]) },
    );

    expect(stillCatalog).toContain(
      'installed_execute_tool: {"id":"install-A:notes.write","arguments":{"text":"approved exactly"}}',
    );
    expect(afterShrink).toContain('notes.write: {"text":"approved exactly"}');
    expect(afterShrink).not.toContain("installed_execute_tool:");
    expect(afterShrinkUniquified).toContain(
      'installed__install-A__notes.write: {"text":"approved exactly"}',
    );
  });

  it("keeps a direct-tool argument named like the catalog marker in continuation JSON", () => {
    const continuation = buildApprovalContinuation(
      [
        {
          kind: "notes.write",
          request: {
            id: "row-1",
            arguments: { mode: "strict" },
            text: "approved exactly",
            __rakazoCatalogTool: "installed_execute_tool",
          },
        },
      ],
      JSON.stringify,
    );

    expect(continuation).toContain(
      'notes.write: {"id":"row-1","arguments":{"mode":"strict"},"text":"approved exactly","__rakazoCatalogTool":"installed_execute_tool"}',
    );
  });

  it("renders a catalog wrapper continuation when a bound direct tool is no longer exposed", () => {
    const request = boundDirectApprovalRequest(
      { connectorId: "installed", resourceId: "install-A", toolName: "notes.write" },
      { text: "approved exactly" },
      "__rakazoCatalogTool",
    );
    const stillDirect = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["notes.write"]) },
    );
    const afterGrowth = buildApprovalContinuation(
      [{ kind: "notes.write", request }],
      JSON.stringify,
      { exposedToolNames: new Set(["installed_execute_tool"]) },
    );

    expect(stillDirect).toContain('notes.write: {"text":"approved exactly"}');
    expect(afterGrowth).toContain(
      'installed_execute_tool: {"id":"install-A:notes.write","arguments":{"text":"approved exactly"}}',
    );
    expect(afterGrowth).not.toContain("notes.write:");
  });

  it("renders a uniquified direct name when collision renames the tool under the direct limit", () => {
    const request = boundDirectApprovalRequest(
      { connectorId: "installed", resourceId: "install-A", toolName: "delete_item" },
      { target: "approved" },
      "__rakazoCatalogTool",
    );
    const continuation = buildApprovalContinuation(
      [{ kind: "delete_item", request }],
      JSON.stringify,
      {
        exposedToolNames: new Set([
          "installed__install-A__delete_item",
          "installed__install-B__delete_item",
        ]),
      },
    );

    expect(continuation).toContain('installed__install-A__delete_item: {"target":"approved"}');
    expect(continuation).not.toContain("installed_execute_tool:");
    expect(continuation).not.toMatch(/(^|\n)delete_item:/);
  });

  it("keeps the original approval effect key after collision uniquify", () => {
    const args = { target: "approved" };
    const original = approvalEffectKey("run", "delete_item", args);
    const uniquified = approvalEffectKey("run", "installed__install-A__delete_item", args);
    expect(original).not.toBe(uniquified);
    const replayName = approvalReplayEffectToolName(
      "installed__install-A__delete_item",
      "delete_item",
      true,
    );
    expect(approvalEffectKey("run", replayName, args)).toBe(original);
  });

  it("pins lazy approval replay to the approved source when tool names collide", () => {
    const effects = [
      {
        kind: "delete_item",
        request: catalogApprovalRequest(
          "installed_execute_tool",
          { id: "install-A:delete_item", arguments: { target: "approved" } },
          "__rakazoCatalogTool",
        ),
      },
    ];
    const queue = createApprovedEffectReplayQueue(effects);
    const replay = approvedCatalogReplay(
      queue,
      "installed_execute_tool",
      "__rakazoCatalogTool",
      true,
    );
    const modelRuntimeArgs = {
      id: "install-B:delete_item",
      arguments: { target: "model-reconstructed" },
    };
    const tools: ConnectorTool[] = ["install-A", "install-B"].map((resourceId) => ({
      name: "delete_item",
      description: "Delete one item",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
      route: { connectorId: "installed", resourceId, toolName: "delete_item" },
    }));

    const resolved = resolveCatalogCall(
      {
        tool: "installed_execute_tool",
        args: replay.args ?? modelRuntimeArgs,
        executionId: "approved",
        route: { connectorId: "installed", toolName: "__catalog_execute" },
      },
      catalogEntries(tools),
    );

    expect(resolved.call.route?.resourceId).toBe("install-A");
    expect(resolved.call.args).toEqual({ target: "approved" });
  });

  it("keeps resolveCall parsed args when draining an approved catalog replay", () => {
    const marker = "__rakazoCatalogTool";
    const approvedRequest = catalogApprovalRequest(
      "installed_execute_tool",
      { id: "install-A:create_item", arguments: {} },
      marker,
    );
    const queue = createApprovedEffectReplayQueue([
      { kind: "create_item", request: approvedRequest },
    ]);
    const replay = approvedCatalogReplay(queue, "installed_execute_tool", marker, true);
    const tool: ConnectorTool = {
      name: "create_item",
      description: "Create one item",
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer", default: 3 } },
        additionalProperties: false,
      },
      route: { connectorId: "installed", resourceId: "install-A", toolName: "create_item" },
    };
    const resolved = resolveCatalogCall(
      {
        tool: "installed_execute_tool",
        args: replay.args!,
        executionId: "approved",
        route: { connectorId: "installed", toolName: "__catalog_execute" },
      },
      catalogEntries([tool]),
    );
    const replayed = approvedReplayArgs(queue.take(tool.name)!, resolved.call.args, marker);

    expect(resolved.call.args).toEqual({ count: 3 });
    expect(replayed).toEqual({ count: 3 });
    expect(replayed).not.toEqual({});
    expect(approvalEffectKey("run", tool.name, replayed)).toBe(
      approvalEffectKey("run", tool.name, resolved.call.args),
    );
    expect(queue.assertDrained).not.toThrow();
  });

  it("preserves direct approved args that use the catalog marker as data", () => {
    const approvedRequest = {
      __rakazoCatalogTool: "user-provided-value",
      target: "approved",
    };

    expect(
      approvedReplayArgs(
        approvedRequest,
        { __rakazoCatalogTool: "user-provided-value", target: "reconstructed" },
        "__rakazoCatalogTool",
      ),
    ).toEqual(approvedRequest);
  });
});
