import * as z from "zod";
import { Id } from "./ids.js";

export const LearningKind = z.enum(["voice", "knowledge", "memory", "skill"]);
export const LearningSourceRefSchema = z.object({
  kind: z.enum(["conversation", "import"]),
  id: Id,
});
export type LearningSourceRef = z.infer<typeof LearningSourceRefSchema>;
export const LearningSaveInput = z.object({
  botId: Id,
  scope: z.enum(["space", "bot"]),
  kind: LearningKind,
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().max(16000),
  customerVisible: z.boolean().default(false),
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(1).max(1000),
  source: z.string().trim().max(2000).default("Staff instruction"),
  sourceRef: LearningSourceRefSchema.optional(),
});
export const LearningDocumentSchema = z.object({
  id: Id,
  scope: z.enum(["space", "bot"]),
  kind: LearningKind,
  key: z.string(),
  title: z.string(),
  content: z.string(),
  customerVisible: z.boolean(),
  revision: z.number().int(),
  canEdit: z.boolean(),
  updatedAt: z.string(),
});
export const LearningRevisionSchema = z.object({
  actor: z.string(),
  id: Id,
  documentId: Id,
  revision: z.number().int(),
  title: z.string(),
  content: z.string(),
  customerVisible: z.boolean(),
  reason: z.string(),
  source: z.string(),
  hasEvidence: z.boolean().default(false),
  restoredFrom: z.number().int().nullable(),
  createdAt: z.string(),
});
export const LearningStateSchema = z.object({
  documents: z.array(LearningDocumentSchema),
  history: z.array(LearningRevisionSchema),
  canEditSpace: z.boolean(),
});
export type LearningState = z.infer<typeof LearningStateSchema>;
export type LearningSave = z.infer<typeof LearningSaveInput>;
export const LearningRestoreInput = z.object({
  botId: Id,
  documentId: Id,
  revision: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
});
export const LearningVersionSchema = LearningSaveInput.pick({
  title: true,
  content: true,
  customerVisible: true,
});
export type LearningVersion = z.infer<typeof LearningVersionSchema>;
export const LearningUndoPreviewSchema = z.object({
  before: LearningVersionSchema,
  after: LearningVersionSchema,
  current: LearningVersionSchema,
  proposed: LearningVersionSchema,
  conflicts: z.array(z.enum(["title", "content", "customerVisible"])),
});
export type LearningUndoPreview = z.infer<typeof LearningUndoPreviewSchema>;
export const LearningUndoInput = LearningRestoreInput.extend({
  resolution: LearningVersionSchema.optional(),
  reason: z.string().trim().min(1).max(1000),
});
export type LearningRestore = z.infer<typeof LearningRestoreInput>;
export type LearningUndo = z.infer<typeof LearningUndoInput>;
const NativeLearningText = z.object({
  id: Id.optional(),
  expectedRevision: z.number().int().nonnegative(),
  beforeContent: z.string().max(100000),
  content: z.string().max(100000),
});
export const NativeLearningChangeSchema = z.discriminatedUnion("kind", [
  NativeLearningText.extend({
    kind: z.literal("memory"),
    scope: z.enum(["bot", "user"]),
    path: z.string().min(1).max(1000),
  }),
  NativeLearningText.extend({ kind: z.literal("skill"), scope: z.literal("user") }),
]);
export type NativeLearningChange = z.infer<typeof NativeLearningChangeSchema>;
export const LearningTaskProposalSchema = z.object({
  native: NativeLearningChangeSchema.optional(),
  addition: z.string().max(13000).optional(),
  baseline: z
    .object({
      documentId: Id.optional(),
      revision: z.number().int().nonnegative(),
    })
    .optional(),
  supported: z.boolean(),
  publicSafe: z.boolean(),
  changesBusinessRules: z.boolean(),
  conditions: z.string().trim().min(1).max(2000),
  save: LearningSaveInput,
});
export type LearningTaskProposal = z.infer<typeof LearningTaskProposalSchema>;
export const LearningTaskSchema = z.object({
  id: Id,
  status: z.enum([
    "queued",
    "running",
    "review",
    "applied",
    "rejected",
    "failed",
    "ignored",
    "cancelled",
  ]),
  proposal: LearningTaskProposalSchema.nullable(),
  error: z.string().nullable(),
  documentId: Id.nullable(),
  appliedRevision: z.number().nullable(),
  targetKind: z.enum(["document", "memory", "skill"]).default("document"),
  reviewReason: z.string().nullable(),
  createdAt: z.string(),
  reviews: z.array(
    z.object({
      decision: z.string(),
      reason: z.string(),
      userId: Id,
      createdAt: z.string(),
    }),
  ),
});
export type LearningTask = z.infer<typeof LearningTaskSchema>;
export const LearningTaskListInput = z.object({
  botId: Id,
  cursor: Id.optional(),
  ids: z.array(Id).max(500).optional(),
});
export type LearningTaskList = z.infer<typeof LearningTaskListInput>;
export const LearningTaskPageSchema = z.object({
  items: z.array(
    LearningTaskSchema.omit({ proposal: true, reviews: true }).extend({ title: z.string() }),
  ),
  nextCursor: Id.nullable(),
});
export type LearningTaskPage = z.infer<typeof LearningTaskPageSchema>;
export const LearningReviewVersionSchema = z.object({
  title: z.string(),
  content: z.string().max(100000),
  customerVisible: z.boolean(),
});
export const LearningTaskDetailSchema = z.object({
  task: LearningTaskSchema,
  before: LearningReviewVersionSchema.nullable(),
  after: LearningReviewVersionSchema.nullable(),
  scope: z.enum(["space", "bot", "private-bot", "private-user"]),
  currentRevision: z.number().int().nonnegative(),
  stale: z.boolean(),
  canEdit: z.boolean(),
});
export type LearningTaskDetail = z.infer<typeof LearningTaskDetailSchema>;
export const LearningTaskDecisionToolInput = z
  .object({
    taskId: Id,
    decision: z.enum(["approve", "reject", "retry"]),
    reason: z.string().trim().min(1).max(900),
    reviewedProposal: LearningTaskProposalSchema.optional(),
    expectedStatus: LearningTaskSchema.shape.status.optional(),
  })
  .superRefine((input, context) => {
    if (input.decision === "approve" && !input.reviewedProposal)
      context.addIssue({
        code: "custom",
        path: ["reviewedProposal"],
        message: "Review the complete proposal before approving it.",
      });
  });
export const LearningTaskDecisionInput = LearningTaskDecisionToolInput.safeExtend({ botId: Id });
export type LearningTaskDecision = z.infer<typeof LearningTaskDecisionInput>;
export const LearningImportMapping = z
  .object({
    threadId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200).optional(),
    sentAt: z.string().min(1).max(200),
    authorRole: z.string().min(1).max(200),
    text: z.string().min(1).max(200),
    businessValues: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
    customerValues: z.array(z.string().trim().min(1).max(200)).max(20),
  })
  .strict()
  .superRefine((mapping, context) => {
    const business = new Set(mapping.businessValues.map((value) => value.normalize("NFC")));
    if (mapping.customerValues.some((value) => business.has(value.normalize("NFC"))))
      context.addIssue({
        code: "custom",
        path: ["customerValues"],
        message: "A source author value cannot mean both business and customer.",
      });
  });
export const LearningImportOptions = z.object({
  mapping: LearningImportMapping.optional(),
  timezoneOffset: z
    .string()
    .regex(/^(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/)
    .refine((value) => value !== "-00:00", "Confirm a known UTC offset; -00:00 means unknown.")
    .optional(),
});
export const LearningImportInput = LearningImportOptions.extend({
  botId: Id,
  format: z.enum(["csv", "json"]),
  content: z.string().min(1).max(1_000_000),
  source: z.string().trim().min(1).max(200),
  windowEnd: z.string().datetime({ offset: true }),
});
export const LearningImportPreviewSchema = z.object({
  accepted: z.number().int(),
  skipped: z.number().int(),
  duplicates: z.number().int(),
  earliest: z.string().nullable(),
  latest: z.string().nullable(),
  content: z.string(),
  errors: z.array(z.string()),
  samples: z
    .array(
      z.object({
        row: z.number().int().positive(),
        threadId: z.string().nullable(),
        sentAt: z.string().nullable(),
        authorRole: z.enum(["business", "customer", "unknown"]),
        text: z.string().max(500),
      }),
    )
    .max(10)
    .optional(),
  authors: z
    .object({ business: z.number().int(), customer: z.number().int(), unknown: z.number().int() })
    .optional(),
  mapping: LearningImportMapping.nullable().optional(),
  timezoneOffset: LearningImportOptions.shape.timezoneOffset.nullable(),
});
export const LearningArchiveInput = LearningImportInput;
export type LearningArchive = z.infer<typeof LearningArchiveInput>;
export const LearningArchiveResultSchema = z.object({
  sourceId: Id,
  preview: LearningImportPreviewSchema,
});
export const LearningEvidenceInput = z.object({ botId: Id, revisionId: Id });
export const LearningTaskEvidenceInput = z.object({ botId: Id, taskId: Id });
export const LearningEvidenceSchema = z.object({
  kind: z.enum(["conversation", "import", "social"]),
  sourceId: Id,
  label: z.string(),
  content: z.string(),
  format: z.enum(["csv", "json"]),
  coverage: LearningImportPreviewSchema.omit({
    content: true,
    samples: true,
    mapping: true,
    timezoneOffset: true,
  }).nullable(),
  mapping: LearningImportMapping.nullable().optional(),
  timezoneOffset: LearningImportOptions.shape.timezoneOffset.nullable(),
  windowEnd: z.string().nullable(),
  withdrawn: z.boolean(),
});
export type LearningEvidence = z.infer<typeof LearningEvidenceSchema>;
export const LearningWithdrawInput = z.object({ botId: Id, sourceId: Id });
export const CustomerSteerInput = z.object({
  id: Id,
  guidance: z.string().trim().min(1).max(4000),
  nonce: z.string().min(1).max(120),
});
export const CustomerSteerResult = z.object({
  applied: z.literal(true),
  inFlight: z.boolean(),
  queued: z.boolean(),
});

export const LearningFeedConfigureInput = z
  .object({
    connectionId: Id,
    expectedRevision: z.number().int().nonnegative(),
    scope: z.enum(["space", "bot"]),
    enabled: z.boolean(),
    includeReplies: z.boolean().default(false),
    includeMessages: z.boolean().default(false),
  })
  .strict();
export const LearningFeedRefreshInput = z.object({ id: Id }).strict();
export const LearningFeedRemoveInput = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const LearningHistoryStartInput = z
  .object({
    sourceId: Id,
    scope: z.enum(["space", "bot"]),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("connection"), connectionId: Id }).strict(),
      z.object({ kind: z.literal("export"), key: z.string().trim().min(1).max(200) }).strict(),
    ]),
  })
  .strict();

export const LearningHistoryListInput = z.object({ cursor: Id.optional() }).strict();
