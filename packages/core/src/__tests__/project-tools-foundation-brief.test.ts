import { describe, expect, it, vi } from "vitest";
import { createInteractionToolsFromDeps } from "../interaction/project-tools.js";

describe("project tools foundation brief", () => {
  it("passes only intro content into the foundation brief when creating a book", async () => {
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
    });

    expect(initBook).toHaveBeenCalledTimes(1);
    const call = initBook.mock.calls[0];
    const options = call?.[1] as { foundationBrief?: string } | undefined;
    expect(options?.foundationBrief).toContain("港城风雨欲来");
    expect(options?.foundationBrief).toContain("一句话卖点");
  });
});
