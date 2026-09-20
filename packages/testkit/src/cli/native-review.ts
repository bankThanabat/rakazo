/** Disposable native-app review server. No real model or external provider is contacted. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sessionCookieHeader } from "../index.js";
import { customerNativeReview } from "./customer-native-review.js";
import { semanticApprovalFixture } from "./semantic-approval.js";

const port = Number(process.env.API_PORT ?? 3213);
const origin = `http://127.0.0.1:${port}`;
const email = "native-review@example.test";
const password = "synthetic-review-password";
const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-native-review-"));
const container = await new PostgreSqlContainer("postgres:16-alpine").start();
const databaseUrl = container.getConnectionUri();
let cleanup: (() => Promise<void>) | undefined;
try {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    REALTIME_DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: "native-review-auth-secret-32characters",
    ENCRYPTION_KEY: "native-review-encryption-32characters",
    SCREEN_PROXY_SECRET: "native-review-screen-secret-32characters",
    BETTER_AUTH_URL: origin,
    WEB_ORIGIN: origin,
    API_URL: origin,
    API_PORT: String(port),
    DATA_DIR: dataDir,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    WAKEUP_DRIVER: "memory",
    SANDBOX_PROVIDER: "fake",
    AGENT_RUNTIME: "scripted",
    CLOUD_AGENT_PROVIDER: "emulator",
    COMPOSIO_API_KEY: "",
  });
  delete process.env.CURSOR_API_KEY;
  execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], { stdio: "inherit" });
  execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
  });
  const { createApp } = await import("../../../../apps/api/src/app.ts");
  const handles = await createApp();
  cleanup = handles.stop;
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password, name: "Native review" }),
  });
  if (!signup.ok) throw new Error(`Synthetic signup failed: ${signup.status}`);
  const cookie = sessionCookieHeader(signup);
  const created = await handles.app.request("/rpc/bots/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({
      json: {
        name: "Document reviewer",
        title: "",
        description: "",
        instructions: "Synthetic document approval review.",
        notifyOnFinish: false,
      },
    }),
  });
  if (!created.ok) throw new Error(`Synthetic bot creation failed: ${created.status}`);
  const fixture = await semanticApprovalFixture(handles.prisma, email, "document");
  const customer = process.argv.includes("--customer")
    ? await customerNativeReview(handles.prisma, fixture.botId)
    : undefined;
  const server = serve({ hostname: "127.0.0.1", port, fetch: handles.app.fetch });
  await writeFile(
    "test-report/deskazo-v1/checks/native-review-fixture.json",
    JSON.stringify(
      {
        origin,
        email,
        password,
        botId: fixture.botId,
        toolName: fixture.toolName,
        customerId: customer?.id,
      },
      null,
      2,
    ),
  );
  console.log(`Native review ready at ${origin}; fixture details saved locally.`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await customer?.verify();
} finally {
  try {
    await cleanup?.();
  } finally {
    await container.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}
