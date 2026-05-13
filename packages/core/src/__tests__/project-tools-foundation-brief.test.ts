import { describe, expect, it, vi } from "vitest";
import { createInteractionToolsFromDeps } from "../interaction/project-tools.js";

describe("project tools foundation brief", () => {
  it("passes author intent and current focus into the foundation brief when creating a book", async () => {
    const initBook = vi.fn(async (_book: unknown, _options?: { foundationBrief?: string }) => undefined);
    const tools = createInteractionToolsFromDeps(
      {
        initBook,
        writeNextChapter: vi.fn(async () => ({
          chapterNumber: 1,
          title: "Draft",
          wordCount: 1000,
          revised: false,
          status: "ready-for-review" as const,
          auditResult: { passed: true, issues: [], summary: "ok" },
        })),
        reviseDraft: vi.fn(async () => ({
          chapterNumber: 1,
          wordCount: 1000,
          fixedIssues: [],
          applied: true,
          status: "ready-for-review" as const,
        })),
      },
      {
        ensureControlDocuments: vi.fn(async () => {}),
        bookDir: vi.fn(),
        loadBookConfig: vi.fn(),
        loadChapterIndex: vi.fn(),
        saveChapterIndex: vi.fn(),
        listBooks: vi.fn(async () => []),
      },
    );

    await tools.createBook?.({
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      blurb: "一句话卖点",
      storyBackground: "港城风雨欲来",
      worldPremise: "港口与账本交织",
      novelOutline: "主线推进",
      volumeOutline: "卷纲推进",
      protagonist: "林砚",
      supportingCast: "老账房",
      characterMatrix: "角色矩阵",
      characterArc: "从自保到反击",
      relationshipMap: "关系网",
      conflictCore: "旧债回潮",
      constraints: "题材约束",
      authorIntent: "# 作者意图\n\n写成冷硬、克制、利益驱动的商战悬疑。\n",
      currentFocus: "# 当前聚焦\n\n先把旧账线和港口势力网立住。\n",
    });

    expect(initBook).toHaveBeenCalledTimes(1);
    const call = initBook.mock.calls[0];
    const options = call?.[1] as { foundationBrief?: string } | undefined;
    expect(options?.foundationBrief).toContain("作者意图");
    expect(options?.foundationBrief).toContain("当前聚焦");
    expect(options?.foundationBrief).toContain("港城风雨欲来");
  });
});
