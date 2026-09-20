import type { CustomerMessage } from "@rakazo/contracts";

/** An interrupted outgoing send may already have reached the customer. */
export function customerDeliveryUnconfirmed(
  message: Pick<CustomerMessage, "role" | "status" | "errorCode">,
): boolean {
  return (
    message.role !== "customer" &&
    message.status === "failed" &&
    message.errorCode === "execution_uncertain"
  );
}

/** Internal practice channels never have a connector or a public visitor endpoint. */
export const CUSTOMER_PREVIEW_PROVIDER = "deskazo-preview";
export const customerChannelUsesConnector = (provider: string) =>
  provider !== "web" && provider !== CUSTOMER_PREVIEW_PROVIDER;

/** Preserve every Unicode code point while fitting the channel's actual wire limit. */
export function customerReplyParts(
  body: string,
  limit: { max: number; unit: "characters" | "utf8" },
): string[] {
  if (!Number.isInteger(limit.max) || limit.max < 4) throw new Error("Invalid message limit");
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let part = "";
  let size = 0;
  for (const character of body) {
    const cost = limit.unit === "utf8" ? encoder.encode(character).length : 1;
    if (size + cost > limit.max) {
      parts.push(part);
      part = "";
      size = 0;
    }
    part += character;
    size += cost;
  }
  if (part) parts.push(part);
  return parts;
}
