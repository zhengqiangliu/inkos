import type { BookTask } from "../shared/contracts";
import { elapsedFrom, formatDuration, resolveTaskEndAt } from "./task-time";
import { getTaskDisplayedChapterCount } from "./task-stage-stats";

function toNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export interface TaskPerformanceSnapshot {
  readonly totalMs: number;
  readonly inputPrepMs: number;
  readonly writingMs: number;
  readonly auditMs: number;
  readonly reviseMs: number;
  readonly truthRebuildMs: number;
  readonly stateValidationMs: number;
  readonly indexSyncMs: number;
}

export interface TaskTokenSample {
  readonly at: number;
  readonly totalTokens: number;
}

export function getTaskAuditPassRate(task: Pick<BookTask, "result">): number | null {
  if (!task.result || typeof task.result !== "object") return null;
  const result = task.result as {
    readonly auditPassRate?: unknown;
    readonly auditedChapters?: unknown;
    readonly passedChapters?: unknown;
    readonly failedChapters?: unknown;
  };

  const directRate = toNumber(result.auditPassRate);
  if (directRate !== null) return Math.max(0, Math.min(100, Math.round(directRate)));

  const auditedChapters = toNumber(result.auditedChapters);
  const passedChapters = toNumber(result.passedChapters);
  const failedChapters = toNumber(result.failedChapters);

  if (auditedChapters !== null && auditedChapters > 0 && passedChapters !== null) {
    return Math.max(0, Math.min(100, Math.round((passedChapters / auditedChapters) * 100)));
  }

  if (passedChapters !== null || failedChapters !== null) {
    const passed = Math.max(0, passedChapters ?? 0);
    const failed = Math.max(0, failedChapters ?? 0);
    const total = passed + failed;
    if (total > 0) return Math.max(0, Math.min(100, Math.round((passed / total) * 100)));
  }

  return null;
}

export function getTaskPerformance(task: Pick<BookTask, "result">): TaskPerformanceSnapshot | null {
  if (!task.result || typeof task.result !== "object") return null;
  const result = task.result as {
    readonly performance?: unknown;
  };
  if (!result.performance || typeof result.performance !== "object") return null;
  const performance = result.performance as {
    readonly totalMs?: unknown;
    readonly inputPrepMs?: unknown;
    readonly writingMs?: unknown;
    readonly auditMs?: unknown;
    readonly reviseMs?: unknown;
    readonly truthRebuildMs?: unknown;
    readonly stateValidationMs?: unknown;
    readonly indexSyncMs?: unknown;
  };
  const totalMs = toNumber(performance.totalMs);
  const inputPrepMs = toNumber(performance.inputPrepMs);
  const writingMs = toNumber(performance.writingMs);
  const auditMs = toNumber(performance.auditMs);
  const reviseMs = toNumber(performance.reviseMs);
  const truthRebuildMs = toNumber(performance.truthRebuildMs);
  const stateValidationMs = toNumber(performance.stateValidationMs);
  const indexSyncMs = toNumber(performance.indexSyncMs);
  if (
    totalMs === null
    || inputPrepMs === null
    || writingMs === null
    || auditMs === null
    || reviseMs === null
    || truthRebuildMs === null
    || stateValidationMs === null
    || indexSyncMs === null
  ) {
    return null;
  }
  return {
    totalMs: Math.max(0, Math.round(totalMs)),
    inputPrepMs: Math.max(0, Math.round(inputPrepMs)),
    writingMs: Math.max(0, Math.round(writingMs)),
    auditMs: Math.max(0, Math.round(auditMs)),
    reviseMs: Math.max(0, Math.round(reviseMs)),
    truthRebuildMs: Math.max(0, Math.round(truthRebuildMs)),
    stateValidationMs: Math.max(0, Math.round(stateValidationMs)),
    indexSyncMs: Math.max(0, Math.round(indexSyncMs)),
  };
}

export function getTaskPerformanceSegments(performance: TaskPerformanceSnapshot): ReadonlyArray<{ readonly label: string; readonly ms: number }> {
  return [
    { label: "输入准备", ms: performance.inputPrepMs },
    { label: "写作", ms: performance.writingMs },
    { label: "审计", ms: performance.auditMs },
    { label: "修订", ms: performance.reviseMs },
    { label: "真相重建", ms: performance.truthRebuildMs },
    { label: "状态校验", ms: performance.stateValidationMs },
    { label: "索引同步", ms: performance.indexSyncMs },
  ];
}

export function getTaskAverageChapterDurationMs(
  task: Pick<BookTask, "status" | "startedAt" | "stageStartedAt" | "chapterStartedAt" | "createdAt" | "chapterFinishedAt" | "finishedAt" | "stageUpdatedAt" | "lastHeartbeatAt" | "updatedAt" | "completedChapters" | "requestedChapters" | "currentChapterNumber">,
  now: number,
): number | null {
  const actualStart = task.startedAt ?? task.stageStartedAt ?? task.chapterStartedAt;
  if (!actualStart) return null;
  const chapters = getTaskDisplayedChapterCount(task);
  if (chapters <= 0) return null;
  const totalMs = elapsedFrom(actualStart, resolveTaskEndAt(task), now);
  return Math.max(0, Math.round(totalMs / chapters));
}

export function getTaskTokenRatePerSecond(
  task: Pick<BookTask, "status" | "startedAt" | "stageStartedAt" | "chapterStartedAt" | "chapterFinishedAt" | "finishedAt" | "stageUpdatedAt" | "lastHeartbeatAt" | "updatedAt" | "tokenUsage">,
  now: number,
): number | null {
  const totalTokens = task.tokenUsage?.totalTokens ?? 0;
  if (totalTokens <= 0) return null;
  const actualStart = task.startedAt ?? task.stageStartedAt ?? task.chapterStartedAt;
  if (!actualStart) return null;
  const elapsedMs = elapsedFrom(actualStart, resolveTaskEndAt(task), now);
  if (elapsedMs <= 0) return null;
  return totalTokens / (elapsedMs / 1000);
}

export function shouldShowTaskTokenMetrics(
  task: Pick<BookTask, "status" | "tokenUsage" | "result">,
): boolean {
  return task.status === "running" || getTaskTotalTokens(task) !== null;
}

export function mergeTaskTokenSamples(existing: ReadonlyArray<TaskTokenSample>, incoming: TaskTokenSample, maxSamples = 120): TaskTokenSample[] {
  if (!Number.isFinite(incoming.at) || !Number.isFinite(incoming.totalTokens)) return [...existing];
  const filtered = existing.filter((sample) => sample.at !== incoming.at);
  filtered.push({
    at: Math.max(0, Math.round(incoming.at)),
    totalTokens: Math.max(0, Math.round(incoming.totalTokens)),
  });
  filtered.sort((a, b) => a.at - b.at);
  return filtered.slice(-Math.max(2, Math.round(maxSamples)));
}

export function createTaskTokenSample(
  task: Pick<BookTask, "updatedAt"> & { readonly tokenUsage?: BookTask["tokenUsage"] },
  fallbackAt = Date.now(),
): TaskTokenSample | null {
  const totalTokens = task.tokenUsage?.totalTokens;
  if (!Number.isFinite(totalTokens ?? NaN)) return null;
  const at = new Date(task.updatedAt).getTime();
  return {
    at: Number.isFinite(at) ? at : fallbackAt,
    totalTokens: totalTokens ?? 0,
  };
}

export function getTaskTotalTokens(task: { readonly tokenUsage?: BookTask["tokenUsage"] } & { readonly result?: BookTask["result"] }): number | null {
  const direct = task.tokenUsage?.totalTokens;
  if (Number.isFinite(direct ?? NaN)) return Math.max(0, Math.round(direct ?? 0));
  if (!task.result || typeof task.result !== "object") return null;
  const result = task.result as { readonly tokenUsage?: { readonly totalTokens?: unknown } };
  const totalTokens = Number(result.tokenUsage?.totalTokens);
  return Number.isFinite(totalTokens) ? Math.max(0, Math.round(totalTokens)) : null;
}

export function getTaskLiveTokenRatePerSecond(
  samples: ReadonlyArray<TaskTokenSample>,
  now: number,
  windowMs = 10_000,
): number | null {
  const validSamples = samples
    .filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.totalTokens) && sample.at <= now)
    .sort((a, b) => a.at - b.at);
  if (validSamples.length < 2) return null;

  const end = validSamples[validSamples.length - 1]!;
  const cutoff = now - Math.max(1_000, Math.round(windowMs));
  let start = validSamples[0]!;
  for (const sample of validSamples) {
    if (sample.at <= cutoff) {
      start = sample;
      continue;
    }
    break;
  }
  if (start.at === end.at && validSamples.length >= 2) {
    start = validSamples[validSamples.length - 2]!;
  }

  const elapsedMs = end.at - start.at;
  if (elapsedMs <= 0) return null;
  const deltaTokens = end.totalTokens - start.totalTokens;
  if (deltaTokens < 0) return null;
  return deltaTokens / (elapsedMs / 1000);
}

export function formatOptionalPercent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

export function formatOptionalDuration(value: number | null): string {
  return value === null ? "—" : formatDuration(value);
}

export function formatOptionalTokenRate(value: number | null): string {
  if (value === null) return "—";
  if (value >= 100) return `${Math.round(value)} tok/s`;
  if (value >= 10) return `${value.toFixed(1)} tok/s`;
  return `${value.toFixed(2)} tok/s`;
}

export function formatLiveTokenRate(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000) return `${Math.round(value)} tok/s`;
  if (value >= 100) return `${value.toFixed(1)} tok/s`;
  return `${value.toFixed(2)} tok/s`;
}

export function formatTaskTokenUsage(task: Pick<BookTask, "status" | "tokenUsage">): string {
  const total = task.tokenUsage?.totalTokens ?? 0;
  return task.status === "running" ? `${total.toLocaleString()}（实时估算）` : `${total.toLocaleString()}（最终）`;
}
