import { z } from "zod";
import { Id } from "./ids.js";

/** Fits the complete checkout input in the staff approval detail. */
export const CUSTOMER_PURCHASE_APPROVAL_MAX_LENGTH = 3500;

const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(30);
export const CustomerPurchaseAddress = z
  .object({
    firstName: z.string().max(500),
    lastName: z.string().max(500),
    company: z.string().max(500).default(""),
    address1: z.string().max(500),
    address2: z.string().max(500).default(""),
    city: z.string().max(500),
    state: z.string().max(500),
    postcode: z.string().max(500),
    country: z.string().regex(/^[A-Z]{2}$/),
    email: z.string().email().max(500),
    phone: z.string().max(500),
  })
  .strict();
export const CustomerPurchaseChange = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add"),
      productId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      quantity: z.number().int().min(1).max(10000),
      variation: z
        .array(
          z
            .object({ attribute: z.string().min(1).max(500), value: z.string().min(1).max(500) })
            .strict(),
        )
        .max(20)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("quantity"),
      key: z.string().min(1).max(500),
      quantity: z.number().int().min(1).max(10000),
    })
    .strict(),
  z.object({ kind: z.literal("remove"), key: z.string().min(1).max(500) }).strict(),
  z
    .object({
      kind: z.literal("coupon"),
      code: z.string().min(1).max(500),
      remove: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("address"),
      billing: CustomerPurchaseAddress,
      shipping: CustomerPurchaseAddress,
    })
    .strict(),
  z
    .object({
      kind: z.literal("shipping"),
      packageId: z.number().int().min(0),
      rateId: z.string().min(1).max(500),
    })
    .strict(),
]);
export type CustomerPurchaseChange = z.infer<typeof CustomerPurchaseChange>;
export const CustomerPurchaseSummary = z
  .object({
    items: z
      .array(
        z.object({
          key: z.string().max(500),
          id: z.number().int().positive(),
          name: z.string().max(1000),
          quantity: z.number().int().min(1),
          variation: z
            .array(
              z.object({ attribute: z.string().max(500), value: z.string().max(500) }).strict(),
            )
            .max(20)
            .default([]),
        }),
      )
      .max(100),
    currency: z.string().regex(/^[A-Z]{3}$/),
    minorUnit: z.number().int().min(0).max(6),
    total: amount,
    needsShipping: z.boolean(),
    needsPayment: z.boolean(),
    coupons: z.array(z.string().max(500)).max(100),
    shippingRates: z
      .array(
        z.object({
          packageId: z.number().int().min(0),
          id: z.string().max(500),
          name: z.string().max(1000),
          price: amount,
          selected: z.boolean(),
        }),
      )
      .max(100),
    order: z
      .object({
        id: z.string().min(1).max(500),
        status: z.string().max(100),
        paymentStatus: z.enum(["unconfirmed", "recorded_paid"]),
        observedAt: z.string().datetime().optional(),
        total: amount.optional(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        paymentMethod: z.string().max(100).nullable().optional(),
        needsPayment: z.boolean().nullable().optional(),
        recordedPaidAt: z.string().max(100).nullable().optional(),
        transactionId: z.string().max(500).nullable().optional(),
      })
      .optional(),
  })
  .strict();
export type CustomerPurchaseSummary = z.infer<typeof CustomerPurchaseSummary>;
export const CustomerPurchaseQuote = z
  .object({
    summary: CustomerPurchaseSummary,
    billing: CustomerPurchaseAddress.extend({
      email: z.string().max(500),
      country: z.string().max(2),
    }).partial(),
    shipping: CustomerPurchaseAddress.extend({
      email: z.string().max(500),
      country: z.string().max(2),
    }).partial(),
  })
  .strict();
export type CustomerPurchaseQuote = z.infer<typeof CustomerPurchaseQuote>;
export const CustomerPurchaseQuoteInput = z.object({ id: Id }).strict();
export const CustomerPurchaseStartInput = z
  .object({
    conversationId: Id,
    customerId: z.string().min(1).max(500),
    connectionId: Id,
    nonce: z.string().uuid(),
    paymentMethods: z.array(z.string().min(1).max(100)).min(1).max(10),
  })
  .strict();
export const CustomerPurchaseInspectInput = z
  .object({ conversationId: Id, cursor: Id.optional() })
  .strict();
export const CustomerPurchaseUpdateInput = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    change: CustomerPurchaseChange,
  })
  .strict();
export const CustomerPurchaseCheckoutInput = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    quote: CustomerPurchaseQuote,
    paymentMethod: z.string().min(1).max(100),
  })
  .strict()
  .refine(
    (input) => JSON.stringify(input, null, 2).length <= CUSTOMER_PURCHASE_APPROVAL_MAX_LENGTH,
    "The complete checkout quote is too large for staff approval; use the merchant checkout",
  );

export const CustomerPurchaseCloseInput = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const CustomerPurchaseReconcileInput = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    orderId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(16),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** The website session proves control of this conversation, not a merchant identity. */
export const CustomerPurchaseReview = z
  .object({
    id: z.string().uuid(),
    purchaseId: Id,
    paymentMethodLabel: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    quote: CustomerPurchaseQuote,
    paymentMethod: z.string().min(1).max(100),
    expiresAt: z.string().datetime(),
    decision: z.enum(["confirmed", "changes_requested"]).nullable(),
  })
  .strict();
export type CustomerPurchaseReview = z.infer<typeof CustomerPurchaseReview>;
export const CustomerPurchaseDecisionInput = z
  .object({
    purchaseId: Id,
    reviewId: z.string().uuid(),
    decision: z.enum(["confirmed", "changes_requested"]),
  })
  .strict();
