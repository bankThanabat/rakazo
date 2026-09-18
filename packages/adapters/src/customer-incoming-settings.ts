import { WebhookVerificationSchema } from "@rakazo/contracts";
import { z } from "zod";
import { customerIncomingTemplate } from "./customer-incoming.js";
import type { OperatorSettingsDeps } from "./operator-settings.js";
import { loadOperatorSettings, saveOperatorSettings } from "./operator-settings.js";

const incomingSettingsId = (provider: string) => `incoming-webhook:${provider}`;

function parseIncomingSettings(provider: string, input: unknown) {
  const template = customerIncomingTemplate(provider);
  if (!template?.managed) throw new Error("This app does not use managed webhook settings");
  const values = z.record(z.string(), z.string().trim().min(1).max(16384)).parse(input);
  if (template.secrets.some((field) => !values[field.key]))
    throw new Error("Incomplete webhook settings");
  return Object.fromEntries(template.secrets.map((field) => [field.key, values[field.key]!]));
}

export async function loadIncomingSettings(deps: OperatorSettingsDeps, provider: string) {
  const stored = await loadOperatorSettings(deps, incomingSettingsId(provider));
  if (!stored) throw new Error("Incoming messages are not configured on the integration server");
  return parseIncomingSettings(provider, stored);
}

export async function saveIncomingSettings(
  deps: OperatorSettingsDeps,
  provider: string,
  input: unknown,
) {
  await saveOperatorSettings(
    deps,
    incomingSettingsId(provider),
    parseIncomingSettings(provider, input),
  );
}

/** Operator-owned signature verification for a managed provider, or null when the
 * account owner supplies the secrets. Secret ids are the field keys themselves. */
export async function loadManagedWebhook(deps: OperatorSettingsDeps, provider: string) {
  const template = customerIncomingTemplate(provider);
  if (!template?.managed) return null;
  const values = await loadIncomingSettings(deps, provider);
  const secretIds = Object.fromEntries(template.secrets.map((field) => [field.key, field.key]));
  const webhook = template.binding({ account: "", secretIds }).receive.webhook!;
  return {
    webhookSecret: values[webhook.secretId]!,
    verificationToken: values[webhook.verificationSecretId!],
    verification: WebhookVerificationSchema.parse(webhook),
  };
}
