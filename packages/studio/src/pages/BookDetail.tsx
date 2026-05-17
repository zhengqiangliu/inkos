import { useCallback, useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { useApi } from "../hooks/use-api";
import { useChatStore } from "../store/chat";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ArtifactView } from "../components/chat/BookSidebar";
import { BookDetailChatDock } from "../components/chat/BookDetailChatDock";
import { ChaptersSection } from "../components/sidebar/ChaptersSection";
import { ChapterPlansSection } from "../components/sidebar/ChapterPlansSection";
import { ChapterPlanReader } from "../components/sidebar/ChapterPlanReader";
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
  }>;
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

type MenuEntry = {
  readonly file: string;
  readonly label: string;
  readonly source: string;
  readonly mode: ReaderMode;
};

const FILE_LABELS: Record<string, string> = {
  "story_bible.md": "世界观设定",
  "volume_outline.md": "卷纲规划",
  "book_rules.md": "叙事规则",
  "current_state.md": "状态卡 / 世界状态",
  "pending_hooks.md": "伏笔池 / 未闭合伏笔",
  "subplot_board.md": "支线进度 / 支线进度板",
  "emotional_arcs.md": "感情线 / 情感弧线",
  "character_matrix.md": "角色矩阵 / 角色交互矩阵",
  "particle_ledger.md": "资源账本",
  "chapter_summaries.md": "各章摘要",
  "story/author_intent.md": "长期作者意图",
  "story/current_focus.md": "当前阶段关注点",
};

const ASSET_MENU_ITEMS: ReadonlyArray<MenuEntry> = [
  { file: "story_bible.md", label: "世界观设定", source: "资产列表", mode: "truth" },
  { file: "volume_outline.md", label: "卷纲规划", source: "资产列表", mode: "outline" },
  { file: "book_rules.md", label: "叙事规则", source: "资产列表", mode: "truth" },
  { file: "current_state.md", label: "状态卡", source: "资产列表", mode: "truth" },
  { file: "pending_hooks.md", label: "伏笔池", source: "资产列表", mode: "truth" },
  { file: "subplot_board.md", label: "支线进度", source: "资产列表", mode: "truth" },
  { file: "emotional_arcs.md", label: "感情线", source: "资产列表", mode: "truth" },
  { file: "character_matrix.md", label: "角色矩阵", source: "资产列表", mode: "truth" },
];

const GUIDE_MENU_ITEMS: ReadonlyArray<MenuEntry> = [
  { file: "story_bible.md", label: "简介 / 故事背景", source: "向导资料", mode: "truth" },
  { file: "story_bible.md", label: "世界观", source: "向导资料", mode: "truth" },
  { file: "volume_outline.md", label: "大纲", source: "向导资料", mode: "outline" },
  { file: "volume_outline.md", label: "卷纲规划", source: "向导资料", mode: "outline" },
  { file: "character_matrix.md", label: "主角 / 配角", source: "向导资料", mode: "truth" },
  { file: "emotional_arcs.md", label: "人物弧光", source: "向导资料", mode: "truth" },
  { file: "character_matrix.md", label: "人物关系", source: "向导资料", mode: "truth" },
  { file: "story/author_intent.md", label: "最终确认", source: "向导资料", mode: "truth" },
];

const TRUTH_MENU_ITEMS: ReadonlyArray<MenuEntry> = [
  { file: "current_state.md", label: "世界状态", source: "小说真相", mode: "truth" },
  { file: "particle_ledger.md", label: "资源账本", source: "小说真相", mode: "truth" },
  { file: "pending_hooks.md", label: "未闭合伏笔", source: "小说真相", mode: "truth" },
  { file: "chapter_summaries.md", label: "各章摘要", source: "小说真相", mode: "truth" },
  { file: "subplot_board.md", label: "支线进度板", source: "小说真相", mode: "truth" },
  { file: "emotional_arcs.md", label: "情感弧线", source: "小说真相", mode: "truth" },
  { file: "character_matrix.md", label: "角色交互矩阵", source: "小说真相", mode: "truth" },
  { file: "story/author_intent.md", label: "长期作者意图", source: "小说真相", mode: "truth" },
  { file: "story/current_focus.md", label: "当前阶段关注点", source: "小说真相", mode: "truth" },
];

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface BookDetailProps {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

export function shouldAutoOpenFirstChapter(
  chapters: ReadonlyArray<Pick<ChapterMeta, "number" | "title" | "status" | "wordCount">>,
  activeChapter: number | null,
): boolean {
  return activeChapter === null && chapters.length > 0;
}

function renderMenuEntry(item: MenuEntry) {
  return (
    <div className="flex min-w-0 flex-col items-start">
      <span className="truncate text-left">{item.label}</span>
      <span className="text-[10px] text-muted-foreground">{item.file} / {item.source}</span>
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
  const { data: chapterPlansData } = useApi<ChapterPlansResponse>(`/books/${bookId}/chapter-plans`);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [readerMode, setReaderMode] = useState<ReaderMode>("chapter");
  const [selectedPlanChapter, setSelectedPlanChapter] = useState<number | null>(null);
  const openChapterArtifact = useChatStore((s) => s.openChapterArtifact);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const artifactFile = useChatStore((s) => s.artifactFile);
  const openArtifact = useChatStore((s) => s.openArtifact);

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
      },
    });
  }, [artifactChapter, data, openChapterArtifact, readerMode]);

  const truthFiles = truthData?.files ?? [];
  const truthFilesToShow = truthFiles.length > 0 ? truthFiles : [];
  const chapterPlans = chapterPlansData?.plans ?? [];
  const selectedPlan = useMemo(() => {
    if (chapterPlans.length === 0) return null;
    if (selectedPlanChapter === null) return chapterPlans[0] ?? null;
    return chapterPlans.find((plan) => plan.chapterNumber === selectedPlanChapter) ?? chapterPlans[0] ?? null;
  }, [chapterPlans, selectedPlanChapter]);

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

  if (loading) return <div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" /></div>;
  if (error) return <div className="p-6 text-destructive">{error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const designSelected = readerMode === "design";

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden bg-background/30">
      <aside className="w-[420px] shrink-0 border-r border-border/30 bg-card/40 backdrop-blur-md flex flex-col min-h-0 overflow-hidden">
        <div className="shrink-0 border-b border-border/20 px-4 py-3">
          <button onClick={nav.toDashboard} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft size={14} />{t("bread.books")}</button>
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-serif">{book.title}</h1>
              {book.language === "en" && <span className="rounded border border-primary/20 px-1.5 py-0.5 text-[10px] text-primary">EN</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><FileText size={12} />{chapters.length}</span>
              <span className="inline-flex items-center gap-1"><Zap size={12} />{totalWords.toLocaleString()}</span>
              {book.fanficMode && <span className="inline-flex items-center gap-1"><Sparkles size={12} />{book.fanficMode}</span>}
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          {designSelected ? (
            <ChapterPlansSection
              bookId={bookId}
              onSelectChapter={setSelectedPlanChapter}
              selectedChapter={selectedPlanChapter ?? chapterPlans[0]?.chapterNumber ?? null}
            />
          ) : (
            <ChaptersSection
              bookId={bookId}
              t={t}
              sse={sse}
              className="flex min-h-0 flex-1 flex-col"
              listClassName="h-full min-h-0"
            />
          )}
        </div>
      </aside>

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
                        <span className="truncate">{FILE_LABELS[file] ?? file}</span>
                        <span className="text-[10px] text-muted-foreground">{file} / 向导资料</span>
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
                  {(truthFilesToShow.length > 0 ? truthFilesToShow : TRUTH_MENU_ITEMS.map((item) => ({ name: item.file }))).map((file) => {
                    const name = file.name;
                    const label = FILE_LABELS[name] ?? name;
                    return (
                      <DropdownMenuItem key={name} onClick={() => openReaderFile(name, "truth")}>
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate">{label}</span>
                          <span className="text-[10px] text-muted-foreground">{name}</span>
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
                    <DropdownMenuItem key={`${item.file}:${item.label}`} onClick={() => openReaderFile(item.file, item.mode)}>
                      {renderMenuEntry(item)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <button onClick={() => nav.toAnalytics(bookId)} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground"><BarChart2 size={12} />分析</button>
            <button
              onClick={() => handleSelectReaderMode(readerMode === "design" ? "chapter" : "design")}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground"
            >
              <BookOpen size={12} />{readerMode === "design" ? "正文" : "分章设计"}
            </button>
          </div>
          <button onClick={() => setConfirmDeleteOpen(true)} disabled={deleting} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"><Trash2 size={12} />删除</button>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_580px]">
            <section className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-4">
              <div className="mx-auto w-full max-w-none">
                {designSelected ? (
                  <ChapterPlanReader plan={selectedPlan} />
                ) : (
                  <ArtifactView bookId={bookId} t={t} />
                )}
              </div>
            </section>
            <BookDetailChatDock bookId={bookId} nav={nav} theme={theme} t={t} sse={sse} />
          </div>
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
    </div>
  );
}
