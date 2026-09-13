import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCustomerRepos, createDb, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!available)("retired customer channels", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("retires all native channels without deleting history and is safe to rerun", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE customer_channels (
          id TEXT, provider TEXT, enabled BOOLEAN, "updatedAt" TIMESTAMP, ciphertext TEXT
        ) ON COMMIT DROP;
        CREATE TEMP TABLE customer_conversations (
          id TEXT, "channelId" TEXT, owner TEXT, "needsHuman" BOOLEAN, generation INTEGER,
          "leaseToken" TEXT, "leaseUntil" TIMESTAMP
        ) ON COMMIT DROP;
        CREATE TEMP TABLE customer_messages (
          id TEXT, "conversationId" TEXT, status TEXT, body TEXT, "nextAttemptAt" TIMESTAMP
        ) ON COMMIT DROP;
        INSERT INTO customer_channels
          SELECT provider, provider, true, NOW(), 'encrypted-fixture'
          FROM unnest(ARRAY['line', 'instagram', 'tiktok', 'other']) AS provider;
        INSERT INTO customer_conversations
          SELECT id, id, 'bot', true, 3, 'lease', NOW() FROM customer_channels;
        INSERT INTO customer_messages
          SELECT c.id || '-' || status, c.id, status, 'Preserved transcript', NOW()
          FROM customer_channels c
          CROSS JOIN unnest(ARRAY['received', 'sent', 'queued', 'processing', 'sending']) AS status;
      `);
      const sql = readFileSync(
        new URL(
          "../../db/prisma/migrations/20260911000000_retire_native_customer_channels/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(sql);
      const snapshot = async () => ({
        channels: (await client.query("SELECT * FROM customer_channels ORDER BY id")).rows,
        conversations: (await client.query("SELECT * FROM customer_conversations ORDER BY id"))
          .rows,
        messages: (await client.query("SELECT * FROM customer_messages ORDER BY id")).rows,
      });
      const result = await snapshot();
      expect(result.channels).toHaveLength(4);
      expect(result.messages).toHaveLength(20);
      for (const provider of ["line", "instagram", "tiktok"]) {
        expect(result.channels.find((row) => row.id === provider)).toMatchObject({
          enabled: false,
          ciphertext: "encrypted-fixture",
        });
        expect(result.conversations.find((row) => row.id === provider)).toMatchObject({
          owner: "staff",
          needsHuman: false,
          generation: 4,
          leaseToken: null,
          leaseUntil: null,
        });
        for (const [before, after] of [
          ["received", "received"],
          ["sent", "sent"],
          ["queued", "cancelled"],
          ["processing", "cancelled"],
          ["sending", "failed"],
        ]) {
          expect(result.messages.find((row) => row.id === `${provider}-${before}`)).toMatchObject({
            body: "Preserved transcript",
            status: after,
          });
        }
      }
      expect(result.channels.find((row) => row.id === "other")).toMatchObject({ enabled: true });
      expect(result.conversations.find((row) => row.id === "other")).toMatchObject({
        owner: "bot",
        generation: 3,
      });
      await client.query(sql);
      expect(await snapshot()).toEqual(result);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps archived transcripts readable only by their owner in their Space", async () => {
    const identity = await provisionMessagingIdentity(
      db.prisma,
      { provider: "test", address: randomUUID() },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    const actor = { userId: identity.userId, spaceId: identity.spaceId };
    try {
      const repos = createCustomerRepos(db.prisma);
      for (const provider of ["line", "instagram", "tiktok"]) {
        const channel = await db.prisma.customerChannel.create({
          data: {
            ...actor,
            botId: identity.botId,
            provider,
            accountId: randomUUID(),
            name: "Archived support",
            ciphertext: "encrypted-fixture",
            enabled: false,
          },
        });
        const conversation = await db.prisma.customerConversation.create({
          data: {
            channelId: channel.id,
            customerId: "customer",
            externalThreadId: "old-thread",
            name: "Customer",
            owner: "staff",
            messages: {
              create: { seq: 1, role: "customer", body: "Historical question", status: "received" },
            },
          },
        });
        const snapshot = await repos.snapshot(actor, conversation.id);
        expect(snapshot.conversation.provider).toBe(provider);
        expect(snapshot.messages[0]?.body).toBe("Historical question");
        for (const outsider of [
          { ...actor, userId: "another-user" },
          { ...actor, spaceId: "another-space" },
        ]) {
          expect(await repos.list(outsider)).toEqual([]);
          await expect(repos.snapshot(outsider, conversation.id)).rejects.toThrow();
        }
      }
      expect(await repos.list(actor)).toHaveLength(3);
    } finally {
      await db.prisma.space.delete({ where: { id: actor.spaceId } });
      await db.prisma.user.delete({ where: { id: actor.userId } });
    }
  });
});
