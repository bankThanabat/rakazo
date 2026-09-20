// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, StrictMode } from "react";
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
    Text: Container,
    ScrollView: Container,
    ActivityIndicator: () => <span>Loading</span>,
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: ({
      children,
      disabled,
      onPress,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress: () => void;
    }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
    Switch: () => null,
    TextInput: () => null,
  };
});

import { PrivateKnowledgeHistory } from "./private-history";

it("keeps native selection locked until the current history request settles through effect replay", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const completions: Array<(value: unknown) => void> = [];
  api.mockImplementation((path: string) => {
    if (path === "memory/list") return Promise.resolve([{ id: "memory", path: "MEMORY.md" }]);
    if (path === "agentSkills/listHistory") return Promise.resolve({ items: [], nextCursor: null });
    if (path === "privateHistory/history")
      return new Promise((resolve) => completions.push(resolve));
    throw new Error(`Unexpected call ${path}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!found) throw new Error(`Missing ${label}`);
    return found;
  };
  const history = {
    title: "MEMORY.md",
    scope: "user",
    revision: 1,
    items: [],
    nextBeforeRevision: null,
  };
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <PrivateKnowledgeHistory />
        </StrictMode>,
      ),
    );
    await act(async () => button("Memory and skill history").click());
    await act(async () => button("MEMORY.md").click());
    expect(completions).toHaveLength(2);
    expect(button("Memory and skill history").disabled).toBe(true);
    await act(async () => completions[0]!(history));
    expect(button("Memory and skill history").disabled).toBe(true);
    await act(async () => completions[1]!(history));
    expect(button("Memory and skill history").disabled).toBe(false);
    expect(button("Reload history").disabled).toBe(false);
  } finally {
    await act(async () => {
      completions.forEach((resolve) => {
        resolve(history);
      });
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    api.mockReset();
  }
});
