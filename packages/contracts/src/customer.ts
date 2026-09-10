import * as z from "zod";
import { Id } from "./ids.js";

export const CUSTOMER_REPLY_MAX_LENGTH = 900;

export const CustomerProviderSchema = z.enum(["line", "instagram", "tiktok"]);
export type CustomerProvider = z.infer<typeof CustomerProviderSchema>;
export const CustomerChannelInputSchema = z.object({
  provider: CustomerProviderSchema,
  accountId: z
    .string()
    .trim()
    .min(1)
    .max(150)
    .regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(100),
  botId: Id,
  instructions: z.string().trim().max(12000).default(""),
  credentials: z
    .record(z.string().max(80), z.string().min(1).max(8000))
    .refine((v) => Object.keys(v).length <= 10),
});
export type CustomerChannelInput = z.infer<typeof CustomerChannelInputSchema>;
export const CustomerChannelSchema = z.object({
  id: Id,
  provider: CustomerProviderSchema,
  accountId: z.string(),
  name: z.string(),
  botId: Id,
  instructions: z.string(),
  enabled: z.boolean(),
  webhookPath: z.string(),
  webhookUrl: z.string().url().optional(),
});
export type CustomerChannel = z.infer<typeof CustomerChannelSchema>;
export const CustomerConversationSchema = z.object({
  id: Id,
  channelId: Id,
  provider: CustomerProviderSchema,
  channelName: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable().default(null),
  owner: z.enum(["bot", "staff"]),
  needsHuman: z.boolean().default(false),
  preview: z.string(),
  updatedAt: z.string(),
});
export type CustomerConversation = z.infer<typeof CustomerConversationSchema>;
export const CustomerMessageSchema = z.object({
  id: Id,
  seq: z.number().int(),
  role: z.enum(["customer", "bot", "staff"]),
  body: z.string(),
  mediaUrl: z.string().nullable(),
  status: z.enum(["received", "queued", "processing", "sending", "sent", "failed", "cancelled"]),
  createdAt: z.string(),
});
export type CustomerMessage = z.infer<typeof CustomerMessageSchema>;
export const CustomerSnapshotSchema = z.object({
  conversation: CustomerConversationSchema,
  messages: z.array(CustomerMessageSchema),
});
export type CustomerSnapshot = z.infer<typeof CustomerSnapshotSchema>;
export const CustomerProviderDefinitionSchema = z.object({
  id: CustomerProviderSchema,
  name: z.string(),
  accountLabel: z.string(),
  setupUrl: z.string().url(),
  fields: z.array(z.object({ key: z.string(), label: z.string(), secret: z.boolean() })),
});
export type CustomerProviderDefinition = z.infer<typeof CustomerProviderDefinitionSchema>;
