import { describe, expect, it } from "vitest";
import {
  buildChapterPlanRows,
  computeMissingChapterNumbers,
  mapChapterPlanFailureReason,
} from "./ChapterPlansSection";

describe("computeMissingChapterNumbers", () => {
  it("keeps missing chapters visible when plans are partially generated", () => {
    const plans = [
      {
        chapterNumber: 1,
        chapterName: "第1章",
        highlight: "看点1",
        coreConflict: "冲突1",
        plotAndConflict: "剧情1",
        emotionalTone: "推进",
        endingHook: "钩子1",
        status: "planned",
        source: "auto",
        version: 1,
      },
      {
        chapterNumber: 3,
        chapterName: "第3章",
        highlight: "看点3",
        coreConflict: "冲突3",
        plotAndConflict: "剧情3",
        emotionalTone: "推进",
        endingHook: "钩子3",
        status: "planned",
        source: "auto",
        version: 1,
      },
    ];

    const missing = computeMissingChapterNumbers(plans, 4);
    expect(missing).toEqual([2]);

    const rows = buildChapterPlanRows(plans, missing, "all");
    const missingRows = rows.filter((row) => row.kind === "missing").map((row) => row.chapterNumber);
    expect(missingRows).toEqual([2]);
  });
});

describe("mapChapterPlanFailureReason", () => {
  it("maps known reason codes to readable text", () => {
    expect(mapChapterPlanFailureReason({
      reasonCode: "CHAPTER_PLAN_AGENT_MISSING_OUTPUT",
      reason: "agent-missing-plan",
    })).toContain("Agent 未返回");
    expect(mapChapterPlanFailureReason({
      reasonCode: "CHAPTER_CONTENT_MISSING",
      reason: "chapter-content-missing",
    })).toContain("章节正文缺失");
  });

  it("falls back to original reason for agent failures", () => {
    expect(mapChapterPlanFailureReason({
      reasonCode: "CHAPTER_PLAN_AGENT_FAILED",
      reason: "timeout",
    })).toBe("timeout");
  });
});
