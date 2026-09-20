import { createHash, randomUUID } from "node:crypto";
import { createCustomerInbox, createDb, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { customerOperationReview, executeCustomerOperation } from "./customer-operation.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("durable customer operations", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let conversationId: string;
  const operation = () => ({
    spaceId: owner.spaceId,
    conversationId,
    receipt: { invoice: ["invoice"] },
    connectionId: "test-store",
    action: "invoice.create",
    operationKey: "verified-order",
    customerId: "customer",
    input: { orderId: "verified-order", amount: 20 },
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
        name: "Test shop",
        ciphertext: "",
      },
    });
    conversationId = await createCustomerInbox(db.prisma).receive(channel.id, {
      externalId: "one",
      externalThreadId: "thread",
      customerId: "customer",
      name: "Test shopper",
      body: "Test purchase",
    });
  });
  afterEach(async () => {
    await db.prisma.space.delete({ where: { id: owner.spaceId } });
    await db.prisma.user.delete({ where: { id: owner.userId } });
  });
  it("pages unresolved operations without hiding them behind newer completed records", async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: createHash("sha256").update(`${owner.spaceId}:${index}`).digest("hex"),
      spaceId: owner.spaceId,
      requestHash: "synthetic",
      status: index < 101 ? "uncertain" : "completed",
      createdAt: new Date(index < 101 ? "2000-01-01Z" : "2020-01-01Z"),
    }));
    await db.prisma.customerOperation.createMany({ data: rows });
    await db.prisma.customerOperationReceipt.createMany({
      data: rows.map((row) => ({
        operationId: row.id,
        conversationId,
        connectionId: "test-store",
        action: "invoice.create",
        recordKey: row.id,
        mapping: { invoice: ["invoice"] },
        createdAt: row.createdAt,
      })),
    });
    const review = customerOperationReview(db.prisma);
    const first = await review.list(owner, owner.botId);
    expect(first.operations).toHaveLength(100);
    expect(first.operations.every((row) => row.operation.status === "uncertain")).toBe(true);
    const second = await review.list(owner, owner.botId, { cursor: first.nextCursor });
    expect(second.operations).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.operations, ...second.operations].map((row) => row.operationId)).size,
    ).toBe(101);
    const completed = await review.list(owner, owner.botId, { status: "completed" });
    expect(completed.operations).toHaveLength(100);
    expect(completed.operations.every((row) => row.operation.status === "completed")).toBe(true);
    await expect(review.list(owner, "another-bot", { cursor: first.nextCursor })).rejects.toThrow();
  });
  it("reuses a confirmed receipt across turns without dispatching a second write", async () => {
    const send = vi.fn(async () => ({ invoice: "synthetic-receipt" }));
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual({
      invoice: "synthetic-receipt",
    });
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual({
      invoice: "synthetic-receipt",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      expect.stringMatching(/^customer.operation:[a-f0-9]{64}$/),
    ]);
    await expect(
      executeCustomerOperation(db.prisma, { ...operation(), input: { amount: 99 } }, send),
    ).rejects.toThrow("changed");
    await expect(
      executeCustomerOperation(db.prisma, { ...operation(), customerId: "other-customer" }, send),
    ).rejects.toThrow("changed");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("elects one writer across concurrent calls and refuses an interrupted outcome", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      started();
      await blocked;
      return { invoice: "synthetic-receipt" };
    });
    const first = executeCustomerOperation(db.prisma, operation(), send);
    await entered;
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow(
      "uncertain",
    );
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
    await db.prisma.customerOperation.updateMany({
      where: { spaceId: owner.spaceId },
      data: { status: "executing" },
    });
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow(
      "uncertain",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not expose a prior receipt or dispatch again after a linked identity changes", async () => {
    const identity = { id: "link", revision: 1, providerRef: "merchant-account" };
    const send = vi.fn(async () => ({ invoice: "recorded-order" }));
    await executeCustomerOperation(db.prisma, { ...operation(), identity }, send);
    await expect(
      executeCustomerOperation(db.prisma, { ...operation(), identity }, send),
    ).resolves.toEqual({ invoice: "recorded-order" });
    for (const changed of [
      { ...identity, revision: 2 },
      { ...identity, providerRef: "another-account" },
      undefined,
    ])
      await expect(
        executeCustomerOperation(db.prisma, { ...operation(), identity: changed }, send),
      ).rejects.toThrow("changed");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps a failed write uncertain instead of attempting it in another turn", async () => {
    const send = vi.fn(async () => {
      throw new Error("Lost confirmation after dispatch");
    });
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow(
      "uncertain",
    );
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow(
      "uncertain",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.prisma.customerOperation.findFirstOrThrow({ where: { spaceId: owner.spaceId } }),
    ).toMatchObject({ status: "uncertain" });
  });
  it("keeps only selected scalar receipt fields and erases them with the source case", async () => {
    const send = vi.fn(async () => ({
      invoice: "synthetic-receipt",
      privateCustomer: "Must not be retained",
      card: { sensitive: true },
    }));
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual({
      invoice: "synthetic-receipt",
    });
    expect(
      JSON.stringify(
        await db.prisma.customerOperationReceipt.findMany({ where: { conversationId } }),
      ),
    ).not.toContain("Must not be retained");
    await db.prisma.customerConversation.delete({ where: { id: conversationId } });
    expect(await db.prisma.customerOperationReceipt.count({ where: { conversationId } })).toBe(0);
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual({
      confirmed: true,
      receiptUnavailable: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("authorizes one identical retry in the original case and preserves provider idempotency", async () => {
    const send = vi.fn(async () => ({ invoice: "retry-receipt" }));
    send.mockRejectedValueOnce(new Error("Provider rejected the request"));
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow(
      "uncertain",
    );
    const review = customerOperationReview(db.prisma);
    const pending = (await review.list(owner, owner.botId, { status: "all" })).operations[0]!;
    const input = {
      id: pending.operationId,
      expectedAttempt: 0,
      reason: "Staff verified a terminal rejection with no invoice created",
      providerReference: "synthetic-rejection-42",
      failureStatus: "rejected",
    };
    await expect(
      review.retry({ ...owner, userId: "stranger" }, owner.botId, input),
    ).rejects.toThrow();
    const decisions = await Promise.allSettled([
      review.retry(owner, owner.botId, input),
      review.retry(owner, owner.botId, input),
    ]);
    expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    for (const changed of [
      { ...operation(), input: { amount: 99 } },
      { ...operation(), customerId: "other-customer" },
      { ...operation(), conversationId: "another-case" },
    ])
      await expect(executeCustomerOperation(db.prisma, changed, send)).rejects.toThrow();
    expect((await review.list(owner, owner.botId, { status: "all" })).operations[0]).toMatchObject({
      operation: { status: "retry_ready", attempt: 1 },
      reviewHistory: [
        { decision: "retry", attempt: 0, userId: owner.userId, failureStatus: "rejected" },
      ],
    });
    await expect(
      review.confirm(owner, owner.botId, {
        id: input.id,
        expectedAttempt: input.expectedAttempt,
        reason: input.reason,
        providerReference: input.providerReference,
        receipt: { invoice: "stale" },
      }),
    ).rejects.toThrow("changed");
    const retries = await Promise.allSettled([
      executeCustomerOperation(db.prisma, operation(), send),
      executeCustomerOperation(db.prisma, operation(), send),
    ]);
    expect(retries.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual({
      invoice: "retry-receipt",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(
      (await review.list(owner, owner.botId, { status: "all" })).operations[0]!.operation,
    ).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });
  it.each([false, true])(
    "fences an old attempt while a retry is running, old failure: %s",
    async (failOld) => {
      let enterOld!: () => void;
      let releaseOld!: () => void;
      const enteredOld = new Promise<void>((resolve) => {
        enterOld = resolve;
      });
      const blockedOld = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      const old = executeCustomerOperation(db.prisma, operation(), async () => {
        enterOld();
        await blockedOld;
        if (failOld) throw new Error("Old timeout");
        return { invoice: "old-response" };
      });
      await enteredOld;
      const review = customerOperationReview(db.prisma);
      const row = (await review.list(owner, owner.botId, { status: "all" })).operations[0]!;
      const input = {
        id: row.operationId,
        expectedAttempt: 0,
        reason: "Verified terminal rejection",
        providerReference: "synthetic-terminal-rejection",
        failureStatus: "rejected",
      };
      await expect(review.retry(owner, owner.botId, input)).rejects.toThrow("still be running");
      await db.prisma.customerOperation.update({
        where: { id: row.operationId },
        data: { updatedAt: new Date(0) },
      });
      await review.retry(owner, owner.botId, input);
      let enterNew!: () => void;
      let releaseNew!: () => void;
      const enteredNew = new Promise<void>((resolve) => {
        enterNew = resolve;
      });
      const blockedNew = new Promise<void>((resolve) => {
        releaseNew = resolve;
      });
      const next = executeCustomerOperation(db.prisma, operation(), async () => {
        enterNew();
        await blockedNew;
        return { invoice: "new-response" };
      });
      await enteredNew;
      releaseOld();
      await expect(old).rejects.toThrow("uncertain");
      expect(
        (await review.list(owner, owner.botId, { status: "all" })).operations[0]!.operation,
      ).toMatchObject({
        status: "executing",
        attempt: 1,
      });
      releaseNew();
      await expect(next).resolves.toEqual({ invoice: "new-response" });
    },
  );
  it("retains ordered retry and confirmation decisions and rejects stale approvals", async () => {
    const send = vi.fn(async () => {
      throw new Error("Unconfirmed response");
    });
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow();
    const review = customerOperationReview(db.prisma);
    const row = (await review.list(owner, owner.botId, { status: "all" })).operations[0]!;
    const input = {
      id: row.operationId,
      expectedAttempt: 0,
      reason: "Provider confirms rejection",
      providerReference: "synthetic-rejected-operation",
      failureStatus: "rejected",
    };
    await review.retry(owner, owner.botId, input);
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow();
    await expect(review.retry(owner, owner.botId, input)).rejects.toThrow("changed");
    const confirmation = {
      id: row.operationId,
      expectedAttempt: 0,
      receipt: { invoice: "verified-second-attempt" },
      providerReference: "synthetic-invoice",
      reason: "Provider confirms invoice exists",
    };
    await expect(review.confirm(owner, owner.botId, confirmation)).rejects.toThrow("changed");
    await review.confirm(owner, owner.botId, { ...confirmation, expectedAttempt: 1 });
    expect(
      (await review.list(owner, owner.botId, { status: "all" })).operations[0]!.reviewHistory,
    ).toMatchObject([
      { decision: "retry", attempt: 0, failureStatus: "rejected" },
      { decision: "confirmed", attempt: 1, receipt: confirmation.receipt },
    ]);
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual(
      confirmation.receipt,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("lets a fresh provider confirmation cancel an approved retry before dispatch", async () => {
    const send = vi.fn(async () => {
      throw new Error("Unconfirmed response");
    });
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow();
    const review = customerOperationReview(db.prisma);
    const row = (await review.list(owner, owner.botId, { status: "all" })).operations[0]!;
    await review.retry(owner, owner.botId, {
      id: row.operationId,
      expectedAttempt: 0,
      reason: "Provider reported rejection",
      providerReference: "synthetic-rejection",
      failureStatus: "rejected",
    });
    const receipt = { invoice: "provider-corrected-receipt" };
    await review.confirm(owner, owner.botId, {
      id: row.operationId,
      expectedAttempt: 1,
      reason: "Provider corrected its status before retry",
      providerReference: "synthetic-invoice",
      receipt,
    });
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual(receipt);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch a reviewed retry after the source case was erased", async () => {
    const send = vi.fn(async () => {
      throw new Error("Provider rejected");
    });
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow();
    const review = customerOperationReview(db.prisma);
    const row = (await review.list(owner, owner.botId, { status: "all" })).operations[0]!;
    await review.retry(owner, owner.botId, {
      id: row.operationId,
      expectedAttempt: 0,
      reason: "Verified rejection",
      providerReference: "synthetic",
      failureStatus: "rejected",
    });
    await db.prisma.customerConversation.delete({ where: { id: conversationId } });
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.prisma.customerOperationReceipt.count({ where: { operationId: row.operationId } }),
    ).toBe(0);
  });
  it("refuses oversized or nested receipts without retrying the provider", async () => {
    const send = vi.fn(async () => ({ invoice: { private: "Unbounded object" } }));
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow(
      "uncertain",
    );
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow(
      "uncertain",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.prisma.customerOperationReceipt.findFirstOrThrow({ where: { conversationId } }),
    ).toMatchObject({ result: null });
  });
  it("records provider-confirmed recovery once without dispatching again and isolates its audit", async () => {
    const send = vi.fn(async () => {
      throw new Error("Confirmation lost");
    });
    await expect(executeCustomerOperation(db.prisma, operation(), send)).rejects.toThrow();
    const review = customerOperationReview(db.prisma);
    const pending = (await review.list(owner, owner.botId, { status: "all" })).operations[0]!;
    const input = {
      id: pending.operationId,
      receipt: { invoice: "verified-provider-invoice" },
      reason: "Staff checked the provider",
      providerReference: "provider receipt synthetic-42",
    };
    await expect(
      review.confirm({ ...owner, userId: "stranger" }, owner.botId, input),
    ).rejects.toThrow();
    await expect(
      review.confirm(owner, owner.botId, { ...input, receipt: { extra: "not configured" } }),
    ).rejects.toThrow("configured");
    expect(await review.confirm(owner, owner.botId, input)).toEqual({
      confirmed: true,
      dispatched: false,
    });
    await expect(review.confirm(owner, owner.botId, input)).rejects.toThrow("already confirmed");
    expect(await executeCustomerOperation(db.prisma, operation(), send)).toEqual(input.receipt);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await review.list(owner, owner.botId, { status: "all" })).operations[0]).toMatchObject({
      reviewedByUserId: owner.userId,
      reviewReason: input.reason,
      providerReference: input.providerReference,
      operation: { status: "completed" },
    });
  });
  it("refuses recovery while a provider call may still be running and preserves a later staff decision", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = executeCustomerOperation(db.prisma, operation(), async () => {
      started();
      await blocked;
      return { invoice: "late-provider-response" };
    });
    await entered;
    const review = customerOperationReview(db.prisma);
    const row = (await review.list(owner, owner.botId, { status: "all" })).operations[0]!;
    const input = {
      id: row.operationId,
      receipt: { invoice: "staff-verified" },
      reason: "Verified provider receipt",
      providerReference: "synthetic-provider-reference",
    };
    await expect(review.confirm(owner, owner.botId, input)).rejects.toThrow("still be running");
    await db.prisma.customerOperation.update({
      where: { id: row.operationId },
      data: { updatedAt: new Date(Date.now() - 360000) },
    });
    await review.confirm(owner, owner.botId, input);
    release();
    await expect(running).rejects.toThrow("uncertain");
    expect((await review.list(owner, owner.botId, { status: "all" })).operations[0]).toMatchObject({
      result: input.receipt,
      operation: { status: "completed" },
    });
  });
});
