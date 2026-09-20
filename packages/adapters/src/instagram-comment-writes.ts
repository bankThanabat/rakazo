import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import type { ConnectorReceipt, ConnectorReceiptQuery } from "@rakazo/contracts";
import {
  ConnectorAccountIdentitySchema,
  ConnectorReceiptQuerySchema,
  ConnectorReceiptSchema,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import { assertConnectorActionAllowed } from "./connector-action-access.js";

const id = z.string().min(1).max(500);
const resultSchemas = {
  "instagram.create_comment": z.object({ commentId: id, mediaId: id }),
  "instagram.reply_to_comment": z.object({ commentId: id, parentCommentId: id }),
  "instagram.send_message": z.object({ messageId: id, recipientId: id, threadId: id.optional() }),
};
const targetFields = {
  "instagram.create_comment": "mediaId",
  "instagram.reply_to_comment": "commentId",
  "instagram.send_message": "recipientId",
} as const;
function isInstagramSend(action: unknown): action is keyof typeof resultSchemas {
  return typeof action === "string" && Object.hasOwn(resultSchemas, action);
}
const receiptId = (result: z.infer<(typeof resultSchemas)[keyof typeof resultSchemas]>) =>
  "messageId" in result ? result.messageId : result.commentId;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const instagramAccountHash = (id: string) => hash(JSON.stringify(["instagram", id]));
export async function instagramAccount(
  provider: ManagedConnectorProvider,
  connectionId: string,
  context: AdapterContext,
) {
  if (!provider.accountIdentity) return null;
  const account = ConnectorAccountIdentitySchema.parse(
    await provider.accountIdentity(connectionId, context),
  );
  if (account.provider !== "instagram")
    throw new Error("Instagram account identity is unavailable");
  return account;
}
export const instagramBindingHash = (ref: string) => hash(ref);
function parseInstagramResult(action: keyof typeof resultSchemas, target: string, value: unknown) {
  const result = resultSchemas[action].parse(value);
  if (
    ("recipientId" in result
      ? result.recipientId
      : "mediaId" in result
        ? result.mediaId
        : result.parentCommentId) !== target
  )
    throw new Error("Instagram send result does not match its target");
  return result;
}

/** A missing receipt never proves that a send failed. Only a matching confirmed receipt
 * can release uncertainty, and this path must never call execute. */
async function readInstagramReceipt(
  prisma: Pick<PrismaClient, "instagramSend">,
  provider: ManagedConnectorProvider,
  raw: ConnectorReceiptQuery,
  context: AdapterContext,
): Promise<ConnectorReceipt> {
  const query = ConnectorReceiptQuerySchema.parse(raw);
  const connection = context.connectedConnections?.find((row) => row.id === query.connectionId);
  if (
    connection?.externalId !== "instagram" ||
    connection.connectorId !== "open-connector" ||
    !connection.providerRef
  )
    throw new Error("Instagram connection is unavailable");
  assertConnectorActionAllowed(context, {
    connectorId: "open-connector",
    resourceId: connection.id,
    toolName: query.action,
  });
  context.signal.throwIfAborted();
  const key = { spaceId: context.spaceId, executionKey: query.executionKey };
  const previous = await prisma.instagramSend.findUnique({
    where: { spaceId_executionKey: key },
  });
  if (
    !previous ||
    previous.requestHash !== query.requestHash ||
    previous.bindingHash !== instagramBindingHash(connection.providerRef) ||
    previous.action !== query.action
  )
    return { status: "missing" };
  const account = await instagramAccount(provider, connection.id, context);
  if (
    previous.accountHash &&
    (!account || previous.accountHash !== instagramAccountHash(account.id))
  )
    return { status: "missing" };
  const action = previous.action;
  if (!isInstagramSend(action) || !previous.targetId) return { status: "uncertain" };
  const parseResult = (value: unknown) => parseInstagramResult(action, previous.targetId!, value);
  if (previous.result) return { status: "confirmed", data: parseResult(previous.result) };
  const remote = provider.receipt
    ? ConnectorReceiptSchema.parse(await provider.receipt(query, context))
    : null;
  if (remote?.status !== "confirmed") return { status: "uncertain" };
  const result = parseResult(remote.data);
  if (previous.accountHash) {
    const currentAccount = await instagramAccount(provider, connection.id, context);
    if (!currentAccount || previous.accountHash !== instagramAccountHash(currentAccount.id))
      return { status: "missing" };
  }
  // Concurrent recovery can confirm once, but cannot replace an already confirmed result.
  await prisma.instagramSend.updateMany({
    where: { id: previous.id, requestHash: query.requestHash, externalId: null },
    data: { externalId: receiptId(result), result },
  });
  const current = await prisma.instagramSend.findUniqueOrThrow({
    where: { id: previous.id },
  });
  return { status: "confirmed", data: parseResult(current.result) };
}

/** Persist before dispatch, including before a gateway request that can lose its response.
 * Receipts contain IDs and request digests, never message text or credentials. They survive
 * connection/run deletion so reconnecting cannot turn a generated reply into a voice example.
 */
export async function* executeWithInstagramReceipt(
  prisma: Pick<PrismaClient, "instagramSend">,
  provider: ManagedConnectorProvider,
  call: ConnectorCall,
  context: AdapterContext,
): AsyncIterable<ConnectorEvent> {
  const action = call.route?.toolName;
  if (!isInstagramSend(action)) {
    yield* provider.execute(call, context);
    return;
  }
  const resolved = await provider.resolveCall?.(call, context);
  const route = resolved?.call.route;
  const connection = context.connectedConnections?.find((row) => row.id === route?.resourceId);
  if (
    !resolved ||
    !route ||
    route.connectorId !== "open-connector" ||
    route.toolName !== action ||
    route.resourceId !== call.route?.resourceId ||
    connection?.externalId !== "instagram" ||
    !connection.providerRef
  )
    throw new Error("Instagram send action is unavailable");
  assertConnectorActionAllowed(context, route);
  context.signal.throwIfAborted();
  const account = await instagramAccount(provider, connection.id, context);
  if (!account) throw new Error("Verified Instagram account identity is required");
  if (call.expectedAccountId !== undefined && call.expectedAccountId !== account?.id)
    throw new Error("The linked provider account changed");
  const accountHash = instagramAccountHash(account.id);
  const dispatch = { ...resolved.call, expectedAccountId: account.id };
  const target = id.parse(resolved.call.args[targetFields[action]]);
  const parseResult = (value: unknown) => parseInstagramResult(action, target, value);
  const requestHash = hash(
    stableJsonValue([connection.id, connection.providerRef, action, resolved.call.args]),
  );
  const key = { spaceId: context.spaceId, executionKey: hash(call.executionId) };
  const recovery = {
    bindingHash: instagramBindingHash(connection.providerRef),
    action,
    targetId: target,
  };
  // The unique key arbitrates concurrent dispatchers without holding a transaction over I/O.
  const inserted = await prisma.instagramSend.createMany({
    data: { ...key, requestHash, ...recovery, accountHash },
    skipDuplicates: true,
  });
  if (!inserted.count) {
    const previous = await prisma.instagramSend.findUniqueOrThrow({
      where: { spaceId_executionKey: key },
    });
    if (previous.accountHash && previous.accountHash !== accountHash)
      throw new Error("The linked provider account changed");
    if (previous.requestHash !== requestHash)
      throw new Error("Instagram send execution does not match its original request");
    if (previous.result) {
      yield { type: "result", data: parseResult(previous.result) };
      return;
    }
    // Old records can recover their missing routing metadata only from the exact original request.
    await prisma.instagramSend.updateMany({
      where: { id: previous.id, bindingHash: null },
      data: recovery,
    });
    const receipt = await readInstagramReceipt(
      prisma,
      provider,
      { executionKey: key.executionKey, requestHash, connectionId: connection.id, action },
      context,
    );
    if (receipt.status !== "confirmed")
      throw new Error(
        "Instagram send outcome is uncertain. Inspect and reconcile the send before retrying.",
      );
    yield { type: "result", data: parseResult(receipt.data) };
    return;
  }
  // Buffer the terminal result until it is durable. A thrown, aborted, malformed or missing
  // result leaves an uncertain receipt; upstream idempotency keys are not permanent receipts.
  let result: z.infer<(typeof resultSchemas)[typeof action]> | undefined;
  for await (const event of provider.execute(dispatch, context)) {
    if (event.type === "error") {
      // Only this invocation's new claim can be released by an explicit predispatch proof.
      // Transport failures and pre-existing uncertain receipts never enter this path.
      if (!result && account && event.dispatch === "not_started")
        await prisma.instagramSend.deleteMany({
          where: {
            ...key,
            requestHash,
            accountHash,
            externalId: null,
            result: { equals: Prisma.DbNull },
          },
        });
      yield event;
      return;
    }
    if (event.type === "result") {
      if (result) throw new Error("Instagram send returned multiple results");
      result = parseResult(event.data);
    } else yield event;
  }
  if (!result) throw new Error("Instagram send did not confirm completion");
  await prisma.instagramSend.update({
    where: { spaceId_executionKey: key },
    data: { externalId: receiptId(result), result },
  });
  yield { type: "result", data: result };
}

/** Preserve provider methods and instanceof checks; only dispatch adds local receipts. */
export function withInstagramReceipts(
  prisma: Pick<PrismaClient, "instagramSend">,
  provider: ManagedConnectorProvider,
): ManagedConnectorProvider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === "execute")
        return (call: ConnectorCall, context: AdapterContext) =>
          executeWithInstagramReceipt(prisma, target, call, context);
      if (property === "receipt")
        return (query: ConnectorReceiptQuery, context: AdapterContext) =>
          readInstagramReceipt(prisma, target, query, context);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
