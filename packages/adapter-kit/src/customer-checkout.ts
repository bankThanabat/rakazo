import type {
  CustomerPurchaseChange,
  CustomerPurchaseQuote,
  CustomerPurchaseSummary,
} from "@rakazo/contracts";

/** Capability/privateData stay encrypted. Selected quote fields are disclosed to staff review. */
export interface CustomerCheckoutState {
  checkoutAttempt?: { reference: string; paymentMethod: string };
  capability: string;
  privateData: Record<string, unknown>;
  summary: CustomerPurchaseSummary;
  billing: CustomerPurchaseQuote["billing"];
  shipping: CustomerPurchaseQuote["shipping"];
}

export type CustomerCheckoutExecute = (
  action: string,
  input: Record<string, unknown>,
  effect: "read" | "write",
) => Promise<unknown>;

/** Store semantics belong in adapters. The caller owns approval, ownership and durable dispatch. */
export interface CustomerCheckoutProvider {
  paymentMethodLabels?: Readonly<Record<string, string>>;
  actions: Array<{ action: string; effect: "read" | "write" }>;
  create(): Promise<CustomerCheckoutState>;
  update(
    state: CustomerCheckoutState,
    change: CustomerPurchaseChange,
  ): Promise<CustomerCheckoutState>;
  submit(state: CustomerCheckoutState, paymentMethod: string): Promise<CustomerCheckoutState>;
  readOrder(state: CustomerCheckoutState, orderId: string): Promise<CustomerCheckoutState>;
}

/** The provider returned a changed quote before order submission. Ask for a new approval. */
export class CustomerCheckoutReviewRequired extends Error {
  constructor(public readonly state: CustomerCheckoutState) {
    super("The cart changed. Review the current quote before checkout.");
  }
}
