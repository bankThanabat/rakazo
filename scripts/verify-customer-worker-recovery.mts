#!/usr/bin/env -S pnpm exec tsx
/** Opt-in fault check for the owned synthetic website lab after verify-customer-website.mts.
 * Usage: pnpm exec tsx scripts/verify-customer-worker-recovery.mts <lab-dir> <website-report-dir> <new-report-dir> --interrupt-worker
 * Kills only the verified detached lab worker while a customer event is processing,
 * restarts it, waits for the real lease expiry, then exercises staff acknowledgement
 * and explicit resume. Requires an enabled loopback test channel. Leaves its transcript.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CustomerActionGrantSchema } from "../packages/contracts/src/customer.js";
import { createDb } from "../packages/db/src/index.js";

const [labArg, reportArg, outArg, permission, ...extra] = process.argv.slice(2);
assert.ok(
  labArg && reportArg && outArg && permission === "--interrupt-worker" && extra.length === 0,
  "Specify lab, website report, new report and --interrupt-worker",
);
const lab = resolve(labArg),
  base = resolve(reportArg),
  out = resolve(outArg),
  root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(out, { mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const env = JSON.parse(readFileSync(resolve(lab, "environment.private.json"), "utf8"));
assert.equal(env.WEB_ORIGIN, "http://127.0.0.1:5280");
assert.equal(new URL(env.DATABASE_URL).hostname, "127.0.0.1");
assert.equal(new URL(env.DATABASE_URL).port, "15434");
const session = JSON.parse(readFileSync(resolve(base, "session.private.json"), "utf8"));
const processes = JSON.parse(readFileSync(resolve(lab, "processes.json"), "utf8"));
const db = createDb(env.DATABASE_URL);
let killed = false,
  restarted = false;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as { code: string }).code === "ESRCH") return false;
    throw e;
  }
};
const restart = () => {
  execFileSync(process.execPath, [resolve(lab, "start.mjs")], { stdio: "inherit" });
  const current = JSON.parse(readFileSync(resolve(lab, "processes.json"), "utf8"));
  assert.notEqual(current.worker, processes.worker);
  assert.ok(alive(current.worker));
  for (const name of ["api", "web", "supervisor"]) assert.equal(current[name], processes[name]);
  restarted = true;
  return current;
};
try {
  const owner = await db.prisma.user.findUniqueOrThrow({
    where: { email: "deskazo-v1@example.test" },
  });
  assert.equal(await db.prisma.user.count(), 1);
  const bot = await db.prisma.bot.findFirstOrThrow({ where: { userId: owner.id, name: "Chief" } });
  const behavior = await db.prisma.customerBehavior.findUniqueOrThrow({ where: { botId: bot.id } });
  const grants = CustomerActionGrantSchema.array().parse(behavior.actions);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.audience, "public");
  assert.equal(grants[0]!.steps.length, 1);
  assert.equal(grants[0]!.steps[0]!.effect, "read");
  assert.equal(grants[0]!.steps[0]!.action, "woocommerce.get_store_product");
  assert.deepEqual(grants[0]!.steps[0]!.input, { productId: 10 });
  assert.ok(behavior.modelCredentialId);
  assert.equal(
    (
      await db.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: behavior.modelCredentialId },
        select: { provider: true },
      })
    ).provider,
    "openai-codex",
  );
  const channel = await db.prisma.customerChannel.findUniqueOrThrow({
    where: { id: session.channelId },
  });
  assert.equal(channel.botId, bot.id);
  assert.equal(channel.provider, "web");
  assert.deepEqual(channel.websiteOrigins, [env.WEB_ORIGIN]);
  assert.ok(channel.enabled && channel.autoReplies);
  assert.equal(
    await db.prisma.run.count({
      where: { status: { in: ["queued", "leased", "running", "waiting_input"] } },
    }),
    0,
  );
  assert.equal(
    await db.prisma.customerConversation.count({ where: { leaseUntil: { not: null } } }),
    0,
  );
  assert.equal(await db.prisma.customerAlertDestination.count(), 0);
  const before = await db.prisma.customerConversation.findUniqueOrThrow({
    where: { id: session.conversationId },
  });
  assert.equal(before.channelId, channel.id);
  assert.equal(before.owner, "bot");
  assert.equal(before.needsHuman, false);
  const body = {
    body: "ขอเช็กข้อมูลล่าสุดของ SKU FIXTURE-ONLY อีกครั้งค่ะ โปรดระบุราคาเป็นทศนิยมสองตำแหน่ง สกุลเงิน และสถานะสต็อกค่ะ",
    nonce: randomUUID(),
  };
  save("request.private.json", body);
  const visitor = async (path: string, input?: unknown) => {
    const res = await fetch(`${env.WEB_ORIGIN}/api/customer-web/${channel.id}/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        origin: env.WEB_ORIGIN,
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.ok(res.ok);
    return res.json();
  };
  const sentBots = () =>
    db.prisma.customerMessage.count({
      where: { conversationId: before.id, role: "bot", status: "sent" },
    });
  const botsBefore = await sentBots();
  assert.ok(botsBefore >= 2);
  const worker = processes.worker;
  assert.ok(Number.isInteger(worker) && worker > 1);
  const command = execFileSync("ps", ["-p", String(worker), "-o", "command="], {
    encoding: "utf8",
  });
  assert.ok(command.includes(resolve(root, "apps/worker/src/index.ts")));
  assert.equal(
    Number(execFileSync("ps", ["-p", String(worker), "-o", "pgid="], { encoding: "utf8" }).trim()),
    worker,
  );
  await visitor("messages", body);
  const deadline = Date.now() + 30000;
  let processing: Awaited<ReturnType<typeof db.prisma.customerMessage.findFirst>> = null;
  while (Date.now() < deadline) {
    processing = await db.prisma.customerMessage.findFirst({
      where: { conversationId: before.id, externalId: `in:${body.nonce}`, status: "processing" },
    });
    if (processing) break;
    assert.equal(
      await sentBots(),
      botsBefore,
      "Reply finished before interruption; do not kill an idle worker",
    );
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(processing?.executionUntil);
  const leased = await db.prisma.customerConversation.findUniqueOrThrow({
    where: { id: before.id },
  });
  assert.ok(leased.leaseUntil && leased.leaseToken);
  save("before-kill.private.json", {
    at: new Date().toISOString(),
    before,
    processing,
    leased,
    botsBefore,
    processes,
  });
  process.kill(-worker, "SIGKILL");
  killed = true;
  const stoppedUntil = Date.now() + 10000;
  while (alive(worker) && Date.now() < stoppedUntil) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(worker));
  const current = restart();
  save("restart.private.json", {
    at: new Date().toISOString(),
    onlyOwnedWorkerKilled: true,
    apiWebSupervisorPidsUnchanged: true,
    workerChanged: true,
    current,
  });
  console.log(
    "Interrupted the owned worker during processing; restarted only that worker. Waiting for the real lease expiry.",
  );
  const recoveryUntil = Date.now() + 240000;
  let recovered = before;
  while (Date.now() < recoveryUntil) {
    recovered = await db.prisma.customerConversation.findUniqueOrThrow({
      where: { id: before.id },
    });
    if (recovered.owner === "staff" && recovered.needsHuman && recovered.leaseUntil === null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const messages = await db.prisma.customerMessage.findMany({
    where: { conversationId: before.id },
    orderBy: { seq: "asc" },
  });
  save("recovered.private.json", {
    at: new Date().toISOString(),
    row: recovered,
    messages,
    visitor: await visitor("messages"),
  });
  assert.equal(recovered?.owner, "staff");
  assert.equal(recovered.needsHuman, true);
  assert.equal(recovered.leaseUntil, null);
  assert.ok(recovered.handoffReason?.includes("failed"));
  const failed = messages.find((m) => m.id === processing.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed.errorCode, "execution_uncertain");
  assert.equal(await sentBots(), botsBefore);
  await visitor("messages", body);
  assert.equal(
    await db.prisma.customerMessage.count({
      where: { conversationId: before.id, externalId: `in:${body.nonce}` },
    }),
    1,
  );
  const creds = JSON.parse(readFileSync(resolve(lab, "private.json"), "utf8"));
  const login = await fetch(`${env.WEB_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: env.WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: creds.appPassword }),
  });
  assert.ok(login.ok);
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  const rpc = async (name: string, input: unknown) => {
    const r = await fetch(`${env.WEB_ORIGIN}/rpc/customers/${name}`, {
      method: "POST",
      headers: { origin: env.WEB_ORIGIN, "content-type": "application/json", cookie },
      body: JSON.stringify({ json: input }),
    });
    assert.ok(r.ok);
    return (await r.json()).json;
  };
  save("staff-attention.private.json", await rpc("snapshot", { id: before.id }));
  console.log(
    "Expired processing lease produced an actionable staff handoff; no extra customer reply was sent.",
  );
  await rpc("updateCase", { id: before.id, acknowledge: true });
  await rpc("setOwner", { id: before.id, owner: "bot" });
  const resumed = { ...body, nonce: randomUUID() };
  save("resume-request.private.json", resumed);
  await visitor("messages", resumed);
  await visitor("messages", resumed);
  const replyUntil = Date.now() + 180000;
  while ((await sentBots()) < botsBefore + 1 && Date.now() < replyUntil)
    await new Promise((r) => setTimeout(r, 1000));
  const final = await rpc("snapshot", { id: before.id });
  save("final.private.json", {
    at: new Date().toISOString(),
    staff: final,
    visitor: await visitor("messages"),
    ledger: await db.prisma.customerToolCall.findMany({
      where: { message: { conversationId: before.id } },
      select: { name: true, status: true, result: true },
    }),
  });
  assert.equal(await sentBots(), botsBefore + 1);
  assert.equal(final.conversation.owner, "bot");
  assert.equal(final.conversation.needsHuman, false);
  const last = final.messages
    .filter((m: { role: string; status: string }) => m.role === "bot" && m.status === "sent")
    .at(-1);
  assert.match(last.body, /FIXTURE-ONLY/);
  assert.match(last.body, /125\.00/);
  assert.match(last.body, /THB|บาท|฿/);
  assert.equal(await db.prisma.customerPurchase.count({ where: { conversationId: before.id } }), 0);
  save("result.json", {
    status: "passed",
    interruption: "SIGKILL of verified owned local worker while customer event was processing",
    realLeaseExpired: true,
    uncertainEventHandedToStaff: true,
    noAutomaticReplyAfterInterruption: true,
    duplicateReceiveStayedSingle: true,
    explicitResumeDeliveredOneReply: true,
    noPurchaseActions: true,
    apiWebSupervisorPreserved: true,
    scope:
      "Actual owned worker and local website/store/subscription; no provider write interrupted and no LINE/Instagram delivery.",
  });
  console.log("Worker interruption, staff recovery and explicit resumed reply passed.");
} catch (error) {
  save("failure.private.json", {
    at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  if (killed && !restarted) restart();
  await db.prisma.$disconnect();
  await db.pool.end();
}
