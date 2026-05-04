import { describe, expect, it } from "vitest";
import type { ToolExecution } from "../../../store/chat/types";
import { buildExecutionPanelSummary } from "../ExecutionPanel";

function makeExec(overrides: Partial<ToolExecution> & { id: string }): ToolExecution {
  return {
    ...overrides,
    id: overrides.id,
    tool: overrides.tool ?? "sub_agent",
    label: overrides.label ?? "执行过程",
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? Date.now(),
  };
}

describe("buildExecutionPanelSummary", () => {
  it("summarizes counts by execution status", () => {
    const executions: ToolExecution[] = [
      makeExec({ id: "1", status: "running" }),
      makeExec({ id: "2", status: "completed" }),
      makeExec({ id: "3", status: "error", error: "failed" }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.total).toBe(3);
    expect(summary.running).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("uses active stage label from first running execution", () => {
    const executions: ToolExecution[] = [
      makeExec({
        id: "1",
        status: "running",
        label: "写作",
        stages: [
          { label: "准备章节输入", status: "completed" },
          { label: "撰写章节草稿", status: "active" },
        ],
      }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.activeStageLabel).toBe("撰写章节草稿");
    expect(summary.activeStageProgressText).toBe("2/2 · 撰写章节草稿");
  });

  it("falls back to execution label when no stage is active", () => {
    const executions: ToolExecution[] = [
      makeExec({ id: "1", status: "running", label: "审计" }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.activeStageLabel).toBe("审计");
  });

  it("uses auto-review progress text when stage list is unavailable", () => {
    const executions: ToolExecution[] = [
      makeExec({
        id: "1",
        status: "running",
        label: "执行过程",
        autoReview: {
          enabled: true,
          phase: "revise",
          round: 1,
          maxRounds: 3,
          final: false,
          reviseRoundsUsed: 1,
        },
      }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.activeStageProgressText).toBe("自动修订 1/3");
  });

  it("includes auto-review meta summary for gate, failed dimensions, and unresolved must-fix", () => {
    const executions: ToolExecution[] = [
      makeExec({
        id: "1",
        status: "running",
        label: "审计",
        autoReview: {
          enabled: true,
          phase: "audit",
          round: 2,
          maxRounds: 3,
          final: false,
          reviseRoundsUsed: 1,
          failureGate: "score",
          failedDimensions: ["大纲对齐", "角色一致性"],
          mustFixUnresolvedCount: 2,
          mustFixTotalCount: 5,
        },
      }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.autoReviewMeta).toEqual([
      "门禁 score",
      "失败维度 2",
      "关键未收敛 2/5",
    ]);
  });

  it("prefers auto-review progress text over stage progress when both exist", () => {
    const executions: ToolExecution[] = [
      makeExec({
        id: "1",
        status: "running",
        label: "审计",
        stages: [
          { label: "审计章节", status: "active" },
        ],
        autoReview: {
          enabled: true,
          phase: "revise",
          round: 1,
          maxRounds: 2,
          final: false,
          reviseRoundsUsed: 1,
        },
      }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.activeStageProgressText).toBe("自动修订 1/2");
  });

  it("uses pending stage for progress when active stage is missing", () => {
    const executions: ToolExecution[] = [
      makeExec({
        id: "1",
        status: "running",
        label: "写作",
        stages: [
          { label: "准备章节输入", status: "completed" },
          { label: "撰写章节草稿", status: "pending" },
          { label: "落盘最终章节", status: "pending" },
        ],
      }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.activeStageLabel).toBe("撰写章节草稿");
    expect(summary.activeStageProgressText).toBe("2/3 · 撰写章节草稿");
  });

  it("captures latest failure text from error/result/label in priority order", () => {
    const executions: ToolExecution[] = [
      makeExec({ id: "1", status: "error", label: "修订", error: "patch rejected" }),
      makeExec({ id: "2", status: "error", label: "审计", result: "audit timeout" }),
    ];
    const summary = buildExecutionPanelSummary(executions);
    expect(summary.latestFailure).toBe("patch rejected");
  });
});
