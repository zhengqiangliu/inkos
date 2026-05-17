import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn();
const activateSession = vi.fn();
const createSession = vi.fn();

vi.mock("../store/chat", () => ({
  useChatStore: {
    getState: () => ({
      activeSessionId: "session-1",
      sessions: {
        "session-1": { bookId: "book-1", isStreaming: false },
        "session-2": { bookId: "book-2", isStreaming: false },
      },
      sessionIdsByBook: {},
      activateSession,
      createSession,
      sendMessage,
    }),
  },
}));

describe("dispatchWriteNextInstruction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage);
  });

  it("routes write-next through the chat store sendMessage pipeline", async () => {
    const { dispatchWriteNextInstruction } = await import("./write-next");

    await dispatchWriteNextInstruction("book-1");

    expect(activateSession).toHaveBeenCalledWith("session-1");
    expect(sendMessage).toHaveBeenCalledWith("session-1", "写下一章", "book-1", {
      skipAutoNewPrefix: true,
    });
  });

  it("persists the resolved book-detail session id before sending", async () => {
    const { dispatchWriteNextInstruction } = await import("./write-next");

    await dispatchWriteNextInstruction("book-1", undefined, "session-1");

    expect(globalThis.localStorage?.setItem).toHaveBeenCalledWith(
      "inkos.book-detail.session-id.book-1",
      "session-1",
    );
  });

  it("ignores mismatched explicit sessions and falls back to the book session", async () => {
    const { dispatchWriteNextInstruction } = await import("./write-next");

    await dispatchWriteNextInstruction("book-1", undefined, "session-2");

    expect(sendMessage).toHaveBeenCalledWith("session-1", "写下一章", "book-1", {
      skipAutoNewPrefix: true,
    });
    expect(globalThis.localStorage?.setItem).toHaveBeenCalledWith(
      "inkos.book-detail.session-id.book-1",
      "session-1",
    );
  });
});
