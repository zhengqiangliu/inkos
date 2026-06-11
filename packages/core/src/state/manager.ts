import { readFile, writeFile, mkdir, readdir, rm, stat, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { BookCreationWizardStep } from "../interaction/session.js";
import { bootstrapStructuredStateFromMarkdown, resolveDurableStoryProgress } from "./state-bootstrap.js";

const BOOK_CREATION_WIZARD_STEPS: ReadonlyArray<BookCreationWizardStep> = [
  "intro",
  "world",
  "outline",
  "volume",
  "characters",
  "arc",
  "relation",
];

const WIZARD_STEP_FILE_NAMES: Readonly<Record<BookCreationWizardStep, string>> = {
  intro: "intro.md",
  world: "world.md",
  outline: "outline.md",
  volume: "volume.md",
  characters: "characters.md",
  arc: "character_arc.md",
  relation: "relationship_map.md",
};

const LEGACY_WIZARD_STEP_FILE_NAMES: Readonly<Partial<Record<BookCreationWizardStep, string>>> = {
  arc: "arc.md",
};

type WizardStepStatus = "empty" | "saved" | "dirty";

interface WizardStepFileRecord {
  readonly status: WizardStepStatus;
  readonly version: number;
  readonly updatedAt?: string;
}

interface WizardIndexFile {
  readonly version: 1;
  readonly bookShellCreated: boolean;
  readonly currentStep: BookCreationWizardStep;
  readonly updatedAt: string;
  readonly steps: Record<BookCreationWizardStep, WizardStepFileRecord>;
}

interface PromotableWizardFile {
  readonly step: BookCreationWizardStep;
  readonly source: string;
  readonly targets: ReadonlyArray<string>;
}

const PROMOTABLE_WIZARD_FILES: ReadonlyArray<PromotableWizardFile> = [
  {
    step: "intro",
    source: "intro.md",
    targets: ["story/foundation_brief.md"],
  },
  {
    step: "world",
    source: "world.md",
    targets: ["story/outline/story_frame.md", "story/story_bible.md"],
  },
  {
    step: "outline",
    source: "outline.md",
    targets: ["story/novel_outline.md"],
  },
  {
    step: "volume",
    source: "volume.md",
    targets: ["story/outline/volume_map.md", "story/volume_outline.md"],
  },
  {
    step: "characters",
    source: "characters.md",
    targets: ["story/character_matrix.md"],
  },
  {
    step: "arc",
    source: "character_arc.md",
    targets: ["story/character_arc.md"],
  },
  {
    step: "relation",
    source: "relationship_map.md",
    targets: ["story/relationship_map.md"],
  },
];

function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function extractMarkdownSummary(raw: string, maxChars: number = 220): string {
  const text = collapseWhitespace(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^#{1,6}\s+/.test(line) && line !== "---")
      .join(" "),
  );
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildDefaultBookRulesMarkdown(
  book: BookConfig,
  inputs: {
    readonly outline: string;
    readonly volume: string;
    readonly characters: string;
    readonly arc: string;
    readonly relation: string;
    readonly world: string;
  },
): string {
  const isEn = book.language === "en";
  const heading = isEn ? "# Book Rules" : "# 叙事规则";
  const lead = isEn
    ? "This file is auto-seeded from the wizard. Refine it after creation if needed."
    : "本文件由建书向导自动生成，完成创建后可继续细化。";
  const rules = isEn
    ? [
      "Stay aligned with the generated outline and volume map.",
      "Do not introduce new setting conflicts during the creation phase.",
      "Keep protagonist behavior and pacing consistent with the wizard draft.",
    ]
    : [
      "严格遵守已生成的大纲与卷纲，不要在创建阶段随意偏航。",
      "不要引入与既有设定冲突的新规则或新设定。",
      "主角行为、章节节奏与向导草案保持一致。",
    ];
  const sources = [
    { heading: isEn ? "## Novel Outline" : "## 小说大纲", value: extractMarkdownSummary(inputs.outline) },
    { heading: isEn ? "## Volume Map" : "## 卷纲规划", value: extractMarkdownSummary(inputs.volume) },
    { heading: isEn ? "## World Notes" : "## 世界观摘要", value: extractMarkdownSummary(inputs.world) },
    { heading: isEn ? "## Characters" : "## 角色摘要", value: extractMarkdownSummary(inputs.characters) },
    { heading: isEn ? "## Character Arc" : "## 人物弧光", value: extractMarkdownSummary(inputs.arc) },
    { heading: isEn ? "## Relationship Map" : "## 人物关系", value: extractMarkdownSummary(inputs.relation) },
  ].filter((entry) => entry.value.length > 0);

  const lines = [
    "---",
    'version: "1.0"',
    "genreLock:",
    `  primary: ${JSON.stringify(book.genre)}`,
    "  forbidden: []",
    "dialogueQuotePolicy:",
    "  mode: auto",
    "  strict: false",
    "  autoNormalize: false",
    "openingThreeChapters:",
    "  enabled: true",
    "  applyInGovernedMode: true",
    "  strict: true",
    "  maxCharacters: 5",
    "prohibitions:",
    `  - ${JSON.stringify(rules[0] ?? "")}`,
    `  - ${JSON.stringify(rules[1] ?? "")}`,
    `  - ${JSON.stringify(rules[2] ?? "")}`,
    "chapterTypesOverride: []",
    "fatigueWordsOverride: []",
    "additionalAuditDimensions: []",
    "enableFullCastTracking: false",
    "---",
    "",
    heading,
    "",
    lead,
    "",
    "## 项目摘要",
    `- ${isEn ? "Title" : "书名"}：${book.title}`,
    `- ${isEn ? "Genre" : "题材"}：${book.genre}`,
    ...(typeof book.targetChapters === "number" ? [`- ${isEn ? "Target chapters" : "目标章数"}：${book.targetChapters}`] : []),
    ...(typeof book.chapterWordCount === "number" ? [`- ${isEn ? "Words per chapter" : "每章字数"}：${book.chapterWordCount}`] : []),
    "",
    "## 规则说明",
    ...rules.map((rule) => `- ${rule}`),
    "",
    "## 向导资料快照",
    ...sources.flatMap((source) => [source.heading, "", source.value, ""]),
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

export class StateManager {
  /** Books actively being written by this process — used for same-process stale lock detection. */
  private readonly activeWrites = new Set<string>();

  constructor(private readonly projectRoot: string) {}

  private static defaultAuthorIntent(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 作者意图\n\n（在这里描述这本书的长期创作方向。）\n"
      : "# Author Intent\n\n(Describe the long-horizon vision for this book here.)\n";
  }

  private static defaultCurrentFocus(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 当前聚焦\n\n## 当前重点\n\n（描述接下来 1-3 章最需要优先推进的内容。）\n"
      : "# Current Focus\n\n## Active Focus\n\n(Describe what the next 1-3 chapters should prioritize.)\n";
  }

  async ensureControlDocuments(
    bookId: string,
    authorIntent?: string,
    foundationBrief?: string,
  ): Promise<void> {
    const language = await this.resolveControlDocumentLanguage(bookId);
    await this.ensureControlDocumentsAt(this.bookDir(bookId), language, authorIntent, foundationBrief);
  }

  async ensureControlDocumentsAt(
    bookDir: string,
    language: "zh" | "en",
    authorIntent?: string,
    foundationBrief?: string,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");

    await mkdir(storyDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });

    await this.writeIfMissing(
      join(storyDir, "author_intent.md"),
      authorIntent?.trim()
        ? authorIntent.trimEnd() + "\n"
        : StateManager.defaultAuthorIntent(language),
    );

    await this.writeIfMissing(
      join(storyDir, "current_focus.md"),
      StateManager.defaultCurrentFocus(language),
    );

    if (foundationBrief?.trim()) {
      const briefText = foundationBrief.trimEnd() + "\n";
      await this.writeIfMissing(join(storyDir, "foundation_brief.md"), briefText);
    }
  }

  async loadControlDocuments(bookId: string): Promise<{
    authorIntent: string;
    currentFocus: string;
    runtimeDir: string;
  }> {
    await this.ensureControlDocuments(bookId);

    const storyDir = join(this.bookDir(bookId), "story");
    const runtimeDir = join(storyDir, "runtime");
    const [authorIntent, currentFocus] = await Promise.all([
      readFile(join(storyDir, "author_intent.md"), "utf-8"),
      readFile(join(storyDir, "current_focus.md"), "utf-8"),
    ]);

    return { authorIntent, currentFocus, runtimeDir };
  }

  private async resolveControlDocumentLanguage(bookId: string): Promise<"zh" | "en"> {
    try {
      const raw = await readFile(join(this.bookDir(bookId), "book.json"), "utf-8");
      const parsed = JSON.parse(raw) as { language?: unknown };
      return parsed.language === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  }

  async acquireBookLock(bookId: string): Promise<() => Promise<void>> {
    await mkdir(this.bookDir(bookId), { recursive: true });
    const lockPath = join(this.bookDir(bookId), ".write.lock");
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
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        const lockData = await readFile(lockPath, "utf-8").catch(() => "pid:unknown ts:unknown");
        const lockPid = this.extractLockPid(lockData);
        const isStale =
          (lockPid !== undefined && !this.isProcessAlive(lockPid)) ||
          (lockPid === process.pid && !this.activeWrites.has(bookId));
        if (isStale) {
          await unlink(lockPath).catch(() => undefined);
          return this.acquireBookLock(bookId);
        }
        throw new Error(
          `Book "${bookId}" is locked by another process (${lockData}). ` +
            `If this is stale, delete ${lockPath}`,
        );
      }
      throw e;
    }
    this.activeWrites.add(bookId);
    return async () => {
      this.activeWrites.delete(bookId);
      try {
        await unlink(lockPath);
      } catch {
        // ignore
      }
    };
  }

  private extractLockPid(lockData: string): number | undefined {
    const match = lockData.match(/pid:(\d+)/);
    if (!match) return undefined;
    const pid = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
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

  get booksDir(): string {
    return join(this.projectRoot, "books");
  }

  get projectRootDir(): string {
    return this.projectRoot;
  }

  bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  stateDir(bookId: string): string {
    return join(this.bookDir(bookId), "story", "state");
  }

  async loadProjectConfig(): Promise<Record<string, unknown>> {
    const configPath = join(this.projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  }

  async saveProjectConfig(config: Record<string, unknown>): Promise<void> {
    const configPath = join(this.projectRoot, "inkos.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  async loadBookConfig(bookId: string): Promise<BookConfig> {
    const configPath = join(this.bookDir(bookId), "book.json");
    const raw = await readFile(configPath, "utf-8");
    if (!raw.trim()) {
      throw new Error(`book.json is empty for book "${bookId}"`);
    }
    return JSON.parse(raw) as BookConfig;
  }

  async saveBookConfig(bookId: string, config: BookConfig): Promise<void> {
    await this.saveBookConfigAt(this.bookDir(bookId), config);
  }

  async markBookReady(bookId: string): Promise<BookConfig> {
    const book = await this.loadBookConfig(bookId);
    await this.promoteWizardArtifacts(bookId);
    const nextBook: BookConfig = {
      ...book,
      creationState: "ready",
      updatedAt: new Date().toISOString(),
    };
    await this.saveBookConfig(bookId, nextBook);
    return nextBook;
  }

  async ensurePromotedWizardArtifacts(bookId: string): Promise<boolean> {
    const book = await this.loadBookConfig(bookId).catch(() => null);
    if (!book || book.creationState !== "ready") {
      return false;
    }

    const storyDir = join(this.bookDir(bookId), "story");
    const outlineDir = join(storyDir, "outline");
    const checks = [
      join(outlineDir, "volume_map.md"),
      join(outlineDir, "story_frame.md"),
      join(storyDir, "story_bible.md"),
      join(storyDir, "book_rules.md"),
      join(storyDir, "character_matrix.md"),
      join(storyDir, "character_arc.md"),
      join(storyDir, "relationship_map.md"),
    ];
    const missing = await Promise.all(checks.map(async (path) => {
      try {
        const content = await readFile(path, "utf-8");
        return !content.trim();
      } catch {
        return true;
      }
    }));
    if (missing.every((item) => !item)) {
      return false;
    }

    await this.promoteWizardArtifacts(bookId);
    return true;
  }

  async saveBookConfigAt(bookDir: string, config: BookConfig): Promise<void> {
    await mkdir(bookDir, { recursive: true });
    await writeFile(
      join(bookDir, "book.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  async promoteWizardArtifacts(bookId: string): Promise<void> {
    const bookDir = this.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const outlineDir = join(storyDir, "outline");
    const wizardDir = this.wizardDir(bookId);
    await mkdir(storyDir, { recursive: true });
    await mkdir(outlineDir, { recursive: true });

    for (const file of PROMOTABLE_WIZARD_FILES) {
      const sourcePath = join(wizardDir, file.source);
      const content = await readFile(sourcePath, "utf-8").catch(() => "");
      if (!content.trim()) continue;
      const normalized = content.trimEnd() + "\n";
      await Promise.all(file.targets.map(async (target) => {
        const targetPath = join(bookDir, target);
        await mkdir(join(targetPath, ".."), { recursive: true }).catch(() => undefined);
        await writeFile(targetPath, normalized, "utf-8");
      }));
    }

    const existingRules = await readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => "");
    if (!existingRules.trim()) {
      const [book, world, outline, volume, characters, arc, relation] = await Promise.all([
        this.loadBookConfig(bookId).catch(() => null),
        readFile(join(wizardDir, "world.md"), "utf-8").catch(() => ""),
        readFile(join(wizardDir, "outline.md"), "utf-8").catch(() => ""),
        readFile(join(wizardDir, "volume.md"), "utf-8").catch(() => ""),
        readFile(join(wizardDir, "characters.md"), "utf-8").catch(() => ""),
        readFile(join(wizardDir, "character_arc.md"), "utf-8").catch(() => ""),
        readFile(join(wizardDir, "relationship_map.md"), "utf-8").catch(() => ""),
      ]);
      if (book) {
        await writeFile(
          join(storyDir, "book_rules.md"),
          buildDefaultBookRulesMarkdown(book, {
            world,
            outline,
            volume,
            characters,
            arc,
            relation,
          }),
          "utf-8",
        );
      }
    }
  }

  private wizardDir(bookId: string): string {
    return join(this.bookDir(bookId), "wizard");
  }

  private wizardIndexPath(bookId: string): string {
    return join(this.wizardDir(bookId), "index.json");
  }

  private wizardStepPath(bookId: string, step: BookCreationWizardStep): string {
    return join(this.wizardDir(bookId), WIZARD_STEP_FILE_NAMES[step]);
  }

  private legacyWizardStepPath(bookId: string, step: BookCreationWizardStep): string | null {
    const legacyFileName = LEGACY_WIZARD_STEP_FILE_NAMES[step];
    if (!legacyFileName) return null;
    return join(this.wizardDir(bookId), legacyFileName);
  }

  private defaultWizardIndex(now = new Date().toISOString()): WizardIndexFile {
    const steps = Object.fromEntries(
      BOOK_CREATION_WIZARD_STEPS.map((step) => [step, { status: "empty" as const, version: 0, updatedAt: undefined }]),
    ) as WizardIndexFile["steps"];
    return {
      version: 1,
      bookShellCreated: false,
      currentStep: "intro",
      updatedAt: now,
      steps,
    };
  }

  async ensureBookWizardIndex(bookId: string): Promise<WizardIndexFile> {
    const wizardDir = this.wizardDir(bookId);
    await mkdir(wizardDir, { recursive: true });
    const indexPath = this.wizardIndexPath(bookId);
    try {
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<WizardIndexFile>;
      const defaults = this.defaultWizardIndex(parsed.updatedAt ?? new Date().toISOString());
      const steps = { ...defaults.steps };
      for (const step of BOOK_CREATION_WIZARD_STEPS) {
        const record = parsed.steps?.[step];
        if (!record) continue;
        steps[step] = {
          status: record.status === "empty" || record.status === "saved" || record.status === "dirty" ? record.status : "empty",
          version: Number.isFinite(record.version) ? Math.max(0, Math.trunc(Number(record.version))) : 0,
          ...(typeof record.updatedAt === "string" && record.updatedAt.trim() ? { updatedAt: record.updatedAt.trim() } : {}),
        };
      }
      return {
        ...defaults,
        ...(parsed.version === 1 ? { version: 1 as const } : {}),
        ...(typeof parsed.bookShellCreated === "boolean" ? { bookShellCreated: parsed.bookShellCreated } : {}),
        ...(BOOK_CREATION_WIZARD_STEPS.includes(parsed.currentStep as BookCreationWizardStep)
          ? { currentStep: parsed.currentStep as BookCreationWizardStep }
          : {}),
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : defaults.updatedAt,
        steps,
      };
    } catch {
      const index = this.defaultWizardIndex();
      await writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
      return index;
    }
  }

  async loadBookWizardState(bookId: string): Promise<WizardIndexFile> {
    return this.ensureBookWizardIndex(bookId);
  }

  async saveBookWizardState(bookId: string, state: WizardIndexFile): Promise<void> {
    const wizardDir = this.wizardDir(bookId);
    await mkdir(wizardDir, { recursive: true });
    await writeFile(this.wizardIndexPath(bookId), JSON.stringify(state, null, 2), "utf-8");
  }

  async loadBookWizardStep(bookId: string, step: BookCreationWizardStep): Promise<{
    readonly content: string;
    readonly status: WizardStepStatus;
    readonly version: number;
    readonly updatedAt?: string;
  }> {
    const index = await this.ensureBookWizardIndex(bookId);
    const record = index.steps[step];
    const primaryPath = this.wizardStepPath(bookId, step);
    const legacyPath = this.legacyWizardStepPath(bookId, step);
    const content = await readFile(primaryPath, "utf-8").catch(async () => {
      if (!legacyPath) return "";
      return readFile(legacyPath, "utf-8").catch(() => "");
    });
    return {
      content,
      status: record?.status ?? "empty",
      version: record?.version ?? 0,
      ...(record?.updatedAt ? { updatedAt: record.updatedAt } : {}),
    };
  }

  async saveBookWizardStep(bookId: string, step: BookCreationWizardStep, content: string, expectedVersion?: number): Promise<{
    readonly version: number;
    readonly updatedAt: string;
  }> {
    const now = new Date().toISOString();
    const index = await this.ensureBookWizardIndex(bookId);
    const record = index.steps[step] ?? { status: "empty" as const, version: 0 };
    if (expectedVersion !== undefined && Number.isFinite(expectedVersion) && Math.trunc(expectedVersion) !== record.version) {
      throw new Error(`Wizard step "${step}" version conflict for book "${bookId}"`);
    }
    await mkdir(this.wizardDir(bookId), { recursive: true });
    const primaryPath = this.wizardStepPath(bookId, step);
    const legacyPath = this.legacyWizardStepPath(bookId, step);
    await writeFile(primaryPath, content.trimEnd() + "\n", "utf-8");
    if (legacyPath) {
      await unlink(legacyPath).catch(() => undefined);
    }
    const nextVersion = record.version + 1;
    const nextIndex: WizardIndexFile = {
      ...index,
      currentStep: step,
      bookShellCreated: true,
      updatedAt: now,
      steps: {
        ...index.steps,
        [step]: {
          status: content.trim().length > 0 ? "saved" : "empty",
          version: nextVersion,
          updatedAt: now,
        },
      },
    };
    await this.saveBookWizardState(bookId, nextIndex);
    return {
      version: nextVersion,
      updatedAt: now,
    };
  }

  async markBookShellCreated(bookId: string): Promise<WizardIndexFile> {
    const now = new Date().toISOString();
    const index = await this.ensureBookWizardIndex(bookId);
    const nextIndex: WizardIndexFile = {
      ...index,
      bookShellCreated: true,
      updatedAt: now,
    };
    await this.saveBookWizardState(bookId, nextIndex);
    return nextIndex;
  }

  async ensureRuntimeState(bookId: string, fallbackChapter = 0): Promise<void> {
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter,
    });
  }

  async listBooks(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.booksDir);
      const bookIds: string[] = [];
      for (const entry of entries) {
        const bookJsonPath = join(this.booksDir, entry, "book.json");
        try {
          await stat(bookJsonPath);
          bookIds.push(entry);
        } catch {
          // not a book directory
        }
      }
      return bookIds;
    } catch {
      return [];
    }
  }

  async getNextChapterNumber(bookId: string): Promise<number> {
    const durableChapter = await resolveDurableStoryProgress({
      bookDir: this.bookDir(bookId),
    });
    // Ensure structured state is bootstrapped (side-effect: creates missing
    // JSON files), but do NOT trust its chapter number for progress — only
    // the contiguous durable artifact chain is authoritative.
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter: durableChapter,
    });
    return durableChapter + 1;
  }

  async getPersistedChapterCount(bookId: string): Promise<number> {
    const chaptersDir = join(this.bookDir(bookId), "chapters");
    const chapterNumbers = new Set<number>();

    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        chapterNumbers.add(parseInt(match[1]!, 10));
      }
    } catch {
      return 0;
    }

    return chapterNumbers.size;
  }

  async loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const indexPath = join(this.bookDir(bookId), "chapters", "index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async saveChapterIndex(
    bookId: string,
    index: ReadonlyArray<ChapterMeta>,
  ): Promise<void> {
    await this.saveChapterIndexAt(this.bookDir(bookId), index);
  }

  async saveChapterIndexAt(
    bookDir: string,
    index: ReadonlyArray<ChapterMeta>,
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(
      join(chaptersDir, "index.json"),
      JSON.stringify(index, null, 2),
      "utf-8",
    );
  }

  async snapshotState(bookId: string, chapterNumber: number): Promise<void> {
    await this.snapshotStateAt(this.bookDir(bookId), chapterNumber);
  }

  async snapshotStateAt(bookDir: string, chapterNumber: number): Promise<void> {
    const storyDir = join(bookDir, "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));
    await mkdir(snapshotDir, { recursive: true });

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
      "volume_outline.md",
    ];
    await Promise.all(
      files.map(async (f) => {
        try {
          const content = await readFile(join(storyDir, f), "utf-8");
          await writeFile(join(snapshotDir, f), content, "utf-8");
        } catch {
          // file doesn't exist yet
        }
      }),
    );

    const stateDir = join(bookDir, "story", "state");
    const snapshotStateDir = join(snapshotDir, "state");
    try {
      const stateFiles = (await readdir(stateDir)).filter((fileName) => fileName !== "book-tasks.json");
      if (stateFiles.length > 0) {
        await mkdir(snapshotStateDir, { recursive: true });
        await Promise.all(
          stateFiles.map(async (fileName) => {
            const content = await readFile(join(stateDir, fileName), "utf-8");
            await writeFile(join(snapshotStateDir, fileName), content, "utf-8");
          }),
        );
      }
    } catch {
      // state directory missing — skip
    }
  }

  async isCompleteBookDirectory(bookDir: string): Promise<boolean> {
    const requiredPaths = [
      join(bookDir, "book.json"),
      join(bookDir, "story", "story_bible.md"),
      join(bookDir, "story", "volume_outline.md"),
      join(bookDir, "story", "book_rules.md"),
      join(bookDir, "story", "current_state.md"),
      join(bookDir, "story", "pending_hooks.md"),
      join(bookDir, "chapters", "index.json"),
    ];

    for (const requiredPath of requiredPaths) {
      try {
        await stat(requiredPath);
      } catch {
        return false;
      }
    }

    return true;
  }

  async restoreState(bookId: string, chapterNumber: number): Promise<boolean> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
      "volume_outline.md",
    ];
    try {
      // current_state.md and pending_hooks.md are required;
      // particle_ledger.md is optional (numericalSystem=false genres don't have it)
      // the rest are optional (may not exist in older snapshots)
      const requiredFiles = ["current_state.md", "pending_hooks.md"];
      const optionalFiles = files.filter((f) => !requiredFiles.includes(f));

      await Promise.all(
        requiredFiles.map(async (f) => {
          const content = await readFile(join(snapshotDir, f), "utf-8");
          await writeFile(join(storyDir, f), content, "utf-8");
        }),
      );

      await Promise.all(
        optionalFiles.map(async (f) => {
          const targetPath = join(storyDir, f);
          try {
            const content = await readFile(join(snapshotDir, f), "utf-8");
            await writeFile(targetPath, content, "utf-8");
          } catch {
            // volume_outline.md is only restored if the snapshot has it;
            // never delete it when the snapshot is missing it (old snapshots)
            if (f !== "volume_outline.md") {
              await rm(targetPath, { force: true });
            }
          }
        }),
      );

      const stateDir = this.stateDir(bookId);
      let restoredStructuredState = false;
      try {
        const snapshotStateDir = join(snapshotDir, "state");
        const stateFiles = (await readdir(snapshotStateDir)).filter((fileName) => fileName !== "book-tasks.json");
        if (stateFiles.length > 0) {
          restoredStructuredState = true;
          await mkdir(stateDir, { recursive: true });
          await Promise.all(
            stateFiles.map(async (fileName) => {
              const content = await readFile(join(snapshotStateDir, fileName), "utf-8");
              await writeFile(join(stateDir, fileName), content, "utf-8");
            }),
          );
        }
      } catch {
        // snapshot structured state missing — skip
      }
      if (!restoredStructuredState) {
        await rm(stateDir, { recursive: true, force: true });
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Roll back state to the snapshot at `targetChapter`, removing all chapters
   * after it and their associated files (chapter markdown, snapshots, runtime).
   * Used by review reject to undo a bad chapter and everything that followed.
   *
   * Returns the list of chapter numbers that were discarded.
   */
  async rollbackToChapter(
    bookId: string,
    targetChapter: number,
  ): Promise<ReadonlyArray<number>> {
    const restored = await this.restoreState(bookId, targetChapter);
    if (!restored) {
      throw new Error(`Cannot restore snapshot for chapter ${targetChapter} in "${bookId}"`);
    }
    return this.rollbackArtifactsToChapter(bookId, targetChapter);
  }

  /**
   * Roll back chapter artifacts without restoring snapshot markdown/state first.
   * Used as a fallback when snapshot chain has holes but chapter files still exist.
   */
  async rollbackToChapterWithoutSnapshot(
    bookId: string,
    targetChapter: number,
  ): Promise<ReadonlyArray<number>> {
    return this.rollbackArtifactsToChapter(bookId, targetChapter);
  }

  private async rollbackArtifactsToChapter(
    bookId: string,
    targetChapter: number,
  ): Promise<ReadonlyArray<number>> {
    const bookDir = this.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const index = await this.loadChapterIndex(bookId);

    const kept: ChapterMeta[] = [];
    const discarded: number[] = [];

    for (const entry of index) {
      if (entry.number <= targetChapter) {
        kept.push(entry);
      } else {
        discarded.push(entry.number);
      }
    }

    // Delete chapter markdown files for discarded chapters
    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(chaptersDir, file)).catch(() => {});
        }
      }
    } catch {
      // chapters directory missing
    }

    // Delete snapshots for discarded chapters
    const snapshotsDir = join(bookDir, "story", "snapshots");
    try {
      const snapshots = await readdir(snapshotsDir);
      for (const snap of snapshots) {
        const num = parseInt(snap, 10);
        if (Number.isFinite(num) && num > targetChapter) {
          await rm(join(snapshotsDir, snap), { recursive: true, force: true });
        }
      }
    } catch {
      // snapshots directory missing
    }

    // Delete runtime artifacts for discarded chapters
    const runtimeDir = join(bookDir, "story", "runtime");
    try {
      const runtimeFiles = await readdir(runtimeDir);
      for (const file of runtimeFiles) {
        const match = file.match(/^chapter-(\d+)\./);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(runtimeDir, file)).catch(() => {});
        }
      }
    } catch {
      // runtime directory missing
    }

    // Also check story/drafts/ for discarded chapter files
    const draftsDir = join(bookDir, "story", "drafts");
    try {
      const draftFiles = await readdir(draftsDir);
      for (const file of draftFiles) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(draftsDir, file)).catch(() => {});
        }
      }
    } catch {
      // drafts directory missing
    }

    // Drop any persisted sqlite acceleration index so discarded chapters
    // cannot leak back into retrieval after the markdown/state rollback.
    await Promise.all([
      rm(join(bookDir, "story", "memory.db"), { force: true }),
      rm(join(bookDir, "story", "memory.db-shm"), { force: true }),
      rm(join(bookDir, "story", "memory.db-wal"), { force: true }),
      rm(join(bookDir, "story", "current_state_fact_sync.json"), { force: true }),
      rm(join(bookDir, "story", "narrative_memory_sync.json"), { force: true }),
    ]);

    await this.saveChapterIndex(bookId, kept);
    return discarded;
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      await stat(path);
    } catch {
      await writeFile(path, content, "utf-8");
    }
  }
}
