import * as z from "zod";
import { ConnectorActionAccessSchema } from "./connector-actions.js";
import { ConnectorAuthInputSchema, IncomingSecretSchema } from "./connector-auth.js";
import { WebhookVerificationSchema } from "./customer.js";
import { isPlainHttpUrl } from "./http-url.js";

const id = z.string().min(1).max(200);
export const GatewayServerConfigSchema = z.object({
  endpoint: z
    .string()
    .url()
    .refine(
      (value) => isPlainHttpUrl(value),
      "Use an HTTP or HTTPS server URL without credentials",
    ),
  apiKey: z.string().min(1).max(16384),
  projectId: id,
  callbackOrigin: z
    .string()
    .url()
    .refine(
      (value) => isPlainHttpUrl(value, { httpsOnly: true, originOnly: true }),
      "Use a public HTTPS origin",
    ),
});
export type GatewayServerConfig = z.infer<typeof GatewayServerConfigSchema>;
export const IncomingSetupInputSchema = z.object({
  connectionId: id,
  botId: id,
  secrets: z.record(IncomingSecretSchema.shape.key, z.string().trim().min(1).max(16384)),
});
export const IncomingSetupResultSchema = z.object({ id, webhookUrl: z.string().url() });
export const GatewayConnectionSchema = z.object({
  id,
  providerRef: id,
  connectorId: z.literal("open-connector"),
  externalId: id,
  displayName: z.string().max(200),
});
const call = z.object({
  tool: id,
  args: z.record(z.string(), z.json()),
  executionId: id,
  connectionId: id.optional(),
  route: z
    .object({
      connectorId: z.literal("open-connector"),
      toolName: id,
      resourceId: id.optional(),
      resourceRevision: id.optional(),
      catalogGroup: z.string().optional(),
    })
    .optional(),
});
export const GatewayCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("catalog"), query: z.string().max(200).optional() }),
  z.object({ op: z.literal("setup"), provider: id }),
  z.object({ op: z.literal("listActions"), provider: id }),
  z.object({
    op: z.literal("begin"),
    provider: id,
    auth: ConnectorAuthInputSchema.optional(),
    credential: z.string().max(16384).optional(),
  }),
  ...(["poll", "status", "cancel", "revoke"] as const).map((op) =>
    z.object({ op: z.literal(op), ref: id }),
  ),
  z.object({ op: z.literal("reconnect"), ref: id, auth: ConnectorAuthInputSchema }),
  z.object({
    op: z.literal("discover"),
    connections: z.array(GatewayConnectionSchema).max(100),
    actionAccess: ConnectorActionAccessSchema.optional(),
  }),
  z.object({
    op: z.literal("resolve"),
    actionAccess: ConnectorActionAccessSchema.optional(),
    call,
    connections: z.array(GatewayConnectionSchema).max(100),
  }),
  z.object({
    op: z.literal("execute"),
    actionAccess: ConnectorActionAccessSchema.optional(),
    call,
    connections: z.array(GatewayConnectionSchema).max(100),
  }),
  z.object({
    op: z.literal("incoming"),
    ref: id,
    channelId: id,
    webhookSecret: z.string().min(1).max(16384),
    verification: WebhookVerificationSchema,
  }),
  z.object({ op: z.literal("deliveries") }),
  z.object({ op: z.literal("ack"), id }),
]);
export type GatewayCommand = z.infer<typeof GatewayCommandSchema>;
export const GatewayDeliverySchema = z.object({
  id,
  routeId: id,
  channelId: id,
  providerRef: id,
  payload: z.string().max(1024 * 1024),
});
export type GatewayDelivery = z.infer<typeof GatewayDeliverySchema>;
