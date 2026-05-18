import type { PipelineConfig, ProjectConfig, StateManager } from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import type { BookTask, BookTaskCreatePayload, BookTaskStatus, RunLogEntry } from "../../shared/contracts.js";
import { BookTaskStore } from "./book-task-store.js";

type Broadcast = (event: string, data: unknown) => void;

type ResolveRuntimeSelection = (args: {
  readonly currentConfig: ProjectConfig;
  readonly selectedService?: string;
  readonly selectedModel?: string;
}) => Promise<{ client?: unknown; model?: string; error?: string }>;

type PipelineFactory = (config: PipelineConfig) => {
  writeNextChapter: (
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    options?: { quickMode?: boolean },
  ) => Promise<unknown>;
};

export interface BookTaskControllerDeps {
  readonly state: StateManager;
  readonly loadCurrentProjectConfig: () => Promise<ProjectConfig>;
  readonly buildPipelineConfig: (overrides?: Partial<Pick<PipelineConfig, "externalContext" | "client" | "model" | "defaultWriteNextQuickMode" | "writeStageHeartbeatMs">> & { readonly currentConfig?: ProjectConfig }) => Promise<PipelineConfig>;
  readonly resolvePipelineClientFromSelection: ResolveRuntimeSelection;
  readonly createPipeline: PipelineFactory;
  readonly broadcast: Broadcast;
  readonly resolveWriteStageHeartbeatMs: () => number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeChapterCount(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.round(numeric));
}

function summarizeTask(task: BookTask): Partial<BookTask> {
  return {
    id: task.id,
    bookId: task.bookId,
    type: task.type,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    stopRequestedAt: task.stopRequestedAt,
    stoppedAt: task.stoppedAt,
    requestedChapters: task.requestedChapters,
    completedChapters: task.completedChapters,
    currentChapterNumber: task.currentChapterNumber,
    nextChapterNumber: task.nextChapterNumber,
    lastChapterNumber: task.lastChapterNumber,
    options: task.options,
    result: task.result,
    error: task.error,
  };
}

function isTerminalTaskStatus(status: BookTaskStatus): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded";
}

function isFatalWriteResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const payload = result as { status?: unknown; error?: unknown };
  const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  if (/failed|error/.test(status)) return true;
  return typeof payload.error === "string" && payload.error.trim().length > 0;
}

export class BookTaskController {
  private readonly store: BookTaskStore;
  private readonly runningTaskIds = new Set<string>();

  constructor(private readonly deps: BookTaskControllerDeps) {
    this.store = new BookTaskStore(deps.state);
  }

  async list(bookId: string): Promise<ReadonlyArray<BookTask>> {
    return this.store.list(bookId);
  }

  async get(bookId: string, taskId: string): Promise<BookTask | null> {
    return this.store.get(bookId, taskId);
  }

  async create(bookId: string, payload: BookTaskCreatePayload): Promise<BookTask> {
    const active = await this.store.findActive(bookId);
    if (active) {
      throw new ApiError(409, "BOOK_TASK_ACTIVE", `Book "${bookId}" already has an active task "${active.title}".`);
    }

    const currentConfig = await this.deps.loadCurrentProjectConfig();
    const book = await this.deps.state.loadBookConfig(bookId);
    const nextChapter = await this.deps.state.getNextChapterNumber(bookId);
    const defaultRequested = Math.max(1, (Number(book.targetChapters ?? 0) || nextChapter) - nextChapter + 1);
    const requestedChapters = normalizeChapterCount(payload.requestedChapters, defaultRequested);
    const title = typeof payload.requestedChapters === "number" && Number.isFinite(payload.requestedChapters)
      ? `连续写作 ${requestedChapters} 章`
      : "自动写作至目标章节";

    const task = await this.store.create(bookId, {
      ...payload,
      requestedChapters,
      title,
    });

    await this.appendTaskEvent("book-task:created", task);
    void this.runTask(bookId, task.id, currentConfig);
    return task;
  }

  async stop(bookId: string, taskId: string): Promise<BookTask> {
    const task = await this.requireTask(bookId, taskId);
    if (isTerminalTaskStatus(task.status)) return task;

    if (task.status === "queued" || task.status === "paused") {
      const stopped = await this.store.setStatus(bookId, taskId, "cancelled", {
        stopRequestedAt: nowIso(),
        stoppedAt: nowIso(),
        finishedAt: nowIso(),
        result: { cancelled: true, reason: "stopped before start" },
      });
      await this.appendTaskEvent("book-task:complete", stopped);
      return stopped;
    }

    const stopping = await this.store.setStatus(bookId, taskId, "stopping", {
      stopRequestedAt: nowIso(),
    });
    await this.appendTaskEvent("book-task:update", stopping);
    await this.appendTaskEvent("book-task:stop", stopping);
    return stopping;
  }

  async resume(bookId: string, taskId: string, currentConfig?: ProjectConfig): Promise<BookTask> {
    const task = await this.requireTask(bookId, taskId);
    if (task.status !== "paused") {
      throw new ApiError(409, "BOOK_TASK_NOT_PAUSED", `Task "${taskId}" is not paused.`);
    }

    const config = currentConfig ?? await this.deps.loadCurrentProjectConfig();
    const resumed = await this.store.setStatus(bookId, taskId, "queued", {
      error: null,
      stopRequestedAt: null,
      stoppedAt: null,
    });
    await this.appendTaskEvent("book-task:resume", resumed);
    void this.runTask(bookId, taskId, config);
    return resumed;
  }

  async recoverPendingTasks(bookId: string, currentConfig: ProjectConfig): Promise<void> {
    const tasks = await this.store.list(bookId);
    for (const task of tasks) {
      if (this.runningTaskIds.has(task.id)) continue;
      if (task.status === "queued") {
        void this.runTask(bookId, task.id, currentConfig);
        continue;
      }
      if (task.status === "running" || task.status === "stopping") {
        const paused = await this.store.setStatus(bookId, task.id, "paused", {
          error: "服务器重启后任务已暂停，请手动继续。",
        });
        await this.appendTaskEvent("book-task:update", paused);
        await this.appendTaskLog(paused, "warn", "服务器重启后任务已暂停，请手动继续。");
      }
    }
  }

  private async requireTask(bookId: string, taskId: string): Promise<BookTask> {
    const task = await this.store.get(bookId, taskId);
    if (!task) {
      throw new ApiError(404, "BOOK_TASK_NOT_FOUND", `Task "${taskId}" not found for book "${bookId}".`);
    }
    return task;
  }

  private async appendTaskEvent(event: string, task: BookTask, extra?: Record<string, unknown>): Promise<void> {
    this.deps.broadcast(event, {
      bookId: task.bookId,
      taskId: task.id,
      task: summarizeTask(task),
      ...(extra ?? {}),
    });
  }

  private async appendTaskLog(task: BookTask, level: RunLogEntry["level"], message: string): Promise<BookTask> {
    const log: RunLogEntry = {
      timestamp: nowIso(),
      level,
      message,
    };
    const updated = await this.store.appendLog(task.bookId, task.id, log);
    await this.appendTaskEvent("book-task:log", updated, { log });
    return updated;
  }

  private async runTask(bookId: string, taskId: string, currentConfig: ProjectConfig): Promise<void> {
    if (this.runningTaskIds.has(taskId)) return;
    this.runningTaskIds.add(taskId);
    try {
      let task = await this.requireTask(bookId, taskId);
      if (task.status !== "queued") return;

      task = await this.store.setStatus(bookId, taskId, "running", {
        startedAt: nowIso(),
        updatedAt: nowIso(),
      });
      await this.appendTaskEvent("book-task:update", task);
      await this.appendTaskLog(task, "info", `开始自动写作：${task.requestedChapters} 章。`);

      const selectedRuntime = await this.deps.resolvePipelineClientFromSelection({
        currentConfig,
        selectedService: task.options.service ?? undefined,
        selectedModel: task.options.model ?? undefined,
      });
      if (selectedRuntime.error) {
        throw new Error(selectedRuntime.error);
      }

      const pipeline = this.deps.createPipeline(await this.deps.buildPipelineConfig({
        currentConfig,
        ...(selectedRuntime.client ? { client: selectedRuntime.client as never } : {}),
        ...(selectedRuntime.model ? { model: selectedRuntime.model } : {}),
        writeStageHeartbeatMs: this.deps.resolveWriteStageHeartbeatMs(),
      }));

      let completed = task.completedChapters;
      let latest = task;
      while (completed < task.requestedChapters) {
        latest = await this.requireTask(bookId, taskId);
        if (latest.status === "stopping" || latest.stopRequestedAt) {
          const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
            finishedAt: nowIso(),
            stoppedAt: nowIso(),
            error: null,
            result: {
              cancelled: true,
              completedChapters: completed,
            },
          });
          await this.appendTaskEvent("book-task:complete", cancelled);
          return;
        }

        const nextChapter = await this.deps.state.getNextChapterNumber(bookId);
        latest = await this.store.setStatus(bookId, taskId, "running", {
          currentChapterNumber: nextChapter,
          nextChapterNumber: nextChapter + 1,
        });
        await this.appendTaskEvent("book-task:update", latest);
        await this.appendTaskLog(latest, "info", `开始写作第 ${nextChapter} 章。`);

        const result = await pipeline.writeNextChapter(
          bookId,
          task.options.wordCount ?? undefined,
          undefined,
          { quickMode: task.options.quickMode },
        );

        completed += 1;
        latest = await this.store.setStatus(bookId, taskId, "running", {
          completedChapters: completed,
          currentChapterNumber: typeof result === "object" && result && "chapterNumber" in result
            ? Number((result as { chapterNumber?: unknown }).chapterNumber) || nextChapter
            : nextChapter,
          lastChapterNumber: typeof result === "object" && result && "chapterNumber" in result
            ? Number((result as { chapterNumber?: unknown }).chapterNumber) || nextChapter
            : nextChapter,
          nextChapterNumber: nextChapter + 1,
        });
        await this.appendTaskEvent("book-task:update", latest);
        await this.appendTaskLog(latest, "info", `第 ${nextChapter} 章完成。`);

        if (isFatalWriteResult(result)) {
          throw new Error(`章节 ${nextChapter} 写作失败。`);
        }

        const refreshed = await this.requireTask(bookId, taskId);
        if (refreshed.status === "stopping" || refreshed.stopRequestedAt) {
          const cancelled = await this.store.setStatus(bookId, taskId, "cancelled", {
            finishedAt: nowIso(),
            stoppedAt: nowIso(),
            error: null,
            result: {
              cancelled: true,
              completedChapters: completed,
              lastChapterNumber: latest.lastChapterNumber,
            },
          });
          await this.appendTaskEvent("book-task:complete", cancelled);
          return;
        }
      }

      const finalTask = await this.store.setStatus(bookId, taskId, "succeeded", {
        finishedAt: nowIso(),
        result: {
          completedChapters: completed,
          lastChapterNumber: latest.lastChapterNumber,
        },
        error: null,
      });
      await this.appendTaskEvent("book-task:complete", finalTask);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.store.setStatus(bookId, taskId, "failed", {
        finishedAt: nowIso(),
        error: message,
        result: null,
      }).catch(() => null);
      if (failed) {
        await this.appendTaskEvent("book-task:error", failed);
      }
    } finally {
      this.runningTaskIds.delete(taskId);
    }
  }
}
