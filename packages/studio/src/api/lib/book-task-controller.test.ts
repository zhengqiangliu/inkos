import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "@actalk/inkos-core";
import { BookTaskController } from "./book-task-controller.js";
import { BookTaskStore } from "./book-task-store.js";
import type { BookTask } from "../../shared/contracts.js";

describe("BookTaskController audit gating", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });


  it("allows runtime setting edits after a task is failed or cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const state = {
      stateDir: (id: string) => join(root, "books", id, "story", "state"),
      loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
      loadChapterIndex: async () => [],
      getNextChapterNumber: async () => 1,
    } as never;

    const controller = new BookTaskController({
      state,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft: async () => ({}),
        reviseDraft: async () => ({}),
        writeNextChapter: async () => ({}),
      }),
      broadcast: () => undefined,
      resolveWriteStageHeartbeatMs: () => 3_000,
    });
    const store = new BookTaskStore(state);

    const failedTask = await store.create(bookId, {
      type: "write",
      requestedChapters: 1,
      title: "Failed task",
      retryEnabled: false,
      service: "svc-a",
      model: "model-a",
      quickMode: false,
    });
    await store.setStatus(bookId, failedTask.id, "failed", {
      finishedAt: new Date().toISOString(),
      stage: "failed",
      stageLabel: "失败",
      stageDetail: "任务执行失败",
    });
    const failed = await controller.patch(bookId, failedTask.id, { options: { model: "model-b", service: "svc-b", quickMode: true } });
    expect(failed.status).toBe("failed");
    expect(failed.options).toMatchObject({ model: "model-b", service: "svc-b", quickMode: true });

    const cancelledTask = await store.create(bookId, {
      type: "write",
      requestedChapters: 1,
      title: "Cancelled task",
      retryEnabled: false,
      service: "svc-c",
      model: "model-c",
      quickMode: false,
    });
    await store.setStatus(bookId, cancelledTask.id, "cancelled", {
      finishedAt: new Date().toISOString(),
      stage: "cancelled",
      stageLabel: "已取消",
      stageDetail: "任务已取消",
    });
    const cancelled = await controller.patch(bookId, cancelledTask.id, { options: { model: "model-d" } });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.options.model).toBe("model-d");

    const activeTask = await store.create(bookId, {
      type: "write",
      requestedChapters: 1,
      title: "Active task",
      retryEnabled: false,
      service: "svc-e",
      model: "model-e",
      quickMode: false,
    });
    await store.setStatus(bookId, activeTask.id, "running", {
      finishedAt: null,
      stage: "running",
      stageLabel: "运行中",
      stageDetail: "任务运行中",
    });
    await expect(controller.patch(bookId, activeTask.id, { options: { model: "model-f" } })).rejects.toMatchObject({ status: 409 });
  });

  it("allows deleting any non-running task but blocks running ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const state = {
      stateDir: (id: string) => join(root, "books", id, "story", "state"),
      loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
      loadChapterIndex: async () => [],
      getNextChapterNumber: async () => 1,
    } as never;

    const controller = new BookTaskController({
      state,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft: async () => ({}),
        reviseDraft: async () => ({}),
        writeNextChapter: async () => ({}),
      }),
      broadcast: () => undefined,
      resolveWriteStageHeartbeatMs: () => 3_000,
    });
    const store = new BookTaskStore(state);

    const makeTask = async (status: BookTask["status"], title: string, targetBookId: string): Promise<BookTask> => {
      const task = await store.create(targetBookId, {
        type: "write",
        requestedChapters: 1,
        title,
        retryEnabled: false,
        service: "svc-a",
        model: "model-a",
        quickMode: false,
      });
      await store.setStatus(targetBookId, task.id, status, {
        finishedAt: status === "running" || status === "stopping" || status === "retry_waiting" ? null : new Date().toISOString(),
        stage: status,
        stageLabel: status,
        stageDetail: title,
      });
      return task;
    };

    const makeBook = async (suffix: string): Promise<string> => {
      const id = `${bookId}-${suffix}`;
      await mkdir(join(root, "books", id, "story", "state"), { recursive: true });
      await writeFile(join(root, "books", id, "book.json"), JSON.stringify({ id, title: `Demo Book ${suffix}` }), "utf-8");
      return id;
    };

    const failedBookId = await makeBook("failed");
    const cancelledBookId = await makeBook("cancelled");
    const succeededBookId = await makeBook("succeeded");
    const pausedBookId = await makeBook("paused");
    const queuedBookId = await makeBook("queued");
    const retryBookId = await makeBook("retry");
    const runningBookId = await makeBook("running");
    const stoppingBookId = await makeBook("stopping");

    await controller.delete(failedBookId, (await makeTask("failed", "failed task", failedBookId)).id);
    await controller.delete(cancelledBookId, (await makeTask("cancelled", "cancelled task", cancelledBookId)).id);
    await controller.delete(succeededBookId, (await makeTask("succeeded", "succeeded task", succeededBookId)).id);
    await controller.delete(pausedBookId, (await makeTask("paused", "paused task", pausedBookId)).id);
    await controller.delete(queuedBookId, (await makeTask("queued", "queued task", queuedBookId)).id);
    await controller.delete(retryBookId, (await makeTask("retry_waiting", "retry task", retryBookId)).id);

    const runningTask = await makeTask("running", "running task", runningBookId);
    await expect(controller.delete(runningBookId, runningTask.id)).rejects.toMatchObject({ status: 409 });
    const stoppingTask = await makeTask("stopping", "stopping task", stoppingBookId);
    await controller.delete(stoppingBookId, stoppingTask.id);
  });

  it("updates live token usage for audit and revise stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const state = {
      stateDir: (id: string) => join(root, "books", id, "story", "state"),
      loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
      loadChapterIndex: async () => [],
      getNextChapterNumber: async () => 1,
    } as never;

    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const controller = new BookTaskController({
      state,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft: async () => ({}),
        reviseDraft: async () => ({}),
        writeNextChapter: async () => ({}),
      }),
      broadcast: (event, data) => {
        broadcasts.push({ event, data });
      },
      resolveWriteStageHeartbeatMs: () => 3_000,
    });
    const store = new BookTaskStore(state);
    const task = await store.create(bookId, {
      type: "audit",
      requestedChapters: 1,
      title: "Audit task",
      retryEnabled: false,
      service: "svc-a",
      model: "model-a",
      quickMode: false,
    });
    await store.setStatus(bookId, task.id, "running", {
      finishedAt: null,
      stage: "audit",
      stageLabel: "审计中",
      stageDetail: "正在审计第 1 章",
      currentChapterNumber: 1,
      chapterFinishedAt: null,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    const auditUpdated = await (controller as unknown as {
      updateLiveTaskMetrics: (
        bookId: string,
        taskId: string,
        baseWords: number,
        baseTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number },
        progress: { totalChars: number; elapsedMs: number; chineseChars: number; status: string },
        language: string | null | undefined,
        activeChapterNumber: number | null,
      ) => Promise<BookTask | null>;
    }).updateLiveTaskMetrics(
      bookId,
      task.id,
      1234,
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      { totalChars: 200, elapsedMs: 1000, chineseChars: 200, status: "streaming" },
      "zh",
      null,
    );

    expect(auditUpdated?.tokenUsage?.totalTokens).toBeGreaterThan(0);
    expect(auditUpdated?.writtenWords).toBe(0);
    expect(broadcasts.some((item) => item.event === "book-task:update")).toBe(true);
    expect(broadcasts.some((item) => item.event === "book-task:progress")).toBe(true);

    await store.setStatus(bookId, task.id, "running", {
      finishedAt: null,
      stage: "revise",
      stageLabel: "修订中",
      stageDetail: "正在修订第 1 章",
      currentChapterNumber: 1,
      chapterFinishedAt: null,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    const reviseUpdated = await (controller as unknown as {
      updateLiveTaskMetrics: (
        bookId: string,
        taskId: string,
        baseWords: number,
        baseTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number },
        progress: { totalChars: number; elapsedMs: number; chineseChars: number; status: string },
        language: string | null | undefined,
        activeChapterNumber: number | null,
      ) => Promise<BookTask | null>;
    }).updateLiveTaskMetrics(
      bookId,
      task.id,
      1234,
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      { totalChars: 300, elapsedMs: 1500, chineseChars: 300, status: "streaming" },
      "zh",
      null,
    );

    expect(reviseUpdated?.tokenUsage?.totalTokens).toBeGreaterThan(0);
  });

  it("emits live token progress while running an audit task", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const state = {
      stateDir: (id: string) => join(root, "books", id, "story", "state"),
      loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
      loadChapterIndex: async () => [{
        number: 1,
        title: "Ch 1",
        status: "draft",
        wordCount: 0,
        updatedAt: "2026-05-23T00:00:00.000Z",
        fileName: "ch01.md",
      }],
      saveChapterIndex: async () => undefined,
      getNextChapterNumber: async () => 2,
    } as never;

    const broadcasts: Array<{ event: string; data: unknown }> = [];
    let capturedConfig: {
      onStreamProgress?: (progress: { status: "streaming" | "done"; elapsedMs: number; totalChars: number; chineseChars: number }) => void;
      onTaskSignal?: (signal: unknown) => void;
    } | null = null;

    const controller = new BookTaskController({
      state,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async (overrides) => overrides as never,
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: (config) => {
        capturedConfig = config as never;
        return {
          auditDraft: async () => {
            capturedConfig?.onStreamProgress?.({
              status: "streaming",
              elapsedMs: 1000,
              totalChars: 200,
              chineseChars: 200,
            });
            await new Promise((resolve) => setTimeout(resolve, 10));
            capturedConfig?.onStreamProgress?.({
              status: "streaming",
              elapsedMs: 2000,
              totalChars: 420,
              chineseChars: 420,
            });
            return {
              passed: true,
              issues: [],
              summary: "ok",
              tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            };
          },
          reviseDraft: async () => ({}),
          writeNextChapter: async () => ({}),
        };
      },
      broadcast: (event, data) => {
        broadcasts.push({ event, data });
      },
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "audit",
      requestedChapters: 1,
      retryEnabled: false,
      service: "svc-a",
      model: "model-a",
      quickMode: false,
    });

    await vi.waitFor(() => {
      expect(broadcasts.some((item) => item.event === "book-task:progress")).toBe(true);
    });
    await vi.waitFor(async () => {
      const latest = await controller.get(bookId, task.id);
      expect(latest?.status).toBe("succeeded");
      expect(latest?.tokenUsage?.totalTokens).toBeGreaterThan(0);
    });
  });

  it("revises audit chapters when the latest audit score is below 80 even if status is approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    let chapterIndex = [{
      number: 3,
      title: "Ch 3",
      status: "ready-for-review",
      wordCount: 2400,
      auditIssueCount: 1,
      updatedAt: "2026-05-20T00:00:00.000Z",
      fileName: "ch03.md",
      auditHistory: [{
        auditedAt: "2026-05-20T00:00:00.000Z",
        passed: true,
        issueCount: 1,
        score: 40,
        summary: "low score pass",
        issues: ["[warning] pacing"],
      }],
    }];

    const auditDraft = vi.fn().mockResolvedValue({
      passed: true,
      issues: [],
      summary: "audit ok",
      report: "audit report body",
    });
    const reviseDraft = vi.fn().mockResolvedValue({
      status: "ready-for-review",
      applied: true,
      audit: {
        passed: true,
        score: 92,
        issueCount: 0,
        severityCounts: { critical: 0, warning: 0, info: 0 },
        summary: "repaired",
        report: "修订后审计报告",
        issues: [],
      },
    });
    const auditIssues = [{
      severity: "warning",
      category: "结构",
      description: "节奏偏慢",
      suggestion: "提高冲突密度",
    }];
    auditDraft.mockResolvedValueOnce({
      passed: false,
      issues: auditIssues,
      summary: "needs revision",
      report: "audit report body",
    });
    const loadChapterIndex = vi.fn(async () => chapterIndex);
    const saveChapterIndex = vi.fn(async (_bookId: string, nextIndex: unknown) => {
      chapterIndex = nextIndex as typeof chapterIndex;
    });

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
        loadChapterIndex,
        saveChapterIndex,
        getNextChapterNumber: async () => 4,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft,
        reviseDraft,
        writeNextChapter: async () => ({}),
      }),
      broadcast: () => undefined,
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "audit",
      requestedChapters: 1,
      auditChapterStart: 3,
      auditChapterEnd: 3,
      retryEnabled: false,
    });

    let finalTask = task;
    for (let i = 0; i < 80; i += 1) {
      const current = await controller.get(bookId, task.id);
      if (current) {
        finalTask = current;
        if (current.status === "succeeded") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(auditDraft).toHaveBeenCalledTimes(1);
    expect(reviseDraft).toHaveBeenCalledTimes(1);
    expect(reviseDraft).toHaveBeenCalledWith(
      bookId,
      3,
      "polish",
      expect.objectContaining({
        userBrief: expect.stringContaining("## 任务中心自动修订约束"),
        reviseContext: expect.objectContaining({
          failureGate: "score",
          score: 40,
          passScoreThreshold: 80,
          scoreShortfall: 40,
          mustFixFirstIssueIds: expect.arrayContaining(["ISSUE-01"]),
        }),
      }),
    );
    expect(saveChapterIndex).toHaveBeenCalled();
    expect(finalTask.status).toBe("succeeded");
    expect(finalTask.result).toMatchObject({
      auditedChapters: 1,
      passedChapters: 1,
      failedChapters: 0,
      auditPassRate: 100,
    });
    expect(chapterIndex[0]).toMatchObject({
      status: "ready-for-review",
      auditIssueCount: 0,
      auditHistory: [
        expect.objectContaining({
          passed: true,
          issueCount: 1,
          score: 40,
        }),
        expect.objectContaining({
          passed: true,
          issueCount: 0,
          score: 92,
          summary: "repaired",
          report: "修订后审计报告",
        }),
      ],
    });
  });

  it("broadcasts chapter-level audit completion when audit tasks succeed", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    let chapterIndex = [{
      number: 3,
      title: "Ch 3",
      status: "drafted",
      wordCount: 2400,
      auditIssueCount: 2,
      updatedAt: "2026-05-20T00:00:00.000Z",
      fileName: "ch03.md",
      auditHistory: [],
    }];

    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const auditDraft = vi.fn().mockResolvedValue({
      passed: true,
      issues: [],
      summary: "audit ok",
      report: "audit report body",
    });
    const loadChapterIndex = vi.fn(async () => chapterIndex);
    const saveChapterIndex = vi.fn(async (_bookId: string, nextIndex: unknown) => {
      chapterIndex = nextIndex as typeof chapterIndex;
    });

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
        loadChapterIndex,
        saveChapterIndex,
        getNextChapterNumber: async () => 4,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft,
        reviseDraft: async () => ({}),
        writeNextChapter: async () => ({}),
      }),
      broadcast: (event, data) => {
        broadcasts.push({ event, data });
      },
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "audit",
      requestedChapters: 1,
      auditChapterStart: 3,
      auditChapterEnd: 3,
      retryEnabled: false,
    });

    let finalTask = task;
    for (let i = 0; i < 80; i += 1) {
      const current = await controller.get(bookId, task.id);
      if (current) {
        finalTask = current;
        if (current.status === "succeeded") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(auditDraft).toHaveBeenCalledTimes(1);
    expect(loadChapterIndex).toHaveBeenCalled();
    expect(saveChapterIndex).toHaveBeenCalled();
    expect(finalTask.status).toBe("succeeded");
    const auditComplete = broadcasts.find((item) => item.event === "audit:complete");
    expect(auditComplete).toBeTruthy();
    expect(auditComplete?.data).toMatchObject({
      bookId,
      chapterNumber: 3,
      passed: true,
      score: 100,
      issueCount: 0,
      report: "audit report body",
      status: "ready-for-review",
    });
    expect(chapterIndex[0]).toMatchObject({
      status: "ready-for-review",
      auditIssueCount: 0,
      auditHistory: [
        expect.objectContaining({
          passed: true,
          issueCount: 0,
          score: 100,
          report: "audit report body",
        }),
      ],
    });
    expect(broadcasts.some((item) => item.event === "book-task:complete")).toBe(true);
  });

  it("keeps audit task below 80 in revise flow until it passes threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    let chapterIndex = [{
      number: 3,
      title: "Ch 3",
      status: "drafted",
      wordCount: 2400,
      auditIssueCount: 2,
      updatedAt: "2026-05-20T00:00:00.000Z",
      fileName: "ch03.md",
      auditHistory: [{
        auditedAt: "2026-05-20T00:00:00.000Z",
        passed: true,
        issueCount: 2,
        score: 72,
        summary: "low score pass",
      }],
    }];

    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const auditDraft = vi.fn().mockResolvedValue({
      passed: true,
      issues: [],
      summary: "audit ok",
      report: "audit report body",
    });
    const reviseDraft = vi.fn().mockResolvedValue({
      status: "ready-for-review",
      applied: true,
      audit: {
        passed: true,
        score: 92,
        issueCount: 0,
        severityCounts: { critical: 0, warning: 0, info: 0 },
        summary: "repaired",
        report: "revised report",
        issues: [],
      },
    });
    const loadChapterIndex = vi.fn(async () => chapterIndex);
    const saveChapterIndex = vi.fn(async (_bookId: string, nextIndex: unknown) => {
      chapterIndex = nextIndex as typeof chapterIndex;
    });

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
        loadChapterIndex,
        saveChapterIndex,
        getNextChapterNumber: async () => 4,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft,
        reviseDraft,
        writeNextChapter: async () => ({}),
      }),
      broadcast: (event, data) => {
        broadcasts.push({ event, data });
      },
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "audit",
      requestedChapters: 1,
      auditChapterStart: 3,
      auditChapterEnd: 3,
      retryEnabled: false,
    });

    await vi.waitFor(async () => {
      const current = await controller.get(bookId, task.id);
      expect(current?.status).toBe("succeeded");
    });

    expect(auditDraft).toHaveBeenCalledTimes(1);
    expect(reviseDraft).toHaveBeenCalledTimes(1);
    expect(saveChapterIndex).toHaveBeenCalled();
    expect(broadcasts.some((item) => item.event === "book-task:error")).toBe(false);
    expect(chapterIndex[0]).toMatchObject({
      status: "ready-for-review",
      auditIssueCount: 0,
      auditHistory: [
        expect.objectContaining({
          passed: true,
          score: 72,
        }),
        expect.objectContaining({
          passed: true,
          score: 92,
        }),
      ],
    });
  });

  it("switches to rework for task-center audit revisions with critical issues", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    let chapterIndex = [{
      number: 3,
      title: "Ch 3",
      status: "drafted",
      wordCount: 2400,
      auditIssueCount: 1,
      updatedAt: "2026-05-20T00:00:00.000Z",
      fileName: "ch03.md",
      auditHistory: [],
    }];

    const auditDraft = vi.fn().mockResolvedValue({
      passed: false,
      issues: [
        {
          severity: "critical",
          category: "plot",
          description: "main conflict broken",
          suggestion: "restore main conflict",
        },
      ],
      summary: "critical failure",
      report: "critical report",
    });
    const reviseDraft = vi.fn().mockResolvedValue({
      status: "ready-for-review",
      applied: true,
      audit: {
        passed: true,
        score: 88,
        issueCount: 0,
        severityCounts: { critical: 0, warning: 0, info: 0 },
        summary: "fixed",
        report: "fixed report",
        issues: [],
      },
    });
    const loadChapterIndex = vi.fn(async () => chapterIndex);
    const saveChapterIndex = vi.fn(async (_bookId: string, nextIndex: unknown) => {
      chapterIndex = nextIndex as typeof chapterIndex;
    });

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6 }),
        loadChapterIndex,
        saveChapterIndex,
        getNextChapterNumber: async () => 4,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft,
        reviseDraft,
        writeNextChapter: async () => ({}),
      }),
      broadcast: () => undefined,
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "audit",
      requestedChapters: 1,
      auditChapterStart: 3,
      auditChapterEnd: 3,
      retryEnabled: false,
    });

    await vi.waitFor(async () => {
      const current = await controller.get(bookId, task.id);
      expect(current?.status).toBe("succeeded");
    });

    expect(reviseDraft).toHaveBeenCalledWith(
      bookId,
      3,
      "rewrite",
      expect.objectContaining({
        reviseContext: expect.objectContaining({
          failureGate: "critical",
          mustFixFirstIssueIds: expect.arrayContaining(["ISSUE-01"]),
        }),
      }),
    );
  });

  it("warns once and keeps writing when the latest chapter is state-degraded", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const writeNextChapter = vi.fn().mockResolvedValue({
      chapterNumber: 48,
      title: "Ch 48",
      wordCount: 1200,
      status: "ready-for-review",
      passed: true,
      auditResult: {
        passed: true,
      },
      tokenUsage: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      },
    });

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 60, language: "zh" }),
        loadChapterIndex: async () => ([{
          number: 47,
          title: "Ch 47",
          status: "state-degraded",
          wordCount: 4200,
          updatedAt: "2026-05-23T00:00:00.000Z",
          fileName: "ch47.md",
          auditIssues: ["[warning] state validation degraded"],
        }]),
        getNextChapterNumber: async () => 48,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft: async () => ({}),
        reviseDraft: async () => ({}),
        writeNextChapter,
      }),
      broadcast: (event, data) => {
        broadcasts.push({ event, data });
      },
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "write",
      requestedChapters: 1,
      retryEnabled: false,
      service: "svc-a",
      model: "model-a",
      quickMode: false,
    });

    await vi.waitFor(async () => {
      const current = await controller.get(bookId, task.id);
      expect(current?.status).toBe("succeeded");
    });

    expect(writeNextChapter).toHaveBeenCalledTimes(1);
    expect(writeNextChapter).toHaveBeenCalledWith(
      bookId,
      expect.any(Number),
      undefined,
      expect.objectContaining({
        quickMode: false,
        allowPendingAuditFailure: true,
        unboundedReview: false,
      }),
    );
    const warnLogs = broadcasts.filter((item) => item.event === "book-task:log" && (item.data as { log?: { level?: string } }).log?.level === "warn");
    expect(warnLogs).toHaveLength(1);
    expect((warnLogs[0]?.data as { log?: { message?: string } } | undefined)?.log?.message).toContain("state-degraded");
    expect(broadcasts.some((item) => item.event === "book-task:error")).toBe(false);
  });

  it("enables unbounded review rounds for task-center write tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const writeNextChapter = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      title: "Ch 1",
      wordCount: 1200,
      status: "ready-for-review",
      passed: true,
      auditResult: {
        passed: true,
      },
      tokenUsage: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      },
    });

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6, language: "zh" }),
        loadChapterIndex: async () => [],
        getNextChapterNumber: async () => 1,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft: async () => ({}),
        reviseDraft: async () => ({}),
        writeNextChapter,
      }),
      broadcast: () => undefined,
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "write",
      source: "task-center",
      requestedChapters: 1,
      retryEnabled: false,
      service: "svc-a",
      model: "model-a",
      quickMode: false,
    });

    await vi.waitFor(async () => {
      const current = await controller.get(bookId, task.id);
      expect(current?.status).toBe("succeeded");
    });

    expect(writeNextChapter).toHaveBeenCalledWith(
      bookId,
      expect.any(Number),
      undefined,
      expect.objectContaining({
        quickMode: false,
        allowPendingAuditFailure: true,
        unboundedReview: true,
      }),
    );
  });

  it("propagates failed task-center auto-review results without imposing extra repair rounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const writeNextChapter = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      title: "Ch 1",
      wordCount: 1200,
      status: "failed",
      passed: false,
      auditResult: {
        passed: false,
        score: 64,
        issueCount: 3,
        summary: "needs revision",
        report: "pipeline review stopped after convergence guardrail",
        issues: [
          { severity: "warning", category: "pacing", description: "too slow", suggestion: "tighten" },
          { severity: "warning", category: "structure", description: "flat middle", suggestion: "add conflict" },
          { severity: "warning", category: "hook", description: "weak ending", suggestion: "strengthen hook" },
        ],
      },
      autoReview: {
        maxReviseRounds: 0,
        reviseRoundsUsed: 0,
        auditRounds: 1,
        stoppedByMaxRounds: true,
        finalState: "failed-max-rounds",
        stopReason: "pipeline review stopped after convergence guardrail",
      },
      tokenUsage: {
        promptTokens: 12,
        completionTokens: 18,
        totalTokens: 30,
      },
    });
    const reviseDraft = vi.fn();

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6, language: "zh" }),
        loadChapterIndex: async () => [],
        getNextChapterNumber: async () => 1,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft: async () => ({}),
        reviseDraft,
        writeNextChapter,
      }),
      broadcast: () => undefined,
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "write",
      source: "task-center",
      requestedChapters: 1,
      retryEnabled: false,
      service: "svc-a",
      model: "model-a",
      quickMode: false,
    });

    await vi.waitFor(async () => {
      const current = await controller.get(bookId, task.id);
      expect(current?.status).toBe("failed");
    });

    const finalTask = await controller.get(bookId, task.id);
    expect(writeNextChapter).toHaveBeenCalledTimes(1);
    expect(reviseDraft).not.toHaveBeenCalled();
    expect(finalTask?.status).toBe("failed");
    expect(finalTask?.completedChapters).toBe(0);
    expect(finalTask?.error).toContain("pipeline review stopped after convergence guardrail");
  });

  it("fails task-center write chapters using the pipeline stop reason, not a fixed repair-round cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-task-controller-"));
    tempRoots.push(root);
    const bookId = "demo-book";
    await mkdir(join(root, "books", bookId, "story", "state"), { recursive: true });
    await writeFile(join(root, "books", bookId, "book.json"), JSON.stringify({ id: bookId, title: "Demo Book" }), "utf-8");

    const writeNextChapter = vi.fn().mockResolvedValue({
      chapterNumber: 1,
      title: "Ch 1",
      wordCount: 1200,
      status: "failed",
      passed: false,
      auditResult: {
        passed: false,
        score: 64,
        issueCount: 3,
        summary: "needs revision",
        report: "pipeline review stopped after convergence guardrail",
        issues: [
          { severity: "warning", category: "pacing", description: "too slow", suggestion: "tighten" },
          { severity: "warning", category: "structure", description: "flat middle", suggestion: "add conflict" },
          { severity: "warning", category: "hook", description: "weak ending", suggestion: "strengthen hook" },
        ],
      },
      autoReview: {
        maxReviseRounds: 0,
        reviseRoundsUsed: 0,
        auditRounds: 1,
        stoppedByMaxRounds: true,
        finalState: "failed-max-rounds",
        stopReason: "pipeline review stopped after convergence guardrail",
      },
      tokenUsage: {
        promptTokens: 12,
        completionTokens: 18,
        totalTokens: 30,
      },
    });
    const reviseDraft = vi.fn();

    const controller = new BookTaskController({
      state: {
        stateDir: (id: string) => join(root, "books", id, "story", "state"),
        loadBookConfig: async () => ({ title: "Demo Book", targetChapters: 6, language: "zh" }),
        loadChapterIndex: async () => [],
        getNextChapterNumber: async () => 1,
      } as never,
      loadCurrentProjectConfig: async () => ({}) as ProjectConfig,
      buildPipelineConfig: async () => ({} as never),
      resolvePipelineClientFromSelection: async () => ({}),
      createPipeline: () => ({
        auditDraft: async () => ({}),
        reviseDraft,
        writeNextChapter,
      }),
      broadcast: () => undefined,
      resolveWriteStageHeartbeatMs: () => 3_000,
    });

    const task = await controller.create(bookId, {
      type: "write",
      source: "task-center",
      requestedChapters: 1,
      retryEnabled: false,
      service: "svc-a",
      model: "model-a",
      quickMode: false,
    });

    await vi.waitFor(async () => {
      const current = await controller.get(bookId, task.id);
      expect(current?.status).toBe("failed");
    });

    const finalTask = await controller.get(bookId, task.id);
    expect(writeNextChapter).toHaveBeenCalledTimes(1);
    expect(reviseDraft).not.toHaveBeenCalled();
    expect(finalTask?.status).toBe("failed");
    expect(finalTask?.completedChapters).toBe(0);
    expect(finalTask?.error).toContain("pipeline review stopped after convergence guardrail");
    expect(finalTask?.error).not.toContain("3 轮");
  });
});
