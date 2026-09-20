import { readFileSync } from "node:fs";
import { saveIncomingSettings } from "../packages/adapters/src/customer-incoming-settings.js";
import { createCustomerPublications } from "../packages/adapters/src/customer-publications.js";
import { saveCustomerReplyRuntime } from "../packages/adapters/src/customer-reply-defaults.js";
import { EncryptedSecretStore } from "../packages/adapters/src/secrets.js";
import { resolveEncryptionKey } from "../packages/core/src/secrets-guard.js";
import { createDb } from "../packages/db/src/client.js";

// Operator-only setup. Credentials arrive as JSON on stdin and are sealed with the
// server's encryption key; only status/counts are printed. Model credentials stay with each owner.
//   configure-operator-settings.mts customer-replies < runtime.json
//   configure-operator-settings.mts customer-runtime-cleanup < runtime.json
//   configure-operator-settings.mts incoming-webhook <provider> < webhook.json
const [kind, provider] = process.argv.slice(2);
let input: unknown;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  throw new Error("Expected operator settings JSON on stdin");
}
const { prisma, pool } = createDb(process.env.DATABASE_URL!);
const deps = { prisma, secrets: new EncryptedSecretStore(resolveEncryptionKey()) };
try {
  if (kind === "customer-runtime-cleanup") {
    const counts = await createCustomerPublications(deps).recoverCredentials(input);
    process.stdout.write(`${JSON.stringify(counts)}\n`);
  } else if (kind === "customer-replies") await saveCustomerReplyRuntime(deps, input);
  else if (kind === "incoming-webhook" && provider)
    await saveIncomingSettings(deps, provider, input);
  else
    throw new Error(
      "Usage: customer-replies | customer-runtime-cleanup | incoming-webhook <provider>",
    );
  if (kind !== "customer-runtime-cleanup") process.stdout.write("Settings saved\n");
} finally {
  await prisma.$disconnect();
  await pool.end();
}
