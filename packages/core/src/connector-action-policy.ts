import type { ConnectorActionPolicy } from "@rakazo/contracts";
import { ConnectorActionPolicySchema } from "@rakazo/contracts";

/** A missing or malformed policy reads as empty, so every action stays internal. */
export function readActionPolicy(stored: unknown): ConnectorActionPolicy {
  const parsed = ConnectorActionPolicySchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : { defaults: {}, overrides: {} };
}

export function actionInternal(policy: ConnectorActionPolicy, action: string): boolean {
  const { defaults, overrides } = policy;
  if (Object.hasOwn(overrides, action)) return overrides[action]!;
  return Object.hasOwn(defaults, action) ? defaults[action]! : true;
}

/** The actions customer agents may use on this account. */
export function sharedActions(policy: ConnectorActionPolicy): string[] {
  const named = new Set([...Object.keys(policy.defaults), ...Object.keys(policy.overrides)]);
  return [...named].filter((action) => !actionInternal(policy, action));
}
