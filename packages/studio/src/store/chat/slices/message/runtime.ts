import type {
  Message,
  MessagePart,
  PipelineStage,
  SessionMessage,
  SessionRuntime,
  SessionSummary,
  ToolExecution,
} from "../../types";

const NULL_BOOK_KEY = "__null__";

const AGENT_LABELS: Record<string, string> = {
  architect: "建书",
  writer: "写作",
  auditor: "审计",
  reviser: "修订",
  exporter: "导出",
};

const TOOL_LABELS: Record<string, string> = {
  sub_agent: "执行过程",
  read: "读取文件",
  edit: "编辑文件",
  grep: "搜索",
  ls: "列目录",
};

export function bookKey(bookId: string | null | undefined): string {
  return bookId ?? NULL_BOOK_KEY;
}

export function extractErrorMessage(error: string | { code?: string; message?: string }): string {
  if (typeof error === "string") return error;
  return error.message ?? "Unknown error";
}

export function resolveToolLabel(tool: string, agent?: string): string {
  if (tool === "sub_agent" && agent) return AGENT_LABELS[agent] ?? agent;
  return TOOL_LABELS[tool] ?? tool;
}

export function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.content === "string") return record.content.slice(0, 200);
    if (typeof record.text === "string") return record.text.slice(0, 200);
    if (record.content && Array.isArray(record.content)) {
      const text = record.content
        .filter((content): content is { type?: unknown; text?: unknown } => !!content && typeof content === "object")
        .filter((content) => content.type === "text" && typeof content.text === "string")
        .map((content) => String(content.text).trim())
        .filter(Boolean)
        .join("\n");
      if (text) return text.slice(0, 200);
    }
    try {
      const serialized = JSON.stringify(result);
      if (serialized && serialized !== "{}") return serialized.slice(0, 200);
    } catch {
      // ignore stringify errors and fall back below
    }
  }
  return String(result).slice(0, 200);
}

export function extractToolError(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 500);
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.content === "string") return record.content.slice(0, 500);
    if (typeof record.text === "string") return record.text.slice(0, 500);
    if (record.content && Array.isArray(record.content)) {
      const textPart = record.content.find((content: any) => content.type === "text");
      if (textPart) return (textPart as any).text?.slice(0, 500) ?? "";
    }
    try {
      const serialized = JSON.stringify(result);
      if (serialized && serialized !== "{}") return serialized.slice(0, 500);
    } catch {
      // ignore stringify errors and fall back below
    }
  }
  return String(result).slice(0, 500);
}

export function getOrCreateStream(
  messages: ReadonlyArray<Message>,
  streamTs: number,
): [ReadonlyArray<Message>, Message] {
  const last = messages[messages.length - 1];
  if (last?.timestamp === streamTs && last.role === "assistant") {
    return [messages, last];
  }
  const message: Message = { role: "assistant", content: "", timestamp: streamTs, parts: [] };
  return [[...messages, message], message];
}

export function replaceLast(
  messages: ReadonlyArray<Message>,
  updated: Message,
): ReadonlyArray<Message> {
  return [...messages.slice(0, -1), updated];
}

export function findRunningToolPart(
  parts: MessagePart[],
): (MessagePart & { type: "tool" }) | undefined {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.type === "tool" && part.execution.status === "running") {
      return part as MessagePart & { type: "tool" };
    }
  }
  return undefined;
}

export function deriveFlat(
  parts: MessagePart[],
): { content: string; thinking?: string; thinkingStreaming?: boolean; toolExecutions?: ToolExecution[] } {
  let content = "";
  let thinking = "";
  let thinkingStreaming = false;
  const toolExecutions: ToolExecution[] = [];

  for (const part of parts) {
    if (part.type === "thinking") {
      if (thinking) thinking += "\n\n---\n\n";
      thinking += part.content;
      if (part.streaming) thinkingStreaming = true;
      continue;
    }

    if (part.type === "text") {
      content += part.content;
      continue;
    }

    toolExecutions.push(part.execution);
  }

  return {
    content,
    ...(thinking ? { thinking } : {}),
    ...(thinkingStreaming ? { thinkingStreaming: true } : {}),
    ...(toolExecutions.length > 0 ? { toolExecutions } : {}),
  };
}

export function createSessionRuntime(input: {
  sessionId: string;
  bookId: string | null;
  title: string | null;
  hasWizardStepMessage?: boolean;
  detailLoaded?: boolean;
  messages?: ReadonlyArray<Message>;
  currentWizardStep?: Message["wizardStep"] | null;
  creationDraft?: SessionRuntime["creationDraft"];
  creationWizard?: SessionRuntime["creationWizard"];
  isDraft?: boolean;
}): SessionRuntime {
  return {
    sessionId: input.sessionId,
    bookId: input.bookId,
    title: input.title,
    hasWizardStepMessage: input.hasWizardStepMessage,
    detailLoaded: input.detailLoaded ?? false,
    messages: input.messages ?? [],
    currentWizardStep: input.currentWizardStep ?? null,
    stream: null,
    isStreaming: false,
    isStopping: false,
    stoppedByUser: false,
    currentRunId: null,
    lastError: null,
    pendingBookArgs: null,
    ...(input.creationDraft ? { creationDraft: input.creationDraft } : {}),
    ...(input.creationWizard ? { creationWizard: input.creationWizard } : {}),
    isDraft: input.isDraft ?? false,
  };
}

export function deserializeMessages(
  msgs: ReadonlyArray<SessionMessage>,
): ReadonlyArray<Message> {
  return msgs
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const toolExecutions = message.toolExecutions;
      const parts: MessagePart[] = [];
      if (message.thinking || message.thinkingStreaming) {
        parts.push({
          type: "thinking",
          content: message.thinking ?? "",
          streaming: message.thinkingStreaming === true,
        });
      }
      if (toolExecutions) {
        for (const execution of toolExecutions) {
          parts.push({ type: "tool", execution });
        }
      }
      if (message.content) parts.push({ type: "text", content: message.content });
      return {
        role: message.role as "user" | "assistant",
        content: message.content,
        wizardStep: message.wizardStep as Message["wizardStep"],
        thinking: message.thinking,
        thinkingStreaming: message.thinkingStreaming,
        audit: (message as { audit?: unknown }).audit as Message["audit"],
        toolExecutions,
        timestamp: message.timestamp,
        parts: parts.length > 0 ? parts : undefined,
      };
    });
}

export function updateSession(
  sessions: Record<string, SessionRuntime>,
  sessionId: string,
  updater: (session: SessionRuntime) => Partial<SessionRuntime>,
): Record<string, SessionRuntime> {
  const existing = sessions[sessionId];
  if (!existing) return sessions;
  return {
    ...sessions,
    [sessionId]: {
      ...existing,
      ...updater(existing),
    },
  };
}

export function upsertSessionSummary(
  sessions: Record<string, SessionRuntime>,
  summary: Pick<SessionSummary, "sessionId" | "bookId" | "title" | "hasWizardStepMessage">,
): Record<string, SessionRuntime> {
  const existing = sessions[summary.sessionId];
  return {
    ...sessions,
    [summary.sessionId]: existing
      ? {
          ...existing,
          bookId: summary.bookId,
          title: summary.title,
          hasWizardStepMessage: summary.hasWizardStepMessage ?? existing.hasWizardStepMessage,
        }
      : createSessionRuntime(summary),
  };
}

export function mergeSessionIds(
  existing: ReadonlyArray<string> | undefined,
  incoming: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (!existing?.length) return [...incoming];
  const seen = new Set(existing);
  const appended = incoming.filter((id) => !seen.has(id));
  if (appended.length === 0) return existing as string[];
  return [...existing, ...appended];
}

export function sessionMatchesEvent(sessionId: string, data: unknown, runId?: string): boolean {
  if (!data || typeof data !== "object") return false;
  const event = data as { sessionId?: unknown; runId?: unknown };
  if (event.sessionId !== sessionId) return false;
  if (!runId) return true;
  return typeof event.runId === "string" && event.runId === runId;
}

export function buildAgentRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isExplicitWriteNextCommand(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (/^(写下一章|下一章|write next(?: chapter)?|next chapter)$/i.test(text)) {
    return true;
  }
  if (/^(?:连写|连续写|写)\s*(\d+)\s*章$/i.test(text)) {
    return true;
  }
  if (/^写第\s*(\d+)\s*章[。.!！?？]?$/i.test(text)) {
    return true;
  }
  if (/^(?:write|continue)\s*(\d+)\s*chapters?(?:\s+continuously)?$/i.test(text)) {
    return true;
  }
  return false;
}
