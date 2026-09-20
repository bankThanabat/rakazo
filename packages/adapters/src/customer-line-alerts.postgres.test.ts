import { randomUUID } from "node:crypto";
import type { AdapterContext, JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import {
  createCustomerInbox,
  createCustomerRepos,
  createDb,
  provisionMessagingIdentity,
  requestAccountDeletion,
  startCustomerAttention,
  writeAccountExport,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCustomerAttentionAlert } from "./customer-alerts.js";
import { createCustomerConnector } from "./customer-connector.js";
import { createCustomerConversations } from "./customer-conversations.js";
import { createCustomerLineAlerts } from "./customer-line-alerts.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { createOpenConnectorFixture, sampleAction } from "./open-connector-test-fixture.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const target = { kind: "private_group" as const, recipientId: `C${"1".repeat(32)}` };
const botAccountId = `U${"b".repeat(32)}`;
describe.skipIf(!enabled)("verified LINE staff alerts", () => {
  let db: ReturnType<typeof createDb>;
  let owners: Array<Awaited<ReturnType<typeof provisionMessagingIdentity>>>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let f: ReturnType<typeof createOpenConnectorFixture>;
  let integrations: IntegrationProviderSettings;
  let connector: ReturnType<typeof createCustomerConnector>;
  let line: ReturnType<typeof createCustomerLineAlerts>;
  let connectionId: string;
  let conversationId: string;
  let botIdentity: string;
  let rejectRead: boolean;
  let loseSend: boolean;
  let holdSend: Promise<void> | undefined;
  let sendStarted: (() => void) | undefined;
  let notify: ReturnType<typeof vi.fn<NotificationProvider["send"]>>;
  let app: NotificationProvider;
  const pushes: Array<{ to: string; texts: string[]; retryKey: string }> = [];
  const input = (expectedId: string | null = null) => ({
    connectionId,
    recipient: target,
    nonce: randomUUID(),
    expectedId,
  });
  const code = () => pushes.at(-1)!.texts[0]!.match(/Verification code: ([0-9a-f]{12})/)![1]!;
  const verifyInput = (id: string, value = code()) => ({
    id,
    connectionId,
    recipient: target,
    code: value,
    staffOnly: true,
  });
  async function verify() {
    const result = await line.test(owner, owner.botId, input());
    expect(result?.status).toBe("awaiting_confirmation");
    return (await line.verify(owner, owner.botId, verifyInput(result!.id)))!;
  }
  async function dispatch(now = new Date()) {
    return sendCustomerAttentionAlert(db.prisma, app, conversationId, now, line.providers);
  }
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    owners = [];
    owner = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    owners.push(owner);
    pushes.length = 0;
    botIdentity = botAccountId;
    rejectRead = false;
    loseSend = false;
    holdSend = undefined;
    sendStarted = undefined;
    f = createOpenConnectorFixture(async (action, input) => {
      if (action === "line.get_bot_info") {
        if (rejectRead) throw new Error("Synthetic read failure");
        return { userId: botIdentity };
      }
      expect(action).toBe("line.send_push_text");
      const push = input as (typeof pushes)[number];
      expect(push.retryKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      pushes.push(push);
      sendStarted?.();
      await holdSend;
      if (loseSend) throw new Error("Synthetic lost push response");
      return { sentMessages: [{ id: "synthetic-message" }] };
    });
    f.providers.splice(0, f.providers.length, {
      ...f.providers[0]!,
      service: "line",
      displayName: "LINE",
      actions: [
        {
          ...sampleAction,
          id: "line.send_push_text",
          service: "line",
          inputSchema: {
            ...sampleAction.inputSchema,
            properties: {
              ...sampleAction.inputSchema.properties,
              retryKey: { type: "string", format: "uuid" },
            },
          },
        },
        {
          ...sampleAction,
          id: "line.get_bot_info",
          service: "line",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    const context: AdapterContext = {
      ...owner,
      operationId: "setup",
      traceId: "setup",
      signal: new AbortController().signal,
    };
    const auth = await f.adapter.begin(
      {
        provider: "line",
        credential: "synthetic-channel-token",
        redirectUrl: "https://app.example.test",
      },
      context,
    );
    connectionId = (
      await db.prisma.connection.create({
        data: {
          userId: owner.userId,
          spaceId: owner.spaceId,
          connectorId: "open-connector",
          provider: "line",
          displayName: "Staff alerts",
          status: "connected",
          providerRef: auth.state,
        },
      })
    ).id;
    integrations = new IntegrationProviderSettings(db.prisma, f.secrets, "synthetic-key", {
      "open-connector": f.adapter,
    });
    connector = createCustomerConnector({ prisma: db.prisma, integrations });
    line = createCustomerLineAlerts({
      prisma: db.prisma,
      connector,
      webOrigin: "https://app.example.test",
    });
    const channel = await db.prisma.customerChannel.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: owner.botId,
        provider: "web",
        accountId: randomUUID(),
        name: "Customer",
        ciphertext: "",
        enabled: true,
      },
    });
    conversationId = await createCustomerInbox(db.prisma).receive(channel.id, {
      externalId: "one",
      externalThreadId: "thread",
      customerId: "shopper",
      name: "Shopper",
      body: "Private customer content",
    });
    await db.prisma.customerConversation.update({
      where: { id: conversationId },
      data: { ...startCustomerAttention(), owner: "staff" },
    });
    notify = vi.fn(async () => ({ status: "accepted" }));
    app = {
      describe: () => ({
        id: "app-fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { push: true, email: false },
      }),
      send: notify,
    };
  });
  afterEach(async () => {
    for (const actor of owners) {
      await db.prisma.space.deleteMany({ where: { id: actor.spaceId } });
      await db.prisma.accountDeletion.deleteMany({ where: { userId: actor.userId } });
      await db.prisma.user.deleteMany({ where: { id: actor.userId } });
    }
  });
  it("requires the received test code and sends only a reason and authenticated case link", async () => {
    const args = input();
    const result = await line.test(owner, owner.botId, args);
    const receivedCode = code();
    expect(JSON.stringify(result)).not.toContain(receivedCode);
    expect(await line.providers(owner)).toEqual([]);
    await expect(
      line.verify(owner, owner.botId, verifyInput(result!.id, "000000000000")),
    ).rejects.toThrow("does not match");
    expect(await line.providers(owner)).toEqual([]);
    await line.verify(owner, owner.botId, verifyInput(result!.id, receivedCode));
    expect(
      (await db.prisma.customerAlertDestination.findUniqueOrThrow({ where: { id: result!.id } }))
        .codeHash,
    ).toBeNull();
    await dispatch();
    await dispatch();
    expect(notify).toHaveBeenCalledOnce();
    expect(pushes).toHaveLength(2);
    const alert = pushes[1]!;
    expect(alert.to).toBe(target.recipientId);
    const url = new URL(alert.texts[0]!.split("\n")[1]!);
    expect(url.origin).toBe("https://app.example.test");
    expect(url.pathname).toBe("/app");
    expect([...url.searchParams]).toEqual([
      ["space", owner.spaceId],
      ["customer", conversationId],
    ]);
    expect(alert.texts[0]).not.toContain("Private customer content");
    expect(await db.prisma.customerChannel.count({ where: { userId: owner.userId } })).toBe(1);
    expect(
      await db.prisma.customerAlertDelivery.count({
        where: { conversationId, status: "accepted" },
      }),
    ).toBe(2);
  });
  it("deduplicates a test after a lost response, and a received code can still verify it", async () => {
    loseSend = true;
    const args = input();
    const first = await line.test(owner, owner.botId, args);
    expect(first?.status).toBe("uncertain");
    const receivedCode = code();
    expect((await line.test(owner, owner.botId, args))?.id).toBe(first?.id);
    expect(pushes).toHaveLength(1);
    await line.verify(owner, owner.botId, verifyInput(first!.id, receivedCode));
    expect(await line.providers(owner)).toHaveLength(1);
  });
  it("deduplicates concurrent setup requests before sending", async () => {
    const args = input();
    const result = await Promise.all([
      line.test(owner, owner.botId, args),
      line.test(owner, owner.botId, args),
    ]);
    expect(result[0]!.id).toBe(result[1]!.id);
    expect(pushes).toHaveLength(1);
  });
  it("rejects nonce reuse for another recipient and rate limits a new test", async () => {
    const args = input();
    const result = await line.test(owner, owner.botId, args);
    await expect(
      line.test(owner, owner.botId, {
        ...args,
        recipient: { kind: "user", recipientId: `U${"2".repeat(32)}` },
      }),
    ).rejects.toThrow("another destination");
    await expect(line.test(owner, owner.botId, input(result!.id))).rejects.toThrow("one minute");
    expect(pushes).toHaveLength(1);
  });
  it("expires verification and bounds code guessing", async () => {
    const result = await line.test(owner, owner.botId, input());
    const receivedCode = code();
    for (let i = 0; i < 5; i++)
      await expect(
        line.verify(owner, owner.botId, verifyInput(result!.id, "000000000000")),
      ).rejects.toThrow();
    await expect(
      line.verify(owner, owner.botId, verifyInput(result!.id, receivedCode)),
    ).rejects.toThrow("expired or is unavailable");
    expect(await line.providers(owner)).toEqual([]);
    expect(
      (await db.prisma.customerAlertDestination.findUniqueOrThrow({ where: { id: result!.id } }))
        .failedVerifications,
    ).toBe(5);
  });
  it("refuses an expired test code", async () => {
    const result = await line.test(owner, owner.botId, input());
    await db.prisma.customerAlertDestination.update({
      where: { id: result!.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(line.verify(owner, owner.botId, verifyInput(result!.id))).rejects.toThrow(
      "expired",
    );
    expect(await line.providers(owner)).toEqual([]);
  });
  it("does not retarget a verified destination when the provider account changes behind its reference", async () => {
    await verify();
    botIdentity = `U${"c".repeat(32)}`;
    await expect(dispatch()).rejects.toThrow();
    expect(pushes).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(
      (await createCustomerRepos(db.prisma).snapshot(owner, conversationId)).notificationIssue,
    ).toBe("failed");
  });
  it.each(["reference", "revoke", "delete"])(
    "refuses a destination after account %s",
    async (action) => {
      await verify();
      if (action === "reference")
        await db.prisma.connection.update({
          where: { id: connectionId },
          data: { providerRef: "different-account" },
        });
      if (action === "revoke")
        await db.prisma.connection.update({
          where: { id: connectionId },
          data: { status: "revoked" },
        });
      if (action === "delete") await db.prisma.connection.delete({ where: { id: connectionId } });
      await expect(dispatch()).rejects.toThrow();
      expect(pushes).toHaveLength(1);
      expect(
        (await createCustomerRepos(db.prisma).snapshot(owner, conversationId)).notificationIssue,
      ).toBe("failed");
    },
  );
  it("makes binding fields immutable at the database boundary", async () => {
    const result = await verify();
    for (const data of [
      { recipientId: `U${"2".repeat(32)}` },
      { providerRef: "another" },
      { botAccountId: "another" },
      { kind: "user" },
    ])
      await expect(
        db.prisma.customerAlertDestination.update({ where: { id: result.id }, data }),
      ).rejects.toThrow("immutable");
  });
  it("stops disabled destinations and requires a fresh ID and test to replace them", async () => {
    const first = await verify();
    const previous = (await line.providers(owner))[0]!;
    await line.disable(owner, owner.botId, { id: first.id });
    expect(await line.providers(owner)).toEqual([]);
    await expect(
      previous.send(
        {
          kind: "help",
          title: "Attention",
          body: "Open",
          botId: owner.botId,
          threadId: conversationId,
          customerConversationId: conversationId,
        },
        {
          userId: owner.userId,
          spaceId: owner.spaceId,
          operationId: "old-attempt",
          traceId: conversationId,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("disabled");
    await db.prisma.customerAlertDestination.update({
      where: { id: first.id },
      data: { createdAt: new Date(0) },
    });
    const second = await line.test(owner, owner.botId, input());
    expect(second!.id).not.toBe(first.id);
    await expect(
      line.test(owner, owner.botId, { ...input(), expectedId: first.id }),
    ).rejects.toThrow("Inspect the current");
  });
  it("retries a failed account read without repeating the app notification", async () => {
    await verify();
    rejectRead = true;
    await expect(dispatch()).rejects.toThrow();
    expect(notify).toHaveBeenCalledOnce();
    expect(pushes).toHaveLength(1);
    rejectRead = false;
    await db.prisma.customerConversation.update({
      where: { id: conversationId },
      data: { nextAttentionAlertAt: new Date() },
    });
    await dispatch();
    expect(pushes).toHaveLength(2);
    expect(notify).toHaveBeenCalledOnce();
  });
  it("does not resend an alert after losing the LINE response", async () => {
    await verify();
    loseSend = true;
    await expect(dispatch()).rejects.toThrow();
    await dispatch();
    expect(pushes).toHaveLength(2);
    expect(
      (await createCustomerRepos(db.prisma).snapshot(owner, conversationId)).notificationIssue,
    ).toBe("uncertain");
  });
  it("keeps the destination and account locked through an in-flight send", async () => {
    const destination = await verify();
    let release!: () => void;
    let started!: () => void;
    holdSend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    sendStarted = started;
    const sending = dispatch();
    try {
      await ready;
      for (const [table, id] of [
        ['"user"', owner.userId],
        ["connections", connectionId],
        ["customer_alert_destinations", destination.id],
      ]) {
        const client = await db.pool.connect();
        try {
          await client.query("BEGIN; SET LOCAL lock_timeout = '100ms'");
          await expect(
            client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
    } finally {
      release();
      await sending;
    }
  });
  it("lets an in-flight push finish before account deletion commits", async () => {
    await verify();
    let release!: () => void;
    holdSend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const sending = dispatch();
    await ready;
    const deleting = requestAccountDeletion(db.prisma, owner.userId);
    try {
      await vi.waitFor(async () => {
        const waiting = await db.pool.query(
          `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'
            AND query LIKE '%SELECT id FROM "user" WHERE id = %'`,
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      expect(
        await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
      ).toBeNull();
    } finally {
      release();
      await Promise.all([sending, deleting]);
    }
    expect(pushes).toHaveLength(2);
    expect(
      await db.prisma.accountDeletion.findUnique({ where: { userId: owner.userId } }),
    ).not.toBeNull();
    await expect(line.test(owner, owner.botId, input())).rejects.toThrow();
    await dispatch();
    expect(pushes).toHaveLength(2);
  });
  it("refuses setup and verification while account deletion owns the lifecycle lock", async () => {
    const destination = await line.test(owner, owner.botId, input());
    const args = verifyInput(destination!.id);
    const { organizationId } = await db.prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
    });
    const client = await db.pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM organization WHERE id = $1 FOR UPDATE", [organizationId]);
    const deleting = requestAccountDeletion(db.prisma, owner.userId);
    try {
      await vi.waitFor(async () => {
        const waiting = await db.pool.query(
          `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock'
            AND query LIKE '%SELECT o.id FROM organization o JOIN member m%'`,
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      await expect(line.test(owner, owner.botId, input(destination!.id))).rejects.toThrow(
        "unavailable",
      );
      await expect(line.verify(owner, owner.botId, args)).rejects.toThrow("unavailable");
      expect(pushes).toHaveLength(1);
      expect(
        await db.prisma.customerAlertDestination.count({ where: { userId: owner.userId } }),
      ).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await deleting;
    }
    await expect(line.verify(owner, owner.botId, args)).rejects.toThrow();
    expect(
      (
        await db.prisma.customerAlertDestination.findUniqueOrThrow({
          where: { id: destination!.id },
        })
      ).status,
    ).toBe("awaiting_confirmation");
  });
  it("keeps preferences private and excludes verification secrets from account export", async () => {
    const destination = await line.test(owner, owner.botId, input());
    const other = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    owners.push(other);
    await expect(line.verify(other, other.botId, verifyInput(destination!.id))).rejects.toThrow();
    await expect(line.disable(other, other.botId, { id: destination!.id })).rejects.toThrow();
    expect(await line.inspect(other, other.botId)).toBeNull();
    const records: unknown[] = [];
    await writeAccountExport(
      db.prisma,
      owner.userId,
      async (record) => {
        records.push(record);
      },
      async () => "",
      new AbortController().signal,
    );
    const text = JSON.stringify(records);
    expect(text).toContain(target.recipientId);
    expect(text).not.toContain(code());
    const stored = await db.prisma.customerAlertDestination.findUniqueOrThrow({
      where: { id: destination!.id },
    });
    expect(text).not.toContain(stored.codeHash);
    await db.prisma.user.delete({ where: { id: owner.userId } });
    expect(
      await db.prisma.customerAlertDestination.count({ where: { userId: owner.userId } }),
    ).toBe(0);
  });
  it.each([undefined, "http://outside.example.test", "https://user:password@app.example.test"])(
    "refuses unsafe or missing application origin %s before sending",
    async (webOrigin) => {
      const unsafe = createCustomerLineAlerts({ prisma: db.prisma, connector, webOrigin });
      await expect(unsafe.test(owner, owner.botId, input())).rejects.toThrow();
      expect(pushes).toHaveLength(0);
    },
  );
  it("uses the assigned staff destination for reminders and the owner's destination for escalation", async () => {
    await verify();
    const member = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    owners.push(member);
    const { organizationId } = await db.prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
    });
    await db.prisma.member.create({
      data: {
        id: randomUUID(),
        userId: member.userId,
        organizationId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const bot = await db.prisma.bot.create({
      data: {
        userId: member.userId,
        spaceId: owner.spaceId,
        name: "Assigned staff",
        color: "blue",
        thread: { create: { userId: member.userId, spaceId: owner.spaceId } },
      },
    });
    const actor = { userId: member.userId, spaceId: owner.spaceId };
    await db.prisma.connection.update({ where: { id: connectionId }, data: { scope: "team" } });
    const recipient = { kind: "user", recipientId: `U${"2".repeat(32)}` };
    const tested = await line.test(actor, bot.id, { ...input(), recipient });
    await line.verify(actor, bot.id, { ...verifyInput(tested!.id), recipient });
    const conversation = await db.prisma.customerConversation.update({
      where: { id: conversationId },
      data: { assignee: { connect: { id: member.userId } }, channel: { update: { shared: true } } },
    });
    for (const minutes of [0, 10, 30, 60])
      await dispatch(new Date(conversation.attentionStartedAt!.getTime() + minutes * 60000));
    expect(pushes.slice(2).map((push) => push.to)).toEqual([
      recipient.recipientId,
      recipient.recipientId,
      target.recipientId,
    ]);
    expect(notify.mock.calls.map(([, context]) => context.userId)).toEqual([
      member.userId,
      member.userId,
      owner.userId,
    ]);
  });
  it("allows verified LINE alerts when app help notifications are disabled", async () => {
    await verify();
    await db.prisma.notificationPreference.update({
      where: { spaceId_userId: { userId: owner.userId, spaceId: owner.spaceId } },
      data: { help: false },
    });
    await dispatch();
    expect(pushes).toHaveLength(2);
    expect(notify).not.toHaveBeenCalled();
    expect(
      await db.prisma.customerAlertDelivery.count({
        where: { conversationId, status: "accepted" },
      }),
    ).toBe(1);
  });
  it("defers LINE during quiet hours and stops its reminders after acknowledgement", async () => {
    await verify();
    const night = new Date("2026-01-02T23:00:00Z");
    const morning = new Date("2026-01-03T08:00:00Z");
    await db.prisma.notificationPreference.update({
      where: { spaceId_userId: { userId: owner.userId, spaceId: owner.spaceId } },
      data: {
        customerQuietHours: { start: "22:00", end: "08:00", timezone: "UTC" },
      },
    });
    await db.prisma.customerConversation.update({
      where: { id: conversationId },
      data: {
        attentionStartedAt: night,
        nextAttentionAlertAt: night,
        ownerAttentionAlertAt: night,
      },
    });
    await dispatch(night);
    expect(pushes).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    await dispatch(morning);
    expect(pushes).toHaveLength(2);
    await createCustomerInbox(db.prisma).updateCase(owner, {
      id: conversationId,
      acknowledge: true,
    });
    await dispatch(new Date(morning.getTime() + 3600000));
    expect(pushes).toHaveLength(2);
    expect(notify).toHaveBeenCalledOnce();
  });
  it("composes the staff setup tools and scheduled delivery through the customer service", async () => {
    const service = createCustomerConversations({
      prisma: db.prisma,
      integrations,
      secrets: f.secrets,
      webOrigin: "https://app.example.test",
      notifications: app,
      jobs: { enqueue: vi.fn() } as unknown as JobPublisher,
    });
    const tested = (await service.manage(owner, owner.botId, "alert_line_test", input())) as {
      id: string;
    };
    await service.manage(owner, owner.botId, "alert_line_verify", verifyInput(tested.id));
    await service.reconcile();
    expect(pushes).toHaveLength(2);
    expect(notify).toHaveBeenCalledOnce();
    await service.manage(owner, owner.botId, "alert_line_disable", { id: tested.id });
    expect(await service.manage(owner, owner.botId, "alert_line", {})).toBeNull();
  });
});
