import { describe, expect, it } from "vitest";
import { countChapterLengthByLanguage } from "./chapter-length";

describe("chapter-length", () => {
  it("ignores markdown heading/frontmatter when counting zh chapter length", () => {
    const markdown = [
      "---",
      "id: demo",
      "---",
      "# 第13章 标题",
      "",
      "甲乙 丙丁",
      "",
      "```",
      "code block",
      "```",
    ].join("\n");
    expect(countChapterLengthByLanguage(markdown, "zh")).toBe("甲乙丙丁".length);
  });

  it("counts english words for en language", () => {
    const markdown = "# Chapter 3\n\nHe walked across the bridge.";
    expect(countChapterLengthByLanguage(markdown, "en")).toBe(5);
  });
});
