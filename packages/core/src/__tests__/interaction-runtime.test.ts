import { describe, expect, it, vi } from "vitest";
import { InteractionSessionSchema, validateCreationDraftConsistency } from "../interaction/session.js";
import { runInteractionRequest } from "../interaction/runtime.js";

function makeTools(overrides: Partial<Parameters<typeof runInteractionRequest>[0]["tools"]> = {}) {
  return {
    listBooks: vi.fn(async () => ["harbor"]),
    developBookDraft: vi.fn(),
    advanceBookWizard: vi.fn(),
    createBook: vi.fn(),
    exportBook: vi.fn(),
    writeNextChapter: vi.fn(),
    reviseDraft: vi.fn(),
    patchChapterText: vi.fn(),
    renameEntity: vi.fn(),
    updateCurrentFocus: vi.fn(),
    updateAuthorIntent: vi.fn(),
    writeTruthFile: vi.fn(),
    ...overrides,
  };
}

describe("interaction runtime", () => {
  it("routes develop_book through the shared draft tool and updates the creation draft", async () => {
    const developBookDraft = vi.fn(async () => ({
      __interaction: {
        responseText: "我先按港风商战悬疑收着。你更想写长篇连载，还是十来章能收住？",
        details: {
          creationDraft: {
            concept: "港风商战悬疑，主角从灰产洗白。",
            title: "夜港账本",
            genre: "urban",
            nextQuestion: "更想写长篇连载，还是十来章能收住？",
            missingFields: ["targetChapters"],
            readyToCreate: false,
          },
        },
      },
    }));

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-draft",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: {
        intent: "develop_book",
        instruction: "我想写个港风商战悬疑，主角从灰产洗白。",
      },
      tools: makeTools({
        developBookDraft,
      }),
    });

    expect(developBookDraft).toHaveBeenCalledWith("我想写个港风商战悬疑，主角从灰产洗白。", undefined, undefined);
    expect(result.session.creationDraft).toEqual(expect.objectContaining({
      rawConcept: "港风商战悬疑，主角从灰产洗白。",
      title: "夜港账本",
      genre: "urban",
    }));
    expect(result.responseText).toContain("港风商战悬疑");
  });

  it("selects a genre from the shared genre library and seeds a draft", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-genre",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: {
        intent: "select_genre",
        genre: "urban",
        genreName: "都市",
        genreAlias: "港风商战悬疑",
        genreSource: "custom",
      },
      tools: makeTools(),
    });

    expect(result.session.creationDraft).toEqual(expect.objectContaining({
      concept: "都市",
      genre: "urban",
      genreSource: "custom",
      genreAlias: "港风商战悬疑",
      mappedGenreId: "urban",
      nextQuestion: expect.stringContaining("故事概述"),
    }));
    expect(result.session.creationWizard?.currentStep).toBe("intro");
    expect(result.responseText).toContain("都市");
  });

  it("stores hard book parameters before the final create step", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-hard-params",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        creationDraft: {
          concept: "港风商战悬疑",
          genre: "urban",
          missingFields: [],
          readyToCreate: false,
        },
        messages: [],
        events: [],
      }),
      request: {
        intent: "set_book_draft_params",
        title: "夜港账本",
        platform: "tomato",
        language: "zh",
        targetChapters: 120,
        chapterWordCount: 2800,
      },
      tools: makeTools(),
    });

    expect(result.session.creationDraft).toEqual(expect.objectContaining({
      rawConcept: "港风商战悬疑",
      title: "夜港账本",
      platform: "tomato",
      language: "zh",
      targetChapters: 120,
      chapterWordCount: 2800,
      confirmedFields: expect.arrayContaining(["title", "platform", "language", "targetChapters", "chapterWordCount"]),
      draftFields: expect.objectContaining({
        title: "夜港账本",
        platform: "tomato",
        targetChapters: "120",
        chapterWordCount: "2800",
      }),
    }));
    expect(result.responseText).toContain("夜港账本");
    expect(result.responseText).toContain("120");
  });

  it("routes advance_book_wizard through the shared wizard tool and advances to the next step", async () => {
    const advanceBookWizard = vi.fn(async () => ({
      __interaction: {
        responseText: "已生成简介 / 故事背景并进入世界观。",
        details: {
          creationDraft: {
            concept: "港风商战悬疑，主角从灰产洗白。",
            blurb: "港口账本牵出灰产洗白风暴。",
            storyBackground: "港城、账本、灰产洗白。",
            missingFields: [],
            readyToCreate: false,
          },
        },
      },
    }));

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-wizard",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        creationWizard: {
          currentStep: "intro",
          completedSteps: [],
          stepNotes: {},
        },
        messages: [],
        events: [],
      }),
      request: {
        intent: "advance_book_wizard",
        instruction: "确认当前简介页，进入世界观。",
        wizardStep: "intro",
      },
      tools: makeTools({
        advanceBookWizard,
      }),
    });

    expect(advanceBookWizard).toHaveBeenCalledWith("确认当前简介页，进入世界观。", undefined, "intro");
    expect(result.session.creationDraft).toEqual(expect.objectContaining({
      blurb: "港口账本牵出灰产洗白风暴。",
      storyBackground: "港城、账本、灰产洗白。",
    }));
    expect(result.session.creationWizard?.currentStep).toBe("world");
    expect(result.session.creationWizard?.completedSteps).toContain("intro");
  });

  it("routes retreat_book_wizard and moves the wizard back one step without clearing the draft", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-retreat",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        creationDraft: {
          concept: "港风商战悬疑，主角从灰产洗白。",
          blurb: "港口账本牵出灰产洗白风暴。",
          storyBackground: "港城、账本、灰产洗白。",
          missingFields: [],
          readyToCreate: false,
        },
        creationWizard: {
          currentStep: "world",
          completedSteps: ["intro", "world"],
          stepNotes: {},
        },
        messages: [],
        events: [],
      }),
      request: {
        intent: "retreat_book_wizard",
        wizardStep: "world",
      },
      tools: makeTools(),
    });

    expect(result.session.creationDraft).toEqual(expect.objectContaining({
      blurb: "港口账本牵出灰产洗白风暴。",
    }));
    expect(result.session.creationWizard?.currentStep).toBe("intro");
    expect(result.session.creationWizard?.completedSteps).toContain("intro");
  });

  it("rejects incomplete drafts at final create time", async () => {
    const consistency = validateCreationDraftConsistency({
      concept: "港风商战悬疑，主角从灰产洗白。",
      title: "夜港账本",
      genre: "urban",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 2800,
      missingFields: [],
      readyToCreate: false,
    });

    expect(consistency.readyToCreate).toBe(false);
    expect(consistency.missingFields.length).toBeGreaterThan(0);
  });

  it("routes create_book through the shared create tool and binds the created book", async () => {
    const fullDraft = {
      concept: "港风商战悬疑，主角从灰产洗白。",
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 2800,
      blurb: "港口账本牵出灰产洗白风暴。",
      storyBackground: "港城、账本、灰产洗白。",
      worldPremise: "港口商战和地下账本交织。",
      novelOutline: "从查账到洗白，再到反转清算。",
      volumeOutline: "三卷结构，逐步升级。",
      protagonist: "林砚",
      supportingCast: "老账房、码头经理、警方线人",
      characterMatrix: "主角、对立方、盟友",
      characterArc: "从自保到主动反击",
      relationshipMap: "合作、利用、背叛",
      conflictCore: "洗白与旧债回潮的对撞",
      readyToCreate: true,
      missingFields: [],
    };

    expect(validateCreationDraftConsistency(fullDraft)).toEqual({
      readyToCreate: true,
      missingFields: [],
      warnings: [],
    });

    const createBook = vi.fn(async () => ({
      bookId: "night-harbor",
      title: "Night Harbor",
      __interaction: {
        responseText: "Created Night Harbor.",
      },
    }));

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-create",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        creationDraft: fullDraft,
        messages: [],
        events: [],
      }),
      request: {
        intent: "create_book",
      },
      tools: makeTools({
        createBook,
      }),
    });

    expect(createBook).toHaveBeenCalledWith(expect.objectContaining({
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 2800,
    }));
    expect(result.session.activeBookId).toBe("night-harbor");
    expect(result.session.creationDraft).toBeUndefined();
    expect(result.responseText).toContain("Created Night Harbor.");
  });

  it("blocks create_book when foundation data is incomplete", async () => {
    await expect(runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-create-blocked",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        creationDraft: {
          concept: "港风商战悬疑，主角从灰产洗白。",
          title: "Night Harbor",
          genre: "urban",
          platform: "tomato",
          targetChapters: 120,
          chapterWordCount: 2800,
          blurb: "港口账本牵出灰产洗白风暴。",
          missingFields: ["world"],
          readyToCreate: false,
        },
        messages: [],
        events: [],
      }),
      request: {
        intent: "create_book",
      },
      tools: makeTools(),
    })).rejects.toThrow("基础资料尚未完成");
  });

  it("clears the creation draft when discard_book_draft is requested", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-discard",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        creationDraft: {
          concept: "港风商战悬疑，主角从灰产洗白。",
          title: "夜港账本",
          readyToCreate: false,
          missingFields: ["genre"],
        },
        messages: [],
        events: [],
      }),
      request: {
        intent: "discard_book_draft",
      },
      tools: makeTools(),
    });

    expect(result.session.creationDraft).toBeUndefined();
    expect(result.responseText).toContain("已丢弃");
  });

  it("renders the current creation draft when show_book_draft is requested", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-show-draft",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        creationDraft: {
          concept: "港风商战悬疑，主角从灰产洗白。",
          title: "夜港账本",
          genre: "urban",
          worldPremise: "近未来港口城，账本牵出多方势力。",
          protagonist: "林砚，水货账房出身，擅长记账和看人。",
          conflictCore: "洗白与旧债回潮的对撞。",
          nextQuestion: "卷一先查账还是先砸场？",
          missingFields: ["targetChapters"],
          readyToCreate: false,
        },
        messages: [],
        events: [],
      }),
      request: {
        intent: "show_book_draft",
      },
      tools: makeTools(),
    });

    expect(result.responseText).toContain("夜港账本");
    expect(result.responseText).toContain("近未来港口城");
    expect(result.responseText).toContain("卷一先查账还是先砸场");
  });

  it("routes export_book through the shared export tool", async () => {
    const exportBook = vi.fn(async () => ({
      outputPath: "/tmp/project/exports/harbor.md",
      chaptersExported: 9,
      __interaction: {
        responseText: "Exported harbor to /tmp/project/exports/harbor.md",
      },
    }));

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-export",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: {
        intent: "export_book",
        bookId: "harbor",
        format: "md",
        approvedOnly: true,
        outputPath: "/tmp/project/exports/harbor.md",
      },
      tools: makeTools({
        exportBook,
      }),
    });

    expect(exportBook).toHaveBeenCalledWith("harbor", {
      format: "md",
      approvedOnly: true,
      outputPath: "/tmp/project/exports/harbor.md",
    });
    expect(result.responseText).toContain("Exported harbor");
  });

  it("keeps write_next completed in auto mode", async () => {
    const writeNextChapter = vi.fn(async () => ({
      chapterNumber: 7,
      title: "Harbor Ledger",
      wordCount: 3210,
      revised: false,
      status: "ready-for-review" as const,
    }));
    const reviseDraft = vi.fn();
    const updateCurrentFocus = vi.fn();
    const updateAuthorIntent = vi.fn();
    const writeTruthFile = vi.fn();

    const session = InteractionSessionSchema.parse({
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      activeBookId: "harbor",
      automationMode: "auto",
      messages: [],
      events: [],
    });

    const result = await runInteractionRequest({
      session,
      request: { intent: "write_next", bookId: "harbor" },
      tools: makeTools({
        writeNextChapter,
        reviseDraft,
        updateCurrentFocus,
        updateAuthorIntent,
        writeTruthFile,
      }),
    });

    expect(writeNextChapter).toHaveBeenCalledWith("harbor");
    expect(reviseDraft).not.toHaveBeenCalled();
    expect(result.session.activeBookId).toBe("harbor");
    expect(result.session.activeChapterNumber).toBe(7);
    expect(result.session.currentExecution?.status).toBe("completed");
    expect(result.session.pendingDecision).toBeUndefined();
    expect(result.session.events.map((event) => event.kind)).toEqual([
      "task.started",
      "task.completed",
    ]);
  });

  it("moves content-producing work into waiting_human in semi mode", async () => {
    const writeNextChapter = vi.fn(async () => ({
      chapterNumber: 7,
      title: "Harbor Ledger",
      wordCount: 3210,
      revised: false,
      status: "ready-for-review" as const,
      auditResult: { passed: true, issues: [], summary: "ok" },
      __interaction: {
        events: [{
          kind: "stage.changed",
          timestamp: 1710000000000,
          status: "writing" as const,
          bookId: "harbor",
          chapterNumber: 7,
          detail: "writing chapter draft",
        }],
      },
    }));

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-1b",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: { intent: "write_next", bookId: "harbor" },
      tools: makeTools({
        writeNextChapter,
      }),
    });

    expect(result.session.currentExecution?.status).toBe("waiting_human");
    expect(result.session.pendingDecision?.kind).toBe("review-next-step");
    expect(result.session.pendingDecision?.chapterNumber).toBe(7);
    expect(result.session.events.map((event) => event.kind)).toEqual([
      "task.started",
      "stage.changed",
      "task.completed",
    ]);
    expect(result.responseText).toContain("等待你的下一步决定");
  });

  it("routes revise_chapter to reviseDraft with local-fix", async () => {
    const writeNextChapter = vi.fn();
    const reviseDraft = vi.fn(async () => ({
      chapterNumber: 3,
      wordCount: 2800,
      fixedIssues: ["tightened ending"],
      applied: true,
      status: "ready-for-review" as const,
    }));

    const session = InteractionSessionSchema.parse({
      sessionId: "session-2",
      projectRoot: "/tmp/project",
      activeBookId: "harbor",
      automationMode: "manual",
      messages: [],
    });

    await runInteractionRequest({
      session,
      request: { intent: "revise_chapter", bookId: "harbor", chapterNumber: 3 },
      tools: makeTools({
        writeNextChapter,
        reviseDraft,
      }),
    });

    expect(reviseDraft).toHaveBeenCalledWith("harbor", 3, "local-fix");
  });

  it("routes rewrite_chapter to reviseDraft with rewrite mode", async () => {
    const reviseDraft = vi.fn(async () => ({
      chapterNumber: 5,
      wordCount: 3100,
      fixedIssues: ["rewrote chapter"],
      applied: true,
      status: "ready-for-review" as const,
    }));

    await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-3",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "manual",
        messages: [],
      }),
      request: { intent: "rewrite_chapter", bookId: "harbor", chapterNumber: 5 },
      tools: makeTools({
        reviseDraft,
      }),
    });

    expect(reviseDraft).toHaveBeenCalledWith("harbor", 5, "rewrite");
  });

  it("routes update_focus to the focus updater", async () => {
    const updateCurrentFocus = vi.fn(async () => ({ ok: true }));

    await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-4",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
      }),
      request: {
        intent: "update_focus",
        bookId: "harbor",
        instruction: "Bring the story back to the old harbor debt line.",
      },
      tools: makeTools({
        updateCurrentFocus,
      }),
    });

    expect(updateCurrentFocus).toHaveBeenCalledWith(
      "harbor",
      "Bring the story back to the old harbor debt line.",
    );
  });

  it("answers chat-style requests without forcing a status summary", async () => {
    const chat = vi.fn(async () => ({
      __interaction: {
        responseText: "你好，我在。当前没有活动书，要不要先说说你想写什么？",
      },
    }));

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-chat",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: {
        intent: "chat",
        bookId: "harbor",
        instruction: "hi",
      },
      tools: makeTools({
        chat,
      }),
    });

    expect(chat).toHaveBeenCalledWith("hi", {
      bookId: "harbor",
      automationMode: "semi",
    });
    expect(result.responseText).toContain("你好");
    expect(result.responseText).not.toContain("Current status");
    expect(result.session.events.map((event) => event.kind)).toEqual([
      "task.started",
      "task.completed",
    ]);
  });

  it("routes edit_truth to the truth-file updater", async () => {
    const writeTruthFile = vi.fn(async () => ({ ok: true }));

    await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-4b",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: {
        intent: "edit_truth",
        bookId: "harbor",
        fileName: "current_focus.md",
        instruction: "# Current Focus\n\nBring the story back to the old harbor debt line.\n",
      },
      tools: makeTools({
        writeTruthFile,
      }),
    });

    expect(writeTruthFile).toHaveBeenCalledWith(
      "harbor",
      "current_focus.md",
      "# Current Focus\n\nBring the story back to the old harbor debt line.\n",
    );
  });

  it("routes rename_entity to the rename tool", async () => {
    const renameEntity = vi.fn(async () => ({ ok: true }));

    await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-4c",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "manual",
        messages: [],
        events: [],
      }),
      request: {
        intent: "rename_entity",
        bookId: "harbor",
        oldValue: "陆尘",
        newValue: "林砚",
      },
      tools: makeTools({
        renameEntity,
      }),
    });

    expect(renameEntity).toHaveBeenCalledWith("harbor", "陆尘", "林砚");
  });

  it("routes patch_chapter_text to the chapter patch tool and waits for review", async () => {
    const patchChapterText = vi.fn(async () => ({
      chapterNumber: 3,
      __interaction: {
        responseText: "Patched chapter 3 and marked it for review.",
      },
    }));

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-4d",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: {
        intent: "patch_chapter_text",
        bookId: "harbor",
        chapterNumber: 3,
        targetText: "旧名字",
        replacementText: "新名字",
      },
      tools: makeTools({
        patchChapterText,
      }),
    });

    expect(patchChapterText).toHaveBeenCalledWith("harbor", 3, "旧名字", "新名字");
    expect(result.session.currentExecution?.status).toBe("waiting_human");
    expect(result.session.pendingDecision?.chapterNumber).toBe(3);
    expect(result.responseText).toContain("marked it for review");
  });

  it("updates automation mode without invoking pipeline tools", async () => {
    const writeNextChapter = vi.fn();
    const reviseDraft = vi.fn();
    const updateCurrentFocus = vi.fn();
    const updateAuthorIntent = vi.fn();
    const writeTruthFile = vi.fn();

    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-5",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: { intent: "switch_mode", mode: "auto" },
      tools: makeTools({
        writeNextChapter,
        reviseDraft,
        updateCurrentFocus,
        updateAuthorIntent,
        writeTruthFile,
      }),
    });

    expect(result.session.automationMode).toBe("auto");
    expect(writeNextChapter).not.toHaveBeenCalled();
    expect(reviseDraft).not.toHaveBeenCalled();
    expect(updateCurrentFocus).not.toHaveBeenCalled();
    expect(updateAuthorIntent).not.toHaveBeenCalled();
    expect(result.session.events.map((event) => event.kind)).toEqual([
      "task.started",
      "task.completed",
    ]);
  });

  it("binds the selected book without invoking pipeline tools", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-5b",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: { intent: "select_book", bookId: "beta" },
      tools: makeTools({
        listBooks: vi.fn(async () => ["harbor", "beta"]),
      }),
    });

    expect(result.session.activeBookId).toBe("beta");
    expect(result.responseText).toContain("beta");
  });

  it("lists project books through the shared runtime", async () => {
    const listBooks = vi.fn(async () => ["harbor", "beta"]);
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-5c",
        projectRoot: "/tmp/project",
        automationMode: "semi",
        messages: [],
        events: [],
      }),
      request: { intent: "list_books" },
      tools: makeTools({
        listBooks,
      }),
    });

    expect(listBooks).toHaveBeenCalledTimes(1);
    expect(result.responseText).toContain("harbor");
    expect(result.responseText).toContain("beta");
  });

  it("pauses the active book without invoking pipeline tools", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-6",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "auto",
        messages: [],
        events: [],
      }),
      request: { intent: "pause_book", bookId: "harbor" },
      tools: makeTools(),
    });

    expect(result.session.currentExecution?.status).toBe("blocked");
    expect(result.responseText).toContain("已暂停");
    expect(result.session.events.map((event) => event.kind)).toEqual([
      "task.started",
      "task.completed",
    ]);
  });

  it("returns a human-readable explanation for explain_status", async () => {
    const result = await runInteractionRequest({
      session: InteractionSessionSchema.parse({
        sessionId: "session-7",
        projectRoot: "/tmp/project",
        activeBookId: "harbor",
        automationMode: "semi",
        messages: [],
        events: [],
        currentExecution: {
          status: "repairing",
          bookId: "harbor",
          chapterNumber: 3,
          stageLabel: "repairing chapter 3",
        },
      }),
      request: { intent: "explain_status", bookId: "harbor", instruction: "what are you doing?" },
      tools: makeTools(),
    });

    expect(result.responseText).toContain("repairing");
    expect(result.responseText).toContain("harbor");
  });
});
