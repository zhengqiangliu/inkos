import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { initialChatState } from "../initialState";
import type { AgentResponse, ChatStore } from "../types";
import { createCreateSlice } from "../slices/create/action";
import { createMessageSlice } from "../slices/message/action";
import { createSessionRuntime } from "../slices/message/runtime";
import { fetchJson } from "../../../hooks/use-api";
import { attachSessionStreamListeners } from "../slices/message/stream-events";

vi.mock("../../../hooks/use-api", () => ({
  fetchJson: vi.fn(),
}));

vi.mock("../slices/message/stream-events", () => ({
  attachSessionStreamListeners: vi.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly handlers = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    queueMicrotask(() => this.emit("open", null));
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = listener as (event: MessageEvent) => void;
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = listener as (event: MessageEvent) => void;
    const list = this.handlers.get(type) ?? [];
    const filtered = list.filter((item) => item !== fn);
    this.handlers.set(type, filtered);
  }

  emit(type: string, data: unknown): void {
    const payload = data === null ? "" : JSON.stringify(data);
    const event = { data: payload } as MessageEvent;
    for (const listener of this.handlers.get(type) ?? []) {
      listener(event);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function createTestStore() {
  return createStore<ChatStore>()((...a) => ({
    ...initialChatState,
    ...createMessageSlice(...a),
    ...createCreateSlice(...a),
  }));
}

describe("chat stop + resend run isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  it("ignores stale agent response after stop and immediate resend", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    const attachListenersMock = vi.mocked(attachSessionStreamListeners);

    const agentCalls: Array<{ runId: string; deferred: Deferred<AgentResponse> }> = [];
    const stopCalls: Array<{ sessionId: string; runId: string }> = [];

    fetchJsonMock.mockImplementation(async (path, init) => {
      if (path === "/agent") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { runId: string };
        const call = { runId: body.runId, deferred: deferred<AgentResponse>() };
        agentCalls.push(call);
        return call.deferred.promise;
      }

      if (path === "/agent/stop") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { sessionId: string; runId: string };
        stopCalls.push(body);
        return { ok: true, stopped: true } as AgentResponse;
      }

      throw new Error(`Unexpected fetchJson path: ${path}`);
    });

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({ sessionId: "s1", bookId: "book-1", title: "Session 1" }),
      },
      activeSessionId: "s1",
      selectedModel: "gpt-5.4",
      selectedService: "openai",
    }));

    const sendA = store.getState().sendMessage("s1", "first", "book-1");
    await vi.waitFor(() => expect(agentCalls).toHaveLength(1));
    const runA = agentCalls[0];

    await store.getState().stopMessage("s1");
    expect(stopCalls).toEqual([{ sessionId: "s1", runId: runA.runId }]);

    const sendB = store.getState().sendMessage("s1", "second", "book-1");
    await vi.waitFor(() => expect(agentCalls).toHaveLength(2));
    const runB = agentCalls[1];

    runB.deferred.resolve({ response: "second-response" });
    await sendB;

    runA.deferred.resolve({ response: "first-response-late" });
    await sendA;

    const session = store.getState().sessions.s1;
    expect(session?.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:first",
      "user:second",
      "assistant:second-response",
    ]);
    expect(attachListenersMock).toHaveBeenCalledTimes(2);
    expect(session?.isStreaming).toBe(false);
    expect(session?.currentRunId).toBeNull();
  });

  it("appends final assistant response when user timestamp collides with streamTs", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);

    fetchJsonMock.mockImplementation(async (path) => {
      if (path === "/agent") {
        return { response: "collision-safe-response" } as AgentResponse;
      }
      throw new Error(`Unexpected fetchJson path: ${path}`);
    });

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({ sessionId: "s1", bookId: "book-1", title: "Session 1" }),
      },
      activeSessionId: "s1",
      selectedModel: "gpt-5.4",
      selectedService: "openai",
    }));

    const nowSpy = vi.spyOn(Date, "now");
    const nowValues = [1000, 2000, 1001, 3000];
    nowSpy.mockImplementation(() => nowValues.shift() ?? 4000);

    try {
      await store.getState().sendMessage("s1", "collision-case", "book-1");
    } finally {
      nowSpy.mockRestore();
    }

    const session = store.getState().sessions.s1;
    expect(session?.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:collision-case",
      "assistant:collision-safe-response",
    ]);
  });

  it("waits terminal run event before closing SSE stream to avoid losing tail deltas", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    const run = deferred<AgentResponse>();
    let capturedRunId = "";

    fetchJsonMock.mockImplementation(async (path, init) => {
      if (path === "/agent") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { runId: string };
        capturedRunId = body.runId;
        return run.promise;
      }
      throw new Error(`Unexpected fetchJson path: ${path}`);
    });

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({ sessionId: "s1", bookId: "book-1", title: "Session 1" }),
      },
      activeSessionId: "s1",
      selectedModel: "gpt-5.4",
      selectedService: "openai",
    }));

    const sending = store.getState().sendMessage("s1", "写第12章", "book-1");
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    const stream = MockEventSource.instances.at(-1)!;

    run.resolve({ response: "ok" });
    await Promise.resolve();
    expect(stream.closed).toBe(false);

    stream.emit("agent:complete", { sessionId: "s1", runId: capturedRunId });
    await sending;
    expect(stream.closed).toBe(true);
  });

  it("includes themeGenre in /agent requests for wizard generation", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);

    let agentBody: Record<string, unknown> | null = null;
    fetchJsonMock.mockImplementation(async (path, init) => {
      if (path === "/agent") {
        agentBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return {
          response: "## 世界观\n都市港城与灰产势力交错。",
          details: { draftRaw: "## 世界观\n都市港城与灰产势力交错。" },
        } as AgentResponse;
      }
      throw new Error(`Unexpected fetchJson path: ${path}`);
    });

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({ sessionId: "s1", bookId: "book-1", title: "Session 1" }),
      },
      activeSessionId: "s1",
      selectedModel: "gpt-5.4",
      selectedService: "openai",
    }));

    await store.getState().sendMessage("s1", "生成世界观", "book-1", {
      skipAutoNewPrefix: true,
      wizardStep: "world",
      themeGenre: "urban",
    });

    expect(agentBody).toEqual(expect.objectContaining({
      instruction: "生成世界观",
      wizardStep: "world",
      themeGenre: "urban",
    }));
  });

  it("preserves streamed wizard body when finalization payload is only a short summary", async () => {
    const store = createTestStore();

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({
          sessionId: "s1",
          bookId: "book-1",
          title: "Session 1",
          currentWizardStep: "world",
          messages: [
            {
              role: "assistant",
              content: "# 世界观\n\n近未来港口城被灰产账本和旧债网络盘踞，公开秩序和地下清算并行存在。",
              wizardStep: "world",
              timestamp: 100,
              parts: [
                { type: "text", content: "# 世界观\n\n近未来港口城被灰产账本和旧债网络盘踞，公开秩序和地下清算并行存在。" },
              ],
            },
          ],
        }),
      },
    }));

    store.getState().finalizeStream("s1", 100, "已完成重写。", undefined);

    const session = store.getState().sessions.s1;
    const last = session.messages.at(-1);
    expect(last?.content).toContain("近未来港口城被灰产账本和旧债网络盘踞");
    expect(last?.content).not.toBe("已完成重写。");
  });

  it("keeps streamed wizard body when final summary has no markdown body", async () => {
    const store = createTestStore();

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({
          sessionId: "s1",
          bookId: "book-1",
          title: "Session 1",
          currentWizardStep: "outline",
          messages: [
            {
              role: "assistant",
              content: "# 小说大纲\n\n## 第一卷\n- 主线：港城清算",
              wizardStep: "outline",
              timestamp: 101,
              parts: [
                { type: "text", content: "# 小说大纲\n\n## 第一卷\n- 主线：港城清算" },
              ],
            },
          ],
        }),
      },
    }));

    store.getState().finalizeStream("s1", 101, "已完成重写并保存。", undefined);

    const session = store.getState().sessions.s1;
    const last = session.messages.at(-1);
    expect(last?.content).toContain("港城清算");
    expect(last?.content).not.toBe("已完成重写并保存。");
  });

  it("keeps streamed intro markdown when final content is not intro body", async () => {
    const store = createTestStore();

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({
          sessionId: "s1",
          bookId: "book-1",
          title: "Session 1",
          currentWizardStep: "intro",
          messages: [
            {
              role: "assistant",
              content: "# 简介正文\n\n## 一句话卖点\n账本牵出港城旧债。\n\n## 故事概述\n林砚被迫卷入灰产清算。",
              wizardStep: "intro",
              timestamp: 102,
              parts: [
                { type: "text", content: "# 简介正文\n\n## 一句话卖点\n账本牵出港城旧债。\n\n## 故事概述\n林砚被迫卷入灰产清算。" },
              ],
            },
          ],
        }),
      },
    }));

    store.getState().finalizeStream("s1", 102, "好的，我已生成并更新允许的字段。", undefined);

    const session = store.getState().sessions.s1;
    const last = session.messages.at(-1);
    expect(last?.content).toContain("账本牵出港城旧债");
    expect(last?.content).not.toBe("好的，我已生成并更新允许的字段。");
  });

  it("retags the latest unbound assistant message when replacing wizard step content", () => {
    const store = createTestStore();

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({
          sessionId: "s1",
          bookId: null,
          title: "draft",
          messages: [
            { role: "user", content: "生成简介", wizardStep: "intro", timestamp: 1 },
            { role: "assistant", content: "正在生成简介...", timestamp: 2 },
          ],
        }),
      },
      activeSessionId: "s1",
    }));

    store.getState().replaceWizardStepMessage("s1", "intro", "# 简介正文\n\n## 一句话卖点\n账本牵出旧债。");

    const session = store.getState().sessions.s1;
    const last = session.messages.at(-1);
    expect(last?.wizardStep).toBe("intro");
    expect(last?.content).toContain("账本牵出旧债");
    expect(session.messages).toHaveLength(2);
  });

  it("probes /agent/status on timeout-like failure and avoids immediate hard error when still running", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    let statusCalls = 0;

    fetchJsonMock.mockImplementation(async (path) => {
      if (path === "/agent") {
        throw new Error("请求超时：审计 第10章。后台可能仍在执行，请稍后刷新确认。");
      }
      if (typeof path === "string" && path.startsWith("/agent/status?")) {
        statusCalls += 1;
        return { ok: true, running: true, sessionId: "s1", runId: "run-timeout" } as unknown as AgentResponse;
      }
      throw new Error(`Unexpected fetchJson path: ${path}`);
    });

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({ sessionId: "s1", bookId: "book-1", title: "Session 1" }),
      },
      activeSessionId: "s1",
      selectedModel: "gpt-5.4",
      selectedService: "openai",
    }));

    await store.getState().sendMessage("s1", "写下一章", "book-1");

    const session = store.getState().sessions.s1;
    expect(statusCalls).toBeGreaterThan(0);
    expect(session?.messages.at(-1)?.content ?? "").not.toContain("请求超时");
    expect(session?.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:写下一章",
    ]);
  });

  it("keeps timeout error when /agent/status confirms run is not active", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    let statusCalls = 0;

    fetchJsonMock.mockImplementation(async (path) => {
      if (path === "/agent") {
        throw new Error("timeout after 120000ms");
      }
      if (typeof path === "string" && path.startsWith("/agent/status?")) {
        statusCalls += 1;
        return { ok: true, running: false, sessionId: "s1", runId: "run-timeout" } as unknown as AgentResponse;
      }
      throw new Error(`Unexpected fetchJson path: ${path}`);
    });

    store.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s1: createSessionRuntime({ sessionId: "s1", bookId: "book-1", title: "Session 1" }),
      },
      activeSessionId: "s1",
      selectedModel: "gpt-5.4",
      selectedService: "openai",
    }));

    await store.getState().sendMessage("s1", "写下一章", "book-1");

    const session = store.getState().sessions.s1;
    expect(statusCalls).toBeGreaterThan(0);
    expect(session?.messages.at(-1)?.content ?? "").toContain("timeout after 120000ms");
  });
});
