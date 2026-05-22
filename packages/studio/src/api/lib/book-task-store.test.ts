import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "@actalk/inkos-core";
import { BookTaskStore } from "./book-task-store.js";

describe("BookTaskStore", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = null;
    }
  });

  it("loads legacy task files into a project-level cache and persists to the root file", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-task-store-"));
    await mkdir(join(root, "books", "demo-book", "story", "state"), { recursive: true });
    await writeFile(join(root, "books", "demo-book", "book.json"), JSON.stringify({ id: "demo-book", title: "Demo Book" }), "utf-8");
    await writeFile(join(root, "books", "demo-book", "story", "state", "book-tasks.json"), JSON.stringify({
      updatedAt: "2026-05-20T00:00:00.000Z",
      tasks: [
        {
          id: "task-legacy",
          bookId: "demo-book",
          type: "write",
          title: "Legacy task",
          status: "queued",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          stopRequestedAt: null,
          stoppedAt: null,
          requestedChapters: 1,
          completedChapters: 0,
          currentChapterNumber: null,
          nextChapterNumber: null,
          lastChapterNumber: null,
          retryCount: 0,
          maxRetryAttempts: 0,
          retryEnabled: true,
          retryAt: null,
          writtenChapters: 0,
          writtenWords: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          lastErrorType: null,
          lastErrorCode: null,
          lastErrorStage: null,
          options: {
            wordCount: null,
            quickMode: false,
            preferFastWriterModel: true,
            service: null,
            model: null,
          },
          logs: [],
          exceptionLogs: [],
          result: null,
          error: null,
          stage: "queued",
          stageLabel: "排队中",
          stageDetail: "等待调度执行",
          stageStartedAt: "2026-05-20T00:00:00.000Z",
          stageUpdatedAt: "2026-05-20T00:00:00.000Z",
          lastHeartbeatAt: null,
          chapterStartedAt: null,
          chapterFinishedAt: null,
        },
      ],
    }, null, 2), "utf-8");

    const store = new BookTaskStore(new StateManager(root));

    const tasks = await store.list("demo-book");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("task-legacy");

    const persisted = JSON.parse(await readFile(join(root, "book-tasks.json"), "utf-8")) as {
      tasks: Array<{ id: string; bookId: string }>;
    };
    expect(persisted.tasks).toHaveLength(1);
    expect(persisted.tasks[0]).toMatchObject({
      id: "task-legacy",
      bookId: "demo-book",
    });

    await store.deleteBook("demo-book");
    expect(await store.list("demo-book")).toEqual([]);
  });

  it("waits for a cross-process project lock before writing task changes", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-task-lock-"));
    await mkdir(join(root, "books", "demo-book", "story", "state"), { recursive: true });
    await writeFile(join(root, "books", "demo-book", "book.json"), JSON.stringify({ id: "demo-book", title: "Demo Book" }), "utf-8");

    const state = new StateManager(root);
    const firstStore = new BookTaskStore(state);
    const task = await firstStore.create("demo-book", {
      requestedChapters: 1,
      title: "Test",
      type: "write",
    });

    const secondStore = new BookTaskStore(state);
    const blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve) => blocker.once("spawn", resolve));
    await writeFile(join(root, "book-tasks.lock"), `pid:${blocker.pid} ts:${Date.now()}`, "utf-8");

    const started = Date.now();
    let settled = false;
    const updatedPromise = secondStore.update("demo-book", task.id, (current) => ({
      ...current,
      error: "updated",
    })).then((value) => {
      settled = true;
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    blocker.kill();
    await new Promise((resolve) => blocker.once("close", resolve));
    const updated = await updatedPromise;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(updated.error).toBe("updated");
  });

  it("treats an old lock file as stale and continues writing", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-task-lock-stale-"));
    await mkdir(join(root, "books", "demo-book", "story", "state"), { recursive: true });
    await writeFile(join(root, "books", "demo-book", "book.json"), JSON.stringify({ id: "demo-book", title: "Demo Book" }), "utf-8");
    await writeFile(join(root, "book-tasks.lock"), `pid:999999 ts:${Date.now() - (11 * 60 * 1000)}`, "utf-8");

    const store = new BookTaskStore(new StateManager(root));
    const task = await store.create("demo-book", {
      requestedChapters: 1,
      title: "Test",
      type: "write",
    });

    expect(task.bookId).toBe("demo-book");
    await expect(readFile(join(root, "book-tasks.lock"), "utf-8")).rejects.toThrow();
  });

  it("persists audit chapter range fields", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-task-audit-range-"));
    await mkdir(join(root, "books", "demo-book", "story", "state"), { recursive: true });
    await writeFile(join(root, "books", "demo-book", "book.json"), JSON.stringify({ id: "demo-book", title: "Demo Book" }), "utf-8");

    const store = new BookTaskStore(new StateManager(root));
    const task = await store.create("demo-book", {
      requestedChapters: 5,
      auditChapterStart: 12,
      auditChapterEnd: 18,
      title: "Audit range",
      type: "audit",
    });

    expect(task.auditChapterStart).toBe(12);
    expect(task.auditChapterEnd).toBe(18);

    const persisted = JSON.parse(await readFile(join(root, "book-tasks.json"), "utf-8")) as {
      tasks: Array<{ auditChapterStart?: number | null; auditChapterEnd?: number | null }>;
    };
    expect(persisted.tasks[0]).toMatchObject({
      auditChapterStart: 12,
      auditChapterEnd: 18,
    });
  });
});
