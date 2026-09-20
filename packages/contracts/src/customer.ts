import * as z from "zod";
import { BotSecretName } from "./bot-secrets.js";
import { isPlainHttpUrl } from "./http-url.js";
import { Id } from "./ids.js";

const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const CustomerQuietHoursSchema = z
  .object({
    start: ClockTime,
    end: ClockTime,
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((timezone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
          return true;
        } catch {
          return false;
        }
      }, "Use a valid timezone"),
  })
  .refine(
    (hours) => hours.start !== hours.end,
    "Quiet hours must have different start and end times",
  );
export type CustomerQuietHours = z.infer<typeof CustomerQuietHoursSchema>;
export const CustomerNotificationSettingsInput = z
  .object({
    help: z.boolean().optional(),
    quietHours: CustomerQuietHoursSchema.nullable().optional(),
  })
  .strict();

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
  acknowledgedAt: z.string().nullable().optional(),
  unread: z.boolean().default(false),
  draft: z.string().nullable().default(null),
  canReply: z.boolean().default(false),
  preview: z.string(),
  updatedAt: z.string(),
});
export type CustomerConversation = z.infer<typeof CustomerConversationSchema>;
export const CustomerMessageSchema = z.object({
  id: Id,
  senderId: z.string().nullable().default(null),
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
  notificationIssue: z.enum(["failed", "uncertain"]).nullable().default(null),
  guidance: z
    .array(z.object({ id: Id, content: z.string(), inFlight: z.boolean(), createdAt: z.string() }))
    .default([]),
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
export const CustomerCaseInput = z
  .object({
    id: Id,
    state: z.enum(["open", "resolved"]).optional(),
    assigneeId: Id.nullable().optional(),
    read: z.boolean().optional(),
    acknowledge: z.literal(true).optional(),
  })
  .refine((input) => !(input.acknowledge && input.state === "resolved"), {
    message: "Acknowledge or resolve the case, not both",
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
  autoReplies: z.boolean().optional(),
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
export const CustomerPreviewInput = z
  .object({
    message: z.string().trim().min(1).max(4000),
  })
  .strict();

export const CustomerKnowledgeInput = z.object({
  id: Id.optional(),
  query: z.string().trim().min(1).max(4000),
});

// Paths are arrays of literal property names, not executable expressions.
const Path = z.array(z.string().min(1).max(200)).max(20);
/** A field is one path, or several paths tried in order until one is present. */
const Field = z.union([Path, z.array(Path).min(1).max(5)]);
const Action = z.object({
  action: z.string().min(1).max(200),
  input: z.record(z.string(), z.json()),
});
/** How a provider signs webhook requests. Shared by direct ingress and the relay. */
export const WebhookVerificationSchema = z.object({
  header: z.string().min(1).max(100),
  algorithm: z.enum(["sha256", "sha1", "token"]).default("sha256"),
  encoding: z.enum(["hex", "base64"]).default("hex"),
  prefix: z.string().max(32).default(""),
  timestamp: z
    .object({
      header: z.string().min(1),
      prefix: z.string().default(""),
      separator: z.string().default(":"),
    })
    .optional(),
});
export type WebhookVerification = z.infer<typeof WebhookVerificationSchema>;
export const CustomerBindingSchema = z.object({
  receive: z.object({
    mode: z.enum(["poll", "webhook"]).default("poll"),
    action: z.string().min(1).max(200).optional(),
    input: z.record(z.string(), z.json()).default({}),
    batchPath: Path.optional(),
    account: z.object({ path: Path, equals: z.string().min(1) }).optional(),
    webhook: WebhookVerificationSchema.extend({
      secretId: Id,
      verificationSecretId: Id.optional(),
      challengePath: Path.optional(),
    }).optional(),
    items: Path,
    single: z.boolean().default(false),
    cursor: z.union([Path, z.object({ kind: z.literal("max-plus-one"), path: Path })]).optional(),
    timestampFormat: z.enum(["iso", "seconds", "milliseconds"]).default("iso"),
    incoming: z.object({ path: Path, equals: z.union([z.string(), z.number(), z.boolean()]) }),
    nonText: z.enum(["ignore", "handoff"]).default("ignore"),
    withdrawal: z
      .object({
        event: z.object({ path: Path, equals: z.union([z.string(), z.number(), z.boolean()]) }),
        messageId: Field,
      })
      .optional(),
    fields: z.object({
      id: Field,
      providerMessageId: Field.optional(),
      threadId: Field,
      customerId: Field,
      body: Field,
      timestamp: Field,
      name: Field.optional(),
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
export type CustomerBindingInput = z.input<typeof CustomerBindingSchema>;
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
        // A stable provider record from the preceding customer ownership read.
        operationKey: z
          .string()
          .regex(/^\$steps\.[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+$/)
          .optional(),
        receipt: z
          .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), Path.min(1))
          .refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 16)
          .optional(),
        // A customer ownership check is required before any write. Promotion/limit
        // checks can compare other results to literals or previous step results.
        check: z.object({ path: Path, equals: z.json() }).optional(),
      }),
    )
    .min(1)
    .max(12),
});
export type CustomerActionGrant = z.infer<typeof CustomerActionGrantSchema>;
export const CustomerIdentityInput = z
  .object({
    conversationId: Id,
    customerId: z.string().min(1).max(500),
    connectionId: Id,
  })
  .strict();
export const CustomerIdentitySetInput = CustomerIdentityInput.extend({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  identity: z
    .object({
      value: z.union([
        z.string().trim().min(1).max(500),
        z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      ]),
      action: z.string().min(1).max(200),
      input: z.record(z.string(), z.json()),
      path: Path.min(1),
    })
    .strict()
    .nullable(),
}).strict();
export const CustomerServiceConnection = z.object({
  credential: BotSecretName,
  baseUrl: z
    .string()
    .url()
    .refine(
      (value) => isPlainHttpUrl(value),
      "Use an HTTP service URL without credentials, query, or fragment",
    ),
});
export type CustomerServiceConnection = z.infer<typeof CustomerServiceConnection>;
export const CustomerAssessmentConfig = CustomerServiceConnection.extend({
  provider: z.literal("jev"),
  model: z.string().trim().min(1).max(100).default("jev-latest"),
  criteria: z.string().trim().max(2000).default(""),
});

export const CustomerBehaviorInput = CustomerInstructionsInput.extend({
  runtime: CustomerServiceConnection,
  modelCredentialId: Id,
  modelId: z.string().trim().min(1).max(256),
  knowledge: CustomerServiceConnection.nullable().default(null),
  actions: z.array(CustomerActionGrantSchema).max(32).default([]),
  knowledgeFilterId: z.string().min(1).max(200).nullable().default(null),
});
export const CustomerConnectInput = z.object({
  connectionId: Id,
  binding: CustomerBindingSchema,
  cursor: z.union([z.string(), z.number()]).optional(),
});

export const CustomerOperationListInput = z
  .object({
    status: z.enum(["unresolved", "completed", "all"]).default("unresolved"),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();

const CustomerOperationReviewInput = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    expectedAttempt: z.number().int().nonnegative().default(0),
    reason: z.string().trim().min(1).max(1000),
    providerReference: z.string().trim().min(1).max(500),
  })
  .strict();
export const CustomerOperationRetryInput = CustomerOperationReviewInput.extend({
  failureStatus: z.string().trim().min(1).max(200),
});
export const CustomerOperationResolveInput = CustomerOperationReviewInput.extend({
  receipt: z.record(
    z.string(),
    z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]),
  ),
});
