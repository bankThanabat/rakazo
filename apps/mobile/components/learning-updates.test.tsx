// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ rpc: api }));
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../lib/native", () => ({ useThemedStyles: (create: () => unknown) => create() }));
vi.mock("../lib/i18n", () => ({
  useI18n: () => ({ t: (value: string) => value, locale: "en" }),
  dateLocaleForUi: () => "en-US",
}));
vi.mock("./learning-evidence", () => ({ LearningEvidence: () => null }));
vi.mock("./private-history", () => ({ PrivateHistoryReview: () => null }));
vi.mock("react-native", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Container,
    Text: Container,
    ScrollView: Container,
    ActivityIndicator: () => <span>Loading</span>,
    StyleSheet: { create: (styles: unknown) => styles },
    Switch: () => null,
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
    TextInput: ({
      value,
      onChangeText,
      editable,
      accessibilityLabel,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      editable: boolean;
      accessibilityLabel: string;
    }) => (
      <input
        aria-label={accessibilityLabel}
        value={value}
        disabled={!editable}
        onInput={(event) => onChangeText(event.currentTarget.value)}
      />
    ),
  };
});

import { LearningUpdates } from "./learning-updates";

it("lets a downgraded Space owner reject the reviewed proposal while approval stays disabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const proposal = {
    supported: true,
    publicSafe: true,
    changesBusinessRules: true,
    conditions: "Sizing questions",
    save: {
      botId: "bot",
      scope: "space",
      kind: "knowledge",
      key: "sizing",
      title: "Sizing policy",
      content: "Ask for the garment measurements.",
      customerVisible: false,
      expectedRevision: 0,
      reason: "Correction",
      source: "Staff",
    },
  };
  const task = {
    id: "task",
    status: "review",
    proposal,
    reviews: [],
    createdAt: "2026-09-19T00:00:00Z",
    targetKind: "document",
    documentId: null,
    appliedRevision: null,
  };
  let rejected = false;
  api.mockImplementation(async (path: string) => {
    if (path === "learning/taskList")
      return { items: [{ ...task, title: "Sizing policy" }], nextCursor: null };
    if (path === "learning/task")
      return {
        task: { ...task, status: rejected ? "rejected" : "review" },
        scope: "space",
        before: { title: "", content: "", customerVisible: false },
        after: proposal.save,
        currentRevision: 0,
        stale: false,
        canEdit: false,
      };
    if (path === "learning/decideTask") {
      rejected = true;
      return { status: "rejected" };
    }
    throw new Error(`Unexpected call ${path}`);
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith(label),
    );
    if (!found) throw new Error(`Missing ${label}`);
    return found;
  };
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <LearningUpdates botId="bot" />
        </StrictMode>,
      ),
    );
    await act(async () => button("Learning updates").click());
    await act(async () => button("Sizing policy").click());
    const reason = container.querySelector<HTMLInputElement>(
      'input[aria-label="Reason for decision"]',
    )!;
    expect(reason).not.toBeNull();
    await act(async () => {
      reason.value = "Does not apply to this shop";
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Approve change").disabled).toBe(true);
    expect(button("Reject").disabled).toBe(false);
    expect(button("Regenerate").disabled).toBe(false);
    await act(async () => button("Reject").click());
    expect(api).toHaveBeenCalledWith("learning/decideTask", {
      botId: "bot",
      taskId: "task",
      decision: "reject",
      reason: "Does not apply to this shop",
      expectedStatus: "review",
      reviewedProposal: proposal,
    });
    expect(container.textContent).toContain("Suggestion rejected.");
  } finally {
    await act(async () => root.unmount());
    api.mockReset();
    vi.unstubAllGlobals();
  }
});
