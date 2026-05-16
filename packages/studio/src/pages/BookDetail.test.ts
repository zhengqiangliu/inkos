import { describe, expect, it } from "vitest";
import { shouldAutoOpenFirstChapter } from "./BookDetail";

describe("shouldAutoOpenFirstChapter", () => {
  it("opens the first chapter when nothing is active", () => {
    expect(shouldAutoOpenFirstChapter([
      { number: 1, title: "第一章", status: "drafted", wordCount: 1200 },
    ], null)).toBe(true);
  });

  it("does not reopen when a chapter is already selected", () => {
    expect(shouldAutoOpenFirstChapter([
      { number: 1, title: "第一章", status: "drafted", wordCount: 1200 },
    ], 1)).toBe(false);
  });

  it("does not open when there are no chapters", () => {
    expect(shouldAutoOpenFirstChapter([], null)).toBe(false);
  });
});
