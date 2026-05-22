import { describe, expect, it } from "vitest";
import {
  canCancelRetryWaitingTask,
  canEditTaskRuntimeSettings,
  canDeleteTask,
  canResumeTask,
  canRetryTask,
  canStopTask,
  canToggleAutoRetry,
  getAutoRetryToggleLabel,
  getCancelTaskActionLabel,
  getResumeActionLabel,
  getRetryActionLabel,
  getTaskStateSummary,
  isTaskTerminalStatus,
} from "./TaskStateLegend";

describe("TaskStateLegend copy", () => {
  it("describes paused tasks as resumable, not retryable", () => {
    expect(getTaskStateSummary({ status: "paused", retryEnabled: true })).toContain("继续任务");
    expect(getTaskStateSummary({ status: "paused", retryEnabled: true })).toContain("自动重试不会唤醒暂停任务");
    expect(getTaskStateSummary({ status: "paused", retryEnabled: true })).toContain("总时长和单章时长都会冻结");
  });

  it("uses explicit labels for actions", () => {
    expect(getResumeActionLabel()).toBe("继续任务");
    expect(getRetryActionLabel()).toBe("立即重试");
    expect(getCancelTaskActionLabel()).toBe("取消任务");
  });

  it("labels auto retry as a failure-only setting", () => {
    expect(getAutoRetryToggleLabel({ retryEnabled: true })).toBe("失败后自动重试：开");
    expect(getAutoRetryToggleLabel({ retryEnabled: false })).toBe("失败后自动重试：关");
  });

  it("allows runtime edits only when a task is not active", () => {
    expect(canEditTaskRuntimeSettings("queued")).toBe(true);
    expect(canEditTaskRuntimeSettings("paused")).toBe(true);
    expect(canEditTaskRuntimeSettings("failed")).toBe(true);
    expect(canEditTaskRuntimeSettings("running")).toBe(false);
    expect(canEditTaskRuntimeSettings("stopping")).toBe(true);
    expect(canEditTaskRuntimeSettings("retry_waiting")).toBe(true);
    expect(canEditTaskRuntimeSettings("succeeded")).toBe(true);
    expect(canEditTaskRuntimeSettings("cancelled")).toBe(true);
  });

  it("uses a consistent task action matrix", () => {
    expect(isTaskTerminalStatus("cancelled")).toBe(true);
    expect(isTaskTerminalStatus("failed")).toBe(true);
    expect(isTaskTerminalStatus("succeeded")).toBe(true);
    expect(isTaskTerminalStatus("paused")).toBe(false);
    expect(canDeleteTask("paused")).toBe(true);
    expect(canDeleteTask("failed")).toBe(true);
    expect(canDeleteTask("succeeded")).toBe(true);
    expect(canDeleteTask("cancelled")).toBe(true);
    expect(canDeleteTask("running")).toBe(false);
    expect(canDeleteTask("stopping")).toBe(true);
    expect(canResumeTask("paused")).toBe(true);
    expect(canRetryTask("failed")).toBe(true);
    expect(canCancelRetryWaitingTask("retry_waiting")).toBe(true);
    expect(canToggleAutoRetry("queued")).toBe(true);
    expect(canToggleAutoRetry("paused")).toBe(false);
    expect(canStopTask("running")).toBe(true);
    expect(canStopTask("paused")).toBe(false);
  });
});
