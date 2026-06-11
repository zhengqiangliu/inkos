import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as llmProvider from "../llm/provider.js";
import { buildFallbackIntroRevisionOutput, buildIntroRevisionPrompt, buildWizardPrompt, createInteractionToolsFromDeps, normalizeIntroRevisionOutput } from "../interaction/project-tools.js";
import { StateManager } from "../state/manager.js";

describe("wizard prompt templates", () => {
  it("renders the intro page prompt with the intro framework only", () => {
    const prompt = buildWizardPrompt("intro", "generate", "我想写港风商战悬疑");
    expect(prompt).toContain("当前步骤：简介 / 故事背景");
    expect(prompt).toContain("一句话卖点");
    expect(prompt).toContain("故事背景");
    expect(prompt).not.toContain("时间 / 空间背景");
    expect(prompt).not.toContain("卷纲规划");
  });

  it("renders a structured intro revision prompt", () => {
    const prompt = buildWizardPrompt(
      "intro",
      "generate",
      "请按题材和主题生成正式简介",
      {
        blurb: "港口账本牵出灰产洗白风暴。",
        storyBackground: "港城、账本、灰产洗白。",
      } as any,
    );
    expect(prompt).toContain("当前步骤：简介 / 故事背景");
    expect(prompt).toContain("模式：生成正式简介");
    expect(prompt).toContain("内容框架必须包含");
    expect(prompt).toContain("一句话卖点");
    expect(prompt).toContain("故事背景");
    expect(prompt).toContain("正文首行禁止显示书名");
    expect(prompt).not.toContain("blurb：用于书籍简介或卖点开头");
    expect(prompt).not.toContain("storyBackground：交代故事起点");
    expect(prompt).not.toContain("introMarkdown：");
    expect(prompt).not.toContain("title：");
    expect(prompt).toContain("故事概述");
    expect(prompt).toContain("主要人物成长路径");
  });

  it("locks intro revision hard params instead of asking them again", () => {
    const prompt = buildIntroRevisionPrompt({
      mode: "generate",
      userMessage: "请根据已知参数生成正式简介",
      existingDraft: {
        title: "夜港账本",
        platform: "番茄小说",
        targetChapters: 200,
        chapterWordCount: 3000,
        blurb: "港口账本牵出灰产洗白风暴。",
        storyBackground: "港城、账本、灰产洗白。",
      } as any,
      writingLanguage: "zh",
      targetChapters: 200,
      chapterWordCount: 3000,
    });

    expect(prompt).toContain("写作语言");
    expect(prompt).toContain("目标章节数");
    expect(prompt).toContain("每章字数");
    expect(prompt).toContain("不要再次询问");
  });

  it("keeps intro revision generation direct instead of question-driven", () => {
    const prompt = buildIntroRevisionPrompt({
      mode: "generate",
      userMessage: "生成正文",
      writingLanguage: "zh",
      targetChapters: 120,
      chapterWordCount: 3000,
      existingDraft: {
        blurb: "港口账本牵出灰产洗白风暴。",
        storyBackground: "港城、账本、灰产洗白。",
      } as any,
    });

    expect(prompt).toContain("输出方式：直接输出正文");
    expect(prompt).toContain("不要反问任何确认项");
    expect(prompt).toContain("不要再次询问");
    expect(prompt).toContain("正文首行禁止显示书名");
    expect(prompt).not.toContain("请确认");
  });

  it("normalizes structured intro output into plain markdown text", () => {
    const output = normalizeIntroRevisionOutput(`title：不卷

blurb：别人加班我下班。

storyBackground：林晚，28岁，产品总监。

introMarkdown：
# 不卷

## 一句话卖点
别人加班我下班。`);

    expect(output).toContain("# 不卷");
    expect(output).toContain("## 一句话卖点");
    expect(output).toContain("别人加班我下班。");
    expect(output).not.toContain("title：");
    expect(output).not.toContain("blurb：");
    expect(output).not.toContain("storyBackground：");
    expect(output).not.toContain("introMarkdown：");
  });

  it("does not synthesize a duplicate title when title is only a field label", () => {
    const output = normalizeIntroRevisionOutput(`title：不卷
blurb：别人加班我下班。
storyBackground：林晚，28岁，产品总监。`);

    expect(output).not.toContain("title：");
    expect(output).not.toContain("blurb：");
    expect(output).not.toContain("storyBackground：");
    expect(output).toContain("# 简介正文");
    expect(output).toContain("别人加班我下班。");
  });

  it("rejects intro progress text that is not markdown body", () => {
    expect(normalizeIntroRevisionOutput("好的，我来生成正式简介，并更新允许的字段。")).toBe("");
    expect(buildFallbackIntroRevisionOutput({
      title: "夜港账本",
      blurb: "港口账本牵出灰产洗白风暴。",
      storyBackground: "港城、账本、灰产洗白。",
    })).toContain("# 简介正文");
  });

  it("keeps intro markdown body when raw output starts with a short preamble", () => {
    const output = normalizeIntroRevisionOutput(`好的，我来生成正式简介，并更新允许的字段。

# 简介正文

## 一句话卖点
港口账本牵出灰产洗白风暴。

## 故事概述
林砚被迫卷入港城旧债和灰产洗白链。`);

    expect(output).toContain("# 简介正文");
    expect(output).toContain("港口账本牵出灰产洗白风暴。");
    expect(output).not.toContain("好的，我来生成正式简介");
  });

  it("prefers extracted intro markdown body over fallback scaffold when field labels are mixed in", () => {
    const output = normalizeIntroRevisionOutput(`title：夜港账本
blurb：港口账本牵出灰产洗白风暴。
storyBackground：林砚被迫卷入港城旧债和灰产洗白链。

好的，我来生成正式简介。

# 简介正文

## 一句话卖点
港口账本牵出灰产洗白风暴。

## 故事概述
林砚被迫卷入港城旧债和灰产洗白链。

## 故事走向
他在自保、复仇和真相之间越陷越深。`);

    expect(output).toContain("他在自保、复仇和真相之间越陷越深。");
    expect(output).not.toContain("## 核心价值观\n-");
  });

  it("does not let a scaffold-only intro body override a more complete raw intro markdown", () => {
    const output = normalizeIntroRevisionOutput(`title：夜港账本
blurb：港口账本牵出灰产洗白风暴。
storyBackground：林砚被迫卷入港城旧债和灰产洗白链。
introMarkdown：
# 简介正文

## 一句话卖点
港口账本牵出灰产洗白风暴。

## 故事概述
林砚被迫卷入港城旧债和灰产洗白链。

## 故事走向
他在自保、复仇和真相之间越陷越深。

## 主要人物成长路径
林砚从被动防守到主动追索真相。

## 核心冲突
他与灰产链条的对抗不断升级。

## 核心价值观
在灰色秩序中守住底线。`);

    expect(output).toContain("主要人物成长路径");
    expect(output).toContain("核心冲突");
    expect(output).toContain("核心价值观");
    expect(output).not.toContain("## 一句话卖点\n-");
  });

  it("prefers streamed intro markdown over a scaffold-like final completion result", async () => {
    const tools = createInteractionToolsFromDeps({
      config: {
        client: {} as any,
        model: "test-model",
        projectRoot: "/tmp/project",
      },
    } as any, new StateManager(await mkdtemp(join(tmpdir(), "inkos-intro-"))), {
      onDraftRawDelta: () => undefined,
      onDraftTextDelta: () => undefined,
    });

    const chatCompletionSpy = vi.spyOn(llmProvider, "chatCompletion").mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as { onTextDelta?: (text: string) => void } | undefined;
      options?.onTextDelta?.("# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。\n\n## 故事概述\n林砚被迫卷入港城旧债和灰产洗白链。\n\n## 故事走向\n他在自保、复仇和真相之间越陷越深。\n\n## 主要人物成长路径\n林砚从被动防守到主动追索真相。\n\n## 核心冲突\n他与灰产链条的对抗不断升级。\n\n## 核心价值观\n在灰色秩序中守住底线。");
      return {
        content: "# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。\n\n## 故事概述\n林砚被迫卷入港城旧债和灰产洗白链。\n\n## 故事走向\n-\n\n## 主要人物成长路径\n-\n\n## 核心冲突\n-\n\n## 核心价值观\n-",
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
      };
    });

    const result = await tools.reviseBookIntro?.("根据种子生成正式简介", {
      concept: "港风商战悬疑",
      title: "夜港账本",
      genre: "urban",
      blurb: "港口账本牵出灰产洗白风暴。",
      storyBackground: "林砚被迫卷入港城旧债和灰产洗白链。",
      missingFields: [],
      readyToCreate: false,
    } as any, "generate", "urban");

    const interaction = (result as { __interaction?: { details?: { draftRaw?: string; creationDraft?: { draftFields?: { introMarkdown?: string } } } } }).__interaction;
    expect(interaction?.details?.draftRaw).toContain("林砚从被动防守到主动追索真相。");
    expect(interaction?.details?.creationDraft?.draftFields?.introMarkdown).toContain("林砚从被动防守到主动追索真相。");

    chatCompletionSpy.mockRestore();
  });

  it("keeps modify prompts scoped to the current step", () => {
    const prompt = buildWizardPrompt(
      "arc",
      "modify",
      "把人物弧光收紧成复仇转折",
      {
        characterArc: "林砚从自保转向主动复仇",
        protagonist: "林砚",
        supportingCast: "老账房、码头经理",
      } as any,
    );
    expect(prompt).toContain("当前步骤：人物弧光");
    expect(prompt).toContain("核心弧光");
    expect(prompt).toContain("起点状态：性格缺陷 / 内心恐惧 / 错误信念");
    expect(prompt).toContain("成长转折：触发事件 / 内心挣扎 / 觉醒时刻 / 持续考验");
    expect(prompt).toContain("终点状态：性格蜕变 / 克服恐惧 / 新信念 / 残留痕迹");
    expect(prompt).toContain("人物弧光草案");
    expect(prompt).toContain("主角设定");
    expect(prompt).toContain("小说大纲");
    expect(prompt).toContain("卷纲规划");
  });

  it("injects full prior context into arc prompts", () => {
    const prompt = buildWizardPrompt(
      "arc",
      "generate",
      "生成人物弧光正文",
      {
        blurb: "港口账本牵出灰产洗白风暴。",
        storyBackground: "港城、账本、灰产洗白。",
        protagonist: "林砚",
        supportingCast: "老账房、码头经理",
        characterArc: "林砚从被动躲债到主动掀桌。",
        conflictCore: "主角与反派的资源争夺。",
        novelOutline: "第一卷建立冲突，第二卷升级对抗。",
        volumeOutline: "前三卷建立局势，后四卷完成逆转。",
        worldPremise: "近未来港口城，资本与技术垄断并存。",
        settingNotes: "卷纲必须贴着主线推进，不要空转。",
      } as any,
    );

    expect(prompt).toContain("简介 / 卖点");
    expect(prompt).toContain("故事背景");
    expect(prompt).toContain("主角设定");
    expect(prompt).toContain("关键配角 / 势力");
    expect(prompt).toContain("核心冲突");
    expect(prompt).toContain("小说大纲");
    expect(prompt).toContain("卷纲规划");
    expect(prompt).toContain("世界观与核心设定");
    expect(prompt).toContain("必须写出至少 3 条具体变化线索或事件触发点");
    expect(prompt).toContain("至少写出主角和 2 个关键角色的完整弧光");
    expect(prompt).toContain("参考结构应接近：角色名 -> 核心弧光 -> 起点状态 -> 成长转折 -> 终点状态");
  });

  it("injects full prior context into relation prompts", () => {
    const prompt = buildWizardPrompt(
      "relation",
      "generate",
      "生成人物关系正文",
      {
        blurb: "港口账本牵出灰产洗白风暴。",
        storyBackground: "港城、账本、灰产洗白。",
        protagonist: "林砚",
        supportingCast: "老账房、码头经理",
        characterArc: "林砚从被动躲债到主动掀桌。",
        conflictCore: "主角与反派的资源争夺。",
        novelOutline: "第一卷建立冲突，第二卷升级对抗。",
        volumeOutline: "前三卷建立局势，后四卷完成逆转。",
        worldPremise: "近未来港口城，资本与技术垄断并存。",
        settingNotes: "卷纲必须贴着主线推进，不要空转。",
      } as any,
    );

    expect(prompt).toContain("简介 / 卖点");
    expect(prompt).toContain("故事背景");
    expect(prompt).toContain("主角设定");
    expect(prompt).toContain("关键配角 / 势力");
    expect(prompt).toContain("## 人物弧光");
    expect(prompt).toContain("核心冲突");
    expect(prompt).toContain("小说大纲");
    expect(prompt).toContain("卷纲规划");
    expect(prompt).toContain("世界观与核心设定");
    expect(prompt).toContain("不要询问用户“是不是生成人物关系”或任何确认问题，直接生成正文");
    expect(prompt).toContain("必须写出至少 6 条具体关系条目");
    expect(prompt).toContain("至少覆盖主角与 2 个关键角色");
    expect(prompt).toContain("必须按“核心关系 -> 对立关系 -> 隐藏联系 -> 潜在冲突”的顺序输出");
    expect(prompt).toContain("必须写出至少 6 条具体关系条目");
    expect(prompt).toContain("参考结构应接近：核心关系 -> 对立关系 -> 隐藏联系 -> 潜在冲突");
  });

  it("injects genre constraints when a genre context is available", () => {
    const prompt = buildWizardPrompt(
      "intro",
      "generate",
      "我想写港风商战悬疑",
      undefined,
      {
        profile: {
          name: "都市",
          id: "urban",
          language: "zh",
          chapterTypes: ["开局", "冲突", "反转"],
          fatigueWords: ["逆天", "无敌"],
          numericalSystem: false,
          powerScaling: false,
          eraResearch: false,
          pacingRule: "快节奏",
          satisfactionTypes: ["爽感", "压迫感"],
          auditDimensions: [1, 2, 3],
        },
        body: "禁止空泛设定，必须贴着商战冲突推进。",
      },
    );

    expect(prompt).toContain("题材库约束");
    expect(prompt).toContain("题材：都市 (urban)");
    expect(prompt).toContain("快节奏");
    expect(prompt).toContain("禁止空泛设定");
  });

  it("states the single-field multi-turn revision rule explicitly", () => {
    const prompt = buildWizardPrompt("world", "modify", "把世界观再收紧一点");
    expect(prompt).toContain("只改这个字段");
    expect(prompt).toContain("不要顺手重写同页其他字段");
  });

  it("separates outline and volume responsibilities", () => {
    const outlinePrompt = buildWizardPrompt("outline", "generate", "补齐主线结构");
    const volumePrompt = buildWizardPrompt(
      "volume",
      "generate",
      "补齐卷级规划",
      {
        novelOutline: "第一卷建立冲突，第二卷升级对抗。",
        conflictCore: "主角与反派的资源争夺。",
        worldPremise: "近未来都市，资本与技术垄断并存。",
        settingNotes: "卷纲必须贴着主线推进，不要空转。",
      } as any,
    );

    expect(outlinePrompt).toContain("结构设计");
    expect(outlinePrompt).toContain("大事件时间线");
    expect(outlinePrompt).toContain("落点设计");
    expect(outlinePrompt).toContain("卡点设计");
    expect(outlinePrompt).not.toContain("卷纲必须和主线成长同步");

    expect(volumePrompt).toContain("每卷目标");
    expect(volumePrompt).toContain("小说大纲");
    expect(volumePrompt).toContain("核心冲突");
    expect(volumePrompt).toContain("卷纲必须和主线成长同步");
  });
});

describe("wizard truth file routing", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("writes character arc and relationship map into wizard instead of story", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-wizard-routing-"));
    const state = new StateManager(root);
    const tools = createInteractionToolsFromDeps(
      {
        writeNextChapter: async () => ({ ok: true } as any),
        reviseDraft: async () => ({ ok: true } as any),
      },
      state,
    );
    const bookId = "demo-book";

    await tools.writeTruthFile(bookId, "人物弧光页.md", "# 人物弧光\n\n正文A\n");
    await tools.writeTruthFile(bookId, "relationship_map.md", "# 人物关系\n\n正文B\n");

    const arc = await readFile(join(root, "books", bookId, "wizard", "character_arc.md"), "utf-8");
    const relation = await readFile(join(root, "books", bookId, "wizard", "relationship_map.md"), "utf-8");

    expect(arc).toContain("正文A");
    expect(relation).toContain("正文B");
  });
});
