import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { fetchJson, useApi } from "../hooks/use-api";
import { useChatStore } from "../store/chat";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ArtifactView } from "../components/chat/BookSidebar";
import { BookDetailChatDock } from "../components/chat/BookDetailChatDock";
import { dispatchWriteNextInstruction } from "../utils/write-next";
import { ChaptersSection } from "../components/sidebar/ChaptersSection";
import { ChapterAuditHistoryModal } from "../components/sidebar/ChapterAuditHistoryModal";
import { ChapterPlansSection, EditPlanModal } from "../components/sidebar/ChapterPlansSection";
import { ChapterPlanReader } from "../components/sidebar/ChapterPlanReader";
import { VersionHistoryModal } from "../components/sidebar/VersionHistoryModal";
import { ASSET_MENU_ITEMS, GUIDE_MENU_ITEMS, TRUTH_MENU_ITEMS, getArtifactLabel } from "../utils/book-artifacts";
import type { ChapterAuditReport } from "../shared/contracts";
import { resolveLatestChapterAuditReport } from "../utils/chapter-audit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ChevronLeft, ChevronDown, FileText, Zap, Sparkles, Database, BarChart2, Trash2, BookOpen } from "lucide-react";

interface Nav {
  toDashboard: () => void;
  toServices: () => void;
  toTruth: (bookId: string) => void;
  toAnalytics: (bookId: string) => void;
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
  readonly chapters: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly status: string;
    readonly wordCount: number;
    readonly auditHistory?: ReadonlyArray<ChapterAuditReport>;
  }>;
  readonly nextChapter?: number;
}

interface TruthFile {
  readonly name: string;
  readonly size: number;
  readonly preview: string;
}

interface TruthFilesResponse {
  readonly files: ReadonlyArray<TruthFile>;
}

interface ChapterPlan {
  readonly chapterNumber: number;
  readonly chapterName: string;
  readonly highlight: string;
  readonly coreConflict: string;
  readonly plotAndConflict: string;
  readonly emotionalTone: string;
  readonly endingHook: string;
  readonly status: string;
  readonly source: string;
  readonly version: number;
  readonly needsReview?: boolean;
  readonly lockedFields?: ReadonlyArray<string>;
  readonly driftFlags?: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly maxNewHooks?: number;
  readonly maxRecoveryPerChapter?: number;
}

interface ChapterPlansResponse {
  readonly count: number;
  readonly plans: ReadonlyArray<ChapterPlan>;
}

type ReaderMode = "chapter" | "design" | "outline" | "truth";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditHistory?: ReadonlyArray<ChapterAuditReport>;
}

interface BookDetailProps {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; stateMessages: ReadonlyArray<SSEMessage>; connected: boolean };
}

const DETAIL_LEFT_WIDTH_KEY = "studio.book-detail.left-width";
const DETAIL_RIGHT_WIDTH_KEY = "studio.book-detail.right-width";
const DETAIL_LEFT_MIN = 280;
const DETAIL_LEFT_MAX = 640;
const DETAIL_RIGHT_MIN = 360;
const DETAIL_RIGHT_MAX = 1020;
const DETAIL_LEFT_DEFAULT = 360;
const DETAIL_RIGHT_DEFAULT = 750;
const DETAIL_MIDDLE_MIN = 320;
const DETAIL_HANDLE_WIDTH = 8;

function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(raw)) return fallback;
  return Math.round(raw);
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeDetailWidths(left: number, right: number, viewportWidth: number): { left: number; right: number } {
  let nextLeft = clampWidth(left, DETAIL_LEFT_MIN, DETAIL_LEFT_MAX);
  let nextRight = clampWidth(right, DETAIL_RIGHT_MIN, DETAIL_RIGHT_MAX);
  const maxSides = Math.max(DETAIL_LEFT_MIN + DETAIL_RIGHT_MIN, viewportWidth - DETAIL_MIDDLE_MIN - DETAIL_HANDLE_WIDTH * 2);
  const total = nextLeft + nextRight;
  if (total > maxSides) {
    const overflow = total - maxSides;
    const rightRoom = nextRight - DETAIL_RIGHT_MIN;
    const shrinkRight = Math.min(overflow, rightRoom);
    nextRight -= shrinkRight;
    const remaining = overflow - shrinkRight;
    if (remaining > 0) nextLeft = Math.max(DETAIL_LEFT_MIN, nextLeft - remaining);
  }
  return { left: nextLeft, right: nextRight };
}

export function shouldAutoOpenFirstChapter(
  chapters: ReadonlyArray<Pick<ChapterMeta, "number" | "title" | "status" | "wordCount">>,
  activeChapter: number | null,
): boolean {
  return activeChapter === null && chapters.length > 0;
}

function renderMenuEntry(item: { title: string; subtitle: string; source: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start">
      <span className="truncate text-left">{item.title}</span>
      <span className="text-[10px] text-muted-foreground">{item.subtitle} / {item.source}</span>
    </div>
  );
}

function renderMenuEmpty(label: string, subtitle: string) {
  return (
    <div className="flex min-w-0 flex-col items-start">
      <span className="truncate text-left">{label}</span>
      <span className="text-[10px] text-muted-foreground">{subtitle}</span>
    </div>
  );
}

export function BookDetail({ bookId, nav, theme, t, sse }: BookDetailProps) {
  const { data, loading, error } = useApi<BookData>(`/books/${bookId}`);
  const { data: truthData } = useApi<TruthFilesResponse>(`/books/${bookId}/truth`);
  const { data: chapterPlansData, refetch: refetchChapterPlans } = useApi<ChapterPlansResponse>(`/books/${bookId}/chapter-plans`);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [readerMode, setReaderMode] = useState<ReaderMode>("chapter");
  const [selectedPlanChapter, setSelectedPlanChapter] = useState<number | null>(null);
  const [historyChapter, setHistoryChapter] = useState<number | null>(null);
  const [auditHistoryChapter, setAuditHistoryChapter] = useState<number | null>(null);
  const [planEditorChapter, setPlanEditorChapter] = useState<number | null>(null);
  const [planEditorSource, setPlanEditorSource] = useState<"manual" | "ai">("manual");
  const [chapterPlansRefreshKey, setChapterPlansRefreshKey] = useState(0);
  const openChapterArtifact = useChatStore((s) => s.openChapterArtifact);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const artifactFile = useChatStore((s) => s.artifactFile);
  const openArtifact = useChatStore((s) => s.openArtifact);
  const truthFilesToShow = truthData?.files ?? [];
  const [leftWidth, setLeftWidth] = useState(() => clampWidth(readStoredWidth(DETAIL_LEFT_WIDTH_KEY, DETAIL_LEFT_DEFAULT), DETAIL_LEFT_MIN, DETAIL_LEFT_MAX));
  const [rightWidth, setRightWidth] = useState(() => clampWidth(readStoredWidth(DETAIL_RIGHT_WIDTH_KEY, DETAIL_RIGHT_DEFAULT), DETAIL_RIGHT_MIN, DETAIL_RIGHT_MAX));
  const [draggingSide, setDraggingSide] = useState<"left" | "right" | null>(null);
  const dragStateRef = useRef<{
    type: "left" | "right";
    startX: number;
    startLeft: number;
    startRight: number;
  } | null>(null);
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);

  useEffect(() => {
    leftWidthRef.current = leftWidth;
  }, [leftWidth]);

  useEffect(() => {
    rightWidthRef.current = rightWidth;
  }, [rightWidth]);

  useEffect(() => {
    if (readerMode !== "chapter") return;
    if (!data) return;
    if (!shouldAutoOpenFirstChapter(data.chapters, artifactChapter)) return;
    const firstChapter = data.chapters[0];
    if (!firstChapter) return;
    openChapterArtifact(firstChapter.number, {
      edit: false,
      meta: {
        number: firstChapter.number,
        title: firstChapter.title,
        status: firstChapter.status,
        wordCount: firstChapter.wordCount,
        ...(Array.isArray(firstChapter.auditHistory) ? { auditHistory: firstChapter.auditHistory } : {}),
      },
    });
  }, [artifactChapter, data, openChapterArtifact, readerMode]);

  const chapterPlans = chapterPlansData?.plans ?? [];
  const selectedPlan = useMemo(() => {
    if (chapterPlans.length === 0) return null;
    if (selectedPlanChapter === null) return chapterPlans[0] ?? null;
    return chapterPlans.find((plan) => plan.chapterNumber === selectedPlanChapter) ?? chapterPlans[0] ?? null;
  }, [chapterPlans, selectedPlanChapter]);
  const historyPlan = useMemo(() => {
    if (historyChapter === null) return null;
    return chapterPlans.find((plan) => plan.chapterNumber === historyChapter) ?? null;
  }, [chapterPlans, historyChapter]);
  const planEditorPlan = useMemo(() => {
    if (planEditorChapter === null) return null;
    return chapterPlans.find((plan) => plan.chapterNumber === planEditorChapter) ?? null;
  }, [chapterPlans, planEditorChapter]);
  const handleOpenAuditHistory = useCallback((chapterNumber: number) => {
    setAuditHistoryChapter(chapterNumber);
  }, []);

  useEffect(() => {
    if (readerMode !== "design") return;
    if (chapterPlans.length === 0) return;
    if (selectedPlanChapter !== null && chapterPlans.some((plan) => plan.chapterNumber === selectedPlanChapter)) return;
    setSelectedPlanChapter(chapterPlans[0]?.chapterNumber ?? null);
  }, [chapterPlans, readerMode, selectedPlanChapter]);

  useEffect(() => {
    if (readerMode !== "design") return;
    if (selectedPlanChapter !== null) return;
    const firstPlan = chapterPlans[0];
    if (!firstPlan) return;
    setSelectedPlanChapter(firstPlan.chapterNumber);
  }, [chapterPlans, readerMode, selectedPlanChapter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DETAIL_LEFT_WIDTH_KEY, String(leftWidth));
  }, [leftWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DETAIL_RIGHT_WIDTH_KEY, String(rightWidth));
  }, [rightWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const clampToViewport = () => {
      const viewportWidth = window.innerWidth || 0;
      const next = normalizeDetailWidths(leftWidth, rightWidth, viewportWidth);
      if (next.left !== leftWidth) setLeftWidth(next.left);
      if (next.right !== rightWidth) setRightWidth(next.right);
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    if (!draggingSide) return;

    const onMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const delta = event.clientX - drag.startX;
      if (drag.type === "left") {
        const next = normalizeDetailWidths(drag.startLeft + delta, rightWidthRef.current, window.innerWidth || 0);
        setLeftWidth(next.left);
        return;
      }
      const next = normalizeDetailWidths(leftWidthRef.current, drag.startRight - delta, window.innerWidth || 0);
      setRightWidth(next.right);
    };

    const endDrag = () => {
      dragStateRef.current = null;
      setDraggingSide(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, [draggingSide]);

  const startDrag = useCallback((type: "left" | "right", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      type,
      startX: event.clientX,
      startLeft: leftWidth,
      startRight: rightWidth,
    };
    setDraggingSide(type);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, [leftWidth, rightWidth]);


  const openReaderFile = useCallback((file: string, mode: ReaderMode) => {
    setReaderMode(mode);
    if (mode === "chapter" || mode === "design") return;
    if (artifactFile !== file) openArtifact(file);
  }, [artifactFile, openArtifact]);

  const handleSelectReaderMode = useCallback((nextMode: ReaderMode) => {
    setReaderMode(nextMode);
    if (nextMode === "design") {
      setSelectedPlanChapter(chapterPlans[0]?.chapterNumber ?? null);
      return;
    }
    if (nextMode === "truth") {
      const firstTruth = truthFilesToShow[0]?.name ?? "story_bible.md";
      if (artifactFile !== firstTruth) openArtifact(firstTruth);
      return;
    }
    if (nextMode === "outline") {
      if (artifactFile !== "volume_outline.md") openArtifact("volume_outline.md");
      return;
    }
    if (data?.chapters[0]) {
      const firstChapter = data.chapters[0];
      openChapterArtifact(firstChapter.number, {
        edit: false,
        meta: {
          number: firstChapter.number,
          title: firstChapter.title,
          status: firstChapter.status,
          wordCount: firstChapter.wordCount,
          ...(Array.isArray(firstChapter.auditHistory) ? { auditHistory: firstChapter.auditHistory } : {}),
        },
      });
    }
  }, [artifactFile, chapterPlans, data, openArtifact, openChapterArtifact, truthFilesToShow]);

  const handleDeleteBook = useCallback(async () => {
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
  }, [bookId, nav]);

  const handleApprovePlan = useCallback(async () => {
    if (!selectedPlan) return;
    const chapterNumber = selectedPlan.chapterNumber;
    await fetchJson(`/books/${bookId}/chapter-plans/${chapterNumber}/approve`, {
      method: "POST",
    });
    await refetchChapterPlans();
    setChapterPlansRefreshKey((value) => value + 1);
    setPlanEditorChapter(null);
  }, [bookId, refetchChapterPlans, selectedPlan]);

  const handleSavePlan = useCallback(async (updated: Partial<ChapterPlan>, source: "manual" | "ai") => {
    if (planEditorChapter === null) return;
    const savedChapter = planEditorChapter;
    await fetchJson(`/books/${bookId}/chapter-plans/${planEditorChapter}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...updated,
        source,
        status: "planned",
        needsReview: true,
      }),
    });
    await refetchChapterPlans();
    setChapterPlansRefreshKey((value) => value + 1);
    setSelectedPlanChapter(savedChapter);
    setPlanEditorChapter(null);
  }, [bookId, planEditorChapter, refetchChapterPlans]);

  if (loading && !data) return <div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" /></div>;
  if (error && !data) return <div className="p-6 text-destructive">{error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const nextChapter = Math.max(1, Number(data.nextChapter ?? chapters.length + 1));
  const latestChapterNumber = chapters[chapters.length - 1]?.number ?? null;
  const latestChapterAuditReport = resolveLatestChapterAuditReport(chapters[chapters.length - 1] ?? null);
  const targetChapters = Math.max(1, Number(book.targetChapters ?? 1));
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const designSelected = readerMode === "design";
  const selectedPlanHasContent = selectedPlan ? chapters.some((chapter) => chapter.number === selectedPlan.chapterNumber) : false;
  const auditHistoryChapterMeta = auditHistoryChapter === null
    ? null
    : chapters.find((chapter) => chapter.number === auditHistoryChapter) ?? null;

  const handleOpenReview = () => {
    if (!selectedPlan) return;
    setPlanEditorChapter(selectedPlan.chapterNumber);
    setPlanEditorSource(selectedPlan.source === "ai" ? "ai" : "manual");
  };

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden bg-background/30">
      <aside
        className="shrink-0 border-r border-border/30 bg-card/40 backdrop-blur-md flex flex-col min-h-0 overflow-hidden"
        style={{ width: `${leftWidth}px` }}
      >
        <div className="shrink-0 border-b border-border/20 px-4 py-3">
          <button onClick={nav.toDashboard} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft size={14} />{t("bread.books")}</button>
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-serif">{book.title}</h1>
              {book.language === "en" && <span className="rounded border border-primary/20 px-1.5 py-0.5 text-[10px] text-primary">EN</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><FileText size={12} />{chapters.length}</span>
              <span className="inline-flex items-center gap-1"><BookOpen size={12} />{targetChapters}</span>
              <span className="inline-flex items-center gap-1"><Zap size={12} />{totalWords.toLocaleString()}</span>
              {book.fanficMode && <span className="inline-flex items-center gap-1"><Sparkles size={12} />{book.fanficMode}</span>}
            </div>
          </div>
        </div>
        <div className="shrink-0 border-b border-border/20 px-3 py-2">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => handleSelectReaderMode("chapter")}
              aria-pressed={readerMode === "chapter"}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                readerMode === "chapter"
                  ? "bg-primary/15 text-primary"
                  : "border border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <BookOpen size={12} />正文
            </button>
            <button
              type="button"
              onClick={() => handleSelectReaderMode("design")}
              aria-pressed={readerMode === "design"}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                readerMode === "design"
                  ? "bg-primary/15 text-primary"
                  : "border border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <BookOpen size={12} />分章设计
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          <div className={designSelected ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
            <ChaptersSection
              bookId={bookId}
              t={t}
              sse={sse}
              className="flex min-h-0 flex-1 flex-col"
              listClassName="h-full min-h-0"
              onOpenAuditHistory={handleOpenAuditHistory}
              hidePassedAuditSummary
            />
          </div>
          <div className={designSelected ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <ChapterPlansSection
                bookId={bookId}
                nextChapter={nextChapter}
                targetChapters={targetChapters}
                refreshToken={chapterPlansRefreshKey}
                onRefresh={() => setChapterPlansRefreshKey((value) => value + 1)}
                onSelectChapter={setSelectedPlanChapter}
                selectedChapter={selectedPlanChapter ?? chapterPlans[0]?.chapterNumber ?? null}
                chapterNumbers={chapters.map((chapter) => chapter.number)}
                onOpenHistory={setHistoryChapter}
              />
          </div>
        </div>
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => startDrag("left", e)}
        className={["group relative z-10 w-2 shrink-0 cursor-col-resize select-none bg-transparent touch-none", draggingSide === "left" ? "bg-primary/20" : "hover:bg-primary/10"].join(" ")}
        title="拖拽调整左侧宽度"
      >
        <div className={["absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors", draggingSide === "left" ? "bg-primary/60" : "bg-border/30 group-hover:bg-primary/40"].join(" ")} />
      </div>

      <main className="min-w-0 flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="shrink-0 border-b border-border/30 px-4 py-3 flex items-center justify-between gap-3 overflow-x-auto">
          <div className="flex min-w-0 flex-nowrap items-center gap-2 text-xs text-muted-foreground">
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground">
                <Database size={12} />资产列表 <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">核心文件</div>
                <DropdownMenuGroup>
                  {ASSET_MENU_ITEMS.map((item) => (
                    <DropdownMenuItem key={item.file} onClick={() => openReaderFile(item.file, item.mode)}>
                      {renderMenuEntry(item)}
                    </DropdownMenuItem>
                  ))}
                  {ASSET_MENU_ITEMS.length === 0 && (
                    <DropdownMenuItem onClick={() => nav.toTruth(bookId)}>
                      {renderMenuEmpty("暂无核心文件", "请先生成基础资料")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">向导资料</div>
                <DropdownMenuGroup>
                  {["story/author_intent.md", "story/current_focus.md"].map((file) => (
                    <DropdownMenuItem key={file} onClick={() => openReaderFile(file, "truth")}>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{getArtifactLabel(file).title}</span>
                        <span className="text-[10px] text-muted-foreground">{getArtifactLabel(file).subtitle} / 向导资料</span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground">
                <Database size={12} />小说真相 <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">真相文件</div>
                <DropdownMenuGroup>
                  {TRUTH_MENU_ITEMS.map((item) => {
                    const label = getArtifactLabel(item.file);
                    return (
                      <DropdownMenuItem key={item.file} onClick={() => openReaderFile(item.file, "truth")}>
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate">{label.title}</span>
                          <span className="text-[10px] text-muted-foreground">{label.subtitle}</span>
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground">
                <BookOpen size={12} />向导资料 <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">8 步向导</div>
                <DropdownMenuGroup>
                  {GUIDE_MENU_ITEMS.map((item) => (
                    <DropdownMenuItem key={`${item.file}:${item.title}`} onClick={() => openReaderFile(item.file, item.mode)}>
                      {renderMenuEntry(item)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <button onClick={() => nav.toAnalytics(bookId)} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground"><BarChart2 size={12} />分析</button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void dispatchWriteNextInstruction(bookId); }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 hover:text-primary"
              title={t("book.writeNext")}
            >
              <Zap size={12} />{t("book.writeNext")}
            </button>
            <button onClick={() => setConfirmDeleteOpen(true)} disabled={deleting} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"><Trash2 size={12} />删除</button>
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden flex">
          <section className={`min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 ${designSelected ? "overflow-y-auto" : "overflow-hidden"}`}>
            <div className="mx-auto h-full w-full max-w-none min-h-0">
              {designSelected ? (
                <ChapterPlanReader
                  plan={selectedPlan}
                  canEdit={Boolean(selectedPlan && !selectedPlanHasContent)}
                  onEditReview={selectedPlan ? handleOpenReview : undefined}
                  onApprove={selectedPlan ? handleApprovePlan : undefined}
                  onOpenHistory={selectedPlan ? () => setHistoryChapter(selectedPlan.chapterNumber) : undefined}
                />
              ) : (
                <ArtifactView bookId={bookId} t={t} />
              )}
            </div>
          </section>

          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => startDrag("right", e)}
            className={["group relative z-10 w-2 shrink-0 cursor-col-resize select-none bg-transparent touch-none", draggingSide === "right" ? "bg-primary/20" : "hover:bg-primary/10"].join(" ")}
            title="拖拽调整右侧宽度"
          >
            <div className={["absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors", draggingSide === "right" ? "bg-primary/60" : "bg-border/30 group-hover:bg-primary/40"].join(" ")} />
          </div>

          <BookDetailChatDock
            bookId={bookId}
            nav={nav}
            theme={theme}
            t={t}
            sse={sse}
            width={rightWidth}
            latestChapterNumber={latestChapterNumber}
            latestChapterAuditReport={latestChapterAuditReport}
            nextChapter={nextChapter}
            targetChapters={targetChapters}
            chapterWordCount={book.chapterWordCount}
          />
        </div>
      </main>

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

      {planEditorChapter !== null && planEditorPlan && (
        <EditPlanModal
          bookId={bookId}
          chapterNumber={planEditorChapter}
          plan={planEditorPlan}
          canEdit={!selectedPlanHasContent}
          needsReview={planEditorPlan.needsReview ?? false}
          initialSource={planEditorSource}
          onApprove={async () => {
            await handleApprovePlan();
            setPlanEditorChapter(null);
          }}
          onClose={() => setPlanEditorChapter(null)}
          onSave={handleSavePlan}
        />
      )}

      {historyChapter !== null && historyPlan && (
        <VersionHistoryModal
          bookId={bookId}
          chapterNumber={historyChapter}
          currentPlan={historyPlan}
          onClose={() => setHistoryChapter(null)}
          onRestore={async (restoredPlan) => {
            setHistoryChapter(null);
            await refetchChapterPlans();
            setChapterPlansRefreshKey((value) => value + 1);
            setSelectedPlanChapter(restoredPlan.chapterNumber);
          }}
        />
      )}

      {auditHistoryChapter !== null && auditHistoryChapterMeta && (
        <ChapterAuditHistoryModal
          chapterNumber={auditHistoryChapter}
          chapterTitle={auditHistoryChapterMeta.title}
          history={Array.isArray(auditHistoryChapterMeta.auditHistory) ? auditHistoryChapterMeta.auditHistory : []}
          onClose={() => setAuditHistoryChapter(null)}
        />
      )}
    </div>
  );
}






