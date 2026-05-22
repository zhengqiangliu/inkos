import { describe, expect, it } from "vitest";
import { formatOptionalTokenRate, getTaskTokenRatePerSecond, getTaskTotalTokens, shouldShowTaskTokenMetrics } from "./task-metrics";

describe("task-metrics", () => {
  it("formats token rate", () => {
    expect(formatOptionalTokenRate(null)).toBe("—");
    expect(formatOptionalTokenRate(8.126)).toBe("8.13 tok/s");
    expect(formatOptionalTokenRate(12.34)).toBe("12.3 tok/s");
    expect(formatOptionalTokenRate(123.4)).toBe("123 tok/s");
  });

  it("derives token rate from total usage and elapsed time", () => {
    expect(getTaskTokenRatePerSecond({
      startedAt: "2026-05-20T00:00:00.000Z",
      stageStartedAt: null,
      chapterStartedAt: null,
      chapterFinishedAt: null,
      finishedAt: null,
      stageUpdatedAt: null,
      lastHeartbeatAt: null,
      updatedAt: "2026-05-20T00:10:00.000Z",
      status: "running",
      tokenUsage: { promptTokens: 0, completionTokens: 600, totalTokens: 600 },
    }, Date.parse("2026-05-20T00:10:00.000Z"))).toBe(1);
  });

  it("falls back to result token usage when top-level usage is missing", () => {
    expect(getTaskTotalTokens({
      tokenUsage: null,
      result: {
        tokenUsage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
      },
    })).toBe(46);
  });

  it("shows token metrics whenever the task is running or has token usage", () => {
    expect(shouldShowTaskTokenMetrics({
      status: "running",
      tokenUsage: null,
      result: null,
    })).toBe(true);
    expect(shouldShowTaskTokenMetrics({
      status: "running",
      tokenUsage: null,
      result: null,
    })).toBe(true);
    expect(shouldShowTaskTokenMetrics({
      status: "succeeded",
      tokenUsage: null,
      result: null,
    })).toBe(false);
    expect(shouldShowTaskTokenMetrics({
      status: "succeeded",
      tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      result: null,
    })).toBe(true);
  });
});
