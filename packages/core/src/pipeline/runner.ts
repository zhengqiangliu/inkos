import type { LLMClient, OnStreamProgress } from "../llm/provider.js";
import { chatCompletion, createLLMClient } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { NotifyChannel, LLMConfig, AgentLLMOverride, InputGovernanceMode } from "../models/project.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { ArchitectAgent, type ArchitectOutput } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { ComposerAgent } from "../agents/composer.js";
import { WriterAgent, type WriteChapterInput, type WriteChapterOutput } from "../agents/writer.js";
import { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReviserAgent, DEFAULT_REVISE_MODE, type ReviseMode, type ReviseOutput } from "../agents/reviser.js";
import { StateValidatorAgent, type ValidationResult, type ValidationWarning } from "../agents/state-validator.js";
import { RadarAgent } from "../agents/radar.js";
import type { RadarSource } from "../agents/radar-source.js";
import { readBookRules, readGenreProfile } from "../agents/rules-reader.js";
import { analyzeAITells } from "../agents/ai-tells.js";
import { analyzeSensitiveWords } from "../agents/sensitive-words.js";
import { resolveDialogueQuotePolicy as resolveBookDialogueQuotePolicy } from "../utils/dialogue-quote-policy.js";
import { StateManager } from "../state/manager.js";
import { MemoryDB, type Fact, type StoredHook } from "../state/memory-db.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { RadarResult } from "../agents/radar.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import { buildLengthSpec, countChapterLength, formatLengthCount, isOutsideHardRange, isOutsideSoftRange, resolveLengthCountingMode, type LengthLanguage } from "../utils/length-metrics.js";
import { analyzeLongSpanFatigue } from "../utils/long-span-fatigue.js";
import { readStoryFrame, readVolumeMap } from "../utils/outline-paths.js";
import { loadNarrativeMemorySeed, loadRuntimeStateSnapshot, loadSnapshotCurrentStateFacts, type NarrativeMemorySeed } from "../state/runtime-state-store.js";
import { rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { classifyAuditIssueClass, countAuditIssueClasses, isStructuralAuditIssue } from "../utils/audit-issue-classification.js";
import { appendFile, readFile, readdir, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseStateDegradedReviewNote,
  resolveStateDegradedBaseStatus,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";
import { buildChapterAuditHistoryEntry, persistChapterArtifacts } from "./chapter-persistence.js";
import { runChapterReviewCycle } from "./chapter-review-cycle.js";
import { validateChapterTruthPersistence } from "./chapter-truth-validation.js";
import { loadPersistedPlan, relativeToBookDir } from "./persisted-governed-plan.js";
import { ChapterPlanSchema, type ChapterPlan } from "../models/chapter-plan.js";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";
import { deriveHookDebtBudget, filterActiveHooks, resolveStoryPhase } from "../utils/hook-agenda.js";
import { HOOK_POOL_PHASE_LIMITS } from "../utils/hook-policy.js";

const SEQUENCE_LEVEL_CATEGORIES = new Set([
  "Pacing Monotony", "节奏单调",
  "Mood Monotony", "情绪单调",
  "Title Collapse", "标题重复",
  "Title Clustering", "标题聚集",
  "Opening Pattern Repetition", "开头同构",
  "Ending Pattern Repetition", "结尾同构",
]);

const FACT_HISTORY_SYNC_PROGRESS_FILE = "current_state_fact_sync.json";
const NARRATIVE_MEMORY_SYNC_PROGRESS_FILE = "narrative_memory_sync.json";
const AUDIT_FAILURE_HISTORY_FILE = "audit_failure_history.json";

interface AuditFailureHistoryEntry {
  readonly chapterNumber: number;
  readonly issues: ReadonlyArray<{
    readonly category: string;
    readonly severity: AuditIssue["severity"];
    readonly dimensionId?: string;
    readonly suggestion?: string;
  }>;
  readonly recordedAt: string;
}

interface AuditFailureHistoryPayload {
  readonly version: 2;
  readonly entries: ReadonlyArray<AuditFailureHistoryEntry>;
}

function isSequenceLevelCategory(category: string): boolean {
  return SEQUENCE_LEVEL_CATEGORIES.has(category);
}

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly defaultLLMConfig?: LLMConfig;
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly radarSources?: ReadonlyArray<RadarSource>;
  readonly externalContext?: string;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly inputGovernanceMode?: InputGovernanceMode;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onWriterTextDelta?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly text: string;
    readonly mode: "write-next" | "draft";
  }) => void;
  readonly onReviserTextDelta?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly text: string;
    readonly mode: ReviseMode;
  }) => void;
  readonly onReviserPatchDelta?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly text: string;
    readonly mode: ReviseMode;
  }) => void;
  readonly onReviserThinkingDelta?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly mode: ReviseMode;
    readonly text: string;
  }) => void;
  readonly onReviserThinkingEnd?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly mode: ReviseMode;
  }) => void;
  readonly onAuditorTextDelta?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly text: string;
  }) => void;
  readonly onAuditorThinkingEnd?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
  }) => void;
  readonly onTaskSignal?: (signal: {
    readonly kind: "log" | "audit:start" | "audit:complete" | "revise:start" | "revise:complete";
    readonly level?: "info" | "warn";
    readonly message?: string;
    readonly bookId?: string;
    readonly chapterNumber?: number;
    readonly round?: number;
    readonly maxReviseRounds?: number;
    readonly unboundedReview?: boolean;
    readonly phase?: "audit" | "revise";
    readonly mode?: ReviseMode;
    readonly passed?: boolean;
    readonly issueCount?: number;
    readonly score?: number;
    readonly wordCount?: number;
    readonly applied?: boolean;
    readonly summary?: string;
  }) => void;
  readonly onWriteNextAuditStart?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly round: number;
    readonly maxReviseRounds: number;
    readonly phase: "audit";
    readonly unboundedReview?: boolean;
  }) => void | Promise<void>;
  readonly onWriteNextAuditComplete?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly round: number;
    readonly maxReviseRounds: number;
    readonly phase: "audit";
    readonly audit: ReviseAuditSummary;
    readonly unboundedReview?: boolean;
  }) => void | Promise<void>;
  readonly onWriteNextReviseStart?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly round: number;
    readonly maxReviseRounds: number;
    readonly phase: "revise";
    readonly mode: ReviseMode;
    readonly unboundedReview?: boolean;
  }) => void | Promise<void>;
  readonly onWriteNextReviseComplete?: (payload: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly round: number;
    readonly maxReviseRounds: number;
    readonly phase: "revise";
    readonly mode: ReviseMode;
    readonly wordCount: number;
    readonly applied: boolean;
    readonly audit?: ReviseAuditSummary;
    readonly unboundedReview?: boolean;
  }) => void | Promise<void>;
  readonly defaultWriteNextQuickMode?: boolean;
  readonly writeStageHeartbeatMs?: number;
  readonly enforceOutlineAnchorMatch?: boolean;
}

type DialogueQuotePolicyMode = "auto" | "force_double" | "force_corner" | "force_none";

function normalizeDialogueQuotesByPolicy(
  content: string,
  mode: DialogueQuotePolicyMode,
): string {
  if (mode === "force_double") {
    return content
      .replace(/「/g, "“")
      .replace(/」/g, "”")
      .replace(/『/g, "“")
      .replace(/』/g, "”");
  }
  if (mode === "force_corner") {
    return content
      .replace(/“/g, "「")
      .replace(/”/g, "」")
      .replace(/『/g, "「")
      .replace(/』/g, "」");
  }
  return content;
}

function normalizeContentForTruthRebuildCompare(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/，/g, ",")
    .replace(/。/g, ".")
    .replace(/！/g, "!")
    .replace(/？/g, "?")
    .replace(/：/g, ":")
    .replace(/；/g, ";")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .replace(/《/g, "<")
    .replace(/》/g, ">")
    .replace(/、/g, ",")
    .replace(/[“”„‟«»]/g, "\"")
    .replace(/[「」『』]/g, "\"")
    .replace(/[‘’‚‛‹›]/g, "'")
    .replace(/\s+/gu, "");
}

function isNonStructuralTruthContentChange(previous: string, next: string): boolean {
  if (previous === next) return false;
  return normalizeContentForTruthRebuildCompare(previous) === normalizeContentForTruthRebuildCompare(next);
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterPipelineResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly autoReview?: {
    readonly enabled: boolean;
    readonly maxReviseRounds: number;
    readonly reviseRoundsUsed: number;
    readonly auditRounds: number;
    readonly stoppedByMaxRounds: boolean;
    readonly finalState: "passed" | "failed-max-rounds" | "failed-single-audit";
    readonly stopReason?: string;
  };
  readonly structuralIssueCount?: number;
  readonly textualIssueCount?: number;
  readonly revised: boolean;
  readonly status: "ready-for-review" | "audit-failed" | "state-degraded";
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
  readonly performance?: {
    readonly totalMs: number;
    readonly inputPrepMs: number;
    readonly writingMs: number;
    readonly auditMs: number;
    readonly reviseMs: number;
    readonly truthRebuildMs: number;
    readonly stateValidationMs: number;
    readonly indexSyncMs: number;
  };
}

export interface WriteNextChapterOptions {
  readonly quickMode?: boolean;
  readonly skipStateValidation?: boolean;
  readonly deferMemorySync?: boolean;
  readonly deferSnapshotSync?: boolean;
  readonly allowPendingAuditFailure?: boolean;
  readonly unboundedReview?: boolean;
}

// Atomic operation results
export interface DraftResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly filePath: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
}

export interface PlanChapterResult {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly intentPath: string;
  readonly goal: string;
  readonly conflicts: ReadonlyArray<string>;
}

export interface ComposeChapterResult extends PlanChapterResult {
  readonly contextPath: string;
  readonly ruleStackPath: string;
  readonly tracePath: string;
}

export interface ReviseResult {
  readonly chapterNumber: number;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly applied: boolean;
  readonly status: "unchanged" | "ready-for-review" | "audit-failed";
  readonly skippedReason?: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly audit?: ReviseAuditSummary;
}

export interface ReviseAuditSummary {
  readonly passed: boolean;
  readonly score: number;
  readonly issueCount: number;
  readonly severityCounts: Readonly<{
    critical: number;
    warning: number;
    info: number;
  }>;
  readonly dimensionChecks?: ReadonlyArray<{
    readonly dimension: string;
    readonly status: "pass" | "warning" | "failed";
    readonly evidence?: string;
  }>;
  readonly issueClassCounts?: Readonly<{
    structural: number;
    textual: number;
  }>;
  readonly primaryIssueClass?: "none" | "structural" | "textual" | "mixed";
  readonly summary?: string;
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly report?: string;
}

export interface ReviseDraftOptions {
  readonly overrideIssues?: ReadonlyArray<AuditIssue>;
  readonly userBrief?: string;
  readonly reviseContext?: {
    readonly failureGate?: "critical" | "score" | "none";
    readonly score?: number;
    readonly passScoreThreshold?: number;
    readonly scoreShortfall?: number;
    readonly unresolvedIssueIdsFromPrevRound?: ReadonlyArray<string>;
    readonly mustFixFirstIssueIds?: ReadonlyArray<string>;
    readonly issueClassCounts?: Readonly<{
      structural: number;
      textual: number;
    }>;
    readonly primaryIssueClass?: "none" | "structural" | "textual" | "mixed";
    readonly previousRevisionWasNoop?: boolean;
    readonly dimensionChecks?: ReadonlyArray<{
      readonly dimension: string;
      readonly status: "pass" | "warning" | "failed";
      readonly evidence?: string;
    }>;
  };
}

export interface TruthFiles {
  readonly currentState: string;
  readonly particleLedger: string;
  readonly pendingHooks: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
}

export interface BookStatusInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

interface MergedAuditEvaluation {
  readonly auditResult: AuditResult;
  readonly aiTellCount: number;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

interface ReviewPreflightSignal {
  readonly code: string;
  readonly severity: "warning" | "info";
  readonly message: string;
  readonly suggestion: string;
}

interface ReviewPreflightResult {
  readonly target: "write-next" | "revise";
  readonly chapterNumber: number;
  readonly signals: ReadonlyArray<ReviewPreflightSignal>;
}

class OutlineAnchorMismatchError extends Error {
  readonly chapterNumber: number;

  constructor(chapterNumber: number, message: string) {
    super(message);
    this.name = "OutlineAnchorMismatchError";
    this.chapterNumber = chapterNumber;
  }
}

interface ReducedAuditControlInput {
  readonly chapterIntent: string;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

function countAuditIssueSeverities(issues: ReadonlyArray<AuditIssue>): Readonly<{
  critical: number;
  warning: number;
  info: number;
}> {
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

function estimateAuditScore(severityCounts: Readonly<{ critical: number; warning: number; info: number }>): number {
  const raw = 100 - severityCounts.critical * 35 - severityCounts.warning * 12;
  return Math.max(0, Math.min(100, raw));
}

function countBlockingAITellIssues(issues: ReadonlyArray<{ readonly severity: "warning" | "info" }>): number {
  return issues.filter((issue) => issue.severity === "warning").length;
}

const MIN_AUDIT_PASS_SCORE = 80;

const AUTO_REVIEW_FINAL_NOTE_PREFIX = "[auto-review-final]";

function buildReviseAuditSummaryFromResult(
  auditResult: AuditResult,
): ReviseAuditSummary {
  const severityCounts = countAuditIssueSeverities(auditResult.issues);
  const issueCount = Array.isArray(auditResult.issues) ? auditResult.issues.length : 0;
  return {
    passed: auditResult.passed,
    score: estimateAuditScore(severityCounts),
    issueCount,
    severityCounts,
    ...(Array.isArray(auditResult.dimensionChecks) && auditResult.dimensionChecks.length > 0
      ? { dimensionChecks: auditResult.dimensionChecks }
      : {}),
    summary: auditResult.summary?.trim() ? auditResult.summary.trim() : undefined,
    issues: auditResult.issues,
    report: buildAuditReportText(auditResult, severityCounts, issueCount),
  };
}

function buildAuditReportText(
  auditResult: AuditResult,
  severityCounts: Readonly<{ critical: number; warning: number; info: number }>,
  issueCount: number,
): string {
  const score = estimateAuditScore(severityCounts);
  const lines = [
    auditResult.passed
      ? issueCount > 0
        ? `审计通过，发现${issueCount}项非阻断问题。`
        : "审计通过。"
      : `审计未通过，共${issueCount}项问题。`,
    `审计评分：${score}/100（严重 ${severityCounts.critical} / 警告 ${severityCounts.warning} / 提示 ${severityCounts.info}）`,
  ];
  const summary = auditResult.summary?.trim();
  if (summary) {
    lines.push(`审计报告：${summary}`);
  }
  if (auditResult.issues.length > 0) {
    lines.push("问题清单：");
    for (const [index, issue] of auditResult.issues.entries()) {
      lines.push(`${index + 1}. [${issue.severity}] ${issue.category} - ${issue.description}`);
    }
  }
  return lines.join("\n");
}

function buildAutoReviewFinalNote(args: {
  finalState: "failed-max-rounds" | "failed-single-audit";
  stopReason?: string;
  audit: Pick<ReviseAuditSummary, "score" | "issueCount" | "summary">;
}): string {
  const summaryText = typeof args.audit.summary === "string" ? args.audit.summary.trim() : "";
  const summarySegment = summaryText
    ? `；摘要：${summaryText.slice(0, 180)}`
    : "";
  const reasonText = args.stopReason?.trim()
    || (args.finalState === "failed-max-rounds"
      ? "达到自动修订轮次上限，仍未通过审计"
      : "单次审计未通过");
  return `${AUTO_REVIEW_FINAL_NOTE_PREFIX} 自动审计未通过（${reasonText}）；评分 ${args.audit.score}/100；问题 ${args.audit.issueCount} 项${summarySegment}`;
}

function countIssueClassesForMetrics(issues: ReadonlyArray<AuditIssue>): Readonly<{
  structural: number;
  textual: number;
}> {
  return countAuditIssueClasses(issues);
}

function normalizeTruthPayload(payload: string | undefined): string | undefined {
  if (typeof payload !== "string") return undefined;
  const trimmed = payload.trim();
  if (trimmed.length === 0) return undefined;
  const placeholders = new Set([
    "(状态卡未更新)",
    "(账本未更新)",
    "(伏笔池未更新)",
    "(state card not updated)",
    "(ledger not updated)",
    "(hooks pool not updated)",
  ]);
  if (placeholders.has(trimmed)) return undefined;
  return payload;
}

export interface ImportChaptersInput {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportChaptersResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}

export interface InitBookOptions {
  readonly externalContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
  readonly foundationBrief?: string;
}

export class PipelineRunner {
  private readonly state: StateManager;
  private readonly config: PipelineConfig;
  private readonly agentClients = new Map<string, LLMClient>();
  private memoryIndexFallbackWarned = false;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private buildReviseAuditSummary(auditResult: AuditResult): ReviseAuditSummary {
    const severityCounts = countAuditIssueSeverities(auditResult.issues);
    return {
      passed: auditResult.passed,
      score: estimateAuditScore(severityCounts),
      issueCount: auditResult.issues.length,
      severityCounts,
      summary: auditResult.summary?.trim() ? auditResult.summary.trim() : undefined,
      issues: auditResult.issues,
    };
  }

  private async readAuditFailureHistory(bookDir: string): Promise<AuditFailureHistoryPayload> {
    const historyPath = join(bookDir, "story", AUDIT_FAILURE_HISTORY_FILE);
    const raw = await readFile(historyPath, "utf-8").catch(() => "");
    if (!raw.trim()) {
      return { version: 2, entries: [] };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<AuditFailureHistoryPayload> & {
        readonly entries?: Array<{
          readonly chapterNumber?: unknown;
          readonly recordedAt?: unknown;
          readonly categories?: unknown;
          readonly issues?: unknown;
        }>;
      };
      if (!parsed || !Array.isArray(parsed.entries)) {
        return { version: 2, entries: [] };
      }
      const entries = parsed.entries
        .filter((entry): entry is AuditFailureHistoryEntry => Boolean(
          entry
          && Number.isFinite(Number(entry.chapterNumber))
          && typeof entry.recordedAt === "string",
        ))
        .map((entry: {
          readonly chapterNumber?: unknown;
          readonly recordedAt: string;
          readonly categories?: unknown;
          readonly issues?: unknown;
        }) => ({
          chapterNumber: Math.max(1, Math.trunc(Number(entry.chapterNumber))),
          issues: Array.isArray(entry.issues)
            ? entry.issues
              .filter((issue): issue is { readonly category: string; readonly severity: AuditIssue["severity"]; readonly dimensionId?: string; readonly suggestion?: string } => Boolean(
                issue
                && typeof issue === "object"
                && typeof (issue as { category?: unknown }).category === "string"
                && typeof (issue as { severity?: unknown }).severity === "string",
              ))
              .map((issue) => ({
                category: issue.category.trim(),
                severity: issue.severity === "critical" || issue.severity === "warning" || issue.severity === "info"
                  ? issue.severity
                  : "warning",
                ...(typeof issue.dimensionId === "string" && issue.dimensionId.trim().length > 0
                  ? { dimensionId: issue.dimensionId.trim() }
                  : {}),
                ...(typeof issue.suggestion === "string" && issue.suggestion.trim().length > 0
                  ? { suggestion: issue.suggestion.trim() }
                  : {}),
              }))
              : Array.isArray(entry.categories)
                ? entry.categories
                  .filter((category): category is string => typeof category === "string" && category.trim().length > 0)
                  .map((category) => ({
                    category: category.trim(),
                    severity: "warning" as const,
                  }))
                : [],
          recordedAt: entry.recordedAt,
        }))
        .filter((entry) => entry.issues.length > 0);
      return { version: 2, entries };
    } catch {
      return { version: 2, entries: [] };
    }
  }

  private async writeAuditFailureHistory(bookDir: string, payload: AuditFailureHistoryPayload): Promise<void> {
    const historyPath = join(bookDir, "story", AUDIT_FAILURE_HISTORY_FILE);
    await writeFile(historyPath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private async recordAuditFailureHistory(bookDir: string, chapterNumber: number, auditResult: AuditResult): Promise<void> {
    const severityRank: Record<AuditIssue["severity"], number> = {
      critical: 2,
      warning: 1,
      info: 0,
    };
    const issueMap = new Map<string, {
      category: string;
      severity: AuditIssue["severity"];
      dimensionId?: string;
      suggestion?: string;
    }>();

    for (const issue of auditResult.issues) {
      if (issue.severity !== "critical" && issue.severity !== "warning") continue;
      const category = typeof issue.category === "string" ? issue.category.trim() : "";
      if (!category) continue;
      const dimensionId = typeof issue.dimensionId === "string" && issue.dimensionId.trim().length > 0
        ? issue.dimensionId.trim()
        : undefined;
      const suggestion = typeof issue.suggestion === "string" && issue.suggestion.trim().length > 0
        ? issue.suggestion.trim()
        : undefined;
      const current = issueMap.get(category);
      if (!current) {
        issueMap.set(category, { category, severity: issue.severity, ...(dimensionId ? { dimensionId } : {}), ...(suggestion ? { suggestion } : {}) });
        continue;
      }
      if (severityRank[issue.severity] > severityRank[current.severity]) {
        issueMap.set(category, { category, severity: issue.severity, ...(dimensionId ? { dimensionId } : {}), ...(suggestion ? { suggestion } : {}) });
        continue;
      }
      if (!current.dimensionId && dimensionId) {
        current.dimensionId = dimensionId;
      }
      if (!current.suggestion && suggestion) {
        current.suggestion = suggestion;
      }
    }

    const issues = [...issueMap.values()];
    if (issues.length === 0) return;

    const current = await this.readAuditFailureHistory(bookDir);
    const entries = [...current.entries.filter((entry) => entry.chapterNumber !== chapterNumber)];
    entries.push({
      chapterNumber,
      issues,
      recordedAt: new Date().toISOString(),
    });
    entries.sort((left, right) => left.chapterNumber - right.chapterNumber);
    await this.writeAuditFailureHistory(bookDir, { version: 2, entries });
  }

  private async buildAuditFailureHints(bookDir: string): Promise<string | undefined> {
    const history = await this.readAuditFailureHistory(bookDir);
    if (history.entries.length === 0) return undefined;

    type FailureStats = {
      readonly category: string;
      dimensionId?: string;
      suggestion?: string;
      critical: number;
      warning: number;
      chapters: number[];
    };

    const stats = new Map<string, FailureStats>();
    for (const entry of history.entries.slice(-8)) {
      for (const issue of entry.issues) {
        const category = issue.category.trim();
        if (!category) continue;
        const dimensionId = typeof issue.dimensionId === "string" && issue.dimensionId.trim().length > 0
          ? issue.dimensionId.trim()
          : undefined;
        const suggestion = typeof issue.suggestion === "string" && issue.suggestion.trim().length > 0
          ? issue.suggestion.trim()
          : undefined;
        const current = stats.get(category) ?? {
          category,
          ...(dimensionId ? { dimensionId } : {}),
          ...(suggestion ? { suggestion } : {}),
          critical: 0,
          warning: 0,
          chapters: [],
        };
        if (!stats.has(category)) {
          stats.set(category, current);
        } else if (!current.dimensionId && dimensionId) {
          current.dimensionId = dimensionId;
        }
        if (!current.suggestion && suggestion) {
          current.suggestion = suggestion;
        }
        if (issue.severity === "critical") current.critical += 1;
        if (issue.severity === "warning") current.warning += 1;
        if (!current.chapters.includes(entry.chapterNumber)) {
          current.chapters.push(entry.chapterNumber);
          current.chapters.sort((left, right) => left - right);
        }
      }
    }

    const describeRun = (chapters: ReadonlyArray<number>): string => {
      if (chapters.length === 0) return "最近未出现";
      let recentRun = 1;
      for (let index = chapters.length - 1; index > 0; index -= 1) {
        if (chapters[index] === chapters[index - 1]! + 1) {
          recentRun += 1;
        } else {
          break;
        }
      }
      return recentRun > 1 ? `最近连续${recentRun}章` : "最近1章";
    };

    const latestChapter = (chapters: ReadonlyArray<number>): number => chapters[chapters.length - 1] ?? 0;

    const selected = [...stats.values()]
      .filter((item) => item.critical > 0 || item.warning > 0)
      .sort((left, right) =>
        right.critical - left.critical
        || right.warning - left.warning
        || latestChapter(right.chapters) - latestChapter(left.chapters)
        || left.category.localeCompare(right.category),
      )
      .slice(0, 3);

    if (selected.length === 0) return undefined;

    const selectedStructural = selected.filter((item) => classifyAuditIssueClass(item) === "structural");
    const selectedTextual = selected.filter((item) => classifyAuditIssueClass(item) === "textual");

    const formatCounts = (item: FailureStats): string => {
      const parts: string[] = [];
      if (item.critical > 0) parts.push(`critical×${item.critical}`);
      if (item.warning > 0) parts.push(`warning×${item.warning}`);
      return parts.join("，");
    };

    const formatItem = (item: FailureStats): string => {
      const dimSegment = item.dimensionId && item.dimensionId !== item.category ? `，${item.dimensionId}` : "";
      const suggestionSegment = item.suggestion ? `；动作：${item.suggestion}` : "";
      return `- ${item.category}${dimSegment}（${formatCounts(item)}，${describeRun(item.chapters)}${suggestionSegment}）`;
    };

    const lines = [
      "## 高频失败维度提示",
      "",
      "近期反复出现的审计问题已按结构性 / 文本性拆分。最多保留3项，先修结构，再修句面：",
    ];

    if (selectedStructural.length > 0) {
      lines.push("### 结构性（先修）");
      lines.push("先回到节点、衔接、回收和推进，再考虑句面润色。");
      lines.push(...selectedStructural.map(formatItem));
    }

    if (selectedTextual.length > 0) {
      lines.push("### 文本性（后修）");
      lines.push("先压缩重复、套话和AI味，再做表达微调。");
      lines.push(...selectedTextual.map(formatItem));
    }

    return lines.join("\n");
  }

  private resolveTruthFileOverridesFromReviseOutput(
    reviseOutput: ReviseOutput,
    includeLedger: boolean,
  ): {
    currentState?: string;
    ledger?: string;
    hooks?: string;
  } {
    return {
      currentState: normalizeTruthPayload(reviseOutput.updatedState),
      ...(includeLedger ? { ledger: normalizeTruthPayload(reviseOutput.updatedLedger) } : {}),
      hooks: normalizeTruthPayload(reviseOutput.updatedHooks),
    };
  }

  private enforceLengthRequirement(params: {
    auditResult: AuditResult;
    chapterContent: string;
    lengthSpec: LengthSpec;
    language: LengthLanguage;
  }): { auditResult: AuditResult; lengthOutOfBand: boolean } {
    const chapterWordCount = countChapterLength(
      params.chapterContent,
      params.lengthSpec.countingMode,
    );
    const lengthOutOfBand = isOutsideSoftRange(chapterWordCount, params.lengthSpec);
    if (!lengthOutOfBand) {
      return { auditResult: params.auditResult, lengthOutOfBand: false };
    }

    const hasLengthIssue = params.auditResult.issues.some(
      (issue) => issue.category === "篇幅控制" || issue.category === "Length Control",
    );
    const lengthIssue: AuditIssue = {
      severity: "info",
      category: params.language === "en" ? "Length Control" : "篇幅控制",
      description: this.localize(params.language, {
        zh: `字数未达目标区间（${params.lengthSpec.softMin}-${params.lengthSpec.softMax}字，当前 ${chapterWordCount}字）。`,
        en: `Chapter length is outside target range (${params.lengthSpec.softMin}-${params.lengthSpec.softMax} words, current ${chapterWordCount}).`,
      }),
      suggestion: this.localize(params.language, {
        zh: "请补充或压缩正文，使字数回到目标区间后再审计。",
        en: "Revise chapter length to fit the target range, then re-run audit.",
      }),
    };

    const normalizedIssues = hasLengthIssue
      ? params.auditResult.issues
      : [...params.auditResult.issues, lengthIssue];
    const normalizedSummary = hasLengthIssue
      ? params.auditResult.summary
      : [params.auditResult.summary?.trim(), lengthIssue.description]
        .filter((entry): entry is string => Boolean(entry && entry.length > 0))
        .join("\n");

    return {
      auditResult: {
        ...params.auditResult,
        passed: params.auditResult.passed,
        issues: normalizedIssues,
        summary: normalizedSummary,
      },
      lengthOutOfBand: true,
    };
  }

  private enforceAuditScoreRequirement(params: {
    auditResult: AuditResult;
    language: LengthLanguage;
    scoreIssues?: ReadonlyArray<AuditIssue>;
  }): AuditResult {
    if (!params.auditResult.passed) return params.auditResult;
    const scoreBasis = params.scoreIssues ?? params.auditResult.issues;
    const score = estimateAuditScore(countAuditIssueSeverities(scoreBasis));
    if (score >= MIN_AUDIT_PASS_SCORE) return params.auditResult;

    const category = params.language === "en" ? "Score Gate" : "评分门禁";
    const hasScoreGateIssue = params.auditResult.issues.some((issue) => issue.category === category);
    const description = this.localize(params.language, {
      zh: `审计评分低于通过阈值（${score}/${MIN_AUDIT_PASS_SCORE}）。`,
      en: `Audit score is below the pass threshold (${score}/${MIN_AUDIT_PASS_SCORE}).`,
    });
    const suggestion = this.localize(params.language, {
      zh: "请优先修复警告项并提升章节质量后再审计。",
      en: "Address warning-level issues and improve chapter quality before re-audit.",
    });
    const issues = hasScoreGateIssue
      ? params.auditResult.issues
      : [...params.auditResult.issues, {
          severity: "info",
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

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLanguage> {
    if (book.language) {
      return book.language;
    }

    try {
      const { profile } = await this.loadGenreProfile(book.genre);
      return profile.language;
    } catch {
      return "zh";
    }
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLanguage> {
    try {
      const book = await this.state.loadBookConfig(bookId);
      return await this.resolveBookLanguage(book);
    } catch {
      return "zh";
    }
  }

  private languageFromLengthSpec(lengthSpec: Pick<LengthSpec, "countingMode">): LengthLanguage {
    return lengthSpec.countingMode === "en_words" ? "en" : "zh";
  }

  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    const text = `${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`;
    this.config.logger?.info(text);
    this.config.onTaskSignal?.({ kind: "log", level: "info", message: text });
  }

  private logInfo(language: LengthLanguage, message: { zh: string; en: string }): void {
    const text = this.localize(language, message);
    this.config.logger?.info(text);
    this.config.onTaskSignal?.({ kind: "log", level: "info", message: text });
  }

  private logWarn(language: LengthLanguage, message: { zh: string; en: string }): void {
    const text = this.localize(language, message);
    this.config.logger?.warn(text);
    this.config.onTaskSignal?.({ kind: "log", level: "warn", message: text });
  }

  private nowMs(): number {
    return Date.now();
  }

  private elapsedMs(startMs: number): number {
    return Math.max(0, this.nowMs() - startMs);
  }

  private logWriteNextPerformance(
    language: LengthLanguage,
    chapterNumber: number,
    performance: {
      totalMs: number;
      inputPrepMs: number;
      writingMs: number;
      auditMs: number;
      reviseMs: number;
      truthRebuildMs: number;
      stateValidationMs: number;
      indexSyncMs: number;
    },
  ): void {
    this.logInfo(language, {
      zh: `写一章阶段耗时(ms) ch=${chapterNumber}: total=${performance.totalMs}, input=${performance.inputPrepMs}, write=${performance.writingMs}, audit=${performance.auditMs}, revise=${performance.reviseMs}, truth=${performance.truthRebuildMs}, validate=${performance.stateValidationMs}, sync=${performance.indexSyncMs}`,
      en: `write-next stage timings(ms) ch=${chapterNumber}: total=${performance.totalMs}, input=${performance.inputPrepMs}, write=${performance.writingMs}, audit=${performance.auditMs}, revise=${performance.reviseMs}, truth=${performance.truthRebuildMs}, validate=${performance.stateValidationMs}, sync=${performance.indexSyncMs}`,
    });
  }

  private async appendWriteNextPerformanceSample(
    bookDir: string,
    sample: {
      chapterNumber: number;
      totalMs: number;
      inputPrepMs: number;
      writingMs: number;
      auditMs: number;
      reviseMs: number;
      truthRebuildMs: number;
      stateValidationMs: number;
      indexSyncMs: number;
    },
  ): Promise<void> {
    const runtimeDir = join(bookDir, "story", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await appendFile(
      join(runtimeDir, "write-next-performance.ndjson"),
      `${JSON.stringify({ at: new Date().toISOString(), ...sample })}\n`,
      "utf-8",
    );
  }

  private async withStageHeartbeat<T>(
    language: LengthLanguage,
    message: { zh: string; en: string },
    task: () => Promise<T>,
    options?: { suppressElapsedLog?: boolean },
  ): Promise<T> {
    if (options?.suppressElapsedLog) {
      return task();
    }
    const heartbeatMs = this.config.writeStageHeartbeatMs ?? 0;
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
      return task();
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      this.logInfo(language, {
        zh: `${message.zh}（进行中 ${elapsedSeconds}s）`,
        en: `${message.en} (${elapsedSeconds}s elapsed)`,
      });
    }, heartbeatMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      return await task();
    } finally {
      clearInterval(timer);
    }
  }

  private runInBackground(
    language: LengthLanguage,
    taskName: { zh: string; en: string },
    task: () => Promise<void>,
  ): void {
    void (async () => {
      this.logInfo(language, {
        zh: `${taskName.zh}已转后台执行`,
        en: `${taskName.en} moved to background`,
      });
      try {
        await task();
        this.logInfo(language, {
          zh: `${taskName.zh}已完成`,
          en: `${taskName.en} completed`,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logWarn(language, {
          zh: `${taskName.zh}失败：${detail}`,
          en: `${taskName.en} failed: ${detail}`,
        });
      }
    })();
  }

  private async tryGenerateStyleGuide(
    bookId: string,
    referenceText: string,
    sourceName: string | undefined,
    language?: LengthLanguage,
  ): Promise<void> {
    try {
      await this.generateStyleGuide(bookId, referenceText, sourceName);
    } catch (error) {
      const resolvedLanguage = language ?? await this.resolveBookLanguageById(bookId);
      const detail = error instanceof Error ? error.message : String(error);
      this.logWarn(resolvedLanguage, {
        zh: `风格指纹提取失败，已跳过：${detail}`,
        en: `Style fingerprint extraction failed and was skipped: ${detail}`,
      });
    }
  }

  private async generateAndReviewFoundation(params: {
    readonly generate: (reviewFeedback?: string) => Promise<ArchitectOutput>;
    readonly reviewer: FoundationReviewerAgent;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly stageLanguage: LengthLanguage;
    readonly maxRetries?: number;
  }): Promise<ArchitectOutput> {
    const maxRetries = params.maxRetries ?? 2;
    let foundation = await params.generate();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.logStage(params.stageLanguage, {
        zh: `审核基础设定（第${attempt + 1}轮）`,
        en: `reviewing foundation (round ${attempt + 1})`,
      });

      const review = await params.reviewer.review({
        foundation,
        mode: params.mode,
        sourceCanon: params.sourceCanon,
        styleGuide: params.styleGuide,
        language: params.language,
      });

      this.config.logger?.info(
        `Foundation review: ${review.totalScore}/100 ${review.passed ? "PASSED" : "REJECTED"}`,
      );
      for (const dim of review.dimensions) {
        this.config.logger?.info(`  [${dim.score}] ${dim.name.slice(0, 40)}`);
      }

      if (review.passed) {
        return foundation;
      }

      this.logWarn(params.stageLanguage, {
        zh: `基础设定未通过审核（${review.totalScore}分），正在重新生成...`,
        en: `Foundation rejected (${review.totalScore}/100), regenerating...`,
      });

      foundation = await params.generate(this.buildFoundationReviewFeedback(review, params.language));
    }

    // Final review
    const finalReview = await params.reviewer.review({
      foundation,
      mode: params.mode,
      sourceCanon: params.sourceCanon,
      styleGuide: params.styleGuide,
      language: params.language,
    });
    this.config.logger?.info(
      `Foundation final review: ${finalReview.totalScore}/100 ${finalReview.passed ? "PASSED" : "ACCEPTED (max retries)"}`,
    );

    return foundation;
  }

  private buildFoundationReviewFeedback(
    review: {
      readonly dimensions: ReadonlyArray<{
        readonly name: string;
        readonly score: number;
        readonly feedback: string;
      }>;
      readonly overallFeedback: string;
    },
    language: "zh" | "en",
  ): string {
    const dimensionLines = review.dimensions
      .map((dimension) => (
        language === "en"
          ? `- ${dimension.name} [${dimension.score}]: ${dimension.feedback}`
          : `- ${dimension.name}（${dimension.score}分）：${dimension.feedback}`
      ))
      .join("\n");

    return language === "en"
      ? [
          "## Overall Feedback",
          review.overallFeedback,
          "",
          "## Dimension Notes",
          dimensionLines || "- none",
        ].join("\n")
      : [
          "## 总评",
          review.overallFeedback,
          "",
          "## 分项问题",
          dimensionLines || "- 无",
        ].join("\n");
  }

  private agentCtx(bookId?: string): AgentContext {
    return {
      client: this.config.client,
      model: this.config.model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger,
      onStreamProgress: this.config.onStreamProgress,
    };
  }

  private resolveOverride(agentName: string): { model: string; client: LLMClient } {
    const override = this.config.modelOverrides?.[agentName];
    if (!override) {
      return { model: this.config.model, client: this.config.client };
    }
    if (typeof override === "string") {
      return { model: override, client: this.config.client };
    }
    // Full override — needs its own client if baseUrl differs
    if (!override.baseUrl) {
      return { model: override.model, client: this.config.client };
    }
    const base = this.config.defaultLLMConfig;
    const provider = override.provider ?? base?.provider ?? "custom";
    const apiKeySource = override.apiKeyEnv
      ? `env:${override.apiKeyEnv}`
      : `base:${base?.apiKey ?? ""}`;
    const stream = override.stream ?? base?.stream ?? true;
    const apiFormat = base?.apiFormat ?? "chat";
    const cacheKey = [
      provider,
      override.baseUrl,
      apiKeySource,
      `stream:${stream}`,
      `format:${apiFormat}`,
    ].join("|");
    let client = this.agentClients.get(cacheKey);
    if (!client) {
      const apiKey = override.apiKeyEnv
        ? process.env[override.apiKeyEnv] ?? ""
        : base?.apiKey ?? "";
      client = createLLMClient({
        provider,
        service: base?.service ?? "custom",
        configSource: base?.configSource ?? "env",
        baseUrl: override.baseUrl,
        apiKey,
        model: override.model,
        temperature: base?.temperature ?? 0.7,
        maxTokens: base?.maxTokens ?? 8192,
        thinkingBudget: base?.thinkingBudget ?? 0,
        apiFormat,
        stream,
      });
      this.agentClients.set(cacheKey, client);
    }
    return { model: override.model, client };
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    const { model, client } = this.resolveOverride(agent);
    return {
      client,
      model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger?.child(agent),
      onStreamProgress: this.config.onStreamProgress,
    };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.config.projectRoot, genre);
    return { profile: parsed.profile };
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by OpenClaw or agent mode)
  // ---------------------------------------------------------------------------

  async runRadar(): Promise<RadarResult> {
    const radar = new RadarAgent(this.agentCtxFor("radar"), this.config.radarSources);
    return radar.scan();
  }

  async initBook(book: BookConfig, options: InitBookOptions = {}): Promise<void> {
    const bookDir = this.state.bookDir(book.id);
    const stagingBookDir = join(
      this.state.booksDir,
      `.tmp-book-create-${book.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stageLanguage = await this.resolveBookLanguage(book);

    const { profile: gp } = await this.loadGenreProfile(book.genre);
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfigAt(stagingBookDir, book);

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocumentsAt(
        stagingBookDir,
        book.language ?? gp.language,
        options.authorIntent ?? this.config.externalContext,
        options.foundationBrief ?? options.externalContext ?? this.config.externalContext,
      );
      if (options.currentFocus?.trim()) {
        await writeFile(
          join(stagingBookDir, "story", "current_focus.md"),
          options.currentFocus.trimEnd() + "\n",
          "utf-8",
        );
      }

      await this.state.saveChapterIndexAt(stagingBookDir, []);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await this.state.snapshotStateAt(stagingBookDir, 0);

      if (await this.pathExists(bookDir)) {
        if (await this.state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${book.id}" already exists at books/${book.id}/. Use a different title or delete the existing book first.`);
        }
        await rm(bookDir, { recursive: true, force: true });
      }

      await rename(stagingBookDir, bookDir);
    } catch (error) {
      await rm(stagingBookDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Import external source material and generate fanfic_canon.md */
  async importFanficCanon(
    bookId: string,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<string> {
    const { FanficCanonImporter } = await import("../agents/fanfic-canon-importer.js");
    const importer = new FanficCanonImporter(this.agentCtxFor("fanfic-canon-importer", bookId));
    const result = await importer.importFromText(sourceText, sourceName, fanficMode);

    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "fanfic_canon.md"), result.fullDocument, "utf-8");

    return result.fullDocument;
  }

  /** One-step fanfic book creation: create book + import canon + generate foundation */
  async initFanficBook(
    book: BookConfig,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<void> {
    const bookDir = this.state.bookDir(book.id);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
    await this.state.saveBookConfig(book.id, book);

    // Step 1: Import source material → fanfic_canon.md
    this.logStage(stageLanguage, { zh: "导入同人正典", en: "importing fanfic canon" });
    const fanficCanon = await this.importFanficCanon(book.id, sourceText, sourceName, fanficMode);

    // Step 2: Generate foundation with review loop
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    this.logStage(stageLanguage, { zh: "生成同人基础设定", en: "generating fanfic foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFanficFoundation(
        book,
        fanficCanon,
        fanficMode,
        reviewFeedback,
      ),
      reviewer,
      mode: "fanfic",
      sourceCanon: fanficCanon,
      language: resolvedLanguage,
      stageLanguage,
    });
    this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      gp.numericalSystem,
      book.language ?? gp.language,
    );
    this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
    await this.state.ensureControlDocuments(book.id, this.config.externalContext);

    // Step 3: Generate style guide from source material
    if (sourceText.length >= 500) {
      this.logStage(stageLanguage, { zh: "提取原作风格指纹", en: "extracting source style fingerprint" });
      await this.tryGenerateStyleGuide(book.id, sourceText, sourceName, stageLanguage);
    }

    // Step 4: Initialize chapters directory + snapshot
    this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await this.state.saveChapterIndex(book.id, []);
    await this.state.snapshotState(book.id, 0);
  }

  /** Write a single draft chapter. Saves chapter file + truth files + index + snapshot. */
  async writeDraft(bookId: string, context?: string, wordCount?: number): Promise<DraftResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      await this.state.ensureControlDocuments(bookId);
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const chapterNumber = await this.state.getNextChapterNumber(bookId);
      const stageLanguage = await this.resolveBookLanguage(book);
      this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
      const writeInput = await this.prepareWriteInput(
        book,
        bookDir,
        chapterNumber,
        context ?? this.config.externalContext,
      );

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const lengthSpec = buildLengthSpec(
        wordCount ?? book.chapterWordCount,
        book.language ?? gp.language,
      );
      const reviewPreflight = await this.runReviewPreflight({
        bookDir,
        chapterNumber,
        target: "write-next",
        language: book.language ?? gp.language,
        targetChapters: book.targetChapters,
      });
      const writeInputWithPreflight = this.applyReviewPreflightToWriteInput(
        writeInput,
        reviewPreflight,
        book.language ?? gp.language,
      );
      if (reviewPreflight.signals.length > 0) {
        this.logWarn(book.language ?? gp.language, {
          zh: this.buildPreflightSignalsSummary(reviewPreflight, book.language ?? gp.language),
          en: this.buildPreflightSignalsSummary(reviewPreflight, book.language ?? gp.language),
        });
      }

      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
      const output = await writer.writeChapter({
        book,
        bookDir,
        chapterNumber,
        ...writeInputWithPreflight,
        lengthSpec,
        onTextDelta: (text) => {
          this.config.onWriterTextDelta?.({
            bookId,
            chapterNumber,
            text,
            mode: "draft",
          });
        },
        onThinkingDelta: (text) => {
          this.config.onAuditorTextDelta?.({ bookId, chapterNumber, text });
        },
        ...(wordCount ? { wordCountOverride: wordCount } : {}),
      });
      const writerCount = countChapterLength(output.content, lengthSpec.countingMode);
      let totalUsage: TokenUsageSummary = output.tokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      const normalizedDraft = await this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber,
        chapterContent: output.content,
        lengthSpec,
        chapterIntent: writeInputWithPreflight.chapterIntent,
      });
      totalUsage = PipelineRunner.addUsage(totalUsage, normalizedDraft.tokenUsage);
      const draftOutput: WriteChapterOutput = {
        ...output,
        content: normalizedDraft.content,
        wordCount: normalizedDraft.wordCount,
        tokenUsage: totalUsage,
      };
      const lengthWarnings = this.buildLengthWarnings(
        chapterNumber,
        draftOutput.wordCount,
        lengthSpec,
      );
      const lengthTelemetry = this.buildLengthTelemetry({
        lengthSpec,
        writerCount,
        postWriterNormalizeCount: normalizedDraft.wordCount,
        postReviseCount: 0,
        finalCount: draftOutput.wordCount,
        normalizeApplied: normalizedDraft.applied,
        lengthWarning: lengthWarnings.length > 0,
      });
      this.logLengthWarnings(lengthWarnings);

      // Save chapter file
      const chaptersDir = join(bookDir, "chapters");
      const paddedNum = String(chapterNumber).padStart(4, "0");
      const sanitized = draftOutput.title.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, "_").slice(0, 50);
      const filename = `${paddedNum}_${sanitized}.md`;
      const filePath = join(chaptersDir, filename);

      const resolvedLang = book.language ?? gp.language;
      const heading = resolvedLang === "en"
        ? `# Chapter ${chapterNumber}: ${draftOutput.title}`
        : `# 第${chapterNumber}章 ${draftOutput.title}`;
      await writeFile(filePath, `${heading}\n\n${draftOutput.content}`, "utf-8");

      // Save truth files
      this.logStage(stageLanguage, { zh: "落盘草稿与真相文件", en: "persisting draft and truth files" });
      await writer.saveChapter(bookDir, draftOutput, gp.numericalSystem, resolvedLang);
      await writer.saveNewTruthFiles(bookDir, draftOutput, resolvedLang);
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, draftOutput);
      await this.syncNarrativeMemoryIndex(bookId);

      // Update index
      const existingIndex = await this.state.loadChapterIndex(bookId);
      const now = new Date().toISOString();
      const newEntry: ChapterMeta = {
        number: chapterNumber,
        title: draftOutput.title,
        status: "drafted",
        wordCount: draftOutput.wordCount,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings,
        lengthTelemetry,
        ...(draftOutput.tokenUsage ? { tokenUsage: draftOutput.tokenUsage } : {}),
      };
      const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
      const updatedIndex = existingIdx >= 0
        ? existingIndex.map((e, i) => i === existingIdx ? newEntry : e)
        : [...existingIndex, newEntry];
      await this.state.saveChapterIndex(bookId, updatedIndex);
      await this.markBookActiveIfNeeded(bookId);

      // Snapshot
      this.logStage(stageLanguage, { zh: "更新章节索引与快照", en: "updating chapter index and snapshots" });
      await this.state.snapshotState(bookId, chapterNumber);
      await this.syncCurrentStateFactHistory(bookId, chapterNumber);

      await this.emitWebhook("chapter-complete", bookId, chapterNumber, {
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
      });

      return {
        chapterNumber,
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
        filePath,
        lengthWarnings,
        lengthTelemetry,
        tokenUsage: draftOutput.tokenUsage,
      };
    } finally {
      await releaseLock();
    }
  }

  async planChapter(bookId: string, context?: string): Promise<PlanChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "规划下一章意图", en: "planning next chapter intent" });
    const { plan } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: false },
    );

    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: plan.intent.conflicts.map((conflict) => `${conflict.type}: ${conflict.resolution}`),
    };
  }

  async composeChapter(bookId: string, context?: string): Promise<ComposeChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "组装章节运行时上下文", en: "composing chapter runtime context" });
    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: plan.intent.conflicts.map((conflict) => `${conflict.type}: ${conflict.resolution}`),
      contextPath: relativeToBookDir(bookDir, composed.contextPath),
      ruleStackPath: relativeToBookDir(bookDir, composed.ruleStackPath),
      tracePath: relativeToBookDir(bookDir, composed.tracePath),
    };
  }

  /** Audit the latest (or specified) chapter. Read-only, no lock needed. */
  async auditDraft(bookId: string, chapterNumber?: number): Promise<AuditResult & { readonly chapterNumber: number }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
    if (targetChapter < 1) {
      throw new Error(`No chapters to audit for "${bookId}"`);
    }

    const content = await this.readChapterContent(bookDir, targetChapter);
    const index = await this.state.loadChapterIndex(bookId);
    const chapterMeta = index.find((chapter) => chapter.number === targetChapter);
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const language = book.language ?? gp.language;
    const countingMode = chapterMeta?.lengthTelemetry?.countingMode ?? resolveLengthCountingMode(language);
    const lengthLanguage: LengthLanguage = countingMode === "en_words" ? "en" : "zh";
    const lengthSpec = buildLengthSpec(
      chapterMeta?.lengthTelemetry?.target ?? book.chapterWordCount,
      lengthLanguage,
    );
    const chapterWordCount = countChapterLength(content, countingMode);
    this.logStage(language, {
      zh: `审计第${targetChapter}章`,
      en: `auditing chapter ${targetChapter}`,
    });
    const evaluation = await this.evaluateMergedAudit({
      auditor,
      book,
      bookDir,
      chapterContent: content,
      chapterNumber: targetChapter,
      language,
      lengthSpec,
      onThinkingDelta: (text) => {
        this.config.onAuditorTextDelta?.({ bookId, chapterNumber: targetChapter, text });
      },
        onThinkingEnd: () => {
          this.config.onAuditorThinkingEnd?.({ bookId, chapterNumber: targetChapter });
        },
    });
    const result: AuditResult = this.enforceAuditScoreRequirement({
      auditResult: evaluation.auditResult,
      language,
      scoreIssues: evaluation.revisionBlockingIssues,
    });

    // Update index with audit result
    const updated = index.map((ch) =>
      ch.number === targetChapter
        ? {
            ...ch,
            status: (result.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
            wordCount: chapterWordCount,
            updatedAt: new Date().toISOString(),
            auditIssues: result.issues.map((i) => `[${i.severity}] ${i.description}`),
          }
        : ch,
    );
    await this.state.saveChapterIndex(bookId, updated);
    const latestChapter = index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
    if (targetChapter === latestChapter) {
      await this.persistAuditDriftGuidance({
        bookDir,
        chapterNumber: targetChapter,
        issues: result.issues.filter((issue) => issue.severity === "critical" || issue.severity === "warning"),
        language,
      }).catch(() => undefined);
    }

    await this.emitWebhook(
      result.passed ? "audit-passed" : "audit-failed",
      bookId,
      targetChapter,
      { summary: result.summary, issueCount: result.issues.length },
    );

    return { ...result, chapterNumber: targetChapter };
  }

  /** Revise the latest (or specified) chapter based on audit issues. */
  async reviseDraft(
    bookId: string,
    chapterNumber?: number,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    options?: ReviseDraftOptions,
  ): Promise<ReviseResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
      if (targetChapter < 1) {
        throw new Error(`No chapters to revise for "${bookId}"`);
      }

      const stageLanguage = await this.resolveBookLanguage(book);
      const reviseActionZh = mode === "rewrite" ? "重写" : "修订";
      const reviseActionEn = mode === "rewrite" ? "rewrite" : "revision";
      // Read the current audit issues from index
      this.logStage(stageLanguage, {
        zh: `加载第${targetChapter}章${reviseActionZh}上下文`,
        en: `loading ${reviseActionEn} context for chapter ${targetChapter}`,
      });
      const index = await this.state.loadChapterIndex(bookId);
      const chapterMeta = index.find((ch) => ch.number === targetChapter);
      if (!chapterMeta) {
        throw new Error(`Chapter ${targetChapter} not found in index`);
      }
      const syncChapterAuditSnapshotInIndex = async (
        wordCount: number,
        auditResult?: AuditResult,
      ): Promise<void> => {
        const updatedAt = new Date().toISOString();
        const auditSummary = auditResult ? this.buildReviseAuditSummary(auditResult) : null;
        const historyEntry = auditResult
          ? buildChapterAuditHistoryEntry(auditResult, updatedAt, auditSummary?.report)
          : null;
        const updatedIndex = index.map((ch) =>
          ch.number === targetChapter
            ? {
                ...ch,
                ...(auditResult
                  ? {
                      status: (auditResult.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
                      auditIssues: auditResult.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
                      ...(historyEntry
                        ? {
                            auditHistory: [...(Array.isArray(ch.auditHistory) ? ch.auditHistory : []), historyEntry],
                          }
                        : {}),
                    }
                  : {}),
                wordCount,
                updatedAt,
              }
            : ch,
        );
        await this.state.saveChapterIndex(bookId, updatedIndex);
      };

      // Re-audit to get structured issues (index only stores strings)
      const content = await this.readChapterContent(bookDir, targetChapter);
      const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const language = book.language ?? gp.language;
      const countingMode = resolveLengthCountingMode(language);
      const parsedBookRules = await readBookRules(bookDir).catch(() => null);
      const dialogueQuotePolicy = resolveBookDialogueQuotePolicy(
        parsedBookRules?.rules ?? null,
        language,
      );
      const chapterLengthTarget = chapterMeta.lengthTelemetry?.target ?? book.chapterWordCount;
      const lengthLanguage = chapterMeta.lengthTelemetry?.countingMode === "en_words"
        ? "en"
        : language;
      const lengthSpec = buildLengthSpec(
        chapterLengthTarget,
        lengthLanguage,
      );
      const auditFailureHints = await this.buildAuditFailureHints(bookDir);
      const reviseExternalContext = this.mergeExternalContext(this.config.externalContext, auditFailureHints);
      const reviseControlInput = (this.config.inputGovernanceMode ?? "v2") === "legacy"
        ? undefined
        : await this.createGovernedArtifacts(
          book,
          bookDir,
          targetChapter,
          this.config.externalContext,
          { reuseExistingIntentWhenContextMissing: true },
        );
      const reviseAuditControlInput: ReducedAuditControlInput | undefined = reviseControlInput
        ? {
            chapterIntent: reviseControlInput.plan.intentMarkdown,
            contextPackage: reviseControlInput.composed.contextPackage,
            ruleStack: reviseControlInput.composed.ruleStack,
          }
        : undefined;
      const reviewPreflight = await this.runReviewPreflight({
        bookDir,
        chapterNumber: targetChapter,
        target: "revise",
        language,
        targetChapters: book.targetChapters,
      });
      const reviseAuditControlInputWithPreflight = this.withPreflightControlInput(
        reviseAuditControlInput,
        reviewPreflight,
        language,
      );
      if (reviewPreflight.signals.length > 0) {
        this.logWarn(language, {
          zh: this.buildPreflightSignalsSummary(reviewPreflight, language),
          en: this.buildPreflightSignalsSummary(reviewPreflight, language),
        });
      }
      const preRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        chapterContent: content,
        chapterNumber: targetChapter,
        language,
        lengthSpec,
        onThinkingDelta: (text) => {
          this.config.onAuditorTextDelta?.({ bookId, chapterNumber: targetChapter, text });
        },
        onThinkingEnd: () => {
          this.config.onAuditorThinkingEnd?.({ bookId, chapterNumber: targetChapter });
        },
        auditOptions: reviseAuditControlInputWithPreflight
          ? {
              chapterIntent: reviseAuditControlInputWithPreflight.chapterIntent,
              contextPackage: reviseAuditControlInputWithPreflight.contextPackage,
              ruleStack: reviseAuditControlInputWithPreflight.ruleStack,
            }
          : undefined,
      });
      const rewriteLikeMode = mode === "rewrite" || mode === "rework";
      const overrideIssues = Array.isArray(options?.overrideIssues)
        ? options.overrideIssues.filter((issue) =>
          issue
          && typeof issue.description === "string"
          && issue.description.trim().length > 0,
        )
        : [];
      const reviseIssues = overrideIssues.length > 0
        ? overrideIssues
        : preRevision.auditResult.issues;

      if (!rewriteLikeMode && preRevision.blockingCount === 0 && preRevision.aiTellCount === 0 && overrideIssues.length === 0) {
        const existingWordCount = countChapterLength(content, countingMode);
        // Even when we skip manual revise, keep index status aligned with latest audit.
        await syncChapterAuditSnapshotInIndex(existingWordCount, preRevision.auditResult);
        return {
          chapterNumber: targetChapter,
          wordCount: existingWordCount,
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: "No warning, critical, or AI-tell issues to fix.",
          audit: this.buildReviseAuditSummary(preRevision.auditResult),
        };
      }

      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      this.logStage(stageLanguage, {
        zh: `${reviseActionZh}第${targetChapter}章`,
        en: `${mode === "rewrite" ? "rewriting" : "revising"} chapter ${targetChapter}`,
      });

      // Load chapter plan for maxRecoveryPerChapter
      let reviseChapterPlan: ChapterPlan | undefined;
      try {
        const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
        const raw = await readFile(plansPath, "utf-8");
        const data = JSON.parse(raw);
        const plans: ChapterPlan[] = Array.isArray(data.plans) ? data.plans : [];
        const matched = plans.find((p) => p.chapterNumber === targetChapter);
        if (matched) {
          reviseChapterPlan = ChapterPlanSchema.parse(matched);
        }
      } catch { /* no chapter-plans.json — ignore */ }

      // Load previous chapter tail for衔接 protection (only for rewrite/rework modes)
      const previousChapterForRevise = (mode === "rewrite" || mode === "rework") && targetChapter > 1
        ? await this.readChapterContent(bookDir, targetChapter - 1).catch(() => undefined)
        : undefined;

      let sawReviserDelta = false;
      let sawReviserPatchDelta = false;
      const reviseOutput = await reviser.reviseChapter(
        bookDir,
        content,
        targetChapter,
        reviseIssues,
        mode,
        book.genre,
        reviseAuditControlInputWithPreflight
          ? {
              userBrief: options?.userBrief,
              externalContext: reviseExternalContext,
              chapterIntent: reviseAuditControlInputWithPreflight.chapterIntent,
              contextPackage: reviseAuditControlInputWithPreflight.contextPackage,
              ruleStack: reviseAuditControlInputWithPreflight.ruleStack,
              lengthSpec,
              reviseContext: options?.reviseContext,
              previousChapterContent: previousChapterForRevise,
              chapterPlan: reviseChapterPlan,
              onThinkingDelta: (text) => {
                if (!text) return;
                this.config.onReviserThinkingDelta?.({ bookId, chapterNumber: targetChapter, mode, text });
              },
              onThinkingEnd: () => {
                this.config.onReviserThinkingEnd?.({ bookId, chapterNumber: targetChapter, mode });
              },
              onRevisedContentDelta: (text) => {
                if (!text) return;
                sawReviserDelta = true;
                this.config.onReviserTextDelta?.({
                  bookId,
                  chapterNumber: targetChapter,
                  mode,
                  text,
                });
              },
              onSpotFixPatchDelta: (text) => {
                if (!text) return;
                sawReviserPatchDelta = true;
                this.config.onReviserPatchDelta?.({
                  bookId,
                  chapterNumber: targetChapter,
                  mode,
                  text,
                });
              },
            }
          : {
              userBrief: options?.userBrief,
              externalContext: reviseExternalContext,
              lengthSpec,
              reviseContext: options?.reviseContext,
              previousChapterContent: previousChapterForRevise,
              chapterPlan: reviseChapterPlan,
              onThinkingDelta: (text) => {
                if (!text) return;
                this.config.onReviserThinkingDelta?.({ bookId, chapterNumber: targetChapter, mode, text });
              },
              onThinkingEnd: () => {
                this.config.onReviserThinkingEnd?.({ bookId, chapterNumber: targetChapter, mode });
              },
              onRevisedContentDelta: (text) => {
                if (!text) return;
                sawReviserDelta = true;
                this.config.onReviserTextDelta?.({
                  bookId,
                  chapterNumber: targetChapter,
                  mode,
                  text,
                });
              },
              onSpotFixPatchDelta: (text) => {
                if (!text) return;
                sawReviserPatchDelta = true;
                this.config.onReviserPatchDelta?.({
                  bookId,
                  chapterNumber: targetChapter,
                  mode,
                  text,
                });
              },
            },
      );

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }
      let policyAdjustedRevisionContent = reviseOutput.revisedContent;
      if (dialogueQuotePolicy && (dialogueQuotePolicy.mode === "force_double" || dialogueQuotePolicy.mode === "force_corner")) {
        const normalizedByPolicy = normalizeDialogueQuotesByPolicy(
          policyAdjustedRevisionContent,
          dialogueQuotePolicy.mode,
        );
        if (normalizedByPolicy !== policyAdjustedRevisionContent) {
          policyAdjustedRevisionContent = normalizedByPolicy;
          this.logStage(stageLanguage, {
            zh: `按书籍规则统一第${targetChapter}章对白引号`,
            en: `normalizing dialogue quotes by policy for chapter ${targetChapter}`,
          });
        }
      }
      if (!sawReviserDelta && policyAdjustedRevisionContent && this.config.onReviserTextDelta && mode !== "spot-fix") {
        const chunkSize = 120;
        for (let i = 0; i < policyAdjustedRevisionContent.length; i += chunkSize) {
          const chunk = policyAdjustedRevisionContent.slice(i, i + chunkSize);
          if (!chunk) continue;
          this.config.onReviserTextDelta({
            bookId,
            chapterNumber: targetChapter,
            mode,
            text: chunk,
          });
        }
      }
      if (!sawReviserPatchDelta && this.config.onReviserPatchDelta && mode === "spot-fix") {
        const fallbackPatchPreview = reviseOutput.fixedIssues.length > 0
          ? `=== PATCH PREVIEW ===\n${reviseOutput.fixedIssues.map((issue) => `- ${issue}`).join("\n")}\n`
          : "=== PATCH PREVIEW ===\n(未生成可应用补丁)\n";
        const chunkSize = 120;
        for (let i = 0; i < fallbackPatchPreview.length; i += chunkSize) {
          const chunk = fallbackPatchPreview.slice(i, i + chunkSize);
          if (!chunk) continue;
          this.config.onReviserPatchDelta({
            bookId,
            chapterNumber: targetChapter,
            mode,
            text: chunk,
          });
        }
      }
      const normalizedRevision = await this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber: targetChapter,
        chapterContent: policyAdjustedRevisionContent,
        lengthSpec,
      });
      const postRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        chapterContent: normalizedRevision.content,
        chapterNumber: targetChapter,
        language,
        lengthSpec,
        onThinkingDelta: (text) => {
          this.config.onAuditorTextDelta?.({ bookId, chapterNumber: targetChapter, text });
        },
        onThinkingEnd: () => {
          this.config.onAuditorThinkingEnd?.({ bookId, chapterNumber: targetChapter });
        },
        auditOptions: reviseAuditControlInputWithPreflight
          ? {
              temperature: 0,
              chapterIntent: reviseAuditControlInputWithPreflight.chapterIntent,
              contextPackage: reviseAuditControlInputWithPreflight.contextPackage,
              ruleStack: reviseAuditControlInputWithPreflight.ruleStack,
              truthFileOverrides: this.resolveTruthFileOverridesFromReviseOutput(reviseOutput, gp.numericalSystem),
            }
          : {
              temperature: 0,
              truthFileOverrides: this.resolveTruthFileOverridesFromReviseOutput(reviseOutput, gp.numericalSystem),
            },
      });
      const effectivePostRevision = this.restoreActionableAuditIfLost(
        preRevision,
        postRevision,
      );
      const revisionBaseCount = countChapterLength(content, lengthSpec.countingMode);
      const lengthWarnings = this.buildLengthWarnings(
        targetChapter,
        normalizedRevision.wordCount,
        lengthSpec,
      );
      const lengthTelemetry = this.buildLengthTelemetry({
        lengthSpec,
        writerCount: revisionBaseCount,
        postWriterNormalizeCount: 0,
        postReviseCount: normalizedRevision.wordCount,
        finalCount: normalizedRevision.wordCount,
        normalizeApplied: normalizedRevision.applied,
        lengthWarning: lengthWarnings.length > 0,
      });

      const improvedBlocking = effectivePostRevision.blockingCount < preRevision.blockingCount;
      const improvedAITells = effectivePostRevision.aiTellCount < preRevision.aiTellCount;
      const blockingDidNotWorsen = effectivePostRevision.blockingCount <= preRevision.blockingCount;
      const criticalDidNotWorsen = effectivePostRevision.criticalCount <= preRevision.criticalCount;
      const aiDidNotWorsen = effectivePostRevision.aiTellCount <= preRevision.aiTellCount;
      const hasMeaningfulContentChange = normalizedRevision.content.trim() !== content.trim();
      const nonWorseningRevision = hasMeaningfulContentChange
        && blockingDidNotWorsen
        && criticalDidNotWorsen
        && aiDidNotWorsen;
      const shouldApplyRevision = nonWorseningRevision;

      if (!shouldApplyRevision) {
        // Revision body was rejected; chapter content stays unchanged, but audit status
        // should still reflect the current baseline audit on the kept content.
        await syncChapterAuditSnapshotInIndex(revisionBaseCount, preRevision.auditResult);
        return {
          chapterNumber: targetChapter,
          wordCount: revisionBaseCount,
          fixedIssues: reviseOutput.fixedIssues,
          applied: false,
          status: "unchanged",
          skippedReason: rewriteLikeMode
            ? hasMeaningfulContentChange
              ? "Manual rewrite worsened merged audit or AI-tell metrics; kept original chapter."
              : "Manual rewrite did not produce meaningful content change; kept original chapter."
            : hasMeaningfulContentChange
              ? "Manual revision worsened merged audit or AI-tell metrics; kept original chapter."
              : "Manual revision did not produce meaningful content change; kept original chapter.",
          audit: this.buildReviseAuditSummary(preRevision.auditResult),
        };
      }
      this.logLengthWarnings(lengthWarnings);

      // Save revised chapter file
      this.logStage(stageLanguage, {
        zh: `落盘第${targetChapter}章${reviseActionZh}结果`,
        en: `persisting ${reviseActionEn} result for chapter ${targetChapter}`,
      });
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(targetChapter).padStart(4, "0");
      const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!existingFile) {
        throw new Error(`Chapter ${targetChapter} file not found in ${chaptersDir} (expected filename starting with ${paddedNum})`);
      }
      const reviseLang = book.language ?? gp.language;
      const reviseHeading = reviseLang === "en"
        ? `# Chapter ${targetChapter}: ${chapterMeta.title}`
        : `# 第${targetChapter}章 ${chapterMeta.title}`;
      await writeFile(
        join(chaptersDir, existingFile),
        `${reviseHeading}\n\n${normalizedRevision.content}`,
        "utf-8",
      );

      // Commit truth files when revision passes audit.
      // For failed audit, allow structural minimal commit (D3) to reduce state drift risk.
      const revisionPassedAudit = effectivePostRevision.auditResult.passed;
      const storyDir = join(bookDir, "story");
      const truthOverrides = this.resolveTruthFileOverridesFromReviseOutput(reviseOutput, gp.numericalSystem);
      const blockingIssuesAfterRevision = effectivePostRevision.auditResult.issues.filter(
        (issue) => issue.severity === "critical" || issue.severity === "warning",
      );
      const structuralBlockingCount = blockingIssuesAfterRevision.filter((issue) => isStructuralAuditIssue(issue)).length;
      const textualBlockingCount = Math.max(0, blockingIssuesAfterRevision.length - structuralBlockingCount);
      const allowStructuralMinimalCommit = !revisionPassedAudit
        && structuralBlockingCount > 0
        && textualBlockingCount === 0;
      if (revisionPassedAudit || allowStructuralMinimalCommit) {
        const filesToBackup: Array<{ path: string; next?: string }> = [
          { path: join(storyDir, "current_state.md"), next: truthOverrides.currentState },
          ...(gp.numericalSystem ? [{ path: join(storyDir, "particle_ledger.md"), next: truthOverrides.ledger }] : []),
          { path: join(storyDir, "pending_hooks.md"), next: truthOverrides.hooks },
        ];
        const backups = await Promise.all(filesToBackup.map(async (entry) => ({
          ...entry,
          previous: await readFile(entry.path, "utf-8").catch(() => undefined as string | undefined),
        })));
        try {
          for (const entry of backups) {
            if (typeof entry.next === "string") {
              await writeFile(entry.path, entry.next, "utf-8");
            }
          }
        } catch (error) {
          for (const entry of backups) {
            if (typeof entry.previous === "string") {
              await writeFile(entry.path, entry.previous, "utf-8").catch(() => undefined);
            }
          }
          throw error;
        }
        if (allowStructuralMinimalCommit) {
          this.logWarn(stageLanguage, {
            zh: `第${targetChapter}章${reviseActionZh}未过审但仅剩结构阻断问题：已执行可回滚最小结构提交（state/ledger/hooks）。`,
            en: `Chapter ${targetChapter} ${reviseActionEn} failed audit with structural-only blockers: applied rollback-safe minimal structural commit (state/ledger/hooks).`,
          });
        }
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter);
      } else {
        this.logWarn(stageLanguage, {
          zh: `第${targetChapter}章${reviseActionZh}后审计未通过：仅更新章节与索引，跳过真相文件提交。`,
          en: `chapter ${targetChapter} ${reviseActionEn} did not pass audit: only chapter/index updated; truth commit skipped.`,
        });
      }

      // Update index
      const updatedAt = new Date().toISOString();
      const reviseAuditSummary = this.buildReviseAuditSummary(effectivePostRevision.auditResult);
      const updatedIndex = index.map((ch) =>
        ch.number === targetChapter
          ? {
              ...ch,
              status: (effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
              wordCount: normalizedRevision.wordCount,
              updatedAt,
              auditIssues: effectivePostRevision.auditResult.issues.map((i) => `[${i.severity}] ${i.description}`),
              lengthWarnings,
              lengthTelemetry,
              auditHistory: [
                ...(Array.isArray(ch.auditHistory) ? ch.auditHistory : []),
                buildChapterAuditHistoryEntry(
                  effectivePostRevision.auditResult,
                  updatedAt,
                  reviseAuditSummary.report,
                ),
              ],
            }
          : ch,
      );
      await this.state.saveChapterIndex(bookId, updatedIndex);
      const latestChapter = index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
      const revisingHistoricalChapter = targetChapter < latestChapter;
      if (targetChapter === latestChapter) {
        await this.persistAuditDriftGuidance({
          bookDir,
          chapterNumber: targetChapter,
          issues: effectivePostRevision.auditResult.issues.filter(
            (issue) => issue.severity === "critical" || issue.severity === "warning",
          ),
          language,
        }).catch(() => undefined);
      }

      if (revisionPassedAudit) {
        // Re-snapshot
        this.logStage(stageLanguage, {
          zh: `更新第${targetChapter}章索引与快照`,
          en: `updating chapter index and snapshots for chapter ${targetChapter}`,
        });
        if (revisingHistoricalChapter) {
          await this.clearMemorySyncProgress(bookDir);
        }
        await this.state.snapshotState(bookId, targetChapter);
        await this.syncNarrativeMemoryIndex(bookId);
        await this.syncCurrentStateFactHistory(
          bookId,
          revisingHistoricalChapter ? latestChapter : targetChapter,
        );
      }

      await this.emitWebhook("revision-complete", bookId, targetChapter, {
        wordCount: normalizedRevision.wordCount,
        fixedCount: reviseOutput.fixedIssues.length,
      });

      return {
        chapterNumber: targetChapter,
        wordCount: normalizedRevision.wordCount,
        fixedIssues: reviseOutput.fixedIssues,
        applied: true,
        status: effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed",
        lengthWarnings,
        lengthTelemetry,
        audit: this.buildReviseAuditSummary(effectivePostRevision.auditResult),
      };
    } finally {
      await releaseLock();
    }
  }

  /** Read all truth files for a book. */
  async readTruthFiles(bookId: string): Promise<TruthFiles> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const readSafe = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return "(文件不存在)";
      }
    };

    const [currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules] =
      await Promise.all([
        readSafe(join(storyDir, "current_state.md")),
        readSafe(join(storyDir, "particle_ledger.md")),
        readSafe(join(storyDir, "pending_hooks.md")),
        readStoryFrame(bookDir, "(文件不存在)"),
        readVolumeMap(bookDir, "(文件不存在)"),
        readSafe(join(storyDir, "book_rules.md")),
      ]);

    return { currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules };
  }

  /** Get book status overview. */
  async getBookStatus(bookId: string): Promise<BookStatusInfo> {
    const book = await this.state.loadBookConfig(bookId);
    const chapters = await this.state.loadChapterIndex(bookId);
    const nextChapter = await this.state.getNextChapterNumber(bookId);
    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      chaptersWritten: chapters.length,
      totalWords,
      nextChapter,
      chapters: [...chapters],
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline (convenience — runs draft + audit + revise in one shot)
  // ---------------------------------------------------------------------------

  async writeNextChapter(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    options?: WriteNextChapterOptions,
  ): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._writeNextChapterLocked(bookId, wordCount, temperatureOverride, options);
    } finally {
      await releaseLock();
    }
  }

  async repairChapterState(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._repairChapterStateLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  async resyncChapterArtifacts(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._resyncChapterArtifactsLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  private async _writeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    options?: WriteNextChapterOptions,
  ): Promise<ChapterPipelineResult> {
    const writeNextStartedAt = this.nowMs();
    let inputPrepMs = 0;
    let writingMs = 0;
    let auditMs = 0;
    let reviseMs = 0;
    let truthRebuildMs = 0;
    let stateValidationMs = 0;
    let indexSyncMs = 0;
    const auditRoundStartedAt = new Map<number, number>();
    const reviseRoundStartedAt = new Map<number, number>();

    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    await this.assertNoPendingStateRepair(bookId, options?.allowPendingAuditFailure ?? false);
    const stageLanguage = await this.resolveBookLanguage(book);
    await this.assertNoPendingAuditFailure(bookId, stageLanguage, options?.allowPendingAuditFailure ?? false);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
    const inputPrepStartedAt = this.nowMs();
    const writeInput = await this.prepareWriteInput(
      book,
      bookDir,
      chapterNumber,
      this.config.externalContext,
    );
    const reducedControlInput: ReducedAuditControlInput | undefined =
      writeInput.chapterIntent && writeInput.contextPackage && writeInput.ruleStack
      ? {
          chapterIntent: writeInput.chapterIntent,
          contextPackage: writeInput.contextPackage,
          ruleStack: writeInput.ruleStack,
        }
      : undefined;
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const parsedBookRules = await readBookRules(bookDir).catch(() => null);
    const dialogueQuotePolicy = resolveBookDialogueQuotePolicy(
      parsedBookRules?.rules ?? null,
      pipelineLang,
    );
    const lengthSpec = buildLengthSpec(
      wordCount ?? book.chapterWordCount,
      pipelineLang,
    );
    inputPrepMs += this.elapsedMs(inputPrepStartedAt);
    const quickMode = options?.quickMode ?? this.config.defaultWriteNextQuickMode ?? false;
    let skipStateValidation = options?.skipStateValidation ?? quickMode;
    const deferMemorySync = options?.deferMemorySync ?? quickMode;
    const deferSnapshotSync = options?.deferSnapshotSync ?? quickMode;
    if (quickMode) {
      this.logWarn(stageLanguage, {
        zh: "快速写作模式已启用：状态校验与部分后处理将降级或转后台执行。",
        en: "Quick writing mode enabled: state validation and part of post-processing are reduced or deferred.",
      });
    }
    const reviewPreflight = await this.runReviewPreflight({
      bookDir,
      chapterNumber,
      target: "write-next",
      language: pipelineLang,
      targetChapters: book.targetChapters,
    });
    const writeInputWithPreflight = this.applyReviewPreflightToWriteInput(
      writeInput,
      reviewPreflight,
      pipelineLang,
    );
    const reducedControlInputWithPreflight = this.withPreflightControlInput(
      reducedControlInput,
      reviewPreflight,
      pipelineLang,
    );
    if (reviewPreflight.signals.length > 0) {
      this.logWarn(pipelineLang, {
        zh: this.buildPreflightSignalsSummary(reviewPreflight, pipelineLang),
        en: this.buildPreflightSignalsSummary(reviewPreflight, pipelineLang),
      });
    }

    // 1. Write chapter
    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
    const writingStartedAt = this.nowMs();
    const output = await writer.writeChapter({
      book,
      bookDir,
      chapterNumber,
      ...writeInputWithPreflight,
      lengthSpec,
      // Write-next may be retried after a partial/failed previous run where state projection
      // already advanced to the same chapter number; allow idempotent reapply for this chapter.
      allowReapply: true,
      onTextDelta: (text) => {
        this.config.onWriterTextDelta?.({
          bookId,
          chapterNumber,
          text,
          mode: "write-next",
        });
      },
      onThinkingDelta: (text) => {
        this.config.onAuditorTextDelta?.({ bookId, chapterNumber, text });
      },
      ...(wordCount ? { wordCountOverride: wordCount } : {}),
      ...(temperatureOverride ? { temperatureOverride } : {}),
    });
    writingMs += this.elapsedMs(writingStartedAt);
    const writerCount = countChapterLength(output.content, lengthSpec.countingMode);

    // Token usage accumulator
    let totalUsage: TokenUsageSummary = output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    // Compute active hook count for hook-ledger net-reduction mode detection.
    const hooksMarkdownForAudit = await readFile(
      join(bookDir, "story", "pending_hooks.md"), "utf-8",
    ).catch(() => "");
    const activeHookCountForAudit = filterActiveHooks(
      parsePendingHooksMarkdown(hooksMarkdownForAudit),
    ).length;
    const reviewResult = await runChapterReviewCycle({
      book: { genre: book.genre },
      bookDir,
      chapterNumber,
      initialOutput: output,
      reducedControlInput: reducedControlInputWithPreflight,
      externalContext: writeInput.externalContext,
      lengthSpec,
      initialUsage: totalUsage,
      createReviser: () => new ReviserAgent(this.agentCtxFor("reviser", bookId)),
      auditor,
      onThinkingDelta: (text) => {
        this.config.onAuditorTextDelta?.({ bookId, chapterNumber, text });
      },
      onThinkingEnd: () => {
        this.config.onAuditorThinkingEnd?.({ bookId, chapterNumber });
      },
      onRevisedContentDelta: (text) => {
        this.config.onReviserTextDelta?.({ bookId, chapterNumber, text, mode: "spot-fix" });
      },
      onSpotFixPatchDelta: (text) => {
        this.config.onReviserPatchDelta?.({ bookId, chapterNumber, text, mode: "spot-fix" });
      },
      onReviserThinkingDelta: (text) => {
        this.config.onReviserThinkingDelta?.({ bookId, chapterNumber, mode: "spot-fix", text });
      },
      onReviserThinkingEnd: () => {
        this.config.onReviserThinkingEnd?.({ bookId, chapterNumber, mode: "spot-fix" });
      },
      normalizeDraftLengthIfNeeded: (chapterContent) => this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber,
        chapterContent,
        lengthSpec,
        chapterIntent: writeInput.chapterIntent,
      }),
      assertChapterContentNotEmpty: (content, stage) =>
        this.assertChapterContentNotEmpty(content, chapterNumber, stage),
      addUsage: PipelineRunner.addUsage,
      restoreLostAuditIssues: (previous, next) => this.restoreLostAuditIssues(previous, next),
      analyzeAITells,
      analyzeSensitiveWords,
      preflightSignals: reviewPreflight.signals,
      activeHookCount: activeHookCountForAudit,
      hookDebtContext: writeInput.chapterPlan
        ? {
            requiredRecoverHooks: writeInput.chapterPlan.requiredRecoverHooks,
            staleDebt: writeInput.chapterPlan.hookAssignment.filter(
              (id) => !writeInput.chapterPlan!.requiredRecoverHooks.includes(id),
            ),
            hardClearMode: writeInput.chapterPlan.maxNewHooks === 0,
            language: pipelineLang,
          }
        : undefined,
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logStage: (message) => this.logStage(stageLanguage, message),
      reviseMode: "spot-fix",
      unboundedReview: options?.unboundedReview ?? false,
      onAuditStart: async ({ round, maxReviseRounds, unboundedReview }) => {
        auditRoundStartedAt.set(round, this.nowMs());
        await this.config.onWriteNextAuditStart?.({
          bookId,
          chapterNumber,
          round,
          maxReviseRounds,
          phase: "audit",
          unboundedReview,
        });
      },
      onAuditComplete: async ({ round, maxReviseRounds, unboundedReview, audit }) => {
        const startedAt = auditRoundStartedAt.get(round);
        if (typeof startedAt === "number") {
          auditMs += this.elapsedMs(startedAt);
          auditRoundStartedAt.delete(round);
        }
        await this.config.onWriteNextAuditComplete?.({
          bookId,
          chapterNumber,
          round,
          maxReviseRounds,
          phase: "audit",
          unboundedReview,
          audit: {
            passed: audit.passed,
            score: audit.score,
            issueCount: audit.issueCount,
            severityCounts: audit.severityCounts,
            issueClassCounts: audit.issueClassCounts,
            primaryIssueClass: audit.primaryIssueClass,
            summary: audit.summary,
            issues: audit.issues,
          },
        });
      },
      onReviseStart: async ({ round, maxReviseRounds, unboundedReview, mode }) => {
        reviseRoundStartedAt.set(round, this.nowMs());
        await this.config.onWriteNextReviseStart?.({
          bookId,
          chapterNumber,
          round,
          maxReviseRounds,
          phase: "revise",
          mode,
          unboundedReview,
        });
      },
      onStructuralPreRevise: async ({ round, mode }) => {
        this.logStage(stageLanguage, {
          zh: `结构性预修复：第${round}轮 ${mode} 前同步 truth-files`,
          en: `Structural pre-repair: syncing truth files before round ${round} ${mode}`,
        });
        await this.syncLegacyStructuredStateFromMarkdown(
          bookDir,
          chapterNumber,
        );
        await this.syncNarrativeMemoryIndex(bookId);
      },
      onReviseComplete: async ({ round, maxReviseRounds, unboundedReview, mode, reviseResult, reviseAudit }) => {
        const startedAt = reviseRoundStartedAt.get(round);
        if (typeof startedAt === "number") {
          reviseMs += this.elapsedMs(startedAt);
          reviseRoundStartedAt.delete(round);
        }
        await this.config.onWriteNextReviseComplete?.({
          bookId,
          chapterNumber,
          round,
          maxReviseRounds,
          phase: "revise",
          mode,
          unboundedReview,
          wordCount: reviseResult.wordCount,
          applied: reviseResult.revisedContent.length > 0,
          ...(reviseAudit
            ? {
              audit: {
                passed: reviseAudit.passed,
                score: reviseAudit.score,
                issueCount: reviseAudit.issueCount,
                severityCounts: reviseAudit.severityCounts,
                issueClassCounts: reviseAudit.issueClassCounts,
                primaryIssueClass: reviseAudit.primaryIssueClass,
                summary: reviseAudit.summary,
                issues: reviseAudit.issues,
              } satisfies ReviseAuditSummary,
            }
            : {}),
        });
      },
    });
    totalUsage = reviewResult.totalUsage;
    let finalContent = reviewResult.finalContent;
    let finalWordCount = reviewResult.finalWordCount;
    let revised = reviewResult.revised;
    let auditResult = reviewResult.auditResult;
    const postReviseCount = reviewResult.postReviseCount;
    const normalizeApplied = reviewResult.normalizeApplied;
    const contentChangedBeforeQuotePolicy = finalContent !== output.content;
    let quotePolicyOnlyContentChange = false;
    if (dialogueQuotePolicy && (dialogueQuotePolicy.mode === "force_double" || dialogueQuotePolicy.mode === "force_corner")) {
      const normalizedByPolicy = normalizeDialogueQuotesByPolicy(
        finalContent,
        dialogueQuotePolicy.mode,
      );
      if (normalizedByPolicy !== finalContent) {
        quotePolicyOnlyContentChange = !contentChangedBeforeQuotePolicy;
        finalContent = normalizedByPolicy;
        finalWordCount = countChapterLength(finalContent, lengthSpec.countingMode);
        this.logStage(stageLanguage, {
          zh: `按书籍规则统一第${chapterNumber}章对白引号`,
          en: `normalizing dialogue quotes by policy for chapter ${chapterNumber}`,
        });
      }
    }
    const nonStructuralContentChange = isNonStructuralTruthContentChange(output.content, finalContent);
    const skipTruthRebuildReason = quotePolicyOnlyContentChange
      ? "quote-policy-only"
      : nonStructuralContentChange
        ? "non-structural-content"
        : null;
    if (skipTruthRebuildReason) {
      skipStateValidation = true;
    }
    if (skipTruthRebuildReason) {
      this.logInfo(stageLanguage, {
        zh: `第${chapterNumber}章跳过真相重建：reason=${skipTruthRebuildReason}，wordCount=${finalWordCount}。`,
        en: `Skipping truth rebuild for chapter ${chapterNumber}: reason=${skipTruthRebuildReason}, wordCount=${finalWordCount}.`,
      });
    }

    // 3.5 Pre-persist raw chapter draft for crash safety
    // Write to drafts/ dir to avoid bootstrapping durable-progress detection
    // (bootstrapStructuredStateFromMarkdown scans chapters/, not drafts/).
    {
      const draftsDir = join(bookDir, "drafts");
      const paddedNum = String(chapterNumber).padStart(4, "0");
      const safeTitle = output.title.replace(/[/\\?%*:|"<>]/g, "_");
      const draftFilename = `${paddedNum}_${safeTitle}.md`;
      const heading = pipelineLang === "en"
        ? `# Chapter ${chapterNumber}: ${output.title}`
        : `# 第${chapterNumber}章 ${output.title}`;
      await mkdir(draftsDir, { recursive: true });
      await writeFile(
        join(draftsDir, draftFilename),
        [heading, "", finalContent].join("\n"),
        "utf-8",
      ).catch((error: unknown) => {
        this.config.logger?.warn(`[draft] failed to save raw chapter draft: ${String(error)}`);
      });
    }

    // 4. Save the final chapter and truth files from a single persistence source
    this.logStage(stageLanguage, { zh: "落盘最终章节", en: "persisting final chapter" });
    this.logStage(stageLanguage, { zh: "生成最终真相文件", en: "rebuilding final truth files" });
    const chapterIndexBeforePersist = await this.state.loadChapterIndex(bookId);
    const { resolveDuplicateTitle } = await import("../agents/post-write-validator.js");
    const initialTitleResolution = resolveDuplicateTitle(
      output.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    const persistenceSeedOutput = initialTitleResolution.title === output.title
      ? output
      : { ...output, title: initialTitleResolution.title };
    const truthRebuildStartedAt = this.nowMs();
    let persistenceOutput: WriteChapterOutput;
    try {
      persistenceOutput = await this.withStageHeartbeat(
        stageLanguage,
        { zh: "生成最终真相文件", en: "rebuilding final truth files" },
        () => this.buildPersistenceOutput(
          bookId,
          book,
          bookDir,
          chapterNumber,
          persistenceSeedOutput,
          finalContent,
          lengthSpec.countingMode,
          reducedControlInput,
          { skipTruthRebuild: skipTruthRebuildReason !== null },
        ),
        { suppressElapsedLog: true },
      );
    } catch (error: unknown) {
      this.config.logger?.warn(`[persist] truth rebuild failed; falling back to raw output: ${String(error)}`);
      persistenceOutput = {
        ...persistenceSeedOutput,
        content: finalContent,
        wordCount: finalWordCount,
      };
    }
    truthRebuildMs += this.elapsedMs(truthRebuildStartedAt);
    const finalTitleResolution = resolveDuplicateTitle(
      persistenceOutput.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    if (finalTitleResolution.title !== persistenceOutput.title) {
      persistenceOutput = {
        ...persistenceOutput,
        title: finalTitleResolution.title,
      };
    }
    if (persistenceOutput.title !== output.title) {
      const description = pipelineLang === "en"
        ? `Chapter title "${output.title}" was auto-adjusted to "${persistenceOutput.title}".`
        : `章节标题"${output.title}"已自动调整为"${persistenceOutput.title}"。`;
      this.config.logger?.warn(`[title] ${description}`);
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, {
          severity: "warning",
          category: "title-dedup",
          description,
          suggestion: pipelineLang === "en"
            ? "If the auto-renamed title is weak, revise the chapter title manually."
            : "如果自动改名不理想，可以在后续手动修订章节标题。",
        }],
      };
    }
    const longSpanFatigue = await analyzeLongSpanFatigue({
      bookDir,
      chapterNumber,
      chapterContent: finalContent,
      chapterSummary: persistenceOutput.chapterSummary,
      language: pipelineLang,
    });
    auditResult = {
      ...auditResult,
      issues: [
        ...auditResult.issues,
        ...longSpanFatigue.issues,
        ...(persistenceOutput.hookHealthIssues ?? []),
      ],
    };
    await this.recordAuditFailureHistory(bookDir, chapterNumber, auditResult).catch(() => undefined);
    finalWordCount = persistenceOutput.wordCount;
    const lengthWarnings = this.buildLengthWarnings(
      chapterNumber,
      finalWordCount,
      lengthSpec,
    );
    const lengthTelemetry = this.buildLengthTelemetry({
      lengthSpec,
      writerCount,
      postWriterNormalizeCount: reviewResult.preAuditNormalizedWordCount,
      postReviseCount,
      finalCount: finalWordCount,
      normalizeApplied,
      lengthWarning: lengthWarnings.length > 0,
    });
    this.logLengthWarnings(lengthWarnings);

    // 4.1 Validate settler output before writing
    let chapterStatus: ChapterPipelineResult["status"] | null = null;
    let degradedIssues: ReadonlyArray<AuditIssue> = [];
    if (!skipStateValidation) {
      this.logStage(stageLanguage, { zh: "校验真相文件变更", en: "validating truth file updates" });
      const stateValidationStartedAt = this.nowMs();
      const storyDir = join(bookDir, "story");
      const [oldState, oldHooks, oldLedger] = await Promise.all([
        readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "particle_ledger.md"), "utf-8").catch(() => ""),
      ]);
      const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
      let truthValidation;
      try {
        truthValidation = await this.withStageHeartbeat(
          stageLanguage,
          { zh: "校验真相文件变更", en: "validating truth file updates" },
          () => validateChapterTruthPersistence({
            writer,
            validator,
            book,
            bookDir,
            chapterNumber,
            title: persistenceOutput.title,
            content: finalContent,
            persistenceOutput,
            auditResult,
            previousTruth: {
              oldState,
              oldHooks,
              oldLedger,
            },
            reducedControlInput,
            language: pipelineLang,
            logWarn: (message) => this.logWarn(pipelineLang, message),
            logger: this.config.logger,
          }),
        );
        chapterStatus = truthValidation.chapterStatus;
        degradedIssues = truthValidation.degradedIssues;
        persistenceOutput = truthValidation.persistenceOutput;
        auditResult = truthValidation.auditResult;
      } catch (error: unknown) {
        this.config.logger?.warn(`[persist] state validation failed; continuing: ${String(error)}`);
      }
      stateValidationMs += this.elapsedMs(stateValidationStartedAt);
    } else {
      this.logWarn(stageLanguage, {
        zh: "快速模式：已跳过真相文件状态校验。",
        en: "Quick mode: state validation for truth files skipped.",
      });
    }

    // 4.2 Final paragraph shape check on persisted content (post-normalize, post-revise)
    {
      const {
        detectParagraphLengthDrift,
        detectParagraphShapeWarnings,
      } = await import("../agents/post-write-validator.js");
      const chapDir = join(bookDir, "chapters");
      const recentFiles = (await readdir(chapDir).catch(() => [] as string[]))
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(-5);
      const recentContent = (await Promise.all(
        recentFiles.map((f) => readFile(join(chapDir, f), "utf-8").catch(() => "")),
      )).join("\n\n");
      const paragraphIssues = [
        ...detectParagraphShapeWarnings(finalContent, pipelineLang),
        ...detectParagraphLengthDrift(finalContent, recentContent, pipelineLang),
      ];
      if (paragraphIssues.length > 0) {
        for (const issue of paragraphIssues) {
          this.config.logger?.warn(`[paragraph] ${issue.description}`);
        }
        auditResult = {
          ...auditResult,
          issues: [...auditResult.issues, ...paragraphIssues.map((v) => ({
            severity: v.severity as "warning",
            category: "paragraph-shape",
            description: v.description,
            suggestion: v.suggestion,
          }))],
        };
      }
    }

    const resolvedStatus = chapterStatus ?? (auditResult.passed ? "ready-for-review" : "audit-failed");
    const writeNextFinalAudit = buildReviseAuditSummaryFromResult(auditResult);
    const autoReviewFinalNote = auditResult.passed
      ? undefined
      : buildAutoReviewFinalNote({
        finalState: reviewResult.autoReview.stoppedByMaxRounds
          ? "failed-max-rounds"
          : "failed-single-audit",
        stopReason: reviewResult.autoReview.stopReason,
        audit: writeNextFinalAudit,
      });
    const indexSyncStartedAt = this.nowMs();
    await persistChapterArtifacts({
      chapterNumber,
      chapterTitle: persistenceOutput.title,
      status: resolvedStatus,
      auditResult,
      auditReport: writeNextFinalAudit.report,
      finalWordCount,
      lengthWarnings,
      lengthTelemetry,
      reviewNote: autoReviewFinalNote,
      degradedIssues,
      tokenUsage: totalUsage,
      loadChapterIndex: () => this.state.loadChapterIndex(bookId),
      saveChapter: () => writer.saveChapter(bookDir, persistenceOutput, gp.numericalSystem, pipelineLang),
      saveTruthFiles: async () => {
        await writer.saveNewTruthFiles(bookDir, persistenceOutput, pipelineLang);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, persistenceOutput);
        if (deferMemorySync) {
          this.runInBackground(
            stageLanguage,
            { zh: "同步记忆索引", en: "syncing memory indexes" },
            () => this.syncNarrativeMemoryIndex(bookId),
          );
          return;
        }
        this.logStage(stageLanguage, { zh: "同步记忆索引", en: "syncing memory indexes" });
        await this.withStageHeartbeat(
          stageLanguage,
          { zh: "同步记忆索引", en: "syncing memory indexes" },
          () => this.syncNarrativeMemoryIndex(bookId),
        );
      },
      saveChapterIndex: (index) => this.state.saveChapterIndex(bookId, index),
      markBookActiveIfNeeded: () => this.markBookActiveIfNeeded(bookId),
      persistAuditDriftGuidance: (issues) => this.persistAuditDriftGuidance({
        bookDir,
        chapterNumber,
        issues,
        language: stageLanguage,
      }).catch(() => undefined),
      snapshotState: async () => {
        if (deferSnapshotSync) {
          return;
        }
        await this.state.snapshotState(bookId, chapterNumber);
      },
      syncCurrentStateFactHistory: async () => {
        if (deferSnapshotSync) {
          this.runInBackground(
            stageLanguage,
            { zh: "更新章节快照与事实历史", en: "updating snapshots and fact history" },
            async () => {
              await this.state.snapshotState(bookId, chapterNumber);
              await this.syncCurrentStateFactHistory(bookId, chapterNumber);
            },
          );
          return;
        }
        await this.syncCurrentStateFactHistory(bookId, chapterNumber);
      },
      logSnapshotStage: () =>
        this.logStage(stageLanguage, { zh: "更新章节索引与快照", en: "updating chapter index and snapshots" }),
    });
    indexSyncMs += this.elapsedMs(indexSyncStartedAt);

    // 6. Send notification
    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      const statusEmoji = resolvedStatus === "state-degraded"
        ? "🧯"
        : auditResult.passed ? "✅" : "⚠️";
      const chapterLength = formatLengthCount(finalWordCount, lengthSpec.countingMode);
      await dispatchNotification(this.config.notifyChannels, {
        title: `${statusEmoji} ${book.title} 第${chapterNumber}章`,
        body: [
          `**${persistenceOutput.title}** | ${chapterLength}`,
          revised ? "📝 已自动修正" : "",
          resolvedStatus === "state-degraded"
            ? "状态结算: 已降级保存，需先修复 state 再继续"
            : `审稿: ${auditResult.passed ? "通过" : "需人工审核"}`,
          ...auditResult.issues
            .filter((i) => i.severity !== "info")
            .map((i) => `- [${i.severity}] ${i.description}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    await this.emitWebhook("pipeline-complete", bookId, chapterNumber, {
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      passed: auditResult.passed,
      revised,
      status: resolvedStatus,
    });

    const performance = {
      totalMs: this.elapsedMs(writeNextStartedAt),
      inputPrepMs,
      writingMs,
      auditMs,
      reviseMs,
      truthRebuildMs,
      stateValidationMs,
      indexSyncMs,
    } as const;
    await this.appendWriteNextPerformanceSample(bookDir, {
      chapterNumber,
      ...performance,
    }).catch(() => undefined);
    this.logWriteNextPerformance(stageLanguage, chapterNumber, performance);

    return {
      chapterNumber,
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      auditResult,
      autoReview: {
        ...reviewResult.autoReview,
        finalState: auditResult.passed
          ? "passed"
          : (reviewResult.autoReview.stoppedByMaxRounds ? "failed-max-rounds" : "failed-single-audit"),
      },
      structuralIssueCount: countIssueClassesForMetrics(auditResult.issues).structural,
      textualIssueCount: countIssueClassesForMetrics(auditResult.issues).textual,
      revised,
      status: resolvedStatus,
      lengthWarnings,
      lengthTelemetry,
      tokenUsage: totalUsage,
      performance,
    };
  }

  private async _repairChapterStateLocked(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to repair.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }
    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetMeta.status !== "state-degraded") {
      throw new Error(`Chapter ${targetChapter} is not state-degraded.`);
    }
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest state-degraded chapter can be repaired safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "修复章节状态结算", en: "repairing chapter state settlement" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let repairedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      repairedOutput.updatedState,
      oldHooks,
      repairedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description
            ?? `State repair still failed for chapter ${targetChapter}.`,
        );
      }
      repairedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`State repair still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, repairedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, repairedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, repairedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const baseStatus = resolveStateDegradedBaseStatus(targetMeta);
    const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
    const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
    index[targetIndex] = {
      ...targetMeta,
      status: baseStatus,
      updatedAt: new Date().toISOString(),
      auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
      reviewNote: undefined,
    };
    await this.state.saveChapterIndex(bookId, index);

    const repairedPassesAudit = baseStatus !== "audit-failed";
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: repairedPassesAudit,
        issues: [],
        summary: repairedPassesAudit ? "state repaired" : "state repaired but chapter still needs review",
      },
      structuralIssueCount: 0,
      textualIssueCount: 0,
      revised: false,
      status: baseStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  private async _resyncChapterArtifactsLocked(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to sync.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }

    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest persisted chapter can be synced safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "根据已编辑正文同步真相文件与索引", en: "syncing truth files and indexes from edited chapter body" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const reducedControlInput = (this.config.inputGovernanceMode ?? "v2") === "legacy"
      ? undefined
      : await this.createGovernedArtifacts(
        book,
        bookDir,
        targetChapter,
        this.config.externalContext,
        { reuseExistingIntentWhenContextMissing: true },
      );

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let syncedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      chapterIntent: reducedControlInput?.plan.intentMarkdown,
      contextPackage: reducedControlInput?.composed.contextPackage,
      ruleStack: reducedControlInput?.composed.ruleStack,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      syncedOutput.updatedState,
      oldHooks,
      syncedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        reducedControlInput: reducedControlInput
          ? {
              chapterIntent: reducedControlInput.plan.intentMarkdown,
              contextPackage: reducedControlInput.composed.contextPackage,
              ruleStack: reducedControlInput.composed.ruleStack,
            }
          : undefined,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description
            ?? `Chapter sync still failed for chapter ${targetChapter}.`,
        );
      }
      syncedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`Chapter sync still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, syncedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, syncedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, syncedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const finalStatus: "ready-for-review" | "audit-failed" = targetMeta.status === "state-degraded"
      ? resolveStateDegradedBaseStatus(targetMeta)
      : "ready-for-review";

    if (targetMeta.status === "state-degraded") {
      const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
      const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
      index[targetIndex] = {
        ...targetMeta,
        status: finalStatus,
        updatedAt: new Date().toISOString(),
        auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
        reviewNote: undefined,
      };
    } else {
      index[targetIndex] = {
        ...targetMeta,
        status: "ready-for-review",
        updatedAt: new Date().toISOString(),
      };
    }
    await this.state.saveChapterIndex(bookId, index);
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: finalStatus !== "audit-failed",
        issues: [],
        summary: finalStatus === "audit-failed"
          ? "chapter truth/state resynced from edited body, but chapter still needs audit fixes"
          : "chapter truth/state resynced from edited body",
      },
      structuralIssueCount: 0,
      textualIssueCount: 0,
      revised: false,
      status: finalStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Import operations (style imitation + canon for spinoff)
  // ---------------------------------------------------------------------------

  /**
   * Generate a qualitative style guide from reference text via LLM.
   * Also saves the statistical style_profile.json.
   */
  async generateStyleGuide(bookId: string, referenceText: string, sourceName?: string): Promise<string> {
    if (referenceText.length < 500) {
      throw new Error(`Reference text too short (${referenceText.length} chars, minimum 500). Provide at least 2000 chars for reliable style extraction.`);
    }

    const { analyzeStyle } = await import("../agents/style-analyzer.js");
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    // Statistical fingerprint
    const profile = analyzeStyle(referenceText, sourceName);
    await writeFile(join(storyDir, "style_profile.json"), JSON.stringify(profile, null, 2), "utf-8");

    // LLM qualitative extraction
    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位文学风格分析专家。分析参考文本的写作风格，提取可供模仿的定性特征。

输出格式（Markdown）：
## 叙事声音与语气
（冷峻/热烈/讽刺/温情/...，附1-2个原文例句）

## 对话风格
（角色说话的共性特征：句子长短、口头禅倾向、方言痕迹、对话节奏）

## 场景描写特征
（五感偏好、意象选择、描写密度、环境与情绪的关联方式）

## 转折与衔接手法
（场景如何切换、时间跳跃的处理方式、段落间的过渡特征）

## 节奏特征
（长短句分布、段落长度偏好、高潮/舒缓的交替方式）

## 词汇偏好
（高频特色用词、比喻/修辞倾向、口语化程度）

## 情绪表达方式
（直白抒情 vs 动作外化、内心独白的频率和风格）

## 独特习惯
（任何值得模仿的个人写作习惯）

分析必须基于原文实际特征，不要泛泛而谈。每个部分用1-2个原文例句佐证。`,
      },
      {
        role: "user",
        content: `分析以下参考文本的写作风格：\n\n${referenceText.slice(0, 20000)}`,
      },
    ], { temperature: 0.3 });

    await writeFile(join(storyDir, "style_guide.md"), response.content, "utf-8");
    return response.content;
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Reads parent's truth files, uses LLM to generate parent_canon.md in target book.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    // Validate both books exist
    const bookIds = await this.state.listBooks();
    if (!bookIds.includes(parentBookId)) {
      throw new Error(`Parent book "${parentBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }
    if (!bookIds.includes(targetBookId)) {
      throw new Error(`Target book "${targetBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }

    const parentDir = this.state.bookDir(parentBookId);
    const targetDir = this.state.bookDir(targetBookId);
    const storyDir = join(targetDir, "story");
    await mkdir(storyDir, { recursive: true });

    const readSafe = async (path: string): Promise<string> => {
      try { return await readFile(path, "utf-8"); } catch { return "(无)"; }
    };

    const parentBook = await this.state.loadBookConfig(parentBookId);

    const [storyBible, currentState, ledger, hooks, summaries, subplots, emotions, matrix] =
      await Promise.all([
        readSafe(join(parentDir, "story/story_bible.md")),
        readSafe(join(parentDir, "story/current_state.md")),
        readSafe(join(parentDir, "story/particle_ledger.md")),
        readSafe(join(parentDir, "story/pending_hooks.md")),
        readSafe(join(parentDir, "story/chapter_summaries.md")),
        readSafe(join(parentDir, "story/subplot_board.md")),
        readSafe(join(parentDir, "story/emotional_arcs.md")),
        readSafe(join(parentDir, "story/character_matrix.md")),
      ]);

    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位网络小说架构师。基于正传的全部设定和状态文件，生成一份完整的"正传正典参照"文档，供番外写作和审计使用。

输出格式（Markdown）：
# 正传正典（《{正传书名}》）

## 世界规则（完整，来自正传设定）
（力量体系、地理设定、阵营关系、核心规则——完整复制，不压缩）

## 正典约束（不可违反的事实）
| 约束ID | 类型 | 约束内容 | 严重性 |
|---|---|---|---|
| C01 | 人物存亡 | ... | critical |
（列出所有硬性约束：谁活着、谁死了、什么事件已经发生、什么规则不可违反）

## 角色快照
| 角色 | 当前状态 | 性格底色 | 对话特征 | 已知信息 | 未知信息 |
|---|---|---|---|---|---|
（从状态卡和角色矩阵中提取每个重要角色的完整快照）

## 角色双态处理原则
- 未来会变强的角色：写潜力暗示
- 未来会黑化的角色：写微小裂痕
- 未来会死的角色：写导致死亡的性格底色

## 关键事件时间线
| 章节 | 事件 | 涉及角色 | 对番外的约束 |
|---|---|---|---|
（从章节摘要中提取关键事件）

## 伏笔状态
| Hook ID | 类型 | 状态 | 内容 | 预期回收 |
|---|---|---|---|---|

## 资源账本快照
（当前资源状态）

---
meta:
  parentBookId: "{parentBookId}"
  parentTitle: "{正传书名}"
  generatedAt: "{ISO timestamp}"

要求：
1. 世界规则完整复制，不压缩——准确性优先
2. 正典约束必须穷尽，遗漏会导致番外与正传矛盾
3. 角色快照必须包含信息边界（已知/未知），防止番外中角色引用不该知道的信息`,
      },
      {
        role: "user",
        content: `正传书名：${parentBook.title}
正传ID：${parentBookId}

## 正传世界设定
${storyBible}

## 正传当前状态卡
${currentState}

## 正传资源账本
${ledger}

## 正传伏笔池
${hooks}

## 正传章节摘要
${summaries}

## 正传支线进度
${subplots}

## 正传情感弧线
${emotions}

## 正传角色矩阵
${matrix}`,
      },
    ], { temperature: 0.3 });

    // Append deterministic meta block (LLM may hallucinate timestamps)
    const metaBlock = [
      "",
      "---",
      "meta:",
      `  parentBookId: "${parentBookId}"`,
      `  parentTitle: "${parentBook.title}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");
    const canon = response.content + metaBlock;

    await writeFile(join(storyDir, "parent_canon.md"), canon, "utf-8");

    // Also generate style guide from parent's chapter text if available
    const parentChaptersDir = join(parentDir, "chapters");
    const parentChapterText = await this.readParentChapterSample(parentChaptersDir);
    if (parentChapterText.length >= 500) {
      await this.tryGenerateStyleGuide(targetBookId, parentChapterText, parentBook.title);
    }

    return canon;
  }

  private async readParentChapterSample(chaptersDir: string): Promise<string> {
    try {
      const entries = await readdir(chaptersDir);
      const mdFiles = entries
        .filter((file) => file.endsWith(".md"))
        .sort()
        .slice(0, 5);
      const chunks: string[] = [];
      let totalLength = 0;
      for (const file of mdFiles) {
        if (totalLength >= 20000) break;
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chunks.push(content);
        totalLength += content.length;
      }
      return chunks.join("\n\n---\n\n");
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Chapter import (for continuation writing from existing chapters)
  // ---------------------------------------------------------------------------

  /**
   * Import existing chapters into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   *
   * Step 1: Generate foundation (story_bible, volume_outline, book_rules) from all chapters.
   * Step 2: Sequentially replay each chapter through ChapterAnalyzer to build truth files.
   */
  async importChapters(input: ImportChaptersInput): Promise<ImportChaptersResult> {
    const releaseLock = await this.state.acquireBookLock(input.bookId);
    try {
      const book = await this.state.loadBookConfig(input.bookId);
      const bookDir = this.state.bookDir(input.bookId);
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const resolvedLanguage = book.language ?? gp.language;

      const startFrom = input.resumeFrom ?? 1;

      const log = this.config.logger?.child("import");

      // Step 1: Generate foundation on first run (not on resume)
      if (startFrom === 1) {
        log?.info(this.localize(resolvedLanguage, {
          zh: `步骤 1：从 ${input.chapters.length} 章生成基础设定...`,
          en: `Step 1: Generating foundation from ${input.chapters.length} chapters...`,
        }));
        const allText = input.chapters.map((c, i) =>
          resolvedLanguage === "en"
            ? `Chapter ${i + 1}: ${c.title}\n\n${c.content}`
            : `第${i + 1}章 ${c.title}\n\n${c.content}`,
        ).join("\n\n---\n\n");

        const architect = new ArchitectAgent(this.agentCtxFor("architect", input.bookId));
        const isSeries = input.importMode === "series";
        const foundation = isSeries
          ? await this.generateAndReviewFoundation({
              generate: (reviewFeedback) => architect.generateFoundationFromImport(book, allText, undefined, reviewFeedback, { importMode: "series" }),
              reviewer: new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", input.bookId)),
              mode: "series",
              language: resolvedLanguage === "en" ? "en" : "zh",
              stageLanguage: resolvedLanguage,
            })
          : await architect.generateFoundationFromImport(book, allText);
        await architect.writeFoundationFiles(
          bookDir,
          foundation,
          gp.numericalSystem,
          resolvedLanguage,
        );
        await this.resetImportReplayTruthFiles(bookDir, resolvedLanguage);
        await this.state.saveChapterIndex(input.bookId, []);
        await this.state.snapshotState(input.bookId, 0);

        // Generate style guide from imported chapters
        if (allText.length >= 500) {
          log?.info(this.localize(resolvedLanguage, {
            zh: "提取原文风格指纹...",
            en: "Extracting source style fingerprint...",
          }));
          await this.tryGenerateStyleGuide(input.bookId, allText, book.title, resolvedLanguage);
        }

        log?.info(this.localize(resolvedLanguage, {
          zh: "基础设定已生成。",
          en: "Foundation generated.",
        }));
      }

      // Step 2: Sequential replay
      log?.info(this.localize(resolvedLanguage, {
        zh: `步骤 2：从第 ${startFrom} 章开始顺序回放...`,
        en: `Step 2: Sequential replay from chapter ${startFrom}...`,
      }));
      const analyzer = new ChapterAnalyzerAgent(this.agentCtxFor("chapter-analyzer", input.bookId));
      const writer = new WriterAgent(this.agentCtxFor("writer", input.bookId));
      const countingMode = resolveLengthCountingMode(book.language ?? gp.language);
      let totalWords = 0;
      let importedCount = 0;

      for (let i = startFrom - 1; i < input.chapters.length; i++) {
        const ch = input.chapters[i]!;
        const chapterNumber = i + 1;
        const governedInput = await this.prepareWriteInput(book, bookDir, chapterNumber);

        log?.info(this.localize(resolvedLanguage, {
          zh: `分析章节 ${chapterNumber}/${input.chapters.length}：${ch.title}...`,
          en: `Analyzing chapter ${chapterNumber}/${input.chapters.length}: ${ch.title}...`,
        }));

        // Analyze chapter to get truth file updates
        const output = await analyzer.analyzeChapter({
          book,
          bookDir,
          chapterNumber,
          chapterContent: ch.content,
          chapterTitle: ch.title,
          chapterIntent: governedInput.chapterIntent,
          contextPackage: governedInput.contextPackage,
          ruleStack: governedInput.ruleStack,
        });

        // Save chapter file + core truth files (state, ledger, hooks)
        await writer.saveChapter(bookDir, {
          ...output,
          postWriteErrors: [],
          postWriteWarnings: [],
        }, gp.numericalSystem, resolvedLanguage);

        // Save extended truth files (summaries, subplots, emotional arcs, character matrix)
        await writer.saveNewTruthFiles(bookDir, {
          ...output,
          postWriteErrors: [],
          postWriteWarnings: [],
        }, resolvedLanguage);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, output);
        await this.syncNarrativeMemoryIndex(input.bookId);

        // Update chapter index
        const existingIndex = await this.state.loadChapterIndex(input.bookId);
        const now = new Date().toISOString();
        const chapterWordCount = countChapterLength(ch.content, countingMode);
        const newEntry: ChapterMeta = {
          number: chapterNumber,
          title: output.title,
          status: "imported",
          wordCount: chapterWordCount,
          createdAt: now,
          updatedAt: now,
          auditIssues: [],
          lengthWarnings: [],
        };
        // Replace if exists (resume case), otherwise append
        const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
        const updatedIndex = existingIdx >= 0
          ? existingIndex.map((e, idx) => idx === existingIdx ? newEntry : e)
          : [...existingIndex, newEntry];
        await this.state.saveChapterIndex(input.bookId, updatedIndex);

        // Snapshot state after each chapter for rollback + resume support
        await this.state.snapshotState(input.bookId, chapterNumber);

        importedCount++;
        totalWords += chapterWordCount;
      }

      if (input.chapters.length > 0) {
        await this.markBookActiveIfNeeded(input.bookId);
        await this.syncCurrentStateFactHistory(input.bookId, input.chapters.length);
      }

      const nextChapter = input.chapters.length + 1;
      log?.info(this.localize(resolvedLanguage, {
        zh: `完成。已导入 ${importedCount} 章，共 ${formatLengthCount(totalWords, countingMode)}。下一章：${nextChapter}`,
        en: `Done. ${importedCount} chapters imported, ${formatLengthCount(totalWords, countingMode)}. Next chapter: ${nextChapter}`,
      }));

      return {
        bookId: input.bookId,
        importedCount,
        totalWords,
        nextChapter,
      };
    } finally {
      await releaseLock();
    }
  }

  private static addUsage(
    a: TokenUsageSummary,
    b?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number },
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  private async buildPersistenceOutput(
    bookId: string,
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    output: WriteChapterOutput,
    finalContent: string,
    countingMode: Parameters<typeof countChapterLength>[1],
    reducedControlInput?: {
      chapterIntent: string;
      contextPackage: ContextPackage;
      ruleStack: RuleStack;
    },
    options?: {
      skipTruthRebuild?: boolean;
    },
  ): Promise<WriteChapterOutput> {
    if (finalContent === output.content) {
      return output;
    }
    if (options?.skipTruthRebuild) {
      return {
        ...output,
        content: finalContent,
        wordCount: countChapterLength(finalContent, countingMode),
      };
    }

    const analyzer = new ChapterAnalyzerAgent(this.agentCtxFor("chapter-analyzer", bookId));
    const analyzed = await analyzer.analyzeChapter({
      book,
      bookDir,
      chapterNumber,
      chapterContent: finalContent,
      chapterTitle: output.title,
      chapterIntent: reducedControlInput?.chapterIntent,
      contextPackage: reducedControlInput?.contextPackage,
      ruleStack: reducedControlInput?.ruleStack,
    });

    return {
      ...analyzed,
      content: finalContent,
      wordCount: countChapterLength(finalContent, countingMode),
      postWriteErrors: [],
      postWriteWarnings: [],
      hookHealthIssues: output.hookHealthIssues,
      tokenUsage: output.tokenUsage,
    };
  }

  private async assertNoPendingStateRepair(bookId: string, allowContinue: boolean): Promise<void> {
    const existingIndex = await this.state.loadChapterIndex(bookId);
    const latestChapter = [...existingIndex].sort((left, right) => right.number - left.number)[0];
    if (latestChapter?.status !== "state-degraded") {
      return;
    }

    if (allowContinue) {
      return;
    }

    throw new Error(
      `Latest chapter ${latestChapter.number} is state-degraded. Repair state or rewrite that chapter before continuing.`,
    );
  }

  private async assertNoPendingAuditFailure(bookId: string, language: LengthLanguage, allowContinue: boolean): Promise<void> {
    const existingIndex = await this.state.loadChapterIndex(bookId);
    const latestChapter = [...existingIndex].sort((left, right) => right.number - left.number)[0];
    if (latestChapter?.status !== "audit-failed") {
      return;
    }

    if (allowContinue) {
      this.logWarn(language, {
        zh: `最新章节 ${latestChapter.number} 审计未通过，继续写作并等待后续修订。`,
        en: `Latest chapter ${latestChapter.number} failed audit; continuing write-next and leaving revision for later.`,
      });
      return;
    }

    throw new Error(
      `Latest chapter ${latestChapter.number} failed audit. Revise/rewrite and pass audit before writing the next chapter.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<Pick<WriteChapterInput, "externalContext" | "chapterIntent" | "contextPackage" | "ruleStack" | "trace" | "chapterPlan">> {
    const auditDriftGuidance = await this.loadAuditDriftGuidance(bookDir);
    const auditFailureHints = await this.buildAuditFailureHints(bookDir);
    const mergedExternalContext = this.mergeExternalContext(
      externalContext,
      [auditDriftGuidance, auditFailureHints].filter((part): part is string => Boolean(part && part.trim().length > 0)).join("\n\n") || undefined,
    );

    // Load chapter plan if available
    let chapterPlan: ChapterPlan | undefined;
    try {
      const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
      const raw = await readFile(plansPath, "utf-8");
      const data = JSON.parse(raw);
      const plans: ChapterPlan[] = Array.isArray(data.plans) ? data.plans : [];
      const matched = plans.find((p) => p.chapterNumber === chapterNumber);
      if (matched) {
        chapterPlan = ChapterPlanSchema.parse(matched);
      }
    } catch { /* no chapter-plans.json — ignore */ }

    if ((this.config.inputGovernanceMode ?? "v2") === "legacy") {
      return { externalContext: mergedExternalContext, chapterPlan };
    }

    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      mergedExternalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      externalContext: mergedExternalContext,
      chapterIntent: plan.intentMarkdown,
      contextPackage: composed.contextPackage,
      ruleStack: composed.ruleStack,
      trace: composed.trace,
      chapterPlan,
    };
  }

  private assertGovernedOutlineAnchor(plan: PlanChapterOutput, chapterNumber: number): void {
    if (!this.config.enforceOutlineAnchorMatch) return;
    if (plan.intent.outlineAnchorMatched === true) return;
    throw new OutlineAnchorMismatchError(
      chapterNumber,
      `OUTLINE_ANCHOR_NOT_FOUND: chapter ${chapterNumber} has no explicit anchor in volume_outline.md`,
    );
  }

  /**
   * Append a chapter-level placeholder entry to volume_outline.md when the
   * chapter is missing from the outline. This allows re-writing a deleted
   * chapter or writing beyond the original outline scope without failing the
   * enforceOutlineAnchorMatch guard.
   */
  private async extendVolumeOutlineForChapter(
    bookDir: string,
    chapterNumber: number,
    language: string | undefined,
  ): Promise<void> {
    const outlinePath = join(bookDir, "story", "outline", "volume_map.md");
    const outline = await readVolumeMap(bookDir, "");
    if (!outline) return;

    const isZh = !language || language.startsWith("zh");
    const lines = outline.split("\n").map((l) => l.trim()).filter(Boolean);

    // Check exact match: "Chapter N" or "第N章"
    const exactPattern = isZh
      ? new RegExp(
        `^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?第\\s*${chapterNumber}\\s*章(?!\\d|\\s*[-~–—]\\s*\\d)`,
      )
      : new RegExp(
        `^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?Chapter\\s*${chapterNumber}(?!\\d|\\s*[-~–—]\\s*\\d)`,
        "i",
      );

    // Check range match: "第A-B章" or "Chapter A-B"
    const rangePattern = isZh
      ? /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章/
      : /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*(\d+)\s*[-~–—]\s*(\d+)\b/i;

    const hasAnchor = lines.some((line) => {
      if (exactPattern.test(line)) return true;
      const rangeMatch = line.match(rangePattern);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]!, 10);
        const end = parseInt(rangeMatch[2]!, 10);
        if (start <= chapterNumber && chapterNumber <= end) return true;
      }
      return false;
    });

    if (hasAnchor) return;

    const suffix = outline.endsWith("\n") ? "" : "\n";
    const entry = isZh ? `\n## 第${chapterNumber}章` : `\n## Chapter ${chapterNumber}`;
    await mkdir(join(bookDir, "story", "outline"), { recursive: true });
    await writeFile(outlinePath, outline + suffix + entry + "\n", "utf-8");
    await writeFile(join(bookDir, "story", "volume_outline.md"), outline + suffix + entry + "\n", "utf-8").catch(() => undefined);
  }

  private mergeExternalContext(
    externalContext: string | undefined,
    auditDriftGuidance: string | undefined,
  ): string | undefined {
    const parts = [externalContext?.trim(), auditDriftGuidance?.trim()].filter((part): part is string => Boolean(part && part.length > 0));
    if (parts.length === 0) return undefined;
    return parts.join("\n\n");
  }

  private async loadAuditDriftGuidance(bookDir: string): Promise<string | undefined> {
    const driftPath = join(bookDir, "story", "audit_drift.md");
    const raw = await readFile(driftPath, "utf-8").catch(() => "");
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;

    const lines = trimmed.split("\n").map((line) => line.trimEnd());
    const summaryLines: string[] = [];
    let inQuoteBlock = false;
    for (const line of lines) {
      if (line.startsWith(">")) {
        const cleaned = line.replace(/^>\s?/u, "").trim();
        if (!cleaned) continue;
        if (cleaned.startsWith("- ")) {
          summaryLines.push(cleaned);
        } else if (cleaned.startsWith("Chapter ") || cleaned.startsWith("第")) {
          summaryLines.push(cleaned);
        }
        continue;
      }
      if (line === "## Audit Drift Correction" || line === "## 审计纠偏（自动生成，下一章写作前参照）") {
        continue;
      }
      if (line.startsWith("## ")) {
        summaryLines.push(line);
        continue;
      }
      if (line.length === 0) {
        inQuoteBlock = false;
        continue;
      }
      if (!inQuoteBlock && summaryLines.length === 0) {
        summaryLines.push(line);
      }
      inQuoteBlock = false;
    }

    const compact = summaryLines.slice(0, 8).join("\n").trim();
    return compact.length > 0 ? compact : trimmed;
  }

  private async resetImportReplayTruthFiles(
    bookDir: string,
    language: LengthLanguage,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        this.buildImportReplayStateSeed(language),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        this.buildImportReplayHooksSeed(language),
        "utf-8",
      ),
      rm(join(storyDir, "chapter_summaries.md"), { force: true }),
      rm(join(storyDir, "subplot_board.md"), { force: true }),
      rm(join(storyDir, "emotional_arcs.md"), { force: true }),
      rm(join(storyDir, "character_matrix.md"), { force: true }),
      rm(join(storyDir, "volume_summaries.md"), { force: true }),
      rm(join(storyDir, "particle_ledger.md"), { force: true }),
      rm(join(storyDir, "memory.db"), { force: true }),
      rm(join(storyDir, "memory.db-shm"), { force: true }),
      rm(join(storyDir, "memory.db-wal"), { force: true }),
      rm(join(storyDir, "state"), { recursive: true, force: true }),
      rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
    ]);
  }

  private buildImportReplayStateSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 0 |",
        "| Current Location | (not set) |",
        "| Protagonist State | (not set) |",
        "| Current Goal | (not set) |",
        "| Current Constraint | (not set) |",
        "| Current Alliances | (not set) |",
        "| Current Conflict | (not set) |",
        "",
      ].join("\n");
    }

    return [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 0 |",
      "| 当前位置 | （未设定） |",
      "| 主角状态 | （未设定） |",
      "| 当前目标 | （未设定） |",
      "| 当前限制 | （未设定） |",
      "| 当前敌我 | （未设定） |",
      "| 当前冲突 | （未设定） |",
      "",
    ].join("\n");
  }

  private buildImportReplayHooksSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
    }

    return [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  private async normalizeDraftLengthIfNeeded(params: {
    bookId: string;
    chapterNumber: number;
    chapterContent: string;
    lengthSpec: LengthSpec;
    chapterIntent?: string;
  }): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: TokenUsageSummary;
  }> {
    const writerCount = countChapterLength(
      params.chapterContent,
      params.lengthSpec.countingMode,
    );
    if (!isOutsideSoftRange(writerCount, params.lengthSpec)) {
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    const normalizer = new LengthNormalizerAgent(
      this.agentCtxFor("length-normalizer", params.bookId),
    );
    const normalized = await normalizer.normalizeChapter({
      chapterContent: params.chapterContent,
      lengthSpec: params.lengthSpec,
      chapterIntent: params.chapterIntent,
    });

    // Safety net: if normalizer output is less than 25% of original, it was too destructive.
    // Reject and keep original content.
    if (normalized.finalCount < writerCount * 0.25) {
      this.logWarn(this.languageFromLengthSpec(params.lengthSpec), {
        zh: `字数归一化被拒绝：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}（砍了${Math.round((1 - normalized.finalCount / writerCount) * 100)}%，超过安全阈值）`,
        en: `Length normalization rejected for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount} (cut ${Math.round((1 - normalized.finalCount / writerCount) * 100)}%, exceeds safety threshold)`,
      });
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    this.logInfo(this.languageFromLengthSpec(params.lengthSpec), {
      zh: `审计前字数归一化：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}`,
      en: `Length normalization before audit for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount}`,
    });

    return {
      content: normalized.normalizedContent,
      wordCount: normalized.finalCount,
      applied: normalized.applied,
      tokenUsage: normalized.tokenUsage,
    };
  }

  private assertChapterContentNotEmpty(content: string, chapterNumber: number, stage: string): void {
    if (content.trim().length > 0) return;
    throw new Error(`Chapter ${chapterNumber} has empty chapter content after ${stage}`);
  }

  private async syncCurrentStateFactHistory(bookId: string, uptoChapter: number): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.syncCurrentStateFactHistoryWithStrategy(bookDir, uptoChapter);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.syncCurrentStateFactHistoryWithStrategy(bookDir, uptoChapter);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `状态事实同步已跳过：${String(error)}`,
        en: `State fact sync skipped: ${String(error)}`,
      });
    }
  }

  private async syncCurrentStateFactHistoryWithStrategy(bookDir: string, uptoChapter: number): Promise<void> {
    const progress = await this.readFactHistorySyncProgress(bookDir);
    const canUseIncremental = uptoChapter > 0 && (progress === uptoChapter - 1 || progress === uptoChapter);

    if (canUseIncremental) {
      try {
        await this.incrementCurrentStateFactHistory(bookDir, uptoChapter);
        await this.writeFactHistorySyncProgress(bookDir, uptoChapter);
        return;
      } catch {
        // Fall back to full rebuild when incremental preconditions are not met in practice.
      }
    }

    await this.rebuildCurrentStateFactHistory(bookDir, uptoChapter);
    await this.writeFactHistorySyncProgress(bookDir, uptoChapter);
  }

  private async incrementCurrentStateFactHistory(bookDir: string, chapter: number): Promise<void> {
    const snapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, chapter);
    if (snapshotFacts.length === 0) {
      return;
    }

    const memoryDb = await this.withMemoryIndexRetry(async () => {
      const db = new MemoryDB(bookDir);
      try {
        const currentFacts = db.getCurrentFacts();
        if (currentFacts.length === 0 && chapter > 0) {
          const previousSnapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, chapter - 1);
          if (previousSnapshotFacts.length > 0) {
            throw new Error("Current-state fact index appears stale; requiring full rebuild.");
          }
        }
        const activeFacts = new Map<string, { id: number; object: string }>();
        const nextFacts = new Map<string, Omit<Fact, "id">>();

        for (const fact of currentFacts) {
          if (typeof fact.id !== "number") continue;
          activeFacts.set(this.factKey(fact), { id: fact.id, object: fact.object });
        }

        for (const fact of snapshotFacts) {
          nextFacts.set(this.factKey(fact), {
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            validFromChapter: chapter,
            validUntilChapter: null,
            sourceChapter: chapter,
          });
        }

        for (const [key, previous] of activeFacts.entries()) {
          const next = nextFacts.get(key);
          if (!next || next.object !== previous.object) {
            db.invalidateFact(previous.id, chapter);
            activeFacts.delete(key);
          }
        }

        for (const [key, fact] of nextFacts.entries()) {
          if (activeFacts.has(key)) continue;
          db.addFact(fact);
        }

        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the update.
    } finally {
      memoryDb.close();
    }
  }

  private async syncLegacyStructuredStateFromMarkdown(
    bookDir: string,
    chapterNumber: number,
    output?: {
      readonly runtimeStateDelta?: WriteChapterOutput["runtimeStateDelta"];
      readonly runtimeStateSnapshot?: WriteChapterOutput["runtimeStateSnapshot"];
    },
  ): Promise<void> {
    if (output?.runtimeStateDelta || output?.runtimeStateSnapshot) {
      return;
    }

    await rewriteStructuredStateFromMarkdown({
      bookDir,
      fallbackChapter: chapterNumber,
    });
  }

  private async syncNarrativeMemoryIndex(bookId: string): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.syncNarrativeMemoryIndexWithStrategy(bookDir);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.syncNarrativeMemoryIndexWithStrategy(bookDir);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `叙事记忆同步已跳过：${String(error)}`,
        en: `Narrative memory sync skipped: ${String(error)}`,
      });
    }
  }

  private async syncNarrativeMemoryIndexWithStrategy(bookDir: string): Promise<void> {
    const snapshot = await loadRuntimeStateSnapshot(bookDir);
    const targetChapter = snapshot.manifest.lastAppliedChapter;
    const seed = this.narrativeSeedFromSnapshot(snapshot);
    const progress = await this.readNarrativeMemorySyncProgress(bookDir);
    const canUseIncremental = targetChapter > 0 && (progress === targetChapter - 1 || progress === targetChapter);

    if (canUseIncremental) {
      try {
        await this.incrementNarrativeMemoryIndex(bookDir, targetChapter, seed);
        await this.writeNarrativeMemorySyncProgress(bookDir, targetChapter);
        return;
      } catch (error) {
        if (process.env.INKOS_DEBUG_SQLITE_MEMORY === "1") {
          this.config.logger?.warn(`Narrative memory incremental sync fallback: ${String(error)}`);
        }
        // Fall back to full rebuild when incremental preconditions are not met in practice.
      }
    }

    await this.rebuildNarrativeMemoryIndex(bookDir, seed);
    await this.writeNarrativeMemorySyncProgress(bookDir, targetChapter);
  }

  private async incrementNarrativeMemoryIndex(
    bookDir: string,
    targetChapter: number,
    seed: NarrativeMemorySeed,
  ): Promise<void> {
    const memoryDb = await this.withMemoryIndexRetry(() => {
      const db = new MemoryDB(bookDir);
      try {
        const hasHistoricalSummaries = seed.summaries.some((summary) => summary.chapter < targetChapter);
        if (hasHistoricalSummaries && db.getChapterCount() === 0) {
          throw new Error("Narrative memory index appears empty; requiring full rebuild.");
        }
        const latestSummary = seed.summaries.find((summary) => summary.chapter === targetChapter);
        if (latestSummary) {
          db.upsertSummary(latestSummary);
        }
        for (const hook of seed.hooks) {
          // Hooks can change status without changing count, so upsert by id.
          db.upsertHook(hook);
        }
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the update.
    } finally {
      memoryDb.close();
    }
  }

  private async rebuildCurrentStateFactHistory(bookDir: string, uptoChapter: number): Promise<void> {
    const memoryDb = await this.withMemoryIndexRetry(async () => {
      const db = new MemoryDB(bookDir);
      try {
        db.resetFacts();

        const activeFacts = new Map<string, { id: number; object: string }>();

        for (let chapter = 0; chapter <= uptoChapter; chapter++) {
          const snapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, chapter);
          if (snapshotFacts.length === 0) continue;
          const nextFacts = new Map<string, Omit<Fact, "id">>();

          for (const fact of snapshotFacts) {
            nextFacts.set(this.factKey(fact), {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              validFromChapter: chapter,
              validUntilChapter: null,
              sourceChapter: chapter,
            });
          }

          for (const [key, previous] of activeFacts.entries()) {
            const next = nextFacts.get(key);
            if (!next || next.object !== previous.object) {
              db.invalidateFact(previous.id, chapter);
              activeFacts.delete(key);
            }
          }

          for (const [key, fact] of nextFacts.entries()) {
            if (activeFacts.has(key)) continue;
            const id = db.addFact(fact);
            activeFacts.set(key, { id, object: fact.object });
          }
        }

        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private async readFactHistorySyncProgress(bookDir: string): Promise<number | null> {
    const path = join(bookDir, "story", FACT_HISTORY_SYNC_PROGRESS_FILE);
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as { lastSyncedChapter?: unknown };
      if (typeof parsed.lastSyncedChapter !== "number" || !Number.isInteger(parsed.lastSyncedChapter)) {
        return null;
      }
      return parsed.lastSyncedChapter;
    } catch {
      return null;
    }
  }

  private async writeFactHistorySyncProgress(bookDir: string, chapter: number): Promise<void> {
    const path = join(bookDir, "story", FACT_HISTORY_SYNC_PROGRESS_FILE);
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          lastSyncedChapter: chapter,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  private async rebuildNarrativeMemoryIndex(
    bookDir: string,
    memorySeed?: NarrativeMemorySeed,
  ): Promise<void> {
    const seed = memorySeed ?? await loadNarrativeMemorySeed(bookDir);

    const memoryDb = await this.withMemoryIndexRetry(() => {
      const db = new MemoryDB(bookDir);
      try {
        db.replaceSummaries(seed.summaries);
        db.replaceHooks(seed.hooks);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private narrativeSeedFromSnapshot(snapshot: Awaited<ReturnType<typeof loadRuntimeStateSnapshot>>): NarrativeMemorySeed {
    return {
      summaries: snapshot.chapterSummaries.rows.map((row) => ({
        chapter: row.chapter,
        title: row.title,
        characters: row.characters,
        events: row.events,
        stateChanges: row.stateChanges,
        hookActivity: row.hookActivity,
        mood: row.mood,
        chapterType: row.chapterType,
      })),
      hooks: snapshot.hooks.hooks.map((hook) => ({
        hookId: hook.hookId,
        startChapter: hook.startChapter,
        type: hook.type,
        status: hook.status,
        lastAdvancedChapter: hook.lastAdvancedChapter,
        expectedPayoff: hook.expectedPayoff,
        payoffTiming: hook.payoffTiming,
        notes: hook.notes,
      })),
    };
  }

  private async readNarrativeMemorySyncProgress(bookDir: string): Promise<number | null> {
    const path = join(bookDir, "story", NARRATIVE_MEMORY_SYNC_PROGRESS_FILE);
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as { lastSyncedChapter?: unknown };
      if (typeof parsed.lastSyncedChapter !== "number" || !Number.isInteger(parsed.lastSyncedChapter)) {
        return null;
      }
      return parsed.lastSyncedChapter;
    } catch {
      return null;
    }
  }

  private async writeNarrativeMemorySyncProgress(bookDir: string, chapter: number): Promise<void> {
    const path = join(bookDir, "story", NARRATIVE_MEMORY_SYNC_PROGRESS_FILE);
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          lastSyncedChapter: chapter,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  private async clearMemorySyncProgress(bookDir: string): Promise<void> {
    await Promise.all([
      rm(join(bookDir, "story", FACT_HISTORY_SYNC_PROGRESS_FILE), { force: true }),
      rm(join(bookDir, "story", NARRATIVE_MEMORY_SYNC_PROGRESS_FILE), { force: true }),
    ]);
  }

  private canOpenMemoryIndex(bookDir: string): boolean {
    let memoryDb: MemoryDB | null = null;
    try {
      memoryDb = new MemoryDB(bookDir);
      return true;
    } catch {
      return false;
    } finally {
      memoryDb?.close();
    }
  }

  private async logMemoryIndexDebugInfo(bookId: string, error: unknown): Promise<void> {
    if (process.env.INKOS_DEBUG_SQLITE_MEMORY !== "1") {
      return;
    }

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    this.logWarn(await this.resolveBookLanguageById(bookId), {
      zh: `SQLite 记忆索引调试：node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
      en: `SQLite memory debug: node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
    });
  }

  private async withMemoryIndexRetry<T>(operation: () => Promise<T> | T): Promise<T> {
    const retryDelaysMs = [0, 25, 75];
    let lastError: unknown;

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isMemoryIndexBusyError(error) || attempt === retryDelaysMs.length - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt + 1]!));
      }
    }

    throw lastError;
  }

  private isMemoryIndexUnavailableError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);
    const normalizedMessage = message.trim();

    return /^No such built-in module:\s*node:sqlite$/i.test(normalizedMessage)
      || /^Cannot find module ['"]node:sqlite['"]$/i.test(normalizedMessage)
      || (code === "ERR_UNKNOWN_BUILTIN_MODULE" && /\bnode:sqlite\b/i.test(normalizedMessage));
  }

  private isMemoryIndexBusyError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    return code === "SQLITE_BUSY"
      || code === "SQLITE_LOCKED"
      || /\bSQLITE_BUSY\b/i.test(message)
      || /\bSQLITE_LOCKED\b/i.test(message)
      || /database is locked/i.test(message)
      || /database is busy/i.test(message);
  }

  private factKey(fact: Pick<Fact, "subject" | "predicate">): string {
    return `${fact.subject}::${fact.predicate}`;
  }

  private buildLengthWarnings(
    chapterNumber: number,
    finalCount: number,
    lengthSpec: LengthSpec,
  ): string[] {
    if (!isOutsideHardRange(finalCount, lengthSpec)) {
      return [];
    }
    return [
      this.localize(this.languageFromLengthSpec(lengthSpec), {
        zh: `第${chapterNumber}章经过一次字数归一化后仍超出硬区间（${lengthSpec.hardMin}-${lengthSpec.hardMax}，实际 ${finalCount}）。`,
        en: `Chapter ${chapterNumber} remains outside hard range (${lengthSpec.hardMin}-${lengthSpec.hardMax}, actual ${finalCount}) after a single normalization pass.`,
      }),
    ];
  }

  private buildLengthTelemetry(params: {
    lengthSpec: LengthSpec;
    writerCount: number;
    postWriterNormalizeCount: number;
    postReviseCount: number;
    finalCount: number;
    normalizeApplied: boolean;
    lengthWarning: boolean;
  }): LengthTelemetry {
    return {
      target: params.lengthSpec.target,
      softMin: params.lengthSpec.softMin,
      softMax: params.lengthSpec.softMax,
      hardMin: params.lengthSpec.hardMin,
      hardMax: params.lengthSpec.hardMax,
      countingMode: params.lengthSpec.countingMode,
      writerCount: params.writerCount,
      postWriterNormalizeCount: params.postWriterNormalizeCount,
      postReviseCount: params.postReviseCount,
      finalCount: params.finalCount,
      normalizeApplied: params.normalizeApplied,
      lengthWarning: params.lengthWarning,
    };
  }

  private async persistAuditDriftGuidance(params: {
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly issues: ReadonlyArray<AuditIssue>;
    readonly language: LengthLanguage;
  }): Promise<void> {
    const storyDir = join(params.bookDir, "story");
    const driftPath = join(storyDir, "audit_drift.md");
    const statePath = join(storyDir, "current_state.md");
    const currentState = await readFile(statePath, "utf-8").catch(() => "");
    const sanitizedState = this.stripAuditDriftCorrectionBlock(currentState).trimEnd();

    if (sanitizedState !== currentState) {
      await writeFile(statePath, sanitizedState, "utf-8");
    }

    if (params.issues.length === 0) {
      await rm(driftPath, { force: true }).catch(() => undefined);
      return;
    }

    const block = [
      this.localize(params.language, {
        zh: "# 审计纠偏",
        en: "# Audit Drift",
      }),
      "",
      this.localize(params.language, {
        zh: "## 审计纠偏（自动生成，下一章写作前参照）",
        en: "## Audit Drift Correction",
      }),
      "",
      this.localize(params.language, {
        zh: `> 第${params.chapterNumber}章审计发现以下问题，下一章写作时必须避免：`,
        en: `> Chapter ${params.chapterNumber} audit found the following issues to avoid in the next chapter:`,
      }),
      ...params.issues.map((issue) => `> - [${issue.severity}] ${issue.category}: ${issue.description}`),
      "",
    ].join("\n");

    await writeFile(driftPath, block, "utf-8");
  }

  private stripAuditDriftCorrectionBlock(currentState: string): string {
    const headers = [
      "## 审计纠偏（自动生成，下一章写作前参照）",
      "## Audit Drift Correction",
      "# 审计纠偏",
      "# Audit Drift",
    ];

    let cutIndex = -1;
    for (const header of headers) {
      const index = currentState.indexOf(header);
      if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
        cutIndex = index;
      }
    }

    if (cutIndex < 0) {
      return currentState;
    }

    return currentState.slice(0, cutIndex).trimEnd();
  }

  private logLengthWarnings(lengthWarnings: ReadonlyArray<string>): void {
    for (const warning of lengthWarnings) {
      this.config.logger?.warn(warning);
    }
  }

  private restoreLostAuditIssues(previous: AuditResult, next: AuditResult): AuditResult {
    if (next.passed || previous.issues.length === 0) {
      return next;
    }

    const issueKey = (issue: AuditIssue): string => {
      const issueId = typeof issue.issueId === "string" ? issue.issueId.trim().toUpperCase() : "";
      if (issueId.length > 0) return `id:${issueId}`;
      return `text:${issue.category}:${issue.description}`
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
    };

    // Case 1: re-audit returned zero issues — restore previous critical issues
    // (the audit gap is likely a structural-repair intermediate state)
    if (next.issues.length === 0) {
      const previousHadCritical = previous.issues.some((issue) => issue.severity === "critical");
      if (!previousHadCritical) return next;
      return {
        ...next,
        issues: previous.issues,
        summary: next.summary || previous.summary,
      };
    }

    // Case 2: re-audit returned different issues — merge unmatched previous
    // critical issues to prevent auditor attention drift from silently replacing
    // unresolved problems.
    const nextKeys = new Set(next.issues.map(issueKey));
    const unmatchedPreviousCritical = previous.issues.filter(
      (issue) => issue.severity === "critical" && !nextKeys.has(issueKey(issue)),
    );
    if (unmatchedPreviousCritical.length === 0) return next;

    // Check match rate: how many of the NEW issues overlap with PREVIOUS issues?
    // Low overlap (< 30%) signals auditor attention drift — critical issues
    // are being silently abandoned rather than actually resolved.
    const prevKeys = new Set(previous.issues.map(issueKey));
    let matchedCount = 0;
    for (const issue of next.issues) {
      if (prevKeys.has(issueKey(issue))) matchedCount += 1;
    }
    const matchRate = matchedCount / Math.max(1, next.issues.length);
    if (matchRate >= 0.3) return next;

    return {
      ...next,
      issues: [...next.issues, ...unmatchedPreviousCritical],
      summary: next.summary || previous.summary,
    };
  }

  private restoreActionableAuditIfLost(
    previous: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
    next: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
  ): MergedAuditEvaluation {
    const auditResult = this.restoreLostAuditIssues(previous.auditResult, next.auditResult);
    if (auditResult === next.auditResult) {
      return next;
    }

    return {
      ...next,
      auditResult,
      revisionBlockingIssues: previous.revisionBlockingIssues,
      blockingCount: previous.blockingCount,
      criticalCount: previous.criticalCount,
    };
  }

  private async evaluateMergedAudit(params: {
    auditor: ContinuityAuditor;
    book: BookConfig;
    bookDir: string;
    chapterContent: string;
    chapterNumber: number;
    language: LengthLanguage;
    lengthSpec?: LengthSpec;
    onThinkingDelta?: (text: string) => void;
    onThinkingEnd?: () => void;
    auditOptions?: {
      temperature?: number;
      chapterIntent?: string;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      truthFileOverrides?: {
        currentState?: string;
        ledger?: string;
        hooks?: string;
      };
    };
  }): Promise<MergedAuditEvaluation> {
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      params.chapterContent,
      params.chapterNumber,
      params.book.genre,
      {
        ...params.auditOptions,
        onThinkingDelta: params.onThinkingDelta,
        onThinkingEnd: params.onThinkingEnd,
      },
    );
    const aiTells = analyzeAITells(params.chapterContent, params.language);
    const sensitiveResult = analyzeSensitiveWords(params.chapterContent, undefined, params.language);
    const longSpanFatigue = await analyzeLongSpanFatigue({
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      chapterContent: params.chapterContent,
      language: params.language,
    });
    const hasBlockedWords = sensitiveResult.found.some((f) => f.severity === "block");
    const issues: ReadonlyArray<AuditIssue> = [
      ...llmAudit.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
      ...longSpanFatigue.issues,
    ];
    let auditResult: AuditResult = {
      passed: hasBlockedWords ? false : llmAudit.passed,
      issues,
      summary: llmAudit.summary,
      tokenUsage: llmAudit.tokenUsage,
    };
    if (params.lengthSpec) {
      auditResult = this.enforceLengthRequirement({
        auditResult,
        chapterContent: params.chapterContent,
        lengthSpec: params.lengthSpec,
        language: params.language,
      }).auditResult;
    }

    // revisionBlockingIssues excludes long-span-fatigue issues by construction
    // (not by category name) so that an LLM-reported issue sharing a category
    // label with a long-span issue is still counted.
    const fatigueIssueSet = new Set<AuditIssue>(longSpanFatigue.issues as ReadonlyArray<AuditIssue>);
    let revisionBlockingIssues = auditResult.issues.filter(
      (issue) => !fatigueIssueSet.has(issue),
    );
    auditResult = this.enforceAuditScoreRequirement({
      auditResult,
      language: params.language,
      scoreIssues: revisionBlockingIssues,
    });
    revisionBlockingIssues = auditResult.issues.filter(
      (issue) => !fatigueIssueSet.has(issue),
    );

    return {
      auditResult,
      aiTellCount: countBlockingAITellIssues(aiTells.issues),
      blockingCount: revisionBlockingIssues.filter((issue) => issue.severity === "warning" || issue.severity === "critical").length,
      criticalCount: revisionBlockingIssues.filter((issue) => issue.severity === "critical").length,
      revisionBlockingIssues,
    };
  }

  private buildPreflightSignalsSummary(
    preflight: ReviewPreflightResult,
    language: LengthLanguage,
  ): string {
    if (preflight.signals.length === 0) {
      return language === "en"
        ? "No structural preflight risks detected."
        : "未发现结构性预检风险。";
    }
    if (language === "en") {
      return [
        `Structural preflight for chapter ${preflight.chapterNumber}:`,
        ...preflight.signals.map((signal, index) => `${index + 1}. [${signal.severity}] ${signal.message} (${signal.code})`),
      ].join("\n");
    }
    return [
      `第${preflight.chapterNumber}章结构预检：`,
      ...preflight.signals.map((signal, index) => `${index + 1}. [${signal.severity}] ${signal.message}（${signal.code}）`),
    ].join("\n");
  }

  private withPreflightControlInput(
    reduced: ReducedAuditControlInput | undefined,
    preflight: ReviewPreflightResult,
    language: LengthLanguage,
  ): ReducedAuditControlInput | undefined {
    if (!reduced || preflight.signals.length === 0) {
      return reduced;
    }

    const appendix = [
      "",
      "## Review Preflight",
      this.buildPreflightSignalsSummary(preflight, language),
      "Follow-up directives:",
      ...preflight.signals.map((signal, index) => `${index + 1}. ${signal.suggestion}`),
      "",
    ].join("\n");
    return {
      ...reduced,
      chapterIntent: `${reduced.chapterIntent}\n${appendix}`.trim(),
    };
  }

  private applyReviewPreflightToWriteInput<T extends {
    readonly chapterIntent?: string;
    readonly externalContext?: string;
  }>(
    input: T,
    preflight: ReviewPreflightResult,
    language: LengthLanguage,
  ): T {
    if (preflight.signals.length === 0) {
      return input;
    }

    const appendix = [
      "",
      "## Review Preflight",
      this.buildPreflightSignalsSummary(preflight, language),
      "Follow-up directives:",
      ...preflight.signals.map((signal, index) => `${index + 1}. ${signal.suggestion}`),
      "",
    ].join("\n");

    if (typeof input.chapterIntent === "string" && input.chapterIntent.trim().length > 0) {
      return {
        ...input,
        chapterIntent: `${input.chapterIntent.trim()}\n${appendix}`.trim(),
      };
    }

    if (typeof input.externalContext === "string" && input.externalContext.trim().length > 0) {
      return {
        ...input,
        externalContext: `${input.externalContext.trim()}\n${appendix}`.trim(),
      };
    }

    return input;
  }

  private async runReviewPreflight(params: {
    bookDir: string;
    chapterNumber: number;
    target: "write-next" | "revise";
    language: LengthLanguage;
    targetChapters?: number;
  }): Promise<ReviewPreflightResult> {
    const storyDir = join(params.bookDir, "story");
    const [volumeOutline, currentState, pendingHooks, ledger, syncProgressRaw] = await Promise.all([
      readVolumeMap(params.bookDir, ""),
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "particle_ledger.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, FACT_HISTORY_SYNC_PROGRESS_FILE), "utf-8").catch(() => ""),
    ]);
    const signals: ReviewPreflightSignal[] = [];

    const hasVolumeAnchor = new RegExp(`(?:chapter|第)\\s*${params.chapterNumber}\\s*(?:章)?`, "iu")
      .test(volumeOutline);
    if (volumeOutline.trim().length === 0) {
      signals.push({
        code: "volume_outline_missing",
        severity: "warning",
        message: params.language === "en"
          ? "Volume outline is missing; chapter-level anchor cannot be validated."
          : "卷纲缺失，无法校验章节锚点一致性。",
        suggestion: params.language === "en"
          ? "Rebuild or restore volume_outline before deep rewrite to avoid structural drift."
          : "深度重写前先补全/恢复卷纲，避免结构漂移。",
      });
    } else if (!hasVolumeAnchor) {
      signals.push({
        code: "volume_anchor_weak",
        severity: "warning",
        message: params.language === "en"
          ? `No explicit chapter-${params.chapterNumber} anchor found in volume outline.`
          : `卷纲中未发现第${params.chapterNumber}章的显式锚点。`,
        suggestion: params.language === "en"
          ? "Lock this chapter's objective to current volume milestone before revision."
          : "修订前先锁定本章与当前卷里程碑的对应目标。",
      });
    }

    const chapterPattern = /(?:\|\s*(?:当前章节|Current Chapter)\s*\|\s*|(?:当前章节|Current Chapter)\s*[:：]\s*)(\d{1,6})/iu;
    const chapterMatch = currentState.match(chapterPattern);
    const stateChapter = chapterMatch ? Number.parseInt(chapterMatch[1] ?? "", 10) : Number.NaN;
    if (Number.isFinite(stateChapter) && stateChapter + 1 < params.chapterNumber) {
      signals.push({
        code: "state_chapter_lag",
        severity: "warning",
        message: params.language === "en"
          ? `Current state chapter (${stateChapter}) lags behind target chapter (${params.chapterNumber}).`
          : `状态卡章节号（${stateChapter}）落后于目标章节（${params.chapterNumber}）。`,
        suggestion: params.language === "en"
          ? "Prioritize state/card alignment and chapter pointer repair before deep prose tuning."
          : "优先修复状态卡与章节指针一致性，再进行正文细修。",
      });
    }

    const hookDebt = await (async () => {
      try {
        const db = new MemoryDB(params.bookDir);
        try {
          const storedHooks = db.getActiveHooks();
          return deriveHookDebtBudget({
            hooks: storedHooks as StoredHook[],
            chapterNumber: params.chapterNumber,
            targetChapters: params.targetChapters,
          });
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    })();
    if (hookDebt?.highPressureMode) {
      const staleCount = hookDebt.staleDebt.length;
      const overdueCount = hookDebt.requiredRecoverHooks.length;
      const pressureCount = Math.max(staleCount, overdueCount);
      signals.push({
        code: "hook_debt_pressure",
        severity: "warning",
        message: params.language === "en"
          ? `${pressureCount} long-standing open hooks detected; hook debt pressure is high.`
          : `检测到 ${pressureCount} 条长期未回收伏笔，伏笔债务压力偏高。`,
        suggestion: params.language === "en"
          ? "Address at least one high-pressure hook in this chapter and reflect it in truth files."
          : "本章至少推进或回收一条高压力伏笔，并同步到真相文件。",
      });
    }

    const hasResourceSignals = /(资源|灵力|法力|点数|库存|余额|银两|coins?|credits?|mana|energy|ledger)/iu
      .test(currentState);
    if (hasResourceSignals && ledger.trim().length === 0) {
      signals.push({
        code: "ledger_consistency_risk",
        severity: "warning",
        message: params.language === "en"
          ? "State card references resources but ledger file is missing or empty."
          : "状态卡出现资源线索，但账本文件缺失或为空。",
        suggestion: params.language === "en"
          ? "Rebuild ledger baseline before revision and keep resource changes auditable."
          : "修订前先补齐账本基线，确保资源变动可审计。",
      });
    }

    if (syncProgressRaw.trim().length > 0) {
      try {
        const parsed = JSON.parse(syncProgressRaw) as { lastSyncedChapter?: unknown };
        const lastSynced = typeof parsed.lastSyncedChapter === "number"
          ? parsed.lastSyncedChapter
          : Number.NaN;
        if (Number.isFinite(lastSynced) && lastSynced + 1 < params.chapterNumber) {
          signals.push({
            code: "fact_sync_lag",
            severity: "info",
            message: params.language === "en"
              ? `Fact history sync progress (${lastSynced}) is behind target chapter (${params.chapterNumber}).`
              : `事实索引同步进度（${lastSynced}）落后于目标章节（${params.chapterNumber}）。`,
            suggestion: params.language === "en"
              ? "Prefer structural consistency fixes first; avoid introducing fresh cross-chapter state jumps."
              : "优先做结构一致性修复，避免引入新的跨章状态跳变。",
          });
        }
      } catch {
        signals.push({
          code: "fact_sync_progress_invalid",
          severity: "info",
          message: params.language === "en"
            ? "Fact sync progress metadata is malformed."
            : "事实索引同步进度元数据格式异常。",
          suggestion: params.language === "en"
            ? "Treat this run as high-risk for structural drift and recheck truth files after revision."
            : "本次按结构漂移高风险处理，修订后复核真相文件。",
        });
      }
    }

    return {
      target: params.target,
      chapterNumber: params.chapterNumber,
      signals,
    };
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<{
    plan: PlanChapterOutput;
    composed: Awaited<ReturnType<ComposerAgent["composeChapter"]>>;
  }> {
    let plan = await this.resolveGovernedPlan(book, bookDir, chapterNumber, externalContext, options);

    if (this.config.enforceOutlineAnchorMatch && plan.intent.outlineAnchorMatched !== true) {
      await this.extendVolumeOutlineForChapter(bookDir, chapterNumber, book.language);
      // Don't pass options on retry — the persisted plan may be stale
      // (outlineAnchorMatched: false from a prior run), so force a fresh planner run.
      plan = await this.resolveGovernedPlan(book, bookDir, chapterNumber, externalContext);
    }

    this.assertGovernedOutlineAnchor(plan, chapterNumber);

    const composer = new ComposerAgent(this.agentCtxFor("composer", book.id));
    const composed = await composer.composeChapter({
      book,
      bookDir,
      chapterNumber,
      plan,
    });

    return { plan, composed };
  }

  private async resolveGovernedPlan(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<PlanChapterOutput> {
    if (
      options?.reuseExistingIntentWhenContextMissing &&
      (!externalContext || externalContext.trim().length === 0)
    ) {
      const persisted = await loadPersistedPlan(bookDir, chapterNumber);
      if (persisted) return persisted;
    }

    const planner = new PlannerAgent(this.agentCtxFor("planner", book.id));
    return planner.planChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext,
    });
  }

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    chapterNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      chapterNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async readChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const files = await readdir(chaptersDir);
    const paddedNum = String(chapterNumber).padStart(4, "0");
    const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found in ${chaptersDir}`);
    }
    const raw = await readFile(join(chaptersDir, chapterFile), "utf-8");
    // Strip the title line
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }
}
