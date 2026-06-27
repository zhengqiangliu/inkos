import { useEffect, useMemo, useState } from "react";
import { prefetchApiPath, useApi } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import { shouldRefetchBookCollections, shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import type { TFunction } from "../hooks/use-i18n";
import { useChatStore } from "../store/chat";
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
  ListTodo,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { isWizardIncompleteBook, resolveBookPrimaryNavigation, resolveWizardProgressLabel } from "../utils/book-creation-routing";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly creationState?: "wizard" | "ready";
  readonly chaptersWritten: number;
  readonly creation?: {
    readonly wizardCompleted: boolean;
    readonly resumeStep: string;
    readonly completedCount: number;
    readonly totalSteps: number;
  };
}

interface Nav {
  toDashboard: () => void;
  toBook: (id: string) => void;
  toBookCreate: (bookId?: string) => void;
  toBookDraft?: (draftSessionId: string) => void;
  toServices: () => void;
  toDaemon: () => void;
  toLogs: () => void;
  toTasks: () => void;
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

export function getBookBadgeInitial(title: string): string {
  const normalized = title.normalize("NFKC").trim();
  if (!normalized) return "?";
  const stripped = normalized.replace(/^[\s"'“”‘’《》【】()（）\[\]{}·—\-_,.!?：:；;、/\\|]+/u, "");
  const chars = Array.from(stripped || normalized);
  for (const char of chars) {
    if (/\p{L}/u.test(char) || /\p{N}/u.test(char) || /\p{Script=Han}/u.test(char)) {
      return /[a-z]/i.test(char) ? char.toUpperCase() : char;
    }
  }
  const fallback = chars[0] ?? "?";
  return /[a-z]/i.test(fallback) ? fallback.toUpperCase() : fallback;
}

export function shouldShowBookList(activePage: string): boolean {
  return activePage !== "book-create";
}

export function Sidebar({ nav, activePage, sse, t, collapsed = false, onToggleCollapsed }: SidebarProps) {
  const { data, refetch: refetchBooks } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { data: daemon, refetch: refetchDaemon } = useApi<{ running: boolean }>("/daemon");
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const loadSessionList = useChatStore((s) => s.loadSessionList);

  const books = data?.books ?? [];
  const showBookList = shouldShowBookList(activePage);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) refetchBooks();
    if (shouldRefetchDaemonStatus(recent)) refetchDaemon();
  }, [refetchBooks, refetchDaemon, sse.messages]);

  useEffect(() => {
    void loadSessionList(null);
  }, [bookDataVersion, loadSessionList]);

  const prefetchBook = (book: BookSummary) => {
    if (resolveBookPrimaryNavigation(book) === "book-create") {
      return;
    }
    void prefetchApiPath(`/books/${book.id}`);
    void loadSessionList(book.id);
  };

  const openBook = (book: BookSummary) => {
    if (resolveBookPrimaryNavigation(book) === "book-create") {
      nav.toBookCreate(book.id);
      return;
    }
    prefetchBook(book);
    nav.toBook(book.id);
  };

  return (
    <TooltipProvider delay={120}>
      <aside className={`group/sidebar relative ${collapsed ? "w-[72px]" : "w-[260px]"} shrink-0 border-r border-border bg-background/80 backdrop-blur-md flex flex-col h-full overflow-hidden select-none transition-all duration-200`}>
        <Tooltip>
          <TooltipTrigger
            render={(
              <button
                type="button"
                onClick={() => onToggleCollapsed?.()}
                className="absolute right-[-10px] top-4 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground shadow-md transition-all hover:bg-secondary hover:text-foreground"
                aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
              >
                {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </button>
            )}
          />
          <TooltipContent side="right">{collapsed ? "展开侧边栏" : "折叠侧边栏"}</TooltipContent>
        </Tooltip>

        <div className={`${collapsed ? "px-2 py-5" : "px-6 py-8"}`}>
          <Tooltip>
            <TooltipTrigger
              render={(
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
              )}
            />
            {collapsed && <TooltipContent side="right">返回首页</TooltipContent>}
          </Tooltip>
        </div>

        <div className={`flex-1 overflow-y-auto ${collapsed ? "px-2 py-2" : "px-4 py-2"} space-y-6`}>
          {showBookList ? <div>
            {!collapsed && (
              <div className="px-3 mb-3 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">{t("nav.books")}</span>
                <button
                  onClick={() => nav.toBookCreate()}
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
                  <TooltipTrigger
                    render={(
                      <button
                        type="button"
                        onClick={() => nav.toBookCreate()}
                        className="grid h-10 w-10 place-items-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border/60 hover:bg-secondary/40 hover:text-foreground"
                        aria-label="新建书籍"
                      >
                        <Plus size={16} />
                      </button>
                    )}
                  />
                  <TooltipContent side="right">新建书籍</TooltipContent>
                </Tooltip>
              </div>
            )}

            <div className="space-y-0.5">
              {books.map((book) => {
                const isActiveBook = activePage === `book:${book.id}`;
                const initial = getBookBadgeInitial(book.title);
                const isDrafting = isWizardIncompleteBook(book);
                const progressLabel = resolveWizardProgressLabel(book);
                const badgeClass = isDrafting
                  ? "border-amber-400/50 bg-amber-500/10 text-amber-700"
                  : isActiveBook
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border/60 bg-secondary/40 text-muted-foreground";

                return (
                  <div key={book.id}>
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={(
                            <button
                              type="button"
                              onClick={() => openBook(book)}
                              onPointerEnter={() => prefetchBook(book)}
                              onFocus={() => prefetchBook(book)}
                              className={`grid h-10 w-10 place-items-center rounded-full border transition-colors ${
                                isDrafting ? "border-amber-400/30 bg-amber-500/10 text-amber-700" : isActiveBook ? "border-primary bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-secondary/40 hover:text-foreground"
                              }`}
                              aria-label={book.title}
                            >
                              <span
                                className={`grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold leading-none ${
                                  isDrafting
                                    ? "bg-amber-50 text-amber-700 ring-1 ring-amber-400/40"
                                    : isActiveBook
                                      ? "bg-primary/10 text-primary"
                                      : "bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/60 group-hover:text-foreground"
                                }`}
                              >
                                {initial}
                              </span>
                            </button>
                          )}
                        />
                        <TooltipContent side="right">{book.title}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <div className="group/book flex items-center">
                        <button
                          type="button"
                          onClick={() => openBook(book)}
                          onPointerEnter={() => prefetchBook(book)}
                          onFocus={() => prefetchBook(book)}
                          className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
                            isActiveBook ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/30"
                          }`}
                        >
                          <ChevronRight
                            size={12}
                            className="shrink-0 text-muted-foreground/60"
                          />
                          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold leading-none ${badgeClass}`}>
                            {initial}
                          </span>
                          <span className="truncate flex-1 text-left">{book.title}</span>
                          {progressLabel ? (
                            <span className="shrink-0 text-[10px] font-medium text-amber-700">
                              {progressLabel}
                            </span>
                          ) : null}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {books.length === 0 && !collapsed && (
                <div className="px-3 py-6 text-xs text-muted-foreground/50 italic text-center">{t("dash.noBooks")}</div>
              )}
            </div>
          </div> : null}

          <div>
            {!collapsed && (
              <div className="px-3 mb-3">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">{t("nav.system")}</span>
              </div>
            )}
            <div className="space-y-1">
              <SidebarItem collapsed={collapsed} label={t("create.genre")} icon={<Boxes size={16} />} active={activePage === "genres"} onClick={nav.toGenres} href="#/genres" />
              <SidebarItem collapsed={collapsed} label={t("nav.config")} icon={<Settings size={16} />} active={activePage === "services"} onClick={nav.toServices} href="#/services" />
              <SidebarItem collapsed={collapsed} label="任务中心" icon={<ListTodo size={16} />} active={activePage === "tasks"} onClick={nav.toTasks} href="#/tasks" />
              <SidebarItem collapsed={collapsed} label={t("nav.logs")} icon={<Terminal size={16} />} active={activePage === "logs"} onClick={nav.toLogs} href="#/logs" />
            </div>
          </div>

          <div>
            {!collapsed && (
              <div className="px-3 mb-3">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">{t("nav.tools")}</span>
              </div>
            )}
            <div className="space-y-1">
              <SidebarItem collapsed={collapsed} label={t("nav.style")} icon={<Wand2 size={16} />} active={activePage === "style"} onClick={nav.toStyle} href="#/style" />
              <SidebarItem collapsed={collapsed} label={t("nav.import")} icon={<FileInput size={16} />} active={activePage === "import"} onClick={nav.toImport} href="#/import" />
              <SidebarItem collapsed={collapsed} label={t("nav.radar")} icon={<TrendingUp size={16} />} active={activePage === "radar"} onClick={nav.toRadar} href="#/radar" />
              <SidebarItem collapsed={collapsed} label={t("nav.doctor")} icon={<Stethoscope size={16} />} active={activePage === "doctor"} onClick={nav.toDoctor} href="#/doctor" />
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
      </aside>
    </TooltipProvider>
  );
}

function SidebarItem({
  label,
  icon,
  active,
  onClick,
  href,
  badge,
  badgeColor,
  collapsed = false,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  href?: string;
  badge?: string;
  badgeColor?: string;
  collapsed?: boolean;
}) {
  const commonClassName = `group flex items-center text-sm transition-all duration-200 ${
    collapsed
      ? `grid h-10 w-10 place-items-center rounded-lg border ${active ? "border-primary bg-secondary/80 text-foreground shadow-sm" : "border-transparent text-foreground hover:border-border/60 hover:bg-secondary/50"}`
      : `w-full gap-3 px-3 py-2 rounded-lg ${active ? "bg-secondary text-foreground font-medium shadow-sm border border-border" : "text-foreground font-medium hover:text-foreground hover:bg-secondary/50"}`
  }`;

  const content = (
    <>
      <span className={`transition-colors ${active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}>
        {icon}
      </span>
      {!collapsed && <span className="flex-1 text-left">{label}</span>}
      {!collapsed && badge && (
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-tight ${badgeColor ?? "bg-muted text-muted-foreground"}`}>
          {badge}
        </span>
      )}
    </>
  );

  const control = href ? (
    <a href={href} className={commonClassName} aria-label={label}>
      {content}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={commonClassName} aria-label={label}>
      {content}
    </button>
  );

  if (!collapsed) return control;
  return (
    <Tooltip>
      <TooltipTrigger render={control} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

