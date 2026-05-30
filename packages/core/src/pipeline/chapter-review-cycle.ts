import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideSoftRange } from "../utils/length-metrics.js";
import { countAuditIssueClasses, isStructuralAuditIssue, resolvePrimaryIssueClass, splitAuditIssuesByClass } from "../utils/audit-issue-classification.js";
import { validateHookLedger } from "../utils/hook-ledger-validator.js";
import { HOOK_HEALTH_DEFAULTS } from "../utils/hook-policy.js";

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

export interface ChapterReviewContext {
  readonly failureGate?: "critical" | "score" | "none";
  readonly score?: number;
  readonly passScoreThreshold?: number;
  readonly scoreShortfall?: number;
  readonly structureOverload?: {
    readonly enabled: boolean;
    readonly reason: string;
    readonly signals: ReadonlyArray<{
      readonly code: string;
      readonly severity: "warning" | "info";
      readonly message: string;
      readonly suggestion: string;
    }>;
  };
  readonly unresolvedIssueIdsFromPrevRound?: ReadonlyArray<string>;
  readonly mustFixFirstIssueIds?: ReadonlyArray<string>;
  readonly issueClassCounts?: Readonly<{
    structural: number;
    textual: number;
  }>;
  readonly primaryIssueClass?: "none" | "structural" | "textual" | "mixed";
  readonly dimensionChecks?: ReadonlyArray<{
    dimension: string;
    status: "pass" | "warning" | "failed";
    evidence?: string;
  }>;
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
const MAX_ADAPTIVE_REVISE_ROUNDS = 5;
const MAX_REVISE_TOTAL_TOKENS = 200_000;
const AUTO_REVIEW_STOP_REASON_MAX_ROUNDS = "达到自动修订轮次上限，仍未通过审计";
const AUTO_REVIEW_STOP_REASON_TOKEN_LIMIT = "修订消耗总 token 超过安全阈值，停止修订";
const MIN_AUDIT_PASS_SCORE = 80;
const AUTO_REVIEW_DEFAULT_MODE: ReviseMode = "spot-fix";
const STRUCTURAL_REPAIR_EXCLUDED_CATEGORIES = new Set(["篇幅控制", "Length Control", "评分门禁", "Score Gate"]);
const STRUCTURE_OVERLOAD_WARNING_THRESHOLD = 3;
const STRUCTURE_OVERLOAD_LOW_SCORE_THRESHOLD = 60;

export interface AuditSeverityCounts {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export interface AuditIssueClassCounts {
  readonly structural: number;
  readonly textual: number;
}

export interface IssueLifecycleSummary {
  readonly previousIssueCount: number;
  readonly unresolvedIssueCount: number;
  readonly partialIssueCount: number;
  readonly freshIssueCount: number;
  readonly resolvedIssueCount: number;
  readonly unresolvedIssueIds: ReadonlyArray<string>;
  readonly partialIssueDimensions: ReadonlyArray<string>;
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
  readonly issueLifecycle?: IssueLifecycleSummary;
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
  const raw = 100 - severityCounts.critical * 35 - severityCounts.warning * 12;
  return Math.max(0, Math.min(100, raw));
}

function countBlockingAITellIssues(issues: ReadonlyArray<{ readonly severity: AuditIssue["severity"] }>): number {
  return issues.filter((issue) => issue.severity === "warning").length;
}

function countIssueClasses(issues: ReadonlyArray<AuditIssue>): AuditIssueClassCounts {
  return countAuditIssueClasses(issues);
}

function applyScoreGateToAuditResult(params: {
  auditResult: AuditResult;
  lengthSpec: LengthSpec;
  previousScore?: number;
}): AuditResult {
  if (!params.auditResult.passed) return params.auditResult;
  const severityCounts = countIssueSeverities(params.auditResult.issues);
  const score = estimateAuditScore(severityCounts);
  if (score >= MIN_AUDIT_PASS_SCORE) return params.auditResult;

  // Remove any existing score gate issues — they are not useful revision targets.
  const filteredIssues = params.auditResult.issues.filter(
    (issue) => issue.category !== "评分门禁" && issue.category !== "Score Gate",
  );
  const scoreGateIssue: AuditIssue = {
    severity: "warning",
    category: "评分门禁",
    description: `审计评分低于通过阈值（${score}/${MIN_AUDIT_PASS_SCORE}）。`,
    suggestion: "请优先修复警告项并提升章节质量后再审计。",
  };

  return {
    ...params.auditResult,
    passed: false,
    issues: [...filteredIssues, scoreGateIssue],
  };
}

function buildAuditRoundSummary(
  chapterNumber: number,
  auditResult: AuditResult,
  previousBlockingIssues?: ReadonlyArray<AuditIssue>,
): AuditRoundSummary {
  const severityCounts = countIssueSeverities(auditResult.issues);
  const issueClassCounts = countIssueClasses(auditResult.issues);
  const currentBlockingIssues = auditResult.issues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  const issueLifecycle = previousBlockingIssues && previousBlockingIssues.length > 0
    ? (() => {
        const partition = partitionIssueCarryover(currentBlockingIssues, previousBlockingIssues);
        const previousIssueCount = previousBlockingIssues.length;
        const unresolvedIssueCount = partition.unresolved.length;
        const partialIssueCount = partition.partial.length;
        const freshIssueCount = partition.fresh.length;
        const resolvedIssueCount = Math.max(0, previousIssueCount - unresolvedIssueCount - partialIssueCount);
        const unresolvedIssueIds = collectIssueIds(partition.unresolved);
        const partialIssueDimensions = [...new Set(
          partition.partial.map((issue) => normalizeIssueDimensionForCompare(issue)),
        )];
        return {
          previousIssueCount,
          unresolvedIssueCount,
          partialIssueCount,
          freshIssueCount,
          resolvedIssueCount,
          unresolvedIssueIds,
          partialIssueDimensions,
        } satisfies IssueLifecycleSummary;
      })()
    : undefined;
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
    ...(issueLifecycle ? { issueLifecycle } : {}),
  };
}

function normalizeIssueIdForCompare(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toUpperCase();
  return /^(?:ISSUE-\d{2,}|PW-\d{3})$/u.test(normalized) ? normalized : fallback;
}

function normalizeIssueDimensionForCompare(issue: AuditIssue): string {
  const dimensionId = typeof issue.dimensionId === "string" && issue.dimensionId.trim().length > 0
    ? issue.dimensionId.trim()
    : issue.category;
  return dimensionId.toLowerCase();
}

function normalizeIssueSignatureForCompare(issue: AuditIssue): string {
  return `${issue.category}:${issue.description}`
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

interface IssueCarryoverPartition {
  readonly unresolved: ReadonlyArray<AuditIssue>;
  readonly partial: ReadonlyArray<AuditIssue>;
  readonly fresh: ReadonlyArray<AuditIssue>;
}

function partitionIssueCarryover(
  issues: ReadonlyArray<AuditIssue>,
  previousIssues: ReadonlyArray<AuditIssue>,
): IssueCarryoverPartition {
  if (issues.length === 0 || previousIssues.length === 0) {
    return {
      unresolved: [],
      partial: [],
      fresh: issues,
    };
  }

  const previousIds = new Set(
    previousIssues
      .map((issue) => normalizeIssueIdForCompare(issue.issueId))
      .filter((value) => value.length > 0),
  );
  const previousDimensions = new Set(previousIssues.map((issue) => normalizeIssueDimensionForCompare(issue)));
  const previousSignatures = new Set(previousIssues.map((issue) => normalizeIssueSignatureForCompare(issue)));

  const unresolved: AuditIssue[] = [];
  const partial: AuditIssue[] = [];
  const fresh: AuditIssue[] = [];

  for (const issue of issues) {
    const issueId = normalizeIssueIdForCompare(issue.issueId);
    const dimension = normalizeIssueDimensionForCompare(issue);
    const signature = normalizeIssueSignatureForCompare(issue);

    if ((issueId.length > 0 && previousIds.has(issueId)) || previousSignatures.has(signature)) {
      unresolved.push(issue);
      continue;
    }

    if (previousDimensions.has(dimension)) {
      partial.push(issue);
      continue;
    }

    fresh.push(issue);
  }

  return { unresolved, partial, fresh };
}

function prioritizeIssuesByCarryover(
  issues: ReadonlyArray<AuditIssue>,
  previousIssues: ReadonlyArray<AuditIssue>,
): ReadonlyArray<AuditIssue> {
  const partition = partitionIssueCarryover(issues, previousIssues);
  if (partition.unresolved.length === 0 && partition.partial.length === 0) {
    return issues;
  }
  return [...partition.unresolved, ...partition.partial, ...partition.fresh];
}

function collectIssueIds(issues: ReadonlyArray<AuditIssue>): ReadonlyArray<string> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, issue] of issues.entries()) {
    const issueId = normalizeIssueIdForCompare(issue.issueId, `ISSUE-${String(index + 1).padStart(2, "0")}`);
    if (!issueId || seen.has(issueId)) continue;
    seen.add(issueId);
    ids.push(issueId);
  }
  return ids;
}

function splitIssuesByClass(issues: ReadonlyArray<AuditIssue>): {
  structural: ReadonlyArray<AuditIssue>;
  textual: ReadonlyArray<AuditIssue>;
} {
  return splitAuditIssuesByClass(issues);
}

function resolveTextualReviseMode(
  issues: ReadonlyArray<AuditIssue>,
  reviseRound: number,
  failureGate?: "critical" | "score" | "none",
  scoreShortfall?: number,
): ReviseMode {
  const severity = countIssueSeverities(issues);
  if (severity.critical > 0) {
    // Textual critical issues often fail to converge with repeated spot-fix;
    // escalate after the first attempt to avoid no-op loops.
    return reviseRound <= 1 ? "spot-fix" : "rework";
  }
  if (reviseRound <= 1 && severity.critical === 0 && severity.warning >= 3) {
    if (failureGate === "score" && typeof scoreShortfall === "number" && scoreShortfall >= 8) {
      return "rewrite";
    }
    return "polish";
  }
  return "spot-fix";
}

function hasMeaningfulContentDelta(previous: string, next: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  return normalize(previous) !== normalize(next);
}

function isLengthOnlyIssues(issues: ReadonlyArray<AuditIssue>): boolean {
  if (issues.length === 0) return false;
  return issues.every((issue) =>
    issue.category === "篇幅控制" || issue.category === "Length Control"
  );
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

function shouldTriggerStructureOverload(params: {
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly score?: number;
  readonly preflightSignals?: ReadonlyArray<{
    readonly code: string;
    readonly severity: "warning" | "info";
    readonly message: string;
    readonly suggestion: string;
  }>;
}): { readonly enabled: boolean; readonly reason: string } {
  const structuralCount = params.issues.filter((issue) => isStructuralAuditIssue(issue)).length;
  const preflightHighRisk = params.preflightSignals?.some((signal) =>
    signal.code === "hook_debt_pressure" || signal.code === "volume_outline_missing" || signal.code === "volume_anchor_weak" || signal.code === "state_chapter_lag",
  ) ?? false;
  const lowScore = typeof params.score === "number" && params.score < STRUCTURE_OVERLOAD_LOW_SCORE_THRESHOLD;
  if (structuralCount >= STRUCTURE_OVERLOAD_WARNING_THRESHOLD && (preflightHighRisk || lowScore)) {
    return {
      enabled: true,
      reason: preflightHighRisk
        ? "预检已确认存在高风险结构债务，需直接按重构策略处理"
        : "结构性问题过多且评分偏低，需直接按重构策略处理",
    };
  }
  if (preflightHighRisk && lowScore && structuralCount > 0) {
    return {
      enabled: true,
      reason: "预检高风险信号与低评分叠加，需直接按重构策略处理",
    };
  }
  return { enabled: false, reason: "" };
}

function buildStructureOverloadSignalBlock(params: {
  readonly enabled: boolean;
  readonly reason: string;
  readonly preflightSignals?: ReadonlyArray<{
    readonly code: string;
    readonly severity: "warning" | "info";
    readonly message: string;
    readonly suggestion: string;
  }>;
}): ChapterReviewContext["structureOverload"] {
  if (!params.enabled) return undefined;
  return {
    enabled: true,
    reason: params.reason,
    signals: params.preflightSignals ?? [],
  };
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
  return Math.max(0, Math.min(MAX_ADAPTIVE_REVISE_ROUNDS, resolved));
}

function resolveAdaptiveReviseMode(
  configuredMode: ReviseMode,
  issues: ReadonlyArray<AuditIssue>,
  reviseRound: number,
  carryover?: IssueCarryoverPartition,
  reviseContext?: ChapterReviewContext,
): ReviseMode {
  if (configuredMode !== "spot-fix") return configuredMode;
  if (reviseRound > 1 && carryover && (carryover.unresolved.length > 0 || carryover.partial.length > 0)) {
    return hasStructuralAuditSignals([...carryover.unresolved, ...carryover.partial])
      ? "rework"
      : "rewrite";
  }
  if (!hasStructuralAuditSignals(issues)) {
    // Pure word-count deficiency: use rewrite (broader than spot-fix but lighter than rework)
    if (isLengthOnlyIssues(issues)) return "rewrite";
    const scoreShortfall = typeof reviseContext?.score === "number" && typeof reviseContext?.passScoreThreshold === "number"
      ? Math.max(0, Math.trunc(reviseContext.passScoreThreshold) - Math.trunc(reviseContext.score))
      : undefined;
    return resolveTextualReviseMode(issues, reviseRound, reviseContext?.failureGate, scoreShortfall);
  }
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
  previousWordCount?: number;
}): { auditResult: AuditResult; lengthOutOfBand: boolean } {
  const count = countChapterLength(params.chapterContent, params.lengthSpec.countingMode);
  const lengthOutOfBand = isOutsideSoftRange(count, params.lengthSpec);
  if (!lengthOutOfBand) {
    return { auditResult: params.auditResult, lengthOutOfBand: false };
  }

  // Trend-aware tolerance: if previous word count existed and current count
  // is converging toward the target range, skip re-adding the length warning
  // (avoids score gate oscillation when length is improving but not yet in range).
  if (typeof params.previousWordCount === "number" && params.previousWordCount > 0) {
    const target = params.lengthSpec.target;
    const prevDist = Math.abs(params.previousWordCount - target);
    const curDist = Math.abs(count - target);
    if (curDist < prevDist) {
      // Converging — don't add another length warning; it would only
      // penalize the score gate without helping convergence.
      return { auditResult: params.auditResult, lengthOutOfBand: true };
    }
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
        severity: "info",
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
      passed: params.auditResult.passed,
      issues,
      summary,
    },
    lengthOutOfBand: true,
  };
}

/**
 * Build an external-context block for the reviser when hook-budget violations
 * are detected in clear-debt mode. Tells the LLM exactly which hooks to recover.
 */
function buildHookDebtReviseBlock(ctx: {
  readonly requiredRecoverHooks: ReadonlyArray<string>;
  readonly staleDebt: ReadonlyArray<string>;
  readonly hardClearMode: boolean;
  readonly language: "zh" | "en";
}): string {
  const isEn = ctx.language === "en";
  const lines: string[] = [];

  if (isEn) {
    lines.push("## Hook Debt Recovery — Mandatory Revision Directive");
    if (ctx.hardClearMode) {
      lines.push(
        "⚠️ HARD CLEAR MODE: The hook pool is over its phase limit.",
        "This revision MUST reduce the active hook count. Do NOT introduce any new hooks.",
      );
    }
    if (ctx.requiredRecoverHooks.length > 0) {
      lines.push(
        "",
        "The following hooks MUST be explicitly resolved or meaningfully advanced in the revised chapter:",
        ...ctx.requiredRecoverHooks.map((id) => `- ${id}`),
      );
    }
    if (ctx.staleDebt.length > 0) {
      lines.push(
        "",
        "Additionally, these long-dormant hooks should be advanced if possible:",
        ...ctx.staleDebt.map((id) => `- ${id}`),
      );
    }
  } else {
    lines.push("## 伏笔清债修订指令（强制执行）");
    if (ctx.hardClearMode) {
      lines.push(
        "⚠️ 清债模式：伏笔池已超阶段上限。",
        "本次修订必须减少活跃伏笔数量，严禁新增任何伏笔。",
      );
    }
    if (ctx.requiredRecoverHooks.length > 0) {
      lines.push(
        "",
        "以下伏笔必须在修订后的正文中明确回收或有实质性推进：",
        ...ctx.requiredRecoverHooks.map((id) => `- ${id}`),
      );
    }
    if (ctx.staleDebt.length > 0) {
      lines.push(
        "",
        "此外，以下长期沉睡的伏笔应尽量推进：",
        ...ctx.staleDebt.map((id) => `- ${id}`),
      );
    }
  }

  return lines.join("\n");
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly externalContext?: string;
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
        externalContext?: string;
        chapterIntent?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
        reviseContext?: ChapterReviewContext;
        onRevisedContentDelta?: (text: string) => void;
        onSpotFixPatchDelta?: (text: string) => void;
        onThinkingDelta?: (text: string) => void;
        onThinkingEnd?: () => void;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly onThinkingDelta?: (text: string) => void;
  readonly onThinkingEnd?: () => void;
  readonly onRevisedContentDelta?: (text: string) => void;
  readonly onSpotFixPatchDelta?: (text: string) => void;
  readonly onReviserThinkingDelta?: (text: string) => void;
  readonly onReviserThinkingEnd?: () => void;
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
        previousAuditIssues?: ReadonlyArray<AuditIssue>;
        revisionClaims?: ReadonlyArray<string>;
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
  readonly preflightSignals?: ReadonlyArray<{
    readonly code: string;
    readonly severity: "warning" | "info";
    readonly message: string;
    readonly suggestion: string;
  }>;
  /**
   * Number of currently active (non-resolved, non-deferred) hooks in the pool.
   * Used by validateHookLedger to determine net-reduction mode when the pool
   * is over the phase limit. Defaults to 0 (normal mode) when not provided.
   */
  readonly activeHookCount?: number;
  /**
   * Hook debt context for clear-debt mode revisions.
   * When postWriteErrors contain hook-budget violations, this is injected into
   * the spot-fix reviser's externalContext so the LLM knows which hooks to recover.
   */
  readonly hookDebtContext?: {
    readonly requiredRecoverHooks: ReadonlyArray<string>;
    readonly staleDebt: ReadonlyArray<string>;
    readonly hardClearMode: boolean;
    readonly language: "zh" | "en";
  };
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
  readonly maxReviseRounds?: number;
  readonly unboundedReview?: boolean;
  readonly reviseMode?: ReviseMode;
  readonly onAuditStart?: (payload: { round: number; maxReviseRounds: number; unboundedReview?: boolean }) => void | Promise<void>;
  readonly onAuditComplete?: (payload: {
    round: number;
    maxReviseRounds: number;
    unboundedReview?: boolean;
    audit: AuditRoundSummary;
  }) => void | Promise<void>;
  readonly onReviseStart?: (payload: {
    round: number;
    maxReviseRounds: number;
    unboundedReview?: boolean;
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
    unboundedReview?: boolean;
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
  const unboundedReview = params.unboundedReview === true;
  const configuredMaxReviseRounds = Number.isFinite(Number(params.maxReviseRounds))
    ? Math.max(0, Math.trunc(Number(params.maxReviseRounds)))
    : DEFAULT_AUTO_REVISE_ROUNDS;
  const configuredReviseMode = params.reviseMode ?? AUTO_REVIEW_DEFAULT_MODE;
  let maxReviseRounds = Math.max(0, Math.min(MAX_ADAPTIVE_REVISE_ROUNDS, configuredMaxReviseRounds));

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
      ...(typeof violation.issueId === "string" && violation.issueId.trim().length > 0
        ? { issueId: violation.issueId.trim().toUpperCase() }
        : {}),
      ...(typeof violation.dimensionId === "string" && violation.dimensionId.trim().length > 0
        ? { dimensionId: violation.dimensionId.trim() }
        : {}),
    }));
    const spotFixIssueClassCounts = countIssueClasses(spotFixIssues);

    // Build hook-debt injection block when hook-budget violations are present.
    const hasHookBudgetViolation = params.initialOutput.postWriteErrors.some(
      (v) => v.rule === "hook-budget-net-debt" || v.rule === "hook-budget-recovery-floor",
    );
    const hookDebtReviseBlock = hasHookBudgetViolation && params.hookDebtContext
      ? buildHookDebtReviseBlock(params.hookDebtContext)
      : "";
    const spotFixExternalContext = [params.externalContext, hookDebtReviseBlock]
      .filter(Boolean)
      .join("\n\n") || undefined;

    const fixResult = await reviser.reviseChapter(
      params.bookDir,
      finalContent,
      params.chapterNumber,
      spotFixIssues,
      "spot-fix",
      params.book.genre,
      {
        ...params.reducedControlInput,
        externalContext: spotFixExternalContext,
        lengthSpec: params.lengthSpec,
        reviseContext: {
          failureGate: "critical",
          issueClassCounts: spotFixIssueClassCounts,
          primaryIssueClass: resolvePrimaryIssueClass(spotFixIssueClassCounts),
          mustFixFirstIssueIds: collectIssueIds(spotFixIssues),
          unresolvedIssueIdsFromPrevRound: collectIssueIds(spotFixIssues),
        },
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
          externalContext: params.externalContext,
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
  await params.onAuditStart?.({ round: auditRound, maxReviseRounds, unboundedReview });
  const llmAudit = await params.auditor.auditChapter(
    params.bookDir,
    finalContent,
    params.chapterNumber,
    params.book.genre,
    params.reducedControlInput
      ? { ...params.reducedControlInput, temperature: 0, onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd }
      : { temperature: 0, ...(params.onThinkingDelta || params.onThinkingEnd ? { onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd } : {}) },
  );
  totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
  const aiTellsInitial = params.analyzeAITells(finalContent);
  const sensitiveWriteResult = params.analyzeSensitiveWords(finalContent);
  const hasBlockedWriteWords = sensitiveWriteResult.found.some((item) => item.severity === "block");
  let previousAITellCount = countBlockingAITellIssues(aiTellsInitial.issues);
  let auditResult: AuditResult = {
    passed: hasBlockedWriteWords ? false : llmAudit.passed,
    issues: [...llmAudit.issues, ...aiTellsInitial.issues, ...sensitiveWriteResult.issues],
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
  // Hook ledger gate: validate that the draft actually acts on every hook the
  // planner committed to in the memo's "## 本章 hook 账" section. Violations
  // are injected as critical AuditIssues so they feed into the revise loop.
  if (params.reducedControlInput?.chapterIntent) {
    const hookLedgerViolations = validateHookLedger(
      params.reducedControlInput.chapterIntent,
      finalContent,
      params.activeHookCount ?? 0,
      HOOK_HEALTH_DEFAULTS.maxActiveHooks,
    );
    if (hookLedgerViolations.length > 0) {
      const hookLedgerIssues: AuditIssue[] = hookLedgerViolations.map((v) => ({
        severity: v.severity,
        category: v.category,
        description: v.description,
        suggestion: v.suggestion,
      }));
      auditResult = {
        ...auditResult,
        passed: false,
        issues: [...auditResult.issues, ...hookLedgerIssues],
        summary: auditResult.summary
          ? `${auditResult.summary}\n${hookLedgerIssues.map((i) => i.description).join("\n")}`
          : hookLedgerIssues.map((i) => i.description).join("\n"),
      };
    }
  }
  maxReviseRounds = resolveAdaptiveMaxReviseRounds(configuredMaxReviseRounds, auditResult.issues);
  await params.onAuditComplete?.({
    round: auditRound,
    maxReviseRounds,
    unboundedReview,
    audit: buildAuditRoundSummary(params.chapterNumber, auditResult),
  });

  let priorRoundIssues: ReadonlyArray<AuditIssue> = auditResult.issues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  let priorAuditScore = estimateAuditScore(countIssueSeverities(auditResult.issues));
  let priorWordCount = finalWordCount;
  let reviseRoundsUsed = 0;
  let stoppedByMaxRounds = false;
  let stopReason: string | undefined;
  let previousSpotFixHadNoDelta = false;
  const reviseLoopStartTokens = totalUsage.totalTokens;
  const structureOverload = shouldTriggerStructureOverload({
    issues: auditResult.issues,
    score: estimateAuditScore(countIssueSeverities(auditResult.issues)),
    preflightSignals: params.preflightSignals,
  });
  for (let reviseRound = 1; (unboundedReview || reviseRound <= maxReviseRounds) && !auditResult.passed; reviseRound += 1) {
    // Token safety valve: prevent runaway consumption in high-round scenarios
      if (totalUsage.totalTokens - reviseLoopStartTokens > MAX_REVISE_TOTAL_TOKENS) {
        stoppedByMaxRounds = true;
        stopReason = AUTO_REVIEW_STOP_REASON_TOKEN_LIMIT;
        break;
      }
    const blockingIssues = auditResult.issues.filter(
      (issue) => issue.severity === "critical" || issue.severity === "warning",
    );
    if (blockingIssues.length === 0) {
      break;
    }
    reviseRoundsUsed = reviseRound;
    const reviser = params.createReviser();
    const carryover = reviseRound > 1
      ? partitionIssueCarryover(blockingIssues, priorRoundIssues)
      : null;
    const unresolvedPrioritizedIssues = reviseRound > 1
      ? prioritizeIssuesByCarryover(blockingIssues, priorRoundIssues)
      : blockingIssues;
    const issuesForRound = resolveAdaptiveIssuesForRound(
      configuredReviseMode,
      unresolvedPrioritizedIssues,
      reviseRound,
    );
    const issueClassCounts = countIssueClasses(issuesForRound);
    const primaryIssueClass = resolvePrimaryIssueClass(issueClassCounts);
    const persistentIssues = carryover ? [...carryover.unresolved, ...carryover.partial] : [];
    const structuralPriorityIssues = issuesForRound.filter((issue) => isStructuralAuditIssue(issue));
    const mustFixFirstSource = structuralPriorityIssues.length > 0 ? structuralPriorityIssues : issuesForRound;
    const scoreShortfall = Math.max(0, MIN_AUDIT_PASS_SCORE - priorAuditScore);
    const reviseContext: ChapterReviewContext = {
      failureGate: countIssueSeverities(blockingIssues).critical > 0 ? "critical" as const : "score" as const,
      score: priorAuditScore,
      passScoreThreshold: MIN_AUDIT_PASS_SCORE,
      scoreShortfall,
      structureOverload: buildStructureOverloadSignalBlock({
        enabled: structureOverload.enabled,
        reason: structureOverload.reason,
        preflightSignals: params.preflightSignals,
      }),
      issueClassCounts,
      primaryIssueClass,
      dimensionChecks: auditResult.dimensionChecks,
      unresolvedIssueIdsFromPrevRound: collectIssueIds(persistentIssues),
      mustFixFirstIssueIds: collectIssueIds(mustFixFirstSource.slice(0, 3)),
    };
    let reviseMode = resolveAdaptiveReviseMode(
      configuredReviseMode,
      issuesForRound,
      reviseRound,
      carryover ?? undefined,
      reviseContext,
    );
    if (structureOverload.enabled && reviseMode === "spot-fix") {
      reviseMode = "rework";
      params.logWarn({
        zh: `检测到结构过载：${structureOverload.reason}，本轮直接切换为rework`,
        en: `Structure overload detected: ${structureOverload.reason}; switching directly to rework for this round`,
      });
    }
    if (configuredReviseMode === "spot-fix" && reviseRound > 1 && carryover && (carryover.unresolved.length > 0 || carryover.partial.length > 0)) {
      const persistentIssuesForMode = [...carryover.unresolved, ...carryover.partial];
      reviseMode = hasStructuralAuditSignals(persistentIssuesForMode) ? "rework" : "rewrite";
      params.logWarn({
        zh: `第${reviseRound}轮仍有 ${persistentIssuesForMode.length} 个未收敛问题，切换为${reviseMode}以避免 spot-fix 空转`,
        en: `Round ${reviseRound} still has ${persistentIssuesForMode.length} unresolved/partial issue(s); switching to ${reviseMode} to avoid spot-fix churn`,
      });
    }
    // Early escalation: if previous round's spot-fix made no meaningful delta,
    // skip straight to rewrite instead of waiting for the final round.
    if (reviseMode === "spot-fix" && previousSpotFixHadNoDelta) {
      params.logWarn({
        zh: `第${reviseRound - 1}轮spot-fix未产生有效改动，提前升级为rewrite`,
        en: `Round ${reviseRound - 1} spot-fix made no meaningful change; early escalating to rewrite`,
      });
      reviseMode = "rewrite";
    }
    // On the final round, escalate to rewrite for a stronger convergence attempt
    if (!unboundedReview && reviseMode === "spot-fix" && reviseRound >= maxReviseRounds) {
      reviseMode = "rewrite";
    }
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
      unboundedReview,
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
        externalContext: params.externalContext,
        lengthSpec: params.lengthSpec,
        reviseContext,
        onRevisedContentDelta: params.onRevisedContentDelta,
        onSpotFixPatchDelta: params.onSpotFixPatchDelta,
        onThinkingDelta: params.onReviserThinkingDelta,
        onThinkingEnd: params.onReviserThinkingEnd,
      },
    );
    totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);
    if (reviseOutput.revisedContent.length === 0) {
      await params.onReviseComplete?.({
        round: reviseRound,
        maxReviseRounds,
        unboundedReview,
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
    const preMarkerCount = countBlockingAITellIssues(preMarkers.issues);
    const postMarkerCount = countBlockingAITellIssues(postMarkers.issues);
    const contentChanged = hasMeaningfulContentDelta(finalContent, normalizedRevision.content);
    // Track ineffective spot-fix for early mode escalation in the next round
    if (reviseMode === "spot-fix" && !contentChanged) {
      previousSpotFixHadNoDelta = true;
    } else {
      previousSpotFixHadNoDelta = false;
    }
    if (postMarkerCount <= preMarkerCount + 1 && contentChanged) {
      finalContent = normalizedRevision.content;
      finalWordCount = normalizedRevision.wordCount;
      revised = true;
      params.assertChapterContentNotEmpty(finalContent, `revision round ${reviseRound}`);
    }

    auditRound = reviseRound + 1;
    await params.onAuditStart?.({ round: auditRound, maxReviseRounds, unboundedReview });
    const reAudit = await params.auditor.auditChapter(
      params.bookDir,
      finalContent,
      params.chapterNumber,
      params.book.genre,
      params.reducedControlInput
        ? { ...params.reducedControlInput, temperature: 0, onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd, previousAuditIssues: priorRoundIssues, revisionClaims: reviseOutput.fixedIssues.length > 0 ? reviseOutput.fixedIssues : undefined }
        : { temperature: 0, ...(params.onThinkingDelta || params.onThinkingEnd ? { onThinkingDelta: params.onThinkingDelta, onThinkingEnd: params.onThinkingEnd } : {}), previousAuditIssues: priorRoundIssues, revisionClaims: reviseOutput.fixedIssues.length > 0 ? reviseOutput.fixedIssues : undefined },
    );
    totalUsage = params.addUsage(totalUsage, reAudit.tokenUsage);
    const reAuditReturnedNoIssues = Array.isArray(reAudit.issues) && reAudit.issues.length === 0;
    const reAITells = params.analyzeAITells(finalContent);
    // Only inject AI-tell issues on re-audit if the count worsened, to prevent
    // the reviser from being penalized by the same or diminishing AI markers
    // across rounds (which creates a convergence deadlock).
    const reAITellCount = countBlockingAITellIssues(reAITells.issues);
    const aiTellWorsened = reAITellCount > previousAITellCount;
    const aiTellIssuesForRound = aiTellWorsened
      ? reAITells.issues
      : [];
    previousAITellCount = reAITellCount;
    const reSensitive = params.analyzeSensitiveWords(finalContent);
    const reHasBlocked = reSensitive.found.some((item) => item.severity === "block");
    const previousAuditResult = auditResult;
    auditResult = params.restoreLostAuditIssues(auditResult, {
      passed: reHasBlocked ? false : reAudit.passed,
      issues: [...reAudit.issues, ...aiTellIssuesForRound, ...reSensitive.issues],
      summary: reAudit.summary,
    });
    auditResult = applyLengthGateToAuditResult({
      auditResult,
      chapterContent: finalContent,
      lengthSpec: params.lengthSpec,
      previousWordCount: priorWordCount,
    }).auditResult;
    auditResult = applyScoreGateToAuditResult({
    auditResult,
    lengthSpec: params.lengthSpec,
    previousScore: auditRound > 1 ? priorAuditScore : undefined,
  });
    const reviseAuditSummary = buildAuditRoundSummary(params.chapterNumber, auditResult, priorRoundIssues);
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
      unboundedReview,
      audit: reviseAuditSummary,
    });
    priorRoundIssues = auditResult.issues.filter(
      (issue) => issue.severity === "critical" || issue.severity === "warning",
    );
    priorAuditScore = estimateAuditScore(countIssueSeverities(auditResult.issues));
    priorWordCount = finalWordCount;
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
      if (structureOverload.enabled && reviseRound < maxReviseRounds) {
        params.logWarn({
          zh: `第${reviseRound}轮仍未通过且存在结构过载信号，继续下一轮重构修复`,
          en: `Round ${reviseRound} still failed with structure overload signals; continuing the next reconstruction round`,
        });
        continue;
      }
      break;
    }
    if (!unboundedReview && !auditResult.passed && reviseRound === maxReviseRounds) {
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
      enabled: unboundedReview || maxReviseRounds > 0,
      maxReviseRounds,
      reviseRoundsUsed,
      auditRounds: auditRound,
      stoppedByMaxRounds,
      ...(stopReason ? { stopReason } : {}),
    },
  };
}
