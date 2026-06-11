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
import type { BookCreationDraft, BookCreationWizardState } from "@actalk/inkos-core";

function supportsEventSourceListeners(es: EventSource): es is EventSource & {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
} {
  return typeof (es as { addEventListener?: unknown }).addEventListener === "function"
    && typeof (es as { removeEventListener?: unknown }).removeEventListener === "function";
}

function normalizeBookCreationDraft(value: unknown): BookCreationDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as BookCreationDraft;
}

function normalizeBookCreationWizard(value: unknown): BookCreationWizardState | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as BookCreationWizardState;
}

function isCustomServiceId(service: string): boolean {
  return service === "custom" || service.startsWith("custom:");
}

function resolveCustomServiceName(service: string): string {
  const rawName = service.startsWith("custom:") ? decodeURIComponent(service.slice("custom:".length)) : "";
  const name = rawName.trim();
  return name.length > 0 ? name : "Custom";
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
    || message.includes("超时")
    || message.includes("后端可能仍在执行")
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
      return withErrorGuidance(`写作失败：章节正文未落库（第 ${missingChapterNumbers.join("、")} 章）。`);
    }
    const { beforeCount, afterCount } = normalizeIntegrityCounts(apiError.details);
    if (
      typeof beforeCount === "number"
      && typeof afterCount === "number"
      && afterCount <= beforeCount
    ) {
      return withErrorGuidance("写作失败：未检测到新章节索引写入。");
    }
    return withErrorGuidance("写作失败：章节未完成落库或索引未更新。");
  }
  if (code === "AGENT_WRITE_DEGRADED") {
    const degraded = normalizeDegradedWrite(apiError.details);
    const chapterText = degraded.degradedChapterNumbers.length > 0
      ? `第 ${degraded.degradedChapterNumbers.join("、")} 章`
      : "目标章节";
    const recoveryText = degraded.attempted
      ? `已尝试自动修复${degraded.attemptedChapterNumber ? `（第 ${degraded.attemptedChapterNumber} 章）` : ""}，但仍未恢复。`
      : "未执行自动修复。";
    return withErrorGuidance(
      `写作降级：正文已落库，但 ${chapterText} 状态降级。${recoveryText}${degraded.suggestion ? ` ${degraded.suggestion}` : ""}`,
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

function looksLikeFinalizationSummary(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return /已重写|已完成|已保存|总结|汇报|相较|相比|未改动|重新生成|完成重写|重写完成/i.test(trimmed)
    && !/^#{1,6}\s+/m.test(trimmed)
    && trimmed.length < 120;
}

function looksLikeIntroMarkdownBody(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^(已|好的|我来|我先|正在|开始|生成|修改|润色|总结|汇报|说明)/.test(trimmed)) return false;
  return /(^|\n)\s*#\s+/.test(trimmed)
    || /(^|\n)\s*##\s+(一句话卖点|故事概述|故事走向|主要人物成长路径|核心冲突|核心价值观)/.test(trimmed);
}

function scoreIntroMarkdownBody(content: string): number {
  const trimmed = content.trim();
  if (!looksLikeIntroMarkdownBody(trimmed)) return Number.NEGATIVE_INFINITY;
  const requiredSections = [
    "一句话卖点",
    "故事概述",
    "故事走向",
    "主要人物成长路径",
    "核心冲突",
    "核心价值观",
  ];
  const sectionCount = requiredSections.filter((section) => trimmed.includes(section)).length;
  const concreteLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !/^#/.test(line)
      && !/^-+\s*$/.test(line)
      && line !== "-"
      && line !== "—"
      && line !== "…"
      && line !== "..."
      && !/^(题材|平台|主题)[:：]/.test(line),
    );
  const substantiveCount = concreteLines.filter((line) => line.length >= 8).length;
  const placeholderCount = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line === "-" || line === "—" || line === "…" || line === "..." || /^-\s*$/.test(line))
    .length;
  return sectionCount * 100 + substantiveCount * 12 + Math.min(500, trimmed.length / 2) - placeholderCount * 40;
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

  addUserMessage: (sessionId, content, wizardStep) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "user", content, ...(wizardStep ? { wizardStep } : {}), timestamp: Date.now() }],
        lastError: null,
      })),
    })),

  appendAssistantMessage: (sessionId, content, wizardStep) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "assistant", content, ...(wizardStep ? { wizardStep } : {}), timestamp: Date.now() }],
      })),
    })),

  replaceWizardStepMessage: (sessionId, wizardStep, content) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => {
        let replaced = false;
        const nextMessages = [...session.messages];
        for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
          const message = nextMessages[index];
          if (message?.role !== "assistant" || message.wizardStep !== wizardStep) continue;
          nextMessages[index] = { ...message, content };
          replaced = true;
          break;
        }
        if (replaced) {
          return { messages: nextMessages };
        }
        return {
          messages: [...session.messages, { role: "assistant", content, wizardStep, timestamp: Date.now() }],
        };
      }),
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
          const lastTextIndex = [...parts].reverse().findIndex((part) => part.type === "text");
          const textIndex = lastTextIndex >= 0 ? parts.length - 1 - lastTextIndex : -1;
          const lastPart = textIndex >= 0 ? parts[textIndex] : parts[parts.length - 1];
          const streamedText = parts
            .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
            .map((part) => part.content)
            .join("");
          const finalSummary = looksLikeFinalizationSummary(content);
          const keepStreamedIntroBody = message.wizardStep === "intro"
            && looksLikeIntroMarkdownBody(streamedText);
          if (streamedText && (finalSummary || keepStreamedIntroBody)) {
            return { ...message, toolCall, parts, content: streamedText };
          }
          if (lastPart?.type === "text") {
            parts[parts.length - 1] = { ...lastPart, content: content || lastPart.content };
          } else if (content) {
            parts.push({ type: "text", content });
          }
          return { ...message, content: content || streamedText, toolCall, parts };
        }),
      })),
    })),

  replaceStreamWithError: (sessionId, streamTs, errorMsg, wizardStep) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [
          ...session.messages.filter(
            (message) => !(message.timestamp === streamTs && message.role === "assistant"),
          ),
          { role: "assistant", content: `\u2717 ${errorMsg}`, ...(wizardStep ? { wizardStep } : {}), timestamp: Date.now() },
        ],
        isStreaming: false,
        lastError: errorMsg,
        stream: null,
      })),
    })),

  addErrorMessage: (sessionId, errorMsg, wizardStep) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "assistant", content: `\u2717 ${errorMsg}`, ...(wizardStep ? { wizardStep } : {}), timestamp: Date.now() }],
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

  setSelectedModel: (model, service, options) => {
    set({ selectedModel: model, selectedService: service });
    if (options?.persist === false) {
      return;
    }
    void fetchJson("/services/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service,
        defaultModel: model,
        services: [
          isCustomServiceId(service)
            ? {
                service: "custom",
                name: resolveCustomServiceName(service),
                preferredModel: model,
              }
            : {
                service,
                preferredModel: model,
              },
        ],
      }),
    })
      .then(() => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("inkos:api-invalidate", {
            detail: { paths: ["/api/v1/services/config"] },
          }));
        }
      })
      .catch(() => {
        // Ignore persistence failures and keep the in-memory selection.
      });
  },

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
    // 閸撳秶顏悽鐔稿灇 sessionId閿涘牅绗岄崥搴ｎ伂 createBookSession 閸氬本鐗稿蹇ョ礆閿涘本娈忔稉宥嗗瘮娑斿懎瀵查崚鎵梿閻╂﹫绱?
    // 娑旂喐娈忔稉宥呭晸閸?sessionIdsByBook閳ユ柡鈧柧鏅舵潏瑙勭埉閻绗夐崚鎷岀箹閺?draft閵?
    // 閸欐垿鈧胶顑囨稉鈧弶鈩冪Х閹垱妞?sendMessage 娴兼俺鐨?POST /sessions { sessionId, bookId } 閽€鐣屾磸
    // 楠炶埖濡?id 鏉╄棄濮炴潻?sessionIdsByBook閿涘矂鍋呮稉鈧崚璁虫櫠鏉堣鐖幍宥呭毉閻滄媽顕氭导姘崇樈閿涘牆鐢惈鈧?title閿涘鈧?
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => {
      const runtime = createSessionRuntime({
        sessionId,
        bookId,
        title: null,
        hasWizardStepMessage: true,
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
    // 閼藉顭堟导姘崇樈鏉╂ɑ鐥呴崘娆忓煂绾句胶娲忛敍宀冪儲鏉?DELETE 鐠囬攱鐪伴柆鍨帳閸氬海顏潻鏂挎礀 404
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
    try {
      const data = await fetchJson<SessionResponse>(`/sessions/${sessionId}`);
      const detail = data.session;
      if (!detail?.sessionId) return;
      const detailSessionId = detail.sessionId;
      const messages = detail.messages ? deserializeMessages(detail.messages) : [];

      set((state) => {
        const runtime = state.sessions[detailSessionId];
        const nextBookId = detail.bookId ?? runtime?.bookId ?? null;
        const hasLiveStream = Boolean(runtime?.stream);
        const nextRuntime = runtime ?? createSessionRuntime({
          sessionId: detailSessionId,
          bookId: nextBookId,
          title: detail.title ?? null,
        });
        const detailDraft = normalizeBookCreationDraft(detail.creationDraft);
        const detailWizard = normalizeBookCreationWizard(detail.creationWizard);
        return {
          sessions: {
            ...state.sessions,
            [detailSessionId]: {
              ...nextRuntime,
              bookId: nextBookId,
              title: detail.title ?? runtime?.title ?? null,
              messages: hasLiveStream ? runtime?.messages ?? messages : messages,
              stream: runtime?.stream ?? null,
              isStreaming: hasLiveStream ? runtime?.isStreaming ?? false : false,
              isStopping: hasLiveStream ? runtime?.isStopping ?? false : false,
              stoppedByUser: hasLiveStream ? runtime?.stoppedByUser ?? false : false,
              currentRunId: hasLiveStream ? runtime?.currentRunId ?? null : null,
              lastError: hasLiveStream ? runtime?.lastError ?? null : null,
              ...(detailDraft ? { creationDraft: detailDraft } : {}),
              ...(detailWizard ? { creationWizard: detailWizard } : {}),
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

  sendMessage: async (sessionId, text, activeBookId, options) => {
    const trimmed = text.trim();
    const session = get().sessions[sessionId];
    if (!trimmed || !session || session.isStreaming) return null;
    const expectsPersistedWrite = Boolean(activeBookId && isExplicitWriteNextCommand(trimmed));

    if (!get().selectedModel) {
      get().addUserMessage(sessionId, trimmed, options?.wizardStep);
      get().addErrorMessage(sessionId, "请选择一个模型。");
      return null;
    }

    // 閼藉顭堟导姘崇樈閿涙氨顑囨稉鈧弶鈩冪Х閹垰褰傞柅浣规閹靛秶婀″锝嗗Ω session 閺傚洣娆㈤崘娆忓煂绾句胶娲忛妴?
    // 閸氬海顏?POST /sessions 閺€顖涘瘮閹恒儱褰堢€广垺鍩涚粩顖欑炊閸忋儳娈?sessionId閿涘本澧嶆禒?id 娣囨繃瀵旀稉鈧懛杈剧礉
    // 閸撳秶顏?store 闁插瞼娈?runtime 娑撳秶鏁?remount閿涘苯褰ч棁鈧憰浣瑰Ω isDraft 缂堢粯鍨?false閵?
    if (session.isDraft) {
      try {
        await fetchJson<SessionResponse>("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, bookId: session.bookId }),
        });
        // 閽€鐣屾磸閹存劕濮涢敍姘Ω isDraft 缂堢粯鍨?false閿涘苯鎮撻弮鑸靛Ω sessionId 鏉╄棄濮炴潻?sessionIdsByBook
        // 鐠佲晙鏅舵潏瑙勭埉閻滄澘婀幍宥囨箙閸掓媽绻栭弶鈥茬窗鐠囨縿鈧?
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
        return null;
      }
    }

    const instruction = options?.skipAutoNewPrefix
      ? trimmed
      : activeBookId
        ? trimmed
        : trimmed.startsWith("/")
          ? trimmed
          : `/new ${trimmed}`;
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
        ...(options?.wizardStep ? { currentWizardStep: options.wizardStep } : {}),
      })),
    }));

    get().addUserMessage(sessionId, trimmed, options?.wizardStep);
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
          ...(options?.wizardStep ? { wizardStep: options.wizardStep } : {} ),
          ...(options?.wizardAdvance ? { wizardAdvance: options.wizardAdvance } : {}),
          model: get().selectedModel ?? undefined,
          service: get().selectedService ?? undefined,
          ...(options?.quickMode !== undefined ? { quickMode: options.quickMode } : {}),
          ...(options?.preferFastWriterModel !== undefined ? { preferFastWriterModel: options.preferFastWriterModel } : {}),
          ...(options?.forceStream !== undefined ? { forceStream: options.forceStream } : {}),
          ...(options?.responseFormat ? { responseFormat: options.responseFormat } : {}),
        }),
      });

      if (get().sessions[sessionId]?.currentRunId !== runId) {
        return data;
      }
      const persistedWrite = (data.details as {
        effects?: { writeNext?: { persisted?: boolean } };
      } | undefined)?.effects?.writeNext?.persisted === true;
      if (expectsPersistedWrite && !persistedWrite) {
        const writeError = withErrorGuidance("写作失败：未确认章节落库（缺少 persisted 信号）。");
        const hasStream = Boolean(
          get().sessions[sessionId]?.messages.some(
            (message) => message.timestamp === streamTs && message.role === "assistant",
          ),
        );
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, writeError, options?.wizardStep);
        } else {
          get().addErrorMessage(sessionId, writeError, options?.wizardStep);
        }
        return data;
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
          get().replaceStreamWithError(sessionId, streamTs, errorMessage, options?.wizardStep);
        } else {
          get().addErrorMessage(sessionId, errorMessage, options?.wizardStep);
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
                  ...(options?.wizardStep ? { wizardStep: options.wizardStep } : {}),
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
          "模型未返回正文。请检查对话类型（chat/responses）、流式开关或上游服务兼容性。"
        );
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, emptyMessage, options?.wizardStep);
        } else {
          get().addErrorMessage(sessionId, emptyMessage, options?.wizardStep);
        }
      }
      return data;
    } catch (error) {
      if (get().sessions[sessionId]?.currentRunId !== runId) {
        return null;
      }
      if (isTimeoutLikeError(error)) {
        const stillRunning = await pollAgentRunningStatus({ sessionId, runId });
        if (stillRunning && get().sessions[sessionId]?.currentRunId === runId) {
          return null;
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
        get().replaceStreamWithError(sessionId, streamTs, errorMessage, options?.wizardStep);
      } else {
        get().addErrorMessage(sessionId, errorMessage, options?.wizardStep);
      }
      return null;
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
