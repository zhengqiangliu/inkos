import type { AuditIssue, OnStreamProgress, PipelineConfig, ProjectConfig, StateManager } from "@actalk/inkos-core";
import type { ReviseMode } from "@actalk/inkos-core";
import { countAuditIssueClasses, isStructuralAuditIssue, resolvePrimaryIssueClass } from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import { persistChapterAuditSummary } from "./chapter-audit-index.js";
import type { BookTask, BookTaskCreatePayload, BookTaskPatchPayload, BookTaskStatus, BookTaskType, RunLogEntry } from "../../shared/contracts.js";
import { BookTaskStore } from "./book-task-store.js";
import { AUDIT_PASS_SCORE_THRESHOLD, estimateAuditScoreFromSeverityCounts } from "../../utils/audit-score.js";

type Broadcast = (event: string, data: unknown) => void;

interface TaskProgressSignal {
  readonly kind: "log" | "audit:start" | "audit:complete" | "revise:start" | "revise:complete";
  readonly message?: string;
  readonly level?: RunLogEntry["level"];
  readonly chapterNumber?: number;
  readonly round?: number;
  readonly maxReviseRounds?: number;
  readonly unboundedReview?: boolean;
  readonly mode?: string;
  readonly passed?: boolean;
  readonly score?: number;
  readonly issueCount?: number;
  readonly wordCount?: number;
  readonly applied?: boolean;
  readonly summary?: string | null;
  readonly phase?: "audit" | "revise";
}

type ResolveRuntimeSelection = (args: {
  readonly currentConfig: ProjectConfig;
  readonly selectedService?: string;
  readonly selectedModel?: string;
}) => Promise<{ client?: unknown; model?: string; error?: string }>;

type PipelineLike = {
  readonly auditDraft: (bookId: string, chapterNumber?: number) => Promise<unknown>;
  readonly reviseDraft?: (
    bookId: string,
    chapterNumber?: number,
    mode?: ReviseMode,
    options?: ReviseDraftOptions,
  ) => Promise<unknown>;
  readonly writeNextChapter: (
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    options?: WriteNextChapterOptions,
  ) => Promise<unknown>;
};
type PipelineFactory = (config: PipelineConfig) => PipelineLike;

interface ReviseDraftOptions {
  readonly overrideIssues?: ReadonlyArray<AuditIssue>;
  readonly userBrief?: string;
  readonly reviseContext?: {
    readonly failureGate?: "critical" | "score" | "none";
    readonly score?: number;
    readonly passScoreThreshold?: number;
    readonly scoreShortfall?: number;
    readonly previousRevisionWasNoop?: boolean;
    readonly structureOverload?: {
      enabled: boolean;
      reason: string;
      signals: ReadonlyArray<{
        code: string;
        severity: "warning" | "info";
        message: string;
        suggestion: string;
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
      readonly dimension: string;
      readonly status: "pass" | "warning" | "failed";
      readonly evidence?: string;
    }>;
  };
}

export interface BookTaskControllerDeps {
  readonly state: StateManager;
  readonly loadCurrentProjectConfig: () => Promise<ProjectConfig>;
  readonly buildPipelineConfig: (overrides?: Partial<Pick<PipelineConfig, "externalContext" | "client" | "model" | "defaultWriteNextQuickMode" | "writeStageHeartbeatMs" | "onTaskSignal" | "onStreamProgress">> & { readonly currentConfig?: ProjectConfig; readonly bookId?: string }) => Promise<PipelineConfig>;
  readonly resolvePipelineClientFromSelection: ResolveRuntimeSelection;
  readonly createPipeline: PipelineFactory;
  readonly broadcast: Broadcast;
  readonly resolveWriteStageHeartbeatMs: () => number;
}

interface WriteNextChapterOptions {
  readonly quickMode?: boolean;
  readonly allowPendingAuditFailure?: boolean;
  readonly unboundedReview?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

const MIN_AUDIT_PASS_SCORE = 80;
const TASK_CENTER_AUDIT_MIN_PASS_SCORE = AUDIT_PASS_SCORE_THRESHOLD;
const TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS = 3;

function normalizeChapterCount(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.round(numeric));
}

function summarizeTask(task: BookTask): Partial<BookTask> {
  return {
    id: task.id,
    bookId: task.bookId,
    type: task.type,
    source: task.source,
    title: task.title,
    status: task.status,
    stage: task.stage,
    stageLabel: task.stageLabel,
    stageDetail: task.stageDetail,
    stageStartedAt: task.stageStartedAt,
    stageUpdatedAt: task.stageUpdatedAt,
    lastHeartbeatAt: task.lastHeartbeatAt,
    chapterStartedAt: task.chapterStartedAt,
    chapterFinishedAt: task.chapterFinishedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    stopRequestedAt: task.stopRequestedAt,
    stoppedAt: task.stoppedAt,
    requestedChapters: task.requestedChapters,
    auditChapterStart: task.auditChapterStart,
    auditChapterEnd: task.auditChapterEnd,
    completedChapters: task.completedChapters,
    currentChapterNumber: task.currentChapterNumber,
    nextChapterNumber: task.nextChapterNumber,
    lastChapterNumber: task.lastChapterNumber,
    retryCount: task.retryCount,
    maxRetryAttempts: task.maxRetryAttempts,
    retryEnabled: task.retryEnabled,
    retryAt: task.retryAt,
    writtenChapters: task.writtenChapters,
    writtenWords: task.writtenWords,
    tokenUsage: task.tokenUsage,
    lastErrorType: task.lastErrorType,
    lastErrorCode: task.lastErrorCode,
    lastErrorStage: task.lastErrorStage,
    options: task.options,
    result: task.result,
    error: task.error,
  };
}

function isTerminalTaskStatus(status: BookTaskStatus): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded";
}

function canDeleteTaskStatus(status: BookTaskStatus): boolean {
  return status !== "running";
}

function isFatalWriteResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const payload = result as { status?: unknown; error?: unknown };
  const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  if (/failed|error/.test(status)) return true;
  return typeof payload.error === "string" && payload.error.trim().length > 0;
}

function extractWordCount(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as { wordCount?: unknown };
  const value = Number(payload.wordCount);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function extractTokenUsage(result: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as { tokenUsage?: unknown };
  if (!payload.tokenUsage || typeof payload.tokenUsage !== "object") return null;
  const usage = payload.tokenUsage as { promptTokens?: unknown; completionTokens?: unknown; totalTokens?: unknown };
  const promptTokens = Number(usage.promptTokens);
  const completionTokens = Number(usage.completionTokens);
  const totalTokens = Number(usage.totalTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null;
  return {
    promptTokens: Math.max(0, Math.round(promptTokens)),
    completionTokens: Math.max(0, Math.round(completionTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
  };
}

function addTokenUsage(
  base: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
  delta: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
): { promptTokens: number; completionTokens: number; totalTokens: number } | null {
  if (!base && !delta) return null;
  const left = base ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const right = delta ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function classifyTaskError(message: string): { type: string; code: string; stage: string } {
  const text = message.toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) {
    return { type: "timeout", code: "task_timeout", stage: "pipeline" };
  }
  if (text.includes("429") || text.includes("rate limit")) {
    return { type: "rate_limit", code: "task_rate_limited", stage: "pipeline" };
  }
  if (text.includes("5xx") || text.includes("502") || text.includes("503") || text.includes("504")) {
    return { type: "server_error", code: "task_server_error", stage: "pipeline" };
  }
  if (text.includes("fetch") || text.includes("network") || text.includes("socket")) {
    return { type: "network", code: "task_network_error", stage: "pipeline" };
  }
  return { type: "unknown", code: "task_unknown_error", stage: "pipeline" };
}

function estimateLiveWordCount(progress: Parameters<OnStreamProgress>[0], language: string | null | undefined): number {
  const chars = Math.max(0, Math.round(progress.totalChars));
  if (language === "en") {
    return Math.max(1, Math.round(chars / 5));
  }
  return Math.max(1, chars);
}

function estimateLiveTokenUsage(progress: Parameters<OnStreamProgress>[0], language: string | null | undefined): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const chars = Math.max(0, Math.round(progress.totalChars));
  const totalTokens = language === "en"
    ? Math.max(1, Math.round(chars / 4))
    : Math.max(1, Math.round(chars / 2));
  return {
    promptTokens: 0,
    completionTokens: totalTokens,
    totalTokens,
  };
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "queued": return "排队中";
    case "prepare": return "准备中";
    case "resolve_model": return "解析模型";
    case "write_chapter": return "写作中";
    case "audit": return "审计中";
    case "revise": return "修订中";
    case "saving_persist": return "落盘中";
    case "saving_truth": return "真相重建";
    case "saving_validate": return "真相校验";
    case "saving_memory": return "记忆同步";
    case "saving_index": return "索引更新";
    case "finalize": return "收尾中";
    case "saving": return "保存中";
    case "retry_waiting": return "等待重试";
    case "stopping": return "停止中";
    case "paused": return "已暂停";
    case "failed": return "失败";
    case "succeeded": return "已完成";
    default: return stage;
  }
}

function normalizeTaskType(type: unknown): BookTaskType {
  return type === "audit" ? "audit" : "write";
}

function normalizeTaskSource(source: unknown): "book-detail" | "task-center" {
  return source === "task-center" ? "task-center" : "book-detail";
}

function resolveWriteTaskMode(task: BookTask): { readonly unboundedReview: boolean } {
  return {
    unboundedReview: normalizeTaskSource(task.source) === "task-center" && task.type === "write",
  };
}

function taskTypeStartLog(type: BookTaskType, requestedChapters: number): string {
  return type === "audit"
    ? `开始审计任务：${requestedChapters} 章。`
    : `开始自动写作：${requestedChapters} 章。`;
}

function normalizeNullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.round(numeric)) : null;
}

function buildAuditChapterRange(args: {
  readonly requestedChapters: number;
  readonly auditChapterStart?: number | null;
  readonly auditChapterEnd?: number | null;
  readonly latestChapterNumber: number;
}): { readonly start: number; readonly end: number } {
  const latestChapterNumber = Math.max(0, Math.trunc(args.latestChapterNumber));
  const explicitStart = normalizeNullableNumber(args.auditChapterStart);
  const explicitEnd = normalizeNullableNumber(args.auditChapterEnd);
  if (explicitStart !== null || explicitEnd !== null) {
    const start = Math.min(explicitStart ?? explicitEnd ?? 1, explicitEnd ?? explicitStart ?? 1);
    const end = Math.max(explicitStart ?? start, explicitEnd ?? start);
    return { start, end };
  }
  if (latestChapterNumber <= 0) {
    return { start: 1, end: 0 };
  }
  return {
    start: Math.max(1, latestChapterNumber - Math.max(1, Math.trunc(args.requestedChapters)) + 1),
    end: latestChapterNumber,
  };
}

function taskConsolePrefix(args: {
  readonly bookId: string;
  readonly taskId: string;
  readonly taskType: BookTaskType;
  readonly retryCount: number;
}): string {
  return `[studio][book:${args.bookId}][task:${args.taskId}][type:${args.taskType}][retry:${args.retryCount}]`;
}

function taskTypePrepareStage(type: BookTaskType): string {
  return type === "audit" ? "构建审计管线" : "构建写作管线";
}

function taskTypePrepareDetail(type: BookTaskType): string {
  return type === "audit" ? "读取书籍配置与审计参数" : "读取书籍配置与运行参数";
}

type ChapterAuditHistoryEntry = {
  readonly passed?: boolean;
  readonly score?: number;
  readonly issueCount?: number;
  readonly summary?: string;
  readonly report?: string;
};

function extractLatestChapterAuditSnapshot(chapter: {
  readonly status?: string;
  readonly auditHistory?: ReadonlyArray<ChapterAuditHistoryEntry>;
} | undefined): { readonly passed: boolean; readonly score: number | null } | null {
  if (!chapter) return null;
  const history = Array.isArray(chapter.auditHistory) ? chapter.auditHistory : [];
  const latest = history[history.length - 1];
  if (latest) {
    const score = typeof latest.score === "number" && Number.isFinite(latest.score) ? Math.trunc(latest.score) : null;
    if (typeof latest.passed === "boolean" || score !== null) {
      return {
        passed: typeof latest.passed === "boolean" ? latest.passed : chapter.status === "approved" || chapter.status === "ready-for-review",
        score,
      };
    }
  }
  if (chapter.status === "approved" || chapter.status === "ready-for-review") {
    return { passed: true, score: null };
  }
  return null;
}

function isChapterAuditPassed(chapter: {
  readonly status?: string;
  readonly auditHistory?: ReadonlyArray<ChapterAuditHistoryEntry>;
} | undefined): boolean {
  const snapshot = extractLatestChapterAuditSnapshot(chapter);
  if (!snapshot) return false;
  if (!snapshot.passed) return false;
  if (snapshot.score !== null) return snapshot.score >= MIN_AUDIT_PASS_SCORE;
  return true;
}

function normalizeNullableText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function extractAutoReviewStopReason(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as {
    readonly autoReview?: {
      readonly stopReason?: unknown;
    };
  };
  return normalizeNullableText(payload.autoReview?.stopReason) ?? null;
}

function extractChapterAuditPassed(result: unknown): boolean | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as {
    readonly passed?: unknown;
    readonly auditResult?: unknown;
    readonly audit?: unknown;
  };
  if (typeof payload.passed === "boolean") return payload.passed;
  for (const nested of [payload.auditResult, payload.audit]) {
    if (!nested || typeof nested !== "object") continue;
    const audit = nested as { readonly passed?: unknown };
    if (typeof audit.passed === "boolean") return audit.passed;
  }
  return null;
}

function buildAuditMetrics(args: {
  readonly auditedChapters: number;
  readonly passedChapters: number;
  readonly failedChapters: number;
}): {
  readonly auditedChapters: number;
  readonly passedChapters: number;
  readonly failedChapters: number;
  readonly auditPassRate: number | null;
} {
  const auditedChapters = Math.max(0, Math.trunc(args.auditedChapters));
  const passedChapters = Math.max(0, Math.trunc(args.passedChapters));
  const failedChapters = Math.max(0, Math.trunc(args.failedChapters));
  return {
    auditedChapters,
    passedChapters,
    failedChapters,
    auditPassRate: auditedChapters > 0 ? Math.round((passedChapters / auditedChapters) * 100) : null,
  };
}

function normalizeAuditIssueTexts(issues: ReadonlyArray<{ readonly severity?: string; readonly category?: string; readonly description?: string }>): string[] {
  const result: string[] = [];
  for (const issue of issues) {
    const text = typeof issue.description === "string" && issue.description.trim()
      ? issue.description.trim()
      : typeof issue.category === "string" && issue.category.trim()
        ? issue.category.trim()
        : "";
    if (text) result.push(text);
  }
  return result;
}

function countAuditIssueSeverities(issues: ReadonlyArray<{ readonly severity?: string }>): { critical: number; warning: number; info: number } {
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

function estimateAuditScore(severityCounts: { critical: number; warning: number; info: number }): number {
  return estimateAuditScoreFromSeverityCounts(severityCounts);
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildTaskCenterRevisionBrief(args: {
  readonly chapterNumber: number;
  readonly reviseRound: number;
  readonly maxReviseRounds: number;
  readonly score: number | null;
  readonly threshold: number;
  readonly summary?: string | null;
  readonly report?: string | null;
  readonly severityCounts: { critical: number; warning: number; info: number };
  readonly issues: ReadonlyArray<{
    readonly severity?: string;
    readonly category?: string;
    readonly description?: string;
    readonly suggestion?: string;
  }>;
}): string {
  const scoreLine = typeof args.score === "number" ? `${args.score}/100` : "未知";
  const shortfall = typeof args.score === "number"
    ? Math.max(0, args.threshold - args.score)
    : null;
  const topIssues = (() => {
    const criticalIssues = args.issues.filter((issue) => issue && issue.severity === "critical");
    const warningIssues = args.issues.filter((issue) => issue && issue.severity === "warning").slice(0, 5);
    const selected = [...criticalIssues, ...warningIssues];
    return selected.map((issue, index) => {
      const severity = issue.severity ?? "info";
      const category = issue.category?.trim() || "未分类";
      const description = issue.description?.trim() || "未提供描述";
      const suggestion = issue.suggestion?.trim()
        ? `；建议：${clipText(issue.suggestion.trim(), 200)}`
        : "";
      return `${index + 1}. [${severity}] ${category}: ${clipText(description, 300)}${suggestion}`;
    });
  })();

  const reportBlock = args.report?.trim()
    ? `\n## 审计报告摘要\n${clipText(args.report.trim(), 1200)}`
    : "";

  return [
    "## 任务中心自动修订约束",
    `- 章节：第${args.chapterNumber}章`,
    `- 修订轮次：第 ${args.reviseRound}/${args.maxReviseRounds} 轮`,
    `- 审计结论：未通过`,
    `- 当前评分：${scoreLine}`,
    `- 通过阈值：${args.threshold}/100`,
    ...(shortfall !== null ? [`- 距离通过阈值还差：${shortfall}`] : []),
    `- 严重问题：${args.severityCounts.critical}，警告：${args.severityCounts.warning}，提示：${args.severityCounts.info}`,
    ...(args.summary?.trim() ? [`- 审计摘要：${args.summary.trim()}`] : []),
    "## 优先修复项",
    ...(topIssues.length > 0 ? topIssues : ["- 本轮审计未提供结构化问题明细，请基于审计报告整体收敛修改。"]),
    "## 修订要求",
    "- 只围绕上述问题收敛修改，优先清理 critical/warning。",
    "- 不要扩写无关情节，不要改变主线结论。",
    "- 如果需要较大改动，优先重组问题段落而不是整章推翻。",
    ...(args.reviseRound >= args.maxReviseRounds ? [
      "- 本轮是最后一次自动修订，必须执行结构级重构，不允许继续做局部措辞微调。",
    ] : []),
    reportBlock,
  ]
    .filter((line) => typeof line === "string" && line.length > 0)
    .join("\n");
}

function buildIssueIdList(
  issues: ReadonlyArray<{ readonly severity?: string }>,
  allowedSeverities: ReadonlyArray<string> = ["critical", "warning"],
): string[] {
  const issueIds: string[] = [];
  let counter = 1;
  for (const issue of issues) {
    if (!allowedSeverities.includes(issue.severity ?? "")) continue;
    issueIds.push(`ISSUE-${String(counter).padStart(2, "0")}`);
    counter += 1;
  }
  return issueIds;
}

function buildFullReviseContext(args: {
  readonly issues: ReadonlyArray<{ readonly severity?: string; readonly category?: string; readonly description?: string; readonly dimensionId?: string }>;
  readonly severityCounts: { critical: number; warning: number; info: number };
  readonly score: number;
  readonly unresolvedIssueIdsFromPrevRound?: ReadonlyArray<string>;
  readonly dimensionChecks?: ReadonlyArray<{ readonly dimension: string; readonly status: "pass" | "warning" | "failed"; readonly evidence?: string }>;
  readonly previousRevisionWasNoop?: boolean;
  readonly structureOverload?: {
    enabled: boolean;
    reason: string;
    signals: ReadonlyArray<{
      code: string;
      severity: "warning" | "info";
      message: string;
      suggestion: string;
    }>;
  };
}): NonNullable<ReviseDraftOptions["reviseContext"]> {
  const criticalWarningIssues = args.issues.filter(
    (i) => i.severity === "critical" || i.severity === "warning",
  );
  const issueClassCounts = countAuditIssueClasses(
    criticalWarningIssues.map((i) => ({
      category: i.category ?? "",
      dimensionId: i.dimensionId,
      description: i.description,
    })),
  );
  const primaryIssueClass = resolvePrimaryIssueClass(issueClassCounts);
  const mustFixFirstIssueIds = buildIssueIdList(args.issues).slice(0, 5);

  return {
    failureGate: args.severityCounts.critical > 0 ? "critical" as const : "score" as const,
    score: args.score,
    passScoreThreshold: MIN_AUDIT_PASS_SCORE,
    scoreShortfall: Math.max(0, MIN_AUDIT_PASS_SCORE - args.score),
    mustFixFirstIssueIds,
    issueClassCounts,
    primaryIssueClass,
    dimensionChecks: args.dimensionChecks?.slice(0, 15),
    unresolvedIssueIdsFromPrevRound: args.unresolvedIssueIdsFromPrevRound,
    previousRevisionWasNoop: args.previousRevisionWasNoop,
    ...(args.structureOverload ? { structureOverload: args.structureOverload } : {}),
  };
}

function selectReviseMode(
  severityCounts: { critical: number; warning: number },
  round: number,
  primaryIssueClass: "none" | "structural" | "textual" | "mixed",
): "polish" | "rewrite" | "rework" {
  if (round >= TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS) {
    return "rework";
  }
  if (severityCounts.critical === 0 && severityCounts.warning <= 2) {
    return "polish";
  }
  if (primaryIssueClass === "textual") {
    return "rewrite";
  }
  if (round <= 1) {
    return "rewrite";
  }
  return "rework";
}

export class BookTaskController {
  private readonly store: BookTaskStore;
  private readonly runningTaskIds = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly taskSignalChains = new Map<string, Promise<void>>();
  private readonly pendingStateRepairWarnings = new Map<string, number>();

  constructor(private readonly deps: BookTaskControllerDeps) {
    this.store = new BookTaskStore(deps.state);
  }

  async list(bookId: string): Promise<ReadonlyArray<BookTask>> {
    return this.store.list(bookId);
  }

  async get(bookId: string, taskId: string): Promise<BookTask | null> {
    return this.store.get(bookId, taskId);
  }

  async delete(bookId: string, taskId: string): Promise<void> {
    const task = await this.requireTask(bookId, taskId);
    if (!canDeleteTaskStatus(task.status)) {
      throw new ApiError(409, "BOOK_TASK_NOT_DELETABLE", `Task "${taskId}" can only be deleted when not running.`);
    }
    await this.store.delete(bookId, taskId);
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.store.deleteBook(bookId);
  }

  async create(bookId: string, payload: BookTaskCreatePayload): Promise<BookTask> {
    const active = await this.store.findActive(bookId);
    if (active) {
      throw new ApiError(409, "BOOK_TASK_ACTIVE", `Book "${bookId}" already has an active task "${active.title}".`);
    }

    const currentConfig = await this.deps.loadCurrentProjectConfig();
    const book = await this.deps.state.loadBookConfig(bookId);
    const nextChapter = await this.deps.state.getNextChapterNumber(bookId);
    const defaultRequested = Math.max(1, (Number(book.targetChapters ?? 0) || nextChapter) - nextChapter + 1);
    const auditChapterStart = normalizeNullableNumber(payload.auditChapterStart);
    const auditChapterEnd = normalizeNullableNumber(payload.auditChapterEnd);
    const type = normalizeTaskType(payload.type);
    const source = normalizeTaskSource(payload.source);
    const requestedChapters = type === "audit" && (auditChapterStart !== null || auditChapterEnd !== null)
      ? Math.max(1, Math.abs((auditChapterEnd ?? auditChapterStart ?? nextChapter) - (auditChapterStart ?? auditChapterEnd ?? nextChapter)) + 1)
      : normalizeChapterCount(payload.requestedChapters, defaultRequested);
    const title = type === "audit"
      ? (auditChapterStart !== null || auditChapterEnd !== null
        ? `审计第 ${auditChapterStart ?? "?"}-${auditChapterEnd ?? "?"} 章`
        : (typeof payload.requestedChapters === "number" && Number.isFinite(payload.requestedChapters)
          ? `连续审计 ${requestedChapters} 章`
          : "自动审计至目标章节"))
      : (typeof payload.requestedChapters === "number" && Number.isFinite(payload.requestedChapters)
        ? `连续写作 ${requestedChapters} 章`
        : "自动写作至目标章节");

    const task = await this.store.create(bookId, {
      ...payload,
      type,
      source,
      requestedChapters,
      auditChapterStart,
      auditChapterEnd,
      title,
    });

    await this.appendTaskEvent("book-task:created", task);
    void this.runTask(bookId, task.id, currentConfig);
    return task;
  }

  async stop(bookId: string, taskId: string): Promise<BookTask> {
    const task = await this.requireTask(bookId, taskId);
    if (isTerminalTaskStatus(task.status)) return task;

    if (task.status === "queued" || task.status === "paused") {
      const stopped = await this.store.setStatus(bookId, taskId, "cancelled", {
        stopRequestedAt: nowIso(),
        stoppedAt: nowIso(),
        finishedAt: nowIso(),
        chapterFinishedAt: nowIso(),
        stage: "cancelled",
        stageLabel: stageLabel("cancelled"),
        stageDetail: "任务在开始前被停止",
        stageUpdatedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        result: { cancelled: true, reason: "stopped before start" },
      });
      await this.appendTaskEvent("book-task:complete", stopped);
      return stopped;
    }

    const stopping = await this.store.setStatus(bookId, taskId, "stopping", {
      stopRequestedAt: nowIso(),
      stage: "stopping",
      stageLabel: stageLabel("stopping"),
      stageDetail: "正在停止当前任务",
      stageUpdatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
    });
    await this.appendTaskEvent("book-task:update", stopping);
    await this.appendTaskEvent("book-task:stop", stopping);
    return stopping;
  }

  async cancel(bookId: string, taskId: string): Promise<BookTask> {
    const task = await this.requireTask(bookId, taskId);
    if (isTerminalTaskStatus(task.status)) return task;
    const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
      stopRequestedAt: nowIso(),
      stoppedAt: nowIso(),
      finishedAt: nowIso(),
      chapterFinishedAt: nowIso(),
      stage: "cancelled",
      stageLabel: stageLabel("cancelled"),
      stageDetail: "任务已取消",
      stageUpdatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      result: { cancelled: true, reason: "cancelled by user" },
      error: null,
    });
    await this.appendTaskEvent("book-task:complete", cancelled);
    return cancelled;
  }

  async patch(bookId: string, taskId: string, patch: BookTaskPatchPayload): Promise<BookTask> {
    const task = await this.requireTask(bookId, taskId);
    if (task.status === "running") {
      throw new ApiError(409, "BOOK_TASK_ACTIVE", `Task "${taskId}" is active and cannot be modified.`);
    }
    const optionsPatch = patch.options;
    const updated = await this.store.update(bookId, taskId, (current) => ({
      ...current,
      ...patch,
      updatedAt: nowIso(),
      options: {
        ...current.options,
        ...(optionsPatch
          ? {
            ...(optionsPatch.quickMode !== undefined ? { quickMode: optionsPatch.quickMode } : {}),
            ...(optionsPatch.service !== undefined ? { service: normalizeNullableText(optionsPatch.service) } : {}),
            ...(optionsPatch.model !== undefined ? { model: normalizeNullableText(optionsPatch.model) } : {}),
          }
          : {}),
      },
    }));
    await this.appendTaskEvent("book-task:update", updated);
    return updated;
  }

  async retry(bookId: string, taskId: string): Promise<BookTask> {
    const task = await this.requireTask(bookId, taskId);
    if (task.status !== "failed") {
      throw new ApiError(409, "BOOK_TASK_NOT_FAILED", `Task "${taskId}" is not failed.`);
    }
    const retried = await this.store.setStatus(bookId, taskId, "retry_waiting", {
      error: null,
      lastErrorType: null,
      lastErrorCode: null,
      lastErrorStage: null,
      stage: "retry_waiting",
      stageLabel: stageLabel("retry_waiting"),
      stageDetail: "等待自动重试",
      stageUpdatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      retryCount: task.retryCount + 1,
      retryAt: nowIso(),
      startedAt: task.startedAt ?? nowIso(),
      chapterStartedAt: task.chapterStartedAt ?? null,
    });
    await this.appendTaskEvent("book-task:resume", retried);
    console.info(taskConsolePrefix({ bookId, taskId, taskType: task.type, retryCount: retried.retryCount }), "manual retry scheduled");
    this.scheduleRetry(bookId, taskId, 0);
    return retried;
  }

  async resume(bookId: string, taskId: string, currentConfig?: ProjectConfig): Promise<BookTask> {
    const task = await this.requireTask(bookId, taskId);
    if (task.status !== "paused") {
      throw new ApiError(409, "BOOK_TASK_NOT_PAUSED", `Task "${taskId}" is not paused.`);
    }

    const config = currentConfig ?? await this.deps.loadCurrentProjectConfig();
    const resumed = await this.store.setStatus(bookId, taskId, "queued", {
      error: null,
      stopRequestedAt: null,
      stoppedAt: null,
      finishedAt: null,
      chapterFinishedAt: null,
      stage: "queued",
      stageLabel: stageLabel("queued"),
      stageDetail: "恢复后重新排队",
      startedAt: task.startedAt ?? nowIso(),
      chapterStartedAt: task.chapterStartedAt ?? null,
      stageStartedAt: nowIso(),
      stageUpdatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
    });
    await this.appendTaskEvent("book-task:resume", resumed);
    void this.runTask(bookId, taskId, config);
    return resumed;
  }

  async recoverPendingTasks(bookId: string, currentConfig: ProjectConfig): Promise<void> {
    const tasks = await this.store.list(bookId);
    for (const task of tasks) {
      if (this.runningTaskIds.has(task.id)) continue;
      if (task.status === "queued") {
        void this.runTask(bookId, task.id, currentConfig);
        continue;
      }
      if (task.status === "retry_waiting" && task.retryEnabled) {
        this.scheduleRetry(bookId, task.id, this.resolveRetryDelayMs(task.retryCount));
        continue;
      }
      if (task.status === "running" || task.status === "stopping") {
        const paused = await this.store.setStatus(bookId, task.id, "paused", {
          error: "服务器重启后任务已暂停，请手动继续。",
          stage: "paused",
          stageLabel: stageLabel("paused"),
          stageDetail: "服务器重启后任务已暂停",
          stageUpdatedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
        });
        await this.appendTaskEvent("book-task:update", paused);
        await this.appendTaskLog(paused, "warn", "服务器重启后任务已暂停，请手动继续。");
      }
    }
  }

  private async requireTask(bookId: string, taskId: string): Promise<BookTask> {
    const task = await this.store.get(bookId, taskId);
    if (!task) {
      throw new ApiError(404, "BOOK_TASK_NOT_FOUND", `Task "${taskId}" not found for book "${bookId}".`);
    }
    return task;
  }

  private async appendTaskEvent(event: string, task: BookTask, extra?: Record<string, unknown>): Promise<void> {
    this.deps.broadcast(event, {
      bookId: task.bookId,
      taskId: task.id,
      task: summarizeTask(task),
      ...(extra ?? {}),
    });
  }

  private async appendTaskLog(task: BookTask, level: RunLogEntry["level"], message: string): Promise<BookTask> {
    const log: RunLogEntry = {
      timestamp: nowIso(),
      level,
      message,
    };
    const updated = await this.store.appendLog(task.bookId, task.id, log);
    await this.appendTaskEvent("book-task:log", updated, { log });
    return updated;
  }

  private async warnPendingStateRepairOnce(task: BookTask): Promise<BookTask> {
    if (task.type !== "write") return task;
    const index = await this.deps.state.loadChapterIndex(task.bookId).catch(() => []);
    const latestChapter = [...index].sort((left, right) => right.number - left.number)[0];
    const key = this.taskSignalKey(task.bookId, task.id);
    if (latestChapter?.status !== "state-degraded") {
      this.pendingStateRepairWarnings.delete(key);
      return task;
    }
    if (this.pendingStateRepairWarnings.get(key) === latestChapter.number) {
      return task;
    }
    this.pendingStateRepairWarnings.set(key, latestChapter.number);
    return this.appendTaskLog(
      task,
      "warn",
      `最新章节 ${latestChapter.number} 状态降级（state-degraded），已允许继续写作一次，请尽快修复。`,
    );
  }

  private broadcastAuditComplete(args: {
    readonly task: BookTask;
    readonly chapterNumber: number;
    readonly passed: boolean;
    readonly score: number | null;
    readonly issueCount: number;
    readonly summary?: string | null;
    readonly report?: string | null;
    readonly issues?: ReadonlyArray<{ readonly severity?: string; readonly category?: string; readonly description?: string }>;
    readonly status?: string;
    readonly wordCount?: number | null;
  }): void {
    const severityCounts = args.issues ? countAuditIssueSeverities(args.issues) : undefined;
    const score = args.score ?? (severityCounts ? estimateAuditScore(severityCounts) : null);
    this.deps.broadcast("audit:complete", {
      bookId: args.task.bookId,
      taskId: args.task.id,
      task: summarizeTask(args.task),
      chapter: args.chapterNumber,
      chapterNumber: args.chapterNumber,
      passed: args.passed,
      score,
      issueCount: args.issueCount,
      summary: args.summary ?? undefined,
      report: args.report ?? undefined,
      issues: args.issues ? normalizeAuditIssueTexts(args.issues) : undefined,
      status: args.status,
      ...(typeof args.wordCount === "number" ? { wordCount: args.wordCount } : {}),
      ...(severityCounts ? { severityCounts } : {}),
      failureGate: "none",
    });
  }

  private async updateLiveTaskMetrics(
    bookId: string,
    taskId: string,
    baseWords: number,
    baseTokenUsage: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number },
    progress: Parameters<OnStreamProgress>[0],
    language: string | null | undefined,
    activeChapterNumber: number | null,
  ): Promise<BookTask | null> {
    const current = await this.requireTask(bookId, taskId).catch(() => null);
    if (!current || current.status !== "running") return null;
    const resolvedChapterNumber = current.currentChapterNumber ?? activeChapterNumber;
    if (resolvedChapterNumber === null) return null;
    if (activeChapterNumber !== null && resolvedChapterNumber !== activeChapterNumber) return null;
    if (current.chapterFinishedAt) return null;

    const isWritingStage = current.stage === "write_chapter";
    const liveWrittenWords = isWritingStage
      ? baseWords + estimateLiveWordCount(progress, language)
      : current.writtenWords;
    const liveTotalTokens = baseTokenUsage.totalTokens + estimateLiveTokenUsage(progress, language).totalTokens;
    const liveTokenUsage = {
      promptTokens: baseTokenUsage.promptTokens,
      completionTokens: Math.max(0, liveTotalTokens - baseTokenUsage.promptTokens),
      totalTokens: liveTotalTokens,
    };

    if (
      current.writtenWords === liveWrittenWords
      && current.tokenUsage?.promptTokens === liveTokenUsage.promptTokens
      && current.tokenUsage?.completionTokens === liveTokenUsage.completionTokens
      && current.tokenUsage?.totalTokens === liveTokenUsage.totalTokens
    ) {
      return current;
    }

    const updated = await this.store.update(bookId, taskId, (task) => ({
      ...task,
      writtenWords: liveWrittenWords,
      tokenUsage: liveTokenUsage,
      lastHeartbeatAt: nowIso(),
      updatedAt: nowIso(),
    }));
    await this.appendTaskEvent("book-task:update", updated);
    this.deps.broadcast("book-task:progress", {
      bookId,
      taskId,
      task: summarizeTask(updated),
      progress: {
        elapsedMs: progress.elapsedMs,
        totalChars: progress.totalChars,
        chineseChars: progress.chineseChars,
        status: progress.status,
        tokenUsage: liveTokenUsage,
      },
    });
    return updated;
  }

  private taskSignalKey(bookId: string, taskId: string): string {
    return `${bookId}:${taskId}`;
  }

  private enqueueTaskSignal(bookId: string, taskId: string, work: () => Promise<void>): void {
    const key = this.taskSignalKey(bookId, taskId);
    const previous = this.taskSignalChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((error) => {
        console.warn("[studio] task stage signal update failed:", error);
      })
      .then(() => undefined);
    this.taskSignalChains.set(key, next);
  }

  private async drainTaskSignals(bookId: string, taskId: string): Promise<void> {
    await this.taskSignalChains.get(this.taskSignalKey(bookId, taskId));
  }

  private resolveSignalFromLog(message: string): { stage: string; detail: string; heartbeat?: boolean } | null {
    const text = message.trim();
    if (!text) return null;
    const normalized = text.replace(/^(?:阶段：|Stage:\s*)/i, "");
    if (/（进行中\s*\d+s）|\(\d+s elapsed\)/i.test(normalized)) {
      return { stage: "heartbeat", detail: text, heartbeat: true };
    }
    if (/^(准备章节输入|preparing chapter inputs)/i.test(normalized)) {
      return { stage: "prepare", detail: "读取书籍配置与运行参数" };
    }
    if (/^(撰写章节草稿|writing chapter draft)/i.test(normalized)) {
      return { stage: "write_chapter", detail: "正在撰写章节草稿" };
    }
    if (/^(审计第\d+章|auditing chapter \d+)/i.test(normalized)) {
      return { stage: "audit", detail: normalized };
    }
    if (/^(加载第\d+章.*修订上下文|revising chapter \d+|rewriting chapter \d+)/i.test(normalized)) {
      return { stage: "revise", detail: normalized };
    }
    if (/^(落盘最终章节|persisting final chapter)/i.test(normalized)) {
      return { stage: "saving_persist", detail: "正在落盘最终章节" };
    }
    if (/^(生成最终真相文件|rebuilding final truth files)/i.test(normalized)) {
      return { stage: "saving_truth", detail: "正在生成最终真相文件" };
    }
    if (/^(校验真相文件变更|validating truth file updates)/i.test(normalized)) {
      return { stage: "saving_validate", detail: "正在校验真相文件变更" };
    }
    if (/^(同步记忆索引|syncing memory indexes)/i.test(normalized)) {
      return { stage: "saving_memory", detail: "正在同步记忆索引" };
    }
    if (/^(更新章节索引与快照|updating chapter index and snapshots)/i.test(normalized)) {
      return { stage: "saving_index", detail: "正在更新章节索引与快照" };
    }
    return null;
  }

  private isDetailedSavingStage(stage: string): boolean {
    return stage === "audit"
      || stage === "revise"
      || stage === "saving_persist"
      || stage === "saving_truth"
      || stage === "saving_validate"
      || stage === "saving_memory"
      || stage === "saving_index";
  }

  private async handleTaskSignal(bookId: string, taskId: string, signal: TaskProgressSignal): Promise<void> {
    if (signal.kind === "log") {
      const parsed = this.resolveSignalFromLog(signal.message ?? "");
      if (!parsed) return;
      if (parsed.heartbeat) {
        const current = await this.requireTask(bookId, taskId).catch(() => null);
        if (!current || current.status !== "running") return;
        await this.beatStage(current);
        return;
      }
      const current = await this.requireTask(bookId, taskId).catch(() => null);
      if (!current || current.status !== "running") return;
      await this.updateStage(current, parsed.stage, parsed.detail);
      return;
    }

    const current = await this.requireTask(bookId, taskId).catch(() => null);
    if (!current || current.status !== "running") return;

    if (signal.kind === "audit:start") {
      const detail = signal.chapterNumber
        ? `第 ${signal.chapterNumber} 章审计中${typeof signal.round === "number" ? `（第 ${signal.round}/${signal.unboundedReview ? "∞" : (Number.isFinite(signal.maxReviseRounds) ? signal.maxReviseRounds : "∞")} 轮）` : ""}`
        : "审计中";
      await this.updateStage(current, "audit", detail);
      return;
    }

    if (signal.kind === "audit:complete") {
      const detail = signal.chapterNumber
        ? `第 ${signal.chapterNumber} 章审计完成${typeof signal.score === "number" ? `，评分 ${signal.score}/100` : ""}${typeof signal.issueCount === "number" ? `，问题 ${signal.issueCount} 项` : ""}`
        : "审计完成";
      await this.updateStage(current, "audit", detail);
      return;
    }

    if (signal.kind === "revise:start") {
      const detail = signal.chapterNumber
        ? `第 ${signal.chapterNumber} 章修订中${typeof signal.mode === "string" ? `（${signal.mode}）` : ""}${typeof signal.round === "number" ? `，第 ${signal.round}/${signal.unboundedReview ? "∞" : (Number.isFinite(signal.maxReviseRounds) ? signal.maxReviseRounds : "∞")} 轮` : ""}`
        : "修订中";
      await this.updateStage(current, "revise", detail);
      return;
    }

    if (signal.kind === "revise:complete") {
      const detail = signal.chapterNumber
        ? `第 ${signal.chapterNumber} 章修订完成${typeof signal.wordCount === "number" ? `，${signal.wordCount} 字` : ""}`
        : "修订完成";
      const stage = signal.applied ? "saving_persist" : "revise";
      await this.updateStage(current, stage, signal.applied ? `${detail}，正在保存结果` : detail);
    }
  }

  private async updateStage(
    task: BookTask,
    stage: string,
    detail: string,
    patch?: Partial<BookTask>,
    event: "book-task:stage" | "book-task:update" = "book-task:stage",
  ): Promise<BookTask> {
    const timestamp = nowIso();
    const updated = await this.store.update(task.bookId, task.id, (current) => ({
      ...current,
      ...patch,
      stage,
      stageLabel: stageLabel(stage),
      stageDetail: detail,
      stageStartedAt: patch?.stageStartedAt ?? (current.stage !== stage ? timestamp : current.stageStartedAt),
      stageUpdatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      updatedAt: timestamp,
    }));
    await this.appendTaskEvent(event, updated);
    return updated;
  }

  private async beatStage(task: BookTask, detail?: string): Promise<BookTask> {
    const timestamp = nowIso();
    const heartbeatTask: BookTask = {
      ...task,
      ...(detail ? { stageDetail: detail } : {}),
      lastHeartbeatAt: timestamp,
      updatedAt: timestamp,
    };
    await this.appendTaskEvent("book-task:update", heartbeatTask, { heartbeat: true });
    return heartbeatTask;
  }

  private resolveRetryDelayMs(retryCount: number): number {
    const base = 5_000;
    const max = 60_000;
    return Math.min(max, base * (2 ** Math.max(0, retryCount)));
  }

  private scheduleRetry(bookId: string, taskId: string, delayMs: number): void {
    const key = `${bookId}:${taskId}`;
    const existing = this.retryTimers.get(key);
    if (existing) clearTimeout(existing);
    const runRetry = () => {
      void (async () => {
        try {
          const task = await this.requireTask(bookId, taskId);
          if (task.status !== "retry_waiting") return;
          if (!task.retryEnabled) return;
          console.info(taskConsolePrefix({ bookId, taskId, taskType: task.type, retryCount: task.retryCount }), `retry starting after ${delayMs}ms wait`);
          const updated = await this.store.setStatus(bookId, taskId, "queued", {
            retryAt: nowIso(),
            startedAt: task.startedAt ?? nowIso(),
            chapterStartedAt: task.chapterStartedAt ?? null,
          });
          await this.appendTaskEvent("book-task:update", updated);
          const currentConfig = await this.deps.loadCurrentProjectConfig();
          void this.runTask(bookId, taskId, currentConfig);
        } catch (error) {
          console.warn("[studio] retry schedule failed:", error);
        } finally {
          this.retryTimers.delete(key);
        }
      })();
    };
    void this.requireTask(bookId, taskId).then((task) => {
      console.info(taskConsolePrefix({ bookId, taskId, taskType: task.type, retryCount: task.retryCount }), `retry scheduled in ${Math.max(0, delayMs)}ms`);
    }).catch(() => undefined);
    if (delayMs <= 0) {
      runRetry();
      return;
    }
    const timer = setTimeout(runRetry, Math.max(0, delayMs));
    this.retryTimers.set(key, timer);
  }

  private async runAuditTask(args: {
    readonly bookId: string;
    readonly taskId: string;
    readonly task: BookTask;
    readonly pipeline: PipelineLike;
  }): Promise<void> {
    const { bookId, taskId, pipeline } = args;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const chapterIndex = await this.deps.state.loadChapterIndex(bookId).catch(() => []);
    const chapterNumbers = [...new Set(
      chapterIndex
        .map((chapter) => Number(chapter.number))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value)),
    )].sort((left, right) => left - right);
    const latestChapterNumber = chapterNumbers[chapterNumbers.length - 1] ?? 0;
    const { start: auditStart, end: auditEnd } = buildAuditChapterRange({
      requestedChapters: args.task.requestedChapters,
      auditChapterStart: args.task.auditChapterStart,
      auditChapterEnd: args.task.auditChapterEnd,
      latestChapterNumber,
    });
    const chaptersToAudit = chapterNumbers.filter((chapterNumber) => chapterNumber >= auditStart && chapterNumber <= auditEnd);
    if (chaptersToAudit.length === 0) {
      const finalTask = await this.store.setStatus(bookId, taskId, "succeeded", {
        finishedAt: nowIso(),
        stage: "succeeded",
        stageLabel: stageLabel("succeeded"),
        stageDetail: chapterNumbers.length === 0
          ? "没有可审计章节，已忽略"
          : `审计范围 ${auditStart}-${auditEnd} 内没有可用章节，已忽略`,
        stageStartedAt: nowIso(),
        stageUpdatedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        chapterFinishedAt: nowIso(),
        result: {
          completedChapters: args.task.completedChapters,
          auditedChapters: 0,
          passedChapters: 0,
          failedChapters: 0,
          auditPassRate: null,
          auditChapterStart: auditStart,
          auditChapterEnd: auditEnd,
        },
        error: null,
      });
      await this.appendTaskEvent("book-task:complete", finalTask);
      return;
    }

    let completed = args.task.completedChapters;
    let latest = args.task;
    let auditedChapters = 0;
    let passedChapters = 0;
    let failedChapters = 0;
    const minPassScore = TASK_CENTER_AUDIT_MIN_PASS_SCORE;
    for (const chapterNumber of chaptersToAudit) {
      latest = await this.requireTask(bookId, taskId);
      if (latest.status === "stopping" || latest.stopRequestedAt) {
        const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
          finishedAt: nowIso(),
          stoppedAt: nowIso(),
          error: null,
          result: {
            cancelled: true,
            completedChapters: completed,
          },
        });
        await this.appendTaskEvent("book-task:complete", cancelled);
        return;
      }

      const chapterMeta = chapterIndex.find((chapter) => Number(chapter.number) === chapterNumber);
      if (!chapterMeta) {
        completed += 1;
        const auditMetrics = buildAuditMetrics({ auditedChapters, passedChapters, failedChapters });
        latest = await this.store.setStatus(bookId, taskId, "running", {
          completedChapters: completed,
          currentChapterNumber: chapterNumber,
          lastChapterNumber: chapterNumber,
          nextChapterNumber: chapterNumber + 1,
          chapterStartedAt: nowIso(),
          chapterFinishedAt: nowIso(),
          stage: "audit",
          stageLabel: stageLabel("audit"),
          stageDetail: `第 ${chapterNumber} 章不存在，自动忽略`,
          stageStartedAt: nowIso(),
          stageUpdatedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
          result: {
            skipped: true,
            chapterNumber,
            reason: "missing chapter",
            ...auditMetrics,
            auditChapterStart: auditStart,
            auditChapterEnd: auditEnd,
          },
        });
        await this.appendTaskEvent("book-task:update", latest);
        await this.appendTaskLog(latest, "info", `第 ${chapterNumber} 章不存在，自动忽略。`);
        continue;
      }
      let currentChapterMeta = chapterMeta;
      let auditLoopRound = 0;
      let auditRepairRound = 0;
      let auditUnresolvedIssueIds: string[] = [];
      let chapterFinished = false;
      while (!chapterFinished) {
        auditLoopRound += 1;
        const chapterAuditSnapshot = extractLatestChapterAuditSnapshot(currentChapterMeta);
        const chapterAuditPassed = isChapterAuditPassed(currentChapterMeta);
        const chapterAuditScore = chapterAuditSnapshot?.score ?? null;
        if (chapterAuditPassed && (chapterAuditScore === null || chapterAuditScore >= minPassScore)) {
          completed += 1;
          passedChapters += 1;
          const auditMetrics = buildAuditMetrics({ auditedChapters, passedChapters, failedChapters });
          const latestIndex = await this.deps.state.loadChapterIndex(bookId).catch(() => chapterIndex);
          currentChapterMeta = latestIndex.find((chapter) => Number(chapter.number) === chapterNumber) ?? currentChapterMeta;
          const latestSnapshot = extractLatestChapterAuditSnapshot(currentChapterMeta);
          const auditScore = latestSnapshot?.score ?? chapterAuditScore;
          latest = await this.store.setStatus(bookId, taskId, "running", {
            completedChapters: completed,
            currentChapterNumber: chapterNumber,
            lastChapterNumber: chapterNumber,
            nextChapterNumber: chapterNumber + 1,
            chapterFinishedAt: nowIso(),
            stage: "audit",
            stageLabel: stageLabel("audit"),
            stageDetail: `第 ${chapterNumber} 章审计通过${auditScore !== null && auditScore !== undefined ? `，评分 ${auditScore}/100` : ""}`,
            stageStartedAt: nowIso(),
            stageUpdatedAt: nowIso(),
            lastHeartbeatAt: nowIso(),
            result: {
              chapterNumber,
              passed: true,
              issueCount: 0,
              summary: null,
              auditScore,
              ...auditMetrics,
              auditChapterStart: auditStart,
              auditChapterEnd: auditEnd,
            },
          });
          await this.appendTaskEvent("book-task:update", latest);
          await this.appendTaskLog(
            latest,
            "info",
            auditScore !== null && auditScore !== undefined
              ? `第 ${chapterNumber} 章审计通过，评分 ${auditScore}/100。`
              : `第 ${chapterNumber} 章审计通过。`,
          );
          this.broadcastAuditComplete({
            task: latest,
            chapterNumber,
            passed: true,
            score: auditScore,
            issueCount: 0,
            summary: null,
            report: null,
            issues: [],
            status: "ready-for-review",
          });
          chapterFinished = true;
          continue;
        }

        if (chapterAuditPassed && chapterAuditScore !== null && chapterAuditScore < minPassScore) {
          await this.appendTaskLog(
            latest,
            "warn",
            `第 ${chapterNumber} 章最近审计评分 ${chapterAuditScore}/100，低于 ${minPassScore} 分门槛，进入自动修订。`,
          );
        }

        latest = await this.store.setStatus(bookId, taskId, "running", {
          currentChapterNumber: chapterNumber,
          nextChapterNumber: chapterNumber + 1,
          chapterStartedAt: nowIso(),
          chapterFinishedAt: null,
          stage: "audit",
          stageLabel: stageLabel("audit"),
          stageDetail: `第 ${chapterNumber} 章审计第 ${auditLoopRound} 轮`,
          stageStartedAt: nowIso(),
          stageUpdatedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
        });
        await this.appendTaskEvent("book-task:update", latest);
        clearHeartbeat();
        heartbeatTimer = setInterval(() => {
          void (async () => {
            const current = await this.requireTask(bookId, taskId).catch(() => null);
            if (!current || current.status !== "running" || current.stage !== "audit") return;
            await this.beatStage(current, `第 ${chapterNumber} 章审计第 ${auditLoopRound} 轮，已执行中`);
          })();
        }, Math.max(3_000, this.deps.resolveWriteStageHeartbeatMs()));
        await this.appendTaskLog(latest, "info", `开始审计第 ${chapterNumber} 章，第 ${auditLoopRound} 轮。`);

        const result = await pipeline.auditDraft(bookId, chapterNumber) as {
          readonly passed: boolean;
          readonly issues: ReadonlyArray<{ readonly severity?: string; readonly category?: string; readonly description?: string; readonly dimensionId?: string; readonly suggestion?: string }>;
          readonly summary?: string;
          readonly report?: string;
          readonly dimensionChecks?: ReadonlyArray<{ readonly dimension: string; readonly status: "pass" | "warning" | "failed"; readonly evidence?: string }>;
        };
        clearHeartbeat();
        await this.drainTaskSignals(bookId, taskId);
        auditedChapters += 1;
        const refreshedIndex = await this.deps.state.loadChapterIndex(bookId).catch(() => chapterIndex);
        currentChapterMeta = refreshedIndex.find((chapter) => Number(chapter.number) === chapterNumber) ?? currentChapterMeta;
        const refreshedSnapshot = extractLatestChapterAuditSnapshot(currentChapterMeta);
        const refreshed = await this.requireTask(bookId, taskId);
        if (refreshed.status === "stopping" || refreshed.stopRequestedAt) {
          const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
            finishedAt: nowIso(),
            stoppedAt: nowIso(),
            error: null,
            result: {
              cancelled: true,
              completedChapters: completed,
              lastChapterNumber: chapterNumber,
            },
          });
          await this.appendTaskEvent("book-task:complete", cancelled);
          return;
        }

        const initialAuditPassed = Boolean(result.passed) && (refreshedSnapshot?.score === null || refreshedSnapshot?.score === undefined || refreshedSnapshot.score >= MIN_AUDIT_PASS_SCORE);
        if (initialAuditPassed) {
          passedChapters += 1;
          const auditMetrics = buildAuditMetrics({ auditedChapters, passedChapters, failedChapters });
          const severityCounts = countAuditIssueSeverities(result.issues);
          const auditScore = estimateAuditScore(severityCounts);
          const issueTexts = normalizeAuditIssueTexts(result.issues);
          await persistChapterAuditSummary({
            state: this.deps.state,
            bookId,
            chapterNumber,
            audit: {
              passed: true,
              score: auditScore,
              issueCount: result.issues.length,
              summary: result.summary ?? null,
              report: result.report ?? null,
              issues: issueTexts,
              severityCounts,
            },
          });
          latest = await this.store.setStatus(bookId, taskId, "running", {
            completedChapters: completed,
            currentChapterNumber: chapterNumber,
            lastChapterNumber: chapterNumber,
            nextChapterNumber: chapterNumber + 1,
            chapterFinishedAt: nowIso(),
            stage: "audit",
            stageLabel: stageLabel("audit"),
            stageDetail: `第 ${chapterNumber} 章审计通过${auditScore !== null && auditScore !== undefined ? `，评分 ${auditScore}/100` : ""}`,
            stageStartedAt: refreshed.stageStartedAt ?? nowIso(),
            stageUpdatedAt: nowIso(),
            lastHeartbeatAt: nowIso(),
            result: {
              chapterNumber,
              passed: true,
              issueCount: result.issues.length,
              summary: result.summary ?? null,
              auditScore,
              ...auditMetrics,
              auditChapterStart: auditStart,
              auditChapterEnd: auditEnd,
            },
          });
          await this.appendTaskEvent("book-task:update", latest);
          await this.appendTaskLog(
            latest,
            "info",
            auditScore !== null && auditScore !== undefined
              ? `第 ${chapterNumber} 章审计通过，评分 ${auditScore}/100。`
              : `第 ${chapterNumber} 章审计通过。`,
          );
          this.broadcastAuditComplete({
            task: latest,
            chapterNumber,
            passed: true,
            score: auditScore,
            issueCount: result.issues.length,
            summary: result.summary ?? null,
            report: result.report ?? null,
            issues: result.issues,
            status: "ready-for-review",
          });
          chapterFinished = true;
          continue;
        }

        await this.appendTaskLog(
          latest,
          "warn",
          refreshedSnapshot?.score !== null && refreshedSnapshot?.score !== undefined
            ? `第 ${chapterNumber} 章审计评分 ${refreshedSnapshot.score}/100，未达标，进入自动修订。`
            : `第 ${chapterNumber} 章审计未通过，进入自动修订。`,
        );

        if (auditRepairRound >= TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS) {
          await this.appendTaskLog(latest, "warn", `第 ${chapterNumber} 章已达最大修订轮次（${TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS}），跳过。`);
          failedChapters += 1;
          const auditMetrics = buildAuditMetrics({ auditedChapters, passedChapters, failedChapters });
          latest = await this.store.setStatus(bookId, taskId, "running", {
            completedChapters: completed,
            currentChapterNumber: chapterNumber,
            lastChapterNumber: chapterNumber,
            nextChapterNumber: chapterNumber + 1,
            chapterFinishedAt: nowIso(),
            stage: "revise",
            stageLabel: stageLabel("revise"),
            stageDetail: `第 ${chapterNumber} 章修订${TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS}轮后仍未通过`,
            stageStartedAt: nowIso(),
            stageUpdatedAt: nowIso(),
            lastHeartbeatAt: nowIso(),
            result: {
              chapterNumber,
              passed: false,
              issueCount: result.issues.length,
              summary: result.summary ?? null,
              ...auditMetrics,
              auditChapterStart: auditStart,
              auditChapterEnd: auditEnd,
            },
          });
          await this.appendTaskEvent("book-task:update", latest);
          chapterFinished = true;
          continue;
        }
        auditRepairRound += 1;

        await this.updateStage(latest, "revise", `第 ${chapterNumber} 章审计未通过，正在自动修订（第 ${auditRepairRound}/${TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS} 轮）`);

        if (typeof pipeline.reviseDraft !== "function") {
          throw new Error(`Task pipeline does not support reviseDraft for chapter ${chapterNumber}.`);
        }

        const reviseSeverityCounts = countAuditIssueSeverities(result.issues);
        const reviseScore = typeof refreshedSnapshot?.score === "number"
          ? refreshedSnapshot.score
          : estimateAuditScore(reviseSeverityCounts);
        const reviseContext = buildFullReviseContext({
          issues: result.issues,
          severityCounts: reviseSeverityCounts,
          score: reviseScore,
          dimensionChecks: result.dimensionChecks,
          unresolvedIssueIdsFromPrevRound: auditUnresolvedIssueIds.length > 0
            ? auditUnresolvedIssueIds
            : undefined,
          previousRevisionWasNoop: auditRepairRound > 1 && auditUnresolvedIssueIds.length > 0,
          ...(auditRepairRound >= TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS
            ? {
                structureOverload: {
                  enabled: true,
                  reason: `第 ${auditRepairRound}/${TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS} 轮仍未通过，已切换为结构级重构模式。`,
                  signals: result.issues
                    .filter((issue) => issue.severity === "critical" || issue.severity === "warning")
                    .slice(0, 5)
                    .map((issue, index) => ({
                      code: `ISSUE-${String(index + 1).padStart(2, "0")}`,
                      severity: isStructuralAuditIssue({
                        category: issue.category ?? "",
                        dimensionId: issue.dimensionId,
                        description: issue.description,
                      }) ? "warning" : "info",
                      message: `${issue.category ?? "未分类"}：${issue.description ?? "未提供描述"}`,
                      suggestion: issue.suggestion ?? "先重构段落骨架，再处理局部措辞。",
                    })),
                },
              }
            : {}),
        });
        const revisionBrief = buildTaskCenterRevisionBrief({
          chapterNumber,
          reviseRound: auditRepairRound,
          maxReviseRounds: TASK_CENTER_AUDIT_REPAIR_MAX_ROUNDS,
          score: reviseScore,
          threshold: MIN_AUDIT_PASS_SCORE,
          summary: result.summary ?? null,
          report: result.report ?? null,
          severityCounts: reviseSeverityCounts,
          issues: result.issues,
        });
        const reviseMode = selectReviseMode(
          reviseSeverityCounts,
          auditRepairRound,
          reviseContext.primaryIssueClass ?? "none",
        );
        const reviseResult = await pipeline.reviseDraft(bookId, chapterNumber, reviseMode, {
          userBrief: revisionBrief,
          reviseContext,
        }) as {
          readonly status?: string;
          readonly applied?: boolean;
          readonly audit?: {
            readonly passed?: boolean;
            readonly score?: number;
            readonly issueCount?: number;
            readonly summary?: string;
            readonly report?: string;
            readonly severityCounts?: Readonly<{
              critical: number;
              warning: number;
              info: number;
            }>;
            readonly issues?: ReadonlyArray<{
              readonly severity?: string;
              readonly category?: string;
              readonly description?: string;
            }>;
          };
        };
        await this.drainTaskSignals(bookId, taskId);

        const revisionAuditScore = typeof reviseResult?.audit?.score === "number"
          ? reviseResult.audit.score
          : null;
        const revisionIssueCount = typeof reviseResult?.audit?.issueCount === "number"
          ? reviseResult.audit.issueCount
          : 0;
        const revisionPassed = Boolean(reviseResult?.audit?.passed ?? reviseResult?.status === "ready-for-review")
          && (revisionAuditScore === null || revisionAuditScore >= minPassScore);
        if (revisionPassed) {
          passedChapters += 1;
        } else {
          failedChapters += 1;
          // Track unresolved issues for next audit repair round
          const prevIssueIds = buildIssueIdList(result.issues);
          const nextIssues = reviseResult?.audit?.issues ?? [];
          const prevDescriptions = result.issues
            .filter((i) => i.severity === "critical" || i.severity === "warning")
            .map((i) => (i.description ?? "").slice(0, 50));
          const nextDescriptions = new Set(
            nextIssues
              .filter((i) => i.severity === "critical" || i.severity === "warning")
              .map((i) => (i.description ?? "").slice(0, 50)),
          );
          auditUnresolvedIssueIds = prevIssueIds.filter(
            (_id, index) => index < prevDescriptions.length && nextDescriptions.has(prevDescriptions[index]!),
          );
        }
        const auditMetrics = buildAuditMetrics({ auditedChapters, passedChapters, failedChapters });

        latest = await this.store.setStatus(bookId, taskId, "running", {
          completedChapters: completed,
          currentChapterNumber: chapterNumber,
          lastChapterNumber: chapterNumber,
          nextChapterNumber: chapterNumber + 1,
          chapterFinishedAt: nowIso(),
          stage: revisionPassed ? "audit" : "revise",
          stageLabel: stageLabel(revisionPassed ? "audit" : "revise"),
          stageDetail: revisionPassed
            ? `第 ${chapterNumber} 章已自动修订并复审通过${revisionAuditScore !== null ? `，评分 ${revisionAuditScore}/100` : ""}`
            : `第 ${chapterNumber} 章自动修订后仍未通过`,
          stageStartedAt: refreshed.stageStartedAt ?? nowIso(),
          stageUpdatedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
          result: {
            chapterNumber,
            passed: revisionPassed,
            issueCount: revisionIssueCount,
            summary: reviseResult?.audit?.summary ?? result.summary ?? null,
            revisionApplied: reviseResult?.applied ?? false,
            revisionStatus: reviseResult?.status ?? null,
            revisionAuditScore,
            ...auditMetrics,
            auditChapterStart: auditStart,
            auditChapterEnd: auditEnd,
          },
        });
        await this.appendTaskEvent("book-task:update", latest);
        await this.appendTaskLog(
          latest,
          revisionPassed ? "info" : "warn",
          revisionPassed
            ? `第 ${chapterNumber} 章已自动修订并复审通过${revisionAuditScore !== null ? `，评分 ${revisionAuditScore}/100` : ""}。`
            : `第 ${chapterNumber} 章自动修订后仍未通过审计。`,
        );
        if (revisionPassed) {
          const reviseAudit = reviseResult.audit;
          const reviseSeverityCounts = reviseAudit?.severityCounts ?? countAuditIssueSeverities(reviseAudit?.issues ?? []);
          const reviseAuditScore = typeof reviseAudit?.score === "number"
            ? reviseAudit.score
            : estimateAuditScore(reviseSeverityCounts);
          const reviseIssueTexts = reviseAudit?.issues ? normalizeAuditIssueTexts(reviseAudit.issues) : [];
          await persistChapterAuditSummary({
            state: this.deps.state,
            bookId,
            chapterNumber,
            audit: {
              passed: true,
              score: reviseAuditScore,
              issueCount: typeof reviseAudit?.issueCount === "number"
                ? reviseAudit.issueCount
                : reviseIssueTexts.length,
              summary: reviseAudit?.summary ?? result.summary ?? null,
              report: reviseAudit?.report ?? null,
              issues: reviseIssueTexts,
              severityCounts: reviseSeverityCounts,
            },
          });
          this.broadcastAuditComplete({
            task: latest,
            chapterNumber,
            passed: true,
            score: reviseAuditScore,
            issueCount: typeof reviseResult?.audit?.issueCount === "number"
              ? reviseResult.audit.issueCount
              : result.issues.length,
          summary: reviseResult?.audit?.summary ?? result.summary ?? null,
          report: reviseAudit?.report ?? null,
          status: "ready-for-review",
        });
          chapterFinished = true;
          continue;
        }
      }
    }

    const finalTask = await this.store.setStatus(bookId, taskId, "succeeded", {
      finishedAt: nowIso(),
      stage: "succeeded",
      stageLabel: stageLabel("succeeded"),
      stageDetail: "全部章节审计完成",
      stageStartedAt: nowIso(),
      stageUpdatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      chapterFinishedAt: nowIso(),
      result: {
        completedChapters: completed,
        lastChapterNumber: latest.lastChapterNumber,
        ...buildAuditMetrics({ auditedChapters, passedChapters, failedChapters }),
        auditChapterStart: auditStart,
        auditChapterEnd: auditEnd,
      },
      error: null,
    });
    await this.drainTaskSignals(bookId, taskId);
    await this.appendTaskEvent("book-task:complete", finalTask);
  }

  private async runTask(bookId: string, taskId: string, currentConfig: ProjectConfig): Promise<void> {
    if (this.runningTaskIds.has(taskId)) return;
    this.runningTaskIds.add(taskId);
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let bookLanguage: string | null = null;
    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    try {
      let task = await this.requireTask(bookId, taskId);
      if (task.status !== "queued") return;
      const book = await this.deps.state.loadBookConfig(bookId).catch(() => null);
      bookLanguage = book?.language ?? null;
      const taskType = normalizeTaskType(task.type);
      let auditTotalChapters = 0;
      let auditPassedChapters = 0;
      let auditFailedChapters = 0;

      task = await this.store.setStatus(bookId, taskId, "running", {
        startedAt: task.startedAt ?? nowIso(),
        finishedAt: null,
        chapterFinishedAt: null,
        updatedAt: nowIso(),
        stage: "prepare",
        stageLabel: stageLabel("prepare"),
        stageDetail: taskTypePrepareDetail(taskType),
        stageStartedAt: nowIso(),
        stageUpdatedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        chapterStartedAt: null,
      });
      await this.appendTaskEvent("book-task:update", task);
      await this.appendTaskLog(task, "info", taskTypeStartLog(taskType, task.requestedChapters));

      task = await this.updateStage(task, "resolve_model", "解析当前模型与服务商");
      const selectedRuntime = await this.deps.resolvePipelineClientFromSelection({
        currentConfig,
        selectedService: task.options.service ?? undefined,
        selectedModel: task.options.model ?? undefined,
      });
      if (selectedRuntime.error) {
        throw new Error(selectedRuntime.error);
      }

      task = await this.updateStage(task, "prepare", taskTypePrepareStage(taskType));
      const writeTaskMode = resolveWriteTaskMode(task);
      let activeChapterNumber: number | null = null;
      let chapterBaseWords = task.writtenWords ?? 0;
      let chapterBaseTokenUsage = task.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const pipeline = this.deps.createPipeline(await this.deps.buildPipelineConfig({
        currentConfig,
        ...(selectedRuntime.client ? { client: selectedRuntime.client as never } : {}),
        ...(selectedRuntime.model ? { model: selectedRuntime.model } : {}),
        writeStageHeartbeatMs: this.deps.resolveWriteStageHeartbeatMs(),
        onStreamProgress: (progress) => {
          void this.enqueueTaskSignal(bookId, taskId, async () => {
            await this.updateLiveTaskMetrics(
              bookId,
              taskId,
              chapterBaseWords,
              chapterBaseTokenUsage,
              progress,
              bookLanguage,
              activeChapterNumber,
            );
          });
        },
        onTaskSignal: (signal) => {
          void this.enqueueTaskSignal(bookId, taskId, () => this.handleTaskSignal(bookId, taskId, signal));
        },
      }));

      let completed = task.completedChapters;
      let latest = task;
      if (taskType === "audit") {
        await this.runAuditTask({
          bookId,
          taskId,
          task,
          pipeline: pipeline as PipelineLike,
        });
        return;
      }
      while (completed < task.requestedChapters) {
        latest = await this.requireTask(bookId, taskId);
        if (latest.status === "stopping" || latest.stopRequestedAt) {
          const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
            finishedAt: nowIso(),
            stoppedAt: nowIso(),
            error: null,
            result: {
              cancelled: true,
              completedChapters: completed,
            },
          });
          await this.appendTaskEvent("book-task:complete", cancelled);
          return;
        }

        const nextChapter = await this.deps.state.getNextChapterNumber(bookId);
        const chapterStageDetail = `正在写作第 ${nextChapter} 章`;
        activeChapterNumber = nextChapter;
        chapterBaseWords = latest.writtenWords ?? 0;
        chapterBaseTokenUsage = latest.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        latest = await this.store.setStatus(bookId, taskId, "running", {
          currentChapterNumber: nextChapter,
          nextChapterNumber: nextChapter + 1,
          chapterStartedAt: nowIso(),
          chapterFinishedAt: null,
          stage: "write_chapter",
          stageLabel: stageLabel("write_chapter"),
          stageDetail: chapterStageDetail,
          stageStartedAt: nowIso(),
          stageUpdatedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
        });
        await this.appendTaskEvent("book-task:update", latest);
        latest = await this.warnPendingStateRepairOnce(latest);
        clearHeartbeat();
        heartbeatTimer = setInterval(() => {
          void (async () => {
            const current = await this.requireTask(bookId, taskId).catch(() => null);
            if (!current || current.status !== "running" || current.stage !== "write_chapter") return;
            await this.beatStage(current, `${chapterStageDetail}，已执行中`);
          })();
        }, Math.max(3_000, this.deps.resolveWriteStageHeartbeatMs()));
        await this.appendTaskLog(latest, "info", `开始写作第 ${nextChapter} 章。`);

        const result = await pipeline.writeNextChapter(
          bookId,
          task.options.wordCount ?? undefined,
          undefined,
          { quickMode: task.options.quickMode, allowPendingAuditFailure: true, unboundedReview: writeTaskMode.unboundedReview },
        );

        clearHeartbeat();
        await this.drainTaskSignals(bookId, taskId);
        const resolvedChapterNumber = typeof result === "object" && result && "chapterNumber" in result
          ? Number((result as { chapterNumber?: unknown }).chapterNumber) || nextChapter
          : nextChapter;
        const initialWordCount = extractWordCount(result) ?? task.options.wordCount ?? 0;
        const initialTokenUsage = extractTokenUsage(result) ?? latest.tokenUsage ?? null;
        const chapterAuditPassed = extractChapterAuditPassed(result);
        let finalPipelineResult: unknown = result;
        let finalWordCount = initialWordCount;
        let finalTokenUsage = initialTokenUsage;
        let finalAuditPassed = chapterAuditPassed === true;
        let finalRevisionApplied = false;
        let finalRevisionStatus: string | null = typeof result === "object" && result && "status" in result && typeof (result as { status?: unknown }).status === "string"
          ? String((result as { status?: unknown }).status)
          : null;
        let finalRevisionAuditScore: number | null = null;

        const finalAuditFromResult = (payload: unknown): {
          readonly passed: boolean | null;
          readonly score: number | null;
          readonly issueCount: number;
          readonly summary: string | null;
          readonly report: string | null;
          readonly issues: ReadonlyArray<{ readonly severity?: string; readonly category?: string; readonly description?: string; readonly suggestion?: string }>;
        } => {
          if (!payload || typeof payload !== "object") {
            return { passed: null, score: null, issueCount: 0, summary: null, report: null, issues: [] };
          }
          const auditPayload = (payload as {
            readonly audit?: {
              readonly passed?: unknown;
              readonly score?: unknown;
              readonly issueCount?: unknown;
              readonly summary?: unknown;
              readonly report?: unknown;
              readonly issues?: unknown;
            };
            readonly auditResult?: {
              readonly passed?: unknown;
              readonly score?: unknown;
              readonly issueCount?: unknown;
              readonly summary?: unknown;
              readonly report?: unknown;
              readonly issues?: unknown;
            };
            readonly passed?: unknown;
          });
          const nested = auditPayload.audit ?? auditPayload.auditResult ?? null;
          const issues = Array.isArray(nested?.issues)
            ? nested.issues.filter((issue): issue is { readonly severity?: string; readonly category?: string; readonly description?: string; readonly suggestion?: string } => Boolean(issue) && typeof issue === "object")
            : [];
          return {
            passed: typeof nested?.passed === "boolean"
              ? nested.passed
              : typeof auditPayload.passed === "boolean"
                ? auditPayload.passed
                : null,
            score: Number.isFinite(Number(nested?.score)) ? Math.trunc(Number(nested?.score)) : null,
            issueCount: Number.isFinite(Number(nested?.issueCount)) ? Math.max(0, Math.round(Number(nested?.issueCount))) : issues.length,
            summary: typeof nested?.summary === "string" ? nested.summary : null,
            report: typeof nested?.report === "string" ? nested.report : null,
            issues,
          };
        };

        const currentAudit = finalAuditFromResult(result);
        if (currentAudit.passed !== true) {
          finalRevisionStatus = typeof result === "object" && result && "status" in result && typeof (result as { status?: unknown }).status === "string"
            ? String((result as { status?: unknown }).status)
            : finalRevisionStatus;
          finalRevisionAuditScore = currentAudit.score;
        }

        const wordCount = finalWordCount;
        const tokenUsage = finalTokenUsage;
        const auditedChaptersAfterThisRound = auditTotalChapters + 1;
        const passedChaptersAfterThisRound = auditPassedChapters + (finalAuditPassed ? 1 : 0);
        const failedChaptersAfterThisRound = auditFailedChapters + (finalAuditPassed ? 0 : 1);
        const auditMetrics = buildAuditMetrics({
          auditedChapters: auditedChaptersAfterThisRound,
          passedChapters: passedChaptersAfterThisRound,
          failedChapters: failedChaptersAfterThisRound,
        });
        if (chapterAuditPassed !== null) {
          auditTotalChapters = auditedChaptersAfterThisRound;
          if (finalAuditPassed) {
            auditPassedChapters = passedChaptersAfterThisRound;
          } else {
            auditFailedChapters = failedChaptersAfterThisRound;
          }
        }
        if (!finalAuditPassed) {
          const autoReviewReason = currentAudit.report?.trim()
            || currentAudit.summary?.trim()
            || extractAutoReviewStopReason(result)
            || "";
          const failureMessage = `第 ${resolvedChapterNumber} 章未通过自动复审${autoReviewReason ? `：${autoReviewReason}` : ""}。`;
          const failed = await this.store.setStatus(bookId, taskId, "failed", {
            finishedAt: nowIso(),
            error: failureMessage,
            result: {
              chapterNumber: resolvedChapterNumber,
              passed: false,
              issueCount: currentAudit.issueCount,
              summary: currentAudit.summary ?? null,
              revisionApplied: finalRevisionApplied,
              revisionStatus: finalRevisionStatus,
              revisionAuditScore: finalRevisionAuditScore,
              ...auditMetrics,
              auditChapterStart: nextChapter,
              auditChapterEnd: nextChapter,
            },
            lastErrorType: "quality",
            lastErrorCode: "chapter_audit_failed",
            lastErrorStage: "revise",
            stage: "failed",
            stageLabel: stageLabel("failed"),
            stageDetail: failureMessage,
            stageUpdatedAt: nowIso(),
            lastHeartbeatAt: nowIso(),
          });
          await this.appendTaskEvent("book-task:error", failed, {
            exceptionLog: {
              timestamp: nowIso(),
              level: "error",
              message: failureMessage,
            },
          });
          await this.appendTaskLog(failed, "error", failureMessage);
          return;
        }

        completed += 1;
        const refreshed = await this.requireTask(bookId, taskId);
        if (refreshed.status === "stopping" || refreshed.stopRequestedAt) {
          const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
            finishedAt: nowIso(),
            stoppedAt: nowIso(),
            error: null,
            result: {
              cancelled: true,
              completedChapters: completed,
              lastChapterNumber: resolvedChapterNumber,
            },
          });
          await this.appendTaskEvent("book-task:complete", cancelled);
          return;
        }
        const preserveDetailedStage = this.isDetailedSavingStage(refreshed.stage);
        latest = await this.store.setStatus(bookId, taskId, "running", {
          completedChapters: completed,
          currentChapterNumber: resolvedChapterNumber,
          lastChapterNumber: resolvedChapterNumber,
          nextChapterNumber: nextChapter + 1,
          chapterFinishedAt: nowIso(),
          ...(preserveDetailedStage
            ? {
                stageUpdatedAt: nowIso(),
                lastHeartbeatAt: nowIso(),
              }
            : {
                stage: "saving",
                stageLabel: stageLabel("saving"),
                stageDetail: `第 ${nextChapter} 章完成，正在保存结果`,
                stageStartedAt: nowIso(),
                stageUpdatedAt: nowIso(),
                lastHeartbeatAt: nowIso(),
              }),
          writtenChapters: completed,
          writtenWords: (latest.writtenWords ?? 0) + wordCount,
          tokenUsage,
          result: {
            ...(typeof finalPipelineResult === "object" && finalPipelineResult ? (finalPipelineResult as Record<string, unknown>) : {}),
            ...auditMetrics,
          },
        });
        await this.appendTaskEvent("book-task:update", latest);
        await this.appendTaskLog(
          latest,
          "info",
          finalRevisionApplied
            ? `第 ${resolvedChapterNumber} 章已自动修订并复审通过${finalRevisionAuditScore !== null ? `，评分 ${finalRevisionAuditScore}/100` : ""}。`
            : `第 ${resolvedChapterNumber} 章完成。`,
        );

        if (isFatalWriteResult(finalPipelineResult)) {
          throw new Error(`章节 ${resolvedChapterNumber} 写作失败。`);
        }

        const refreshedAfterUpdate = await this.requireTask(bookId, taskId);
        if (refreshedAfterUpdate.status === "stopping" || refreshedAfterUpdate.stopRequestedAt) {
          const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
            finishedAt: nowIso(),
            stoppedAt: nowIso(),
            error: null,
            result: {
              cancelled: true,
              completedChapters: completed,
              lastChapterNumber: latest.lastChapterNumber,
            },
          });
          await this.appendTaskEvent("book-task:complete", cancelled);
          return;
        }
      }

      const finalTask = await this.store.setStatus(bookId, taskId, "succeeded", {
        finishedAt: nowIso(),
        stage: "succeeded",
        stageLabel: stageLabel("succeeded"),
        stageDetail: "全部章节写作完成",
        stageStartedAt: nowIso(),
        stageUpdatedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        chapterFinishedAt: nowIso(),
        result: {
          completedChapters: completed,
          lastChapterNumber: latest.lastChapterNumber,
          tokenUsage: latest.tokenUsage,
          writtenWords: latest.writtenWords,
          performance,
          ...buildAuditMetrics({
            auditedChapters: auditTotalChapters,
            passedChapters: auditPassedChapters,
            failedChapters: auditFailedChapters,
          }),
        },
        error: null,
        writtenChapters: completed,
      });
      await this.drainTaskSignals(bookId, taskId);
      await this.appendTaskEvent("book-task:complete", finalTask);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classification = classifyTaskError(message);
      const current = await this.requireTask(bookId, taskId).catch(() => null);
      const retryEnabled = current?.retryEnabled ?? true;
      const retryCount = current?.retryCount ?? 0;
      const shouldRetry = retryEnabled && current?.status !== "paused" && current?.status !== "stopping" && !current?.stopRequestedAt;
      const delayMs = shouldRetry ? this.resolveRetryDelayMs(retryCount) : 0;
      const retryAt = shouldRetry ? new Date(Date.now() + delayMs).toISOString() : null;
      const errorLog: RunLogEntry = {
        timestamp: nowIso(),
        level: "error",
        message,
      };
      const failed = await this.store.setStatus(bookId, taskId, shouldRetry ? "retry_waiting" : "failed", {
        finishedAt: nowIso(),
        error: message,
        result: null,
        lastErrorType: classification.type,
        lastErrorCode: classification.code,
        lastErrorStage: classification.stage,
        stage: shouldRetry ? "retry_waiting" : "failed",
        stageLabel: stageLabel(shouldRetry ? "retry_waiting" : "failed"),
        stageDetail: message,
        stageUpdatedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        retryAt,
        retryCount: shouldRetry ? retryCount + 1 : retryCount,
      }).catch(() => null);
      if (failed) {
        await this.store.appendExceptionLog(bookId, taskId, errorLog).catch(() => null);
        await this.appendTaskEvent("book-task:error", failed, { exceptionLog: errorLog });
        console.error(taskConsolePrefix({ bookId, taskId, taskType: failed.type, retryCount: failed.retryCount }), `task failed: ${message}`);
        if (shouldRetry) {
          await this.appendTaskLog(failed, "warn", `失败后自动重试中，第 ${failed.retryCount} 次尝试，${Math.round(delayMs / 1000)} 秒后重试。`).catch(() => null);
          console.info(taskConsolePrefix({ bookId, taskId, taskType: failed.type, retryCount: failed.retryCount }), `retry retryCount=${failed.retryCount} delayMs=${delayMs}`);
          this.scheduleRetry(bookId, taskId, delayMs);
        }
      }
    } finally {
      clearHeartbeat();
      this.runningTaskIds.delete(taskId);
    }
  }
}
