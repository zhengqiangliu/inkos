import { describe, expect, it } from "vitest";
import {
  parseDialogueQuotePolicyFromBookRules,
  parseOpeningThreeChaptersPolicyFromBookRules,
  upsertDialogueQuotePolicyInBookRules,
  upsertOpeningThreeChaptersPolicyInBookRules,
} from "./book-rules-policy.js";

describe("book-rules-policy", () => {
  it("parses dialogueQuotePolicy from YAML frontmatter", () => {
    const raw = [
      "---",
      "version: \"1.0\"",
      "dialogueQuotePolicy:",
      "  mode: force_double",
      "  strict: true",
      "  autoNormalize: true",
      "---",
      "",
      "# Book Rules",
    ].join("\n");

    const policy = parseDialogueQuotePolicyFromBookRules(raw);
    expect(policy).toEqual({
      mode: "force_double",
      strict: true,
      autoNormalize: true,
    });
  });

  it("returns null when frontmatter has no dialogueQuotePolicy", () => {
    const raw = [
      "---",
      "version: \"1.0\"",
      "prohibitions: []",
      "---",
      "",
      "# Book Rules",
    ].join("\n");

    expect(parseDialogueQuotePolicyFromBookRules(raw)).toBeNull();
  });

  it("upserts policy into existing frontmatter without dropping other keys", () => {
    const raw = [
      "---",
      "version: \"1.0\"",
      "prohibitions:",
      "  - 不能泄露底牌",
      "---",
      "",
      "# Book Rules",
    ].join("\n");

    const updated = upsertDialogueQuotePolicyInBookRules(raw, {
      mode: "force_double",
      strict: true,
      autoNormalize: true,
    });

    expect(updated).toContain("version: \"1.0\"");
    expect(updated).toContain("prohibitions:");
    expect(updated).toContain("dialogueQuotePolicy:");
    expect(updated).toContain("mode: force_double");
    expect(updated).toContain("strict: true");
    expect(updated).toContain("autoNormalize: true");
  });

  it("inserts frontmatter when the file has no frontmatter", () => {
    const raw = "# Book Rules\n\n- keep tense scenes tight\n";
    const updated = upsertDialogueQuotePolicyInBookRules(raw, {
      mode: "force_corner",
      strict: false,
      autoNormalize: false,
    });

    expect(updated.startsWith("---\n")).toBe(true);
    expect(updated).toContain("dialogueQuotePolicy:");
    expect(updated).toContain("mode: force_corner");
    expect(updated).toContain("# Book Rules");
  });

  it("replaces existing dialogueQuotePolicy block instead of duplicating", () => {
    const raw = [
      "---",
      "version: \"1.0\"",
      "dialogueQuotePolicy:",
      "  mode: force_corner",
      "  strict: false",
      "  autoNormalize: false",
      "prohibitions:",
      "  - 不能泄露底牌",
      "---",
      "",
      "# Book Rules",
    ].join("\n");

    const updated = upsertDialogueQuotePolicyInBookRules(raw, {
      mode: "force_double",
      strict: true,
      autoNormalize: true,
    });

    expect((updated.match(/dialogueQuotePolicy:/g) ?? []).length).toBe(1);
    expect(updated).toContain("mode: force_double");
    expect(updated).toContain("strict: true");
    expect(updated).toContain("autoNormalize: true");
  });

  it("parses openingThreeChapters policy from YAML frontmatter", () => {
    const raw = [
      "---",
      "version: \"1.0\"",
      "openingThreeChapters:",
      "  enabled: true",
      "  applyInGovernedMode: true",
      "  strict: true",
      "  maxCharacters: 5",
      "---",
      "",
      "# Book Rules",
    ].join("\n");

    const policy = parseOpeningThreeChaptersPolicyFromBookRules(raw);
    expect(policy).toEqual({
      enabled: true,
      applyInGovernedMode: true,
      strict: true,
      maxCharacters: 5,
    });
  });

  it("upserts openingThreeChapters policy and keeps other frontmatter keys", () => {
    const raw = [
      "---",
      "version: \"1.0\"",
      "prohibitions:",
      "  - 不能泄露底牌",
      "---",
      "",
      "# Book Rules",
    ].join("\n");

    const updated = upsertOpeningThreeChaptersPolicyInBookRules(raw, {
      enabled: true,
      applyInGovernedMode: true,
      strict: true,
      maxCharacters: 5,
    });

    expect(updated).toContain("version: \"1.0\"");
    expect(updated).toContain("prohibitions:");
    expect(updated).toContain("openingThreeChapters:");
    expect(updated).toContain("enabled: true");
    expect(updated).toContain("applyInGovernedMode: true");
    expect(updated).toContain("strict: true");
    expect(updated).toContain("maxCharacters: 5");
  });
});
