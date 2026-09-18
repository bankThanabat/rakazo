import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadRootEnv } from "../packages/core/src/node/load-root-env.js";
import { createDb } from "../packages/db/src/client.js";

// Exercise durable delivery in a disposable local database, never the developer's data.
loadRootEnv();
const url = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw new Error("This check requires a local PostgreSQL server");
const name = `rakazo_instagram_check_${randomBytes(6).toString("hex")}`;
const { prisma, pool } = createDb(url.href);
let created = false;
try {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: url.href, VERIFY_DATABASE: "1" };
  const migration = spawnSync("pnpm", ["--filter", "@rakazo/db", "migrate"], {
    env,
    encoding: "utf8",
  });
  if (migration.status !== 0) throw new Error("Disposable database migrations failed");
  const test = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/adapters/src/integration-gateway.postgres.test.ts",
      "packages/adapters/src/integration-gateway-webhook.test.ts",
      "packages/adapters/src/customer-incoming.test.ts",
      "packages/adapters/src/customer-relay.test.ts",
      "packages/adapters/src/customer-conversations.postgres.test.ts",
      "apps/api/src/integration-gateway-http.test.ts",
    ],
    { env, stdio: "inherit" },
  );
  process.exitCode = test.status ?? 1;
} finally {
  if (created) await prisma.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await prisma.$disconnect();
  await pool.end();
}
