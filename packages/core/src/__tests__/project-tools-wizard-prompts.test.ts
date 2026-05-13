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

  it("keeps modify prompts scoped to the current step", () => {
    const prompt = buildWizardPrompt("arc", "modify", "把人物弧光收紧成复仇转折");
    expect(prompt).toContain("当前步骤：人物弧光");
    expect(prompt).toContain("核心弧光");
    expect(prompt).toContain("起点状态");
    expect(prompt).not.toContain("小说大纲");
    expect(prompt).not.toContain("人物关系");
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
});
