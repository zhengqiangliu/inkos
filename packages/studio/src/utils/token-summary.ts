import type { SSEMessage } from "../hooks/use-sse";
import type { BookTask } from "../shared/contracts";
import { formatOptionalTokenRate, getTaskLiveTokenRatePerSecond, getTaskTotalTokens, type TaskTokenSample } from "../lib/task-metrics";

type TokenUsageSnapshot = NonNullable<BookTask["tokenUsage"]>;

export interface TokenSummarySnapshot {
  readonly summary: string;
  readonly latestAt: number;
}

function normalizeTokenUsage(value: unknown): TokenUsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as {
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
  };
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

function extractAgentTokenUsage(message: SSEMessage): TokenUsageSnapshot | null {
  if (message.event !== "agent:usage" && message.event !== "agent:complete" && message.event !== "agent:error" && message.event !== "agent:stopped") {
    return null;
  }
  const payload = message.data as {
    sessionId?: unknown;
    runId?: unknown;
    tokenUsage?: unknown;
  } | null;
  return normalizeTokenUsage(payload?.tokenUsage);
}

function extractAgentRunId(message: SSEMessage, sessionId: string): string | null {
  const payload = message.data as {
    sessionId?: unknown;
    runId?: unknown;
  } | null;
  if (payload?.sessionId !== sessionId) return null;
  if (typeof payload.runId === "string" && payload.runId.trim()) return payload.runId;
  return null;
}

export function resolveLatestAgentRunId(
  messages: ReadonlyArray<SSEMessage>,
  sessionId: string,
  currentRunId: string | null | undefined,
): string | null {
  if (currentRunId) return currentRunId;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.event !== "agent:complete" && message.event !== "agent:error" && message.event !== "agent:stopped" && message.event !== "agent:usage" && message.event !== "agent:start") {
      continue;
    }
    const runId = extractAgentRunId(message, sessionId);
    if (runId) return runId;
  }
  return null;
}

export function resolveLatestAgentTokenSnapshot(
  messages: ReadonlyArray<SSEMessage>,
  sessionId: string,
  currentRunId: string | null | undefined,
  nowTick: number,
): TokenSummarySnapshot | null {
  const runId = resolveLatestAgentRunId(messages, sessionId, currentRunId);
  if (!runId) return null;

  const samples: TaskTokenSample[] = [];
  let latestUsage: TokenUsageSnapshot | null = null;
  let latestAt = 0;

  for (const message of messages) {
    const payload = message.data as {
      sessionId?: unknown;
      runId?: unknown;
    } | null;
    if (payload?.sessionId !== sessionId || payload?.runId !== runId) continue;
    const usage = extractAgentTokenUsage(message);
    if (!usage) continue;
    latestUsage = usage;
    latestAt = Math.max(latestAt, message.timestamp);
    samples.push({
      at: message.timestamp,
      totalTokens: usage.totalTokens,
    });
  }

  const liveRate = samples.length > 1 ? getTaskLiveTokenRatePerSecond(samples, nowTick) : null;
  const totalTokens = latestUsage?.totalTokens ?? samples.at(-1)?.totalTokens ?? null;
  if (totalTokens === null && liveRate === null) return null;
  return {
    latestAt,
    summary: `Token：实时 ${formatOptionalTokenRate(liveRate)} · 总计 ${totalTokens === null ? "—" : totalTokens.toLocaleString()}`,
  };
}

export function resolveLatestAgentTokenSummary(
  messages: ReadonlyArray<SSEMessage>,
  sessionId: string,
  currentRunId: string | null | undefined,
  nowTick: number,
): string | null {
  return resolveLatestAgentTokenSnapshot(messages, sessionId, currentRunId, nowTick)?.summary ?? null;
}

function extractTaskTokenUsage(message: SSEMessage): TokenUsageSnapshot | null {
  if (message.event !== "book-task:update" && message.event !== "book-task:progress" && message.event !== "book-task:complete") {
    return null;
  }
  const payload = message.data as {
    bookId?: unknown;
    task?: {
      id?: unknown;
      tokenUsage?: unknown;
      result?: { tokenUsage?: unknown } | null;
      status?: unknown;
    };
    progress?: {
      tokenUsage?: unknown;
    };
  } | null;
  const usage = normalizeTokenUsage(payload?.task?.tokenUsage)
    ?? normalizeTokenUsage(payload?.progress?.tokenUsage)
    ?? normalizeTokenUsage(payload?.task?.result?.tokenUsage);
  return usage;
}

export function resolveLatestBookTaskTokenSnapshot(
  messages: ReadonlyArray<SSEMessage>,
  bookId: string,
  nowTick: number,
): TokenSummarySnapshot | null {
  let latestTaskId: string | null = null;
  let latestAt = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || (message.event !== "book-task:update" && message.event !== "book-task:progress" && message.event !== "book-task:complete")) continue;
    const payload = message.data as {
      bookId?: unknown;
      task?: {
        id?: unknown;
      };
    } | null;
    if (payload?.bookId !== bookId) continue;
    const taskId = typeof payload.task?.id === "string" && payload.task.id.trim() ? payload.task.id : null;
    if (!taskId) continue;
    latestTaskId = taskId;
    latestAt = message.timestamp;
    break;
  }

  if (!latestTaskId) return null;

  const samples: TaskTokenSample[] = [];
  let latestUsage: TokenUsageSnapshot | null = null;

  for (const message of messages) {
    if (message.event !== "book-task:update" && message.event !== "book-task:progress" && message.event !== "book-task:complete") continue;
    const payload = message.data as {
      bookId?: unknown;
      task?: {
        id?: unknown;
        tokenUsage?: unknown;
        result?: { tokenUsage?: unknown } | null;
      };
      progress?: {
        tokenUsage?: unknown;
      };
    } | null;
    if (payload?.bookId !== bookId) continue;
    const taskId = typeof payload.task?.id === "string" && payload.task.id.trim() ? payload.task.id : null;
    if (taskId !== latestTaskId) continue;

    const usage = extractTaskTokenUsage(message);
    if (!usage) continue;
    latestUsage = usage;
    latestAt = Math.max(latestAt, message.timestamp);
    samples.push({
      at: message.timestamp,
      totalTokens: usage.totalTokens,
    });
  }

  const liveRate = samples.length > 1 ? getTaskLiveTokenRatePerSecond(samples, nowTick) : null;
  const totalTokens = latestUsage?.totalTokens ?? samples.at(-1)?.totalTokens ?? null;
  if (totalTokens === null && liveRate === null) return null;
  return {
    latestAt,
    summary: `Token：实时 ${formatOptionalTokenRate(liveRate)} · 总计 ${totalTokens === null ? "—" : totalTokens.toLocaleString()}`,
  };
}

export function resolveLatestBookTaskTokenSummary(
  messages: ReadonlyArray<SSEMessage>,
  bookId: string,
  nowTick: number,
): string | null {
  return resolveLatestBookTaskTokenSnapshot(messages, bookId, nowTick)?.summary ?? null;
}

export function resolveTokenUsageTotalFromTask(task: Pick<BookTask, "tokenUsage" | "result">): number | null {
  return getTaskTotalTokens(task);
}
