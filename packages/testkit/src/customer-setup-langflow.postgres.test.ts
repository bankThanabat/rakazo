import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { ComposioEmulator, EncryptedSecretStore } from "@rakazo/adapters";
import { createLearning } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.js";
import { saveCustomerReplyRuntime } from "../../adapters/src/customer-reply-defaults.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

// Opt in only with the local review Langflow and its installed customer component.
// Real app, Pi, PostgreSQL, Langflow and model bridge. Scripted decisions by default;
// VERIFY_LOCAL_MODEL opts into nondeterministic local inference with synthetic data.
const enabled = process.env.VERIFY_DATABASE === "1" && process.env.VERIFY_LANGFLOW === "1";
const liveLocal = process.env.VERIFY_LOCAL_MODEL === "1";
const testTimeout = liveLocal ? 900_000 : 180_000;
const runtimeUrl = "http://127.0.0.1:17860/api/v1";
const origin = "http://127.0.0.1:5173";

describe.skipIf(!enabled)("staff customer setup through local Langflow", () => {
  it(
    "approves preparation, privately practices approved voice and policy, then enables a website",
    async () => {
      const steps: ModelEmulatorStep[] = [];
      const model = liveLocal
        ? undefined
        : await startModelEmulator({ steps, apiKey: "synthetic-setup-key" });
      const modelId = model?.model.id ?? process.env.VERIFY_LOCAL_MODEL_ID ?? "qwen3.5:9b";
      const modelBase = model?.baseUrl ?? "http://127.0.0.1:11435/v1";
      const started = Date.now();
      const runs: Array<{
        tool: string;
        calls: unknown[];
        messages: unknown[];
        effects: unknown[];
      }> = [];
      let website: unknown;
      let localModel: { name: string; digest: string; size: number } | undefined;
      let learningSetting: { before: boolean; after: boolean } | undefined;
      const customerCalls: Array<{ status: number; inputChecked: boolean; result: unknown }> = [];
      const dataDir = await mkdtemp(path.join(tmpdir(), "deskazo-customer-setup-"));
      let handles: AppHandles | undefined;
      let botId: string | undefined;
      let keyId: string | undefined;
      const keyIds = new Set<string>();
      let token: string | undefined;
      let runtimeKey: string | undefined;
      const previousInternalUrl = process.env.API_INTERNAL_URL;
      const server = serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;
          // Docker can reach only the authenticated execution callbacks, never account APIs.
          if (
            !handles ||
            !["/api/model-bridge/", "/api/customer-tools"].some((p) => pathname.startsWith(p))
          )
            return new Response("Not found", { status: 404 });
          if (!liveLocal || !pathname.endsWith("/v1/chat/completions"))
            return handles.app.fetch(request);
          const input = JSON.stringify(await request.clone().json());
          expect(input).toContain("three business days");
          expect(input).toContain("friendly Thai");
          expect(input).not.toContain("PRIVATE_STAFF_SENTINEL");
          expect(input).not.toContain(runtimeKey!);
          const response = await handles.app.fetch(request);
          customerCalls.push({
            status: response.status,
            inputChecked: true,
            result: await response.clone().json(),
          });
          return response;
        },
      });
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      process.env.API_INTERNAL_URL = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;
      const runtimeRequest = async (route: string, method = "GET", body?: unknown) => {
        const response = await fetch(`${runtimeUrl}/${route}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`Local runtime ${method} failed (${response.status})`);
        return response;
      };
      try {
        if (liveLocal) {
          const response = await fetch("http://127.0.0.1:11435/api/tags", {
            signal: AbortSignal.timeout(5_000),
          });
          expect(response.ok).toBe(true);
          const tags = (await response.json()) as {
            models: Array<{ name: string; digest: string; size: number; remote_host?: string }>;
          };
          const local = tags.models.find((item) => item.name === modelId);
          expect(local?.remote_host).toBeUndefined();
          expect(local?.size).toBeGreaterThan(1_000_000_000);
          localModel = local;
        }
        token = ((await (await runtimeRequest("auto_login")).json()) as { access_token: string })
          .access_token;
        expect(typeof token).toBe("string");
        const key = (await (
          await runtimeRequest("api_key/", "POST", {
            name: `Deskazo setup verification ${randomUUID()}`,
          })
        ).json()) as { id: string; api_key: string };
        keyId = key.id;
        runtimeKey = key.api_key;
        keyIds.add(keyId);
        expect(typeof keyId).toBe("string");
        const encryptionKey = "synthetic-customer-setup-encryption-key";
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
          encryptionKey,
        });
        await saveCustomerReplyRuntime(
          { prisma: handles.prisma, secrets: new EncryptedSecretStore(encryptionKey) },
          {
            baseUrl: runtimeUrl,
            apiKey: key.api_key,
          },
        );
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: `setup-${randomUUID()}@example.test`,
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
          baseUrl: modelBase,
          ...(liveLocal
            ? { reasoning: true, thinkingLevel: "low", maxTokens: 2048, contextWindow: 65536 }
            : { apiKey: "synthetic-setup-key" }),
        });
        botId = (
          await rpc<{ id: string }>("bots/create", {
            name: "Shop staff",
            instructions: "PRIVATE_STAFF_SENTINEL",
            title: "",
            description: "",
            notifyOnFinish: false,
          })
        ).id;
        if (liveLocal)
          await rpc("bots/update", {
            botId,
            modelProvider: "openai-compatible",
            modelId,
            thinkingLevel: "low",
          });
        const bot = await handles.prisma.bot.findUniqueOrThrow({
          where: { id: botId },
          include: { thread: true },
        });
        const actor = { userId: bot.userId, spaceId: bot.spaceId };
        const learning = createLearning(handles.prisma);
        // Owner-approved synthetic knowledge. No model quality or history-import claim.
        for (const [kind, name, content] of [
          ["voice", "brand-voice", "Use concise, friendly Thai. End with ค่ะ."],
          [
            "knowledge",
            "shipping",
            "For this synthetic shop, standard shipping takes three business days.",
          ],
        ] as const)
          await learning.save(actor, {
            botId,
            scope: "space",
            kind,
            key: name,
            title: name,
            content,
            customerVisible: true,
            expectedRevision: 0,
            reason: "Approved synthetic example",
            source: "Fixture owner",
          });

        const tool = (name: string, args: Record<string, unknown>): ModelEmulatorStep => ({
          expect(request) {
            expect(request.tools?.map((t) => t.function.name)).toContain(name);
          },
          response: { type: "tool", id: randomUUID(), name, arguments: args },
        });
        const runTool = async (
          name: string,
          args: Record<string, unknown>,
          approve: boolean,
          during?: ModelEmulatorStep,
        ) => {
          if (model) {
            steps.push(tool(name, args));
            if (approve) steps.push(tool(name, args));
            if (during) steps.push(during);
            steps.push({
              expect(request) {
                const result = request.messages.findLast((message) => message.role === "tool");
                expect(result).toBeDefined();
                expect(String(result!.content)).not.toContain('"error":');
                if (during) expect(String(result!.content)).toContain("จัดส่งภายในสามวันทำการค่ะ");
              },
              response: {
                type: "text",
                text: during ? "Private practice: จัดส่งภายในสามวันทำการค่ะ" : "Verified setup step.",
              },
            });
          }
          const prompts: Record<string, string> = {
            customer_initialize:
              "Prepare private customer replies for this synthetic shop using the approved voice and shipping knowledge already saved. Do not enable a channel or contact customers.",
            customer_preview:
              "Try a private customer sample: ส่งสินค้ากี่วันคะ. Show the actual practice result.",
            customer_website:
              "I have reviewed the private practice result. Enable a website chat called Synthetic shop for https://shop.example.test. Do not connect any other channels.",
          };
          const { runId } = await rpc<{ runId: string }>("threads/send", {
            botId,
            text: liveLocal ? prompts[name]! : `Synthetic setup: ${name}`,
          });
          const recordRun = async () => {
            const calls = await handles!.prisma.event.findMany({
              where: { runId, type: "agent.tool.called" },
              select: { payload: true },
            });
            const messages = await handles!.prisma.message.findMany({
              where: { runId, role: "bot" },
              select: { blocks: true },
            });
            const effects = await handles!.prisma.externalEffect.findMany({
              where: { runId },
              select: { kind: true, request: true, status: true, result: true },
            });
            runs.push({ tool: name, calls, messages, effects });
            return { calls, effects };
          };
          let approved = false;
          const deadline = Date.now() + (liveLocal ? 300_000 : 90_000);
          while (Date.now() < deadline) {
            const run = await handles!.prisma.run.findUniqueOrThrow({ where: { id: runId } });
            if (run.status === "completed") {
              const { calls, effects } = await recordRun();
              if (liveLocal) {
                expect(JSON.stringify(calls)).not.toContain("customer_learning_configure");
                expect(
                  effects.some((effect) => effect.kind === "customer_learning_configure"),
                ).toBe(false);
              }
              expect(approved).toBe(approve);
              model?.assertComplete();
              expect(JSON.stringify(calls)).toContain(name);
              return;
            }
            if (run.status === "failed" || run.status === "cancelled") {
              await recordRun();
              throw new Error(`Setup run ${name} ended ${run.status}: ${run.error}`);
            }
            if (run.status === "waiting_input") {
              if (approved) {
                await recordRun();
                throw new Error(`Setup run ${name} requested unexpected additional input`);
              }
              expect(approve).toBe(true);
              const messages = await handles!.prisma.message.findMany({
                where: { runId },
                orderBy: { createdAt: "desc" },
              });
              const message = messages.find((m) =>
                JSON.stringify(m.blocks).includes('"approvalEffectId"'),
              );
              expect(message).toBeDefined();
              if (liveLocal) {
                const block = (message!.blocks as Array<{ approvalEffectId?: string }>).find(
                  (item) => item.approvalEffectId,
                );
                const effect = await handles!.prisma.externalEffect.findUniqueOrThrow({
                  where: { id: block!.approvalEffectId },
                });
                if (effect.kind !== name) await recordRun();
                expect(effect.runId).toBe(runId);
                expect(effect.kind).toBe(name);
                expect(effect.request).toEqual(args);
              }
              if (name === "customer_initialize")
                expect(await handles!.prisma.customerBehavior.count({ where: { botId } })).toBe(0);
              if (name === "customer_website")
                expect(await handles!.prisma.customerChannel.count({ where: { botId } })).toBe(0);
              await rpc("threads/answer", {
                botId,
                runId,
                messageId: message!.id,
                answer: "allow",
              });
              approved = true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await recordRun();
          throw new Error(`Setup run ${name} timed out`);
        };
        await runTool("customer_initialize", {}, true);
        const behavior = await handles.prisma.customerBehavior.findUniqueOrThrow({
          where: { botId },
        });
        expect(behavior.flowId).toMatch(/^langflow:1:/);
        if (liveLocal) {
          learningSetting = {
            before: bot.learningEnabled,
            after: (await handles.prisma.bot.findUniqueOrThrow({ where: { id: botId } }))
              .learningEnabled,
          };
          expect(learningSetting.after).toBe(learningSetting.before);
        }
        expect(await handles.prisma.botSecret.count({ where: { botId } })).toBe(0);
        expect(await handles.prisma.customerChannel.count({ where: { botId } })).toBe(0);
        const customerAnswer: ModelEmulatorStep = {
          expect(request) {
            const input = JSON.stringify(request.messages);
            expect(input).toContain("three business days");
            expect(input).toContain("friendly Thai");
            expect(input).not.toContain("PRIVATE_STAFF_SENTINEL");
            expect(input).not.toContain(key.api_key);
          },
          response: { type: "text", text: "จัดส่งภายในสามวันทำการค่ะ" },
        };
        await runTool("customer_preview", { message: "ส่งสินค้ากี่วันคะ" }, false, customerAnswer);
        const history = await handles.prisma.message.findMany({
          where: { threadId: bot.thread!.id },
        });
        if (liveLocal) {
          expect(customerCalls.length).toBeGreaterThan(0);
          expect(JSON.stringify(customerCalls)).toMatch(/(?:3|สาม)\s*วันทำการ/);
          expect(customerCalls.every((call) => call.status === 200)).toBe(true);
        } else expect(JSON.stringify(history)).toContain("จัดส่งภายในสามวันทำการค่ะ");
        expect(JSON.stringify(history)).not.toContain(key.api_key);
        expect(await handles.prisma.customerChannel.count({ where: { botId } })).toBe(0);
        await runTool(
          "customer_website",
          { name: "Synthetic shop", origins: ["https://shop.example.test"] },
          true,
        );
        const channel = await handles.prisma.customerChannel.findFirstOrThrow({ where: { botId } });
        expect(channel).toMatchObject({
          name: "Synthetic shop",
          provider: "web",
          enabled: true,
          autoReplies: true,
        });
        website = { name: channel.name, origins: channel.websiteOrigins };
        expect(await handles.prisma.customerConversation.count()).toBe(0);
        // Deliver through the real visitor API only after channel approval.
        const visitorRequest = (route: string, options: RequestInit = {}) =>
          handles!.app.request(`/api/customer-web/${channel.id}/${route}`, {
            ...options,
            headers: {
              origin: "https://shop.example.test",
              "content-type": "application/json",
              ...options.headers,
            },
          });
        const visitorResponse = await visitorRequest("session", { method: "POST", body: "{}" });
        expect(visitorResponse.ok).toBe(true);
        const visitor = (await visitorResponse.json()) as { token: string; conversationId: string };
        const headers = { authorization: `Bearer ${visitor.token}` };
        if (model) steps.push(customerAnswer);
        const body = JSON.stringify({ body: "ส่งสินค้ากี่วันคะ", nonce: randomUUID() });
        for (let retry = 0; retry < 2; retry++)
          expect((await visitorRequest("messages", { method: "POST", headers, body })).status).toBe(
            200,
          );
        const delivered: string[] = [];
        await expect
          .poll(
            async () => {
              const response = await visitorRequest("messages", { headers });
              expect(response.status).toBe(200);
              const transcript = (await response.json()) as {
                messages: Array<{ role: string; body: string }>;
              };
              delivered.splice(
                0,
                delivered.length,
                ...transcript.messages.filter((m) => m.role === "bot").map((m) => m.body),
              );
              return delivered.length;
            },
            { timeout: liveLocal ? 180_000 : 30_000 },
          )
          .toBe(1);
        if (liveLocal) expect(delivered[0]).toMatch(/(?:3|สาม)\s*วันทำการ/);
        else expect(delivered).toEqual(["จัดส่งภายในสามวันทำการค่ะ"]);
        if (liveLocal) {
          const textFor = (tool: string) =>
            runs
              .filter((run) => run.tool === tool)
              .flatMap((run) =>
                (run.messages as Array<{ blocks: Array<{ kind: string; text?: string }> }>)
                  .flatMap((message) => message.blocks)
                  .filter((block) => block.kind === "text")
                  .map((block) => block.text ?? ""),
              )
              .join("\n");
          expect(textFor("customer_initialize")).not.toMatch(
            /managed_customer_runtime|langflow:1:|127\.0\.0\.1:17860|flow id|publication\s*id|customer_(?:preview|inspect|configure|instructions|initialize|reply)|request_human|\*\*runtime\*\*/i,
          );
          expect(textFor("customer_initialize")).not.toMatch(
            /(?:^|\n)(?:\*\*)?(?:Approved |Saved )?(?:Knowledge|Voice)(?::\*\*|:\s*| is\s+)\s*(?:not attached|missing|not configured|unavailable)/im,
          );
          expect(textFor("customer_initialize")).not.toMatch(
            /learning\s+(?:is\s+|was\s+|has been\s+)?(?:paused|disabled|turned off)|(?:paused|disabled|turned off)\s+(?:automatic\s+)?learning/i,
          );
          expect(textFor("customer_website")).toContain(
            `<script src="${origin}/support-widget.js" data-channel="${channel.id}" defer></script>`,
          );
        }
        expect(
          await handles.prisma.customerMessage.count({
            where: { conversationId: visitor.conversationId, role: "customer" },
          }),
        ).toBe(1);
        model?.assertComplete();
        expect(behavior.publicationId).toBeTruthy();
        const publicationId = behavior.publicationId!;
        expect(
          await handles.prisma.customerPublication.findUnique({ where: { id: publicationId } }),
        ).toMatchObject({ status: "active", confirmed: true });
        const publication = await handles.prisma.customerPublication.findUniqueOrThrow({
          where: { id: publicationId },
        });
        const runtimeOwner = (await (await runtimeRequest("users/whoami")).json()) as {
          id: string;
        };
        expect(
          JSON.parse(
            new EncryptedSecretStore(encryptionKey).load(publication.ciphertext, publicationId),
          ).principal,
        ).toBe(`langflow-user:${runtimeOwner.id}`);
        await handles.customers.reconcilePublications();
        await runtimeRequest(`flows/${publicationId}`);
        await rpc("bots/remove", { botId, deleteMemories: true });
        await handles.customers.reconcilePublications();
        // The last completed reply's conservative lease still protects its flow.
        expect(
          await handles.prisma.customerPublication.findUnique({ where: { id: publicationId } }),
        ).not.toBeNull();
        await runtimeRequest(`flows/${publicationId}`);
        const replacement = (await (
          await runtimeRequest("api_key/", "POST", {
            name: `Deskazo cleanup rotation verification ${randomUUID()}`,
          })
        ).json()) as { id: string; api_key: string };
        keyIds.add(replacement.id);
        await runtimeRequest(`api_key/${key.id}`, "DELETE");
        keyIds.delete(key.id);
        // Advance the recorded lease, avoiding a 90-second wall-clock wait in this test.
        await handles.prisma.customerPublication.update({
          where: { id: publicationId },
          data: { inUseUntil: new Date(0) },
        });
        await handles.customers.reconcilePublications();
        expect(
          await handles.prisma.customerPublication.findUnique({ where: { id: publicationId } }),
        ).toMatchObject({ status: "cleanup", confirmed: true });
        await runtimeRequest(`flows/${publicationId}`);
        const repair = execFileSync(
          "pnpm",
          [
            "exec",
            "tsx",
            path.resolve("scripts/configure-operator-settings.mts"),
            "customer-runtime-cleanup",
          ],
          {
            input: JSON.stringify({ baseUrl: runtimeUrl, apiKey: replacement.api_key }),
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env, ENCRYPTION_KEY: encryptionKey },
          },
        );
        expect(JSON.parse(repair)).toEqual({ refreshed: 1, unverified: 0, failed: 0 });
        await handles.customers.reconcilePublications();
        expect(
          await handles.prisma.customerPublication.findUnique({ where: { id: publicationId } }),
        ).toBeNull();
        await expect(runtimeRequest(`flows/${publicationId}`)).rejects.toThrow(
          "Local runtime GET failed (404)",
        );
      } finally {
        const cleanup: Array<() => Promise<unknown>> = [
          async () => handles?.stop(),
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
          async () => {
            if (!botId || !token) return;
            const flows = (await (
              await runtimeRequest("flows/?header_flows=true")
            ).json()) as Array<{
              id: string;
              name: string;
            }>;
            for (const flow of flows.filter((f) => f.name.startsWith(`Customer ${botId} `)))
              await runtimeRequest(`flows/${flow.id}`, "DELETE");
            const remaining = (await (
              await runtimeRequest("flows/?header_flows=true")
            ).json()) as Array<{ name: string }>;
            expect(remaining.some((flow) => flow.name.startsWith(`Customer ${botId} `))).toBe(
              false,
            );
          },
          async () => {
            await Promise.allSettled(
              [...keyIds].map((id) => runtimeRequest(`api_key/${id}`, "DELETE")),
            );
            const remaining = (await (await runtimeRequest("api_key/")).json()) as {
              api_keys: Array<{ id: string }>;
            };
            expect(remaining.api_keys.some((key) => keyIds.has(key.id))).toBe(false);
          },
          async () => model?.close(),
          () => rm(dataDir, { recursive: true, force: true }),
        ];
        const failed: unknown[] = [];
        for (const clean of cleanup)
          try {
            await clean();
          } catch (error) {
            failed.push(error);
          }
        if (previousInternalUrl === undefined) delete process.env.API_INTERNAL_URL;
        else process.env.API_INTERNAL_URL = previousInternalUrl;
        if (liveLocal && process.env.VERIFY_CUSTOMER_LOCAL_RECEIPT)
          await writeFile(
            process.env.VERIFY_CUSTOMER_LOCAL_RECEIPT,
            JSON.stringify(
              {
                modelId,
                localModel,
                learningSetting,
                seconds: (Date.now() - started) / 1000,
                runs,
                website,
                customerCalls,
                cleanupFailures: failed.length,
                limitation:
                  "Synthetic approved knowledge and website visitor; fake sandbox; no merchant/provider acceptance.",
              },
              null,
              2,
            ),
          );
        expect(failed).toEqual([]);
        console.info(
          "Customer setup cleanup verified: owned runtime flows and key removed; app, callback server and model fixture stopped.",
        );
      }
    },
    testTimeout,
  );
});
