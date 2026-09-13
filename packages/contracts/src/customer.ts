import * as z from "zod";
import { Id } from "./ids.js";

// Provider identifiers remain readable in archived customer transcripts.
const CustomerProviderSchema = z.enum(["line", "instagram", "tiktok"]);
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
