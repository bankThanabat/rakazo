import { LearningImportInput, LearningImportPreviewSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalLearningImport,
  learningImportRows,
  previewLearningImport,
} from "./learning-import.js";

// Deliberately synthetic flat export, not a claimed LINE native schema.
const mapping = {
  threadId: "chat",
  messageId: "id",
  sentAt: "date",
  authorRole: "sender",
  text: "body",
  businessValues: ["ร้านค้า"],
  customerValues: ["ลูกค้า"],
};
const row = {
  chat: "old-chat",
  id: "reply-1",
  date: "2026-09-18 10:00:00",
  sender: "ร้านค้า",
  body: "ยินดีค่ะ, พร้อมส่ง\nขอบคุณค่ะ",
};
const input = {
  botId: "bot",
  source: "Synthetic mapped export",
  windowEnd: "2026-09-18T12:00:00Z",
  format: "json",
  timezoneOffset: "+07:00",
  mapping,
  content: JSON.stringify([row]),
};

describe("explicit history import mapping", () => {
  it("returns options that can be copied unchanged into an archive request", () => {
    for (const options of [
      { mapping, timezoneOffset: "+07:00" },
      { mapping: undefined, timezoneOffset: undefined },
    ]) {
      const request = { ...input, ...options };
      const preview = JSON.parse(JSON.stringify(previewLearningImport(request)));
      expect(
        LearningImportInput.safeParse({
          ...request,
          mapping: preview.mapping,
          timezoneOffset: preview.timezoneOffset,
        }).success,
      ).toBe(true);
    }
  });
  it("maps Thai fields and confirmed local time without treating customer text as voice", () => {
    const result = LearningImportPreviewSchema.parse(
      previewLearningImport({
        ...input,
        content: JSON.stringify([
          row,
          { ...row, id: "customer", sender: "ลูกค้า", body: "Private customer context" },
          { ...row, sender: "unknown" },
        ]),
      }),
    );
    expect(result).toMatchObject({
      accepted: 1,
      skipped: 2,
      earliest: "2026-09-18T03:00:00.000Z",
      mapping,
      timezoneOffset: "+07:00",
      authors: { business: 1, customer: 1, unknown: 1 },
    });
    expect(result.samples).toMatchObject([
      { threadId: "old-chat", authorRole: "business", sentAt: "2026-09-18T03:00:00.000Z" },
      { authorRole: "customer" },
      { authorRole: "unknown" },
    ]);
    expect(result.content).toContain(row.body);
    expect(result.content).not.toContain("Private customer context");
  });
  it("recognizes the same evidence after mapped CSV or normalized JSON reexport", () => {
    const normalized = {
      thread_id: row.chat,
      message_id: row.id,
      sent_at: "2026-09-18T03:00:00Z",
      author_role: "business",
      text: row.body,
    };
    expect(canonicalLearningImport(input)).toBe(
      canonicalLearningImport({
        ...input,
        mapping: undefined,
        timezoneOffset: undefined,
        content: JSON.stringify([normalized]),
      }),
    );
    const csv = {
      ...input,
      format: "csv",
      content:
        '\uFEFFchat,id,date,sender,body\r\nold-chat,reply-1,2026-09-18 10:00:00,ร้านค้า,"ยินดีค่ะ, พร้อมส่ง\r\nขอบคุณค่ะ"',
    };
    expect(canonicalLearningImport(csv)).toBe(canonicalLearningImport(input));
    expect(previewLearningImport(csv).accepted).toBe(1);
  });
  it("never guesses a timezone or changes a timestamp's explicit offset", () => {
    expect(previewLearningImport({ ...input, timezoneOffset: undefined })).toMatchObject({
      accepted: 0,
      skipped: 1,
    });
    const explicit = {
      ...input,
      content: JSON.stringify([{ ...row, date: "2026-09-18T10:00:00-04:00" }]),
    };
    expect(previewLearningImport({ ...explicit, windowEnd: "2026-09-18T16:00:00Z" }).earliest).toBe(
      "2026-09-18T14:00:00.000Z",
    );
    for (const timezoneOffset of ["Asia/Bangkok", "-00:00", "+14:30", "+25:00"])
      expect(LearningImportInput.safeParse({ ...input, timezoneOffset }).success).toBe(false);
  });
  it.each(["18/09/2026 10:00", "2026-02-30 10:00:00", "2026-09-18 25:00:00"])(
    "does not reinterpret ambiguous or invalid date %s",
    (date) => {
      const result = previewLearningImport({
        ...input,
        content: JSON.stringify([{ ...row, date }]),
      });
      expect(result).toMatchObject({ accepted: 0, skipped: 1 });
      expect(result.samples?.[0]?.sentAt).toBeNull();
    },
  );
  it("filters the window using converted timestamps and preserves optional IDs", () => {
    const result = learningImportRows({
      ...input,
      mapping: { ...mapping, messageId: undefined },
      content: JSON.stringify([
        { ...row, date: "2026-08-19 19:00:00" },
        { ...row, date: "2026-08-19 18:59:59" },
        { ...row, date: "2026-09-18 19:00:00" },
        { ...row, date: "2026-09-18 19:00:01" },
      ]),
    });
    expect(result.map((value) => value.reply?.sentAt ?? null)).toEqual([
      "2026-08-19T12:00:00.000Z",
      null,
      "2026-09-18T12:00:00.000Z",
      null,
    ]);
    expect(result[0]?.reply?.messageId).toBeNull();
  });
  it("rejects ambiguous authorship, duplicate headers and missing mapped CSV fields", () => {
    expect(
      LearningImportInput.safeParse({
        ...input,
        mapping: { ...mapping, customerValues: [" ร้านค้า "] },
      }).success,
    ).toBe(false);
    expect(() =>
      previewLearningImport({
        ...input,
        format: "csv",
        content: "chat,id,date,sender,body,body\na,b,c,d,e,f",
      }),
    ).toThrow("unique");
    expect(() =>
      previewLearningImport({ ...input, format: "csv", content: "chat,id,date,sender\na,b,c,d" }),
    ).toThrow("missing");
    expect(
      previewLearningImport({
        ...input,
        content: JSON.stringify([{ ...row, sender: "Shop display name" }]),
      }).accepted,
    ).toBe(0);
  });
  it("bounds samples while counts cover every row", () => {
    const result = previewLearningImport({
      ...input,
      content: JSON.stringify(
        Array.from({ length: 30 }, (_, index) => ({
          ...row,
          id: String(index),
          body: "a".repeat(600),
        })),
      ),
    });
    expect(result.samples).toHaveLength(10);
    expect(result.samples?.[0]?.text).toHaveLength(500);
    expect(result.authors.business).toBe(30);
    expect(result.accepted).toBe(30);
  });
});
