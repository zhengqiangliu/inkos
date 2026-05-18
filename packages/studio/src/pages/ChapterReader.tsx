import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useChatStore } from "../store/chat";
import { useTextSelection } from "../hooks/use-text-selection";
import { ChapterSelectionToolbar } from "../components/sidebar/ChapterSelectionToolbar";
import { ChapterRevisionSection } from "../components/sidebar/ChapterRevisionSection";
import {
  ChevronLeft,
  List,
  RotateCcw,
  BookOpen,
  CheckCircle2,
  XCircle,
  Hash,
  Type,
  Clock,
  Pencil,
  Save,
  Eye,
} from "lucide-react";
import { countChapterLengthByLanguage } from "../utils/chapter-length";
import { resolveChapterReaderSelectionState } from "./chapter-reader-state";

interface ChapterData {
  readonly chapterNumber: number;
  readonly filename: string;
  readonly content: string;
  readonly wordCount?: number;
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
}

function splitBody(content: string): { title: string; paragraphs: string[] } {
  const lines = content.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  const title = titleLine?.replace(/^#\s*/, "") ?? "";
  const body = titleLine ? lines.filter((line) => line !== titleLine).join("\n").trim() : content.trim();
  const paragraphs = body.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  return { title, paragraphs };
}

function getTextareaSelection(el: HTMLTextAreaElement | null): string {
  if (!el) return "";
  const start = Math.min(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  const end = Math.max(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  return el.value.slice(start, end);
}

function formatSelectionPreview(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}

export function ChapterReader({ bookId, chapterNumber, nav, theme: _theme, t }: {
  bookId: string;
  chapterNumber: number;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const { data, loading, error, refetch } = useApi<ChapterData>(`/books/${bookId}/chapters/${chapterNumber}`);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectionModeActive, setSelectionModeActive] = useState(false);
  const [editorSelectedText, setEditorSelectedText] = useState("");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const viewerSelection = useTextSelection(viewerRef);

  const content = editing ? editContent : data?.content ?? "";
  const { title, paragraphs } = useMemo(() => splitBody(content), [content]);
  const selectionState = resolveChapterReaderSelectionState({
    editing,
    selectionModeActive,
    editorSelectedText,
    viewerSelectedText: viewerSelection.selectedText,
    viewerIsSelecting: viewerSelection.isSelecting,
  });
  const { selectedText, hasSelection, effectiveSelectionMode, showFloatingToolbar } = selectionState;
  const chapterWordCount = typeof data?.wordCount === "number" && Number.isFinite(data.wordCount)
    ? data.wordCount
    : countChapterLengthByLanguage(content);

  const clearAllSelection = useCallback(() => {
    setSelectionModeActive(false);
    setEditorSelectedText("");
    viewerSelection.clearSelection();
  }, [viewerSelection]);

  const handleStartEdit = useCallback(() => {
    if (!data) return;
    setEditContent(data.content);
    setEditing(true);
    clearAllSelection();
  }, [clearAllSelection, data]);

  const handleCancelEdit = useCallback(() => {
    setEditing(false);
    setEditContent("");
    clearAllSelection();
  }, [clearAllSelection]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      setEditing(false);
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [bookId, chapterNumber, editContent, refetch]);

  const handleApprove = useCallback(async () => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/approve`);
      nav.toBook(bookId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Approve failed");
    }
  }, [bookId, chapterNumber, nav]);

  const handleReject = useCallback(async () => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/reject`);
      nav.toBook(bookId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Reject failed");
    }
  }, [bookId, chapterNumber, nav]);

  const syncEditorSelection = useCallback(() => {
    const el = editorRef.current;
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
    const el = editorRef.current;
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

  useEffect(() => {
    if (!editing) return;
    setEditorSelectedText((current) => current);
  }, [editing]);

  const onToggleSelectionMode = useCallback(() => {
    if (editing) {
      setSelectionModeActive((prev) => !prev);
      setEditorSelectedText("");
      return;
    }
    setSelectionModeActive((prev) => !prev);
    viewerSelection.clearSelection();
  }, [editing, viewerSelection]);

  const onDismissSelectionMode = useCallback(() => {
    clearAllSelection();
  }, [clearAllSelection]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
        <span className="text-sm text-muted-foreground">{t("reader.openingManuscript")}</span>
      </div>
    );
  }

  if (error) {
    return <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-8 text-destructive">Error: {error}</div>;
  }

  if (!data) return null;

  return (
    <div className="relative isolate mx-auto flex w-full max-w-none flex-col gap-6 px-4 py-6 lg:px-8">
      <div className="sticky top-0 z-50 -mx-4 mb-6 flex flex-col justify-between gap-4 border-b border-border/30 bg-background/98 px-4 py-4 shadow-sm backdrop-blur-md md:flex-row md:items-center lg:-mx-8 lg:px-8">
        <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
          <button onClick={nav.toDashboard} className="flex items-center gap-1 transition-colors hover:text-primary">{t("bread.books")}</button>
          <span className="text-border">/</span>
          <button onClick={() => nav.toBook(bookId)} className="truncate transition-colors hover:text-primary">{bookId}</button>
          <span className="text-border">/</span>
          <span className="flex items-center gap-1 text-foreground"><Hash size={12} />{chapterNumber}</span>
        </nav>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => nav.toBook(bookId)} className="flex items-center gap-2 rounded-xl border border-border/50 bg-secondary px-4 py-2 text-xs font-bold text-muted-foreground transition-all hover:bg-secondary/80 hover:text-foreground">
            <List size={14} />
            {t("reader.backToList")}
          </button>
          {editing ? (
            <>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">
                <Save size={14} />
                {saving ? t("book.saving") : t("book.save")}
              </button>
              <button onClick={handleCancelEdit} className="flex items-center gap-2 rounded-xl border border-border/50 bg-secondary px-4 py-2 text-xs font-bold text-muted-foreground transition-all hover:text-foreground">
                <Eye size={14} />
                {t("reader.preview")}
              </button>
            </>
          ) : (
            <button onClick={handleStartEdit} className="flex items-center gap-2 rounded-xl border border-border/50 bg-secondary px-4 py-2 text-xs font-bold text-muted-foreground transition-all hover:bg-primary/10 hover:text-primary">
              <Pencil size={14} />
              {t("reader.edit")}
            </button>
          )}
          <button onClick={handleApprove} className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs font-bold text-emerald-600">
            <CheckCircle2 size={14} />
            {t("reader.approve")}
          </button>
          <button onClick={handleReject} className="flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-2 text-xs font-bold text-destructive">
            <XCircle size={14} />
            {t("reader.reject")}
          </button>
        </div>
      </div>

      <div className="w-full">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/20 pb-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted-foreground/70">
              <BookOpen size={14} />
              章节正文
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title || `Chapter ${chapterNumber}`}</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary/70 px-3 py-1.5"><Type size={14} />{chapterWordCount.toLocaleString()}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary/70 px-3 py-1.5"><Clock size={14} />{Math.max(1, Math.ceil(chapterWordCount / 500))}</span>
          </div>
        </div>

        <div ref={viewerRef} className="mt-5 min-w-0">
          {editing ? (
            <textarea
              ref={editorRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onSelect={syncEditorSelection}
              onMouseUp={syncEditorSelection}
              onKeyUp={syncEditorSelection}
              onBlur={syncEditorSelection}
              className="min-h-[62vh] w-full resize-y border-0 bg-transparent px-0 py-0 text-[15px] leading-8 text-foreground outline-none"
              autoFocus
            />
          ) : (
            <article className="space-y-5">
              {paragraphs.map((para, i) => (
                <p key={i} className="max-w-none whitespace-pre-wrap text-[16px] leading-8 text-foreground/90">{para}</p>
              ))}
            </article>
          )}
        </div>
      </div>

      <div className="sticky bottom-4 z-30 rounded-2xl border border-border/30 bg-card/95 shadow-xl shadow-black/10 backdrop-blur-md">
        <ChapterRevisionSection
          bookId={bookId}
          chapterNumber={chapterNumber}
          selectedText={selectedText}
          selectionModeActive={effectiveSelectionMode}
          onToggleSelectionMode={onToggleSelectionMode}
          onRevisionComplete={(newContent) => {
            if (newContent !== null) {
              setEditContent(newContent);
            }
          }}
        />
      </div>

      <div className="flex justify-between items-center py-8">
        {chapterNumber > 1 ? (
          <button onClick={() => nav.toBook(bookId)} className="flex items-center gap-2 text-sm font-bold text-muted-foreground hover:text-primary transition-all group">
            <RotateCcw size={16} className="group-hover:-rotate-45 transition-transform" />
            {t("reader.chapterList")}
          </button>
        ) : (
          <div />
        )}
      </div>

      {showFloatingToolbar && (
        <ChapterSelectionToolbar
          bookId={bookId}
          chapterNumber={chapterNumber}
          selectedText={selectedText}
          selectionRect={editing ? null : viewerSelection.selectionRect}
          selectionModeActive={effectiveSelectionMode}
          onDismiss={onDismissSelectionMode}
        />
      )}
    </div>
  );
}
