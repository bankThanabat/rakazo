import type { CustomerBindingInput, IncomingSecret } from "@rakazo/contracts";
import { lineIncoming } from "./customer-incoming-line.js";

/** Everything a messaging app needs for one-click incoming setup, as data.
 * Shared setup, relay, ingress and UI code never branch on a provider: to support
 * another app, add a template file and register it below. */
export type CustomerIncomingTemplate = {
  /** Secrets the account owner enters; keys become the setup input. */
  secrets: IncomingSecret[];
  /** Connected-account action and result path yielding the identifier payloads must match. */
  account?: { action: string; path: string[] };
  /** Builds the channel binding. `account` is empty when no lookup is declared. */
  binding: (values: { account: string; secretIds: Record<string, string> }) => CustomerBindingInput;
};

const templates: Record<string, CustomerIncomingTemplate> = { line: lineIncoming };

export function customerIncomingTemplate(provider: string): CustomerIncomingTemplate | undefined {
  return Object.hasOwn(templates, provider) ? templates[provider] : undefined;
}
