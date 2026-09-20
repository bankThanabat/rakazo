import { buildSkillMd, formatSkillsCatalogInstruction, parseSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { parseSkillMutation, SKILL_MUTATION_TOOLS, skillTools } from "./skill-tools.js";

const content = buildSkillMd({
  name: "Review",
  description: "Review a patch",
  body: "Read the diff.",
  frontmatter: { compatibility: "offline", "allowed-tools": ["read_file"] },
});
describe("skill consent contract", () => {
  it("canonicalizes complete writes before hashing and showing approval", () => {
    const parsed = parseSkillMutation("skill_create", {
      content,
      expectedRevision: 0,
      reason: "Reusable review",
    });
    expect(parsed.content).toBe(content);
    expect(parseSkillMd(String(parsed.content))).toMatchObject({
      frontmatter: { compatibility: "offline", "allowed-tools": ["read_file"] },
    });
    expect(parseSkillMutation("skill_create", parsed)).toEqual(parsed);
    expect(() =>
      parseSkillMutation("skill_create", { name: "Review", description: "Missing full text" }),
    ).toThrow();
    expect(() =>
      parseSkillMutation("skill_create", { ...parsed, skillId: "already-exists" }),
    ).toThrow();
    expect(() => parseSkillMutation("skill_update", { ...parsed, skillId: "skill" })).toThrow();
    expect(() => parseSkillMutation("skill_update", { ...parsed, expectedRevision: 1 })).toThrow();
  });
  it.each(["skill_delete", "skill_undo", "skill_restore"])(
    "rejects unreviewed %s payloads",
    (name) => {
      const input = { skillId: "skill", expectedRevision: 1, revision: 1, reason: "Correction" };
      expect(() => parseSkillMutation(name, input)).toThrow();
      if (name !== "skill_delete")
        expect(() => parseSkillMutation(name, { ...input, reviewedContent: content })).toThrow();
      expect(
        parseSkillMutation(name, { ...input, reviewedContent: content, reviewedRemoved: false }),
      ).toMatchObject({ reviewedContent: content });
    },
  );
  it.each([...SKILL_MUTATION_TOOLS])(
    "shows all %s details and only once, or denies incomplete display",
    (name) => {
      const args = {
        content,
        reviewedContent: content,
        expectedRevision: 3,
        reviewedRemoved: false,
        reason: "Correct recipe",
      };
      const block = buildApprovalAskBlock("effect", name, args, []);
      expect(block).toMatchObject({
        kind: "ask",
        detail: JSON.stringify(args, null, 2),
        actions: [{ id: "allow" }, { id: "deny" }],
      });
      const longReview = { ...args, content: "x".repeat(100000) };
      expect(buildApprovalAskBlock("effect", name, longReview, [])).toMatchObject({
        detail: JSON.stringify(longReview, null, 2),
        actions: [{ id: "allow" }, { id: "deny" }],
      });
      expect(
        buildApprovalAskBlock("effect", name, { ...args, content: "x".repeat(1500000) }, []),
      ).toMatchObject({ actions: [{ id: "deny" }] });
      expect(buildApprovalAskBlock("effect", name, args, ["Correct recipe"])).toMatchObject({
        actions: [{ id: "deny" }],
      });
    },
  );
  it("bounds skill names, descriptions, content and catalog metadata", () => {
    for (const oversized of [
      content + "x".repeat(100000),
      `---\nname: ${"x".repeat(81)}\ndescription: d\n---\nb`,
      `---\nname: n\ndescription: ${"x".repeat(2001)}\n---\nb`,
    ]) {
      expect(() =>
        parseSkillMutation("skill_create", {
          content: oversized,
          expectedRevision: 0,
          reason: "test",
        }),
      ).toThrow();
    }
    const catalog = formatSkillsCatalogInstruction(
      Array.from({ length: 100 }, () => ({
        name: "n".repeat(80),
        description: "d".repeat(2000),
        source: "user" as const,
        readOnly: false,
      })),
    );
    expect(catalog!.length).toBeLessThan(12000);
  });
  it("ships valid read-only builtin recipes and read-only inspection definitions", () => {
    for (const skill of BUILTIN_AGENT_SKILLS)
      expect(parseSkillMd(skill.content)).toMatchObject({
        name: skill.name,
        description: skill.description,
      });
    for (const tool of skillTools)
      expect(Boolean(tool.readOnly)).toBe(!SKILL_MUTATION_TOOLS.has(tool.name));
  });
});
