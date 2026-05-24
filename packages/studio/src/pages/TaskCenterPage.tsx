import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { deleteApi, patchApi, postApi, useApi } from "../hooks/use-api";
import { useChatStore } from "../store/chat";
import { useServiceStore } from "../store/service";
import type {
  BookDetail,
  BookSummary,
  BookTaskType,
  GlobalBookTaskItem,
  GlobalBookTaskListResponse,
  RunLogEntry,
} from "../shared/contracts";
import { resolveModelSelection } from "./chat-page-state";
import { AssistantOutputCard } from "../components/chat/AssistantOutputCard";
import { TaskChapterProgress } from "../components/task/TaskChapterProgress";
import { TaskInlineNote } from "../components/task/TaskInlineNote";
import { TaskMetricsSummary } from "../components/task/TaskMetricsSummary";
import { TaskPerformanceBreakdown } from "../components/task/TaskPerformanceBreakdown";
import { TaskRuntimeControls } from "../components/task/TaskRuntimeControls";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
} from "../components/task/TaskStateLegend";
import { cn } from "../lib/utils";
import { buildTaskStageTimeline, computeTaskPhaseDurations, getTaskDisplayedChapterCount, mergeTaskStageHistory, type TaskStageSnapshot } from "../lib/task-stage-stats";
import { elapsedFrom, formatDuration, resolveTaskChapterStartAt, resolveTaskEndAt, resolveTaskStartAt, resolveTaskUpdateAt } from "../lib/task-time";
import { createTaskTokenSample, formatTaskTokenUsage, mergeTaskTokenSamples, type TaskTokenSample } from "../lib/task-metrics";
import { Play, RefreshCw, Square, Trash2, XCircle } from "lucide-react";

interface Nav {
  toDashboard: () => void;
  toServices: () => void;
}

interface BookListItem extends BookSummary {
  readonly chapterWordCount?: number;
  readonly chaptersWritten?: number;
}

interface BookDetailResponse {
  readonly book: {
    readonly targetChapters?: number;
    readonly chapterWordCount?: number;
  } & Pick<BookDetail, "id" | "title">;
  readonly chapters: ReadonlyArray<{ readonly number: number }>;
  readonly nextChapter?: number;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function taskStageGroup(stage: string): string {
  if (stage === "audit") return "审计阶段";
  if (stage === "revise") return "修订阶段";
  if (stage.startsWith("saving_")) return "保存阶段";
  if (stage === "write_chapter") return "写作阶段";
  if (stage === "retry_waiting") return "重试阶段";
  if (stage === "stopping") return "停止阶段";
  if (stage === "paused") return "暂停阶段";
  return "任务阶段";
}

function taskStageLabel(task: Pick<GlobalBookTaskItem, "stage" | "stageLabel">): string {
  return task.stageLabel?.trim() || task.stage;
}

function taskStageText(task: Pick<GlobalBookTaskItem, "stage" | "stageLabel" | "stageDetail">): string {
  return `${taskStageGroup(task.stage)} · ${taskStageLabel(task)}${task.stageDetail ? ` · ${task.stageDetail}` : ""}`;
}

function taskModelText(task: Pick<GlobalBookTaskItem, "options">): string {
  const service = task.options.service?.trim();
  const model = task.options.model?.trim();
  if (service && model) return `${service}/${model}`;
  if (model) return model;
  if (service) return service;
  return "未选择";
}

function taskQuickModeText(task: Pick<GlobalBookTaskItem, "options">): string {
  return `快速模式 ${task.options.quickMode ? "开" : "关"}`;
}

function taskRetryText(task: Pick<GlobalBookTaskItem, "retryCount" | "retryEnabled" | "retryAt" | "status">, nowTick: number): string {
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

function taskAuditRangeText(task: Pick<GlobalBookTaskItem, "type" | "auditChapterStart" | "auditChapterEnd">): string | null {
  if (task.type !== "audit") return null;
  if (task.auditChapterStart == null && task.auditChapterEnd == null) return "审计范围：自动";
  return `审计范围：${task.auditChapterStart ?? "?"} - ${task.auditChapterEnd ?? "?"}`;
}

function taskAuditReminder(task: Pick<GlobalBookTaskItem, "error" | "lastErrorType" | "status">): string | null {
  const raw = `${task.error ?? ""} ${task.lastErrorType ?? ""}`.toLowerCase();
  if (!raw.includes("failed audit")) return null;
  return task.status === "running"
    ? "上一章审计未通过，任务继续执行中"
    : "上一章审计未通过";
}

interface AnnotatedTaskLog extends RunLogEntry {
  readonly stage: string;
  readonly stageLabel: string | null;
  readonly stageDetail: string | null;
}

function taskKey(task: Pick<GlobalBookTaskItem, "bookId" | "id">): string {
  return `${task.bookId}:${task.id}`;
}

function annotateTaskLogs(task: Pick<GlobalBookTaskItem, "stage" | "stageLabel" | "stageDetail">, logs: ReadonlyArray<RunLogEntry>): AnnotatedTaskLog[] {
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

function stageTrailText(task: Pick<GlobalBookTaskItem, "stage" | "stageLabel" | "stageDetail">): string {
  return `${taskStageGroup(task.stage)} · ${taskStageLabel(task)}${task.stageDetail ? ` · ${task.stageDetail}` : ""}`;
}

type TaskSnapshot = Partial<Omit<GlobalBookTaskItem, "logs" | "exceptionLogs">> & Pick<GlobalBookTaskItem, "id" | "bookId" | "updatedAt"> & {
  readonly logs?: ReadonlyArray<RunLogEntry>;
  readonly exceptionLogs?: ReadonlyArray<RunLogEntry>;
};

function taskLogKey(log: RunLogEntry): string {
  return `${log.timestamp}::${log.level}::${log.message}`;
}

function mergeTaskLogs(existing: ReadonlyArray<RunLogEntry>, incoming: ReadonlyArray<RunLogEntry>): RunLogEntry[] {
  const merged = [...existing];
  const seen = new Set(existing.map(taskLogKey));
  for (const log of incoming) {
    const key = taskLogKey(log);
    if (seen.has(key)) continue;
    merged.push(log);
    seen.add(key);
  }
  return merged.slice(-100);
}

function mergeTaskSnapshot(existing: GlobalBookTaskItem | undefined, incoming: TaskSnapshot): GlobalBookTaskItem {
  const nextTask: GlobalBookTaskItem = existing && existing.updatedAt > incoming.updatedAt
    ? {
        ...existing,
        bookTitle: incoming.bookTitle ?? existing.bookTitle ?? null,
        logs: incoming.logs ? mergeTaskLogs(existing.logs ?? [], incoming.logs) : (existing.logs ?? []),
        exceptionLogs: incoming.exceptionLogs ? mergeTaskLogs(existing.exceptionLogs ?? [], incoming.exceptionLogs) : (existing.exceptionLogs ?? []),
      }
    : {
        ...(existing ?? (incoming as GlobalBookTaskItem)),
        ...incoming,
        bookTitle: incoming.bookTitle ?? existing?.bookTitle ?? null,
        logs: incoming.logs ? mergeTaskLogs(existing?.logs ?? [], incoming.logs) : (existing?.logs ?? []),
        exceptionLogs: incoming.exceptionLogs ? mergeTaskLogs(existing?.exceptionLogs ?? [], incoming.exceptionLogs) : (existing?.exceptionLogs ?? []),
      };
  return {
    ...nextTask,
    startedAt: nextTask.startedAt ?? existing?.startedAt ?? null,
    chapterStartedAt: nextTask.chapterStartedAt ?? existing?.chapterStartedAt ?? null,
    stageStartedAt: nextTask.stageStartedAt ?? existing?.stageStartedAt ?? null,
  };
}

function upsertTask(existing: ReadonlyArray<GlobalBookTaskItem>, incoming: TaskSnapshot, log?: RunLogEntry, exceptionLog?: RunLogEntry): GlobalBookTaskItem[] {
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

function mergeTaskList(existing: ReadonlyArray<GlobalBookTaskItem>, incoming: ReadonlyArray<GlobalBookTaskItem>): GlobalBookTaskItem[] {
  const byId = new Map(existing.map((task) => [task.id, task] as const));
  return incoming.map((task) => mergeTaskSnapshot(byId.get(task.id), task));
}

function computeTaskSummary(tasks: ReadonlyArray<GlobalBookTaskItem>) {
  return tasks.reduce((acc, task) => {
    acc.totalTasks += 1;
    if (task.status === "queued") acc.queuedTasks += 1;
    if (task.status === "running" || task.status === "paused" || task.status === "stopping" || task.status === "retry_waiting" || task.status === "queued") acc.activeTasks += 1;
    if (task.status === "failed") acc.failedTasks += 1;
    if (task.status === "succeeded") acc.succeededTasks += 1;
    acc.totalWrittenChapters += task.writtenChapters ?? task.completedChapters ?? 0;
    acc.totalWrittenWords += task.writtenWords ?? 0;
    acc.totalTokenUsage += task.tokenUsage?.totalTokens ?? 0;
    return acc;
  }, {
    totalTasks: 0,
    activeTasks: 0,
    failedTasks: 0,
    queuedTasks: 0,
    succeededTasks: 0,
    totalWrittenChapters: 0,
    totalWrittenWords: 0,
    totalTokenUsage: 0,
  });
}

export function TaskCenterPage({ nav, sse }: { nav: Nav; theme: Theme; t: TFunction; sse: { messages: ReadonlyArray<{ event: string; data: unknown; timestamp: number }> } }) {
  const { data, loading, error, refetch } = useApi<GlobalBookTaskListResponse>("/tasks");
  const { data: booksData } = useApi<{ books: ReadonlyArray<BookListItem> }>("/books");
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  const services = useServiceStore((s) => s.services);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchModels = useServiceStore((s) => s.fetchModels);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [createBookId, setCreateBookId] = useState("");
  const [requestedChapters, setRequestedChapters] = useState("");
  const [auditChapterStart, setAuditChapterStart] = useState("");
  const [auditChapterEnd, setAuditChapterEnd] = useState("");
  const [wordCount, setWordCount] = useState("");
  const [createQuickMode, setCreateQuickMode] = useState(true);
  const [createTaskType, setCreateTaskType] = useState<BookTaskType>("write");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [taskBookFilter, setTaskBookFilter] = useState<string>("all");
  const [createModel, setCreateModel] = useState<string | null>(selectedModel);
  const [createService, setCreateService] = useState<string | null>(selectedService);
  const requestedChaptersTouchedRef = useRef(false);
  const wordCountTouchedRef = useRef(false);
  const modelTouchedRef = useRef(false);
  const [tasks, setTasks] = useState<ReadonlyArray<GlobalBookTaskItem>>([]);
  const [taskLogsByKey, setTaskLogsByKey] = useState<Record<string, ReadonlyArray<AnnotatedTaskLog>>>({});
  const [taskStageHistoryByKey, setTaskStageHistoryByKey] = useState<Record<string, ReadonlyArray<TaskStageSnapshot>>>({});
  const [taskTokenSamplesByKey, setTaskTokenSamplesByKey] = useState<Record<string, ReadonlyArray<TaskTokenSample>>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [updatingTaskKey, setUpdatingTaskKey] = useState<string | null>(null);
  const [deleteConfirmTask, setDeleteConfirmTask] = useState<GlobalBookTaskItem | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const createTaskQuickModeHidden = createTaskType === "audit";
  const createTaskWordCountHidden = createTaskType === "audit";

  const summary = useMemo(() => computeTaskSummary(tasks), [tasks]);
  const books = booksData?.books ?? [];
  const selectedBook = useMemo(() => books.find((book) => book.id === createBookId) ?? null, [books, createBookId]);
  const { data: selectedBookDetail } = useApi<BookDetailResponse>(createBookId ? `/books/${createBookId}` : "");
  const groupedModels = useMemo(() => services
    .filter((service) => service.connected && (modelsByService[service.service]?.models.length ?? 0) > 0)
    .map((service) => ({
      service: service.service,
      label: service.label,
      models: modelsByService[service.service]!.models,
    })), [modelsByService, services]);
  const visibleTasks = useMemo(
    () => taskBookFilter === "all" ? tasks : tasks.filter((task) => task.bookId === taskBookFilter),
    [taskBookFilter, tasks],
  );
  const selectedVisibleTasks = useMemo(
    () => visibleTasks.filter((task) => selectedTaskIds.includes(task.id)),
    [selectedTaskIds, visibleTasks],
  );
  const hasLiveTask = useMemo(
    () => tasks.some((task) => !isTaskTerminalStatus(task.status)),
    [tasks],
  );
  const selectedTask = useMemo(() => {
    if (!visibleTasks.length) return null;
    if (selectedKey) return visibleTasks.find((task) => `${task.bookId}:${task.id}` === selectedKey) ?? visibleTasks[0] ?? null;
    return visibleTasks[0] ?? null;
  }, [selectedKey, visibleTasks]);
  const selectedTaskLogGroups = useMemo(() => {
    if (!selectedTask) return [];
    const key = taskKey(selectedTask);
    const logs = taskLogsByKey[key] ?? annotateTaskLogs(selectedTask, selectedTask.logs ?? []);
    return groupLogsByStage(logs);
  }, [selectedTask, taskLogsByKey]);
  const selectedTaskStageDurations = useMemo(() => {
    if (!selectedTask) return null;
    const key = taskKey(selectedTask);
    return computeTaskPhaseDurations(taskStageHistoryByKey[key] ?? [], selectedTask, nowTick);
  }, [nowTick, selectedTask, taskStageHistoryByKey]);
  const selectedTaskTokenSamples = useMemo(() => {
    if (!selectedTask) return [];
    return taskTokenSamplesByKey[taskKey(selectedTask)] ?? [];
  }, [selectedTask, taskTokenSamplesByKey]);
  const selectedTaskTimeline = useMemo(() => {
    if (!selectedTask) return [];
    const key = taskKey(selectedTask);
    return buildTaskStageTimeline(taskStageHistoryByKey[key] ?? [], selectedTask, nowTick);
  }, [nowTick, selectedTask, taskStageHistoryByKey]);

  useEffect(() => {
    setNowTick(Date.now());
    if (!hasLiveTask) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveTask]);

  useEffect(() => {
    if (!visibleTasks.length) return;
    if (selectedKey && visibleTasks.some((task) => `${task.bookId}:${task.id}` === selectedKey)) return;
    setSelectedKey(`${visibleTasks[0].bookId}:${visibleTasks[0].id}`);
  }, [selectedKey, visibleTasks]);

  useEffect(() => {
    if (visibleTasks.length === 0) {
      setSelectedKey(null);
    }
  }, [visibleTasks.length]);

  useEffect(() => {
    setSelectedTaskIds((current) => current.filter((id) => visibleTasks.some((task) => task.id === id)));
  }, [visibleTasks]);

  useEffect(() => {
    void fetchServices();
  }, [fetchServices]);

  useEffect(() => {
    for (const service of services) {
      if (service.connected) void fetchModels(service.service);
    }
  }, [fetchModels, services]);

  useEffect(() => {
    if (data?.tasks) {
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
    }
  }, [data?.tasks]);

  useEffect(() => {
    if (sse.messages.length === 0) return;
    setTasks((prev) => {
      let next = prev;
      for (const message of sse.messages) {
        if (!message.event.startsWith("book-task:")) continue;
        const dataPayload = message.data as { bookId?: string; task?: TaskSnapshot; log?: RunLogEntry; exceptionLog?: RunLogEntry } | null;
        if (!dataPayload?.bookId || !dataPayload.task) continue;
        next = upsertTask(next, dataPayload.task, dataPayload.log, dataPayload.exceptionLog);
      }
      return next;
    });
    setTaskLogsByKey((prev) => {
      const next = { ...prev };
      for (const message of sse.messages) {
        if (!message.event.startsWith("book-task:")) continue;
        const dataPayload = message.data as { bookId?: string; task?: TaskSnapshot; log?: RunLogEntry } | null;
        if (!dataPayload?.bookId || !dataPayload.task || message.event !== "book-task:log" || !dataPayload.log) continue;
        const key = `${dataPayload.bookId}:${dataPayload.task.id}`;
        const annotated = {
          ...dataPayload.log,
          stage: dataPayload.task.stage ?? "queued",
          stageLabel: dataPayload.task.stageLabel ?? null,
          stageDetail: dataPayload.task.stageDetail ?? null,
        };
        next[key] = mergeAnnotatedTaskLogs(next[key] ?? [], [annotated]);
      }
      return next;
    });
    setTaskStageHistoryByKey((prev) => {
      const next = { ...prev };
      for (const message of sse.messages) {
        if (!message.event.startsWith("book-task:")) continue;
        const dataPayload = message.data as { bookId?: string; task?: TaskSnapshot } | null;
        if (!dataPayload?.bookId || !dataPayload.task) continue;
        const key = `${dataPayload.bookId}:${dataPayload.task.id}`;
        next[key] = mergeTaskStageHistory(next[key] ?? [], dataPayload.task);
      }
      return next;
    });
    setTaskTokenSamplesByKey((prev) => {
      const next = { ...prev };
      for (const message of sse.messages) {
        if (!message.event.startsWith("book-task:")) continue;
        const dataPayload = message.data as { bookId?: string; task?: TaskSnapshot } | null;
        if (!dataPayload?.bookId || !dataPayload.task) continue;
        if (message.event !== "book-task:update" && message.event !== "book-task:progress") continue;
        const sample = createTaskTokenSample(dataPayload.task);
        if (!sample) continue;
        const key = `${dataPayload.bookId}:${dataPayload.task.id}`;
        next[key] = mergeTaskTokenSamples(next[key] ?? [], sample);
      }
      return next;
    });
  }, [sse.messages]);

  useEffect(() => {
    if (!books.length) {
      setCreateBookId("");
      return;
    }
    if (createBookId && books.some((book) => book.id === createBookId)) return;
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("inkos:last-active-book-id")?.trim() : "";
    const nextBookId = stored && books.some((book) => book.id === stored)
      ? stored
      : books[0]?.id ?? "";
    setCreateBookId(nextBookId);
  }, [books, createBookId]);

  useEffect(() => {
    if (taskBookFilter === "all") return;
    if (!books.some((book) => book.id === taskBookFilter)) return;
    if (createBookId === taskBookFilter) return;
    setCreateBookId(taskBookFilter);
  }, [books, createBookId, taskBookFilter]);

  useEffect(() => {
    requestedChaptersTouchedRef.current = false;
    wordCountTouchedRef.current = false;
    setAuditChapterStart("");
    setAuditChapterEnd("");
  }, [createBookId]);

  useEffect(() => {
    if (modelTouchedRef.current) return;
    const resolved = resolveModelSelection(groupedModels, createModel, createService);
    if (!resolved) return;
    setCreateModel(resolved.model);
    setCreateService(resolved.service);
  }, [createModel, createService, groupedModels]);

  useEffect(() => {
    if (!createBookId) return;
    const targetChapters = Number(selectedBookDetail?.book.targetChapters ?? selectedBook?.targetChapters ?? 0);
    const writtenChapters = Number(selectedBook?.chaptersWritten ?? 0);
    const nextChapter = Number(selectedBookDetail?.nextChapter ?? writtenChapters + 1);
    const defaultRequested = Number.isFinite(targetChapters) && targetChapters > 0
      ? Math.max(1, targetChapters - Math.max(1, nextChapter) + 1)
      : Math.max(1, writtenChapters > 0 ? targetChapters - writtenChapters : 1);
    const defaultWordCount = Number(selectedBookDetail?.book.chapterWordCount ?? selectedBook?.chapterWordCount ?? 0);
    if (!requestedChaptersTouchedRef.current) {
      setRequestedChapters(String(defaultRequested));
    }
    if (!wordCountTouchedRef.current) {
      setWordCount(defaultWordCount > 0 ? String(defaultWordCount) : "");
    }
  }, [createBookId, selectedBook, selectedBookDetail]);

  useEffect(() => {
    if (createTaskQuickModeHidden && createQuickMode) {
      setCreateQuickMode(false);
    }
  }, [createQuickMode, createTaskQuickModeHidden]);

  useEffect(() => {
    if (createTaskType !== "audit") return;
    const targetChapters = Number(selectedBookDetail?.book.targetChapters ?? selectedBook?.targetChapters ?? 0);
    const writtenChapters = Number(selectedBook?.chaptersWritten ?? 0);
    const nextChapter = Number(selectedBookDetail?.nextChapter ?? writtenChapters + 1);
    if (!auditChapterStart) setAuditChapterStart(String(nextChapter));
    if (!auditChapterEnd) {
      const defaultEnd = Number.isFinite(targetChapters) && targetChapters > 0 ? targetChapters : nextChapter;
      setAuditChapterEnd(String(Math.max(nextChapter, defaultEnd)));
    }
  }, [auditChapterEnd, auditChapterStart, createTaskType, selectedBook, selectedBookDetail]);

  const handleCreateTask = async () => {
    if (!createBookId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const payload: { type: BookTaskType; source: "task-center"; requestedChapters?: number; auditChapterStart?: number; auditChapterEnd?: number; wordCount?: number; quickMode: boolean; service?: string; model?: string } = {
        type: createTaskType,
        source: "task-center",
        quickMode: createTaskQuickModeHidden ? false : createQuickMode,
      };
      const requested = Number(requestedChapters);
      const auditStart = Number(auditChapterStart);
      const auditEnd = Number(auditChapterEnd);
      const words = Number(wordCount);
      if (Number.isFinite(requested) && requested > 0) {
        payload.requestedChapters = Math.max(1, Math.round(requested));
      }
      if (createTaskType === "audit") {
        if (Number.isFinite(auditStart) && auditStart > 0) payload.auditChapterStart = Math.max(1, Math.round(auditStart));
        if (Number.isFinite(auditEnd) && auditEnd > 0) payload.auditChapterEnd = Math.max(1, Math.round(auditEnd));
      }
      if (!createTaskWordCountHidden && Number.isFinite(words) && words > 0) {
        payload.wordCount = Math.max(1, Math.round(words));
      }
      if (createService) payload.service = createService;
      if (createModel) payload.model = createModel;
      const response = await postApi<{ task: GlobalBookTaskItem }>(`/books/${createBookId}/tasks`, payload);
      setTasks((prev) => upsertTask(prev, response.task));
      await refetch();
      setTaskBookFilter(createBookId);
      setSelectedKey(`${response.task.bookId}:${response.task.id}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const handleStop = async (task: GlobalBookTaskItem) => {
    const response = await postApi<{ task: GlobalBookTaskItem }>(`/books/${task.bookId}/tasks/${task.id}/stop`);
    setTasks((prev) => upsertTask(prev, response.task));
    await refetch();
  };

  const handleResume = async (task: GlobalBookTaskItem) => {
    const response = await postApi<{ task: GlobalBookTaskItem }>(`/books/${task.bookId}/tasks/${task.id}/resume`);
    setTasks((prev) => upsertTask(prev, response.task));
    await refetch();
  };

  const handleDelete = async (task: GlobalBookTaskItem) => {
    await deleteApi(`/tasks/${task.bookId}/${task.id}`);
    setTasks((prev) => prev.filter((item) => item.id !== task.id));
    setSelectedKey((current) => (current === `${task.bookId}:${task.id}` ? null : current));
    setDeleteConfirmTask((current) => (current?.id === task.id ? null : current));
    setSelectedTaskIds((current) => current.filter((id) => id !== task.id));
    await refetch();
  };

  const handleBulkDelete = async () => {
    const targets = selectedVisibleTasks.filter((task) => canDeleteTask(task.status));
    if (targets.length === 0) return;
    setBulkDeleteConfirmOpen(false);
    for (const task of targets) {
      // Keep deletes sequential so local state stays in sync with server responses.
      // eslint-disable-next-line no-await-in-loop
      await handleDelete(task);
    }
    setSelectedTaskIds([]);
  };

  const handleRetry = async (task: GlobalBookTaskItem) => {
    const response = await postApi<{ task: GlobalBookTaskItem }>(`/tasks/${task.bookId}/${task.id}/retry`);
    setTasks((prev) => upsertTask(prev, response.task));
    await refetch();
  };

  const handleCancel = async (task: GlobalBookTaskItem) => {
    const response = await postApi<{ task: GlobalBookTaskItem }>(`/tasks/${task.bookId}/${task.id}/cancel`);
    setTasks((prev) => upsertTask(prev, response.task));
    await refetch();
  };

  const handlePatch = async (task: GlobalBookTaskItem) => {
    const response = await patchApi<{ task: GlobalBookTaskItem }>(`/tasks/${task.bookId}/${task.id}`, {
      retryEnabled: !task.retryEnabled,
    });
    setTasks((prev) => upsertTask(prev, response.task));
    await refetch();
  };

  const handleUpdateTaskSettings = async (
    task: GlobalBookTaskItem,
    patch: { readonly service?: string | null; readonly model?: string | null; readonly quickMode?: boolean },
  ) => {
    const key = taskKey(task);
    setUpdatingTaskKey(key);
    try {
      const response = await patchApi<{ task: GlobalBookTaskItem }>(`/tasks/${task.bookId}/${task.id}`, {
        options: patch,
      });
      setTasks((prev) => upsertTask(prev, response.task));
      await refetch();
    } finally {
      setUpdatingTaskKey((current) => (current === key ? null : current));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className="hover:text-foreground transition-colors">首页</button>
        <span className="text-border">/</span>
        <span className="text-foreground">任务中心</span>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">任务中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">统一查看所有书籍后台写作任务、进度、异常与恢复状态。</p>
        </div>
        <button onClick={() => void refetch()} className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-card/70 px-3 py-2 text-sm hover:bg-secondary/50">
          <RefreshCw size={14} />
          刷新
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="总任务" value={summary?.totalTasks ?? 0} />
        <StatCard label="进行中" value={summary?.activeTasks ?? 0} />
        <StatCard label="失败" value={summary?.failedTasks ?? 0} />
        <StatCard label="Token" value={(summary?.totalTokenUsage ?? 0).toLocaleString()} />
      </div>

      <AssistantOutputCard heading="任务筛选" className="overflow-hidden">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <label className="block min-w-0 flex-1">
            <div className="mb-1 text-xs font-medium text-muted-foreground">按书筛选任务</div>
            <select
              value={taskBookFilter}
              onChange={(event) => {
                const next = event.target.value;
                setTaskBookFilter(next);
                setSelectedKey(null);
              }}
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="all">全部任务</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>{book.title}</option>
              ))}
            </select>
          </label>
          <div className="text-xs text-muted-foreground md:pb-2">
            当前显示 {taskBookFilter === "all" ? tasks.length : visibleTasks.length} 个任务
          </div>
        </div>
      </AssistantOutputCard>

      <AssistantOutputCard heading="按书创建任务" className="overflow-hidden">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] 2xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_repeat(2,minmax(0,0.85fr))]">
              <label className="block">
                <div className="mb-1 text-xs font-medium text-muted-foreground">书籍</div>
                <select
                  value={createBookId}
                  onChange={(event) => {
                    requestedChaptersTouchedRef.current = false;
                    wordCountTouchedRef.current = false;
                    setCreateBookId(event.target.value);
                  }}
                  className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  {books.map((book) => (
                    <option key={book.id} value={book.id}>{book.title}</option>
                  ))}
                  </select>
              </label>
              <label className="block">
                <div className="mb-1 text-xs font-medium text-muted-foreground">任务类型</div>
                <select
                  value={createTaskType}
                  onChange={(event) => setCreateTaskType(event.target.value === "audit" ? "audit" : "write")}
                  className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="write">写作</option>
                  <option value="audit">审计</option>
                </select>
              </label>
              {createTaskType === "audit" ? (
                <>
                  <label className="block">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">审计起始章</div>
                    <input
                      type="number"
                      min={1}
                      value={auditChapterStart}
                      onChange={(event) => setAuditChapterStart(event.target.value)}
                      className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                  </label>
                  <label className="block">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">审计结束章</div>
                    <input
                      type="number"
                      min={1}
                      value={auditChapterEnd}
                      onChange={(event) => setAuditChapterEnd(event.target.value)}
                      className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                  </label>
                </>
              ) : (
                <label className="block">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">章节数</div>
                  <input
                    type="number"
                    min={1}
                    value={requestedChapters}
                    onChange={(event) => {
                      requestedChaptersTouchedRef.current = true;
                      setRequestedChapters(event.target.value);
                    }}
                    className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
              )}
              {!createTaskWordCountHidden ? (
                <label className="block">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">每章字数</div>
                  <input
                    type="number"
                    min={1}
                    value={wordCount}
                    onChange={(event) => {
                      wordCountTouchedRef.current = true;
                      setWordCount(event.target.value);
                    }}
                    className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
              ) : null}
            </div>

            <TaskRuntimeControls
              groupedModels={groupedModels}
              selectedModel={createModel}
              selectedService={createService}
              quickMode={createQuickMode}
              hideQuickMode={createTaskQuickModeHidden}
              editable
              inline
              onModelChange={(model, service) => {
                modelTouchedRef.current = true;
                setCreateModel(model);
                setCreateService(service);
              }}
              onQuickModeChange={setCreateQuickMode}
              onManageModels={nav.toServices}
              className="rounded-xl border border-border/40 bg-background/40 p-4"
              label="任务设置"
            />

            <div className="rounded-xl border border-border/40 bg-background/40 p-4 text-sm text-muted-foreground">
              {createTaskType === "audit"
                ? <div>审计范围默认值：从当前下一章到书籍目标章节，可手动调整起止章。</div>
                : <div>章节数默认值：按书籍目标章节与当前进度自动推算。</div>}
              <div>字数默认值：来自书籍配置的 chapterWordCount。</div>
              <div>模型默认值：沿用当前工作台设置，也可在此单独切换。</div>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-3 rounded-xl border border-border/40 bg-card/50 p-4">
            <div className="space-y-2 text-sm text-muted-foreground">
              <div>当前书籍：<span className="text-foreground">{selectedBook?.title ?? (createBookId || "未选择")}</span></div>
              <div>任务类型：<span className="text-foreground">{taskTypeText(createTaskType)}</span></div>
              <div>当前模型：<span className="text-foreground">{createService && createModel ? `${createService}/${createModel}` : "未选择"}</span></div>
              {!createTaskQuickModeHidden ? <div>快速模式：<span className="text-foreground">{createQuickMode ? "开启" : "关闭"}</span></div> : null}
              {createTaskType === "audit"
                ? <div>审计范围：{auditChapterStart || "—"} - {auditChapterEnd || "—"}</div>
                : <div>建议章节数：{requestedChapters || "—"}</div>}
              {createTaskType !== "audit" ? <div>建议字数：{wordCount ? Number(wordCount).toLocaleString() : "—"}</div> : null}
            </div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void handleCreateTask()}
                disabled={!createBookId || creating || !createModel || !createService}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? "创建中..." : "创建任务"}
              </button>
              {createError && <div className="text-xs text-destructive">{createError}</div>}
            </div>
          </div>
        </div>
      </AssistantOutputCard>

      <div className="grid min-h-0 gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(540px,1fr)] 2xl:grid-cols-[minmax(0,1fr)_minmax(680px,1.08fr)]">
        <AssistantOutputCard heading={`任务列表 (${visibleTasks.length})`} className="flex min-h-0 flex-col overflow-hidden">
          <div className="mb-2 rounded-xl border border-border/40 bg-background/35 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                已选 {selectedTaskIds.length} 项，可删 {selectedVisibleTasks.filter((task) => canDeleteTask(task.status)).length} 项
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelectedTaskIds(visibleTasks.map((task) => task.id))}
                  className="rounded-md border border-border/50 px-2.5 py-1.5 hover:bg-secondary/50"
                >
                  全选
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedTaskIds([])}
                  className="rounded-md border border-border/50 px-2.5 py-1.5 hover:bg-secondary/50"
                >
                  清空
                </button>
                <button
                  type="button"
                  onClick={() => setBulkDeleteConfirmOpen(true)}
                  disabled={selectedVisibleTasks.filter((task) => canDeleteTask(task.status)).length === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-2.5 py-1.5 text-destructive hover:bg-destructive/15 disabled:opacity-50"
                >
                  <Trash2 size={12} /> 批量删除（{selectedVisibleTasks.filter((task) => canDeleteTask(task.status)).length}）
                </button>
              </div>
            </div>
          </div>
          <div className="flex-1 min-h-0 space-y-2 overflow-y-auto pr-1">
            {loading ? (
              <div className="py-16 text-center text-muted-foreground">加载中...</div>
            ) : error ? (
              <div className="py-16 text-center text-destructive">{error}</div>
            ) : visibleTasks.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground">暂无任务</div>
              ) : (
                visibleTasks.map((task) => {
                  const statusMeta = getTaskStatusMeta(task.status);
                  const Icon = statusMeta.icon;
                  const active = `${task.bookId}:${task.id}` === selectedKey;
                  const isLive = task.status === "running";
                  const runtime = formatDuration(elapsedFrom(resolveTaskStartAt(task), resolveTaskEndAt(task), nowTick));
                  const chapterRuntime = formatDuration(elapsedFrom(resolveTaskChapterStartAt(task), task.chapterFinishedAt ?? resolveTaskEndAt(task), nowTick, resolveTaskStartAt(task)));
                  const updateAge = formatDuration(elapsedFrom(resolveTaskUpdateAt(task), null, nowTick, task.updatedAt));
                  const runtimeEditable = canEditTaskRuntimeSettings(task.status) && updatingTaskKey !== taskKey(task);
                  const checked = selectedTaskIds.includes(task.id);
                  return (
                  <div
                    key={`${task.bookId}:${task.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedKey(`${task.bookId}:${task.id}`)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedKey(`${task.bookId}:${task.id}`);
                    }}
                    className={cn("w-full rounded-xl border p-4 text-left transition-colors hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-primary/30", active ? "border-primary/40 bg-primary/5" : "border-border/40 bg-card/50")}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex shrink-0 items-start pt-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            event.stopPropagation();
                            setSelectedTaskIds((current) => event.target.checked
                              ? [...new Set([...current, task.id])]
                              : current.filter((id) => id !== task.id));
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="h-4 w-4 rounded border-border/60 text-primary"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {checked ? <span className="h-2 w-2 rounded-full bg-primary" /> : <span className="h-2 w-2 rounded-full bg-transparent border border-border/40" />}
                          <span className="truncate font-medium">{task.bookTitle ?? task.bookId}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs ${statusMeta.className}`}>{statusMeta.label}</span>
                          <span className="rounded-full border border-border/40 bg-secondary/40 px-2 py-0.5 text-xs text-muted-foreground">{taskTypeText(task.type)}</span>
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">{task.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {taskStageText(task)}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          模型：{taskModelText(task)}{task.type === "audit" ? "" : ` · ${taskQuickModeText(task)}`}
                        </div>
                        {taskAuditRangeText(task) ? <div className="mt-1 text-xs text-muted-foreground">{taskAuditRangeText(task)}</div> : null}
                        <div className="mt-1 text-xs text-muted-foreground">
                          {taskRetryText(task, nowTick)}
                        </div>
                        <TaskChapterProgress task={task} compact className="mt-2" />
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
                          onManageModels={nav.toServices}
                          className="mt-2"
                          label="运行配置"
                        />
                      </div>
                      <div className="flex shrink-0 items-start gap-2">
                        <Icon size={16} className={task.status === "running" ? "animate-spin text-primary" : "text-muted-foreground"} />
                        <div className="flex flex-wrap justify-end gap-1">
                          {canResumeTask(task.status) ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleResume(task);
                              }}
                              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/15"
                            >
                              <Play size={12} />{getResumeActionLabel()}
                            </button>
                          ) : null}
                          {canStopTask(task.status) ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleStop(task);
                              }}
                              className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary/50"
                              >
                              <Square size={12} />中止
                            </button>
                          ) : null}
                          {canDeleteTask(task.status) ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDeleteConfirmTask(task);
                              }}
                              className="inline-flex items-center gap-1 rounded-full border border-destructive/20 bg-destructive/10 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/15"
                            >
                              <Trash2 size={12} />删除
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                      <div className="rounded-lg border border-border/30 bg-background/30 p-2">
                        <span>章节 {getTaskDisplayedChapterCount(task)}/{task.requestedChapters}</span>
                      </div>
                      <div className="rounded-lg border border-border/30 bg-background/30 p-2">
                        <span>总时长 {runtime}</span>
                      </div>
                      <div className="rounded-lg border border-border/30 bg-background/30 p-2">
                        <span>单章 {chapterRuntime}</span>
                      </div>
                      <TaskMetricsSummary task={task} nowTick={nowTick} tokenSamples={taskTokenSamplesByKey[taskKey(task)]} compact className="col-span-full" />
                      <span>{isLive ? "字数（实时估算）" : "字数"} {task.writtenWords.toLocaleString()}</span>
                      <span>Token {formatTaskTokenUsage(task)}</span>
                      <span>任务类型 {taskTypeText(task.type)}</span>
                      {taskAuditReminder(task) ? <span className="text-amber-600">提醒 {taskAuditReminder(task)}</span> : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </AssistantOutputCard>

        <AssistantOutputCard heading="任务详情" className="flex min-h-0 flex-col overflow-hidden">
          {!selectedTask ? (
            <div className="py-16 text-center text-muted-foreground">选择一个任务查看详情</div>
          ) : (
            <div className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1">
              <div className="rounded-xl border border-border/40 bg-background/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{selectedTask.bookTitle ?? selectedTask.bookId}</div>
                    <div className="text-sm text-muted-foreground">{selectedTask.title}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${getTaskStatusMeta(selectedTask.status).className}`}>{getTaskStatusMeta(selectedTask.status).label}</span>
                    <span className="rounded-full border border-border/40 bg-secondary/40 px-2 py-0.5 text-xs text-muted-foreground">{taskTypeText(selectedTask.type)}</span>
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  <div className="grid gap-2 text-sm text-muted-foreground lg:grid-cols-4">
                    <TaskChapterProgress task={selectedTask} className="lg:col-span-4" />
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">类型：{taskTypeText(selectedTask.type)}</div>
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">阶段：{taskStageText(selectedTask)}</div>
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">模型：{taskModelText(selectedTask)}</div>
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">{selectedTask.type === "audit" ? "审计任务无快速模式" : taskQuickModeText(selectedTask)}</div>
                    {taskAuditRangeText(selectedTask) ? <div className="rounded-lg border border-border/30 bg-background/30 p-2 lg:col-span-2">{taskAuditRangeText(selectedTask)}</div> : null}
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">重试：{taskRetryText(selectedTask, nowTick)}</div>
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">{selectedTask.status === "running" ? "字数（实时估算）" : "字数"}：{selectedTask.writtenWords.toLocaleString()}</div>
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">Token：{formatTaskTokenUsage(selectedTask)}</div>
                    <div className="rounded-lg border border-border/30 bg-background/30 p-2">最近错误类型：{selectedTask.lastErrorType ?? "无"}</div>
                    {taskAuditReminder(selectedTask) ? (
                      <TaskInlineNote label="提醒" value={taskAuditReminder(selectedTask)} tone="warning" className="lg:col-span-4" />
                    ) : (
                      <TaskInlineNote label="异常" value={selectedTask.error} className="lg:col-span-4" />
                    )}
                  </div>
                  <div className="rounded-xl border border-border/40 bg-background/30 p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">运行状态</div>
                    <div className="grid gap-2 text-sm text-muted-foreground lg:grid-cols-2">
                      <div>章节：当前 {selectedTask.currentChapterNumber ?? "—"} / 下一 {selectedTask.nextChapterNumber ?? "—"} / 最后 {selectedTask.lastChapterNumber ?? "—"}</div>
                      <div>心跳：{formatTime(selectedTask.lastHeartbeatAt)}</div>
                      <div>停止请求：{formatTime(selectedTask.stopRequestedAt)}</div>
                      <div>重试次数：{selectedTask.retryCount}</div>
                    </div>
                  </div>
                  <div className="rounded-xl border border-border/40 bg-background/30 p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">时间信息</div>
                    <div className="grid gap-2 text-sm text-muted-foreground lg:grid-cols-2">
                      <div>总时长：{formatDuration(elapsedFrom(resolveTaskStartAt(selectedTask), resolveTaskEndAt(selectedTask), nowTick))}</div>
                      <div>单章时长：{formatDuration(elapsedFrom(resolveTaskChapterStartAt(selectedTask), selectedTask.chapterFinishedAt ?? resolveTaskEndAt(selectedTask), nowTick, resolveTaskStartAt(selectedTask)))}</div>
                      <div>阶段更新距今：{formatDuration(elapsedFrom(resolveTaskUpdateAt(selectedTask), null, nowTick, selectedTask.updatedAt))}</div>
                      <div>审计耗时：{formatDuration(selectedTaskStageDurations?.auditMs ?? 0)}</div>
                      <div>修订耗时：{formatDuration(selectedTaskStageDurations?.reviseMs ?? 0)}</div>
                      <div>保存耗时：{formatDuration(selectedTaskStageDurations?.savingMs ?? 0)}</div>
                    </div>
                  </div>
                  <TaskPerformanceBreakdown task={selectedTask} />
                  <TaskMetricsSummary task={selectedTask} nowTick={nowTick} tokenSamples={selectedTaskTokenSamples} />
                </div>

                <TaskRuntimeControls
                  groupedModels={groupedModels}
                  selectedModel={selectedTask.options.model}
                  selectedService={selectedTask.options.service}
                  quickMode={selectedTask.options.quickMode}
                  hideQuickMode={selectedTask.type === "audit"}
                  editable={canEditTaskRuntimeSettings(selectedTask.status) && updatingTaskKey !== taskKey(selectedTask)}
                  inline
                  onModelChange={(model, service) => {
                    void handleUpdateTaskSettings(selectedTask, { model, service });
                  }}
                  onQuickModeChange={(next) => {
                    void handleUpdateTaskSettings(selectedTask, { quickMode: next });
                  }}
                  onManageModels={nav.toServices}
                  className="mt-4 rounded-xl border border-border/40 bg-background/35 p-3"
                  label="运行配置"
                />

                <TaskStateLegend task={selectedTask} className="mt-4" />

                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">当前章节轨迹</span>
                    <span>第 {selectedTask.currentChapterNumber ?? "?"} 章</span>
                  </div>
                  <div className="rounded-xl border border-border/40 bg-background/30 p-2">
                    <div className="space-y-2">
                    {selectedTaskTimeline.map((step, index) => (
                      <div key={`${step.stage}-${step.startedAt ?? index}`} className="flex gap-2">
                        <div className="flex w-4 flex-col items-center pt-1">
                          <span className={cn("h-2 w-2 rounded-full", step.isCurrent ? "bg-primary" : "bg-border")} />
                          {index < selectedTaskTimeline.length - 1 ? <span className="mt-1 w-px flex-1 bg-border/60" /> : null}
                        </div>
                        <div className={cn("min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-xs", step.isCurrent ? "border-primary/30 bg-primary/5" : "border-border/30 bg-card/60")}>
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 truncate font-medium text-foreground">#{step.order} · {taskStageGroup(step.stage)}</span>
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
                    ))}
                    {selectedTaskTimeline.length === 0 ? <div className="px-1 py-2 text-xs text-muted-foreground">暂无阶段轨迹</div> : null}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {canCancelRetryWaitingTask(selectedTask.status) && (
                    <button onClick={() => void handleCancel(selectedTask)} className="inline-flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-sm hover:bg-secondary/50">
                      <XCircle size={14} /> {getCancelTaskActionLabel()}
                    </button>
                  )}
                  {canRetryTask(selectedTask.status) && (
                    <button onClick={() => void handleRetry(selectedTask)} className="inline-flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-sm hover:bg-secondary/50">
                      <Play size={14} /> {getRetryActionLabel()}
                    </button>
                  )}
                  {canToggleAutoRetry(selectedTask.status) && (
                    <button
                      onClick={() => void handlePatch(selectedTask)}
                      className="inline-flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-sm hover:bg-secondary/50"
                    >
                      <RefreshCw size={14} /> {getAutoRetryToggleLabel(selectedTask)}
                    </button>
                  )}
                  {canStopTask(selectedTask.status) && (
                    <button onClick={() => void handleStop(selectedTask)} className="inline-flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-sm hover:bg-secondary/50">
                      <Square size={14} /> 停止
                    </button>
                  )}
                  {canResumeTask(selectedTask.status) && (
                    <button
                      onClick={() => void handleResume(selectedTask)}
                      className="inline-flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/15"
                    >
                      <Play size={14} /> {getResumeActionLabel()}
                    </button>
                  )}
                  {canDeleteTask(selectedTask.status) && (
                    <button onClick={() => setDeleteConfirmTask(selectedTask)} className="inline-flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/5">
                      <Trash2 size={14} /> 删除
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-border/40 bg-background/40 p-4">
                <div className="mb-2 text-xs font-medium text-muted-foreground">按阶段分组日志</div>
                <div className="max-h-48 space-y-3 overflow-auto text-sm">
                  {selectedTaskLogGroups.length > 0 ? selectedTaskLogGroups.map((group) => (
                    <div key={`${group.stage}::${group.stageLabel ?? ""}::${group.stageDetail ?? ""}`} className="rounded-lg border border-border/30 bg-card/70 p-3">
                      <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                        {taskStageGroup(group.stage)} · {group.stageLabel ?? group.stage}
                        {group.stageDetail ? ` · ${group.stageDetail}` : ""}
                      </div>
                      <div className="space-y-2">
                        {group.logs.map((log, index) => (
                          <div key={`${log.timestamp}-${index}`} className="text-muted-foreground">
                            <span className="mr-2 text-xs">{formatTime(log.timestamp)}</span>
                            <span className="mr-2 uppercase">{log.level}</span>
                            <span>{log.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )) : <div className="text-muted-foreground">无</div>}
                </div>
              </div>

              <div className="rounded-xl border border-border/40 bg-background/40 p-4">
                <div className="mb-2 text-xs font-medium text-muted-foreground">异常日志</div>
                <div className="max-h-48 space-y-2 overflow-auto text-sm">
                  {(selectedTask.exceptionLogs ?? []).length > 0 ? selectedTask.exceptionLogs.map((log, index) => (
                    <div key={`${log.timestamp}-${index}`} className="text-destructive/90">
                      <span className="mr-2 text-xs">{formatTime(log.timestamp)}</span>
                      <span className="mr-2 uppercase">{log.level}</span>
                      <span>{log.message}</span>
                    </div>
                  )) : <div className="text-muted-foreground">无</div>}
                </div>
              </div>

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
          void handleDelete(deleteConfirmTask);
        }}
        onCancel={() => setDeleteConfirmTask(null)}
      />

      <ConfirmDialog
        open={bulkDeleteConfirmOpen}
        title="批量删除任务"
        message={`确认删除已选中的 ${selectedVisibleTasks.filter((task) => canDeleteTask(task.status)).length} 个任务吗？删除后无法恢复。`}
        confirmLabel="删除选中"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => { void handleBulkDelete(); }}
        onCancel={() => setBulkDeleteConfirmOpen(false)}
      />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-card/70 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{typeof value === "number" ? value.toLocaleString() : value}</div>
    </div>
  );
}
