import { describe, expect, it } from "vitest";
import { getBookBadgeInitial, selectSidebarDraftSessions } from "./Sidebar";

describe("Sidebar book badge", () => {
  it("uses the first meaningful character of the book title", () => {
    expect(getBookBadgeInitial("星海行者")).toBe("星");
    expect(getBookBadgeInitial("The Last Archive")).toBe("T");
    expect(getBookBadgeInitial("《深渊之门》")).toBe("深");
  });

  it("falls back safely for empty titles", () => {
    expect(getBookBadgeInitial("")).toBe("?");
    expect(getBookBadgeInitial("   ")).toBe("?");
  });
});

describe("Sidebar draft sessions", () => {
  it("selects only null-book drafts for the draft folder", () => {
    const result = selectSidebarDraftSessions(
      {
        __null__: ["draft-1", "draft-2"],
        bookA: ["book-session-1"],
      },
      {
        "draft-1": { sessionId: "draft-1", hasWizardStepMessage: true },
        "draft-2": { sessionId: "draft-2", hasWizardStepMessage: true },
        "book-session-1": { sessionId: "book-session-1" },
      },
    );

    expect(result.map((item) => item.sessionId)).toEqual(["draft-1", "draft-2"]);
  });

  it("returns an empty list when there are no drafts", () => {
    expect(selectSidebarDraftSessions({}, {})).toEqual([]);
  });

  it("deduplicates repeated draft session ids", () => {
    const result = selectSidebarDraftSessions(
      {
        __null__: ["draft-1", "draft-1", "draft-2", "draft-2"],
      },
      {
        "draft-1": { sessionId: "draft-1", hasWizardStepMessage: true },
        "draft-2": { sessionId: "draft-2", hasWizardStepMessage: true },
      },
    );

    expect(result.map((item) => item.sessionId)).toEqual(["draft-1", "draft-2"]);
  });

  it("hides plain null-book chats that are not wizard drafts", () => {
    const result = selectSidebarDraftSessions(
      {
        __null__: ["chat-1", "draft-1"],
      },
      {
        "chat-1": {
          sessionId: "chat-1",
          messages: [{ role: "user", content: "hello" }],
        },
        "draft-1": {
          sessionId: "draft-1",
          hasWizardStepMessage: true,
          messages: [{ role: "user", content: "intro", wizardStep: "intro" }],
        },
      },
    );

    expect(result.map((item) => item.sessionId)).toEqual(["draft-1"]);
  });
});

describe("Sidebar draft title", () => {
  it("does not infer draft titles from user messages", () => {
    expect(getBookBadgeInitial("")).toBe("?");
  });
});
