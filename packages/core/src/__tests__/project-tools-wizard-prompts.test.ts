import { describe, expect, it } from "vitest";
import { buildWizardPrompt } from "../interaction/project-tools.js";

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
    expect(prompt).toContain("blurb：用于书籍简介或卖点开头");
    expect(prompt).toContain("storyBackground：交代故事起点");
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
    expect(prompt).not.toContain("卷纲规划");
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

    expect(outlinePrompt).toContain("大事件时间线");
    expect(outlinePrompt).toContain("卡点设计");
    expect(outlinePrompt).not.toContain("每卷目标");

    expect(volumePrompt).toContain("每卷目标");
    expect(volumePrompt).toContain("小说大纲");
    expect(volumePrompt).toContain("核心冲突");
    expect(volumePrompt).toContain("卷纲必须和主线成长同步");
  });
});
