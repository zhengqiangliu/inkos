import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function createStateCard(params: {
  readonly chapter: number;
  readonly location: string;
  readonly protagonistState: string;
  readonly goal: string;
  readonly conflict: string;
}): string {
  return [
    "# Current State",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Current Chapter | ${params.chapter} |`,
    `| Current Location | ${params.location} |`,
    `| Protagonist State | ${params.protagonistState} |`,
    `| Current Goal | ${params.goal} |`,
    "| Current Constraint | The city gates are watched. |",
    "| Current Alliances | Mentor allies are scattered. |",
    `| Current Conflict | ${params.conflict} |`,
    "",
  ].join("\n");
}

interface FakeStore {
  facts: Array<{
    id: number;
    subject: string;
    predicate: string;
    object: string;
    validFromChapter: number;
    validUntilChapter: number | null;
    sourceChapter: number;
  }>;
  summaries: Array<{
    chapter: number;
    title: string;
    characters: string;
    events: string;
    stateChanges: string;
    hookActivity: string;
    mood: string;
    chapterType: string;
  }>;
  hooks: Array<{
    hookId: string;
    startChapter: number;
    type: string;
    status: string;
    lastAdvancedChapter: number;
    expectedPayoff: string;
    payoffTiming?: string;
    notes: string;
  }>;
  nextFactId: number;
  resetFactsCalls: number;
  addFactCalls: number;
  invalidateFactCalls: number;
  getCurrentFactsCalls: number;
  replaceSummariesCalls: number;
  upsertSummaryCalls: number;
  replaceHooksCalls: number;
  upsertHookCalls: number;
}

class FakeMemoryDB {
  static stores = new Map<string, FakeStore>();

  private readonly store: FakeStore;

  constructor(private readonly bookDir: string) {
    const existing = FakeMemoryDB.stores.get(bookDir);
    if (existing) {
      this.store = existing;
      return;
    }

    const created: FakeStore = {
      facts: [],
      summaries: [],
      hooks: [],
      nextFactId: 1,
      resetFactsCalls: 0,
      addFactCalls: 0,
      invalidateFactCalls: 0,
      getCurrentFactsCalls: 0,
      replaceSummariesCalls: 0,
      upsertSummaryCalls: 0,
      replaceHooksCalls: 0,
      upsertHookCalls: 0,
    };
    FakeMemoryDB.stores.set(bookDir, created);
    this.store = created;
  }

  close(): void {}

  replaceSummaries(summaries: FakeStore["summaries"]): void {
    this.store.replaceSummariesCalls += 1;
    this.store.summaries = summaries.map((summary) => ({ ...summary }));
  }

  upsertSummary(summary: FakeStore["summaries"][number]): void {
    this.store.upsertSummaryCalls += 1;
    const index = this.store.summaries.findIndex((entry) => entry.chapter === summary.chapter);
    if (index >= 0) {
      this.store.summaries[index] = { ...summary };
      return;
    }
    this.store.summaries.push({ ...summary });
  }

  replaceHooks(hooks: FakeStore["hooks"]): void {
    this.store.replaceHooksCalls += 1;
    this.store.hooks = hooks.map((hook) => ({ ...hook }));
  }

  upsertHook(hook: FakeStore["hooks"][number]): void {
    this.store.upsertHookCalls += 1;
    const index = this.store.hooks.findIndex((entry) => entry.hookId === hook.hookId);
    if (index >= 0) {
      this.store.hooks[index] = { ...hook };
      return;
    }
    this.store.hooks.push({ ...hook });
  }

  resetFacts(): void {
    this.store.resetFactsCalls += 1;
    this.store.facts = [];
    this.store.nextFactId = 1;
  }

  addFact(fact: Omit<FakeStore["facts"][number], "id">): number {
    this.store.addFactCalls += 1;
    const id = this.store.nextFactId++;
    this.store.facts.push({ id, ...fact });
    return id;
  }

  invalidateFact(id: number, untilChapter: number): void {
    this.store.invalidateFactCalls += 1;
    const index = this.store.facts.findIndex((fact) => fact.id === id);
    if (index >= 0) {
      this.store.facts[index] = {
        ...this.store.facts[index]!,
        validUntilChapter: untilChapter,
      };
    }
  }

  getCurrentFacts(): ReadonlyArray<FakeStore["facts"][number]> {
    this.store.getCurrentFactsCalls += 1;
    return this.store.facts
      .filter((fact) => fact.validUntilChapter == null)
      .map((fact) => ({ ...fact }));
  }

  getChapterCount(): number {
    return this.store.summaries.length;
  }
}

describe("PipelineRunner structured-state memory sync", () => {
  let root = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../state/memory-db.js");
    FakeMemoryDB.stores.clear();
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("uses structured runtime state for narrative memory during writeNextChapter even when markdown projections drift after persistence", async () => {
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: FakeMemoryDB,
    }));

    const { PipelineRunner } = await import("../pipeline/runner.js");
    const { StateManager } = await import("../state/manager.js");
    const { WriterAgent } = await import("../agents/writer.js");
    const { ContinuityAuditor } = await import("../agents/continuity.js");
    const { StateValidatorAgent } = await import("../agents/state-validator.js");

    root = await mkdtemp(join(tmpdir(), "inkos-runner-memory-sync-"));
    const state = new StateManager(root);
    const bookId = "memory-sync-book";
    const now = "2026-03-25T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Memory Sync Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      language: "en",
      targetChapters: 10,
      chapterWordCount: 10,
      createdAt: now,
      updatedAt: now,
    };

    await state.saveBookConfig(bookId, book);
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Shrine outskirts",
        protagonistState: "Lin Yue begins with the oath token hidden.",
        goal: "Reach the trial city.",
        conflict: "The trial deadline is closing in.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
    ]);

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          maxTokensCap: null,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      inputGovernanceMode: "legacy",
    });

    const originalSaveChapter = WriterAgent.prototype.saveChapter;
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue({
      chapterNumber: 1,
      title: "Structured Chapter",
      content: "Lin Yue follows the debt into the watchtower archive.",
      wordCount: 9,
      preWriteCheck: "check",
      postSettlement: "settled",
      updatedState: "unused legacy state",
      updatedLedger: "unused legacy ledger",
      updatedHooks: "unused legacy hooks",
      chapterSummary: "| 1 | unused summary |",
      updatedSubplots: "",
      updatedEmotionalArcs: "",
      updatedCharacterMatrix: "",
      postWriteErrors: [],
      postWriteWarnings: [],
      tokenUsage: ZERO_USAGE,
      runtimeStateDelta: {
        chapter: 1,
        currentStatePatch: {
          currentGoal: "Trace the debt through the watchtower archive.",
          currentConflict: "Guild pressure keeps colliding with the debt trail.",
        },
        hookOps: {
          upsert: [
            {
              hookId: "structured-hook",
              startChapter: 1,
              type: "relationship",
              status: "open",
              lastAdvancedChapter: 1,
              expectedPayoff: "Reveal why the mentor vanished.",
              notes: "Structured hook should win.",
            },
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
        newHookCandidates: [],
        chapterSummary: {
          chapter: 1,
          title: "Structured Summary",
          characters: "Lin Yue",
          events: "Lin Yue follows the debt into the watchtower archive.",
          stateChanges: "The debt trail sharpens.",
          hookActivity: "structured-hook advanced",
          mood: "tense",
          chapterType: "investigation",
        },
        subplotOps: [],
        emotionalArcOps: [],
        characterMatrixOps: [],
        notes: [],
      },
    });
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue({
      passed: true,
      issues: [],
      summary: "clean",
      tokenUsage: ZERO_USAGE,
    });
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      warnings: [],
      passed: true,
    });
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockImplementation(async function (
      this: InstanceType<typeof WriterAgent>,
      bookDirArg,
      output,
      numericalSystem,
      language,
    ) {
      await originalSaveChapter.call(this, bookDirArg, output, numericalSystem, language);
      await Promise.all([
        writeFile(
          join(bookDirArg, "story", "pending_hooks.md"),
          [
            "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| markdown-drift-hook | 1 | mystery | open | 1 | 5 | Drifted markdown hook |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(bookDirArg, "story", "chapter_summaries.md"),
          [
            "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 1 | Markdown Drift Summary | Lin Yue | Drifted markdown event | Drifted markdown state | markdown-drift-hook advanced | flat | fallback |",
            "",
          ].join("\n"),
          "utf-8",
        ),
      ]);
    });

    await runner.writeNextChapter(bookId);

    const narrativeStore = FakeMemoryDB.stores.get(bookDir);
    expect(await readFile(join(storyDir, "pending_hooks.md"), "utf-8")).toContain("markdown-drift-hook");
    expect(await readFile(join(storyDir, "chapter_summaries.md"), "utf-8")).toContain("Markdown Drift Summary");
    expect(narrativeStore?.hooks).toEqual([
      expect.objectContaining({
        hookId: "structured-hook",
        notes: "Structured hook should win.",
      }),
    ]);
    expect(narrativeStore?.summaries).toEqual([
      expect.objectContaining({
        chapter: 1,
        title: "Structured Summary",
        events: "Lin Yue follows the debt into the watchtower archive.",
      }),
    ]);
  }, 15_000);

  it("uses incremental current-state fact sync after contiguous chapter progress", async () => {
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: FakeMemoryDB,
    }));

    const { PipelineRunner } = await import("../pipeline/runner.js");
    const { StateManager } = await import("../state/manager.js");

    root = await mkdtemp(join(tmpdir(), "inkos-runner-fact-sync-incremental-"));
    const state = new StateManager(root);
    const bookId = "fact-sync-incremental-book";
    const now = "2026-03-25T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Fact Sync Incremental Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      language: "en",
      targetChapters: 10,
      chapterWordCount: 10,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(bookId, book);
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    const writeSnapshot = async (chapter: number, conflict: string) => {
      const snapshotStateDir = join(storyDir, "snapshots", String(chapter), "state");
      await mkdir(snapshotStateDir, { recursive: true });
      await writeFile(join(snapshotStateDir, "current_state.json"), JSON.stringify({
        chapter,
        facts: [
          {
            subject: "protagonist",
            predicate: "Current Conflict",
            object: conflict,
            validFromChapter: chapter,
            validUntilChapter: null,
            sourceChapter: chapter,
          },
        ],
      }, null, 2), "utf-8");
    };

    await writeSnapshot(0, "Conflict zero.");
    await writeSnapshot(1, "Conflict one.");
    await writeSnapshot(2, "Conflict two.");

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          maxTokensCap: null,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      inputGovernanceMode: "legacy",
    });

    await (runner as unknown as {
      syncCurrentStateFactHistory: (targetBookId: string, uptoChapter: number) => Promise<void>;
    }).syncCurrentStateFactHistory(bookId, 1);

    const store = FakeMemoryDB.stores.get(bookDir);
    expect(store?.resetFactsCalls).toBe(1);
    expect(store?.addFactCalls).toBe(2);

    await (runner as unknown as {
      syncCurrentStateFactHistory: (targetBookId: string, uptoChapter: number) => Promise<void>;
    }).syncCurrentStateFactHistory(bookId, 2);

    const updatedStore = FakeMemoryDB.stores.get(bookDir);
    expect(updatedStore?.resetFactsCalls).toBe(1);
    expect(updatedStore?.getCurrentFactsCalls).toBeGreaterThanOrEqual(1);
    expect(updatedStore?.invalidateFactCalls).toBeGreaterThanOrEqual(2);
    expect(updatedStore?.facts.filter((fact) => fact.validUntilChapter == null)).toEqual([
      expect.objectContaining({
        sourceChapter: 2,
        object: "Conflict two.",
      }),
    ]);
  });

  it("keeps current-state fact sync idempotent when the same chapter is synced repeatedly", async () => {
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: FakeMemoryDB,
    }));

    const { PipelineRunner } = await import("../pipeline/runner.js");
    const { StateManager } = await import("../state/manager.js");

    root = await mkdtemp(join(tmpdir(), "inkos-runner-fact-sync-idempotent-"));
    const state = new StateManager(root);
    const bookId = "fact-sync-idempotent-book";
    const now = "2026-03-25T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Fact Sync Idempotent Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      language: "en",
      targetChapters: 10,
      chapterWordCount: 10,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(bookId, book);
    const bookDir = state.bookDir(bookId);
    const snapshotStateDir = join(bookDir, "story", "snapshots", "1", "state");
    await mkdir(snapshotStateDir, { recursive: true });
    await writeFile(join(snapshotStateDir, "current_state.json"), JSON.stringify({
      chapter: 1,
      facts: [
        {
          subject: "protagonist",
          predicate: "Current Goal",
          object: "Reach the trial city.",
          validFromChapter: 1,
          validUntilChapter: null,
          sourceChapter: 1,
        },
      ],
    }, null, 2), "utf-8");

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          maxTokensCap: null,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      inputGovernanceMode: "legacy",
    });

    await (runner as unknown as {
      syncCurrentStateFactHistory: (targetBookId: string, uptoChapter: number) => Promise<void>;
    }).syncCurrentStateFactHistory(bookId, 1);
    const first = FakeMemoryDB.stores.get(bookDir);
    const addFactCallsAfterFirst = first?.addFactCalls ?? 0;
    const invalidateCallsAfterFirst = first?.invalidateFactCalls ?? 0;
    const factsCountAfterFirst = first?.facts.length ?? 0;

    await (runner as unknown as {
      syncCurrentStateFactHistory: (targetBookId: string, uptoChapter: number) => Promise<void>;
    }).syncCurrentStateFactHistory(bookId, 1);

    const second = FakeMemoryDB.stores.get(bookDir);
    expect(second?.addFactCalls).toBe(addFactCallsAfterFirst);
    expect(second?.invalidateFactCalls).toBe(invalidateCallsAfterFirst);
    expect(second?.facts.length).toBe(factsCountAfterFirst);
    expect(second?.facts.filter((fact) => fact.validUntilChapter == null)).toEqual([
      expect.objectContaining({
        sourceChapter: 1,
        object: "Reach the trial city.",
      }),
    ]);
  });

  it("uses incremental narrative memory sync after contiguous chapter progress", async () => {
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: FakeMemoryDB,
    }));

    const { PipelineRunner } = await import("../pipeline/runner.js");
    const { StateManager } = await import("../state/manager.js");

    root = await mkdtemp(join(tmpdir(), "inkos-runner-narrative-sync-incremental-"));
    const state = new StateManager(root);
    const bookId = "narrative-sync-incremental-book";
    const now = "2026-03-25T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Narrative Sync Incremental Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      language: "en",
      targetChapters: 10,
      chapterWordCount: 10,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(bookId, book);
    const bookDir = state.bookDir(bookId);
    const stateDir = join(bookDir, "story", "state");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(stateDir, { recursive: true });
    await mkdir(chaptersDir, { recursive: true });

    await Promise.all([
      writeFile(join(chaptersDir, "index.json"), JSON.stringify([
        { number: 1, title: "Debt Setup", status: "approved" },
      ]), "utf-8"),
      writeFile(join(chaptersDir, "0001_Debt_Setup.md"), "# Chapter 1\n\nDebt pressure begins.", "utf-8"),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 1,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        chapter: 1,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "mentor-debt",
            startChapter: 1,
            type: "relationship",
            status: "open",
            lastAdvancedChapter: 1,
            expectedPayoff: "Reveal the debt owner.",
            notes: "Track debt pressure.",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "chapter_summaries.json"), JSON.stringify({
        rows: [
          {
            chapter: 1,
            title: "Debt Setup",
            characters: "Lin Yue",
            events: "Debt pressure begins.",
            stateChanges: "Mentor debt rises.",
            hookActivity: "mentor-debt opened",
            mood: "tense",
            chapterType: "mainline",
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          maxTokensCap: null,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      inputGovernanceMode: "legacy",
    });

    await (runner as unknown as {
      syncNarrativeMemoryIndex: (targetBookId: string) => Promise<void>;
    }).syncNarrativeMemoryIndex(bookId);

    const firstStore = FakeMemoryDB.stores.get(bookDir);
    expect(firstStore?.replaceSummariesCalls).toBe(1);
    expect(firstStore?.replaceHooksCalls).toBe(1);
    const replaceSummariesCalls = firstStore?.replaceSummariesCalls ?? 0;
    const replaceHooksCalls = firstStore?.replaceHooksCalls ?? 0;

    await Promise.all([
      writeFile(join(chaptersDir, "index.json"), JSON.stringify([
        { number: 1, title: "Debt Setup", status: "approved" },
        { number: 2, title: "Debt Trail", status: "approved" },
      ]), "utf-8"),
      writeFile(join(chaptersDir, "0002_Debt_Trail.md"), "# Chapter 2\n\nA clue surfaces near the watchtower.", "utf-8"),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 2,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        chapter: 2,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "mentor-debt",
            startChapter: 1,
            type: "relationship",
            status: "progressing",
            lastAdvancedChapter: 2,
            expectedPayoff: "Reveal the debt owner.",
            notes: "Debt owner clue appears.",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "chapter_summaries.json"), JSON.stringify({
        rows: [
          {
            chapter: 1,
            title: "Debt Setup",
            characters: "Lin Yue",
            events: "Debt pressure begins.",
            stateChanges: "Mentor debt rises.",
            hookActivity: "mentor-debt opened",
            mood: "tense",
            chapterType: "mainline",
          },
          {
            chapter: 2,
            title: "Debt Trail",
            characters: "Lin Yue",
            events: "A clue surfaces near the watchtower.",
            stateChanges: "Debt owner trace becomes concrete.",
            hookActivity: "mentor-debt advanced",
            mood: "grim",
            chapterType: "mainline",
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    await (runner as unknown as {
      syncNarrativeMemoryIndex: (targetBookId: string) => Promise<void>;
    }).syncNarrativeMemoryIndex(bookId);

    const secondStore = FakeMemoryDB.stores.get(bookDir);
    expect(secondStore?.replaceSummariesCalls).toBe(replaceSummariesCalls);
    expect(secondStore?.replaceHooksCalls).toBe(replaceHooksCalls);
    expect(secondStore?.upsertSummaryCalls).toBeGreaterThanOrEqual(1);
    expect(secondStore?.upsertHookCalls).toBeGreaterThanOrEqual(1);
    expect(secondStore?.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chapter: 2,
          title: "Debt Trail",
        }),
      ]),
    );
    expect(secondStore?.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookId: "mentor-debt",
          status: "progressing",
          lastAdvancedChapter: 2,
        }),
      ]),
    );
  });

  it("keeps memory sync on incremental paths during long contiguous chapter runs", async () => {
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: FakeMemoryDB,
    }));

    const { PipelineRunner } = await import("../pipeline/runner.js");
    const { StateManager } = await import("../state/manager.js");

    root = await mkdtemp(join(tmpdir(), "inkos-runner-memory-sync-long-run-"));
    const state = new StateManager(root);
    const bookId = "memory-sync-long-run-book";
    const now = "2026-03-25T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Memory Sync Long Run Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      language: "en",
      targetChapters: 60,
      chapterWordCount: 10,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(bookId, book);
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    const chaptersDir = join(bookDir, "chapters");
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(chaptersDir, { recursive: true }),
    ]);

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          maxTokensCap: null,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      inputGovernanceMode: "legacy",
    });

    const chapterCount = 30;
    const writeSnapshot = async (chapter: number) => {
      const snapshotStateDir = join(storyDir, "snapshots", String(chapter), "state");
      await mkdir(snapshotStateDir, { recursive: true });
      await writeFile(join(snapshotStateDir, "current_state.json"), JSON.stringify({
        chapter,
        facts: [
          {
            subject: "protagonist",
            predicate: "Current Conflict",
            object: `Conflict ${chapter}`,
            validFromChapter: chapter,
            validUntilChapter: null,
            sourceChapter: chapter,
          },
        ],
      }, null, 2), "utf-8");
    };

    for (let chapter = 0; chapter <= chapterCount; chapter += 1) {
      await writeSnapshot(chapter);
    }

    for (let chapter = 1; chapter <= chapterCount; chapter += 1) {
      const indexRows = Array.from({ length: chapter }, (_unused, idx) => ({
        number: idx + 1,
        title: `Ch${idx + 1}`,
        status: "approved",
      }));
      await writeFile(join(chaptersDir, "index.json"), JSON.stringify(indexRows, null, 2), "utf-8");
      await writeFile(join(chaptersDir, `${String(chapter).padStart(4, "0")}_Ch${chapter}.md`), `# Chapter ${chapter}\n\nBody ${chapter}.`, "utf-8");

      await Promise.all([
        writeFile(join(stateDir, "manifest.json"), JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedChapter: chapter,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2), "utf-8"),
        writeFile(join(stateDir, "current_state.json"), JSON.stringify({
          chapter,
          facts: [],
        }, null, 2), "utf-8"),
        writeFile(join(stateDir, "hooks.json"), JSON.stringify({
          hooks: [
            {
              hookId: "mentor-debt",
              startChapter: 1,
              type: "relationship",
              status: chapter > 1 ? "progressing" : "open",
              lastAdvancedChapter: chapter,
              expectedPayoff: "Resolve the debt pressure.",
              notes: `Debt clue ${chapter}.`,
            },
          ],
        }, null, 2), "utf-8"),
        writeFile(join(stateDir, "chapter_summaries.json"), JSON.stringify({
          rows: Array.from({ length: chapter }, (_unused, idx) => ({
            chapter: idx + 1,
            title: `Chapter ${idx + 1}`,
            characters: "Lin Yue",
            events: `Event ${idx + 1}`,
            stateChanges: `State ${idx + 1}`,
            hookActivity: "mentor-debt advanced",
            mood: "tense",
            chapterType: "mainline",
          })),
        }, null, 2), "utf-8"),
      ]);

      await (runner as unknown as {
        syncCurrentStateFactHistory: (targetBookId: string, uptoChapter: number) => Promise<void>;
      }).syncCurrentStateFactHistory(bookId, chapter);
      await (runner as unknown as {
        syncNarrativeMemoryIndex: (targetBookId: string) => Promise<void>;
      }).syncNarrativeMemoryIndex(bookId);
    }

    const store = FakeMemoryDB.stores.get(bookDir);
    expect(store?.resetFactsCalls).toBe(1);
    expect(store?.replaceSummariesCalls).toBe(1);
    expect(store?.replaceHooksCalls).toBe(1);
    expect(store?.upsertSummaryCalls ?? 0).toBeGreaterThanOrEqual(chapterCount - 1);
    expect(store?.upsertHookCalls ?? 0).toBeGreaterThanOrEqual(chapterCount - 1);
    expect(store?.facts.filter((fact) => fact.validUntilChapter == null)).toEqual([
      expect.objectContaining({
        sourceChapter: chapterCount,
        object: `Conflict ${chapterCount}`,
      }),
    ]);
  }, 20_000);
});
