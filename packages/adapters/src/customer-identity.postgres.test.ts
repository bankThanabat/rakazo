import { randomUUID } from "node:crypto";
import { createCustomerInbox, createDb, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { createCustomerConnector } from "./customer-connector.js";
import { currentCustomerIdentity, customerIdentityReview } from "./customer-identity.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("customer merchant identities", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let conversationId: string;
  let connectionId: string;
  let execute: ReturnType<typeof vi.fn>;
  let review: ReturnType<typeof customerIdentityReview>;
  const scope = () => ({ conversationId, connectionId, customerId: "channel-shopper" });
  const link = () => ({
    ...scope(),
    expectedRevision: 0,
    reason: "Staff verified the merchant account using the approved verification procedure",
    identity: { value: 7, action: "store.customer", input: { id: 7 }, path: ["id"] },
  });
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
    const channel = await db.prisma.customerChannel.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: owner.botId,
        provider: "web",
        accountId: randomUUID(),
        name: "Fixture",
        ciphertext: "",
      },
    });
    conversationId = await createCustomerInbox(db.prisma).receive(channel.id, {
      externalId: "first",
      externalThreadId: "thread",
      customerId: "channel-shopper",
      name: "Fixture customer",
      body: "My order",
    });
    const account = await db.prisma.connection.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId: "open-connector",
        provider: "store",
        providerRef: "fixture-account",
        displayName: "Fixture",
        status: "connected",
      },
    });
    connectionId = account.id;
    execute = vi.fn(async () => ({ id: 7, privateData: "Do not save the provider response" }));
    const connector = {
      connection: async () =>
        db.prisma.connection.findUniqueOrThrow({ where: { id: connectionId } }),
      execute,
    } as unknown as ReturnType<typeof createCustomerConnector>;
    review = customerIdentityReview(db.prisma, connector);
  });
  afterEach(async () => {
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });
  it("links typed provider identity, records review and fences the active case", async () => {
    expect(await review.inspect(owner, owner.botId, scope())).toMatchObject({
      revision: 0,
      active: false,
    });
    const before = await db.prisma.customerConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(await review.set(owner, owner.botId, link())).toMatchObject({
      revision: 1,
      value: 7,
      paused: true,
    });
    expect(execute).toHaveBeenCalledWith(
      owner,
      connectionId,
      "store.customer",
      { id: 7 },
      expect.any(String),
      "staff",
      "read",
      "fixture-account",
    );
    expect(await currentCustomerIdentity(db.prisma, scope())).toMatchObject({
      value: 7,
      revision: 1,
    });
    expect(
      await db.prisma.customerConversation.findUniqueOrThrow({ where: { id: conversationId } }),
    ).toMatchObject({ owner: "staff", generation: before.generation + 1 });
    const record = await review.inspect(owner, owner.botId, scope());
    expect(record.history).toEqual([
      expect.objectContaining({ revision: 1, value: 7, userId: owner.userId }),
    ]);
    expect(JSON.stringify(record)).not.toContain("privateData");
  });
  it("rejects unobserved participants, foreign bots and mismatched provider ID types", async () => {
    await expect(
      review.set(owner, owner.botId, { ...link(), customerId: "unseen" }),
    ).rejects.toThrow();
    await expect(review.set(owner, "another-bot", link())).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(
      review.set(owner, owner.botId, { ...link(), identity: { ...link().identity, value: "7" } }),
    ).rejects.toThrow("selected customer identity");
    expect(await db.prisma.customerIdentity.count()).toBe(0);
  });
  it("serializes concurrent decisions and refuses stale approval", async () => {
    const results = await Promise.allSettled([
      review.set(owner, owner.botId, link()),
      review.set(owner, owner.botId, link()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await review.inspect(owner, owner.botId, scope())).revision).toBe(1);
    await expect(review.set(owner, owner.botId, link())).rejects.toThrow("changed");
  });
  it("reserves a final revocation after the bounded review history fills", async () => {
    await review.set(owner, owner.botId, link());
    await db.prisma.customerIdentity.updateMany({
      where: { conversationId },
      data: {
        revision: 31,
        history: Array.from({ length: 31 }, (_, index) => ({ revision: index + 1, value: 7 })),
      },
    });
    await expect(
      review.set(owner, owner.botId, { ...link(), expectedRevision: 31 }),
    ).rejects.toThrow("limit");
    await expect(
      review.set(owner, owner.botId, {
        ...scope(),
        expectedRevision: 31,
        identity: null,
        reason: "Final revocation",
      }),
    ).resolves.toMatchObject({ revision: 32, value: null });
    expect(await currentCustomerIdentity(db.prisma, scope())).toBeNull();
    expect((await review.inspect(owner, owner.botId, scope())).history).toHaveLength(32);
  });
  it("rejects lossy numeric customer IDs before a provider read", async () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5])
      await expect(
        review.set(owner, owner.botId, { ...link(), identity: { ...link().identity, value } }),
      ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("reports a retained lease even after an earlier invalidation cancelled the message", async () => {
    await db.prisma.customerConversation.update({
      where: { id: conversationId },
      data: { leaseUntil: new Date(0) },
    });
    await db.prisma.customerMessage.updateMany({
      where: { conversationId },
      data: { status: "cancelled" },
    });
    expect(await review.set(owner, owner.botId, link())).toMatchObject({
      paused: true,
      inFlight: true,
    });
  });
  it("keeps participant and account namespaces separate", async () => {
    await review.set(owner, owner.botId, link());
    expect(
      await currentCustomerIdentity(db.prisma, { ...scope(), customerId: "other-participant" }),
    ).toBeNull();
    expect(
      await currentCustomerIdentity(db.prisma, { ...scope(), connectionId: "other-account" }),
    ).toBeNull();
    expect(
      await currentCustomerIdentity(db.prisma, { ...scope(), conversationId: "other-case" }),
    ).toBeNull();
  });
  it("invalidates a link when the provider account changes or disconnects and still permits revocation", async () => {
    await review.set(owner, owner.botId, link());
    await db.prisma.connection.update({
      where: { id: connectionId },
      data: { providerRef: "different-account" },
    });
    expect(await currentCustomerIdentity(db.prisma, scope())).toBeNull();
    await db.prisma.connection.update({
      where: { id: connectionId },
      data: { status: "disconnected", providerRef: null },
    });
    expect(
      await review.set(owner, owner.botId, {
        ...scope(),
        expectedRevision: 1,
        identity: null,
        reason: "Revoke obsolete link",
      }),
    ).toMatchObject({ revision: 2, value: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await review.inspect(owner, owner.botId, scope())).history).toHaveLength(2);
    expect(await currentCustomerIdentity(db.prisma, scope())).toBeNull();
  });
  it("rejects a provider-account switch while verification is in flight", async () => {
    execute.mockImplementationOnce(async () => {
      await db.prisma.connection.update({
        where: { id: connectionId },
        data: { providerRef: "reconnected-account" },
      });
      return { id: 7 };
    });
    await expect(review.set(owner, owner.botId, link())).rejects.toThrow();
    expect(await currentCustomerIdentity(db.prisma, scope())).toBeNull();
  });
  it.each(["case", "connection"])("erases identity and history with its %s", async (target) => {
    await review.set(owner, owner.botId, link());
    if (target === "case")
      await db.prisma.customerConversation.delete({ where: { id: conversationId } });
    else await db.prisma.connection.delete({ where: { id: connectionId } });
    expect(await db.prisma.customerIdentity.count()).toBe(0);
  });
});
