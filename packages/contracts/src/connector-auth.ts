import { z } from "zod";

/** A secret the provider's incoming template asks the account owner to enter. */
export const IncomingSecretSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
  label: z.string().min(1).max(100),
});
export type IncomingSecret = z.infer<typeof IncomingSecretSchema>;

export const ConnectorCredentialFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  inputType: z.enum(["text", "password", "textarea", "json"]),
  required: z.boolean(),
  secret: z.boolean(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
});
export const ConnectorAuthMethodSchema = z.object({
  type: z.enum(["no_auth", "api_key", "custom_credential", "oauth2"]),
  fields: z.array(ConnectorCredentialFieldSchema),
  authorizationOptions: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string(),
        required: z.boolean(),
        defaultSelected: z.boolean(),
      }),
    )
    .optional(),
});
export const ConnectorAuthInputSchema = z.object({
  type: z.enum(["no_auth", "api_key", "custom_credential", "oauth2"]),
  values: z.record(z.string(), z.string().max(65536)).default({}),
  authorizationOptionIds: z.array(z.string()).optional(),
});
export const ConnectorSetupSchema = z.object({
  methods: z.array(ConnectorAuthMethodSchema),
  oauthManaged: z.boolean().optional(),
  oauthConfigured: z.boolean(),
  oauthFields: z.array(ConnectorCredentialFieldSchema).optional(),
  oauthSetupUrl: z.string().url().optional(),
  oauthCallbackUrl: z.string().optional(),
  /** Secrets the incoming-message setup will ask for, so the connect form can collect them up front. */
  incomingSecrets: z.array(IncomingSecretSchema).optional(),
});
export type ConnectorCredentialField = z.infer<typeof ConnectorCredentialFieldSchema>;
export type ConnectorAuthMethod = z.infer<typeof ConnectorAuthMethodSchema>;
export type ConnectorAuthInput = z.infer<typeof ConnectorAuthInputSchema>;
export type ConnectorSetup = z.infer<typeof ConnectorSetupSchema>;
