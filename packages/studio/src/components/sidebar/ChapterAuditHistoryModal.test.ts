import { describe, expect, it } from "vitest";
import {
  buildChapterAuditVersions,
  compareChapterAuditVersions,
} from "./ChapterAuditHistoryModal";

describe("buildChapterAuditVersions", () => {
  it("adds stable version numbers in history order", () => {
    const versions = buildChapterAuditVersions([
      {
        auditedAt: "2026-05-23T00:00:00.000Z",
        passed: false,
        issueCount: 2,
        score: 71,
        issues: [],
      },
      {
        auditedAt: "2026-05-24T00:00:00.000Z",
        passed: true,
        issueCount: 0,
        score: 92,
        issues: [],
      },
    ]);

    expect(versions.map((item) => item.version)).toEqual([1, 2]);
    expect(versions[1]?.score).toBe(92);
  });
});

describe("compareChapterAuditVersions", () => {
  it("reports changed audit fields between two versions", () => {
    const diff = compareChapterAuditVersions(
      {
        version: 1,
        auditedAt: "2026-05-23T00:00:00.000Z",
        passed: false,
        issueCount: 2,
        score: 71,
        summary: "first summary",
        report: "first report",
        issues: ["A"],
      },
      {
        version: 2,
        auditedAt: "2026-05-24T00:00:00.000Z",
        passed: true,
        issueCount: 0,
        score: 92,
        summary: "second summary",
        report: "second report",
        severityCounts: { critical: 0, warning: 0, info: 0 },
        failureGate: "none",
        issues: ["A", "B"],
      },
    );

    expect(diff.changedFields).toEqual([
      "passed",
      "score",
      "issueCount",
      "summary",
      "report",
      "severityCounts",
      "failureGate",
      "issues",
    ]);
  });
});
