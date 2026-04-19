import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../../hooks/use-api";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { useChatStore } from "../../store/chat";
import { SidebarCard } from "./SidebarCard";
import { cn } from "../../lib/utils";
import { Check, Loader2, Pencil, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";

interface ChapterMeta {
  number: number;
  title: string;
  status: string;
  wordCount: number;
}

const STATUS_META: Record<string, { symbol: string; color: string; badge: string }> = {
  approved: { symbol: "✓", color: "text-emerald-500", badge: "bg-emerald-500/10 text-emerald-600" },
  "ready-for-review": { symbol: "◆", color: "text-amber-500", badge: "bg-amber-500/10 text-amber-600" },
  drafted: { symbol: "○", color: "text-muted-foreground", badge: "bg-muted/40 text-muted-foreground" },
  "needs-revision": { symbol: "✕", color: "text-destructive", badge: "bg-destructive/10 text-destructive" },
  "audit-failed": { symbol: "✕", color: "text-destructive", badge: "bg-destructive/10 text-destructive" },
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
  return hit ? t(hit) : status;
}

interface ChaptersSectionProps {
  readonly bookId: string;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage> };
}

function applyTemplate(template: string, replacements: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output;
}

export function ChaptersSection({ bookId, t, sse }: ChaptersSectionProps) {
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [auditingChapters, setAuditingChapters] = useState<ReadonlyArray<number>>([]);
  const [deletingChapters, setDeletingChapters] = useState<ReadonlyArray<number>>([]);
  const [approvingChapters, setApprovingChapters] = useState<ReadonlyArray<number>>([]);
  const rewriteFallbackTimers = useRef<Map<number, number>>(new Map());
  const auditFallbackTimers = useRef<Map<number, number>>(new Map());
  const approveFallbackTimers = useRef<Map<number, number>>(new Map());
  const deleteFallbackTimers = useRef<Map<number, number>>(new Map());
  const openChapterArtifact = useChatStore((s) => s.openChapterArtifact);
  const bumpBookDataVersion = useChatStore((s) => s.bumpBookDataVersion);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const appendAssistantMessage = useChatStore((s) => s.appendAssistantMessage);

  const chapterLabel = useCallback(
    (chapterNum: number) => t("chapter.label").replace("{n}", String(chapterNum)),
    [t],
  );

  const refreshChapters = useCallback(() => {
    fetchJson<{ chapters: ChapterMeta[] }>(`/books/${bookId}`)
      .then((data) => setChapters(data.chapters))
      .catch(() => setChapters([]));
  }, [bookId]);

  useEffect(() => {
    refreshChapters();
  }, [bookDataVersion, refreshChapters]);

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
    (chapterNum: number, passed: boolean, issueCount = 0, summary = "") => {
      if (!activeSessionId) return;
      const template = passed
        ? t("sidebar.chapter.action.auditPassed")
        : t("sidebar.chapter.action.auditFailed");
      const base = applyTemplate(template, { chapter: chapterLabel(chapterNum) });
      if (passed) {
        appendAssistantMessage(activeSessionId, base);
        return;
      }

      const suffixIssueCount = issueCount > 0 ? ` (${issueCount})` : "";
      const summaryText = summary.trim();
      const suffixSummary = summaryText.length > 0 ? ` - ${summaryText}` : "";
      appendAssistantMessage(activeSessionId, `${base}${suffixIssueCount}${suffixSummary}`);
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
      }, 180000);
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
    if (typeof payload?.chapterNumber === "number") return payload.chapterNumber;
    if (typeof payload?.chapter === "number") return payload.chapter;
    return null;
  }, []);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    const data = recent.data as {
      bookId?: string;
      chapter?: number;
      chapterNumber?: number;
      error?: string;
      passed?: boolean;
      issueCount?: number;
      summary?: string;
    } | null;
    if (data?.bookId !== bookId) return;

    if (recent.event === "rewrite:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearRewriteFallback(chapterNum);
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
      bumpBookDataVersion();
      refreshChapters();
      pushActionCompletedMessage(t("book.rewrite"), chapterNum);
      return;
    }

    if (recent.event === "rewrite:error") {
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

    if (recent.event === "audit:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearAuditFallback(chapterNum);
      setAuditingChapters((prev) => prev.filter((n) => n !== chapterNum));
      bumpBookDataVersion();
      refreshChapters();
      const passed = typeof data?.passed === "boolean" ? data.passed : false;
      const issueCount = typeof data?.issueCount === "number" ? data.issueCount : 0;
      const summary = typeof data?.summary === "string" ? data.summary : "";
      pushAuditResultMessage(chapterNum, passed, issueCount, summary);
      return;
    }

    if (recent.event === "audit:error") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum !== null) {
        clearAuditFallback(chapterNum);
        setAuditingChapters((prev) => prev.filter((n) => n !== chapterNum));
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

    if (recent.event === "approve:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearApproveFallback(chapterNum);
      setApprovingChapters((prev) => prev.filter((n) => n !== chapterNum));
      bumpBookDataVersion();
      refreshChapters();
      pushActionCompletedMessage(t("book.approve"), chapterNum);
      return;
    }

    if (recent.event === "approve:error") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearApproveFallback(chapterNum);
      setApprovingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(t("book.approve"), chapterNum, data?.error ?? t("book.approve"));
      return;
    }

    if (recent.event === "delete:complete") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearDeleteFallback(chapterNum);
      setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
      bumpBookDataVersion();
      refreshChapters();
      pushActionCompletedMessage(t("common.delete"), chapterNum);
      return;
    }

    if (recent.event === "delete:error") {
      const chapterNum = chapterNumFromEventData(data);
      if (chapterNum === null) return;
      clearDeleteFallback(chapterNum);
      setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(t("common.delete"), chapterNum, data?.error ?? t("sidebar.chapter.deleteFailed"));
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
    sse.messages,
    t,
  ]);

  const handleOpenChapterEditor = (ch: ChapterMeta) => {
    openChapterArtifact(ch.number, {
      edit: true,
      meta: {
        number: ch.number,
        title: ch.title,
        status: ch.status,
        wordCount: ch.wordCount ?? 0,
      },
    });
  };

  const handleRewrite = async (chapterNum: number) => {
    const brief = window.prompt(t("sidebar.chapter.rewritePrompt"), "");
    if (brief === null) return;
    const actionLabel = t("book.rewrite");
    pushActionStartMessage(actionLabel, chapterNum);
    setRewritingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    scheduleRewriteFallback(chapterNum);
    try {
      await fetchWithTimeout(
        `/books/${bookId}/rewrite/${chapterNum}`,
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
        },
        30000,
        actionLabel,
        chapterNum,
      );
      bumpBookDataVersion();
      refreshChapters();
    } catch (e) {
      clearRewriteFallback(chapterNum);
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(actionLabel, chapterNum, e instanceof Error ? e.message : t("sidebar.chapter.rewriteFailed"));
      alert(e instanceof Error ? e.message : t("sidebar.chapter.rewriteFailed"));
    }
  };

  const handleAudit = async (chapterNum: number) => {
    const actionLabel = t("book.audit");
    pushActionStartMessage(actionLabel, chapterNum);
    setAuditingChapters((prev) => (prev.includes(chapterNum) ? prev : [...prev, chapterNum]));
    scheduleAuditFallback(chapterNum);
    try {
      await fetchJson(`/books/${bookId}/audit/${chapterNum}`, { method: "POST" });
    } catch (e) {
      clearAuditFallback(chapterNum);
      setAuditingChapters((prev) => prev.filter((n) => n !== chapterNum));
      pushActionFailedMessage(actionLabel, chapterNum, e instanceof Error ? e.message : t("sidebar.chapter.auditActionFailed"));
      alert(e instanceof Error ? e.message : t("sidebar.chapter.auditActionFailed"));
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

  return (
    <SidebarCard title={t("sidebar.chapters")}>
      {chapters.length === 0 ? (
        <p className="text-xs text-muted-foreground/50 italic">
          {t("sidebar.noChapters")}
        </p>
      ) : (
        <ul className="space-y-1 max-h-52 overflow-y-auto overflow-x-hidden">
          {chapters.map((ch) => {
            const meta = STATUS_META[ch.status] ?? {
              symbol: "○",
              color: "text-muted-foreground",
              badge: "bg-muted/40 text-muted-foreground",
            };
            const rewriting = rewritingChapters.includes(ch.number);
            const auditing = auditingChapters.includes(ch.number);
            const deleting = deletingChapters.includes(ch.number);
            const approving = approvingChapters.includes(ch.number);
            return (
              <li
                key={`${ch.number}-${ch.title ?? ""}`}
                className="py-1 text-xs text-muted-foreground rounded px-1 -mx-1 hover:bg-secondary/50 transition-colors">
                <div className="flex items-start gap-2">
                  <span className={cn("text-[10px] shrink-0 mt-0.5", meta.color)}>{meta.symbol}</span>
                  <button
                    type="button"
                    onClick={() => handleOpenChapterEditor(ch)}
                    className="min-w-0 flex-1 text-left hover:text-foreground transition-colors"
                    title={t("sidebar.chapter.editBody")}
                  >
                    <div className="truncate">
                      {String(ch.number).padStart(2, "0")} {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </div>
                  </button>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", meta.badge)}>
                        {statusLabel(ch.status, t)}
                      </span>
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
                      >
                        {rewriting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApprove(ch.number)}
                        disabled={approving || ch.status !== "ready-for-review"}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                        title={t("book.approve")}
                      >
                        {approving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenChapterEditor(ch)}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                        title={t("common.edit")}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(ch.number)}
                        disabled={deleting}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                        title={t("common.delete")}
                      >
                        {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAudit(ch.number)}
                        disabled={auditing}
                        className="h-5 w-5 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                        title={t("book.audit")}
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
