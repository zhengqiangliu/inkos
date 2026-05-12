import { describe, expect, it } from "vitest";
import {
  classifyAuditIssueClass,
  countAuditIssueClasses,
  resolvePrimaryIssueClass,
  splitAuditIssuesByClass,
} from "../utils/audit-issue-classification.js";

describe("audit issue classification", () => {
  it("classifies structural issues and splits them from textual ones", () => {
    const issues = [
      { category: "节奏单调", dimensionId: "pacing_monotony", description: "近期节奏拉平。" },
      { category: "文风", description: "表述偏啰嗦。" },
    ] as const;

    expect(classifyAuditIssueClass(issues[0])).toBe("structural");
    expect(classifyAuditIssueClass(issues[1])).toBe("textual");

    const counts = countAuditIssueClasses(issues);
    expect(counts).toEqual({ structural: 1, textual: 1 });
    expect(resolvePrimaryIssueClass(counts)).toBe("mixed");

    const split = splitAuditIssuesByClass(issues);
    expect(split.structural).toHaveLength(1);
    expect(split.textual).toHaveLength(1);
    expect(split.structural[0]?.category).toBe("节奏单调");
    expect(split.textual[0]?.category).toBe("文风");
  });
});
