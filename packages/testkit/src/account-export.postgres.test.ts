import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, LocalArtifactStore } from "@rakazo/adapters";
import type { AccountExportRecord } from "@rakazo/db";
import { writeAccountExport } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
describe.skipIf(!enabled)("account data export", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "account-export-test-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
    });
  });
  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function signup() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `export-${randomUUID()}@rakazo.test`,
        name: "Synthetic shop",
        password: "password12",
      }),
    });
    expect(response.status).toBe(200);
    const cookie = sessionCookieHeader(response);
    const result = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: '{"json":{}}',
    });
    const { json } = (await result.json()) as { json: { userId: string; spaceId: string } };
    return { ...json, cookie };
  }
  const request = (cookie?: string) =>
    handles.app.request("/api/account/export", {
      headers: { origin, ...(cookie ? { cookie } : {}) },
    });
  function parse(text: string): AccountExportRecord[] {
    return text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  async function bot(actor: { userId: string; spaceId: string }) {
    return handles.prisma.bot.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        name: "Export fixture",
        color: "blue",
        learningEnabled: false,
        thread: { create: { userId: actor.userId, spaceId: actor.spaceId } },
      },
      include: { thread: true },
    });
  }
  async function channel(
    actor: { userId: string; spaceId: string },
    botId: string,
    shared: boolean,
    body: string,
  ) {
    return handles.prisma.customerChannel.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId,
        provider: "web",
        accountId: randomUUID(),
        name: "Synthetic channel",
        ciphertext: "CREDENTIAL_SENTINEL",
        enabled: false,
        shared,
        conversations: {
          create: {
            customerId: "synthetic",
            externalThreadId: randomUUID(),
            name: "Synthetic visitor",
            leaseToken: "LEASE_SENTINEL",
            operationReceipts: {
              create: {
                connectionId: "synthetic-store",
                action: "invoice.create",
                recordKey: "synthetic-order",
                mapping: { invoice: ["id"] },
                reviewHistory: [
                  {
                    decision: "retry",
                    attempt: 0,
                    userId: actor.userId,
                    reason: body,
                    providerReference: "synthetic-rejection",
                    failureStatus: "rejected",
                    at: "2026-09-18T00:00:00.000Z",
                  },
                ],
                operation: {
                  create: {
                    id: randomUUID(),
                    spaceId: actor.spaceId,
                    requestHash: "REQUEST_HASH_SENTINEL",
                    status: "retry_ready",
                    attempt: 1,
                  },
                },
              },
            },
            messages: {
              create: {
                seq: 1,
                role: "customer",
                body,
                executionKeyHash: "EXECUTION_SENTINEL",
                providerHandle: "HANDLE_SENTINEL",
                toolCalls: {
                  create: {
                    callId: "synthetic-call",
                    requestHash: "fixture",
                    name: "Check stock",
                    status: "completed",
                    result: { stock: 3 },
                  },
                },
              },
            },
          },
        },
      },
    });
  }
  it("requires authentication", async () => {
    const response = await request();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("exports paginated owned cloud work without credential bindings or inaccessible neighbors", async () => {
    const owner = await signup();
    const other = await signup();
    const ownBot = await bot(owner);
    const data = Array.from({ length: 205 }, (_, index) => ({
      id: randomUUID(),
      operationKey: randomUUID(),
      providerKey: "BINDING_SENTINEL",
      userId: owner.userId,
      spaceId: owner.spaceId,
      botId: ownBot.id,
      threadId: ownBot.thread!.id,
      title: `Cloud task ${index}`,
      status: "finished",
      remoteId: `remote-${index}`,
      leaseToken: "LEASE_SENTINEL",
      nextPollAt: null,
      launchRequest: {
        prompt: `Own prompt ${index}`,
        repository: "https://example.test/repo",
        openPr: false,
        apiKey: "CREDENTIAL_SENTINEL",
        env: { KEY: "ENV_SENTINEL" },
        images: [{ data: "aW1hZ2U=", mimeType: "image/png", token: "IMAGE_SENTINEL" }],
      },
      followup: { prompt: "Pending correction", token: "FOLLOWUP_SENTINEL" },
    }));
    await handles.prisma.cloudAgent.createMany({ data });
    await handles.prisma.cloudAgent.createMany({
      data: [
        {
          ...data[0]!,
          id: randomUUID(),
          operationKey: randomUUID(),
          userId: other.userId,
          title: "FOREIGN_SENTINEL",
        },
        {
          ...data[0]!,
          id: randomUUID(),
          operationKey: randomUUID(),
          spaceId: other.spaceId,
          title: "REVOKED_SPACE_SENTINEL",
        },
      ],
    });
    // Cloud recovery rows can outlive the original bot and thread.
    await handles.prisma.bot.delete({ where: { id: ownBot.id } });
    const response = await request(owner.cookie);
    expect(response.status).toBe(200);
    const text = await response.text();
    const records = parse(text);
    const clouds = records.filter((record) => record.type === "cloudAgent");
    expect(clouds).toHaveLength(205);
    expect(new Set(clouds.map((record) => (record.data as { id: string }).id)).size).toBe(205);
    expect(clouds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            title: "Cloud task 204",
            remoteId: "remote-204",
            launchRequest: {
              prompt: "Own prompt 204",
              repository: "https://example.test/repo",
              openPr: false,
              images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
            },
            followup: { prompt: "Pending correction" },
          }),
        }),
      ]),
    );
    expect(text).not.toContain("SENTINEL");
    expect(records.at(-1)).toMatchObject({
      type: "complete",
      data: { counts: { cloudAgent: 205 } },
    });
  });

  it("exports linked identity audit without the provider account reference or inaccessible cases", async () => {
    const owner = await signup();
    const other = await signup();
    for (const actor of [owner, other]) {
      const agent = await bot(actor);
      const created = await channel(
        actor,
        agent.id,
        false,
        actor === owner ? "Owned case" : "FOREIGN_IDENTITY_SENTINEL",
      );
      const conversation = await handles.prisma.customerConversation.findFirstOrThrow({
        where: { channelId: created.id },
      });
      const connection = await handles.prisma.connection.create({
        data: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          connectorId: "open-connector",
          provider: "fixture",
          displayName: "Fixture merchant",
          status: "connected",
          providerRef: "PROVIDER_REF_SENTINEL",
        },
      });
      await handles.prisma.customerPurchase.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          customerId: "synthetic",
          connectionId: connection.id,
          providerRef: "PROVIDER_REF_SENTINEL",
          activeKey: randomUUID(),
          requestHash: "REQUEST_HASH_SENTINEL",
          paymentMethods: ["bacs"],
          status: "open",
          ciphertext: "CART_CREDENTIAL_SENTINEL",
          summary: { total: actor === owner ? "12500" : "FOREIGN_PURCHASE_SENTINEL" },
          history: [{ kind: "create", result: "confirmed" }],
        },
      });
      await handles.prisma.customerIdentity.create({
        data: {
          conversationId: conversation.id,
          customerId: "synthetic",
          connectionId: connection.id,
          providerRef: "PROVIDER_REF_SENTINEL",
          value: 7,
          history: [
            { revision: 1, value: 7, userId: actor.userId, reason: "Verified account ownership" },
          ],
        },
      });
    }
    const response = await request(owner.cookie);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("SENTINEL");
    expect(parse(text).filter((row) => row.type === "customerPurchase")).toMatchObject([
      { data: { summary: { total: "12500" }, history: [{ kind: "create", result: "confirmed" }] } },
    ]);
    expect(parse(text).filter((row) => row.type === "customerIdentity")).toMatchObject([
      { data: { value: 7, revision: 1, history: [{ reason: "Verified account ownership" }] } },
    ]);
  });
  it("exports full paginated records and files, with shared access but no private neighbors or credentials", async () => {
    const owner = await signup();
    const neighbor = await signup();
    const organization = await handles.prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
    });
    await handles.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: organization.organizationId,
        userId: neighbor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const ownBot = await bot(owner);
    await handles.prisma.aiDataConsent.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        recipientKey: "synthetic-model",
        version: "fixture",
      },
    });
    const secret = await handles.prisma.secret.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        kind: "fixture",
        ciphertext: "SECRET_STORE_SENTINEL",
      },
    });
    await handles.prisma.userModelCredential.create({
      data: {
        userId: owner.userId,
        provider: "fixture",
        label: "Synthetic model",
        secretId: secret.id,
      },
    });
    await handles.prisma.userVoiceCredential.create({
      data: { userId: owner.userId, provider: "fixture", secretId: secret.id },
    });
    await handles.prisma.customerBehavior.create({
      data: {
        botId: ownBot.id,
        flowId: "fixture",
        instructions: "Only verified stock",
        runtime: { token: "RUNTIME_CONFIG_SENTINEL" },
      },
    });
    await handles.prisma.mcpServer.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        slug: "fixture",
        name: "Synthetic MCP",
        transport: "http",
        headers: { authorization: "MCP_HEADER_SENTINEL" },
        env: { API_KEY: "MCP_ENV_SENTINEL" },
        secretId: secret.id,
      },
    });
    const neighborActor = { userId: neighbor.userId, spaceId: owner.spaceId };
    const privateBot = await bot(neighborActor);
    await handles.prisma.message.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        threadId: ownBot.thread!.id,
        seq: index + 1,
        role: "user",
        blocks: [{ type: "text", text: `ไทย\nMessage ${index}` }],
      })),
    });
    await handles.prisma.message.create({
      data: {
        threadId: privateBot.thread!.id,
        seq: 1,
        role: "user",
        blocks: [{ type: "text", text: "PRIVATE_STAFF_SENTINEL" }],
      },
    });
    await channel(neighborActor, privateBot.id, false, "PRIVATE_CUSTOMER_SENTINEL");
    await channel(neighborActor, privateBot.id, true, "Shared customer question");
    await channel(
      { userId: neighbor.userId, spaceId: neighbor.spaceId },
      (await bot(neighbor)).id,
      true,
      "OTHER_SPACE_SENTINEL",
    );
    const archive = (actor: { userId: string; spaceId: string }, botId: string, content: string) =>
      handles.prisma.learningImport.create({
        data: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          botId,
          digest: randomUUID(),
          label: "Synthetic history",
          format: "json",
          content,
          coverage: {},
          windowEnd: new Date(),
        },
      });
    await archive(owner, ownBot.id, "My imported replies");
    await archive(neighborActor, privateBot.id, "PRIVATE_IMPORT_SENTINEL");
    await handles.prisma.memoryDocument.create({
      data: {
        ...neighborActor,
        botId: privateBot.id,
        scope: "bot",
        path: "memory.md",
        content: "PRIVATE_MEMORY_SENTINEL",
      },
    });
    await handles.prisma.memoryDocument.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: ownBot.id,
        scope: "bot",
        path: "memory.md",
        content: "Remember the approved wording",
        revisions: { create: { revision: 1, content: "Original wording" } },
      },
    });
    await handles.prisma.connection.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        provider: "fixture",
        displayName: "Synthetic connection",
        status: "connected",
        secretId: "SECRET_ID_SENTINEL",
        providerRef: "PROVIDER_REF_SENTINEL",
        metadata: { token: "METADATA_SENTINEL" },
      },
    });
    const store = new LocalArtifactStore(dataDir);
    const context = {
      ...owner,
      botId: ownBot.id,
      signal: new AbortController().signal,
      operationId: "fixture",
      traceId: "fixture",
    };
    const bytes = Buffer.from("Synthetic file\nสวัสดี\u0000");
    const stored = await store.put(
      { name: "example.bin", mimeType: "application/octet-stream", bytes },
      context,
    );
    await handles.prisma.artifact.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: ownBot.id,
        name: "example.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
        storageKey: stored.id,
      },
    });
    const revisionId = randomUUID();
    await handles.prisma.knowledgeLibrary.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        baseUrl: "https://knowledge.example.test",
        ciphertext: "KNOWLEDGE_SECRET_SENTINEL",
        sources: {
          create: {
            name: "Original document",
            activeRevisionId: revisionId,
            revisions: {
              create: [
                {
                  id: revisionId,
                  name: "Current original",
                  storageKey: stored.id,
                  mimeType: "text/plain",
                  providerDocumentKey: "PROVIDER_DOCUMENT_SENTINEL",
                  status: "ready",
                },
                {
                  name: "Superseded original",
                  storageKey: "already-erased",
                  mimeType: "text/plain",
                  providerDocumentKey: randomUUID(),
                  status: "ready",
                },
              ],
            },
          },
        },
      },
    });
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("deskazo-export-"));
    const response = await request(owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("deskazo-account.jsonl");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBe(Number(response.headers.get("content-length")));
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain(stored.id);
    expect(text).not.toContain(secret.id);
    expect(text).toContain("Shared customer question");
    expect(text).toContain("My imported replies");
    expect(text).toContain("Original wording");
    const records = parse(text);
    expect(records.some((record) => record.type === "aiDataConsent")).toBe(true);
    expect(records.some((record) => record.type === "modelConnection")).toBe(true);
    expect(records.filter((record) => record.type === "knowledgeFile")).toHaveLength(1);
    expect(records.filter((record) => record.type === "customerAction")).toHaveLength(1);
    expect(records.filter((record) => record.type === "customerOperationReceipt")).toMatchObject([
      {
        data: {
          operation: { status: "retry_ready", attempt: 1 },
          reviewHistory: [{ reason: "Shared customer question", failureStatus: "rejected" }],
        },
      },
    ]);
    expect(text).not.toContain("REQUEST_HASH_SENTINEL");
    expect(text).toContain("Only verified stock");
    expect(text).not.toContain("Superseded original");
    expect(records[0]?.type).toBe("manifest");
    expect(records.at(-1)?.type).toBe("complete");
    const messages = records.filter((record) => record.type === "message");
    expect(messages).toHaveLength(205);
    const file = records.find((record) => record.type === "file")!.data as {
      contentBase64: string;
    };
    expect(Buffer.from(file.contentBase64, "base64")).toEqual(bytes);
    const counts = (records.at(-1)!.data as { counts: Record<string, number> }).counts;
    for (const [type, count] of Object.entries(counts))
      expect(records.filter((record) => record.type === type)).toHaveLength(count);
    await expect
      .poll(async () =>
        (await readdir(tmpdir())).filter((name) => name.startsWith("deskazo-export-")),
      )
      .toEqual(before);
  });
  it("keeps a consistent snapshot across pages while messages change", async () => {
    const owner = await signup();
    const ownBot = await bot(owner);
    await handles.prisma.message.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        threadId: ownBot.thread!.id,
        seq: index + 1,
        role: "user",
        blocks: [{ type: "text", text: "Before edit" }],
      })),
    });
    const records: AccountExportRecord[] = [];
    let mutated = false;
    await writeAccountExport(
      handles.prisma,
      owner.userId,
      async (record) => {
        records.push(record);
        if (record.type === "message" && !mutated) {
          mutated = true;
          await handles.prisma.message.updateMany({
            where: { threadId: ownBot.thread!.id },
            data: { blocks: [{ type: "text", text: "After edit" }] },
          });
        }
      },
      async () => {
        throw new Error("Unexpected file");
      },
      new AbortController().signal,
    );
    expect(records.filter((record) => record.type === "message")).toHaveLength(105);
    expect(JSON.stringify(records)).not.toContain("After edit");
  });
  it("keeps later pages in the original snapshot after deleting the cursor and inserting messages", async () => {
    const owner = await signup();
    const ownBot = await bot(owner);
    const threadId = ownBot.thread!.id;
    const ids = Array.from(
      { length: 205 },
      (_, index) => `${threadId}-${String(index).padStart(4, "0")}`,
    );
    await handles.prisma.message.createMany({
      data: ids.map((id, index) => ({ id, threadId, seq: index + 1, role: "user", blocks: [] })),
    });
    const exported: string[] = [];
    await writeAccountExport(
      handles.prisma,
      owner.userId,
      async (record) => {
        if (record.type !== "message") return;
        exported.push((record.data as { id: string }).id);
        if (exported.length !== 100) return;
        await handles.prisma.message.deleteMany({ where: { threadId } });
        await handles.prisma.message.create({
          data: { id: `${threadId}-new`, threadId, seq: 1, role: "user", blocks: [] },
        });
      },
      async () => {
        throw new Error("Unexpected file");
      },
      new AbortController().signal,
    );
    expect(exported).toEqual(ids);
    expect(await handles.prisma.message.count({ where: { threadId } })).toBe(1);
  });

  // Deliberately opt-in: these acceptance fixtures exercise the real archive limits.
  describe.skipIf(process.env.VERIFY_LARGE_ACCOUNT_EXPORT !== "1")("large archives", () => {
    async function seedMessages(threadId: string, count: number, text: string) {
      for (let start = 0; start < count; start += 1_000) {
        await handles.prisma.message.createMany({
          data: Array.from({ length: Math.min(1_000, count - start) }, (_, offset) => ({
            id: `${threadId}-${String(start + offset).padStart(6, "0")}`,
            threadId,
            seq: start + offset + 1,
            role: "user",
            blocks: [{ type: "text", text }],
          })),
        });
      }
    }

    it("downloads and validates more than 80 MiB across 200 message pages", async () => {
      const owner = await signup();
      const ownBot = await bot(owner);
      const content = `สวัสดี\n${"x".repeat(4_096)}`;
      await seedMessages(ownBot.thread!.id, 20_000, content);
      const response = await request(owner.cookie);
      expect(response.status).toBe(200);
      expect(Number(response.headers.get("content-length"))).toBeGreaterThan(80 * 1024 * 1024);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const counts: Record<string, number> = {};
      let buffer = "";
      let bytes = 0;
      let sequence = 0;
      let complete = false;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        buffer += decoder.decode(chunk.value, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const record = JSON.parse(buffer.slice(0, newline)) as AccountExportRecord;
          buffer = buffer.slice(newline + 1);
          expect(complete).toBe(false);
          if (record.type === "complete") {
            expect(record.data).toEqual({ counts });
            complete = true;
          } else {
            counts[record.type] = (counts[record.type] ?? 0) + 1;
          }
          if (record.type === "message") {
            const message = record.data as { id: string; seq: number; blocks: unknown };
            expect(message.id).toBe(`${ownBot.thread!.id}-${String(sequence).padStart(6, "0")}`);
            expect(message.seq).toBe(++sequence);
            expect(message.blocks).toEqual([{ type: "text", text: content }]);
          }
        }
      }
      buffer += decoder.decode();
      expect(buffer).toBe("");
      expect(complete).toBe(true);
      expect(sequence).toBe(20_000);
      expect(bytes).toBe(Number(response.headers.get("content-length")));
    }, 120_000);

    it("rejects more than 100,000 records without a partial download and permits retry", async () => {
      const owner = await signup();
      const ownBot = await bot(owner);
      const threadId = ownBot.thread!.id;
      await seedMessages(threadId, 100_001, "Synthetic record");
      const response = await request(owner.cookie);
      expect(response.status).toBe(413);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.json()).toMatchObject({ code: "EXPORT_TOO_LARGE" });
      await handles.prisma.message.deleteMany({ where: { threadId, seq: { gt: 205 } } });
      const retry = await request(owner.cookie);
      expect(retry.status).toBe(200);
      const records = parse(await retry.text());
      expect(records.filter((record) => record.type === "message")).toHaveLength(205);
      expect(records.at(-1)?.type).toBe("complete");
    }, 120_000);

    it("rejects accumulated message content above 100 MiB and releases the export slot", async () => {
      const owner = await signup();
      const ownBot = await bot(owner);
      const threadId = ownBot.thread!.id;
      await seedMessages(threadId, 1_000, "x".repeat(110 * 1024));
      const response = await request(owner.cookie);
      expect(response.status).toBe(413);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.json()).toMatchObject({ code: "EXPORT_TOO_LARGE" });
      await handles.prisma.message.deleteMany({ where: { threadId, seq: { gt: 1 } } });
      const retry = await request(owner.cookie);
      expect(retry.status).toBe(200);
      const records = parse(await retry.text());
      expect(records.filter((record) => record.type === "message")).toHaveLength(1);
      expect(records.at(-1)?.type).toBe("complete");
    }, 120_000);
  });
  it("refuses missing or corrupt files and lets the user retry", async () => {
    const owner = await signup();
    const ownBot = await bot(owner);
    const data = {
      userId: owner.userId,
      spaceId: owner.spaceId,
      botId: ownBot.id,
      name: "missing.txt",
      mimeType: "text/plain",
      size: 5,
      hash: "bad-hash",
      storageKey: randomUUID(),
    };
    const artifact = await handles.prisma.artifact.create({ data });
    expect((await request(owner.cookie)).status).toBe(503);
    const store = new LocalArtifactStore(dataDir);
    const stored = await store.put(
      { name: "example.txt", mimeType: "text/plain", bytes: Buffer.from("hello") },
      {
        ...owner,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      },
    );
    await handles.prisma.artifact.update({
      where: { id: artifact.id },
      data: { storageKey: stored.id },
    });
    expect((await request(owner.cookie)).status).toBe(503);
    await handles.prisma.artifact.update({
      where: { id: artifact.id },
      data: { hash: createHash("sha256").update("hello").digest("hex") },
    });
    const success = await request(owner.cookie);
    expect(success.status).toBe(200);
    expect(parse(await success.text()).at(-1)?.type).toBe("complete");
  });
  it("refuses an oversized archive before reading its file and permits a later retry", async () => {
    const owner = await signup();
    const ownBot = await bot(owner);
    const artifact = await handles.prisma.artifact.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: ownBot.id,
        name: "oversized.bin",
        mimeType: "application/octet-stream",
        size: 100 * 1024 * 1024,
        hash: "fixture",
        storageKey: "nonexistent",
      },
    });
    const response = await request(owner.cookie);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "EXPORT_TOO_LARGE" });
    await handles.prisma.artifact.delete({ where: { id: artifact.id } });
    const retry = await request(owner.cookie);
    expect(retry.status).toBe(200);
    expect(parse(await retry.text()).at(-1)?.type).toBe("complete");
  });
  it("rejects concurrent exports and leaves no named private file while generation is running", async () => {
    const owner = await signup();
    const ownBot = await bot(owner);
    const store = new LocalArtifactStore(dataDir);
    const stored = await store.put(
      { name: "example.txt", mimeType: "text/plain", bytes: Buffer.from("hello") },
      {
        ...owner,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      },
    );
    await handles.prisma.artifact.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: ownBot.id,
        name: "example.txt",
        mimeType: "text/plain",
        size: 5,
        hash: createHash("sha256").update("hello").digest("hex"),
        storageKey: stored.id,
      },
    });
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = LocalArtifactStore.prototype.get;
    const spy = vi
      .spyOn(LocalArtifactStore.prototype, "get")
      .mockImplementationOnce(async function (id, context) {
        entered();
        await gate;
        return original.call(this, id, context);
      });
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("deskazo-export-"));
    const pending = request(owner.cookie);
    try {
      await reading;
      expect((await request(owner.cookie)).status).toBe(429);
      expect(
        (await readdir(tmpdir())).filter((name) => name.startsWith("deskazo-export-")),
      ).toEqual(before);
    } finally {
      release();
      spy.mockRestore();
      const response = await pending;
      expect(response.status).toBe(200);
      await response.text();
    }
  });
});
