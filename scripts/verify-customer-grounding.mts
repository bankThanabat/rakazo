#!/usr/bin/env -S pnpm exec tsx
/** Opt-in live subscription check against the owned synthetic provider lab.
 * Usage: pnpm exec tsx scripts/verify-customer-grounding.mts <lab-dir> <new-report> <minor-price>
 * Requires approved voice, one fixed public product workflow, and the running model bridge.
 * Does not configure providers, enable channels, or change store data. Reports are private.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCustomerConnector } from "../packages/adapters/src/customer-connector.js";
import { createCustomerConversations } from "../packages/adapters/src/customer-conversations.js";
import { LangflowCustomerRuntime } from "../packages/adapters/src/customer-runtime.js";
import { IntegrationProviderSettings } from "../packages/adapters/src/integration-provider-settings.js";
import { EncryptedSecretStore } from "../packages/adapters/src/secrets.js";
import { CustomerActionGrantSchema } from "../packages/contracts/src/customer.js";
import { createDb } from "../packages/db/src/index.js";

const [lab, report, expectedPrice] = process.argv.slice(2);
assert.ok(lab && report && expectedPrice && /^\d+$/.test(expectedPrice));
mkdirSync(resolve(report), { mode: 0o700 }); // Refuse to overwrite a prior run.
const save = (name: string, value: unknown) =>
  writeFileSync(resolve(report, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const env = JSON.parse(readFileSync(resolve(lab, "environment.private.json"), "utf8"));
assert.equal(new URL(env.DATABASE_URL).hostname, "127.0.0.1");
assert.equal(new URL(env.DATABASE_URL).port, "15434");
assert.equal(env.API_INTERNAL_URL, "http://host.docker.internal:3210");
assert.equal(env.WEB_ORIGIN, "http://127.0.0.1:5280");
const db = createDb(env.DATABASE_URL);
try {
  assert.equal(await db.prisma.user.count(), 1);
  const owner = await db.prisma.user.findUniqueOrThrow({
    where: { email: "deskazo-v1@example.test" },
  });
  const bot = await db.prisma.bot.findFirstOrThrow({
    where: { userId: owner.id, name: "Chief" },
  });
  const actor = { userId: owner.id, spaceId: bot.spaceId };
  assert.equal(
    await db.prisma.run.count({
      where: { botId: bot.id, status: { in: ["queued", "leased", "running", "waiting_input"] } },
    }),
    0,
  );
  const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: bot.id } });
  const grants = CustomerActionGrantSchema.array().parse(behavior.actions);
  assert.equal(grants.length, 1);
  const grant = grants[0]!;
  assert.equal(grant.audience, "public");
  assert.equal(grant.steps.length, 1);
  assert.equal(grant.steps[0]!.effect, "read");
  assert.equal(grant.steps[0]!.action, "woocommerce.get_store_product");
  assert.deepEqual(grant.steps[0]!.input, { productId: 10 });
  assert.ok(behavior.modelCredentialId);
  const credential = await db.prisma.userModelCredential.findUniqueOrThrow({
    where: { id: behavior.modelCredentialId },
    select: { provider: true },
  });
  assert.equal(credential.provider, "openai-codex");
  const secrets = new EncryptedSecretStore(env.ENCRYPTION_KEY);
  const integrations = new IntegrationProviderSettings(db.prisma, secrets, env.ENCRYPTION_KEY);
  const config = await db.prisma.integrationProviderConfig.findUniqueOrThrow({
    where: { id: "open-connector" },
  });
  assert.equal(
    JSON.parse(secrets.load(config.ciphertext, "integration-provider:open-connector")).endpoint,
    "http://127.0.0.1:13000",
  );
  const connector = createCustomerConnector({ prisma: db.prisma, integrations });
  const source = await connector.execute(
    actor,
    grant.connectionId,
    "woocommerce.get_store_product",
    { productId: 10 },
    randomUUID(),
  );
  const checkProduct = (raw: unknown) => {
    const { product } = raw as {
      product: {
        sku: string;
        prices: { price: string; currency_code: string; currency_minor_unit: number };
        is_in_stock: boolean;
      };
    };
    assert.equal(product.sku, "FIXTURE-ONLY");
    assert.equal(product.prices.price, expectedPrice);
    assert.equal(product.prices.currency_code, "THB");
    assert.equal(product.prices.currency_minor_unit, 2);
    assert.equal(product.is_in_stock, true);
  };
  checkProduct(source);
  assert.equal(await db.prisma.customerChannel.count({ where: { botId: bot.id } }), 0);
  const calls: unknown[] = [];
  const customer = createCustomerConversations({
    prisma: db.prisma,
    secrets,
    integrations,
    apiInternalUrl: env.API_INTERNAL_URL,
    apiUrl: "http://127.0.0.1:3210",
    webOrigin: env.WEB_ORIGIN,
    jobs: {
      async enqueue() {
        throw new Error("Private practice must not enqueue work");
      },
    },
    runtime(config) {
      const runtime = new LangflowCustomerRuntime(config);
      const reply = runtime.reply.bind(runtime);
      runtime.reply = async (input) => {
        const response = await reply(input);
        const ledger = await db.prisma.customerToolCall.findMany({
          where: { message: { conversationId: input.conversationId } },
          select: { name: true, actionId: true, status: true, result: true },
          orderBy: { createdAt: "asc" },
        });
        calls.push({ context: input.customerContext, modelId: input.model.id, response, ledger });
        save("runtime.private.json", calls);
        const reads = ledger.filter((entry) => entry.name === grant.name);
        assert.ok(reads.length > 0, "The model must actually use the product workflow");
        for (const read of reads) {
          assert.equal(read.status, "completed");
          // Workflow calls retain their grant name; the validated grant above fixes the action.
          assert.equal(read.actionId, null);
          checkProduct(read.result);
        }
        return response;
      };
      return runtime;
    },
  });
  const result = await customer.manage(actor, bot.id, "preview", {
    message:
      "สินค้า SKU FIXTURE-ONLY ราคาเท่าไร ใช้สกุลเงินอะไร และตอนนี้มีของไหมคะ โปรดระบุ SKU ในคำตอบด้วยค่ะ",
  });
  const channelsAfter = await db.prisma.customerChannel.count({ where: { botId: bot.id } });
  save("result.private.json", {
    at: new Date().toISOString(),
    provider: credential.provider,
    modelId: behavior.modelId,
    expectedPrice,
    source,
    grants,
    result,
    channelsAfter,
  });
  assert.equal(channelsAfter, 0);
  assert.equal(calls.length, 1);
  const preview = result as { status: string; reply: string };
  assert.equal(preview.status, "reply");
  const amount = (Number(expectedPrice) / 100).toFixed(2);
  assert.ok(preview.reply.includes(amount), "Reply must state the current amount with minor units");
  assert.match(preview.reply, /THB|บาท|฿/);
  assert.ok(preview.reply.includes("FIXTURE-ONLY"));
  assert.match(preview.reply, /มี(?:สินค้า|ของ|สต็อก)|มีจำหน่าย|อยู่ในสต็อก/);
  assert.doesNotMatch(preview.reply, /ไม่มี(?:สินค้า|ของ|สต็อก)|หมดสต็อก|สินค้าหมด/);
  console.log(JSON.stringify({ status: "passed", amount, currency: "THB", reply: preview.reply }));
} finally {
  await db.prisma.$disconnect();
  await db.pool.end();
}
