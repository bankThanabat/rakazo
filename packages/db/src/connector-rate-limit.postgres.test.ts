import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { deleteExpiredConnectorPermits, takeConnectorPermit } from "./connector-rate-limit.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("connector admission with PostgreSQL", () => {
  let clients: Array<ReturnType<typeof createDb>>;
  const keys: string[] = [];
  function key() {
    const value = createHash("sha256").update(randomUUID()).digest("hex");
    keys.push(value);
    return value;
  }
  beforeAll(async () => {
    clients = Array.from({ length: 3 }, () => createDb(process.env.DATABASE_URL!, { poolMax: 1 }));
  });
  afterEach(async () => {
    await clients[0]!.prisma.connectorRateLimit.deleteMany({
      where: { key: { in: keys.splice(0) } },
    });
  });
  afterAll(async () => {
    for (const client of clients) {
      await client.prisma.$disconnect();
      await client.pool.end();
    }
  });

  it("admits one concurrent caller across clients and does not reserve future slots", async () => {
    const bucket = key();
    const attempts = await Promise.all(
      Array.from({ length: 18 }, (_, i) =>
        takeConnectorPermit(clients[i % clients.length]!.prisma, bucket, 30000),
      ),
    );
    await clients[1]!.prisma.$executeRaw`SET TIME ZONE 'Asia/Bangkok'`;
    expect(attempts.filter((retry) => retry === 0)).toHaveLength(1);
    expect(attempts.filter((retry) => retry > 0)).toHaveLength(17);
    const before = await clients[0]!.prisma.connectorRateLimit.findUniqueOrThrow({
      where: { key: bucket },
    });
    expect(await takeConnectorPermit(clients[1]!.prisma, bucket, 30000)).toBeGreaterThan(0);
    expect(
      await clients[0]!.prisma.connectorRateLimit.findUniqueOrThrow({ where: { key: bucket } }),
    ).toEqual(before);
  });

  it("admits different account buckets independently and reopens expired slots", async () => {
    const first = key();
    const second = key();
    expect(await takeConnectorPermit(clients[0]!.prisma, first, 30000)).toBe(0);
    expect(await takeConnectorPermit(clients[1]!.prisma, second, 30000)).toBe(0);
    await clients[0]!.prisma.connectorRateLimit.update({
      where: { key: first },
      data: { availableAt: new Date(0) },
    });
    expect(await takeConnectorPermit(clients[2]!.prisma, first, 30000)).toBe(0);
    expect(await takeConnectorPermit(clients[0]!.prisma, second, 30000)).toBeGreaterThan(0);
  });

  it("refuses raw identities and invalid intervals without persisting them", async () => {
    for (const [bucket, interval] of [
      ["private-account", 600],
      [key(), 0],
      [key(), 60001],
      [key(), 1.5],
    ] as const)
      await expect(takeConnectorPermit(clients[0]!.prisma, bucket, interval)).rejects.toThrow(
        "Invalid",
      );
    expect(
      await clients[0]!.prisma.connectorRateLimit.count({ where: { key: { in: keys } } }),
    ).toBe(0);
  });

  it("cleans only expired operational rows using database time", async () => {
    const old = key();
    const active = key();
    await clients[0]!.prisma.connectorRateLimit.create({
      data: { key: old, availableAt: new Date(0) },
    });
    await takeConnectorPermit(clients[1]!.prisma, active, 30000);
    expect(await deleteExpiredConnectorPermits(clients[2]!.prisma)).toBe(1);
    expect(
      await clients[0]!.prisma.connectorRateLimit.findUnique({ where: { key: old } }),
    ).toBeNull();
    expect(await takeConnectorPermit(clients[2]!.prisma, active, 30000)).toBeGreaterThan(0);
  });
});
