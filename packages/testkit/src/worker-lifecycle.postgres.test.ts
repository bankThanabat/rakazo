import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CustomerBindingSchema } from "@rakazo/contracts";
import {
  createCustomerInbox,
  createDb,
  createLearning,
  createLearningHistory,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenConnector } from "../../adapters/src/open-connector.js";
import { createOpenConnectorFixture } from "../../adapters/src/open-connector-test-fixture.js";
import { GraphileJobPublisher } from "../../adapters/src/wakeup.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const root = fileURLToPath(new URL("../../../", import.meta.url));

describe.skipIf(!enabled).sequential("worker process lifecycle", () => {
  const name = `worker_check_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  let databaseUrl: string;
  let databaseCreated = false;
  let roleCreated = false;

  beforeAll(async () => {
    admin = createDb(process.env.DATABASE_URL!);
    // Each file owns a database so a real worker cannot consume another suite's jobs.
    await admin.pool.query(`CREATE ROLE ${name} LOGIN PASSWORD 'fixture-only'`);
    roleCreated = true;
    await admin.pool.query(`CREATE DATABASE ${name} OWNER ${name}`);
    databaseCreated = true;
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    url.username = name;
    url.password = "fixture-only";
    url.search = "";
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "worker-lifecycle-"));
    // Stop loadRootEnv here rather than reading a maintainer's configuration.
    await writeFile(path.join(directory, ".env"), "");
    await promisify(execFile)(
      "pnpm",
      ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    db = createDb(databaseUrl);
  }, 90_000);

  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
    if (databaseCreated) await admin.pool.query(`DROP DATABASE ${name} WITH (FORCE)`);
    if (roleCreated) await admin.pool.query(`DROP ROLE ${name}`);
    await admin?.prisma.$disconnect();
    await admin?.pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function worker() {
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.join(root, "apps/worker/src/index.ts")],
      {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          LOG_LEVEL: "info",
          LOG_FORMAT: "json",
          DATABASE_URL: databaseUrl,
          DATA_DIR: directory,
          ENCRYPTION_KEY: "fake-secret-storage-key",
          AGENT_RUNTIME: "scripted",
          SANDBOX_PROVIDER: "fake",
          CLOUD_AGENT_PROVIDER: "emulator",
          WAKEUP_DRIVER: "graphile",
          GRAPHILE_WORKER_CONCURRENCY: "1",
        },
      },
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.stderr?.on("data", (data) => {
      output += data;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 70_000);
    void exited.finally(() => clearTimeout(deadline));
    return {
      child,
      exited,
      output: () => output,
      async waitForLog(message: string) {
        await vi.waitFor(
          () => {
            expect(child.exitCode, output).toBeNull();
            expect(child.signalCode, output).toBeNull();
            expect(output).toContain(message);
          },
          { timeout: 35_000, interval: 50 },
        );
      },
      async dispose() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      },
    };
  }

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "resumes history after %s without repeating committed records",
    async (signal) => {
      const owner = await provisionMessagingIdentity(
        db.prisma,
        { provider: "test", address: randomUUID() },
        {
          signupsEnabled: "true",
          signupAllowlist: undefined,
        },
      );
      const actor = { userId: owner.userId, spaceId: owner.spaceId };
      const windowEnd = new Date().toISOString();
      const saved = await createLearning(db.prisma).archive(actor, {
        botId: owner.botId,
        format: "json",
        source: "Synthetic history",
        windowEnd,
        content: JSON.stringify(
          Array.from({ length: 205 }, (_, i) => ({
            thread_id: "fixture-thread",
            message_id: `reply-${i}`,
            author_role: "business",
            sent_at: new Date(Date.now() - 86_400_000).toISOString(),
            text: `Synthetic business greeting ${i}.`,
          })),
        ),
      });
      const history = await createLearningHistory(db.prisma).start(actor, owner.botId, {
        sourceId: saved.sourceId,
        scope: "bot",
        source: { kind: "export", key: "fixture-export" },
      });
      const state = () =>
        db.prisma.learningHistory.findUniqueOrThrow({ where: { id: history.id } });
      const first = worker();
      try {
        await first.waitForLog("worker ready");
        await vi.waitFor(async () => expect((await state()).nextRow).toBe(100), {
          timeout: 20_000,
          interval: 20,
        });
        first.child.kill(signal);
        expect(await first.exited, first.output()).toEqual(
          signal === "SIGKILL" ? { code: null, signal } : { code: 0, signal: null },
        );
        expect(await state()).toMatchObject({ status: "queued", nextRow: 100, accepted: 100 });
      } finally {
        await first.dispose();
      }
      const second = worker();
      try {
        await second.waitForLog("worker ready");
        await vi.waitFor(
          async () =>
            expect(await state(), second.output()).toMatchObject({
              status: "complete",
              nextRow: 205,
              accepted: 205,
              duplicates: 0,
            }),
          { timeout: 45_000, interval: 50 },
        );
        second.child.kill("SIGINT");
        expect(await second.exited, second.output()).toEqual({ code: 0, signal: null });
        expect(await db.prisma.learningHistoryItem.count({ where: { botId: owner.botId } })).toBe(
          205,
        );
        expect(
          (
            await db.prisma.learningImport.findUniqueOrThrow({ where: { id: saved.sourceId } })
          ).windowEnd.toISOString(),
        ).toBe(windowEnd);
      } finally {
        await second.dispose();
      }
    },
    120_000,
  );

  it("does not repeat a customer send after the worker dies before confirmation", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createOpenConnectorFixture(async () => {
      await held;
      return { id: "synthetic-delivered-reply" };
    });
    const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        }
        const reply = await fixture.fetcher(`https://connector.example.test${request.url}`, {
          method: request.method,
          headers,
          redirect: "error",
          body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
        });
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(await reply.text());
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const config = { provider: "open-connector", endpoint, apiKey: "fake-admin-token" };
    const publisher = new GraphileJobPublisher(db.pool);
    const children: ReturnType<typeof worker>[] = [];
    try {
      const owner = await provisionMessagingIdentity(
        db.prisma,
        { provider: "test", address: randomUUID() },
        {
          signupsEnabled: "true",
          signupAllowlist: undefined,
        },
      );
      const adapter = new OpenConnector(
        { ...config, identitySecret: "fake-secret-storage-key" },
        {
          prisma: db.prisma,
          secrets: fixture.secrets,
        },
      );
      const auth = await adapter.begin(
        {
          provider: "sample",
          credential: "fake-account-token",
          redirectUrl: "https://example.test",
        },
        {
          ...owner,
          operationId: "fixture-setup",
          traceId: "fixture-setup",
          signal: AbortSignal.timeout(10_000),
        },
      );
      await db.prisma.integrationProviderConfig.create({
        data: {
          id: "open-connector",
          ciphertext: fixture.secrets.seal(
            JSON.stringify(config),
            "integration-provider:open-connector",
          ),
        },
      });
      const connection = await db.prisma.connection.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          connectorId: "open-connector",
          provider: "sample",
          displayName: "Synthetic messaging",
          status: "connected",
          providerRef: auth.state,
        },
      });
      const channel = await db.prisma.customerChannel.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: owner.botId,
          provider: "sample",
          accountId: randomUUID(),
          name: "Synthetic messaging",
          ciphertext: "",
          connectionId: connection.id,
          binding: CustomerBindingSchema.parse({
            receive: {
              action: "sample.list",
              input: {},
              items: ["messages"],
              incoming: { path: ["incoming"], equals: true },
              fields: {
                id: ["id"],
                threadId: ["thread"],
                customerId: ["customer"],
                body: ["body"],
                timestamp: ["at"],
              },
            },
            send: {
              action: "sample.send",
              input: { to: "$threadId", texts: ["$body"], retryKey: "$messageId" },
            },
          }),
        },
      });
      const inbox = createCustomerInbox(db.prisma);
      const id = await inbox.receive(channel.id, {
        externalId: "question",
        externalThreadId: "fixture-thread",
        customerId: "fixture-customer",
        name: "Synthetic customer",
        body: "When is dispatch?",
      });
      const input = { id, body: "Dispatch is tomorrow.", nonce: "fixture-reply" };
      await inbox.reply(owner, input);
      const message = await db.prisma.customerMessage.findFirstOrThrow({
        where: { conversationId: id, role: "staff" },
      });
      const first = worker();
      children.push(first);
      await first.waitForLog("worker ready");
      await vi.waitFor(() => expect(fixture.sent).toHaveLength(1), { timeout: 15_000 });
      expect(
        await db.prisma.customerMessage.findUniqueOrThrow({ where: { id: message.id } }),
      ).toMatchObject({ status: "sending", sendAttempts: 1 });
      first.child.kill("SIGKILL");
      expect(await first.exited).toEqual({ code: null, signal: "SIGKILL" });
      release();
      // Advance only this fixture's persisted lease, avoiding a two-minute wall-clock wait.
      await db.prisma.customerConversation.update({
        where: { id },
        data: { leaseUntil: new Date(0) },
      });
      const second = worker();
      children.push(second);
      await second.waitForLog("worker ready");
      await vi.waitFor(
        async () =>
          expect(
            await db.prisma.customerConversation.findUniqueOrThrow({ where: { id } }),
          ).toMatchObject({ owner: "staff", needsHuman: true, leaseToken: null }),
        { timeout: 15_000 },
      );
      // Repeated submission and queue delivery must both preserve the original send.
      await inbox.reply(owner, input);
      const key = `fixture-replay:${id}`;
      await publisher.enqueue({
        name: "customer.process",
        payload: { conversationId: id },
        replaceKey: key,
      });
      await vi.waitFor(
        async () =>
          expect(
            Number(
              (
                await db.pool.query(
                  "SELECT count(*) FROM graphile_worker._private_jobs WHERE key=$1",
                  [key],
                )
              ).rows[0].count,
            ),
          ).toBe(0),
        { timeout: 10_000 },
      );
      expect(fixture.sent).toHaveLength(1);
      expect(
        await db.prisma.customerMessage.findUniqueOrThrow({ where: { id: message.id } }),
      ).toMatchObject({
        status: "failed",
        errorCode: "execution_uncertain",
        sendAttempts: 1,
        sentParts: 0,
      });
      expect(errors).toEqual([]);
      second.child.kill("SIGTERM");
      expect(await second.exited, second.output()).toEqual({ code: 0, signal: null });
    } finally {
      release();
      for (const child of children) await child.dispose();
      await publisher.close();
      await db.prisma.integrationProviderConfig.deleteMany({ where: { id: "open-connector" } });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);

  it("shuts down while waiting for database capacity without becoming ready", async () => {
    await admin.pool.query(`ALTER ROLE ${name} CONNECTION LIMIT 0`);
    const pending = worker();
    try {
      await pending.waitForLog("worker job host start waiting on database capacity");
      pending.child.kill("SIGTERM");
      await admin.pool.query(`ALTER ROLE ${name} CONNECTION LIMIT -1`);
      expect(await pending.exited, pending.output()).toEqual({ code: 0, signal: null });
      expect(pending.output()).not.toContain('"message":"worker ready"');
    } finally {
      await admin.pool.query(`ALTER ROLE ${name} CONNECTION LIMIT -1`);
      await pending.dispose();
    }
  }, 60_000);
});
