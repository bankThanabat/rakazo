import { LearningImportInput } from "@rakazo/contracts";
import { csvParse } from "d3-dsv";

const normalizeText = (value: string) => value.replace(/\r\n?/g, "\n").trim().normalize("NFC");

function timestamp(value: unknown, timezoneOffset?: string): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (timezoneOffset && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text))
    return text.replace(" ", "T") + timezoneOffset;
  return text;
}

function importRows(input: ReturnType<typeof LearningImportInput.parse>) {
  const content = input.content.replace(/^\uFEFF/, "");
  const rows = input.format === "json" ? JSON.parse(content) : csvParse(content);
  if (!Array.isArray(rows) || rows.length > 10000)
    throw new Error("Use a CSV or JSON array with at most 10,000 messages");
  const mapping = input.mapping;
  if (input.format === "csv") {
    const columns: string[] = (rows as ReturnType<typeof csvParse>).columns;
    if (new Set(columns).size !== columns.length) throw new Error("CSV headers must be unique.");
    if (
      mapping &&
      [mapping.threadId, mapping.sentAt, mapping.authorRole, mapping.text, mapping.messageId].some(
        (key) => key !== undefined && !columns.includes(key),
      )
    )
      throw new Error("A mapped field is missing from the CSV headers.");
  }
  return (rows as unknown[]).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const field = (key: string | undefined) =>
      key && Object.hasOwn(row, key) ? row[key] : undefined;
    if (!mapping) return { ...row, sent_at: timestamp(row.sent_at, input.timezoneOffset) };
    const author = field(mapping.authorRole);
    const role = typeof author === "string" ? normalizeText(author) : null;
    return {
      thread_id: field(mapping.threadId),
      message_id: field(mapping.messageId),
      sent_at: timestamp(field(mapping.sentAt), input.timezoneOffset),
      author_role: mapping.businessValues.some((value) => normalizeText(value) === role)
        ? "business"
        : mapping.customerValues.some((value) => normalizeText(value) === role)
          ? "customer"
          : "unknown",
      text: field(mapping.text),
    };
  });
}

/** Stable evidence identity across CSV/JSON reserialization and row ordering. */
export function canonicalLearningImport(raw: unknown): string {
  const input = LearningImportInput.parse(raw);
  const normalize = (value: unknown) =>
    typeof value === "string" || value == null
      ? String(value ?? "")
          .replace(/\r\n?/g, "\n")
          .trim()
          .normalize("NFC")
      : { invalid: value };
  const records = importRows(input).map((value) => {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const at = normalize(row.sent_at);
    return JSON.stringify([
      normalize(row.thread_id),
      normalize(row.message_id),
      typeof at === "string" &&
      LearningImportInput.shape.windowEnd.safeParse(at).success &&
      Number.isFinite(Date.parse(at))
        ? new Date(at).toISOString()
        : at,
      normalize(row.author_role),
      normalize(row.text),
    ]);
  });
  return JSON.stringify([...new Set(records)].sort());
}

/** Shared validation for previews and resumable imports. Row positions never change. */
export function learningImportRows(raw: unknown) {
  const input = LearningImportInput.parse(raw);
  return validateRows(input, importRows(input));
}

function validateRows(
  input: ReturnType<typeof LearningImportInput.parse>,
  rows: ReturnType<typeof importRows>,
) {
  const end = Date.parse(input.windowEnd);
  const start = end - 30 * 86400000;
  const normalize = normalizeText;
  return rows.map((value, index) => {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    const invalid = (error?: string) => ({
      reply: null,
      error: error ? `Row ${index + 1}: ${error}` : null,
    });
    if (!row) return invalid("expected a message record");
    if (typeof row.author_role !== "string" || normalize(row.author_role) !== "business")
      return invalid();
    const { thread_id: thread, sent_at: at, text, message_id: messageId } = row;
    if (
      typeof thread !== "string" ||
      !thread.trim() ||
      normalize(thread).length > 1000 ||
      typeof at !== "string" ||
      !LearningImportInput.shape.windowEnd.safeParse(at.trim()).success ||
      typeof text !== "string" ||
      !text.trim() ||
      (messageId != null && typeof messageId !== "string")
    )
      return invalid(
        "need thread_id, sent_at with timezone, text, and an optional string message_id",
      );
    const timestamp = Date.parse(at.trim());
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) return invalid();
    if (
      normalize(text).length > 13000 ||
      (typeof messageId === "string" && normalize(messageId).length > 1000)
    )
      return invalid("reply or identifier exceeds the import limit");
    const sentAt = new Date(timestamp).toISOString();
    const reply = {
      threadId: normalize(thread),
      messageId: typeof messageId === "string" && messageId.trim() ? normalize(messageId) : null,
      sentAt,
      text: normalize(text),
    };
    if (JSON.stringify([reply]).length > 14000)
      return invalid("reply exceeds the learning evidence limit");
    return { reply, error: null };
  });
}

/** Preview counts cover the whole export; only the displayed excerpt is bounded. */
export function previewLearningImport(raw: unknown) {
  const input = LearningImportInput.parse(raw);
  const rows = importRows(input);
  const authors = { business: 0, customer: 0, unknown: 0 };
  const samples = rows.flatMap((row, index) => {
    const role = typeof row?.author_role === "string" ? normalizeText(row.author_role) : "unknown";
    const authorRole = role === "business" || role === "customer" ? role : "unknown";
    authors[authorRole]++;
    if (index >= 10) return [];
    const at = LearningImportInput.shape.windowEnd.safeParse(row?.sent_at);
    return [
      {
        row: index + 1,
        threadId:
          typeof row?.thread_id === "string" ? normalizeText(row.thread_id).slice(0, 1000) : null,
        sentAt:
          at.success && Number.isFinite(Date.parse(at.data))
            ? new Date(at.data).toISOString()
            : null,
        authorRole,
        text: typeof row?.text === "string" ? normalizeText(row.text).slice(0, 500) : "",
      } as const,
    ];
  });
  const seen = new Set<string>();
  const accepted: Array<NonNullable<ReturnType<typeof learningImportRows>[number]["reply"]>> = [];
  const errors: string[] = [];
  let skipped = 0;
  let duplicates = 0;
  for (const { reply, error } of validateRows(input, rows)) {
    if (!reply) {
      skipped++;
      if (error && errors.length < 20) errors.push(error);
      continue;
    }
    const identity = JSON.stringify([reply.threadId, reply.messageId ?? reply.sentAt, reply.text]);
    if (seen.has(identity)) {
      duplicates++;
      continue;
    }
    seen.add(identity);
    accepted.push(reply);
  }
  accepted.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  let content = "";
  for (const reply of accepted) {
    const excerpt = `Business reply ${reply.sentAt}\n${reply.text}`;
    if (content.length + excerpt.length + 2 > 14000) {
      if (errors.length < 20)
        errors.push(
          "Preview excerpt limited to 14,000 characters. Background import processes all accepted replies.",
        );
      break;
    }
    content += (content ? "\n\n" : "") + excerpt;
  }
  return {
    accepted: accepted.length,
    skipped,
    duplicates,
    earliest: accepted[0]?.sentAt ?? null,
    latest: accepted.at(-1)?.sentAt ?? null,
    content,
    errors,
    authors,
    samples,
    mapping: input.mapping,
    timezoneOffset: input.timezoneOffset,
  };
}
