import { describe, expect, it, vi } from "vitest";
import { runChapterReviewCycle } from "../pipeline/chapter-review-cycle.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { ReviseMode } from "../agents/reviser.js";
import type { LengthSpec } from "../models/length-governance.js";

const LENGTH_SPEC: LengthSpec = {
  target: 220,
  softMin: 190,
  softMax: 250,
  hardMin: 160,
  hardMax: 280,
  countingMode: "zh_chars",
  normalizeMode: "none",
};

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    ...overrides,
  };
}

describe("runChapterReviewCycle", () => {
  it("applies post-write spot-fix before the first audit pass", async () => {
    const fixedDraft = "字".repeat(220);
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult());
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: fixedDraft,
      wordCount: 220,
      fixedIssues: ["fixed"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockResolvedValue({
        content: fixedDraft,
        wordCount: 220,
        applied: false,
        tokenUsage: ZERO_USAGE,
      });

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: "字".repeat(180),
        wordCount: 180,
        postWriteErrors: [{
          rule: "paragraph-shape",
          description: "too fragmented",
          suggestion: "merge short fragments",
          severity: "error",
        }],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(auditChapter).toHaveBeenCalledTimes(1);
    expect(auditChapter).toHaveBeenCalledWith(
      "/tmp/book",
      fixedDraft,
      1,
      "xuanhuan",
      { temperature: 0 },
    );
    expect(result.finalContent).toBe(fixedDraft);
    expect(result.revised).toBe(true);
  });

  it("escalates to rework when post-write spot-fix makes no meaningful change", async () => {
    const originalDraft = `甲${"字".repeat(205)}。——不是这样，而是那样。`;
    const fixedDraft = `甲${"字".repeat(210)}。是这样。也是那样。`;
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult());
    const reviseModes: ReviseMode[] = [];
    const reviseChapter = vi.fn().mockImplementation(async (
      _bookDir: string,
      content: string,
      _chapterNumber: number,
      _issues: ReadonlyArray<AuditIssue>,
      mode: ReviseMode,
    ) => {
      reviseModes.push(mode);
      if (mode === "spot-fix") {
        return {
          revisedContent: content,
          wordCount: content.length,
          fixedIssues: ["[ISSUE-01] no-op"],
          updatedState: "",
          updatedLedger: "",
          updatedHooks: "",
          tokenUsage: ZERO_USAGE,
        };
      }
      return {
        revisedContent: fixedDraft,
        wordCount: fixedDraft.length,
        fixedIssues: ["[ISSUE-01] fixed"],
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      };
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockImplementation(async (content: string) => ({
      content,
      wordCount: content.length,
      applied: false,
      tokenUsage: ZERO_USAGE,
    }));

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 2,
      initialOutput: {
        content: originalDraft,
        wordCount: originalDraft.length,
        postWriteErrors: [{
          rule: "禁止破折号",
          description: "出现了破折号「——」",
          suggestion: "用逗号或句号断句",
          severity: "error",
        }],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
    });

    expect(reviseModes).toEqual(["spot-fix", "rework"]);
    expect(result.finalContent).toBe(fixedDraft);
    expect(result.revised).toBe(true);
    expect(auditChapter).toHaveBeenCalledTimes(1);
  });

  it("drops auto-revision when it increases AI tells and re-audits the original draft", async () => {
    const failingAudit = createAuditResult({
      passed: false,
      issues: [{
        severity: "critical",
        category: "continuity",
        description: "broken continuity",
        suggestion: "fix it",
      }],
      summary: "bad",
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(failingAudit)
      .mockResolvedValueOnce(createAuditResult());
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "rewritten draft",
      wordCount: 15,
      fixedIssues: ["fixed"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockResolvedValueOnce({
        content: "original draft",
        wordCount: 13,
        applied: false,
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "rewritten draft",
        wordCount: 15,
        applied: false,
        tokenUsage: ZERO_USAGE,
      });
    const analyzeAITells = vi.fn((content: string) => ({
      issues: content === "rewritten draft"
        ? [
            { severity: "warning", category: "ai", description: "more ai", suggestion: "reduce" } satisfies AuditIssue,
            { severity: "warning", category: "ai", description: "another ai tell", suggestion: "reduce" } satisfies AuditIssue,
          ]
        : [],
    }));

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: "original draft",
        wordCount: 13,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells,
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(auditChapter).toHaveBeenNthCalledWith(1, "/tmp/book", "original draft", 1, "xuanhuan", { temperature: 0 });
    expect(auditChapter).toHaveBeenNthCalledWith(2, "/tmp/book", "original draft", 1, "xuanhuan", { temperature: 0 });
    expect(result.finalContent).toBe("original draft");
    expect(result.revised).toBe(false);
  });

  it("auto-revises length out-of-band draft and passes after re-audit", async () => {
    const longDraft = "字".repeat(300);
    const normalizedDraft = "字".repeat(300);
    const revisedDraft = "字".repeat(220);
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: revisedDraft,
      wordCount: 220,
      fixedIssues: ["length adjusted"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockResolvedValueOnce({
        content: normalizedDraft,
        wordCount: 300,
        applied: false,
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: revisedDraft,
        wordCount: 220,
        applied: false,
        tokenUsage: ZERO_USAGE,
      });

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: longDraft,
        wordCount: 300,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(result.revised).toBe(true);
    expect(result.finalWordCount).toBe(220);
    expect(result.auditResult.passed).toBe(true);
  });

  it("passes on re-audit after one targeted auto-revision", async () => {
    const initialDraft = "字".repeat(200);
    const revisedDraft = "修".repeat(220);
    const failingAudit = createAuditResult({
      passed: false,
      issues: [{
        severity: "critical",
        category: "continuity",
        description: "fact conflict",
        suggestion: "align facts",
      }],
      summary: "need fix",
    });
    const passingAudit = createAuditResult({
      passed: true,
      issues: [],
      summary: "fixed",
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(failingAudit)
      .mockResolvedValueOnce(passingAudit);
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: revisedDraft,
      wordCount: 220,
      fixedIssues: ["fact conflict -> aligned"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockResolvedValueOnce({
        content: initialDraft,
        wordCount: 200,
        applied: false,
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: revisedDraft,
        wordCount: 220,
        applied: false,
        tokenUsage: ZERO_USAGE,
      });

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: initialDraft,
        wordCount: 200,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.revised).toBe(true);
    expect(result.finalContent).toBe(revisedDraft);
    expect(result.auditResult.passed).toBe(true);
    expect(result.auditResult.summary).toBe("fixed");
  });

  it("fails audit when score is below pass threshold even without critical issues", async () => {
    const draft = "字".repeat(220);
    const warningIssues: AuditIssue[] = [
      {
        severity: "warning",
        category: "节奏",
        description: "节奏推进不足",
        suggestion: "提高推进效率",
      },
      {
        severity: "warning",
        category: "情绪",
        description: "情绪曲线单一",
        suggestion: "增加情绪层次",
      },
      {
        severity: "warning",
        category: "冲突",
        description: "冲突压力不够",
        suggestion: "提升场景对抗性",
      },
      {
        severity: "warning",
        category: "信息",
        description: "信息重复偏多",
        suggestion: "压缩重复信息",
      },
      {
        severity: "warning",
        category: "收束",
        description: "结尾收束偏弱",
        suggestion: "强化章末落点",
      },
    ];
    const auditChapter = vi.fn().mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: warningIssues,
        summary: "warning only",
      }),
    );
    const normalizeDraftLengthIfNeeded = vi.fn().mockResolvedValue({
      content: draft,
      wordCount: 220,
      applied: false,
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: draft,
        wordCount: 220,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({
        reviseChapter: vi.fn().mockResolvedValue({
          revisedContent: "",
          wordCount: 220,
          fixedIssues: [],
          updatedState: "",
          updatedLedger: "",
          updatedHooks: "",
          tokenUsage: ZERO_USAGE,
        }),
      }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
      maxReviseRounds: 0,
    });

    expect(result.auditResult.passed).toBe(false);
    expect(result.auditResult.issues.some((issue) => issue.category === "评分门禁")).toBe(false);
  });

  it("classifies structural issues and escalates first revise round to rework", async () => {
    const draft = "字".repeat(220);
    const firstAudit = createAuditResult({
      passed: false,
      issues: [{
        severity: "warning",
        category: "卷纲一致性",
        description: "卷纲偏离，主线推进失焦",
        suggestion: "回收到本卷目标并补强主线锚点",
      }],
      summary: "structural issue",
    });
    const secondAudit = createAuditResult({
      passed: true,
      issues: [],
      summary: "fixed",
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(firstAudit)
      .mockResolvedValueOnce(secondAudit);
    const reviseModes: ReviseMode[] = [];
    const reviseChapter = vi.fn().mockImplementation(async (
      _bookDir: string,
      _chapterContent: string,
      _chapterNumber: number,
      _issues: ReadonlyArray<AuditIssue>,
      mode: ReviseMode,
    ) => {
      reviseModes.push(mode);
      return {
        revisedContent: draft,
        wordCount: 220,
        fixedIssues: ["卷纲主线锚点已补强"],
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      };
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockResolvedValue({
      content: draft,
      wordCount: 220,
      applied: false,
      tokenUsage: ZERO_USAGE,
    });
    const auditRounds: Array<{
      issueClassCounts: { structural: number; textual: number };
      primaryIssueClass: "none" | "structural" | "textual" | "mixed";
    }> = [];

    await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: draft,
        wordCount: 220,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
      onAuditComplete: ({ audit }) => {
        auditRounds.push({
          issueClassCounts: {
            structural: audit.issueClassCounts.structural,
            textual: audit.issueClassCounts.textual,
          },
          primaryIssueClass: audit.primaryIssueClass,
        });
      },
      reviseMode: "spot-fix",
      maxReviseRounds: 2,
    });

    expect(reviseModes).toEqual(["rework"]);
    expect(auditRounds[0]).toMatchObject({
      issueClassCounts: { structural: 1, textual: 0 },
      primaryIssueClass: "structural",
    });
    expect(auditRounds[1]).toMatchObject({
      issueClassCounts: { structural: 0, textual: 0 },
      primaryIssueClass: "none",
    });
  });

  it("falls back to spot-fix after first-round rework for structural issues", async () => {
    const draft = "字".repeat(220);
    const firstAudit = createAuditResult({
      passed: false,
      issues: [
        {
          severity: "warning",
          category: "卷纲一致性",
          description: "卷纲偏离，主线推进失焦",
          suggestion: "回收到本卷目标并补强主线锚点",
        },
        {
          severity: "warning",
          category: "文风",
          description: "表述偏啰嗦",
          suggestion: "压缩重复表达",
        },
      ],
      summary: "mixed issues",
    });
    const secondAudit = createAuditResult({
      passed: false,
      issues: [{
        severity: "warning",
        category: "文风",
        description: "表述偏啰嗦",
        suggestion: "压缩重复表达",
      }],
      summary: "textual remains",
    });
    const thirdAudit = createAuditResult({
      passed: true,
      issues: [],
      summary: "fixed",
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(firstAudit)
      .mockResolvedValueOnce(secondAudit)
      .mockResolvedValueOnce(thirdAudit);
    const reviseModes: ReviseMode[] = [];
    const reviseChapter = vi.fn().mockImplementation(async (
      _bookDir: string,
      _chapterContent: string,
      _chapterNumber: number,
      _issues: ReadonlyArray<AuditIssue>,
      mode: ReviseMode,
    ) => {
      reviseModes.push(mode);
      return {
        revisedContent: draft,
        wordCount: 220,
        fixedIssues: ["fixed"],
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      };
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockResolvedValue({
      content: draft,
      wordCount: 220,
      applied: false,
      tokenUsage: ZERO_USAGE,
    });

    await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: draft,
        wordCount: 220,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
      reviseMode: "spot-fix",
      maxReviseRounds: 2,
    });

    expect(reviseModes).toEqual(["rework", "spot-fix"]);
  });

  it("escalates textual critical issues from spot-fix to rework on later rounds", async () => {
    const draft = "字".repeat(220);
    const failingAudit = createAuditResult({
      passed: false,
      issues: [{
        severity: "critical",
        category: "禁止破折号",
        description: "出现了破折号「——」",
        suggestion: "删除破折号并改写断句",
      }],
      summary: "critical textual issue",
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(failingAudit)
      .mockResolvedValueOnce(failingAudit)
      .mockResolvedValueOnce(failingAudit);
    const reviseModes: ReviseMode[] = [];
    const reviseChapter = vi.fn().mockImplementation(async (
      _bookDir: string,
      chapterContent: string,
      _chapterNumber: number,
      _issues: ReadonlyArray<AuditIssue>,
      mode: ReviseMode,
    ) => {
      reviseModes.push(mode);
      return {
        revisedContent: chapterContent,
        wordCount: chapterContent.length,
        fixedIssues: ["[ISSUE-01] attempted"],
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      };
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockImplementation(async (content: string) => ({
      content,
      wordCount: content.length,
      applied: false,
      tokenUsage: ZERO_USAGE,
    }));

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 2,
      initialOutput: {
        content: draft,
        wordCount: draft.length,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
      reviseMode: "spot-fix",
      maxReviseRounds: 2,
    });

    expect(reviseModes).toEqual(["spot-fix", "rework"]);
    expect(result.auditResult.passed).toBe(false);
    expect(result.autoReview.stoppedByMaxRounds).toBe(true);
  });

  it("runs structural pre-revise hook before content revision", async () => {
    const draft = "字".repeat(220);
    const firstAudit = createAuditResult({
      passed: false,
      issues: [{
        severity: "warning",
        category: "卷纲一致性",
        description: "卷纲偏离，主线推进失焦",
        suggestion: "回收到本卷目标并补强主线锚点",
      }],
      summary: "structural issue",
    });
    const secondAudit = createAuditResult({
      passed: true,
      issues: [],
      summary: "fixed",
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(firstAudit)
      .mockResolvedValueOnce(secondAudit);
    const callOrder: string[] = [];
    const structuralHook = vi.fn(async () => {
      callOrder.push("hook");
    });
    const reviseChapter = vi.fn().mockImplementation(async (
      _bookDir: string,
      _chapterContent: string,
      _chapterNumber: number,
      _issues: ReadonlyArray<AuditIssue>,
      _mode: ReviseMode,
    ) => {
      callOrder.push("revise");
      return {
        revisedContent: draft,
        wordCount: 220,
        fixedIssues: ["fixed"],
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      };
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockResolvedValue({
      content: draft,
      wordCount: 220,
      applied: false,
      tokenUsage: ZERO_USAGE,
    });

    await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: draft,
        wordCount: 220,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (_previous, next) => next,
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
      onStructuralPreRevise: structuralHook,
      reviseMode: "spot-fix",
      maxReviseRounds: 2,
    });

    expect(structuralHook).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["hook", "revise"]);
  });

  it("continues structural repair rounds when re-audit returns no issues but still fails", async () => {
    const draft = "字".repeat(220);
    const firstAudit = createAuditResult({
      passed: false,
      issues: [{
        severity: "warning",
        category: "卷纲一致性",
        description: "卷纲偏离，主线推进失焦",
        suggestion: "回收到本卷目标并补强主线锚点",
      }],
      summary: "structural issue",
    });
    const reAuditWithNoIssues = createAuditResult({
      passed: false,
      issues: [],
      summary: "empty-but-failed",
    });
    const finalAudit = createAuditResult({
      passed: true,
      issues: [],
      summary: "fixed",
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(firstAudit)
      .mockResolvedValueOnce(reAuditWithNoIssues)
      .mockResolvedValueOnce(finalAudit);
    const reviseModes: ReviseMode[] = [];
    const reviseChapter = vi.fn().mockImplementation(async (
      _bookDir: string,
      _chapterContent: string,
      _chapterNumber: number,
      _issues: ReadonlyArray<AuditIssue>,
      mode: ReviseMode,
    ) => {
      reviseModes.push(mode);
      return {
        revisedContent: draft,
        wordCount: 220,
        fixedIssues: ["fixed"],
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      };
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockResolvedValue({
      content: draft,
      wordCount: 220,
      applied: false,
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      book: { genre: "xuanhuan" },
      bookDir: "/tmp/book",
      chapterNumber: 1,
      initialOutput: {
        content: draft,
        wordCount: 220,
        postWriteErrors: [],
      },
      lengthSpec: LENGTH_SPEC,
      reducedControlInput: undefined,
      initialUsage: ZERO_USAGE,
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      assertChapterContentNotEmpty: () => undefined,
      addUsage: (left, right) => ({
        promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
        completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
        totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
      }),
      restoreLostAuditIssues: (previous, next) => (
        !next.passed && next.issues.length === 0 && previous.issues.length > 0
          ? { ...next, issues: previous.issues, summary: next.summary ?? previous.summary }
          : next
      ),
      analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
      analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
      logWarn: () => undefined,
      logStage: () => undefined,
      reviseMode: "spot-fix",
      maxReviseRounds: 2,
    });

    expect(reviseModes).toEqual(["rework", "spot-fix"]);
    expect(auditChapter).toHaveBeenCalledTimes(3);
    expect(result.auditResult.passed).toBe(true);
  });
});
