import { describe, expect, it } from "vitest";
import {
  describeAutoReviewState,
  extractAutoReviewFinalReason,
  extractChapterNumberFromPayload,
  extractRewriteReviewReason,
  isAuditTaskCompletionForBook,
  normalizeAuditSummary,
  resolveChapterAuditScore,
  shouldCarryForwardAuditSummary,
  shouldShowChapterAuditSummary,
  sliceUnprocessedSseMessages,
} from "./ChaptersSection";
import type { SSEMessage } from "../../hooks/use-sse";

describe("extractRewriteReviewReason", () => {
  it("parses structured rewrite-impact notes", () => {
    expect(
      extractRewriteReviewReason("[rewrite-impact] 上游第12章已重写，请复核本章与上游衔接。"),
    ).toBe("上游第12章已重写，请复核本章与上游衔接。");
  });

  it("returns null for unrelated review notes", () => {
    expect(extractRewriteReviewReason("一般备注")).toBeNull();
    expect(extractRewriteReviewReason(undefined)).toBeNull();
  });
});

describe("resolveChapterAuditScore", () => {
  it("prefers structured score when present", () => {
    expect(resolveChapterAuditScore({
      audit: {
        chapter: 12,
        passed: false,
        issueCount: 3,
        score: 61,
      },
      auditIssues: ["[critical] 旧分数来源"],
    })).toBe(61);
  });

  it("falls back to issue-based estimate when structured score is missing", () => {
    expect(resolveChapterAuditScore({
      auditIssues: [
        "[critical] continuity broken",
        "[warning] pacing too fast",
      ],
    })).toBe(53);
  });
});

describe("normalizeAuditSummary", () => {
  it("forces low-score audits to fail even when upstream marked them as passed", () => {
    expect(
      normalizeAuditSummary({
        chapter: 20,
        passed: true,
        issueCount: 2,
        score: 40,
        failureGate: "none",
      }),
    ).toMatchObject({
      chapter: 20,
      passed: false,
      score: 40,
      failureGate: "score",
    });
  });
});

describe("normalizeAuditSummary", () => {
  it("accepts chapter/chapterNumber as numeric strings", () => {
    expect(
      normalizeAuditSummary({
        chapter: "17",
        passed: true,
        issueCount: 1,
        score: 88,
      }),
    ).toMatchObject({
      chapter: 17,
      passed: true,
      issueCount: 1,
      score: 88,
    });

    expect(
      normalizeAuditSummary({
        chapterNumber: "18",
        passed: false,
        issueCount: 2,
        score: 61,
        failureGate: "score",
      }),
    ).toMatchObject({
      chapter: 18,
      passed: false,
      issueCount: 2,
      score: 61,
      failureGate: "score",
    });
  });
});

describe("extractAutoReviewFinalReason", () => {
  it("extracts persisted auto-review terminal reason from reviewNote", () => {
    expect(
      extractAutoReviewFinalReason("[auto-review-final] 自动审计未通过（达到自动修订轮次上限，仍未通过审计）；评分 52/100；问题 4 项"),
    ).toBe("自动审计未通过（达到自动修订轮次上限，仍未通过审计）；评分 52/100；问题 4 项");
  });

  it("returns null for non-auto-review notes", () => {
    expect(extractAutoReviewFinalReason("[rewrite-impact] 上游第12章已重写，请复核本章与上游衔接。")).toBeNull();
    expect(extractAutoReviewFinalReason(undefined)).toBeNull();
  });
});

describe("sliceUnprocessedSseMessages", () => {
  const msg = (event: string, timestamp: number): SSEMessage => ({
    event,
    timestamp,
    data: {},
  });

  it("returns all messages when none was processed before", () => {
    const messages = [msg("rewrite:complete", 1), msg("audit:complete", 2)];
    expect(sliceUnprocessedSseMessages(messages, null)).toEqual(messages);
  });

  it("returns every message after the last processed one", () => {
    const m1 = msg("rewrite:complete", 1);
    const m2 = msg("audit:complete", 2);
    const m3 = msg("agent:complete", 3);
    const messages = [m1, m2, m3];
    expect(sliceUnprocessedSseMessages(messages, m1)).toEqual([m2, m3]);
  });

  it("falls back to all messages when last processed message is not in buffer", () => {
    const old = msg("rewrite:complete", 10);
    const messages = [msg("rewrite:complete", 11), msg("audit:complete", 12)];
    expect(sliceUnprocessedSseMessages(messages, old)).toEqual(messages);
  });
});

describe("isAuditTaskCompletionForBook", () => {
  it("detects audit task completion for the matching book", () => {
    const msg: SSEMessage = {
      event: "book-task:complete",
      timestamp: 1,
      data: {
        bookId: "alpha",
        task: {
          type: "audit",
        },
      },
    };

    expect(isAuditTaskCompletionForBook(msg, "alpha")).toBe(true);
    expect(isAuditTaskCompletionForBook(msg, "beta")).toBe(false);
  });

  it("ignores non-audit task completion events", () => {
    const msg: SSEMessage = {
      event: "book-task:complete",
      timestamp: 1,
      data: {
        bookId: "alpha",
        task: {
          type: "write",
        },
      },
    };

    expect(isAuditTaskCompletionForBook(msg, "alpha")).toBe(false);
  });
});

describe("extractChapterNumberFromPayload", () => {
  it("accepts nested task payloads", () => {
    expect(extractChapterNumberFromPayload({
      task: {
        currentChapterNumber: 47,
      },
    })).toBe(47);

    expect(extractChapterNumberFromPayload({
      task: {
        result: {
          chapterNumber: "48",
        },
      },
    })).toBe(48);
  });
});

describe("describeAutoReviewState", () => {
  it("formats revise progress and stopped reason", () => {
    expect(describeAutoReviewState({
      phase: "revise",
      round: 2,
      maxRounds: 2,
    })).toBe("自动修订：第2/2轮");

    expect(describeAutoReviewState({
      phase: "stopped",
      round: 3,
      maxRounds: 2,
      reason: "二次修订后仍未通过",
    })).toBe("自动修订已中止：二次修订后仍未通过");
  });

  it("returns null for empty or disabled auto review state", () => {
    expect(describeAutoReviewState(undefined)).toBeNull();
    expect(describeAutoReviewState({
      phase: "audit",
      round: 1,
      maxRounds: 0,
    })).toBeNull();
  });
});

describe("shouldCarryForwardAuditSummary", () => {
  it("returns false when status changed", () => {
    expect(shouldCarryForwardAuditSummary({
      previous: {
        number: 7,
        title: "旧章",
        status: "audit-failed",
        wordCount: 3000,
        auditIssues: ["[critical] old issue"],
      },
      incoming: {
        number: 7,
        title: "旧章",
        status: "ready-for-review",
        wordCount: 3020,
        auditIssues: [],
      },
    })).toBe(false);
  });

  it("returns false when issue list changed", () => {
    expect(shouldCarryForwardAuditSummary({
      previous: {
        number: 8,
        title: "第八章",
        status: "audit-failed",
        wordCount: 3200,
        auditIssues: ["[critical] A"],
      },
      incoming: {
        number: 8,
        title: "第八章",
        status: "audit-failed",
        wordCount: 3222,
        auditIssues: ["[warning] B"],
      },
    })).toBe(false);
  });

  it("returns true only when chapter status and issue list are unchanged", () => {
    expect(shouldCarryForwardAuditSummary({
      previous: {
        number: 9,
        title: "第九章",
        status: "audit-failed",
        wordCount: 2800,
        auditIssues: ["[warning] pacing"],
      },
      incoming: {
        number: 9,
        title: "第九章",
        status: "audit-failed",
        wordCount: 2810,
        auditIssues: ["[warning] pacing"],
      },
    })).toBe(true);
  });

  it("keeps prior structured audit score even if issue list text changes", () => {
    expect(shouldCarryForwardAuditSummary({
      previous: {
        number: 10,
        title: "第十章",
        status: "ready-for-review",
        wordCount: 3000,
        auditIssues: ["[warning] old wording"],
        audit: {
          chapter: 10,
          passed: true,
          issueCount: 1,
          score: 88,
        },
      },
      incoming: {
        number: 10,
        title: "第十章",
        status: "ready-for-review",
        wordCount: 3010,
        auditIssues: ["[warning] wording changed after refresh"],
      },
    })).toBe(true);
  });
});

describe("shouldShowChapterAuditSummary", () => {
  it("hides passed audit summaries when requested", () => {
    expect(shouldShowChapterAuditSummary({
      chapter: 11,
      passed: true,
      issueCount: 0,
      score: 91,
      issues: [],
    }, true)).toBe(false);
  });

  it("keeps failed audit summaries visible", () => {
    expect(shouldShowChapterAuditSummary({
      chapter: 12,
      passed: false,
      issueCount: 2,
      score: 63,
      issues: ["[warning] pacing"],
    }, true)).toBe(true);
  });
});
