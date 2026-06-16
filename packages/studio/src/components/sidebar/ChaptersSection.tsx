import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, invalidateApiPaths, patchApi } from "../../hooks/use-api";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { useChatStore } from "../../store/chat";
import type { MessageAuditSummary } from "../../store/chat/types";
import type { ChapterAuditReport } from "../../shared/contracts";
import { SidebarCard } from "./SidebarCard";
import { cn } from "../../lib/utils";
import { estimateAuditScoreFromIssueTexts, scoreBadgeClass } from "../../utils/audit-score";
import { describeChapterAutoReview } from "../../utils/auto-review-display";
import { resolveBookAgentInstruction } from "../../utils/agent-instruction";
import { resolveLatestChapterAuditReport } from "../../utils/chapter-audit";
import { dispatchWriteNextInstruction } from "../../utils/write-next";
import { AUDIT_PASS_SCORE_THRESHOLD } from "../../utils/audit-score";
import { Check, Clock3, Loader2, Pencil, RotateCcw, ShieldCheck, Trash2, Wrench, Zap } from "lucide-react";

interface ChapterMeta {
  number: number;
  title: string;
  status: string;
  wordCount: number;
  auditIssues?: ReadonlyArray<string>;
  audit?: MessageAuditSummary;
  reviewNote?: string;
  auditHistory?: ReadonlyArray<ChapterAuditReport>;
}

const AUDIT_ACTION_TIMEOUT_MS = 600000;

const STATUS_META: Record<string, { symbol: string; color: string; badge: string }> = {
  approved: { symbol: "✓", color: "text-emerald-500", badge: "bg-emerald-500/10 text-emerald-600" },
  "ready-for-review": { symbol: "◆", color: "text-amber-500", badge: "bg-amber-500/10 text-amber-600" },
  drafted: { symbol: "○", color: "text-muted-foreground", badge: "bg-muted/40 text-muted-foreground" },
  "needs-revision": { symbol: "✕", color: "text-destructive", badge: "bg-destructive/10 text-destructive" },
  "audit-failed": { symbol: "✕", color: "text-destructive", badge: "bg-destructive/10 text-destructive" },
  "state-degraded": { symbol: "!", color: "text-orange-500", badge: "bg-orange-500/10 text-orange-600" },
  imported: { symbol: "◇", color: "text-blue-500", badge: "bg-blue-500/10 text-blue-600" },
};

function statusLabel(status: string, t: TFunction): string {
  const map: Record<string, Parameters<TFunction>[0]> = {
    approved: "sidebar.chapter.status.approved",
    "ready-for-review": "sidebar.chapter.status.readyForReview",
    drafted: "sidebar.chapter.status.drafted",
    "needs-revision": "sidebar.chapter.status.needsRevision",
    "audit-failed": "sidebar.chapter.status.auditFailed",
    imported: "sidebar.chapter.status.imported",
  };
  const hit = map[status];
  if (hit) return t(hit);
  if (status === "state-degraded") return "状态降级";
  return status;
}

interface ChaptersSectionProps {
  readonly bookId: string;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage> };
  readonly className?: string;
  readonly listClassName?: string;
  readonly filter?: "all" | "pending-review" | "failed";
  readonly onOpenAuditHistory?: (chapterNum: number) => void;
  readonly hidePassedAuditSummary?: boolean;
}

export function sliceUnprocessedSseMessages(
  messages: ReadonlyArray<SSEMessage>,
  lastProcessed: SSEMessage | null,
): ReadonlyArray<SSEMessage> {
  if (messages.length === 0) return [];
  if (!lastProcessed) return messages;
  const idx = messages.lastIndexOf(lastProcessed);
  if (idx < 0) return messages;
  return messages.slice(idx + 1);
}

function parsePositiveChapterNumber(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const chapter = Math.trunc(value);
  if (chapter <= 0) return null;
  return chapter;
}

export function extractChapterNumberFromPayload(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;
  const candidates = [
    payload.chapterNumber,
    payload.chapter,
    payload.task && typeof payload.task === "object" ? (payload.task as { chapterNumber?: unknown }).chapterNumber : undefined,
    payload.task && typeof payload.task === "object" ? (payload.task as { currentChapterNumber?: unknown }).currentChapterNumber : undefined,
    payload.task && typeof payload.task === "object" ? (payload.task as { lastChapterNumber?: unknown }).lastChapterNumber : undefined,
    payload.task && typeof payload.task === "object" ? (payload.task as { result?: { chapterNumber?: unknown } }).result?.chapterNumber : undefined,
  ];
  for (const candidate of candidates) {
    const chapter = parsePositiveChapterNumber(candidate);
    if (chapter !== null) return chapter;
  }
  return null;
}

function applyTemplate(template: string, replacements: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output;
}

export function chapterAuditScoreBadgeClass(score: number): string {
  if (score >= 80) return "bg-emerald-500/10 text-emerald-600";
  if (score >= 60) return "bg-amber-500/10 text-amber-600";
  return "bg-destructive/10 text-destructive";
}

function normalizeAuditIssueTexts(raw: unknown, limit = 6): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      result.push(item.trim());
    }
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeAuditSeverityCounts(raw: unknown): MessageAuditSummary["severityCounts"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as { critical?: unknown; warning?: unknown; info?: unknown };
  const critical = Number(payload.critical ?? 0);
  const warning = Number(payload.warning ?? 0);
  const info = Number(payload.info ?? 0);
  if (!Number.isFinite(critical) || !Number.isFinite(warning) || !Number.isFinite(info)) return undefined;
  return {
    critical: Math.max(0, Math.trunc(critical)),
    warning: Math.max(0, Math.trunc(warning)),
    info: Math.max(0, Math.trunc(info)),
  };
}

function normalizeAuditFailureGate(raw: unknown): MessageAuditSummary["failureGate"] | undefined {
  if (raw === "none" || raw === "critical" || raw === "score") return raw;
  return undefined;
}

function historyEntryToAuditSummary(entry: ChapterAuditReport | undefined, chapter: number): MessageAuditSummary | undefined {
  if (!entry) return undefined;
  const passed = entry.passed && Math.trunc(entry.score) >= AUDIT_PASS_SCORE_THRESHOLD;
  return {
    chapter,
    passed,
    issueCount: entry.issueCount,
    score: entry.score,
    ...(entry.severityCounts ? { severityCounts: entry.severityCounts } : {}),
    ...(passed ? { failureGate: entry.failureGate } : { failureGate: entry.failureGate === "critical" ? "critical" : "score" }),
    ...(typeof entry.summary === "string" && entry.summary.trim() ? { summary: entry.summary.trim() } : {}),
    ...(typeof entry.report === "string" && entry.report.trim() ? { report: entry.report.trim() } : {}),
    ...(Array.isArray(entry.issues) && entry.issues.length > 0 ? { issues: entry.issues } : {}),
  };
}

export function isAuditTaskCompletionForBook(message: SSEMessage, bookId: string): boolean {
  if (message.event !== "book-task:complete") return false;
  const payload = message.data as { bookId?: unknown; task?: { type?: unknown } } | null;
  return payload?.bookId === bookId && payload?.task?.type === "audit";
}

export function normalizeAuditSummary(raw: unknown, chapterHint?: number): MessageAuditSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as {
    chapter?: unknown;
    chapterNumber?: unknown;
    passed?: unknown;
    issueCount?: unknown;
    score?: unknown;
    severityCounts?: unknown;
    failureGate?: unknown;
    summary?: unknown;
    report?: unknown;
    issues?: unknown;
  };
  const chapterRaw = payload.chapterNumber ?? payload.chapter ?? chapterHint;
  const chapter = Number(chapterRaw);
  if (!Number.isFinite(chapter) || chapter <= 0) return undefined;
  const scoreRaw = Number(payload.score);
  if (!Number.isFinite(scoreRaw)) return undefined;
  const issues = normalizeAuditIssueTexts(payload.issues, 200);
  const severityCounts = normalizeAuditSeverityCounts(payload.severityCounts);
  const failureGate = normalizeAuditFailureGate(payload.failureGate);
  const issueCountRaw = Number(payload.issueCount);
  const issueCount = Number.isFinite(issueCountRaw)
    ? Math.max(0, Math.trunc(issueCountRaw))
    : issues.length;
  const passed = Boolean(payload.passed) && Math.trunc(scoreRaw) >= AUDIT_PASS_SCORE_THRESHOLD;
  return {
    chapter,
    passed,
    issueCount,
    score: Math.max(0, Math.min(100, Math.trunc(scoreRaw))),
    ...(severityCounts ? { severityCounts } : {}),
    ...(passed ? { failureGate } : { failureGate: failureGate === "critical" ? "critical" : "score" }),
    ...(typeof payload.summary === "string" && payload.summary.trim()
      ? { summary: payload.summary.trim() }
      : {}),
    ...(typeof payload.report === "string" && payload.report.trim()
      ? { report: payload.report.trim() }
      : {}),
    ...(issues.length > 0 ? { issues } : {}),
  };
}

function mergeAuditSummary(
  chapter: ChapterMeta,
  audit: MessageAuditSummary | undefined,
): ChapterMeta {
  if (!audit) return chapter;
  return {
    ...chapter,
    audit,
    auditIssues: audit.issues && audit.issues.length > 0 ? audit.issues : chapter.auditIssues,
  };
}

function areIssueListsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function shouldKeepAuditSummaryForStatus(status: string, audit: MessageAuditSummary): boolean {
  if (audit.passed) {
    return status === "ready-for-review" || status === "approved";
  }
  return status === "audit-failed";
}

export function shouldCarryForwardAuditSummary(args: {
  previous: ChapterMeta;
  incoming: ChapterMeta;
}): boolean {
  if (args.previous.number !== args.incoming.number) return false;
  const previousScore = Number(args.previous.audit?.score);
  if (Number.isFinite(previousScore)) {
    // Keep the last structured audit result when index refresh has no structured
    // audit payload (index.json currently stores issue texts, not audit.score).
    return shouldKeepAuditSummaryForStatus(args.incoming.status, args.previous.audit!);
  }
  if (args.previous.status !== args.incoming.status) return false;
  const previousIssues = Array.isArray(args.previous.auditIssues) ? args.previous.auditIssues : [];
  const incomingIssues = Array.isArray(args.incoming.auditIssues) ? args.incoming.auditIssues : [];
  return areIssueListsEqual(previousIssues, incomingIssues);
}

export function shouldShowChapterAuditSummary(
  audit: MessageAuditSummary | undefined,
  hidePassedAuditSummary: boolean,
): boolean {
  if (!audit) return false;
  return !audit.passed || !hidePassedAuditSummary;
}

export function resolveChapterAuditScore(chapter: {
  audit?: MessageAuditSummary;
  auditIssues?: ReadonlyArray<string>;
}): number {
  const score = Number(chapter.audit?.score);
  if (Number.isFinite(score)) return Math.max(0, Math.min(100, Math.trunc(score)));
  return estimateAuditScoreFromIssueTexts(Array.isArray(chapter.auditIssues) ? chapter.auditIssues : []);
}

function extractDegradedReason(status: string, issues: ReadonlyArray<string>): string | null {
  const containsDegradedHint = issues.some((item) => /state-degraded|状态降级/i.test(item));
  if (status !== "state-degraded" && !containsDegradedHint) return null;
  const matched = issues.find((item) =>
    /state-degraded|状态降级|落库|落盘|索引|快照|truth/i.test(item),
  );
  const normalized = (matched ?? "章节状态降级，请先执行“修复落库和索引”。")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
  return normalized || "章节状态降级，请先执行“修复落库和索引”。";
}

const REWRITE_IMPACT_NOTE_PREFIX = "[rewrite-impact]";
const AUTO_REVIEW_FINAL_NOTE_PREFIX = "[auto-review-final]";

export function extractRewriteReviewReason(reviewNote: unknown): string | null {
  if (typeof reviewNote !== "string") return null;
  const raw = reviewNote.trim();
  if (!raw) return null;
  if (raw.startsWith(REWRITE_IMPACT_NOTE_PREFIX)) {
    const stripped = raw.slice(REWRITE_IMPACT_NOTE_PREFIX.length).trim();
    return stripped || "上游章节已变更，请复核。";
  }
  if (/待复核|上游|重写/i.test(raw)) {
    return raw;
  }
  return null;
}

export function extractAutoReviewFinalReason(reviewNote: unknown): string | null {
  if (typeof reviewNote !== "string") return null;
  const raw = reviewNote.trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/u);
  const target = lines.find((line) => line.trim().startsWith(AUTO_REVIEW_FINAL_NOTE_PREFIX));
  if (!target) return null;
  const text = target.trim().slice(AUTO_REVIEW_FINAL_NOTE_PREFIX.length).trim();
  return text || "自动审计未通过，请人工接管。";
}

interface AutoReviewChapterState {
  readonly phase: "audit" | "revise" | "stopped";
  readonly round: number;
  readonly maxRounds: number;
  readonly reason?: string;
}

export function describeAutoReviewState(state: AutoReviewChapterState | undefined): string | null {
  return describeChapterAutoReview(state)?.text ?? null;
}

export function normalizeChapterTitleInput(title: string): string {
  return title.trim();
}

export function ChaptersSection({
  bookId,
  t,
  sse,
  className,
  listClassName,
  filter = "all",
  onOpenAuditHistory,
  hidePassedAuditSummary = false,
}: ChaptersSectionProps) {
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [auditingChapters, setAuditingChapters] = useState<ReadonlyArray<number>>([]);
  const [autoReviewStateByChapter, setAutoReviewStateByChapter] = useState<Readonly<Record<number, AutoReviewChapterState>>>({});
  const [deletingChapters, setDeletingChapters] = useState<ReadonlyArray<number>>([]);
  const [approvingChapters, setApprovingChapters] = useState<ReadonlyArray<number>>([]);
  const [repairingChapters, setRepairingChapters] = useState<ReadonlyArray<number>>([]);
  const [expandedAuditHistoryChapters, setExpandedAuditHistoryChapters] = useState<ReadonlyArray<number>>([]);
  const [auditingImpacted, setAuditingImpacted] = useState(false);
  const [editingChapterNum, setEditingChapterNum] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const rewriteFallbackTimers = useRef<Map<number, number>>(new Map());
  const auditFallbackTimers = useRef<Map<number, number>>(new Map());
  const approveFallbackTimers = useRef<Map<number, number>>(new Map());
  const deleteFallbackTimers = useRef<Map<number, number>>(new Map());
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const refreshRequestSeqRef = useRef(0);
  const lastProcessedSseMessageRef = useRef<SSEMessage | null>(null);
  const latestAuditSummaryByChapterRef = useRef<Map<number, MessageAuditSummary>>(new Map());
  const auditRefreshTimerRef = useRef<number | null>(null);
  const openChapterArtifact = useChatStore((s) => s.openChapterArtifact);
  const activeChapterNumber = useChatStore((s) => s.artifactChapter);
  const bumpBookDataVersion = useChatStore((s) => s.bumpBookDataVersion);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const appendAssistantMessage = useChatStore((s) => s.appendAssistantMessage);
  const createSession = useChatStore((s) => s.createSession);
  const activateSession = useChatStore((s) => s.activateSession);
  const sendMessage = useChatStore((s) => s.sendMessage);

  const chapterLabel = useCallback(
    (chapterNum: number) => t("chapter.label").replace("{n}", String(chapterNum)),
    [t],
  );

  const refreshChapters = useCallback(() => {
    const requestSeq = refreshRequestSeqRef.current + 1;
    refreshRequestSeqRef.current = requestSeq;
    fetchJson<{ chapters: ChapterMeta[] }>(`/books/${bookId}`)
      .then((data) => {
        if (requestSeq !== refreshRequestSeqRef.current) return;
        setChapters((previous) => {
          const previousByChapter = new Map<number, ChapterMeta>();
          previous.forEach((chapter) => {
            previousByChapter.set(chapter.number, chapter);
          });
          return data.chapters.map((chapter) => {
            const auditHistory = Array.isArray(chapter.auditHistory) ? chapter.auditHistory : [];
            const normalized = normalizeAuditSummary(
              (chapter as { audit?: unknown }).audit,
              chapter.number,
            ) ?? historyEntryToAuditSummary(auditHistory[auditHistory.length - 1], chapter.number);
            if (normalized) {
              latestAuditSummaryByChapterRef.current.set(chapter.number, normalized);
              return mergeAuditSummary(chapter, normalized);
            }
            const previousChapter = previousByChapter.get(chapter.number);
            if (
              previousChapter?.audit
              && shouldCarryForwardAuditSummary({ previous: previousChapter, incoming: chapter })
            ) {
              return mergeAuditSummary(chapter, previousChapter.audit);
            }
            const rememberedAudit = latestAuditSummaryByChapterRef.current.get(chapter.number);
            if (rememberedAudit) {
              const expectedStatus = rememberedAudit.passed ? "ready-for-review" : "audit-failed";
              if (chapter.status === expectedStatus) {
                return mergeAuditSummary(chapter, rememberedAudit);
              }
            }
            return chapter;
          });
        });
      })
      .catch(() => {
        if (requestSeq !== refreshRequestSeqRef.current) return;
        setChapters([]);
      });
  }, [bookId]);

  useEffect(() => {
    refreshChapters();
  }, [bookDataVersion, refreshChapters]);

  useEffect(() => {
    latestAuditSummaryByChapterRef.current.clear();
  }, [bookId]);

  useEffect(() => () => {
    if (auditRefreshTimerRef.current !== null) {
      window.clearTimeout(auditRefreshTimerRef.current);
      auditRefreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefreshChapters = useCallback((delay = 400) => {
    if (auditRefreshTimerRef.current !== null) {
      window.clearTimeout(auditRefreshTimerRef.current);
    }
    auditRefreshTimerRef.current = window.setTimeout(() => {
      auditRefreshTimerRef.current = null;
      refreshChapters();
    }, delay);
  }, [refreshChapters]);

  useEffect(() => {
    setExpandedAuditHistoryChapters([]);
    setEditingChapterNum(null);
    setDraftTitle("");
    setSavingTitle(false);
    setTitleError(null);
  }, [bookId]);

  useEffect(() => {
    if (editingChapterNum === null) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editingChapterNum]);

  useEffect(
    () => () => {
      for (const timerId of rewriteFallbackTimers.current.values()) {
        window.clearTimeout(timerId);
      }
      rewriteFallbackTimers.current.clear();
      for (const timerId of auditFallbackTimers.current.values()) {
        window.clearTimeout(timerId);
      }
      auditFallbackTimers.current.clear();
      for (const timerId of approveFallbackTimers.current.values()) {
        window.clearTimeout(timerId);
      }
      approveFallbackTimers.current.clear();
      for (const timerId of deleteFallbackTimers.current.values()) {
        window.clearTimeout(timerId);
      }
      deleteFallbackTimers.current.clear();
    },
    [],
  );

  const clearRewriteFallback = useCallback((chapterNum: number) => {
    const timerId = rewriteFallbackTimers.current.get(chapterNum);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      rewriteFallbackTimers.current.delete(chapterNum);
    }
  }, []);

  const clearAuditFallback = useCallback((chapterNum: number) => {
    const timerId = auditFallbackTimers.current.get(chapterNum);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      auditFallbackTimers.current.delete(chapterNum);
    }
  }, []);

  const clearApproveFallback = useCallback((chapterNum: number) => {
    const timerId = approveFallbackTimers.current.get(chapterNum);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      approveFallbackTimers.current.delete(chapterNum);
    }
  }, []);

  const clearDeleteFallback = useCallback((chapterNum: number) => {
    const timerId = deleteFallbackTimers.current.get(chapterNum);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      deleteFallbackTimers.current.delete(chapterNum);
    }
  }, []);

  const toggleAuditHistory = useCallback((chapterNum: number) => {
    setExpandedAuditHistoryChapters((previous) => (
      previous.includes(chapterNum)
        ? previous.filter((n) => n !== chapterNum)
        : [...previous, chapterNum]
    ));
  }, []);

  const pushActionStartMessage = useCallback(
    (actionLabel: string, chapterNum: number) => {
      if (!activeSessionId) return;
      const chapter = chapterLabel(chapterNum);
      addUserMessage(activeSessionId, `${actionLabel} ${chapter}`);
      appendAssistantMessage(
        activeSessionId,
        applyTemplate(t("sidebar.chapter.action.started"), { action: actionLabel, chapter }),
      );
    },
    [activeSessionId, addUserMessage, appendAssistantMessage, chapterLabel, t],
  );

  const pushActionCompletedMessage = useCallback(
    (actionLabel: string, chapterNum: number) => {
      if (!activeSessionId) return;
      appendAssistantMessage(
        activeSessionId,
        applyTemplate(t("sidebar.chapter.action.completed"), {
          action: actionLabel,
          chapter: chapterLabel(chapterNum),
        }),
      );
    },
    [activeSessionId, appendAssistantMessage, chapterLabel, t],
  );

  const pushActionFailedMessage = useCallback(
    (actionLabel: string, chapterNum: number, errorMessage: string) => {
      if (!activeSessionId) return;
      appendAssistantMessage(
        activeSessionId,
        applyTemplate(t("sidebar.chapter.action.failed"), {
          action: actionLabel,
          chapter: chapterLabel(chapterNum),
          error: errorMessage,
        }),
      );
    },
    [activeSessionId, appendAssistantMessage, chapterLabel, t],
  );

  const pushAuditResultMessage = useCallback(
    (
      chapterNum: number,
      passed: boolean,
      issueCount = 0,
      details?: {
        report?: string;
        summary?: string;
        issues?: ReadonlyArray<string>;
        score?: number;
        severityCounts?: Readonly<{
          critical: number;
          warning: number;
          info: number;
        }>;
        failureGate?: MessageAuditSummary["failureGate"];
      },
    ) => {
      if (!activeSessionId) return;
      const template = passed
        ? t("sidebar.chapter.action.auditPassed")
        : t("sidebar.chapter.action.auditFailed");
      const base = applyTemplate(template, { chapter: chapterLabel(chapterNum) });
      const suffix = !passed && issueCount > 0 ? ` (${issueCount})` : "";
      const lines = [`${base}${suffix}`];
      const report = details?.report?.trim();
      if (report) {
        appendAssistantMessage(activeSessionId, report);
        return;
      }
      const summary = details?.summary?.trim();
      if (summary) {
        lines.push(`审计摘要：${summary}`);
      }
      if (typeof details?.score === "number" && Number.isFinite(details.score)) {
        const counts = details.severityCounts;
        if (
          counts
          && Number.isFinite(counts.critical)
          && Number.isFinite(counts.warning)
          && Number.isFinite(counts.info)
        ) {
          lines.push(`审计评分：${details.score}/100（严重 ${counts.critical} / 警告 ${counts.warning} / 提示 ${counts.info}）`);
        } else {
          lines.push(`审计评分：${details.score}/100`);
        }
      }
      if (!passed && details?.failureGate === "score") {
        lines.push("失败原因：score gate 未通过。");
      } else if (!passed && details?.failureGate === "critical") {
        lines.push("失败原因：critical 问题门禁未通过。");
      }
      if (!passed) {
        const issues = (details?.issues ?? []).filter((item) => item.trim().length > 0);
        if (issues.length > 0) {
          lines.push("问题清单：");
          issues.forEach((issue, index) => {
            lines.push(`${index + 1}. ${issue}`);
          });
        }
      }
      appendAssistantMessage(activeSessionId, lines.join("\n"));
    },
    [activeSessionId, appendAssistantMessage, chapterLabel, t],
  );

  const fetchWithTimeout = useCallback(
    async <T,>(path: string, init: RequestInit, timeoutMs: number, actionLabel: string, chapterNum: number): Promise<T> => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchJson<T>(path, { ...init, signal: controller.signal });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          const timeoutMessage = applyTemplate(t("sidebar.chapter.action.timeout"), {
            action: actionLabel,
            chapter: chapterLabel(chapterNum),
          });
          throw new Error(timeoutMessage);
        }
        throw error;
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    [chapterLabel, t],
  );

  const scheduleRewriteFallback = useCallback(
    (chapterNum: number) => {
      clearRewriteFallback(chapterNum);
      const actionLabel = t("book.rewrite");
      const timeoutId = window.setTimeout(() => {
        setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
        pushActionFailedMessage(
          actionLabel,
          chapterNum,
          applyTemplate(t("sidebar.chapter.action.timeout"), {
            action: actionLabel,
            chapter: chapterLabel(chapterNum),
          }),
        );
        rewriteFallbackTimers.current.delete(chapterNum);
      }, 180000);
      rewriteFallbackTimers.current.set(chapterNum, timeoutId);
    },
    [chapterLabel, clearRewriteFallback, pushActionFailedMessage, t],
  );

  const scheduleApproveFallback = useCallback(
    (chapterNum: number) => {
      clearApproveFallback(chapterNum);
      const actionLabel = t("book.approve");
      const timeoutId = window.setTimeout(() => {
        setApprovingChapters((prev) => prev.filter((n) => n !== chapterNum));
        pushActionFailedMessage(
          actionLabel,
          chapterNum,
          applyTemplate(t("sidebar.chapter.action.timeout"), {
            action: actionLabel,
            chapter: chapterLabel(chapterNum),
          }),
        );
        approveFallbackTimers.current.delete(chapterNum);
      }, 180000);
      approveFallbackTimers.current.set(chapterNum, timeoutId);
    },
    [chapterLabel, clearApproveFallback, pushActionFailedMessage, t],
  );

  const scheduleAuditFallback = useCallback(
    (chapterNum: number) => {
      clearAuditFallback(chapterNum);
      const actionLabel = t("book.audit");
      const timeoutId = window.setTimeout(() => {
        setAuditingChapters((prev) => prev.filter((n) => n !== chapterNum));
        pushActionFailedMessage(
          actionLabel,
          chapterNum,
          applyTemplate(t("sidebar.chapter.action.timeout"), {
            action: actionLabel,
            chapter: chapterLabel(chapterNum),
          }),
        );
        auditFallbackTimers.current.delete(chapterNum);
      }, AUDIT_ACTION_TIMEOUT_MS);
      auditFallbackTimers.current.set(chapterNum, timeoutId);
    },
    [chapterLabel, clearAuditFallback, pushActionFailedMessage, t],
  );

  const scheduleDeleteFallback = useCallback(
    (chapterNum: number) => {
      clearDeleteFallback(chapterNum);
      const actionLabel = t("common.delete");
      const timeoutId = window.setTimeout(() => {
        setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
        pushActionFailedMessage(
          actionLabel,
          chapterNum,
          applyTemplate(t("sidebar.chapter.action.timeout"), {
            action: actionLabel,
            chapter: chapterLabel(chapterNum),
          }),
        );
        deleteFallbackTimers.current.delete(chapterNum);
      }, 180000);
      deleteFallbackTimers.current.set(chapterNum, timeoutId);
    },
    [chapterLabel, clearDeleteFallback, pushActionFailedMessage, t],
  );

  const chapterNumFromEventData = useCallback((data: unknown): number | null => {
    return extractChapterNumberFromPayload(data);
  }, []);

  const ensureBookSessionId = useCallback(async (): Promise<string> => {
    const state = useChatStore.getState();
    const currentSessionId = state.activeSessionId;
    if (currentSessionId) {
      const active = state.sessions[currentSessionId];
      if (active?.bookId === bookId) return currentSessionId;
    }

    const existingIds = state.sessionIdsByBook[bookId] ?? [];
    if (existingIds.length > 0) {
      const nextSessionId = existingIds[0]!;
      activateSession(nextSessionId);
      return nextSessionId;
    }

    return await createSession(bookId);
  }, [activateSession, bookId, createSession]);

  const dispatchAgentInstruction = useCallback(async (instruction: string): Promise<void> => {
    const sessionId = await ensureBookSessionId();
    const state = useChatStore.getState();
    const runtime = state.sessions[sessionId];
    if (runtime?.isStreaming || runtime?.isStopping) {
      const busyMessage = t("book.rewrite").toLowerCase().includes("rewrite")
        ? "Current session is still running. Please wait or stop it first."
        : "当前会话正在执行中，请先等待完成或停止当前任务。";
      throw new Error(busyMessage);
    }
    await sendMessage(sessionId, instruction, bookId);
  }, [bookId, ensureBookSessionId, sendMessage, t]);

  const handleSseEvent = useCallback((message: SSEMessage) => {
    const data = message.data as {
      bookId?: string;
      activeBookId?: string;
      chapter?: number;
      chapterNumber?: number;
      runId?: string;
      error?: string;
    } | null;
    const eventBookId = data?.bookId ?? data?.activeBookId;
    if (eventBookId !== bookId) return;

    if (message.event === "audit:start") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      const roundRaw = Number((data as { round?: unknown } | null)?.round);
      const maxRoundsRaw = Number((data as { maxRounds?: unknown } | null)?.maxRounds);
      if (
        Number.isFinite(roundRaw)
        && roundRaw > 0
        && Number.isFinite(maxRoundsRaw)
        && maxRoundsRaw > 0
      ) {
        const round = Math.trunc(roundRaw);
        const maxRounds = Math.trunc(maxRoundsRaw);
        setAutoReviewStateByChapter((prev) => ({
          ...prev,
          [chapterNum]: { phase: "audit", round, maxRounds },
        }));
      }
      setAuditingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
      scheduleAuditFallback(chapterNum);
      return;
    }

    if (message.event === "revise:start") {
      const chapterNum = chapterNumFromEventData(data);
      const autoTriggeredByAudit = Boolean((data as { autoTriggeredByAudit?: unknown } | null)?.autoTriggeredByAudit);
      if (chapterNum === null || !autoTriggeredByAudit) return;
      const roundRaw = Number((data as { round?: unknown } | null)?.round);
      const maxRoundsRaw = Number((data as { maxRounds?: unknown } | null)?.maxRounds);
      if (
        Number.isFinite(roundRaw)
        && roundRaw > 0
        && Number.isFinite(maxRoundsRaw)
        && maxRoundsRaw > 0
      ) {
        const round = Math.trunc(roundRaw);
        const maxRounds = Math.trunc(maxRoundsRaw);
        setAutoReviewStateByChapter((prev) => ({
          ...prev,
          [chapterNum]: { phase: "revise", round, maxRounds },
        }));
      }
      setAuditingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
      scheduleAuditFallback(chapterNum);
      return;
    }

    if (message.event === "revise:complete") {
      const chapterNum = chapterNumFromEventData(data);
      const autoTriggeredByAudit = Boolean((data as { autoTriggeredByAudit?: unknown } | null)?.autoTriggeredByAudit);
      if (chapterNum === null) return;
      if (autoTriggeredByAudit) {
        // Auto-review may continue with next audit round after revise completion.
        // Refresh fallback timeout to avoid false timeout while backend keeps running.
        scheduleAuditFallback(chapterNum);
        return;
      }
      // Manual revise: refresh UI to show updated content
      bumpBookDataVersion();
      refreshChapters();
      return;
    }

    if (message.event === "rewrite:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearRewriteFallback(chapterNum);
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
      bumpBookDataVersion();
      refreshChapters();
      pushActionCompletedMessage(t("book.rewrite"), chapterNum);
      return;
    }

    if (message.event === "rewrite:error") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum !== null) {
        clearRewriteFallback(chapterNum);
        setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
        pushActionFailedMessage(t("book.rewrite"), chapterNum, data?.error ?? t("sidebar.chapter.rewriteFailed"));
        return;
      }

      for (const timerId of rewriteFallbackTimers.current.values()) {
        window.clearTimeout(timerId);
      }
      rewriteFallbackTimers.current.clear();
      setRewritingChapters([]);
      if (activeSessionId) {
        appendAssistantMessage(activeSessionId, data?.error ?? t("sidebar.chapter.rewriteFailed"));
      }
      return;
    }

    if (message.event === "audit:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      const audit = normalizeAuditSummary(data, chapterNum);
      if (audit) {
        latestAuditSummaryByChapterRef.current.set(chapterNum, audit);
      }
      const passed = typeof (data as { passed?: unknown } | null)?.passed === "boolean"
        ? Boolean((data as { passed?: unknown } | null)?.passed)
        : Boolean(audit?.passed);
      const roundRaw = Number((data as { round?: unknown } | null)?.round);
      const maxRoundsRaw = Number((data as { maxRounds?: unknown } | null)?.maxRounds);
      const hasAutoRound = Number.isFinite(roundRaw) && roundRaw > 0 && Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0;
      const shouldContinueAutoCycle = hasAutoRound && !passed && roundRaw <= maxRoundsRaw;
      const stopReasonRaw = (data as { autoReviewStopReason?: unknown } | null)?.autoReviewStopReason;
      const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw.trim() : "";
      if (shouldContinueAutoCycle) {
        setAuditingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
        scheduleAuditFallback(chapterNum);
        const round = Math.trunc(roundRaw);
        const maxRounds = Math.trunc(maxRoundsRaw);
        setAutoReviewStateByChapter((prev) => ({
          ...prev,
          [chapterNum]: { phase: "audit", round, maxRounds },
        }));
      } else {
        clearAuditFallback(chapterNum);
        setAuditingChapters((prev) => prev.filter((n) => n !== chapterNum));
        if (hasAutoRound && !passed && roundRaw > maxRoundsRaw) {
          const round = Math.trunc(roundRaw);
          const maxRounds = Math.trunc(maxRoundsRaw);
          setAutoReviewStateByChapter((prev) => ({
            ...prev,
            [chapterNum]: {
              phase: "stopped",
              round,
              maxRounds,
              ...(stopReason.length > 0 ? { reason: stopReason } : {}),
            },
          }));
        } else {
          setAutoReviewStateByChapter((prev) => {
            if (!(chapterNum in prev)) return prev;
            const next = { ...prev };
            delete next[chapterNum];
            return next;
          });
        }
      }
      const payloadStatus = typeof (data as { status?: unknown } | null)?.status === "string"
        ? String((data as { status?: unknown } | null)?.status)
        : undefined;
      const payloadWordCountRaw = Number((data as { wordCount?: unknown } | null)?.wordCount);
      const payloadWordCount = Number.isFinite(payloadWordCountRaw) && payloadWordCountRaw >= 0
        ? Math.trunc(payloadWordCountRaw)
        : undefined;
      const eventIssues = normalizeAuditIssueTexts((data as { issues?: unknown } | null)?.issues, 200);
      setChapters((previous) =>
        previous.map((chapter) => {
          if (chapter.number !== chapterNum) return chapter;
          return mergeAuditSummary(
            {
              ...chapter,
              status: payloadStatus
                ?? (audit?.passed === true
                  ? "ready-for-review"
                  : audit?.passed === false
                    ? "audit-failed"
                    : chapter.status),
              ...(typeof payloadWordCount === "number" ? { wordCount: payloadWordCount } : {}),
              auditIssues: eventIssues.length > 0 ? eventIssues : chapter.auditIssues,
            },
            audit,
          );
        }),
      );
      useChatStore.setState((state) => {
        if (state.artifactChapter !== chapterNum || !state.artifactChapterMeta) return {};
        const merged = mergeAuditSummary(
          {
            ...state.artifactChapterMeta,
            status: payloadStatus
              ?? (audit?.passed === true
                ? "ready-for-review"
                : audit?.passed === false
                  ? "audit-failed"
                  : state.artifactChapterMeta.status),
            ...(typeof payloadWordCount === "number" ? { wordCount: payloadWordCount } : {}),
            auditIssues: eventIssues.length > 0
              ? eventIssues
              : (state.artifactChapterMeta.auditIssues ?? []),
          },
          audit,
        );
        return { artifactChapterMeta: merged };
      });
      scheduleRefreshChapters();
      // Chat /agent 审计会在主对话里返回完整报告；侧栏不重复追加消息。
      if (typeof data?.runId === "string" && data.runId.trim().length > 0) {
        return;
      }
      const issueCountRaw = (data as { issueCount?: unknown } | null)?.issueCount;
      const issueCount = Number(issueCountRaw);
      const summary = typeof (data as { summary?: unknown } | null)?.summary === "string"
        ? String((data as { summary?: unknown } | null)?.summary)
        : undefined;
      const report = typeof (data as { report?: unknown } | null)?.report === "string"
        ? String((data as { report?: unknown } | null)?.report)
        : undefined;
      const scoreRaw = (data as { score?: unknown } | null)?.score;
      const score = Number(scoreRaw);
      const severityCountsRaw = (data as { severityCounts?: unknown } | null)?.severityCounts;
      const failureGateRaw = (data as { failureGate?: unknown } | null)?.failureGate;
      const failureGate = normalizeAuditFailureGate(failureGateRaw);
      const severityCounts = typeof severityCountsRaw === "object" && severityCountsRaw !== null
        ? {
            critical: Number((severityCountsRaw as { critical?: unknown }).critical ?? 0),
            warning: Number((severityCountsRaw as { warning?: unknown }).warning ?? 0),
            info: Number((severityCountsRaw as { info?: unknown }).info ?? 0),
          }
        : undefined;
      const issues = normalizeAuditIssueTexts((data as { issues?: unknown } | null)?.issues);
      pushAuditResultMessage(
        chapterNum,
        passed,
        Number.isFinite(issueCount) && issueCount > 0 ? issueCount : issues.length,
        {
          report,
          summary,
          issues,
          score: Number.isFinite(score) ? score : undefined,
          severityCounts: severityCounts
            && Number.isFinite(severityCounts.critical)
            && Number.isFinite(severityCounts.warning)
            && Number.isFinite(severityCounts.info)
            ? severityCounts
            : undefined,
          failureGate,
        },
      );
      return;
    }

    if (message.event === "audit:error") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum !== null) {
        clearAuditFallback(chapterNum);
        setAuditingChapters((prev) => prev.filter((n) => n !== chapterNum));
        setAutoReviewStateByChapter((prev) => {
          if (!(chapterNum in prev)) return prev;
          const next = { ...prev };
          delete next[chapterNum];
          return next;
        });
        if (typeof data?.runId === "string" && data.runId.trim().length > 0) {
          return;
        }
        pushActionFailedMessage(t("book.audit"), chapterNum, data?.error ?? t("sidebar.chapter.auditActionFailed"));
        return;
      }

      for (const timerId of auditFallbackTimers.current.values()) {
        window.clearTimeout(timerId);
      }
      auditFallbackTimers.current.clear();
      setAuditingChapters([]);
      if (activeSessionId) {
        appendAssistantMessage(activeSessionId, data?.error ?? t("sidebar.chapter.auditActionFailed"));
      }
        return;
      }

    if (isAuditTaskCompletionForBook(message, bookId)) {
      invalidateApiPaths([`/api/v1/books/${bookId}`]);
      bumpBookDataVersion();
      scheduleRefreshChapters(900);
      return;
    }

    if (message.event === "approve:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearApproveFallback(chapterNum);
      setApprovingChapters((prev) => prev.filter((n) => n !== chapterNum));
      bumpBookDataVersion();
      refreshChapters();
      pushActionCompletedMessage(t("book.approve"), chapterNum);
      return;
    }

    if (message.event === "approve:error") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearApproveFallback(chapterNum);
      setApprovingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(t("book.approve"), chapterNum, data?.error ?? t("book.approve"));
      return;
    }

    if (message.event === "delete:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearDeleteFallback(chapterNum);
      setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
      bumpBookDataVersion();
      refreshChapters();
      pushActionCompletedMessage(t("common.delete"), chapterNum);
      return;
    }

    if (message.event === "delete:error") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearDeleteFallback(chapterNum);
      setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(t("common.delete"), chapterNum, data?.error ?? t("sidebar.chapter.deleteFailed"));
      return;
    }

    // Deterministic /agent commands (e.g. "审计第19章") may not go through the
    // sidebar action handlers. Refresh after agent completion as a safe fallback.
    if (message.event === "agent:complete") {
      scheduleRefreshChapters(900);
    }
  }, [
    activeSessionId,
    appendAssistantMessage,
    bookId,
    chapterNumFromEventData,
    clearAuditFallback,
    clearApproveFallback,
    clearDeleteFallback,
    clearRewriteFallback,
    pushAuditResultMessage,
    pushActionCompletedMessage,
    pushActionFailedMessage,
    refreshChapters,
    scheduleAuditFallback,
    scheduleRefreshChapters,
    t,
  ]);

  useEffect(() => {
    const messages = sse.messages;
    if (messages.length === 0) {
      lastProcessedSseMessageRef.current = null;
      return;
    }
    const pendingMessages = sliceUnprocessedSseMessages(
      messages,
      lastProcessedSseMessageRef.current,
    );
    for (const message of pendingMessages) {
      handleSseEvent(message);
    }

    const hasAuditCompletion = pendingMessages.some((message) =>
      message.event === "audit:complete" || message.event === "book-task:complete",
    );
    if (hasAuditCompletion) {
      scheduleRefreshChapters();
    }

    lastProcessedSseMessageRef.current = messages[messages.length - 1] ?? null;
  }, [handleSseEvent, scheduleRefreshChapters, sse.messages]);

  const handleOpenChapterEditor = (ch: ChapterMeta) => {
    openChapterArtifact(ch.number, {
      edit: false,
      meta: {
        number: ch.number,
        title: ch.title,
        status: ch.status,
        wordCount: ch.wordCount ?? 0,
        auditIssues: Array.isArray(ch.auditIssues) ? ch.auditIssues : [],
        ...(ch.audit ? { audit: ch.audit } : {}),
        ...(Array.isArray(ch.auditHistory) ? { auditHistory: ch.auditHistory } : {}),
      },
    });
  };

  const handleEditChapter = (ch: ChapterMeta) => {
    openChapterArtifact(ch.number, {
      edit: true,
      meta: {
        number: ch.number,
        title: ch.title,
        status: ch.status,
        wordCount: ch.wordCount ?? 0,
        auditIssues: Array.isArray(ch.auditIssues) ? ch.auditIssues : [],
        ...(ch.audit ? { audit: ch.audit } : {}),
        ...(Array.isArray(ch.auditHistory) ? { auditHistory: ch.auditHistory } : {}),
      },
    });
  };

  const beginTitleEdit = useCallback((chapter: ChapterMeta) => {
    setEditingChapterNum(chapter.number);
    setDraftTitle(chapter.title ?? "");
    setTitleError(null);
  }, []);

  const cancelTitleEdit = useCallback(() => {
    setEditingChapterNum(null);
    setDraftTitle("");
    setSavingTitle(false);
    setTitleError(null);
  }, []);

  const commitTitleEdit = useCallback(async (chapter: ChapterMeta) => {
    const nextTitle = normalizeChapterTitleInput(draftTitle);
    if (!nextTitle) {
      setTitleError("章节名称不能为空");
      return;
    }
    if (nextTitle === chapter.title) {
      cancelTitleEdit();
      return;
    }

    setSavingTitle(true);
    setTitleError(null);
    try {
      const result = await patchApi<{ title: string; updatedAt?: string }>(
        `/books/${bookId}/chapters/${chapter.number}/meta`,
        { title: nextTitle },
      );
      setChapters((previous) =>
        previous.map((item) =>
          item.number === chapter.number
            ? {
                ...item,
                title: result.title,
              }
            : item,
        ),
      );
      useChatStore.setState((state) => {
        if (state.artifactChapter !== chapter.number || !state.artifactChapterMeta) return {};
        return {
          artifactChapterMeta: {
            ...state.artifactChapterMeta,
            title: result.title,
            ...(typeof result.updatedAt === "string" ? { updatedAt: result.updatedAt } : {}),
          },
        };
      });
      bumpBookDataVersion();
      cancelTitleEdit();
    } catch (error) {
      setTitleError(error instanceof Error ? error.message : "章节名称保存失败");
      setSavingTitle(false);
    }
  }, [bookId, bumpBookDataVersion, cancelTitleEdit, draftTitle]);

  const handleRewrite = async (chapterNum: number) => {
    const brief = window.prompt(t("sidebar.chapter.rewritePrompt"), "");
    if (brief === null) return;
    const actionLabel = t("book.rewrite");
    const chapter = chapters.find((item) => item.number === chapterNum);
    setRewritingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    scheduleRewriteFallback(chapterNum);
    try {
      const language = actionLabel.toLowerCase().includes("rewrite") ? "en" : "zh";
      const latestStructuredAudit = historyEntryToAuditSummary(
        (chapter?.auditHistory?.length ?? 0) > 0 ? chapter?.auditHistory?.at(-1) : undefined,
        chapterNum,
      ) ?? chapter?.audit;
      const instruction = resolveBookAgentInstruction("rewrite", {
        chapterNumber: chapterNum,
        brief,
        auditReport: resolveLatestChapterAuditReport(chapter) ?? undefined,
        auditSummary: latestStructuredAudit
          ? {
              score: latestStructuredAudit.score,
              passScoreThreshold: AUDIT_PASS_SCORE_THRESHOLD,
              scoreShortfall: latestStructuredAudit.passed ? 0 : Math.max(0, AUDIT_PASS_SCORE_THRESHOLD - latestStructuredAudit.score),
              issueCount: latestStructuredAudit.issueCount,
              failureGate: latestStructuredAudit.failureGate,
              summary: latestStructuredAudit.summary,
              report: latestStructuredAudit.report,
              issues: latestStructuredAudit.issues,
              severityCounts: latestStructuredAudit.severityCounts,
            }
          : undefined,
        language,
      });
      await dispatchAgentInstruction(instruction);
      bumpBookDataVersion();
      refreshChapters();
    } catch (e) {
      pushActionFailedMessage(actionLabel, chapterNum, e instanceof Error ? e.message : t("sidebar.chapter.rewriteFailed"));
      alert(e instanceof Error ? e.message : t("sidebar.chapter.rewriteFailed"));
    } finally {
      clearRewriteFallback(chapterNum);
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleAudit = async (chapterNum: number) => {
    const actionLabel = t("book.audit");
    setAutoReviewStateByChapter((prev) => {
      if (!(chapterNum in prev)) return prev;
      const next = { ...prev };
      delete next[chapterNum];
      return next;
    });
    setAuditingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    scheduleAuditFallback(chapterNum);
    try {
      const instruction = actionLabel.toLowerCase().includes("audit")
        ? `audit chapter ${chapterNum}`
        : `审计第${chapterNum}章`;
      await dispatchAgentInstruction(instruction);
    } catch (e) {
      pushActionFailedMessage(actionLabel, chapterNum, e instanceof Error ? e.message : t("sidebar.chapter.auditActionFailed"));
      alert(e instanceof Error ? e.message : t("sidebar.chapter.auditActionFailed"));
    } finally {
      clearAuditFallback(chapterNum);
      setAuditingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleDelete = async (chapterNum: number) => {
    const confirmed = window.confirm(
      t("sidebar.chapter.deleteConfirm").replace("{n}", String(chapterNum)),
    );
    if (!confirmed) return;

    const actionLabel = t("common.delete");
    pushActionStartMessage(actionLabel, chapterNum);
    setDeletingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    scheduleDeleteFallback(chapterNum);
    try {
      await fetchWithTimeout(
        `/books/${bookId}/chapters/${chapterNum}`,
        { method: "DELETE" },
        30000,
        actionLabel,
        chapterNum,
      );
    } catch (e) {
      clearDeleteFallback(chapterNum);
      setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(actionLabel, chapterNum, e instanceof Error ? e.message : t("sidebar.chapter.deleteFailed"));
      alert(e instanceof Error ? e.message : t("sidebar.chapter.deleteFailed"));
    }
  };

  const handleApprove = async (chapterNum: number) => {
    const actionLabel = t("book.approve");
    pushActionStartMessage(actionLabel, chapterNum);
    setApprovingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    scheduleApproveFallback(chapterNum);
    try {
      await fetchWithTimeout(
        `/books/${bookId}/chapters/${chapterNum}/approve`,
        { method: "POST" },
        30000,
        actionLabel,
        chapterNum,
      );
    } catch (e) {
      clearApproveFallback(chapterNum);
      setApprovingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(actionLabel, chapterNum, e instanceof Error ? e.message : actionLabel);
      alert(e instanceof Error ? e.message : actionLabel);
    }
  };

  const handleRepair = async (chapterNum: number) => {
    const actionLabel = "修复";
    setRepairingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    try {
      const instruction = `修复第${chapterNum}章落库和索引`;
      await dispatchAgentInstruction(instruction);
      bumpBookDataVersion();
      refreshChapters();
      pushActionCompletedMessage(actionLabel, chapterNum);
    } catch (e) {
      pushActionFailedMessage(actionLabel, chapterNum, e instanceof Error ? e.message : "修复失败");
      alert(e instanceof Error ? e.message : "修复失败");
    } finally {
      setRepairingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const impactedChapters = chapters.filter((chapter) => Boolean(extractRewriteReviewReason(chapter.reviewNote)));
  const visibleChapters = chapters.filter((chapter) => {
    if (filter === "pending-review") return chapter.status === "ready-for-review";
    if (filter === "failed") {
      return chapter.status === "audit-failed"
        || chapter.status === "needs-revision"
        || chapter.status === "state-degraded";
    }
    return true;
  });

  const handleAuditImpacted = async () => {
    if (auditingImpacted) return;
    setAuditingImpacted(true);
    try {
      const auditLabel = t("book.audit");
      const instruction = auditLabel.toLowerCase().includes("audit")
        ? "audit impacted chapters"
        : "批量审计受影响章节";
      await dispatchAgentInstruction(instruction);
      bumpBookDataVersion();
      refreshChapters();
    } catch (error) {
      const message = error instanceof Error ? error.message : "批量审计受影响章节失败";
      if (activeSessionId) {
        appendAssistantMessage(activeSessionId, message);
      } else {
        alert(message);
      }
    } finally {
      setAuditingImpacted(false);
    }
  };

  return (
    <SidebarCard
      title={t("sidebar.chapters")}
      className={className}
      contentClassName={cn("min-h-0", listClassName)}
      actions={(
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/15 transition-colors"
            title={t("book.writeNext")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void dispatchWriteNextInstruction(bookId);
            }}
          >
            <Zap size={12} />
          </button>
          {impactedChapters.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 hover:bg-amber-500/20 transition-colors disabled:opacity-60"
              disabled={auditingImpacted}
              title={`批量审计待复核章节（${impactedChapters.length}）`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void handleAuditImpacted();
              }}
            >
              {auditingImpacted ? "审计中..." : `复核 ${impactedChapters.length}`}
            </button>
          )}
        </div>
      )}
    >
      {visibleChapters.length === 0 ? (
        <p className="text-xs text-muted-foreground/50 italic">
          {filter === "all" ? t("sidebar.noChapters") : "当前筛选下暂无章节"}
        </p>
      ) : (
        <ul className={cn("space-y-1 overflow-y-auto overflow-x-hidden", listClassName ?? "max-h-52")}>
          {visibleChapters.map((ch) => {
            const meta = STATUS_META[ch.status] ?? {
              symbol: "○",
              color: "text-muted-foreground",
              badge: "bg-muted/40 text-muted-foreground",
            };
            const rewriting = rewritingChapters.includes(ch.number);
            const auditing = auditingChapters.includes(ch.number);
            const deleting = deletingChapters.includes(ch.number);
            const approving = approvingChapters.includes(ch.number);
            const auditHistory = Array.isArray(ch.auditHistory) ? ch.auditHistory : [];
            const latestAuditHistory = auditHistory[auditHistory.length - 1];
            const latestStructuredAudit = ch.audit ?? historyEntryToAuditSummary(latestAuditHistory, ch.number);
            const chapterIssues = Array.isArray(ch.auditIssues) ? ch.auditIssues : [];
            const degradedReason = extractDegradedReason(ch.status, chapterIssues);
            const rewriteReviewReason = extractRewriteReviewReason(ch.reviewNote);
            const persistedAutoReviewReason = extractAutoReviewFinalReason(ch.reviewNote);
            const showAuditScore = ch.status === "audit-failed"
              || ch.status === "ready-for-review"
              || ch.status === "approved"
              || typeof latestStructuredAudit?.score === "number";
            const auditScore = resolveChapterAuditScore({
              audit: latestStructuredAudit,
              auditIssues: chapterIssues,
            });
            const autoReviewDisplay = describeChapterAutoReview(autoReviewStateByChapter[ch.number]);
            const autoReviewHint = autoReviewDisplay?.text ?? persistedAutoReviewReason;
            const autoReviewToneClass = autoReviewDisplay?.tone === "danger"
              ? "text-red-700/90"
              : autoReviewDisplay?.tone === "success"
                ? "text-emerald-700/90"
                : "text-sky-700/90";
            const isSelected = activeChapterNumber === ch.number;
            const latestAuditSummaryText = latestStructuredAudit?.summary?.trim() ?? latestStructuredAudit?.report?.split("\n")[0]?.trim() ?? "";
            const auditHistoryExpanded = expandedAuditHistoryChapters.includes(ch.number);
            const latestAuditToneClass = latestStructuredAudit?.passed === false
              ? "text-red-700/90"
              : "text-emerald-700/90";
            const showAuditSummary = shouldShowChapterAuditSummary(latestStructuredAudit, hidePassedAuditSummary);
            const hasAuditHistoryModal = typeof onOpenAuditHistory === "function";
            return (
              <li
                key={`${ch.number}-${ch.title ?? ""}`}
                role="button"
                tabIndex={0}
                onClick={() => handleOpenChapterEditor(ch)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleOpenChapterEditor(ch);
                  }
                }}
                className={cn(
                  "py-1 text-xs rounded px-1 -mx-1 transition-colors cursor-pointer outline-none",
                  isSelected
                    ? "border border-primary/50 bg-primary/10 text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                )}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                      meta.badge,
                      meta.color,
                      isSelected ? "ring-2 ring-primary/20" : "",
                    )}
                    title={statusLabel(ch.status, t)}
                    aria-label={statusLabel(ch.status, t)}
                  >
                    {meta.symbol}
                  </span>
                  <div className="min-w-0 flex-1">
                    {editingChapterNum === ch.number ? (
                      <div
                        className="space-y-1"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 font-medium tabular-nums text-foreground/80">
                            {String(ch.number).padStart(2, "0")}
                          </span>
                          <input
                            ref={titleInputRef}
                            type="text"
                            value={draftTitle}
                            disabled={savingTitle}
                            onChange={(event) => {
                              setDraftTitle(event.target.value);
                              if (titleError) setTitleError(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void commitTitleEdit(ch);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelTitleEdit();
                              }
                            }}
                            onBlur={() => {
                              if (savingTitle) return;
                              void commitTitleEdit(ch);
                            }}
                            className="h-7 flex-1 rounded-md border border-primary/30 bg-background px-2 text-xs text-foreground outline-none ring-offset-background focus:border-primary focus:ring-2 focus:ring-primary/20"
                            aria-label={`修改第${ch.number}章名称`}
                          />
                        </div>
                        {titleError && (
                          <div className="text-[10px] text-destructive">{titleError}</div>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          beginTitleEdit(ch);
                        }}
                        className="w-full min-w-0 text-left transition-colors hover:text-foreground"
                        title="点击修改章节名称"
                      >
                        <div className="truncate">
                          {String(ch.number).padStart(2, "0")} {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                        </div>
                      </button>
                    )}
                    {degradedReason && (
                      <div className="mt-0.5 truncate text-[10px] text-orange-600/90" title={degradedReason}>
                        降级原因：{degradedReason}
                      </div>
                    )}
                    {rewriteReviewReason && (
                      <div className="mt-0.5 truncate text-[10px] text-amber-600/90" title={rewriteReviewReason}>
                        待复核：{rewriteReviewReason}
                      </div>
                    )}
                    {autoReviewHint && (
                      <div className={cn("mt-0.5 truncate text-[10px]", autoReviewToneClass)} title={autoReviewHint}>
                        {autoReviewHint}
                      </div>
                    )}
                    {showAuditSummary && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px]">
                        {latestStructuredAudit && (
                          <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 font-medium", latestAuditToneClass === "text-red-700/90" ? "bg-red-500/10 text-red-700" : "bg-emerald-500/10 text-emerald-700")}>
                            最近审计 {latestStructuredAudit.passed ? "通过" : "未通过"} · 评分 {latestStructuredAudit.score}
                          </span>
                        )}
                        {latestAuditSummaryText && (
                          <span className="truncate text-muted-foreground/80" title={latestAuditSummaryText}>
                            {latestAuditSummaryText}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", meta.badge)}>
                        {statusLabel(ch.status, t)}
                      </span>
                      {showAuditScore && (
                        <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums", chapterAuditScoreBadgeClass(auditScore))}>
                          评分 {auditScore}
                        </span>
                      )}
                      <span className="tabular-nums text-[10px] text-muted-foreground/80 shrink-0 text-right">
                        {(ch.wordCount ?? 0).toLocaleString()} {t("book.words")}
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleRewrite(ch.number)}
                        disabled={rewriting}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                        title={t("book.rewrite")}
                        aria-label={t("book.rewrite")}
                      >
                        {rewriting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRepair(ch.number)}
                        disabled={repairingChapters.includes(ch.number) || ch.status !== "state-degraded"}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-orange-600 hover:bg-orange-500/10 transition-colors disabled:opacity-50"
                        title="修复"
                        aria-label="修复"
                      >
                        {repairingChapters.includes(ch.number) ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApprove(ch.number)}
                        disabled={approving || ch.status !== "ready-for-review"}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                        title="通过"
                        aria-label="通过"
                      >
                        {approving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEditChapter(ch)}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                        title="修订"
                        aria-label="修订"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(ch.number)}
                        disabled={deleting}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                      >
                        {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAudit(ch.number)}
                        disabled={auditing}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                        title="审计"
                        aria-label="审计"
                      >
                        {auditing ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                      </button>
                      {auditHistory.length > 0 && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (hasAuditHistoryModal) {
                              onOpenAuditHistory(ch.number);
                              return;
                            }
                            toggleAuditHistory(ch.number);
                          }}
                          className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          title={hasAuditHistoryModal ? "查看审计历史" : (auditHistoryExpanded ? "收起历史审计" : "展开历史审计")}
                          aria-label={hasAuditHistoryModal ? "查看审计历史" : (auditHistoryExpanded ? "收起历史审计" : "展开历史审计")}
                        >
                          <Clock3 size={10} />
                        </button>
                      )}
                  </div>
                </div>
                </div>
                {auditHistoryExpanded && auditHistory.length > 0 && (
                  <div className="mt-2 rounded-md border border-border/40 bg-background/60 p-2">
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span>审计历史</span>
                      <span>{auditHistory.length} 条记录</span>
                    </div>
                    <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                      {auditHistory.map((entry, index) => {
                        const timeText = (() => {
                          const date = new Date(entry.auditedAt);
                          return Number.isNaN(date.getTime()) ? entry.auditedAt : date.toLocaleString();
                        })();
                        const reportText = entry.report?.trim() || entry.summary?.trim() || "";
                        const severityText = entry.severityCounts
                          ? `严重 ${entry.severityCounts.critical} / 警告 ${entry.severityCounts.warning} / 提示 ${entry.severityCounts.info}`
                          : null;
                        return (
                          <div
                            key={`${entry.auditedAt}-${index}`}
                            className="rounded-md border border-border/30 bg-card/80 p-2 text-[10px] text-muted-foreground shadow-sm"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 font-medium", entry.passed ? "bg-emerald-500/10 text-emerald-700" : "bg-red-500/10 text-red-700")}>
                                {entry.passed ? "通过" : "未通过"} · 评分 {entry.score}
                              </span>
                              <span>问题 {entry.issueCount}</span>
                              <span className="inline-flex items-center gap-1" title={entry.auditedAt}>
                                <Clock3 size={10} />
                                {timeText}
                              </span>
                              {severityText && <span>{severityText}</span>}
                            </div>
                            {entry.summary && (
                              <div className="mt-1 text-[10px] text-foreground/80">
                                摘要：{entry.summary}
                              </div>
                            )}
                            {reportText && (
                              <pre className="mt-1 whitespace-pre-wrap rounded bg-secondary/30 p-2 text-[10px] leading-5 text-foreground/80">
                                {reportText}
                              </pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SidebarCard>
  );
}
