import { describe, expect, it } from "vitest";
import { describeChapterAutoReview, describeExecutionAutoReview } from "./auto-review-display";

describe("describeExecutionAutoReview", () => {
  it("formats running revise progress", () => {
    expect(describeExecutionAutoReview({
      enabled: true,
      phase: "revise",
      round: 1,
      maxRounds: 3,
      final: false,
      reviseRoundsUsed: 1,
    })).toMatchObject({
      text: "自动修订：第1/3轮",
      compactText: "自动修订 1/3",
      tone: "info",
    });
  });

  it("defaults active revise rounds to one-based display when usage is omitted", () => {
    expect(describeExecutionAutoReview({
      enabled: true,
      phase: "revise",
      round: 1,
      maxRounds: 3,
      final: false,
    })).toMatchObject({
      text: "自动修订：第1/3轮",
      compactText: "自动修订 1/3",
      tone: "info",
    });
  });

  it("ignores zero revise usage when a revise round is active", () => {
    expect(describeExecutionAutoReview({
      enabled: true,
      phase: "revise",
      round: 1,
      maxRounds: 3,
      final: false,
      reviseRoundsUsed: 0,
    })).toMatchObject({
      text: "自动修订：第1/3轮",
      compactText: "自动修订 1/3",
      tone: "info",
    });
  });

  it("formats terminal failed-max-rounds status", () => {
    expect(describeExecutionAutoReview({
      enabled: true,
      phase: "audit",
      round: 3,
      maxRounds: 2,
      final: true,
      state: "failed-max-rounds",
      reviseRoundsUsed: 2,
    })).toMatchObject({
      text: "自动闭环：未通过（已达2轮上限）",
      compactText: "自动闭环失败 2/2",
      tone: "danger",
    });
  });

  it("includes gate, failed-dimension and must-fix meta hints", () => {
    expect(describeExecutionAutoReview({
      enabled: true,
      phase: "audit",
      round: 2,
      maxRounds: 3,
      final: false,
      state: "retrying",
      reviseRoundsUsed: 1,
      failureGate: "score",
      failedDimensions: ["大纲对齐"],
      mustFixUnresolvedCount: 2,
      mustFixTotalCount: 4,
    })).toMatchObject({
      text: "自动复审：第2/4轮",
      compactText: "自动复审 2/4",
      tone: "info",
      meta: ["门禁 score", "失败维度 1", "关键未收敛 2/4"],
    });
  });

  it("includes strategy reason in meta hints", () => {
    expect(describeExecutionAutoReview({
      enabled: true,
      phase: "revise",
      round: 1,
      maxRounds: 2,
      final: false,
      reviseRoundsUsed: 1,
      strategyReason: "检测到结构问题连续未收敛，已升级为 rewrite 并注入结构化修订约束。",
    })?.meta).toContain("策略 检测到结构问题连续未收敛，已升级为 rewrite 并注入结构化修订约束。");
  });
});

describe("describeChapterAutoReview", () => {
  it("formats chapter revise/audit hints", () => {
    expect(describeChapterAutoReview({
      phase: "revise",
      round: 0,
      maxRounds: 2,
    })).toMatchObject({
      text: "自动修订：第1/2轮",
      tone: "info",
    });
    expect(describeChapterAutoReview({
      phase: "audit",
      round: 0,
      maxRounds: 2,
    })).toMatchObject({
      text: "自动复审：第1/3轮",
      tone: "info",
    });
  });

  it("marks stopped chapter state as danger tone", () => {
    expect(describeChapterAutoReview({
      phase: "stopped",
      round: 3,
      maxRounds: 2,
      reason: "达到上限仍未通过",
    })).toMatchObject({
      text: "自动修订已中止：达到上限仍未通过",
      tone: "danger",
    });
  });
});
