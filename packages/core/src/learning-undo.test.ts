import { describe, expect, it } from "vitest";
import { previewLearningUndo } from "./learning-undo.js";

const version = (content: string, title = "Voice", customerVisible = true) => ({
  title,
  content,
  customerVisible,
});
describe("selective learning undo", () => {
  it("reverses only the selected change while keeping later lines and metadata", () => {
    const result = previewLearningUndo(
      version("สุภาพ\nAsk one question\nCheck stock"),
      version("Friendly\nAsk one question\nCheck stock"),
      version("Friendly\nAsk one question\nCheck current stock", "Shop voice", false),
    );
    expect(result.proposed).toEqual(
      version("สุภาพ\nAsk one question\nCheck current stock", "Shop voice", false),
    );
    expect(result.conflicts).toEqual([]);
  });
  it("preserves overlapping edits for review while reversing other changes", () => {
    const result = previewLearningUndo(
      version("Formal\nAsk one question\nVerify stock\nFinish"),
      version("Friendly\nAsk one question\nGuess stock\nFinish"),
      version("Warm and concise\nAsk one question\nGuess stock\nFinish", "New title"),
    );
    expect(result.proposed.content).toBe(
      "Warm and concise\nAsk one question\nVerify stock\nFinish",
    );
    expect(result.proposed.title).toBe("New title");
    expect(result.conflicts).toEqual(["content"]);
  });
  it("reverses insertions and deletions with later independent edits", () => {
    expect(
      previewLearningUndo(
        version("A\nB\nC\nD"),
        version("A\nAdded\nB\nD"),
        version("New A\nAdded\nB\nD"),
      ).proposed.content,
    ).toBe("New A\nB\nC\nD");
  });
  it("keeps conflicting titles and treats adjacent insertions conservatively", () => {
    const result = previewLearningUndo(
      version("A\nB", "Old"),
      version("A\nX\nB", "New"),
      version("A\nY\nB", "Latest"),
    );
    expect(result.proposed).toEqual(version("A\nY\nB", "Latest"));
    expect(result.conflicts).toEqual(["title", "content"]);
  });
  it("removes a newly created document from use without deleting its audit identity", () => {
    const empty = version("", "Voice", false);
    expect(previewLearningUndo(empty, version("Friendly"), version("Friendly")).proposed).toEqual(
      empty,
    );
  });
  it("does not replay an already reverted change", () => {
    const before = version("Original");
    expect(previewLearningUndo(before, version("Changed"), before)).toMatchObject({
      proposed: before,
      conflicts: [],
    });
  });
  it("bounds work on pathological multiline rewrites and retains the current text", () => {
    const current = version("C\n".repeat(3000));
    expect(
      previewLearningUndo(version("A\n".repeat(3000)), version("B\n".repeat(3000)), current),
    ).toMatchObject({ proposed: current, conflicts: ["content"] });
  });
});
