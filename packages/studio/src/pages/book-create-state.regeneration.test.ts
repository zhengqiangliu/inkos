import { describe, expect, it } from "vitest";
import {
  buildWizardStepRegenerationInstruction,
  hasMeaningfulIntroMarkdown,
  looksLikeWizardStepMarkdown,
  normalizeIntroMarkdownCandidate,
  pickBestIntroMarkdownCandidate,
  stripWizardPreamble,
} from "./book-create-state";

const SKELETON_INTRO = [
  "# 简介正文",
  "",
  "## 一句话卖点\n-",
  "## 故事概述\n-",
  "## 故事走向\n-",
  "## 主要人物成长路径\n-",
  "## 核心冲突\n-",
  "## 核心价值观\n-",
].join("\n\n");

const REAL_INTRO = [
  "## 一句话卖点",
  "退役军医重回都市，用一把柳叶刀劈开盘踞十年的医疗黑幕。",
  "## 故事概述",
  "主角林川在战地积累了顶尖外科经验，回国后却撞上被资本垄断的私立医院体系。",
  "## 故事走向",
  "从被排挤的急诊夜班，到揭穿器官交易链，主角一步步逼近真正的幕后操盘者。",
  "## 主要人物成长路径",
  "林川从只信刀不信人的孤狼，逐渐学会组建团队、托付后背、承担领导的代价。",
  "## 核心冲突",
  "个人医德与系统性腐败之间的正面对撞，每一次救人都是对既得利益的宣战。",
  "## 核心价值观",
  "技术应当服务于人而非资本，守住底线的人终将赢得同行者。",
].join("\n");

describe("buildWizardStepRegenerationInstruction", () => {
  it("uses the correct wizard file for outline and volume steps", () => {
    expect(buildWizardStepRegenerationInstruction({
      step: "outline",
      title: "小说大纲",
      language: "zh",
    })).toContain("wizard/outline.md");

    expect(buildWizardStepRegenerationInstruction({
      step: "volume",
      title: "卷纲规划",
      language: "zh",
    })).toContain("wizard/volume.md");

    expect(buildWizardStepRegenerationInstruction({
      step: "volume",
      title: "Volume Plan",
      language: "en",
    })).toContain("wizard/volume.md");
  });
});

describe("intro skeleton rejection", () => {
  it("treats a placeholder-only skeleton as not meaningful", () => {
    expect(hasMeaningfulIntroMarkdown(SKELETON_INTRO)).toBe(false);
    expect(hasMeaningfulIntroMarkdown(REAL_INTRO)).toBe(true);
  });

  it("never selects the skeleton over substantive body text", () => {
    expect(pickBestIntroMarkdownCandidate([SKELETON_INTRO, REAL_INTRO])).toBe(normalizeIntroMarkdownCandidate(REAL_INTRO));
  });

  it("does not promote a skeleton even when it is the only candidate", () => {
    expect(pickBestIntroMarkdownCandidate([SKELETON_INTRO])).toBe("");
  });
});

describe("wizard preamble stripping", () => {
  it("keeps valid volume markdown after removing leading explanation text", () => {
    const raw = [
      "我先重写卷纲页正文，并保持其他页面不变。",
      "",
      "# 卷纲规划",
      "",
      "## 第一卷（1-40章）",
      "- 核心目标：主角完成从入局到站稳脚跟的第一轮积累。",
      "- 卷末钩子：第一份关键证据曝光，逼出更高层对手。",
    ].join("\n");

    const stripped = stripWizardPreamble("volume", raw);
    expect(stripped).toContain("# 卷纲规划");
    expect(looksLikeWizardStepMarkdown("volume", stripped)).toBe(true);
  });
});
