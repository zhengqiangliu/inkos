import { useEffect, useMemo, useState } from "react";
import type { SSEMessage } from "../../hooks/use-sse";
import type { BookTask, BookTaskCreateResponse, BookTaskListResponse, BookTaskResumeResponse, BookTaskStatus, BookTaskStopResponse, RunLogEntry } from "../../shared/contracts";
import { postApi, useApi } from "../../hooks/use-api";
import { AssistantOutputCard } from "./AssistantOutputCard";
import { cn } from "../../lib/utils";
import { ArrowRight, CalendarClock, Circle, Clock3, Play, Square, Sparkles, StopCircle, CheckCircle2, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface BookTaskPanelProps {
  readonly bookId: string;
  readonly nextChapter: number;
  readonly targetChapters: number;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

const terminalStatuses: ReadonlyArray<BookTaskStatus> = ["cancelled", "failed", "succeeded"];
const MAX_TASK_LOGS = 100;

type BookTaskSnapshot = Partial<BookTask> & Pick<BookTask, "id" | "bookId" | "updatedAt">;

function logKey(log: RunLogEntry): string {
  return `${log.timestamp}::${log.level}::${log.message}`;
}

function mergeLogs(existing: ReadonlyArray<RunLogEntry>, incoming: ReadonlyArray<RunLogEntry>): RunLogEntry[] {
  const merged = [...existing];
  const seen = new Set(existing.map(logKey));
  for (const log of incoming) {
    const key = logKey(log);
    if (seen.has(key)) continue;
    merged.push(log);
    seen.add(key);
  }
  return merged.slice(-MAX_TASK_LOGS);
}

function mergeTaskSnapshot(existing: BookTask | undefined, incoming: BookTaskSnapshot): BookTask {
  const next: BookTask = existing && existing.id === incoming.id && existing.updatedAt > incoming.updatedAt
    ? { ...existing, logs: mergeLogs(existing.logs, incoming.logs ?? []) }
    : {
        ...(incoming as BookTask),
        logs: mergeLogs(existing?.logs ?? [], incoming.logs ?? []),
      };
  return next;
}

function mergeTaskList(existing: ReadonlyArray<BookTask>, incoming: ReadonlyArray<BookTask>): BookTask[] {
  const byId = new Map(existing.map((task) => [task.id, task] as const));
  return incoming.map((task) => mergeTaskSnapshot(byId.get(task.id), task));
}

function upsertTask(existing: ReadonlyArray<BookTask>, incoming: BookTaskSnapshot, log?: RunLogEntry): BookTask[] {
  const byId = new Map(existing.map((task) => [task.id, task] as const));
  const current = byId.get(incoming.id);
  const next = mergeTaskSnapshot(current, {
    ...incoming,
    ...(log ? { logs: [log] } : {}),
  });
  byId.set(next.id, next);
  const ordered = [next, ...existing.filter((task) => task.id !== next.id)];
  return ordered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function statusMeta(status: BookTaskStatus): { label: string; className: string; icon: LucideIcon } {
  switch (status) {
    case "queued":
      return { label: "排队中", className: "border border-border/50 bg-secondary/40 text-muted-foreground", icon: Clock3 };
    case "running":
      return { label: "运行中", className: "border border-primary/30 bg-primary/10 text-primary", icon: Play };
    case "stopping":
      return { label: "停止中", className: "border border-amber-400/30 bg-amber-400/10 text-amber-600", icon: StopCircle };
    case "paused":
      return { label: "已暂停", className: "border border-border/50 bg-secondary/30 text-muted-foreground", icon: Square };
    case "cancelled":
      return { label: "已取消", className: "border border-border/50 bg-secondary/30 text-muted-foreground", icon: Square };
    case "failed":
      return { label: "失败", className: "border border-destructive/20 bg-destructive/10 text-destructive", icon: AlertTriangle };
    case "succeeded":
      return { label: "完成", className: "border border-emerald-400/30 bg-emerald-400/10 text-emerald-600", icon: CheckCircle2 };
    default:
      return { label: status, className: "border border-border/50 bg-secondary/40 text-muted-foreground", icon: Circle };
  }
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function calcDefaultRequestedChapters(nextChapter: number, targetChapters: number): number {
  return Math.max(1, targetChapters - nextChapter + 1);
}

export function BookTaskPanel({ bookId, nextChapter, targetChapters, sse }: BookTaskPanelProps) {
  const { data } = useApi<BookTaskListResponse>(`/books/${bookId}/tasks`);
  const [tasks, setTasks] = useState<ReadonlyArray<BookTask>>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [requestedChapters, setRequestedChapters] = useState(() => calcDefaultRequestedChapters(nextChapter, targetChapters));
  const [wordCount, setWordCount] = useState("");
  const [quickMode, setQuickMode] = useState(true);
  const [preferFastWriterModel, setPreferFastWriterModel] = useState(true);
  const [service, setService] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data?.tasks) return;
    setTasks((prev) => mergeTaskList(prev, data.tasks));
  }, [data?.tasks]);

  const selectedTask = useMemo(() => {
    if (!tasks.length) return null;
    if (selectedTaskId) return tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
    return tasks[0] ?? null;
  }, [selectedTaskId, tasks]);

  const detailTask = selectedTask ?? null;

  const activeTask = useMemo(
    () => tasks.find((task) => !terminalStatuses.includes(task.status)) ?? null,
    [tasks],
  );
  const canStopActiveTask = activeTask?.status === "queued" || activeTask?.status === "running" || activeTask?.status === "stopping";

  const progress = useMemo(() => {
    if (!selectedTask) return 0;
    return Math.min(100, Math.round((selectedTask.completedChapters / Math.max(1, selectedTask.requestedChapters)) * 100));
  }, [selectedTask]);

  useEffect(() => {
    if (tasks.length === 0) return;
    if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(activeTask?.id ?? tasks[0]?.id ?? null);
  }, [activeTask?.id, selectedTaskId, tasks]);

  useEffect(() => {
    setRequestedChapters(calcDefaultRequestedChapters(nextChapter, targetChapters));
  }, [nextChapter, targetChapters]);

  useEffect(() => {
    const latest = sse.messages[sse.messages.length - 1];
    if (!latest?.event.startsWith("book-task:")) return;
    if ((latest.data as { bookId?: string } | null)?.bookId !== bookId) return;
    const eventTask = latest.data as { task?: BookTaskSnapshot; log?: RunLogEntry } | null;
    const incomingTask = eventTask?.task;
    if (!incomingTask) return;
    setTasks((prev) => upsertTask(prev, incomingTask, eventTask?.log));
  }, [bookId, sse.messages]);

  const handleCreateTask = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const payload = {
        requestedChapters: Number.isFinite(requestedChapters) ? Math.max(1, Math.round(requestedChapters)) : undefined,
        wordCount: wordCount.trim() && Number.isFinite(Number(wordCount)) ? Math.max(1, Math.round(Number(wordCount))) : undefined,
        quickMode,
        preferFastWriterModel,
        service: service.trim() || undefined,
        model: model.trim() || undefined,
      };
      const response = await postApi<BookTaskCreateResponse>(`/books/${bookId}/tasks`, payload);
      setSelectedTaskId(response.task.id);
      setTasks((prev) => upsertTask(prev, response.task));
    } catch (error) {
      console.error("create book task failed", error);
    } finally {
      setBusy(false);
    }
  };

  const handleStopTask = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await postApi<BookTaskStopResponse>(`/books/${bookId}/tasks/${taskId}/stop`);
      setTasks((prev) => upsertTask(prev, response.task));
    } catch (error) {
      console.error("stop book task failed", error);
    } finally {
      setBusy(false);
    }
  };

  const handleResumeTask = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await postApi<BookTaskResumeResponse>(`/books/${bookId}/tasks/${taskId}/resume`);
      setTasks((prev) => upsertTask(prev, response.task));
    } catch (error) {
      console.error("resume book task failed", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <AssistantOutputCard heading="自动写作任务" className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">连续章节数</span>
            <input
              type="number"
              min={1}
              value={requestedChapters}
              onChange={(e) => setRequestedChapters(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">每章字数</span>
            <input
              type="number"
              min={1}
              value={wordCount}
              onChange={(e) => setWordCount(e.target.value)}
              placeholder="可选"
              className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">服务</span>
            <input
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="可选"
              className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">模型</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="可选"
              className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setQuickMode((value) => !value)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition-colors",
              quickMode ? "bg-primary/10 text-primary" : "border border-border/50",
            )}
          >
            <Sparkles size={12} />
            快速模式 {quickMode ? "开" : "关"}
          </button>
          <button
            type="button"
            onClick={() => setPreferFastWriterModel((value) => !value)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition-colors",
              preferFastWriterModel ? "bg-primary/10 text-primary" : "border border-border/50",
            )}
          >
            <ArrowRight size={12} />
            自动快模 {preferFastWriterModel ? "开" : "关"}
          </button>
          <span className="ml-auto inline-flex items-center gap-1">
            <CalendarClock size={12} />
            从第 {nextChapter} 章开始
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void handleCreateTask(); }}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Play size={14} />开始任务
          </button>
          {activeTask && canStopActiveTask && (
            <button
              type="button"
              onClick={() => { void handleStopTask(activeTask.id); }}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive disabled:opacity-50"
            >
              <Square size={14} />停止当前任务
            </button>
          )}
          <span className="text-xs text-muted-foreground">目标章节 {targetChapters}</span>
        </div>
      </AssistantOutputCard>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[0.9fr_1.1fr]">
        <AssistantOutputCard heading={`任务列表 (${tasks.length})`} className="min-h-0 overflow-hidden">
          <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
            {tasks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/40 px-3 py-6 text-center text-xs text-muted-foreground">
                还没有任务，创建后会在这里显示。
              </div>
            ) : (
              tasks.map((task) => {
                const meta = statusMeta(task.status);
                const Icon = meta.icon;
                const selected = selectedTask?.id === task.id;
                const taskProgress = Math.min(100, Math.round((task.completedChapters / Math.max(1, task.requestedChapters)) * 100));
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setSelectedTaskId(task.id)}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2 text-left transition",
                      selected ? "border-primary/40 bg-primary/10" : "border-border/40 bg-background/40 hover:bg-accent/25",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{task.title}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {task.completedChapters}/{task.requestedChapters} 章 · {formatTime(task.updatedAt)}
                        </div>
                      </div>
                      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px]", meta.className)}>
                        <Icon size={11} />{meta.label}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-secondary/70">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${taskProgress}%` }} />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </AssistantOutputCard>

        <AssistantOutputCard heading="任务详情" className="min-h-0 overflow-hidden">
          {detailTask ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{detailTask.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    创建于 {formatTime(detailTask.createdAt)} · 开始 {formatTime(detailTask.startedAt)} · 完成 {formatTime(detailTask.finishedAt)}
                  </div>
                </div>
                <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px]", statusMeta(detailTask.status).className)}>
                  {statusMeta(detailTask.status).label}
                </span>
              </div>

              <div className="space-y-1 text-xs text-muted-foreground">
                <div>当前章节：{detailTask.currentChapterNumber ?? "—"}</div>
                <div>下一章节：{detailTask.nextChapterNumber ?? "—"}</div>
                <div>已完成：{detailTask.completedChapters}/{detailTask.requestedChapters}</div>
                <div>停止请求：{formatTime(detailTask.stopRequestedAt)}</div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">进度</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 rounded-full bg-secondary/70">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
                </div>
              </div>

              <div className="rounded-xl border border-border/40 bg-background/40 p-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">日志</div>
                <div className="max-h-[220px] space-y-2 overflow-y-auto pr-1">
                  {detailTask.logs.length === 0 ? (
                    <div className="text-xs text-muted-foreground">暂无日志</div>
                  ) : (
                    detailTask.logs.slice(-12).map((log) => (
                      <div key={`${log.timestamp}-${log.message}`} className="rounded-lg border border-border/30 bg-card/70 px-2 py-1.5 text-xs">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Clock3 size={11} />
                          {formatTime(log.timestamp)}
                          <span className={cn(
                            "rounded-full px-1.5 py-0.5",
                            log.level === "error" ? "bg-destructive/10 text-destructive" : log.level === "warn" ? "bg-amber-400/10 text-amber-600" : "bg-secondary/50",
                          )}>
                            {log.level}
                          </span>
                        </div>
                        <div className="mt-1 leading-5">{log.message}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {detailTask.status === "paused" ? (
                <button
                  type="button"
                  onClick={() => { void handleResumeTask(detailTask.id); }}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary disabled:opacity-50"
                >
                  <Play size={14} />继续任务
                </button>
              ) : !terminalStatuses.includes(detailTask.status) && (
                <button
                  type="button"
                  onClick={() => { void handleStopTask(detailTask.id); }}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive disabled:opacity-50"
                >
                  <Square size={14} />中止任务
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/40 px-3 py-6 text-center text-xs text-muted-foreground">
              选择一个任务查看详情。
            </div>
          )}
        </AssistantOutputCard>
      </div>
    </div>
  );
}
