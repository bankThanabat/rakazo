import { readFileSync } from "node:fs";
import { saveIncomingSettings } from "../packages/adapters/src/customer-incoming-settings.js";
import { saveCustomerReplyRuntime } from "../packages/adapters/src/customer-reply-defaults.js";
import { EncryptedSecretStore } from "../packages/adapters/src/secrets.js";
import { resolveEncryptionKey } from "../packages/core/src/secrets-guard.js";
import { createDb } from "../packages/db/src/client.js";

// Operator-only setup. Credentials arrive as JSON on stdin and are sealed with the
// server's encryption key; nothing is printed. Model credentials stay with each owner.
//   configure-operator-settings.mts customer-replies < runtime.json
//   configure-operator-settings.mts incoming-webhook <provider> < webhook.json
const [kind, provider] = process.argv.slice(2);
const input: unknown = JSON.parse(readFileSync(0, "utf8"));
const { prisma, pool } = createDb(process.env.DATABASE_URL!);
const deps = { prisma, secrets: new EncryptedSecretStore(resolveEncryptionKey()) };
try {
  if (kind === "customer-replies") await saveCustomerReplyRuntime(deps, input);
  else if (kind === "incoming-webhook" && provider)
    await saveIncomingSettings(deps, provider, input);
  else throw new Error("Usage: customer-replies | incoming-webhook <provider>");
  console.log("Settings saved");
} finally {
  await prisma.$disconnect();
  await pool.end();
}
