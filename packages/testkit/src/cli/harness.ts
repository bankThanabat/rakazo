import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { createApp } from "../../../../apps/api/src/app.ts";
import { runProcess } from "./process.js";

loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const specFilter = specArg?.slice("--spec=".length);
const testGrep = grepArg?.slice("--grep=".length);
const agentRuntime = runtimeArg?.slice("--runtime=".length) ?? "scripted";

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (!["fake", "e2b", "daytona", "box"].includes(sandboxProvider)) {
  throw new Error('Sandbox must be "fake", "e2b", "daytona", or "box"');
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (agentRuntime !== "pi" && agentRuntime !== "scripted") {
  throw new Error('Runtime must be "pi" or "scripted"');
}
if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}
if (sandboxProvider === "daytona" && !process.env.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required when --sandbox=daytona");
}
if (sandboxProvider === "box" && !process.env.BOX_API_KEY) {
  throw new Error("BOX_API_KEY is required when --sandbox=box");
}

async function main() {
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve("test-report", mode);
  await mkdir(reportDir, { recursive: true });
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  try {
    const databaseUrl = container.getConnectionUri();
    const apiPort = Number(process.env.API_PORT ?? 3110);
    const webPort = Number(process.env.WEB_PORT ?? 5180);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.REALTIME_DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = agentRuntime;
    // Playwright/E2E force the offline cloud-agent emulator; clear Cursor keys so cards never hit a live VM.
    process.env.CLOUD_AGENT_PROVIDER = "emulator";
    delete process.env.CURSOR_API_KEY;
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.SANDBOX_SUPERVISOR_TOKEN = "test-supervisor-token-test-32chars";
    process.env.SCREEN_PROXY_SECRET = "test-screen-proxy-secret-test-32chars";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    process.env.CI = "1";

    execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve("packages/db"),
    });

    if (integration) {
      const suites = specFilter
        ? [specFilter]
        : [
            "packages/testkit/src/pi-offline.postgres.test.ts",
            "packages/testkit/src/computer-approval.postgres.test.ts",
            "packages/testkit/src/semantic-memory-approval.postgres.test.ts",
            "packages/testkit/src/document-approval.postgres.test.ts",
            "packages/testkit/src/thread-message-pages.postgres.test.ts",
            "packages/testkit/src/semantic-memory-audit.postgres.test.ts",
            "packages/testkit/src/semantic-memory-direct.postgres.test.ts",
            "packages/testkit/src/semantic-history-compaction.postgres.test.ts",
            "packages/testkit/src/eval-history.postgres.test.ts",
            "packages/testkit/src/eval-customer-support.postgres.test.ts",
            "packages/testkit/src/customer-archive.postgres.test.ts",
            "packages/testkit/src/account-deletion.postgres.test.ts",
            "packages/adapters/src/account-deletion.postgres.test.ts",
            "packages/adapters/src/computer-provisions.postgres.test.ts",
            "packages/adapters/src/customer-publications.postgres.test.ts",
            "packages/adapters/src/customer-conversations.postgres.test.ts",
            "packages/adapters/src/customer-line-alerts.postgres.test.ts",
            "packages/adapters/src/integration-gateway.postgres.test.ts",
            "packages/adapters/src/instagram-comment-writes.postgres.test.ts",
            "packages/adapters/src/instagram-rate-gateway.postgres.test.ts",
            "apps/api/src/customer-website.postgres.test.ts",
            "packages/testkit/src/journeys.test.ts",
            "packages/testkit/src/mention-targets.test.ts",
            "packages/testkit/src/messaging.test.ts",
            "packages/testkit/src/runs-list.test.ts",
            "packages/testkit/src/authorization.test.ts",
            "packages/testkit/src/event-stream-revocation.postgres.test.ts",
            "packages/testkit/src/screen-revocation.postgres.test.ts",
            "packages/testkit/src/attachments.test.ts",
            "packages/testkit/src/voice.test.ts",
            "packages/testkit/src/search.test.ts",
            "packages/testkit/src/executor-lifecycle.test.ts",
            "packages/testkit/src/connections.test.ts",
            "packages/testkit/src/bot-secrets.test.ts",
            "packages/db/src/space-membership.postgres.test.ts",
            "packages/db/src/member-work-revocation.postgres.test.ts",
            "packages/db/src/customer-member-revocation.postgres.test.ts",
            "packages/db/src/messaging.postgres.test.ts",
            "packages/db/src/customer-schema.postgres.test.ts",
            "packages/db/src/connector-rate-limit.postgres.test.ts",
            "packages/testkit/src/account-export.postgres.test.ts",
            "packages/db/src/learning.postgres.test.ts",
            "packages/adapters/src/knowledge.postgres.test.ts",
            "packages/adapters/src/continued-learning.postgres.test.ts",
            "packages/adapters/src/social-learning.postgres.test.ts",
            "packages/adapters/src/learning-history.postgres.test.ts",
            "packages/adapters/src/customer-operation.postgres.test.ts",
            "packages/adapters/src/customer-identity.postgres.test.ts",
            "packages/adapters/src/customer-purchases.postgres.test.ts",
            "packages/memory/src/commit.postgres.test.ts",
            "packages/testkit/src/memory-audit.postgres.test.ts",
            "packages/testkit/src/skill-audit.postgres.test.ts",
            "packages/testkit/src/private-history.postgres.test.ts",
            "packages/adapters/src/wakeup.postgres.test.ts",
            "packages/testkit/src/worker-lifecycle.postgres.test.ts",
            "packages/adapters/src/realtime.postgres.test.ts",
            "packages/adapters/src/job-reconciler.postgres.test.ts",
            "packages/adapters/src/cloud-agent.postgres.test.ts",
          ];
      // Each app reconciles all durable work in its database, including intentionally
      // unfinished fixture runs. Clone the pristine migrated schema so one suite
      // cannot execute another suite's backlog or wait for it during shutdown.
      const template = container.getDatabase().replaceAll('"', '""');
      const databaseCommand = async (statement: string) => {
        const result = await container.exec([
          "psql",
          "-U",
          container.getUsername(),
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ]);
        if (result.exitCode !== 0)
          throw new Error("Isolated integration database operation failed");
      };
      for (const [index, suite] of suites.entries()) {
        const database = `integration_${index}`;
        await databaseCommand(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
        const suiteUrl = new URL(databaseUrl);
        suiteUrl.pathname = `/${database}`;
        try {
          await runProcess(
            "pnpm",
            ["exec", "vitest", "run", suite, ...(testGrep ? ["--testNamePattern", testGrep] : [])],
            {
              ...process.env,
              DATABASE_URL: suiteUrl.toString(),
              REALTIME_DATABASE_URL: suiteUrl.toString(),
              OPENROUTER_API_KEY: "",
              MODEL_API_KEY: "",
            },
          );
        } finally {
          await databaseCommand(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        }
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      return;
    }

    // Fixtures import database adapters too; generation must precede their module loading.
    const [
      {
        ComposioEmulator,
        EmailEmulator,
        EncryptedSecretStore,
        PipedreamConnector,
        ThirdPartyConnectorEmulator,
      },
      { createApp },
      { learningReviewFixture },
      { semanticHistoryFixture },
      { socialLearningFixture },
      { semanticApprovalFixture },
      { semanticDirectFixture },
    ] = await Promise.all([
      import("@rakazo/adapters"),
      import("../../../../apps/api/src/app.ts"),
      import("../fixtures/learning-review.js"),
      import("../fixtures/semantic-history.js"),
      import("../fixtures/social-learning.js"),
      import("./semantic-approval.js"),
      import("./semantic-direct.js"),
    ]);
    const { serve } = await import("@hono/node-server");
    const thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: process.env.ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const email = new EmailEmulator();
    const handles = await createApp({
      databaseUrl,
      prisma: undefined,
      composio: new ComposioEmulator(),
      pipedream,
      email,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      integrationsCatalogUrl: "https://catalog.example.test/",
    });
    const semanticDirect = semanticDirectFixture(
      handles.prisma,
      `http://127.0.0.1:${apiPort}`,
      process.env.ENCRYPTION_KEY!,
    );
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const server = serve({
      fetch: async (request) => {
        if (new URL(request.url).pathname.startsWith("/__e2e/semantic-")) {
          const fixtureResponse = await semanticDirect(request);
          if (fixtureResponse) return fixtureResponse;
        }
        if (new URL(request.url).pathname === "/api/__e2e/widget") {
          const channel = new URL(request.url).searchParams.get("channel") ?? "";
          if (!/^[a-z0-9-]+$/.test(channel)) return new Response(null, { status: 400 });
          return new Response(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Example shop</h1><script src="/support-widget.js" data-channel="${channel}" defer></script></body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (
          new URL(request.url).pathname === "/__e2e/semantic-approval" &&
          request.method === "POST"
        ) {
          const { email: address, variant } = (await request.json()) as {
            email: string;
            variant?: "semantic" | "document";
          };
          if (
            !address.endsWith("@rakazo.test") ||
            (variant && !["semantic", "document"].includes(variant))
          )
            return new Response(null, { status: 400 });
          return Response.json(await semanticApprovalFixture(handles.prisma, address, variant));
        }
        // Fixture routes exist only in this loopback test server, never in createApp.
        if (
          new URL(request.url).pathname === "/__e2e/semantic-history" &&
          request.method === "POST"
        ) {
          const { email: address } = (await request.json()) as { email: string };
          if (!address.endsWith("@rakazo.test")) return new Response(null, { status: 400 });
          return Response.json(await semanticHistoryFixture(handles.prisma, address));
        }
        if (
          new URL(request.url).pathname === "/__e2e/learning-review" &&
          request.method === "POST"
        ) {
          const { email: address } = (await request.json()) as { email: string };
          if (!address.endsWith("@rakazo.test")) return new Response(null, { status: 400 });
          return Response.json(await learningReviewFixture(handles.prisma, address));
        }

        if (
          new URL(request.url).pathname === "/__e2e/social-learning" &&
          request.method === "POST"
        ) {
          const { email: address } = (await request.json()) as { email: string };
          if (!address.endsWith("@rakazo.test")) return new Response(null, { status: 400 });
          await socialLearningFixture(handles.prisma, address);
          return Response.json({ ok: true });
        }
        if (
          new URL(request.url).pathname === "/__e2e/customer-alert" &&
          request.method === "POST"
        ) {
          const {
            email: address,
            channelId,
            status,
          } = (await request.json()) as { email: string; channelId: string; status: string };
          if (!address.endsWith("@rakazo.test") || !["failed", "uncertain"].includes(status))
            return new Response(null, { status: 400 });
          const user = await handles.prisma.user.findUniqueOrThrow({ where: { email: address } });
          const conversation = await handles.prisma.customerConversation.findFirstOrThrow({
            where: { channelId, channel: { userId: user.id } },
          });
          if (!conversation.attentionId) return new Response(null, { status: 409 });
          await handles.prisma.customerAlertDelivery.upsert({
            where: {
              attentionId_stage_provider: {
                attentionId: conversation.attentionId,
                stage: 0,
                provider: "fixture",
              },
            },
            create: {
              conversationId: conversation.id,
              attentionId: conversation.attentionId,
              stage: 0,
              recipientId: user.id,
              provider: "fixture",
              status,
            },
            update: { status, retryable: false, claimToken: null, leaseUntil: null },
          });
          const channel = await handles.prisma.customerChannel.findUniqueOrThrow({
            where: { id: channelId },
          });
          return Response.json({
            ok: true,
            conversationId: conversation.id,
            spaceId: channel.spaceId,
          });
        }
        if (
          new URL(request.url).pathname === "/__e2e/customer-purchase" &&
          request.method === "POST"
        ) {
          const {
            email: address,
            channelId,
            quantity = 1,
          } = (await request.json()) as { email: string; channelId: string; quantity?: number };
          if (!address.endsWith("@rakazo.test") || ![1, 2].includes(quantity))
            return new Response(null, { status: 400 });
          const user = await handles.prisma.user.findUniqueOrThrow({ where: { email: address } });
          const conversation = await handles.prisma.customerConversation.findFirstOrThrow({
            where: { channelId, channel: { userId: user.id } },
            include: { channel: true },
          });
          await handles.prisma.customerConversation.update({
            where: { id: conversation.id },
            data: { owner: "staff" },
          });
          const existing = await handles.prisma.customerPurchase.findFirst({
            where: { conversationId: conversation.id },
          });
          const connection = existing
            ? await handles.prisma.connection.findUniqueOrThrow({
                where: { id: existing.connectionId },
              })
            : await handles.prisma.connection.create({
                data: {
                  userId: user.id,
                  spaceId: conversation.channel.spaceId,
                  provider: "woocommerce",
                  connectorId: "open-connector",
                  displayName: "Example store",
                  status: "connected",
                  providerRef: "SYNTHETIC_STORE",
                },
              });
          const id = existing?.id ?? crypto.randomUUID();
          const quote = {
            summary: {
              items: [
                {
                  key: "shirt",
                  id: 7,
                  name: "Everyday cotton shirt",
                  quantity,
                  variation: [{ attribute: "Size", value: "M" }],
                },
              ],
              currency: "THB",
              minorUnit: 2,
              total: String(quantity * 12500),
              needsShipping: true,
              needsPayment: true,
              coupons: [],
              shippingRates: [
                {
                  packageId: 0,
                  id: "standard",
                  name: "Standard delivery",
                  price: "0",
                  selected: true,
                },
              ],
            },
            billing: {
              firstName: "Example",
              lastName: "Shopper",
              address1: "123 Sample Road",
              city: "Bangkok",
              postcode: "10110",
              country: "TH",
              email: "shopper@example.test",
            },
            shipping: {
              firstName: "Example",
              lastName: "Shopper",
              address1: "123 Sample Road",
              city: "Bangkok",
              postcode: "10110",
              country: "TH",
            },
          };
          const secrets = new EncryptedSecretStore(process.env.ENCRYPTION_KEY!);
          const ciphertext = secrets.seal(
            JSON.stringify({ ...quote, capability: "SYNTHETIC_CART", privateData: {} }),
            `customer-purchase:${id}`,
          );
          const purchase = await handles.prisma.customerPurchase.upsert({
            where: { id },
            create: {
              id,
              conversationId: conversation.id,
              customerId: conversation.customerId,
              connectionId: connection.id,
              providerRef: connection.providerRef!,
              activeKey: id,
              requestHash: "fixture",
              paymentMethods: ["bacs"],
              status: "open",
              ciphertext,
              summary: quote.summary,
            },
            update: { revision: { increment: 1 }, ciphertext, summary: quote.summary },
          });
          const review = await handles.customers.manage(
            { userId: user.id, spaceId: conversation.channel.spaceId },
            conversation.channel.botId,
            "purchase_review",
            {
              id,
              expectedRevision: purchase.revision,
              quote,
              paymentMethod: "bacs",
            },
          );
          return Response.json({ review, purchaseId: id });
        }
        if (new URL(request.url).pathname === "/__e2e/customer" && request.method === "POST") {
          const { email: address } = (await request.json()) as { email: string };
          if (!address.endsWith("@rakazo.test")) return new Response(null, { status: 400 });
          const user = await handles.prisma.user.findUniqueOrThrow({ where: { email: address } });
          const bot = await handles.prisma.bot.findFirstOrThrow({
            where: { userId: user.id, archivedAt: null },
          });
          const channel = await handles.prisma.customerChannel.create({
            data: {
              userId: user.id,
              spaceId: bot.spaceId,
              botId: bot.id,
              provider: "web",
              accountId: crypto.randomUUID(),
              name: "Website support",
              ciphertext: "",
              websiteOrigins: [webOrigin],
            },
          });
          return Response.json({ channelId: channel.id });
        }
        if (new URL(request.url).pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      },
      port: apiPort,
      hostname: "127.0.0.1",
    });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      try {
        await runProcess(
          "pnpm",
          [
            "--filter",
            "@rakazo/web",
            "exec",
            "playwright",
            "test",
            ...(specFilter ? [specFilter] : []),
            ...(testGrep ? ["--grep", testGrep] : []),
          ],
          {
            ...process.env,
            CI: "1",
            // Pin English so e2e selectors match source messages regardless of runner locale.
            VITE_DEFAULT_UI_LOCALE: "en",
          },
        );
      } catch (error) {
        const failedRuns = await handles.prisma.run.findMany({
          where: { status: "failed" },
          select: { id: true, error: true },
        });
        if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
        throw error;
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
        apiPort,
        webPort,
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await handles.stop().catch(() => undefined);
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: computer.kind as "e2b" | "daytona" | "box",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                spaceId: computer.spaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

type AppHandles = Awaited<ReturnType<typeof createApp>>;

async function managedComputers(handles: AppHandles) {
  if (!["e2b", "daytona", "box"].includes(sandboxProvider)) return [];
  return handles.prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, kind: true, providerRef: true, userId: true, spaceId: true },
  });
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
