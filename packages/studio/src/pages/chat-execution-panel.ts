import type { Message, ToolExecution } from "../store/chat/types";

export function buildExecutionPanelStorageKey(sessionId: string | null): string {
  return `studio.execution-panel.collapsed.${sessionId ?? "global"}`;
}

export function readExecutionPanelCollapsedFromStorage(
  getItem: (key: string) => string | null,
  key: string,
  fallbackCollapsed = true,
): boolean {
  const cached = getItem(key);
  if (cached === "0") return false;
  if (cached === "1") return true;
  return fallbackCollapsed;
}

export function pickLatestAssistantToolExecutions(
  messages: ReadonlyArray<Message>,
): ReadonlyArray<ToolExecution> {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (Array.isArray(message.toolExecutions) && message.toolExecutions.length > 0) {
      return message.toolExecutions;
    }
  }
  return [];
}
