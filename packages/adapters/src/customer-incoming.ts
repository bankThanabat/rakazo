import type { CustomerBindingInput, IncomingSecret } from "@rakazo/contracts";
import { instagramIncoming } from "./customer-incoming-instagram.js";
import { lineIncoming } from "./customer-incoming-line.js";

/** Everything a messaging app needs for one-click incoming setup, as data.
 * Shared setup, relay, ingress and UI code never branch on a provider: to support
 * another app, add a template file and register it below. */
export type CustomerIncomingTemplate = {
  /** Application credentials configured by the operator, never by account owners. */
  managed?: boolean;
  /** Verification fields supplied by the operator when managed, otherwise by the account owner. */
  secrets: IncomingSecret[];
  /** Connected-account action and result path yielding the identifier payloads must match. */
  account?: { action: string; path: string[] };
  /** Builds the channel binding. `account` is empty when no lookup is declared. */
  binding: (values: { account: string; secretIds: Record<string, string> }) => CustomerBindingInput;
};

const templates: Record<string, CustomerIncomingTemplate> = {
  line: lineIncoming,
  instagram: instagramIncoming,
};

export function customerIncomingTemplate(provider: string): CustomerIncomingTemplate | undefined {
  return Object.hasOwn(templates, provider) ? templates[provider] : undefined;
}

export function customerIncomingSecrets(provider: string) {
  const template = customerIncomingTemplate(provider);
  return template?.managed ? [] : template?.secrets;
}
