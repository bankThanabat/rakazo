import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { expect, it } from "vitest";
import { createDb } from "./client.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260920040000_customer_member_revocation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
async function fixture(work: (client: PoolClient, second: PoolClient) => Promise<void>) {
  const db = createDb(process.env.DATABASE_URL!);
  const client = await db.pool.connect();
  const second = await db.pool.connect();
  const schema = `customer_member_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await second.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE space_members (id TEXT PRIMARY KEY, "spaceId" TEXT, "userId" TEXT, UNIQUE("spaceId", "userId"));
      CREATE TABLE customer_channels (id TEXT PRIMARY KEY, "spaceId" TEXT, "userId" TEXT,
        enabled BOOLEAN DEFAULT true, "autoReplies" BOOLEAN DEFAULT true,
        "pollToken" TEXT DEFAULT 'poll', "pollUntil" TIMESTAMP DEFAULT now(),
        "nextPollAt" TIMESTAMP DEFAULT now(), "updatedAt" TIMESTAMP DEFAULT now());
      CREATE TABLE customer_conversations (id TEXT PRIMARY KEY, "channelId" TEXT,
        generation INT DEFAULT 4, owner TEXT DEFAULT 'bot', "needsHuman" BOOLEAN DEFAULT true,
        "nextAttentionAlertAt" TIMESTAMP DEFAULT now(), "ownerAttentionAlertAt" TIMESTAMP DEFAULT now(),
        "leaseToken" TEXT DEFAULT 'worker', "updatedAt" TIMESTAMP DEFAULT now());
      CREATE TABLE customer_messages (id TEXT PRIMARY KEY, "conversationId" TEXT, status TEXT, body TEXT);
      INSERT INTO space_members VALUES ('member','space','member'),('other','space','other'),('elsewhere','elsewhere','member');
      INSERT INTO customer_channels(id,"spaceId","userId") VALUES
        ('member','space','member'),('orphan','space','gone'),('other','space','other'),('elsewhere','elsewhere','member');
      INSERT INTO customer_conversations(id,"channelId") SELECT id,id FROM customer_channels;
      INSERT INTO customer_messages SELECT c.id||'-'||s,c.id,s,'Retained text'
        FROM customer_channels c CROSS JOIN unnest(ARRAY['queued','processing','sending','sent','failed']) s;
    `);
    await client.query(migration);
    await work(client, second);
  } finally {
    await client.query("ROLLBACK");
    await second.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    second.release();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}
async function expectRetired(client: PoolClient, id: string) {
  expect(
    (await client.query("SELECT * FROM customer_channels WHERE id=$1", [id])).rows[0],
  ).toMatchObject({
    enabled: false,
    autoReplies: false,
    pollToken: null,
    pollUntil: null,
    nextPollAt: null,
  });
  expect(
    (await client.query("SELECT * FROM customer_conversations WHERE id=$1", [id])).rows[0],
  ).toMatchObject({
    generation: 5,
    owner: "staff",
    needsHuman: false,
    nextAttentionAlertAt: null,
    ownerAttentionAlertAt: null,
    leaseToken: "worker",
  });
  const messages = (
    await client.query(
      'SELECT id,status,body FROM customer_messages WHERE "conversationId"=$1 ORDER BY id',
      [id],
    )
  ).rows;
  expect(messages).toEqual(
    ["failed", "processing", "queued", "sending", "sent"].map((status) => ({
      id: `${id}-${status}`,
      status: ["processing", "queued"].includes(status) ? "cancelled" : status,
      body: "Retained text",
    })),
  );
}

it.skipIf(!enabled)(
  "retires orphan and removed-owner channels without erasing dispatched outcomes or neighbors",
  async () => {
    await fixture(async (client) => {
      await expectRetired(client, "orphan");
      await client.query("DELETE FROM space_members WHERE id='member'");
      await expectRetired(client, "member");
      expect(
        (
          await client.query(
            "SELECT id,enabled FROM customer_channels WHERE id IN ('other','elsewhere') ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "elsewhere", enabled: true },
        { id: "other", enabled: true },
      ]);
      await expect(
        client.query("UPDATE customer_channels SET enabled=true WHERE id='member'"),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        client.query(
          `INSERT INTO customer_channels(id,"spaceId","userId") VALUES('late','space','member')`,
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("INSERT INTO space_members VALUES ('returned','space','member')");
      await expectRetired(client, "member");
      await client.query(
        "UPDATE customer_channels SET enabled=true,\"autoReplies\"=true WHERE id='member'",
      );
      expect(
        (await client.query("SELECT enabled FROM customer_channels WHERE id='member'")).rows[0]
          .enabled,
      ).toBe(true);
      expect(
        (await client.query("SELECT status FROM customer_messages WHERE id='member-queued'"))
          .rows[0].status,
      ).toBe("cancelled");
    });
  },
);

it.skipIf(!enabled)(
  "revokes the old identity when membership moves and preserves unrelated membership edits",
  async () => {
    await fixture(async (client) => {
      await client.query("UPDATE space_members SET id='renamed' WHERE id='member'");
      expect(
        (await client.query("SELECT enabled FROM customer_channels WHERE id='member'")).rows[0]
          .enabled,
      ).toBe(true);
      await client.query("UPDATE space_members SET \"userId\"='replacement' WHERE id='renamed'");
      await expectRetired(client, "member");
    });
  },
);

it.skipIf(!enabled)("orders membership removal after a concurrent channel insert", async () => {
  await fixture(async (client, second) => {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO customer_channels(id,"spaceId","userId") VALUES('racing','space','member')`,
    );
    const pid = (await second.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const removal = second.query("DELETE FROM space_members WHERE id='member'");
    try {
      await expect
        .poll(
          async () =>
            (await client.query("SELECT cardinality(pg_blocking_pids($1)) AS count", [pid])).rows[0]
              .count,
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);
      await client.query("COMMIT");
      await removal;
      expect(
        (await client.query("SELECT enabled FROM customer_channels WHERE id='racing'")).rows[0]
          .enabled,
      ).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      await removal;
    }
  });
});

it.skipIf(!enabled)(
  "rejects channel activation waiting behind committed membership removal",
  async () => {
    await fixture(async (client, second) => {
      await client.query("BEGIN");
      await client.query("DELETE FROM space_members WHERE id='member'");
      const pid = (await second.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const activation = second
        .query("UPDATE customer_channels SET enabled=true WHERE id='member'")
        .then(
          () => null,
          (error: unknown) => error,
        );
      try {
        await expect
          .poll(
            async () =>
              (await client.query("SELECT cardinality(pg_blocking_pids($1)) AS count", [pid]))
                .rows[0].count,
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
        await client.query("COMMIT");
        expect(await activation).toMatchObject({ code: "23503" });
        await expectRetired(client, "member");
      } finally {
        await client.query("ROLLBACK");
        await activation;
      }
    });
  },
);

it.skipIf(!enabled)(
  "rejects channel activation without deadlocking a crossing membership removal",
  async () => {
    await fixture(async (client, second) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL deadlock_timeout='50ms'");
      await client.query("SELECT id FROM customer_channels WHERE id='member' FOR UPDATE");
      const pid = (await second.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const removal = second.query("DELETE FROM space_members WHERE id='member'").then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await expect
          .poll(
            async () =>
              (await client.query("SELECT cardinality(pg_blocking_pids($1)) AS count", [pid]))
                .rows[0].count,
            { timeout: 5000 },
          )
          .toBeGreaterThan(0);
        await expect(
          client.query("UPDATE customer_channels SET enabled=true WHERE id='member'"),
        ).rejects.toMatchObject({ code: "23503" });
      } finally {
        await client.query("ROLLBACK");
        expect(await removal).toBeNull();
      }
      await expectRetired(client, "member");
    });
  },
);
