import * as z from "zod";
import { Id } from "./ids.js";

export const CustomerConversationSchema = z.object({
  id: Id,
  channelId: Id,
  provider: z.string().min(1),
  channelName: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable().default(null),
  owner: z.enum(["bot", "staff"]),
  needsHuman: z.boolean().default(false),
  state: z.enum(["open", "resolved"]).default("open"),
  assigneeId: Id.nullable().default(null),
  handoffReason: z.string().nullable().default(null),
  unread: z.boolean().default(false),
  draft: z.string().nullable().default(null),
  canReply: z.boolean().default(false),
  preview: z.string(),
  updatedAt: z.string(),
});
export type CustomerConversation = z.infer<typeof CustomerConversationSchema>;
export const CustomerMessageSchema = z.object({
  id: Id,
  seq: z.number().int(),
  role: z.enum(["customer", "bot", "staff", "system"]),
  body: z.string(),
  mediaUrl: z.string().nullable(),
  status: z.enum(["received", "queued", "processing", "sending", "sent", "failed", "cancelled"]),
  createdAt: z.string(),
  errorCode: z.string().nullable().default(null),
  sentParts: z.number().int().default(0),
});
export type CustomerMessage = z.infer<typeof CustomerMessageSchema>;
export const CustomerSnapshotSchema = z.object({
  conversation: CustomerConversationSchema,
  messages: z.array(CustomerMessageSchema),
  before: z.number().int().nullable().default(null),
  actions: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        createdAt: z.string(),
        outcome: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type CustomerSnapshot = z.infer<typeof CustomerSnapshotSchema>;

export const CustomerReplyInput = z.object({
  id: Id,
  body: z.string().trim().min(1).max(16_000),
  nonce: z.string().min(1).max(120),
});
export const CustomerOwnerInput = z.object({ id: Id, owner: z.enum(["bot", "staff"]) });
export const CustomerCaseInput = z.object({
  id: Id,
  state: z.enum(["open", "resolved"]).optional(),
  assigneeId: Id.nullable().optional(),
  read: z.boolean().optional(),
});
export const CustomerListInput = z
  .object({
    query: z.string().max(200).default(""),
    state: z.enum(["open", "resolved", "all", "attention"]).default("open"),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .default({ query: "", state: "open", offset: 0 });
export const CustomerChannelSettingsInput = z.object({
  id: Id,
  enabled: z.boolean().optional(),
  shared: z.boolean().optional(),
  dailyMessageLimit: z.number().int().min(1).max(100000).optional(),
  hourlyCustomerLimit: z.number().int().min(1).max(1000).optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});
export const CustomerWebsiteInput = z.object({
  botId: Id,
  name: z.string().trim().min(1).max(100),
  origins: z.array(z.string().url()).min(1).max(20),
});
export const CustomerVisitorSessionInput = z
  .object({ name: z.string().trim().min(1).max(100).default("Visitor") })
  .strict();
export const CustomerVisitorMessageInput = z
  .object({ body: z.string().trim().min(1).max(16000), nonce: z.string().uuid() })
  .strict();
export const CustomerHistoryInput = z.object({
  before: z.coerce.number().int().positive().optional(),
});
export const CustomerDraftInput = z.object({
  id: Id,
  body: z.string().trim().min(1).max(16000),
  expectedSeq: z.number().int().min(0),
});
export const CustomerKnowledgeInput = z.object({
  id: Id.optional(),
  query: z.string().trim().min(1).max(4000),
});

// Paths are arrays of literal property names, not executable expressions.
const Path = z.array(z.string().min(1).max(200)).max(20);
const Action = z.object({
  action: z.string().min(1).max(200),
  input: z.record(z.string(), z.json()),
});
export const CustomerBindingSchema = z.object({
  receive: z.object({
    mode: z.enum(["poll", "webhook"]).default("poll"),
    action: z.string().min(1).max(200).optional(),
    input: z.record(z.string(), z.json()).default({}),
    batchPath: Path.optional(),
    account: z.object({ path: Path, equals: z.string().min(1) }).optional(),
    webhook: z
      .object({
        secretId: Id,
        header: z.string().min(1).max(100),
        algorithm: z.enum(["sha256", "sha1", "token"]).default("sha256"),
        encoding: z.enum(["hex", "base64"]).default("hex"),
        prefix: z.string().max(32).default(""),
        verificationSecretId: Id.optional(),
        timestamp: z
          .object({
            header: z.string().min(1),
            prefix: z.string().default(""),
            separator: z.string().default(":"),
          })
          .optional(),
        challengePath: Path.optional(),
      })
      .optional(),
    items: Path,
    single: z.boolean().default(false),
    cursor: z.union([Path, z.object({ kind: z.literal("max-plus-one"), path: Path })]).optional(),
    timestampFormat: z.enum(["iso", "seconds", "milliseconds"]).default("iso"),
    incoming: z.object({ path: Path, equals: z.union([z.string(), z.number(), z.boolean()]) }),
    nonText: z.enum(["ignore", "handoff"]).default("ignore"),
    fields: z.object({
      id: Path,
      threadId: Path,
      customerId: Path,
      body: Path,
      timestamp: Path,
      name: Path.optional(),
    }),
  }),
  send: Action.extend({
    textLimit: z
      .object({ max: z.number().int().min(4).max(16000), unit: z.enum(["characters", "utf8"]) })
      .default({ max: 1000, unit: "utf8" }),
  }),
  intervalSeconds: z.number().int().min(15).max(3600).default(30),
});
export type CustomerBinding = z.infer<typeof CustomerBindingSchema>;
export const CustomerInstructionsInput = z.object({
  instructions: z.string().trim().min(1).max(32_000),
});
/** A granted workflow binds credentials and scope on the server, never in model arguments. */
export const CustomerActionGrantSchema = z.object({
  audience: z.enum(["customer", "public"]).default("customer"),
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  description: z.string().min(1).max(2000),
  inputSchema: z.record(z.string(), z.json()),
  connectionId: Id,
  steps: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
        action: z.string().min(1).max(200),
        input: z.record(z.string(), z.json()),
        effect: z.enum(["read", "write"]),
        // A customer ownership check is required before any write. Promotion/limit
        // checks can compare other results to literals or previous step results.
        check: z.object({ path: Path, equals: z.json() }).optional(),
      }),
    )
    .min(1)
    .max(12),
});
export type CustomerActionGrant = z.infer<typeof CustomerActionGrantSchema>;
export const CustomerBehaviorInput = CustomerInstructionsInput.extend({
  credentialId: Id,
  actions: z.array(CustomerActionGrantSchema).max(32).default([]),
  knowledgeFilterId: z.string().min(1).max(200).nullable().default(null),
});
export const CustomerConnectInput = z.object({
  connectionId: Id,
  binding: CustomerBindingSchema,
  cursor: z.union([z.string(), z.number()]).optional(),
});
