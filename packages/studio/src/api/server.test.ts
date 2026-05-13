import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const schedulerStartMock = vi.fn<() => Promise<void>>();
const initBookMock = vi.fn();
const runRadarMock = vi.fn();
const reviseDraftMock = vi.fn();
const auditDraftMock = vi.fn();
const resyncChapterArtifactsMock = vi.fn();
const writeNextChapterMock = vi.fn();
const auditChapterMock = vi.fn();
const rollbackToChapterMock = vi.fn();
const rollbackToChapterWithoutSnapshotMock = vi.fn();
const getNextChapterNumberMock = vi.fn();
const saveChapterIndexMock = vi.fn();
const loadChapterIndexMock = vi.fn();
const loadBookConfigMock = vi.fn();
const createLLMClientMock = vi.fn(() => ({}));
const chatCompletionMock = vi.fn();
const loadProjectConfigMock = vi.fn();
const readVolumeMapMock = vi.fn(async (bookDir: string) => {
  const newPath = join(bookDir, "story", "outline", "volume_map.md");
  const legacyPath = join(bookDir, "story", "volume_outline.md");
  const newContent = await readFile(newPath, "utf-8").catch(() => "");
  if (newContent.trim()) return newContent;
  return readFile(legacyPath, "utf-8").catch(() => "");
});
const extractChapterLimitFromOutlineMock = vi.fn((outline: string) => {
  const chinese: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    两: 2,
  };
  const parseToken = (token: string): number | null => {
    const raw = token.trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    if (raw === "十") return 10;
    if (raw.length === 1 && raw in chinese) return chinese[raw] ?? null;
    const match = raw.match(/^([一二三四五六七八九两])?十([一二三四五六七八九两])?$/);
    if (match) {
      const tens = match[1] ? (chinese[match[1]] ?? 0) : 1;
      const ones = match[2] ? (chinese[match[2]] ?? 0) : 0;
      return tens * 10 + ones;
    }
    return null;
  };

  const total = outline.match(/(?:共|总(?:章数|计)|章节总数|总章节数)\s*([零〇一二三四五六七八九十两\d]+)\s*章?/);
  if (total) {
    return parseToken(total[1] ?? "");
  }
  const range = outline.match(/第\s*([零〇一二三四五六七八九十两\d]+)\s*[-~–—至到]\s*([零〇一二三四五六七八九十两\d]+)\s*章/);
  if (range) {
    return parseToken(range[2] ?? "");
  }
  return null;
});
const pipelineConfigs: unknown[] = [];
const processProjectInteractionInputMock = vi.fn();
const processProjectInteractionRequestMock = vi.fn();
const createInteractionToolsFromDepsMock = vi.fn(() => ({}));
const loadProjectSessionMock = vi.fn();
const resolveSessionActiveBookMock = vi.fn();
const runAgentSessionMock = vi.fn();
const createAndPersistBookSessionMock = vi.fn();
const loadBookSessionMock = vi.fn();
const persistBookSessionMock = vi.fn();
const appendBookSessionMessageMock = vi.fn();
const upsertBookSessionMessageMock = vi.fn();
const renameBookSessionMock = vi.fn();
const deleteBookSessionMock = vi.fn();
const migrateBookSessionMock = vi.fn();
const resolveServiceModelMock = vi.fn();
const loadSecretsMock = vi.fn();
const saveSecretsMock = vi.fn();
const getServiceApiKeyMock = vi.fn();
const computeAnalyticsMock = vi.fn(() => ({}));
const initialDestructiveRewriteEnv = process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE;
const initialUnifiedReviewLoopEnv = process.env.INKOS_UNIFIED_REVIEW_LOOP;
type ServicePresetMock = {
  providerFamily: "openai" | "anthropic";
  baseUrl: string;
  modelsBaseUrl?: string;
  knownModels: string[];
};
const SERVICE_PRESETS_MOCK: Record<string, ServicePresetMock> = {
  openai: { providerFamily: "openai", baseUrl: "https://api.openai.com/v1", modelsBaseUrl: "https://api.openai.com/v1", knownModels: [] as string[] },
  anthropic: { providerFamily: "anthropic", baseUrl: "https://api.anthropic.com", modelsBaseUrl: "https://api.anthropic.com", knownModels: [] as string[] },
  minimax: { providerFamily: "anthropic", baseUrl: "https://api.minimaxi.com/anthropic", modelsBaseUrl: "https://api.minimaxi.com/anthropic", knownModels: [] as string[] },
  bailian: { providerFamily: "anthropic", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic", modelsBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", knownModels: [] as string[] },
  custom: { providerFamily: "openai", baseUrl: "", knownModels: [] as string[] },
};
const resolveServicePresetMock = vi.fn((service: string) => SERVICE_PRESETS_MOCK[service]);
const resolveServiceProviderFamilyMock = vi.fn((service: string) => resolveServicePresetMock(service)?.providerFamily);
const resolveServiceModelsBaseUrlMock = vi.fn((service: string) => {
  const preset = SERVICE_PRESETS_MOCK[service];
  return preset?.modelsBaseUrl ?? preset?.baseUrl;
});
const listModelsForServiceMock = vi.fn(async (service: string, apiKey?: string) => {
  const preset = resolveServicePresetMock(service);
  if (!preset || service === "custom") return [];
  if (preset.knownModels.length > 0) {
    return preset.knownModels.map((id) => ({ id, name: id, reasoning: false, contextWindow: 0 }));
  }
  const modelsBaseUrl = resolveServiceModelsBaseUrlMock(service);
  if (!apiKey || !modelsBaseUrl) return [];
  const res = await fetch(`${modelsBaseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const json = await res.json() as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((model) => ({
    id: model.id,
    name: model.id,
    reasoning: false,
    contextWindow: 0,
  }));
});

const logger = {
  child: () => logger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@actalk/inkos-core", () => {
  class MockSessionAlreadyMigratedError extends Error {
    constructor(message = "Session already migrated") {
      super(message);
      this.name = "SessionAlreadyMigratedError";
    }
  }

  class MockStateManager {
    constructor(private readonly root: string) {}

    async listBooks(): Promise<string[]> {
      return [];
    }

    async loadBookConfig(): Promise<never> {
      return await loadBookConfigMock() as never;
    }

    async loadChapterIndex(bookId: string): Promise<[]> {
      return (await loadChapterIndexMock(bookId)) as [];
    }

    async saveChapterIndex(bookId: string, index: unknown): Promise<void> {
      await saveChapterIndexMock(bookId, index);
    }

    async rollbackToChapter(bookId: string, chapterNumber: number): Promise<number[]> {
      return (await rollbackToChapterMock(bookId, chapterNumber)) as number[];
    }

    async rollbackToChapterWithoutSnapshot(bookId: string, chapterNumber: number): Promise<number[]> {
      return (await rollbackToChapterWithoutSnapshotMock(bookId, chapterNumber)) as number[];
    }

    async getNextChapterNumber(bookId: string): Promise<number> {
      const next = await getNextChapterNumberMock(bookId);
      if (typeof next === "number" && Number.isFinite(next)) return next;
      return 1;
    }

    async ensureControlDocuments(): Promise<void> {
      // no-op in tests
    }

    bookDir(id: string): string {
      return join(this.root, "books", id);
    }
  }

  class MockPipelineRunner {
    constructor(config: unknown) {
      pipelineConfigs.push(config);
    }

    initBook = initBookMock;
    runRadar = runRadarMock;
    reviseDraft = reviseDraftMock;
    auditDraft = auditDraftMock;
    resyncChapterArtifacts = resyncChapterArtifactsMock;
    writeNextChapter = writeNextChapterMock;
  }

  class MockScheduler {
    private running = false;

    constructor(_config: unknown) {}

    async start(): Promise<void> {
      this.running = true;
      await schedulerStartMock();
    }

    stop(): void {
      this.running = false;
    }

    get isRunning(): boolean {
      return this.running;
    }
  }

  class MockContinuityAuditor {
    constructor(_config: unknown) {}

    auditChapter = auditChapterMock;
  }

  return {
    StateManager: MockStateManager,
    PipelineRunner: MockPipelineRunner,
    Scheduler: MockScheduler,
    ContinuityAuditor: MockContinuityAuditor,
    createLLMClient: createLLMClientMock,
    createLogger: vi.fn(() => logger),
    computeAnalytics: computeAnalyticsMock,
    chatCompletion: chatCompletionMock,
    loadProjectConfig: loadProjectConfigMock,
    processProjectInteractionInput: processProjectInteractionInputMock,
    processProjectInteractionRequest: processProjectInteractionRequestMock,
    createInteractionToolsFromDeps: createInteractionToolsFromDepsMock,
    loadProjectSession: loadProjectSessionMock,
    resolveSessionActiveBook: resolveSessionActiveBookMock,
    runAgentSession: runAgentSessionMock,
    buildAgentSystemPrompt: vi.fn(() => "You are helpful."),
    createAndPersistBookSession: createAndPersistBookSessionMock,
    loadBookSession: loadBookSessionMock,
    persistBookSession: persistBookSessionMock,
    appendBookSessionMessage: appendBookSessionMessageMock,
    upsertBookSessionMessage: upsertBookSessionMessageMock,
    renameBookSession: renameBookSessionMock,
    deleteBookSession: deleteBookSessionMock,
    migrateBookSession: migrateBookSessionMock,
    SessionAlreadyMigratedError: MockSessionAlreadyMigratedError,
    resolveServicePreset: resolveServicePresetMock,
    resolveServiceProviderFamily: resolveServiceProviderFamilyMock,
    resolveServiceModelsBaseUrl: resolveServiceModelsBaseUrlMock,
    resolveServiceModel: resolveServiceModelMock,
    loadSecrets: loadSecretsMock,
    saveSecrets: saveSecretsMock,
    getServiceApiKey: getServiceApiKeyMock,
    listModelsForService: listModelsForServiceMock,
    readVolumeMap: readVolumeMapMock,
    extractChapterLimitFromOutline: extractChapterLimitFromOutlineMock,
    InteractionRequestSchema: { parse: (value: unknown) => value },
    GLOBAL_ENV_PATH: join(tmpdir(), "inkos-global.env"),
  };
});

const projectConfig = {
  name: "studio-test",
  version: "0.1.0",
  language: "zh",
  llm: {
    provider: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "gpt-5.4",
    temperature: 0.7,
    maxTokens: 4096,
    stream: false,
  },
  daemon: {
    schedule: {
      radarCron: "0 */6 * * *",
      writeCron: "*/15 * * * *",
    },
    maxConcurrentBooks: 1,
    chaptersPerCycle: 1,
    retryDelayMs: 30000,
    cooldownAfterChapterMs: 0,
    maxChaptersPerDay: 50,
  },
  modelOverrides: {},
  notify: [],
} as const;

function cloneProjectConfig() {
  return structuredClone(projectConfig);
}

interface ParsedSSEEvent {
  event: string;
  data: unknown;
}

async function collectSSEEvents(
  response: Response,
  wantedEvents: ReadonlyArray<string>,
  options?: { timeoutMs?: number; minCount?: number },
): Promise<ParsedSSEEvent[]> {
  const body = response.body;
  if (!body) throw new Error("SSE response body is missing");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const wanted = new Set(wantedEvents);
  const minCount = options?.minCount ?? wantedEvents.length;
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const startedAt = Date.now();
  const collected: ParsedSSEEvent[] = [];
  let buffer = "";

  try {
    while (Date.now() - startedAt < timeoutMs && collected.length < minCount) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("SSE read timeout")), Math.max(1, remainingMs));
        }),
      ]);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });

      let splitIdx = buffer.indexOf("\n\n");
      while (splitIdx >= 0) {
        const frame = buffer.slice(0, splitIdx);
        buffer = buffer.slice(splitIdx + 2);
        splitIdx = buffer.indexOf("\n\n");

        const lines = frame.split(/\r?\n/);
        let event = "";
        let dataRaw = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice("event:".length).trim();
          else if (line.startsWith("data:")) dataRaw += line.slice("data:".length).trim();
        }
        if (!event || !wanted.has(event) || !dataRaw) continue;

        try {
          collected.push({ event, data: JSON.parse(dataRaw) });
        } catch {
          // ignore malformed json payloads
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return collected;
}

describe("createStudioServer daemon lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-server-"));
    process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE = "true";
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    schedulerStartMock.mockReset();
    initBookMock.mockReset();
    runRadarMock.mockReset();
    reviseDraftMock.mockReset();
    auditDraftMock.mockReset();
    resyncChapterArtifactsMock.mockReset();
    writeNextChapterMock.mockReset();
    auditChapterMock.mockReset();
    rollbackToChapterMock.mockReset();
    rollbackToChapterWithoutSnapshotMock.mockReset();
    getNextChapterNumberMock.mockReset();
    saveChapterIndexMock.mockReset();
    loadChapterIndexMock.mockReset();
    loadBookConfigMock.mockReset();
    readVolumeMapMock.mockClear();
    await mkdir(join(root, "books", "demo-book", "chapters"), { recursive: true });
    await writeFile(join(root, "books", "demo-book", "chapters", "0003_Demo.md"), "# Demo\n\nBody", "utf-8");
    runRadarMock.mockResolvedValue({
      marketSummary: "Fresh market summary",
      recommendations: [],
    });
    reviseDraftMock.mockResolvedValue({
      chapterNumber: 3,
      wordCount: 1800,
      fixedIssues: ["focus restored"],
      applied: true,
      status: "ready-for-review",
    });
    auditDraftMock.mockResolvedValue({
      chapterNumber: 3,
      passed: true,
      issues: [],
      summary: "ok",
    });
    resyncChapterArtifactsMock.mockResolvedValue({
      chapterNumber: 3,
      title: "Synced Chapter",
      wordCount: 1800,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "synced" },
    });
    writeNextChapterMock.mockResolvedValue({
      chapterNumber: 3,
      title: "Rewritten Chapter",
      wordCount: 1800,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "rewritten" },
    });
    auditChapterMock.mockResolvedValue({
      passed: true,
      issues: [],
      summary: "ok",
    });
    createLLMClientMock.mockReset();
    createLLMClientMock.mockReturnValue({});
    chatCompletionMock.mockReset();
    chatCompletionMock.mockResolvedValue({
      content: "pong",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    loadProjectConfigMock.mockReset();
    processProjectInteractionInputMock.mockReset();
    processProjectInteractionRequestMock.mockReset();
    createInteractionToolsFromDepsMock.mockReset();
    loadProjectSessionMock.mockReset();
    resolveSessionActiveBookMock.mockReset();
    createInteractionToolsFromDepsMock.mockReturnValue({});
    processProjectInteractionRequestMock.mockResolvedValue({
      request: { intent: "create_book" },
      session: {
        sessionId: "session-structured",
        projectRoot: root,
        activeBookId: "new-book",
        automationMode: "semi",
        messages: [],
        events: [],
      },
      details: {
        bookId: "new-book",
        outputPath: join(root, "books", "demo-book", "demo-book.txt"),
        chaptersExported: 2,
      },
    });
    loadProjectSessionMock.mockResolvedValue({
      sessionId: "session-1",
      projectRoot: root,
      automationMode: "semi",
      messages: [],
    });
    resolveSessionActiveBookMock.mockResolvedValue(undefined);
    loadProjectConfigMock.mockImplementation(async () => {
      const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, unknown>;
      return {
        ...cloneProjectConfig(),
        ...raw,
        llm: {
          ...cloneProjectConfig().llm,
          ...((raw.llm ?? {}) as Record<string, unknown>),
        },
        daemon: {
          ...cloneProjectConfig().daemon,
          ...((raw.daemon ?? {}) as Record<string, unknown>),
        },
        modelOverrides: (raw.modelOverrides ?? {}) as Record<string, unknown>,
        notify: (raw.notify ?? []) as unknown[],
      };
    });
    loadChapterIndexMock.mockResolvedValue([]);
    loadBookConfigMock.mockResolvedValue({
      id: "demo-book",
      title: "Demo Book",
      platform: "qidian",
      genre: "xuanhuan",
      status: "active",
      targetChapters: 100,
      chapterWordCount: 3000,
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
    });
    saveChapterIndexMock.mockResolvedValue(undefined);
    rollbackToChapterMock.mockResolvedValue([]);
    rollbackToChapterWithoutSnapshotMock.mockResolvedValue([]);
    getNextChapterNumberMock.mockResolvedValue(1);
    pipelineConfigs.length = 0;
    runAgentSessionMock.mockReset();
    createAndPersistBookSessionMock.mockReset();
    loadBookSessionMock.mockReset();
    persistBookSessionMock.mockReset();
    appendBookSessionMessageMock.mockReset();
    upsertBookSessionMessageMock.mockReset();
    renameBookSessionMock.mockReset();
    deleteBookSessionMock.mockReset();
    migrateBookSessionMock.mockReset();
    resolveServiceModelMock.mockReset();
    loadSecretsMock.mockReset();
    saveSecretsMock.mockReset();
    getServiceApiKeyMock.mockReset();
    computeAnalyticsMock.mockReset();
    computeAnalyticsMock.mockReturnValue({});
    resolveServicePresetMock.mockClear();
    resolveServiceProviderFamilyMock.mockClear();
    resolveServiceModelsBaseUrlMock.mockClear();
    listModelsForServiceMock.mockClear();
    extractChapterLimitFromOutlineMock.mockClear();
    // Default BookSession for agent tests
    const defaultBookSession = {
      sessionId: "agent-session-1",
      bookId: "demo-book",
      title: null,
      messages: [],
      events: [],
      draftRounds: [],
      createdAt: 1,
      updatedAt: 1,
    };
    createAndPersistBookSessionMock.mockResolvedValue(defaultBookSession);
    loadBookSessionMock.mockResolvedValue(defaultBookSession);
    persistBookSessionMock.mockResolvedValue(undefined);
    appendBookSessionMessageMock.mockImplementation((session: any, msg: any) => ({
      ...session,
      messages: [...(session.messages ?? []), msg].sort((left: any, right: any) => left.timestamp - right.timestamp),
      updatedAt: Date.now(),
    }));
    upsertBookSessionMessageMock.mockImplementation((session: any, msg: any) => {
      const index = (session.messages ?? []).findIndex(
        (entry: any) => entry.role === msg.role && entry.timestamp === msg.timestamp,
      );
      const messages = index >= 0
        ? (session.messages ?? []).map((entry: any, entryIndex: number) => (entryIndex === index ? { ...entry, ...msg } : entry))
        : [...(session.messages ?? []), msg];
      return {
        ...session,
        messages: messages.sort((left: any, right: any) => left.timestamp - right.timestamp),
        updatedAt: Date.now(),
      };
    });
    renameBookSessionMock.mockResolvedValue(null);
    deleteBookSessionMock.mockResolvedValue(undefined);
    migrateBookSessionMock.mockImplementation(async (_root: string, _sessionId: string, bookId: string) => ({
      ...defaultBookSession,
      bookId,
    }));
    runAgentSessionMock.mockResolvedValue({
      responseText: "Agent response.",
      messages: [],
    });
    loadSecretsMock.mockResolvedValue({ services: {} });
    saveSecretsMock.mockResolvedValue(undefined);
    getServiceApiKeyMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(join(tmpdir(), "inkos-global.env"), { force: true });
    if (initialDestructiveRewriteEnv === undefined) {
      delete process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE;
    } else {
      process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE = initialDestructiveRewriteEnv;
    }
    if (initialUnifiedReviewLoopEnv === undefined) {
      delete process.env.INKOS_UNIFIED_REVIEW_LOOP;
    } else {
      process.env.INKOS_UNIFIED_REVIEW_LOOP = initialUnifiedReviewLoopEnv;
    }
  });

  it("returns from /api/daemon/start before the first write cycle finishes", async () => {
    let resolveStart: (() => void) | undefined;
    schedulerStartMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const responseOrTimeout = await Promise.race([
      app.request("http://localhost/api/v1/daemon/start", { method: "POST" }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 120)),
    ]);

    expect(responseOrTimeout).not.toBe("timeout");

    const response = responseOrTimeout as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, running: true });

    const status = await app.request("http://localhost/api/v1/daemon");
    await expect(status.json()).resolves.toEqual({ running: true });

    resolveStart?.();
  });

  it("rejects book routes with path traversal ids", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/..%2Fetc%2Fpasswd", {
      method: "GET",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_BOOK_ID",
        message: 'Invalid book ID: "../etc/passwd"',
      },
    });
  });

  it("allows reading and updating fixed control truth files", async () => {
    const bookDir = join(root, "books", "demo-book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "author_intent.md"), "# Author Intent\n\nStay cold.\n", "utf-8"),
      writeFile(join(storyDir, "current_focus.md"), "# Current Focus\n\nReturn to the old case.\n", "utf-8"),
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const readAuthorIntent = await app.request("http://localhost/api/v1/books/demo-book/truth/author_intent.md");
    expect(readAuthorIntent.status).toBe(200);
    await expect(readAuthorIntent.json()).resolves.toMatchObject({
      file: "author_intent.md",
      content: "# Author Intent\n\nStay cold.\n",
    });

    const updateCurrentFocus = await app.request("http://localhost/api/v1/books/demo-book/truth/current_focus.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Current Focus\n\nPull focus back to the harbor trail.\n" }),
    });
    expect(updateCurrentFocus.status).toBe(200);

    await expect(readFile(join(storyDir, "current_focus.md"), "utf-8")).resolves.toBe(
      "# Current Focus\n\nPull focus back to the harbor trail.\n",
    );
  });

  it("reflects project edits immediately without restarting the studio server", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const save = await app.request("http://localhost/api/v1/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "en",
        temperature: 0.2,
        maxTokens: 2048,
        stream: true,
      }),
    });

    expect(save.status).toBe(200);

    const project = await app.request("http://localhost/api/v1/project");
    await expect(project.json()).resolves.toMatchObject({
      language: "en",
      temperature: 0.2,
      maxTokens: 2048,
      stream: true,
    });
  });

  it("reloads latest llm config for doctor checks without restarting the studio server", async () => {
    const startupConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "stale-model",
        baseUrl: "https://stale.example.com/v1",
      },
    };

    const freshConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "fresh-model",
        baseUrl: "https://fresh.example.com/v1",
      },
    };
    loadProjectConfigMock.mockResolvedValue(freshConfig);

    // Stub /models so probe doesn't hit the real OpenAI endpoint and short-circuit on 401.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(startupConfig as never, root);

    const response = await app.request("http://localhost/api/v1/doctor");

    expect(response.status).toBe(200);
    expect(createLLMClientMock).toHaveBeenCalledWith(expect.objectContaining({
      model: "fresh-model",
      baseUrl: "https://fresh.example.com/v1",
    }));
    expect(chatCompletionMock).toHaveBeenCalledWith(
      expect.anything(),
      "fresh-model",
      expect.any(Array),
      expect.objectContaining({ maxTokens: expect.any(Number) }),
    );
  });

  it("auto-falls back to a non-stream probe in doctor checks when the first transport returns empty", async () => {
    const freshConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "claude-sonnet-4-6",
        baseUrl: "https://timesniper.club",
        stream: true,
        apiFormat: "chat",
      },
    };
    loadProjectConfigMock.mockResolvedValue(freshConfig);
    // Stub /models so probe doesn't hit the real OpenAI endpoint and short-circuit on 401.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockImplementation(async (client: any) => {
      if (client.stream === false) {
        return {
          content: "pong",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
      throw new Error("LLM returned empty response from stream");
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(freshConfig as never, root);

    const response = await app.request("http://localhost/api/v1/doctor");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      llmConnected: true,
    });
    expect(createLLMClientMock).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      apiFormat: "chat",
    }));
    expect(createLLMClientMock).toHaveBeenCalledWith(expect.objectContaining({
      stream: false,
      apiFormat: "chat",
    }));
  });

  it("reloads latest llm config for radar scans without restarting the studio server", async () => {
    const startupConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "stale-model",
        baseUrl: "https://stale.example.com/v1",
      },
    };

    const freshConfig = {
      ...cloneProjectConfig(),
      llm: {
        ...cloneProjectConfig().llm,
        model: "fresh-model",
        baseUrl: "https://fresh.example.com/v1",
      },
    };
    loadProjectConfigMock.mockResolvedValue(freshConfig);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(startupConfig as never, root);

    const response = await app.request("http://localhost/api/v1/radar/scan", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(runRadarMock).toHaveBeenCalledTimes(1);
    expect(pipelineConfigs.at(-1)).toMatchObject({
      model: "fresh-model",
      defaultLLMConfig: expect.objectContaining({
        model: "fresh-model",
        baseUrl: "https://fresh.example.com/v1",
      }),
    });
  });

  it("updates the first-run language immediately after the language selector saves", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const save = await app.request("http://localhost/api/v1/project/language", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "en" }),
    });

    expect(save.status).toBe(200);

    const project = await app.request("http://localhost/api/v1/project");
    await expect(project.json()).resolves.toMatchObject({
      language: "en",
      languageExplicit: true,
    });
  });

  it("merges service config patches instead of overwriting existing services", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          { service: "moonshot", temperature: 1, maxTokens: 4096, apiFormat: "chat", stream: true },
          { service: "custom", name: "内网GPT", baseUrl: "https://llm.internal.corp/v1", temperature: 0.9, apiFormat: "responses", stream: false },
        ],
        defaultModel: "kimi-k2.5",
      },
    }, null, 2), "utf-8");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const save = await app.request("http://localhost/api/v1/services/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        services: {
          moonshot: {
            temperature: 0.5,
            maxTokens: 2048,
            apiFormat: "responses",
            stream: false,
          },
        },
      }),
    });

    expect(save.status).toBe(200);

    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(raw.llm.services).toEqual([
      { service: "moonshot", temperature: 0.5, maxTokens: 2048, apiFormat: "responses", stream: false },
      { service: "custom", name: "内网GPT", baseUrl: "https://llm.internal.corp/v1", temperature: 0.9, apiFormat: "responses", stream: false },
    ]);
  });

  it("reports config source and detected env overrides for Studio switching", async () => {
    await writeFile(join(root, ".env"), [
      "INKOS_LLM_PROVIDER=openai",
      "INKOS_LLM_BASE_URL=https://project.example.com/v1",
      "INKOS_LLM_MODEL=gpt-5.4",
      "INKOS_LLM_API_KEY=sk-project",
    ].join("\n"), "utf-8");
    await writeFile(join(tmpdir(), "inkos-global.env"), [
      "INKOS_LLM_PROVIDER=openai",
      "INKOS_LLM_BASE_URL=https://global.example.com/v1",
      "INKOS_LLM_MODEL=gpt-4o",
      "INKOS_LLM_API_KEY=sk-global",
    ].join("\n"), "utf-8");
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        ...projectConfig.llm,
        configSource: "env",
      },
    }, null, 2), "utf-8");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/config");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configSource: "env",
      envConfig: {
        effectiveSource: "project",
        project: {
          detected: true,
          baseUrl: "https://project.example.com/v1",
          model: "gpt-5.4",
          hasApiKey: true,
        },
        global: {
          detected: true,
          baseUrl: "https://global.example.com/v1",
          model: "gpt-4o",
          hasApiKey: true,
        },
      },
    });
  });

  it("allows switching config source without overwriting services", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          { service: "moonshot", temperature: 1, maxTokens: 4096 },
        ],
        defaultModel: "kimi-k2.5",
        configSource: "env",
      },
    }, null, 2), "utf-8");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const save = await app.request("http://localhost/api/v1/services/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configSource: "studio" }),
    });

    expect(save.status).toBe(200);

    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(raw.llm.configSource).toBe("studio");
    expect(raw.llm.services).toEqual([
      { service: "moonshot", temperature: 1, maxTokens: 4096 },
    ]);
    expect(raw.llm.defaultModel).toBe("kimi-k2.5");
  });

  it("syncs llm.model when services config updates defaultModel", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        ...projectConfig.llm,
        model: "old-model",
      },
    }, null, 2), "utf-8");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const save = await app.request("http://localhost/api/v1/services/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "new-model" }),
    });

    expect(save.status).toBe(200);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(raw.llm.defaultModel).toBe("new-model");
    expect(raw.llm.model).toBe("new-model");
  });

  it("tests and lists models for custom services using baseUrl and stored config", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          { service: "custom", name: "内网GPT", baseUrl: "https://llm.internal.corp/v1" },
        ],
        defaultModel: "corp-chat",
      },
    }, null, 2), "utf-8");
    loadSecretsMock.mockResolvedValue({
      services: {
        "custom:内网GPT": { apiKey: "sk-corp" },
      },
    });
    getServiceApiKeyMock.mockResolvedValue("sk-corp");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "corp-chat" }] }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "corp-chat" }] }),
      });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const testResponse = await app.request("http://localhost/api/v1/services/custom%3A%E5%86%85%E7%BD%91GPT/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-corp", baseUrl: "https://llm.internal.corp/v1" }),
    });
    expect(testResponse.status).toBe(200);
    await expect(testResponse.json()).resolves.toMatchObject({
      ok: true,
      models: [{ id: "corp-chat", name: "corp-chat" }],
    });

    const modelsResponse = await app.request("http://localhost/api/v1/services/custom%3A%E5%86%85%E7%BD%91GPT/models");
    expect(modelsResponse.status).toBe(200);
    await expect(modelsResponse.json()).resolves.toMatchObject({
      models: [{ id: "corp-chat", name: "corp-chat" }],
    });
  });

  it("auto-detects a working custom combination when /models is unavailable", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        configSource: "env",
        services: [
          { service: "custom", name: "MiniMax", baseUrl: "https://api.minimax.com/v1" },
        ],
      },
    }, null, 2), "utf-8");
    await writeFile(join(root, ".env"), [
      "INKOS_LLM_MODEL=MiniMax-M2.7",
      "INKOS_LLM_BASE_URL=https://api.minimax.com/v1",
      "INKOS_LLM_API_KEY=sk-minimax",
    ].join("\n"), "utf-8");

    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockImplementation(async (client: any) => {
      if (client.apiFormat === "chat" && client.stream === false) {
        return {
          content: "pong",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
      throw new Error("LLM returned empty response from stream");
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "404 page not found",
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/custom%3AMiniMax/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-minimax",
        baseUrl: "https://api.minimax.com/v1",
        apiFormat: "chat",
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      selectedModel: "MiniMax-M2.7",
      detected: {
        apiFormat: "chat",
        stream: false,
        modelsSource: "fallback",
      },
      models: [],
    });
  });

  it("falls back to the detected/default model when custom /models is unavailable", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        defaultModel: "MiniMax-M2.7",
        services: [
          { service: "custom", name: "MiniMax", baseUrl: "https://api.minimax.com/v1", apiFormat: "chat", stream: false },
        ],
      },
    }, null, 2), "utf-8");
    getServiceApiKeyMock.mockResolvedValue("sk-minimax");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "404 page not found",
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockResolvedValue({
      content: "pong",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/custom%3AMiniMax/models");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [],
    });
  });

  it("short-circuits service probe on 401/403 from /models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-invalid",
        apiFormat: "responses",
        stream: false,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("401"),
    });
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("routes write-next with explicit service/model through selected runtime model", async () => {
    resolveServiceModelMock.mockResolvedValue({
      model: { id: "gpt-5.4", provider: "openai", api: "openai-responses" },
      apiKey: "sk-selected",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "openai", model: "gpt-5.4" }),
    });

    expect(response.status).toBe(200);
    expect(resolveServiceModelMock).toHaveBeenCalledWith(
      "openai",
      "gpt-5.4",
      root,
      expect.any(String),
      undefined,
    );
    expect(createLLMClientMock).toHaveBeenCalledWith(expect.objectContaining({
      service: "openai",
      model: "gpt-5.4",
      apiKey: "sk-selected",
    }));
    expect(pipelineConfigs.at(-1)).toMatchObject({
      model: "gpt-5.4",
    });
  });

  it("auto-switches reasoner model to a faster writer model for write-next and keeps quick mode disabled by default", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        ...projectConfig.llm,
        services: [
          {
            service: "openai",
            models: [
              { id: "deepseek-reasoner", enabled: true, source: "manual" },
              { id: "deepseek-chat", enabled: true, source: "manual" },
            ],
          },
        ],
      },
    }, null, 2), "utf-8");
    resolveServiceModelMock.mockResolvedValue({
      model: { id: "deepseek-chat", provider: "openai", api: "openai-responses" },
      apiKey: "sk-selected",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "openai", model: "deepseek-reasoner" }),
    });

    expect(response.status).toBe(200);
    expect(resolveServiceModelMock).toHaveBeenCalledWith(
      "openai",
      "deepseek-chat",
      root,
      expect.any(String),
      undefined,
    );
    expect(writeNextChapterMock).toHaveBeenCalledWith(
      "demo-book",
      undefined,
      undefined,
      expect.objectContaining({
        quickMode: false,
      }),
    );
  });

  it("does not trigger a second audit-revise loop in studio route after write-next", async () => {
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 3,
      title: "Auto Review Candidate",
      wordCount: 3096,
      revised: false,
      status: "audit-failed",
      auditResult: {
        passed: false,
        issues: [{ severity: "critical", category: "设定冲突", description: "关键设定冲突", suggestion: "统一设定" }],
        summary: "needs fix",
      },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    await Promise.resolve();
    expect(auditDraftMock).not.toHaveBeenCalled();
    expect(reviseDraftMock).not.toHaveBeenCalled();
  });

  it("emits write:complete with a normalized autoReview payload for write-next route", async () => {
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 3,
      title: "Auto Review Candidate",
      wordCount: 3096,
      revised: false,
      status: "ready-for-review",
      auditResult: {
        passed: true,
        issues: [],
        summary: "ok",
      },
      autoReview: {
        enabled: true,
        maxReviseRounds: 2,
        reviseRoundsUsed: 1,
        auditRounds: 2,
        stoppedByMaxRounds: false,
        finalState: "passed",
        revisions: [],
      },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const response = await app.request("http://localhost/api/v1/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(
      eventsResponse,
      ["write:complete"],
      { timeoutMs: 3_000, minCount: 1 },
    );
    const writeComplete = events.find((event) => event.event === "write:complete");
    expect(writeComplete?.data).toMatchObject({
      bookId: "demo-book",
      chapterNumber: 3,
      status: "ready-for-review",
      autoReview: {
        enabled: true,
        maxReviseRounds: 2,
        reviseRoundsUsed: 1,
        auditRounds: 2,
        stoppedByMaxRounds: false,
        finalState: "passed",
      },
    });
  });

  it("tests a single model connectivity with elapsed time", async () => {
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockResolvedValue({
      content: "pong",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models/gpt-5.4/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-openai",
        apiFormat: "responses",
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      model: string;
      canConnect: boolean;
      elapsedMs: number;
      apiFormat: string;
      stream: boolean;
    };
    expect(body).toMatchObject({
      ok: true,
      model: "gpt-5.4",
      canConnect: true,
      apiFormat: "responses",
      stream: false,
    });
    expect(body.elapsedMs).toBeGreaterThan(0);
  });

  it("uses stored service api key when single model test body omits apiKey", async () => {
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockResolvedValue({
      content: "pong",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    getServiceApiKeyMock.mockResolvedValue("sk-stored");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models/gpt-5.4/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiFormat: "chat",
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      model: "gpt-5.4",
      canConnect: true,
    });
    expect(getServiceApiKeyMock).toHaveBeenCalledWith(root, "openai");
  });

  it("returns auth_failed for single model test on 401", async () => {
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockRejectedValue(new Error("401 Unauthorized"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models/gpt-5.4/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-openai",
        apiFormat: "chat",
        stream: true,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      model: "gpt-5.4",
      canConnect: false,
      error: "auth_failed",
    });
  });

  it("returns auth_failed for single model test on 403", async () => {
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockRejectedValue(new Error("403 Forbidden"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models/gpt-5.4/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-openai",
        apiFormat: "chat",
        stream: false,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      model: "gpt-5.4",
      canConnect: false,
      error: "auth_failed",
    });
  });

  it("returns unsupported_model for single model test on 404", async () => {
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockRejectedValue(new Error("404 model not found"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models/not-exists/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-openai",
        apiFormat: "chat",
        stream: false,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      model: "not-exists",
      canConnect: false,
      error: "unsupported_model",
    });
  });

  it("returns timeout for single model test on timeout errors", async () => {
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models/gpt-5.4/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-openai",
        apiFormat: "responses",
        stream: true,
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error?: string; elapsedMs: number };
    expect(body.error).toBe("timeout");
    expect(body.elapsedMs).toBeGreaterThan(0);
  });

  it("uses the MiniMax preset provider family during service probe", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          { service: "minimax", apiFormat: "chat", stream: false },
        ],
        defaultModel: "MiniMax-M2.7",
      },
    }, null, 2), "utf-8");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "404 page not found",
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockImplementation(async (client: any, model: string) => {
      if (client.provider === "anthropic" && client.baseUrl === "https://api.minimaxi.com/anthropic" && model === "MiniMax-M2.7") {
        return {
          content: "pong",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
      throw new Error(`unexpected probe route: ${client.provider} ${client.baseUrl} ${model}`);
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/minimax/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-minimax",
        apiFormat: "chat",
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      selectedModel: "MiniMax-M2.7",
      detected: {
        apiFormat: "chat",
        stream: false,
        baseUrl: "https://api.minimaxi.com/anthropic",
      },
    });
  });

  it("uses the preset models baseUrl when listing Bailian models", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          { service: "bailian", apiFormat: "chat", stream: false },
        ],
        defaultModel: "qwen-max",
      },
    }, null, 2), "utf-8");
    getServiceApiKeyMock.mockResolvedValue("sk-bailian");

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://dashscope.aliyuncs.com/compatible-mode/v1/models") {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "qwen-max" }] }),
          text: async (): Promise<string> => "",
        };
      }
      return {
        ok: false,
        status: 404,
        text: async () => "404 page not found",
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    createLLMClientMock.mockImplementation(((cfg: unknown) => cfg) as any);
    chatCompletionMock.mockImplementation(async (client: any, model: string) => {
      if (client.provider === "anthropic" && client.baseUrl === "https://dashscope.aliyuncs.com/apps/anthropic" && model === "qwen-max") {
        return {
          content: "pong",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
      throw new Error(`unexpected bailian route: ${client.provider} ${client.baseUrl} ${model}`);
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/bailian/models");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [{ id: "qwen-max", name: "qwen-max" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
      expect.any(Object),
    );
  });

  it("keys cached model lists by baseUrl so custom endpoints do not leak stale results", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          { service: "custom", name: "Switcher", baseUrl: "https://a.example.com/v1" },
        ],
      },
    }, null, 2), "utf-8");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://a.example.com/v1/models") {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "model-a" }] }),
          text: async () => "",
        };
      }
      if (url === "https://b.example.com/v1/models") {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "model-b" }] }),
          text: async () => "",
        };
      }
      return {
        ok: false,
        status: 404,
        text: async () => "404 page not found",
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const first = await app.request("http://localhost/api/v1/services/custom%3ASwitcher/models?apiKey=sk-shared-tail");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      models: [{ id: "model-a", name: "model-a" }],
    });

    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          { service: "custom", name: "Switcher", baseUrl: "https://b.example.com/v1" },
        ],
      },
    }, null, 2), "utf-8");

    const second = await app.request("http://localhost/api/v1/services/custom%3ASwitcher/models?apiKey=sk-shared-tail");
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      models: [{ id: "model-b", name: "model-b" }],
    });
  });

  it("merges manual and detected models in hybrid mode", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          {
            service: "openai",
            modelMode: "hybrid",
            models: [
              { id: "manual-prime", name: "Manual Prime", enabled: true, source: "manual" },
              { id: "manual-off", enabled: false, source: "manual" },
            ],
          },
        ],
      },
    }, null, 2), "utf-8");
    getServiceApiKeyMock.mockResolvedValue("sk-openai");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.4" }, { id: "manual-prime" }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      modelMode: "hybrid",
      models: [
        { id: "manual-prime", name: "Manual Prime", source: "manual" },
        { id: "gpt-5.4", name: "gpt-5.4", source: "detected" },
      ],
    });
  });

  it("returns manual models only when modelMode=manual", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          {
            service: "openai",
            modelMode: "manual",
            models: [
              { id: "manual-only", name: "Manual Only", enabled: true, source: "manual" },
            ],
          },
        ],
      },
    }, null, 2), "utf-8");
    getServiceApiKeyMock.mockResolvedValue("sk-openai");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.4" }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      modelMode: "manual",
      models: [{ id: "manual-only", name: "Manual Only", source: "manual" }],
    });
  });

  it("returns detected models only when source=auto is requested", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        services: [
          {
            service: "openai",
            modelMode: "hybrid",
            models: [
              { id: "manual-prime", name: "Manual Prime", enabled: true, source: "manual" },
            ],
          },
        ],
      },
    }, null, 2), "utf-8");
    getServiceApiKeyMock.mockResolvedValue("sk-openai");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.4" }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/openai/models?source=auto");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      modelMode: "hybrid",
      models: [{ id: "gpt-5.4", name: "gpt-5.4", source: "detected" }],
    });
  });

  it("returns stored service secret for detail page rehydration", async () => {
    loadSecretsMock.mockResolvedValue({
      services: {
        moonshot: { apiKey: "sk-moon" },
      },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/services/moonshot/secret");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ apiKey: "sk-moon" });
  });

  it("rejects create requests when a complete book with the same id already exists", async () => {
    await mkdir(join(root, "books", "existing-book", "story"), { recursive: true });
    await writeFile(join(root, "books", "existing-book", "book.json"), JSON.stringify({ id: "existing-book" }), "utf-8");
    await writeFile(join(root, "books", "existing-book", "story", "story_bible.md"), "# existing", "utf-8");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Existing Book",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Book "existing-book" already exists'),
    });
    expect(processProjectInteractionRequestMock).not.toHaveBeenCalled();
    await expect(access(join(root, "books", "existing-book", "story", "story_bible.md"))).resolves.toBeUndefined();
  });

  it("reports async create failures through the create-status endpoint", async () => {
    processProjectInteractionRequestMock.mockRejectedValueOnce(new Error("INKOS_LLM_API_KEY not set"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Broken Book",
        genre: "xuanhuan",
        platform: "qidian",
        language: "zh",
      }),
    });

    expect(response.status).toBe(200);
    await Promise.resolve();

    const status = await app.request("http://localhost/api/v1/books/broken-book/create-status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      status: "error",
      error: "INKOS_LLM_API_KEY not set",
    });
  });

  it("routes standalone audit through pipeline auditDraft", async () => {
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Broken Chapter",
        status: "audit-failed",
        wordCount: 1800,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: ["[warning] old issue"],
        lengthWarnings: [],
      },
    ]);
    auditDraftMock.mockResolvedValue({
      chapterNumber: 3,
      passed: true,
      issues: [],
      summary: "fixed",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(auditDraftMock).toHaveBeenCalledTimes(1);
    expect(auditDraftMock).toHaveBeenCalledWith("demo-book", 3);
    await expect(response.json()).resolves.toMatchObject({
      passed: true,
      summary: "fixed",
    });
  });

  it("keeps standalone audit endpoint available when chapter index is missing", async () => {
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 2,
        title: "Prev Chapter",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);
    auditDraftMock.mockResolvedValue({
      chapterNumber: 3,
      passed: true,
      issues: [],
      summary: "fixed",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(auditDraftMock).toHaveBeenCalledWith("demo-book", 3);
  });

  it("auto-revises up to two rounds when standalone audit keeps failing", async () => {
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Broken Chapter",
        status: "audit-failed",
        wordCount: 3200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        auditIssues: ["[critical] 关键设定冲突"],
      },
    ]);
    const failedAudit = {
      chapterNumber: 3,
      passed: false,
      issues: [
        { severity: "critical", category: "设定冲突", description: "关键设定冲突", suggestion: "统一设定" },
      ],
      summary: "存在关键冲突，需先修正后再审。",
    };
    auditDraftMock
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit);
    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 3010,
        fixedIssues: ["- 修复设定冲突段落"],
        applied: true,
        status: "audit-failed",
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 3042,
        fixedIssues: ["- 再次收束冲突表达"],
        applied: true,
        status: "audit-failed",
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      passed?: boolean;
      autoReview?: {
        enabled?: boolean;
        maxReviseRounds?: number;
        reviseRoundsUsed?: number;
        auditRounds?: number;
        stoppedByMaxRounds?: boolean;
        finalState?: string;
        stopReason?: string;
        revisions?: Array<{
          round?: number;
          fixedIssues?: string[];
          issueResolutions?: Array<{ issue?: string; outcome?: string }>;
        }>;
      };
    };
    expect(payload).toMatchObject({
      passed: false,
      autoReview: {
        enabled: true,
        maxReviseRounds: 2,
        reviseRoundsUsed: 2,
        auditRounds: 3,
        stoppedByMaxRounds: true,
        finalState: "failed-max-rounds",
        stopReason: "达到自动修订轮次上限，仍未通过审计",
      },
    });
    expect(payload.autoReview?.revisions?.[0]).toMatchObject({
      round: 1,
      fixedIssues: ["- 修复设定冲突段落"],
    });
    expect(payload.autoReview?.revisions?.[0]?.issueResolutions?.[0]).toMatchObject({
      issueId: "ISSUE-01",
      issue: expect.stringContaining("关键设定冲突"),
      outcome: "unresolved",
    });
    expect(payload.autoReview?.revisions?.[0]).toMatchObject({
      mustFixOutcomes: expect.arrayContaining([
        expect.objectContaining({
          issueId: "ISSUE-01",
          outcome: "unresolved",
        }),
      ]),
    });
    expect(saveChapterIndexMock).toHaveBeenCalledWith(
      "demo-book",
      expect.arrayContaining([
        expect.objectContaining({
          number: 3,
          reviewNote: expect.stringContaining("[auto-review-final]"),
        }),
      ]),
    );
    expect(auditDraftMock).toHaveBeenCalledTimes(3);
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      1,
      "demo-book",
      3,
      "spot-fix",
      expect.objectContaining({
        reviseContext: expect.objectContaining({
          failureGate: "critical",
          passScoreThreshold: expect.any(Number),
          issueClassCounts: expect.objectContaining({
            structural: expect.any(Number),
            textual: expect.any(Number),
          }),
          primaryIssueClass: expect.stringMatching(/^(none|structural|textual|mixed)$/),
        }),
      }),
    );
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      2,
      "demo-book",
      3,
      "spot-fix",
      expect.objectContaining({
        overrideIssues: expect.arrayContaining([
          expect.objectContaining({
            severity: "critical",
            description: "关键设定冲突",
          }),
        ]),
        reviseContext: expect.objectContaining({
          failureGate: "critical",
          passScoreThreshold: expect.any(Number),
          mustFixFirstIssueIds: expect.arrayContaining(["ISSUE-01"]),
          unresolvedIssueIdsFromPrevRound: expect.arrayContaining(["ISSUE-01"]),
          issueClassCounts: expect.objectContaining({
            structural: expect.any(Number),
            textual: expect.any(Number),
          }),
          primaryIssueClass: expect.stringMatching(/^(none|structural|textual|mixed)$/),
        }),
      }),
    );
  });

  it("escalates structural stagnation with stronger override issues and stop reason", async () => {
    process.env.INKOS_UNIFIED_REVIEW_LOOP = "true";
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...cloneProjectConfig(),
      autoReview: {
        enabled: true,
        maxReviseRounds: 2,
        reviseMode: "spot-fix",
      },
    }, null, 2), "utf-8");
    const structuralFailedAudit = {
      chapterNumber: 3,
      passed: false,
      issues: [
        {
          severity: "critical",
          category: "卷纲一致性",
          description: "大纲偏离：主线推进缺失，未承接卷纲冲突",
          suggestion: "回到卷纲主线推进并补齐冲突承接",
        },
        {
          severity: "warning",
          category: "状态卡一致性",
          description: "状态卡脱节：角色资源账本与正文行动不一致",
          suggestion: "按状态卡与资源账本重排行动成本与后果",
        },
      ],
      summary: "结构性问题持续存在",
    };
    auditDraftMock
      .mockResolvedValueOnce(structuralFailedAudit)
      .mockResolvedValueOnce(structuralFailedAudit)
      .mockResolvedValueOnce(structuralFailedAudit);
    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 3020,
        fixedIssues: [
          "[ISSUE-01] 尝试补回主线推进",
          "[ISSUE-02] 尝试对齐状态卡行动链",
        ],
        applied: true,
        status: "audit-failed",
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 3040,
        fixedIssues: ["- 局部句段替换"],
        applied: true,
        status: "audit-failed",
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      autoReview?: {
        finalState?: string;
        stopReason?: string;
      };
    };
    // The mocked audit payload can trigger adaptive max rounds; verify strategy escalation by early rounds.
    expect(payload.autoReview?.finalState === "passed" || payload.autoReview?.finalState === "failed-max-rounds").toBe(true);
    expect(reviseDraftMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      1,
      "demo-book",
      3,
      "rework",
      expect.objectContaining({
        reviseContext: expect.objectContaining({
          failureGate: "critical",
          passScoreThreshold: expect.any(Number),
        }),
      }),
    );
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      2,
      "demo-book",
      3,
      "rewrite",
      expect.objectContaining({
        overrideIssues: expect.arrayContaining([
          expect.objectContaining({
            category: "outline_alignment",
            severity: "critical",
            suggestion: expect.stringContaining("连续多轮未收敛"),
          }),
        ]),
      }),
    );
  });

  it("respects configurable stagnation threshold before forcing rewrite escalation", async () => {
    process.env.INKOS_UNIFIED_REVIEW_LOOP = "true";
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...cloneProjectConfig(),
      autoReview: {
        enabled: true,
        maxReviseRounds: 2,
        reviseMode: "polish",
        stagnation: {
          minUnresolvedStructuralIssues: 3,
          scoreDeltaThreshold: 1,
        },
      },
    }, null, 2), "utf-8");
    const structuralFailedAudit = {
      chapterNumber: 3,
      passed: false,
      issues: [
        {
          severity: "critical",
          category: "卷纲一致性",
          description: "大纲偏离：主线推进缺失，未承接卷纲冲突",
          suggestion: "回到卷纲主线推进并补齐冲突承接",
        },
        {
          severity: "warning",
          category: "状态卡一致性",
          description: "状态卡脱节：角色资源账本与正文行动不一致",
          suggestion: "按状态卡与资源账本重排行动成本与后果",
        },
      ],
      summary: "结构性问题持续存在",
    };
    auditDraftMock
      .mockResolvedValueOnce(structuralFailedAudit)
      .mockResolvedValueOnce(structuralFailedAudit)
      .mockResolvedValueOnce(structuralFailedAudit);
    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 3020,
        fixedIssues: [
          "[ISSUE-01] 尝试补回主线推进",
          "[ISSUE-02] 尝试对齐状态卡行动链",
        ],
        applied: true,
        status: "audit-failed",
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 3040,
        fixedIssues: ["- 局部句段替换"],
        applied: true,
        status: "audit-failed",
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(reviseDraftMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      1,
      "demo-book",
      3,
      "polish",
      expect.anything(),
    );
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      2,
      "demo-book",
      3,
      "polish",
      expect.anything(),
    );
  });

  it("auto-revises once and exits when second-round audit passes", async () => {
    const firstFailedAudit = {
      chapterNumber: 3,
      passed: false,
      issues: [
        { severity: "critical", category: "设定冲突", description: "关键设定冲突", suggestion: "统一设定" },
      ],
      summary: "first failed",
    };
    const secondPassedAudit = {
      chapterNumber: 3,
      passed: true,
      issues: [],
      summary: "fixed and passed",
    };
    auditDraftMock
      .mockResolvedValueOnce(firstFailedAudit)
      .mockResolvedValueOnce(secondPassedAudit);
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      wordCount: 3028,
      fixedIssues: ["[ISSUE-01] 已修复：统一设定冲突段落"],
      applied: true,
      status: "ready-for-review",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      passed?: boolean;
      autoReview?: {
        enabled?: boolean;
        maxReviseRounds?: number;
        reviseRoundsUsed?: number;
        auditRounds?: number;
        stoppedByMaxRounds?: boolean;
        finalState?: string;
        revisions?: Array<{
          issueResolutions?: Array<{ issueId?: string; outcome?: string; fixDelta?: string }>;
        }>;
      };
    };
    expect(payload).toMatchObject({
      passed: true,
      autoReview: {
        enabled: true,
        maxReviseRounds: 2,
        reviseRoundsUsed: 1,
        auditRounds: 2,
        stoppedByMaxRounds: false,
        finalState: "passed",
      },
    });
    expect(payload.autoReview?.revisions?.[0]?.issueResolutions?.[0]).toMatchObject({
      issueId: "ISSUE-01",
      outcome: "resolved",
      fixDelta: expect.stringContaining("统一设定冲突段落"),
    });
    expect(auditDraftMock).toHaveBeenCalledTimes(2);
    expect(reviseDraftMock).toHaveBeenCalledTimes(1);
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      1,
      "demo-book",
      3,
      "spot-fix",
      expect.objectContaining({
        reviseContext: expect.objectContaining({
          failureGate: "critical",
          passScoreThreshold: expect.any(Number),
          mustFixFirstIssueIds: expect.arrayContaining(["ISSUE-01"]),
        }),
      }),
    );
  });

  it("treats low-score audit as failed and enters auto-revise even when passed=true", async () => {
    const firstLowScoreAudit = {
      chapterNumber: 3,
      passed: true,
      issues: [
        { severity: "warning", category: "节奏", description: "节奏松散", suggestion: "收紧冲突线" },
        { severity: "warning", category: "人物", description: "动机表达偏弱", suggestion: "补强动机锚点" },
        { severity: "info", category: "文风", description: "措辞重复", suggestion: "替换重复表达" },
      ],
      summary: "形式通过，但分数偏低。",
    };
    const secondPassedAudit = {
      chapterNumber: 3,
      passed: true,
      issues: [],
      summary: "修订后通过",
    };
    auditDraftMock
      .mockResolvedValueOnce(firstLowScoreAudit)
      .mockResolvedValueOnce(secondPassedAudit);
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      wordCount: 3096,
      fixedIssues: [
        "[ISSUE-01] 已收紧节奏线",
        "[ISSUE-02] 已补强角色动机",
        "[ISSUE-03] 已去除重复措辞",
      ],
      applied: true,
      status: "ready-for-review",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      passed?: boolean;
      autoReview?: {
        reviseRoundsUsed?: number;
        auditRounds?: number;
        finalState?: string;
      };
    };
    expect(payload.passed).toBe(true);
    expect(payload.autoReview).toMatchObject({
      reviseRoundsUsed: 1,
      auditRounds: 2,
      finalState: "passed",
    });
    expect(auditDraftMock).toHaveBeenCalledTimes(2);
    expect(reviseDraftMock).toHaveBeenCalledTimes(1);
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      1,
      "demo-book",
      3,
      "spot-fix",
      expect.objectContaining({
        reviseContext: expect.objectContaining({
          failureGate: expect.any(String),
          mustFixFirstIssueIds: expect.any(Array),
        }),
      }),
    );
  });

  it("skips auto revise when autoReview.enabled is false", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...cloneProjectConfig(),
      autoReview: {
        enabled: false,
        maxReviseRounds: 2,
        reviseMode: "spot-fix",
      },
    }, null, 2), "utf-8");
    auditDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      passed: false,
      issues: [
        { severity: "warning", category: "节奏", description: "节奏偏平", suggestion: "补充起伏" },
      ],
      summary: "still weak",
    });
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Weak Chapter",
        status: "audit-failed",
        wordCount: 2870,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        auditIssues: ["[warning] 节奏偏平"],
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      passed: false,
      autoReview: {
        enabled: false,
        maxReviseRounds: 0,
        reviseRoundsUsed: 0,
        auditRounds: 1,
        stoppedByMaxRounds: false,
        finalState: "failed-single-audit",
      },
    });
    expect(saveChapterIndexMock).toHaveBeenCalledWith(
      "demo-book",
      expect.arrayContaining([
        expect.objectContaining({
          number: 3,
          reviewNote: expect.stringContaining("[auto-review-final]"),
        }),
      ]),
    );
    expect(auditDraftMock).toHaveBeenCalledTimes(1);
    expect(reviseDraftMock).not.toHaveBeenCalled();
  });

  it("disables unified review loop when INKOS_UNIFIED_REVIEW_LOOP=false", async () => {
    process.env.INKOS_UNIFIED_REVIEW_LOOP = "false";
    auditDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      passed: false,
      issues: [
        { severity: "warning", category: "节奏", description: "节奏偏平", suggestion: "补充起伏" },
      ],
      summary: "still weak",
    });
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Weak Chapter",
        status: "audit-failed",
        wordCount: 2870,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        auditIssues: ["[warning] 节奏偏平"],
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      passed: false,
      autoReview: {
        enabled: false,
        maxReviseRounds: 0,
        reviseRoundsUsed: 0,
        auditRounds: 1,
        stoppedByMaxRounds: false,
        finalState: "failed-single-audit",
      },
    });
    expect(auditDraftMock).toHaveBeenCalledTimes(1);
    expect(reviseDraftMock).not.toHaveBeenCalled();
  });

  it("returns default review metrics payload in analytics endpoint", async () => {
    computeAnalyticsMock.mockReturnValueOnce({
      bookId: "demo-book",
      totalChapters: 0,
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/analytics");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bookId: "demo-book",
      reviewMetrics: {
        fpr0: 0,
        fpr1: 0,
        failed_max_rounds_rate: 0,
        structural_ratio: 0,
        sample_size: 0,
      },
      reviewMetricsByEntry: {
        "write-next": { sample_size: 0 },
        "write-target": { sample_size: 0 },
        rewrite: { sample_size: 0 },
      },
    });
  });

  it("aggregates review metrics and buckets by entry in analytics endpoint", async () => {
    computeAnalyticsMock.mockReturnValue({
      bookId: "demo-book",
      totalChapters: 3,
    });

    writeNextChapterMock.mockImplementationOnce(async (bookId: string) => {
      const config = pipelineConfigs[pipelineConfigs.length - 1] as {
        onWriteNextAuditComplete?: (payload: {
          bookId: string;
          chapterNumber: number;
          round: number;
          maxReviseRounds: number;
          phase: "audit";
          audit: {
            passed: boolean;
            score: number;
            issueCount: number;
            severityCounts: { critical: number; warning: number; info: number };
            summary: string;
            issues: unknown[];
          };
        }) => void;
      } | undefined;
      config?.onWriteNextAuditComplete?.({
        bookId,
        chapterNumber: 4,
        round: 1,
        maxReviseRounds: 0,
        phase: "audit",
        audit: {
          passed: true,
          score: 92,
          issueCount: 0,
          severityCounts: { critical: 0, warning: 0, info: 0 },
          summary: "ok",
          issues: [],
        },
      });
      return {
        chapterNumber: 4,
        title: "New Chapter",
        wordCount: 2100,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      };
    });

    const failedAudit = {
      chapterNumber: 3,
      passed: false,
      issues: [
        { severity: "critical", category: "设定冲突", description: "关键设定冲突", suggestion: "统一设定" },
      ],
      summary: "failed",
    };
    auditDraftMock
      .mockResolvedValueOnce({ chapterNumber: 3, passed: true, issues: [], summary: "passed" })
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit);
    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 2001,
        fixedIssues: [],
        applied: true,
        status: "audit-failed",
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 2002,
        fixedIssues: [],
        applied: true,
        status: "audit-failed",
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 2003,
        fixedIssues: [],
        applied: true,
        status: "audit-failed",
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const writeResponse = await app.request("http://localhost/api/v1/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(writeResponse.status).toBe(200);

    const writeTargetAuditResponse = await app.request("http://localhost/api/v1/books/demo-book/audit/3", {
      method: "POST",
    });
    expect(writeTargetAuditResponse.status).toBe(200);

    const rewriteResponse = await app.request("http://localhost/api/v1/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "保持主线一致，修复设定冲突。" }),
    });
    expect(rewriteResponse.status).toBe(200);

    type AnalyticsMetricsPayload = {
      reviewMetrics?: {
        sample_size?: number;
        fpr0?: number;
        fpr1?: number;
        failed_max_rounds_rate?: number;
        structural_ratio?: number;
      };
      reviewMetricsByEntry?: Record<string, { sample_size?: number; failed_max_rounds_rate?: number; fpr0?: number }>;
    };
    let payload: AnalyticsMetricsPayload = {};

    for (let i = 0; i < 40; i += 1) {
      const analyticsResponse = await app.request("http://localhost/api/v1/books/demo-book/analytics");
      expect(analyticsResponse.status).toBe(200);
      payload = await analyticsResponse.json() as AnalyticsMetricsPayload;
      if ((payload?.reviewMetrics?.sample_size ?? 0) >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(payload?.reviewMetrics).toMatchObject({
      sample_size: 3,
      fpr0: 67,
      fpr1: 67,
      failed_max_rounds_rate: 33,
      structural_ratio: 100,
    });
    expect(payload?.reviewMetricsByEntry?.["write-next"]).toMatchObject({
      sample_size: 1,
      fpr0: 100,
      failed_max_rounds_rate: 0,
    });
    expect(payload?.reviewMetricsByEntry?.["write-target"]).toMatchObject({
      sample_size: 1,
      fpr0: 100,
      failed_max_rounds_rate: 0,
    });
    expect(payload?.reviewMetricsByEntry?.rewrite).toMatchObject({
      sample_size: 1,
      failed_max_rounds_rate: 100,
    });
  });

  it("returns normalized chapter word count in chapter detail endpoint", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/chapters/3");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      chapterNumber: 3,
      filename: "0003_Demo.md",
      wordCount: 4,
    });
  });

  it("self-heals stale chapter index wordCount when opening chapter detail", async () => {
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Demo Chapter",
        status: "ready-for-review",
        wordCount: 3290,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/chapters/3");

    expect(response.status).toBe(200);
    expect(saveChapterIndexMock).toHaveBeenCalledWith(
      "demo-book",
      expect.arrayContaining([
        expect.objectContaining({
          number: 3,
          wordCount: 4,
        }),
      ]),
    );
  });

  it("syncs chapter index wordCount when manually saving chapter content", async () => {
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Demo Chapter",
        status: "ready-for-review",
        wordCount: 3290,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/chapters/3", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# 第3章 Demo\n\n甲乙丙丁" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      chapterNumber: 3,
      wordCount: 4,
    });
    expect(saveChapterIndexMock).toHaveBeenCalledWith(
      "demo-book",
      expect.arrayContaining([
        expect.objectContaining({
          number: 3,
          wordCount: 4,
        }),
      ]),
    );
  });

  it("parses Chinese chapter limits from volume outline during precheck generation", async () => {
    const storyDir = join(root, "books", "demo-book", "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(
      join(storyDir, "volume_outline.md"),
      "# 卷纲\n\n### 第一卷：风起（1-十章）\n\n共十章推进主线。",
      "utf-8",
    );

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/chapter-plans/precheck-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startChapter: 9, count: 4 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      startChapter: 9,
      endChapter: 10,
      count: 2,
      chapters: [
        { chapterNumber: 9, hasPlan: false },
        { chapterNumber: 10, hasPlan: false },
      ],
    });
  });

  it("uses rollback semantics for chapter rejection instead of only flipping status", async () => {
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Broken Chapter",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: ["continuity"],
        lengthWarnings: [],
      },
      {
        number: 4,
        title: "Downstream Chapter",
        status: "ready-for-review",
        wordCount: 1900,
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);
    rollbackToChapterMock.mockResolvedValue([3, 4]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/chapters/3/reject", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      chapterNumber: 3,
      status: "rejected",
      rolledBackTo: 2,
      discarded: [3, 4],
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 2);
    expect(saveChapterIndexMock).not.toHaveBeenCalled();
  });

  it("routes create requests through the shared structured interaction runtime", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "New Book",
        genre: "urban",
        platform: "qidian",
        language: "zh",
        chapterWordCount: 2600,
        targetChapters: 88,
      }),
    });

    expect(response.status).toBe(200);
    expect(createInteractionToolsFromDepsMock).toHaveBeenCalledTimes(1);
    expect(processProjectInteractionRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: root,
      request: {
        intent: "create_book",
        title: "New Book",
        genre: "urban",
        language: "zh",
        platform: "qidian",
        chapterWordCount: 2600,
        targetChapters: 88,
      },
    }));
  });

  it("passes one-off brief into revise requests through pipeline config", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/revise/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rewrite", brief: "把注意力拉回师债主线。" }),
    });

    expect(response.status).toBe(200);
    expect(pipelineConfigs.at(-1)).toMatchObject({ externalContext: "把注意力拉回师债主线。" });
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 3, "rewrite");
  });

  it("uses non-destructive rewrite execution for /api/v1/books/:id/rewrite/:chapter by default", async () => {
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      wordCount: 1800,
      fixedIssues: ["focus restored"],
      applied: true,
      status: "ready-for-review",
    });
    auditDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      passed: true,
      issues: [],
      summary: "re-audit passed",
    });
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Rewritten",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Downstream 4",
        status: "ready-for-review",
        wordCount: 2200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 5,
        title: "Downstream 5",
        status: "ready-for-review",
        wordCount: 2300,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "回到卷一基调重写。" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "rewriting",
      mode: "non-destructive",
      destructive: false,
      bookId: "demo-book",
      chapter: 3,
      note: "后续章节已保留，不会回滚或删除。",
    });
    await Promise.resolve();
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 3, "rewrite");
    await vi.waitFor(() => {
      expect(auditDraftMock).toHaveBeenCalledWith("demo-book", 3);
    });
    expect(rollbackToChapterMock).not.toHaveBeenCalled();
    expect(writeNextChapterMock).not.toHaveBeenCalled();
    expect(pipelineConfigs.at(-1)).toMatchObject({
      externalContext: "回到卷一基调重写。",
    });
    await vi.waitFor(() => {
      expect(saveChapterIndexMock).toHaveBeenCalledWith(
        "demo-book",
        expect.arrayContaining([
          expect.objectContaining({
            number: 4,
            reviewNote: expect.stringContaining("上游第3章已重写"),
          }),
          expect.objectContaining({
            number: 5,
            reviewNote: expect.stringContaining("上游第3章已重写"),
          }),
        ]),
      );
    });
  });

  it("returns destructive rewrite risk summary for /api/v1/books/:id/rewrite/:chapter", async () => {
    getNextChapterNumberMock.mockResolvedValueOnce(3);
    loadChapterIndexMock.mockResolvedValueOnce([
      {
        number: 3,
        title: "Current",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Future",
        status: "ready-for-review",
        wordCount: 1900,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destructive: true, brief: "测试危险模式风险提示" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "rewriting",
      mode: "destructive",
      destructive: true,
      chapter: 3,
      risk: {
        rollbackTarget: 2,
        discardedChapterNumbers: [3, 4],
        discardedCount: 2,
        message: expect.stringContaining("风险提示"),
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 2);
  });

  it("blocks destructive rewrite endpoint unless advanced mode is enabled", async () => {
    delete process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE;

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destructive: true }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_DESTRUCTIVE_REWRITE_DISABLED",
      },
    });
    expect(rollbackToChapterMock).not.toHaveBeenCalled();
  });

  it("emits rewrite:error when non-destructive rewrite endpoint fails", async () => {
    reviseDraftMock.mockRejectedValueOnce(new Error("rewrite failed"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const response = await app.request("http://localhost/api/v1/books/demo-book/rewrite/30", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "测试重写落盘门禁" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "rewriting",
      mode: "non-destructive",
      chapter: 30,
    });

    const events = await collectSSEEvents(
      eventsResponse,
      ["rewrite:error"],
      { timeoutMs: 3_000, minCount: 1 },
    );
    expect(events[0]?.data).toMatchObject({
      bookId: "demo-book",
    });
    expect((events[0]?.data as { error?: string })?.error).toContain("rewrite failed");
  });

  it("emits rewrite:error when non-destructive rewrite causes downstream consistency regression", async () => {
    const chapter4File = join(root, "books", "demo-book", "chapters", "0004_Downstream.md");
    const snapshot4Dir = join(root, "books", "demo-book", "story", "snapshots", "4");
    await writeFile(chapter4File, "# 第4章\n\nDownstream body", "utf-8");
    await mkdir(snapshot4Dir, { recursive: true });
    await writeFile(join(snapshot4Dir, "current_state.md"), "state", "utf-8");
    await writeFile(join(snapshot4Dir, "pending_hooks.md"), "hooks", "utf-8");

    let chapterIndex = [
      {
        number: 3,
        title: "Rewritten",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Downstream",
        status: "ready-for-review",
        wordCount: 2200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock.mockImplementation(async () => chapterIndex);
    reviseDraftMock.mockImplementationOnce(async () => {
      chapterIndex = chapterIndex.filter((entry) => entry.number !== 4);
      await rm(chapter4File, { force: true });
      await rm(snapshot4Dir, { recursive: true, force: true });
      return {
        chapterNumber: 3,
        wordCount: 1800,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "ready-for-review",
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const response = await app.request("http://localhost/api/v1/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "测试一致性门禁" }),
    });
    expect(response.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["rewrite:error"],
      { timeoutMs: 3_000, minCount: 1 },
    );
    expect((events[0]?.data as { error?: string })?.error).toContain("非破坏重写一致性校验失败");
  });

  it("exposes a resync endpoint for rebuilding latest chapter truth artifacts", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/resync/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "以师债线为准同步状态。" }),
    });

    expect(response.status).toBe(200);
    expect(pipelineConfigs.at(-1)).toMatchObject({ externalContext: "以师债线为准同步状态。" });
    expect(resyncChapterArtifactsMock).toHaveBeenCalledWith("demo-book", 3);
  });

  it("routes export-save through the shared structured interaction runtime", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/books/demo-book/export-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "md", approvedOnly: true }),
    });

    expect(response.status).toBe(200);
    expect(processProjectInteractionRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: root,
      activeBookId: "demo-book",
      request: expect.objectContaining({
        intent: "export_book",
        bookId: "demo-book",
        format: "md",
        approvedOnly: true,
      }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      chapters: 2,
    });
  });

  it("creates a fresh book session on POST /api/v1/sessions", async () => {
    createAndPersistBookSessionMock.mockResolvedValueOnce({
      sessionId: "fresh-session",
      bookId: "demo-book",
      title: null,
      messages: [],
      events: [],
      draftRounds: [],
      createdAt: 10,
      updatedAt: 10,
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: "demo-book" }),
    });

    expect(response.status).toBe(200);
    expect(createAndPersistBookSessionMock).toHaveBeenCalledWith(root, "demo-book", undefined);
    await expect(response.json()).resolves.toMatchObject({
      session: { sessionId: "fresh-session", bookId: "demo-book", title: null },
    });
  });

  it("renames a session through PUT /api/v1/sessions/:sessionId", async () => {
    renameBookSessionMock.mockResolvedValueOnce({
      sessionId: "agent-session-1",
      bookId: "demo-book",
      title: "新标题",
      messages: [],
      events: [],
      draftRounds: [],
      createdAt: 1,
      updatedAt: 2,
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/sessions/agent-session-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  新标题  " }),
    });

    expect(response.status).toBe(200);
    expect(renameBookSessionMock).toHaveBeenCalledWith(root, "agent-session-1", "新标题");
    await expect(response.json()).resolves.toMatchObject({
      session: { sessionId: "agent-session-1", title: "新标题" },
    });
  });

  it("deletes a session through DELETE /api/v1/sessions/:sessionId", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/sessions/agent-session-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(deleteBookSessionMock).toHaveBeenCalledWith(root, "agent-session-1");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("routes /api/agent through runAgentSession and returns response + sessionId", async () => {
    runAgentSessionMock.mockResolvedValueOnce({
      responseText: "Completed write_next for demo-book.",
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "Completed write_next for demo-book." },
      ],
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "continue", activeBookId: "demo-book", sessionId: "agent-session-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "Completed write_next for demo-book.",
      runId: expect.any(String),
      session: expect.objectContaining({
        sessionId: "agent-session-1",
      }),
    });
    expect(upsertBookSessionMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "continue",
          }),
        ]),
      }),
      expect.objectContaining({
        role: "assistant",
        content: "Completed write_next for demo-book.",
        thinkingStreaming: false,
      }),
    );
    expect(persistBookSessionMock).toHaveBeenCalledTimes(2);
    expect(runAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: "demo-book",
        projectRoot: root,
      }),
      "continue",
      expect.any(Array),
    );
  });

  it("persists incremental streaming checkpoints with upserted assistant state", async () => {
    const runId = "run-streaming-checkpoint-1";
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start" },
      });
      args.onEvent?.({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "开始执行 write-next" },
      });
      args.onEvent?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "正文流段落。" },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      args.onEvent?.({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end" },
      });
      return {
        responseText: "正文流段落。",
        messages: [
          { role: "user", content: "请写下一章" },
          { role: "assistant", content: "正文流段落。", thinking: "开始执行 write-next" },
        ],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请总结当前进度",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "正文流段落。",
      runId,
    });

    expect(upsertBookSessionMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      upsertBookSessionMessageMock.mock.calls.some(([, message]) => (message as any)?.thinkingStreaming === true),
    ).toBe(true);
    expect(
      upsertBookSessionMessageMock.mock.calls.some(([, message]) => (message as any)?.thinkingStreaming === false),
    ).toBe(true);
    expect(persistBookSessionMock.mock.calls.at(-1)?.[1]).toMatchObject({
      sessionId: "agent-session-1",
      messages: [
        expect.objectContaining({
          role: "user",
          content: "请总结当前进度",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "正文流段落。",
          thinking: "开始执行 write-next",
          thinkingStreaming: false,
        }),
      ],
    });
  });

  it("auto-switches reasoner model for write-intent agent calls and enables quick pipeline defaults", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        ...projectConfig.llm,
        services: [
          {
            service: "openai",
            models: [
              { id: "deepseek-reasoner", enabled: true, source: "manual" },
              { id: "deepseek-chat", enabled: true, source: "manual" },
            ],
          },
        ],
      },
    }, null, 2), "utf-8");
    resolveServiceModelMock.mockImplementation(async (_service: string, model: string) => ({
      model: { id: model, provider: "openai", api: "openai-responses" },
      apiKey: "sk-selected",
    }));
    await writeFile(join(root, "books", "demo-book", "chapters", "0004_New.md"), "# 第4章 New\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 4,
          title: "New",
          status: "ready-for-review",
          wordCount: 1800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-writer-1",
        toolName: "sub_agent",
        args: { agent: "writer" },
      });
      args.onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-writer-1",
        toolName: "sub_agent",
        result: "ok",
        isError: false,
      });
      return {
        responseText: "完成",
        messages: [{ role: "assistant", content: "完成" }],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写下一章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        service: "openai",
        model: "deepseek-reasoner",
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveServiceModelMock).toHaveBeenCalledWith(
      "openai",
      "deepseek-chat",
      root,
      expect.any(String),
      undefined,
    );
    expect(pipelineConfigs.at(-1)).toMatchObject({
      model: "deepseek-chat",
      defaultWriteNextQuickMode: true,
      writeStageHeartbeatMs: 3000,
    });
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("auto-switches default reasoner model for write-intent agent calls without explicit model selection", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        ...projectConfig.llm,
        defaultModel: "deepseek-reasoner",
        services: [
          {
            service: "openai",
            models: [
              { id: "deepseek-reasoner", enabled: true, source: "manual" },
              { id: "deepseek-chat", enabled: true, source: "manual" },
            ],
          },
        ],
      },
    }, null, 2), "utf-8");
    resolveServiceModelMock.mockImplementation(async (_service: string, model: string) => ({
      model: { id: model, provider: "openai", api: "openai-responses" },
      apiKey: "sk-selected",
    }));
    await writeFile(join(root, "books", "demo-book", "chapters", "0004_DefaultSwitch.md"), "# 第4章\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 4,
          title: "DefaultSwitch",
          status: "ready-for-review",
          wordCount: 1800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-writer-default",
        toolName: "sub_agent",
        args: { agent: "writer" },
      });
      args.onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-writer-default",
        toolName: "sub_agent",
        result: "ok",
        isError: false,
      });
      return {
        responseText: "完成",
        messages: [{ role: "assistant", content: "完成" }],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请写下一章并说明完成情况",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveServiceModelMock).toHaveBeenCalledWith(
      "openai",
      "deepseek-chat",
      root,
      expect.any(String),
      undefined,
    );
    expect(pipelineConfigs.at(-1)).toMatchObject({
      model: "deepseek-chat",
      defaultWriteNextQuickMode: true,
    });
  });

  it("routes exact batch write command through deterministic pipeline execution", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0004_BatchA.md"), "# 第4章 BatchA\n\nBody", "utf-8");
    await writeFile(join(root, "books", "demo-book", "chapters", "0005_BatchB.md"), "# 第5章 BatchB\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 4,
          title: "BatchA",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 5,
          title: "BatchB",
          status: "ready-for-review",
          wordCount: 3100,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock
      .mockResolvedValueOnce({
        chapterNumber: 4,
        title: "BatchA",
        wordCount: 3000,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      })
      .mockResolvedValueOnce({
        chapterNumber: 5,
        title: "BatchB",
        wordCount: 3100,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "连续写2章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: expect.any(String),
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [4, 5],
          },
        },
      },
    });
    expect(writeNextChapterMock).toHaveBeenCalledTimes(2);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("routes shorthand Chinese batch write command (写N章) through deterministic pipeline execution", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0004_BatchA.md"), "# 第4章 BatchA\n\nBody", "utf-8");
    await writeFile(join(root, "books", "demo-book", "chapters", "0005_BatchB.md"), "# 第5章 BatchB\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 3,
          title: "Demo",
          status: "ready-for-review",
          wordCount: 1200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 4,
          title: "BatchA",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 5,
          title: "BatchB",
          status: "ready-for-review",
          wordCount: 3100,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock
      .mockResolvedValueOnce({
        chapterNumber: 4,
        title: "BatchA",
        wordCount: 3000,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      })
      .mockResolvedValueOnce({
        chapterNumber: 5,
        title: "BatchB",
        wordCount: 3100,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写2章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: expect.any(String),
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [4, 5],
          },
        },
      },
    });
    expect(writeNextChapterMock).toHaveBeenCalledTimes(2);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("routes target chapter command (写第N章) through deterministic writer execution", async () => {
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 18,
          title: "Target",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockImplementationOnce(async () => {
      await writeFile(join(root, "books", "demo-book", "chapters", "0018_Target.md"), "# 第18章 Target\n\nBody", "utf-8");
      return {
        chapterNumber: 18,
        title: "Target",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写第18章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: expect.any(String),
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [18],
          },
        },
      },
    });
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("routes target chapter command with bare Chinese form (写17章) through deterministic writer execution", async () => {
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 17,
          title: "Target",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockImplementationOnce(async () => {
      await writeFile(join(root, "books", "demo-book", "chapters", "0017_Target.md"), "# 第17章 Target\n\nBody", "utf-8");
      return {
        chapterNumber: 17,
        title: "Target",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写17章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: expect.any(String),
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [17],
          },
        },
      },
    });
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("routes audit chapter command through deterministic auditor execution", async () => {
    auditDraftMock.mockResolvedValueOnce({
      chapterNumber: 19,
      passed: true,
      issues: [],
      summary: "ok",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计第19章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: expect.stringContaining("第19章审计通过。"),
      runId: expect.any(String),
    });
    expect(auditDraftMock).toHaveBeenCalledWith("demo-book", 19);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("routes bare audit command to latest chapter through deterministic auditor execution", async () => {
    loadChapterIndexMock.mockResolvedValueOnce([
      {
        number: 16,
        title: "Ch16",
        status: "ready-for-review",
        wordCount: 3100,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        auditIssues: [],
      },
      {
        number: 17,
        title: "Ch17",
        status: "ready-for-review",
        wordCount: 3200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        auditIssues: [],
      },
    ]);
    auditDraftMock.mockResolvedValueOnce({
      chapterNumber: 17,
      passed: true,
      issues: [],
      summary: "ok",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: expect.stringContaining("第17章审计通过。"),
      runId: expect.any(String),
    });
    expect(auditDraftMock).toHaveBeenCalledWith("demo-book", 17);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("formats deterministic audit report with score and severity-grouped issue sections", async () => {
    const failedAudit = {
      chapterNumber: 12,
      passed: false,
      issues: [
        { severity: "info", category: "文风", description: "存在轻微重复表达", suggestion: "压缩重复句式" },
        { severity: "warning", category: "时间线", description: "当日下午到傍晚转场略跳", suggestion: "补充时间锚点" },
        { severity: "critical", category: "设定冲突", description: "关键道具来源与前文矛盾", suggestion: "统一道具来源" },
      ],
      summary: "存在关键冲突，需先修正后再审。",
    };
    auditDraftMock
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    const report = String((payload as { response?: unknown }).response ?? "");
    expect(report).toContain("审计评分：");
    expect(report).toContain("审计报告：存在关键冲突，需先修正后再审。");
    expect(report).toContain("问题清单：");
    expect(report).toContain("严重：");
    expect(report).toContain("警告：");
    expect(report).toContain("提示：");
    const severePos = report.indexOf("严重：");
    const warnPos = report.indexOf("警告：");
    const infoPos = report.indexOf("提示：");
    expect(severePos).toBeGreaterThan(-1);
    expect(warnPos).toBeGreaterThan(severePos);
    expect(infoPos).toBeGreaterThan(warnPos);
    expect(report).toContain("自动闭环：最多2轮修订，本次执行2轮。");
    expect(report).toContain("二次修订后仍未通过，已自动中止");
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      1,
      "demo-book",
      12,
      "spot-fix",
      expect.objectContaining({
        reviseContext: expect.objectContaining({
          failureGate: "critical",
          mustFixFirstIssueIds: expect.arrayContaining(["ISSUE-01"]),
        }),
      }),
    );
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      2,
      "demo-book",
      12,
      "spot-fix",
      expect.objectContaining({
        overrideIssues: expect.arrayContaining([
          expect.objectContaining({
            description: expect.stringContaining("关键道具来源"),
          }),
        ]),
      }),
    );
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("auto-enters revise and exits after passing on second audit in deterministic /agent flow", async () => {
    const firstFailedAudit = {
      chapterNumber: 12,
      passed: false,
      issues: [
        { severity: "critical", category: "设定冲突", description: "关键道具来源与前文矛盾", suggestion: "统一道具来源" },
      ],
      summary: "need fix first",
    };
    const secondPassedAudit = {
      chapterNumber: 12,
      passed: true,
      issues: [],
      summary: "fixed",
    };
    auditDraftMock
      .mockResolvedValueOnce(firstFailedAudit)
      .mockResolvedValueOnce(secondPassedAudit);
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 12,
      wordCount: 3120,
      fixedIssues: ["- 统一关键道具来源"],
      applied: true,
      status: "ready-for-review",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    const report = String((payload as { response?: unknown }).response ?? "");
    expect(report).toContain("自动闭环：最多2轮修订，本次执行1轮。");
    expect(report).toContain("结果：已达标并结束自动闭环。");
    expect(reviseDraftMock).toHaveBeenCalledTimes(1);
    expect(reviseDraftMock).toHaveBeenNthCalledWith(
      1,
      "demo-book",
      12,
      "spot-fix",
      expect.objectContaining({
        reviseContext: expect.objectContaining({
          failureGate: "critical",
          mustFixFirstIssueIds: expect.arrayContaining(["ISSUE-01"]),
        }),
      }),
    );
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns 404 when deterministic /agent audit reports missing chapter", async () => {
    auditDraftMock.mockRejectedValueOnce(new Error("Chapter not found"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计第10章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "CHAPTER_NOT_FOUND",
        message: "Chapter not found: 10",
      },
    });
  });

  it("maps deterministic /agent audit upstream 410(no body) to AGENT_UPSTREAM_ERROR 502", async () => {
    auditDraftMock.mockRejectedValueOnce(new Error("410 status code (no body)"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计第10章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_UPSTREAM_ERROR",
        message: expect.stringContaining("HTTP 410"),
      },
    });
  });

  it("emits revise:start and revise:complete during deterministic audit auto-review loop", async () => {
    const firstFailedAudit = {
      chapterNumber: 12,
      passed: false,
      issues: [
        { severity: "critical", category: "设定冲突", description: "关键道具来源与前文矛盾", suggestion: "统一道具来源" },
      ],
      summary: "need fix first",
    };
    const secondPassedAudit = {
      chapterNumber: 12,
      passed: true,
      issues: [],
      summary: "fixed",
    };
    auditDraftMock
      .mockResolvedValueOnce(firstFailedAudit)
      .mockResolvedValueOnce(secondPassedAudit);
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 12,
      wordCount: 3120,
      fixedIssues: ["- 统一关键道具来源"],
      applied: true,
      status: "ready-for-review",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-audit-revise-events-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(
      eventsResponse,
      ["audit:start", "audit:complete", "revise:start", "revise:complete"],
      { timeoutMs: 3_000, minCount: 6 },
    );
    const reviseStart = events.find((event) => event.event === "revise:start");
    const reviseComplete = events.find((event) => event.event === "revise:complete");

    expect(reviseStart?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      chapter: 12,
      round: 1,
      maxRounds: 2,
      phase: "revise",
      mode: "spot-fix",
      autoTriggeredByAudit: true,
    });
    expect(reviseComplete?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      chapter: 12,
      round: 1,
      maxRounds: 2,
      phase: "revise",
      mode: "spot-fix",
      autoTriggeredByAudit: true,
      applied: true,
    });
  });

  it("marks deterministic audit tool:end as error when final audit still fails", async () => {
    const failedAudit = {
      chapterNumber: 12,
      passed: false,
      issues: [
        { severity: "warning", category: "节奏", description: "节奏偏慢", suggestion: "压缩段落" },
      ],
      summary: "still failed",
    };
    auditDraftMock
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(failedAudit);
    reviseDraftMock.mockResolvedValue({
      chapterNumber: 12,
      wordCount: 3120,
      fixedIssues: ["- 压缩段落"],
      applied: true,
      status: "audit-failed",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-audit-toolend-failed-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审计第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(eventsResponse, ["tool:end"], { timeoutMs: 3_000, minCount: 1 });
    const toolEnd = events.find((event) => event.event === "tool:end");
    expect(toolEnd?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      tool: "sub_agent",
      isError: true,
    });
    expect(String((toolEnd?.data as { result?: unknown } | undefined)?.result ?? "")).toContain("FAILED");
  });

  it("routes audit+revise chapter command through deterministic reviser execution with real chapter filename", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0012_夜里的探访者.md"),
      "# 第12章 夜里的探访者\n\nBody",
      "utf-8",
    );
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 12,
      wordCount: 7520,
      fixedIssues: ["timeline"],
      applied: true,
      status: "ready-for-review",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "审核并修订第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      response: expect.stringContaining("已完成第12章修订。"),
      runId: expect.any(String),
    });
    expect(payload).toMatchObject({
      response: expect.stringContaining("正文文件：0012_夜里的探访者.md"),
    });
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 12, "spot-fix", undefined);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("includes attempted fixes and current audit score when revise result is unchanged", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0012_夜里的探访者.md"),
      "# 第12章 夜里的探访者\n\nBody",
      "utf-8",
    );
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 12,
      wordCount: 4037,
      fixedIssues: ["timeline"],
      applied: false,
      status: "unchanged",
      skippedReason: "Manual revision did not improve merged audit or AI-tell metrics; kept original chapter.",
    });
    loadChapterIndexMock.mockResolvedValueOnce([
      {
        number: 12,
        title: "夜里的探访者",
        status: "audit-failed",
        wordCount: 4037,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        auditIssues: [
          "[critical] timeline conflict",
          "[warning] pacing issue",
        ],
        lengthWarnings: [],
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "修订第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      response: expect.stringContaining("尝试修复项：1"),
    });
    expect(payload).toMatchObject({
      response: expect.stringContaining("当前审计评分："),
    });
    expect(payload).toMatchObject({
      response: expect.stringContaining("当前问题数：2"),
    });
    expect(payload).toMatchObject({
      response: expect.stringContaining("建议：当前模式未通过应用门槛"),
    });
  });

  it("prefers structured audit from revise result when composing deterministic revise response", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0012_夜里的探访者.md"),
      "# 第12章 夜里的探访者\n\nBody",
      "utf-8",
    );
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 12,
      wordCount: 4339,
      fixedIssues: ["timeline"],
      applied: false,
      status: "unchanged",
      skippedReason: "Manual revision did not improve merged audit or AI-tell metrics; kept original chapter.",
      audit: {
        passed: false,
        score: 53,
        issueCount: 2,
        severityCounts: { critical: 1, warning: 1, info: 0 },
        summary: "存在关键冲突，需先修正后再审。",
        issues: [
          { severity: "critical", category: "人设", description: "Name inconsistency", suggestion: "统一命名" },
          { severity: "warning", category: "节奏", description: "Pacing too fast", suggestion: "放慢推进" },
        ],
      },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "修订第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-structured-audit",
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    const report = String((payload as { response?: unknown }).response ?? "");
    expect(report).toContain("当前审计评分：53/100");
    expect(report).toContain("当前问题数：2");
    expect(report).toContain("审计报告：存在关键冲突，需先修正后再审。");
    expect(report).toContain("问题清单：");
    expect(report).toContain("严重：");
    expect(report).toContain("警告：");
  });

  it("emits audit:complete for write-next, revise and rewrite deterministic commands", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0012_夜里的探访者.md"),
      "# 第12章 夜里的探访者\n\nBody",
      "utf-8",
    );
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0003_库房里的最后一张牌.md"),
      "# 第3章 库房里的最后一张牌\n\nBody",
      "utf-8",
    );
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0004_下游衔接章.md"),
      "# 第4章 下游衔接章\n\nBody",
      "utf-8",
    );

    let chapterIndex = [
      {
        number: 3,
        title: "库房里的最后一张牌",
        status: "ready-for-review",
        wordCount: 3050,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "下游衔接章",
        status: "ready-for-review",
        wordCount: 2990,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 12,
        title: "夜里的探访者",
        status: "audit-failed",
        wordCount: 4339,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 17,
        title: "上一章",
        status: "ready-for-review",
        wordCount: 3200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock.mockImplementation(async () => chapterIndex);
    saveChapterIndexMock.mockImplementation(async (_bookId: string, nextIndex: unknown) => {
      chapterIndex = (nextIndex as typeof chapterIndex);
    });

    writeNextChapterMock.mockImplementationOnce(async () => {
      await writeFile(
        join(root, "books", "demo-book", "chapters", "0018_新章.md"),
        "# 第18章 新章\n\nBody",
        "utf-8",
      );
      chapterIndex = [
        ...chapterIndex,
        {
          number: 18,
          title: "新章",
          status: "ready-for-review",
          wordCount: 3210,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ];
      return {
        chapterNumber: 18,
        title: "新章",
        wordCount: 3210,
        revised: false,
        status: "ready-for-review",
        auditResult: {
          passed: true,
          issues: [],
          summary: "clean",
        },
      };
    });

    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 12,
        wordCount: 4300,
        fixedIssues: ["timeline"],
        applied: true,
        status: "audit-failed",
        audit: {
          passed: false,
          score: 53,
          issueCount: 2,
          severityCounts: { critical: 1, warning: 1, info: 0 },
          summary: "存在关键冲突，需先修正后再审。",
          issues: [
            { severity: "critical", category: "人设", description: "Name inconsistency", suggestion: "统一命名" },
            { severity: "warning", category: "节奏", description: "Pacing too fast", suggestion: "放慢推进" },
          ],
        },
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 3600,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "ready-for-review",
        audit: {
          passed: true,
          score: 92,
          issueCount: 1,
          severityCounts: { critical: 0, warning: 1, info: 0 },
          summary: "整体通过，存在轻微节奏问题。",
          issues: [
            { severity: "warning", category: "节奏", description: "Pacing slightly uneven", suggestion: "微调段落长短" },
          ],
        },
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const writeRunId = "run-auto-audit-write-next-1";
    const reviseRunId = "run-auto-audit-revise-1";
    const rewriteRunId = "run-auto-audit-rewrite-1";

    const writeResponse = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写下一章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId: writeRunId,
      }),
    });
    expect(writeResponse.status).toBe(200);

    const reviseResponse = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "修订第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId: reviseRunId,
      }),
    });
    expect(reviseResponse.status).toBe(200);

    const rewriteResponse = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId: rewriteRunId,
      }),
    });
    expect(rewriteResponse.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["audit:complete"],
      { timeoutMs: 4_000, minCount: 3 },
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "audit:complete",
          data: expect.objectContaining({
            sessionId: "agent-session-1",
            runId: writeRunId,
            entry: "write-next",
            chapter: 18,
            passed: true,
            score: 100,
            issueCount: 0,
            failureGate: "none",
          }),
        }),
        expect.objectContaining({
          event: "audit:complete",
          data: expect.objectContaining({
            sessionId: "agent-session-1",
            runId: reviseRunId,
            entry: "rewrite",
            chapter: 12,
            passed: false,
            score: 53,
            issueCount: 2,
            failureGate: "critical",
          }),
        }),
        expect.objectContaining({
          event: "audit:complete",
          data: expect.objectContaining({
            sessionId: "agent-session-1",
            runId: rewriteRunId,
            entry: "rewrite",
            chapter: 3,
            passed: true,
            score: 100,
            issueCount: 0,
            failureGate: "none",
          }),
        }),
      ]),
    );
  });

  it("emits write-target entry for deterministic 写第N章 audit events", async () => {
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 18,
          title: "Target",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);

    writeNextChapterMock.mockImplementationOnce(async () => {
      await writeFile(
        join(root, "books", "demo-book", "chapters", "0018_Target.md"),
        "# 第18章 Target\n\nBody",
        "utf-8",
      );
      return {
        chapterNumber: 18,
        title: "Target",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-write-target-entry-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写第18章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });
    expect(response.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["audit:complete"],
      { timeoutMs: 4_000, minCount: 1 },
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "audit:complete",
          data: expect.objectContaining({
            sessionId: "agent-session-1",
            runId,
            chapter: 18,
            entry: "write-target",
            passed: true,
            score: 100,
          }),
        }),
      ]),
    );
  });

  it("repairs missing index instead of writing next chapter when 写第N章 targets an existing chapter file", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0017_Target.md"), "# 第17章 Target\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 17,
          title: "Target",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写第17章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "第17章正文已存在，已自动补齐章节索引。",
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [17],
            repairedChapterNumbers: [17],
          },
        },
      },
    });
    expect(saveChapterIndexMock).toHaveBeenCalledTimes(1);
    expect(writeNextChapterMock).not.toHaveBeenCalled();
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("routes rewrite chapter command through deterministic writer execution with rollback", async () => {
    getNextChapterNumberMock.mockResolvedValueOnce(3);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 2,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 2,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 2,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 3,
          title: "Rewritten Chapter",
          status: "ready-for-review",
          wordCount: 1800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);
    const runId = "run-rewrite-destructive-mode-1";

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "已重写第3章。",
      destructive: true,
      runId: expect.any(String),
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [3],
          },
        },
        writeIntegrity: {
          missingChapterFiles: [],
        },
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 2);
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", undefined, undefined, { quickMode: false });
    expect(reviseDraftMock).not.toHaveBeenCalled();
    expect((pipelineConfigs.at(-1) as { writeStageHeartbeatMs?: number }).writeStageHeartbeatMs)
      .toBeLessThanOrEqual(15000);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
    const rewriteEvents = await collectSSEEvents(
      eventsResponse,
      ["rewrite:start", "rewrite:complete"],
      { timeoutMs: 3_000, minCount: 2 },
    );
    expect(rewriteEvents.find((event) => event.event === "rewrite:start")?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      bookId: "demo-book",
      mode: "destructive",
    });
    expect(rewriteEvents.find((event) => event.event === "rewrite:complete")?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      bookId: "demo-book",
      mode: "destructive",
    });
  });

  it("keeps destructive rewrite disabled by default for non-advanced users", async () => {
    delete process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE;
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_DESTRUCTIVE_REWRITE_DISABLED",
      },
    });
    expect(rollbackToChapterMock).not.toHaveBeenCalled();
    expect(writeNextChapterMock).not.toHaveBeenCalled();
  });

  it("routes default rewrite chapter command through deterministic non-destructive revise execution", async () => {
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      wordCount: 1900,
      fixedIssues: ["focus restored"],
      applied: true,
      status: "ready-for-review",
    });
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Rewritten",
        status: "ready-for-review",
        wordCount: 1900,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Downstream 4",
        status: "ready-for-review",
        wordCount: 2200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 5,
        title: "Downstream 5",
        status: "ready-for-review",
        wordCount: 2300,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);
    const runId = "run-rewrite-nondestructive-mode-1";

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      response: expect.stringContaining("已完成第3章重写。"),
      runId: expect.any(String),
    });
    expect(payload.response).toContain("待复核");
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 3, "rewrite", undefined);
    expect(rollbackToChapterMock).not.toHaveBeenCalled();
    expect(writeNextChapterMock).not.toHaveBeenCalled();
    expect(runAgentSessionMock).not.toHaveBeenCalled();
    expect(saveChapterIndexMock).toHaveBeenCalledWith(
      "demo-book",
      expect.arrayContaining([
        expect.objectContaining({
          number: 4,
          reviewNote: expect.stringContaining("上游第3章已重写"),
        }),
      ]),
    );
    const rewriteEvents = await collectSSEEvents(
      eventsResponse,
      ["rewrite:start", "rewrite:complete"],
      { timeoutMs: 3_000, minCount: 2 },
    );
    expect(rewriteEvents.find((event) => event.event === "rewrite:start")?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      bookId: "demo-book",
      mode: "non-destructive",
    });
    expect(rewriteEvents.find((event) => event.event === "rewrite:complete")?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      bookId: "demo-book",
      mode: "non-destructive",
    });
  });

  it("routes Chinese numeral rewrite command through deterministic non-destructive rewrite auto-review loop", async () => {
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 1,
      wordCount: 1860,
      fixedIssues: ["focus restored"],
      applied: true,
      status: "ready-for-review",
    });
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 1,
        title: "Rewritten",
        status: "ready-for-review",
        wordCount: 1860,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);
    const runId = "run-rewrite-cn-numeral-1";

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第一章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 1, "rewrite", undefined);
    expect(runAgentSessionMock).not.toHaveBeenCalled();

    const events = await collectSSEEvents(
      eventsResponse,
      ["rewrite:start", "audit:start", "audit:complete", "rewrite:complete"],
      { timeoutMs: 3_000, minCount: 4 },
    );
    expect(events.find((event) => event.event === "rewrite:start")?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      bookId: "demo-book",
      mode: "non-destructive",
    });
    expect(events.some((event) => event.event === "audit:start")).toBe(true);
    expect(events.some((event) => event.event === "audit:complete")).toBe(true);
    expect(events.find((event) => event.event === "rewrite:complete")?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      bookId: "demo-book",
      mode: "non-destructive",
      autoReview: expect.objectContaining({
        enabled: true,
      }),
    });
  });

  it("does not emit rollback/discarded logs for default non-destructive rewrite", async () => {
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      wordCount: 1900,
      fixedIssues: ["focus restored"],
      applied: true,
      status: "ready-for-review",
    });
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Rewritten",
        status: "ready-for-review",
        wordCount: 1900,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Downstream 4",
        status: "ready-for-review",
        wordCount: 2200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });
    expect(response.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["log", "rewrite:start", "rewrite:complete"],
      { timeoutMs: 3_000, minCount: 3 },
    );
    const logMessages = events
      .filter((event) => event.event === "log")
      .map((event) => String((event.data as { message?: unknown }).message ?? ""));
    expect(logMessages.length).toBeGreaterThan(0);
    expect(logMessages.some((message) => /rollback|discarded chapters|回滚|删除后续/i.test(message))).toBe(false);
  });

  it("fails non-destructive rewrite when downstream index/files/snapshots regress", async () => {
    const chapter4File = join(root, "books", "demo-book", "chapters", "0004_Downstream.md");
    const snapshot4Dir = join(root, "books", "demo-book", "story", "snapshots", "4");
    await writeFile(chapter4File, "# 第4章\n\nDownstream body", "utf-8");
    await mkdir(snapshot4Dir, { recursive: true });
    await writeFile(join(snapshot4Dir, "current_state.md"), "state", "utf-8");
    await writeFile(join(snapshot4Dir, "pending_hooks.md"), "hooks", "utf-8");

    let chapterIndex = [
      {
        number: 3,
        title: "Rewritten",
        status: "ready-for-review",
        wordCount: 1900,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Downstream",
        status: "ready-for-review",
        wordCount: 2200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock.mockImplementation(async () => chapterIndex);
    reviseDraftMock.mockImplementationOnce(async () => {
      chapterIndex = chapterIndex.filter((entry) => entry.number !== 4);
      await rm(chapter4File, { force: true });
      await rm(snapshot4Dir, { recursive: true, force: true });
      return {
        chapterNumber: 3,
        wordCount: 1900,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "ready-for-review",
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_REWRITE_CONSISTENCY_REGRESSION",
        message: expect.stringContaining("非破坏重写一致性校验失败"),
      },
    });
    expect(rollbackToChapterMock).not.toHaveBeenCalled();
  });

  it("fails non-destructive rewrite batch when downstream chapters regress", async () => {
    const chapter5File = join(root, "books", "demo-book", "chapters", "0005_Downstream.md");
    const snapshot5Dir = join(root, "books", "demo-book", "story", "snapshots", "5");
    await writeFile(chapter5File, "# 第5章\n\nDownstream body", "utf-8");
    await mkdir(snapshot5Dir, { recursive: true });
    await writeFile(join(snapshot5Dir, "current_state.md"), "state", "utf-8");
    await writeFile(join(snapshot5Dir, "pending_hooks.md"), "hooks", "utf-8");

    let chapterIndex = [
      {
        number: 3,
        title: "Three",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Four",
        status: "ready-for-review",
        wordCount: 1850,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 5,
        title: "Downstream",
        status: "ready-for-review",
        wordCount: 2100,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock.mockImplementation(async () => chapterIndex);
    reviseDraftMock.mockImplementation(async (_bookId: string, chapterNumber: number) => {
      if (chapterNumber === 4) {
        chapterIndex = chapterIndex.filter((entry) => entry.number !== 5);
        await rm(chapter5File, { force: true });
        await rm(snapshot5Dir, { recursive: true, force: true });
      }
      return {
        chapterNumber,
        wordCount: 1850,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "ready-for-review",
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3-4章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_REWRITE_CONSISTENCY_REGRESSION",
      },
    });
    expect(rollbackToChapterMock).not.toHaveBeenCalled();
  });

  it("emits per-chapter audit:complete during non-destructive rewrite batch and includes audit summaries on rewrite:complete", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0003_Three.md"), "# 第3章 Three\n\nBody", "utf-8");
    await writeFile(join(root, "books", "demo-book", "chapters", "0004_Four.md"), "# 第4章 Four\n\nBody", "utf-8");

    const chapterIndex = [
      {
        number: 3,
        title: "Three",
        status: "ready-for-review",
        wordCount: 1800,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Four",
        status: "ready-for-review",
        wordCount: 1850,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock.mockImplementation(async () => chapterIndex);
    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 1900,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "ready-for-review",
        audit: {
          passed: true,
          score: 96,
          issueCount: 0,
          severityCounts: { critical: 0, warning: 0, info: 0 },
          summary: "clean",
          issues: [],
        },
      })
      .mockResolvedValueOnce({
        chapterNumber: 4,
        wordCount: 1950,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "audit-failed",
        audit: {
          passed: false,
          score: 61,
          issueCount: 2,
          severityCounts: { critical: 0, warning: 1, info: 1 },
          summary: "needs revision",
          issues: [
            { severity: "warning", category: "节奏", description: "Pacing too fast", suggestion: "slow down" },
            { severity: "info", category: "文风", description: "Lexical fatigue", suggestion: "vary phrasing" },
          ],
        },
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-rewrite-nondestructive-batch-audit-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3-4章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: expect.stringContaining("自动审计：共2章，通过1章，未通过1章。"),
    });

    const events = await collectSSEEvents(
      eventsResponse,
      ["audit:complete", "rewrite:complete"],
      { timeoutMs: 3_000, minCount: 3 },
    );
    const auditEvents = events.filter((event) => event.event === "audit:complete");
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      chapter: 3,
      passed: true,
      score: 96,
      issueCount: 0,
      failureGate: "none",
    });
    expect(auditEvents[1]?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      chapter: 4,
      passed: false,
      score: 61,
      issueCount: 2,
      failureGate: "score",
    });
    const rewriteComplete = events.find((event) => event.event === "rewrite:complete");
    expect(rewriteComplete?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      entry: "rewrite",
      mode: "non-destructive",
      autoReview: {
        enabled: false,
        maxReviseRounds: 0,
        reviseRoundsUsed: 0,
        auditRounds: 2,
        stoppedByMaxRounds: false,
        finalState: "failed-single-audit",
      },
      audits: [
        expect.objectContaining({ chapterNumber: 3, passed: true, score: 96, issueCount: 0, failureGate: "none" }),
        expect.objectContaining({ chapterNumber: 4, passed: false, score: 61, issueCount: 2, failureGate: "score" }),
      ],
    });
  });

  it("emits round-level audit/revise events for non-destructive rewrite endpoint", async () => {
    const failedAudit = {
      chapterNumber: 3,
      passed: false,
      issues: [
        { severity: "warning", category: "节奏", description: "节奏偏平", suggestion: "补充起伏" },
      ],
      summary: "still weak",
    };
    const passedAudit = {
      chapterNumber: 3,
      passed: true,
      issues: [],
      summary: "fixed",
    };
    auditDraftMock
      .mockResolvedValueOnce(failedAudit)
      .mockResolvedValueOnce(passedAudit);
    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 1900,
        fixedIssues: ["focus restored"],
        applied: true,
        status: "audit-failed",
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 1920,
        fixedIssues: ["pacing fixed"],
        applied: true,
        status: "ready-for-review",
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const response = await app.request("http://localhost/api/v1/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "保持主线，修复节奏问题" }),
    });
    expect(response.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["audit:start", "audit:complete", "revise:start", "revise:complete", "rewrite:complete"],
      { timeoutMs: 3_000, minCount: 7 },
    );
    const auditStart = events.find((event) => event.event === "audit:start");
    const auditComplete = events.find((event) => event.event === "audit:complete");
    const reviseStart = events.find((event) => event.event === "revise:start");
    const reviseComplete = events.find((event) => event.event === "revise:complete");
    const rewriteComplete = events.find((event) => event.event === "rewrite:complete");

    expect(auditStart?.data).toMatchObject({
      bookId: "demo-book",
      entry: "rewrite",
      chapter: 3,
      round: 1,
      maxRounds: 2,
      phase: "audit",
    });
    expect(auditComplete?.data).toMatchObject({
      bookId: "demo-book",
      entry: "rewrite",
      chapter: 3,
      round: 1,
      maxRounds: 2,
      phase: "audit",
      autoReviewState: "retrying",
      autoReviewFinal: false,
    });
    expect(reviseStart?.data).toMatchObject({
      bookId: "demo-book",
      entry: "rewrite",
      chapter: 3,
      round: 1,
      maxRounds: 2,
      phase: "revise",
      autoTriggeredByAudit: true,
    });
    expect(reviseComplete?.data).toMatchObject({
      bookId: "demo-book",
      entry: "rewrite",
      chapter: 3,
      round: 1,
      maxRounds: 2,
      phase: "revise",
      autoTriggeredByAudit: true,
    });
    expect(rewriteComplete?.data).toMatchObject({
      bookId: "demo-book",
      entry: "rewrite",
      mode: "non-destructive",
      audit: expect.objectContaining({
        passed: true,
      }),
    });
  });

  it("emits consistent terminal autoReview state fields across write-next/write-target/rewrite entries", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    writeNextChapterMock.mockImplementationOnce(async (bookId: string) => {
      const config = pipelineConfigs[pipelineConfigs.length - 1] as {
        onWriteNextAuditComplete?: (payload: {
          bookId: string;
          chapterNumber: number;
          round: number;
          maxReviseRounds: number;
          phase: "audit";
          audit: {
            passed: boolean;
            score: number;
            issueCount: number;
            severityCounts: { critical: number; warning: number; info: number };
            summary: string;
            issues: unknown[];
          };
        }) => void;
      } | undefined;
      config?.onWriteNextAuditComplete?.({
        bookId,
        chapterNumber: 4,
        round: 1,
        maxReviseRounds: 0,
        phase: "audit",
        audit: {
          passed: true,
          score: 92,
          issueCount: 0,
          severityCounts: { critical: 0, warning: 0, info: 0 },
          summary: "ok",
          issues: [],
        },
      });
      return {
        chapterNumber: 4,
        title: "Write Next 4",
        wordCount: 2100,
        revised: false,
        status: "ready-for-review",
        auditResult: {
          passed: true,
          issues: [],
          summary: "ok",
        },
      };
    });
    auditDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        passed: true,
        issues: [],
        summary: "ok",
      })
      .mockResolvedValueOnce({
        chapterNumber: 3,
        passed: true,
        issues: [],
        summary: "ok",
      });
    reviseDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 3,
        wordCount: 1900,
        fixedIssues: ["rewrite-fix"],
        applied: true,
        status: "ready-for-review",
      });

    const writeNextResponse = await app.request("http://localhost/api/v1/books/demo-book/write-next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(writeNextResponse.status).toBe(200);
    await writeNextResponse.json();

    const auditResponse = await app.request("http://localhost/api/v1/books/demo-book/audit/3", { method: "POST" });
    expect(auditResponse.status).toBe(200);
    await auditResponse.json();

    const rewriteResponse = await app.request("http://localhost/api/v1/books/demo-book/rewrite/3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "修复节奏并保持设定一致。" }),
    });
    expect(rewriteResponse.status).toBe(200);
    await rewriteResponse.json();

    const events = await collectSSEEvents(
      eventsResponse,
      ["audit:complete"],
      { timeoutMs: 3_000, minCount: 3 },
    );
    const auditEvents = events
      .map((event) => event.data as {
        entry?: string;
        autoReviewFinal?: boolean;
        autoReviewState?: string;
        round?: number;
        maxRounds?: number;
        phase?: string;
      })
      .filter((data) => typeof data.entry === "string");
    const byEntry = new Map(auditEvents.map((event) => [event.entry as string, event]));
    const writeNext = byEntry.get("write-next");
    const writeTarget = byEntry.get("write-target");
    const rewrite = byEntry.get("rewrite");
    expect(writeNext).toMatchObject({
      autoReviewFinal: true,
      autoReviewState: "passed",
      round: 1,
      phase: "audit",
    });
    expect(writeTarget).toMatchObject({
      autoReviewFinal: true,
      autoReviewState: "passed",
      round: 1,
      phase: "audit",
    });
    expect(rewrite).toMatchObject({
      autoReviewFinal: true,
      autoReviewState: "passed",
      round: 1,
      phase: "audit",
    });
    expect(typeof writeNext?.maxRounds).toBe("number");
    expect(typeof writeTarget?.maxRounds).toBe("number");
    expect(typeof rewrite?.maxRounds).toBe("number");
  });

  it("audits impacted chapters in batch and clears rewrite-impact review notes", async () => {
    const impactedIndex = [
      {
        number: 11,
        title: "Prev",
        status: "ready-for-review",
        wordCount: 2800,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 12,
        title: "Impacted 12",
        status: "ready-for-review",
        wordCount: 3000,
        reviewNote: "[rewrite-impact] 上游第11章已重写，请复核本章与上游衔接。",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 13,
        title: "Impacted 13",
        status: "ready-for-review",
        wordCount: 3050,
        reviewNote: "[rewrite-impact] 上游第11章已重写，请复核本章与上游衔接。",
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock
      .mockResolvedValue(impactedIndex)
      .mockResolvedValueOnce(impactedIndex)
      .mockResolvedValueOnce(impactedIndex);
    auditDraftMock
      .mockResolvedValueOnce({
        chapterNumber: 12,
        passed: true,
        issues: [],
        summary: "ok",
      })
      .mockResolvedValueOnce({
        chapterNumber: 13,
        passed: false,
        issues: [{ severity: "warning", category: "节奏", description: "节奏偏快" }],
        summary: "needs fix",
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "批量审计受影响章节",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      response: expect.stringContaining("已完成受影响章节批量审计：共2章"),
      runId: expect.any(String),
    });
    expect(auditDraftMock).toHaveBeenNthCalledWith(1, "demo-book", 12);
    expect(auditDraftMock).toHaveBeenNthCalledWith(2, "demo-book", 13);
    expect(saveChapterIndexMock).toHaveBeenCalledTimes(1);
    const savedIndex = saveChapterIndexMock.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(savedIndex.find((item) => Number(item.number) === 12)?.reviewNote).toBeUndefined();
    expect(savedIndex.find((item) => Number(item.number) === 13)?.reviewNote).toBeUndefined();
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns AGENT_REWRITE_SNAPSHOT_MISSING when rollback snapshot is unavailable", async () => {
    rollbackToChapterMock.mockRejectedValueOnce(
      new Error('Cannot restore snapshot for chapter 22 in "demo-book"'),
    );
    rollbackToChapterWithoutSnapshotMock.mockRejectedValueOnce(
      new Error("fallback rollback failed"),
    );

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第23章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_REWRITE_SNAPSHOT_MISSING",
      },
    });
    expect(rollbackToChapterWithoutSnapshotMock).toHaveBeenCalledWith("demo-book", 22);
    expect(writeNextChapterMock).not.toHaveBeenCalled();
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("repairs missing rollback snapshot and continues deterministic rewrite", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0023_Rewritten Chapter.md"),
      "# 第23章\n\nrewritten body",
      "utf-8",
    );
    rollbackToChapterMock.mockRejectedValueOnce(
      new Error('Cannot restore snapshot for chapter 22 in "demo-book"'),
    );
    rollbackToChapterWithoutSnapshotMock.mockResolvedValueOnce([23]);
    getNextChapterNumberMock.mockResolvedValueOnce(23);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 22,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 22,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 22,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 23,
          title: "Rewritten Chapter",
          status: "ready-for-review",
          wordCount: 1800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 23,
      title: "Rewritten Chapter",
      wordCount: 1800,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "ok" },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第23章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "已重写第23章。",
      destructive: true,
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [23],
          },
        },
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 22);
    expect(rollbackToChapterWithoutSnapshotMock).toHaveBeenCalledWith("demo-book", 22);
    expect(resyncChapterArtifactsMock).toHaveBeenCalledWith("demo-book", 22);
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("routes rewrite chapter range command through deterministic writer execution with batch progress semantics", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0012_Rewrite12.md"), "# 第12章 Rewrite12\n\nBody", "utf-8");
    await writeFile(join(root, "books", "demo-book", "chapters", "0013_Rewrite13.md"), "# 第13章 Rewrite13\n\nBody", "utf-8");
    await writeFile(join(root, "books", "demo-book", "chapters", "0014_Rewrite14.md"), "# 第14章 Rewrite14\n\nBody", "utf-8");
    getNextChapterNumberMock.mockResolvedValueOnce(12);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 12,
          title: "Rewrite12",
          status: "ready-for-review",
          wordCount: 3100,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 13,
          title: "Rewrite13",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 14,
          title: "Rewrite14",
          status: "ready-for-review",
          wordCount: 3300,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock
      .mockResolvedValueOnce({
        chapterNumber: 12,
        title: "Rewrite12",
        wordCount: 3100,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      })
      .mockResolvedValueOnce({
        chapterNumber: 13,
        title: "Rewrite13",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      })
      .mockResolvedValueOnce({
        chapterNumber: 14,
        title: "Rewrite14",
        wordCount: 3300,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第12-14章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "已完成重写第12-14章，共9600字。",
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [12, 13, 14],
          },
        },
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledTimes(1);
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 11);
    expect(writeNextChapterMock).toHaveBeenCalledTimes(3);
    expect(writeNextChapterMock).toHaveBeenNthCalledWith(1, "demo-book", undefined, undefined, { quickMode: false });
    expect(writeNextChapterMock).toHaveBeenNthCalledWith(2, "demo-book", undefined, undefined, { quickMode: false });
    expect(writeNextChapterMock).toHaveBeenNthCalledWith(3, "demo-book", undefined, undefined, { quickMode: false });
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("emits batch:progress started/progress/completed during deterministic rewrite batch execution", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0012_Rewrite12.md"), "# 第12章 Rewrite12\n\nBody", "utf-8");
    await writeFile(join(root, "books", "demo-book", "chapters", "0013_Rewrite13.md"), "# 第13章 Rewrite13\n\nBody", "utf-8");
    getNextChapterNumberMock.mockResolvedValueOnce(12);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 12,
          title: "Rewrite12",
          status: "ready-for-review",
          wordCount: 3100,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 13,
          title: "Rewrite13",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock
      .mockResolvedValueOnce({
        chapterNumber: 12,
        title: "Rewrite12",
        wordCount: 3100,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      })
      .mockResolvedValueOnce({
        chapterNumber: 13,
        title: "Rewrite13",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-rewrite-batch-progress-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写12到13章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      destructive: true,
    });
    const events = await collectSSEEvents(eventsResponse, ["batch:progress"], { timeoutMs: 3_000, minCount: 4 });
    const started = events.find((event) => event.event === "batch:progress" && (event.data as any)?.status === "started");
    const firstProgress = events.find(
      (event) => event.event === "batch:progress"
        && (event.data as any)?.status === "progress"
        && (event.data as any)?.completed === 1,
    );
    const completed = events.find((event) => event.event === "batch:progress" && (event.data as any)?.status === "completed");
    expect(started?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      status: "started",
      total: 2,
      completed: 0,
    });
    expect(firstProgress?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      status: "progress",
      total: 2,
      completed: 1,
      currentChapter: 12,
      currentWords: 3100,
    });
    expect(completed?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      status: "completed",
      total: 2,
      completed: 2,
      currentChapter: 13,
    });
  });

  it("emits chapter:delta during deterministic rewrite execution", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0012_Rewrite.md"), "# 第12章 Rewrite\n\nBody", "utf-8");
    getNextChapterNumberMock.mockResolvedValueOnce(12);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 12,
          title: "Rewritten 12",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockImplementationOnce(async () => {
      const cfg = pipelineConfigs.at(-1) as {
        onWriterTextDelta?: (payload: {
          bookId: string;
          chapterNumber: number;
          mode: "write-next" | "draft";
          text: string;
        }) => void;
      } | undefined;
      cfg?.onWriterTextDelta?.({
        bookId: "demo-book",
        chapterNumber: 12,
        mode: "write-next",
        text: "“第一段正文流。”",
      });
      return {
        chapterNumber: 12,
        title: "Rewritten 12",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-rewrite-delta-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第12章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(eventsResponse, ["chapter:delta"], { timeoutMs: 3_000, minCount: 1 });
    const chapterDelta = events.find((event) => event.event === "chapter:delta");
    expect(chapterDelta).toBeDefined();
    expect(chapterDelta?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      sequence: 1,
      previewType: "chapter",
      chapterNumber: 12,
      mode: "write-next",
      text: "“第一段正文流。”",
    });
  });

  it("replays persisted chapter content as chapter:delta when deterministic target write has no live writer delta", async () => {
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 18,
          title: "Target",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockImplementationOnce(async () => {
      await writeFile(
        join(root, "books", "demo-book", "chapters", "0018_Target.md"),
        "# 第18章 Target\n\n非流式写作正文回放片段。",
        "utf-8",
      );
      return {
        chapterNumber: 18,
        title: "Target",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-target-write-fallback-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写第18章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(eventsResponse, ["chapter:delta"], { timeoutMs: 3_000, minCount: 1 });
    const chapterDelta = events.find((event) => event.event === "chapter:delta");
    expect(chapterDelta?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      sequence: 1,
      previewType: "chapter",
      chapterNumber: 18,
      mode: "write-next",
    });
    expect((chapterDelta?.data as any)?.text).toContain("非流式写作正文回放片段");
  });

  it("replays persisted chapter content as chapter:delta for default non-destructive rewrite when no reviser delta is streamed", async () => {
    process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE = "false";
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0003_Demo.md"),
      "# 第3章 Demo\n\n非流式重写正文回放片段。",
      "utf-8",
    );
    reviseDraftMock.mockResolvedValueOnce({
      chapterNumber: 3,
      wordCount: 1900,
      fixedIssues: ["focus restored"],
      applied: true,
      status: "ready-for-review",
    });
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 3,
        title: "Rewritten",
        status: "ready-for-review",
        wordCount: 1900,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 4,
        title: "Downstream 4",
        status: "ready-for-review",
        wordCount: 2200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-rewrite-fallback-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第3章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(eventsResponse, ["chapter:delta"], { timeoutMs: 3_000, minCount: 1 });
    const chapterDelta = events.find((event) => event.event === "chapter:delta");
    expect(chapterDelta?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      sequence: 1,
      previewType: "chapter",
      chapterNumber: 3,
      mode: "rewrite",
    });
    expect((chapterDelta?.data as any)?.text).toContain("非流式重写正文回放片段");
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 3, "rewrite", undefined);
  });

  it("emits chapter:delta patch preview during deterministic spot-fix revise execution", async () => {
    reviseDraftMock.mockImplementationOnce(async () => {
      const cfg = pipelineConfigs.at(-1) as {
        onReviserPatchDelta?: (payload: {
          bookId: string;
          chapterNumber: number;
          mode: "rewrite" | "rework" | "polish" | "anti-detect" | "spot-fix";
          text: string;
        }) => void;
      } | undefined;
      cfg?.onReviserPatchDelta?.({
        bookId: "demo-book",
        chapterNumber: 12,
        mode: "spot-fix",
        text: "--- PATCH 1 ---\nTARGET_TEXT:\n原句\nREPLACEMENT_TEXT:\n新句\n--- END PATCH ---\n",
      });
      return {
        chapterNumber: 12,
        wordCount: 3200,
        fixedIssues: ["- 修复了表达问题"],
        applied: false,
        status: "unchanged",
        skippedReason: "Manual revision did not improve merged audit or AI-tell metrics; kept original chapter.",
      };
    });
    loadChapterIndexMock.mockResolvedValueOnce([
      {
        number: 12,
        title: "SpotFix",
        status: "audit-failed",
        wordCount: 3200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        auditIssues: ["[critical] 冲突未收束"],
      },
    ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-spot-fix-patch-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "修订第12章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(eventsResponse, ["chapter:delta"], { timeoutMs: 3_000, minCount: 1 });
    const chapterDelta = events.find((event) => event.event === "chapter:delta");
    expect(chapterDelta?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      sequence: 1,
      previewType: "patch",
      chapterNumber: 12,
      mode: "spot-fix",
    });
    expect((chapterDelta?.data as any)?.text).toContain("PATCH 1");
  });

  it("emits thinking:start/delta/end with metadata during deterministic rewrite execution", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0012_Rewrite.md"), "# 第12章 Rewrite\n\nBody", "utf-8");
    getNextChapterNumberMock.mockResolvedValueOnce(12);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 11,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 12,
          title: "Rewritten 12",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 12,
      title: "Rewritten 12",
      wordCount: 3200,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "ok" },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-rewrite-thinking-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第12章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });
    expect(response.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["thinking:start", "thinking:delta", "thinking:end"],
      { timeoutMs: 6_000, minCount: 8 },
    );
    const start = events.find((event) => event.event === "thinking:start");
    const deltas = events.filter((event) => event.event === "thinking:delta");
    const end = events.find((event) => event.event === "thinking:end");

    expect(start?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      action: "rewrite",
      chapterNumber: 12,
      toolCallId: expect.any(String),
    });
    expect(
      deltas.some((event) => (event.data as any)?.text?.includes("开始执行 rewrite")),
    ).toBe(true);
    expect(
      deltas.some((event) => (event.data as any)?.text?.includes("rolling back to snapshot 11")),
    ).toBe(true);
    expect(
      deltas.every(
        (event) => (event.data as any)?.runId === runId
          && (event.data as any)?.action === "rewrite"
          && (event.data as any)?.toolCallId === (start?.data as any)?.toolCallId,
      ),
    ).toBe(true);
    expect(end?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      action: "rewrite",
      chapterNumber: 12,
      toolCallId: (start?.data as any)?.toolCallId,
    });
  });

  it("emits thinking:start/delta/end with metadata during deterministic target chapter write", async () => {
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 17,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 18,
          title: "Target",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockImplementationOnce(async () => {
      await writeFile(join(root, "books", "demo-book", "chapters", "0018_Target.md"), "# 第18章 Target\n\nBody", "utf-8");
      return {
        chapterNumber: 18,
        title: "Target",
        wordCount: 3200,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-target-thinking-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写第18章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });
    expect(response.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["thinking:start", "thinking:delta", "thinking:end"],
      { timeoutMs: 3_000, minCount: 6 },
    );
    const start = events.find((event) => event.event === "thinking:start");
    const deltas = events.filter((event) => event.event === "thinking:delta");
    const end = events.find((event) => event.event === "thinking:end");

    expect(start?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      action: "write-target-chapter",
      chapterNumber: 18,
      toolCallId: expect.any(String),
    });
    expect(
      deltas.some((event) => (event.data as any)?.text?.includes("Writer progress 1/1: chapter 18")),
    ).toBe(true);
    expect(
      deltas.some(
        (event) => (event.data as any)?.mode === "write-next"
          && (event.data as any)?.chapterNumber === 18,
      ),
    ).toBe(true);
    expect(end?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      action: "write-target-chapter",
      chapterNumber: 18,
      toolCallId: (start?.data as any)?.toolCallId,
    });
  });

  it("emits tool:update, chapter:delta and batch:progress with sessionId/runId payloads", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0015_Stream.md"), "# 第15章 Stream\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 14,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 14,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 15,
          title: "Stream",
          status: "ready-for-review",
          wordCount: 5200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "sub_agent",
        args: { agent: "writer", chapterCount: 3 },
      });
      args.onEvent?.({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "sub_agent",
        partialResult: {
          content: [{ type: "text", text: "Writing 3 consecutive chapters for \"demo-book\"..." }],
        },
      });
      args.onEvent?.({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "sub_agent",
        partialResult: {
          content: [{ type: "text", text: "Writer progress 1/3: chapter 15 (5200 words)." }],
        },
      });
      const cfg = pipelineConfigs.at(-1) as {
        onWriterTextDelta?: (payload: {
          bookId: string;
          chapterNumber: number;
          text: string;
          mode: "write-next" | "draft";
        }) => void;
      } | undefined;
      cfg?.onWriterTextDelta?.({
        bookId: "demo-book",
        chapterNumber: 15,
        mode: "write-next",
        text: "正文流测试片段",
      });
      args.onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "sub_agent",
        result: "ok",
        isError: false,
      });
      return {
        responseText: "done",
        messages: [{ role: "assistant", content: "done" }],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-sse-1";
    const agentResponse = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请写下一章并输出过程",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });
    expect(agentResponse.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["tool:update", "chapter:delta", "batch:progress"],
      { timeoutMs: 3_000, minCount: 5 },
    );
    const toolUpdate = events.find((event) => event.event === "tool:update");
    const chapterDelta = events.find((event) => event.event === "chapter:delta");
    const batchProgress = events.find((event) => event.event === "batch:progress" && (event.data as any)?.status === "progress");

    expect(toolUpdate?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      id: "tool-1",
      tool: "sub_agent",
      partialResult: {
        content: [{ type: "text", text: "Writing 3 consecutive chapters for \"demo-book\"..." }],
      },
    });
    expect(chapterDelta?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      sequence: 1,
      previewType: "chapter",
      bookId: "demo-book",
      chapterNumber: 15,
      mode: "write-next",
      text: "正文流测试片段",
    });
    expect(batchProgress?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      id: "tool-1",
      tool: "sub_agent",
      batchId: `${runId}:tool-1`,
      status: "progress",
      total: 3,
      completed: 1,
      currentChapter: 15,
      currentWords: 5200,
    });
  });

  it("emits log events with run/chapter context prefixes for writer progress", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0017_LogCtx.md"), "# 第17章 LogCtx\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 17,
          title: "LogCtx",
          status: "ready-for-review",
          wordCount: 4200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-logctx-1",
        toolName: "sub_agent",
        args: { agent: "writer", chapterCount: 1 },
      });
      args.onEvent?.({
        type: "tool_execution_update",
        toolCallId: "tool-logctx-1",
        toolName: "sub_agent",
        partialResult: {
          content: [{ type: "text", text: "Writer progress 1/1: chapter 17 (4200 words)." }],
        },
      });
      args.onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-logctx-1",
        toolName: "sub_agent",
        result: "ok",
        isError: false,
      });
      return {
        responseText: "done",
        messages: [{ role: "assistant", content: "done" }],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-logctx-1";
    const agentResponse = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请写下一章并记录日志上下文",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });
    expect(agentResponse.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["log"],
      { timeoutMs: 3_000, minCount: 3 },
    );
    const progressLog = events.find((event) =>
      event.event === "log"
      && typeof (event.data as any)?.message === "string"
      && ((event.data as any).message as string).includes("[writer:progress]"),
    );
    expect(progressLog?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      chapterNumber: 17,
    });
    expect((progressLog?.data as any)?.message).toContain(`[run:${runId}]`);
    expect((progressLog?.data as any)?.message).toContain("[chapter:17]");
  });

  it("emits synthetic draft:delta when upstream returns response text without text deltas", async () => {
    await writeFile(join(root, "books", "demo-book", "chapters", "0016_Fallback.md"), "# 第16章 Fallback\n\nBody", "utf-8");
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 15,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 15,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3200,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 16,
          title: "Fallback",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-writer-2",
        toolName: "sub_agent",
        args: { agent: "writer" },
      });
      args.onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-writer-2",
        toolName: "sub_agent",
        result: "ok",
        isError: false,
      });
      return {
        responseText: "这是兜底草稿流。",
        messages: [{ role: "assistant", content: "这是兜底草稿流。" }],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-sse-fallback-1";
    const agentResponse = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请写下一章并输出摘要",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });
    expect(agentResponse.status).toBe(200);

    const events = await collectSSEEvents(
      eventsResponse,
      ["draft:delta"],
      { timeoutMs: 3_000, minCount: 1 },
    );
    expect(events[0]?.data).toMatchObject({
      sessionId: "agent-session-1",
      runId,
      text: "这是兜底草稿流。",
    });
  });

  it("returns AGENT_WRITE_NOT_EXECUTED when write intent does not call writer tool", async () => {
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockResolvedValueOnce({
      responseText: "已完成第17章。",
      messages: [{ role: "assistant", content: "已完成第17章。" }],
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请写下一章并说明完成情况",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_NOT_EXECUTED",
      },
    });
  });

  it("repairs missing chapter index deterministically for persistence-repair command", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0019_Repair.md"),
      "# 第19章 自动修复\n\n正文用于索引修复。",
      "utf-8",
    );
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 18,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 18,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 18,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 19,
          title: "自动修复",
          status: "ready-for-review",
          wordCount: 9,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 18,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 19,
          title: "自动修复",
          status: "ready-for-review",
          wordCount: 9,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "修复第19章落库和索引",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: expect.stringContaining("第19章正文已落盘"),
    });
    expect(runAgentSessionMock).not.toHaveBeenCalled();
    expect(saveChapterIndexMock).toHaveBeenCalledTimes(1);
    expect(saveChapterIndexMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 19,
          status: "ready-for-review",
        }),
      ]),
    );
  });

  it("returns AGENT_TOOL_CALL_BLOCKED when model emits blocked tool-call marker without execution", async () => {
    runAgentSessionMock.mockResolvedValueOnce({
      responseText: "我来检查。minimax:tool_call [blocked] books/demo-book/chapters/index.json </minimax:tool_call>",
      messages: [{
        role: "assistant",
        content: "我来检查。minimax:tool_call [blocked] books/demo-book/chapters/index.json </minimax:tool_call>",
      }],
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请检查当前作品状态",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_TOOL_CALL_BLOCKED",
      },
    });
    expect(appendBookSessionMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        bookId: "demo-book",
        title: null,
        messages: [],
      }),
      expect.objectContaining({
        role: "user",
        content: "请检查当前作品状态",
      }),
    );
    expect(persistBookSessionMock).toHaveBeenCalledTimes(2);
    expect(persistBookSessionMock.mock.calls[0]?.[1]).toMatchObject({
      sessionId: "agent-session-1",
      title: expect.any(String),
      messages: [
        expect.objectContaining({
          role: "user",
          content: "请检查当前作品状态",
        }),
      ],
    });
    expect(persistBookSessionMock.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "agent-session-1",
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("✗ 当前模型返回了被拦截的工具调用"),
        }),
      ]),
    });
  });

  it("returns AGENT_WRITE_NOT_PERSISTED when writer succeeds but no chapter index is added", async () => {
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-writer-3",
        toolName: "sub_agent",
        args: { agent: "writer" },
      });
      args.onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-writer-3",
        toolName: "sub_agent",
        result: "ok",
        isError: false,
      });
      return {
        responseText: "已完成第17章。",
        messages: [{ role: "assistant", content: "已完成第17章。" }],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请写下一章并说明完成情况",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_NOT_PERSISTED",
      },
    });
  });

  it("returns AGENT_WRITE_NOT_PERSISTED when deterministic rewrite does not persist chapter artifacts", async () => {
    getNextChapterNumberMock.mockResolvedValueOnce(30);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 29,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 29,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 29,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 30,
      title: "Ghost Rewrite",
      wordCount: 2800,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "ok" },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第30章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_NOT_PERSISTED",
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 29);
    expect(writeNextChapterMock).toHaveBeenCalledWith("demo-book", undefined, undefined, { quickMode: false });
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns AGENT_WRITE_NOT_PERSISTED when deterministic rewrite batch does not persist chapter artifacts", async () => {
    getNextChapterNumberMock.mockResolvedValueOnce(20);
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 19,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 19,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 19,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 3000,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    writeNextChapterMock
      .mockResolvedValueOnce({
        chapterNumber: 20,
        title: "Ghost Rewrite 20",
        wordCount: 2800,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      })
      .mockResolvedValueOnce({
        chapterNumber: 21,
        title: "Ghost Rewrite 21",
        wordCount: 2900,
        revised: false,
        status: "ready-for-review",
        auditResult: { passed: true, issues: [], summary: "ok" },
      });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写20到21章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_NOT_PERSISTED",
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 19);
    expect(writeNextChapterMock).toHaveBeenCalledTimes(2);
    expect(writeNextChapterMock).toHaveBeenNthCalledWith(1, "demo-book", undefined, undefined, { quickMode: false });
    expect(writeNextChapterMock).toHaveBeenNthCalledWith(2, "demo-book", undefined, undefined, { quickMode: false });
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns AGENT_WRITE_DEGRADED with recovery details for deterministic write-next", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0004_Degraded Write.md"),
      "# 第4章\n\ndegraded body",
      "utf-8",
    );
    const beforeIndex = [
      {
        number: 3,
        title: "Prev",
        status: "ready-for-review",
        wordCount: 3000,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    const degradedIndex = [
      ...beforeIndex,
      {
        number: 4,
        title: "Degraded Write",
        status: "state-degraded",
        wordCount: 120,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock
      .mockResolvedValueOnce(beforeIndex)
      .mockResolvedValue(degradedIndex);
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 4,
      title: "Degraded Write",
      wordCount: 120,
      revised: false,
      status: "state-degraded",
      auditResult: { passed: false, issues: [], summary: "degraded" },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写下一章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_DEGRADED",
      },
      response: expect.stringContaining("可执行修复：修复第4章落库和索引。"),
      details: {
        writeIntegrity: {
          addedChapterNumbers: [4],
          missingChapterFiles: [],
          degradedChapterNumbers: [4],
        },
        degradedRecovery: {
          attempted: true,
          attemptedChapterNumber: 4,
          recovered: false,
          remainingDegradedChapterNumbers: [4],
          suggestion: "可执行修复：修复第4章落库和索引。",
        },
      },
    });
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(resyncChapterArtifactsMock).toHaveBeenCalledWith("demo-book", 4);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns AGENT_WRITE_DEGRADED when deterministic rewrite settles chapter as state-degraded", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0023_Degraded Rewrite.md"),
      "# 第23章\n\ndegraded body",
      "utf-8",
    );
    getNextChapterNumberMock.mockResolvedValueOnce(23);
    const beforeIndex = [
      {
        number: 22,
        title: "Prev",
        status: "ready-for-review",
        wordCount: 3000,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    const degradedIndex = [
      ...beforeIndex,
      {
        number: 23,
        title: "Degraded Rewrite",
        status: "state-degraded",
        wordCount: 35,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock
      .mockResolvedValueOnce(beforeIndex)
      .mockResolvedValueOnce(beforeIndex)
      .mockResolvedValue(degradedIndex);
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 23,
      title: "Degraded Rewrite",
      wordCount: 35,
      revised: true,
      status: "state-degraded",
      auditResult: { passed: false, issues: [], summary: "degraded" },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第23章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_DEGRADED",
      },
      details: {
        degradedRecovery: {
          attempted: true,
          recovered: false,
          remainingDegradedChapterNumbers: [23],
        },
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 22);
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns AGENT_WRITE_DEGRADED when deterministic rewrite batch hits a state-degraded chapter", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0022_Degraded Rewrite.md"),
      "# 第22章\n\ndegraded body",
      "utf-8",
    );
    getNextChapterNumberMock.mockResolvedValueOnce(22);
    const beforeIndex = [
      {
        number: 21,
        title: "Prev",
        status: "ready-for-review",
        wordCount: 3000,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    const degradedIndex = [
      ...beforeIndex,
      {
        number: 22,
        title: "Degraded Rewrite 22",
        status: "state-degraded",
        wordCount: 35,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock
      .mockResolvedValueOnce(beforeIndex)
      .mockResolvedValueOnce(beforeIndex)
      .mockResolvedValue(degradedIndex);
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 22,
      title: "Degraded Rewrite 22",
      wordCount: 35,
      revised: true,
      status: "state-degraded",
      auditResult: { passed: false, issues: [], summary: "degraded" },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第22-23章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_DEGRADED",
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 21);
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("maps state-degraded precondition errors to AGENT_WRITE_DEGRADED for deterministic rewrite", async () => {
    getNextChapterNumberMock.mockResolvedValueOnce(23);
    loadChapterIndexMock.mockResolvedValue([
      {
        number: 22,
        title: "Prev",
        status: "state-degraded",
        wordCount: 35,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ]);
    writeNextChapterMock.mockRejectedValueOnce(
      new Error("Latest chapter 22 is state-degraded. Repair state or rewrite that chapter before continuing."),
    );

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "重写第23章并回滚后续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_WRITE_DEGRADED",
      },
    });
    expect(rollbackToChapterMock).toHaveBeenCalledWith("demo-book", 22);
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(runAgentSessionMock).not.toHaveBeenCalled();
  });

  it("auto-repairs missing chapter index from disk and emits persist telemetry events", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0017_AutoRepair.md"),
      "# 第17章 自动修复\n\n正文内容用于索引修复。",
      "utf-8",
    );
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
        {
          number: 17,
          title: "自动修复",
          status: "ready-for-review",
          wordCount: 12,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ]);
    runAgentSessionMock.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-writer-repair",
        toolName: "sub_agent",
        args: { agent: "writer" },
      });
      args.onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-writer-repair",
        toolName: "sub_agent",
        result: "ok",
        isError: false,
      });
      return {
        responseText: "已完成第17章。",
        messages: [{ role: "assistant", content: "已完成第17章。" }],
      };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const eventsResponse = await app.request("http://localhost/api/v1/events");
    expect(eventsResponse.status).toBe(200);

    const runId = "run-repair-1";
    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "请写下一章并说明完成情况",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
        runId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId,
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [17],
            repairedChapterNumbers: [17],
          },
        },
      },
    });
    expect(saveChapterIndexMock).toHaveBeenCalledTimes(1);
    expect(saveChapterIndexMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 17,
          status: "ready-for-review",
        }),
      ]),
    );

    const events = await collectSSEEvents(
      eventsResponse,
      ["persist:check", "persist:repair"],
      { timeoutMs: 3_000, minCount: 4 },
    );
    expect(
      events.some(
        (event) => event.event === "persist:repair"
          && (event.data as any)?.status === "completed"
          && Array.isArray((event.data as any)?.repairedChapterNumbers)
          && (event.data as any).repairedChapterNumbers.includes(17),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.event === "persist:check"
          && (event.data as any)?.status === "completed"
          && (event.data as any)?.persisted === true,
      ),
    ).toBe(true);
  });

  it("keeps chapter file and chapter index visible after chat write-next command", async () => {
    await writeFile(
      join(root, "books", "demo-book", "chapters", "0017_Visible.md"),
      "# 第17章 可见性校验\n\n这是用于联调验证的章节正文。",
      "utf-8",
    );
    const visibleChapterIndex = [
      {
        number: 16,
        title: "Prev",
        status: "ready-for-review",
        wordCount: 2800,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
      {
        number: 17,
        title: "Visible",
        status: "ready-for-review",
        wordCount: 3200,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      },
    ];
    loadChapterIndexMock
      .mockResolvedValueOnce([
        {
          number: 16,
          title: "Prev",
          status: "ready-for-review",
          wordCount: 2800,
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce(visibleChapterIndex)
      .mockResolvedValueOnce(visibleChapterIndex)
      .mockResolvedValueOnce(visibleChapterIndex)
      .mockResolvedValue(visibleChapterIndex);
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 17,
      title: "Visible",
      wordCount: 3200,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "ok" },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const agentResponse = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "写下一章",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(agentResponse.status).toBe(200);
    await expect(agentResponse.json()).resolves.toMatchObject({
      details: {
        effects: {
          writeNext: {
            persisted: true,
            addedChapterNumbers: [17],
          },
        },
      },
    });
    await expect(access(join(root, "books", "demo-book", "chapters", "0017_Visible.md"))).resolves.toBeUndefined();

    const detailResponse = await app.request("http://localhost/api/v1/books/demo-book");
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      chapters: expect.arrayContaining([
        expect.objectContaining({
          number: 17,
          title: "Visible",
          status: "ready-for-review",
        }),
      ]),
    });
  });

  it("allows /api/agent to use explicit service+model when Studio config has no defaultModel", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      ...projectConfig,
      llm: {
        configSource: "studio",
        services: [
          { service: "custom", name: "CodexForMe", baseUrl: "https://api-vip.codex-for.me/v1", apiFormat: "responses", stream: false },
        ],
      },
    }, null, 2), "utf-8");
    loadProjectConfigMock.mockImplementation(async () => {
      const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, unknown>;
      return {
        ...cloneProjectConfig(),
        ...raw,
        llm: {
          ...cloneProjectConfig().llm,
          ...((raw.llm ?? {}) as Record<string, unknown>),
        },
        daemon: {
          ...cloneProjectConfig().daemon,
          ...((raw.daemon ?? {}) as Record<string, unknown>),
        },
        modelOverrides: (raw.modelOverrides ?? {}) as Record<string, unknown>,
        notify: (raw.notify ?? []) as unknown[],
      };
    });
    resolveServiceModelMock.mockResolvedValue({
      model: { id: "gpt-5.4", provider: "custom", api: "openai-responses" },
      apiKey: "sk-test",
    });
    runAgentSessionMock.mockResolvedValueOnce({
      responseText: "你好，我在。",
      messages: [
        { role: "user", content: "nihao" },
        { role: "assistant", content: "你好，我在。" },
      ],
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "nihao",
        service: "custom:CodexForMe",
        model: "gpt-5.4",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "你好，我在。",
      runId: expect.any(String),
    });
  });

  it("returns 500 with an error payload when the agent session fails", async () => {
    runAgentSessionMock.mockRejectedValueOnce(new Error("boom"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "continue", activeBookId: "demo-book", sessionId: "agent-session-1" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_ERROR",
        message: "boom",
      },
    });
    expect(appendBookSessionMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        bookId: "demo-book",
        title: null,
        messages: [],
      }),
      expect.objectContaining({
        role: "user",
        content: "continue",
      }),
    );
    expect(persistBookSessionMock).toHaveBeenCalledTimes(2);
    expect(persistBookSessionMock.mock.calls[0]?.[1]).toMatchObject({
      sessionId: "agent-session-1",
      title: "continue",
      messages: [
        expect.objectContaining({
          role: "user",
          content: "continue",
        }),
      ],
    });
    expect(persistBookSessionMock.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "agent-session-1",
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("✗ boom"),
        }),
      ]),
    });
  });

  it("maps non-deterministic /agent upstream 410(no body) to AGENT_UPSTREAM_ERROR 502", async () => {
    runAgentSessionMock.mockRejectedValueOnce(new Error("410 status code (no body)"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "继续",
        activeBookId: "demo-book",
        sessionId: "agent-session-1",
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_UPSTREAM_ERROR",
        message: expect.stringContaining("HTTP 410"),
      },
      response: expect.stringContaining("HTTP 410"),
    });
  });

  it("probes the upstream when the agent returns empty text and surfaces the real error", async () => {
    runAgentSessionMock.mockResolvedValueOnce({
      responseText: "",
      messages: [{ role: "user", content: "nihao" }],
    });
    chatCompletionMock.mockRejectedValue(new Error("quota exhausted"));

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "nihao", activeBookId: "demo-book", sessionId: "agent-session-1" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AGENT_EMPTY_RESPONSE",
        message: "quota exhausted",
      },
      response: "quota exhausted",
    });
  });

  it("falls back to plain chat when the tool-agent returns empty text", async () => {
    runAgentSessionMock.mockResolvedValueOnce({
      responseText: "",
      messages: [{ role: "user", content: "nihao" }],
    });
    chatCompletionMock.mockResolvedValueOnce({
      content: "你好！",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "nihao", activeBookId: "demo-book", sessionId: "agent-session-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "你好！",
      session: { sessionId: "agent-session-1" },
    });
    expect(upsertBookSessionMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "你好！",
        thinkingStreaming: false,
      }),
    );
  });

  it("exposes /api/v1/agent/stop and returns stopped=false when no run is active", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "agent-session-1",
        runId: "run-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      stopped: false,
      sessionId: "agent-session-1",
      runId: "run-1",
    });
  });

  it("exposes /api/v1/agent/status and returns running=false when no run is active", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request(
      "http://localhost/api/v1/agent/status?sessionId=agent-session-1&runId=run-1",
      { method: "GET" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      running: false,
      sessionId: "agent-session-1",
      runId: "run-1",
    });
  });

  it("exposes /api/v1/agent/status and returns running=true for active run", async () => {
    let capturedAbortSignal: AbortSignal | null = null;
    runAgentSessionMock.mockImplementationOnce(async (args: { signal?: AbortSignal }) => {
      capturedAbortSignal = args.signal ?? null;
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      return { responseText: "ok", messages: [] };
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);
    const requestPromise = app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "nihao", activeBookId: "demo-book", sessionId: "agent-session-1", runId: "run-active" }),
    });

    await vi.waitFor(() => {
      expect(capturedAbortSignal).not.toBeNull();
    });

    const statusResponse = await app.request(
      "http://localhost/api/v1/agent/status?sessionId=agent-session-1&runId=run-active",
      { method: "GET" },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      ok: true,
      running: true,
      sessionId: "agent-session-1",
      runId: "run-active",
      aborted: false,
    });

    await requestPromise;
  });

  it("rejects /api/v1/agent requests without sessionId", async () => {
    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "continue", activeBookId: "demo-book" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "SESSION_ID_REQUIRED",
        message: "sessionId is required",
      },
    });
  });

  it("returns the shared interaction session state", async () => {
    loadProjectSessionMock.mockResolvedValue({
      sessionId: "session-2",
      projectRoot: root,
      activeBookId: "demo-book",
      automationMode: "auto",
      messages: [
        { role: "user", content: "continue", timestamp: 1 },
      ],
    });
    resolveSessionActiveBookMock.mockResolvedValue("demo-book");

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/interaction/session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: expect.objectContaining({
        activeBookId: "demo-book",
        automationMode: "auto",
      }),
      activeBookId: "demo-book",
    });
  });

  it("returns creation-draft state through the shared interaction session endpoint", async () => {
    loadProjectSessionMock.mockResolvedValue({
      sessionId: "session-3",
      projectRoot: root,
      automationMode: "semi",
      creationDraft: {
        concept: "港风商战悬疑，主角从灰产洗白。",
        title: "夜港账本",
        nextQuestion: "你更想写长篇连载，还是十来章能收住？",
        missingFields: ["targetChapters"],
        readyToCreate: false,
      },
      messages: [],
    });
    resolveSessionActiveBookMock.mockResolvedValue(undefined);

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/interaction/session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      session: expect.objectContaining({
        creationDraft: expect.objectContaining({
          title: "夜港账本",
          nextQuestion: "你更想写长篇连载，还是十来章能收住？",
        }),
      }),
    });
  });

  it("posts structured interaction requests through the shared interaction session endpoint", async () => {
    processProjectInteractionRequestMock.mockResolvedValueOnce({
      request: { intent: "advance_book_wizard" },
      session: {
        sessionId: "session-4",
        projectRoot: root,
        automationMode: "semi",
        creationDraft: {
          concept: "港风商战悬疑，主角从灰产洗白。",
          blurb: "港口账本牵出灰产洗白风暴。",
          storyBackground: "港城、账本、灰产洗白。",
          missingFields: [],
          readyToCreate: false,
        },
        creationWizard: {
          currentStep: "world",
          completedSteps: ["intro"],
          stepNotes: {},
        },
        messages: [],
        events: [],
      },
      responseText: "已完成简介 / 故事背景并进入下一步。",
    });

    const { createStudioServer } = await import("./server.js");
    const app = createStudioServer(cloneProjectConfig() as never, root);

    const response = await app.request("http://localhost/api/v1/interaction/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          intent: "advance_book_wizard",
          instruction: "确认当前简介页，进入世界观。",
          wizardStep: "intro",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: "已完成简介 / 故事背景并进入下一步。",
      session: expect.objectContaining({
        creationWizard: expect.objectContaining({
          currentStep: "world",
        }),
      }),
    });
    expect(processProjectInteractionRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: root,
      activeBookId: undefined,
      request: expect.objectContaining({
        intent: "advance_book_wizard",
        wizardStep: "intro",
      }),
    }));
  });
});
