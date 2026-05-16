import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../../hooks/use-api";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { useChatStore } from "../../store/chat";
import type { MessageAuditSummary } from "../../store/chat/types";
import { SidebarCard } from "./SidebarCard";
import { cn } from "../../lib/utils";
import { estimateAuditScoreFromIssueTexts, scoreBadgeClass } from "../../utils/audit-score";
import { describeChapterAutoReview } from "../../utils/auto-review-display";
import { resolveBookAgentInstruction } from "../../utils/agent-instruction";
import { Check, Loader2, Pencil, RotateCcw, ShieldCheck, Trash2, Wrench } from "lucide-react";

interface ChapterMeta {
  number: number;
  title: string;
  status: string;
  wordCount: number;
  auditIssues?: ReadonlyArray<string>;
  audit?: MessageAuditSummary;
  reviewNote?: string;
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

function applyTemplate(template: string, replacements: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output;
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
  return {
    chapter,
    passed: Boolean(payload.passed),
    issueCount,
    score: Math.max(0, Math.min(100, Math.trunc(scoreRaw))),
    ...(severityCounts ? { severityCounts } : {}),
    ...(failureGate ? { failureGate } : {}),
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

export function shouldCarryForwardAuditSummary(args: {
  previous: ChapterMeta;
  incoming: ChapterMeta;
}): boolean {
  if (args.previous.number !== args.incoming.number) return false;
  if (args.previous.status !== args.incoming.status) return false;
  const previousScore = Number(args.previous.audit?.score);
  if (Number.isFinite(previousScore)) {
    // Keep the last structured audit result when index refresh has no structured
    // audit payload (index.json currently stores issue texts, not audit.score).
    return true;
  }
  const previousIssues = Array.isArray(args.previous.auditIssues) ? args.previous.auditIssues : [];
  const incomingIssues = Array.isArray(args.incoming.auditIssues) ? args.incoming.auditIssues : [];
  return areIssueListsEqual(previousIssues, incomingIssues);
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

export function ChaptersSection({
  bookId,
  t,
  sse,
  className,
  listClassName,
  filter = "all",
}: ChaptersSectionProps) {
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [auditingChapters, setAuditingChapters] = useState<ReadonlyArray<number>>([]);
  const [autoReviewStateByChapter, setAutoReviewStateByChapter] = useState<Readonly<Record<number, AutoReviewChapterState>>>({});
  const [deletingChapters, setDeletingChapters] = useState<ReadonlyArray<number>>([]);
  const [approvingChapters, setApprovingChapters] = useState<ReadonlyArray<number>>([]);
  const [repairingChapters, setRepairingChapters] = useState<ReadonlyArray<number>>([]);
  const [auditingImpacted, setAuditingImpacted] = useState(false);
  const rewriteFallbackTimers = useRef<Map<number, number>>(new Map());
  const auditFallbackTimers = useRef<Map<number, number>>(new Map());
  const approveFallbackTimers = useRef<Map<number, number>>(new Map());
  const deleteFallbackTimers = useRef<Map<number, number>>(new Map());
  const refreshRequestSeqRef = useRef(0);
  const lastProcessedSseMessageRef = useRef<SSEMessage | null>(null);
  const latestAuditSummaryByChapterRef = useRef<Map<number, MessageAuditSummary>>(new Map());
  const openChapterArtifact = useChatStore((s) => s.openChapterArtifact);
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
            const normalized = normalizeAuditSummary(
              (chapter as { audit?: unknown }).audit,
              chapter.number,
            );
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
    const payload = data as { chapter?: unknown; chapterNumber?: unknown } | null;
    const chapterFromNumber = parsePositiveChapterNumber(payload?.chapterNumber);
    if (chapterFromNumber !== null) return chapterFromNumber;
    const chapterFromAlias = parsePositiveChapterNumber(payload?.chapter);
    if (chapterFromAlias !== null) return chapterFromAlias;
    return null;
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
      bumpBookDataVersion();
      refreshChapters();
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
      bumpBookDataVersion();
      refreshChapters();
    }
  }, [
    activeSessionId,
    appendAssistantMessage,
    bookId,
    bumpBookDataVersion,
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

    lastProcessedSseMessageRef.current = messages[messages.length - 1] ?? null;
  }, [handleSseEvent, sse.messages]);

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
      },
    });
  };

  const handleRewrite = async (chapterNum: number) => {
    const brief = window.prompt(t("sidebar.chapter.rewritePrompt"), "");
    if (brief === null) return;
    const actionLabel = t("book.rewrite");
    setRewritingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    scheduleRewriteFallback(chapterNum);
    try {
      const language = actionLabel.toLowerCase().includes("rewrite") ? "en" : "zh";
      const instruction = resolveBookAgentInstruction("rewrite", {
        chapterNumber: chapterNum,
        brief,
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
      actions={impactedChapters.length > 0
        ? (
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
        )
        : undefined}
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
            const chapterIssues = Array.isArray(ch.auditIssues) ? ch.auditIssues : [];
            const degradedReason = extractDegradedReason(ch.status, chapterIssues);
            const rewriteReviewReason = extractRewriteReviewReason(ch.reviewNote);
            const persistedAutoReviewReason = extractAutoReviewFinalReason(ch.reviewNote);
            const showAuditScore = ch.status === "audit-failed" || ch.status === "ready-for-review" || ch.status === "approved" || typeof ch.audit?.score === "number";
            const auditScore = resolveChapterAuditScore(ch);
            const autoReviewDisplay = describeChapterAutoReview(autoReviewStateByChapter[ch.number]);
            const autoReviewHint = autoReviewDisplay?.text ?? persistedAutoReviewReason;
            const autoReviewToneClass = autoReviewDisplay?.tone === "danger"
              ? "text-red-700/90"
              : autoReviewDisplay?.tone === "success"
                ? "text-emerald-700/90"
                : "text-sky-700/90";
            return (
              <li
                key={`${ch.number}-${ch.title ?? ""}`}
                className="py-1 text-xs text-muted-foreground rounded px-1 -mx-1 hover:bg-secondary/50 transition-colors">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                      meta.badge,
                      meta.color,
                    )}
                    title={statusLabel(ch.status, t)}
                    aria-label={statusLabel(ch.status, t)}
                  >
                    {meta.symbol}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOpenChapterEditor(ch)}
                    className="min-w-0 flex-1 text-left hover:text-foreground transition-colors"
                    title={t("sidebar.chapter.editBody")}
                  >
                    <div className="truncate">
                      {String(ch.number).padStart(2, "0")} {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </div>
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
                  </button>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", meta.badge)}>
                        {statusLabel(ch.status, t)}
                      </span>
                      {showAuditScore && (
                        <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums", scoreBadgeClass(auditScore))}>
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
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SidebarCard>
  );
}
