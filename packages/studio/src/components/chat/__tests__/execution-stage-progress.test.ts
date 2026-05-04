import { describe, expect, it } from "vitest";
import { resolveRunningStageProgress } from "../execution-stage-progress";

describe("resolveRunningStageProgress", () => {
  it("returns active stage progress when active exists", () => {
    const result = resolveRunningStageProgress({
      label: "执行过程",
      stages: [
        { label: "准备章节输入", status: "completed" },
        { label: "撰写章节草稿", status: "active" },
        { label: "落盘最终章节", status: "pending" },
      ],
    });
    expect(result).toMatchObject({
      stageLabel: "撰写章节草稿",
      stageIndex: 1,
      stageCount: 3,
      stageStatus: "active",
      progressText: "2/3 · 撰写章节草稿",
    });
  });

  it("falls back to first pending stage when active is missing", () => {
    const result = resolveRunningStageProgress({
      label: "执行过程",
      stages: [
        { label: "准备章节输入", status: "completed" },
        { label: "撰写章节草稿", status: "pending" },
      ],
    });
    expect(result).toMatchObject({
      stageLabel: "撰写章节草稿",
      stageStatus: "pending",
      progressText: "2/2 · 撰写章节草稿",
    });
  });

  it("falls back to last completed stage when no active/pending stage exists", () => {
    const result = resolveRunningStageProgress({
      label: "执行过程",
      stages: [
        { label: "准备章节输入", status: "completed" },
        { label: "撰写章节草稿", status: "completed" },
      ],
    });
    expect(result).toMatchObject({
      stageLabel: "撰写章节草稿",
      stageStatus: "completed",
      progressText: "2/2 · 撰写章节草稿",
    });
  });

  it("returns null when stages are missing", () => {
    expect(resolveRunningStageProgress({ label: "执行过程", stages: undefined })).toBeNull();
  });
});
