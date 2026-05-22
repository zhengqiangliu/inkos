import { describe, expect, it } from "vitest";
import { resolveLatestChapterAuditReport } from "./chapter-audit";

describe("resolveLatestChapterAuditReport", () => {
  it("prefers live report, then latest history report, then summary", () => {
    expect(resolveLatestChapterAuditReport({
      audit: {
        report: "live report",
        summary: "live summary",
      },
      auditHistory: [
        {
          auditedAt: "2026-05-23T00:00:00.000Z",
          passed: true,
          issueCount: 0,
          score: 100,
          report: "history report",
          summary: "history summary",
          issues: [],
        },
      ],
    })).toBe("live report");

    expect(resolveLatestChapterAuditReport({
      auditHistory: [
        {
          auditedAt: "2026-05-23T00:00:00.000Z",
          passed: true,
          issueCount: 0,
          score: 100,
          summary: "history summary",
          issues: [],
        },
        {
          auditedAt: "2026-05-24T00:00:00.000Z",
          passed: true,
          issueCount: 0,
          score: 98,
          report: "latest history report",
          issues: [],
        },
      ],
    })).toBe("latest history report");

    expect(resolveLatestChapterAuditReport({
      auditHistory: [
        {
          auditedAt: "2026-05-23T00:00:00.000Z",
          passed: true,
          issueCount: 0,
          score: 100,
          summary: "fallback summary",
          issues: [],
        },
      ],
    })).toBe("fallback summary");
  });
});
