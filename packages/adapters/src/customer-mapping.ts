import type { CustomerBinding } from "@rakazo/contracts";
import { z } from "zod";

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
export function customerField(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (forbidden.has(key) || !value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error("Message mapping path is missing");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Exact-value substitution preserves types and cannot turn content into an expression. */
export function customerInput(
  template: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 20) throw new Error("Message mapping is too deep");
    if (typeof value === "string" && value.startsWith("$")) {
      if (!Object.hasOwn(values, value.slice(1))) throw new Error("Unknown message mapping value");
      return values[value.slice(1)];
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (forbidden.has(key)) throw new Error("Invalid message mapping key");
          return [key, visit(item, depth + 1)];
        }),
      );
    return value;
  };
  return visit(template, 0) as Record<string, unknown>;
}

const identifier = z.union([z.string().min(1).max(500), z.number().finite()]).transform(String);
export function customerPage(binding: CustomerBinding, data: unknown, startedAt: Date) {
  const batches = binding.receive.batchPath
    ? z.array(z.unknown()).max(1000).parse(customerField(data, binding.receive.batchPath))
    : [data];
  const items = z
    .array(z.unknown())
    .max(1000)
    .parse(
      batches
        .filter((batch) => {
          const account = binding.receive.account;
          if (!account) return true;
          try {
            return customerField(batch, account.path) === account.equals;
          } catch {
            return false;
          }
        })
        .flatMap((batch) =>
          binding.receive.single
            ? [customerField(batch, binding.receive.items)]
            : z.array(z.unknown()).parse(customerField(batch, binding.receive.items)),
        ),
    );
  const { fields, incoming } = binding.receive;
  const messages = items
    .filter((item) => {
      try {
        return (
          customerField(item, incoming.path) === incoming.equals &&
          typeof customerField(item, fields.body) === "string"
        );
      } catch {
        return false;
      } // Ignore non-message events and attachment-only updates.
    })
    .map((item) => {
      const rawTime = customerField(item, fields.timestamp);
      const timestamp =
        binding.receive.timestampFormat === "iso"
          ? new Date(z.string().datetime({ offset: true }).parse(rawTime))
          : new Date(
              z.coerce.number().finite().positive().parse(rawTime) *
                (binding.receive.timestampFormat === "seconds" ? 1000 : 1),
            );
      if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid message timestamp");
      return {
        externalId: identifier.parse(customerField(item, fields.id)),
        externalThreadId: identifier.parse(customerField(item, fields.threadId)),
        customerId: identifier.parse(customerField(item, fields.customerId)),
        body: z.string().trim().min(1).max(16_000).parse(customerField(item, fields.body)),
        name: fields.name
          ? z.string().max(500).parse(customerField(item, fields.name))
          : "Customer",
        timestamp,
      };
    })
    .filter((message) => message.timestamp >= startedAt)
    .sort(
      (a, b) =>
        a.timestamp.getTime() - b.timestamp.getTime() || a.externalId.localeCompare(b.externalId),
    );
  const checkpoint = binding.receive.cursor;
  let cursor: string | number | null | undefined;
  if (Array.isArray(checkpoint)) {
    let raw: unknown = null;
    try {
      raw = customerField(data, checkpoint);
    } catch {
      // Terminal pages commonly omit the next-page field.
    }
    cursor = z.union([z.string(), z.number(), z.null()]).parse(raw);
  } else if (checkpoint && items.length) {
    const ids = items.map((item) =>
      z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER - 1)
        .parse(customerField(item, checkpoint.path)),
    );
    cursor = Math.max(...ids) + 1;
  }
  return { messages, cursor };
}
