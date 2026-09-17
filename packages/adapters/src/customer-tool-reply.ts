import type { ConnectorCall } from "@rakazo/adapter-kit";
import { CustomerBindingSchema } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { customerDeliveryId, customerInput } from "./customer-mapping.js";

/** Recognize an explicit reply through the channel's existing send mapping. */
export function customerToolReply(
  bindingValue: unknown,
  connectionId: string | null,
  call: ConnectorCall,
  recipient: { customerId: string; threadId: string },
): string | null {
  const binding = CustomerBindingSchema.safeParse(bindingValue);
  if (
    !binding.success ||
    call.route?.resourceId !== connectionId ||
    call.route.toolName !== binding.data.send.action
  )
    return null;
  let body: string | undefined;
  function inspect(template: unknown, input: unknown): void {
    if (template === "$body") {
      if (typeof input !== "string" || !input.trim() || (body !== undefined && body !== input))
        throw new Error("Reply text is required");
      body = input;
    } else if (template && typeof template === "object") {
      for (const [key, value] of Object.entries(template))
        inspect(
          value,
          input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined,
        );
    }
  }
  inspect(binding.data.send.input, call.args);
  if (body === undefined) throw new Error("Reply mapping has no text input");
  const expected = customerInput(binding.data.send.input, {
    ...recipient,
    body,
    messageId: customerDeliveryId(call.executionId, 0),
  });
  // Retry keys come from Rakazo. Compare other arguments with the trusted target.
  function compare(template: unknown, actual: unknown, wanted: unknown): void {
    if (template === "$messageId") return;
    if (template && typeof template === "object") {
      if (!actual || typeof actual !== "object") throw new Error("Reply target is unavailable");
      for (const key of Object.keys(actual))
        if (!Object.hasOwn(template, key)) throw new Error("Unexpected reply argument");
      for (const [key, value] of Object.entries(template))
        compare(
          value,
          (actual as Record<string, unknown>)[key],
          (wanted as Record<string, unknown>)[key],
        );
    } else if (stableJsonValue(actual) !== stableJsonValue(wanted)) {
      throw new Error("Reply target does not match this conversation");
    }
  }
  compare(binding.data.send.input, call.args, expected);
  call.args = expected;
  return body;
}
