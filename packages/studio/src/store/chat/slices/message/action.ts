import type { StateCreator } from "zustand";
import type {
  AgentResponse,
  ChatStore,
  MessageActions,
  Message,
  MessagePart,
  SessionResponse,
  SessionSummary,
} from "../../types";
import { fetchJson } from "../../../../hooks/use-api";
import { withErrorGuidance } from "../../../../utils/error-guidance";
import { attachSessionStreamListeners } from "./stream-events";
import {
  buildAgentRunId,
  bookKey,
  createSessionRuntime,
  deserializeMessages,
  extractErrorMessage,
  isExplicitWriteNextCommand,
  mergeSessionIds,
  updateSession,
  upsertSessionSummary,
} from "./runtime";

function supportsEventSourceListeners(es: EventSource): es is EventSource & {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
} {
  return typeof (es as { addEventListener?: unknown }).addEventListener === "function"
    && typeof (es as { removeEventListener?: unknown }).removeEventListener === "function";
}

interface AgentRunStatusResponse {
  readonly ok?: boolean;
  readonly running?: boolean;
  readonly sessionId?: string;
  readonly runId?: string | null;
  readonly startedAt?: number;
  readonly aborted?: boolean;
}

async function waitForEventSourceReady(es: EventSource, timeoutMs = 1500): Promise<void> {
  if (!supportsEventSourceListeners(es)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      clearTimeout(timer);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onOpen = () => finish(() => resolve());
    const onError = () => finish(() => reject(new Error("SSE connection not ready")));
    const timer = setTimeout(() => finish(() => reject(new Error("SSE connection timeout"))), timeoutMs);

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
  });
}

async function waitForAgentTerminalEvent(
  es: EventSource,
  sessionId: string,
  runId: string,
  timeoutMs = 1200,
): Promise<void> {
  if (!supportsEventSourceListeners(es)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const terminalEvents = ["agent:complete", "agent:error", "agent:stopped"] as const;

    const cleanup = () => {
      for (const eventName of terminalEvents) {
        es.removeEventListener(eventName, onTerminal);
      }
      clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onTerminal = (event: MessageEvent) => {
      try {
        const data = event.data ? JSON.parse(event.data) : null;
        if (!data || typeof data !== "object") return;
        if ((data as { sessionId?: unknown }).sessionId !== sessionId) return;
        if ((data as { runId?: unknown }).runId !== runId) return;
        finish();
      } catch {
        // ignore malformed terminal payload and wait for timeout/next event
      }
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    for (const eventName of terminalEvents) {
      es.addEventListener(eventName, onTerminal);
    }
  });
}

function isTimeoutLikeError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.toLowerCase();
  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("请求超时")
    || message.includes("后台可能仍在执行");
}

async function pollAgentRunningStatus(args: {
  readonly sessionId: string;
  readonly runId: string;
  readonly retries?: number;
  readonly intervalMs?: number;
}): Promise<boolean> {
  const retries = Math.max(1, Math.trunc(args.retries ?? 8));
  const intervalMs = Math.max(120, Math.trunc(args.intervalMs ?? 800));
  for (let i = 0; i < retries; i += 1) {
    try {
      const query = `/agent/status?sessionId=${encodeURIComponent(args.sessionId)}&runId=${encodeURIComponent(args.runId)}`;
      const status = await fetchJson<AgentRunStatusResponse>(query, { method: "GET" });
      if (status.running === true) {
        return true;
      }
      if (status.running === false) {
        return false;
      }
    } catch {
      // Ignore status probe failures and continue retrying.
    }
    if (i < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return false;
}

function normalizeMissingChapterNumbers(details: unknown): number[] {
  if (!details || typeof details !== "object") return [];
  const writeIntegrity = (details as { writeIntegrity?: unknown }).writeIntegrity;
  if (!writeIntegrity || typeof writeIntegrity !== "object") return [];
  const missing = (writeIntegrity as { missingChapterFiles?: unknown }).missingChapterFiles;
  if (!Array.isArray(missing)) return [];
  return missing
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function normalizeIntegrityCounts(details: unknown): { beforeCount?: number; afterCount?: number } {
  if (!details || typeof details !== "object") return {};
  const writeIntegrity = (details as { writeIntegrity?: unknown }).writeIntegrity;
  if (!writeIntegrity || typeof writeIntegrity !== "object") return {};
  const beforeCountRaw = (writeIntegrity as { beforeCount?: unknown }).beforeCount;
  const afterCountRaw = (writeIntegrity as { afterCount?: unknown }).afterCount;
  const beforeCount = Number(beforeCountRaw);
  const afterCount = Number(afterCountRaw);
  return {
    ...(Number.isFinite(beforeCount) ? { beforeCount } : {}),
    ...(Number.isFinite(afterCount) ? { afterCount } : {}),
  };
}

function normalizeDegradedWrite(details: unknown): {
  degradedChapterNumbers: number[];
  attempted: boolean;
  attemptedChapterNumber?: number;
  suggestion?: string;
} {
  if (!details || typeof details !== "object") {
    return { degradedChapterNumbers: [], attempted: false };
  }
  const writeIntegrity = (details as { writeIntegrity?: unknown }).writeIntegrity;
  const degradedFromIntegrity = writeIntegrity && typeof writeIntegrity === "object"
    ? (writeIntegrity as { degradedChapterNumbers?: unknown }).degradedChapterNumbers
    : undefined;
  const degradedRecovery = (details as { degradedRecovery?: unknown }).degradedRecovery;
  const degradedFromRecovery = degradedRecovery && typeof degradedRecovery === "object"
    ? (degradedRecovery as { remainingDegradedChapterNumbers?: unknown }).remainingDegradedChapterNumbers
    : undefined;
  const chapterNumbers = Array.isArray(degradedFromRecovery)
    ? degradedFromRecovery
    : Array.isArray(degradedFromIntegrity)
      ? degradedFromIntegrity
      : [];
  const normalizedChapterNumbers = chapterNumbers
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const attempted = degradedRecovery && typeof degradedRecovery === "object"
    ? Boolean((degradedRecovery as { attempted?: unknown }).attempted)
    : false;
  const attemptedChapterNumberRaw = degradedRecovery && typeof degradedRecovery === "object"
    ? (degradedRecovery as { attemptedChapterNumber?: unknown }).attemptedChapterNumber
    : undefined;
  const attemptedChapterNumber = Number(attemptedChapterNumberRaw);
  const suggestionRaw = degradedRecovery && typeof degradedRecovery === "object"
    ? (degradedRecovery as { suggestion?: unknown }).suggestion
    : undefined;
  return {
    degradedChapterNumbers: normalizedChapterNumbers,
    attempted,
    ...(Number.isFinite(attemptedChapterNumber) && attemptedChapterNumber > 0
      ? { attemptedChapterNumber }
      : {}),
    ...(typeof suggestionRaw === "string" && suggestionRaw.trim() ? { suggestion: suggestionRaw.trim() } : {}),
  };
}

function mapExplicitWriteFailure(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const apiError = error as { name?: unknown; code?: unknown; details?: unknown };
  if (apiError.name !== "ApiRequestError") return null;
  const code = typeof apiError.code === "string" ? apiError.code : null;
  if (code === "AGENT_WRITE_NOT_EXECUTED") {
    return withErrorGuidance("写作失败：未触发写作器（writer），章节未生成。");
  }
  if (code === "AGENT_WRITE_NOT_PERSISTED") {
    const missingChapterNumbers = normalizeMissingChapterNumbers(apiError.details);
    if (missingChapterNumbers.length > 0) {
      return withErrorGuidance(`写作失败：章节正文未落盘（第${missingChapterNumbers.join("、")}章）。`);
    }
    const { beforeCount, afterCount } = normalizeIntegrityCounts(apiError.details);
    if (
      typeof beforeCount === "number"
      && typeof afterCount === "number"
      && afterCount <= beforeCount
    ) {
      return withErrorGuidance("写作失败：未检测到新章节索引写入。");
    }
    return withErrorGuidance("写作失败：章节未完成落盘或索引更新。");
  }
  if (code === "AGENT_WRITE_DEGRADED") {
    const degraded = normalizeDegradedWrite(apiError.details);
    const chapterText = degraded.degradedChapterNumbers.length > 0
      ? `第${degraded.degradedChapterNumbers.join("、")}章`
      : "目标章节";
    const recoveryText = degraded.attempted
      ? `已自动尝试修复${degraded.attemptedChapterNumber ? `（第${degraded.attemptedChapterNumber}章）` : ""}但仍未恢复。`
      : "未执行自动修复。";
    return withErrorGuidance(
      `写作降级：正文已落盘，但${chapterText}状态降级。${recoveryText}${degraded.suggestion ? ` ${degraded.suggestion}` : ""}`,
    );
  }
  return null;
}

function finalizeDanglingToolStates(messages: ReadonlyArray<Message>, streamTs: number): ReadonlyArray<Message> {
  const completedAt = Date.now();
  return messages.map((message) => {
    if (message.role !== "assistant" || message.timestamp !== streamTs || !message.parts?.length) {
      return message;
    }
    let changed = false;
    const parts: MessagePart[] = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      if (part.execution.status !== "running" && part.execution.status !== "processing") return part;
      changed = true;
      return {
        type: "tool" as const,
        execution: {
          ...part.execution,
          status: "completed",
          completedAt,
          stages: part.execution.stages?.map((stage) =>
            stage.status === "completed"
              ? stage
              : { ...stage, status: "completed" as const, progress: undefined },
          ),
          ...(part.execution.result
            ? {}
            : {
                result: part.execution.logs?.at(-1)?.trim()
                  || "completed",
              }),
        },
      };
    });
    if (!changed) return message;
    return {
      ...message,
      parts,
      toolExecutions: parts
        .filter((part): part is Extract<MessagePart, { type: "tool" }> => part.type === "tool")
        .map((part) => part.execution),
    };
  });
}

function finalizeSessionStreamState(
  set: Parameters<StateCreator<ChatStore, [], [], MessageActions>>[0],
  sessionId: string,
  streamTs: number,
  streamEs: EventSource,
  runId: string,
): void {
  set((state) => ({
    sessions: updateSession(state.sessions, sessionId, (runtime) => {
      const shouldFinalizeMessages = runtime.currentRunId === runId;
      const shouldCloseStreamingFlags = runtime.currentRunId === runId;
      return {
        ...(shouldFinalizeMessages
          ? { messages: finalizeDanglingToolStates(runtime.messages, streamTs) }
          : {}),
        ...(shouldCloseStreamingFlags
          ? {
              isStreaming: false,
              isStopping: false,
              currentRunId: null,
            }
          : {}),
        stream: runtime.stream === streamEs ? null : runtime.stream,
      };
    }),
  }));
}

export const createMessageSlice: StateCreator<ChatStore, [], [], MessageActions> = (set, get) => ({
  activateSession: (sessionId) =>
    set({ activeSessionId: sessionId }),

  setInput: (text) => set({ input: text }),

  addUserMessage: (sessionId, content) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "user", content, timestamp: Date.now() }],
        lastError: null,
      })),
    })),

  appendAssistantMessage: (sessionId, content) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "assistant", content, timestamp: Date.now() }],
      })),
    })),

  appendStreamChunk: (sessionId, text, streamTs) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => {
        const last = session.messages[session.messages.length - 1];
        if (last?.timestamp === streamTs && last.role === "assistant") {
          return {
            messages: [...session.messages.slice(0, -1), { ...last, content: last.content + text }],
          };
        }
        return {
          messages: [...session.messages, { role: "assistant", content: text, timestamp: streamTs }],
        };
      }),
    })),

  finalizeStream: (sessionId, streamTs, content, toolCall) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: session.messages.map((message) => {
          if (message.timestamp !== streamTs || message.role !== "assistant") return message;
          const parts = [...(message.parts ?? [])];
          const lastPart = parts[parts.length - 1];
          if (lastPart?.type === "text") {
            // Preserve streamed content (e.g. chapter:delta events) when it's
            // more substantial than the finalization summary.
            if (content && lastPart.content.length > content.length) {
              return { ...message, toolCall, parts };
            }
            parts[parts.length - 1] = { ...lastPart, content };
          } else if (content) {
            parts.push({ type: "text", content });
          }
          return { ...message, content, toolCall, parts };
        }),
      })),
    })),

  replaceStreamWithError: (sessionId, streamTs, errorMsg) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [
          ...session.messages.filter(
            (message) => !(message.timestamp === streamTs && message.role === "assistant"),
          ),
          { role: "assistant", content: `\u2717 ${errorMsg}`, timestamp: Date.now() },
        ],
        isStreaming: false,
        lastError: errorMsg,
        stream: null,
      })),
    })),

  addErrorMessage: (sessionId, errorMsg) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "assistant", content: `\u2717 ${errorMsg}`, timestamp: Date.now() }],
        lastError: errorMsg,
      })),
    })),

  loadSessionMessages: (sessionId, msgs) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => {
        if (session.messages.length > 0) return {};
        return { messages: deserializeMessages(msgs) };
      }),
    })),

  setSelectedModel: (model, service) => set({ selectedModel: model, selectedService: service }),

  loadSessionList: async (bookId) => {
    const query = bookId === null ? "null" : encodeURIComponent(bookId);
    try {
      const data = await fetchJson<{ sessions: ReadonlyArray<SessionSummary> }>(`/sessions?bookId=${query}`);
      set((state) => {
        let sessions = state.sessions;
        for (const summary of data.sessions) {
          sessions = upsertSessionSummary(sessions, summary);
        }
        return {
          sessions,
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(bookId)]: data.sessions.map((session) => session.sessionId),
          },
        };
      });
    } catch {
      // ignore
    }
  },

  createSession: async (bookId) => {
    const data = await fetchJson<SessionResponse>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId }),
    });
    const sessionId = data.session?.sessionId;
    if (!sessionId) {
      throw new Error("Failed to create session");
    }

    set((state) => {
      const runtime = createSessionRuntime({
        sessionId,
        bookId: data.session?.bookId ?? bookId ?? null,
        title: data.session?.title ?? null,
      });
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: runtime,
        },
        sessionIdsByBook: {
          ...state.sessionIdsByBook,
          [bookKey(runtime.bookId)]: mergeSessionIds(
            state.sessionIdsByBook[bookKey(runtime.bookId)],
            [sessionId],
          ),
        },
        activeSessionId: sessionId,
      };
    });

    return sessionId;
  },

  createDraftSession: (bookId) => {
    // 前端生成 sessionId（与后端 createBookSession 同格式），暂不持久化到磁盘，
    // 也暂不写入 sessionIdsByBook——侧边栏看不到这条 draft。
    // 发送第一条消息时 sendMessage 会调 POST /sessions { sessionId, bookId } 落盘
    // 并把 id 追加进 sessionIdsByBook，那一刻侧边栏才出现该会话（带着 title）。
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => {
      const runtime = createSessionRuntime({
        sessionId,
        bookId,
        title: null,
        isDraft: true,
      });
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: runtime,
        },
        activeSessionId: sessionId,
      };
    });
    return sessionId;
  },

  renameSession: async (sessionId, title) => {
    const previous = get().sessions[sessionId]?.title ?? null;
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({ title })),
    }));

    try {
      await fetchJson(`/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch {
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, () => ({ title: previous })),
      }));
    }
  },

  deleteSession: async (sessionId) => {
    const session = get().sessions[sessionId];
    session?.stream?.close();
    // 草稿会话还没写到磁盘，跳过 DELETE 请求避免后端返回 404
    if (session && !session.isDraft) {
      try {
        await fetchJson(`/sessions/${sessionId}`, { method: "DELETE" });
      } catch {
        // ignore
      }
    }

    set((state) => {
      const { [sessionId]: deleted, ...rest } = state.sessions;
      const sessionIdsByBook = Object.fromEntries(
        Object.entries(state.sessionIdsByBook).map(([key, ids]) => [
          key,
          ids.filter((id) => id !== sessionId),
        ]),
      );

      let activeSessionId = state.activeSessionId;
      if (activeSessionId === sessionId) {
        const fallbackKey = bookKey(session?.bookId ?? null);
        activeSessionId = sessionIdsByBook[fallbackKey]?.[0] ?? null;
      }

      return {
        sessions: rest,
        sessionIdsByBook,
        activeSessionId,
      };
    });
  },

  loadSessionDetail: async (sessionId) => {
    // 草稿会话：磁盘上还没有文件，直接跳过远端拉取。
    // 本地已有消息：不拉取远端，避免流式中或未持久化的消息被覆盖。
    const existing = get().sessions[sessionId];
    if (existing?.isDraft) return;
    if (existing && existing.messages.length > 0) return;

    try {
      const data = await fetchJson<SessionResponse>(`/sessions/${sessionId}`);
      const detail = data.session;
      if (!detail?.sessionId) return;
      const detailSessionId = detail.sessionId;
      const messages = detail.messages ? deserializeMessages(detail.messages) : [];

      set((state) => {
        const runtime = state.sessions[detailSessionId];
        // set 执行到这里可能已有本地消息写入（比如并发 sendMessage），再查一次。
        if (runtime && runtime.messages.length > 0) return {};
        const nextBookId = detail.bookId ?? runtime?.bookId ?? null;
        return {
          sessions: {
            ...state.sessions,
            [detailSessionId]: {
              ...(runtime ?? createSessionRuntime({
                sessionId: detailSessionId,
                bookId: nextBookId,
                title: detail.title ?? null,
              })),
              bookId: nextBookId,
              title: detail.title ?? runtime?.title ?? null,
              messages,
            },
          },
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(nextBookId)]: mergeSessionIds(
              state.sessionIdsByBook[bookKey(nextBookId)],
              [detailSessionId],
            ),
          },
        };
      });
    } catch {
      // ignore
    }
  },

  stopMessage: async (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session) return;

    const runId = session.currentRunId;
    session.stream?.close();

    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({
        stream: null,
        isStreaming: false,
        isStopping: true,
        stoppedByUser: true,
        currentRunId: null,
      })),
    }));

    if (!runId) {
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, () => ({ isStopping: false })),
      }));
      return;
    }

    try {
      await fetchJson("/agent/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, runId }),
      });
    } catch {
      // Ignore stop failures: local UI already switched to stopped state.
    } finally {
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, () => ({ isStopping: false })),
      }));
    }
  },

  sendMessage: async (sessionId, text, activeBookId) => {
    const trimmed = text.trim();
    const session = get().sessions[sessionId];
    if (!trimmed || !session || session.isStreaming) return;
    const expectsPersistedWrite = Boolean(activeBookId && isExplicitWriteNextCommand(trimmed));

    if (!get().selectedModel) {
      get().addUserMessage(sessionId, trimmed);
      get().addErrorMessage(sessionId, "请先选择一个模型");
      return;
    }

    // 草稿会话：第一条消息发送时才真正把 session 文件写到磁盘。
    // 后端 POST /sessions 支持接受客户端传入的 sessionId，所以 id 保持一致，
    // 前端 store 里的 runtime 不用 remount，只需要把 isDraft 翻成 false。
    if (session.isDraft) {
      try {
        await fetchJson<SessionResponse>("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, bookId: session.bookId }),
        });
        // 落盘成功：把 isDraft 翻成 false，同时把 sessionId 追加进 sessionIdsByBook
        // 让侧边栏现在才看到这条会话。
        set((state) => ({
          sessions: updateSession(state.sessions, sessionId, () => ({ isDraft: false })),
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(session.bookId)]: mergeSessionIds(
              state.sessionIdsByBook[bookKey(session.bookId)],
              [sessionId],
            ),
          },
        }));
      } catch (err) {
        get().addErrorMessage(sessionId, err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const instruction = activeBookId ? trimmed : `/new ${trimmed}`;
    const streamTs = Date.now() + 1;
    const runId = buildAgentRunId();

    set((state) => ({
      input: "",
      activeSessionId: sessionId,
      sessions: updateSession(state.sessions, sessionId, () => ({
        isStreaming: true,
        isStopping: false,
        stoppedByUser: false,
        currentRunId: runId,
        lastError: null,
      })),
    }));

    get().addUserMessage(sessionId, trimmed);
    session.stream?.close();
    const streamEs = new EventSource("/api/v1/events");
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({ stream: streamEs })),
    }));
    attachSessionStreamListeners({ sessionId, runId, streamTs, streamEs, set, get });

    try {
      // Reduce race window where early SSE events (tool:start/log/chapter:delta) are emitted
      // before the browser stream is fully opened.
      try {
        await waitForEventSourceReady(streamEs, 1500);
      } catch {
        // Do not block request on flaky networks; runtime fallback handlers still recover.
      }

      const data = await fetchJson<AgentResponse>("/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          activeBookId,
          sessionId,
          runId,
          model: get().selectedModel ?? undefined,
          service: get().selectedService ?? undefined,
        }),
      });

      if (get().sessions[sessionId]?.currentRunId !== runId) {
        return;
      }
      const persistedWrite = (data.details as {
        effects?: { writeNext?: { persisted?: boolean } };
      } | undefined)?.effects?.writeNext?.persisted === true;
      if (expectsPersistedWrite && !persistedWrite) {
        const writeError = withErrorGuidance("写作失败：未确认章节落盘（缺少 persisted 信号）。");
        const hasStream = Boolean(
          get().sessions[sessionId]?.messages.some(
            (message) => message.timestamp === streamTs && message.role === "assistant",
          ),
        );
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, writeError);
        } else {
          get().addErrorMessage(sessionId, writeError);
        }
        return;
      }

      const finalContent = data.details?.draftRaw || data.response || "";
      const toolCall = data.details?.toolCall ?? undefined;
      const hasStream = Boolean(
        get().sessions[sessionId]?.messages.some(
          (message) => message.timestamp === streamTs && message.role === "assistant",
        ),
      );

      if (data.error) {
        const errorMessage = withErrorGuidance(extractErrorMessage(data.error));
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, errorMessage);
        } else {
          get().addErrorMessage(sessionId, errorMessage);
        }
      } else if (finalContent) {
        if (hasStream) {
          get().finalizeStream(sessionId, streamTs, finalContent, toolCall);
        } else {
          set((state) => ({
            sessions: updateSession(state.sessions, sessionId, (runtime) => ({
              messages: [
                ...runtime.messages,
                {
                  role: "assistant",
                  content: finalContent,
                  timestamp: Date.now(),
                  toolCall,
                },
              ],
            })),
          }));
        }
        if (toolCall?.name === "create_book") {
          set((state) => ({
            sessions: updateSession(state.sessions, sessionId, () => ({
              pendingBookArgs: { ...toolCall.arguments },
            })),
          }));
        }
      } else {
        const emptyMessage = withErrorGuidance(
          "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。",
        );
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, emptyMessage);
        } else {
          get().addErrorMessage(sessionId, emptyMessage);
        }
      }
    } catch (error) {
      if (get().sessions[sessionId]?.currentRunId !== runId) {
        return;
      }
      if (isTimeoutLikeError(error)) {
        const stillRunning = await pollAgentRunningStatus({ sessionId, runId });
        if (stillRunning && get().sessions[sessionId]?.currentRunId === runId) {
          return;
        }
      }
      const mappedWriteError = expectsPersistedWrite ? mapExplicitWriteFailure(error) : null;
      const errorMessage = mappedWriteError ?? withErrorGuidance(error instanceof Error ? error.message : String(error));
      const hasStream = Boolean(
        get().sessions[sessionId]?.messages.some(
          (message) => message.timestamp === streamTs && message.role === "assistant",
        ),
      );
      if (hasStream) {
        get().replaceStreamWithError(sessionId, streamTs, errorMessage);
      } else {
        get().addErrorMessage(sessionId, errorMessage);
      }
    } finally {
      const shouldWaitForTerminal = get().sessions[sessionId]?.currentRunId === runId;
      if (shouldWaitForTerminal) {
        try {
          await waitForAgentTerminalEvent(streamEs, sessionId, runId, 1200);
        } catch {
          // no-op: timeout fallback still closes stream below
        }
      }
      streamEs.close();
      finalizeSessionStreamState(set, sessionId, streamTs, streamEs, runId);
    }
  },
});
