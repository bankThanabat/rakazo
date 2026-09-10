import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createDb } from "./index.js";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

it.skipIf(!available)(
  "upgrades an existing customer inbox without losing data and tolerates existing fields",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      // Temporary tables shadow the product tables only on this connection.
      await client.query(`
      CREATE TEMP TABLE customer_conversations (id TEXT) ON COMMIT DROP;
      CREATE TEMP TABLE customer_messages (id TEXT) ON COMMIT DROP;
      INSERT INTO customer_conversations VALUES ('existing-conversation');
      INSERT INTO customer_messages VALUES ('existing-message');
    `);
      const sql = readFileSync(
        new URL(
          "../prisma/migrations/20260910020000_customer_delivery_state/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(sql);
      expect(
        (await client.query('SELECT id, "needsHuman" FROM customer_conversations')).rows,
      ).toEqual([{ id: "existing-conversation", needsHuman: false }]);
      expect(
        (await client.query('SELECT id, "sendAttempts", "nextAttemptAt" FROM customer_messages'))
          .rows,
      ).toEqual([{ id: "existing-message", sendAttempts: 0, nextAttemptAt: null }]);
      await client.query('UPDATE customer_conversations SET "needsHuman" = true');
      await client.query('UPDATE customer_messages SET "sendAttempts" = 2');
      await client.query(sql);
      expect(
        (await client.query('SELECT "needsHuman" FROM customer_conversations')).rows[0],
      ).toEqual({ needsHuman: true });
      expect((await client.query('SELECT "sendAttempts" FROM customer_messages')).rows[0]).toEqual({
        sendAttempts: 2,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);
