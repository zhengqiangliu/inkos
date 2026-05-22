import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../../hooks/use-theme";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { chatSelectors, useChatStore } from "../../store/chat";
import { useServiceStore } from "../../store/service";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";
import { ChatMessage } from "./ChatMessage";
import { AssistantOutputCard } from "./AssistantOutputCard";
import { AssistantThinkingCard } from "./AssistantThinkingCard";
import { BookTaskPanel } from "./BookTaskPanel";
import { BotMessageSquare, ArrowUp, Square, ChevronDown, Check, Sparkles, Zap, Search, RefreshCcw } from "lucide-react";
import { Shimmer } from "../ai-elements/shimmer";
import { Message } from "../ai-elements/message";
import { resolveModelSelection } from "../../pages/chat-page-state";
import { ExecutionPanel } from "./ExecutionPanel";
import { pickLatestAssistantToolExecutions } from "../../pages/chat-execution-panel";
import { dispatchWriteNextInstruction, readBookDetailSessionId, resolveBookDetailSessionId } from "../../utils/write-next";
import { resolveBookAgentInstruction } from "../../utils/agent-instruction";
import { resolveLatestChapterAuditReport } from "../../utils/chapter-audit";
import { formatOptionalTokenRate, getTaskLiveTokenRatePerSecond, type TaskTokenSample } from "../../lib/task-metrics";
import type { BookTask } from "../../shared/contracts";

interface Nav {
  toServices: () => void;
}

interface BookDetailChatDockProps {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
  readonly width?: number;
  readonly latestChapterNumber?: number | null;
  readonly latestChapterAuditReport?: string | null;
  readonly nextChapter?: number;
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
}

type TokenUsageSnapshot = NonNullable<BookTask["tokenUsage"]>;

function normalizeTokenUsage(value: unknown): TokenUsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as { promptTokens?: unknown; completionTokens?: unknown; totalTokens?: unknown };
  const promptTokens = Number(usage.promptTokens);
  const completionTokens = Number(usage.completionTokens);
  const totalTokens = Number(usage.totalTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null;
  return {
    promptTokens: Math.max(0, Math.trunc(promptTokens)),
    completionTokens: Math.max(0, Math.trunc(completionTokens)),
    totalTokens: Math.max(0, Math.trunc(totalTokens)),
  };
}

function resolveLatestAgentRunId(
  messages: ReadonlyArray<SSEMessage>,
  sessionId: string,
  currentRunId: string | null | undefined,
): string | null {
  if (currentRunId) return currentRunId;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.event !== "agent:complete") continue;
    const payload = message.data as { sessionId?: unknown; runId?: unknown } | null;
    if (payload?.sessionId !== sessionId) continue;
    if (typeof payload.runId === "string" && payload.runId.trim()) return payload.runId;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.event !== "agent:start") continue;
    const payload = message.data as { sessionId?: unknown; runId?: unknown } | null;
    if (payload?.sessionId !== sessionId) continue;
    if (typeof payload.runId === "string" && payload.runId.trim()) return payload.runId;
  }
  return null;
}

export function BookDetailChatDock({ bookId, nav, theme, t, sse, width = 580, latestChapterNumber = null, latestChapterAuditReport = null, nextChapter = 1, targetChapters = 1, chapterWordCount = 0 }: BookDetailChatDockProps) {
  const activeSession = useChatStore(chatSelectors.activeSession);
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const artifactChapterMeta = useChatStore((s) => s.artifactChapterMeta);
  const input = useChatStore((s) => s.input);
  const loading = useChatStore(chatSelectors.isActiveSessionStreaming);
  const setInput = useChatStore((s) => s.setInput);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopMessage = useChatStore((s) => s.stopMessage);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const createSession = useChatStore((s) => s.createSession);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const quickMenuTimerRef = useRef<number | null>(null);
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const stopping = activeSession?.isStopping ?? false;
  const canStop = Boolean(activeSessionId) && (loading || stopping);
  const hasDraftInput = input.trim().length > 0;
  const quickActionsAvailable = Boolean(activeSessionId) && !loading && !stopping;
  const isZh = t("nav.connected") === "已连接";

  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchModels = useServiceStore((s) => s.fetchModels);

  const [executionCollapsed, setExecutionCollapsed] = useState(false);
  const [panelMode, setPanelMode] = useState<"chat" | "tasks">("chat");
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  useEffect(() => {
    for (const svc of services) {
      if (svc.connected) void fetchModels(svc.service);
    }
  }, [services, fetchModels]);

  const groupedModels = useMemo(() => (
    services
      .filter((service) => service.connected && (modelsByService[service.service]?.models.length ?? 0) > 0)
      .map((service) => ({
        service: service.service,
        label: service.label,
        models: modelsByService[service.service]!.models,
      }))
  ), [modelsByService, services]);
  const quickActionChapter = artifactChapter ?? latestChapterNumber ?? null;
  const hasQuickActionChapter = quickActionChapter !== null && Number.isFinite(quickActionChapter);
  const canShowQuickMenu = quickActionsAvailable && !canStop;

  useEffect(() => {
    const resolved = resolveModelSelection(groupedModels, selectedModel, selectedService);
    if (!resolved) return;
    if (resolved.model !== selectedModel || resolved.service !== selectedService) {
      setSelectedModel(resolved.model, resolved.service);
    }
  }, [groupedModels, selectedModel, selectedService, setSelectedModel]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadSessionList(bookId);
      if (cancelled) return;
      const state = useChatStore.getState();
      const preferredSessionId = readBookDetailSessionId(bookId);
      const preferredSession = preferredSessionId ? state.sessions[preferredSessionId] : null;
      if (preferredSessionId && preferredSession?.bookId === bookId) {
        activateSession(preferredSessionId);
        await loadSessionDetail(preferredSessionId);
        return;
      }
      const currentSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
      if (currentSession?.bookId === bookId) {
        activateSession(currentSession.sessionId);
        await loadSessionDetail(currentSession.sessionId);
        return;
      }
      const ids = state.sessionIdsByBook[bookId] ?? [];
      if (ids.length > 0) {
        activateSession(ids[0]);
        await loadSessionDetail(ids[0]);
        return;
      }
      const created = await createSession(bookId);
      activateSession(created);
      await loadSessionDetail(created);
    })();
    return () => { cancelled = true; };
  }, [activateSession, bookId, createSession, loadSessionDetail, loadSessionList]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 128), 240)}px`;
  }, [input]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (quickMenuTimerRef.current !== null) {
      window.clearTimeout(quickMenuTimerRef.current);
      quickMenuTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const onSend = () => {
    if (loading || stopping || !activeSessionId) return;
    if (!input.trim()) return;
    if (/^(鍐欎笅涓€绔爘write next(?: chapter)?|next chapter)$/i.test(input.trim())) {
      void dispatchWriteNextInstruction(bookId, undefined, activeSessionId);
      return;
    }
    void sendMessage(activeSessionId, input, bookId);
  };

  const runQuickAction = async (action: "write-next" | "audit" | "rewrite") => {
    if (loading || stopping) return;
    setQuickMenuOpen(false);
    try {
      if (action === "write-next") {
        await dispatchWriteNextInstruction(bookId, isZh ? undefined : "en", activeSessionId);
        return;
      }

      if (!hasQuickActionChapter) return;
      const sessionId = await resolveBookDetailSessionId(bookId, activeSessionId);
      const instruction = action === "audit"
        ? (isZh ? `审计第${quickActionChapter}章` : `audit chapter ${quickActionChapter}`)
        : resolveBookAgentInstruction("rewrite", {
          chapterNumber: quickActionChapter,
          auditReport: resolveLatestChapterAuditReport(artifactChapterMeta) ?? latestChapterAuditReport ?? undefined,
          language: isZh ? "zh" : "en",
        });
      await sendMessage(sessionId, instruction, bookId);
    } catch (error) {
      console.error("Quick action failed", error);
    }
  };

  const cancelQuickMenuClose = () => {
    if (quickMenuTimerRef.current !== null) {
      window.clearTimeout(quickMenuTimerRef.current);
      quickMenuTimerRef.current = null;
    }
  };

  const openQuickMenu = () => {
    if (!quickActionsAvailable) return;
    cancelQuickMenuClose();
    setQuickMenuOpen(true);
  };

  const closeQuickMenu = (delay = 120) => {
    cancelQuickMenuClose();
    quickMenuTimerRef.current = window.setTimeout(() => {
      setQuickMenuOpen(false);
      quickMenuTimerRef.current = null;
    }, delay);
  };

  const modelPickerStatus = useMemo(() => {
    if (servicesLoading || services.length === 0) return "loading" as const;
    const connected = services.filter((s) => s.connected);
    if (connected.length === 0) return "no-models" as const;
    if (connected.some((s) => modelsByService[s.service]?.loading)) return "loading" as const;
    return connected.some((s) => (modelsByService[s.service]?.models.length ?? 0) > 0) ? "ready" as const : "no-models" as const;
  }, [modelsByService, services, servicesLoading]);

  const executionList = useMemo(() => {
    const latest = pickLatestAssistantToolExecutions(messages);
    if (loading) return latest;
    return latest.map((execution) => {
      if (execution.status !== "running" && execution.status !== "processing") return execution;
      return {
        ...execution,
        status: "completed" as const,
      };
    });
  }, [loading, messages]);

  const sessionTokenSummary = useMemo(() => {
    const session = activeSession;
    if (!session) return null;
    const runId = resolveLatestAgentRunId(sse.messages, session.sessionId, session.currentRunId);
    if (!runId) return null;

    const samples: TaskTokenSample[] = [];
    let latestUsage: TokenUsageSnapshot | null = null;

    for (const message of sse.messages) {
      if (message.event !== "agent:usage" && message.event !== "agent:complete") continue;
      const payload = message.data as {
        sessionId?: unknown;
        runId?: unknown;
        tokenUsage?: unknown;
      } | null;
      if (payload?.sessionId !== session.sessionId || payload?.runId !== runId) continue;

      const usage = normalizeTokenUsage(payload.tokenUsage);
      if (usage) {
        latestUsage = usage;
        samples.push({
          at: message.timestamp,
          totalTokens: usage.totalTokens,
        });
      }
    }

    const liveRate = samples.length > 1
      ? getTaskLiveTokenRatePerSecond(samples, nowTick)
      : null;
    const totalTokens = latestUsage?.totalTokens ?? samples.at(-1)?.totalTokens ?? null;
    if (totalTokens === null && liveRate === null) return null;
    return `Token：实时 ${formatOptionalTokenRate(liveRate)} · 总计 ${totalTokens === null ? "—" : totalTokens.toLocaleString()}`;
  }, [activeSession, nowTick, sse.messages]);

  return (
    <aside
      className="shrink-0 border-l border-border/30 bg-card/80 backdrop-blur-md flex flex-col min-w-0 min-h-0 overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <div className="shrink-0 border-b border-border/20 px-3 py-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">AI 工作台</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">对话 / 任务 / 正文</div>
          </div>

          <div className="shrink-0 flex flex-col items-end gap-1 text-right">
            {modelPickerStatus === "ready" ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                  <span className="max-w-[180px] truncate">{selectedModel ?? "选择模型"}</span>
                  <ChevronDown size={14} />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end" className="w-64 max-h-80 flex flex-col">
                  {groupedModels.map((group) => (
                    <div key={group.service}>
                      <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">{group.label}</div>
                      {group.models.map((m) => {
                        const active = selectedModel === m.id && selectedService === group.service;
                        return (
                          <DropdownMenuItem key={`${group.service}:${m.id}`} onClick={() => setSelectedModel(m.id, group.service)}>
                            <div className="flex flex-1 items-center justify-between">
                              <span>{m.name ?? m.id}</span>
                              {active && <Check size={14} className="text-primary" />}
                            </div>
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  ))}
                  <DropdownMenuItem onClick={nav.toServices} className="text-primary">管理模型</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button onClick={nav.toServices} className="text-xs text-muted-foreground hover:text-primary">配置模型</button>
            )}
            {sessionTokenSummary ? (
              <div className="max-w-[220px] text-[11px] leading-4 tabular-nums text-muted-foreground">
                {sessionTokenSummary}
              </div>
            ) : null}
          </div>
        </div>

        <div className="inline-flex rounded-full border border-border/40 bg-background/50 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setPanelMode("chat")}
            className={`rounded-full px-3 py-1.5 transition-colors ${panelMode === "chat" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            聊天
          </button>
          <button
            type="button"
            onClick={() => setPanelMode("tasks")}
            className={`rounded-full px-3 py-1.5 transition-colors ${panelMode === "tasks" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            任务
          </button>
        </div>

        {panelMode === "chat" && (
          <ExecutionPanel executions={executionList} collapsed={executionCollapsed} onCollapsedChange={setExecutionCollapsed} />
        )}
      </div>

      {panelMode === "chat" ? (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 min-h-0">
            {messages.length === 0 && !loading ? (
              <div className="h-full flex items-center justify-center text-center">
                <div className="space-y-3">
                  <BotMessageSquare size={24} className="mx-auto text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">输入需求后，AI 会在这里输出思考过程和正文。</p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((msg, i) => (
                  <div key={`${msg.timestamp}-${i}`}>
                    {msg.role === "assistant" && msg.thinking ? (
                      <AssistantThinkingCard content={msg.thinking} isStreaming={msg.thinkingStreaming === true} />
                    ) : null}
                    <ChatMessage
                      role={msg.role}
                      content={msg.content}
                      timestamp={msg.timestamp}
                      theme={theme}
                    />
                  </div>
                ))}
                {loading && !messages.some((item) => item.role === "assistant" && (item.thinkingStreaming || item.content.length > 0)) && (
                  <Message from="assistant">
                    <AssistantOutputCard className="w-full">
                      <Shimmer className="text-sm" duration={1.5}>{isZh ? "思考中..." : "Thinking..."}</Shimmer>
                    </AssistantOutputCard>
                  </Message>
                )}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-border/30 p-3 bg-card/80">
            <div className="relative min-h-[164px] rounded-2xl border border-border/40 bg-secondary/20 px-3 py-3">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                rows={4}
                placeholder={isZh ? "输入修改要求..." : "Enter request..."}
                className="block h-full min-h-[128px] w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/50 max-h-[240px] pr-14 pb-14"
              />
              <div
                className="absolute bottom-3 right-3 z-10"
                onMouseEnter={() => {
                  if (hasDraftInput && quickActionsAvailable) openQuickMenu();
                }}
                onMouseLeave={() => {
                  if (hasDraftInput && quickActionsAvailable) closeQuickMenu();
                }}
              >
                <div className="relative">
                  {canShowQuickMenu && (
                    <div
                      aria-hidden={!quickMenuOpen}
                      className={`absolute right-0 bottom-full mb-2 w-48 origin-bottom-right rounded-xl border border-border/60 bg-popover/98 p-1 shadow-xl backdrop-blur-md transition-[opacity,transform,filter] duration-200 ease-out ${
                        quickMenuOpen
                          ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
                          : "pointer-events-none translate-y-2 scale-95 opacity-0"
                      }`}
                      onMouseEnter={openQuickMenu}
                      onMouseLeave={() => closeQuickMenu()}
                    >
                      <button
                        type="button"
                        onClick={() => { void runQuickAction("write-next"); }}
                        disabled={!quickActionsAvailable}
                        className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-popover-foreground transition-all duration-150 ease-out hover:bg-accent hover:text-accent-foreground disabled:opacity-40 ${
                          quickMenuOpen ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
                        }`}
                        style={{ transitionDelay: "0ms" }}
                      >
                        <Zap size={14} className="transition-transform duration-150 ease-out group-hover:scale-110" />
                        {isZh ? "写下一章" : "Write next"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void runQuickAction("audit"); }}
                        disabled={!hasQuickActionChapter || !quickActionsAvailable}
                        className={`group flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-popover-foreground transition-all duration-150 ease-out hover:bg-accent hover:text-accent-foreground disabled:opacity-40 ${
                          quickMenuOpen ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
                        }`}
                        style={{ transitionDelay: "35ms" }}
                      >
                        <span className="inline-flex items-center gap-2">
                          <Search size={14} className="transition-transform duration-150 ease-out group-hover:scale-110" />{isZh ? "审计" : "Audit"}
                        </span>
                        {hasQuickActionChapter && (
                          <span className="text-[11px] text-muted-foreground">
                            {isZh ? `第${quickActionChapter}章` : `Ch ${quickActionChapter}`}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void runQuickAction("rewrite"); }}
                        disabled={!hasQuickActionChapter || !quickActionsAvailable}
                        className={`group flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-popover-foreground transition-all duration-150 ease-out hover:bg-accent hover:text-accent-foreground disabled:opacity-40 ${
                          quickMenuOpen ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
                        }`}
                        style={{ transitionDelay: "70ms" }}
                      >
                        <span className="inline-flex items-center gap-2">
                          <RefreshCcw size={14} className="transition-transform duration-150 ease-out group-hover:scale-110" />{isZh ? "重写" : "Rewrite"}
                        </span>
                        {hasQuickActionChapter && (
                          <span className="text-[11px] text-muted-foreground">
                            {isZh ? `第${quickActionChapter}章` : `Ch ${quickActionChapter}`}
                          </span>
                        )}
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      if (!activeSessionId) return;
                      if (canStop) {
                        void stopMessage(activeSessionId);
                        return;
                      }
                      if (hasDraftInput) {
                        setQuickMenuOpen(false);
                        onSend();
                        return;
                      }
                      setQuickMenuOpen((prev) => !prev);
                    }}
                    onMouseEnter={() => {
                      if (canShowQuickMenu) openQuickMenu();
                    }}
                    onMouseLeave={() => closeQuickMenu()}
                    onFocus={() => {
                      if (canShowQuickMenu) openQuickMenu();
                    }}
                    onBlur={() => {
                      if (canShowQuickMenu) closeQuickMenu();
                    }}
                    disabled={!activeSessionId || stopping}
                    className="group relative inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/20 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:scale-110 hover:shadow-xl hover:shadow-primary/30 active:scale-95 disabled:opacity-30"
                    title={
                      canStop
                        ? (isZh ? "停止" : "Stop")
                        : hasDraftInput
                          ? (isZh ? "发送 / 快捷操作" : "Send / quick actions")
                          : (isZh ? "快捷操作" : "Quick actions")
                    }
                    aria-label={
                      canStop
                        ? (isZh ? "停止" : "Stop")
                        : hasDraftInput
                          ? (isZh ? "发送 / 快捷操作" : "Send / quick actions")
                          : (isZh ? "快捷操作" : "Quick actions")
                    }
                    >
                    {hasDraftInput && quickActionsAvailable && !canStop && (
                      <span className="pointer-events-none absolute inset-[-7px] rounded-full border border-primary/35 chat-suspense-pulse" />
                    )}
                    {hasDraftInput && quickActionsAvailable && !canStop && (
                      <span className="pointer-events-none absolute inset-[1px] rounded-full bg-primary/10" />
                    )}
                    {canStop
                      ? <Square size={12} fill="currentColor" className="transition-transform duration-200 ease-out group-hover:scale-110" />
                      : hasDraftInput
                        ? <ArrowUp size={15} className="transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:rotate-12 group-hover:scale-110" />
                        : <Sparkles size={15} className="transition-transform duration-200 ease-out group-hover:scale-110 group-hover:rotate-12" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 min-h-0">
          <BookTaskPanel
            bookId={bookId}
            nextChapter={nextChapter}
            targetChapters={targetChapters}
            chapterWordCount={chapterWordCount}
            selectedModel={selectedModel}
            selectedService={selectedService}
            onManageModels={nav.toServices}
            sse={sse}
          />
        </div>
      )}
    </aside>
  );
}


