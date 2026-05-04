import { describe, expect, it } from "vitest";
import type { Message, ToolExecution } from "../store/chat/types";
import {
  buildExecutionPanelStorageKey,
  pickLatestAssistantToolExecutions,
  readExecutionPanelCollapsedFromStorage,
} from "./chat-execution-panel";

function makeExec(overrides: Partial<ToolExecution> & { id: string }): ToolExecution {
  return {
    ...overrides,
    id: overrides.id,
    tool: overrides.tool ?? "sub_agent",
    label: overrides.label ?? "执行过程",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? Date.now(),
  };
}

function makeMessage(overrides: Partial<Message> & { role: Message["role"]; content: string }): Message {
  return {
    ...overrides,
    role: overrides.role,
    content: overrides.content,
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

describe("chat-execution-panel helpers", () => {
  it("builds storage key by session id", () => {
    expect(buildExecutionPanelStorageKey("s1")).toBe("studio.execution-panel.collapsed.s1");
    expect(buildExecutionPanelStorageKey(null)).toBe("studio.execution-panel.collapsed.global");
  });

  it("reads collapsed flag from storage value", () => {
    expect(readExecutionPanelCollapsedFromStorage(() => "0", "k")).toBe(false);
    expect(readExecutionPanelCollapsedFromStorage(() => "1", "k")).toBe(true);
    expect(readExecutionPanelCollapsedFromStorage(() => null, "k")).toBe(true);
    expect(readExecutionPanelCollapsedFromStorage(() => null, "k", false)).toBe(false);
  });

  it("picks latest assistant message executions only", () => {
    const e1 = makeExec({ id: "e1" });
    const e2 = makeExec({ id: "e2", status: "completed" });
    const messages: Message[] = [
      makeMessage({ role: "assistant", content: "old", toolExecutions: [e1] }),
      makeMessage({ role: "user", content: "next" }),
      makeMessage({ role: "assistant", content: "new", toolExecutions: [e2] }),
    ];

    const picked = pickLatestAssistantToolExecutions(messages);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.id).toBe("e2");
  });

  it("returns empty when no assistant executions exist", () => {
    const messages: Message[] = [
      makeMessage({ role: "user", content: "u1" }),
      makeMessage({ role: "assistant", content: "a1" }),
    ];
    expect(pickLatestAssistantToolExecutions(messages)).toEqual([]);
  });

  it("keeps patch preview execution entries", () => {
    const patchPreview = makeExec({
      id: "e2",
      previewKind: "patch",
      previewText: "PATCH 1",
      status: "running",
    });
    const messages: Message[] = [
      makeMessage({ role: "assistant", content: "", toolExecutions: [patchPreview] }),
    ];
    const picked = pickLatestAssistantToolExecutions(messages);
    expect(picked.map((item) => item.id)).toEqual(["e2"]);
  });
});
