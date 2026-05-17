import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../../hooks/use-theme";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { chatSelectors, useChatStore } from "../../store/chat";
import { useServiceStore } from "../../store/service";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";
import { ChatMessage } from "./ChatMessage";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "../ai-elements/reasoning";
import { BotMessageSquare, ArrowUp, Square, ChevronDown, Check } from "lucide-react";
import { Shimmer } from "../ai-elements/shimmer";
import { Message, MessageContent } from "../ai-elements/message";
import { resolveModelSelection } from "../../pages/chat-page-state";
import { ExecutionPanel } from "./ExecutionPanel";
import { pickLatestAssistantToolExecutions } from "../../pages/chat-execution-panel";
import { dispatchWriteNextInstruction, readBookDetailSessionId } from "../../utils/write-next";

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
}

export function BookDetailChatDock({ bookId, nav, theme, t, width = 580 }: BookDetailChatDockProps) {
  const activeSession = useChatStore(chatSelectors.activeSession);
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
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
  const stopping = activeSession?.isStopping ?? false;
  const canStop = Boolean(activeSessionId) && (loading || stopping);
  const isZh = t("nav.connected") === "已连接";

  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchModels = useServiceStore((s) => s.fetchModels);

  const [executionCollapsed, setExecutionCollapsed] = useState(false);

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
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

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

  const modelPickerStatus = useMemo(() => {
    if (servicesLoading || services.length === 0) return "loading" as const;
    const connected = services.filter((s) => s.connected);
    if (connected.length === 0) return "no-models" as const;
    if (connected.some((s) => modelsByService[s.service]?.loading)) return "loading" as const;
    return connected.some((s) => (modelsByService[s.service]?.models.length ?? 0) > 0) ? "ready" as const : "no-models" as const;
  }, [modelsByService, services, servicesLoading]);

  const executionList = pickLatestAssistantToolExecutions(messages);

  return (
    <aside
      className="shrink-0 border-l border-border/30 bg-card/80 backdrop-blur-md flex flex-col min-w-0 min-h-0 overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <div className="shrink-0 border-b border-border/20 px-3 py-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">AI 工作台</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">对话 / 思考 / 正文</div>
          </div>

          <div className="shrink-0">
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
          </div>
        </div>

        <ExecutionPanel executions={executionList} collapsed={executionCollapsed} onCollapsedChange={setExecutionCollapsed} />
      </div>

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
                  <div className="rounded-lg border border-border/40 bg-card/40 px-3 py-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">思考过程</div>
                    <Reasoning isStreaming={msg.thinkingStreaming === true}>
                      <ReasoningTrigger />
                      <ReasoningContent>{msg.thinking}</ReasoningContent>
                    </Reasoning>
                  </div>
                ) : null}
                <ChatMessage role={msg.role} content={msg.content} timestamp={msg.timestamp} theme={theme} />
              </div>
            ))}
            {loading && !messages.some((item) => item.role === "assistant" && (item.thinkingStreaming || item.content.length > 0)) && (
              <Message from="assistant">
                <MessageContent>
                  <Shimmer className="text-sm" duration={1.5}>{isZh ? "鎬濊€冧腑..." : "Thinking..."}</Shimmer>
                </MessageContent>
              </Message>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/30 p-3 bg-card/80">
        <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-2">
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
            rows={1}
            placeholder={isZh ? "输入修改要求..." : "Enter request..."}
            className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 max-h-[180px]"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground/60">{canStop ? "运行中" : "可发送"}</span>
            <button
              type="button"
              onClick={() => {
                if (!activeSessionId) return;
                if (canStop) {
                  void stopMessage(activeSessionId);
                  return;
                }
                onSend();
              }}
              disabled={!activeSessionId || (!canStop && !input.trim()) || stopping}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-30"
            >
              {canStop ? <Square size={12} fill="currentColor" /> : <ArrowUp size={14} />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}


