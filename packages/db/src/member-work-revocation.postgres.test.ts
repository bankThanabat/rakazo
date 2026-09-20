import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PoolClient } from "pg";
import { expect, it } from "vitest";
import { createDb } from "./client.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260920020000_space_member_work_revocation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

async function fixture(work: (client: PoolClient, second: PoolClient) => Promise<void>) {
  const db = createDb(process.env.DATABASE_URL!);
  const client = await db.pool.connect();
  const second = await db.pool.connect();
  const schema = `member_work_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await second.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE space_members (id TEXT PRIMARY KEY, "spaceId" TEXT, "userId" TEXT, UNIQUE("spaceId", "userId"));
      CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, "updatedAt" TIMESTAMP DEFAULT now());
      CREATE TABLE runs (id TEXT PRIMARY KEY, "spaceId" TEXT, "userId" TEXT, "taskId" TEXT,
        status TEXT, "completedAt" TIMESTAMP, "leaseOwner" TEXT, "leaseExpiresAt" TIMESTAMP,
        error TEXT, "updatedAt" TIMESTAMP DEFAULT now());
      CREATE TABLE attempts (id TEXT PRIMARY KEY, "runId" TEXT, status TEXT, "finishedAt" TIMESTAMP);
      CREATE TABLE routines (id TEXT PRIMARY KEY, "spaceId" TEXT, "userId" TEXT, active BOOLEAN, "updatedAt" TIMESTAMP DEFAULT now());
      CREATE TABLE external_effects (id TEXT PRIMARY KEY, "runId" TEXT REFERENCES runs(id), status TEXT, request TEXT);
      INSERT INTO space_members VALUES ('member', 'space', 'member'), ('other', 'space', 'other'), ('other-space', 'other-space', 'member');
      INSERT INTO routines VALUES ('orphan','space','removed',true,now()), ('member','space','member',true,now()),
        ('other','space','other',true,now()), ('other-space','other-space','member',true,now());
    `);
    for (const status of [...ACTIVE_RUN_STATUSES, "completed", "failed", "cancelled"]) {
      await client.query("INSERT INTO tasks(id,status) VALUES($1,$2)", [status, status]);
      await client.query(
        `INSERT INTO runs(id,"spaceId","userId","taskId",status,"leaseOwner","leaseExpiresAt",error)
        VALUES($1,'space','removed',$1,$1,'worker',now() + interval '1 minute','Retained error')`,
        [status],
      );
      await client.query('INSERT INTO attempts(id,"runId",status) VALUES($1,$1,$2)', [
        status,
        status === "running" ? "running" : "completed",
      ]);
    }
    await client.query(`
      INSERT INTO tasks(id,status) VALUES ('member','running'),('other','running'),('other-space','queued');
      INSERT INTO runs(id,"spaceId","userId","taskId",status) VALUES
        ('member','space','member','member','running'),('other','space','other','other','running'),
        ('other-space','other-space','member','other-space','queued');
      INSERT INTO attempts(id,"runId",status) VALUES ('member','member','running'),('other','other','running');
      INSERT INTO external_effects VALUES ('receipt','running','executing','Exact request');
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

it.skipIf(!enabled)(
  "retires orphan work on migration and revokes only the removed membership",
  async () => {
    await fixture(async (client) => {
      const rows = (await client.query("SELECT * FROM runs WHERE \"userId\"='removed'")).rows;
      for (const row of rows) {
        if (ACTIVE_RUN_STATUSES.includes(row.id)) {
          expect(row).toMatchObject({
            status: "cancelled",
            leaseOwner: null,
            leaseExpiresAt: null,
            error: null,
          });
          expect(row.completedAt).not.toBeNull();
          expect(
            (await client.query("SELECT status FROM tasks WHERE id=$1", [row.id])).rows[0].status,
          ).toBe("cancelled");
        } else
          expect(row).toMatchObject({
            status: row.id,
            error: "Retained error",
            leaseOwner: "worker",
          });
      }
      expect(
        (await client.query("SELECT status FROM attempts WHERE id='running'")).rows[0].status,
      ).toBe("cancelled");
      expect(
        (await client.query("SELECT active FROM routines WHERE id='orphan'")).rows[0].active,
      ).toBe(false);
      expect((await client.query("SELECT * FROM external_effects")).rows).toEqual([
        { id: "receipt", runId: "running", status: "executing", request: "Exact request" },
      ]);
      await client.query("DELETE FROM space_members WHERE id='member'");
      expect(
        (
          await client.query(
            "SELECT id,status FROM runs WHERE id IN ('member','other','other-space') ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "member", status: "cancelled" },
        { id: "other", status: "running" },
        { id: "other-space", status: "queued" },
      ]);
      expect(
        (
          await client.query(
            "SELECT id,active FROM routines WHERE id IN ('member','other','other-space') ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "member", active: false },
        { id: "other", active: true },
        { id: "other-space", active: true },
      ]);
      await expect(
        client.query(
          `INSERT INTO runs(id,"spaceId","userId",status) VALUES('late','space','member','queued')`,
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        client.query("UPDATE routines SET active=true WHERE id='member'"),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("INSERT INTO space_members VALUES ('returned','space','member')");
      expect((await client.query("SELECT status FROM runs WHERE id='member'")).rows[0].status).toBe(
        "cancelled",
      );
      expect(
        (await client.query("SELECT active FROM routines WHERE id='member'")).rows[0].active,
      ).toBe(false);
      await client.query(
        `INSERT INTO runs(id,"spaceId","userId",status) VALUES('new','space','member','queued')`,
      );
      await client.query("UPDATE routines SET active=true WHERE id='member'");
    });
  },
);

it.skipIf(!enabled)(
  "orders removal after a concurrent work insert, then cancels that work",
  async () => {
    await fixture(async (client, second) => {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO runs(id,"spaceId","userId","taskId",status) VALUES('racing','space','member','member','queued')`,
      );
      const pid = (await second.query("SELECT pg_backend_pid() AS id")).rows[0].id;
      const removal = second.query("DELETE FROM space_members WHERE id='member'");
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
        await removal;
        expect(
          (await client.query("SELECT status FROM runs WHERE id='racing'")).rows[0].status,
        ).toBe("cancelled");
      } finally {
        await client.query("ROLLBACK");
        await removal;
      }
    });
  },
);

it.skipIf(!enabled)("rejects work that waits behind a committed membership removal", async () => {
  await fixture(async (client, second) => {
    await client.query("BEGIN");
    await client.query("DELETE FROM space_members WHERE id='member'");
    const pid = (await second.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const insert = second
      .query(
        `INSERT INTO runs(id,"spaceId","userId",status) VALUES('late','space','member','queued')`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
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
      expect(await insert).toMatchObject({ code: "23503" });
      expect((await client.query("SELECT id FROM runs WHERE id='late'")).rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      await insert;
    }
  });
});

it.skipIf(!enabled)("uses member indexes to find work in a large Space", async () => {
  await fixture(async (client) => {
    await client.query(`
      INSERT INTO space_members SELECT 'bulk-'||n,'space','bulk-'||n FROM generate_series(1,10000) n;
      INSERT INTO runs(id,"spaceId","userId",status)
        SELECT 'bulk-'||n,'space','bulk-'||n,'running' FROM generate_series(1,10000) n;
      INSERT INTO routines(id,"spaceId","userId",active)
        SELECT 'bulk-'||n,'space','bulk-'||n,true FROM generate_series(1,10000) n;
      ANALYZE runs;
      ANALYZE routines;
    `);
    for (const [table, predicate, index] of [
      [
        "runs",
        "status IN ('queued','leased','running','waiting_input','waiting_takeover')",
        "runs_spaceId_userId_status_idx",
      ],
      ["routines", "active", "routines_spaceId_userId_active_idx"],
    ]) {
      const plan = await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM ${table}
        WHERE "spaceId"='space' AND "userId"='member' AND ${predicate}`);
      expect(JSON.stringify(plan.rows)).toContain(index);
    }
    await client.query("DELETE FROM space_members WHERE id='member'");
    expect((await client.query("SELECT status FROM runs WHERE id='member'")).rows[0].status).toBe(
      "cancelled",
    );
    expect(
      (await client.query("SELECT count(*)::int AS count FROM runs WHERE status='running'")).rows[0]
        .count,
    ).toBe(10001);
  });
});
