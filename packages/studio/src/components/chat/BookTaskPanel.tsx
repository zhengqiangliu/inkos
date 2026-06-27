import { useEffect, useMemo, useState } from "react";
import type { SSEMessage } from "../../hooks/use-sse";
import type { BookTask, BookTaskCreateResponse, BookTaskListResponse, BookTaskResumeResponse, BookTaskStopResponse, BookTaskType, RunLogEntry } from "../../shared/contracts";
import { deleteApi, patchApi, postApi, useApi } from "../../hooks/use-api";
import { useChatStore } from "../../store/chat";
import { useServiceStore } from "../../store/service";
import { AssistantOutputCard } from "./AssistantOutputCard";
import { ConfirmDialog } from "../ConfirmDialog";
import { TaskChapterProgress } from "../task/TaskChapterProgress";
import { TaskInlineNote } from "../task/TaskInlineNote";
import { TaskMetricsSummary } from "../task/TaskMetricsSummary";
import { TaskPerformanceBreakdown } from "../task/TaskPerformanceBreakdown";
import { cn } from "../../lib/utils";
import { elapsedFrom, formatDuration, resolveTaskChapterStartAt, resolveTaskEndAt, resolveTaskStartAt, resolveTaskUpdateAt } from "../../lib/task-time";
import { createTaskTokenSample, formatTaskTokenUsage, mergeTaskTokenSamples, shouldShowTaskTokenMetrics, type TaskTokenSample } from "../../lib/task-metrics";
import { CalendarClock, Clock3, Play, Square, TimerReset, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { buildTaskStageTimeline, computeTaskPhaseDurations, getTaskDisplayedChapterCount, mergeTaskStageHistory, type TaskStageSnapshot } from "../../lib/task-stage-stats";
import { TaskRuntimeControls } from "../task/TaskRuntimeControls";
import {
  TaskStateLegend,
  canCancelRetryWaitingTask,
  canDeleteTask,
  canEditTaskRuntimeSettings,
  canResumeTask,
  canRetryTask,
  canStopTask,
  canToggleAutoRetry,
  getAutoRetryToggleLabel,
  getCancelTaskActionLabel,
  getResumeActionLabel,
  getRetryActionLabel,
  getTaskStatusMeta,
  isTaskTerminalStatus,
} from "../task/TaskStateLegend";

interface BookTaskPanelProps {
  readonly bookId: string;
  readonly nextChapter: number;
  readonly targetChapters: number;
  readonly chapterWordCount: number;
  readonly selectedModel: string | null;
  readonly selectedService: string | null;
  readonly onManageModels?: () => void;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; stateMessages: ReadonlyArray<SSEMessage>; connected: boolean };
}

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
        ...(existing ?? (incoming as BookTask)),
        ...incoming,
        logs: mergeLogs(existing?.logs ?? [], incoming.logs ?? []),
      };
  return {
    ...next,
    startedAt: next.startedAt ?? existing?.startedAt ?? null,
    chapterStartedAt: next.chapterStartedAt ?? existing?.chapterStartedAt ?? null,
    stageStartedAt: next.stageStartedAt ?? existing?.stageStartedAt ?? null,
  };
}

function mergeTaskList(existing: ReadonlyArray<BookTask>, incoming: ReadonlyArray<BookTask>): BookTask[] {
  const byId = new Map(existing.map((task) => [task.id, task] as const));
  return incoming.map((task) => mergeTaskSnapshot(byId.get(task.id), task));
}

function upsertTask(existing: ReadonlyArray<BookTask>, incoming: BookTaskSnapshot, log?: RunLogEntry, exceptionLog?: RunLogEntry): BookTask[] {
  const byId = new Map(existing.map((task) => [task.id, task] as const));
  const current = byId.get(incoming.id);
  const next = mergeTaskSnapshot(current, {
    ...incoming,
    ...(log ? { logs: [log] } : {}),
    ...(exceptionLog ? { exceptionLogs: [exceptionLog] } : {}),
  });
  byId.set(next.id, next);
  const ordered = [next, ...existing.filter((task) => task.id !== next.id)];
  return ordered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function stageGroup(stage: string): string {
  if (stage === "audit") return "审计阶段";
  if (stage === "revise") return "修订阶段";
  if (stage.startsWith("saving_")) return "保存阶段";
  if (stage === "write_chapter") return "写作阶段";
  if (stage === "retry_waiting") return "重试阶段";
  if (stage === "stopping") return "停止阶段";
  if (stage === "paused") return "暂停阶段";
  return "任务阶段";
}

function stageText(task: Pick<BookTask, "stage" | "stageLabel" | "stageDetail">): string {
  const label = task.stageLabel?.trim() || task.stage;
  return `${stageGroup(task.stage)} · ${label}${task.stageDetail ? ` · ${task.stageDetail}` : ""}`;
}

function taskModelText(task: Pick<BookTask, "options">): string {
  const service = task.options.service?.trim();
  const model = task.options.model?.trim();
  if (service && model) return `${service}/${model}`;
  if (model) return model;
  if (service) return service;
  return "未选择";
}

function taskQuickModeText(task: Pick<BookTask, "options">): string {
  return `快速模式 ${task.options.quickMode ? "开" : "关"}`;
}

function taskRetryText(task: Pick<BookTask, "retryCount" | "retryEnabled" | "retryAt" | "status">, nowTick: number): string {
  if (task.status === "retry_waiting") {
    const retryAtMs = task.retryAt ? new Date(task.retryAt).getTime() : null;
    const remainingMs = retryAtMs == null ? null : Math.max(0, retryAtMs - nowTick);
    return remainingMs == null
      ? `自动重试第 ${task.retryCount} 次，等待重试`
      : remainingMs > 0
        ? `自动重试第 ${task.retryCount} 次，${formatDuration(remainingMs)} 后重试`
        : `自动重试第 ${task.retryCount} 次，即将重试`;
  }
  if (task.retryCount > 0) {
    return `已重试 ${task.retryCount} 次${task.retryEnabled ? "，失败后仍会自动重试" : ""}`;
  }
  return task.retryEnabled ? "失败后自动重试：开启" : "失败后自动重试：关闭";
}

function taskTypeText(type: BookTaskType): string {
  return type === "audit" ? "审计任务" : "写作任务";
}

function taskAuditRangeText(task: Pick<BookTask, "type" | "auditChapterStart" | "auditChapterEnd">): string | null {
  if (task.type !== "audit") return null;
  if (task.auditChapterStart == null && task.auditChapterEnd == null) return "审计范围：自动";
  return `审计范围：${task.auditChapterStart ?? "?"} - ${task.auditChapterEnd ?? "?"}`;
}

interface AnnotatedTaskLog extends RunLogEntry {
  readonly stage: string;
  readonly stageLabel: string | null;
  readonly stageDetail: string | null;
}

function taskKey(task: Pick<BookTask, "bookId" | "id">): string {
  return `${task.bookId}:${task.id}`;
}

function annotateTaskLogs(task: Pick<BookTask, "stage" | "stageLabel" | "stageDetail">, logs: ReadonlyArray<RunLogEntry>): AnnotatedTaskLog[] {
  return logs.map((log) => ({
    ...log,
    stage: task.stage,
    stageLabel: task.stageLabel ?? null,
    stageDetail: task.stageDetail ?? null,
  }));
}

function annotatedLogKey(log: AnnotatedTaskLog): string {
  return `${log.timestamp}::${log.level}::${log.stage}::${log.message}`;
}

function mergeAnnotatedTaskLogs(existing: ReadonlyArray<AnnotatedTaskLog>, incoming: ReadonlyArray<AnnotatedTaskLog>): AnnotatedTaskLog[] {
  const merged = [...existing];
  const seen = new Set(existing.map(annotatedLogKey));
  for (const log of incoming) {
    const key = annotatedLogKey(log);
    if (seen.has(key)) continue;
    merged.push(log);
    seen.add(key);
  }
  return merged.slice(-100);
}

function groupLogsByStage(logs: ReadonlyArray<AnnotatedTaskLog>): Array<{ stage: string; stageLabel: string | null; stageDetail: string | null; logs: AnnotatedTaskLog[] }> {
  const groups = new Map<string, { stage: string; stageLabel: string | null; stageDetail: string | null; logs: AnnotatedTaskLog[] }>();
  for (const log of logs) {
    const key = `${log.stage}::${log.stageLabel ?? ""}::${log.stageDetail ?? ""}`;
    const current = groups.get(key);
    if (current) current.logs.push(log);
    else groups.set(key, { stage: log.stage, stageLabel: log.stageLabel, stageDetail: log.stageDetail, logs: [log] });
  }
  return [...groups.values()];
}

function calcDefaultRequestedChapters(nextChapter: number, targetChapters: number): number {
  return Math.max(1, targetChapters - nextChapter + 1);
}

export function BookTaskPanel({ bookId, nextChapter, targetChapters, chapterWordCount, selectedModel, selectedService, onManageModels, sse }: BookTaskPanelProps) {
  const { data } = useApi<BookTaskListResponse>(`/books/${bookId}/tasks`);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const services = useServiceStore((s) => s.services);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchModels = useServiceStore((s) => s.fetchModels);
  const [tasks, setTasks] = useState<ReadonlyArray<BookTask>>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [requestedChapters, setRequestedChapters] = useState(() => calcDefaultRequestedChapters(nextChapter, targetChapters));
  const [auditChapterStart, setAuditChapterStart] = useState(() => String(nextChapter));
  const [auditChapterEnd, setAuditChapterEnd] = useState(() => String(Math.max(nextChapter, targetChapters)));
  const [wordCount, setWordCount] = useState(() => (chapterWordCount > 0 ? String(chapterWordCount) : ""));
  const [quickMode, setQuickMode] = useState(true);
  const [taskType, setTaskType] = useState<BookTaskType>("write");
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [taskLogsByKey, setTaskLogsByKey] = useState<Record<string, ReadonlyArray<AnnotatedTaskLog>>>({});
  const [taskStageHistoryByKey, setTaskStageHistoryByKey] = useState<Record<string, ReadonlyArray<TaskStageSnapshot>>>({});
  const [taskTokenSamplesByKey, setTaskTokenSamplesByKey] = useState<Record<string, ReadonlyArray<TaskTokenSample>>>({});
  const [updatingTaskKey, setUpdatingTaskKey] = useState<string | null>(null);
  const [deleteConfirmTask, setDeleteConfirmTask] = useState<BookTask | null>(null);
  const [taskModelPickerOpened, setTaskModelPickerOpened] = useState(false);
  const createTaskQuickModeHidden = taskType === "audit";
  const createTaskWordCountHidden = taskType === "audit";

  useEffect(() => {
    if (!data?.tasks) return;
    setTasks((prev) => mergeTaskList(prev, data.tasks));
    setTaskLogsByKey((prev) => {
      const next = { ...prev };
      for (const task of data.tasks) {
        const key = taskKey(task);
        next[key] = mergeAnnotatedTaskLogs(next[key] ?? [], annotateTaskLogs(task, task.logs ?? []));
      }
      return next;
    });
    setTaskStageHistoryByKey((prev) => {
      const next = { ...prev };
      for (const task of data.tasks) {
        const key = taskKey(task);
        next[key] = mergeTaskStageHistory(next[key] ?? [], task);
      }
      return next;
    });
    setTaskTokenSamplesByKey((prev) => {
      const next = { ...prev };
      for (const task of data.tasks) {
        const sample = createTaskTokenSample(task);
        if (!sample) continue;
        const key = taskKey(task);
        next[key] = mergeTaskTokenSamples(next[key] ?? [], sample);
      }
      return next;
    });
  }, [data?.tasks]);

  const ensureTaskModelsLoaded = () => {
    if (taskModelPickerOpened) return;
    setTaskModelPickerOpened(true);
  };

  useEffect(() => {
    if (!taskModelPickerOpened) return;
    void fetchServices();
  }, [fetchServices, taskModelPickerOpened]);

  useEffect(() => {
    if (!taskModelPickerOpened) return;
    for (const service of services) {
      if (service.connected) void fetchModels(service.service);
    }
  }, [fetchModels, services, taskModelPickerOpened]);

  const selectedTask = useMemo(() => {
    if (!tasks.length) return null;
    if (selectedTaskId) return tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
    return tasks[0] ?? null;
  }, [selectedTaskId, tasks]);

  const groupedModels = useMemo(
    () => services
      .filter((service) => service.connected && (modelsByService[service.service]?.models.length ?? 0) > 0)
      .map((service) => ({
        service: service.service,
        label: service.label,
        models: modelsByService[service.service]!.models,
      })),
    [modelsByService, services],
  );

  const detailTask = selectedTask ?? null;
  const detailTaskLogGroups = useMemo(() => {
    if (!detailTask) return [];
    const key = taskKey(detailTask);
    const logs = taskLogsByKey[key] ?? annotateTaskLogs(detailTask, detailTask.logs ?? []);
    return groupLogsByStage(logs);
  }, [detailTask, taskLogsByKey]);
  const detailTaskStageDurations = useMemo(() => {
    if (!detailTask) return null;
    const key = taskKey(detailTask);
    return computeTaskPhaseDurations(taskStageHistoryByKey[key] ?? [], detailTask, nowTick);
  }, [detailTask, nowTick, taskStageHistoryByKey]);
  const detailTaskTokenSamples = useMemo(() => {
    if (!detailTask) return [];
    return taskTokenSamplesByKey[taskKey(detailTask)] ?? [];
  }, [detailTask, taskTokenSamplesByKey]);
  const detailTaskTimeline = useMemo(() => {
    if (!detailTask) return [];
    const key = taskKey(detailTask);
    return buildTaskStageTimeline(taskStageHistoryByKey[key] ?? [], detailTask, nowTick);
  }, [detailTask, nowTick, taskStageHistoryByKey]);

  const activeTask = useMemo(
    () => tasks.find((task) => !isTaskTerminalStatus(task.status)) ?? null,
    [tasks],
  );
  const canStopActiveTask = activeTask?.status === "queued" || activeTask?.status === "running" || activeTask?.status === "stopping";

  useEffect(() => {
    if (tasks.length === 0) return;
    if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(activeTask?.id ?? tasks[0]?.id ?? null);
  }, [activeTask?.id, selectedTaskId, tasks]);

  useEffect(() => {
    setRequestedChapters(calcDefaultRequestedChapters(nextChapter, targetChapters));
    setAuditChapterStart(String(nextChapter));
    setAuditChapterEnd(String(Math.max(nextChapter, targetChapters)));
  }, [nextChapter, targetChapters]);

  useEffect(() => {
    if (wordCount.trim().length === 0 && chapterWordCount > 0) {
      setWordCount(String(chapterWordCount));
    }
  }, [chapterWordCount, wordCount]);

  useEffect(() => {
    if (createTaskQuickModeHidden && quickMode) {
      setQuickMode(false);
    }
  }, [createTaskQuickModeHidden, quickMode]);

  const hasLiveTask = useMemo(
    () => tasks.some((task) => !isTaskTerminalStatus(task.status)),
    [tasks],
  );

  useEffect(() => {
    setNowTick(Date.now());
    if (!hasLiveTask) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveTask]);

  useEffect(() => {
    if (sse.stateMessages.length === 0) return;
    setTasks((prev) => {
      let next = prev;
      for (const message of sse.stateMessages) {
        if (!message.event.startsWith("book-task:")) continue;
        if ((message.data as { bookId?: string } | null)?.bookId !== bookId) continue;
        const eventTask = message.data as { task?: BookTaskSnapshot; log?: RunLogEntry; exceptionLog?: RunLogEntry } | null;
        const incomingTask = eventTask?.task;
        if (!incomingTask) continue;
        next = upsertTask(next, incomingTask, eventTask?.log, eventTask?.exceptionLog);
      }
      return next;
    });
    setTaskLogsByKey((prev) => {
      const next = { ...prev };
      for (const message of sse.stateMessages) {
        if (!message.event.startsWith("book-task:")) continue;
        if ((message.data as { bookId?: string } | null)?.bookId !== bookId) continue;
        if (message.event !== "book-task:log") continue;
        const eventTask = message.data as { task?: BookTaskSnapshot; log?: RunLogEntry } | null;
        const incomingTask = eventTask?.task;
        if (!incomingTask || !eventTask?.log) continue;
        const key = `${bookId}:${incomingTask.id}`;
        const annotated = {
          ...eventTask.log,
          stage: incomingTask.stage ?? "queued",
          stageLabel: incomingTask.stageLabel ?? null,
          stageDetail: incomingTask.stageDetail ?? null,
        };
        next[key] = mergeAnnotatedTaskLogs(next[key] ?? [], [annotated]);
      }
      return next;
    });
    setTaskStageHistoryByKey((prev) => {
      const next = { ...prev };
      for (const message of sse.stateMessages) {
        if (!message.event.startsWith("book-task:")) continue;
        if ((message.data as { bookId?: string } | null)?.bookId !== bookId) continue;
        const eventTask = message.data as { task?: BookTaskSnapshot } | null;
        if (!eventTask?.task) continue;
        const key = `${bookId}:${eventTask.task.id}`;
        next[key] = mergeTaskStageHistory(next[key] ?? [], eventTask.task);
      }
      return next;
    });
    setTaskTokenSamplesByKey((prev) => {
      const next = { ...prev };
      for (const message of sse.stateMessages) {
        if (!message.event.startsWith("book-task:")) continue;
        if ((message.data as { bookId?: string } | null)?.bookId !== bookId) continue;
        const eventTask = message.data as { task?: BookTaskSnapshot } | null;
        const incomingTask = eventTask?.task;
        if (!incomingTask) continue;
        if (message.event !== "book-task:update" && message.event !== "book-task:progress") continue;
        const sample = createTaskTokenSample(incomingTask);
        if (!sample) continue;
        const key = `${bookId}:${incomingTask.id}`;
        next[key] = mergeTaskTokenSamples(next[key] ?? [], sample);
      }
      return next;
    });
  }, [bookId, sse.stateMessages]);

  const handleCreateTask = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const payload = {
        type: taskType,
        requestedChapters: Number.isFinite(requestedChapters) ? Math.max(1, Math.round(requestedChapters)) : undefined,
        auditChapterStart: taskType === "audit" && Number.isFinite(Number(auditChapterStart)) ? Math.max(1, Math.round(Number(auditChapterStart))) : undefined,
        auditChapterEnd: taskType === "audit" && Number.isFinite(Number(auditChapterEnd)) ? Math.max(1, Math.round(Number(auditChapterEnd))) : undefined,
        wordCount: createTaskWordCountHidden || !wordCount.trim() || !Number.isFinite(Number(wordCount))
          ? undefined
          : Math.max(1, Math.round(Number(wordCount))),
        quickMode: createTaskQuickModeHidden ? false : quickMode,
        service: selectedService?.trim() || undefined,
        model: selectedModel?.trim() || undefined,
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

  const handleToggleAutoRetry = async (task: BookTask) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await patchApi<{ task: BookTask }>(`/tasks/${bookId}/${task.id}`, {
        retryEnabled: !task.retryEnabled,
      });
      setTasks((prev) => upsertTask(prev, response.task));
    } catch (error) {
      console.error("toggle auto retry failed", error);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateTaskSettings = async (
    task: BookTask,
    patch: { readonly service?: string | null; readonly model?: string | null; readonly quickMode?: boolean },
  ) => {
    const key = taskKey(task);
    setUpdatingTaskKey(key);
    try {
      const response = await patchApi<{ task: BookTask }>(`/tasks/${bookId}/${task.id}`, {
        options: patch,
      });
      setTasks((prev) => upsertTask(prev, response.task));
    } catch (error) {
      console.error("update task settings failed", error);
    } finally {
      setUpdatingTaskKey((current) => (current === key ? null : current));
    }
  };

  const handleRetryTask = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await postApi<{ task: BookTask }>(`/tasks/${bookId}/${taskId}/retry`);
      setTasks((prev) => upsertTask(prev, response.task));
    } catch (error) {
      console.error("retry book task failed", error);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await postApi<{ task: BookTask }>(`/tasks/${bookId}/${taskId}/cancel`);
      setTasks((prev) => upsertTask(prev, response.task));
    } catch (error) {
      console.error("cancel book task failed", error);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTask = async (task: BookTask) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteApi(`/tasks/${bookId}/${task.id}`);
      setTasks((prev) => prev.filter((item) => item.id !== task.id));
      setTaskLogsByKey((prev) => {
        const next = { ...prev };
        delete next[taskKey(task)];
        return next;
      });
      setTaskStageHistoryByKey((prev) => {
        const next = { ...prev };
        delete next[taskKey(task)];
        return next;
      });
      if (selectedTaskId === task.id) {
        setSelectedTaskId(null);
      }
      setDeleteConfirmTask((current) => (current?.id === task.id ? null : current));
    } catch (error) {
      console.error("delete book task failed", error);
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
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)_repeat(2,minmax(0,0.8fr))]">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">任务类型</span>
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value === "audit" ? "audit" : "write")}
              className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
            >
              <option value="write">写作</option>
              <option value="audit">审计</option>
            </select>
          </label>
          {taskType === "audit" ? (
            <>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">审计起始章</span>
                <input
                  type="number"
                  min={1}
                  value={auditChapterStart}
                  onChange={(e) => setAuditChapterStart(e.target.value)}
                  className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">审计结束章</span>
                <input
                  type="number"
                  min={1}
                  value={auditChapterEnd}
                  onChange={(e) => setAuditChapterEnd(e.target.value)}
                  className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
                />
              </label>
            </>
          ) : (
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
          )}
          {createTaskWordCountHidden ? null : (
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">每章字数</span>
              <input
                type="number"
                min={1}
                value={wordCount}
                onChange={(e) => setWordCount(e.target.value)}
                placeholder={chapterWordCount > 0 ? String(chapterWordCount) : "可选"}
                className="h-9 w-full rounded-md border border-border/50 bg-background/70 px-2 text-sm outline-none"
              />
            </label>
          )}
        </div>
        <TaskRuntimeControls
          groupedModels={groupedModels}
          selectedModel={selectedModel}
          selectedService={selectedService}
          quickMode={quickMode}
          hideQuickMode={createTaskQuickModeHidden}
          editable
          inline
          onModelChange={(model, service) => {
            setSelectedModel(model, service);
          }}
          onQuickModeChange={setQuickMode}
          onModelMenuOpen={ensureTaskModelsLoaded}
          onManageModels={onManageModels}
          className="rounded-xl border border-border/40 bg-background/40 p-4"
          label="任务设置"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/40 bg-background/35 px-3 py-2 text-xs text-muted-foreground">
          <span>任务将直接沿用当前 AI 工作台设置。</span>
          <span className="inline-flex items-center gap-1">
            <CalendarClock size={12} />
            {taskType === "audit" ? `审计范围 ${auditChapterStart || "—"} - ${auditChapterEnd || "—"}` : `从第 ${nextChapter} 章开始`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void handleCreateTask(); }}
            disabled={busy || !selectedModel || !selectedService}
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

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(520px,1.12fr)]">
        <AssistantOutputCard heading={`任务列表 (${tasks.length})`} className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex-1 min-h-0 space-y-2 overflow-y-auto pr-1">
            {tasks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/40 px-3 py-6 text-center text-xs text-muted-foreground">
                还没有任务，创建后会在这里显示。
              </div>
            ) : (
              tasks.map((task) => {
                const meta = getTaskStatusMeta(task.status);
                const Icon = meta.icon;
                const selected = selectedTask?.id === task.id;
                const taskProgress = Math.min(100, Math.round(((task.completedChapters + (task.currentChapterNumber != null && !task.chapterFinishedAt ? 1 : 0)) / Math.max(1, task.requestedChapters)) * 100));
                const runtime = formatDuration(elapsedFrom(resolveTaskStartAt(task), resolveTaskEndAt(task), nowTick));
                const chapterRuntime = formatDuration(elapsedFrom(resolveTaskChapterStartAt(task), task.chapterFinishedAt ?? resolveTaskEndAt(task), nowTick, resolveTaskStartAt(task)));
                const updateAge = formatDuration(elapsedFrom(resolveTaskUpdateAt(task), null, nowTick, task.updatedAt));
                const runtimeEditable = canEditTaskRuntimeSettings(task.status) && updatingTaskKey !== taskKey(task);
                return (
                  <div
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedTaskId(task.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedTaskId(task.id);
                    }}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2 text-left transition",
                      selected ? "border-primary/40 bg-primary/10" : "border-border/40 bg-background/40 hover:bg-accent/25",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{task.title}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {taskTypeText(task.type)} · {task.completedChapters}/{task.requestedChapters} 章 · {formatTime(task.updatedAt)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {stageText(task)} · 总时长 {runtime} · 单章 {chapterRuntime}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          阶段更新距今 {updateAge}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          模型：{taskModelText(task)}{task.type === "audit" ? "" : ` · ${taskQuickModeText(task)}`}
                        </div>
                        {taskAuditRangeText(task) ? <div className="mt-1 text-[11px] text-muted-foreground">{taskAuditRangeText(task)}</div> : null}
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {taskRetryText(task, nowTick)}
                        </div>
                          <TaskChapterProgress task={task} compact className="mt-2" />
                          {shouldShowTaskTokenMetrics(task) ? (
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              Token {formatTaskTokenUsage(task)}
                            </div>
                          ) : null}
                        <div onClick={(event) => event.stopPropagation()}>
                        <TaskRuntimeControls
                          groupedModels={groupedModels}
                          selectedModel={task.options.model}
                          selectedService={task.options.service}
                          quickMode={task.options.quickMode}
                          hideQuickMode={task.type === "audit"}
                          editable={runtimeEditable}
                          compact
                          inline
                          onModelChange={(model, service) => {
                            void handleUpdateTaskSettings(task, { model, service });
                          }}
                          onQuickModeChange={(next) => {
                            void handleUpdateTaskSettings(task, { quickMode: next });
                          }}
                          onModelMenuOpen={ensureTaskModelsLoaded}
                          onManageModels={onManageModels}
                          className="mt-2"
                          label="运行配置"
                        />
                        </div>
                      </div>
                      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px]", meta.className)}>
                        <Icon size={11} />{meta.label}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-secondary/70">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${taskProgress}%` }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </AssistantOutputCard>

        <AssistantOutputCard heading="任务详情" className="flex min-h-0 flex-col overflow-hidden">
          {detailTask ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{detailTask.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    创建于 {formatTime(detailTask.createdAt)} · 开始 {formatTime(detailTask.startedAt)} · 完成 {formatTime(detailTask.finishedAt)}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px]", getTaskStatusMeta(detailTask.status).className)}>
                    {getTaskStatusMeta(detailTask.status).label}
                  </span>
                  <span className="rounded-full border border-border/40 bg-secondary/40 px-2 py-1 text-[11px] text-muted-foreground">
                    {taskTypeText(detailTask.type)}
                  </span>
                </div>
              </div>

                <div className="space-y-3 text-xs text-muted-foreground">
                  <div className="grid gap-2 lg:grid-cols-2">
                    <TaskChapterProgress task={detailTask} className="lg:col-span-2" />
                    <div>类型：{taskTypeText(detailTask.type)}</div>
                    <div>阶段：{stageText(detailTask)}</div>
                    <div>模型：{taskModelText(detailTask)}</div>
                    {detailTask.type === "audit" ? null : <div>{taskQuickModeText(detailTask)}</div>}
                    {taskAuditRangeText(detailTask) ? <div>{taskAuditRangeText(detailTask)}</div> : null}
                    <div>重试：{taskRetryText(detailTask, nowTick)}</div>
                    <div>已完成：{getTaskDisplayedChapterCount(detailTask)}/{detailTask.requestedChapters}</div>
                  </div>
                  <TaskMetricsSummary task={detailTask} nowTick={nowTick} tokenSamples={detailTaskTokenSamples} />
                    {shouldShowTaskTokenMetrics(detailTask) ? (
                      <div className="text-xs text-muted-foreground">
                        Token：{formatTaskTokenUsage(detailTask)}
                      </div>
                    ) : null}
                  {detailTask.error ? (
                    <TaskInlineNote label="异常" value={detailTask.error} className="text-xs" />
                  ) : (
                    <TaskInlineNote label="异常" value={null} tone="muted" className="text-xs" />
                  )}
                  <TaskStateLegend task={detailTask} className="mt-1" />
                  <div className="rounded-xl border border-border/40 bg-background/30 p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">运行状态</div>
                    <div className="grid gap-2 lg:grid-cols-2">
                      <div>当前章节：{detailTask.currentChapterNumber ?? "—"}</div>
                      <div>下一章节：{detailTask.nextChapterNumber ?? "—"}</div>
                      <div>心跳：{formatTime(detailTask.lastHeartbeatAt)}</div>
                      <div>停止请求：{formatTime(detailTask.stopRequestedAt)}</div>
                      <div>重试次数：{detailTask.retryCount}</div>
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/40 bg-background/30 p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">时间信息</div>
                    <div className="grid gap-2 lg:grid-cols-2">
                      <div>总时长：{formatDuration(elapsedFrom(resolveTaskStartAt(detailTask), resolveTaskEndAt(detailTask), nowTick))}</div>
                      <div>单章时长：{formatDuration(elapsedFrom(resolveTaskChapterStartAt(detailTask), detailTask.chapterFinishedAt ?? resolveTaskEndAt(detailTask), nowTick, resolveTaskStartAt(detailTask)))}</div>
                      <div>阶段更新距今：{formatDuration(elapsedFrom(resolveTaskUpdateAt(detailTask), null, nowTick, detailTask.updatedAt))}</div>
                      <div>审计耗时：{formatDuration(detailTaskStageDurations?.auditMs ?? 0)}</div>
                      <div>修订耗时：{formatDuration(detailTaskStageDurations?.reviseMs ?? 0)}</div>
                      <div>保存耗时：{formatDuration(detailTaskStageDurations?.savingMs ?? 0)}</div>
                    </div>
                  </div>
                  <TaskPerformanceBreakdown task={detailTask} />
                </div>

              <TaskRuntimeControls
                groupedModels={groupedModels}
                selectedModel={detailTask.options.model}
                selectedService={detailTask.options.service}
                quickMode={detailTask.options.quickMode}
                hideQuickMode={detailTask.type === "audit"}
                editable={canEditTaskRuntimeSettings(detailTask.status) && updatingTaskKey !== taskKey(detailTask)}
                inline
                onModelChange={(model, service) => {
                  void handleUpdateTaskSettings(detailTask, { model, service });
                }}
                onQuickModeChange={(next) => {
                  void handleUpdateTaskSettings(detailTask, { quickMode: next });
                }}
                onModelMenuOpen={ensureTaskModelsLoaded}
                onManageModels={onManageModels}
                className="rounded-xl border border-border/40 bg-background/35 p-3"
                label="运行配置"
              />

              <div className="rounded-xl border border-border/40 bg-background/40 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">当前章节轨迹</span>
                  <span>第 {detailTask.currentChapterNumber ?? "?"} 章</span>
                </div>
                <div className="rounded-xl border border-border/40 bg-background/30 p-2">
                  <div className="space-y-2">
                  {detailTaskTimeline.length === 0 ? (
                    <div className="px-1 py-2 text-xs text-muted-foreground">暂无阶段轨迹</div>
                  ) : (
                    detailTaskTimeline.map((step, index) => (
                      <div key={`${step.stage}-${step.startedAt ?? index}`} className="flex gap-2">
                        <div className="flex w-4 flex-col items-center pt-1">
                          <span className={cn("h-2 w-2 rounded-full", step.isCurrent ? "bg-primary" : "bg-border")} />
                          {index < detailTaskTimeline.length - 1 ? <span className="mt-1 w-px flex-1 bg-border/60" /> : null}
                        </div>
                        <div className={cn("min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-xs", step.isCurrent ? "border-primary/30 bg-primary/5" : "border-border/30 bg-card/60")}>
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 truncate font-medium text-foreground">#{step.order} · {stageGroup(step.stage)}</span>
                            <span className="ml-auto shrink-0 rounded-full bg-secondary/60 px-2 py-0.5 text-[11px] text-muted-foreground">{formatDuration(step.durationMs)}</span>
                            {step.isCurrent ? <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">进行中</span> : null}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="truncate">{step.stageLabel ?? step.stage}</span>
                            {step.stageDetail ? <span className="truncate">· {step.stageDetail}</span> : null}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground/80">
                            {formatTime(step.startedAt)}{step.endedAt ? ` → ${formatTime(step.endedAt)}` : ""}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border/40 bg-background/40 p-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">按阶段分组日志</div>
                <div className="max-h-[220px] space-y-3 overflow-y-auto pr-1">
                  {detailTaskLogGroups.length === 0 ? (
                    <div className="text-xs text-muted-foreground">暂无日志</div>
                  ) : (
                    detailTaskLogGroups.map((group) => (
                      <div key={`${group.stage}::${group.stageLabel ?? ""}::${group.stageDetail ?? ""}`} className="rounded-lg border border-border/30 bg-card/70 px-2 py-2 text-xs">
                        <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                          {stageGroup(group.stage)} · {group.stageLabel ?? group.stage}
                          {group.stageDetail ? ` · ${group.stageDetail}` : ""}
                        </div>
                        <div className="space-y-2">
                          {group.logs.map((log) => (
                            <div key={`${log.timestamp}-${log.message}`} className="text-muted-foreground">
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
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {canResumeTask(detailTask.status) ? (
                  <button
                    type="button"
                    onClick={() => { void handleResumeTask(detailTask.id); }}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary disabled:opacity-50"
                  >
                    <Play size={14} />{getResumeActionLabel()}
                  </button>
                ) : null}
                {canRetryTask(detailTask.status) ? (
                  <button
                    type="button"
                    onClick={() => { void handleRetryTask(detailTask.id); }}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-border/50 px-3 py-2 text-sm hover:bg-secondary/50 disabled:opacity-50"
                  >
                    <Play size={14} />{getRetryActionLabel()}
                  </button>
                ) : null}
                {canCancelRetryWaitingTask(detailTask.status) ? (
                  <button
                    type="button"
                    onClick={() => { void handleCancelTask(detailTask.id); }}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-border/50 px-3 py-2 text-sm hover:bg-secondary/50 disabled:opacity-50"
                  >
                    <Square size={14} />{getCancelTaskActionLabel()}
                  </button>
                ) : null}
                {canToggleAutoRetry(detailTask.status) && (
                  <button
                    type="button"
                    onClick={() => { void handleToggleAutoRetry(detailTask); }}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-border/50 px-3 py-2 text-sm hover:bg-secondary/50 disabled:opacity-50"
                  >
                    <TimerReset size={14} />{getAutoRetryToggleLabel(detailTask)}
                  </button>
                )}
                {canStopTask(detailTask.status) && (
                  <button
                    type="button"
                    onClick={() => { void handleStopTask(detailTask.id); }}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive disabled:opacity-50"
                  >
                    <Square size={14} />中止任务
                  </button>
                )}
                {canDeleteTask(detailTask.status) && (
                  <button
                    type="button"
                    onClick={() => { setDeleteConfirmTask(detailTask); }}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive disabled:opacity-50"
                  >
                    <Trash2 size={14} />删除任务
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/40 px-3 py-6 text-center text-xs text-muted-foreground">
              选择一个任务查看详情。
            </div>
          )}
        </AssistantOutputCard>
      </div>

      <ConfirmDialog
        open={deleteConfirmTask !== null}
        title="删除任务"
        message={deleteConfirmTask ? `确认删除「${deleteConfirmTask.title}」吗？删除后无法恢复。` : "确认删除该任务吗？删除后无法恢复。"}
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => {
          if (!deleteConfirmTask) return;
          void handleDeleteTask(deleteConfirmTask);
        }}
        onCancel={() => setDeleteConfirmTask(null)}
      />
    </div>
  );
}
