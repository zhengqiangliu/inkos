import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateManager } from "@actalk/inkos-core";
import type { BookTask, BookTaskCreatePayload, BookTaskStatus, BookTaskType, RunLogEntry } from "../../shared/contracts.js";

const MAX_TASK_LOGS = 100;
const PROJECT_LOCK_STALE_AFTER_MS = 10 * 60 * 1000;

interface BookTaskStateFile {
  readonly updatedAt: string;
  readonly tasks: ReadonlyArray<BookTask>;
}

interface BookTaskCacheMeta {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface StateManagerLike {
  readonly booksDir: string;
  readonly bookDir: (bookId: string) => string;
  readonly stateDir: (bookId: string) => string;
  readonly listBooks?: () => Promise<ReadonlyArray<string>>;
  readonly projectRootDir?: string;
  readonly projectRoot?: string;
}

interface ParsedLockInfo {
  readonly pid?: number;
  readonly ts?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTaskType(type: unknown): BookTaskType {
  return type === "audit" ? "audit" : "write";
}

function zeroUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function defaultStageForStatus(status: BookTaskStatus): string {
  switch (status) {
    case "running": return "write_chapter";
    case "retry_waiting": return "retry_waiting";
    case "stopping": return "stopping";
    case "paused": return "paused";
    case "failed": return "failed";
    case "succeeded": return "succeeded";
    case "cancelled": return "cancelled";
    default: return "queued";
  }
}

function defaultStageDetailForStatus(status: BookTaskStatus): string {
  switch (status) {
    case "running": return "正在执行写作流程";
    case "retry_waiting": return "等待自动重试";
    case "stopping": return "正在停止任务";
    case "paused": return "任务已暂停";
    case "failed": return "任务执行失败";
    case "succeeded": return "任务已完成";
    case "cancelled": return "任务已取消";
    default: return "等待调度执行";
  }
}

function defaultStageLabelForStage(stage: string): string {
  switch (stage) {
    case "queued": return "排队中";
    case "prepare": return "准备中";
    case "resolve_model": return "解析模型";
    case "write_chapter": return "写作中";
    case "audit": return "审计中";
    case "revise": return "修订中";
    case "saving_persist": return "落盘中";
    case "saving_truth": return "真相重建";
    case "saving_validate": return "真相校验";
    case "saving_memory": return "记忆同步";
    case "saving_index": return "索引更新";
    case "finalize": return "收尾中";
    case "saving": return "保存中";
    case "retry_waiting": return "等待重试";
    case "stopping": return "停止中";
    case "paused": return "已暂停";
    case "failed": return "失败";
    case "succeeded": return "已完成";
    case "cancelled": return "已取消";
    default: return stage;
  }
}

function normalizeUsage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const payload = value as { promptTokens?: unknown; completionTokens?: unknown; totalTokens?: unknown };
  const promptTokens = Number(payload.promptTokens);
  const completionTokens = Number(payload.completionTokens);
  const totalTokens = Number(payload.totalTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null;
  return {
    promptTokens: Math.max(0, Math.round(promptTokens)),
    completionTokens: Math.max(0, Math.round(completionTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
  };
}

function normalizeLogs(logs: unknown): RunLogEntry[] {
  if (!Array.isArray(logs)) return [];
  return logs.filter((log): log is RunLogEntry => Boolean(log) && typeof log === "object").map((log) => ({
    timestamp: typeof log.timestamp === "string" ? log.timestamp : nowIso(),
    level: log.level === "warn" || log.level === "error" ? log.level : "info",
    message: typeof log.message === "string" ? log.message : String((log as { message?: unknown }).message ?? ""),
  }));
}

function normalizeTask(task: Partial<BookTask>): BookTask {
  const usage = normalizeUsage(task.tokenUsage);
  const auditChapterStart = Number.isFinite(Number(task.auditChapterStart)) ? Math.max(1, Math.round(Number(task.auditChapterStart))) : null;
  const auditChapterEnd = Number.isFinite(Number(task.auditChapterEnd)) ? Math.max(1, Math.round(Number(task.auditChapterEnd))) : null;
  return {
    id: typeof task.id === "string" ? task.id : randomUUID(),
    bookId: typeof task.bookId === "string" ? task.bookId : "",
    type: normalizeTaskType(task.type),
    source: task.source === "task-center" ? "task-center" : "book-detail",
    title: typeof task.title === "string" ? task.title : "自动任务",
    status: task.status === "queued" || task.status === "running" || task.status === "paused" || task.status === "stopping" || task.status === "retry_waiting" || task.status === "cancelled" || task.status === "failed" || task.status === "succeeded"
      ? task.status
      : "queued",
    stage: typeof task.stage === "string" && task.stage.trim() ? task.stage.trim() : defaultStageForStatus(task.status as BookTaskStatus),
    stageLabel: typeof task.stageLabel === "string" && task.stageLabel.trim() ? task.stageLabel.trim() : defaultStageLabelForStage(typeof task.stage === "string" && task.stage.trim() ? task.stage.trim() : defaultStageForStatus(task.status as BookTaskStatus)),
    stageDetail: typeof task.stageDetail === "string" && task.stageDetail.trim() ? task.stageDetail.trim() : defaultStageDetailForStatus(task.status as BookTaskStatus),
    stageStartedAt: typeof task.stageStartedAt === "string" || task.stageStartedAt === null ? task.stageStartedAt ?? null : null,
    stageUpdatedAt: typeof task.stageUpdatedAt === "string" || task.stageUpdatedAt === null ? task.stageUpdatedAt ?? null : null,
    lastHeartbeatAt: typeof task.lastHeartbeatAt === "string" || task.lastHeartbeatAt === null ? task.lastHeartbeatAt ?? null : null,
    chapterStartedAt: typeof task.chapterStartedAt === "string" || task.chapterStartedAt === null ? task.chapterStartedAt ?? null : null,
    chapterFinishedAt: typeof task.chapterFinishedAt === "string" || task.chapterFinishedAt === null ? task.chapterFinishedAt ?? null : null,
    createdAt: typeof task.createdAt === "string" ? task.createdAt : nowIso(),
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : nowIso(),
    startedAt: typeof task.startedAt === "string" || task.startedAt === null ? task.startedAt ?? null : null,
    finishedAt: typeof task.finishedAt === "string" || task.finishedAt === null ? task.finishedAt ?? null : null,
    stopRequestedAt: typeof task.stopRequestedAt === "string" || task.stopRequestedAt === null ? task.stopRequestedAt ?? null : null,
    stoppedAt: typeof task.stoppedAt === "string" || task.stoppedAt === null ? task.stoppedAt ?? null : null,
    requestedChapters: Number.isFinite(Number(task.requestedChapters)) ? Math.max(1, Math.round(Number(task.requestedChapters))) : 1,
    auditChapterStart,
    auditChapterEnd,
    completedChapters: Number.isFinite(Number(task.completedChapters)) ? Math.max(0, Math.round(Number(task.completedChapters))) : 0,
    currentChapterNumber: Number.isFinite(Number(task.currentChapterNumber)) ? Math.max(1, Math.round(Number(task.currentChapterNumber))) : null,
    nextChapterNumber: Number.isFinite(Number(task.nextChapterNumber)) ? Math.max(1, Math.round(Number(task.nextChapterNumber))) : null,
    lastChapterNumber: Number.isFinite(Number(task.lastChapterNumber)) ? Math.max(1, Math.round(Number(task.lastChapterNumber))) : null,
    retryCount: Number.isFinite(Number(task.retryCount)) ? Math.max(0, Math.round(Number(task.retryCount))) : 0,
    maxRetryAttempts: Number.isFinite(Number(task.maxRetryAttempts)) ? Math.max(0, Math.round(Number(task.maxRetryAttempts))) : 0,
    retryEnabled: task.retryEnabled !== false,
    retryAt: typeof task.retryAt === "string" || task.retryAt === null ? task.retryAt ?? null : null,
    writtenChapters: Number.isFinite(Number(task.writtenChapters)) ? Math.max(0, Math.round(Number(task.writtenChapters))) : Number.isFinite(Number(task.completedChapters)) ? Math.max(0, Math.round(Number(task.completedChapters))) : 0,
    writtenWords: Number.isFinite(Number(task.writtenWords)) ? Math.max(0, Math.round(Number(task.writtenWords))) : 0,
    tokenUsage: usage,
    lastErrorType: typeof task.lastErrorType === "string" || task.lastErrorType === null ? task.lastErrorType ?? null : null,
    lastErrorCode: typeof task.lastErrorCode === "string" || task.lastErrorCode === null ? task.lastErrorCode ?? null : null,
    lastErrorStage: typeof task.lastErrorStage === "string" || task.lastErrorStage === null ? task.lastErrorStage ?? null : null,
    options: {
      wordCount: task.options && Number.isFinite(Number(task.options.wordCount)) ? Math.max(1, Math.round(Number(task.options.wordCount))) : null,
      quickMode: task.options?.quickMode ?? false,
      preferFastWriterModel: task.options?.preferFastWriterModel ?? true,
      service: typeof task.options?.service === "string" && task.options.service.trim() ? task.options.service.trim() : null,
      model: typeof task.options?.model === "string" && task.options.model.trim() ? task.options.model.trim() : null,
    },
    logs: normalizeLogs(task.logs).slice(-MAX_TASK_LOGS),
    exceptionLogs: normalizeLogs(task.exceptionLogs).slice(-MAX_TASK_LOGS),
    result: task.result ?? null,
    error: typeof task.error === "string" ? task.error : null,
  };
}

function sortTasks(tasks: ReadonlyArray<BookTask>): BookTask[] {
  return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function taskKey(task: Pick<BookTask, "bookId" | "id">): string {
  return `${task.bookId}:${task.id}`;
}

export class BookTaskStore {
  private cachedState: BookTaskStateFile | null = null;
  private cachedMeta: BookTaskCacheMeta | null = null;
  private loadPromise: Promise<BookTaskStateFile> | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private readonly activeLocks = new Set<string>();

  constructor(private readonly state: StateManager) {}

  private resolveProjectRoot(bookId?: string): string | null {
    const state = this.state as unknown as StateManagerLike;
    if (typeof state.projectRootDir === "string" && state.projectRootDir) return state.projectRootDir;
    if (typeof state.projectRoot === "string" && state.projectRoot) return state.projectRoot;
    if (typeof state.booksDir === "string" && state.booksDir) return join(state.booksDir, "..");
    if (bookId && typeof state.bookDir === "function") return join(state.bookDir(bookId), "..", "..");
    if (bookId && typeof state.stateDir === "function") return join(state.stateDir(bookId), "..", "..", "..", "..");
    return null;
  }

  private projectFilePath(bookId?: string): string {
    const projectRoot = this.resolveProjectRoot(bookId);
    if (!projectRoot) {
      throw new Error("Cannot resolve project root for book task storage.");
    }
    return join(projectRoot, "book-tasks.json");
  }

  private projectLockPath(bookId?: string): string {
    const projectRoot = this.resolveProjectRoot(bookId);
    if (!projectRoot) {
      throw new Error("Cannot resolve project root for book task locking.");
    }
    return join(projectRoot, "book-tasks.lock");
  }

  private legacyFilePath(bookId: string): string {
    return join((this.state as unknown as StateManagerLike).stateDir(bookId), "book-tasks.json");
  }

  private async readStateFile(filePath: string): Promise<BookTaskStateFile | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw) as Partial<BookTaskStateFile>;
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map((task) => normalizeTask(task as Partial<BookTask>)) : [];
      return {
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
        tasks: sortTasks(tasks),
      };
    } catch {
      return null;
    }
  }

  private async readFileMeta(filePath: string): Promise<BookTaskCacheMeta | null> {
    try {
      const fileStat = await stat(filePath);
      return {
        path: filePath,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      };
    } catch {
      return null;
    }
  }

  private sameMeta(a: BookTaskCacheMeta | null, b: BookTaskCacheMeta | null): boolean {
    if (!a || !b) return false;
    return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
  }

  private extractLockPid(lockData: string): number | undefined {
    const match = lockData.match(/pid:(\d+)/);
    if (!match) return undefined;
    const pid = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  private extractLockTs(lockData: string): number | undefined {
    const match = lockData.match(/ts:(\d+)/);
    if (!match) return undefined;
    const ts = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(ts) && ts > 0 ? ts : undefined;
  }

  private parseLockInfo(lockData: string): ParsedLockInfo {
    return {
      pid: this.extractLockPid(lockData),
      ts: this.extractLockTs(lockData),
    };
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") {
        return false;
      }
      return true;
    }
  }

  private async acquireProjectLock(bookId?: string): Promise<() => Promise<void>> {
    const projectRoot = this.resolveProjectRoot(bookId);
    if (!projectRoot) {
      throw new Error("Cannot resolve project root for book task locking.");
    }

    const lockPath = this.projectLockPath(bookId);
    await mkdir(projectRoot, { recursive: true });
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(`pid:${process.pid} ts:${Date.now()}`, "utf-8");
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        await handle.close();
        this.activeLocks.add(projectRoot);
        return async () => {
          this.activeLocks.delete(projectRoot);
          await unlink(lockPath).catch(() => undefined);
        };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "EEXIST") {
          throw e;
        }

        const lockData = await readFile(lockPath, "utf-8").catch(() => "pid:unknown ts:unknown");
        const lockInfo = this.parseLockInfo(lockData);
        const lockAge = lockInfo.ts !== undefined ? Date.now() - lockInfo.ts : undefined;
        const isStale =
          (lockInfo.pid !== undefined && !this.isProcessAlive(lockInfo.pid)) ||
          (lockInfo.pid === process.pid && !this.activeLocks.has(projectRoot)) ||
          (lockAge !== undefined && lockAge > PROJECT_LOCK_STALE_AFTER_MS);
        if (isStale) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private async loadLegacyState(bookId?: string): Promise<BookTaskStateFile | null> {
    const state = this.state as unknown as StateManagerLike;
    const bookIds = typeof state.listBooks === "function"
      ? await state.listBooks()
      : bookId
        ? [bookId]
        : [];
    const taskMap = new Map<string, BookTask>();

    for (const bookId of bookIds) {
      const file = await this.readStateFile(this.legacyFilePath(bookId));
      if (!file) continue;
      for (const task of file.tasks) {
        taskMap.set(taskKey(task), task);
      }
    }

    if (taskMap.size === 0) return null;
    return {
      updatedAt: nowIso(),
      tasks: sortTasks([...taskMap.values()]),
    };
  }

  private async persistState(state: BookTaskStateFile, bookId?: string): Promise<void> {
    const filePath = this.projectFilePath(bookId);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({
      updatedAt: state.updatedAt,
      tasks: sortTasks(state.tasks),
    }, null, 2);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(tempPath, payload, "utf-8");
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async loadStateFromDisk(bookId?: string): Promise<BookTaskStateFile> {
    const projectPath = this.projectFilePath(bookId);
    const projectFile = await this.readStateFile(projectPath);
    if (projectFile) {
      this.cachedMeta = await this.readFileMeta(projectPath);
      return projectFile;
    }

    const legacyState = await this.loadLegacyState(bookId);
    if (legacyState) {
      await this.persistState(legacyState, bookId);
      return legacyState;
    }

    return {
      updatedAt: nowIso(),
      tasks: [],
    };
  }

  private async ensureLoaded(bookId?: string): Promise<BookTaskStateFile> {
    const filePath = this.projectFilePath(bookId);
    const meta = await this.readFileMeta(filePath);
    if (this.cachedState && this.sameMeta(this.cachedMeta, meta)) return this.cachedState;
    if (!this.loadPromise) {
      this.loadPromise = this.loadStateFromDisk(bookId)
        .then((state) => {
          this.cachedState = state;
          return state;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    return this.loadPromise;
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(work, work);
    this.operationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async replaceState(next: BookTaskStateFile, bookId?: string): Promise<void> {
    this.cachedState = next;
    await this.persistState(next, bookId);
    this.cachedMeta = await this.readFileMeta(this.projectFilePath(bookId));
  }

  private async withProjectLock<T>(bookId: string, work: () => Promise<T>): Promise<T> {
    const release = await this.acquireProjectLock(bookId);
    try {
      return await work();
    } finally {
      await release();
    }
  }

  async list(bookId: string): Promise<ReadonlyArray<BookTask>> {
    return this.runExclusive(async () => {
      const file = await this.ensureLoaded(bookId);
      return file.tasks.filter((task) => task.bookId === bookId);
    });
  }

  async get(bookId: string, taskId: string): Promise<BookTask | null> {
    return this.runExclusive(async () => {
      const file = await this.ensureLoaded(bookId);
      return file.tasks.find((task) => task.bookId === bookId && task.id === taskId) ?? null;
    });
  }

  async findActive(bookId: string): Promise<BookTask | null> {
    return this.runExclusive(async () => {
      const file = await this.ensureLoaded(bookId);
      return file.tasks.find((task) =>
        task.bookId === bookId
        && (task.status === "queued" || task.status === "running" || task.status === "stopping" || task.status === "paused" || task.status === "retry_waiting")) ?? null;
    });
  }

  async create(
    bookId: string,
    input: BookTaskCreatePayload & {
      readonly requestedChapters: number;
      readonly auditChapterStart?: number | null | undefined;
      readonly auditChapterEnd?: number | null | undefined;
      readonly title: string;
    },
  ): Promise<BookTask> {
    return this.runExclusive(async () => {
      return this.withProjectLock(bookId, async () => {
        const file = await this.loadStateFromDisk(bookId);
        const active = file.tasks.find((task) => task.bookId === bookId && (task.status === "queued" || task.status === "running" || task.status === "stopping" || task.status === "paused" || task.status === "retry_waiting"));
        if (active) {
          throw new Error(`Book "${bookId}" already has an active task "${active.title}".`);
        }

        const now = nowIso();
        const type = normalizeTaskType(input.type);
        const task: BookTask = normalizeTask({
          id: randomUUID(),
          bookId,
          type,
          source: input.source === "task-center" ? "task-center" : "book-detail",
          title: input.title,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
          stopRequestedAt: null,
          stoppedAt: null,
          stage: "queued",
          stageLabel: "排队中",
          stageDetail: "等待调度执行",
          stageStartedAt: now,
          stageUpdatedAt: now,
          lastHeartbeatAt: null,
          chapterStartedAt: null,
          chapterFinishedAt: null,
          requestedChapters: input.requestedChapters,
          auditChapterStart: Number.isFinite(Number(input.auditChapterStart)) ? Math.max(1, Math.round(Number(input.auditChapterStart))) : null,
          auditChapterEnd: Number.isFinite(Number(input.auditChapterEnd)) ? Math.max(1, Math.round(Number(input.auditChapterEnd))) : null,
          completedChapters: 0,
          currentChapterNumber: null,
          nextChapterNumber: null,
          lastChapterNumber: null,
          retryCount: 0,
          maxRetryAttempts: 0,
          retryEnabled: input.retryEnabled ?? true,
          retryAt: null,
          writtenChapters: 0,
          writtenWords: 0,
          tokenUsage: zeroUsage(),
          lastErrorType: null,
          lastErrorCode: null,
          lastErrorStage: null,
          options: {
            wordCount: typeof input.wordCount === "number" && Number.isFinite(input.wordCount) ? Math.max(1, Math.round(input.wordCount)) : null,
            quickMode: input.quickMode ?? false,
            preferFastWriterModel: input.preferFastWriterModel ?? true,
            service: typeof input.service === "string" && input.service.trim() ? input.service.trim() : null,
            model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : null,
          },
          logs: [],
          exceptionLogs: [],
          result: null,
          error: null,
        });

        const next: BookTaskStateFile = {
          updatedAt: now,
          tasks: sortTasks([task, ...file.tasks]),
        };
        await this.replaceState(next, bookId);
        return task;
      });
    });
  }

  async update(
    bookId: string,
    taskId: string,
    updater: (task: BookTask) => BookTask,
  ): Promise<BookTask> {
    return this.runExclusive(async () => {
      return this.withProjectLock(bookId, async () => {
        const file = await this.loadStateFromDisk(bookId);
        let updated: BookTask | null = null;
        const tasks = file.tasks.map((task) => {
          if (task.bookId !== bookId || task.id !== taskId) return task;
          updated = normalizeTask(updater(task));
          return updated;
        });

        if (!updated) {
          throw new Error(`Task ${taskId} not found for book "${bookId}".`);
        }

        await this.replaceState({
          updatedAt: nowIso(),
          tasks: sortTasks(tasks),
        }, bookId);
        return updated;
      });
    });
  }

  async delete(bookId: string, taskId: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.withProjectLock(bookId, async () => {
        const file = await this.loadStateFromDisk(bookId);
        const tasks = file.tasks.filter((task) => !(task.bookId === bookId && task.id === taskId));
        if (tasks.length === file.tasks.length) {
          throw new Error(`Task ${taskId} not found for book "${bookId}".`);
        }
        await this.replaceState({
          updatedAt: nowIso(),
          tasks: sortTasks(tasks),
        }, bookId);
      });
    });
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.withProjectLock(bookId, async () => {
        const file = await this.loadStateFromDisk(bookId);
        const tasks = file.tasks.filter((task) => task.bookId !== bookId);
        if (tasks.length === file.tasks.length) return;
        await this.replaceState({
          updatedAt: nowIso(),
          tasks: sortTasks(tasks),
        }, bookId);
      });
    });
  }

  async setStatus(
    bookId: string,
    taskId: string,
    status: BookTaskStatus,
    patch?: Partial<BookTask>,
  ): Promise<BookTask> {
    return this.update(bookId, taskId, (task) => normalizeTask({
      ...task,
      ...patch,
      status,
      updatedAt: nowIso(),
    }));
  }

  async appendLog(bookId: string, taskId: string, log: RunLogEntry): Promise<BookTask> {
    return this.update(bookId, taskId, (task) => normalizeTask({
      ...task,
      logs: [...task.logs, log].slice(-MAX_TASK_LOGS),
    }));
  }

  async appendExceptionLog(bookId: string, taskId: string, log: RunLogEntry): Promise<BookTask> {
    return this.update(bookId, taskId, (task) => normalizeTask({
      ...task,
      exceptionLogs: [...task.exceptionLogs, log].slice(-MAX_TASK_LOGS),
    }));
  }
}
