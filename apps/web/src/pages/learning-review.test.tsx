// @vitest-environment jsdom
import type { LearningReviewApi } from "@rakazo/chat-ui/learning-review";
import { useLearningReview } from "@rakazo/chat-ui/learning-review";
import type { LearningTaskDetail, LearningTaskPage } from "@rakazo/contracts";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const detail: LearningTaskDetail = {
  task: {
    id: "task",
    status: "review",
    targetKind: "memory",
    error: null,
    documentId: null,
    appliedRevision: null,
    reviewReason: null,
    createdAt: "2026-09-19T00:00:00Z",
    reviews: [],
    proposal: {
      native: {
        kind: "memory",
        scope: "bot",
        path: "customer-learning.md",
        expectedRevision: 0,
        beforeContent: "",
        content: "Complete private content. ".repeat(300),
      },
      supported: true,
      publicSafe: false,
      changesBusinessRules: false,
      conditions: "Sizing questions",
      save: {
        botId: "bot",
        scope: "bot",
        kind: "memory",
        key: "customer-learning",
        title: "Sizing",
        content: "Sizing guidance",
        customerVisible: false,
        expectedRevision: 0,
        reason: "Correction",
        source: "Staff correction",
      },
    },
  },
  before: { title: "customer-learning.md", content: "", customerVisible: false },
  after: {
    title: "customer-learning.md",
    content: "Complete private content. ".repeat(300),
    customerVisible: false,
  },
  scope: "private-bot",
  currentRevision: 0,
  stale: false,
  canEdit: true,
};
const emptyPage: LearningTaskPage = { items: [], nextCursor: null };
let review: ReturnType<typeof useLearningReview>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const api = {
  taskList: vi.fn<LearningReviewApi["taskList"]>(),
  task: vi.fn<LearningReviewApi["task"]>(),
  decideTask: vi.fn<LearningReviewApi["decideTask"]>(),
  previewUndo: vi.fn<LearningReviewApi["previewUndo"]>(),
  undo: vi.fn<LearningReviewApi["undo"]>(),
};
function Probe({ botId = "bot", ids }: { botId?: string; ids?: string[] }) {
  review = useLearningReview(api, botId, ids);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.taskList.mockResolvedValue(emptyPage);
  api.task.mockResolvedValue(detail);
  api.decideTask.mockResolvedValue({ status: "applied" });
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("sends the full reviewed snapshot once and holds the lock through reload", async () => {
  await act(async () => review.select("task"));
  await act(async () => review.setReason("Reviewed every condition"));
  const save = deferred<{ status: string }>();
  const reload = deferred<LearningTaskDetail>();
  api.decideTask.mockReturnValueOnce(save.promise);
  api.task.mockReturnValueOnce(reload.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = review.decide("approve");
    void review.decide("approve");
  });
  expect(api.decideTask).toHaveBeenCalledTimes(1);
  expect(api.decideTask).toHaveBeenCalledWith({
    botId: "bot",
    taskId: "task",
    decision: "approve",
    reason: "Reviewed every condition",
    expectedStatus: "review",
    reviewedProposal: detail.task.proposal,
  });
  expect(review.busy).toBe(true);
  await act(async () => save.resolve({ status: "applied" }));
  expect(review.current).toBeUndefined();
  expect(review.busy).toBe(true);
  await act(async () => {
    reload.resolve({ ...detail, task: { ...detail.task, status: "applied" } });
    await pending;
  });
  expect(review.busy).toBe(false);
  expect(review.current!.task.status).toBe("applied");
});
it("does not offer stale approval after a successful decision whose reload fails", async () => {
  await act(async () => review.select("task"));
  await act(async () => review.setReason("Reviewed"));
  api.task.mockRejectedValueOnce(new Error("Reload interrupted"));
  await act(async () => review.decide("approve"));
  expect(review.notice).toBe("saved");
  expect(review.error).toBe(true);
  expect(review.current).toBeUndefined();
  expect(review.busy).toBe(false);
});
it("ignores an old bot request without unlocking the new bot request", async () => {
  const old = deferred<LearningTaskDetail>();
  const current = deferred<LearningTaskDetail>();
  api.task.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  let oldRead!: Promise<void>;
  let newRead!: Promise<void>;
  await act(async () => {
    oldRead = review.select("task");
  });
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe botId="new-bot" />
      </StrictMode>,
    ),
  );
  expect(review.current).toBeUndefined();
  await act(async () => {
    newRead = review.select("new-task");
  });
  await act(async () => {
    old.resolve(detail);
    await oldRead;
  });
  expect(review.current).toBeUndefined();
  expect(review.busy).toBe(true);
  await act(async () => {
    current.resolve({ ...detail, task: { ...detail.task, id: "new-task" } });
    await newRead;
  });
  expect(review.current!.task.id).toBe("new-task");
  expect(review.busy).toBe(false);
});
it("ignores a late decision after unmount without starting reloads", async () => {
  await act(async () => review.select("task"));
  await act(async () => review.setReason("Reviewed"));
  const save = deferred<{ status: string }>();
  api.decideTask.mockReturnValueOnce(save.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = review.decide("approve");
  });
  await act(async () => root.render(null));
  await act(async () => {
    save.resolve({ status: "applied" });
    await pending;
  });
  expect(api.task).toHaveBeenCalledTimes(1);
  expect(api.taskList).not.toHaveBeenCalled();
});
it("keeps the summary ids on pagination and selects a retry child outside that summary", async () => {
  await act(async () => root.render(<Probe ids={["task"]} />));
  const { proposal: _proposal, reviews: _reviews, ...metadata } = detail.task;
  api.taskList.mockResolvedValueOnce({
    items: [{ ...metadata, title: "Sizing" }],
    nextCursor: "task",
  });
  await act(async () => review.toggle());
  await act(async () => review.more());
  expect(api.taskList).toHaveBeenLastCalledWith({ botId: "bot", ids: ["task"], cursor: "task" });
  expect(review.list!.items).toHaveLength(1);
  await act(async () => review.select("task"));
  await act(async () => review.setReason("Reconsider"));
  api.decideTask.mockResolvedValueOnce({ status: "queued", taskId: "child" });
  api.task.mockResolvedValueOnce({
    ...detail,
    task: { ...detail.task, id: "child", status: "queued" },
  });
  await act(async () => review.decide("retry"));
  expect(review.current!.task.id).toBe("child");
  expect(review.notice).toBe("queued");
  expect(api.decideTask).toHaveBeenLastCalledWith(
    expect.objectContaining({ reviewedProposal: detail.task.proposal }),
  );
});
it("requires a decision reason", async () => {
  await act(async () => review.select("task"));
  await act(async () => review.decide("approve"));
  expect(api.decideTask).not.toHaveBeenCalled();
});
