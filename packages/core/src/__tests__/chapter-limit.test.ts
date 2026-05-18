import { describe, expect, it } from "vitest";
import { extractChapterLimitFromOutline } from "../utils/chapter-limit.js";

describe("extractChapterLimitFromOutline", () => {
  it("prefers chapter counts over volume counts when both appear on the same line", () => {
    const outline = "**卷纲规划（共5卷，100章）**";
    expect(extractChapterLimitFromOutline(outline)).toBe(100);
  });

  it("extracts the end chapter from a chapter range", () => {
    const outline = [
      "第一卷：职场废柴的逆流而上（1-20章）",
      "第二卷：破镜与寻踪——灵气迷踪（21-40章）",
    ].join("\n");
    expect(extractChapterLimitFromOutline(outline)).toBe(40);
  });

  it("reads explicit total chapter labels", () => {
    const outline = "总章数：120";
    expect(extractChapterLimitFromOutline(outline)).toBe(120);
  });
});
