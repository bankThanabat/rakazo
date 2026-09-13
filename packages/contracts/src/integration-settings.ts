import * as z from "zod";

export const IntegrationProviderIdSchema = z.enum(["composio", "pipedream", "open-connector"]);
export const IntegrationProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("composio"), apiKey: z.string().trim().min(1).max(16384) }),
  z.object({
    provider: z.literal("open-connector"),
    endpoint: z
      .string()
      .trim()
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "Use an HTTP or HTTPS server URL without credentials or query parameters"),
    apiKey: z.string().trim().min(1).max(16384),
  }),
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
