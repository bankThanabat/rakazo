import type {
  CustomerCheckoutExecute,
  CustomerCheckoutProvider,
  CustomerCheckoutState,
} from "@rakazo/adapter-kit";
import { CustomerCheckoutReviewRequired } from "@rakazo/adapter-kit";
import {
  CustomerPurchaseAddress,
  CustomerPurchaseQuote,
  CustomerPurchaseSummary,
} from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const envelope = z.object({
  cartToken: z.string().min(1).max(8192),
  cart: object.optional(),
  checkout: object.optional(),
});
const addressKeys: Record<string, string> = {
  firstName: "first_name",
  lastName: "last_name",
  address1: "address_1",
  address2: "address_2",
};
const address = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).map(([key, value]) => [addressKeys[key] ?? key, value]));

function readAddress(raw: unknown) {
  const fields = object.parse(raw);
  return CustomerPurchaseQuote.shape.billing.parse(
    Object.fromEntries(
      Object.keys(CustomerPurchaseAddress.shape)
        .map((key) => [key, fields[addressKeys[key] ?? key]])
        .filter(([, value]) => value !== undefined),
    ),
  );
}

/** Only this adapter understands WooCommerce paths and status meanings. */
export function wooCommerceCheckout(execute: CustomerCheckoutExecute): CustomerCheckoutProvider {
  const action = (name: string, input: Record<string, unknown>) =>
    execute(`woocommerce.${name}`, input, name === "get_order" ? "read" : "write");
  function cart(raw: unknown): CustomerCheckoutState {
    const result = envelope.parse(raw);
    const data = object.parse(result.cart);
    const totals = object.parse(data.totals);
    return {
      capability: result.cartToken,
      privateData: data,
      billing: readAddress(data.billing_address),
      shipping: readAddress(data.shipping_address),
      summary: CustomerPurchaseSummary.parse({
        items: z
          .array(object)
          .parse(data.items)
          .map((item) => ({
            key: item.key,
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            variation: item.variation ?? [],
          })),
        currency: totals.currency_code,
        minorUnit: totals.currency_minor_unit,
        total: totals.total_price,
        needsShipping: data.needs_shipping,
        needsPayment: data.needs_payment,
        coupons: z
          .array(object)
          .parse(data.coupons)
          .map((coupon) => coupon.code),
        shippingRates: z
          .array(object)
          .parse(data.shipping_rates)
          .flatMap((pack) =>
            z
              .array(object)
              .parse(pack.shipping_rates)
              .map((rate) => ({
                packageId: pack.package_id,
                id: rate.rate_id,
                name: rate.name,
                price: rate.price,
                selected: rate.selected,
              })),
          ),
      }),
    };
  }
  return {
    paymentMethodLabels: { bacs: "Bank transfer", cod: "Cash on delivery", cheque: "Cheque" },
    actions: [
      { action: "woocommerce.get_order", effect: "read" },
      ...[
        "create_cart",
        "get_cart",
        "add_cart_item",
        "update_cart_item",
        "remove_cart_item",
        "apply_cart_coupon",
        "remove_cart_coupon",
        "update_cart_customer",
        "select_cart_shipping_rate",
        "submit_checkout",
      ].map((name) => ({ action: `woocommerce.${name}`, effect: "write" as const })),
    ],
    async create() {
      return cart(await action("create_cart", {}));
    },
    async update(state, change) {
      const input: Record<string, unknown> = { cartToken: state.capability };
      let name: string;
      switch (change.kind) {
        case "add":
          name = "add_cart_item";
          Object.assign(input, {
            productId: change.productId,
            quantity: change.quantity,
            ...(change.variation ? { variation: change.variation } : {}),
          });
          break;
        case "quantity":
        case "remove":
          if (!state.summary.items.some((item) => item.key === change.key))
            throw new Error("Select an item in this cart");
          name = change.kind === "quantity" ? "update_cart_item" : "remove_cart_item";
          Object.assign(input, {
            key: change.key,
            ...(change.kind === "quantity" ? { quantity: change.quantity } : {}),
          });
          break;
        case "coupon":
          name = change.remove ? "remove_cart_coupon" : "apply_cart_coupon";
          input.code = change.code;
          break;
        case "address":
          name = "update_cart_customer";
          Object.assign(input, {
            billingAddress: address(change.billing),
            shippingAddress: address(change.shipping),
          });
          break;
        case "shipping":
          if (
            !state.summary.shippingRates.some(
              (rate) => rate.packageId === change.packageId && rate.id === change.rateId,
            )
          )
            throw new Error("Select an available rate for this cart");
          name = "select_cart_shipping_rate";
          Object.assign(input, { packageId: change.packageId, rateId: change.rateId });
          break;
      }
      return cart(await action(name, input));
    },
    async submit(state, paymentMethod) {
      if (!state.checkoutAttempt || state.checkoutAttempt.paymentMethod !== paymentMethod)
        throw new Error("A durable checkout reference is required");
      if (!state.summary.items.length || state.summary.order)
        throw new Error("This cart cannot be submitted");
      // Re-read current totals and availability before submission; persist no synthetic price.
      const fresh = cart(await action("get_cart", { cartToken: state.capability }));
      if (stableJsonValue(fresh.privateData) !== stableJsonValue(state.privateData))
        throw new CustomerCheckoutReviewRequired(fresh);
      const result = envelope.parse(
        await action("submit_checkout", {
          cartToken: fresh.capability,
          paymentMethod,
          expectedTotal: fresh.summary.total,
          customerNote: `Deskazo purchase ${state.checkoutAttempt.reference}`,
          billingAddress: object.parse(fresh.privateData.billing_address),
          shippingAddress: object.parse(fresh.privateData.shipping_address),
        }),
      );
      const checkout = z
        .object({ order_id: z.number().int().positive(), status: z.string().min(1).max(100) })
        .parse(result.checkout);
      return {
        checkoutAttempt: state.checkoutAttempt,
        capability: result.cartToken,
        billing: fresh.billing,
        shipping: fresh.shipping,
        privateData: { ...fresh.privateData, checkout: result.checkout },
        summary: {
          ...fresh.summary,
          order: {
            id: String(checkout.order_id),
            status: checkout.status,
            paymentStatus: "unconfirmed",
          },
        },
      };
    },
    async readOrder(state, orderId) {
      if (!state.checkoutAttempt) throw new Error("This checkout has no recovery reference");
      const id = Number(orderId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid provider order ID");
      const record = object.parse(await action("get_order", { orderId: id }));
      const order = z
        .object({
          id: z.number().int().positive(),
          status: z.string().min(1).max(100),
          customerNote: z.string(),
          currency: z.string(),
          total: z.string(),
          paymentMethod: z.string().max(100).nullable(),
          needsPayment: z.boolean().nullable(),
          datePaidGmt: z.string().nullable(),
          transactionId: z.string().max(500).nullable(),
          billing: object,
          shipping: object,
          lineItems: z
            .array(
              z.object({
                productId: z.number().int().positive(),
                variationId: z.number().int().nonnegative().nullable(),
                quantity: z.number().int().positive(),
              }),
            )
            .min(1)
            .max(100),
        })
        .parse(record);
      const money = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(order.total);
      const digits = state.summary.minorUnit;
      if (!money || order.total.length > 40 || /[1-9]/.test((money[2] ?? "").slice(digits)))
        throw new Error("Provider order amount is invalid");
      const total = (
        BigInt(money[1]!) * 10n ** BigInt(digits) +
        BigInt((money[2] ?? "").slice(0, digits).padEnd(digits, "0") || "0")
      ).toString();
      const quantities = (items: Array<{ id: number; quantity: number }>) => {
        const byId = new Map<number, number>();
        for (const item of items) byId.set(item.id, (byId.get(item.id) ?? 0) + item.quantity);
        return [...byId].sort(([a], [b]) => a - b);
      };
      const comparableAddress = (value: Record<string, unknown>) =>
        Object.fromEntries(
          Object.keys(CustomerPurchaseAddress.shape).map((key) => [key, value[key] ?? ""]),
        );
      if (
        order.id !== id ||
        (state.summary.order && state.summary.order.id !== orderId) ||
        order.customerNote !== `Deskazo purchase ${state.checkoutAttempt.reference}` ||
        ["checkout-draft", "auto-draft", "draft", "trash"].includes(order.status) ||
        order.currency !== state.summary.currency ||
        BigInt(total) > BigInt(state.summary.total) ||
        order.paymentMethod !== state.checkoutAttempt.paymentMethod ||
        stableJsonValue(quantities(state.summary.items)) !==
          stableJsonValue(
            quantities(
              order.lineItems.map((item) => ({
                id: item.variationId || item.productId,
                quantity: item.quantity,
              })),
            ),
          ) ||
        stableJsonValue(comparableAddress(order.billing)) !==
          stableJsonValue(comparableAddress(state.billing)) ||
        stableJsonValue(comparableAddress(order.shipping)) !==
          stableJsonValue(comparableAddress(state.shipping))
      )
        throw new Error("Provider order does not match this checkout reference and approved cart");
      let recordedPaidAt: string | null = null;
      if (order.datePaidGmt !== null) {
        const candidate = new Date(`${order.datePaidGmt}Z`);
        if (
          !Number.isFinite(candidate.getTime()) ||
          candidate.toISOString().slice(0, 19) !== order.datePaidGmt
        )
          throw new Error("Provider payment timestamp is invalid");
        recordedPaidAt = candidate.toISOString();
      }
      return {
        ...state,
        privateData: { ...state.privateData, order: record },
        summary: {
          ...state.summary,
          order: {
            id: orderId,
            status: order.status,
            paymentStatus:
              recordedPaidAt &&
              order.needsPayment === false &&
              ["processing", "completed"].includes(order.status)
                ? "recorded_paid"
                : "unconfirmed",
            observedAt: new Date().toISOString(),
            total,
            currency: order.currency,
            paymentMethod: order.paymentMethod,
            needsPayment: order.needsPayment,
            recordedPaidAt,
            transactionId: order.transactionId,
          },
        },
      };
    },
  };
}
