import { describe, expect, it } from "vitest";
import { buildSettlerUserPrompt } from "../agents/settler-prompts.js";

const BASE_PARAMS = {
  chapterNumber: 10,
  title: "Test Chapter",
  content: "Chapter content here.",
  currentState: "State card content.",
  ledger: "",
  hooks: "Hook list.",
  chapterSummaries: "(文件尚未创建)",
  subplotBoard: "(文件尚未创建)",
  emotionalArcs: "(文件尚未创建)",
  characterMatrix: "(文件尚未创建)",
  volumeOutline: "Volume outline.",
};

const PAST_DEADLINE_HOOKS = [
  {
    hookId: "mentor-oath",
    startChapter: 3,
    age: 25,
    deadline: 18,
    expectedPayoff: "揭开师债真相",
  },
  {
    hookId: "kiln-key",
    startChapter: 5,
    age: 20,
    deadline: 12,
    expectedPayoff: "获得熔炉钥匙",
  },
];

describe("buildSettlerUserPrompt", () => {
  it("does not include enforcement block when no pastDeadlineHooks provided", () => {
    const result = buildSettlerUserPrompt(BASE_PARAMS);

    expect(result).not.toContain("强制回收指令");
    expect(result).not.toContain("超出强制回收死线");
  });

  it("does not include enforcement block when pastDeadlineHooks is empty", () => {
    const result = buildSettlerUserPrompt({
      ...BASE_PARAMS,
      pastDeadlineHooks: [],
    });

    expect(result).not.toContain("强制回收指令");
  });

  it("includes enforcement block when pastDeadlineHooks provided without cap", () => {
    const result = buildSettlerUserPrompt({
      ...BASE_PARAMS,
      pastDeadlineHooks: PAST_DEADLINE_HOOKS,
    });

    expect(result).toContain("## 强制回收指令（必须执行）");
    expect(result).toContain("以下伏笔已超出强制回收死线");
    expect(result).toContain("mentor-oath");
    expect(result).toContain("kiln-key");
    expect(result).toContain("种于第3章");
    expect(result).toContain("种于第5章");
    expect(result).toContain("死线为第18章");
    expect(result).toContain("死线为第12章");
    expect(result).toContain("揭开师债真相");
    expect(result).toContain("获得熔炉钥匙");
    // Should NOT contain cap hint when cap not specified
    expect(result).not.toContain("回收上限");
  });

  it("includes cap hint when forceResolveCap provided", () => {
    const result = buildSettlerUserPrompt({
      ...BASE_PARAMS,
      pastDeadlineHooks: PAST_DEADLINE_HOOKS,
      forceResolveCap: 2,
    });

    expect(result).toContain("## 强制回收指令（必须执行）");
    expect(result).toContain("## 回收上限");
    expect(result).toContain("每章最多回收 2 个超死线伏笔");
  });

  it("renders single hook correctly", () => {
    const result = buildSettlerUserPrompt({
      ...BASE_PARAMS,
      pastDeadlineHooks: [PAST_DEADLINE_HOOKS[0]],
      forceResolveCap: 1,
    });

    expect(result).toContain("mentor-oath");
    expect(result).not.toContain("kiln-key");
    expect(result).toContain("每章最多回收 1 个超死线伏笔");
  });

  it("does not affect normal prompt content", () => {
    const result = buildSettlerUserPrompt({
      ...BASE_PARAMS,
      pastDeadlineHooks: PAST_DEADLINE_HOOKS,
    });

    expect(result).toContain("请分析第10章「Test Chapter」的正文");
    expect(result).toContain("Chapter content here.");
    expect(result).toContain("State card content.");
    expect(result).toContain("Hook list.");
    expect(result).toContain("Volume outline.");
  });
});
