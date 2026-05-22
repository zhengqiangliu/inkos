import type { BookTask } from "../shared/contracts";

export interface TaskStageInput {
  readonly status?: string;
  readonly stage?: string;
  readonly stageLabel?: string | null;
  readonly stageDetail?: string | null;
  readonly stageStartedAt?: string | null;
  readonly stageUpdatedAt?: string | null;
  readonly lastHeartbeatAt?: string | null;
  readonly finishedAt?: string | null;
  readonly currentChapterNumber?: number | null;
  readonly chapterStartedAt?: string | null;
  readonly chapterFinishedAt?: string | null;
  readonly updatedAt: string;
}

export interface TaskStageSnapshot {
  readonly stage: string;
  readonly stageLabel: string | null;
  readonly stageDetail: string | null;
  readonly stageStartedAt: string | null;
  readonly stageUpdatedAt: string | null;
  readonly finishedAt: string | null;
  readonly currentChapterNumber: number | null;
  readonly chapterStartedAt: string | null;
  readonly chapterFinishedAt: string | null;
  readonly updatedAt: string;
}

export interface TaskPhaseDurations {
  readonly auditMs: number;
  readonly reviseMs: number;
  readonly savingMs: number;
  readonly trackedMs: number;
}

export interface TaskStageTimelineEntry {
  readonly stage: string;
  readonly stageLabel: string | null;
  readonly stageDetail: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number;
  readonly isCurrent: boolean;
  readonly order: number;
}

function stageBucket(stage: string): "audit" | "revise" | "saving" | "other" {
  if (stage === "audit") return "audit";
  if (stage === "revise") return "revise";
  if (stage.startsWith("saving_") || stage === "saving") return "saving";
  return "other";
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function chapterKey(chapterStartedAt: string | null, currentChapterNumber: number | null): string {
  if (chapterStartedAt) return chapterStartedAt;
  if (Number.isFinite(currentChapterNumber ?? NaN)) return `chapter:${currentChapterNumber}`;
  return "";
}

function snapshotKey(snapshot: Pick<TaskStageSnapshot, "stage" | "chapterStartedAt" | "currentChapterNumber">): string {
  return `${chapterKey(snapshot.chapterStartedAt, snapshot.currentChapterNumber)}::${snapshot.stage}`;
}

function snapshotTime(snapshot: Pick<TaskStageSnapshot, "stageStartedAt" | "stageUpdatedAt" | "updatedAt">): number {
  return parseTime(snapshot.stageStartedAt) ?? parseTime(snapshot.stageUpdatedAt) ?? parseTime(snapshot.updatedAt) ?? 0;
}

function createStageSnapshot(task: TaskStageInput): TaskStageSnapshot {
  return {
    stage: task.stage ?? "",
    stageLabel: task.stageLabel ?? null,
    stageDetail: task.stageDetail ?? null,
    stageStartedAt: task.stageStartedAt ?? null,
    stageUpdatedAt: task.stageUpdatedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    currentChapterNumber: Number.isFinite(task.currentChapterNumber ?? NaN) ? Math.max(1, Math.round(Number(task.currentChapterNumber))) : null,
    chapterStartedAt: task.chapterStartedAt ?? null,
    chapterFinishedAt: task.chapterFinishedAt ?? null,
    updatedAt: task.updatedAt,
  };
}

function resolveTimelineChapterKey(
  history: ReadonlyArray<TaskStageSnapshot>,
  task: Pick<TaskStageInput, "chapterStartedAt" | "currentChapterNumber">,
): string {
  if (task.chapterStartedAt) return chapterKey(task.chapterStartedAt, task.currentChapterNumber ?? null);
  if (Number.isFinite(task.currentChapterNumber ?? NaN)) return chapterKey(null, task.currentChapterNumber ?? null);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    const key = chapterKey(item.chapterStartedAt, item.currentChapterNumber);
    if (key) return key;
  }
  return "";
}

function filterHistoryToChapter(
  history: ReadonlyArray<TaskStageSnapshot>,
  timelineChapterKey: string,
): TaskStageSnapshot[] {
  if (!timelineChapterKey) return [];
  return history.filter((item) => chapterKey(item.chapterStartedAt, item.currentChapterNumber) === timelineChapterKey && isTrajectoryStage(item.stage));
}

function isTrajectoryStage(stage: string): boolean {
  return stage === "write_chapter" || stage === "audit" || stage === "revise" || stage === "saving" || stage.startsWith("saving_");
}

function resolveHistoryEndAt(task: Pick<TaskStageInput, "status" | "finishedAt" | "stageUpdatedAt" | "lastHeartbeatAt" | "updatedAt">): string | null {
  if (task.status === "paused") {
    return task.stageUpdatedAt ?? task.lastHeartbeatAt ?? task.updatedAt;
  }
  if (task.status === "queued" || task.status === "running" || task.status === "stopping" || task.status === "retry_waiting") {
    return null;
  }
  return task.finishedAt ?? null;
}

export function mergeTaskStageHistory(
  existing: ReadonlyArray<TaskStageSnapshot>,
  task: TaskStageInput,
): TaskStageSnapshot[] {
  const entry = createStageSnapshot(task);
  const key = snapshotKey(entry);
  const index = existing.findIndex((item) => snapshotKey(item) === key);
  if (index >= 0) {
    const merged = [...existing];
    merged[index] = { ...merged[index], ...entry };
    return merged.sort((a, b) => snapshotTime(a) - snapshotTime(b));
  }
  return [...existing, entry].sort((a, b) => snapshotTime(a) - snapshotTime(b));
}

export function computeTaskPhaseDurations(
  history: ReadonlyArray<TaskStageSnapshot>,
  task: Pick<TaskStageInput, "status" | "chapterStartedAt" | "currentChapterNumber" | "finishedAt" | "stageUpdatedAt" | "lastHeartbeatAt" | "updatedAt">,
  now: number,
): TaskPhaseDurations {
  const sorted = filterHistoryToChapter(history, resolveTimelineChapterKey(history, task)).sort((a, b) => snapshotTime(a) - snapshotTime(b));
  const finishedAt = resolveHistoryEndAt(task);
  let auditMs = 0;
  let reviseMs = 0;
  let savingMs = 0;
  let trackedMs = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    const start = snapshotTime(current);
    const end = next
      ? snapshotTime(next)
      : parseTime(finishedAt) ?? now;
    const span = Math.max(0, end - start);
    trackedMs += span;

    switch (stageBucket(current.stage)) {
      case "audit":
        auditMs += span;
        break;
      case "revise":
        reviseMs += span;
        break;
      case "saving":
        savingMs += span;
        break;
      default:
        break;
    }
  }

  return { auditMs, reviseMs, savingMs, trackedMs };
}

export function buildTaskStageTimeline(
  history: ReadonlyArray<TaskStageSnapshot>,
  task: Pick<TaskStageInput, "status" | "chapterStartedAt" | "currentChapterNumber" | "finishedAt" | "stageUpdatedAt" | "lastHeartbeatAt" | "updatedAt">,
  now: number,
): TaskStageTimelineEntry[] {
  const sorted = filterHistoryToChapter(history, resolveTimelineChapterKey(history, task)).sort((a, b) => snapshotTime(a) - snapshotTime(b));
  const finishedAt = resolveHistoryEndAt(task);
  return sorted.map((current, index) => {
    const next = sorted[index + 1];
    const startedAt = current.stageStartedAt ?? current.stageUpdatedAt ?? current.updatedAt;
    const endedAt = next?.stageStartedAt ?? next?.stageUpdatedAt ?? next?.updatedAt ?? finishedAt ?? null;
    const start = parseTime(startedAt) ?? 0;
    const end = parseTime(endedAt) ?? now;
    return {
      stage: current.stage,
      stageLabel: current.stageLabel,
      stageDetail: current.stageDetail,
      startedAt,
      endedAt,
      durationMs: Math.max(0, end - start),
      isCurrent: index === sorted.length - 1 && !finishedAt,
      order: index + 1,
    };
  });
}

export function stageBucketLabel(stage: string): string {
  switch (stageBucket(stage)) {
    case "audit":
      return "审计";
    case "revise":
      return "修订";
    case "saving":
      return "保存";
    default:
      return "其他";
  }
}

export function isTaskCurrentChapterActive(task: Pick<BookTask, "chapterStartedAt" | "chapterFinishedAt">): boolean {
  return Boolean(task.chapterStartedAt && !task.chapterFinishedAt);
}

export function getTaskDisplayedChapterCount(
  task: Pick<BookTask, "completedChapters" | "requestedChapters" | "currentChapterNumber" | "chapterFinishedAt">,
): number {
  const inProgress = task.currentChapterNumber != null && !task.chapterFinishedAt ? 1 : 0;
  return Math.min(Math.max(0, task.requestedChapters), Math.max(0, task.completedChapters + inProgress));
}
