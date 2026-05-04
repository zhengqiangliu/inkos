import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { useServiceStore } from "../store/service";
import { useColors } from "../hooks/use-colors";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { resolveModelSelection } from "./chat-page-state";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { resolveBookAgentInstruction } from "../utils/agent-instruction";
import { withErrorGuidance } from "../utils/error-guidance";
import {
  ChevronLeft,
  Zap,
  FileText,
  CheckCheck,
  BarChart2,
  Download,
  Search,
  Wand2,
  Eye,
  Database,
  Check,
  X,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  Sparkles,
  Trash2,
  Save
} from "lucide-react";

const BOOK_DETAIL_AGENT_SESSION_KEY_PREFIX = "inkos:book-detail:agent-session:";

function getBookDetailAgentSessionKey(bookId: string): string {
  return `${BOOK_DETAIL_AGENT_SESSION_KEY_PREFIX}${bookId}`;
}

function readBookDetailSessionId(bookId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(getBookDetailAgentSessionKey(bookId))?.trim() ?? "";
  return value || null;
}

function writeBookDetailSessionId(bookId: string, sessionId: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(getBookDetailAgentSessionKey(bookId), sessionId);
}

function createBookDetailRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractToolUpdateText(partialResult: unknown): string | null {
  if (typeof partialResult === "string") {
    const value = partialResult.trim();
    return value.length > 0 ? value : null;
  }
  if (!partialResult || typeof partialResult !== "object") return null;
  const payload = partialResult as { text?: unknown; content?: unknown };
  if (typeof payload.text === "string") {
    const value = payload.text.trim();
    if (value) return value;
  }
  if (typeof payload.content === "string") {
    const value = payload.content.trim();
    if (value) return value;
  }
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => String(item.text).trim())
      .filter(Boolean)
      .join("\n");
    return text || null;
  }
  return null;
}

function formatElapsedMs(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function isHeartbeatLogLine(message: string): boolean {
  return /（进行中\s*\d+s）|\(\d+s elapsed\)/i.test(message);
}

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface RealtimeBatchProgress {
  batchId: string;
  status: "started" | "progress" | "completed" | "failed";
  total: number;
  completed: number;
  elapsedMs: number;
  currentChapter?: number;
  failedChapterNumber?: number;
  error?: string;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly chapterWordCount: number;
    readonly targetChapters?: number;
    readonly language?: string;
    readonly fanficMode?: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

type ReviseMode = "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";
type ExportFormat = "txt" | "md" | "epub";
type BookStatus = "active" | "paused" | "outlining" | "completed" | "dropped";

interface Nav {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toAnalytics: (bookId: string) => void;
  toTruth: (bookId: string) => void;
}

function translateChapterStatus(status: string, t: TFunction): string {
  const map: Record<string, () => string> = {
    "ready-for-review": () => t("chapter.readyForReview"),
    "approved": () => t("chapter.approved"),
    "drafted": () => t("chapter.drafted"),
    "needs-revision": () => t("chapter.needsRevision"),
    "imported": () => t("chapter.imported"),
    "audit-failed": () => t("chapter.auditFailed"),
    "state-degraded": () => "状态降级",
  };
  return map[status]?.() ?? status;
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  "ready-for-review": { color: "text-amber-500 bg-amber-500/10", icon: <Eye size={12} /> },
  approved: { color: "text-emerald-500 bg-emerald-500/10", icon: <Check size={12} /> },
  drafted: { color: "text-muted-foreground bg-muted/20", icon: <FileText size={12} /> },
  "needs-revision": { color: "text-destructive bg-destructive/10", icon: <RotateCcw size={12} /> },
  "state-degraded": { color: "text-orange-600 bg-orange-500/10", icon: <X size={12} /> },
  imported: { color: "text-blue-500 bg-blue-500/10", icon: <Download size={12} /> },
};

export function BookDetail({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const [writeRequestPending, setWriteRequestPending] = useState(false);
  const [draftRequestPending, setDraftRequestPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [revisingChapters, setRevisingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsWordCount, setSettingsWordCount] = useState<number | null>(null);
  const [settingsTargetChapters, setSettingsTargetChapters] = useState<number | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<BookStatus | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [exportApprovedOnly, setExportApprovedOnly] = useState(false);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [activeAgentRun, setActiveAgentRun] = useState<{ sessionId: string; runId: string } | null>(null);

  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchModels = useServiceStore((s) => s.fetchModels);

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  useEffect(() => {
    for (const service of services) {
      if (service.connected) void fetchModels(service.service);
    }
  }, [fetchModels, services]);

  const groupedModels = useMemo(() => (
    services
      .filter((service) => service.connected && (modelsByService[service.service]?.models.length ?? 0) > 0)
      .map((service) => ({
        service: service.service,
        label: service.label,
        models: modelsByService[service.service]!.models,
      }))
  ), [modelsByService, services]);

  useEffect(() => {
    const resolved = resolveModelSelection(groupedModels, selectedModel, selectedService);
    if (!resolved) {
      setSelectedModel(null);
      setSelectedService(null);
      return;
    }
    if (resolved.model !== selectedModel || resolved.service !== selectedService) {
      setSelectedModel(resolved.model);
      setSelectedService(resolved.service);
    }
  }, [groupedModels, selectedModel, selectedService]);

  const runtimeModelPayload = selectedService && selectedModel
    ? { service: selectedService, model: selectedModel }
    : undefined;
  const instructionLanguage = data?.book.language === "en" ? "en" : "zh";
  const resolveReviseInstruction = (
    chapterNum: number,
    mode: ReviseMode,
    brief?: string,
  ): string => {
    if (mode === "rewrite") {
      return resolveBookAgentInstruction("rewrite", {
        chapterNumber: chapterNum,
        brief,
        language: instructionLanguage,
      });
    }
    const lang = instructionLanguage;
    const suffix = brief?.trim() ? ` ${brief.trim()}` : "";
    if (lang === "en") {
      if (mode === "polish") return `polish chapter ${chapterNum}${suffix}`;
      if (mode === "rework") return `revise chapter ${chapterNum} rework${suffix}`;
      if (mode === "anti-detect") return `anti-detect chapter ${chapterNum}${suffix}`;
      return `revise chapter ${chapterNum}${suffix}`;
    }
    if (mode === "polish") return `润色第${chapterNum}章${suffix}`;
    if (mode === "rework") return `修订第${chapterNum}章 rework${suffix}`;
    if (mode === "anti-detect") return `修订第${chapterNum}章 anti-detect${suffix}`;
    return `修订第${chapterNum}章${suffix}`;
  };

  const ensureAgentSessionId = async (): Promise<string> => {
    const existing = readBookDetailSessionId(bookId);
    if (existing) return existing;
    const created = await fetchJson<{ session?: { sessionId?: string } }>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId }),
    });
    const sessionId = created.session?.sessionId?.trim();
    if (!sessionId) throw new Error("无法创建会话");
    writeBookDetailSessionId(bookId, sessionId);
    return sessionId;
  };

  const dispatchAgentInstruction = async (instruction: string): Promise<void> => {
    const send = async (sessionId: string, runId: string): Promise<void> => {
      setActiveAgentRun({ sessionId, runId });
      await fetchJson<{ response?: string; runId?: string }>("/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          activeBookId: bookId,
          sessionId,
          runId,
          ...(runtimeModelPayload ?? {}),
        }),
      });
    };

    let sessionId = await ensureAgentSessionId();
    let runId = createBookDetailRunId();
    try {
      await send(sessionId, runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/SESSION_NOT_FOUND|Session not found/i.test(message)) {
        writeBookDetailSessionId(bookId, "");
        sessionId = await ensureAgentSessionId();
        runId = createBookDetailRunId();
        await send(sessionId, runId);
        return;
      }
      setActiveAgentRun((current) =>
        current && current.sessionId === sessionId && current.runId === runId
          ? null
          : current,
      );
      throw error;
    }
  };
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const activityErrorText = useMemo(
    () => (activity.lastError ? withErrorGuidance(activity.lastError) : null),
    [activity.lastError],
  );
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;
  const realtimeAgentLines = useMemo(() => {
    if (!activeAgentRun) return [] as string[];
    const lines: string[] = [];
    for (const message of sse.messages) {
      const payload = message.data as {
        sessionId?: string;
        runId?: string;
        message?: string;
        partialResult?: unknown;
        text?: string;
        previewType?: "chapter" | "patch";
        mode?: string;
        status?: string;
        elapsedMs?: number;
      } | null;
      if (!payload || payload.sessionId !== activeAgentRun.sessionId) continue;
      if (typeof payload.runId === "string" && payload.runId !== activeAgentRun.runId) continue;

      if (message.event === "log" && typeof payload.message === "string" && payload.message.trim()) {
        if (!isHeartbeatLogLine(payload.message)) {
          lines.push(payload.message.trim());
        }
      } else if (message.event === "thinking:start") {
        lines.push("思考过程（流式）开始");
      } else if (message.event === "thinking:delta" && typeof payload.text === "string" && payload.text.trim()) {
        lines.push(`思考中：${payload.text.trim()}`);
      } else if (message.event === "thinking:end") {
        lines.push("思考过程（流式）结束");
      } else if (message.event === "draft:delta" && typeof payload.text === "string" && payload.text.trim()) {
        lines.push(`回复：${payload.text.trim()}`);
      } else if (message.event === "tool:update") {
        const text = extractToolUpdateText(payload.partialResult);
        if (text) lines.push(text);
      } else if (message.event === "chapter:delta" && typeof payload.text === "string" && payload.text.trim()) {
        const normalizedMode = typeof payload.mode === "string" ? payload.mode.trim().toLowerCase() : "";
        const label = payload.previewType === "patch"
          ? "修订补丁片段"
          : normalizedMode === "rewrite"
            ? "重写正文片段"
            : "正文片段";
        lines.push(`${label}：${payload.text.trim()}`);
      } else if (message.event === "llm:progress") {
        const status = typeof payload.status === "string" ? payload.status : "running";
        lines.push(`进度：${status}`);
      } else if (message.event === "persist:check") {
        const p = payload as {
          status?: string;
          persisted?: boolean;
          addedChapterNumbers?: unknown;
          missingChapterFiles?: unknown;
        };
        if (p.status === "started") {
          lines.push("落盘校验：开始");
        } else {
          const added = Array.isArray(p.addedChapterNumbers) ? p.addedChapterNumbers.length : 0;
          const missing = Array.isArray(p.missingChapterFiles) ? p.missingChapterFiles.length : 0;
          lines.push(`落盘校验：${p.persisted ? "通过" : "失败"} · 新增索引 ${added} · 缺失正文 ${missing}`);
        }
      } else if (message.event === "persist:repair") {
        const p = payload as { status?: string; repairedChapterNumbers?: unknown; reason?: string };
        const repaired = Array.isArray(p.repairedChapterNumbers) ? p.repairedChapterNumbers.join(",") : "";
        lines.push(
          `索引修复：${p.status ?? "unknown"}`
          + `${repaired ? ` · 章节 ${repaired}` : ""}`
          + `${typeof p.reason === "string" && p.reason.trim() ? ` · ${p.reason.trim()}` : ""}`,
        );
      } else if (message.event === "agent:error" || message.event === "write:error" || message.event === "rewrite:error") {
        const errorText = typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : "Unknown error";
        lines.push(`执行失败：${withErrorGuidance(errorText).replace(/\s*\n\s*/g, " ")}`);
      }
    }
    return lines.slice(-40);
  }, [activeAgentRun, sse.messages]);

  const realtimeBatchProgress = useMemo(() => {
    if (!activeAgentRun) return [] as RealtimeBatchProgress[];
    const latest = new Map<string, RealtimeBatchProgress>();
    for (const message of sse.messages) {
      if (message.event !== "batch:progress") continue;
      const payload = message.data as {
        sessionId?: string;
        runId?: string;
        batchId?: string;
        status?: "started" | "progress" | "completed" | "failed";
        total?: number;
        completed?: number;
        elapsedMs?: number;
        currentChapter?: number;
        failedChapterNumber?: number;
        error?: string;
      } | null;
      if (!payload || payload.sessionId !== activeAgentRun.sessionId) continue;
      if (typeof payload.runId === "string" && payload.runId !== activeAgentRun.runId) continue;
      const batchId = typeof payload.batchId === "string" ? payload.batchId : null;
      const total = Number(payload.total ?? 0);
      if (!batchId || !Number.isFinite(total) || total <= 0) continue;
      latest.set(batchId, {
        batchId,
        status: payload.status ?? "progress",
        total,
        completed: Math.max(0, Number(payload.completed ?? 0)),
        elapsedMs: Math.max(0, Number(payload.elapsedMs ?? 0)),
        ...(Number.isFinite(Number(payload.currentChapter))
          ? { currentChapter: Number(payload.currentChapter) }
          : {}),
        ...(Number.isFinite(Number(payload.failedChapterNumber))
          ? { failedChapterNumber: Number(payload.failedChapterNumber) }
          : {}),
        ...(typeof payload.error === "string" && payload.error.trim()
          ? { error: payload.error.trim() }
          : {}),
      });
    }
    return [...latest.values()];
  }, [activeAgentRun, sse.messages]);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;

    const data = recent.data as { bookId?: string; activeBookId?: string } | null;
    const eventBookId = data?.bookId ?? data?.activeBookId;
    if (eventBookId !== bookId) return;

    const runData = recent.data as { sessionId?: string; runId?: string } | null;
    if (recent.event === "agent:start" && typeof runData?.sessionId === "string" && typeof runData?.runId === "string") {
      setActiveAgentRun({ sessionId: runData.sessionId, runId: runData.runId });
    }
    if (
      (recent.event === "agent:complete" || recent.event === "agent:error" || recent.event === "agent:stopped")
      && typeof runData?.sessionId === "string"
      && typeof runData?.runId === "string"
    ) {
      setActiveAgentRun((current) =>
        current && current.sessionId === runData.sessionId && current.runId === runData.runId
          ? null
          : current
      );
    }

    if (recent.event === "write:start" || recent.event === "agent:start") {
      setWriteRequestPending(false);
      return;
    }

    if (recent.event === "draft:start") {
      setDraftRequestPending(false);
      return;
    }

    if (shouldRefetchBookView(recent, bookId)) {
      setWriteRequestPending(false);
      setDraftRequestPending(false);
      refetch();
    }
  }, [bookId, refetch, sse.messages]);

  const handleWriteNext = async () => {
    setWriteRequestPending(true);
    try {
      await dispatchAgentInstruction(resolveBookAgentInstruction("write-next", { language: instructionLanguage }));
    } catch (e) {
      setWriteRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleWriteBatch = async () => {
    const input = window.prompt(
      data?.book.language === "en"
        ? "How many chapters to write continuously?"
        : "请输入连续写作章节数",
      "3",
    );
    if (input === null) return;
    const count = Number(input.trim());
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      alert(data?.book.language === "en" ? "Please enter an integer between 1 and 20." : "请输入 1 到 20 的整数。");
      return;
    }

    setWriteRequestPending(true);
    try {
      const instruction = data?.book.language === "en"
        ? `write ${count} chapters continuously`
        : `连续写${count}章`;
      await dispatchAgentInstruction(instruction);
    } catch (e) {
      setWriteRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDraft = async () => {
    setDraftRequestPending(true);
    try {
      await postApi(`/books/${bookId}/draft`, runtimeModelPayload);
    } catch (e) {
      setDraftRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDeleteBook = async () => {
    setConfirmDeleteOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/books/${bookId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `${res.status}`);
      }
      nav.toDashboard();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const handleRewrite = async (chapterNum: number) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional rewrite brief for this run only. Leave blank to use existing focus."
        : "可选：输入这次重写要遵循的补充想法。留空则沿用现有 focus。",
      "",
    );
    if (brief === null) return;
    setRewritingChapters((prev) => [...prev, chapterNum]);
    try {
      await dispatchAgentInstruction(resolveBookAgentInstruction("rewrite", {
        chapterNumber: chapterNum,
        brief,
        language: instructionLanguage,
      }));
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rewrite failed");
    } finally {
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleRevise = async (chapterNum: number, mode: ReviseMode) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional revise brief for this run only. Leave blank to use existing focus."
        : "可选：输入这次修订要遵循的补充想法。留空则沿用现有 focus。",
      "",
    );
    if (brief === null) return;
    setRevisingChapters((prev) => [...prev, chapterNum]);
    try {
      await dispatchAgentInstruction(resolveReviseInstruction(chapterNum, mode, brief));
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Revision failed");
    } finally {
      setRevisingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSync = async (chapterNum: number) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional sync brief for interpreting the edited chapter body. Leave blank to sync directly from the text."
        : "可选：输入这次同步时要遵循的补充说明。留空则直接按正文同步。",
      "",
    );
    if (brief === null) return;
    setSyncingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/resync/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSaveSettings = async () => {
    if (!data) return;
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (settingsWordCount !== null) body.chapterWordCount = settingsWordCount;
      if (settingsTargetChapters !== null) body.targetChapters = settingsTargetChapters;
      if (settingsStatus !== null) body.status = settingsStatus;
      await fetchJson(`/books/${bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleApproveAll = async () => {
    if (!data) return;
    const reviewable = data.chapters.filter((ch) => ch.status === "ready-for-review");
    let failed = 0;
    for (const chapter of reviewable) {
      try {
        await postApi(`/books/${bookId}/chapters/${chapter.number}/approve`);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      alert(`${failed}/${reviewable.length} approve(s) failed`);
    }
    refetch();
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;

  const currentWordCount = settingsWordCount ?? book.chapterWordCount;
  const currentTargetChapters = settingsTargetChapters ?? book.targetChapters ?? 0;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);

  const exportHref = `/api/v1/books/${bookId}/export?format=${exportFormat}${exportApprovedOnly ? "&approvedOnly=true" : ""}`;
  const modelSelectValue = selectedService && selectedModel
    ? JSON.stringify([selectedService, selectedModel])
    : "";
  const modelSelectorReady = !servicesLoading && groupedModels.length > 0;

  return (
    <div className="space-y-8 fade-in">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button
          onClick={nav.toDashboard}
          className="hover:text-primary transition-colors flex items-center gap-1"
        >
          <ChevronLeft size={14} />
          {t("bread.books")}
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{book.title}</span>
      </nav>

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/40 pb-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-serif font-medium">{book.title}</h1>
            {book.language === "en" && (
              <span className="px-1.5 py-0.5 rounded border border-primary/20 text-primary text-[10px] font-bold">EN</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground font-medium">
            <span className="px-2 py-0.5 rounded bg-secondary/50 text-foreground/70 uppercase tracking-wider text-xs">{book.genre}</span>
            <div className="flex items-center gap-1.5">
              <FileText size={14} />
              <span>{chapters.length} {t("dash.chapters")}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Zap size={14} />
              <span>{totalWords.toLocaleString()} {t("book.words")}</span>
            </div>
            {book.fanficMode && (
              <span className="flex items-center gap-1 text-purple-500">
                <Sparkles size={12} />
                <span className="italic">fanfic:{book.fanficMode}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">模型</span>
            {modelSelectorReady ? (
              <select
                value={modelSelectValue}
                onChange={(e) => {
                  const raw = e.target.value;
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(raw);
                  } catch {
                    return;
                  }
                  const [service = "", model = ""] = Array.isArray(parsed) ? parsed : [];
                  if (!service || !model) return;
                  setSelectedService(service);
                  setSelectedModel(model);
                }}
                className="px-2 py-1.5 text-xs rounded-lg border border-border/50 bg-secondary/30 outline-none min-w-[220px]"
              >
                {groupedModels.map((group) => (
                  <optgroup key={group.service} label={group.label}>
                    {group.models.map((model) => (
                      <option key={`${group.service}:${model.id}`} value={JSON.stringify([group.service, model.id])}>
                        {model.name ?? model.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <span className="text-xs text-muted-foreground/60 rounded-lg border border-border/40 px-2 py-1.5">
                请先配置模型
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
          <button
            onClick={handleWriteNext}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Zap size={16} />}
            {writing ? t("dash.writing") : t("book.writeNext")}
          </button>
          <button
            onClick={handleWriteBatch}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold bg-primary/10 text-primary rounded-xl hover:bg-primary/20 transition-all border border-primary/20 disabled:opacity-50"
          >
            <Zap size={14} />
            {data?.book.language === "en" ? "Write Batch" : "连写"}
          </button>
          <button
            onClick={handleDraft}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-secondary text-foreground rounded-xl hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50"
          >
            {drafting ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <Wand2 size={16} />}
            {drafting ? t("book.drafting") : t("book.draftOnly")}
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-white transition-all border border-destructive/20 disabled:opacity-50"
          >
            {deleting ? <div className="w-4 h-4 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" /> : <Trash2 size={16} />}
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
          </div>
        </div>
      </div>

      {(writing || drafting || activityErrorText) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            activityErrorText
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-primary/20 bg-primary/[0.04] text-foreground"
          }`}
        >
          {activityErrorText ? (
            <span className="whitespace-pre-wrap">
              {t("book.pipelineFailed")}: {activityErrorText}
            </span>
          ) : writing ? (
            <span>{t("book.pipelineWriting")}</span>
          ) : (
            <span>{t("book.pipelineDrafting")}</span>
          )}
        </div>
      )}

      {activeAgentRun && (realtimeAgentLines.length > 0 || realtimeBatchProgress.length > 0) && (
        <div className="rounded-2xl border border-border/40 bg-card/60 px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
            流式过程（思考/正文）
          </div>
          {realtimeBatchProgress.length > 0 && (
            <div className="mb-2 space-y-2">
              {realtimeBatchProgress.map((batch) => (
                <div key={batch.batchId} className="rounded-lg border border-border/40 bg-background/40 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-foreground/90">
                      连写进度 {Math.min(batch.completed, batch.total)}/{batch.total}
                    </span>
                    <span className={`font-medium ${
                      batch.status === "failed"
                        ? "text-destructive"
                        : batch.status === "completed"
                          ? "text-green-600 dark:text-green-400"
                          : "text-primary"
                    }`}>
                      {batch.status === "failed" ? "失败" : batch.status === "completed" ? "已完成" : "进行中"}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-secondary/70 overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        batch.status === "failed"
                          ? "bg-destructive"
                          : batch.status === "completed"
                            ? "bg-green-600 dark:bg-green-400"
                            : "bg-primary"
                      }`}
                      style={{
                        width: `${Math.max(0, Math.min(100, (batch.completed / Math.max(1, batch.total)) * 100))}%`,
                      }}
                    />
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>耗时 {formatElapsedMs(batch.elapsedMs)}</span>
                    {typeof batch.currentChapter === "number" && <span>当前章 {batch.currentChapter}</span>}
                    {typeof batch.failedChapterNumber === "number" && <span>失败章 {batch.failedChapterNumber}</span>}
                  </div>
                  {batch.status === "failed" && batch.error && (
                    <div className="mt-1 text-[11px] text-destructive break-words">
                      {batch.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {realtimeAgentLines.length > 0 && (
            <ul className="space-y-1 max-h-48 overflow-y-auto">
              {realtimeAgentLines.map((line, index) => (
                <li key={`${activeAgentRun.runId}-${index}`} className="text-xs leading-5 text-foreground/85 break-words">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Tool Strip */}
      <div className="flex flex-wrap items-center gap-2 py-1">
          {reviewCount > 0 && (
            <button
              onClick={handleApproveAll}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-500/10 text-emerald-600 rounded-lg hover:bg-emerald-500/20 transition-all border border-emerald-500/20"
            >
              <CheckCheck size={14} />
              {t("book.approveAll")} ({reviewCount})
            </button>
          )}
          <button
            onClick={() => nav.toTruth(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <Database size={14} />
            {t("book.truthFiles")}
          </button>
          <button
            onClick={() => nav.toAnalytics(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <BarChart2 size={14} />
            {t("book.analytics")}
          </button>
          <div className="flex items-center gap-2">
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              className="px-2 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg border border-border/50 outline-none"
            >
              <option value="txt">TXT</option>
              <option value="md">MD</option>
              <option value="epub">EPUB</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={exportApprovedOnly}
                onChange={(e) => setExportApprovedOnly(e.target.checked)}
                className="rounded border-border/50"
              />
              {t("book.approvedOnly")}
            </label>
            <button
              onClick={async () => {
                try {
                  const data = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ format: exportFormat, approvedOnly: exportApprovedOnly }),
                  });
                  alert(`${t("common.exportSuccess")}\n${data.path}\n(${data.chapters} ${t("dash.chapters")})`);
                } catch (e) {
                  alert(e instanceof Error ? e.message : "Export failed");
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
            >
              <Download size={14} />
              {t("book.export")}
            </button>
          </div>
      </div>

      {/* Book Settings */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">{t("book.settings")}</h2>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.wordsPerChapter")}</label>
            <input
              type="number"
              value={currentWordCount}
              onChange={(e) => setSettingsWordCount(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.targetChapters")}</label>
            <input
              type="number"
              value={currentTargetChapters}
              onChange={(e) => setSettingsTargetChapters(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.status")}</label>
            <select
              value={currentStatus}
              onChange={(e) => setSettingsStatus(e.target.value as BookStatus)}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50"
            >
              <option value="active">{t("book.statusActive")}</option>
              <option value="paused">{t("book.statusPaused")}</option>
              <option value="outlining">{t("book.statusOutlining")}</option>
              <option value="completed">{t("book.statusCompleted")}</option>
              <option value="dropped">{t("book.statusDropped")}</option>
            </select>
          </div>
          <button
            onClick={handleSaveSettings}
            disabled={savingSettings}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            {savingSettings ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
            {savingSettings ? t("book.saving") : t("book.save")}
          </button>
        </div>
      </div>

      {/* Chapters Table */}
      <div className="paper-sheet rounded-2xl overflow-hidden border border-border/40 shadow-xl shadow-primary/5">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/30 border-b border-border/50">
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-16">#</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.manuscriptTitle")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-28">{t("book.words")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-36">{t("book.status")}</th>
                <th className="text-right px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.curate")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {chapters.map((ch, index) => {
                const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
                return (
                <tr key={ch.number} className={`group hover:bg-primary/[0.02] transition-colors fade-in ${staggerClass}`}>
                  <td className="px-6 py-4 text-muted-foreground/60 font-mono text-xs">{ch.number.toString().padStart(2, '0')}</td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => nav.toChapter(bookId, ch.number)}
                      className="font-serif text-lg font-medium hover:text-primary transition-colors text-left"
                    >
                      {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </button>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground font-medium tabular-nums text-xs">{(ch.wordCount ?? 0).toLocaleString()}</td>
                  <td className="px-6 py-4">
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight ${STATUS_CONFIG[ch.status]?.color ?? "bg-muted text-muted-foreground"}`}>
                      {STATUS_CONFIG[ch.status]?.icon}
                      {translateChapterStatus(ch.status, t)}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      {ch.status === "ready-for-review" && (
                        <>
                          <button
                            onClick={async () => {
                              try { await postApi(`/books/${bookId}/chapters/${ch.number}/approve`); refetch(); }
                              catch (e) { alert(e instanceof Error ? e.message : "Approve failed"); }
                            }}
                            className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all shadow-sm"
                            title={t("book.approve")}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={async () => {
                              try { await postApi(`/books/${bookId}/chapters/${ch.number}/reject`); refetch(); }
                              catch (e) { alert(e instanceof Error ? e.message : "Reject failed"); }
                            }}
                            className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all shadow-sm"
                            title={t("book.reject")}
                          >
                            <X size={14} />
                          </button>
                        </>
                      )}
                      <button
                        onClick={async () => {
                          try {
                            const auditResult = await fetchJson<{ passed?: boolean; issues?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                            alert(auditResult.passed ? "Audit passed" : `Audit failed: ${auditResult.issues?.length ?? 0} issues`);
                            refetch();
                          } catch (e) {
                            alert(e instanceof Error ? e.message : "Audit failed");
                          }
                        }}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
                        title={t("book.audit")}
                      >
                        <ShieldCheck size={14} />
                      </button>
                      <button
                        onClick={() => handleRewrite(ch.number)}
                        disabled={rewritingChapters.includes(ch.number)}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={t("book.rewrite")}
                      >
                        {rewritingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RotateCcw size={14} />}
                      </button>
                      <button
                        onClick={() => handleSync(ch.number)}
                        disabled={syncingChapters.includes(ch.number) || ch.number !== latestPersistedChapter}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={data?.book.language === "en" ? "Sync truth/state from edited chapter" : "根据已编辑章节同步 truth/state"}
                      >
                        {syncingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RefreshCw size={14} />}
                      </button>
                      <select
                        disabled={revisingChapters.includes(ch.number)}
                        value=""
                        onChange={(e) => {
                          const mode = e.target.value as ReviseMode;
                          if (mode) handleRevise(ch.number, mode);
                        }}
                        className="px-2 py-1.5 text-[11px] font-bold rounded-lg bg-secondary text-muted-foreground border border-border/50 outline-none hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-50 cursor-pointer"
                        title="Revise with AI"
                      >
                        <option value="" disabled>{revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}</option>
                        <option value="spot-fix">{t("book.spotFix")}</option>
                        <option value="polish">{t("book.polish")}</option>
                        <option value="rewrite">{t("book.rewrite")}</option>
                        <option value="rework">{t("book.rework")}</option>
                        <option value="anti-detect">{t("book.antiDetect")}</option>
                      </select>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {chapters.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-muted/20 flex items-center justify-center mb-4">
               <FileText size={20} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm italic font-serif text-muted-foreground">
              {t("book.noChapters")}
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.deleteBook")}
        message={t("book.confirmDelete")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDeleteBook}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
