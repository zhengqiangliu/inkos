import { describe, expect, it } from "vitest";
import { attachSessionStreamListeners } from "../slices/message/stream-events";
import { createSessionRuntime } from "../slices/message/runtime";
import type { SessionRuntime } from "../types";

class MockEventSource {
  private readonly handlers = new Map<string, Array<(event: MessageEvent) => void>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = listener as (event: MessageEvent) => void;
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  emit(type: string, data: unknown): void {
    const listeners = this.handlers.get(type) ?? [];
    const payload = JSON.stringify(data);
    for (const listener of listeners) {
      listener({ data: payload } as MessageEvent);
    }
  }
}

interface TestState {
  sessions: Record<string, SessionRuntime>;
  bumpBookDataVersion: () => void;
}

function createState(): {
  get: () => TestState;
  set: (updater: ((state: TestState) => Partial<TestState>) | Partial<TestState>) => void;
} {
  let state: TestState = {
    sessions: {
      s1: createSessionRuntime({ sessionId: "s1", bookId: "book-1", title: "demo" }),
    },
    bumpBookDataVersion: () => undefined,
  };

  return {
    get: () => state,
    set: (updater) => {
      const partial = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...partial };
    },
  };
}

describe("attachSessionStreamListeners", () => {
  it("keeps thinking delta when thinking/tool events are interleaved", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 100,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("thinking:start", { sessionId: "s1", runId: "r1" });
    eventSource.emit("thinking:delta", { sessionId: "s1", runId: "r1", text: "先" });
    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t-thinking-interleave",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("thinking:delta", { sessionId: "s1", runId: "r1", text: "后" });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    expect(last?.thinking).toBe("先后");
    expect(last?.thinkingStreaming).toBe(true);
  });

  it("marks latest thinking part ended even when last part is tool", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 101,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("thinking:start", { sessionId: "s1", runId: "r1" });
    eventSource.emit("thinking:delta", { sessionId: "s1", runId: "r1", text: "阶段思考" });
    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t-thinking-end",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("thinking:end", { sessionId: "s1", runId: "r1" });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    expect(last?.thinking).toBe("阶段思考");
    expect(last?.thinkingStreaming).not.toBe(true);
  });

  it("promotes pipeline stage from log messages", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 1,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t1",
      tool: "sub_agent",
      args: { agent: "writer" },
      stages: ["准备章节输入", "撰写章节草稿"],
    });

    eventSource.emit("log", {
      sessionId: "s1",
      runId: "r1",
      message: "[studio] 阶段：撰写章节草稿",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.stages?.[0]?.status).toBe("completed");
      expect(tool.execution.stages?.[1]?.status).toBe("active");
      expect(typeof tool.execution.stages?.[1]?.activatedAt).toBe("number");
      expect(tool.execution.logs).toContain("[studio] 阶段：撰写章节草稿");
    }
  });

  it("ignores heartbeat-only log lines with elapsed seconds", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 9,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t9",
      tool: "sub_agent",
      args: { agent: "writer" },
      stages: ["准备章节输入", "生成最终真相文件"],
    });
    eventSource.emit("log", {
      sessionId: "s1",
      runId: "r1",
      message: "[studio] 生成最终真相文件（进行中 12s）",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.logs?.length ?? 0).toBe(0);
      expect(tool.execution.stages?.[0]?.status).toBe("active");
      expect(tool.execution.stages?.[1]?.status).toBe("pending");
    }
  });

  it("maps writer phase-2 logs to final-truth stage to avoid draft-stage freeze perception", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 10,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t10",
      tool: "sub_agent",
      args: { agent: "writer" },
      stages: ["准备章节输入", "撰写章节草稿", "落盘最终章节", "生成最终真相文件"],
    });
    eventSource.emit("log", {
      sessionId: "s1",
      runId: "r1",
      message: "[writer] 阶段 2：状态结算（第18章，4741字）",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.stages?.[0]?.status).toBe("completed");
      expect(tool.execution.stages?.[1]?.status).toBe("completed");
      expect(tool.execution.stages?.[2]?.status).toBe("completed");
      expect(tool.execution.stages?.[3]?.status).toBe("active");
    }
  });

  it("activates first stage at tool start with activatedAt", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 11,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t11",
      tool: "sub_agent",
      args: { agent: "writer" },
      stages: ["准备章节输入", "撰写章节草稿"],
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.stages?.[0]?.status).toBe("active");
      expect(typeof tool.execution.stages?.[0]?.activatedAt).toBe("number");
      expect(tool.execution.stages?.[1]?.status).toBe("pending");
    }
  });

  it("accepts legacy progress events without runId for same session", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 2,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t2",
      tool: "sub_agent",
      args: { agent: "writer" },
      stages: ["准备章节输入", "撰写章节草稿"],
    });
    eventSource.emit("log", {
      sessionId: "s1",
      runId: "r1",
      message: "[studio] 阶段：准备章节输入",
    });

    eventSource.emit("llm:progress", {
      sessionId: "s1",
      status: "thinking",
      elapsedMs: 3000,
      totalChars: 1200,
      chineseChars: 1180,
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.stages?.[0]?.progress?.elapsedMs).toBe(3000);
      expect(tool.execution.stages?.[0]?.progress?.status).toBe("thinking");
    }
  });

  it("appends tool:update partial result to running tool logs", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 3,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t3",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("tool:update", {
      sessionId: "s1",
      runId: "r1",
      id: "t3",
      tool: "sub_agent",
      partialResult: {
        content: [{ type: "text", text: "正在读取章节上下文" }],
      },
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.logs).toContain("正在读取章节上下文");
    }
  });

  it("labels deterministic rewrite execution as 重写", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 30,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t30",
      tool: "sub_agent",
      args: { agent: "writer", action: "rewrite" },
      stages: ["准备章节输入", "撰写章节草稿", "落盘最终章节", "更新章节索引与快照"],
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.label).toBe("重写");
    }
  });

  it("creates a fallback execution from tool:update when tool:start was missed", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 31,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:update", {
      sessionId: "s1",
      runId: "r1",
      id: "t31",
      tool: "sub_agent",
      partialResult: {
        content: [{ type: "text", text: "开始准备章节上下文" }],
      },
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.id).toBe("t31");
      expect(tool.execution.status).toBe("running");
      expect(tool.execution.logs).toContain("开始准备章节上下文");
    }
  });

  it("routes chapter:delta to assistant text stream instead of tool preview", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 4,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t4",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 15,
      text: "第一段。",
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      text: "第二段。",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    expect(last?.content).toContain("第一段。第二段。");
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.previewText).toBeUndefined();
      expect(tool.execution.previewKind).toBeUndefined();
    }
  });

  it("does not create fallback execution for chapter:delta when tool:start was missed", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 32,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 20,
      text: "这一段应该进入正文流预览。",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool).toBeUndefined();
    expect(last?.content).toContain("这一段应该进入正文流预览。");
  });

  it("creates a fallback execution from log when tool:start was missed", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 33,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("log", {
      sessionId: "s1",
      runId: "r1",
      message: "[writer] 阶段 1：创作正文（第20章）",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.status).toBe("running");
      expect(tool.execution.agent).toBe("writer");
      expect(tool.execution.logs).toContain("[writer] 阶段 1：创作正文（第20章）");
    }
  });

  it("keeps chapter:delta text in content stream during batch writing", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 42,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t42",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 15,
      text: "第15章片段。",
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 16,
      text: "第16章片段。",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    expect(last?.content).toContain("第15章片段。第16章片段。");
  });

  it("ignores chapter:delta events without runId to prevent stale-stream pollution", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 43,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t43",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      chapterNumber: 15,
      text: "旧流片段，不应写入。",
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 15,
      text: "新流片段，应写入。",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    expect(last?.content).toContain("新流片段，应写入。");
    expect(last?.content).not.toContain("旧流片段");
  });

  it("stores chapter:delta patch preview type into running tool preview kind", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 41,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t41",
      tool: "sub_agent",
      args: { agent: "reviser" },
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 12,
      previewType: "patch",
      text: "--- PATCH 1 ---\nTARGET_TEXT:\n原句",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.previewKind).toBe("patch");
      expect(tool.execution.previewText).toContain("PATCH 1");
      expect(tool.execution.previewChapterNumber).toBe(12);
    }
  });

  it("stores batch:progress into running tool batch status", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 5,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t5",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("batch:progress", {
      sessionId: "s1",
      runId: "r1",
      id: "t5",
      batchId: "r1:t5",
      status: "progress",
      total: 3,
      completed: 1,
      elapsedMs: 1200,
      currentChapter: 15,
      currentWords: 5100,
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.batch).toMatchObject({
        batchId: "r1:t5",
        status: "running",
        total: 3,
        completed: 1,
        elapsedMs: 1200,
        currentChapter: 15,
        currentWords: 5100,
      });
    }
  });

  it("keeps existing chapter preview content when audit:complete arrives", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 88,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t88",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 18,
      text: "正文片段A。",
    });
    eventSource.emit("chapter:delta", {
      sessionId: "s1",
      runId: "r1",
      chapterNumber: 18,
      text: "正文片段B。",
    });
    eventSource.emit("audit:complete", {
      sessionId: "s1",
      runId: "r1",
      chapter: 18,
      passed: false,
      issueCount: 2,
      score: 52,
      summary: "score gate 未通过",
      issues: ["[warning] issue 1", "[warning] issue 2"],
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    expect(last?.content).toContain("正文片段A。正文片段B。");
    expect(last?.audit?.chapter).toBe(18);
    expect(last?.audit?.passed).toBe(false);
  });

  it("stores auto-review round progress on execution from audit/revise events", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 89,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t89",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("audit:start", {
      sessionId: "s1",
      runId: "r1",
      chapter: 3,
      round: 1,
      maxRounds: 2,
      phase: "audit",
    });
    eventSource.emit("revise:start", {
      sessionId: "s1",
      runId: "r1",
      chapter: 3,
      round: 1,
      maxRounds: 2,
      phase: "revise",
      mode: "non-destructive",
      strategyReason: "评分门禁未通过，本轮优先修复高影响问题并提升总分。",
      autoTriggeredByAudit: true,
    });
    eventSource.emit("audit:complete", {
      sessionId: "s1",
      runId: "r1",
      chapter: 3,
      round: 2,
      maxRounds: 2,
      phase: "audit",
      passed: true,
      score: 82,
      issueCount: 0,
      autoReviewState: "passed",
      autoReviewFinal: true,
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.autoReview).toMatchObject({
        enabled: true,
        phase: "audit",
        round: 2,
        maxRounds: 2,
        final: true,
        state: "passed",
        reviseRoundsUsed: 1,
        strategyReason: "评分门禁未通过，本轮优先修复高影响问题并提升总分。",
      });
    }
  });

  it("creates fallback execution for audit progress when tool:start was missed", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 90,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("audit:start", {
      sessionId: "s1",
      runId: "r1",
      chapter: 6,
      round: 1,
      maxRounds: 0,
      phase: "audit",
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.id).toBe("review-r1");
      expect(tool.execution.autoReview).toMatchObject({
        enabled: false,
        phase: "audit",
        round: 1,
        maxRounds: 0,
      });
    }
  });

  it("appends persist check/repair logs to the latest tool even after tool completion", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 6,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t6",
      tool: "sub_agent",
      args: { agent: "writer" },
    });
    eventSource.emit("tool:end", {
      sessionId: "s1",
      runId: "r1",
      id: "t6",
      tool: "sub_agent",
      result: "ok",
      isError: false,
    });
    eventSource.emit("persist:check", {
      sessionId: "s1",
      runId: "r1",
      status: "completed",
      persisted: true,
      beforeCount: 16,
      afterCount: 17,
      addedChapterNumbers: [17],
      missingChapterFiles: [],
    });
    eventSource.emit("persist:repair", {
      sessionId: "s1",
      runId: "r1",
      status: "completed",
      repairedChapterNumbers: [17],
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.logs?.some((line) => line.includes("[persist:check]"))).toBe(true);
      expect(tool.execution.logs?.some((line) => line.includes("[persist:repair]"))).toBe(true);
    }
  });

  it("summarizes structured tool:end result without rendering [object Object]", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 7,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t7",
      tool: "sub_agent",
      args: { agent: "reviser" },
    });
    eventSource.emit("tool:end", {
      sessionId: "s1",
      runId: "r1",
      id: "t7",
      tool: "sub_agent",
      isError: false,
      result: {
        content: [
          { type: "text", text: "已完成第14章修订。" },
        ],
      },
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.result).toContain("已完成第14章修订");
      expect(tool.execution.result).not.toContain("[object Object]");
    }
  });

  it("stores structured audit:complete payload on the streaming assistant message", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 44,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t44",
      tool: "sub_agent",
      args: { agent: "auditor" },
    });
    eventSource.emit("audit:complete", {
      sessionId: "s1",
      runId: "r1",
      chapter: 13,
      passed: false,
      issueCount: 2,
      score: 53,
      severityCounts: { critical: 1, warning: 1, info: 0 },
      failureGate: "critical",
      summary: "节奏过快，线索冲突未收束。",
      issues: ["[critical] Name inconsistency", "[warning] Pacing too fast"],
      dimensionChecks: [
        { dimension: "时间线检查", status: "warning", evidence: "第3段时间点跳变过快" },
      ],
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    expect(last?.audit).toMatchObject({
      chapter: 13,
      passed: false,
      issueCount: 2,
      score: 53,
      severityCounts: { critical: 1, warning: 1, info: 0 },
      failureGate: "critical",
      summary: "节奏过快，线索冲突未收束。",
    });
    expect(last?.audit?.issues).toEqual(["[critical] Name inconsistency", "[warning] Pacing too fast"]);
    expect(last?.audit?.dimensionChecks).toEqual([
      { dimension: "时间线检查", status: "warning", evidence: "第3段时间点跳变过快" },
    ]);
  });

  it("stores audit gate and must-fix unresolved telemetry into autoReview progress", () => {
    const eventSource = new MockEventSource();
    const state = createState();

    attachSessionStreamListeners({
      sessionId: "s1",
      runId: "r1",
      streamTs: 91,
      streamEs: eventSource as unknown as EventSource,
      set: state.set as any,
      get: state.get as any,
    });

    eventSource.emit("tool:start", {
      sessionId: "s1",
      runId: "r1",
      id: "t91",
      tool: "sub_agent",
      args: { agent: "auditor" },
    });
    eventSource.emit("audit:complete", {
      sessionId: "s1",
      runId: "r1",
      chapter: 10,
      round: 2,
      maxRounds: 3,
      phase: "audit",
      passed: false,
      issueCount: 3,
      score: 64,
      failureGate: "score",
      dimensionChecks: [
        { dimension: "大纲对齐", status: "failed" },
        { dimension: "角色一致性", status: "pass" },
      ],
      latestRevisionMustFixOutcomes: [
        { issueId: "ISSUE-1", outcome: "resolved" },
        { issueId: "ISSUE-2", outcome: "partial" },
        { issueId: "ISSUE-3", outcome: "unresolved" },
      ],
      latestRevisionMustFixTotalCount: 3,
      latestRevisionMustFixUnresolvedCount: 2,
      autoReviewState: "retrying",
      autoReviewFinal: false,
    });

    const session = state.get().sessions.s1;
    const last = session.messages[session.messages.length - 1];
    const tool = last?.parts?.find((part) => part.type === "tool");
    expect(tool?.type).toBe("tool");
    if (tool?.type === "tool") {
      expect(tool.execution.autoReview).toMatchObject({
        failureGate: "score",
        failedDimensions: ["大纲对齐"],
        mustFixUnresolvedCount: 2,
        mustFixTotalCount: 3,
      });
    }
  });
});
