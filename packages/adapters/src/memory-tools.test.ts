import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { bindSemanticMemoryRemoval, selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("memory_semantic_undo"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps semantic memory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual([
      "recall_memory",
      "save_memory",
      "forget_memory",
      "memory_semantic_undo",
      "shell",
    ]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});

describe("semantic memory removal scope", () => {
  const binding = {
    botId: "bot-1",
    scope: "isolated" as const,
    provider: "serenity",
    configurationRevision: "config-1:revision-1",
  };
  const fact = { id: "fact-1", expectedContent: "Use metric units." };
  it("binds approval to server scope and strips model-supplied authority", () => {
    expect(
      bindSemanticMemoryRemoval(
        {
          ...fact,
          botId: "other-bot",
          scope: "shared",
          provider: "other-provider",
          extra: "ignored",
        },
        binding,
        false,
      ),
    ).toEqual({ ...fact, ...binding });
  });
  it("preserves an exact approved request after recovery", () => {
    expect(bindSemanticMemoryRemoval({ ...fact, ...binding }, binding, true)).toEqual({
      ...fact,
      ...binding,
    });
  });
  it.each(["botId", "scope", "provider", "configurationRevision"])(
    "refuses an approved request after %s changes",
    (field) => {
      expect(() =>
        bindSemanticMemoryRemoval({ ...fact, ...binding, [field]: "different" }, binding, true),
      ).toThrow("changed");
    },
  );
  it.each([
    {},
    { id: "fact-1" },
    { ...fact, expectedContent: "  " },
    { ...fact, expectedContent: "x".repeat(10001) },
  ])("requires complete bounded content: %j", (input) => {
    expect(() => bindSemanticMemoryRemoval(input, binding, false)).toThrow();
  });
  it("requires new approval for legacy requests without bound scope", () => {
    expect(() => bindSemanticMemoryRemoval(fact, binding, true)).toThrow("changed");
  });
});
