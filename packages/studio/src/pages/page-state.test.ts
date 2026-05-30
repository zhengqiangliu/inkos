import { describe, expect, it } from "vitest";
import {
  buildChatActionLabels,
  buildChatGuide,
  buildChatQuickTemplates,
  buildConceptSplitSummary,
  buildCreationReviewChecklist,
  buildIntroCandidateBackfill,
  buildHardParamsSummary,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  platformOptionsForLanguage,
  pickValidValue,
  resolveGenreMapping,
  resolveDraftInstruction,
  parsePositiveIntegerInput,
  parseIntroCandidateResponse,
  parseLatestIntroCandidates,
  rankIntroCandidates,
  buildStepFocusCard,
  buildStepActionSections,
  buildStepRecommendedAction,
  buildStepShortcuts,
  resolveInitialGenreSelection,
  selectBookCreateDockMessages,
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

describe("resolveInitialGenreSelection", () => {
  it("prefers the draft genre, then the project language, then the first available genre", () => {
    const genres = [
      { id: "urban", name: "都市", language: "zh" },
      { id: "fantasy", name: "Fantasy", language: "en" },
    ];

    expect(resolveInitialGenreSelection("", genres, "fantasy", "zh")).toBe("fantasy");
    expect(resolveInitialGenreSelection("", genres, undefined, "en")).toBe("fantasy");
    expect(resolveInitialGenreSelection("", genres, undefined, "zh")).toBe("urban");
  });
});

describe("buildChatGuide", () => {
  it("keeps intro guidance focused on the seed inputs", () => {
    const intro = buildChatGuide("intro", "zh");
    expect(intro.placeholder).toContain("题材");
    expect(intro.examples.some((item) => item.includes("候选"))).toBe(true);
  });
});

describe("buildCreationReviewChecklist", () => {
  it("renders step-level review items with completion states and jump targets", () => {
    const checklist = buildCreationReviewChecklist({
      title: "夜港账本",
      genre: "urban",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 3000,
      blurb: "港口账本牵出灰产链。",
      storyBackground: "港城、账本、洗白、反转。",
      novelOutline: "主线清晰",
    }, "zh");

    expect(checklist.map((item) => item.key)).toEqual([
      "basic",
      "intro",
      "world",
      "outline",
      "volume",
      "characters",
      "arc",
      "relation",
      "review",
    ]);
    expect(checklist[0]?.done).toBe(true);
    expect(checklist[1]?.done).toBe(true);
    expect(checklist[2]?.done).toBe(false);
    expect(checklist[2]?.target.kind).toBe("step");
    expect(checklist[2]?.target.kind === "step" ? checklist[2]?.target.step : undefined).toBe("world");
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
    expect(review.examples).toContain("先核对分项是否齐全，再完成创建。");
    expect(review.advanceLabel).toBe("复核并完成创建");
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
    expect(intro.createLabel).toBe("完成创建");
    expect(review.advanceLabel).toBe("复核并完成创建");
    expect(review.createLabel).toBe("完成创建");
  });
});

describe("selectBookCreateDockMessages", () => {
  it("keeps the dock scoped to the current wizard step and counts legacy messages", () => {
    const result = selectBookCreateDockMessages([
      { role: "user", content: "intro question", wizardStep: "intro" },
      { role: "assistant", content: "intro answer", wizardStep: "intro" },
      { role: "assistant", content: "world answer", wizardStep: "world" },
      { role: "assistant", content: "legacy answer" },
    ], "intro");

    expect(result.visibleMessages).toHaveLength(2);
    expect(result.visibleMessages.every((item: { wizardStep?: string }) => item.wizardStep === "intro")).toBe(true);
    expect(result.legacyMessageCount).toBe(1);
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

describe("parseIntroCandidateResponse", () => {
  it("parses candidate JSON from fenced model output", () => {
    expect(parseIntroCandidateResponse(`\`\`\`json
[
  {
    "title": "候选 A",
    "blurb": "一句话卖点 A",
    "storyBackground": "故事背景 A",
    "hook": "引爆点 A",
    "style": "都市悬疑",
    "reason": "适合快速抓人"
  }
]
\`\`\``)).toEqual([
      {
        title: "候选 A",
        blurb: "一句话卖点 A",
        storyBackground: "故事背景 A",
        hook: "引爆点 A",
        style: "都市悬疑",
        reason: "适合快速抓人",
      },
    ]);
  });

  it("parses multiple text-block candidates when the model does not emit strict JSON", () => {
    expect(parseIntroCandidateResponse(`
候选 1
title: 夜港账本
blurb: 港口账本牵出灰产链。
storyBackground: 港城、账本、洗白、反转。
style: 都市商战
reason: 适合快节奏抓人

候选 2
title: 雾港来信
blurb: 一封旧信撬开失踪案。
storyBackground: 雾港、旧案、家族秘密。
style: 都市悬疑
reason: 适合强悬念开局
    `)).toEqual([
      {
        title: "夜港账本",
        blurb: "港口账本牵出灰产链。",
        storyBackground: "港城、账本、洗白、反转。",
        style: "都市商战",
        reason: "适合快节奏抓人",
      },
      {
        title: "雾港来信",
        blurb: "一封旧信撬开失踪案。",
        storyBackground: "雾港、旧案、家族秘密。",
        style: "都市悬疑",
        reason: "适合强悬念开局",
      },
    ]);
  });

  it("extracts candidates from noisy mixed text that wraps a JSON array", () => {
    expect(parseIntroCandidateResponse(`
先给你三套候选，直接选即可。
[
  {
    "title": "候选 A",
    "blurb": "卖点 A",
    "storyBackground": "背景 A",
    "style": "都市商战",
    "reason": "节奏快"
  },
  {
    "title": "候选 B",
    "blurb": "卖点 B",
    "storyBackground": "背景 B",
    "style": "都市悬疑",
    "reason": "悬念强"
  },
  {
    "title": "候选 C",
    "blurb": "卖点 C",
    "storyBackground": "背景 C",
    "style": "都市情感",
    "reason": "情绪重"
  }
]
如果要我继续，我可以按 1/2/3 展开。
    `)).toHaveLength(3);
  });
});

describe("parseLatestIntroCandidates", () => {
  it("picks the latest assistant message that contains candidate JSON", () => {
    const candidates = parseLatestIntroCandidates([
      { role: "user", content: "生成候选" },
      { role: "assistant", content: "先给你候选" },
      { role: "assistant", content: `[
        {"title":"A","blurb":"a","storyBackground":"sa"},
        {"title":"B","blurb":"b","storyBackground":"sb"}
      ]` },
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.title).toBe("A");
  });
});

describe("buildIntroCandidateBackfill", () => {
  it("converts a candidate into the manual intro seed text", () => {
    expect(buildIntroCandidateBackfill({
      title: "候选 A",
      blurb: "一句话卖点 A",
      storyBackground: "故事背景 A",
      style: "都市悬疑",
      reason: "适合强悬念开局",
    })).toBe("简介/卖点：一句话卖点 A\n\n故事背景：故事背景 A");
  });
});

describe("rankIntroCandidates", () => {
  it("prefers candidates matching the selected style preset", () => {
    const ranked = rankIntroCandidates([
      {
        title: "仙门秘闻",
        blurb: "少年踏入仙门，意外卷入旧约。",
        storyBackground: "仙门、灵气、宗门博弈。",
      },
      {
        title: "夜港账本",
        blurb: "一份账本掀翻港城灰产链。",
        storyBackground: "都市、商战、灰产、反转。",
        style: "都市商战",
      },
    ], "urban");

    expect(ranked[0]?.title).toBe("夜港账本");
  });
});

describe("buildStepFocusCard", () => {
  it("surfaces intro focus and missing fields", () => {
    const focus = buildStepFocusCard("intro", {
      concept: "港风商战悬疑",
      blurb: "港口账本牵出灰产风暴。",
      missingFields: [],
      readyToCreate: false,
    }, "zh");

    expect(focus.title).toContain("简介");
    expect(focus.highlights.some((line: string) => line.includes("一句话卖点"))).toBe(true);
    expect(focus.missing).toContain("故事背景");
  });

  it("surfaces world focus without intro summary text", () => {
    const focus = buildStepFocusCard("world", {
      concept: "港风商战悬疑",
      worldPremise: "港口城规和商帮冲突。",
      settingNotes: "夜港通行税。",
      missingFields: [],
      readyToCreate: false,
    }, "zh");

    expect(focus.title).toContain("世界观焦点");
    expect(focus.highlights.join(" ")).toContain("世界观");
    expect(focus.highlights.join(" ")).not.toContain("一句话卖点");
    expect(focus.highlights.join(" ")).not.toContain("故事背景");
    expect(focus.missing.join(" ")).not.toContain("简介");
  });

  it("surfaces review gaps when creation fields are missing", () => {
    const focus = buildStepFocusCard("review", {
      concept: "港风商战悬疑",
      title: "夜港账本",
      genre: "urban",
      readyToCreate: false,
      missingFields: ["targetChapters"],
    }, "zh");

    expect(focus.missing).toContain("目标章数");
  });
});

describe("buildStepShortcuts", () => {
  it("includes page-specific actions for intro", () => {
    const shortcuts = buildStepShortcuts("intro", {
      title: "当前焦点：简介 / 故事背景",
      description: "说一句话卖点、故事背景和主角处境，让系统把当前页拆清楚。",
      highlights: [],
      missing: ["故事背景"],
    }, "世界观", "zh");

    expect(shortcuts[0]?.label).toBe("生成卖点候选");
    expect(shortcuts[0]?.kind).toBe("generate");
    expect(shortcuts.some((item) => item.label === "按风格重抽")).toBe(true);
    expect(shortcuts[0]?.value).toContain("候选池");
  });

  it("adds stronger structural hints for world and review pages", () => {
    const worldShortcuts = buildStepShortcuts("world", {
      title: "当前焦点：世界观",
      description: "定义规则、势力和边界。",
      highlights: [],
      missing: ["世界观"],
    }, "小说大纲", "zh");
    const reviewShortcuts = buildStepShortcuts("review", {
      title: "当前焦点：最终确认",
      description: "这里只做核对和补缺口，确认无误后才创建书籍。",
      highlights: ["书名：夜港账本"],
      missing: ["目标章数"],
    }, undefined, "zh");

    expect(worldShortcuts[0]?.value).toContain("规则、势力、资源、边界");
    expect(reviewShortcuts[0]?.value).toContain("书名、题材、章数、字数");
  });
});

describe("buildStepActionSections", () => {
  it("groups actions into explicit workbench sections", () => {
    const sections = buildStepActionSections("review", {
      title: "当前焦点：最终确认",
      description: "这里只做核对和补缺口，确认无误后才创建书籍。",
      highlights: ["书名：夜港账本"],
      missing: ["目标章数"],
    }, undefined, "zh");

    expect(sections.map((section) => section.title)).toEqual(["修订", "定稿"]);
    expect(sections[0]?.items.some((item) => item.kind === "revise")).toBe(true);
    expect(sections[1]?.items.some((item) => item.kind === "create")).toBe(true);
  });
});

describe("buildStepRecommendedAction", () => {
  it("prefers candidate generation on intro when no candidates exist", () => {
    const action = buildStepRecommendedAction({
      step: "intro",
      focusCard: {
        title: "当前焦点：简介 / 故事背景",
        description: "先把卖点和故事起点定住。",
        highlights: [],
        missing: ["故事背景"],
      },
      language: "zh",
      hasIntroCandidates: false,
    });

    expect(action.shortcut.kind).toBe("generate");
    expect(action.shortcut.label).toContain("候选");
  });

  it("prefers create on review when the draft is ready", () => {
    const action = buildStepRecommendedAction({
      step: "review",
      focusCard: {
        title: "当前焦点：最终确认",
        description: "这里只做核对和补缺口，确认无误后才创建书籍。",
        highlights: ["书名：夜港账本"],
        missing: [],
      },
      language: "zh",
      canCreate: true,
    });

    expect(action.shortcut.kind).toBe("create");
    expect(action.reason).toContain("创建");
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

