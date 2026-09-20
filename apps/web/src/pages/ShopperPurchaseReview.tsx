import { Trans } from "@lingui/react/macro";
import type { CustomerPurchaseReview } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";

import { purchaseAmount } from "../lib/customer-purchase-money";

export function ShopperPurchaseReview({
  review,
  busy,
  onDecide,
}: {
  review: CustomerPurchaseReview;
  busy: boolean;
  onDecide: (decision: "confirmed" | "changes_requested") => void;
}) {
  const { summary, billing, shipping } = review.quote;
  return (
    <section
      aria-labelledby={`review-${review.id}`}
      className="my-4 space-y-4 border-y border-border py-4 text-sm"
    >
      <h2 id={`review-${review.id}`} className="font-medium">
        <Trans>Review order details</Trans>
      </h2>
      <ul className="space-y-2">
        {summary.items.map((item) => (
          <li key={item.key} className="flex items-start justify-between gap-4">
            <span className="min-w-0 break-words">
              {item.name}
              {item.variation.map((variant) => (
                <span key={variant.attribute} className="block text-muted-foreground">
                  {variant.attribute}: {variant.value}
                </span>
              ))}
            </span>
            <span className="shrink-0 tabular-nums">
              <Trans>Qty {item.quantity}</Trans>
            </span>
          </li>
        ))}
      </ul>
      {summary.coupons.length > 0 && (
        <p className="break-words">
          <Trans>Coupons</Trans>: {summary.coupons.join(", ")}
        </p>
      )}
      {summary.shippingRates
        .filter((rate) => rate.selected)
        .map((rate) => (
          <p key={`${rate.packageId}:${rate.id}`} className="break-words">
            {rate.name}: {summary.currency} {purchaseAmount(rate.price, summary.minorUnit)}
          </p>
        ))}
      <p className="flex flex-wrap justify-between gap-2 font-medium">
        <span>
          <Trans>Total</Trans>
        </span>
        <span className="break-all tabular-nums">
          {summary.currency} {purchaseAmount(summary.total, summary.minorUnit)}
        </span>
      </p>
      <div className="space-y-3">
        {(
          [
            ["billing", billing],
            ...(Object.values(shipping).some(Boolean) || summary.needsShipping
              ? [["shipping", shipping] as const]
              : []),
          ] as const
        ).map(([kind, address]) => (
          <div key={kind}>
            <h3 className="mb-1 font-medium">
              {kind === "billing" ? <Trans>Billing</Trans> : <Trans>Delivery</Trans>}
            </h3>
            <p className="whitespace-pre-line break-words text-muted-foreground">
              {[
                [address.firstName, address.lastName].filter(Boolean).join(" "),
                address.company,
                address.address1,
                address.address2,
                [address.city, address.state, address.postcode].filter(Boolean).join(" "),
                address.country,
                address.email,
                address.phone,
              ]
                .filter(Boolean)
                .join("\n")}
            </p>
          </div>
        ))}
        <p className="break-words">
          <Trans>Payment method</Trans>: {review.paymentMethodLabel}
        </p>
      </div>
      {review.decision ? (
        <div className="space-y-3">
          <p role="status" className="text-muted-foreground">
            {review.decision === "confirmed" ? (
              <Trans>Details confirmed. Your order has not been placed yet.</Trans>
            ) : (
              <Trans>Changes requested. Tell support what to update.</Trans>
            )}
          </p>
          {review.decision === "confirmed" && (
            <Button variant="outline" disabled={busy} onClick={() => onDecide("changes_requested")}>
              <Trans>Request changes</Trans>
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-muted-foreground">
            <Trans>
              Confirm these details for staff to place your order. This does not make a payment.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => onDecide("confirmed")}>
              <Trans>Confirm details</Trans>
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => onDecide("changes_requested")}>
              <Trans>Request changes</Trans>
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
