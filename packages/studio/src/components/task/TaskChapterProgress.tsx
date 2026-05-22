import type { BookTask } from "../../shared/contracts";
import { cn } from "../../lib/utils";
import { getTaskDisplayedChapterCount } from "../../lib/task-stage-stats";

type TaskChapterProgressTask = Pick<
  BookTask,
  "completedChapters" | "requestedChapters" | "currentChapterNumber" | "chapterFinishedAt"
>;

export function TaskChapterProgress({
  task,
  compact = false,
  className,
}: {
  readonly task: TaskChapterProgressTask;
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const completed = getTaskDisplayedChapterCount(task);
  const total = Math.max(1, task.requestedChapters);
  const progress = Math.min(100, Math.round((completed / total) * 100));

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>章节进度</span>
        <span className="font-medium tabular-nums text-foreground">
          {completed}/{task.requestedChapters}
        </span>
      </div>
      <div className={cn("overflow-hidden rounded-full bg-secondary/70", compact ? "h-1.5" : "h-2")}>
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="text-[11px] text-muted-foreground">
        已完成 {completed} 章 / 共 {task.requestedChapters} 章
      </div>
    </div>
  );
}
