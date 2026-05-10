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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-chapter-design-agent-"));
    bookDir = join(root, "books", "demo-book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n第3章推进主线冲突。", "utf-8");
    await writeFile(join(storyDir, "character_matrix.md"), "# 角色矩阵\n\n主角与反派关系升级。", "utf-8");
    await writeFile(join(storyDir, "story_bible.md"), "# 世界观\n\n灵能体系与城市禁区规则。", "utf-8");
    await writeFile(join(storyDir, "emotional_arcs.md"), "# 感情线\n\n主角与搭档信任破裂后修复。", "utf-8");
    await writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\nH-07 身份反转伏笔。", "utf-8");
    chatCompletionMock.mockReset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("includes chapter content + volume outline and optional context, and enforces six fields", async () => {
    chatCompletionMock.mockResolvedValue({
      content: [
        "---",
        "chapterNumber: 3",
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
      chapterNumber: 3,
      title: "第三章 夜雨",
      content: "正文A段。正文B段。关键冲突在此发生。",
      language: "zh",
    });

    const userMessage = chatCompletionMock.mock.calls[0]?.[2]?.[1]?.content as string;
    expect(userMessage).toContain("## 本章标题");
    expect(userMessage).toContain("第三章 夜雨");
    expect(userMessage).toContain("## 正文内容（前2000字）");
    expect(userMessage).toContain("关键冲突在此发生");
    expect(userMessage).toContain("## 卷纲（参考）");
    expect(userMessage).toContain("第3章推进主线冲突");
    expect(userMessage).toContain("## 世界观设定（参考）");
    expect(userMessage).toContain("## 感情线（参考）");
    expect(userMessage).toContain("## 伏笔池（参考）");
    expect(userMessage).toContain("输出必须包含以下六个字段");
    expect(userMessage).toContain("chapterName、highlight、coreConflict、plotAndConflict、emotionalTone、endingHook");
  });
});
