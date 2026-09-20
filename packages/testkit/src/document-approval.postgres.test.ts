import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MessageBlock } from "@rakazo/contracts";
import { LearningTaskProposalSchema } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { createAgentSkillStore } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "../../memory/src/index.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const names = [
  "memory_undo",
  "memory_restore",
  "skill_create",
  "skill_update",
  "skill_delete",
  "skill_undo",
  "skill_restore",
  "customer_learning_decide",
] as const;
const plainContent =
  `Start of full document.\n${"Keep this reviewed guidance.\n".repeat(4000)}`.slice(0, 99977) +
  "\nEnd of full document.";

describe.skipIf(!enabled)("full document review through the authenticated executor", () => {
  for (const name of names) {
    for (const answer of [
      "allow",
      "deny",
      ...(name === "skill_update" ? ["substitution", "fifo"] : []),
      ...(name === "memory_restore" ? ["repeat"] : []),
      ...(name === "customer_learning_decide" ? ["escaped"] : []),
      ...(["memory_undo", "skill_update", "customer_learning_decide"].includes(name)
        ? ["stale"]
        : []),
    ]) {
      it(`${name} ${answer} preserves the complete approved version`, async () => {
        const content =
          answer === "escaped"
            ? `Start of full document.\n${"\u0001".repeat(99953)}\nEnd of full document.`
            : plainContent;
        const succeeds = answer !== "deny" && answer !== "stale";
        let verify: (applied: boolean) => Promise<void>;
        let secondApproved: Record<string, unknown> | undefined;
        let secondApplied = false;
        const approved: Record<string, unknown> = {};
        const model = await startModelEmulator({
          apiKey: "offline-document-key",
          steps: [
            {
              expect(request) {
                expect(
                  request.tools?.some((tool) => tool.function.name === "apply_approved_document"),
                ).toBe(false);
                expect(request.tools).toContainEqual(
                  expect.objectContaining({ function: expect.objectContaining({ name }) }),
                );
              },
              response: { type: "tool", id: "proposed", name, arguments: approved },
            },
            {
              expect(request) {
                if (answer === "deny") {
                  expect(
                    request.tools?.some((tool) => tool.function.name === "apply_approved_document"),
                  ).toBe(false);
                  return;
                }
                const text = request.messages
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
                expect(text).toContain("apply_approved_document: {}");
                expect(text).not.toContain(`${name}: {`);
                expect(text).not.toContain("End of full document.");
                // Ordinary memory context independently contributes up to 32 KiB.
                expect(text.length).toBeLessThan(45_000);
                expect(request.tools).toContainEqual(
                  expect.objectContaining({
                    function: expect.objectContaining({ name: "apply_approved_document" }),
                  }),
                );
              },
              response: () => ({
                type: "tool",
                id: "resumed",
                name: answer === "deny" ? name : "apply_approved_document",
                arguments: {
                  ...(answer === "deny"
                    ? approved
                    : answer === "substitution"
                      ? { content: "Never approved" }
                      : {}),
                },
              }),
            },
            {
              async expect(request) {
                const result = request.messages.findLast((message) => message.role === "tool");
                expect(result?.tool_call_id).toBe("resumed");
                if (answer === "substitution") {
                  expect(String(result?.content)).toMatch(/error|argument|property/i);
                  await verify(false);
                } else if (answer === "deny") expect(String(result?.content)).toMatch(/denied/i);
                else if (answer === "stale")
                  expect(String(result?.content)).toMatch(/changed|revision/i);
                else expect(String(result?.content)).not.toMatch(/"error"|Validation/i);
              },
              response:
                answer === "substitution" || answer === "repeat" || answer === "fifo"
                  ? { type: "tool", id: "again", name: "apply_approved_document", arguments: {} }
                  : { type: "text", text: "Document review finished." },
            },
            ...(answer === "substitution" || answer === "repeat" || answer === "fifo"
              ? [
                  {
                    async expect(request: ModelEmulatorRequest) {
                      const result = request.messages.findLast(
                        (message) => message.role === "tool",
                      );
                      expect(result?.tool_call_id).toBe("again");
                      if (answer === "repeat")
                        expect(String(result?.content)).toContain("No available document approval");
                      else expect(String(result?.content)).not.toMatch(/"error"|Validation/i);
                      if (answer === "fifo") secondApplied = true;
                      await verify(true);
                    },
                    response: { type: "text" as const, text: "Document review finished." },
                  },
                ]
              : []),
          ],
        });
        const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-document-review-"));
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
            encryptionKey: "offline-document-encryption-key",
          });
          stop = handles.stop;
          const signup = await handles.app.request("/api/auth/sign-up/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({
              email: `document-${randomUUID()}@example.test`,
              password: "password12",
              name: "Document fixture",
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
            apiKey: "offline-document-key",
          });
          const bot = await rpc<{ id: string }>("bots/create", {
            name: "Document fixture",
            title: "",
            description: "",
            instructions: "Review the complete document before changing it.",
            notifyOnFinish: false,
          });
          await rpc("bots/update", {
            botId: bot.id,
            modelProvider: model.model.provider,
            modelId: model.model.id,
          });
          const stored = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
          const owner = { userId: stored.userId, spaceId: stored.spaceId };
          const context = {
            ...owner,
            operationId: "document-fixture",
            traceId: "document-fixture",
            signal: new AbortController().signal,
          };
          let changed = false;
          let change = async () => {};
          if (name.startsWith("memory_") || name === "customer_learning_decide") {
            const memory = new MarkdownMemoryStore(handles.prisma);
            const initial = await memory.commit(
              { scope: "bot", botId: bot.id, path: "reviewed.md", content, expectedRevision: 0 },
              context,
            );
            const replacement = content.replace("Start", "Later");
            const current = await memory.commit(
              {
                scope: "bot",
                botId: bot.id,
                path: "reviewed.md",
                content: replacement,
                expectedRevision: 1,
              },
              context,
            );
            change = async () => {
              await memory.commit(
                {
                  scope: "bot",
                  botId: bot.id,
                  path: "reviewed.md",
                  content: "Newer staff edit",
                  expectedRevision: 2,
                },
                context,
              );
            };
            if (name === "customer_learning_decide") {
              const archive = await handles.prisma.learningImport.create({
                data: {
                  ...owner,
                  botId: bot.id,
                  digest: randomUUID(),
                  label: "Approved synthetic examples",
                  format: "examples",
                  content: "Use reviewed guidance",
                  coverage: {},
                  windowEnd: new Date(),
                },
              });
              const proposal = LearningTaskProposalSchema.parse({
                native: {
                  kind: "memory",
                  scope: "bot",
                  path: "reviewed.md",
                  id: current.id,
                  expectedRevision: 2,
                  beforeContent: replacement,
                  content,
                },
                supported: true,
                publicSafe: false,
                changesBusinessRules: false,
                conditions: "Private staff work",
                save: {
                  botId: bot.id,
                  scope: "bot",
                  kind: "memory",
                  key: "reviewed-guidance",
                  title: "Reviewed guidance",
                  content: "Keep the reviewed correction",
                  customerVisible: false,
                  expectedRevision: 0,
                  reason: "Synthetic correction",
                  source: "Approved examples",
                  sourceRef: { kind: "import", id: archive.id },
                },
              });
              const task = await handles.prisma.learningTask.create({
                data: {
                  ...owner,
                  botId: bot.id,
                  importId: archive.id,
                  sourceKey: randomUUID(),
                  evidence: {},
                  status: "review",
                  targetKind: "memory",
                  proposal,
                },
              });
              Object.assign(approved, {
                taskId: task.id,
                decision: "approve",
                reason: "Owner reviewed the full proposal",
                reviewedProposal: proposal,
              });
              verify = async (applied) => {
                const row = await handles.prisma.memoryDocument.findUniqueOrThrow({
                  where: { id: initial.id },
                });
                expect(row.content).toBe(
                  applied ? content : changed ? "Newer staff edit" : replacement,
                );
                expect(
                  (await handles.prisma.learningTask.findUniqueOrThrow({ where: { id: task.id } }))
                    .status,
                ).toBe(applied ? "applied" : "review");
                if (applied)
                  expect(
                    await handles.prisma.learningTaskReview.findFirst({
                      where: { taskId: task.id },
                    }),
                  ).toMatchObject({ reason: approved.reason });
              };
            } else {
              Object.assign(approved, {
                documentId: initial.id,
                revision: name === "memory_undo" ? 2 : 1,
                expectedRevision: 2,
                reviewedContent: content,
                reason: "Owner reviewed the full document",
              });
              verify = async (applied) => {
                expect(
                  await handles.prisma.memoryDocument.findUniqueOrThrow({
                    where: { id: initial.id },
                  }),
                ).toMatchObject({
                  content: applied ? content : changed ? "Newer staff edit" : replacement,
                  revision: applied || changed ? 3 : 2,
                });
              };
            }
          } else {
            const skills = createAgentSkillStore(handles.prisma, []);
            const full = buildSkillMd({
              name: "Reviewed guidance",
              description: "Synthetic document",
              body: content.slice(0, 99000),
            });
            const initial =
              name === "skill_create"
                ? null
                : await skills.create(owner, { content: full, reason: "Synthetic baseline" });
            let previous = full;
            let revision = 1;
            if (name === "skill_undo" || name === "skill_restore") {
              previous = full.replace("Start", "Later");
              await skills.update(owner, {
                skillId: initial!.id,
                expectedRevision: 1,
                content: previous,
                reason: "Synthetic edit",
              });
              revision = 2;
            }
            Object.assign(
              approved,
              name === "skill_create" || name === "skill_update"
                ? {
                    ...(initial ? { skillId: initial.id } : {}),
                    expectedRevision: initial ? 1 : 0,
                    content: full.replace("Start", "Final"),
                    reason: "Owner reviewed the full skill",
                  }
                : {
                    skillId: initial!.id,
                    expectedRevision: revision,
                    reviewedContent: full,
                    reason: "Owner reviewed the full skill",
                    ...(name !== "skill_delete"
                      ? { revision: name === "skill_undo" ? 2 : 1, reviewedRemoved: false }
                      : {}),
                  },
            );
            change = async () => {
              await skills.update(owner, {
                skillId: initial!.id,
                expectedRevision: 1,
                body: "Newer staff edit",
                reason: "Intervening edit",
              });
            };
            verify = async (applied) => {
              const row = await handles.prisma.agentSkill.findFirst({
                where: { ...owner, name: "Reviewed guidance" },
              });
              if (!initial && !applied) {
                expect(row).toBeNull();
                return;
              }
              expect(row?.revision).toBe(
                applied
                  ? initial
                    ? revision + (secondApplied ? 2 : 1)
                    : 1
                  : changed
                    ? 2
                    : revision,
              );
              expect(Boolean(row?.removedAt)).toBe(applied && name === "skill_delete");
              if (changed) expect(row?.content).toContain("Newer staff edit");
              else
                expect(row?.content).toBe(
                  applied
                    ? String(
                        secondApplied
                          ? secondApproved!.content
                          : (approved.content ?? approved.reviewedContent),
                      )
                    : previous,
                );
              expect(
                await handles.prisma.agentSkill.count({ where: { ...owner, name: "Unapproved" } }),
              ).toBe(0);
            };
          }
          const sent = await rpc<{ runId: string }>("threads/send", {
            botId: bot.id,
            text: "Review and apply the complete document change.",
          });
          const wait = async (status: string) => {
            await expect
              .poll(
                async () => {
                  const row = await handles.prisma.run.findUniqueOrThrow({
                    where: { id: sent.runId },
                  });
                  if (row.status === "failed") model.assertComplete();
                  return row.status;
                },
                { timeout: 15000, interval: 100 },
              )
              .toBe(status);
          };
          await wait("waiting_input");
          const card = await handles.prisma.message.findFirstOrThrow({
            where: { runId: sent.runId, role: "bot" },
            orderBy: { seq: "desc" },
          });
          const ask = (card.blocks as MessageBlock[]).find((block) => block.kind === "ask");
          if (ask?.kind !== "ask") throw new Error("Missing approval");
          expect(JSON.parse(ask.detail!)).toEqual(approved);
          expect(ask.detail!.length).toBeGreaterThan(answer === "escaped" ? 1_000_000 : 99000);
          expect(ask.actions).toEqual([
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ]);
          await verify(false);
          if (answer === "stale") {
            await change();
            changed = true;
          }
          if (answer === "fifo") {
            secondApproved = {
              ...approved,
              expectedRevision: Number(approved.expectedRevision) + 1,
              content: String(approved.content).replace("Start", "Second"),
            };
            // Seed a second retained approval before releasing the first card. Both
            // requests are scoped to this run; the real executor must keep FIFO.
            await handles.prisma.externalEffect.create({
              data: {
                spaceId: owner.spaceId,
                runId: sent.runId,
                kind: name,
                idempotencyKey: approvalEffectKey(sent.runId, name, secondApproved),
                status: "approved",
                request: secondApproved as never,
              },
            });
          }
          await rpc("threads/answer", {
            botId: bot.id,
            runId: sent.runId,
            messageId: card.id,
            answer: answer === "deny" ? "deny" : "allow",
          });
          await wait("completed");
          model.assertComplete();
          await verify(succeeds);
          expect(
            await handles.prisma.externalEffect.count({ where: { runId: sent.runId, kind: name } }),
          ).toBe(answer === "fifo" ? 2 : 1);
        } finally {
          try {
            await stop?.();
          } finally {
            await model.close();
            await rm(dataDir, { recursive: true, force: true });
          }
        }
      });
    }
  }
});
