import type { BookTask } from "../../shared/contracts";
import { cn } from "../../lib/utils";
import { formatDuration } from "../../lib/task-time";
import { getTaskPerformance, getTaskPerformanceSegments } from "../../lib/task-metrics";

type TaskPerformanceTask = Pick<BookTask, "result">;

export function TaskPerformanceBreakdown({
  task,
  className,
}: {
  readonly task: TaskPerformanceTask;
  readonly className?: string;
}) {
  const performance = getTaskPerformance(task);
  if (!performance) return null;

  const total = Math.max(1, performance.totalMs);
  const segments = getTaskPerformanceSegments(performance);

  return (
    <div className={cn("rounded-xl border border-border/40 bg-background/30 p-3", className)}>
      <div className="mb-2 text-xs font-medium text-muted-foreground">耗时拆分</div>
      <div className="space-y-2">
        <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
          <span>总耗时 {formatDuration(performance.totalMs)}</span>
          <span>写作 {formatDuration(performance.writingMs)}</span>
          <span>审计 {formatDuration(performance.auditMs)}</span>
          <span>修订 {formatDuration(performance.reviseMs)}</span>
        </div>
        <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
          <span>输入准备 {formatDuration(performance.inputPrepMs)}</span>
          <span>真相重建 {formatDuration(performance.truthRebuildMs)}</span>
          <span>状态校验 {formatDuration(performance.stateValidationMs)}</span>
          <span>索引同步 {formatDuration(performance.indexSyncMs)}</span>
        </div>
        <div className="space-y-1.5">
          {segments.map((segment) => {
            const width = Math.max(0, Math.min(100, Math.round((segment.ms / total) * 100)));
            return (
              <div key={segment.label} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>{segment.label}</span>
                  <span className="font-medium tabular-nums text-foreground">{formatDuration(segment.ms)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary/70">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${width}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
