import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SemanticMemoryUndoApprovedInput } from "@rakazo/contracts";
import { createSemanticMemoryAudit, writeAccountExport } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceMemoryProviderResolver } from "../../adapters/src/memory-provider-factory.js";
import {
  forgetSerenity,
  recallSerenity,
  rememberSerenity,
} from "../../adapters/src/serenity-client.js";
import { SerenityMemoryProvider } from "../../adapters/src/serenity-memory-provider.js";
import { SupermemoryMemoryProvider } from "../../adapters/src/supermemory-memory-provider.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

vi.mock("../../adapters/src/serenity-client.js", async (original) => ({
  ...(await original<typeof import("../../adapters/src/serenity-client.js")>()),
  recallSerenity: vi.fn(),
  forgetSerenity: vi.fn(),
  rememberSerenity: vi.fn(),
}));

const origin = "http://127.0.0.1:5173";
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe.skipIf(!enabled).each([
  { providerId: "supermemory", operation: "undo", defaultPolicy: false },
  { providerId: "supermemory", operation: "restore", defaultPolicy: false },
  { providerId: "serenity", operation: "restore", defaultPolicy: false },
  {
    providerId: "supermemory",
    operation: "restore",
    defaultPolicy: false,
    sharedDestination: true,
  },
  { providerId: "serenity", operation: "restore", defaultPolicy: false, sharedDestination: true },
  { providerId: "serenity", operation: "forget", defaultPolicy: false },
  { providerId: "supermemory", operation: "forget", defaultPolicy: false },
  { providerId: "serenity", operation: "save", defaultPolicy: false },
  { providerId: "supermemory", operation: "save", defaultPolicy: false },
  { providerId: "serenity", operation: "save", defaultPolicy: true },
  { providerId: "supermemory", operation: "save", defaultPolicy: true },
] as const)(
  "$providerId memory $operation through real executor, defaultPolicy=$defaultPolicy",
  (scenario) => {
    const { providerId, operation, defaultPolicy } = scenario;
    const sharedDestination = "sharedDestination" in scenario && scenario.sharedDestination;
    const isReversal = operation === "undo" || operation === "restore";
    const isWrite = operation === "save" || operation === "restore";
    const toolName = isReversal ? "memory_semantic_undo" : `${operation}_memory`;
    it.each(
      (
        [
          "allow",
          "allow-large",
          "deny",
          "content-changed",
          "scope-changed",
          "connection-changed",
          "dispatch-unavailable",
          "dispatch-reconfigured",
          "lost-response",
          "wrong-receipt",
          "provider-error",
          "partial",
        ] as const
      ).filter((outcome) =>
        sharedDestination
          ? ["allow", "lost-response", "scope-changed"].includes(outcome)
          : defaultPolicy
            ? ["allow", "lost-response", "partial"].includes(outcome)
            : operation !== "save"
              ? outcome !== "partial"
              : outcome !== "content-changed",
      ),
    )(
      "%s preserves reviewed content and configured scope across worker attempts",
      async (outcome) => {
        const content =
          outcome === "allow-large"
            ? `Start of full fact.\n${"Use metric units.\n".repeat(600)}`.slice(0, 9982) +
              "\nEnd of full fact."
            : "Use metric units.";
        if (outcome === "allow-large") expect(content).toHaveLength(10000);
        const allowed = outcome === "allow" || outcome === "allow-large";
        const originalMutationId = randomUUID();
        const approved =
          operation === "save"
            ? { content, reason: "Owner preference" }
            : { id: "fact-1", expectedContent: content, reason: "Obsolete fact" };
        const uncertain = ["lost-response", "wrong-receipt", "provider-error", "partial"].includes(
          outcome,
        );
        const initialScope = outcome === "partial" || sharedDestination ? "shared" : "isolated";
        let configuredScope: "isolated" | "shared" = initialScope;
        let configurationRevision = "config-1:revision-1";
        let failDispatch = false;
        vi.spyOn(SpaceMemoryProviderResolver.prototype, "resolve").mockImplementation(async () => {
          if (failDispatch) throw new Error("Synthetic resolver failure");
          return {
            defaultScope: configuredScope,
            configurationRevision,
            // A fresh provider per worker attempt proves no process-local cache is required.
            provider:
              providerId === "supermemory"
                ? new SupermemoryMemoryProvider({
                    baseUrl: "http://127.0.0.1:6767",
                    apiKey: "offline-memory-key",
                  })
                : new SerenityMemoryProvider({
                    endpoint: "http://127.0.0.1:8787/mcp",
                    token: "offline-memory-token",
                    brainLabel: "",
                    allowWrites: true,
                  }),
          };
        });
        let factPresent = operation !== "restore";
        let factEntity: string | undefined;
        vi.mocked(recallSerenity).mockImplementation(async (_query, _connection, options) => ({
          ok: true,
          value:
            (factEntity && options.entity !== factEntity) ||
            (operation === "restore" && !factPresent && outcome !== "content-changed")
              ? []
              : [
                  {
                    factId: operation === "restore" && factPresent ? "saved-fact" : "fact-1",
                    fact: outcome === "content-changed" ? "Use imperial units." : content,
                    provenance: "Synthetic owner correction",
                    entitySlug: options.entity,
                  },
                ],
        }));
        vi.mocked(forgetSerenity).mockResolvedValue(
          outcome === "lost-response" || outcome === "provider-error"
            ? { ok: false, error: "Synthetic uncertain provider failure" }
            : {
                ok: true,
                value: {
                  id: outcome === "wrong-receipt" ? "other-fact" : "fact-1",
                  expired: true,
                  reason: approved.reason,
                },
              },
        );
        vi.mocked(rememberSerenity).mockImplementation(
          async (_content, _provenance, _connection, options) => {
            if (
              ["lost-response", "provider-error", "wrong-receipt"].includes(outcome) ||
              (outcome === "partial" && options?.entity?.startsWith("rakazo-bot/"))
            ) {
              return { ok: false, error: "Synthetic uncertain save" };
            }
            if (operation === "restore") factPresent = true;
            return { ok: true, value: { id: "saved-fact", status: "acknowledged" } };
          },
        );
        const memoryRequests: { method?: string; body: Record<string, unknown> }[] = [];
        const originalFetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          if (!String(input).startsWith("http://127.0.0.1:6767/"))
            return originalFetch(input, init);
          memoryRequests.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
          if (String(input).endsWith("/v4/memories") && init?.method === "POST") {
            const body = JSON.parse(String(init.body));
            if (
              outcome === "lost-response" ||
              (outcome === "partial" &&
                body.containerTag.startsWith("rakazo:") &&
                !body.containerTag.startsWith("rakazo:workspace:"))
            )
              throw new Error("Lost save response");
            if (outcome === "provider-error") return new Response("", { status: 500 });
            if (operation === "restore" && allowed) factPresent = true;
            return Response.json(
              {
                memories:
                  outcome === "wrong-receipt" ? [] : [{ id: "saved-fact", memory: content }],
              },
              { status: 201 },
            );
          }
          if (init?.method === "DELETE") {
            if (outcome === "lost-response") throw new Error("Lost provider response");
            if (outcome === "provider-error") return new Response("", { status: 500 });
            if (operation === "undo" && allowed) factPresent = false;
            return Response.json({
              id: outcome === "wrong-receipt" ? "other-fact" : "fact-1",
              forgotten: true,
            });
          }
          if (String(input).endsWith("/v4/search"))
            return Response.json({
              results:
                isReversal &&
                factPresent &&
                JSON.parse(String(init?.body)).containerTag === factEntity
                  ? [
                      {
                        id: operation === "restore" ? "saved-fact" : "fact-1",
                        memory: content,
                        similarity: 1,
                      },
                    ]
                  : [],
            });
          return Response.json({
            memoryEntries: [
              {
                id: "fact-1",
                memory: outcome === "content-changed" ? "Use imperial units." : content,
                isLatest: true,
                isForgotten: operation === "restore" && !factPresent,
              },
            ],
            pagination: { currentPage: 1, totalPages: 1, totalItems: 1 },
          });
        });
        const model = await startModelEmulator({
          apiKey: "offline-memory-key",
          steps: [
            {
              expect(request) {
                expect(request.tools).toContainEqual(
                  expect.objectContaining({
                    function: expect.objectContaining({ name: toolName }),
                  }),
                );
              },
              response: {
                type: "tool",
                id: "proposed-removal",
                name: toolName,
                arguments: approved,
              },
            },
            {
              expect(request) {
                const resumedText = request.messages
                  .flatMap((message) =>
                    typeof message.content === "string"
                      ? [message.content]
                      : Array.isArray(message.content)
                        ? message.content
                            .filter((part) => part?.type === "text")
                            .map((part) => String(part.text))
                        : [],
                  )
                  .join("\n");
                if (outcome === "deny") {
                  expect(resumedText).toContain(`Review before ${toolName}`);
                } else {
                  const prefix = `${toolName}: `;
                  const replay = resumedText.split("\n").find((line) => line.startsWith(prefix));
                  expect(replay).toBeDefined();
                  const replayArgs = JSON.parse(replay!.slice(prefix.length));
                  if (isReversal) expect(replayArgs.mutationId).toBe(originalMutationId);
                  else
                    expect(replayArgs[operation === "save" ? "content" : "expectedContent"]).toBe(
                      content,
                    );
                }
                if (outcome === "dispatch-unavailable") failDispatch = true;
                if (outcome === "dispatch-reconfigured")
                  configurationRevision = "config-1:revision-2";
              },
              response: () => ({
                type: "tool",
                id: "resumed-removal",
                name: toolName,
                arguments:
                  outcome === "deny"
                    ? approved
                    : {
                        ...approved,
                        ...(operation === "save"
                          ? { content: "Unapproved changed fact" }
                          : isReversal
                            ? { id: "unapproved-fact" }
                            : {
                                id: "unapproved-fact",
                                expectedContent: "Do not delete this fact.",
                              }),
                      },
              }),
            },
            {
              expect(request) {
                const tool = request.messages.findLast((message) => message.role === "tool");
                expect(tool?.tool_call_id).toBe(
                  defaultPolicy ? "proposed-removal" : "resumed-removal",
                );
                expect(String(tool?.content), String(tool?.content)).not.toMatch(/^Validation/);
                const result = JSON.parse(String(tool?.content));
                if (allowed)
                  expect(result).toMatchObject(
                    !isWrite
                      ? { ok: true, value: { id: "fact-1", expired: true } }
                      : { ok: true, value: [{ id: "saved-fact" }] },
                  );
                else if (outcome === "deny") expect(JSON.stringify(result)).toMatch(/denied/i);
                else if (uncertain) expect(result).toMatchObject({ uncertain: true });
                else
                  expect(JSON.stringify(result)).toMatch(
                    /changed|current memory scope|unavailable|still recalled/i,
                  );
              },
              response: uncertain
                ? {
                    type: "tool",
                    id: "repeat-removal",
                    name: toolName,
                    arguments:
                      operation === "save"
                        ? { ...approved, reason: "Retry the same fact" }
                        : approved,
                  }
                : { type: "text", text: "Finished the memory review." },
            },
            ...(uncertain
              ? [
                  {
                    expect(request: { messages: { role: string; content?: unknown }[] }) {
                      const tool = request.messages.findLast((message) => message.role === "tool");
                      expect(JSON.parse(String(tool?.content))).toMatchObject({ uncertain: true });
                    },
                    response: {
                      type: "text" as const,
                      text: "Inspect the provider before another removal.",
                    },
                  },
                ]
              : []),
          ].filter((_, index) => !defaultPolicy || index !== 1),
        });
        const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-memory-approval-"));
        let stop: (() => Promise<void>) | undefined;
        try {
          const { createApp } = await import("../../../apps/api/src/app.ts");
          const handles = await createApp({
            databaseUrl: process.env.DATABASE_URL!,
            realtimeDatabaseUrl: process.env.DATABASE_URL!,
            authUrl: origin,
            webOrigin: origin,
            dataDir,
            sandboxProvider: "fake",
            agentRuntime: "pi",
            wakeupDriver: "memory",
            signupsEnabled: "true",
            encryptionKey: "offline-memory-encryption-key",
          });
          stop = handles.stop;
          const signup = await handles.app.request("/api/auth/sign-up/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({
              email: `memory-${randomUUID()}@example.test`,
              password: "password12",
              name: "Memory fixture",
            }),
          });
          expect(signup.status).toBeLessThan(400);
          const cookie = sessionCookieHeader(signup);
          const rpc = async <T>(procedure: string, input: unknown = {}): Promise<T> => {
            const response = await handles.app.request(`/rpc/${procedure}`, {
              method: "POST",
              headers: { "content-type": "application/json", cookie, origin },
              body: JSON.stringify({ json: input }),
            });
            const body = (await response.json()) as { json: T; error?: { message?: string } };
            if (!response.ok || body.error)
              throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
            return body.json;
          };
          await rpc("models/connect", {
            provider: model.model.provider,
            modelId: model.model.id,
            baseUrl: model.baseUrl,
            apiKey: "offline-memory-key",
          });
          const bot = await rpc<{ id: string }>("bots/create", {
            name: "Memory fixture",
            title: "",
            description: "",
            instructions: "Remove the reviewed memory.",
            notifyOnFinish: false,
          });
          await rpc("bots/update", {
            botId: bot.id,
            modelProvider: model.model.provider,
            modelId: model.model.id,
          });
          const stored = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
          const recallCurrent = () =>
            new SupermemoryMemoryProvider({
              baseUrl: "http://127.0.0.1:6767",
              apiKey: "offline-memory-key",
            }).recall(
              { query: content, botId: bot.id, scope: initialScope, limit: 5 },
              {
                botId: bot.id,
                spaceId: stored.spaceId,
                userId: stored.userId,
                operationId: "verify-retrieval",
                traceId: "verify-retrieval",
                signal: new AbortController().signal,
              },
            );
          if (isReversal) {
            const entity =
              providerId === "serenity"
                ? sharedDestination
                  ? `rakazo-space/${stored.spaceId}`
                  : `rakazo-bot/${bot.id}`
                : sharedDestination
                  ? `rakazo:workspace:${stored.spaceId}`
                  : `rakazo:${bot.id}`;
            factEntity = entity;
            Reflect.deleteProperty(approved, "expectedContent");
            Object.assign(approved, { mutationId: originalMutationId, entity });
            await handles.prisma.semanticMemoryMutation.create({
              data: {
                id: originalMutationId,
                userId: stored.userId,
                spaceId: stored.spaceId,
                botId: bot.id,
                operation: operation === "restore" ? "forget" : "save",
                provider: providerId,
                configurationRevision,
                scope: initialScope,
                status: "completed",
                sourceRunId: "deleted-source-run",
                sourceThreadId: "deleted-source-thread",
                request:
                  operation === "restore"
                    ? { id: "fact-1", entity, expectedContent: content }
                    : { content },
                result:
                  operation === "restore"
                    ? {
                        ok: true,
                        value: { id: "fact-1", entity, expired: true, reason: "Synthetic removal" },
                      }
                    : {
                        ok: true,
                        value: [{ version: 1, id: "fact-1", entity, content, created: true }],
                      },
              },
            });
          }
          if (!defaultPolicy)
            await handles.prisma.actionApprovalRule.create({
              data: {
                spaceId: stored.spaceId,
                createdByUserId: stored.userId,
                effect: operation !== "save" ? "always_allow" : "require_approval",
                matchKind: "tool",
                matchValue: toolName,
              },
            });
          if (operation === "undo" && allowed)
            expect(await recallCurrent()).toMatchObject({
              ok: true,
              value: [{ id: "fact-1", memory: content }],
            });
          const sent = await rpc<{ runId: string }>("threads/send", {
            botId: bot.id,
            text: "Remove the obsolete metric preference after I review it.",
          });
          const wait = async (status: string) => {
            await expect
              .poll(
                async () => {
                  const current = await handles.prisma.run.findUniqueOrThrow({
                    where: { id: sent.runId },
                  });
                  return current.status === status || current.status === "failed";
                },
                { timeout: 15000, interval: 100 },
              )
              .toBe(true);
            const current = await handles.prisma.run.findUniqueOrThrow({
              where: { id: sent.runId },
            });
            if (current.status === "failed") model.assertComplete();
            expect(current.status, current.error ?? undefined).toBe(status);
          };
          await wait(defaultPolicy ? "completed" : "waiting_input");
          if (!defaultPolicy) expect(forgetSerenity).not.toHaveBeenCalled();
          const effect = await handles.prisma.externalEffect.findFirstOrThrow({
            where: { runId: sent.runId, kind: toolName },
          });
          const expectedBinding = {
            ...approved,
            botId: bot.id,
            scope: initialScope,
            provider: providerId,
            configurationRevision,
          };
          const bound = isReversal
            ? SemanticMemoryUndoApprovedInput.parse({
                ...expectedBinding,
                action: operation === "restore" ? "restore" : "forget",
                expectedContent: content,
              })
            : expectedBinding;
          expect(effect.request).toEqual(bound);
          if (!defaultPolicy) {
            const card = await handles.prisma.message.findFirstOrThrow({
              where: { runId: sent.runId, role: "bot" },
              orderBy: { seq: "desc" },
            });
            expect(card.blocks).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  kind: "ask",
                  approvalEffectId: effect.id,
                  detail: expect.any(String),
                  actions: expect.arrayContaining([
                    { id: "allow", label: "Allow once" },
                    { id: "deny", label: "Deny" },
                  ]),
                }),
              ]),
            );
            const ask = (card.blocks as Array<{ kind: string; detail?: string }>).find(
              (block) => block.kind === "ask",
            );
            expect(JSON.parse(ask!.detail!)).toEqual(bound);
            if (outcome === "scope-changed")
              configuredScope = initialScope === "shared" ? "isolated" : "shared";
            if (outcome === "connection-changed") configurationRevision = "config-1:revision-2";
            await rpc("threads/answer", {
              botId: bot.id,
              runId: sent.runId,
              messageId: card.id,
              answer: outcome === "deny" ? "deny" : "allow",
            });
            await wait("completed");
          }
          model.assertComplete();
          if (operation === "undo" && allowed)
            expect(await recallCurrent()).toEqual({ ok: true, value: [] });
          if (operation === "restore" && allowed) {
            if (providerId === "supermemory")
              expect(await recallCurrent()).toMatchObject({
                ok: true,
                value: [{ id: "saved-fact", memory: content }],
              });
            else
              expect(
                await new SerenityMemoryProvider({
                  endpoint: "http://127.0.0.1:8787/mcp",
                  token: "offline-memory-token",
                  brainLabel: "",
                  allowWrites: true,
                }).recall(
                  { query: content, botId: bot.id, scope: initialScope, limit: 5 },
                  {
                    botId: bot.id,
                    spaceId: stored.spaceId,
                    userId: stored.userId,
                    operationId: "verify",
                    traceId: "verify",
                    signal: new AbortController().signal,
                  },
                ),
              ).toMatchObject({ ok: true, value: [{ id: "saved-fact", memory: content }] });
          }
          const dispatched = allowed || uncertain;
          expect(forgetSerenity).toHaveBeenCalledTimes(
            providerId === "serenity" && !isWrite && dispatched ? 1 : 0,
          );
          const deletes = memoryRequests.filter((entry) => entry.method === "DELETE");
          expect(deletes).toHaveLength(
            providerId === "supermemory" && !isWrite && dispatched ? 1 : 0,
          );
          if (providerId === "supermemory" && !isWrite && dispatched) {
            expect(deletes[0]?.body).toEqual({
              id: "fact-1",
              containerTag: `rakazo:${bot.id}`,
              reason: approved.reason,
            });
          }
          if (isWrite) {
            const expectedWrites = dispatched
              ? operation === "save" && initialScope === "shared"
                ? 2
                : 1
              : 0;
            expect(rememberSerenity).toHaveBeenCalledTimes(
              providerId === "serenity" ? expectedWrites : 0,
            );
            const saves = memoryRequests.filter((entry) => Array.isArray(entry.body.memories));
            expect(saves).toHaveLength(providerId === "supermemory" ? expectedWrites : 0);
            for (const save of saves)
              expect(save.body.memories).toEqual([{ content, isStatic: false }]);
            const saved = await handles.prisma.externalEffect.findUniqueOrThrow({
              where: { id: effect.id },
            });
            if (allowed || outcome === "partial") {
              const entity =
                providerId === "serenity"
                  ? initialScope === "shared"
                    ? `rakazo-space/${stored.spaceId}`
                    : `rakazo-bot/${bot.id}`
                  : initialScope === "shared"
                    ? `rakazo:workspace:${stored.spaceId}`
                    : `rakazo:${bot.id}`;
              const receipt = {
                id: "saved-fact",
                entity,
                content: providerId === "supermemory" || operation === "restore" ? content : null,
                created: providerId === "supermemory" ? true : null,
              };
              expect(saved.result).toMatchObject(
                allowed
                  ? { ok: true, value: [receipt] }
                  : {
                      uncertain: true,
                      receipts: [receipt],
                      uncertainEntities: [
                        providerId === "serenity" ? `rakazo-bot/${bot.id}` : `rakazo:${bot.id}`,
                      ],
                    },
              );
            }
          }
          if (uncertain) {
            expect(
              await handles.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
            ).toMatchObject({ status: "uncertain", result: { uncertain: true } });
          }
          if (providerId === "serenity" && !isWrite && allowed) {
            expect(forgetSerenity).toHaveBeenCalledWith(
              "fact-1",
              expect.anything(),
              expect.objectContaining({ reason: approved.reason }),
            );
            expect(recallSerenity).toHaveBeenCalledWith(
              content,
              expect.anything(),
              expect.objectContaining({ entity: `rakazo-bot/${bot.id}` }),
            );
          }
          if (
            [
              "scope-changed",
              "connection-changed",
              "dispatch-unavailable",
              "dispatch-reconfigured",
            ].includes(outcome)
          ) {
            expect(
              await handles.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
            ).toMatchObject({
              status: "completed",
              result: { error: expect.stringMatching(/unavailable|changed/) },
            });
            expect(recallSerenity).not.toHaveBeenCalled();
          }
          const auditRow = await handles.prisma.semanticMemoryMutation.findUnique({
            where: { id: effect.id },
          });
          const wasDispatched =
            allowed || uncertain || (operation !== "save" && outcome === "content-changed");
          if (wasDispatched) {
            expect(auditRow).toMatchObject({
              id: effect.id,
              userId: stored.userId,
              spaceId: stored.spaceId,
              botId: bot.id,
              operation: isReversal
                ? operation === "restore"
                  ? "undo_forget"
                  : "undo_save"
                : operation,
              ...(isReversal ? { reversesId: originalMutationId } : {}),
              provider: providerId,
              scope: initialScope,
              status: uncertain
                ? "uncertain"
                : outcome === "content-changed"
                  ? "failed"
                  : "completed",
              sourceRunId: sent.runId,
              request: bound,
            });
            if (outcome === "partial")
              expect(auditRow?.result).toMatchObject({
                ok: false,
                receipts: [{ id: "saved-fact" }],
                uncertainEntities: expect.any(Array),
              });
          } else expect(auditRow).toBeNull();
          if (operation === "undo") {
            expect(
              await handles.prisma.semanticMemoryMutation.findUnique({
                where: { id: originalMutationId },
              }),
            ).toMatchObject({
              status: "completed",
              result: { ok: true, value: [{ id: "fact-1", content, created: true }] },
            });
            expect(auditRow?.reversalKey != null).toBe(
              wasDispatched && outcome !== "content-changed",
            );
          }

          if (defaultPolicy && allowed && providerId === "supermemory") {
            const audit = createSemanticMemoryAudit(handles.prisma);
            const actor = {
              operationId: "audit-test",
              traceId: "audit-test",
              spaceId: stored.spaceId,
              userId: stored.userId,
              botId: bot.id,
              signal: new AbortController().signal,
            };
            const list = await audit.list(actor);
            expect(list.items).toEqual([
              expect.objectContaining({ id: effect.id, status: "completed" }),
            ]);
            const first = await audit.read(actor, { mutationId: effect.id });
            let text = first.content;
            let offset = first.nextOffset;
            while (offset !== null) {
              const chunk = await audit.read(actor, {
                mutationId: effect.id,
                version: first.version,
                offset,
              });
              text += chunk.content;
              offset = chunk.nextOffset;
            }
            expect(JSON.parse(text)).toMatchObject({
              sourceRunId: sent.runId,
              request: bound,
              result: { ok: true, value: [{ id: "saved-fact", content }] },
            });
            await expect(audit.read(actor, { mutationId: effect.id, offset: 1 })).rejects.toThrow(
              "version",
            );
            await expect(
              audit.read({ ...actor, botId: "foreign-bot" }, { mutationId: effect.id }),
            ).rejects.toThrow();
            const otherId = `audit-other-${randomUUID()}`;
            await handles.prisma.user.create({
              data: { id: otherId, email: `${otherId}@example.test`, name: "Other owner" },
            });
            const organization = await handles.prisma.space.findUniqueOrThrow({
              where: { id: stored.spaceId },
            });
            await handles.prisma.member.create({
              data: {
                id: randomUUID(),
                organizationId: organization.organizationId,
                userId: otherId,
                role: "member",
                createdAt: new Date(),
              },
            });
            expect(
              await handles.prisma.spaceMember.count({
                where: { spaceId: stored.spaceId, userId: otherId },
              }),
            ).toBe(1);
            await expect(
              audit.read({ ...actor, userId: otherId }, { mutationId: effect.id }),
            ).rejects.toThrow();
            await expect(audit.list(actor, { cursor: "foreign-entry" })).rejects.toThrow();
            await handles.prisma.run.delete({ where: { id: sent.runId } });
            expect(await handles.prisma.externalEffect.count({ where: { id: effect.id } })).toBe(0);
            expect(
              await handles.prisma.semanticMemoryMutation.count({ where: { id: effect.id } }),
            ).toBe(1);
            await expect(
              audit.read(actor, { mutationId: effect.id, version: first.version }),
            ).rejects.toThrow("changed");
            const afterSourceDeletion = await audit.read(actor, { mutationId: effect.id });
            expect(afterSourceDeletion.content).toContain('"sourceRunId": null');
            expect(afterSourceDeletion.content).toContain('"sourceThreadId": null');
            await handles.prisma.semanticMemoryMutation.createMany({
              data: Array.from({ length: 11 }, (_, index) => ({
                id: `audit-page-${randomUUID()}-${index}`,
                spaceId: stored.spaceId,
                userId: stored.userId,
                botId: bot.id,
                sourceRunId: sent.runId,
                sourceThreadId: "removed-thread",
                operation: operation === "restore" ? "forget" : "save",
                provider: providerId,
                configurationRevision: "config-1:revision-1",
                scope: "isolated",
                status: "uncertain",
                request: bound,
              })),
            });
            const firstPage = await audit.list(actor);
            expect(firstPage.items).toHaveLength(10);
            expect(firstPage.nextCursor).not.toBeNull();
            const secondPage = await audit.list(actor, { cursor: firstPage.nextCursor! });
            expect(secondPage.items).toHaveLength(2);
            expect(secondPage.nextCursor).toBeNull();
            expect(
              new Set([...firstPage.items, ...secondPage.items].map((entry) => entry.id)).size,
            ).toBe(12);
            const exported: unknown[] = [];
            await writeAccountExport(
              handles.prisma,
              stored.userId,
              async (entry) => {
                if (entry.type === "semanticMemoryMutation") exported.push(entry.data);
              },
              async () => "",
              actor.signal,
            );
            expect(exported).toHaveLength(12);
            expect(exported).toContainEqual(
              expect.objectContaining({ id: effect.id, request: bound }),
            );
            const foreignExport: unknown[] = [];
            await writeAccountExport(
              handles.prisma,
              otherId,
              async (entry) => {
                if (entry.type === "semanticMemoryMutation") foreignExport.push(entry.data);
              },
              async () => "",
              actor.signal,
            );
            expect(foreignExport).toEqual([]);
            await handles.prisma.user.delete({ where: { id: stored.userId } });
            expect(
              await handles.prisma.semanticMemoryMutation.count({ where: { id: effect.id } }),
            ).toBe(0);
            return;
          }
          expect(
            await handles.prisma.externalEffect.count({
              where: { runId: sent.runId, kind: toolName },
            }),
          ).toBe(1);
        } finally {
          try {
            await stop?.();
          } finally {
            await model.close();
            await rm(dataDir, { recursive: true, force: true });
          }
        }
      },
      45000,
    );
  },
);
