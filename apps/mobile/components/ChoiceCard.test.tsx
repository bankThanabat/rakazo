// @vitest-environment jsdom
import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ rpc: api }));
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("react-native", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Container,
    Text: Container,
    Alert: { alert },
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
  };
});

import { ChoiceCard } from "./ChoiceCard";

const block: Extract<MessageBlock, { kind: "choice" }> = {
  kind: "choice",
  question: "What would you like to set up first?",
  options: [
    { id: "customers", letter: "A", label: "Customer replies" },
    { id: "voice", letter: "B", label: "My brand voice" },
  ],
};
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function render(answerId?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container);
  await act(async () => root.render(<ChoiceCard botId="bot" block={{ ...block, answerId }} />));
}
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.clearAllMocks();
});
it("saves a choice and prevents another answer before the stream refreshes", async () => {
  api.mockResolvedValue({ ok: true });
  await render();
  await act(async () => button("Customer replies").click());
  expect(api).toHaveBeenCalledWith("onboarding/choose", { botId: "bot", optionId: "customers" });
  expect(container.textContent).toContain("Customer replies");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});
it("retains options after a failed save so the owner can retry", async () => {
  api.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ ok: true });
  await render();
  await act(async () => button("Customer replies").click());
  expect(alert).toHaveBeenCalledWith("Could not submit answer", "Offline");
  expect(button("Customer replies").disabled).toBe(false);
  await act(async () => button("Customer replies").click());
  expect(api).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll("button")).toHaveLength(0);
});
it("dismisses without choosing a business task", async () => {
  api.mockResolvedValue({ ok: true });
  await render();
  await act(async () => button("Dismiss").click());
  expect(api).toHaveBeenCalledWith("onboarding/dismissFocus", { botId: "bot" });
  expect(container.textContent).toBe("");
});
it.each(["customers", "_dismissed"])(
  "honors the saved answer %s after reopening",
  async (answer) => {
    await render(answer);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(api).not.toHaveBeenCalled();
    expect(container.textContent).toBe(
      answer === "_dismissed" ? "" : `${block.question}Customer replies`,
    );
  },
);
