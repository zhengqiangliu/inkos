import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { chatCompletionMock } = vi.hoisted(() => ({
  chatCompletionMock: vi.fn(),
}));

vi.mock("../llm/provider.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/provider.js")>("../llm/provider.js");
  return {
    ...actual,
    chatCompletion: chatCompletionMock,
  };
});

import { ChapterDesignAgent } from "../agents/chapter-design.js";

describe("ChapterDesignAgent backfill prompt", () => {
  let root: string;
  let bookDir: string;
  let outlineDir: string;
  let volumeOutlineText: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-chapter-design-agent-"));
    bookDir = join(root, "books", "demo-book");
    const storyDir = join(bookDir, "story");
    outlineDir = join(storyDir, "outline");
    volumeOutlineText = "# 卷纲\n\n### 第一卷：风起（1-3章）\n\n第1章到第3章围绕主线冲突推进。";
    await mkdir(storyDir, { recursive: true });
    await mkdir(outlineDir, { recursive: true });
    await writeFile(join(outlineDir, "volume_map.md"), volumeOutlineText, "utf-8");
    await writeFile(join(outlineDir, "story_frame.md"), "# Story Frame\n\n新的世界框架：灵能三层结构。", "utf-8");
    await writeFile(join(storyDir, "volume_outline.md"), "# Legacy Outline\n\n第99章旧内容。", "utf-8");
    await writeFile(join(storyDir, "character_matrix.md"), "# 角色矩阵\n\n主角与反派关系升级。", "utf-8");
    await writeFile(join(storyDir, "story_bible.md"), "# Legacy Story Bible\n\n旧世界观。", "utf-8");
    await writeFile(join(storyDir, "emotional_arcs.md"), "# 感情线\n\n主角与搭档信任破裂后修复。", "utf-8");
    await writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\nH-07 身份反转伏笔。", "utf-8");
    await writeFile(
      join(storyDir, "chapter_summaries.md"),
      [
        "# Chapter Summaries",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 起点 | 主角 | 进入城市 | 适应规则 | H-01 | 紧张 | setup |",
        "| 2 | 追踪 | 主角 | 发现线索 | 升级 | H-02 | 紧张 | conflict |",
      ].join("\n"),
      "utf-8",
    );
    chatCompletionMock.mockReset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the new outline layout and injects chapter limit guardrails into backfill prompts", async () => {
    chatCompletionMock.mockResolvedValue({
      content: [
        "---",
        "chapterNumber: 99",
        "chapterName: 夜雨追踪",
        "highlight: 关键线索浮出水面",
        "coreConflict: 主角必须在救人与追凶之间抉择",
        "plotAndConflict: |",
        "  主角夜探禁区，发现同伴被胁迫，冲突升级。",
        "emotionalTone: 紧张",
        "endingHook: 线索指向最信任的人。",
        "---",
      ].join("\n"),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const agent = new ChapterDesignAgent({
      client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 8192, maxTokensCap: null, thinkingBudget: 0, extra: {} } },
      model: "gpt-5.4",
      projectRoot: root,
      bookId: "demo-book",
    });

    await agent.analyzeAndDesignChapter({
      book: {
        id: "demo-book",
        title: "Demo",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
        status: "active",
        targetChapters: 100,
        chapterWordCount: 3000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      bookDir,
      volumeOutline: volumeOutlineText,
      chapterNumber: 3,
      title: "第三章 夜雨",
      content: "正文A段。正文B段。关键冲突在此发生。",
      language: "zh",
    });

    const userMessage = chatCompletionMock.mock.calls[0]?.[2]?.[1]?.content as string;
    expect(userMessage).toContain("## 章数硬约束");
    expect(userMessage).toContain("卷纲总章数：3章");
    expect(userMessage).toContain("## 卷纲规划（必须输入，唯一规划依据）");
    expect(userMessage).toContain(volumeOutlineText);
    expect(userMessage).toContain("## 本章标题");
    expect(userMessage).toContain("第三章 夜雨");
    expect(userMessage).toContain("## 正文内容（前2000字）");
    expect(userMessage).toContain("关键冲突在此发生");
    expect(userMessage).toContain("## 世界观设定（参考）");
    expect(userMessage).toContain("新的世界框架：灵能三层结构");
    expect(userMessage).toContain("## 感情线（参考）");
    expect(userMessage).toContain("## 伏笔池（参考）");
    expect(userMessage).toContain("## 前章摘要（Previous Chapter Summaries）");
    expect(userMessage).toContain("| 1 | 起点 |");
    expect(userMessage).toContain("输出必须包含以下六个字段");
    expect(userMessage).toContain("chapterName、highlight、coreConflict、plotAndConflict、emotionalTone、endingHook");
  });

  it("clamps batch generation to the outline limit and ignores model-provided chapter numbers", async () => {
    chatCompletionMock.mockResolvedValue({
      content: [
        "---",
        "chapterNumber: 99",
        "chapterName: 越界一",
        "highlight: 第一段冲突",
        "coreConflict: 主角被迫越线",
        "plotAndConflict: |",
        "  第一章冲突推进。",
        "emotionalTone: 紧张",
        "endingHook: 第一章留下悬念。",
        "---",
        "chapterNumber: 100",
        "chapterName: 越界二",
        "highlight: 第二段冲突",
        "coreConflict: 线索指向旧人",
        "plotAndConflict: |",
        "  第二章继续推进。",
        "emotionalTone: 紧张",
        "endingHook: 第二章留下悬念。",
        "---",
      ].join("\n"),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const agent = new ChapterDesignAgent({
      client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 8192, maxTokensCap: null, thinkingBudget: 0, extra: {} } },
      model: "gpt-5.4",
      projectRoot: root,
      bookId: "demo-book",
    });

    const plans = await agent.designBatch({
      book: {
        id: "demo-book",
        title: "Demo",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
        status: "active",
        targetChapters: 100,
        chapterWordCount: 3000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      bookDir,
      volumeOutline: volumeOutlineText,
      startChapter: 2,
      count: 4,
      language: "zh",
    });

    const userMessage = chatCompletionMock.mock.calls[0]?.[2]?.[1]?.content as string;
    expect(userMessage).toContain("## 章数硬约束");
    expect(userMessage).toContain("卷纲总章数：3章");
    expect(userMessage).toContain("本次最多生成到第 3 章");
    expect(userMessage).toContain("请为第 2 章到第 3 章生成章节设计方案。");
    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.chapterNumber)).toEqual([2, 3]);
    expect(plans[0]?.chapterName).toBe("越界一");
    expect(plans[1]?.chapterName).toBe("越界二");
  });

  it("parses Chinese chapter counts from the outline and still enforces limit guards", async () => {
    const chineseOutlineText = "# 卷纲\n\n### 第一卷：风起（1-十章）\n\n共十章推进主线。";
    chatCompletionMock.mockResolvedValue({
      content: [
        "---",
        "chapterName: 中文卷纲",
        "highlight: 中文总章数也能识别",
        "coreConflict: 约束来自卷纲",
        "plotAndConflict: |",
        "  第九章仍在卷纲范围内。",
        "emotionalTone: 紧张",
        "endingHook: 保持后续推进。",
        "---",
        "chapterName: 中文卷纲二",
        "highlight: 第二章继续推进",
        "coreConflict: 继续围绕卷纲收束",
        "plotAndConflict: |",
        "  第十章完成当前卷纲段落。",
        "emotionalTone: 紧张",
        "endingHook: 为下一卷留钩子。",
        "---",
      ].join("\n"),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const agent = new ChapterDesignAgent({
      client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 8192, maxTokensCap: null, thinkingBudget: 0, extra: {} } },
      model: "gpt-5.4",
      projectRoot: root,
      bookId: "demo-book",
    });

    const plans = await agent.designBatch({
      book: {
        id: "demo-book",
        title: "Demo",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
        status: "active",
        targetChapters: 100,
        chapterWordCount: 3000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      bookDir,
      volumeOutline: chineseOutlineText,
      startChapter: 9,
      count: 4,
      language: "zh",
    });

    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.chapterNumber)).toEqual([9, 10]);
    const userMessage = chatCompletionMock.mock.calls[0]?.[2]?.[1]?.content as string;
    expect(userMessage).toContain("卷纲总章数：10章");
  });

  it("rejects incomplete batch outputs instead of silently accepting missing chapters", async () => {
    chatCompletionMock.mockResolvedValue({
      content: [
        "---",
        "chapterName: 只出一章",
        "highlight: 只生成了一个块",
        "coreConflict: 输出数量不足",
        "plotAndConflict: |",
        "  只返回了一章的设计。",
        "emotionalTone: 紧张",
        "endingHook: 仍然留下悬念。",
        "---",
      ].join("\n"),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const agent = new ChapterDesignAgent({
      client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 8192, maxTokensCap: null, thinkingBudget: 0, extra: {} } },
      model: "gpt-5.4",
      projectRoot: root,
      bookId: "demo-book",
    });

    await expect(agent.designBatch({
      book: {
        id: "demo-book",
        title: "Demo",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
        status: "active",
        targetChapters: 100,
        chapterWordCount: 3000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      bookDir,
      volumeOutline: volumeOutlineText,
      startChapter: 2,
      count: 2,
      language: "zh",
    })).rejects.toThrow("Failed to parse complete chapter design output");
  });

  it("fails fast when volume outline input is empty", async () => {
    const agent = new ChapterDesignAgent({
      client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 8192, maxTokensCap: null, thinkingBudget: 0, extra: {} } },
      model: "gpt-5.4",
      projectRoot: root,
      bookId: "demo-book",
    });

    await expect(agent.designBatch({
      book: {
        id: "demo-book",
        title: "Demo",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
        status: "active",
        targetChapters: 100,
        chapterWordCount: 3000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      bookDir,
      volumeOutline: "",
      startChapter: 1,
      count: 1,
      language: "zh",
    })).rejects.toThrow("卷纲规划缺失");
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });
});
