import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateManager } from "@actalk/inkos-core";
import type { BookTask, BookTaskCreatePayload, BookTaskStatus, RunLogEntry } from "../../shared/contracts.js";

const MAX_TASK_LOGS = 100;

interface BookTaskStateFile {
  readonly updatedAt: string;
  readonly tasks: ReadonlyArray<BookTask>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sortTasks(tasks: ReadonlyArray<BookTask>): BookTask[] {
  return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function normalizeTask(task: BookTask): BookTask {
  return {
    ...task,
    logs: [...task.logs].slice(-MAX_TASK_LOGS),
  };
}

export class BookTaskStore {
  constructor(private readonly state: StateManager) {}

  private filePath(bookId: string): string {
    return join(this.state.stateDir(bookId), "book-tasks.json");
  }

  private async ensureDirectory(bookId: string): Promise<void> {
    await mkdir(this.state.stateDir(bookId), { recursive: true });
  }

  private async readFile(bookId: string): Promise<BookTaskStateFile> {
    await this.ensureDirectory(bookId);
    try {
      const raw = await readFile(this.filePath(bookId), "utf-8");
      const parsed = JSON.parse(raw) as Partial<BookTaskStateFile>;
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map((task) => normalizeTask(task as BookTask)) : [];
      return {
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
        tasks: sortTasks(tasks),
      };
    } catch {
      return { updatedAt: nowIso(), tasks: [] };
    }
  }

  private async writeFile(bookId: string, file: BookTaskStateFile): Promise<void> {
    await this.ensureDirectory(bookId);
    await writeFile(this.filePath(bookId), JSON.stringify(file, null, 2), "utf-8");
  }

  async list(bookId: string): Promise<ReadonlyArray<BookTask>> {
    return (await this.readFile(bookId)).tasks;
  }

  async get(bookId: string, taskId: string): Promise<BookTask | null> {
    const file = await this.readFile(bookId);
    return file.tasks.find((task) => task.id === taskId) ?? null;
  }

  async findActive(bookId: string): Promise<BookTask | null> {
    const file = await this.readFile(bookId);
    return file.tasks.find((task) => task.status === "queued" || task.status === "running" || task.status === "stopping" || task.status === "paused") ?? null;
  }

  async create(
    bookId: string,
    input: BookTaskCreatePayload & {
      readonly requestedChapters: number;
      readonly title: string;
    },
  ): Promise<BookTask> {
    const file = await this.readFile(bookId);
    const now = nowIso();
    const task: BookTask = normalizeTask({
      id: randomUUID(),
      bookId,
      type: "auto-write",
      title: input.title,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      stopRequestedAt: null,
      stoppedAt: null,
      requestedChapters: input.requestedChapters,
      completedChapters: 0,
      currentChapterNumber: null,
      nextChapterNumber: null,
      lastChapterNumber: null,
      options: {
        wordCount: typeof input.wordCount === "number" && Number.isFinite(input.wordCount) ? Math.max(1, Math.round(input.wordCount)) : null,
        quickMode: input.quickMode ?? false,
        preferFastWriterModel: input.preferFastWriterModel ?? true,
        service: typeof input.service === "string" && input.service.trim() ? input.service.trim() : null,
        model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : null,
      },
      logs: [],
      result: null,
      error: null,
    });

    const next: BookTaskStateFile = {
      updatedAt: now,
      tasks: sortTasks([task, ...file.tasks]),
    };
    await this.writeFile(bookId, next);
    return task;
  }

  async update(
    bookId: string,
    taskId: string,
    updater: (task: BookTask) => BookTask,
  ): Promise<BookTask> {
    const file = await this.readFile(bookId);
    let updated: BookTask | null = null;
    const tasks = file.tasks.map((task) => {
      if (task.id !== taskId) return task;
      updated = normalizeTask(updater(task));
      return updated;
    });

    if (!updated) {
      throw new Error(`Task ${taskId} not found for book "${bookId}".`);
    }

    await this.writeFile(bookId, {
      updatedAt: nowIso(),
      tasks: sortTasks(tasks),
    });
    return updated;
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
    }));
  }

  async appendLog(bookId: string, taskId: string, log: RunLogEntry): Promise<BookTask> {
    return this.update(bookId, taskId, (task) => normalizeTask({
      ...task,
      logs: [...task.logs, log].slice(-MAX_TASK_LOGS),
    }));
  }
}
