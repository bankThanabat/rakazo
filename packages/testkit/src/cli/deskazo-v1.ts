/** Disposable live UI laboratory. Product API, PostgreSQL, Pi and Langflow stay real.
 * The local model is explicitly a protocol fixture, not a model-quality claim.
 * Run: pnpm exec tsx packages/testkit/src/cli/deskazo-v1.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import {
  createCustomerConversations,
  EncryptedSecretStore,
  IntegrationProviderSettings,
  selectConfiguredModel,
} from "@rakazo/adapters";
import { findDefaultModelCredential, findModelCredential } from "@rakazo/db";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { startModelEmulator } from "../model-emulator.js";

const reportDir = path.resolve("test-report/deskazo-v1");
await mkdir(reportDir, { recursive: true });
const container = await new PostgreSqlContainer("postgres:16-alpine").start();
const databaseUrl = container.getConnectionUri();
const apiPort = 3210;
const webPort = 5280;
const origin = `http://127.0.0.1:${webPort}`;
const model = await startModelEmulator({
  modelId: "deskazo-protocol-fixture",
  apiKey: "local",
  steps: Array.from({ length: 100 }, () => ({
    expect: () => {},
    response: {
      type: "text" as const,
      text: "This is a local protocol-fixture reply. The request reached the model through the running app. For customer help, a staff member can review the conversation and provide guidance.",
    },
  })),
});
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  REALTIME_DATABASE_URL: databaseUrl,
  WAKEUP_DRIVER: "memory",
  SANDBOX_PROVIDER: "fake",
  AGENT_RUNTIME: "pi",
  CLOUD_AGENT_PROVIDER: "emulator",
  BETTER_AUTH_SECRET: crypto.randomUUID(),
  ENCRYPTION_KEY: crypto.randomUUID(),
  SCREEN_PROXY_SECRET: crypto.randomUUID(),
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
  API_URL: `http://127.0.0.1:${apiPort}`,
  API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
  API_INTERNAL_URL: `http://host.docker.internal:${apiPort}`,
  API_PORT: String(apiPort),
  WEB_PORT: String(webPort),
  DATA_DIR: path.join(reportDir, "data"),
  SIGNUPS_ENABLED: "true",
  SIGNUP_ALLOWLIST: "",
  VITE_DEFAULT_UI_LOCALE: "en",
});
execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], { stdio: "inherit" });
execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
  stdio: "inherit",
});
const { createApp } = await import("../../../../apps/api/src/app.ts");
const handles = await createApp();
const secrets = new EncryptedSecretStore(process.env.ENCRYPTION_KEY!);
const customers = createCustomerConversations({
  prisma: handles.prisma,
  secrets,
  jobs: handles.jobs,
  integrations: new IntegrationProviderSettings(handles.prisma, secrets, "test"),
  apiUrl: `http://127.0.0.1:${apiPort}`,
  apiInternalUrl: `http://host.docker.internal:${apiPort}`,
  webOrigin: origin,
});
let channelId: string | undefined;
const server = serve({
  hostname: "0.0.0.0",
  port: apiPort,
  fetch: async (request, env) => {
    const url = new URL(request.url);
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      env.incoming.socket.remoteAddress ?? "",
    );
    // Docker needs only authenticated execution callbacks. Keep the test account,
    // fixture setup and the rest of this disposable application loopback-only.
    if (
      !local &&
      !["/api/model-bridge/", "/api/customer-tools"].some((p) => url.pathname.startsWith(p))
    )
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/api/__deskazo/setup" && request.method === "POST") {
      try {
        // Only this synthetic account in this disposable database is eligible.
        const user = await handles.prisma.user.findUniqueOrThrow({
          where: { email: "deskazo-v1@example.test" },
        });
        const bot = await handles.prisma.bot.findFirstOrThrow({
          where: { userId: user.id, archivedAt: null },
        });
        const actor = { userId: user.id, spaceId: bot.spaceId };
        const [overrideCredential, defaultCredential] = await Promise.all([
          bot.modelProvider && bot.modelId
            ? findModelCredential(handles.prisma, actor, bot.modelProvider, bot.modelId)
            : Promise.resolve(null),
          findDefaultModelCredential(handles.prisma, actor),
        ]);
        const selected = selectConfiguredModel({
          bot,
          overrideCredential,
          defaultCredential,
          settings: null,
          deployment: null,
        });
        if (!selected.credential || !selected.id) throw new Error("Connect a model first");
        const login = await fetch("http://127.0.0.1:17860/api/v1/auto_login");
        const session = (await login.json()) as { access_token?: string };
        if (!session.access_token) throw new Error("Isolated Langflow needs an auto-login session");
        const keyResponse = await fetch("http://127.0.0.1:17860/api/v1/api_key/", {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.access_token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Deskazo disposable verification" }),
        });
        const key = (await keyResponse.json()) as { api_key?: string };
        if (!key.api_key) throw new Error("Could not create an isolated Langflow key");
        const id = crypto.randomUUID();
        await handles.prisma.botSecret.upsert({
          where: {
            userId_spaceId_botId_name: {
              userId: user.id,
              spaceId: bot.spaceId,
              botId: bot.id,
              name: "verification_runtime",
            },
          },
          create: {
            id,
            userId: user.id,
            spaceId: bot.spaceId,
            botId: bot.id,
            name: "verification_runtime",
            origin: "http://127.0.0.1:17860",
            auth: { type: "header", name: "x-api-key" },
            ciphertext: secrets.seal(key.api_key, id),
          },
          update: {},
        });
        await customers.manage(actor, bot.id, "configure", {
          runtime: { credential: "verification_runtime", baseUrl: "http://127.0.0.1:17860/api/v1" },
          modelCredentialId: selected.credential.id,
          modelId: selected.id,
          instructions:
            "You assist the synthetic Deskazo test shop. Ask for a human when needed. Never invent stock or payment status.",
        });
        const channel = (await customers.manage(actor, bot.id, "website", {
          name: "Deskazo test shop",
          origins: [origin],
        })) as { channelId: string };
        channelId = channel.channelId;
        return Response.json({ channelId });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Setup failed" },
          { status: 400 },
        );
      }
    }
    if (url.pathname === "/api/__deskazo/shop")
      return new Response(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Deskazo test shop</title></head><body><h1>Deskazo test shop</h1><p>Synthetic customer conversation for verification.</p>${channelId ? `<script src="${origin}/support-widget.js" data-channel="${channelId}" defer></script>` : "<p>Finish the test channel setup first.</p>"}</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    return handles.app.fetch(request);
  },
});
const web = spawn("pnpm", ["--filter", "@rakazo/web", "dev", "--host", "127.0.0.1"], {
  env: process.env,
  stdio: "inherit",
});
await writeFile(
  path.join(reportDir, "environment.json"),
  JSON.stringify(
    {
      web: origin,
      modelBaseUrl: model.baseUrl,
      modelId: "deskazo-protocol-fixture",
      apiKey: "local",
      model: "protocol fixture",
      runtime: "real Langflow",
      database: "disposable PostgreSQL",
      sandbox: "fixture",
      liveMerchant: false,
    },
    null,
    2,
  ),
);
console.log(
  `DESKAZO_READY ${origin} — model connection details in test-report/deskazo-v1/environment.json`,
);
async function stop() {
  web.kill();
  server.close();
  await handles.stop();
  await model.close();
  await container.stop();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
