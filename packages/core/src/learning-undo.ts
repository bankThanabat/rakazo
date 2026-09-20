import type { LearningUndoPreview, LearningVersion } from "@rakazo/contracts";

type Edit = { start: number; end: number; lines: string[] };

// Line-based three-way reversal. Bound the LCS matrix for adversarial documents;
// large, unrelated rewrites require review instead of blocking the worker.
function edits(base: string[], next: string[]): Edit[] | undefined {
  if ((base.length + 1) * (next.length + 1) > 1_000_000) return;
  const width = next.length + 1;
  const lcs = new Uint16Array((base.length + 1) * width);
  for (let i = base.length - 1; i >= 0; i--)
    for (let j = next.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        base[i] === next[j]
          ? 1 + lcs[(i + 1) * width + j + 1]!
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const result: Edit[] = [];
  let i = 0;
  let j = 0;
  let edit: Edit | undefined;
  while (i < base.length || j < next.length) {
    if (i < base.length && j < next.length && base[i] === next[j]) {
      edit = undefined;
      i++;
      j++;
      continue;
    }
    if (!edit) {
      edit = { start: i, end: i, lines: [] };
      result.push(edit);
    }
    if (
      j < next.length &&
      (i === base.length || lcs[i * width + j + 1]! > lcs[(i + 1) * width + j]!)
    ) {
      edit.lines.push(next[j++]!);
    } else {
      edit.end = ++i;
    }
  }
  return result;
}

function overlap(a: Edit, b: Edit) {
  // Insertions at a changed boundary are ambiguous; keep the current text.
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

export function previewContentUndo(before: string, after: string, current: string) {
  if (before === after || current === before) return { content: current, conflict: false };
  if (current === after) return { content: before, conflict: false };
  const base = after.split("\n");
  const inverse = edits(base, before.split("\n"));
  const later = edits(base, current.split("\n"));
  if (!inverse || !later) return { content: current, conflict: true };
  const safe = inverse.filter((edit) => !later.some((other) => overlap(edit, other)));
  const merged = [...later, ...safe].sort((a, b) => b.start - a.start);
  for (const edit of merged) base.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return { content: base.join("\n"), conflict: safe.length !== inverse.length };
}

/** Reverse one revision while retaining subsequent edits, including conflicts. */
export function previewLearningUndo(
  before: LearningVersion,
  after: LearningVersion,
  current: LearningVersion,
): LearningUndoPreview {
  const proposed = { ...current };
  const conflicts: LearningUndoPreview["conflicts"] = [];
  for (const field of ["title", "customerVisible"] as const) {
    if (before[field] === after[field] || current[field] === before[field]) continue;
    if (current[field] !== after[field]) conflicts.push(field);
    else Object.assign(proposed, { [field]: before[field] });
  }
  const content = previewContentUndo(before.content, after.content, current.content);
  proposed.content = content.content;
  if (content.conflict) conflicts.push("content");
  return { before, after, current, proposed, conflicts };
}
