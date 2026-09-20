// @vitest-environment jsdom

import { useSemanticHistory } from "@rakazo/chat-ui/semantic-history";
import type { SemanticMemoryDetail, SemanticMemoryHistory } from "@rakazo/contracts";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const row = (id: string, date = "2026-01-01") => ({
  id,
  operation: "save",
  status: "completed",
  reversesId: null,
  scope: "isolated",
  provider: "test",
  createdAt: `${date}T12:00:00Z`,
  updatedAt: `${date}T12:00:00Z`,
});
const detail = (id: string): SemanticMemoryDetail => ({
  ...row(id),
  botName: "Test bot",
  reason: null,
  sourceThreadId: null,
  requestedContent: "Private fact",
  changes: [],
  uncertainEntities: [],
});
const history = vi.fn<() => Promise<SemanticMemoryHistory>>();
const read = vi.fn<(id: string) => Promise<SemanticMemoryDetail>>();
const preview = vi.fn();
const apply = vi.fn();
let state: ReturnType<typeof useSemanticHistory>;
function Probe() {
  state = useSemanticHistory({
    history,
    detail: read,
    botId: "bot-one",
    nonce: () => "nonce",
    preview,
    apply,
  });
  return <div>{state.detail?.requestedContent}</div>;
}
const host = document.createElement("div");
let root = createRoot(host);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount(key = "bot-one") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe key={key} />
      </StrictMode>,
    ),
  );
}
it("opens an original outside the loaded page and deduplicates it when loading older changes", async () => {
  history.mockResolvedValueOnce({ items: [row("new", "2026-01-10")], nextCursor: "new" });
  read.mockResolvedValue(detail("original"));
  await mount();
  await act(async () => state.toggle());
  await act(async () => state.select("original"));
  expect(state.detail?.id).toBe("original");
  expect(state.page?.items.map((item) => item.id)).toEqual(["new", "original"]);
  history.mockResolvedValueOnce({
    items: [row("middle", "2026-01-05"), row("original")],
    nextCursor: null,
  });
  await act(async () => state.load(true));
  expect(state.page?.items.map((item) => item.id)).toEqual(["new", "middle", "original"]);
  expect(history).toHaveBeenLastCalledWith("new");
});
it("removes private snapshots after a failed read and permits a fresh retry", async () => {
  history.mockResolvedValue({ items: [row("one")], nextCursor: null });
  read.mockResolvedValueOnce(detail("one")).mockRejectedValueOnce(new Error("Access revoked"));
  await mount();
  await act(async () => state.toggle());
  await act(async () => state.select("one"));
  expect(host.textContent).toBe("Private fact");
  await act(async () => state.select("one"));
  expect(state.error).toBe(true);
  expect(state.page).toBeUndefined();
  expect(host.textContent).toBe("");
  await act(async () => state.load());
  expect(state.error).toBe(false);
  expect(state.page?.items).toHaveLength(1);
});
it("ignores a late response after moving to another bot and serializes rapid requests", async () => {
  let finish!: (value: SemanticMemoryHistory) => void;
  history
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce({ items: [row("new-bot")], nextCursor: null });
  await mount();
  await act(async () => {
    state.toggle();
    state.toggle();
  });
  expect(history).toHaveBeenCalledTimes(1);
  await mount("bot-two");
  await act(async () => state.toggle());
  await act(async () => finish({ items: [row("private-old-bot")], nextCursor: null }));
  expect(state.page?.items.map((item) => item.id)).toEqual(["new-bot"]);
});

const fact = {
  id: "fact",
  entity: "private-bot",
  before: { state: "absent" as const, content: null },
  after: { state: "recorded" as const, content: "Full fact" },
};
async function prepareReview() {
  history.mockResolvedValue({ items: [row("original")], nextCursor: null });
  read.mockResolvedValue({ ...detail("original"), changes: [fact] });
  preview.mockResolvedValue({
    version: "a".repeat(64),
    action: "forget",
    content: "Full fact",
    provider: "test",
    scope: "isolated",
  });
  await mount();
  await act(async () => state.toggle());
  await act(async () => state.select("original"));
  await act(async () => state.startReview(fact));
  await act(async () => state.setReason(" Staff correction "));
  await act(async () => state.preview());
}
it("binds the full preview to the selected fact and invalidates it when the reason changes", async () => {
  await prepareReview();
  expect(state.review?.input).toEqual({
    botId: "bot-one",
    mutationId: "original",
    id: "fact",
    entity: "private-bot",
    reason: "Staff correction",
    version: "a".repeat(64),
    clientNonce: "nonce",
  });
  await act(async () => state.setReason("Different reason"));
  expect(state.review).toBeUndefined();
  await act(async () => state.apply());
  expect(apply).not.toHaveBeenCalled();
});
it("serializes confirmation and inserts the actual returned audit event", async () => {
  await prepareReview();
  let finish!: (value: { mutationId: string; status: string }) => void;
  apply.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  read.mockResolvedValue({
    ...detail("reversed"),
    createdAt: "2026-02-01T12:00:00Z",
    reversesId: "original",
  });
  await act(async () => {
    void state.apply();
    void state.apply();
  });
  expect(apply).toHaveBeenCalledTimes(1);
  await act(async () => finish({ mutationId: "reversed", status: "completed" }));
  expect(state.review).toBeUndefined();
  expect(state.detail?.id).toBe("reversed");
  expect(state.page?.items.map((value) => value.id)).toEqual(["reversed", "original"]);
});
it("clears private snapshots after a lost response and retries the same confirmation", async () => {
  await prepareReview();
  const input = state.review?.input;
  apply.mockRejectedValueOnce(new Error("Lost response"));
  await act(async () => state.apply());
  expect(state.error).toBe(true);
  expect(state.review).toBeUndefined();
  expect(state.detail).toBeUndefined();
  expect(state.page).toBeUndefined();
  expect(state.pending).toEqual(input);
  apply.mockResolvedValue({ mutationId: "reversed", status: "completed" });
  read.mockResolvedValue(detail("reversed"));
  await act(async () => state.apply());
  expect(apply).toHaveBeenNthCalledWith(2, input);
  expect(state.pending).toBeUndefined();
  expect(state.detail?.id).toBe("reversed");
  expect(state.page?.items.map((item) => item.id)).toEqual(["reversed"]);
});
it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT"])(
  "discards confirmation after %s instead of retrying a rejected request",
  async (code) => {
    await prepareReview();
    apply.mockRejectedValue(Object.assign(new Error("Change rejected"), { code }));
    await act(async () => state.apply());
    expect(state.pending).toBeUndefined();
    expect(state.review).toBeUndefined();
    await act(async () => state.apply());
    expect(apply).toHaveBeenCalledTimes(1);
  },
);
it("discards an unresolved confirmation when staff reloads history", async () => {
  await prepareReview();
  apply.mockRejectedValue(new Error("Lost response"));
  await act(async () => state.apply());
  await act(async () => state.load());
  expect(state.pending).toBeUndefined();
  await act(async () => state.apply());
  expect(apply).toHaveBeenCalledTimes(1);
});
it("does not retry a confirmed write when reading its result fails", async () => {
  await prepareReview();
  apply.mockResolvedValue({ mutationId: "reversed", status: "completed" });
  read.mockRejectedValue(new Error("Read failed"));
  await act(async () => state.apply());
  expect(state.pending).toBeUndefined();
  expect(state.error).toBe(true);
  await act(async () => state.apply());
  expect(apply).toHaveBeenCalledTimes(1);
});
it("ignores a delayed preview after changing bots", async () => {
  await prepareReview();
  let finish!: (value: unknown) => void;
  preview.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    void state.preview();
  });
  await mount("another-bot");
  await act(async () => finish({ version: "b".repeat(64), content: "Old private fact" }));
  expect(state.review).toBeUndefined();
});
