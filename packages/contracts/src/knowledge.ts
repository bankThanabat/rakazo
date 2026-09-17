import { z } from "zod";
import { ATTACHMENT_MAX_BASE64_LENGTH } from "./attachments.js";
import { isPlainHttpUrl } from "./http-url.js";
import { Id } from "./ids.js";

export const KnowledgeStatus = z.enum(["queued", "processing", "ready", "failed"]);
/** Accepted documents by file extension; the one list every surface and the backend share. */
export const KNOWLEDGE_MIME_TYPES = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export const KnowledgeSourceSchema = z.object({
  id: Id,
  name: z.string(),
  internal: z.boolean(),
  status: KnowledgeStatus,
  activeRevisionId: Id.nullable(),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
export const KnowledgeStateSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  canManage: z.boolean(),
  baseUrl: z.string().optional(),
  sources: z.array(KnowledgeSourceSchema),
});
export type KnowledgeState = z.infer<typeof KnowledgeStateSchema>;
export const KnowledgeConfigureInput = z.object({
  botId: Id,
  baseUrl: z
    .string()
    .max(2048)
    .refine((url) => isPlainHttpUrl(url)),
  apiKey: z.string().trim().min(1).max(4096),
});
export const KnowledgeUploadInput = z.object({
  botId: Id,
  sourceId: Id.optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !/[\\/]/.test(name) && [...name].every((char) => char.charCodeAt(0) >= 32)),
  mimeType: z.enum(KNOWLEDGE_MIME_TYPES),
  contentBase64: z.string().min(1).max(ATTACHMENT_MAX_BASE64_LENGTH),
});
export const KnowledgeSearchInput = z
  .object({ query: z.string().trim().min(1).max(4000) })
  .strict();

/** File pickers disagree on Markdown and CSV MIME types; normalize once for every surface. */
export function knowledgeMimeType(name: string, reported = ""): string {
  const types: Record<string, string> = KNOWLEDGE_MIME_TYPES;
  return types[name.split(".").pop()?.toLowerCase() ?? ""] ?? reported;
}
