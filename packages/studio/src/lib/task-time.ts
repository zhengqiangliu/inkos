export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function elapsedFrom(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
  now: number,
  fallbackStartedAt?: string | null | undefined,
): number {
  const start = parseTime(startedAt) ?? parseTime(fallbackStartedAt);
  if (start == null) return 0;
  const end = endedAt ? parseTime(endedAt) : now;
  if (end == null) return 0;
  return Math.max(0, end - start);
}

export function resolveTaskEndAt(task: {
  readonly status: string;
  readonly finishedAt: string | null;
  readonly stageUpdatedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly updatedAt: string;
}): string | null {
  if (task.status === "paused") return task.stageUpdatedAt ?? task.lastHeartbeatAt ?? task.updatedAt;
  if (task.status === "queued" || task.status === "running" || task.status === "stopping" || task.status === "retry_waiting") return null;
  if (task.finishedAt) return task.finishedAt;
  return null;
}

export function resolveTaskStartAt(task: {
  readonly startedAt: string | null;
  readonly stageStartedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string;
}): string | null {
  return task.startedAt ?? task.stageStartedAt ?? task.createdAt ?? task.updatedAt;
}

export function resolveTaskChapterStartAt(task: {
  readonly chapterStartedAt: string | null;
  readonly stageStartedAt: string | null;
  readonly startedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string;
}): string | null {
  return task.chapterStartedAt ?? task.stageStartedAt ?? task.startedAt ?? task.createdAt ?? task.updatedAt;
}

export function resolveTaskUpdateAt(task: {
  readonly stageUpdatedAt: string | null;
  readonly updatedAt: string;
}): string | null {
  return task.stageUpdatedAt ?? task.updatedAt;
}
