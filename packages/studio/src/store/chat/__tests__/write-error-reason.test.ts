import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { initialChatState } from "../initialState";
import type { ChatStore } from "../types";
import { createCreateSlice } from "../slices/create/action";
import { createMessageSlice } from "../slices/message/action";
import { createSessionRuntime } from "../slices/message/runtime";
import { ApiRequestError, fetchJson } from "../../../hooks/use-api";
import { attachSessionStreamListeners } from "../slices/message/stream-events";

vi.mock("../../../hooks/use-api", () => ({
  fetchJson: vi.fn(),
  ApiRequestError: class extends Error {
    readonly status: number;
    readonly code?: string;
    readonly details?: unknown;
    readonly payload?: unknown;

    constructor(args: {
      readonly message: string;
      readonly status: number;
      readonly code?: string;
      readonly details?: unknown;
      readonly payload?: unknown;
    }) {
      super(args.message);
      this.name = "ApiRequestError";
      this.status = args.status;
      this.code = args.code;
      this.details = args.details;
      this.payload = args.payload;
    }
  },
}));

vi.mock("../slices/message/stream-events", () => ({
  attachSessionStreamListeners: vi.fn(),
}));

class MockEventSource {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    // no-op
  }
}

function createTestStore() {
  return createStore<ChatStore>()((...a) => ({
    ...initialChatState,
    ...createMessageSlice(...a),
    ...createCreateSlice(...a),
  }));
}

describe("chat explicit write command failure reasons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  it("shows writer-not-executed reason for explicit write-next command", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    vi.mocked(attachSessionStreamListeners).mockImplementation(() => undefined);

    fetchJsonMock.mockImplementation(async (path) => {
      if (path === "/agent") {
        throw new ApiRequestError({
          message: "未触发写作工具，章节尚未生成。",
          status: 409,
          code: "AGENT_WRITE_NOT_EXECUTED",
        });
      }
      throw new Error(`Unexpected path: ${path}`);
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

    const assistantMessages = store.getState().sessions.s1?.messages.filter((msg) => msg.role === "assistant") ?? [];
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toContain("未触发写作器");
  });

  it("shows missing-index reason when persistence check reports no index growth", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    vi.mocked(attachSessionStreamListeners).mockImplementation(() => undefined);

    fetchJsonMock.mockImplementation(async (path) => {
      if (path === "/agent") {
        throw new ApiRequestError({
          message: "写作流程结束，但未检测到新章节写入索引。",
          status: 409,
          code: "AGENT_WRITE_NOT_PERSISTED",
          details: {
            writeIntegrity: {
              beforeCount: 10,
              afterCount: 10,
              addedChapterNumbers: [],
              missingChapterFiles: [],
            },
          },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
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

    const assistantMessages = store.getState().sessions.s1?.messages.filter((msg) => msg.role === "assistant") ?? [];
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toContain("未检测到新章节索引写入");
  });

  it("shows missing-file reason when persistence check reports missing chapter files", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    vi.mocked(attachSessionStreamListeners).mockImplementation(() => undefined);

    fetchJsonMock.mockImplementation(async (path) => {
      if (path === "/agent") {
        throw new ApiRequestError({
          message: "写作流程结束，但第17章正文文件未落盘。",
          status: 409,
          code: "AGENT_WRITE_NOT_PERSISTED",
          details: {
            writeIntegrity: {
              beforeCount: 16,
              afterCount: 17,
              addedChapterNumbers: [17],
              missingChapterFiles: [17],
            },
          },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
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

    const assistantMessages = store.getState().sessions.s1?.messages.filter((msg) => msg.role === "assistant") ?? [];
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toContain("章节正文未落盘");
    expect(assistantMessages[0]?.content).toContain("17");
  });

  it("shows degraded-but-persisted reason when write settles in state-degraded", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    vi.mocked(attachSessionStreamListeners).mockImplementation(() => undefined);

    fetchJsonMock.mockImplementation(async (path) => {
      if (path === "/agent") {
        throw new ApiRequestError({
          message: "写作已完成且正文已落盘，但第23章状态降级（state-degraded），请先修复后再继续。",
          status: 409,
          code: "AGENT_WRITE_DEGRADED",
          details: {
            writeIntegrity: {
              beforeCount: 22,
              afterCount: 23,
              addedChapterNumbers: [23],
              missingChapterFiles: [],
              degradedChapterNumbers: [23],
            },
            degradedRecovery: {
              persisted: true,
              attempted: true,
              attemptedChapterNumber: 23,
              recovered: false,
              remainingDegradedChapterNumbers: [23],
              suggestion: "可执行修复：修复第23章落库和索引。",
            },
          },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
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

    const assistantMessages = store.getState().sessions.s1?.messages.filter((msg) => msg.role === "assistant") ?? [];
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toContain("正文已落盘");
    expect(assistantMessages[0]?.content).toContain("状态降级");
    expect(assistantMessages[0]?.content).toContain("第23章");
  });
});
