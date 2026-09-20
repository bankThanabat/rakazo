import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { createDb, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerConnector } from "./customer-connector.js";
import { instagramAccountHash } from "./instagram-comment-writes.js";
import { IntegrationGatewayClient } from "./integration-gateway-client.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("Instagram comment dispatch provenance", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let context: AdapterContext;
  let call: ConnectorCall;
  let provider: ManagedConnectorProvider;
  let settings: IntegrationProviderSettings;
  let events: ConnectorEvent[];
  let identity: string;
  let beforeSend: () => Promise<void>;
  const sent = vi.fn();
  const resolve = vi.fn(async (request: ConnectorCall) => ({
    call: request,
    tool: { name: request.tool, description: "Synthetic action", inputSchema: {}, readOnly: false },
  }));
  const collect = async (request = call, adapter?: ManagedConnectorProvider) => {
    const result = [];
    for await (const event of (adapter ?? (await settings.resolve("open-connector"))!).execute(
      request,
      context,
    ))
      result.push(event);
    return result;
  };
  const receipts = () => db.prisma.instagramSend.findMany({ where: { spaceId: owner.spaceId } });
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    owner = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    const connection = await db.prisma.connection.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        provider: "instagram",
        connectorId: "open-connector",
        providerRef: "PRIVATE_BINDING",
        displayName: "Synthetic account",
        status: "connected",
        actionPolicy: {
          defaults: { "instagram.reply_to_comment": false, "instagram.send_message": false },
        },
      },
    });
    context = {
      spaceId: owner.spaceId,
      userId: owner.userId,
      signal: new AbortController().signal,
      operationId: "test",
      traceId: "test",
      connectedConnections: [
        {
          id: connection.id,
          connectorId: "open-connector",
          externalId: "instagram",
          displayName: "Synthetic account",
          providerRef: "PRIVATE_BINDING",
        },
      ],
    };
    call = {
      tool: "instagram.reply_to_comment",
      executionId: randomUUID(),
      route: {
        connectorId: "open-connector",
        resourceId: connection.id,
        toolName: "instagram.reply_to_comment",
      },
      args: { commentId: "parent", message: "PRIVATE_REPLY_TEXT" },
    };
    events = [
      { type: "result", data: { commentId: "generated-reply", parentCommentId: "parent" } },
    ];
    beforeSend = async () => {};
    sent.mockClear();
    resolve.mockClear();
    identity = "account-a";
    provider = {
      accountIdentity: async () => ({ provider: "instagram", id: identity }),
      resolveCall: resolve,
      async *execute(request: ConnectorCall) {
        sent(request);
        await beforeSend();
        yield* events;
      },
    } as unknown as ManagedConnectorProvider;
    settings = new IntegrationProviderSettings(
      db.prisma,
      new EncryptedSecretStore("test-key"),
      "test",
      { "open-connector": provider },
    );
  });
  afterEach(async () => {
    await db.prisma.space.deleteMany({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });

  function directMessage() {
    call = {
      ...call,
      tool: "instagram.send_message",
      route: { ...call.route!, toolName: "instagram.send_message" },
      args: { recipientId: "customer-scoped-id", text: "PRIVATE_DM_TEXT" },
    };
    events = [
      {
        type: "result",
        data: { messageId: "generated-message", recipientId: "customer-scoped-id" },
      },
    ];
  }

  it("upgrades a populated legacy ledger without rewriting its comment IDs or identity", async () => {
    const migration = (name: string) =>
      readFile(
        new URL(`../../db/prisma/migrations/${name}/migration.sql`, import.meta.url),
        "utf8",
      );
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      // PostgreSQL forbids temporary-table FKs to permanent tables. Keep this
      // upgrade rehearsal entirely inside the connection's temporary schema.
      await client.query("CREATE TEMP TABLE receipt_test_spaces (id TEXT PRIMARY KEY)");
      await client.query("INSERT INTO receipt_test_spaces VALUES ($1)", [owner.spaceId]);
      await client.query(
        (await migration("20260919180000_instagram_comment_writes"))
          .replace(
            "CREATE TABLE instagram_comment_writes",
            "CREATE TEMP TABLE instagram_comment_writes",
          )
          .replace("REFERENCES spaces(id)", "REFERENCES pg_temp.receipt_test_spaces(id)"),
      );
      for (const name of [
        "20260919190000_instagram_receipt_recovery",
        "20260919200000_instagram_account_binding",
      ])
        await client.query(
          (await migration(name)).replace(
            "ALTER TABLE instagram_comment_writes",
            "ALTER TABLE pg_temp.instagram_comment_writes",
          ),
        );
      await client.query(
        `INSERT INTO pg_temp.instagram_comment_writes
        (id, "spaceId", "executionKey", "requestHash", "commentId", result)
        VALUES ('legacy', $1, 'old-execution', 'old-request', 'old-comment', $2)`,
        [owner.spaceId, JSON.stringify({ commentId: "old-comment", parentCommentId: "parent" })],
      );
      await client.query(
        (await migration("20260919210000_instagram_message_receipts")).replace(
          "ALTER TABLE instagram_comment_writes",
          "ALTER TABLE pg_temp.instagram_comment_writes",
        ),
      );
      expect(
        (
          await client.query(`SELECT "commentId", result, action, "accountHash"
        FROM pg_temp.instagram_comment_writes WHERE id = 'legacy'`)
        ).rows,
      ).toEqual([
        {
          commentId: "old-comment",
          result: { commentId: "old-comment", parentCommentId: "parent" },
          action: null,
          accountHash: null,
        },
      ]);
      await client.query(
        `INSERT INTO pg_temp.instagram_comment_writes
        (id, "spaceId", "executionKey", "requestHash", action, "targetId", "commentId", result)
        VALUES ('dm', $1, 'dm-execution', 'dm-request', 'instagram.send_message', 'customer', 'dm-id', $2)`,
        [owner.spaceId, JSON.stringify({ messageId: "dm-id", recipientId: "customer" })],
      );
      expect(
        (await client.query("SELECT count(*)::int AS count FROM pg_temp.instagram_comment_writes"))
          .rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("records account-bound DMs before dispatch and replays confirmed IDs without retaining text", async () => {
    directMessage();
    beforeSend = async () => {
      expect(await receipts()).toMatchObject([
        { action: "instagram.send_message", externalId: null, result: null },
      ]);
    };
    events = [
      {
        type: "result",
        data: {
          messageId: "generated-message",
          recipientId: "customer-scoped-id",
          threadId: "conversation",
          text: "PRIVATE_DM_TEXT",
          credentials: "PRIVATE_SECRET",
        },
      },
    ];
    const first = await collect();
    expect(first).toEqual([
      {
        type: "result",
        data: {
          messageId: "generated-message",
          recipientId: "customer-scoped-id",
          threadId: "conversation",
        },
      },
    ]);
    expect(sent.mock.calls[0]![0]).toMatchObject({ expectedAccountId: "account-a" });
    const rows = await receipts();
    expect(rows).toMatchObject([
      {
        externalId: "generated-message",
        targetId: "customer-scoped-id",
        accountHash: instagramAccountHash("account-a"),
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
    await db.prisma.instagramSend.update({
      where: { id: rows[0]!.id },
      data: { createdAt: new Date("2020-01-01") },
    });
    expect(await collect()).toEqual(first);
    expect(sent).toHaveBeenCalledOnce();
    const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
    expect(
      (await connector.commentWrites(context, { connectionId: call.route!.resourceId })).items,
    ).toMatchObject([
      { action: "instagram.send_message", externalId: "generated-message", status: "confirmed" },
    ]);
    identity = "another-account";
    await expect(collect()).rejects.toThrow("account changed");
    expect(
      (await connector.commentWrites(context, { connectionId: call.route!.resourceId })).items,
    ).toEqual([]);
    expect(sent).toHaveBeenCalledOnce();
  });

  it.each([
    [],
    [{ type: "error", message: "Provider failed" }],
    [{ type: "result", data: { messageId: "wrong-message", recipientId: "another-customer" } }],
    [{ type: "result", data: { messageId: "", recipientId: "customer-scoped-id" } }],
    [
      {
        type: "result",
        data: { messageId: "generated-message", recipientId: "customer-scoped-id" },
      },
      { type: "error", message: "Late failure" },
    ],
  ] as ConnectorEvent[][])(
    "holds unconfirmed DMs without replaying them: %j",
    async (...failure) => {
      directMessage();
      events = failure;
      await collect().catch(() => {});
      expect(await receipts()).toMatchObject([{ externalId: null, result: null }]);
      await expect(collect()).rejects.toThrow("uncertain");
      expect(sent).toHaveBeenCalledOnce();
    },
  );

  it("reconciles a lost DM outcome only from a matching receipt and never resends", async () => {
    directMessage();
    beforeSend = async () => {
      throw new Error("Lost DM response");
    };
    await expect(collect()).rejects.toThrow("Lost DM response");
    provider.receipt = vi.fn(async () => ({
      status: "confirmed" as const,
      data: {
        messageId: "generated-message",
        recipientId: "another-customer",
      },
    }));
    const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
    const receipt = (await receipts())[0]!;
    const input = { connectionId: call.route!.resourceId!, id: receipt.id };
    await expect(connector.reconcileCommentWrite(context, input)).rejects.toThrow(
      "does not match its target",
    );
    expect(await receipts()).toMatchObject([{ externalId: null }]);
    provider.receipt = vi.fn(async () => ({
      status: "confirmed" as const,
      data: {
        messageId: "generated-message",
        recipientId: "customer-scoped-id",
      },
    }));
    expect(await connector.reconcileCommentWrite(context, input)).toMatchObject({
      status: "confirmed",
    });
    expect(await receipts()).toMatchObject([{ externalId: "generated-message" }]);
    expect(await collect()).toEqual(events);
    expect(sent).toHaveBeenCalledOnce();
  });

  it.each([
    { messageId: "wrong", recipientId: "customer-scoped-id" },
    { messageId: "generated-message", recipientId: "wrong" },
    { commentId: "generated-message", parentCommentId: "customer-scoped-id" },
  ])(
    "rejects invalid DM confirmation in the database as well as the adapter: %j",
    async (result) => {
      await expect(
        db.prisma.instagramSend.create({
          data: {
            spaceId: owner.spaceId,
            executionKey: randomUUID(),
            requestHash: "test",
            action: "instagram.send_message",
            targetId: "customer-scoped-id",
            externalId: "generated-message",
            result,
          },
        }),
      ).rejects.toThrow();
    },
  );

  it("leaves a DM uncertain when confirmation storage fails", async () => {
    directMessage();
    const update = vi
      .spyOn(db.prisma.instagramSend, "update")
      .mockRejectedValueOnce(new Error("Database unavailable"));
    try {
      await expect(collect()).rejects.toThrow("Database unavailable");
    } finally {
      update.mockRestore();
    }
    await expect(collect()).rejects.toThrow("uncertain");
    expect(sent).toHaveBeenCalledOnce();
  });

  it("releases only a new DM claim after proof that the account guard rejected dispatch", async () => {
    directMessage();
    events = [{ type: "error", message: "Account changed", dispatch: "not_started" }];
    expect(await collect()).toEqual(events);
    expect(await receipts()).toEqual([]);
    directMessage();
    await collect();
    expect(await receipts()).toMatchObject([{ externalId: "generated-message" }]);
  });

  it("persists before staff dispatch, stores only IDs, and replays after upstream key expiry", async () => {
    beforeSend = async () => {
      expect(await receipts()).toMatchObject([{ externalId: null, result: null }]);
    };
    expect(await collect()).toEqual(events);
    const rows = await receipts();
    expect(rows).toMatchObject([
      {
        externalId: "generated-reply",
        result: events[0]!.type === "result" ? events[0]!.data : null,
      },
    ]);
    expect(
      await db.prisma.$queryRaw`
      SELECT "commentId" FROM instagram_comment_writes WHERE id = ${rows[0]!.id}
    `,
    ).toEqual([{ commentId: "generated-reply" }]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
    await db.prisma.instagramSend.update({
      where: { id: rows[0]!.id },
      data: { createdAt: new Date("2020-01-01") },
    });
    const worker = new IntegrationProviderSettings(
      db.prisma,
      new EncryptedSecretStore("test-key"),
      "test",
      { "open-connector": provider },
    );
    expect(
      await collect(
        { ...call, args: { message: "PRIVATE_REPLY_TEXT", commentId: "parent" } },
        (await worker.resolve("open-connector"))!,
      ),
    ).toEqual(events);
    expect(sent).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("binds the dispatched request and its durable receipt to the verified account", async () => {
    await collect();
    expect(sent.mock.calls[0]![0]).toMatchObject({ expectedAccountId: "account-a" });
    expect(await receipts()).toMatchObject([{ accountHash: instagramAccountHash("account-a") }]);
    identity = "account-b";
    await expect(collect()).rejects.toThrow("account changed");
    const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
    expect(
      (await connector.commentWrites(context, { connectionId: call.route!.resourceId })).items,
    ).toEqual([]);
    const receipt = (await receipts())[0]!;
    expect(
      await connector.reconcileCommentWrite(context, {
        connectionId: call.route!.resourceId,
        id: receipt.id,
      }),
    ).toEqual({ status: "missing" });
    expect(sent).toHaveBeenCalledOnce();
  });

  it("rejects a stale expected identity before creating a receipt or dispatching", async () => {
    await expect(collect({ ...call, expectedAccountId: "account-b" })).rejects.toThrow(
      "account changed",
    );
    expect(await receipts()).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it("releases only its new claim after a proven account guard rejection", async () => {
    events = [{ type: "error", message: "Changed", dispatch: "not_started" }];
    expect(await collect()).toEqual(events);
    expect(await receipts()).toEqual([]);
    // A later predispatch failure must never release an older uncertain send.
    events = [{ type: "error", message: "Response lost" }];
    await collect();
    events = [{ type: "error", message: "Changed", dispatch: "not_started" }];
    await expect(collect()).rejects.toThrow("uncertain");
    expect(await receipts()).toHaveLength(1);
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it.each(["revoke", "rebind"])(
    "rechecks receipt-list access after identity I/O: %s",
    async (change) => {
      await collect();
      provider.accountIdentity = async () => {
        await db.prisma.connection.update({
          where: { id: call.route!.resourceId! },
          data: change === "revoke" ? { status: "disconnected" } : { providerRef: "other-binding" },
        });
        return { provider: "instagram", id: "account-a" };
      };
      const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
      await expect(
        connector.commentWrites(context, { connectionId: call.route!.resourceId }),
      ).rejects.toThrow();
      expect(sent).toHaveBeenCalledOnce();
    },
  );

  it("fails closed without verified account identity", async () => {
    delete provider.accountIdentity;
    await expect(collect()).rejects.toThrow("identity is required");
    expect(sent).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([]);
  });

  it("does not assign historical account identity to legacy receipts", async () => {
    await collect();
    await db.prisma.instagramSend.updateMany({
      where: { spaceId: owner.spaceId },
      data: { accountHash: null },
    });
    await collect();
    expect(await receipts()).toMatchObject([{ accountHash: null }]);
    expect(sent).toHaveBeenCalledOnce();
  });

  it("records top-level comments as well as replies", async () => {
    call = {
      ...call,
      tool: "instagram.create_comment",
      route: { ...call.route!, toolName: "instagram.create_comment" },
      args: { mediaId: "media", message: "PRIVATE_REPLY_TEXT" },
    };
    events = [{ type: "result", data: { commentId: "top-level", mediaId: "media" } }];
    expect(await collect()).toEqual(events);
    expect(await receipts()).toMatchObject([{ externalId: "top-level" }]);
  });

  it("uses the same receipt for customer connector dispatch and keeps the action policy fence", async () => {
    const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
    await connector.execute(
      context,
      call.route!.resourceId!,
      call.tool,
      call.args,
      call.executionId,
      "customer",
      "write",
    );
    expect(await receipts()).toMatchObject([{ externalId: "generated-reply" }]);
    context.actionAccess = { [call.route!.resourceId!]: [] };
    await expect(collect()).rejects.toThrow();
    expect(sent).toHaveBeenCalledOnce();
  });

  it("arbitrates concurrent dispatchers before any network side effect", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    beforeSend = () => gate;
    const first = collect();
    try {
      await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
      await expect(collect()).rejects.toThrow("uncertain");
    } finally {
      release();
    }
    expect(await first).toEqual(events);
    expect(sent).toHaveBeenCalledOnce();
  });

  it.each(["error", "throw", "missing", "malformed", "multiple"])(
    "holds %s outcomes and never blindly resends them",
    async (kind) => {
      if (kind === "error") events = [{ type: "error", message: "Synthetic provider failure" }];
      if (kind === "throw")
        beforeSend = async () => {
          throw new Error("Response lost");
        };
      if (kind === "missing") events = [];
      if (kind === "malformed") events = [{ type: "result", data: { success: true } }];
      if (kind === "multiple") events.push(events[0]!);
      if (kind === "error") expect(await collect()).toEqual(events);
      else await expect(collect()).rejects.toThrow();
      expect(await receipts()).toMatchObject([{ externalId: null, result: null }]);
      await expect(collect()).rejects.toThrow("uncertain");
      expect(sent).toHaveBeenCalledOnce();
    },
  );

  it("rejects changed arguments or account binding on replay", async () => {
    await collect();
    await expect(
      collect({ ...call, args: { ...call.args, message: "different" } }),
    ).rejects.toThrow("original request");
    context.connectedConnections![0]!.providerRef = "replacement-binding";
    await expect(collect()).rejects.toThrow("original request");
    expect(sent).toHaveBeenCalledOnce();
  });

  it.each(["instagram.create_comment", "instagram.reply_to_comment"])(
    "keeps %s uncertain when its confirmed target does not match the request",
    async (action) => {
      const create = action === "instagram.create_comment";
      call = {
        ...call,
        tool: action,
        route: { ...call.route!, toolName: action },
        args: {
          [create ? "mediaId" : "commentId"]: "intended-target",
          message: "PRIVATE_REPLY_TEXT",
        },
      };
      events = [
        {
          type: "result",
          data: {
            commentId: "unrelated-reply",
            [create ? "mediaId" : "parentCommentId"]: "other-target",
          },
        },
      ];
      await expect(collect()).rejects.toThrow("does not match its target");
      expect(await receipts()).toMatchObject([{ externalId: null, result: null }]);
      await expect(collect()).rejects.toThrow("uncertain");
      expect(sent).toHaveBeenCalledOnce();
    },
  );

  it("does not dispatch when the receipt cannot be made durable", async () => {
    const insert = vi
      .spyOn(db.prisma.instagramSend, "createMany")
      .mockRejectedValueOnce(new Error("Database unavailable"));
    try {
      await expect(collect()).rejects.toThrow("Database unavailable");
    } finally {
      insert.mockRestore();
    }
    expect(sent).not.toHaveBeenCalled();
  });

  it("withholds success when receipt confirmation fails after the provider sends", async () => {
    const update = vi
      .spyOn(db.prisma.instagramSend, "update")
      .mockRejectedValueOnce(new Error("Confirmation unavailable"));
    try {
      await expect(collect()).rejects.toThrow("Confirmation unavailable");
    } finally {
      update.mockRestore();
    }
    expect(await receipts()).toMatchObject([{ externalId: null }]);
    await expect(collect()).rejects.toThrow("uncertain");
    expect(sent).toHaveBeenCalledOnce();
  });

  it("leaves reads unchanged and creates no provenance rows", async () => {
    await collect({ ...call, route: { ...call.route!, toolName: "instagram.list_media" } });
    expect(await receipts()).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("persists in the customer database before gateway dispatch, including a lost response", async () => {
    let loseResponse = false;
    const gateway = new IntegrationGatewayClient(
      { endpoint: "https://gateway.example.test", apiKey: "fake" },
      vi.fn<typeof fetch>(async (_url, init) => {
        const command = JSON.parse(String(init?.body));
        if (command.op === "resolve") return Response.json({ data: await resolve(command.call) });
        if (command.op === "accountIdentity")
          return Response.json({ data: { provider: "instagram", id: identity } });
        if (command.op === "receipt") return Response.json({ data: { status: "uncertain" } });
        expect(command.op).toBe("execute");
        sent(command.call);
        expect((await receipts()).some((row) => row.externalId === null)).toBe(true);
        if (loseResponse) throw new Error("Gateway response lost");
        return Response.json({ data: events });
      }),
    );
    settings = new IntegrationProviderSettings(
      db.prisma,
      new EncryptedSecretStore("test-key"),
      "test",
      { "open-connector": gateway },
    );
    expect(await collect()).toEqual(events);
    loseResponse = true;
    call = { ...call, executionId: randomUUID() };
    await expect(collect()).rejects.toThrow("Gateway response lost");
    await expect(collect()).rejects.toThrow("uncertain");
    expect(await receipts()).toHaveLength(2);
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("retains provenance after connection deletion and cascades on Space deletion", async () => {
    await collect();
    await db.prisma.connection.delete({ where: { id: call.route!.resourceId! } });
    expect(await receipts()).toHaveLength(1);
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    expect(await receipts()).toEqual([]);
  });

  it("recovers a lost response from a matching receipt without another execute", async () => {
    beforeSend = async () => {
      throw new Error("Response lost");
    };
    await expect(collect()).rejects.toThrow("Response lost");
    provider.receipt = vi.fn<NonNullable<ManagedConnectorProvider["receipt"]>>(async () => ({
      status: "confirmed",
      data: { commentId: "generated-reply", parentCommentId: "parent" },
    }));
    expect(await collect()).toEqual(events);
    expect(sent).toHaveBeenCalledOnce();
    expect(provider.receipt).toHaveBeenCalledOnce();
    expect(await receipts()).toMatchObject([{ externalId: "generated-reply" }]);
  });

  it.each(["missing", "uncertain", "wrong-target", "invalid", "lost"])(
    "does not clear uncertainty for a %s receipt",
    async (status) => {
      beforeSend = async () => {
        throw new Error("Response lost");
      };
      await expect(collect()).rejects.toThrow();
      provider.receipt = vi.fn(async () => {
        if (status === "lost") throw new Error("Receipt read failed");
        return (
          status === "wrong-target"
            ? { status: "confirmed", data: { commentId: "wrong", parentCommentId: "other" } }
            : status === "invalid"
              ? { status: "confirmed", data: { success: true } }
              : { status }
        ) as Awaited<ReturnType<NonNullable<ManagedConnectorProvider["receipt"]>>>;
      });
      await expect(collect()).rejects.toThrow();
      expect(sent).toHaveBeenCalledOnce();
      expect(await receipts()).toMatchObject([{ externalId: null, result: null }]);
    },
  );

  it("lists and reconciles staff sends without exposing request or binding digests", async () => {
    beforeSend = async () => {
      throw new Error("Response lost");
    };
    await expect(collect()).rejects.toThrow();
    provider.receipt = vi.fn<NonNullable<ManagedConnectorProvider["receipt"]>>(async () => ({
      status: "confirmed",
      data: { commentId: "generated-reply", parentCommentId: "parent" },
    }));
    const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
    const list = await connector.commentWrites(context, { connectionId: call.route!.resourceId });
    expect(list).toMatchObject({
      items: [{ status: "uncertain", action: call.tool, targetId: "parent" }],
      nextCursor: null,
    });
    const serialized = JSON.stringify(list);
    for (const hidden of ["PRIVATE_", "requestHash", "bindingHash", "executionKey"])
      expect(serialized).not.toContain(hidden);
    expect(
      await connector.reconcileCommentWrite(context, {
        connectionId: call.route!.resourceId,
        id: list.items[0]!.id,
      }),
    ).toMatchObject({ status: "confirmed" });
    expect(sent).toHaveBeenCalledOnce();
    await db.prisma.connection.update({
      where: { id: call.route!.resourceId! },
      data: { providerRef: "new-binding" },
    });
    expect(
      (await connector.commentWrites(context, { connectionId: call.route!.resourceId })).items,
    ).toEqual([]);
    await expect(
      connector.reconcileCommentWrite(context, {
        connectionId: call.route!.resourceId,
        id: list.items[0]!.id,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("fences receipt lookup by request, action, binding and action access", async () => {
    await collect();
    const row = (await receipts())[0]!;
    const adapter = (await settings.resolve("open-connector"))!;
    const query = {
      connectionId: call.route!.resourceId!,
      action: call.tool,
      executionKey: row.executionKey,
      requestHash: row.requestHash,
    };
    expect(await adapter.receipt!(query, context)).toMatchObject({ status: "confirmed" });
    expect(await adapter.receipt!({ ...query, requestHash: "0".repeat(64) }, context)).toEqual({
      status: "missing",
    });
    expect(
      await adapter.receipt!({ ...query, action: "instagram.create_comment" }, context),
    ).toEqual({ status: "missing" });
    context.actionAccess = {};
    await expect(adapter.receipt!(query, context)).rejects.toThrow("unavailable");
    delete context.actionAccess;
    context.connectedConnections![0]!.providerRef = "other-binding";
    expect(await adapter.receipt!(query, context)).toEqual({ status: "missing" });
  });

  it("paginates staff inspection within the selected binding", async () => {
    await collect();
    const original = (await receipts())[0]!;
    await db.prisma.instagramSend.createMany({
      data: Array.from({ length: 104 }, (_, index) => ({
        spaceId: owner.spaceId,
        executionKey: String(index),
        requestHash: "synthetic",
        bindingHash: original.bindingHash,
        action: original.action,
        targetId: original.targetId,
      })),
    });
    const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
    const first = await connector.commentWrites(context, { connectionId: call.route!.resourceId });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const last = await connector.commentWrites(context, {
      connectionId: call.route!.resourceId,
      cursor: first.nextCursor,
    });
    expect(last.items).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
    expect(new Set([...first.items, ...last.items].map((row) => row.id)).size).toBe(105);
  });

  it("does not reveal recovered results after connection revocation during the read", async () => {
    beforeSend = async () => {
      throw new Error("Response lost");
    };
    await expect(collect()).rejects.toThrow();
    provider.receipt = async () => {
      await db.prisma.connection.update({
        where: { id: call.route!.resourceId! },
        data: { status: "disconnected" },
      });
      return {
        status: "confirmed",
        data: { commentId: "generated-reply", parentCommentId: "parent" },
      };
    };
    const connector = createCustomerConnector({ prisma: db.prisma, integrations: settings });
    const row = (await receipts())[0]!;
    await expect(
      connector.reconcileCommentWrite(context, {
        connectionId: call.route!.resourceId,
        id: row.id,
      }),
    ).rejects.toThrow("Connect and authorize");
    expect(sent).toHaveBeenCalledOnce();
  });
});
