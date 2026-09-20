import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  CustomerOperationListInput,
  CustomerOperationResolveInput,
  CustomerOperationRetryInput,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { z } from "zod";
import { customerField } from "./customer-mapping.js";

const digest = (value: unknown) =>
  createHash("sha256").update(stableJsonValue(value)).digest("hex");

/** Reserve before dispatch. Only a staff-reviewed terminal failure may be tried again. */
export async function executeCustomerOperation(
  prisma: PrismaClient,
  operation: {
    spaceId: string;
    conversationId: string;
    receipt: Record<string, string[]>;
    connectionId: string;
    action: string;
    operationKey: unknown;
    customerId: string;
    input: Record<string, unknown>;
    identity?: { id: string; revision: number; providerRef: string };
  },
  execute: (executionId: string) => Promise<unknown>,
) {
  const key = z
    .union([z.string().trim().min(1).max(500), z.number().finite()])
    .parse(operation.operationKey);
  const id = digest([operation.spaceId, operation.connectionId, operation.action, key]);
  const requestHash = digest([
    operation.customerId,
    operation.input,
    operation.receipt,
    ...(operation.identity ? [operation.identity] : []),
  ]);
  // Unique insertion, unlike a read followed by insert, elects exactly one dispatcher.
  const claimed = await prisma.$transaction(async (tx) => {
    const claimed = await tx.customerOperation.createMany({
      data: { id, spaceId: operation.spaceId, requestHash, status: "executing" },
      skipDuplicates: true,
    });
    if (claimed.count) {
      await tx.customerOperationReceipt.create({
        data: {
          operationId: id,
          conversationId: operation.conversationId,
          connectionId: operation.connectionId,
          action: operation.action,
          recordKey: String(key),
          mapping: operation.receipt,
        },
      });
      return 0;
    }
    const retry = await tx.customerOperation.updateMany({
      where: {
        id,
        requestHash,
        status: "retry_ready",
        receipt: { is: { conversationId: operation.conversationId } },
      },
      data: { status: "executing" },
    });
    if (!retry.count) return null;
    // The update holds the row lock until the chosen attempt is returned.
    return (await tx.customerOperation.findUniqueOrThrow({ where: { id } })).attempt;
  });
  if (claimed === null) {
    const prior = await prisma.customerOperation.findUniqueOrThrow({
      where: { id },
      include: { receipt: true },
    });
    if (prior.requestHash !== requestHash || prior.status !== "completed")
      throw new Error("This operation changed or its outcome is uncertain. Staff must review it.");
    return prior.receipt?.result ?? { confirmed: true, receiptUnavailable: true };
  }
  try {
    const raw = await execute(`customer.operation:${id}`);
    const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
    const result = Object.fromEntries(
      Object.entries(operation.receipt).map(([name, path]) => [
        name,
        scalar.parse(customerField(raw, path)),
      ]),
    );
    if (JSON.stringify(result).length > 16000) throw new Error("Receipt is too large");
    await prisma.$transaction(async (tx) => {
      // Lock the operation before its receipt, matching staff reconciliation.
      const committed = await tx.customerOperation.updateMany({
        where: { id, status: "executing", attempt: claimed },
        data: { status: "completed" },
      });
      if (!committed.count) throw new Error("Operation was already reviewed");
      // Case deletion may erase the receipt while leaving the duplicate-prevention record.
      await tx.customerOperationReceipt.updateMany({
        where: { operationId: id },
        data: { result },
      });
    });
    return result;
  } catch {
    await prisma.customerOperation.updateMany({
      where: { id, status: "executing", attempt: claimed },
      data: { status: "uncertain" },
    });
    throw new Error(
      "The operation outcome is uncertain. Staff must check the provider before continuing.",
    );
  }
}

export function customerOperationReview(prisma: PrismaClient) {
  const scope = (actor: Pick<Actor, "userId" | "spaceId">, botId: string) => ({
    conversation: { channel: { spaceId: actor.spaceId, userId: actor.userId, botId } },
  });
  async function requireMember(actor: Pick<Actor, "userId" | "spaceId">) {
    if (
      !(await prisma.spaceMember.count({ where: { spaceId: actor.spaceId, userId: actor.userId } }))
    )
      throw new IsolationError();
  }
  return {
    async list(actor: Pick<Actor, "userId" | "spaceId">, botId: string, raw: unknown = {}) {
      await requireMember(actor);
      const input = CustomerOperationListInput.parse(raw);
      if (
        input.cursor &&
        !(await prisma.customerOperationReceipt.count({
          where: { operationId: input.cursor, ...scope(actor, botId) },
        }))
      )
        throw new IsolationError();
      const rows = await prisma.customerOperationReceipt.findMany({
        where: {
          ...scope(actor, botId),
          ...(input.status === "all"
            ? {}
            : {
                operation: {
                  status:
                    input.status === "completed"
                      ? "completed"
                      : { in: ["executing", "uncertain", "retry_ready"] },
                },
              }),
        },
        include: {
          operation: { select: { id: true, status: true, attempt: true, createdAt: true } },
        },
        orderBy: [{ createdAt: "desc" }, { operationId: "desc" }],
        ...(input.cursor ? { cursor: { operationId: input.cursor }, skip: 1 } : {}),
        take: 101,
      });
      return {
        operations: rows.slice(0, 100),
        nextCursor: rows.length > 100 ? rows[99]!.operationId : null,
      };
    },
    async confirm(actor: Pick<Actor, "userId" | "spaceId">, botId: string, raw: unknown) {
      return review(actor, botId, {
        decision: "confirmed",
        ...CustomerOperationResolveInput.parse(raw),
      });
    },
    async retry(actor: Pick<Actor, "userId" | "spaceId">, botId: string, raw: unknown) {
      return review(actor, botId, { decision: "retry", ...CustomerOperationRetryInput.parse(raw) });
    },
  };
  async function review(
    actor: Pick<Actor, "userId" | "spaceId">,
    botId: string,
    input:
      | ({ decision: "confirmed" } & z.infer<typeof CustomerOperationResolveInput>)
      | ({ decision: "retry" } & z.infer<typeof CustomerOperationRetryInput>),
  ) {
    if (input.decision === "confirmed" && JSON.stringify(input.receipt).length > 16000)
      throw new Error("Receipt is too large");
    return prisma.$transaction(async (tx) => {
      // Authorize before locking, and keep membership stable through the write.
      const authorized = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT operation.id FROM customer_operations operation
          JOIN customer_operation_receipts receipt ON receipt."operationId" = operation.id
          JOIN customer_conversations conversation ON conversation.id = receipt."conversationId"
          JOIN customer_channels channel ON channel.id = conversation."channelId"
          JOIN space_members member ON member."spaceId" = channel."spaceId" AND member."userId" = ${actor.userId}
          WHERE operation.id = ${input.id} AND channel."spaceId" = ${actor.spaceId}
            AND channel."userId" = ${actor.userId} AND channel."botId" = ${botId}
          FOR UPDATE OF operation FOR SHARE OF member`;
      if (!authorized.length) throw new IsolationError();
      const row = await tx.customerOperationReceipt.findFirst({
        where: { operationId: input.id, ...scope(actor, botId) },
        include: { operation: true },
      });
      if (!row) throw new IsolationError();
      if (row.operation.status === "completed")
        throw new Error("This operation is already confirmed");
      if (
        row.operation.attempt !== input.expectedAttempt ||
        (input.decision === "retry" && row.operation.status === "retry_ready")
      )
        throw new Error("This operation changed. Inspect it again before reviewing.");
      if (
        row.operation.status === "executing" &&
        row.operation.updatedAt.getTime() > Date.now() - 300000
      )
        throw new Error("The provider call may still be running. Check again after five minutes.");
      if (input.decision === "confirmed") {
        const fields = Object.keys(
          z.record(z.string(), z.array(z.string())).parse(row.mapping),
        ).sort();
        if (JSON.stringify(Object.keys(input.receipt).sort()) !== JSON.stringify(fields))
          throw new Error("Use exactly the configured confirmation fields");
      }
      // Keep one slot available for a final confirmation after repeated failures.
      const history = z
        .array(z.json())
        .max(input.decision === "retry" ? 30 : 31)
        .parse(row.reviewHistory);
      const at = new Date();
      await tx.customerOperation.update({
        where: { id: input.id },
        data:
          input.decision === "confirmed"
            ? { status: "completed" }
            : { status: "retry_ready", attempt: { increment: 1 } },
      });
      await tx.customerOperationReceipt.update({
        where: { operationId: input.id },
        data: {
          ...(input.decision === "confirmed" ? { result: input.receipt } : {}),
          reviewedByUserId: actor.userId,
          reviewedAt: at,
          reviewReason: input.reason,
          providerReference: input.providerReference,
          reviewHistory: [
            ...history,
            {
              decision: input.decision,
              attempt: input.expectedAttempt,
              userId: actor.userId,
              at: at.toISOString(),
              reason: input.reason,
              providerReference: input.providerReference,
              ...(input.decision === "confirmed"
                ? { receipt: input.receipt }
                : { failureStatus: input.failureStatus }),
            },
          ],
        },
      });
      return input.decision === "confirmed"
        ? { confirmed: true, dispatched: false }
        : { retryReady: true, attempt: input.expectedAttempt + 1, dispatched: false };
    });
  }
}
