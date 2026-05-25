import { useEffect, useRef, useCallback, useState } from "react";

export interface SSEMessage {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: number;
}

/**
 * 低频关键状态事件 — 保留在独立缓冲区，不会被高频 delta 事件挤出。
 * 用于 token 用量查询、任务状态追踪等。
 */
const STATE_EVENTS: ReadonlySet<string> = new Set([
  "agent:start",
  "agent:usage",
  "agent:complete",
  "agent:stopped",
  "agent:error",
  "book-task:created",
  "book-task:update",
  "book-task:progress",
  "book-task:stage",
  "book-task:log",
  "book-task:complete",
  "book-task:error",
  "book-task:stop",
  "book-task:resume",
]);

export const STUDIO_SSE_EVENTS = [
  "book:creating",
  "book:created",
  "book:deleted",
  "book:error",
  "write:start",
  "write:complete",
  "write:error",
  "draft:start",
  "draft:complete",
  "draft:error",
  "daemon:chapter",
  "daemon:started",
  "daemon:stopped",
  "daemon:error",
  "agent:start",
  "agent:usage",
  "agent:complete",
  "agent:stopped",
  "agent:error",
  "session:title",
  "audit:start",
  "audit:complete",
  "audit:error",
  "revise:start",
  "revise:complete",
  "revise:error",
  "rewrite:start",
  "rewrite:complete",
  "rewrite:error",
  "rewrite:risk",
  "book-task:created",
  "book-task:update",
  "book-task:progress",
  "book-task:stage",
  "book-task:log",
  "book-task:complete",
  "book-task:error",
  "book-task:stop",
  "book-task:resume",
  "approve:start",
  "approve:complete",
  "approve:error",
  "delete:start",
  "delete:complete",
  "delete:error",
  "style:start",
  "style:complete",
  "style:error",
  "import:start",
  "import:complete",
  "import:error",
  "fanfic:start",
  "fanfic:complete",
  "fanfic:error",
  "fanfic:refresh:start",
  "fanfic:refresh:complete",
  "fanfic:refresh:error",
  "thinking:start",
  "thinking:delta",
  "thinking:end",
  "draft:delta",
  "tool:update",
  "chapter:delta",
  "batch:progress",
  "persist:check",
  "persist:repair",
  "radar:start",
  "radar:complete",
  "radar:error",
  "log",
  "llm:progress",
  "ping",
] as const;

export function useSSE(url = "/api/v1/events") {
  const [messages, setMessages] = useState<ReadonlyArray<SSEMessage>>([]);
  const [stateMessages, setStateMessages] = useState<ReadonlyArray<SSEMessage>>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const handleEvent = (e: MessageEvent) => {
      try {
        const data = e.data ? JSON.parse(e.data) : null;
        const msg: SSEMessage = { event: e.type, data, timestamp: Date.now() };
        if (STATE_EVENTS.has(e.type)) {
          setStateMessages((prev) => [...prev.slice(-49), msg]);
        }
        // 所有事件仍写入 messages（保持向后兼容），但 messages 只保留100条
        setMessages((prev) => [...prev.slice(-99), msg]);
      } catch {
        // ignore parse errors
      }
    };

    for (const event of STUDIO_SSE_EVENTS) {
      es.addEventListener(event, handleEvent);
    }

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url]);

  const clear = useCallback(() => {
    setMessages([]);
    setStateMessages([]);
  }, []);

  return { messages, stateMessages, connected, clear };
}
