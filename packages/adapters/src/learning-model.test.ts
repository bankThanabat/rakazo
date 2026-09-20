import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { runLearningModel } from "./learning-model.js";

const request: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "Synthetic correction",
  instructions: "Return JSON",
  history: [],
  tools: [],
  allowBuiltinTools: false,
  model: { provider: "test", id: "offline" },
};
const context = (signal: AbortSignal): AdapterContext => ({
  spaceId: "space",
  userId: "owner",
  operationId: "learning",
  traceId: "learning",
  signal,
});
it("accepts fenced JSON from an adapter without changing the tool-free request", async () => {
  const run = vi.fn(async function* () {
    yield { type: "done" as const, text: '```json\n{"compatible":true}\n```' };
  });
  expect(await runLearningModel({ run }, request, context(new AbortController().signal))).toEqual({
    compatible: true,
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ tools: [], allowBuiltinTools: false, history: [] }),
    expect.anything(),
  );
});
it("rejects a late provider result after the shared deadline aborts", async () => {
  const controller = new AbortController();
  const runtime: Pick<AgentRuntime, "run"> = {
    async *run() {
      controller.abort();
      yield { type: "done", text: '{"compatible":true}' };
    },
  };
  await expect(runLearningModel(runtime, request, context(controller.signal))).rejects.toThrow();
});
it("does not start another model stage after an abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const run = vi.fn(async function* () {
    yield { type: "done" as const, text: "{}" };
  });
  await expect(runLearningModel({ run }, request, context(controller.signal))).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
it("refuses an oversized response before parsing it", async () => {
  const runtime: Pick<AgentRuntime, "run"> = {
    async *run() {
      yield { type: "done", text: JSON.stringify({ compatible: true, extra: "x".repeat(20000) }) };
    },
  };
  await expect(
    runLearningModel(runtime, request, context(new AbortController().signal)),
  ).rejects.toThrow("too large");
});
