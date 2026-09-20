// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ rpc: api }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../lib/native", () => ({ useThemedStyles: (create: () => unknown) => create() }));
vi.mock("../lib/i18n", () => ({
  useI18n: () => ({ t: (value: string) => value, locale: "en" }),
  dateLocaleForUi: () => "en-US",
}));
vi.mock("react-native", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Container,
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      editable,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      accessibilityLabel: string;
      editable: boolean;
    }) => (
      <input
        aria-label={accessibilityLabel}
        value={value}
        disabled={!editable}
        onInput={(event) => onChangeText(event.currentTarget.value)}
      />
    ),
    Text: Container,
    ScrollView: Container,
    ActivityIndicator: () => <span>Loading</span>,
    StyleSheet: { create: (value: unknown) => value },
    Pressable: ({
      children,
      disabled,
      onPress,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress: () => void;
    }) => (
      <button disabled={disabled} type="button" onClick={onPress}>
        {children}
      </button>
    ),
  };
});

import { SemanticMemoryHistory } from "./semantic-memory-history";

it("native history reads unknown outcomes and the original full version, then clears content on lost access", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const item = {
    id: "undo",
    operation: "undo_save",
    status: "uncertain",
    provider: "test",
    scope: "isolated",
    createdAt: "2026-01-02T12:00:00Z",
    updatedAt: "2026-01-02T12:00:00Z",
    reversesId: "original",
  };
  api.mockImplementation(async (path: string, input: { mutationId?: string }) => {
    if (path === "semanticMemory/history") return { items: [item], nextCursor: null };
    if (path === "semanticMemory/detail")
      return {
        ...item,
        ...(input.mutationId === "original"
          ? { id: "original", operation: "save", status: "completed", reversesId: null }
          : {}),
        botName: "Synthetic bot",
        sourceThreadId: null,
        reason: "Synthetic correction",
        requestedContent: "Full private snapshot",
        changes: [
          {
            id: "fact",
            entity: null,
            before: { state: "unknown", content: null },
            after: { state: "unknown", content: null },
          },
        ],
        uncertainEntities: [],
      };
    throw new Error("Unexpected API");
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(
      (entry) => entry.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<SemanticMemoryHistory botId="bot" />));
    await click("Provider memory history");
    await click("Undo memory save · Outcome unknown");
    expect(host.textContent).toContain("The provider outcome is unknown.");
    expect(host.textContent).not.toContain("Source conversation");
    expect(host.textContent).toContain("Unavailable");
    await click("Original change");
    expect(api).toHaveBeenLastCalledWith("semanticMemory/detail", {
      botId: "bot",
      mutationId: "original",
    });
    expect(host.textContent).toContain("Full private snapshot");
    api.mockRejectedValueOnce(new Error("Access revoked"));
    await click("Reload history");
    expect(host.textContent).not.toContain("Full private snapshot");
    expect(host.textContent).toContain("Could not load history. Try again.");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    api.mockReset();
  }
});

it("native history previews complete content before applying the exact staff reversal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const content = "Native complete fact. ".repeat(300);
  const item = {
    id: "original",
    operation: "save",
    status: "completed",
    provider: "test",
    scope: "isolated",
    createdAt: "2026-01-01T12:00:00Z",
    updatedAt: "2026-01-01T12:00:00Z",
    reversesId: null,
  };
  api.mockImplementation(async (path: string, input: { mutationId?: string }) => {
    if (path === "semanticMemory/history") return { items: [item], nextCursor: null };
    if (path === "semanticMemory/detail")
      return {
        ...item,
        ...(input.mutationId === "removed"
          ? { id: "removed", operation: "undo_save", reversesId: "original" }
          : {}),
        botName: "Test bot",
        reason: "Staff preference",
        sourceThreadId: null,
        requestedContent: content,
        uncertainEntities: [],
        changes: [
          {
            id: "fact",
            entity: "private-bot",
            before: { state: "absent", content: null },
            after: { state: "recorded", content },
          },
        ],
      };
    if (path === "semanticMemory/preview")
      return {
        version: "a".repeat(64),
        action: "forget",
        content,
        provider: "test",
        scope: "isolated",
      };
    if (path === "semanticMemory/apply") return { mutationId: "removed", status: "completed" };
    throw new Error("Unexpected API");
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing ${label}`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<SemanticMemoryHistory botId="bot" />));
    await click("Provider memory history");
    await click("Save memory · Confirmed");
    await click("Review undo");
    const field = host.querySelector("input")!;
    await act(async () => {
      field.value = "Native staff review";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Preview change");
    expect(host.textContent).toContain("Remove this fact");
    expect(host.textContent).toContain(content);
    expect(api.mock.calls.some(([path]) => path === "semanticMemory/apply")).toBe(false);
    api.mockRejectedValueOnce(new Error("Lost response"));
    await click("Confirm removal");
    expect(host.textContent).not.toContain(content);
    expect(host.textContent).toContain("Could not confirm the change. Retry or reload history.");
    const originalInput = api.mock.calls.at(-1)?.[1];
    await click("Retry confirmation");
    const confirmations = api.mock.calls.filter(([path]) => path === "semanticMemory/apply");
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]?.[1]).toEqual(originalInput);
    expect(api).toHaveBeenCalledWith("semanticMemory/apply", {
      botId: "bot",
      mutationId: "original",
      id: "fact",
      entity: "private-bot",
      reason: "Native staff review",
      version: "a".repeat(64),
      clientNonce: expect.any(String),
    });
    expect(host.textContent).toContain("Undo memory save · Confirmed");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    api.mockReset();
  }
});
