import type { BookTask } from "../../shared/contracts";
import { cn } from "../../lib/utils";
import {
  formatLiveTokenRate,
  formatOptionalDuration,
  formatOptionalPercent,
  formatOptionalTokenRate,
  getTaskLiveTokenRatePerSecond,
  getTaskAuditPassRate,
  getTaskAverageChapterDurationMs,
  getTaskTokenRatePerSecond,
  type TaskTokenSample,
} from "../../lib/task-metrics";

type TaskMetricsTask = Pick<
  BookTask,
  | "status"
  | "startedAt"
  | "stageStartedAt"
  | "chapterStartedAt"
  | "createdAt"
  | "chapterFinishedAt"
  | "finishedAt"
  | "stageUpdatedAt"
  | "lastHeartbeatAt"
  | "updatedAt"
  | "completedChapters"
  | "requestedChapters"
  | "currentChapterNumber"
  | "tokenUsage"
  | "result"
>;

export function TaskMetricsSummary({
  task,
  nowTick,
  tokenSamples,
  compact = false,
  className,
}: {
  readonly task: TaskMetricsTask;
  readonly nowTick: number;
  readonly tokenSamples?: ReadonlyArray<TaskTokenSample>;
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const auditPassRate = getTaskAuditPassRate(task);
  const averageChapterDuration = getTaskAverageChapterDurationMs(task, nowTick);
  const tokenRate = getTaskTokenRatePerSecond(task, nowTick);
  const liveTokenRate = task.status === "running" && tokenSamples && tokenSamples.length > 0
    ? getTaskLiveTokenRatePerSecond(tokenSamples, nowTick)
    : null;
  const rateTone = auditPassRate === null
    ? "bg-border"
    : auditPassRate >= 90
      ? "bg-emerald-500"
      : auditPassRate >= 70
        ? "bg-amber-500"
        : "bg-destructive";
  const shellClassName = compact
    ? "rounded-lg border border-border/30 bg-card/50 p-2.5"
    : "rounded-xl border border-border/40 bg-background/30 p-3";

  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-1 sm:grid-cols-3" : "lg:grid-cols-3", className)}>
      <div className={shellClassName}>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>审计通过率</span>
          <span className="font-medium tabular-nums text-foreground">{formatOptionalPercent(auditPassRate)}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary/70">
          <div
            className={cn("h-full rounded-full transition-all", rateTone)}
            style={{ width: `${auditPassRate ?? 0}%` }}
          />
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {auditPassRate === null ? "暂无审计结果" : "按审计结果汇总"}
        </div>
      </div>

      <div className={shellClassName}>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>每章平均耗时</span>
          <span className="font-medium tabular-nums text-foreground">{formatOptionalDuration(averageChapterDuration)}</span>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          {averageChapterDuration === null ? "暂无可计算时长" : "按当前已完成章节均摊总时长"}
        </div>
      </div>

      <div className={shellClassName}>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>Token 速率</span>
          <span className="font-medium tabular-nums text-foreground">{formatOptionalTokenRate(tokenRate)}</span>
        </div>
        <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span>平均</span>
            <span className="font-medium tabular-nums text-foreground">{formatOptionalTokenRate(tokenRate)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>实时</span>
            <span className="font-medium tabular-nums text-foreground">
              {task.status === "running" ? formatLiveTokenRate(liveTokenRate) : "—"}
            </span>
          </div>
          <div>
            {task.status === "running"
              ? "实时按最近窗口内的 token 增量估算"
              : "平均值按累计 token / 运行时长计算"}
          </div>
        </div>
      </div>
    </div>
  );
}
