import type { ToolExecution } from "../../store/chat/types";

export interface RunningStageProgress {
  readonly stageLabel: string;
  readonly stageIndex: number;
  readonly stageCount: number;
  readonly stageStatus: "active" | "pending" | "completed";
  readonly progressText: string;
}

export function resolveRunningStageProgress(
  execution: Pick<ToolExecution, "label" | "stages">,
): RunningStageProgress | null {
  const stages = execution.stages;
  if (!stages?.length) return null;

  const stageCount = stages.length;
  const activeIndex = stages.findIndex((stage) => stage.status === "active");
  if (activeIndex >= 0) {
    const stageLabel = stages[activeIndex]?.label ?? execution.label;
    return {
      stageLabel,
      stageIndex: activeIndex,
      stageCount,
      stageStatus: "active",
      progressText: `${activeIndex + 1}/${stageCount} · ${stageLabel}`,
    };
  }

  const pendingIndex = stages.findIndex((stage) => stage.status === "pending");
  if (pendingIndex >= 0) {
    const stageLabel = stages[pendingIndex]?.label ?? execution.label;
    return {
      stageLabel,
      stageIndex: pendingIndex,
      stageCount,
      stageStatus: "pending",
      progressText: `${pendingIndex + 1}/${stageCount} · ${stageLabel}`,
    };
  }

  const lastIndex = stageCount - 1;
  const lastStage = stages[lastIndex];
  if (!lastStage) return null;
  return {
    stageLabel: lastStage.label,
    stageIndex: lastIndex,
    stageCount,
    stageStatus: "completed",
    progressText: `${stageCount}/${stageCount} · ${lastStage.label}`,
  };
}
