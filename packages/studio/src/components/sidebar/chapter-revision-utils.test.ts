import { describe, expect, it } from "vitest";
import {
  buildChapterRevisionInstruction,
  getChapterRevisionDisplayMeta,
  getChapterRevisionModeMeta,
  resolveChapterRevisionMode,
} from "./chapter-revision-utils";

describe("chapter revision utils", () => {
  it("resolves revision mode from selection text", () => {
    expect(resolveChapterRevisionMode("")).toBe("full");
    expect(resolveChapterRevisionMode("   ")).toBe("full");
    expect(resolveChapterRevisionMode("选中文本")).toBe("selected");
  });

  it("builds selected-mode instruction when text exists", () => {
    const instruction = buildChapterRevisionInstruction({
      chapterNumber: 12,
      selectedText: "这里是选中的一段文本",
      brief: "收紧节奏",
      mode: "selected",
    });

    expect(instruction).toContain("第12章选中的文本");
    expect(instruction).toContain("[选中文本]");
    expect(instruction).toContain("收紧节奏");
  });

  it("returns readable mode metadata", () => {
    expect(getChapterRevisionModeMeta("")).toMatchObject({
      mode: "full",
      label: "全文模式",
    });
    expect(getChapterRevisionModeMeta("选中文本")).toMatchObject({
      mode: "selected",
      label: "正文选中模式",
    });
  });

  it("promotes empty selection into selection mode when the AI selection panel is active", () => {
    expect(getChapterRevisionDisplayMeta("", true)).toMatchObject({
      mode: "selected",
      label: "AI 选择模式",
    });
  });
});
