import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import {
  buildChapterPlanRows,
  computeMissingChapterNumbers,
  mapChapterPlanFailureReason,
} from "./ChapterPlansSection";
import { ChapterPlanReader } from "./ChapterPlanReader";

describe("computeMissingChapterNumbers", () => {
  it("keeps missing chapters visible when plans are partially generated", () => {
    const plans = [
      {
        chapterNumber: 1,
        chapterName: "chapter-1",
        highlight: "highlight-1",
        coreConflict: "conflict-1",
        plotAndConflict: "plot-1",
        emotionalTone: "tone",
        endingHook: "hook-1",
        status: "planned",
        source: "auto",
        version: 1,
      },
      {
        chapterNumber: 3,
        chapterName: "chapter-3",
        highlight: "highlight-3",
        coreConflict: "conflict-3",
        plotAndConflict: "plot-3",
        emotionalTone: "tone",
        endingHook: "hook-3",
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

  it("extends the missing range to already written chapters", () => {
    const plans = [
      {
        chapterNumber: 1,
        chapterName: "chapter-1",
        highlight: "highlight-1",
        coreConflict: "conflict-1",
        plotAndConflict: "plot-1",
        emotionalTone: "tone",
        endingHook: "hook-1",
        status: "planned",
        source: "auto",
        version: 1,
      },
    ];

    const missing = computeMissingChapterNumbers(plans, 2, [1, 2, 3, 4]);
    expect(missing).toEqual([2, 3, 4]);
  });
});

describe("mapChapterPlanFailureReason", () => {
  it("maps known reason codes to readable text", () => {
    expect(mapChapterPlanFailureReason({
      reasonCode: "CHAPTER_PLAN_AGENT_MISSING_OUTPUT",
      reason: "agent-missing-plan",
    })).toContain("Agent");
    expect(mapChapterPlanFailureReason({
      reasonCode: "CHAPTER_CONTENT_MISSING",
      reason: "chapter-content-missing",
    })).not.toBe("");
  });

  it("falls back to original reason for agent failures", () => {
    expect(mapChapterPlanFailureReason({
      reasonCode: "CHAPTER_PLAN_AGENT_FAILED",
      reason: "timeout",
    })).toBe("timeout");
  });
});

describe("ChapterPlanReader", () => {
  it("renders a history entry point for the current plan", () => {
    const html = renderToString(createElement(ChapterPlanReader, {
      plan: {
        chapterNumber: 3,
        chapterName: "demo",
        highlight: "demo",
        coreConflict: "demo",
        plotAndConflict: "demo",
        emotionalTone: "demo",
        endingHook: "demo",
        status: "planned",
        source: "auto",
        version: 1,
      },
      onOpenHistory: () => undefined,
    }));

    expect(html).toContain("历史版本");
    expect(html).toContain("修改复核");
    expect(html).toContain("通过");
  });
});
