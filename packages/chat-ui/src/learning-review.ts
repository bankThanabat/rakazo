import type {
  LearningRestore,
  LearningTaskDecision,
  LearningTaskDetail,
  LearningTaskList,
  LearningTaskPage,
  LearningUndo,
  LearningUndoPreview,
  LearningVersion,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

export type LearningReviewApi = {
  taskList(input: LearningTaskList): Promise<LearningTaskPage>;
  task(input: { botId: string; taskId: string }): Promise<LearningTaskDetail>;
  decideTask(input: LearningTaskDecision): Promise<{ status: string; taskId?: string }>;
  previewUndo(input: LearningRestore): Promise<LearningUndoPreview>;
  undo(input: LearningUndo): Promise<unknown>;
};

/** Web and native share request lifetime, exact proposal consent, and undo state. */
export function useLearningReview(api: LearningReviewApi, botId: string, ids?: string[]) {
  const key = `${botId}:${ids?.join(",") ?? "all"}`;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<{ key: string; value: LearningTaskPage }>();
  const [detail, setDetail] = useState<{ key: string; value: LearningTaskDetail }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<"saved" | "queued" | "rejected" | null>(null);
  const [reason, setReason] = useState("");
  const [undo, setUndo] = useState<{ input: LearningRestore; preview: LearningUndoPreview }>();
  const [resolved, setResolved] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  const activeKey = useRef(key);
  activeKey.current = key;
  useEffect(() => {
    setOpen(false);
    setPage(undefined);
    setDetail(undefined);
    setUndo(undefined);
    setReason("");
    setError(false);
    setNotice(null);
    setBusy(false);
    return () => {
      generation.current++;
      running.current = false;
    };
  }, [key]);
  const current = detail?.key === key ? detail.value : undefined;
  const list = page?.key === key ? page.value : undefined;
  async function run(work: (alive: () => boolean) => Promise<void>) {
    if (running.current || activeKey.current !== key) return;
    running.current = true;
    const version = generation.current;
    const alive = () => generation.current === version && activeKey.current === key;
    setBusy(true);
    setError(false);
    setNotice(null);
    try {
      await work(alive);
    } catch {
      if (alive()) setError(true);
    } finally {
      if (alive()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function load(alive: () => boolean, more = false) {
    const next = await api.taskList({
      botId,
      ids,
      cursor: more ? (list?.nextCursor ?? undefined) : undefined,
    });
    if (alive())
      setPage({
        key,
        value: more && list ? { ...next, items: [...list.items, ...next.items] } : next,
      });
  }
  async function read(alive: () => boolean, taskId: string) {
    const next = await api.task({ botId, taskId });
    if (alive()) {
      setDetail({ key, value: next });
      setReason("");
      setUndo(undefined);
      setResolved(false);
    }
  }
  return {
    open,
    list,
    current,
    busy,
    error,
    notice,
    reason,
    setReason,
    undo,
    resolved,
    setResolved,
    toggle: () => {
      if (running.current) return;
      setOpen(!open);
      if (!open) void run((alive) => load(alive));
    },
    more: () => run((alive) => load(alive, true)),
    refresh: () =>
      run(async (alive) => {
        await load(alive);
        if (alive() && current) await read(alive, current.task.id);
      }),
    select: (taskId: string) => run((alive) => read(alive, taskId)),
    decide: (decision: "approve" | "reject" | "retry") =>
      run(async (alive) => {
        if (!current || !reason.trim()) return;
        const result = await api.decideTask({
          botId,
          taskId: current.task.id,
          decision,
          reason,
          expectedStatus: current.task.status,
          reviewedProposal: current.task.proposal ?? undefined,
        });
        if (!alive()) return;
        // A retry may return a new task. Keep it selected even outside an older daily summary.
        setReason("");
        setUndo(undefined);
        setDetail(undefined);
        const taskId = result.taskId ?? current.task.id;
        try {
          await read(alive, taskId);
          if (alive()) await load(alive);
        } finally {
          if (alive())
            setNotice(
              result.status === "queued"
                ? "queued"
                : result.status === "rejected"
                  ? "rejected"
                  : "saved",
            );
        }
      }),
    prepareUndo: () =>
      run(async (alive) => {
        if (!current?.task.documentId || !current.task.appliedRevision || !current.currentRevision)
          return;
        const input = {
          botId,
          documentId: current.task.documentId,
          revision: current.task.appliedRevision,
          expectedRevision: current.currentRevision,
        };
        const preview = await api.previewUndo(input);
        if (alive()) {
          setUndo({ input, preview });
          setReason("");
          setResolved(false);
        }
      }),
    changeUndo: (change: Partial<LearningVersion>) =>
      setUndo((value) =>
        value
          ? {
              ...value,
              preview: { ...value.preview, proposed: { ...value.preview.proposed, ...change } },
            }
          : value,
      ),
    cancelUndo: () => {
      if (!running.current) setUndo(undefined);
    },
    applyUndo: () =>
      run(async (alive) => {
        if (!undo || !current || !reason.trim() || (undo.preview.conflicts.length && !resolved))
          return;
        await api.undo({ ...undo.input, resolution: undo.preview.proposed, reason });
        if (!alive()) return;
        setUndo(undefined);
        setReason("");
        setDetail(undefined);
        try {
          await read(alive, current.task.id);
          if (alive()) await load(alive);
        } finally {
          if (alive()) setNotice("saved");
        }
      }),
  };
}
