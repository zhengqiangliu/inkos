import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";

const BOOK: BookConfig = {
  id: "prompt-book",
  title: "Prompt Book",
  platform: "tomato",
  genre: "other",
  status: "active",
  targetChapters: 20,
  chapterWordCount: 3000,
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

const GENRE: GenreProfile = {
  id: "other",
  name: "综合",
  language: "zh",
  chapterTypes: ["setup", "conflict"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

describe("buildWriterSystemPrompt", () => {
  it("demotes always-on methodology blocks in governed mode but keeps opening-three-chapters guardrail by default", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 输入治理契约");
    expect(prompt).toContain("卷纲是默认规划");
    expect(prompt).not.toContain("## 六步走人物心理分析");
    expect(prompt).not.toContain("## 读者心理学框架");
    expect(prompt).toContain("## 黄金三章特殊指令（当前第3章）");
  });

  it("allows disabling opening-three-chapters guardrail in governed mode via book rules", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      {
        version: "1.0",
        prohibitions: [],
        chapterTypesOverride: [],
        fatigueWordsOverride: [],
        additionalAuditDimensions: [],
        enableFullCastTracking: false,
        allowedDeviations: [],
        openingThreeChapters: {
          enabled: true,
          applyInGovernedMode: false,
          strict: true,
          maxCharacters: 5,
        },
      },
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      2,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).not.toContain("## 黄金三章特殊指令");
  });

  it("uses target-range wording when a length spec is provided", () => {
    const lengthSpec = LengthSpecSchema.parse({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "zh_chars",
      normalizeMode: "none",
    });

    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
      lengthSpec,
    );

    expect(prompt).toContain("目标字数：2200");
    expect(prompt).toContain("允许区间：1900-2500");
    expect(prompt).not.toContain("正文不少于2200字");
  });

  it("keeps hard guardrails and book/style constraints in governed mode", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules\n\n- Do not reveal the mastermind.",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 核心规则");
    expect(prompt).toContain("## 硬性禁令");
    expect(prompt).toContain("Do not reveal the mastermind");
    expect(prompt).toContain("Keep the prose restrained");
  });

  it("surfaces an audit gate block before the creative prompt body", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      2,
      "creative",
      undefined,
      "zh",
      "legacy",
      undefined,
      {
        chapterNumber: 2,
        chapterName: "风起",
        highlight: "开局承压",
        coreConflict: "主角要在限定时间内过关",
        plotAndConflict: "动作推进与冲突升级",
        emotionalTone: "紧张",
        endingHook: "门外传来敲门声",
        status: "planned",
        source: "auto",
        version: 1,
        needsReview: false,
        anchorRefs: {
          worldRefs: [],
          characterRefs: [],
          emotionRefs: [],
          hookRefs: [],
        },
        driftFlags: [],
        lockedFields: [],
        hookAssignment: [],
        requiredRecoverHooks: [],
        maxNewHooks: 3,
        maxRecoveryPerChapter: 3,
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
      { hasParentCanon: true },
    );

    expect(prompt).toContain("## 审计门禁");
    expect(prompt).toContain("critical=0 / score>=80 / 结构优先");
    expect(prompt).toContain("章节衔接检查");
    expect(prompt).toContain("伏笔检查");
  });

  it("keeps the full audit preview aligned with chapter-plan-driven priority dimensions", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      2,
      "creative",
      undefined,
      "zh",
      "legacy",
      undefined,
      {
        chapterNumber: 2,
        chapterName: "风起",
        highlight: "开局承压",
        coreConflict: "主角要在限定时间内过关",
        plotAndConflict: "动作推进与冲突升级",
        emotionalTone: "紧张",
        endingHook: "门外传来敲门声",
        status: "planned",
        source: "auto",
        version: 1,
        needsReview: false,
        anchorRefs: {
          worldRefs: [],
          characterRefs: [],
          emotionRefs: [],
          hookRefs: [],
        },
        driftFlags: [],
        lockedFields: [],
        hookAssignment: [],
        requiredRecoverHooks: [],
        maxNewHooks: 3,
        maxRecoveryPerChapter: 3,
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
      { hasParentCanon: true },
    );

    expect(prompt).toContain("## 审计预览");
    expect(prompt).toContain("章节衔接检查");
    expect(prompt).toContain("读者期待管理");
    expect(prompt).toContain("大纲偏离检测");
  });

  it("tells governed English prompts to obey variance briefs and include resistance-bearing exchanges", () => {
    const prompt = buildWriterSystemPrompt(
      {
        ...BOOK,
        language: "en",
      },
      {
        ...GENRE,
        language: "en",
        name: "General",
      },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "en",
      "governed",
    );

    expect(prompt).toContain("English Variance Brief");
    expect(prompt).toContain("resistance-bearing exchange");
  });

  it("surfaces the fuller audit preview in writer prompts", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "legacy",
    );

    expect(prompt).toContain("章节衔接检查");
    expect(prompt).toContain("大纲偏离检测");
    expect(prompt).toContain("读者期待管理");
    expect(prompt).toContain("章节衔接检查");
  });

  it("uses a shorter governed pre-write checklist", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## Governed Pre-Write Checklist");
    expect(prompt).toContain("本章必须推进哪个卷纲节点");
    expect(prompt).toContain("本章的主冲突是什么");
    expect(prompt).not.toContain("## 动笔前必须自问");
  });

  it("includes post-write guardrails that mirror deterministic validator risks", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 写后硬门禁镜像");
    expect(prompt).toContain("分析报告式语言");
    expect(prompt).toContain("章节号");
    expect(prompt).toContain("仿佛");
    expect(prompt).toContain("全场震惊");
  });
});
