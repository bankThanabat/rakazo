// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ snapshot: vi.fn(), updateCase: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { customers: api } }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  ProfileAvatar: () => null,
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));

import { CustomerThread } from "./CustomerInbox";
import { SupportWidget } from "./SupportWidget";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.updateCase.mockResolvedValue({ ok: true });
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

it("keeps loaded visitor history across moving windows and catches up after reconnecting", async () => {
  window.history.replaceState(null, "", "/support/channel?origin=http%3A%2F%2Flocalhost");
  let latest = 199;
  const fetch = vi.fn(async (url: string) => {
    const before = Number(new URL(url, location.origin).searchParams.get("before")) || latest + 1;
    const last = Math.min(latest, before - 1);
    const first = Math.max(1, last - 99);
    const messages = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => ({
      id: `message-${first + i}`,
      seq: first + i,
      body: `Transcript ${first + i}.`,
      role: "customer",
    }));
    return Response.json({
      owner: "staff",
      needsHuman: false,
      state: "open",
      messages,
      before: messages.length === 100 ? first : null,
    });
  });
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<SupportWidget />));
  await act(async () => button("Open support").click());
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "http://localhost",
        data: { type: "support-session", channel: "channel", token: "x".repeat(43) },
      }),
    ),
  );
  await act(async () => button("Earlier messages").click());
  expect(container.textContent).toContain("Transcript 1.");
  expect(container.textContent).toContain("Transcript 100.");
  latest = 200;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.textContent).toContain("Transcript 100.");
  expect(container.textContent).toContain("Transcript 200.");
  latest = 401;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  for (let seq = 1; seq <= latest; seq++)
    expect(container.textContent).toContain(`Transcript ${seq}.`);
});

it("shows action outcomes from the displayed historical page", async () => {
  const conversation = { id: "case", name: "Customer", canReply: false };
  const message = (seq: number) => ({
    id: `m${seq}`,
    seq,
    role: "customer",
    body: `Transcript ${seq}.`,
  });
  api.snapshot.mockImplementation(async ({ before }: { before?: number }) => ({
    conversation,
    messages: [message(before ? 1 : 201)],
    before: before ? null : 201,
    actions: before
      ? [
          {
            name: "Historical refund",
            status: "completed",
            outcome: "Confirmed refund",
            createdAt: "2026-01-01",
          },
        ]
      : [],
  }));
  await act(async () =>
    root.render(<CustomerThread id="case" onOpenNavigation={() => undefined} />),
  );
  await act(async () => button("Earlier messages").click());
  expect(container.textContent).toContain("Transcript 1.");
  expect(container.textContent).toContain("Historical refund");
  expect(container.textContent).toContain("Confirmed refund");
  await act(async () => button("Latest messages").click());
  expect(container.textContent).not.toContain("Historical refund");
});
