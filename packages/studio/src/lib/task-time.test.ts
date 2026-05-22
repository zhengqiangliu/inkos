import { describe, expect, it } from "vitest";
import { elapsedFrom, formatDuration, resolveTaskChapterStartAt, resolveTaskEndAt, resolveTaskStartAt, resolveTaskUpdateAt } from "./task-time";

describe("task-time", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(61_000)).toBe("1 分 1 秒");
    expect(formatDuration(3_661_000)).toBe("1 小时 1 分");
  });

  it("falls back to a secondary start time when the primary one is missing", () => {
    const now = new Date("2026-05-19T12:00:10.000Z").getTime();
    expect(elapsedFrom(null, null, now, "2026-05-19T12:00:00.000Z")).toBe(10_000);
  });

  it("returns zero for invalid timestamps", () => {
    expect(elapsedFrom("bad", null, Date.now())).toBe(0);
  });

  it("freezes paused tasks at the pause timestamp", () => {
    expect(resolveTaskEndAt({
      status: "paused",
      finishedAt: null,
      stageUpdatedAt: "2026-05-19T12:00:05.000Z",
      lastHeartbeatAt: "2026-05-19T12:00:04.000Z",
      updatedAt: "2026-05-19T12:00:06.000Z",
    })).toBe("2026-05-19T12:00:05.000Z");
  });

  it("keeps running tasks open even if finishedAt is still populated", () => {
    expect(resolveTaskEndAt({
      status: "running",
      finishedAt: "2026-05-19T12:00:05.000Z",
      stageUpdatedAt: "2026-05-19T12:00:04.000Z",
      lastHeartbeatAt: "2026-05-19T12:00:04.000Z",
      updatedAt: "2026-05-19T12:00:06.000Z",
    })).toBeNull();
  });

  it("falls back to stage and created timestamps for resumed tasks", () => {
    expect(resolveTaskStartAt({
      startedAt: null,
      stageStartedAt: "2026-05-19T12:00:01.000Z",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:02.000Z",
    })).toBe("2026-05-19T12:00:01.000Z");
    expect(resolveTaskChapterStartAt({
      chapterStartedAt: null,
      stageStartedAt: "2026-05-19T12:00:03.000Z",
      startedAt: null,
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:04.000Z",
    })).toBe("2026-05-19T12:00:03.000Z");
  });

  it("prefers stage update time over noisy updatedAt for runtime age", () => {
    expect(resolveTaskUpdateAt({
      stageUpdatedAt: "2026-05-19T12:00:03.000Z",
      updatedAt: "2026-05-19T12:00:10.000Z",
    })).toBe("2026-05-19T12:00:03.000Z");
    expect(resolveTaskUpdateAt({
      stageUpdatedAt: null,
      updatedAt: "2026-05-19T12:00:10.000Z",
    })).toBe("2026-05-19T12:00:10.000Z");
  });
});
