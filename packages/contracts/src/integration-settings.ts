import * as z from "zod";
import { isPlainHttpUrl } from "./http-url.js";

export const IntegrationProviderIdSchema = z.enum(["composio", "pipedream", "open-connector"]);
export const IntegrationProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("composio"), apiKey: z.string().trim().min(1).max(16384) }),
  z
    .object({
      provider: z.literal("open-connector"),
      mode: z.enum(["direct", "gateway"]).optional(),
      endpoint: z
        .string()
        .trim()
        .url()
        .refine(
          (value) => isPlainHttpUrl(value),
          "Use an HTTP or HTTPS server URL without credentials or query parameters",
        ),
      apiKey: z.string().trim().min(1).max(16384),
    })
    .refine((config) => {
      if (config.mode !== "gateway") return true;
      const url = new URL(config.endpoint);
      return (
        url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      );
    }, "Use HTTPS for a remote gateway"),
  z.object({
    provider: z.literal("pipedream"),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(16384),
    projectId: z.string().trim().min(1).max(512),
    environment: z.enum(["production", "development"]).default("production"),
  }),
]);
export type IntegrationProviderConfig = z.infer<typeof IntegrationProviderConfigSchema>;
export type IntegrationProviderId = z.infer<typeof IntegrationProviderIdSchema>;
export const IntegrationSetupStateSchema = z.object({
  canConfigure: z.boolean(),
  needsSetup: z.boolean(),
  webUrl: z.string().url(),
  providers: z.array(z.object({ id: IntegrationProviderIdSchema, configured: z.boolean() })),
});
export type IntegrationSetupState = z.infer<typeof IntegrationSetupStateSchema>;
