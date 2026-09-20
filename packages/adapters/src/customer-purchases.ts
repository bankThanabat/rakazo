import { createHash, randomUUID } from "node:crypto";
import type {
  CustomerCheckoutExecute,
  CustomerCheckoutProvider,
  CustomerCheckoutState,
} from "@rakazo/adapter-kit";
import { CustomerCheckoutReviewRequired } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  CustomerPurchaseCheckoutInput,
  CustomerPurchaseCloseInput,
  CustomerPurchaseDecisionInput,
  CustomerPurchaseInspectInput,
  CustomerPurchaseQuote,
  CustomerPurchaseQuoteInput,
  CustomerPurchaseReconcileInput,
  CustomerPurchaseReview,
  CustomerPurchaseStartInput,
  CustomerPurchaseSummary,
  CustomerPurchaseUpdateInput,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { CustomerPurchase, Prisma, PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  invalidateCustomerConversations,
  purchaseDispatchMs,
  purchaseRecoveryMs,
  startCustomerAttention,
} from "@rakazo/db";
import { z } from "zod";
import type { createCustomerConnector } from "./customer-connector.js";
import type { EncryptedSecretStore } from "./secrets.js";

type Caller = Pick<Actor, "userId" | "spaceId">;
type Scope = { conversationId: string; customerId: string; connectionId: string };
const digest = (value: unknown) =>
  createHash("sha256").update(stableJsonValue(value)).digest("hex");
const privateState = z.object({
  review: z
    .object({
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      quoteHash: z.string(),
      paymentMethod: z.string(),
      paymentMethodLabel: z.string(),
      expiresAt: z.string().datetime(),
      decision: z.enum(["confirmed", "changes_requested"]).nullable(),
      sessionHash: z.string().optional(),
    })
    .strict()
    .optional(),
  checkoutAttempt: z
    .object({ reference: z.string().min(1).max(500), paymentMethod: z.string().min(1).max(100) })
    .strict()
    .optional(),
  capability: z.string().min(1).max(8192),
  privateData: z.record(z.string(), z.unknown()),
  summary: CustomerPurchaseSummary,
  billing: CustomerPurchaseQuote.shape.billing,
  shipping: CustomerPurchaseQuote.shape.shipping,
});
const view = (row: CustomerPurchase) => ({
  id: row.id,
  conversationId: row.conversationId,
  customerId: row.customerId,
  connectionId: row.connectionId,
  revision: row.revision,
  status: row.status,
  summary: row.summary,
  history: row.history,
  paymentMethods: row.paymentMethods,
  actionKind: row.actionKind,
  actionStartedAt: row.actionStartedAt,
});

/** Staff approvals and authenticated website confirmation share backend-owned purchase state. */
export function createCustomerPurchases(deps: {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  connector: ReturnType<typeof createCustomerConnector>;
  provider: (name: string, execute: CustomerCheckoutExecute) => CustomerCheckoutProvider;
}) {
  const { prisma } = deps;
  const caseWhere = (actor: Caller, botId: string) => ({
    channel: { userId: actor.userId, spaceId: actor.spaceId, botId, bot: { archivedAt: null } },
  });
  async function lock(
    tx: Prisma.TransactionClient,
    actor: Caller,
    botId: string,
    scope: Scope,
    providerRef: string,
    recovery = false,
  ) {
    const account = await tx.connection.findUniqueOrThrow({
      where: { id: scope.connectionId },
      select: { userId: true },
    });
    const userIds = [...new Set([actor.userId, account.userId])].sort();
    for (const userId of userIds) {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "user" WHERE id = ${userId} FOR SHARE SKIP LOCKED`;
      if (!users.length) throw new IsolationError();
    }
    if (await tx.accountDeletion.count({ where: { userId: { in: userIds } } }))
      throw new IsolationError();
    const rows = await tx.$queryRaw<Array<{ generation: number; leaseUntil: Date | null }>>`
      SELECT conversation.generation, conversation."leaseUntil" FROM customer_conversations conversation
      JOIN customer_channels channel ON channel.id = conversation."channelId"
      JOIN bots bot ON bot.id = channel."botId"
      JOIN space_members member ON member."spaceId" = channel."spaceId" AND member."userId" = ${actor.userId}
      JOIN connections account ON account.id = ${scope.connectionId}
      WHERE conversation.id = ${scope.conversationId} AND channel."userId" = ${actor.userId}
        AND channel."spaceId" = ${actor.spaceId} AND channel."botId" = ${botId}
        AND bot."archivedAt" IS NULL AND (${recovery} OR (channel.enabled AND conversation.state <> 'resolved'))
        AND account."spaceId" = ${actor.spaceId} AND (account."userId" = ${actor.userId} OR account.scope = 'team')
        AND account."userId" = ${account.userId}
        AND account.status = 'connected' AND account."connectorId" = 'open-connector' AND account."providerRef" = ${providerRef}
        AND EXISTS (SELECT 1 FROM customer_messages message WHERE message."conversationId" = conversation.id
          AND message.role = 'customer' AND message."senderId" = ${scope.customerId})
      FOR UPDATE OF conversation FOR SHARE OF account, channel, member, bot`;
    if (!rows.length) throw new IsolationError();
    // A previous customer action might already be dispatched; do not overlap it.
    if (rows[0]!.leaseUntil && rows[0]!.leaseUntil > new Date())
      throw new Error("Customer work is still in flight; wait before managing this purchase");
    return rows[0]!;
  }
  async function owned(actor: Caller, botId: string, id: string) {
    if (
      !(await prisma.spaceMember.count({ where: { userId: actor.userId, spaceId: actor.spaceId } }))
    )
      throw new IsolationError();
    const row = await prisma.customerPurchase.findFirst({
      where: { id, conversation: caseWhere(actor, botId) },
    });
    if (!row) throw new IsolationError();
    return row;
  }
  function read(row: CustomerPurchase) {
    if (!row.ciphertext) throw new Error("Purchase state unavailable");
    return privateState.parse(
      JSON.parse(deps.secrets.load(row.ciphertext, `customer-purchase:${row.id}`)),
    );
  }
  function quote(state: CustomerCheckoutState) {
    return CustomerPurchaseQuote.parse({
      summary: state.summary,
      billing: state.billing,
      shipping: state.shipping,
    });
  }
  function reviewView(row: CustomerPurchase, state: z.infer<typeof privateState>) {
    const review = state.review;
    if (!review || review.revision !== row.revision || review.expiresAt <= new Date().toISOString())
      return null;
    return CustomerPurchaseReview.parse({
      id: review.id,
      purchaseId: row.id,
      revision: row.revision,
      quote: quote(state),
      paymentMethod: review.paymentMethod,
      paymentMethodLabel: review.paymentMethodLabel,
      expiresAt: review.expiresAt,
      decision: review.decision,
    });
  }
  async function visitor(tx: Prisma.TransactionClient, tokenHash: string) {
    const sessions = await tx.$queryRaw<Array<{ conversationId: string }>>`
      SELECT "conversationId" FROM customer_visitor_sessions WHERE "tokenHash" = ${tokenHash}
        AND "expiresAt" > NOW() FOR SHARE`;
    if (!sessions[0]) throw new IsolationError();
    const conversation = await tx.customerConversation.findUniqueOrThrow({
      where: { id: sessions[0].conversationId },
      include: { channel: true },
    });
    const session = await tx.customerVisitorSession.findUniqueOrThrow({ where: { tokenHash } });
    if (
      conversation.channel.provider !== "web" ||
      !conversation.channel.websiteOrigins.includes(session.origin)
    )
      throw new IsolationError();
    return conversation;
  }
  function seal(state: CustomerCheckoutState, id: string) {
    const checked = privateState.parse(state);
    const plaintext = JSON.stringify(checked);
    if (plaintext.length > 2 * 1024 * 1024) throw new Error("Purchase state is too large");
    return { checked, ciphertext: deps.secrets.seal(plaintext, `customer-purchase:${id}`) };
  }
  async function dispatch(
    actor: Caller,
    botId: string,
    row: CustomerPurchase,
    generation: number,
    run: (provider: CustomerCheckoutProvider) => Promise<CustomerCheckoutState>,
  ) {
    let attempted = false;
    let recorded = false;
    const authorize = async () => {
      const consent = row.actionKind === "checkout" ? read(row).review : undefined;
      if (consent) {
        if (consent.expiresAt <= new Date().toISOString() || !consent.sessionHash)
          throw new IsolationError();
        const session = await prisma.customerVisitorSession.findUnique({
          where: { tokenHash: consent.sessionHash },
          include: { conversation: { include: { channel: true } } },
        });
        if (
          !session ||
          session.expiresAt <= new Date() ||
          session.conversationId !== row.conversationId ||
          !session.conversation.channel.websiteOrigins.includes(session.origin)
        )
          throw new IsolationError();
      }
      if (
        !(await prisma.customerConversation.count({
          where: {
            id: row.conversationId,
            ...caseWhere(actor, botId),
            generation,
            owner: "staff",
            state: { not: "resolved" },
            channel: { ...caseWhere(actor, botId).channel, enabled: true },
          },
        }))
      )
        throw new IsolationError();
      const account = await deps.connector.connection(actor, row.connectionId);
      if (
        account.providerRef !== row.providerRef ||
        (await prisma.accountDeletion.count({
          where: { userId: { in: [actor.userId, account.userId] } },
        }))
      )
        throw new IsolationError();
      return account;
    };
    async function finish(
      state: CustomerCheckoutState,
      status: "open" | "submitted",
      result: string,
    ) {
      const { checked, ciphertext } = seal(state, row.id);
      const history = z.array(z.json()).parse(row.history);
      const committed = await prisma.customerPurchase.updateMany({
        where: { id: row.id, actionId: row.actionId, revision: row.revision, status: row.status },
        data: {
          ciphertext,
          summary: checked.summary,
          providerOrderId: checked.summary.order?.id ?? null,
          status,
          activeKey: status === "submitted" ? null : row.activeKey,
          actionId: null,
          actionHash: null,
          actionKind: null,
          actionStartedAt: null,
          history: [
            ...history,
            {
              id: row.actionId,
              kind: row.actionKind,
              inputHash: row.actionHash,
              revision: row.revision,
              result,
              userId: actor.userId,
              at: new Date().toISOString(),
            },
          ],
        },
      });
      if (!committed.count) throw new Error("Purchase changed during dispatch");
      recorded = true;
      // Keep confirmed provider results for reconciliation even if access changed in flight.
      await authorize();
      return view(await prisma.customerPurchase.findUniqueOrThrow({ where: { id: row.id } }));
    }
    try {
      // The reservation is durable before dispatch. A suspended process must not
      // start another provider call after account cleanup's recovery window.
      const deadline = (row.actionStartedAt?.getTime() ?? 0) + purchaseDispatchMs;
      const remaining = Math.min(purchaseDispatchMs, deadline - Date.now());
      if (remaining <= 0) throw new Error("Purchase dispatch expired");
      const signal = AbortSignal.timeout(remaining);
      const account = await authorize();
      const provider = deps.provider(account.provider, async (action, input, effect) => {
        await authorize();
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("Purchase dispatch expired");
        // Bypass model tool/result history; only the encrypted purchase state receives capabilities.
        attempted = true;
        return deps.connector.execute(
          actor,
          row.connectionId,
          action,
          input,
          `customer.purchase:${row.id}:${row.actionId}:${action}`,
          "staff",
          effect,
          row.providerRef,
          signal,
        );
      });
      let state: CustomerCheckoutState;
      let result = "confirmed";
      try {
        state = await run(provider);
      } catch (error) {
        if (!(error instanceof CustomerCheckoutReviewRequired)) throw error;
        state = error.state;
        result = "review_required";
      }
      return await finish(
        state,
        row.actionKind === "checkout" && result === "confirmed" ? "submitted" : "open",
        result,
      );
    } catch {
      if (recorded)
        throw new Error(
          "Provider result was recorded, but conversation or access changed. Inspect the purchase before continuing.",
        );
      if (!attempted) {
        await prisma.customerPurchase.updateMany({
          where: { id: row.id, actionId: row.actionId, revision: row.revision },
          data: {
            status: row.actionKind === "create" ? "closed" : "open",
            activeKey: row.actionKind === "create" ? null : row.activeKey,
            actionId: null,
            actionHash: null,
            actionKind: null,
            actionStartedAt: null,
            history: [
              ...z.array(z.json()).parse(row.history),
              {
                id: row.actionId,
                kind: row.actionKind,
                revision: row.revision,
                result: "not_dispatched",
                inputHash: row.actionHash,
                userId: actor.userId,
                at: new Date().toISOString(),
              },
            ],
          },
        });
        throw new Error(
          "Purchase was not dispatched. Review the cart and request before continuing.",
        );
      }
      await prisma.customerPurchase.updateMany({
        where: { id: row.id, actionId: row.actionId, revision: row.revision },
        data: { status: "uncertain" },
      });
      throw new Error(
        "Purchase outcome is uncertain. Inspect the purchase and provider before continuing; do not repeat the request.",
      );
    }
  }
  return {
    async status(actor: Caller, botId: string, raw: unknown) {
      return observe(actor, botId, CustomerPurchaseQuoteInput.parse(raw).id);
    },
    async reconcile(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerPurchaseReconcileInput.parse(raw);
      return observe(actor, botId, input.id, input);
    },
    async inspect(actor: Caller, botId: string, raw: unknown) {
      const { conversationId, cursor } = CustomerPurchaseInspectInput.parse(raw);
      if (
        !(await prisma.spaceMember.count({
          where: { userId: actor.userId, spaceId: actor.spaceId },
        })) ||
        !(await prisma.customerConversation.count({
          where: { id: conversationId, ...caseWhere(actor, botId) },
        }))
      )
        throw new IsolationError();
      if (
        cursor &&
        !(await prisma.customerPurchase.count({ where: { id: cursor, conversationId } }))
      )
        throw new IsolationError();
      const rows = await prisma.customerPurchase.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: 101,
      });
      return {
        purchases: rows.slice(0, 100).map(view),
        nextCursor: rows.length > 100 ? rows[99]!.id : null,
      };
    },
    async quote(actor: Caller, botId: string, raw: unknown) {
      const row = await owned(actor, botId, CustomerPurchaseQuoteInput.parse(raw).id);
      if (!row.ciphertext || row.status !== "open")
        throw new Error("This purchase has no current quote available for checkout");
      const account = await deps.connector.connection(actor, row.connectionId);
      if (account.providerRef !== row.providerRef) throw new IsolationError();
      const state = privateState.parse(
        JSON.parse(deps.secrets.load(row.ciphertext, `customer-purchase:${row.id}`)),
      );
      return {
        id: row.id,
        expectedRevision: row.revision,
        quote: CustomerPurchaseQuote.parse({
          summary: state.summary,
          billing: state.billing,
          shipping: state.shipping,
        }),
        paymentMethods: row.paymentMethods,
        review: state.review
          ? {
              id: state.review.id,
              decision: state.review.decision,
              expiresAt: state.review.expiresAt,
            }
          : null,
      };
    },
    async requestReview(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerPurchaseCheckoutInput.parse(raw);
      const original = await owned(actor, botId, input.id);
      return prisma.$transaction(async (tx) => {
        await lock(tx, actor, botId, original, original.providerRef);
        const channel = await tx.customerConversation.findUniqueOrThrow({
          where: { id: original.conversationId },
          include: { channel: true },
        });
        if (channel.channel.provider !== "web" || channel.customerId !== original.customerId)
          throw new Error("Shopper review is available in the participant's website conversation");
        const row = await tx.customerPurchase.findUniqueOrThrow({ where: { id: input.id } });
        const state = read(row);
        if (
          row.status !== "open" ||
          row.revision !== input.expectedRevision ||
          digest(quote(state)) !== digest(input.quote) ||
          !z.array(z.string()).parse(row.paymentMethods).includes(input.paymentMethod)
        )
          throw new Error("Purchase changed; review its current quote");
        const quoteHash = digest({ quote: input.quote, paymentMethod: input.paymentMethod });
        if (state.review?.quoteHash === quoteHash && reviewView(row, state))
          return {
            id: state.review.id,
            decision: state.review.decision,
            expiresAt: state.review.expiresAt,
          };
        const history = z.array(z.json()).parse(row.history);
        if (history.length >= 98)
          throw new Error("Purchase review limit reached; use staff handling");
        const account = await tx.connection.findUniqueOrThrow({ where: { id: row.connectionId } });
        const provider = deps.provider(account.provider, async () => {
          throw new Error("Not dispatched");
        });
        const paymentMethodLabel = provider.paymentMethodLabels?.[input.paymentMethod];
        if (!paymentMethodLabel)
          throw new Error(
            "This payment method needs merchant checkout; no shopper-facing description is available",
          );
        state.review = {
          paymentMethodLabel,
          id: randomUUID(),
          revision: row.revision,
          quoteHash,
          paymentMethod: input.paymentMethod,
          expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
          decision: null,
        };
        await tx.customerPurchase.update({
          where: { id: row.id },
          data: {
            ciphertext: seal(state, row.id).ciphertext,
            history: [
              ...history,
              {
                kind: "review_requested",
                reviewId: state.review.id,
                quoteHash,
                revision: row.revision,
                userId: actor.userId,
                at: new Date().toISOString(),
              },
            ],
          },
        });
        return { id: state.review.id, decision: null, expiresAt: state.review.expiresAt };
      });
    },
    async visitorReviews(tokenHash: string) {
      return prisma.$transaction(async (tx) => {
        const conversation = await visitor(tx, tokenHash);
        const rows = await tx.customerPurchase.findMany({
          where: {
            conversationId: conversation.id,
            customerId: conversation.customerId,
            status: "open",
            ciphertext: { not: null },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        const reviews = [];
        for (const row of rows) {
          try {
            await lock(tx, conversation.channel, conversation.channel.botId, row, row.providerRef);
          } catch (error) {
            if (error instanceof IsolationError) continue;
            throw error;
          }
          // A cart edit may have committed while the conversation lock was held elsewhere.
          const current = await tx.customerPurchase.findUnique({ where: { id: row.id } });
          if (current?.status !== "open" || !current.ciphertext) continue;
          const review = reviewView(current, read(current));
          if (review) reviews.push(review);
        }
        return reviews;
      });
    },
    async decideReview(tokenHash: string, raw: unknown) {
      const input = CustomerPurchaseDecisionInput.parse(raw);
      return prisma.$transaction(async (tx) => {
        const conversation = await visitor(tx, tokenHash);
        const original = await tx.customerPurchase.findFirstOrThrow({
          where: {
            id: input.purchaseId,
            conversationId: conversation.id,
            customerId: conversation.customerId,
          },
        });
        await lock(
          tx,
          conversation.channel,
          conversation.channel.botId,
          original,
          original.providerRef,
        );
        const row = await tx.customerPurchase.findUniqueOrThrow({ where: { id: original.id } });
        const state = read(row);
        const reviewed = reviewView(row, state);
        if (row.status !== "open" || !reviewed || reviewed.id !== input.reviewId)
          throw new Error("Purchase changed; ask staff for a new review");
        if (state.review!.decision === "changes_requested" && input.decision === "confirmed")
          throw new Error("This review already has a decision; ask staff for a new review");
        if (state.review!.decision !== input.decision) {
          const history = z.array(z.json()).max(99).parse(row.history);
          state.review!.decision = input.decision;
          state.review!.sessionHash = tokenHash;
          await tx.customerPurchase.update({
            where: { id: row.id },
            data: {
              ciphertext: seal(state, row.id).ciphertext,
              history: [
                ...history,
                {
                  kind: "shopper_review",
                  reviewId: input.reviewId,
                  revision: row.revision,
                  customerId: row.customerId,
                  decision: input.decision,
                  at: new Date().toISOString(),
                },
              ],
            },
          });
          await invalidateCustomerConversations(tx, { id: row.conversationId }, "staff");
          await tx.customerConversation.update({
            where: { id: row.conversationId },
            data: {
              ...startCustomerAttention(),
              handoffReason:
                input.decision === "confirmed"
                  ? "Shopper confirmed order details"
                  : "Shopper requested changes to order details",
            },
          });
        }
        return { ...reviewed, decision: input.decision };
      });
    },
    async close(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerPurchaseCloseInput.parse(raw);
      const original = await owned(actor, botId, input.id);
      return prisma.$transaction(async (tx) => {
        const authorized = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT conversation.id FROM customer_conversations conversation
          JOIN customer_channels channel ON channel.id = conversation."channelId"
          JOIN space_members member ON member."spaceId" = channel."spaceId" AND member."userId" = ${actor.userId}
          JOIN bots bot ON bot.id = channel."botId"
          WHERE conversation.id = ${original.conversationId} AND channel."userId" = ${actor.userId}
            AND channel."spaceId" = ${actor.spaceId} AND channel."botId" = ${botId} AND bot."archivedAt" IS NULL
          FOR UPDATE OF conversation FOR SHARE OF member, channel, bot`;
        if (!authorized.length) throw new IsolationError();
        const row = await tx.customerPurchase.findUniqueOrThrow({ where: { id: input.id } });
        if (row.revision !== input.expectedRevision || row.status === "closed")
          throw new Error("Purchase changed; inspect it again");
        if (row.status === "submitted" || row.actionKind === "checkout")
          throw new Error(
            "Inspect the order with the provider; closing cannot resolve an attempted checkout",
          );
        if (row.actionStartedAt && row.actionStartedAt.getTime() > Date.now() - purchaseRecoveryMs)
          throw new Error(
            "The cart request may still be running; inspect again after five minutes",
          );
        const history = z.array(z.json()).max(101).parse(row.history);
        const closed = await tx.customerPurchase.update({
          where: { id: row.id },
          data: {
            status: "closed",
            revision: { increment: 1 },
            activeKey: null,
            ciphertext: null,
            actionId: null,
            actionHash: null,
            actionKind: null,
            actionStartedAt: null,
            history: [
              ...history,
              {
                kind: "close",
                revision: row.revision + 1,
                reason: input.reason,
                userId: actor.userId,
                at: new Date().toISOString(),
                previousStatus: row.status,
                previousAction: {
                  id: row.actionId,
                  kind: row.actionKind,
                  inputHash: row.actionHash,
                  startedAt: row.actionStartedAt?.toISOString() ?? null,
                },
              },
            ],
          },
        });
        await invalidateCustomerConversations(tx, { id: row.conversationId }, "staff");
        return view(closed);
      });
    },
    async start(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerPurchaseStartInput.parse(raw);
      const account = await deps.connector.connection(actor, input.connectionId);
      // Missing provider capabilities fail before reserving a purchase.
      const selected = deps.provider(account.provider, async () => {
        throw new Error("Not dispatched");
      });
      await deps.connector.validateWorkflow(actor, input.connectionId, selected.actions);
      const scope: Scope = input;
      const activeKey = digest([input.conversationId, input.customerId, input.connectionId]);
      const id = digest([activeKey, input.nonce]);
      const requestHash = digest([...new Set(input.paymentMethods)].sort());
      const claimed = await prisma.$transaction(async (tx) => {
        const current = await lock(tx, actor, botId, scope, account.providerRef!);
        const prior = await tx.customerPurchase.findUnique({ where: { id } });
        if (prior) {
          if (prior.requestHash !== requestHash || prior.providerRef !== account.providerRef)
            throw new Error("Purchase request changed; inspect the existing purchase");
          return { row: prior, dispatch: false, generation: current.generation };
        }
        if (await tx.customerPurchase.count({ where: { activeKey } }))
          throw new Error(
            "This participant already has an open or uncertain purchase; inspect it first",
          );
        const row = await tx.customerPurchase.create({
          data: {
            id,
            conversationId: input.conversationId,
            customerId: input.customerId,
            connectionId: input.connectionId,
            providerRef: account.providerRef!,
            activeKey,
            requestHash,
            paymentMethods: input.paymentMethods,
            status: "creating",
            actionId: randomUUID(),
            actionHash: requestHash,
            actionKind: "create",
            actionStartedAt: new Date(),
          },
        });
        await invalidateCustomerConversations(tx, { id: input.conversationId }, "staff");
        return { row, dispatch: true, generation: current.generation + 1 };
      });
      return claimed.dispatch
        ? dispatch(actor, botId, claimed.row, claimed.generation, (provider) => provider.create())
        : view(claimed.row);
    },
    async update(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerPurchaseUpdateInput.parse(raw);
      return change(
        actor,
        botId,
        input.id,
        input.expectedRevision,
        input.change.kind,
        input.change,
        (provider, state) => provider.update(state, input.change),
      );
    },
    async checkout(actor: Caller, botId: string, raw: unknown) {
      const input = CustomerPurchaseCheckoutInput.parse(raw);
      const row = await owned(actor, botId, input.id);
      if (!z.array(z.string()).parse(row.paymentMethods).includes(input.paymentMethod))
        throw new Error("Payment method was not approved for this purchase");
      return change(
        actor,
        botId,
        input.id,
        input.expectedRevision,
        "checkout",
        { paymentMethod: input.paymentMethod, quote: input.quote },
        (provider, state) => {
          const quote = {
            summary: state.summary,
            billing: state.billing,
            shipping: state.shipping,
          };
          if (stableJsonValue(quote) !== stableJsonValue(input.quote))
            throw new Error("Approved quote does not match the purchase");
          return provider.submit(state, input.paymentMethod);
        },
      );
    },
  };
  async function observe(
    actor: Caller,
    botId: string,
    id: string,
    review?: z.infer<typeof CustomerPurchaseReconcileInput>,
  ) {
    const original = await owned(actor, botId, id);
    if (!original.ciphertext) throw new Error("Purchase recovery state is unavailable");
    if (review) {
      if (
        original.revision !== review.expectedRevision ||
        original.actionKind !== "checkout" ||
        !["uncertain", "submitting"].includes(original.status)
      )
        throw new Error("Purchase changed or has no unresolved checkout; inspect it again");
      if (
        original.status === "submitting" &&
        (!original.actionStartedAt ||
          original.actionStartedAt.getTime() > Date.now() - purchaseRecoveryMs)
      )
        throw new Error("Checkout may still be running; inspect again after five minutes");
    } else if (original.status !== "submitted" || !original.providerOrderId) {
      throw new Error(
        "Only a confirmed order can be refreshed; unresolved checkout requires staff reconciliation",
      );
    }
    const orderId = review?.orderId ?? original.providerOrderId!;
    const account = await deps.connector.connection(actor, original.connectionId);
    if (account.providerRef !== original.providerRef) throw new IsolationError();
    const state = privateState.parse(
      JSON.parse(deps.secrets.load(original.ciphertext, `customer-purchase:${id}`)),
    );
    if (state.checkoutAttempt?.reference !== id)
      throw new Error(
        "This checkout predates purchase reference recovery; inspect the merchant directly",
      );
    const provider = deps.provider(account.provider, async (action, input, effect) => {
      if (effect !== "read") throw new Error("Order recovery must use a read-only provider action");
      return deps.connector.execute(
        actor,
        original.connectionId,
        action,
        input,
        `customer.purchase.read:${id}:${randomUUID()}`,
        "staff",
        "read",
        original.providerRef,
      );
    });
    const observed = await provider.readOrder(state, orderId).catch(() => {
      throw new Error(
        "Provider lookup did not confirm this checkout's reference and approved cart. The purchase was not changed or retried.",
      );
    });
    const { checked, ciphertext } = seal(observed, id);
    if (checked.summary.order?.id !== orderId || !checked.summary.order.observedAt)
      throw new Error("Provider did not confirm this order");
    const updated = await prisma.$transaction(async (tx) => {
      await lock(tx, actor, botId, original, original.providerRef, true);
      await tx.$queryRaw`SELECT id FROM customer_purchases WHERE id = ${id} FOR UPDATE`;
      const row = await tx.customerPurchase.findUniqueOrThrow({ where: { id } });
      if (
        row.revision !== original.revision ||
        row.status !== original.status ||
        row.actionId !== original.actionId
      )
        throw new Error("Purchase changed during order lookup; inspect it again");
      const history = z.array(z.json()).parse(row.history);
      if (review && history.length >= 102) throw new Error("Purchase review history limit reached");
      const result = await tx.customerPurchase.update({
        where: { id },
        data: {
          revision: { increment: 1 },
          status: "submitted",
          activeKey: null,
          providerOrderId: orderId,
          ciphertext,
          summary: checked.summary,
          actionId: null,
          actionKind: null,
          actionHash: null,
          actionStartedAt: null,
          ...(review
            ? {
                history: [
                  ...history,
                  {
                    kind: "reconcile",
                    revision: row.revision + 1,
                    userId: actor.userId,
                    reason: review.reason,
                    at: checked.summary.order!.observedAt!,
                    orderId,
                    observation: checked.summary.order!,
                    previousAction: {
                      id: row.actionId,
                      inputHash: row.actionHash,
                      startedAt: row.actionStartedAt?.toISOString() ?? null,
                    },
                  },
                ],
              }
            : {}),
        },
      });
      if (review) await invalidateCustomerConversations(tx, { id: row.conversationId }, "staff");
      return result;
    });
    // The observation is durable even if permissions change before returning it.
    await owned(actor, botId, id);
    if (
      (await deps.connector.connection(actor, original.connectionId)).providerRef !==
      original.providerRef
    )
      throw new IsolationError();
    return view(updated);
  }
  async function change(
    actor: Caller,
    botId: string,
    id: string,
    expectedRevision: number,
    kind: string,
    input: unknown,
    run: (
      provider: CustomerCheckoutProvider,
      state: CustomerCheckoutState,
    ) => Promise<CustomerCheckoutState>,
  ) {
    const original = await owned(actor, botId, id);
    const account = await deps.connector.connection(actor, original.connectionId);
    const selected = deps.provider(account.provider, async () => {
      throw new Error("Not dispatched");
    });
    await deps.connector.validateWorkflow(actor, original.connectionId, selected.actions);
    const claimed = await prisma.$transaction(async (tx) => {
      const current = await lock(tx, actor, botId, original, original.providerRef);
      const row = await tx.customerPurchase.findUniqueOrThrow({ where: { id } });
      if (row.status !== "open" || row.revision !== expectedRevision || !row.ciphertext)
        throw new Error("Purchase changed or is uncertain; inspect it before continuing");
      const history = z.array(z.json()).parse(row.history);
      if (history.length >= (kind === "checkout" ? 101 : 100))
        throw new Error("Purchase change limit reached; use staff handling");
      const state = privateState.parse(
        JSON.parse(deps.secrets.load(row.ciphertext, `customer-purchase:${row.id}`)),
      );
      if (kind === "checkout") {
        const checkout = CustomerPurchaseCheckoutInput.parse({
          id,
          expectedRevision,
          ...z.object({ paymentMethod: z.string(), quote: CustomerPurchaseQuote }).parse(input),
        });
        const conversation = await tx.customerConversation.findUniqueOrThrow({
          where: { id: row.conversationId },
          include: { channel: true },
        });
        if (conversation.channel.provider === "web") {
          const review = state.review;
          if (
            review?.decision !== "confirmed" ||
            !review.sessionHash ||
            review.revision !== row.revision ||
            review.expiresAt <= new Date().toISOString() ||
            review.quoteHash !==
              digest({ quote: checkout.quote, paymentMethod: checkout.paymentMethod })
          )
            throw new Error(
              "The shopper must confirm this exact quote in their website conversation",
            );
          const session = await visitor(tx, review.sessionHash);
          if (session.id !== row.conversationId || session.customerId !== row.customerId)
            throw new IsolationError();
          if (history.length >= 100)
            throw new Error("Purchase change limit reached; use staff handling");
          history.push({
            kind: "shopper_confirmation_used",
            reviewId: review.id,
            quoteHash: review.quoteHash,
            revision: row.revision,
            at: new Date().toISOString(),
          });
        }
        state.checkoutAttempt = { reference: row.id, paymentMethod: checkout.paymentMethod };
      }
      const claimed = await tx.customerPurchase.update({
        where: { id },
        data: {
          revision: { increment: 1 },
          status: kind === "checkout" ? "submitting" : "updating",
          history,
          ...(kind === "checkout" ? { ciphertext: seal(state, row.id).ciphertext } : {}),
          actionId: randomUUID(),
          actionHash: digest(input),
          actionKind: kind,
          actionStartedAt: new Date(),
        },
      });
      await invalidateCustomerConversations(tx, { id: row.conversationId }, "staff");
      return { row: claimed, state, generation: current.generation + 1 };
    });
    return dispatch(actor, botId, claimed.row, claimed.generation, (provider) =>
      run(provider, claimed.state),
    );
  }
}
