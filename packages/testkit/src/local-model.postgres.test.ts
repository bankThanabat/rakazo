import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.js";
import { sessionCookieHeader } from "./index.js";

// Opt-in live local inference, never part of deterministic offline verification.
// The launcher supplies a disposable database. No merchant accounts or sends.
const enabled = process.env.VERIFY_DATABASE === "1" && process.env.VERIFY_LOCAL_MODEL === "1";
const origin = "http://127.0.0.1:5173";
const server = "http://127.0.0.1:11435";
const modelId = "qwen3.5:9b";

describe.skipIf(!enabled)("free local model through the product", () => {
  it("saves a keyless connection and executes real file tools with Thai text", async () => {
    const tagsResponse = await fetch(`${server}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(tagsResponse.ok).toBe(true);
    const tags = (await tagsResponse.json()) as {
      models: Array<{ name: string; digest: string; remote_host?: string; size: number }>;
    };
    const model = tags.models.find((item) => item.name === modelId);
    expect(model).toBeDefined();
    expect(model!.remote_host).toBeUndefined();
    expect(model!.size).toBeGreaterThan(1_000_000_000);
    const dataDir = await mkdtemp(path.join(tmpdir(), "deskazo-local-model-"));
    let handles: AppHandles | undefined;
    const started = Date.now();
    try {
      const { createApp } = await import("../../../apps/api/src/app.js");
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        cloudAgentProvider: "none",
        encryptionKey: "synthetic-local-model-encryption-key",
      });
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `local-model-${randomUUID()}@example.test`,
          password: "synthetic-password-12",
          name: "Synthetic shop",
        }),
      });
      expect(signup.ok).toBe(true);
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles!.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        if (!response.ok) throw new Error(`${procedure} failed (${response.status})`);
        return ((await response.json()) as { json: T }).json;
      };
      await rpc("models/connect", {
        provider: "openai-compatible",
        modelId,
        baseUrl: `${server}/v1`,
        reasoning: true,
        thinkingLevel: "low",
        maxTokens: 2048,
        contextWindow: 65536,
        supportsImages: false,
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Local model check",
        instructions:
          "Complete the requested file task with the provided tools. Reply in concise Thai.",
        title: "",
        description: "",
        notifyOnFinish: false,
      });
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: "openai-compatible",
        modelId,
        thinkingLevel: "low",
      });
      const sent = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: 'Use write_file to save exactly "จัดส่งภายในสามวันทำการค่ะ" to notes/shipping.txt. Then use read_file to verify the saved content. Reply in Thai after verifying it.',
      });
      await expect
        .poll(
          async () => {
            const run = await handles!.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
            if (["failed", "cancelled", "waiting_input"].includes(run.status))
              throw new Error(`Local inference ended ${run.status}: ${run.error}`);
            return run.status;
          },
          { timeout: 240_000, interval: 250 },
        )
        .toBe("completed");
      const file = await rpc<{ content: string }>("computer/readFile", {
        botId: bot.id,
        path: "notes/shipping.txt",
      });
      const calls = await handles.prisma.event.findMany({
        where: { botId: bot.id, runId: sent.runId, type: "agent.tool.called" },
        select: { payload: true },
      });
      const messages = await handles.prisma.message.findMany({
        where: { runId: sent.runId, role: "bot" },
        select: { blocks: true },
      });
      if (process.env.VERIFY_LOCAL_MODEL_RECEIPT)
        await writeFile(
          process.env.VERIFY_LOCAL_MODEL_RECEIPT,
          JSON.stringify(
            {
              modelId,
              digest: model!.digest,
              size: model!.size,
              baseUrl: `${server}/v1`,
              seconds: (Date.now() - started) / 1000,
              savedConnection: true,
              runtime: "pi",
              thinkingLevel: "low",
              contextWindow: 65536,
              sandbox: "fake",
              fileContent: file.content,
              calls,
              messages,
              limitation:
                "Synthetic file task; not merchant acceptance or native filesystem verification.",
            },
            null,
            2,
          ),
        );
      expect(file.content.trim()).toBe("จัดส่งภายในสามวันทำการค่ะ");
      expect(JSON.stringify(calls)).toContain("write_file");
      expect(JSON.stringify(calls)).toContain("read_file");
      expect(JSON.stringify(messages)).toMatch(/[ก-๙]/);
    } finally {
      try {
        await handles?.stop();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 300_000);
});
