import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import { shouldRefetchBookCollections, shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import type { TFunction } from "../hooks/use-i18n";
import { useChatStore } from "../store/chat";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  Settings,
  Terminal,
  Plus,
  ScrollText,
  Boxes,
  Wand2,
  FileInput,
  TrendingUp,
  Stethoscope,
  FolderOpen,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
}

interface Nav {
  toDashboard: () => void;
  toBook: (id: string) => void;
  toBookCreate: () => void;
  toServices: () => void;
  toDaemon: () => void;
  toLogs: () => void;
  toGenres: () => void;
  toStyle: () => void;
  toImport: () => void;
  toRadar: () => void;
  toDoctor: () => void;
}

interface SidebarProps {
  nav: Nav;
  activePage: string;
  sse: { messages: ReadonlyArray<SSEMessage> };
  t: TFunction;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function Sidebar({ nav, activePage, sse, t, collapsed = false, onToggleCollapsed }: SidebarProps) {
  const { data, refetch: refetchBooks } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { data: daemon, refetch: refetchDaemon } = useApi<{ running: boolean }>("/daemon");
  const sessions = useChatStore((s) => s.sessions);
  const sessionIdsByBook = useChatStore((s) => s.sessionIdsByBook);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; currentTitle: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; title: string } | null>(null);
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());

  const books = data?.books ?? [];

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) refetchBooks();
    if (shouldRefetchDaemonStatus(recent)) refetchDaemon();
  }, [refetchBooks, refetchDaemon, sse.messages]);

  useEffect(() => {
    for (const bookId of expandedBooks) void loadSessionList(bookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookDataVersion, loadSessionList]);

  const toggleBook = (bookId: string) => {
    setExpandedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
        if (sessionIdsByBook[bookId] === undefined) {
          void loadSessionList(bookId);
        }
      }
      return next;
    });
  };

  const sessionsByBook = useMemo(
    () =>
      Object.fromEntries(
        books.map((book) => [
          book.id,
          (sessionIdsByBook[book.id] ?? [])
            .map((sessionId) => sessions[sessionId])
            .filter(Boolean),
        ]),
      ) as Record<string, Array<(typeof sessions)[string]>>,
    [books, sessionIdsByBook, sessions],
  );

  const openSession = (bookId: string, sessionId: string) => {
    activateSession(sessionId);
    nav.toBook(bookId);
    void loadSessionDetail(sessionId);
  };

  const handleCreateSession = (bookId: string) => {
    setExpandedBooks((prev) => new Set(prev).add(bookId));
    createDraftSession(bookId);
    nav.toBook(bookId);
  };

  const handleRenameConfirm = async () => {
    if (!renameTarget) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;
    await renameSession(renameTarget.sessionId, nextTitle);
    setRenameTarget(null);
    setRenameValue("");
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deleteSession(deleteTarget.sessionId);
    setDeleteTarget(null);
  };

  return (
    <TooltipProvider delay={120}>
      <aside className={`group/sidebar relative ${collapsed ? "w-[72px]" : "w-[260px]"} shrink-0 border-r border-border bg-background/80 backdrop-blur-md flex flex-col h-full overflow-hidden select-none transition-all duration-200`}>
        <Tooltip>
          <TooltipTrigger>
            <button
              type="button"
              onClick={() => onToggleCollapsed?.()}
              className="absolute right-[-10px] top-4 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground shadow-md transition-all hover:bg-secondary hover:text-foreground"
              aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            >
              {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? "展开侧边栏" : "折叠侧边栏"}</TooltipContent>
        </Tooltip>

        <div className={`${collapsed ? "px-2 py-5" : "px-6 py-8"}`}>
          <Tooltip>
            <TooltipTrigger>
              <button
                onClick={nav.toDashboard}
                className={`group flex items-center ${collapsed ? "mx-auto justify-center" : "gap-2"} hover:opacity-80 transition-all duration-300`}
                aria-label="返回首页"
              >
                <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg shadow-primary/20 group-hover:scale-105 transition-transform">
                  <ScrollText size={18} />
                </div>
                {!collapsed && (
                  <div className="flex flex-col">
                    <span className="font-serif text-xl leading-none italic font-medium">InkOS</span>
                    <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-bold mt-1">Studio</span>
                  </div>
                )}
              </button>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">返回首页</TooltipContent>}
          </Tooltip>
        </div>

        <div className={`flex-1 overflow-y-auto ${collapsed ? "px-2 py-2" : "px-4 py-2"} space-y-6`}>
          <div>
            {!collapsed && (
              <div className="px-3 mb-3 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">{t("nav.books")}</span>
                <button
                  onClick={nav.toBookCreate}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
                >
                  <Plus size={12} />
                  <span>{t("nav.newBook")}</span>
                </button>
              </div>
            )}

            {collapsed && (
              <div className="mb-3 grid w-full place-items-center">
                <Tooltip>
                  <TooltipTrigger>
                    <button
                      type="button"
                      onClick={nav.toBookCreate}
                      className="grid h-10 w-10 place-items-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border/60 hover:bg-secondary/40 hover:text-foreground"
                      aria-label="新建书籍"
                    >
                      <Plus size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">新建书籍</TooltipContent>
                </Tooltip>
              </div>
            )}

            <div className="space-y-0.5">
              {books.map((book) => {
                const bookSessions = sessionsByBook[book.id] ?? [];
                const isActiveBook = activePage === `book:${book.id}`;
                const isExpanded = expandedBooks.has(book.id);

                return (
                  <div key={book.id}>
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger>
                          <button
                            type="button"
                            onClick={() => nav.toBook(book.id)}
                            className={`grid h-10 w-10 place-items-center rounded-lg border transition-colors ${
                              isActiveBook ? "border-primary bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-secondary/40 hover:text-foreground"
                            }`}
                            aria-label={book.title}
                          >
                            <FolderOpen size={16} className="shrink-0" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">{book.title}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <>
                        <div className="group/book flex items-center">
                          <button
                            type="button"
                            onClick={() => toggleBook(book.id)}
                            className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
                              isActiveBook ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/30"
                            }`}
                          >
                            <ChevronRight
                              size={12}
                              className={`shrink-0 text-muted-foreground/60 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                            />
                            <FolderOpen size={14} className="shrink-0 text-muted-foreground/60" />
                            <span className="truncate flex-1 text-left">{book.title}</span>
                          </button>
                        </div>

                        {isExpanded && (
                          <div className="mt-0.5">
                            {bookSessions.map((session) => {
                              const isActiveSession = isActiveBook && activeSessionId === session.sessionId;
                              const label = getSessionLabel(session);

                              return (
                                <div
                                  key={session.sessionId}
                                  className={`group/session flex items-center rounded-md ${isActiveSession ? "bg-secondary/50" : "hover:bg-secondary/30"}`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => openSession(book.id, session.sessionId)}
                                    className="flex min-w-0 flex-1 items-center gap-2 pl-9 pr-2 py-1 text-left text-[13px] transition-colors"
                                  >
                                    <span className={`truncate flex-1 ${isActiveSession ? "text-foreground" : "text-muted-foreground group-hover/session:text-foreground"}`}>
                                      {label}
                                    </span>
                                    {session.isStreaming ? (
                                      <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                                    ) : (
                                      <span className="shrink-0 text-[11px] text-muted-foreground/40">{formatRelativeTime(session.sessionId)}</span>
                                    )}
                                  </button>

                                  <DropdownMenu>
                                    <DropdownMenuTrigger className="flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 group-hover/session:opacity-100 text-muted-foreground hover:text-foreground transition-opacity">
                                      <MoreHorizontal size={14} />
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent side="right" align="start" className="w-36">
                                      <DropdownMenuItem
                                        onClick={() => {
                                          setRenameTarget({ sessionId: session.sessionId, currentTitle: label });
                                          setRenameValue(session.title ?? "");
                                        }}
                                      >
                                        <Pencil size={14} />
                                        <span>改名</span>
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget({ sessionId: session.sessionId, title: label })}>
                                        <Trash2 size={14} />
                                        <span>删除</span>
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() => void handleCreateSession(book.id)}
                              className="w-full flex items-center gap-2 pl-9 pr-2 py-1 text-xs text-muted-foreground/50 hover:text-foreground transition-colors"
                            >
                              <Plus size={12} />
                              <span>新建会话</span>
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}

              {books.length === 0 && !collapsed && (
                <div className="px-3 py-6 text-xs text-muted-foreground/50 italic text-center">{t("dash.noBooks")}</div>
              )}
            </div>
          </div>

          <div>
            {!collapsed && (
              <div className="px-3 mb-3">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">{t("nav.system")}</span>
              </div>
            )}
            <div className="space-y-1">
              <SidebarItem collapsed={collapsed} label={t("create.genre")} icon={<Boxes size={16} />} active={activePage === "genres"} onClick={nav.toGenres} />
              <SidebarItem collapsed={collapsed} label={t("nav.config")} icon={<Settings size={16} />} active={activePage === "services"} onClick={nav.toServices} />
              <SidebarItem collapsed={collapsed} label={t("nav.logs")} icon={<Terminal size={16} />} active={activePage === "logs"} onClick={nav.toLogs} />
            </div>
          </div>

          <div>
            {!collapsed && (
              <div className="px-3 mb-3">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">{t("nav.tools")}</span>
              </div>
            )}
            <div className="space-y-1">
              <SidebarItem collapsed={collapsed} label={t("nav.style")} icon={<Wand2 size={16} />} active={activePage === "style"} onClick={nav.toStyle} />
              <SidebarItem collapsed={collapsed} label={t("nav.import")} icon={<FileInput size={16} />} active={activePage === "import"} onClick={nav.toImport} />
              <SidebarItem collapsed={collapsed} label={t("nav.radar")} icon={<TrendingUp size={16} />} active={activePage === "radar"} onClick={nav.toRadar} />
              <SidebarItem collapsed={collapsed} label={t("nav.doctor")} icon={<Stethoscope size={16} />} active={activePage === "doctor"} onClick={nav.toDoctor} />
            </div>
          </div>
        </div>

        {daemon?.running && !collapsed && (
          <div className="p-4 border-t border-border bg-secondary/40">
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-card border border-border shadow-sm">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wider">{t("nav.agentOnline")}</span>
            </div>
          </div>
        )}

        <Dialog
          open={renameTarget !== null}
          onOpenChange={(open) => {
            if (!open) {
              setRenameTarget(null);
              setRenameValue("");
            }
          }}
        >
          <DialogContent showCloseButton={false} className="sm:max-w-[360px] p-4 gap-3">
            <DialogHeader className="space-y-0 gap-0">
              <DialogTitle className="font-sans text-sm font-medium">重命名会话</DialogTitle>
            </DialogHeader>
            <input
              id="session-rename-input"
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleRenameConfirm();
                }
              }}
              placeholder="输入新标题"
              className="w-full rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-border"
            />
            <DialogFooter className="gap-1 sm:gap-1">
              <button
                type="button"
                onClick={() => {
                  setRenameTarget(null);
                  setRenameValue("");
                }}
                className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleRenameConfirm()}
                disabled={!renameValue.trim()}
                className="px-3 py-1 text-xs font-medium rounded-md bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-30"
              >
                保存
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleteTarget !== null}
          title="删除会话"
          message={`确认删除“${deleteTarget?.title ?? ""}”吗？该操作只删除这条会话，不影响书籍内容。`}
          confirmLabel="删除"
          cancelLabel="取消"
          variant="danger"
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setDeleteTarget(null)}
        />
      </aside>
    </TooltipProvider>
  );
}

function getSessionLabel(session: { sessionId: string; title: string | null; messages: ReadonlyArray<{ role: string; content: string }> }): string {
  if (session.title) return session.title;
  const firstUserMsg = session.messages.find((m) => m.role === "user")?.content?.trim();
  if (firstUserMsg) {
    const oneLine = firstUserMsg.replace(/\s+/g, " ");
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
  }
  return "新会话";
}

function formatRelativeTime(sessionId: string): string {
  const rawTs = Number(sessionId.split("-")[0]);
  if (!Number.isFinite(rawTs)) return "";
  const diff = Date.now() - rawTs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  return `${months} 个月`;
}

function SidebarItem({
  label,
  icon,
  active,
  onClick,
  badge,
  badgeColor,
  collapsed = false,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: string;
  badgeColor?: string;
  collapsed?: boolean;
}) {
  const button = (
    <button
      onClick={onClick}
      className={`group flex items-center text-sm transition-all duration-200 ${
        collapsed
          ? `grid h-10 w-10 place-items-center rounded-lg border ${active ? "border-primary bg-secondary/80 text-foreground shadow-sm" : "border-transparent text-foreground hover:border-border/60 hover:bg-secondary/50"}`
          : `w-full gap-3 px-3 py-2 rounded-lg ${active ? "bg-secondary text-foreground font-medium shadow-sm border border-border" : "text-foreground font-medium hover:text-foreground hover:bg-secondary/50"}`
      }`}
      aria-label={label}
    >
      <span className={`transition-colors ${active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}>
        {icon}
      </span>
      {!collapsed && <span className="flex-1 text-left">{label}</span>}
      {!collapsed && badge && (
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-tight ${badgeColor ?? "bg-muted text-muted-foreground"}`}>
          {badge}
        </span>
      )}
    </button>
  );

  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
