import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Theme } from "../../hooks/use-theme";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { chatSelectors, useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { PanelRightClose, PanelRightOpen, ArrowLeft, Loader2, Pencil, Save, X, Maximize2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { ProgressSection } from "../sidebar/ProgressSection";
import { FoundationSection } from "../sidebar/FoundationSection";
import { SummarySection } from "../sidebar/SummarySection";
import { ChaptersSection } from "../sidebar/ChaptersSection";
import { CharacterSection } from "../sidebar/CharacterSection";
import { SidebarCard } from "../sidebar/SidebarCard";
import {
  parseDialogueQuotePolicyFromBookRules,
  parseOpeningThreeChaptersPolicyFromBookRules,
  upsertDialogueQuotePolicyInBookRules,
  upsertOpeningThreeChaptersPolicyInBookRules,
  type DialogueQuotePolicyMode,
} from "../../utils/book-rules-policy";
import { estimateAuditScoreFromIssueTexts, scoreBadgeClass } from "../../utils/audit-score";
import { countChapterLengthByLanguage } from "../../utils/chapter-length";
import { useTextSelection } from "../../hooks/use-text-selection";
import { useHighlightApi } from "../../hooks/use-highlight-api";
import { normalizeDialogueQuotesToDouble } from "../../utils/dialogue-quotes";
import { ChapterSelectionToolbar } from "../sidebar/ChapterSelectionToolbar";
import { ChapterRevisionSection } from "../sidebar/ChapterRevisionSection";
import { ChapterFullscreenModal } from "../sidebar/ChapterFullscreenModal";
import { ExecutionPanel } from "./ExecutionPanel";
import { ChapterPlansSection } from "../sidebar/ChapterPlansSection";
import {
  buildExecutionPanelStorageKey,
  pickLatestAssistantToolExecutions,
  readExecutionPanelCollapsedFromStorage,
} from "../../pages/chat-execution-panel";

export interface BookSidebarProps {
  readonly bookId: string;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

const FOUNDATION_LABELS: Record<string, string> = {
  "story_bible.md": "世界观设定",
  "volume_outline.md": "卷纲规划",
  "story/outline/volume_map.md": "卷纲规划",
  "book_rules.md": "叙事规则",
  "current_state.md": "状态卡",
  "pending_hooks.md": "伏笔池",
  "subplot_board.md": "支线进度",
  "emotional_arcs.md": "感情线",
  "character_matrix.md": "角色矩阵",
};

const streamdownPlugins = { cjk };
const RIGHT_PANEL_TAB_STORAGE_PREFIX = "studio.book.right-tab.";

type RightPanelTab = "chapter-design" | "execution" | "chapters" | "outline" | "settings" | "assets";

const RIGHT_PANEL_TABS: ReadonlyArray<{ id: RightPanelTab; label: string; compactLabel: string }> = [
  { id: "execution", label: "执行阶段", compactLabel: "执行" },
  { id: "chapters", label: "章节", compactLabel: "章节" },
  { id: "outline", label: "大纲", compactLabel: "大纲" },
  { id: "chapter-design", label: "分章设计", compactLabel: "设计" },
  { id: "settings", label: "设定", compactLabel: "设定" },
  { id: "assets", label: "资产版本", compactLabel: "版本" },
];

function isRightPanelTab(value: string): value is RightPanelTab {
  return RIGHT_PANEL_TABS.some((item) => item.id === value);
}

function readRightPanelTab(bookId: string): RightPanelTab {
  if (typeof window === "undefined") return "chapters";
  const raw = window.localStorage.getItem(`${RIGHT_PANEL_TAB_STORAGE_PREFIX}${bookId}`)?.trim();
  if (!raw || !isRightPanelTab(raw)) return "chapters";
  return raw;
}

function writeRightPanelTab(bookId: string, tab: RightPanelTab): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${RIGHT_PANEL_TAB_STORAGE_PREFIX}${bookId}`, tab);
}

export function resolveEventBookId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as { bookId?: unknown; activeBookId?: unknown };
  if (typeof payload.bookId === "string") return payload.bookId;
  if (typeof payload.activeBookId === "string") return payload.activeBookId;
  return null;
}

export function isSettingsConflictLog(message: string): boolean {
  return /设定冲突|world\s+conflict|character\s+conflict|规则冲突|book_rules|story_bible|character_matrix/i.test(message);
}

export function countChapterStatusBuckets(
  chapters: ReadonlyArray<{ status?: unknown }>,
): { failed: number; unpublished: number } {
  const failed = chapters.filter((chapter) => {
    const status = typeof chapter.status === "string" ? chapter.status : "";
    return status === "audit-failed" || status === "needs-revision" || status === "state-degraded";
  }).length;
  const unpublished = chapters.filter((chapter) => {
    const status = typeof chapter.status === "string" ? chapter.status : "";
    return status === "ready-for-review";
  }).length;
  return { failed, unpublished };
}

function chapterStatusLabel(status: string, t: TFunction): string {
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

function QuickFileLinks({
  title,
  files,
}: {
  readonly title: string;
  readonly files: ReadonlyArray<{ file: string; label: string }>;
}) {
  const openArtifact = useChatStore((s) => s.openArtifact);

  return (
    <SidebarCard title={title}>
      <div className="space-y-1">
        {files.map((item) => (
          <button
            key={item.file}
            onClick={() => openArtifact(item.file)}
            className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
          >
            {item.label}
          </button>
        ))}
      </div>
    </SidebarCard>
  );
}

export function resolveArtifactEndpoint(
  bookId: string,
  artifactFile: string,
  artifactSource: "truth" | "wizard",
): string {
  return artifactSource === "wizard"
    ? `/books/${bookId}/wizard-file/${encodeURIComponent(artifactFile)}`
    : `/books/${bookId}/truth/${encodeURIComponent(artifactFile)}`;
}

export function ArtifactView({ bookId, t }: { readonly bookId: string; readonly t: TFunction }) {
  const artifactSource = useChatStore((s) => s.artifactSource);
  const artifactFile = useChatStore((s) => s.artifactFile);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const artifactChapterMeta = useChatStore((s) => s.artifactChapterMeta);
  const artifactEditMode = useChatStore((s) => s.artifactEditMode);
  const closeArtifact = useChatStore((s) => s.closeArtifact);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [contentWordCount, setContentWordCount] = useState<number | null>(null);
  const [dialogueQuoteMode, setDialogueQuoteMode] = useState<DialogueQuotePolicyMode>("auto");
  const [dialogueQuoteStrict, setDialogueQuoteStrict] = useState(false);
  const [dialogueQuoteAutoNormalize, setDialogueQuoteAutoNormalize] = useState(false);
  const [openingEnabled, setOpeningEnabled] = useState(true);
  const [openingApplyInGovernedMode, setOpeningApplyInGovernedMode] = useState(true);
  const [openingStrict, setOpeningStrict] = useState(true);
  const [openingMaxCharacters, setOpeningMaxCharacters] = useState(5);
  const [selectionModeActive, setSelectionModeActive] = useState(false);
  const [editorSelectedText, setEditorSelectedText] = useState("");
  const contentContainerRef = useRef<HTMLDivElement | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { selectedText, isSelecting, selectionRect, persistedRange, clearSelection } = useTextSelection(contentContainerRef);
  useHighlightApi(persistedRange);
  const [fullscreen, setFullscreen] = useState(false);

  const isChapter = artifactChapter !== null;
  const isBookRules = !isChapter && artifactFile === "book_rules.md";
  const label = isChapter
    ? t("chapter.label").replace("{n}", String(artifactChapter))
    : artifactFile ? FOUNDATION_LABELS[artifactFile] ?? artifactFile : "";

  useEffect(() => {
    setEditing(false);
    setEditContent("");
    setContentWordCount(null);
    setSelectionModeActive(false);
    clearSelection();
    setLoading(true);
    if (isChapter) {
      fetchJson<{ content: string; wordCount?: number }>(`/books/${bookId}/chapters/${artifactChapter}`)
        .then((data) => {
          const nextContent = data.content ?? "";
          setContent(nextContent);
          setContentWordCount(
            typeof data.wordCount === "number" && Number.isFinite(data.wordCount)
              ? data.wordCount
              : countChapterLengthByLanguage(nextContent),
          );
          if (artifactEditMode) {
            setEditContent(nextContent);
            setEditing(true);
          }
        })
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    } else if (artifactFile) {
      const endpoint = resolveArtifactEndpoint(bookId, artifactFile, artifactSource);
      fetchJson<{ content: string | null }>(endpoint)
        .then((data) => {
          setContent(data.content ?? "");
          setContentWordCount(null);
        })
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    }
  }, [artifactSource, bookId, artifactFile, artifactChapter, artifactEditMode, clearSelection, isChapter, bookDataVersion]);

  useEffect(() => {
    if (!isChapter || !artifactEditMode || content === null) return;
    setEditContent(content);
    setEditing(true);
  }, [artifactEditMode, content, isChapter]);

  useEffect(() => {
    if (!isBookRules || content === null) return;
    const parsed = parseDialogueQuotePolicyFromBookRules(content);
    if (!parsed) {
      setDialogueQuoteMode("auto");
      setDialogueQuoteStrict(false);
      setDialogueQuoteAutoNormalize(false);
      return;
    }
    setDialogueQuoteMode(parsed.mode);
    setDialogueQuoteStrict(parsed.strict);
    setDialogueQuoteAutoNormalize(parsed.autoNormalize);

    const opening = parseOpeningThreeChaptersPolicyFromBookRules(content);
    if (!opening) {
      setOpeningEnabled(true);
      setOpeningApplyInGovernedMode(true);
      setOpeningStrict(true);
      setOpeningMaxCharacters(5);
      return;
    }
    setOpeningEnabled(opening.enabled);
    setOpeningApplyInGovernedMode(opening.applyInGovernedMode);
    setOpeningStrict(opening.strict);
    setOpeningMaxCharacters(opening.maxCharacters);
  }, [isBookRules, content]);

  const handleRevisionComplete = useCallback((newContent: string | null) => {
    if (newContent !== null) {
      setContent(newContent);
      setEditContent(newContent);
      setContentWordCount(countChapterLengthByLanguage(newContent));
    }
  }, []);

  const handleEdit = useCallback(() => {
    setSelectionModeActive(false);
    clearSelection();
    setEditorSelectedText("");
    setEditContent(content ?? "");
    setEditing(true);
  }, [clearSelection, content]);

  const handleToggleSelectionMode = useCallback(() => {
    setEditing(false);
    setSelectionModeActive((prev) => !prev);
    clearSelection();
    setEditorSelectedText("");
  }, [clearSelection]);

  const handleDismissSelectionMode = useCallback(() => {
    setSelectionModeActive(false);
    clearSelection();
    setEditorSelectedText("");
  }, [clearSelection]);

  const syncEditorSelection = useCallback(() => {
    const el = editorTextareaRef.current;
    if (!el) return;
    const start = Math.min(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    const end = Math.max(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    setEditorSelectedText(el.value.slice(start, end));
  }, []);

  useEffect(() => {
    if (!editing) {
      setEditorSelectedText("");
      return;
    }
    syncEditorSelection();
    const el = editorTextareaRef.current;
    if (!el) return;
    const onSelectionChange = () => {
      if (document.activeElement === el) syncEditorSelection();
    };
    el.addEventListener("select", syncEditorSelection);
    el.addEventListener("mouseup", syncEditorSelection);
    el.addEventListener("keyup", syncEditorSelection);
    el.addEventListener("touchend", syncEditorSelection);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      el.removeEventListener("select", syncEditorSelection);
      el.removeEventListener("mouseup", syncEditorSelection);
      el.removeEventListener("keyup", syncEditorSelection);
      el.removeEventListener("touchend", syncEditorSelection);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [editing, syncEditorSelection]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (isChapter) {
        const result = await fetchJson<{ wordCount?: number }>(`/books/${bookId}/chapters/${artifactChapter}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
        setContentWordCount(
          typeof result.wordCount === "number" && Number.isFinite(result.wordCount)
            ? result.wordCount
            : countChapterLengthByLanguage(editContent),
        );
      } else if (artifactFile) {
        const endpoint = resolveArtifactEndpoint(bookId, artifactFile, artifactSource);
        await fetchJson(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
        setContentWordCount(null);
      }
      setContent(editContent);
      setEditing(false);
    } catch {
      // keep editing state on error
    } finally {
      setSaving(false);
    }
  }, [artifactSource, bookId, artifactFile, artifactChapter, isChapter, editContent]);

  const handleNormalizeDialogueQuotes = useCallback(() => {
    setEditContent((current) => normalizeDialogueQuotesToDouble(current));
  }, []);

  const handleApplyDialogueQuotePolicy = useCallback(async () => {
    if (!isBookRules) return;
    const source = editing ? editContent : (content ?? "");
    const next = upsertDialogueQuotePolicyInBookRules(source, {
      mode: dialogueQuoteMode,
      strict: dialogueQuoteStrict,
      autoNormalize: dialogueQuoteAutoNormalize,
    });
    setEditContent(next);
    setSaving(true);
    try {
      if (artifactFile) {
        const endpoint = resolveArtifactEndpoint(bookId, artifactFile, artifactSource);
        await fetchJson(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: next }),
        });
      }
      setContent(next);
      if (!editing) {
        setEditing(false);
      }
    } catch {
      setEditing(true);
    } finally {
      setSaving(false);
    }
  }, [
    bookId,
    artifactFile,
    artifactSource,
    isBookRules,
    editing,
    editContent,
    content,
    dialogueQuoteMode,
    dialogueQuoteStrict,
    dialogueQuoteAutoNormalize,
  ]);

  const handleApplyOpeningThreeChaptersPolicy = useCallback(async () => {
    if (!isBookRules) return;
    const source = editing ? editContent : (content ?? "");
    const next = upsertOpeningThreeChaptersPolicyInBookRules(source, {
      enabled: openingEnabled,
      applyInGovernedMode: openingApplyInGovernedMode,
      strict: openingStrict,
      maxCharacters: openingMaxCharacters,
    });
    setEditContent(next);
    setSaving(true);
    try {
      if (artifactFile) {
        const endpoint = resolveArtifactEndpoint(bookId, artifactFile, artifactSource);
        await fetchJson(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: next }),
        });
      }
      setContent(next);
      if (!editing) {
        setEditing(false);
      }
    } catch {
      setEditing(true);
    } finally {
      setSaving(false);
    }
  }, [
    bookId,
    artifactFile,
    artifactSource,
    isBookRules,
    editing,
    editContent,
    content,
    openingEnabled,
    openingApplyInGovernedMode,
    openingStrict,
    openingMaxCharacters,
  ]);

  const handleApplyRecommendedOpeningPolicy = useCallback(async () => {
    if (!isBookRules) return;
    const recommended = {
      enabled: true,
      applyInGovernedMode: true,
      strict: true,
      maxCharacters: 5,
    };
    const source = editing ? editContent : (content ?? "");
    const next = upsertOpeningThreeChaptersPolicyInBookRules(source, recommended);
    setOpeningEnabled(recommended.enabled);
    setOpeningApplyInGovernedMode(recommended.applyInGovernedMode);
    setOpeningStrict(recommended.strict);
    setOpeningMaxCharacters(recommended.maxCharacters);
    setEditContent(next);
    setSaving(true);
    try {
      if (artifactFile) {
        const endpoint = resolveArtifactEndpoint(bookId, artifactFile, artifactSource);
        await fetchJson(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: next }),
        });
      }
      setContent(next);
      if (!editing) {
        setEditing(false);
      }
    } catch {
      setEditing(true);
    } finally {
      setSaving(false);
    }
  }, [artifactSource, bookId, artifactFile, isBookRules, editing, editContent, content]);

  const chapterStatus = artifactChapterMeta?.status ?? t("sidebar.chapter.statusUnknown");
  const chapterIssues = artifactChapterMeta?.auditIssues ?? [];
  const chapterScoreRaw = Number(artifactChapterMeta?.audit?.score);
  const chapterScore = Number.isFinite(chapterScoreRaw)
    ? Math.max(0, Math.min(100, Math.trunc(chapterScoreRaw)))
    : estimateAuditScoreFromIssueTexts(chapterIssues);
  const showChapterScore = chapterStatus === "audit-failed"
    || chapterStatus === "ready-for-review"
    || Number.isFinite(chapterScoreRaw);
  const displayedWords = editing
    ? countChapterLengthByLanguage(editContent)
    : typeof contentWordCount === "number"
      ? contentWordCount
      : content !== null
        ? countChapterLengthByLanguage(content)
        : (artifactChapterMeta?.wordCount ?? 0);

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/20 shrink-0">
        <button
          onClick={closeArtifact}
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-sm font-medium truncate flex-1">{label}</span>
        {isChapter && (
          <div className="flex items-center gap-1.5 mr-1">
            <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-muted/50 text-muted-foreground">
              {chapterStatusLabel(chapterStatus, t)}
            </span>
            {showChapterScore && (
              <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${scoreBadgeClass(chapterScore)}`}>
                评分 {chapterScore}
              </span>
            )}
            <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-muted/50 text-muted-foreground tabular-nums">
              {displayedWords.toLocaleString()} {t("book.words")}
            </span>
          </div>
        )}
        {!loading && content !== null && !editing && (
          <button
            onClick={handleEdit}
            className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          >
            <Pencil size={12} />
          </button>
        )}
        {!loading && content !== null && (
          <button
            onClick={() => setFullscreen(true)}
            className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            title="全屏预览"
          >
            <Maximize2 size={12} />
          </button>
        )}
        {editing && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleNormalizeDialogueQuotes}
              className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
              title="将「」统一替换为双引号"
            >
              <span className="text-[10px] font-bold leading-none">引</span>
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-6 h-6 rounded-md flex items-center justify-center text-emerald-500 hover:bg-emerald-500/10 transition-colors"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {isBookRules && !loading && content !== null && (
          <div className="px-4 py-3 border-b border-border/20 bg-secondary/20">
            <div className="text-xs font-medium text-foreground mb-2">对话引号策略</div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground block">
                模式
              </label>
              <select
                value={dialogueQuoteMode}
                onChange={(e) => setDialogueQuoteMode(e.target.value as DialogueQuotePolicyMode)}
                className="w-full h-8 rounded-md border border-border/40 bg-background px-2 text-xs outline-none"
              >
                <option value="auto">自动跟随历史</option>
                <option value="force_double">强制中文双引号“……”</option>
                <option value="force_corner">强制日式引号「……」</option>
                <option value="force_none">强制无引号体（说话人：内容）</option>
              </select>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={dialogueQuoteStrict}
                  onChange={(e) => setDialogueQuoteStrict(e.target.checked)}
                  className="rounded border-border/40"
                />
                严格模式（无引号对白也算违规）
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={dialogueQuoteAutoNormalize}
                  onChange={(e) => setDialogueQuoteAutoNormalize(e.target.checked)}
                  className="rounded border-border/40"
                />
                自动规范化（写作后统一引号）
              </label>
              <button
                onClick={handleApplyDialogueQuotePolicy}
                disabled={saving}
                className="h-8 px-2 rounded-md border border-border/40 text-xs text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-50"
              >
                应用并保存到 book_rules.md
              </button>
            </div>
            <div className="mt-4 pt-3 border-t border-border/20">
              <div className="text-xs font-medium text-foreground mb-2">开篇前三章策略</div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={openingEnabled}
                    onChange={(e) => setOpeningEnabled(e.target.checked)}
                    className="rounded border-border/40"
                  />
                  启用前三章开篇规则
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={openingApplyInGovernedMode}
                    onChange={(e) => setOpeningApplyInGovernedMode(e.target.checked)}
                    className="rounded border-border/40"
                  />
                  在 governed 模式生效
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={openingStrict}
                    onChange={(e) => setOpeningStrict(e.target.checked)}
                    className="rounded border-border/40"
                  />
                  严格模式（优先修开篇硬伤）
                </label>
                <label className="text-xs text-muted-foreground block">
                  前三章人物上限（3-8）
                </label>
                <input
                  type="number"
                  min={3}
                  max={8}
                  value={openingMaxCharacters}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    if (!Number.isFinite(parsed)) return;
                    setOpeningMaxCharacters(Math.min(8, Math.max(3, parsed)));
                  }}
                  className="w-full h-8 rounded-md border border-border/40 bg-background px-2 text-xs outline-none"
                />
                <button
                  onClick={handleApplyOpeningThreeChaptersPolicy}
                  disabled={saving}
                  className="h-8 px-2 rounded-md border border-border/40 text-xs text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-50"
                >
                  应用并保存到 book_rules.md
                </button>
                <button
                  onClick={handleApplyRecommendedOpeningPolicy}
                  disabled={saving}
                  className="h-8 px-2 rounded-md border border-emerald-500/30 text-xs text-emerald-600 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                >
                  一键推荐配置并保存
                </button>
              </div>
            </div>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="text-muted-foreground animate-spin" />
          </div>
        ) : content === null ? (
          <p className="text-xs text-muted-foreground/50 italic px-4 py-3">{t("sidebar.fileNotFound")}</p>
        ) : editing ? (
          <div className="flex h-full min-h-0 flex-col px-4 py-3">
            <div className="shrink-0 pb-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/75">
                  章节正文
                </span>
                <span className="text-[10px] text-muted-foreground/60">编辑中</span>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <textarea
                ref={editorTextareaRef}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onSelect={syncEditorSelection}
                onMouseUp={syncEditorSelection}
                onKeyUp={syncEditorSelection}
                onBlur={syncEditorSelection}
                className="w-full min-h-[56vh] resize-y border-0 bg-transparent px-0 py-0 font-mono text-sm leading-7 outline-none"
              />
            </div>
            {isChapter && content !== null && !loading && (
              <div className="shrink-0">
                <ChapterRevisionSection
                  bookId={bookId}
                  chapterNumber={artifactChapter!}
                  selectedText={editorSelectedText}
                  selectionModeActive={selectionModeActive || editorSelectedText.trim().length > 0}
                  onToggleSelectionMode={handleToggleSelectionMode}
                  onRevisionComplete={handleRevisionComplete}
                />
              </div>
            )}
          </div>
        ) : isChapter ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border/20 bg-card/35 px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/75">
                  章节正文
                </span>
                <span className="text-[10px] text-muted-foreground/60">阅读区</span>
              </div>
            </div>
            <div ref={contentContainerRef} className="flex-1 overflow-y-auto px-4 py-4 text-sm leading-7">
              <div className="mx-auto w-full max-w-none">
                <Streamdown className="w-full min-w-0 max-w-none break-words [&_*]:min-w-0" plugins={streamdownPlugins} mode="static">{content}</Streamdown>
              </div>
            </div>
          </div>
        ) : (
          <div ref={contentContainerRef} className="px-4 py-3 text-sm leading-7">
            <div className="mx-auto w-full max-w-none">
              <Streamdown className="w-full min-w-0 max-w-none break-words [&_*]:min-w-0" plugins={streamdownPlugins} mode="static">{content}</Streamdown>
            </div>
          </div>
        )}
      </div>
      {fullscreen && content !== null && (
        <ChapterFullscreenModal
          bookId={bookId}
          chapterNumber={artifactChapter}
          title={label}
          content={content}
          editContent={editContent}
          editing={editing}
          loading={loading}
          onClose={() => setFullscreen(false)}
        />
      )}
      {isChapter && (((editing && (selectionModeActive || editorSelectedText.trim().length > 0))) || (!editing && (selectionModeActive || (isSelecting && selectedText)))) && (
        <ChapterSelectionToolbar
          bookId={bookId}
          chapterNumber={artifactChapter!}
          selectedText={editing ? editorSelectedText : selectedText}
          selectionRect={editing ? null : selectionRect}
          selectionModeActive={editing ? (selectionModeActive || editorSelectedText.trim().length > 0) : selectionModeActive}
          onDismiss={handleDismissSelectionMode}
        />
      )}
    </div>
  );
}

function PanelView({ bookId, theme: _theme, t, sse }: BookSidebarProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>(() => readRightPanelTab(bookId));
  // Show writing indicator only during pipeline operations (write/audit/revise)
  const [activeOp, setActiveOp] = useState<string | null>(null);
  const [chapterFilter, setChapterFilter] = useState<"all" | "pending-review" | "failed">("all");
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const panelExecutions = useMemo(
    () => pickLatestAssistantToolExecutions(messages),
    [messages],
  );
  const executionPanelStorageKey = useMemo(
    () => buildExecutionPanelStorageKey(activeSessionId),
    [activeSessionId],
  );
  const [executionPanelCollapsed, setExecutionPanelCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return readExecutionPanelCollapsedFromStorage(
      (key) => window.localStorage.getItem(key),
      buildExecutionPanelStorageKey(null),
      true,
    );
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    setExecutionPanelCollapsed(
      readExecutionPanelCollapsedFromStorage(
        (key) => window.localStorage.getItem(key),
        executionPanelStorageKey,
        true,
      ),
    );
  }, [executionPanelStorageKey]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(executionPanelStorageKey, executionPanelCollapsed ? "1" : "0");
  }, [executionPanelCollapsed, executionPanelStorageKey]);
  const [failedChapterCount, setFailedChapterCount] = useState(0);
  const [unpublishedChapterCount, setUnpublishedChapterCount] = useState(0);

  useEffect(() => {
    setActiveTab(readRightPanelTab(bookId));
  }, [bookId]);

  useEffect(() => {
    writeRightPanelTab(bookId, activeTab);
  }, [bookId, activeTab]);

  const refreshChapterStats = useCallback(() => {
    void fetchJson<{ chapters?: ReadonlyArray<{ status?: unknown }> }>(`/books/${bookId}`)
      .then((data) => {
        const chapters = Array.isArray(data.chapters) ? data.chapters : [];
        const buckets = countChapterStatusBuckets(chapters);
        setFailedChapterCount(buckets.failed);
        setUnpublishedChapterCount(buckets.unpublished);
      })
      .catch(() => {
        setFailedChapterCount(0);
        setUnpublishedChapterCount(0);
      });
  }, [bookId]);

  useEffect(() => {
    refreshChapterStats();
  }, [refreshChapterStats, bookDataVersion]);

  useEffect(() => {
    const latest = sse.messages;
    if (latest.length === 0) return;
    const last = latest[latest.length - 1];
    const eventBookId = resolveEventBookId(last.data);
    if (eventBookId && eventBookId !== bookId) return;

    if (last.event === "write:start") setActiveOp("write");
    else if (last.event === "tool:start") {
      const data = last.data as { tool?: string; args?: { agent?: string } } | null;
      if (data?.tool === "sub_agent") {
        const agent = data.args?.agent;
        if (agent === "writer") setActiveOp("write");
        else if (agent === "auditor") setActiveOp("audit");
        else if (agent === "reviser") setActiveOp("revise");
      }
    } else if (
      last.event === "write:complete"
      || last.event === "tool:end"
      || last.event === "agent:complete"
      || last.event === "agent:error"
      || last.event === "agent:stopped"
    ) {
      setActiveOp(null);
    }

    if (
      last.event === "audit:complete"
      || last.event === "audit:error"
      || last.event === "revise:complete"
      || last.event === "revise:error"
      || last.event === "rewrite:complete"
      || last.event === "rewrite:error"
    ) {
      setActiveTab("chapters");
      setChapterFilter("failed");
      refreshChapterStats();
      return;
    }

    if (last.event === "log") {
      const payload = last.data as { message?: unknown } | null;
      if (typeof payload?.message === "string" && isSettingsConflictLog(payload.message)) {
        setActiveTab("settings");
      }
    }
  }, [sse.messages]);

  const OP_LABELS: Record<string, string> = {
    write: t("sidebar.op.write"),
    audit: t("sidebar.op.audit"),
    revise: t("sidebar.op.revise"),
  };

  const tabBadge = useCallback((tab: RightPanelTab): React.ReactNode => {
    if (tab === "chapters" && activeOp) {
      return <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />;
    }
    if (tab === "chapters" && failedChapterCount > 0) {
      return (
        <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
          {Math.min(failedChapterCount, 99)}
        </span>
      );
    }
    if (tab === "assets" && unpublishedChapterCount > 0) {
      return (
        <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-400">
          {Math.min(unpublishedChapterCount, 99)}
        </span>
      );
    }
    return null;
  }, [activeOp, failedChapterCount, unpublishedChapterCount]);

  const renderTabPanel = () => {
    if (activeTab === "chapter-design") {
      return <p className="text-xs text-muted-foreground px-1">??</p>;
    }
    if (activeTab === "execution") {
      return panelExecutions.length > 0 ? (
        <ExecutionPanel
          executions={panelExecutions}
          collapsed={executionPanelCollapsed}
          onCollapsedChange={setExecutionPanelCollapsed}
        />
      ) : (
        <p className="text-xs text-muted-foreground px-1">暂无执行记录</p>
      );
    }
    if (activeTab === "chapters") {
      return (
        <>
          <ProgressSection sse={sse} />
          <SidebarCard title="筛选">
            <div className="flex items-center gap-1">
              {[
                { key: "all", label: "全部" },
                { key: "pending-review", label: "待审" },
                { key: "failed", label: "未通过" },
              ].map((item) => {
                const active = chapterFilter === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setChapterFilter(item.key as "all" | "pending-review" | "failed")}
                    className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                      active
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </SidebarCard>
          <ChaptersSection
            bookId={bookId}
            t={t}
            sse={sse}
            filter={chapterFilter}
            className="flex min-h-0 flex-1 flex-col"
            listClassName="h-full min-h-0"
          />
        </>
      );
    }
    if (activeTab === "outline") {
      return (
        <>
          <QuickFileLinks
            title="大纲导航"
            files={[
              { file: "story/outline/volume_map.md", label: "卷纲规划" },
              { file: "pending_hooks.md", label: "伏笔池" },
              { file: "subplot_board.md", label: "支线进度" },
              { file: "current_state.md", label: "状态卡" },
            ]}
          />
        </>
      );
    }
    if (activeTab === "settings") {
      return (
        <>
          <QuickFileLinks
            title="设定文件"
            files={[
              { file: "story_bible.md", label: "世界观设定" },
              { file: "character_matrix.md", label: "角色矩阵" },
              { file: "book_rules.md", label: "叙事规则" },
              { file: "emotional_arcs.md", label: "感情线" },
            ]}
          />
          <SummarySection bookId={bookId} />
          <CharacterSection bookId={bookId} />
        </>
      );
    }
    return (
      <>
        <FoundationSection bookId={bookId} />
        <SidebarCard title="版本与导出">
          <p className="text-xs text-muted-foreground">
            资产页聚焦版本与导出，并提供核心文件入口。
          </p>
          <div className="mt-2 space-y-1">
            <button
              type="button"
              onClick={() => useChatStore.getState().openArtifact("current_state.md")}
              className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            >
              查看当前状态快照
            </button>
            <button
              type="button"
              onClick={() => useChatStore.getState().openArtifact("book_rules.md")}
              className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            >
              查看发布前规则
            </button>
          </div>
        </SidebarCard>
      </>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/20 px-2 pb-2 pt-2 sm:px-3 sm:pt-3">
        <div className="flex items-center gap-1 overflow-x-auto">
          {RIGHT_PANEL_TABS.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                  active
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                }`}
              >
                <span className="sm:hidden">{tab.compactLabel}</span>
                <span className="hidden sm:inline">{tab.label}</span>
                {tabBadge(tab.id)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex h-full min-h-0 flex-col gap-2 p-3">
          {activeOp && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/10 bg-primary/5 px-3 py-2">
              <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
              <span className="text-xs font-medium text-primary">
                {OP_LABELS[activeOp] ?? activeOp}
              </span>
            </div>
          )}
          {renderTabPanel()}
        </div>
      </div>
    </div>
  );
}

const SIDEBAR_RATIO = 0.4;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 700;

function defaultSidebarWidth(): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * SIDEBAR_RATIO)));
}

export function BookSidebar({ bookId, theme, t, sse }: BookSidebarProps) {
  const sidebarView = useChatStore((s) => s.sidebarView);
  const [width, setWidth] = useState(defaultSidebarWidth);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX;
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width]);

  return (
    <aside
      className="hidden lg:flex shrink-0 flex-col border-l border-border/30 backdrop-blur-md overflow-y-auto relative shadow-[0_0_30px_rgba(0,0,0,0.08)]"
      style={{
        width,
        background: "linear-gradient(180deg, color-mix(in oklch, var(--background) 82%, var(--card) 18%) 0%, color-mix(in oklch, var(--background) 72%, black 28%) 100%)",
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onMouseDown}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors z-10"
      />
      {sidebarView === "artifact" ? (
        <ArtifactView bookId={bookId} t={t} />
      ) : (
        <PanelView bookId={bookId} theme={theme} t={t} sse={sse} />
      )}
    </aside>
  );
}

export function BookSidebarToggle({ bookId, theme, t, sse }: BookSidebarProps) {
  const [open, setOpen] = useState(false);
  const sidebarView = useChatStore((s) => s.sidebarView);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed right-3 top-[72px] z-20 lg:hidden w-8 h-8 rounded-lg bg-card border border-border/40 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
      >
        <PanelRightOpen size={14} />
      </button>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
          <aside
            className="absolute right-0 top-0 h-full w-[480px] max-w-[85vw] border-l border-border/30 overflow-y-auto overflow-x-hidden shadow-2xl"
            style={{
              background: "linear-gradient(180deg, color-mix(in oklch, var(--background) 88%, var(--card) 12%) 0%, color-mix(in oklch, var(--background) 76%, black 24%) 100%)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/20">
              <span className="text-xs font-medium text-muted-foreground">{t("sidebar.bookInfo")}</span>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <PanelRightClose size={14} />
              </button>
            </div>
            {sidebarView === "artifact" ? (
              <ArtifactView bookId={bookId} t={t} />
            ) : (
              <PanelView bookId={bookId} theme={theme} t={t} sse={sse} />
            )}
          </aside>
        </div>
      )}
    </>
  );
}
