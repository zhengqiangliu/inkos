import { fetchJson, useApi } from "../hooks/use-api";
import { useEffect, useMemo, useState, useRef } from "react";
import { useServiceStore } from "../store/service";
import type { SSEMessage } from "../hooks/use-sse";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { deriveActiveBookIds, shouldRefetchBookCollections } from "../hooks/use-book-activity";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { dispatchWriteNextInstruction } from "../utils/write-next";
import { isWizardIncompleteBook, resolveBookPrimaryNavigation, resolveWizardProgressLabel } from "../utils/book-creation-routing";
import { markScriptWorkspaceAutoOpen } from "../utils/script-workspace-routing";
import {
  Plus,
  BookOpen,
  BarChart2,
  Zap,
  Clock,
  CheckCircle2,
  AlertCircle,
  MoreVertical,
  ChevronRight,
  Flame,
  Trash2,
  Settings,
  Download,
  FileInput,
  Sparkles,
} from "lucide-react";
interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly creationState?: "wizard" | "ready";
  readonly chaptersWritten: number;
  readonly language?: string;
  readonly fanficMode?: string;
  readonly creation?: {
    readonly wizardCompleted: boolean;
    readonly resumeStep: string;
    readonly completedCount: number;
    readonly totalSteps: number;
  };
}

interface Nav {
  toBook: (id: string) => void;
  toAnalytics: (id: string) => void;
  toBookCreate: (bookId?: string) => void;
  toServices: () => void;
}

export function buildDashboardExportSaveRequest(bookId: string): {
  readonly path: string;
  readonly init: RequestInit;
} {
  return {
    path: `/books/${bookId}/export-save`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "txt", approvedOnly: false }),
    },
  };
}

type ExportDialogState =
  | { readonly open: false }
  | {
      readonly open: true;
      readonly status: "success" | "error";
      readonly message: string;
      readonly path?: string;
    };

function BookMenu({ bookId, bookTitle, nav, t, onDelete, onOpenChange }: {
  readonly bookId: string;
  readonly bookTitle: string;
  readonly nav: Nav;
  readonly t: TFunction;
  readonly onDelete: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenRaw] = useState(false);
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpenRaw((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      onOpenChange?.(value);
      return value;
    });
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportDialog, setExportDialog] = useState<ExportDialogState>({ open: false });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleDelete = async () => {
    setConfirmDelete(false);
    setOpen(false);
    await fetchJson(`/books/${bookId}`, { method: "DELETE" });
    onDelete();
  };

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setOpen(false);
    try {
      const request = buildDashboardExportSaveRequest(bookId);
      const result = await fetchJson<{ ok: boolean; path?: string }>(request.path, request.init);
      setExportDialog({
        open: true,
        status: "success",
        message: t("book.exportSaved"),
        ...(result.path ? { path: result.path } : {}),
      });
    } catch (e) {
      setExportDialog({
        open: true,
        status: "error",
        message: e instanceof Error ? e.message : t("book.exportSaveFailed"),
      });
    } finally {
      setExporting(false);
    }
  };

  const handleOpenExportedFile = async () => {
    if (exportDialog.open !== true || !exportDialog.path) return;
    try {
      await fetchJson(`/books/${bookId}/export-open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: exportDialog.path }),
      });
      setExportDialog((current) => (current.open ? { ...current, message: t("book.exportSaved") } : current));
    } catch {
      setExportDialog((current) => (current.open ? { ...current, message: t("book.exportOpenFailed") } : current));
    }
  };

  return (
    <div
      ref={menuRef}
      className="relative"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="p-3 rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10 hover:scale-105 active:scale-95 transition-all cursor-pointer"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-card border border-border rounded-xl shadow-lg shadow-primary/5 py-1 z-50 fade-in">
          <button
            onClick={() => { setOpen(false); nav.toBook(bookId); }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            <Settings size={14} className="text-muted-foreground" />
            {t("book.settings")}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
          >
            <Download size={14} className="text-muted-foreground" />
            {t("book.export")}
          </button>
          <div className="border-t border-border/50 my-1" />
          <button
            onClick={() => { setOpen(false); setConfirmDelete(true); }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
            {t("book.deleteBook")}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={t("book.deleteBook")}
        message={`${t("book.confirmDelete")}\n\n"${bookTitle}"`}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
      <Dialog open={exportDialog.open} onOpenChange={(open) => { if (!open) setExportDialog({ open: false }); }}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {exportDialog.open ? (exportDialog.status === "success" ? t("book.exportSaved") : t("book.exportSaveFailed")) : ""}
            </DialogTitle>
            {exportDialog.open && (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{exportDialog.message}</p>
                {exportDialog.path && (
                  <p className="break-all rounded-lg border border-border/50 bg-secondary/40 px-3 py-2 text-xs">
                    {exportDialog.path}
                  </p>
                )}
              </div>
            )}
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setExportDialog({ open: false })}
              className="px-4 py-2.5 text-sm font-medium rounded-xl bg-secondary text-foreground hover:bg-secondary/80 transition-all border border-border/50"
            >
              {t("common.cancel")}
            </button>
            {exportDialog.open && exportDialog.status === "success" && exportDialog.path && (
              <button
                type="button"
                onClick={() => void handleOpenExportedFile()}
                className="px-4 py-2.5 text-sm font-bold rounded-xl bg-primary text-primary-foreground hover:shadow-primary/20 transition-all"
              >
                {t("book.openExport")}
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function Dashboard({ nav, sse, theme, t }: { nav: Nav; sse: { messages: ReadonlyArray<SSEMessage> }; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const [menuOpenBookId, setMenuOpenBookId] = useState<string | null>(null);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem("inkos:last-active-book-id")?.trim() ?? "";
    return stored || null;
  });
  const { data, loading, error, refetch } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const writingBooks = useMemo(() => deriveActiveBookIds(sse.messages), [sse.messages]);
  const serviceStoreServices = useServiceStore((s) => s.services);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  useEffect(() => { void fetchServices(); }, [fetchServices]);
  const hasServices = serviceStoreServices.some((s) => s.connected);

  const logEvents = sse.messages.filter((m) => m.event === "log").slice(-8);
  const progressEvent = sse.messages.filter((m) => m.event === "llm:progress").slice(-1)[0];

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) {
      refetch();
    }
  }, [refetch, sse.messages]);

  useEffect(() => {
    if (!data?.books?.length) {
      setSelectedBookId(null);
      return;
    }
    if (!selectedBookId) return;
    const stillExists = data.books.some((book) => book.id === selectedBookId);
    if (!stillExists) {
      setSelectedBookId(null);
    }
  }, [data?.books, selectedBookId]);


  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground animate-pulse">Gathering manuscripts...</span>
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center py-20 bg-destructive/5 border border-destructive/20 rounded-2xl">
      <AlertCircle className="text-destructive mb-4" size={32} />
      <h2 className="text-lg font-semibold text-destructive">Failed to load library</h2>
      <p className="text-sm text-muted-foreground mt-1">{error}</p>
    </div>
  );

  if (!data?.books.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center fade-in">
        <div className="w-20 h-20 rounded-full bg-primary/5 flex items-center justify-center mb-8">
          <BookOpen size={40} className="text-primary/20" />
        </div>
        <h2 className="font-serif text-3xl italic text-foreground/80 mb-3">{t("dash.noBooks")}</h2>
        <p className="text-sm text-muted-foreground max-w-xs leading-relaxed mb-10">
          {t("dash.createFirst")}
        </p>
        <button
          onClick={() => nav.toBookCreate()}
          className="group flex items-center gap-2 px-8 py-3.5 rounded-xl text-sm font-bold bg-primary text-primary-foreground hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20"
        >
          <Plus size={18} />
          {t("nav.newBook")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      {!hasServices && (
        <div className="rounded-lg border border-border/60 bg-card px-5 py-4 mb-8 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">杩樻病鏈夐厤缃?AI 妯″瀷</div>
            <div className="text-xs text-muted-foreground mt-0.5">閰嶅ソ涓€涓湇鍔″晢鎵嶈兘寮€濮嬪垱浣?</div>
          </div>
          <button
            onClick={nav.toServices}
            className="px-4 py-2 text-xs rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors shrink-0"
          >
            鍘婚厤缃?
          </button>
        </div>
      )}
      <div className="flex items-end justify-between border-b border-border/40 pb-8">
        <div>
          <h1 className="font-serif text-4xl mb-2">{t("dash.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("dash.subtitle")}</p>
        </div>
        <button
          onClick={() => nav.toBookCreate()}
          className="group flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold bg-primary text-primary-foreground hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20"
        >
          <Plus size={16} />
          {t("nav.newBook")}
        </button>
      </div>

      <div className="grid gap-6">
        {data.books.map((book, index) => {
          const isWriting = writingBooks.has(book.id);
          const isSelected = selectedBookId === book.id;
          const isWizardIncomplete = isWizardIncompleteBook(book);
          const progressLabel = resolveWizardProgressLabel(book);
          const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
          return (
            <div
              key={book.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                setSelectedBookId(book.id);
                if (typeof window !== "undefined") {
                  window.localStorage.setItem("inkos:last-active-book-id", book.id);
                }
                if (resolveBookPrimaryNavigation(book) === "book-create") {
                  nav.toBookCreate(book.id);
                  return;
                }
                nav.toBook(book.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedBookId(book.id);
                  if (typeof window !== "undefined") {
                    window.localStorage.setItem("inkos:last-active-book-id", book.id);
                  }
                  if (resolveBookPrimaryNavigation(book) === "book-create") {
                    nav.toBookCreate(book.id);
                    return;
                  }
                  nav.toBook(book.id);
                }
              }}
              className={`paper-sheet group relative rounded-2xl fade-in cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-xl hover:ring-1 focus-visible:outline-none focus-visible:ring-2 ${
                isWizardIncomplete
                  ? "hover:shadow-amber-500/10 hover:ring-amber-400/30 hover:bg-amber-500/[0.02] focus-visible:ring-amber-400/40"
                  : "hover:shadow-primary/10 hover:ring-primary/30 hover:bg-primary/[0.02] focus-visible:ring-primary/40"
              } ${isSelected ? (isWizardIncomplete ? "ring-1 ring-amber-400/45 bg-amber-500/[0.045] shadow-lg shadow-amber-500/10" : "ring-1 ring-primary/45 bg-primary/[0.045] shadow-lg shadow-primary/10") : ""} ${staggerClass} ${menuOpenBookId === book.id ? "z-50" : ""}`}
            >
              <div className="p-8 flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 rounded-lg bg-primary/5 text-primary">
                      <BookOpen size={20} />
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedBookId(book.id);
                        if (typeof window !== "undefined") {
                          window.localStorage.setItem("inkos:last-active-book-id", book.id);
                        }
                        if (resolveBookPrimaryNavigation(book) === "book-create") {
                          nav.toBookCreate(book.id);
                          return;
                        }
                        nav.toBook(book.id);
                      }}
                      className="font-serif text-2xl hover:text-primary transition-all text-left truncate block font-medium hover:underline underline-offset-4 decoration-primary/30"
                    >
                      {book.title}
                    </button>
                    {isSelected && (
                      <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-primary">
                        褰撳墠鍒涗綔涓?
                      </span>
                    )}
                    {isWizardIncomplete && (
                      <span className="shrink-0 rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700">
                        向导未完成 {progressLabel ?? "0/8"}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-[13px] text-muted-foreground font-medium">
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-secondary/50">
                      <span className="uppercase tracking-wider">{book.genre}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock size={14} />
                      <span>{book.chaptersWritten} {t("dash.chapters")}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${
                        book.status === "active" ? "bg-emerald-500" :
                        book.status === "paused" ? "bg-amber-500" :
                        "bg-muted-foreground"
                      }`} />
                      <span>{
                        book.status === "active" ? t("book.statusActive") :
                        book.status === "paused" ? t("book.statusPaused") :
                        book.status === "outlining" ? t("book.statusOutlining") :
                        book.status === "completed" ? t("book.statusCompleted") :
                        book.status === "dropped" ? t("book.statusDropped") :
                        book.status
                      }</span>
                    </div>
                    {book.language === "en" && (
                      <span className="px-1.5 py-0.5 rounded border border-primary/20 text-primary text-[10px] font-bold">EN</span>
                    )}
                    {book.fanficMode && (
                      <span className="flex items-center gap-1 text-purple-500">
                        <Zap size={12} />
                        <span className="italic">{book.fanficMode}</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 ml-6">
                  <button
                    onClick={async (event) => {
                      event.stopPropagation();
                      try { await dispatchWriteNextInstruction(book.id, book.language); }
                      catch (e) { alert(e instanceof Error ? e.message : "Write failed"); }
                    }}
                    disabled={isWriting}
                    className={`flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all shadow-sm ${
                      isWriting
                        ? "bg-primary/20 text-primary cursor-wait animate-pulse"
                        : "bg-secondary text-foreground hover:bg-primary hover:text-primary-foreground hover:shadow-lg hover:shadow-primary/20 hover:scale-105 active:scale-95"
                    }`}
                  >
                    {isWriting ? (
                      <>
                        <div className="w-4 h-4 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                        {t("dash.writing")}
                      </>
                    ) : (
                      <>
                        <Zap size={16} />
                        {t("dash.writeNext")}
                      </>
                    )}
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      if (typeof window !== "undefined") {
                        markScriptWorkspaceAutoOpen(window.localStorage);
                        window.localStorage.setItem("inkos:last-active-book-id", book.id);
                      }
                      nav.toBook(book.id);
                    }}
                    className="p-3 rounded-xl bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/30 hover:shadow-md hover:scale-105 active:scale-95 transition-all border border-border/50 shadow-sm"
                    title="转剧本"
                  >
                    <Sparkles size={18} />
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      nav.toAnalytics(book.id);
                    }}
                    className="p-3 rounded-xl bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/30 hover:shadow-md hover:scale-105 active:scale-95 transition-all border border-border/50 shadow-sm"
                    title={t("dash.stats")}
                  >
                    <BarChart2 size={18} />
                  </button>
                  <BookMenu
                    bookId={book.id}
                    bookTitle={book.title}
                    nav={nav}
                    t={t}
                    onDelete={() => refetch()}
                    onOpenChange={(isOpen) => setMenuOpenBookId(isOpen ? book.id : null)}
                  />
                </div>
              </div>

              {/* Enhanced progress indicator */}
              {isWriting && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-secondary overflow-hidden">
                   <div className="h-full bg-primary w-1/3 animate-[progress_2s_ease-in-out_infinite]" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Modern writing progress panel */}
      {writingBooks.size > 0 && logEvents.length > 0 && (
        <div className="glass-panel rounded-2xl p-8 border-primary/20 bg-primary/[0.02] shadow-2xl shadow-primary/5 fade-in">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary text-primary-foreground shadow-lg shadow-primary/20">
                <Flame size={18} className="animate-pulse" />
              </div>
              <div>
                <h3 className="text-sm font-bold uppercase tracking-widest text-primary"> Manuscript Foundry</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Real-time LLM generation tracking</p>
              </div>
            </div>
            {progressEvent && (
              <div className="flex items-center gap-4 text-xs font-bold text-primary px-4 py-2 rounded-full bg-primary/10 border border-primary/20">
                <div className="flex items-center gap-2">
                  <Clock size={12} />
                  <span>{Math.round(((progressEvent.data as { elapsedMs?: number })?.elapsedMs ?? 0) / 1000)}s</span>
                </div>
                <div className="w-px h-3 bg-primary/20" />
                <div className="flex items-center gap-2">
                  <Zap size={12} />
                  <span>{((progressEvent.data as { totalChars?: number })?.totalChars ?? 0).toLocaleString()} Chars</span>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2 font-mono text-xs bg-black/5 dark:bg-black/20 p-6 rounded-xl border border-border/50 max-h-[200px] overflow-y-auto scrollbar-thin">
            {logEvents.map((msg, i) => {
              const d = msg.data as { tag?: string; message?: string };
              return (
                <div key={i} className="flex gap-3 leading-relaxed animate-in fade-in slide-in-from-left-2 duration-300">
                  <span className="text-primary/60 font-bold shrink-0">[{d.tag}]</span>
                  <span className="text-muted-foreground">{d.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        @keyframes progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}


