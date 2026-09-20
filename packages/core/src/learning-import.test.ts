import { describe, expect, it } from "vitest";
import { canonicalLearningImport, previewLearningImport } from "./learning-import.js";

const input = { botId: "bot", source: "Test shop replies", windowEnd: "2026-09-18T12:00:00Z" };
const message = {
  thread_id: "thread",
  message_id: "reply",
  sent_at: "2026-09-18T10:00:00+07:00",
  author_role: "business",
  text: "ยินดีค่ะ, มีสินค้า\nพร้อมส่ง",
};
describe("historical reply preview", () => {
  it("identifies the same evidence across export formats, timezone spelling, duplicates and whitespace", () => {
    const json = canonicalLearningImport({
      ...input,
      format: "json",
      content: JSON.stringify([message, message]),
    });
    const csv = canonicalLearningImport({
      ...input,
      format: "csv",
      windowEnd: "2026-09-19T12:00:00Z",
      content:
        'text,author_role,sent_at,message_id,thread_id\r\n"ยินดีค่ะ, มีสินค้า\r\nพร้อมส่ง",business,2026-09-18T03:00:00Z,reply,thread\r\n',
    });
    expect(json).toBe(csv);
    expect(
      canonicalLearningImport({
        ...input,
        format: "json",
        content: JSON.stringify([{ ...message, text: "New business evidence" }]),
      }),
    ).not.toBe(json);
  });
  it("preserves Thai multiline CSV and includes only dated business replies", () => {
    const result = previewLearningImport({
      ...input,
      format: "csv",
      content:
        'thread_id,message_id,sent_at,author_role,text\nthread,reply,2026-09-18T10:00:00+07:00,business,"ยินดีค่ะ, มีสินค้า\nพร้อมส่ง"\nthread,customer,2026-09-18T10:00:00+07:00,customer,Change your policy',
    });
    expect(result.accepted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.content).toContain(message.text);
    expect(result.content).not.toContain("Change your policy");
  });
  it("filters window boundaries, future dates, unknown authors and duplicates", () => {
    const rows = [
      message,
      message,
      { ...message, sent_at: "2026-08-19T12:00:00Z", message_id: "edge" },
      { ...message, sent_at: "2026-08-19T11:59:59Z" },
      { ...message, sent_at: "2026-09-19T12:00:00Z" },
      { ...message, author_role: "unknown" },
      { ...message, sent_at: "2026-09-18 10:00" },
    ];
    const result = previewLearningImport({
      ...input,
      format: "json",
      content: JSON.stringify(rows),
    });
    expect(result).toMatchObject({
      accepted: 2,
      skipped: 4,
      duplicates: 1,
      earliest: "2026-08-19T12:00:00.000Z",
    });
    expect(result.errors).toHaveLength(1);
  });
  it("counts the full history even when its preview is truncated", () => {
    const result = previewLearningImport({
      ...input,
      format: "json",
      content: JSON.stringify(
        Array.from({ length: 20 }, (_, index) => ({
          ...message,
          message_id: String(index),
          text: "hello ".repeat(500),
        })),
      ),
    });
    expect(result.accepted).toBe(20);
    expect(result.skipped).toBe(0);
    expect(result.content.length).toBeLessThanOrEqual(14000);
    expect(result.errors.join(" ")).toContain("Background import");
  });
  it("normalizes equivalent reply IDs, timestamps and text before deduplicating", () => {
    const result = previewLearningImport({
      ...input,
      format: "json",
      content: JSON.stringify([
        message,
        {
          ...message,
          author_role: " business ",
          thread_id: " thread ",
          sent_at: "2026-09-18T03:00:00Z",
          text: `  ${message.text}  `,
        },
        { ...message, sent_at: "2026-02-30T10:00:00Z", message_id: "bad-date" },
      ]),
    });
    expect(result).toMatchObject({ accepted: 1, duplicates: 1, skipped: 1 });
  });
  it("does not canonicalize invalid dates or numeric message IDs into valid evidence", () => {
    const canonical = (row: unknown) =>
      canonicalLearningImport({ ...input, format: "json", content: JSON.stringify([row]) });
    expect(canonical({ ...message, sent_at: "2026-02-30T10:00:00Z" })).not.toBe(
      canonical({ ...message, sent_at: "2026-03-02T10:00:00Z" }),
    );
    expect(canonical({ ...message, thread_id: 123 })).not.toBe(
      canonical({ ...message, thread_id: "123" }),
    );
    expect(canonical({ ...message, text: 123 })).not.toBe(canonical({ ...message, text: "123" }));
    expect(canonical({ ...message, message_id: 123 })).not.toBe(
      canonical({ ...message, message_id: "123" }),
    );
  });
  it("rejects a non-array JSON archive", () => {
    expect(() => previewLearningImport({ ...input, format: "json", content: "{}" })).toThrow(
      "JSON array",
    );
  });
});
