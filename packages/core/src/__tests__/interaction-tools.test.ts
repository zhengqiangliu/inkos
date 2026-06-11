import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger, type LogSink } from "../index.js";
import * as coreIndex from "../index.js";
import {
  buildChapterFileLookup,
  createInteractionToolsFromDeps,
} from "../interaction/project-tools.js";

let projectRoot: string;

describe("interaction tools", () => {
  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-core-interaction-tools-"));
    await mkdir(join(projectRoot, "books", "harbor", "story"), { recursive: true });
  });

  it("delegates writeNextChapter and reviseDraft to the pipeline", async () => {
    const events: string[] = [];
    const sink: LogSink = {
      write(entry) {
        events.push(entry.message);
      },
    };
    const pipeline = {
      config: {
        logger: createLogger({ tag: "test", sinks: [sink] }),
      },
      writeNextChapter: vi.fn(async () => ({
        config: undefined,
        chapterNumber: 1,
        title: "Draft",
        wordCount: 1000,
        revised: false,
        status: "ready-for-review" as const,
        auditResult: { passed: true, issues: [], summary: "ok" },
      })),
      reviseDraft: vi.fn(async () => ({
        chapterNumber: 3,
        wordCount: 1200,
        fixedIssues: [],
        applied: true,
        status: "ready-for-review" as const,
      })),
    };
    const state = {
      ensureControlDocuments: vi.fn(async () => {}),
      bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
      loadBookConfig: vi.fn(async () => ({
        id: "harbor",
        title: "Harbor",
        platform: "other" as const,
        genre: "other",
        status: "outlining" as const,
        targetChapters: 200,
        chapterWordCount: 3000,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      loadChapterIndex: vi.fn(async () => []),
      saveChapterIndex: vi.fn(async () => undefined),
      listBooks: vi.fn(async () => ["harbor"]),
    };

    const tools = createInteractionToolsFromDeps(pipeline, state);

    const writeResult = await tools.writeNextChapter("harbor");
    await tools.reviseDraft("harbor", 3, "rewrite");

    expect(pipeline.writeNextChapter).toHaveBeenCalledWith("harbor");
    expect(pipeline.reviseDraft).toHaveBeenCalledWith("harbor", 3, "rewrite");
    expect((writeResult as { __interaction?: { activeChapterNumber?: number } }).__interaction?.activeChapterNumber).toBe(1);
    expect(events).toEqual([]);
  });

  it("emits thinking and draft callbacks for wizard step generation", async () => {
    const chatWithToolsMock = vi.spyOn(coreIndex, "chatWithTools");
    chatWithToolsMock.mockResolvedValueOnce({
      content: "# 世界观\n\n正文内容",
      toolCalls: [{
        id: "tool-1",
        name: "save_book_wizard_step",
        arguments: JSON.stringify({
          worldPremise: "近未来港口城",
          settingNotes: "账本规则",
        }),
      }],
    } as never);

    const thinking: string[] = [];
    const drafts: string[] = [];
    const rawDrafts: string[] = [];
    const tools = createInteractionToolsFromDeps(
      {
        config: {
          client: {},
          model: "demo-model",
        },
        writeNextChapter: vi.fn(async () => ({
          chapterNumber: 1,
          title: "Draft",
          wordCount: 1000,
          revised: false,
          status: "ready-for-review" as const,
          auditResult: { passed: true, issues: [], summary: "ok" },
        })),
        reviseDraft: vi.fn(async () => ({
          chapterNumber: 3,
          wordCount: 1200,
          fixedIssues: [],
          applied: true,
          status: "ready-for-review" as const,
        })),
      } as any,
      {
        ensureControlDocuments: vi.fn(async () => {}),
        bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
        loadBookConfig: vi.fn(),
        loadChapterIndex: vi.fn(),
        saveChapterIndex: vi.fn(),
        listBooks: vi.fn(async () => ["harbor"]),
      },
      {
        onThinkingDelta: (text: string) => thinking.push(text),
        onDraftTextDelta: (text: string) => drafts.push(text),
        onDraftRawDelta: (text: string) => rawDrafts.push(text),
      } as any,
    );

    await tools.saveBookWizardStep?.("生成世界观", {
      concept: "港城账本",
      missingFields: [],
      readyToCreate: false,
    } as any, "world");

    expect(thinking.length).toBeGreaterThan(0);
    expect(drafts.join("")).toContain("正文内容");
    expect(rawDrafts.join("")).toContain("正文内容");
    chatWithToolsMock.mockRestore();
  });

  it("captures pipeline stage logs into interaction events", async () => {
    const pipeline = {
      config: {
        logger: createLogger({
          tag: "test",
          sinks: [{
            write() {},
          }],
        }),
      },
      writeNextChapter: vi.fn(async function (this: { config: { logger?: { info: (msg: string) => void } } }) {
        this.config.logger?.info("Stage: preparing chapter inputs");
        this.config.logger?.info("Stage: writing chapter draft");
        return {
          chapterNumber: 4,
          title: "Draft",
          wordCount: 1000,
          revised: false,
          status: "ready-for-review" as const,
          auditResult: { passed: true, issues: [], summary: "ok" },
        };
      }),
      reviseDraft: vi.fn(async () => ({
        chapterNumber: 3,
        wordCount: 1200,
        fixedIssues: [],
        applied: true,
        status: "ready-for-review" as const,
      })),
    };
    const state = {
      ensureControlDocuments: vi.fn(async () => {}),
      bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
      loadBookConfig: vi.fn(async () => ({
        id: "harbor",
        title: "Harbor",
        platform: "other" as const,
        genre: "other",
        status: "outlining" as const,
        targetChapters: 200,
        chapterWordCount: 3000,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      loadChapterIndex: vi.fn(async () => []),
      saveChapterIndex: vi.fn(async () => undefined),
      listBooks: vi.fn(async () => ["harbor"]),
    };

    const tools = createInteractionToolsFromDeps(pipeline, state);
    const result = await tools.writeNextChapter("harbor");

    expect((result as {
      __interaction?: {
        events?: ReadonlyArray<{ kind: string; status: string; detail?: string }>;
      };
    }).__interaction?.events).toEqual([
      expect.objectContaining({ kind: "stage.changed", status: "planning", detail: "preparing chapter inputs" }),
      expect.objectContaining({ kind: "stage.changed", status: "writing", detail: "writing chapter draft" }),
    ]);
  });

  it("writes current_focus and author_intent into canonical story paths", async () => {
    const tools = createInteractionToolsFromDeps(
      {
        writeNextChapter: vi.fn(async () => ({
          chapterNumber: 1,
          title: "Draft",
          wordCount: 1000,
          revised: false,
          status: "ready-for-review" as const,
          auditResult: { passed: true, issues: [], summary: "ok" },
        })),
        reviseDraft: vi.fn(async () => ({
          chapterNumber: 3,
          wordCount: 1200,
          fixedIssues: [],
          applied: true,
          status: "ready-for-review" as const,
        })),
      },
      {
        ensureControlDocuments: vi.fn(async () => {}),
        bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
        loadBookConfig: vi.fn(async () => ({
          id: "harbor",
          title: "Harbor",
          platform: "other" as const,
          genre: "other",
          status: "outlining" as const,
          targetChapters: 200,
          chapterWordCount: 3000,
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        })),
        loadChapterIndex: vi.fn(async () => []),
        saveChapterIndex: vi.fn(async () => undefined),
        listBooks: vi.fn(async () => ["harbor"]),
      },
    );

    await tools.updateCurrentFocus("harbor", "# Current Focus\n\nBring focus back.\n");
    await tools.updateAuthorIntent("harbor", "# Author Intent\n\nWrite a harbor mystery.\n");

    await expect(readFile(join(projectRoot, "books", "harbor", "story", "current_focus.md"), "utf-8"))
      .resolves.toContain("Bring focus back");
    await expect(readFile(join(projectRoot, "books", "harbor", "story", "author_intent.md"), "utf-8"))
      .resolves.toContain("harbor mystery");
  });

  it("forwards foundation draft fields into shared book creation", async () => {
    const pipeline = {
      initBook: vi.fn(async () => undefined),
      writeNextChapter: vi.fn(async () => ({
        chapterNumber: 1,
        title: "Draft",
        wordCount: 1000,
        revised: false,
        status: "ready-for-review" as const,
        auditResult: { passed: true, issues: [], summary: "ok" },
      })),
      reviseDraft: vi.fn(async () => ({
        chapterNumber: 3,
        wordCount: 1200,
        fixedIssues: [],
        applied: true,
        status: "ready-for-review" as const,
      })),
    };
    const state = {
      ensureControlDocuments: vi.fn(async () => {}),
      bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
      loadBookConfig: vi.fn(async () => ({
        id: "night-harbor",
        title: "Night Harbor",
        platform: "other" as const,
        genre: "urban",
        status: "outlining" as const,
        targetChapters: 120,
        chapterWordCount: 2800,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      loadChapterIndex: vi.fn(async () => []),
      saveChapterIndex: vi.fn(async () => undefined),
      listBooks: vi.fn(async () => []),
    };

    const tools = createInteractionToolsFromDeps(pipeline, state);
    await tools.createBook?.({
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      blurb: "一个做灰产生意的人，准备在夜港洗白，却先被旧账拖回去。",
      storyBackground: "港城风雨欲来，旧账开始回潮。",
    });

    expect(pipeline.initBook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Night Harbor",
        genre: "urban",
        platform: "tomato",
        creationState: "ready",
      }),
      expect.objectContaining({
        foundationBrief: expect.stringContaining("港城风雨欲来"),
        externalContext: expect.stringContaining("港城风雨欲来"),
      }),
    );
  });

  it("builds a reusable chapter lookup from a single directory listing", () => {
    const lookup = buildChapterFileLookup([
      "0001_First.md",
      "0002_Second.md",
      "notes.txt",
      "0002_Second.backup",
    ]);

    expect(lookup.get(1)).toBe("0001_First.md");
    expect(lookup.get(2)).toBe("0002_Second.md");
    expect(lookup.size).toBe(2);
  });
});
