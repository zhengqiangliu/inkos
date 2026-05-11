import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideSoftRange } from "../utils/length-metrics.js";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditNormalizedWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly normalizeApplied: boolean;
  readonly autoReview: {
    readonly enabled: boolean;
    readonly maxReviseRounds: number;
    readonly reviseRoundsUsed: number;
    readonly auditRounds: number;
    readonly stoppedByMaxRounds: boolean;
    readonly stopReason?: string;
  };
}

const DEFAULT_AUTO_REVISE_ROUNDS = 2;
const AUTO_REVIEW_STOP_REASON_MAX_ROUNDS = "达到自动修订轮次上限，仍未通过审计";
const MIN_AUDIT_PASS_SCORE = 80;
const AUTO_REVIEW_DEFAULT_MODE: ReviseMode = "spot-fix";
const STRUCTURAL_REPAIR_EXCLUDED_CATEGORIES = new Set(["篇幅控制", "Length Control", "评分门禁", "Score Gate"]);
const STRUCTURAL_AUDIT_SIGNALS = [
  "volume_outline",
  "卷纲",
  "大纲偏离",
  "hook debt",
  "伏笔债务",
  "paragraph-shape",
  "读者期待管理",
  "篇幅控制",
  "length control",
  "资源账本",
  "ledger",
  "状态卡",
  "评分门禁",
  "score gate",
];

export interface AuditSeverityCounts {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export interface AuditIssueClassCounts {
  readonly structural: number;
  readonly textual: number;
}

export interface AuditRoundSummary {
  readonly chapterNumber: number;
  readonly passed: boolean;
  readonly issueCount: number;
  readonly severityCounts: AuditSeverityCounts;
  readonly issueClassCounts: AuditIssueClassCounts;
  readonly primaryIssueClass: "none" | "structural" | "textual" | "mixed";
  readonly score: number;
  readonly summary?: string;
  readonly issues: ReadonlyArray<AuditIssue>;
}

function countIssueSeverities(issues: ReadonlyArray<AuditIssue>): AuditSeverityCounts {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const issue of issues) {
    if (issue.severity === "critical") critical += 1;
    else if (issue.severity === "warning") warning += 1;
    else info += 1;
  }
  return { critical, warning, info };
}

function estimateAuditScore(severityCounts: AuditSeverityCounts): number {
  const raw = 100 - severityCounts.critical * 35 - severityCounts.warning * 12 - severityCounts.info * 4;
  return Math.max(0, Math.min(100, raw));
}

function isStructuralAuditIssue(issue: AuditIssue): boolean {
  const merged = `${issue.category} ${issue.description}`.toLowerCase();
  return STRUCTURAL_AUDIT_SIGNALS.some((signal) => merged.includes(signal));
}

function countIssueClasses(issues: ReadonlyArray<AuditIssue>): AuditIssueClassCounts {
  let structural = 0;
  for (const issue of issues) {
    if (isStructuralAuditIssue(issue)) structural += 1;
  }
  return {
    structural,
    textual: Math.max(0, issues.length - structural),
  };
}

function resolvePrimaryIssueClass(counts: AuditIssueClassCounts): "none" | "structural" | "textual" | "mixed" {
  if (counts.structural === 0 && counts.textual === 0) return "none";
  if (counts.structural > 0 && counts.textual > 0) return "mixed";
  return counts.structural > 0 ? "structural" : "textual";
}

function applyScoreGateToAuditResult(params: {
  auditResult: AuditResult;
  lengthSpec: LengthSpec;
}): AuditResult {
  if (!params.auditResult.passed) return params.auditResult;
  const score = estimateAuditScore(countIssueSeverities(params.auditResult.issues));
  if (score >= MIN_AUDIT_PASS_SCORE) return params.auditResult;

  const isEnglish = params.lengthSpec.countingMode === "en_words";
  const category = isEnglish ? "Score Gate" : "评分门禁";
  const hasScoreGateIssue = params.auditResult.issues.some((issue) => issue.category === category);
  const description = isEnglish
    ? `Audit score is below the pass threshold (${score}/${MIN_AUDIT_PASS_SCORE}).`
    : `审计评分低于通过阈值（${score}/${MIN_AUDIT_PASS_SCORE}）。`;
  const suggestion = isEnglish
    ? "Address warning-level issues and improve chapter quality before re-audit."
    : "请优先修复警告项并提升章节质量后再审计。";
  const issues = hasScoreGateIssue
    ? params.auditResult.issues
    : [...params.auditResult.issues, {
        severity: "warning",
        category,
        description,
        suggestion,
      } satisfies AuditIssue];
  const summary = hasScoreGateIssue
    ? params.auditResult.summary
    : [params.auditResult.summary?.trim(), description]
      .filter((entry): entry is string => Boolean(entry && entry.length > 0))
      .join("\n");

  return {
    ...params.auditResult,
    passed: false,
    issues,
    summary,
  };
}

function buildAuditRoundSummary(
  chapterNumber: number,
  auditResult: AuditResult,
): AuditRoundSummary {
  const severityCounts = countIssueSeverities(auditResult.issues);
  const issueClassCounts = countIssueClasses(auditResult.issues);
  return {
    chapterNumber,
    passed: auditResult.passed,
    issueCount: auditResult.issues.length,
    severityCounts,
    issueClassCounts,
    primaryIssueClass: resolvePrimaryIssueClass(issueClassCounts),
    score: estimateAuditScore(severityCounts),
    summary: auditResult.summary?.trim() ? auditResult.summary.trim() : undefined,
    issues: auditResult.issues,
  };
}

function normalizeIssueTextForCompare(issue: AuditIssue): string {
  return `${issue.category}:${issue.description}`
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function prioritizeUnresolvedIssues(
  issues: ReadonlyArray<AuditIssue>,
  previousIssues: ReadonlyArray<AuditIssue>,
): ReadonlyArray<AuditIssue> {
  if (issues.length === 0 || previousIssues.length === 0) {
    return issues;
  }
  const unresolved = new Set(previousIssues.map((issue) => normalizeIssueTextForCompare(issue)));
  const prioritized: AuditIssue[] = [];
  const remaining: AuditIssue[] = [];
  for (const issue of issues) {
    const normalized = normalizeIssueTextForCompare(issue);
    if (unresolved.has(normalized)) prioritized.push(issue);
    else remaining.push(issue);
  }
  if (prioritized.length === 0) {
    return issues;
  }
  return [...prioritized, ...remaining];
}

function splitIssuesByClass(issues: ReadonlyArray<AuditIssue>): {
  structural: ReadonlyArray<AuditIssue>;
  textual: ReadonlyArray<AuditIssue>;
} {
  const structural: AuditIssue[] = [];
  const textual: AuditIssue[] = [];
  for (const issue of issues) {
    if (isStructuralAuditIssue(issue)) structural.push(issue);
    else textual.push(issue);
  }
  return { structural, textual };
}

function resolveTextualReviseMode(
  issues: ReadonlyArray<AuditIssue>,
  reviseRound: number,
): ReviseMode {
  const severity = countIssueSeverities(issues);
  if (severity.critical > 0) {
    // Textual critical issues often fail to converge with repeated spot-fix;
    // escalate after the first attempt to avoid no-op loops.
    return reviseRound <= 1 ? "spot-fix" : "rework";
  }
  if (reviseRound <= 1 && severity.critical === 0 && severity.warning >= 3) {
    return "polish";
  }
  return "spot-fix";
}

function hasMeaningfulContentDelta(previous: string, next: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  return normalize(previous) !== normalize(next);
}

function hasStructuralAuditSignals(issues: ReadonlyArray<AuditIssue>): boolean {
  if (issues.length === 0) return false;
  const counts = countIssueClasses(issues);
  return counts.structural > 0;
}

function hasRepairStructuralSignals(issues: ReadonlyArray<AuditIssue>): boolean {
  return issues.some((issue) =>
    isStructuralAuditIssue(issue) && !STRUCTURAL_REPAIR_EXCLUDED_CATEGORIES.has(issue.category),
  );
}

function resolveAdaptiveMaxReviseRounds(
  configuredMaxRounds: number,
  issues: ReadonlyArray<AuditIssue>,
): number {
  if (configuredMaxRounds <= 0) return 0;
  const severity = countIssueSeverities(issues);
  let resolved = configuredMaxRounds;
  if (severity.warning >= 4 || hasStructuralAuditSignals(issues)) {
    resolved = Math.max(resolved, 4);
  }
  if (severity.critical >= 2) {
    resolved = Math.max(resolved, 5);
  }
  return Math.max(0, Math.min(5, resolved));
}

function resolveAdaptiveReviseMode(
  configuredMode: ReviseMode,
  issues: ReadonlyArray<AuditIssue>,
  reviseRound: number,
): ReviseMode {
  if (configuredMode !== "spot-fix") return configuredMode;
  if (!hasStructuralAuditSignals(issues)) return resolveTextualReviseMode(issues, reviseRound);
  // Stage switch: first round tackles structural issues with deeper rewrite,
  // then fallback to spot-fix for follow-up convergence rounds.
  return reviseRound <= 1 ? "rework" : "spot-fix";
}

function resolveAdaptiveIssuesForRound(
  configuredMode: ReviseMode,
  issues: ReadonlyArray<AuditIssue>,
  reviseRound: number,
): ReadonlyArray<AuditIssue> {
  if (configuredMode !== "spot-fix" || issues.length === 0) return issues;
  const { structural, textual } = splitIssuesByClass(issues);
  if (structural.length === 0) {
    return issues;
  }
  if (reviseRound <= 1) {
    // Structural lane first: keep structural issues at the front.
    return [...structural, ...textual];
  }
  // Convergence lane: clear textual gaps first while preserving unresolved structural items.
  return [...textual, ...structural];
}

function hasBlockingIssues(issues: ReadonlyArray<AuditIssue>): boolean {
  return issues.some((issue) => issue.severity === "critical" || issue.severity === "warning");
}

function applyLengthGateToAuditResult(params: {
  auditResult: AuditResult;
  chapterContent: string;
  lengthSpec: LengthSpec;
}): { auditResult: AuditResult; lengthOutOfBand: boolean } {
  const count = countChapterLength(params.chapterContent, params.lengthSpec.countingMode);
  const lengthOutOfBand = isOutsideSoftRange(count, params.lengthSpec);
  if (!lengthOutOfBand) {
    return { auditResult: params.auditResult, lengthOutOfBand: false };
  }

  const isEnglish = params.lengthSpec.countingMode === "en_words";
  const category = isEnglish ? "Length Control" : "篇幅控制";
  const hasLengthIssue = params.auditResult.issues.some((issue) => issue.category === category);
  const description = isEnglish
    ? `Chapter length is outside target range (${params.lengthSpec.softMin}-${params.lengthSpec.softMax} words, current ${count}).`
    : `字数未达目标区间（${params.lengthSpec.softMin}-${params.lengthSpec.softMax}字，当前 ${count}字）。`;
  const suggestion = isEnglish
    ? "Revise chapter length to fit the target range, then re-run audit."
    : "请补充或压缩正文，使字数回到目标区间后再审计。";
  const issues = hasLengthIssue
    ? params.auditResult.issues
    : [...params.auditResult.issues, {
        severity: "warning",
        category,
        description,
        suggestion,
      } satisfies AuditIssue];
  const summary = hasLengthIssue
    ? params.auditResult.summary
    : [params.auditResult.summary?.trim(), description]
      .filter((entry): entry is string => Boolean(entry && entry.length > 0))
      .join("\n");

  return {
    auditResult: {
      ...params.auditResult,
      passed: false,
      issues,
      summary,
    },
    lengthOutOfBand: true,
  };
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode: ReviseMode,
      genre?: string,
      options?: {
        chapterIntent?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly onThinkingDelta?: (text: string) => void;
  readonly onThinkingEnd?: () => void;
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: {
        temperature?: number;
        chapterIntent?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        onThinkingDelta?: (text: string) => void;
        onThinkingEnd?: () => void;
      },
    ) => Promise<AuditResult>;
  };
  readonly normalizeDraftLengthIfNeeded: (chapterContent: string) => Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: ChapterReviewCycleUsage;
  }>;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly restoreLostAuditIssues: (previous: AuditResult, next: AuditResult) => AuditResult;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => {
    found: ReadonlyArray<{ severity: string }>;
    issues: ReadonlyArray<AuditIssue>;
  };
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
  readonly maxReviseRounds?: number;
  readonly reviseMode?: ReviseMode;
  readonly onAuditStart?: (payload: { round: number; maxReviseRounds: number }) => void | Promise<void>;
  readonly onAuditComplete?: (payload: {
    round: number;
    maxReviseRounds: number;
    audit: AuditRoundSummary;
  }) => void | Promise<void>;
  readonly onReviseStart?: (payload: {
    round: number;
    maxReviseRounds: number;
    mode: ReviseMode;
  }) => void | Promise<void>;
  readonly onStructuralPreRevise?: (payload: {
    round: number;
    maxReviseRounds: number;
    mode: ReviseMode;
    issues: ReadonlyArray<AuditIssue>;
  }) => void | Promise<void>;
  readonly onReviseComplete?: (payload: {
    round: number;
    maxReviseRounds: number;
    mode: ReviseMode;
    reviseResult: ReviseOutput;
    reviseAudit: AuditRoundSummary | null;
  }) => void | Promise<void>;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let postReviseCount = 0;
  let normalizeApplied = false;
  let finalContent = params.initialOutput.content;
  let finalWordCount = params.initialOutput.wordCount;
  let revised = false;
  const configuredMaxReviseRounds = Number.isFinite(Number(params.maxReviseRounds))
    ? Math.max(0, Math.min(5, Math.trunc(Number(params.maxReviseRounds))))
    : DEFAULT_AUTO_REVISE_ROUNDS;
  const configuredReviseMode = params.reviseMode ?? AUTO_REVIEW_DEFAULT_MODE;
  let maxReviseRounds = configuredMaxReviseRounds;

  if (params.initialOutput.postWriteErrors.length > 0) {
    params.logWarn({
      zh: `检测到 ${params.initialOutput.postWriteErrors.length} 个后写错误，审计前触发 spot-fix 修补`,
      en: `${params.initialOutput.postWriteErrors.length} post-write errors detected, triggering spot-fix before audit`,
    });
    const reviser = params.createReviser();
    const spotFixIssues = params.initialOutput.postWriteErrors.map((violation) => ({
      severity: "critical" as const,
      category: violation.rule,
      description: violation.description,
      suggestion: violation.suggestion,
    }));
    const fixResult = await reviser.reviseChapter(
      params.bookDir,
      finalContent,
      params.chapterNumber,
      spotFixIssues,
      "spot-fix",
      params.book.genre,
      {
        ...params.reducedControlInput,
        lengthSpec: params.lengthSpec,
      },
    );
    totalUsage = params.addUsage(totalUsage, fixResult.tokenUsage);
    if (fixResult.revisedContent.length > 0) {
      finalContent = fixResult.revisedContent;
      finalWordCount = fixResult.wordCount;
      revised = true;
    }
    if (!hasMeaningfulContentDelta(params.initialOutput.content, finalContent)) {
      params.logWarn({
        zh: "后写错误 spot-fix 未产生有效改动，升级为 rework 进行兜底修复",
        en: "Post-write spot-fix made no meaningful change; escalating to rework fallback",
      });
      const reworkResult = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        spotFixIssues,
        "rework",
        params.book.genre,
        {
          ...params.reducedControlInput,
          lengthSpec: params.lengthSpec,
        },
      );
      totalUsage = params.addUsage(totalUsage, reworkResult.tokenUsage);
      if (reworkResult.revisedContent.length > 0 && hasMeaningfulContentDelta(finalContent, reworkResult.revisedContent)) {
        finalContent = reworkResult.revisedContent;
        finalWordCount = reworkResult.wordCount;
        revised = true;
      }
    }
  }

  const normalizedBeforeAudit = await params.normalizeDraftLengthIfNeeded(finalContent);
  totalUsage = params.addUsage(totalUsage, normalizedBeforeAudit.tokenUsage);
  finalContent = normalizedBeforeAudit.content;
  finalWordCount = normalizedBeforeAudit.wordCount;
  normalizeApplied = normalizeApplied || normalizedBeforeAudit.applied;
  params.assertChapterContentNotEmpty(finalContent, "draft generation");

  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  let auditRound = 1;
  await params.onAuditStart?.({ round: auditRound, maxReviseRounds });
  const llmAudit = await params.auditor.auditChapter(
    params.bookDir,
    finalContent,
    params.chapterNumber,
    params.book.genre,
    params.reducedControlInput
      ? { ...params.reducedControlInput, onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd }
      : params.onThinkingDelta || params.onThinkingEnd
        ? { onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd }
        : undefined,
  );
  totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
  const aiTellsResult = params.analyzeAITells(finalContent);
  const sensitiveWriteResult = params.analyzeSensitiveWords(finalContent);
  const hasBlockedWriteWords = sensitiveWriteResult.found.some((item) => item.severity === "block");
  let auditResult: AuditResult = {
    passed: hasBlockedWriteWords ? false : llmAudit.passed,
    issues: [...llmAudit.issues, ...aiTellsResult.issues, ...sensitiveWriteResult.issues],
    summary: llmAudit.summary,
  };
  {
    const lengthAdjusted = applyLengthGateToAuditResult({
      auditResult,
      chapterContent: finalContent,
      lengthSpec: params.lengthSpec,
    });
    auditResult = lengthAdjusted.auditResult;
  }
  auditResult = applyScoreGateToAuditResult({
    auditResult,
    lengthSpec: params.lengthSpec,
  });
  maxReviseRounds = resolveAdaptiveMaxReviseRounds(configuredMaxReviseRounds, auditResult.issues);
  await params.onAuditComplete?.({
    round: auditRound,
    maxReviseRounds,
    audit: buildAuditRoundSummary(params.chapterNumber, auditResult),
  });

  let priorRoundIssues: ReadonlyArray<AuditIssue> = [];
  let reviseRoundsUsed = 0;
  let stoppedByMaxRounds = false;
  let stopReason: string | undefined;
  for (let reviseRound = 1; reviseRound <= maxReviseRounds && !auditResult.passed; reviseRound += 1) {
    const blockingIssues = auditResult.issues.filter(
      (issue) => issue.severity === "critical" || issue.severity === "warning",
    );
    if (blockingIssues.length === 0) {
      break;
    }
    reviseRoundsUsed = reviseRound;
    const reviser = params.createReviser();
    const unresolvedPrioritizedIssues = reviseRound > 1
      ? prioritizeUnresolvedIssues(blockingIssues, priorRoundIssues)
      : blockingIssues;
    const issuesForRound = resolveAdaptiveIssuesForRound(
      configuredReviseMode,
      unresolvedPrioritizedIssues,
      reviseRound,
    );
    const reviseMode = resolveAdaptiveReviseMode(configuredReviseMode, issuesForRound, reviseRound);
    if (hasStructuralAuditSignals(issuesForRound)) {
      try {
        await params.onStructuralPreRevise?.({
          round: reviseRound,
          maxReviseRounds,
          mode: reviseMode,
          issues: issuesForRound,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        params.logWarn({
          zh: `结构性预修复钩子执行失败，继续正文修订：${detail}`,
          en: `Structural pre-revise hook failed; continuing content revision: ${detail}`,
        });
      }
    }
    await params.onReviseStart?.({
      round: reviseRound,
      maxReviseRounds,
      mode: reviseMode,
    });
    params.logStage({
      zh: `自动修订第${reviseRound}轮`,
      en: `auto revision round ${reviseRound}`,
    });
    const reviseOutput = await reviser.reviseChapter(
      params.bookDir,
      finalContent,
      params.chapterNumber,
      issuesForRound,
      reviseMode,
      params.book.genre,
      {
        ...params.reducedControlInput,
        lengthSpec: params.lengthSpec,
      },
    );
    totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);
    if (reviseOutput.revisedContent.length === 0) {
      await params.onReviseComplete?.({
        round: reviseRound,
        maxReviseRounds,
        mode: reviseMode,
        reviseResult: reviseOutput,
        reviseAudit: null,
      });
      break;
    }

    const normalizedRevision = await params.normalizeDraftLengthIfNeeded(reviseOutput.revisedContent);
    totalUsage = params.addUsage(totalUsage, normalizedRevision.tokenUsage);
    postReviseCount = normalizedRevision.wordCount;
    normalizeApplied = normalizeApplied || normalizedRevision.applied;

    const preMarkers = params.analyzeAITells(finalContent);
    const postMarkers = params.analyzeAITells(normalizedRevision.content);
    const contentChanged = hasMeaningfulContentDelta(finalContent, normalizedRevision.content);
    if (postMarkers.issues.length <= preMarkers.issues.length && contentChanged) {
      finalContent = normalizedRevision.content;
      finalWordCount = normalizedRevision.wordCount;
      revised = true;
      params.assertChapterContentNotEmpty(finalContent, `revision round ${reviseRound}`);
    }

    auditRound = reviseRound + 1;
    await params.onAuditStart?.({ round: auditRound, maxReviseRounds });
    const reAudit = await params.auditor.auditChapter(
      params.bookDir,
      finalContent,
      params.chapterNumber,
      params.book.genre,
      params.reducedControlInput
        ? { ...params.reducedControlInput, temperature: 0, onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd }
        : { temperature: 0, ...(params.onThinkingDelta || params.onThinkingEnd ? { onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd } : {}) },
    );
    totalUsage = params.addUsage(totalUsage, reAudit.tokenUsage);
    const reAuditReturnedNoIssues = Array.isArray(reAudit.issues) && reAudit.issues.length === 0;
    const reAITells = params.analyzeAITells(finalContent);
    const reSensitive = params.analyzeSensitiveWords(finalContent);
    const reHasBlocked = reSensitive.found.some((item) => item.severity === "block");
    const previousAuditResult = auditResult;
    auditResult = params.restoreLostAuditIssues(auditResult, {
      passed: reHasBlocked ? false : reAudit.passed,
      issues: [...reAudit.issues, ...reAITells.issues, ...reSensitive.issues],
      summary: reAudit.summary,
    });
    auditResult = applyLengthGateToAuditResult({
      auditResult,
      chapterContent: finalContent,
      lengthSpec: params.lengthSpec,
    }).auditResult;
    auditResult = applyScoreGateToAuditResult({
      auditResult,
      lengthSpec: params.lengthSpec,
    });
    const reviseAuditSummary = buildAuditRoundSummary(params.chapterNumber, auditResult);
    await params.onReviseComplete?.({
      round: reviseRound,
      maxReviseRounds,
      mode: reviseMode,
      reviseResult: reviseOutput,
      reviseAudit: reviseAuditSummary,
    });
    await params.onAuditComplete?.({
      round: auditRound,
      maxReviseRounds,
      audit: reviseAuditSummary,
    });
    priorRoundIssues = issuesForRound;
    if (!auditResult.passed && reAuditReturnedNoIssues) {
      const unresolvedBlockingIssues = hasBlockingIssues(auditResult.issues);
      const structuralRepairInProgress = hasRepairStructuralSignals(previousAuditResult.issues)
        || hasRepairStructuralSignals(auditResult.issues);
      if (!unresolvedBlockingIssues) {
        break;
      }
      if (structuralRepairInProgress && reviseRound < maxReviseRounds) {
        params.logWarn({
          zh: `第${reviseRound}轮重审返回空问题但仍未通过，判定为结构修复中间态，继续下一轮修订`,
          en: `Round ${reviseRound} re-audit returned no issues but still failed; treating as structural-repair intermediate state and continuing`,
        });
        continue;
      }
      break;
    }
    if (!auditResult.passed && reviseRound === maxReviseRounds) {
      stoppedByMaxRounds = true;
      stopReason = AUTO_REVIEW_STOP_REASON_MAX_ROUNDS;
    }
  }

  return {
    finalContent,
    finalWordCount,
    preAuditNormalizedWordCount: normalizedBeforeAudit.wordCount,
    revised,
    auditResult,
    totalUsage,
    postReviseCount,
    normalizeApplied,
    autoReview: {
      enabled: maxReviseRounds > 0,
      maxReviseRounds,
      reviseRoundsUsed,
      auditRounds: auditRound,
      stoppedByMaxRounds,
      ...(stopReason ? { stopReason } : {}),
    },
  };
}
