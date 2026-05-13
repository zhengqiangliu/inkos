import { describe, expect, it } from "vitest";
import {
  buildChatActionLabels,
  buildChatGuide,
  buildChatQuickTemplates,
  buildConceptSplitSummary,
  buildCreationDraftSummary,
  buildHardParamsSummary,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  platformOptionsForLanguage,
  pickValidValue,
  resolveGenreMapping,
  resolveDraftInstruction,
  parsePositiveIntegerInput,
  shouldSubmitChatOnKeyDown,
  waitForBookReady,
} from "./BookCreate";

describe("pickValidValue", () => {
  it("keeps the current value when it is still available", () => {
    expect(pickValidValue("mystery", ["mystery", "romance"])).toBe("mystery");
  });

  it("falls back to the first available value when current is blank or invalid", () => {
    expect(pickValidValue("", ["mystery", "romance"])).toBe("mystery");
    expect(pickValidValue("invalid", ["mystery", "romance"])).toBe("mystery");
    expect(pickValidValue("", [])).toBe("");
  });
});

describe("defaultChapterWordsForLanguage", () => {
  it("uses 3000 for chinese projects and 2000 for english projects", () => {
    expect(defaultChapterWordsForLanguage("zh")).toBe("3000");
    expect(defaultChapterWordsForLanguage("en")).toBe("2000");
  });
});

describe("platformOptionsForLanguage", () => {
  it("uses stable, unique values for english platform choices", () => {
    const values = platformOptionsForLanguage("en").map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(["royal-road", "kindle-unlimited", "scribble-hub", "other"]);
  });
});

describe("waitForBookReady", () => {
  it("retries until the created book becomes readable", async () => {
    let attempts = 0;

    await expect(waitForBookReady("fresh-book", {
      fetchBook: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Book not found");
        }
      },
      fetchStatus: async () => ({ status: "creating" }),
      delayMs: 0,
      waitImpl: async () => undefined,
    })).resolves.toBeUndefined();

    expect(attempts).toBe(3);
  });

  it("keeps polling while the server still reports the book as creating", async () => {
    let attempts = 0;

    await expect(waitForBookReady("slow-book", {
      fetchBook: async () => {
        attempts += 1;
        if (attempts < 25) {
          throw new Error("Book not found");
        }
      },
      fetchStatus: async () => ({ status: "creating" }),
      delayMs: 0,
      waitImpl: async () => undefined,
    })).resolves.toBeUndefined();

    expect(attempts).toBe(25);
  });

  it("surfaces a clear timeout when the book is still being created", async () => {
    await expect(waitForBookReady("missing-book", {
      fetchBook: async () => {
        throw new Error("Book not found");
      },
      fetchStatus: async () => ({ status: "creating" }),
      maxAttempts: 2,
      delayMs: 0,
      waitImpl: async () => undefined,
    })).rejects.toThrow('Book "missing-book" is still being created. Wait a moment and refresh.');
  });

  it("prefers the server-reported create failure over a polling timeout", async () => {
    await expect(waitForBookReady("broken-book", {
      fetchBook: async () => {
        throw new Error("Book not found");
      },
      fetchStatus: async () => ({ status: "error", error: "INKOS_LLM_API_KEY not set" }),
      delayMs: 0,
      waitImpl: async () => undefined,
    })).rejects.toThrow("INKOS_LLM_API_KEY not set");
  });
});

describe("resolveDraftInstruction", () => {
  it("forces the first ideation turn through /new so an active book does not hijack the flow", () => {
    expect(resolveDraftInstruction("我想写个港风商战悬疑", false)).toBe("/new 我想写个港风商战悬疑");
    expect(resolveDraftInstruction("把世界观改成近未来港口城", true)).toBe("把世界观改成近未来港口城");
  });
});

describe("buildCreationDraftSummary", () => {
  it("includes genre in the shared foundation summary", () => {
    expect(buildCreationDraftSummary({
      concept: "港风商战悬疑，主角从灰产洗白。",
      title: "夜港账本",
      genre: "urban",
      missingFields: [],
      readyToCreate: false,
    }, "zh")).toContainEqual({
      key: "genre",
      label: "题材",
      value: "urban",
    });
  });
});

describe("buildHardParamsSummary", () => {
  it("renders only the hard parameters that matter for final creation", () => {
    expect(buildHardParamsSummary({
      concept: "港风商战悬疑",
      title: "夜港账本",
      platform: "tomato",
      language: "zh",
      targetChapters: 120,
      chapterWordCount: 2800,
      missingFields: [],
      readyToCreate: false,
    }, "zh")).toEqual([
      { key: "title", label: "书名", value: "夜港账本" },
      { key: "platform", label: "平台", value: "tomato" },
      { key: "language", label: "语言", value: "zh" },
      { key: "targetChapters", label: "目标章数", value: "120" },
      { key: "chapterWordCount", label: "每章字数", value: "2800" },
    ]);
  });
});

describe("parsePositiveIntegerInput", () => {
  it("normalizes only positive integers", () => {
    expect(parsePositiveIntegerInput("120")).toBe(120);
    expect(parsePositiveIntegerInput("12.6")).toBe(12);
    expect(parsePositiveIntegerInput("0")).toBeUndefined();
    expect(parsePositiveIntegerInput("-3")).toBeUndefined();
    expect(parsePositiveIntegerInput("abc")).toBeUndefined();
  });
});

describe("buildConceptSplitSummary", () => {
  it("surfaces only the concept split fields", () => {
    expect(buildConceptSplitSummary({
      concept: "港风商战悬疑，主角从灰产洗白。",
      genre: "urban",
      blurb: "港口账本牵出灰产洗白风暴。",
      storyBackground: "港城、账本、灰产洗白。",
      worldPremise: "港口商战和地下账本交织。",
      protagonist: "林砚",
      conflictCore: "洗白与旧债回潮的对撞。",
      missingFields: [],
      readyToCreate: false,
    }, "zh")).toEqual([
      { key: "blurb", label: "一句话卖点", value: "港口账本牵出灰产洗白风暴。" },
      { key: "storyBackground", label: "故事背景种子", value: "港城、账本、灰产洗白。" },
      { key: "worldPremise", label: "世界观种子", value: "港口商战和地下账本交织。" },
      { key: "protagonist", label: "主角", value: "林砚" },
      { key: "conflictCore", label: "核心冲突", value: "洗白与旧债回潮的对撞。" },
    ]);
  });
});

describe("buildChatGuide", () => {
  it("changes the right-side chat guidance by step", () => {
    const intro = buildChatGuide("intro", "zh");
    const review = buildChatGuide("review", "zh");

    expect(intro.placeholder).toContain("卖点");
    expect(intro.examples).toContain("把一句话卖点改得更抓人。");
    expect(intro.advanceLabel).toBe("确认当前页并进入下一步");

    expect(review.placeholder).toContain("书名");
    expect(review.examples).toContain("如果完整就直接确认创建。");
    expect(review.advanceLabel).toBe("确认并创建书籍");
  });
});

describe("buildChatQuickTemplates", () => {
  it("builds step-aware shortcut templates for the chat input", () => {
    const templates = buildChatQuickTemplates("outline", "小说大纲", "卷纲规划", {
      title: "夜港账本",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 3000,
    });

    expect(templates).toHaveLength(3);
    expect(templates[0]?.action).toBe("modify");
    expect(templates[1]?.action).toBe("advance");
    expect(templates[2]?.action).toBe("params");
    expect(templates[0]?.value).toContain("只优化当前小说大纲页");
    expect(templates[1]?.value).toContain("卷纲规划");
    expect(templates[2]?.value).toBe("/params 书名=夜港账本 平台=tomato 目标章数=120 每章字数=3000");
  });
});

describe("buildChatActionLabels", () => {
  it("keeps confirm actions explicit for intro and review", () => {
    const intro = buildChatActionLabels("intro", "世界观", "zh");
    const review = buildChatActionLabels("review", undefined, "zh");

    expect(intro.advanceLabel).toBe("确认并进入 世界观");
    expect(intro.createLabel).toBe("直接创建（跳过确认）");
    expect(review.advanceLabel).toBe("确认并创建书籍");
    expect(review.createLabel).toBe("直接创建（跳过确认）");
  });
});

describe("shouldSubmitChatOnKeyDown", () => {
  it("submits on Enter and keeps Shift+Enter as newline", () => {
    expect(shouldSubmitChatOnKeyDown({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmitChatOnKeyDown({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitChatOnKeyDown({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitChatOnKeyDown({ key: "a", shiftKey: false })).toBe(false);
  });
});

describe("resolveGenreMapping", () => {
  it("maps a custom urban-style genre to the urban master genre", () => {
    const suggestion = resolveGenreMapping("港风商战悬疑", [
      { id: "urban", name: "都市", source: "builtin", language: "zh" },
      { id: "xianxia", name: "仙侠", source: "builtin", language: "zh" },
    ]);

    expect(suggestion?.genre.id).toBe("urban");
    expect(suggestion?.matchedBy).toBe("keyword");
  });
});

describe("canCreateFromDraft", () => {
  it("accepts drafts explicitly marked ready", () => {
    expect(canCreateFromDraft({
      concept: "港风商战悬疑",
      readyToCreate: true,
      missingFields: [],
    })).toBe(true);
  });

  it("accepts drafts that already have the minimum creation fields", () => {
    expect(canCreateFromDraft({
      concept: "港风商战悬疑",
      title: "夜港账本",
      genre: "urban",
      targetChapters: 120,
      chapterWordCount: 2800,
      readyToCreate: false,
      missingFields: [],
    })).toBe(true);
  });

  it("rejects incomplete drafts", () => {
    expect(canCreateFromDraft({
      concept: "港风商战悬疑",
      title: "夜港账本",
      readyToCreate: false,
      missingFields: ["genre", "targetChapters"],
    })).toBe(false);
  });
});

describe("buildCreationDraftSummary", () => {
  it("surfaces the shared foundation draft in a user-facing order", () => {
    expect(buildCreationDraftSummary({
      concept: "港风商战悬疑，主角从灰产洗白。",
      title: "夜港账本",
      genre: "urban",
      worldPremise: "近未来港口城，账本牵出多方势力。",
      protagonist: "林砚，水货账房出身，擅长记账和看人。",
      conflictCore: "洗白与旧债回潮的对撞。",
      volumeOutline: "卷一先查账，再暴露港口旧案。",
      blurb: "一个做灰产生意的人，准备在夜港洗白，却先被旧账拖回去。",
      nextQuestion: "卷一先查账还是先砸场？",
      missingFields: ["targetChapters"],
      readyToCreate: false,
    }, "zh")).toEqual([
      { key: "title", label: "书名", value: "夜港账本" },
      { key: "genre", label: "题材", value: "urban" },
      { key: "worldPremise", label: "世界观", value: "近未来港口城，账本牵出多方势力。" },
      { key: "protagonist", label: "主角", value: "林砚，水货账房出身，擅长记账和看人。" },
      { key: "conflictCore", label: "核心冲突", value: "洗白与旧债回潮的对撞。" },
      { key: "volumeOutline", label: "卷纲方向", value: "卷一先查账，再暴露港口旧案。" },
      { key: "blurb", label: "简介", value: "一个做灰产生意的人，准备在夜港洗白，却先被旧账拖回去。" },
      { key: "nextQuestion", label: "下一步", value: "卷一先查账还是先砸场？" },
    ]);
  });
});
