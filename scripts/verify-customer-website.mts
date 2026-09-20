#!/usr/bin/env -S pnpm exec tsx
/** Live, opt-in website delivery check against the owned synthetic shop.
 * Usage: pnpm exec tsx scripts/verify-customer-website.mts <lab-dir> <new-report-dir>
 * Requires Chief's approved loopback website channel and fixed public product read.
 * Uses normal visitor/staff HTTP routes and the running worker, not a fake runtime.
 * Leaves the transcript for inspection. Disconnect the test channel after review.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CustomerActionGrantSchema } from "../packages/contracts/src/customer.js";
import { createDb } from "../packages/db/src/index.js";

const [lab, directory] = process.argv.slice(2);
assert.ok(lab && directory);
mkdirSync(resolve(directory), { mode: 0o700 });
const save = (name: string, data: unknown) =>
  writeFileSync(resolve(directory, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const env = JSON.parse(readFileSync(resolve(lab, "environment.private.json"), "utf8"));
const credentials = JSON.parse(readFileSync(resolve(lab, "private.json"), "utf8"));
assert.equal(new URL(env.DATABASE_URL).hostname, "127.0.0.1");
assert.equal(new URL(env.DATABASE_URL).port, "15434");
assert.equal(env.WEB_ORIGIN, "http://127.0.0.1:5280");
const db = createDb(env.DATABASE_URL);
let conversationId: string | undefined;
try {
  assert.equal(await db.prisma.user.count(), 1);
  const owner = await db.prisma.user.findUniqueOrThrow({
    where: { email: "deskazo-v1@example.test" },
  });
  const bot = await db.prisma.bot.findFirstOrThrow({
    where: { userId: owner.id, name: "Chief" },
  });
  assert.equal(await db.prisma.customerAlertDestination.count(), 0);
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
  assert.equal(grant.steps[0]!.action, "woocommerce.get_store_product");
  assert.equal(grant.steps[0]!.effect, "read");
  assert.deepEqual(grant.steps[0]!.input, { productId: 10 });
  assert.ok(behavior.modelCredentialId);
  const model = await db.prisma.userModelCredential.findUniqueOrThrow({
    where: { id: behavior.modelCredentialId },
    select: { provider: true },
  });
  assert.equal(model.provider, "openai-codex");
  const channel = await db.prisma.customerChannel.findFirstOrThrow({
    where: { botId: bot.id, provider: "web", name: "Local acceptance only" },
  });
  assert.deepEqual(channel.websiteOrigins, [env.WEB_ORIGIN]);
  assert.ok(channel.enabled && channel.autoReplies);
  assert.equal(channel.connectionId, null);
  const learningBefore = await db.prisma.learningDocument.findMany({
    where: { spaceId: bot.spaceId },
    orderBy: { id: "asc" },
  });
  const login = await fetch(`${env.WEB_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: env.WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: credentials.appPassword }),
  });
  assert.ok(login.ok);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const rpc = async (name: string, input: unknown) => {
    const response = await fetch(`${env.WEB_ORIGIN}/rpc/customers/${name}`, {
      method: "POST",
      headers: { cookie, origin: env.WEB_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    });
    assert.ok(response.ok, `Staff ${name}: HTTP ${response.status}`);
    return (await response.json()).json;
  };
  let token: string | undefined;
  const visitor = async (path: string, input?: unknown) => {
    const response = await fetch(`${env.WEB_ORIGIN}/api/customer-web/${channel.id}/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        origin: env.WEB_ORIGIN,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.ok(response.ok, `Visitor ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const session = await visitor("session", { name: "Synthetic website acceptance" });
  token = session.token;
  conversationId = session.conversationId;
  assert.ok(conversationId && token);
  save("session.private.json", { ...session, channelId: channel.id });
  const snapshot = async (stage: string) => {
    const state = {
      visitor: await visitor("messages"),
      staff: await rpc("snapshot", { id: conversationId }),
      row: await db.prisma.customerConversation.findUniqueOrThrow({
        where: { id: conversationId },
      }),
      messages: await db.prisma.customerMessage.findMany({
        where: { conversationId },
        orderBy: { seq: "asc" },
      }),
      ledger: await db.prisma.customerToolCall.findMany({
        where: { message: { conversationId } },
        orderBy: { createdAt: "asc" },
        select: { name: true, status: true, result: true, actionId: true },
      }),
    };
    save(`${stage}.private.json`, state);
    return state;
  };
  const waitFor = async (stage: string, ready: () => Promise<boolean>) => {
    const deadline = Date.now() + 180_000;
    while (!(await ready())) {
      if (Date.now() >= deadline) {
        await snapshot(`${stage}-pending`);
        throw new Error(
          `${stage} observation expired; inspect the existing conversation before retrying`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  const send = async (stage: string, body: string) => {
    const input = { body, nonce: randomUUID() };
    save(`${stage}-request.private.json`, input);
    await visitor("messages", input);
    await visitor("messages", input); // A retried delivery must be the same customer event.
  };
  const sentBots = () =>
    db.prisma.customerMessage.count({
      where: { conversationId, role: "bot", status: "sent" },
    });
  const question =
    "สินค้า SKU FIXTURE-ONLY ราคาเท่าไร ใช้สกุลเงินอะไร และมีของไหมคะ โปรดระบุ SKU และราคาทศนิยมสองตำแหน่งด้วยค่ะ";
  await send("product", question);
  await waitFor("product", async () => (await sentBots()) >= 1);
  const first = await snapshot("product");
  assert.equal(first.messages.filter((message) => message.role === "customer").length, 1);
  assert.equal(
    first.messages.filter((message) => message.role === "bot" && message.status === "sent").length,
    1,
  );
  assert.equal(first.row.owner, "bot");
  console.log("Website customer received the first subscription reply.");

  await visitor("handoff", {});
  const attention = await snapshot("attention");
  assert.equal(attention.row.owner, "staff");
  assert.equal(attention.row.needsHuman, true);
  assert.ok(attention.row.handoffReason && attention.row.attentionId);
  assert.equal(attention.staff.conversation.canReply, true);
  await send("held", "ระหว่างรอเจ้าหน้าที่ ขอให้ยืนยันราคาสินค้าเดิมด้วยค่ะ");
  await rpc("updateCase", { id: conversationId, acknowledge: true });
  const staffInput = {
    id: conversationId,
    nonce: randomUUID(),
    body: "เจ้าหน้าที่รับเรื่องแล้วค่ะ กำลังตรวจสอบให้ค่ะ",
  };
  save("staff-request.private.json", staffInput);
  await rpc("reply", staffInput);
  await rpc("reply", staffInput);
  await waitFor(
    "staff",
    async () =>
      (await db.prisma.customerMessage.count({
        where: { conversationId, role: "staff", status: "sent" },
      })) === 1,
  );
  const held = await snapshot("staff");
  assert.equal(await sentBots(), 1);
  assert.equal(held.row.owner, "staff");
  assert.ok(held.row.acknowledgedAt);
  assert.equal(
    held.visitor.messages.filter((message: { body: string }) => message.body === staffInput.body)
      .length,
    1,
  );
  console.log(
    "Handoff reached the staff inbox; one staff reply delivered and automatic replies stayed stopped.",
  );

  await rpc("setOwner", { id: conversationId, owner: "bot" });
  await send("resumed", question);
  await waitFor("resumed", async () => (await sentBots()) >= 2);
  const final = await snapshot("resumed");
  const replies = final.messages.filter(
    (message) => message.role === "bot" && message.status === "sent",
  );
  assert.equal(replies.length, 2);
  assert.equal(final.row.owner, "bot");
  assert.equal(final.row.needsHuman, false);
  assert.equal(final.messages.filter((message) => message.role === "customer").length, 3);
  for (const reply of replies) {
    assert.match(reply.body, /FIXTURE-ONLY/);
    assert.match(reply.body, /125\.00/);
    assert.match(reply.body, /THB|บาท|฿/);
  }
  const reads = final.ledger.filter((call) => call.name === grant.name);
  assert.ok(reads.length >= 2);
  for (const call of reads) {
    assert.equal(call.status, "completed");
    const result = call.result as {
      product: {
        sku: string;
        prices: { price: string; currency_code: string };
        is_in_stock: boolean;
      };
    };
    assert.equal(result.product.sku, "FIXTURE-ONLY");
    assert.equal(result.product.prices.price, "12500");
    assert.equal(result.product.prices.currency_code, "THB");
    assert.equal(result.product.is_in_stock, true);
  }
  assert.deepEqual(
    await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: bot.id } }),
    behavior,
  );
  assert.deepEqual(
    await db.prisma.learningDocument.findMany({
      where: { spaceId: bot.spaceId },
      orderBy: { id: "asc" },
    }),
    learningBefore,
  );
  save("result.json", {
    status: "passed",
    provider: model.provider,
    modelId: behavior.modelId,
    botReplies: replies.length,
    staffReplies: 1,
    customerEvents: 3,
    completedProductReads: reads.length,
    duplicateRequestsDeduplicated: true,
    staffOwnershipStoppedReplies: true,
    explicitResumeVerified: true,
    behaviorAndKnowledgeUnchanged: true,
    channelCleanupRequired: true,
    scope:
      "Live local website API, running worker, Langflow and ChatGPT subscription with owned synthetic WooCommerce. No external social delivery or rendered browser acceptance.",
  });
  console.log("Website delivery, handoff, staff retry deduplication and explicit resume passed.");
} catch (error) {
  save("failure.private.json", {
    error: error instanceof Error ? error.message : String(error),
    conversationId,
  });
  throw error;
} finally {
  await db.prisma.$disconnect();
  await db.pool.end();
}
