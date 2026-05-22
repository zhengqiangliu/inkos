import type { BookTask } from "../../shared/contracts";
import { cn } from "../../lib/utils";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, PauseCircle, Play, Square, TimerReset, type LucideIcon } from "lucide-react";

export function isTaskTerminalStatus(status: BookTask["status"]): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded";
}

export function canResumeTask(status: BookTask["status"]): boolean {
  return status === "paused";
}

export function canRetryTask(status: BookTask["status"]): boolean {
  return status === "failed";
}

export function canCancelRetryWaitingTask(status: BookTask["status"]): boolean {
  return status === "retry_waiting";
}

export function canToggleAutoRetry(status: BookTask["status"]): boolean {
  return status === "queued" || status === "running" || status === "stopping";
}

export function canDeleteTask(status: BookTask["status"]): boolean {
  return status !== "running";
}

export function canStopTask(status: BookTask["status"]): boolean {
  return status !== "paused" && !isTaskTerminalStatus(status);
}

export function getTaskStatusMeta(status: BookTask["status"]): { label: string; className: string; icon: LucideIcon } {
  switch (status) {
    case "queued":
      return { label: "排队中", className: "border border-amber-500/20 bg-amber-500/10 text-amber-600", icon: Clock3 };
    case "running":
      return { label: "运行中", className: "border border-primary/30 bg-primary/10 text-primary", icon: Loader2 };
    case "paused":
      return { label: "已暂停", className: "border border-border/50 bg-secondary/30 text-muted-foreground", icon: PauseCircle };
    case "stopping":
      return { label: "停止中", className: "border border-orange-500/20 bg-orange-500/10 text-orange-600", icon: Square };
    case "retry_waiting":
      return { label: "等待重试", className: "border border-indigo-500/20 bg-indigo-500/10 text-indigo-600", icon: TimerReset };
    case "cancelled":
      return { label: "已取消", className: "border border-border/50 bg-secondary/30 text-muted-foreground", icon: Square };
    case "failed":
      return { label: "失败", className: "border border-destructive/20 bg-destructive/10 text-destructive", icon: AlertTriangle };
    case "succeeded":
      return { label: "已完成", className: "border border-emerald-400/30 bg-emerald-400/10 text-emerald-600", icon: CheckCircle2 };
    default:
      return { label: status, className: "border border-border/50 bg-secondary/40 text-muted-foreground", icon: Clock3 };
  }
}

export function getAutoRetryToggleLabel(task: Pick<BookTask, "retryEnabled">): string {
  return `失败后自动重试：${task.retryEnabled ? "开" : "关"}`;
}

export function getResumeActionLabel(): string {
  return "继续任务";
}

export function getRetryActionLabel(): string {
  return "立即重试";
}

export function getCancelTaskActionLabel(): string {
  return "取消任务";
}

export function getTaskStateSummary(task: Pick<BookTask, "status" | "retryEnabled">): string {
  switch (task.status) {
    case "paused":
      return "任务已挂起，总时长和单章时长都会冻结；只能点击“继续任务”恢复，自动重试不会唤醒暂停任务。";
    case "retry_waiting":
      return "任务已进入自动重试队列，失败后会按当前开关再次启动。";
    case "running":
      return task.retryEnabled
        ? "任务正在执行，失败后会自动进入重试队列。"
        : "任务正在执行，失败后不会自动重试。";
    case "queued":
      return task.retryEnabled
        ? "任务正在排队，失败后会自动重试。"
        : "任务正在排队，失败后需要手动重试。";
    case "stopping":
      return "任务正在停止中，等待当前步骤收尾。";
    case "failed":
      return "任务已失败，可手动重试；自动重试只影响失败后的自动拉起。";
    case "cancelled":
      return "任务已停止，可删除；不能继续或自动重试。";
    case "succeeded":
      return "任务已完成，可删除；不能继续或自动重试。";
    default:
      return "当前任务状态已更新。";
  }
}

export function canEditTaskRuntimeSettings(status: BookTask["status"]): boolean {
  return status !== "running";
}

export function TaskStateLegend({
  task,
  className,
}: {
  readonly task: Pick<BookTask, "status" | "retryEnabled">;
  readonly className?: string;
}) {
  const summary = getTaskStateSummary(task);
  return (
    <div className={cn("rounded-xl border border-border/40 bg-background/35 p-3 text-xs text-muted-foreground", className)}>
      <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
        <TimerReset size={12} />
        状态说明
      </div>
      <div className="mt-1 leading-5">{summary}</div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-4">
        <div className="rounded-lg border border-border/30 bg-card/60 p-2">
          <div className="flex items-center gap-1 text-[11px] font-medium text-foreground">
            <PauseCircle size={11} />
            暂停
          </div>
          <div className="mt-1 leading-5">暂停后总时长和单章时长冻结，只能用继续任务恢复。</div>
        </div>
        <div className="rounded-lg border border-border/30 bg-card/60 p-2">
          <div className="flex items-center gap-1 text-[11px] font-medium text-foreground">
            <Play size={11} />
            继续
          </div>
          <div className="mt-1 leading-5">只恢复暂停态，不会触发重试或改写任务类型。</div>
        </div>
        <div className="rounded-lg border border-border/30 bg-card/60 p-2">
          <div className="flex items-center gap-1 text-[11px] font-medium text-foreground">
            <TimerReset size={11} />
            自动重试
          </div>
          <div className="mt-1 leading-5">只影响失败后的自动重试，不唤醒暂停任务。</div>
        </div>
        <div className="rounded-lg border border-border/30 bg-card/60 p-2">
          <div className="flex items-center gap-1 text-[11px] font-medium text-foreground">
            <Square size={11} />
            删除
          </div>
          <div className="mt-1 leading-5">仅运行中任务不可删除，其他状态都可以删除。</div>
        </div>
      </div>
    </div>
  );
}
