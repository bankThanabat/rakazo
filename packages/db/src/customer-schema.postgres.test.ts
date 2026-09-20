import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createDb } from "./index.js";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

it.skipIf(!available)(
  "preserves earlier purchase confirmations when adding retry recovery",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TEMP TABLE customer_operations (
        id TEXT PRIMARY KEY, status TEXT CHECK (status IN ('executing', 'completed', 'uncertain'))
      ) ON COMMIT DROP;
      CREATE TEMP TABLE customer_operation_receipts (
        "operationId" TEXT PRIMARY KEY, "reviewedByUserId" TEXT, "reviewedAt" TIMESTAMP(3),
        "reviewReason" TEXT, "providerReference" TEXT, result JSONB
      ) ON COMMIT DROP;
      INSERT INTO customer_operations VALUES ('confirmed', 'completed'), ('pending', 'uncertain');
      INSERT INTO customer_operation_receipts VALUES
        ('confirmed', 'synthetic-owner', '2026-01-01 10:00:00', 'Checked invoice', 'synthetic-invoice', '{"invoice":"one"}'),
        ('pending', NULL, NULL, NULL, NULL, NULL);
    `);
      await client.query(
        readFileSync(
          new URL(
            "../prisma/migrations/20260918120000_customer_operation_retry/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(
        (await client.query("SELECT id, status, attempt FROM customer_operations ORDER BY id"))
          .rows,
      ).toEqual([
        { id: "confirmed", status: "completed", attempt: 0 },
        { id: "pending", status: "uncertain", attempt: 0 },
      ]);
      const { rows } = await client.query(
        'SELECT "operationId", "reviewHistory" FROM customer_operation_receipts ORDER BY "operationId"',
      );
      expect(rows).toMatchObject([
        {
          operationId: "confirmed",
          reviewHistory: [
            {
              decision: "confirmed",
              attempt: 0,
              at: "2026-01-01T10:00:00.000Z",
              userId: "synthetic-owner",
              reason: "Checked invoice",
              providerReference: "synthetic-invoice",
              receipt: { invoice: "one" },
            },
          ],
        },
        { operationId: "pending", reviewHistory: [] },
      ]);
      await client.query(
        "UPDATE customer_operations SET status = 'retry_ready', attempt = 1 WHERE id = 'pending'",
      );
      expect(
        (await client.query("SELECT status, attempt FROM customer_operations WHERE id = 'pending'"))
          .rows,
      ).toEqual([{ status: "retry_ready", attempt: 1 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);

it.skipIf(!available)(
  "migrates orphan private records and enforces account deletion in surviving Spaces",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TEMP TABLE "user" (id TEXT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE memory_documents (id TEXT PRIMARY KEY, "userId" TEXT) ON COMMIT DROP;
      CREATE TEMP TABLE memory_revisions ("documentId" TEXT REFERENCES memory_documents(id) ON DELETE CASCADE, content TEXT) ON COMMIT DROP;
      CREATE TEMP TABLE notification_preferences (id TEXT, "userId" TEXT) ON COMMIT DROP;
      CREATE TEMP TABLE customer_conversation_reads (id TEXT, "userId" TEXT) ON COMMIT DROP;
      CREATE TEMP TABLE customer_conversations (id TEXT, "assigneeId" TEXT) ON COMMIT DROP;
      INSERT INTO "user" VALUES ('member'), ('other');
      INSERT INTO memory_documents SELECT id, id FROM unnest(ARRAY['member','other','deleted']) AS id;
      INSERT INTO memory_revisions SELECT id, 'Private memory' FROM memory_documents;
      INSERT INTO notification_preferences SELECT id, id FROM memory_documents;
      INSERT INTO customer_conversation_reads SELECT id, id FROM memory_documents;
      INSERT INTO customer_conversations SELECT id, id FROM memory_documents;
    `);
      await client.query(
        readFileSync(
          new URL(
            "../prisma/migrations/20260918100000_private_account_lifecycle/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      // New writes are constrained even before old orphans have been cleaned.
      await client.query("SAVEPOINT late_write");
      await expect(
        client.query(`INSERT INTO memory_documents VALUES ('late', 'deleted')`),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT late_write");
      await client.query(
        readFileSync(
          new URL(
            "../prisma/migrations/20260918100100_validate_private_account_lifecycle/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      for (const table of [
        "memory_documents",
        "notification_preferences",
        "customer_conversation_reads",
      ]) {
        expect((await client.query(`SELECT id FROM ${table} ORDER BY id`)).rows, table).toEqual([
          { id: "member" },
          { id: "other" },
        ]);
      }
      expect(
        (await client.query('SELECT "documentId" FROM memory_revisions ORDER BY "documentId"'))
          .rows,
      ).toEqual([{ documentId: "member" }, { documentId: "other" }]);
      expect(
        (
          await client.query(
            "SELECT \"assigneeId\" FROM customer_conversations WHERE id = 'deleted'",
          )
        ).rows,
      ).toEqual([{ assigneeId: null }]);
      await client.query("DELETE FROM \"user\" WHERE id = 'member'");
      for (const table of [
        "memory_documents",
        "notification_preferences",
        "customer_conversation_reads",
      ]) {
        expect((await client.query(`SELECT id FROM ${table}`)).rows, table).toEqual([
          { id: "other" },
        ]);
      }
      expect((await client.query('SELECT "documentId" FROM memory_revisions')).rows).toEqual([
        { documentId: "other" },
      ]);
      expect(
        (await client.query('SELECT id, "assigneeId" FROM customer_conversations ORDER BY id'))
          .rows,
      ).toEqual([
        { id: "deleted", assigneeId: null },
        { id: "member", assigneeId: null },
        { id: "other", assigneeId: "other" },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);

it.skipIf(!available)(
  "migrates pending human alerts without repeating delivered initial alerts",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TEMP TABLE customer_conversations (
        id TEXT, "needsHuman" BOOLEAN, "acknowledgedAt" TIMESTAMP(3), state TEXT,
        "updatedAt" TIMESTAMP(3), "notifiedGeneration" INTEGER
      ) ON COMMIT DROP;
      INSERT INTO customer_conversations VALUES
        ('pending', true, NULL, 'open', '2026-01-01 10:00:00', -1),
        ('delivered', true, NULL, 'open', '2026-01-01 10:00:00', 4),
        ('acknowledged', true, '2026-01-01 10:01:00', 'open', '2026-01-01 10:00:00', 4),
        ('resolved', true, NULL, 'resolved', '2026-01-01 10:00:00', -1),
        ('automatic', false, NULL, 'open', '2026-01-01 10:00:00', -1);
    `);
      await client.query(
        readFileSync(
          new URL(
            "../prisma/migrations/20260918070000_customer_alert_schedule/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const { rows } = await client.query(`SELECT id, "attentionId", "attentionAlertStage",
      to_char("nextAttentionAlertAt", 'HH24:MI') AS due FROM customer_conversations ORDER BY id`);
      expect(rows).toEqual([
        { id: "acknowledged", attentionId: null, attentionAlertStage: 0, due: null },
        { id: "automatic", attentionId: null, attentionAlertStage: 0, due: null },
        { id: "delivered", attentionId: expect.any(String), attentionAlertStage: 1, due: "10:10" },
        { id: "pending", attentionId: expect.any(String), attentionAlertStage: 0, due: "10:00" },
        { id: "resolved", attentionId: null, attentionAlertStage: 0, due: null },
      ]);
      expect(rows[2].attentionId).not.toBe(rows[3].attentionId);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);

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

it.skipIf(!available)(
  "adds social learning without losing existing conversation tasks",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TEMP TABLE spaces (id TEXT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE bots (id TEXT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE "user" (id TEXT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE connections (id TEXT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE learning_imports (id TEXT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE learning_tasks (id TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, evidence JSONB) ON COMMIT DROP;
      INSERT INTO learning_tasks VALUES ('earlier', 'existing-case', '{"guidance":"Keep earlier evidence"}');
    `);
      // Temporary parents require temporary children; all other migration statements are unchanged.
      const migration = readFileSync(
        new URL(
          "../prisma/migrations/20260918180000_social_learning/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ).replaceAll("CREATE TABLE", "CREATE TEMP TABLE");
      await client.query(migration);
      expect(
        (await client.query("SELECT * FROM learning_tasks WHERE id = 'earlier'")).rows,
      ).toEqual([
        {
          id: "earlier",
          conversationId: "existing-case",
          importId: null,
          evidence: { guidance: "Keep earlier evidence" },
        },
      ]);
      await client.query("INSERT INTO learning_imports(id) VALUES ('post-batch')");
      await client.query(
        "INSERT INTO learning_tasks(id, \"importId\") VALUES ('social', 'post-batch')",
      );
      expect(
        (
          await client.query(
            'SELECT "conversationId", "importId" FROM learning_tasks WHERE id = \'social\'',
          )
        ).rows,
      ).toEqual([{ conversationId: null, importId: "post-batch" }]);
      await client.query("DELETE FROM learning_imports WHERE id = 'post-batch'");
      expect((await client.query("SELECT id FROM learning_tasks ORDER BY id")).rows).toEqual([
        { id: "earlier" },
      ]);
      await expect(
        client.query("INSERT INTO learning_tasks(id) VALUES ('no-source')"),
      ).rejects.toThrow("learning_tasks_one_source");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);

it.skipIf(!available)(
  "adds resumable histories without altering populated archives and cascades retained hashes with bots",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TEMP TABLE bots (id TEXT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE learning_imports (id TEXT PRIMARY KEY, content TEXT) ON COMMIT DROP;
      INSERT INTO bots VALUES ('synthetic-bot');
      INSERT INTO learning_imports VALUES ('synthetic-import', 'original private archive');
    `);
      const migration = readFileSync(
        new URL(
          "../prisma/migrations/20260919100000_learning_history/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ).replaceAll("CREATE TABLE ", "CREATE TEMP TABLE ");
      await client.query(migration);
      expect((await client.query("SELECT content FROM learning_imports")).rows).toEqual([
        { content: "original private archive" },
      ]);
      await client.query(`
      INSERT INTO learning_histories (id, "importId", scope, "sourceKey", "updatedAt")
      VALUES ('synthetic-history', 'synthetic-import', 'bot', 'hash', CURRENT_TIMESTAMP);
      INSERT INTO learning_history_items ("botId", "sourceKey", identity, digest)
      VALUES ('synthetic-bot', 'hash', 'message-hash', 'text-hash');
      DELETE FROM learning_imports;
    `);
      expect(
        (await client.query("SELECT count(*)::int AS n FROM learning_histories")).rows[0].n,
      ).toBe(0);
      expect(
        (await client.query("SELECT count(*)::int AS n FROM learning_history_items")).rows[0].n,
      ).toBe(1);
      await client.query("DELETE FROM bots");
      expect(
        (await client.query("SELECT count(*)::int AS n FROM learning_history_items")).rows[0].n,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);

it.skipIf(!available)(
  "snapshots only known legacy memory and preserves existing revision provenance",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TEMP TABLE memory_documents (id TEXT PRIMARY KEY, revision INTEGER, content TEXT, "updatedAt" TIMESTAMP(3)) ON COMMIT DROP;
      CREATE TEMP TABLE memory_revisions (id TEXT PRIMARY KEY, "documentId" TEXT, revision INTEGER, content TEXT, "sourceRunId" TEXT, "createdAt" TIMESTAMP(3), UNIQUE("documentId", revision)) ON COMMIT DROP;
      INSERT INTO memory_documents VALUES ('legacy', 8, 'Known current value', '2026-01-01'), ('existing', 2, 'Second value', '2026-01-02');
      INSERT INTO memory_revisions VALUES ('old-event', 'existing', 2, 'Second value', 'old-run', '2026-01-02');
    `);
      await client.query(
        readFileSync(
          new URL(
            "../prisma/migrations/20260919110000_memory_audit/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(
        (
          await client.query(
            'SELECT "documentId", revision, content, "sourceRunId", "actorKind", reason FROM memory_revisions ORDER BY "documentId"',
          )
        ).rows,
      ).toEqual([
        {
          documentId: "existing",
          revision: 2,
          content: "Second value",
          sourceRunId: "old-run",
          actorKind: "unknown",
          reason: "Memory saved",
        },
        {
          documentId: "legacy",
          revision: 8,
          content: "Known current value",
          sourceRunId: null,
          actorKind: "unknown",
          reason: "Existing memory snapshot",
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);

it.skipIf(!available)(
  "upgrades only the original built-in LINE mapping for message withdrawal",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const client = await db.pool.connect();
    const original = {
      receive: {
        mode: "webhook",
        items: ["events"],
        timestampFormat: "milliseconds",
        incoming: { path: ["type"], equals: "message" },
        fields: {
          id: ["webhookEventId"],
          threadId: [
            ["source", "groupId"],
            ["source", "roomId"],
            ["source", "userId"],
          ],
          customerId: ["source", "userId"],
          body: ["message", "text"],
          timestamp: ["timestamp"],
        },
      },
    };
    const custom = {
      receive: {
        ...original.receive,
        fields: {
          ...original.receive.fields,
          providerMessageId: ["custom", "id"],
        },
      },
    };
    try {
      await client.query("BEGIN");
      await client.query(
        'CREATE TEMP TABLE customer_channels (id TEXT PRIMARY KEY, provider TEXT, binding JSONB, "updatedAt" TIMESTAMP(3)) ON COMMIT DROP',
      );
      for (const [id, provider, binding] of [
        ["default", "line", original],
        ["custom", "line", custom],
        ["other", "other", original],
      ])
        await client.query("INSERT INTO customer_channels VALUES ($1,$2,$3,'2026-01-01')", [
          id,
          provider,
          JSON.stringify(binding),
        ]);
      const sql = readFileSync(
        new URL(
          "../prisma/migrations/20260920090000_customer_message_withdrawals/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(sql.slice(sql.indexOf("-- Upgrade")));
      const { rows } = await client.query("SELECT id, binding FROM customer_channels ORDER BY id");
      expect(rows.find((row) => row.id === "default").binding.receive).toMatchObject({
        fields: { providerMessageId: ["message", "id"] },
        withdrawal: {
          event: { path: ["type"], equals: "unsend" },
          messageId: ["unsend", "messageId"],
        },
      });
      expect(rows.find((row) => row.id === "custom").binding).toEqual(custom);
      expect(rows.find((row) => row.id === "other").binding).toEqual(original);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);
