import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  StateManager,
  PipelineRunner,
  ChapterDesignAgent,
  BaseAgent,
  createLLMClient,
  createLogger,
  createInteractionToolsFromDeps,
  computeAnalytics,
  loadProjectConfig,
  loadProjectSession,
  processProjectInteractionInput,
  processProjectInteractionRequest,
  readVolumeMap,
  resolveSessionActiveBook,
  listBookSessions,
  loadBookSession,
  persistBookSession,
  appendBookSessionMessage,
  upsertBookSessionMessage,
  createAndPersistBookSession,
  renameBookSession,
  deleteBookSession,
  migrateBookSession,
  SessionAlreadyMigratedError,
  runAgentSession,
  buildAgentSystemPrompt,
  resolveServicePreset,
  resolveServiceProviderFamily,
  resolveServiceModelsBaseUrl,
  resolveServiceModel,
  loadSecrets,
  saveSecrets,
  getServiceApiKey,
  listModelsForService,
  chatCompletion,
  buildExportArtifact,
  GLOBAL_ENV_PATH,
  extractChapterLimitFromOutline,
  InteractionRequestSchema,
  type BookCreationWizardStep,
  type AgentContext,
  type ResolvedModel,
  type PipelineConfig,
  type ProjectConfig,
  type LogSink,
  type LogEntry,
} from "@actalk/inkos-core";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";
import { buildStudioBookConfig } from "./book-create.js";
import { BookTaskController } from "./lib/book-task-controller.js";
import { persistChapterAuditSummary } from "./lib/chapter-audit-index.js";
import type {
  AssetLibrary,
  AssetLibraryDiffResult,
  AssetGenerationStatus,
  AssetLibraryGeneratePayload,
  AssetLibraryHistoryEntry,
  AssetLibraryHistoryResponse,
  AssetLibraryItem,
  AssetLibraryItemStatus,
  AssetLibraryItemType,
  AssetLibraryResponse,
  AssetLibrarySavePayload,
  AssetLibraryUploadPayload,
  AssetLibraryUploadResponse,
  BookTask,
  DirectorPlan,
  DirectorPlanDiffResult,
  DirectorPlanEpisode,
  DirectorPlanGeneratePayload,
  DirectorPlanHistoryEntry,
  DirectorPlanHistoryResponse,
  DirectorPlanResponse,
  DirectorPlanSavePayload,
  ProductionDialogueType,
  ProductionEpisode,
  ProductionShot,
  ProductionWorkspace,
  ProductionWorkspaceGeneratePayload,
  ProductionWorkspaceResponse,
  ProductionWorkspaceSavePayload,
  ScriptWorkspace,
  ScriptWorkspaceConfig,
  ScriptWorkspaceDiffResult,
  ScriptWorkspaceEntity,
  ScriptWorkspaceEpisode,
  ScriptWorkspaceExtraction,
  ScriptWorkspaceHistoryEntry,
  ScriptWorkspaceHistoryResponse,
  ScriptWorkspaceGeneratePayload,
  ScriptWorkspaceGenerationStrategy,
  ScriptWorkspaceResponse,
  ScriptWorkspaceScene,
  ScriptWorkspaceSegment,
  ScriptWorkspaceSavePayload,
  TaskChecklistItem,
} from "../shared/contracts.js";
import { countChapterLengthByLanguage } from "../utils/chapter-length.js";
import { normalizeArtifactFile, resolveArtifactStoragePath } from "../utils/book-artifacts.js";
import { listScriptWorkspaceChecklistTemplates, resolveScriptWorkspaceChecklistTemplateId } from "../utils/script-workspace-checklist.js";
import {
  AUDIT_PASS_SCORE_THRESHOLD,
  clampAuditScore,
  estimateAuditScoreFromSeverityCounts,
  resolveAuditFailureGate,
  resolveAuditPassedByScore,
  type AuditFailureGate,
  type AuditSeverityCounts,
} from "../utils/audit-score.js";

// -- Pipeline stage definitions per agent type --

const PIPELINE_STAGES: Record<string, string[]> = {
  writer: [
    "准备章节输入", "撰写章节草稿", "正文清洗与校验", "落盘最终章节",
    "生成最终真相文件", "校验真相文件变更", "同步记忆索引",
    "更新章节索引与快照",
  ],
  architect: [
    "生成基础设定", "保存书籍配置", "写入基础设定文件",
    "初始化控制文档", "创建初始快照",
  ],
  reviser: [
    "加载修订上下文", "修订章节", "落盘修订结果",
    "更新索引与快照",
  ],
  rewrite: [
    "加载重写上下文", "重写章节", "落盘重写结果",
    "更新索引与快照",
  ],
  auditor: ["审计章节"],
};

const AGENT_LABELS: Record<string, string> = {
  architect: "建书", writer: "写作", auditor: "审计",
  reviser: "修订", exporter: "导出",
};
const TOOL_LABELS: Record<string, string> = {
  read: "读取文件", edit: "编辑文件", grep: "搜索", ls: "列目录",
};
const CHAPTER_PLAN_HISTORY_FILE = "chapter-plans.history.json";
const SCRIPT_WORKSPACE_HISTORY_FILE = "script-workspace.history.json";
const PRODUCTION_WORKSPACE_FILE = "production-workspace.json";
const DIRECTOR_PLAN_FILE = "director-plan.json";
const DIRECTOR_PLAN_HISTORY_FILE = "director-plan.history.json";
const ASSET_LIBRARY_FILE = "asset-library.json";
const ASSET_LIBRARY_HISTORY_FILE = "asset-library.history.json";
const WRITE_STAGE_HEARTBEAT_MS = 3_000;
const MAX_STAGE_SILENCE_MS = 15_000;
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
  relation: "relation.md",
};
  const TRUTH_FILE_ALIASES: Readonly<Record<string, string>> = {
    "story/outline/story_frame.md": "story_bible.md",
  };

function resolveWriteStageHeartbeatMs(): number {
  return Math.min(WRITE_STAGE_HEARTBEAT_MS, MAX_STAGE_SILENCE_MS);
}

function resolveToolLabel(tool: string, agent?: string): string {
  if (tool === "sub_agent" && agent) return AGENT_LABELS[agent] ?? agent;
  return TOOL_LABELS[tool] ?? tool;
}

function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 200);
    if (typeof r.text === "string") return r.text.slice(0, 200);
    if (Array.isArray(r.content)) {
      const text = r.content
        .filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => String(item.text).trim())
        .filter(Boolean)
        .join("\n");
      if (text) return text.slice(0, 200);
    }
    try {
      const serialized = JSON.stringify(result);
      if (serialized && serialized !== "{}") return serialized.slice(0, 200);
    } catch {
      // ignore stringify errors and fall back below
    }
  }
  return String(result).slice(0, 200);
}

function extractToolError(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 500);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 500);
    if (typeof r.text === "string") return r.text.slice(0, 500);
    if (r.content && Array.isArray(r.content)) {
      const textPart = r.content.find((c: any) => c.type === "text");
      if (textPart) return (textPart as any).text?.slice(0, 500) ?? "";
    }
    try {
      const serialized = JSON.stringify(result);
      if (serialized && serialized !== "{}") return serialized.slice(0, 500);
    } catch {
      // ignore stringify errors and fall back below
    }
  }
  return String(result).slice(0, 500);
}

function shouldSuppressStageHeartbeatLog(message: string): boolean {
  return /（进行中\s*\d+s）|\(\d+s elapsed\)/i.test(message);
}

export async function openPathWithSystemDefault(path: string): Promise<void> {
  const platform = process.platform;
  const command = platform === "darwin"
    ? "open"
    : platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = platform === "darwin"
    ? [path]
    : platform === "win32"
      ? ["/c", "start", "", path]
      : [path];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`open command exited with code ${code}`));
      }
    });
    child.unref();
  });
}

export interface StudioServerOptions {
  readonly openPath?: (path: string) => Promise<void>;
}

function resolveExportPathForProject(root: string, exportPath: string): string | null {
  const normalized = exportPath.trim().replace(/\\/g, "/");
  const rootPrefix = join(root, "").replace(/\\/g, "/");
  if (!normalized.startsWith(rootPrefix)) {
    return null;
  }
  return normalized;
}

function normalizeTaskChecklistItem(item: Partial<TaskChecklistItem> & { readonly text?: unknown }): TaskChecklistItem {
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!text) {
    throw new Error("Checklist item text is required.");
  }
  const order = Number.isFinite(Number(item.order)) ? Math.max(0, Math.trunc(Number(item.order))) : 0;
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `task-${order + 1}`,
    text,
    done: Boolean(item.done),
    order,
    ...(typeof item.note === "string" ? { note: item.note.trim() || null } : {}),
  };
}

function sortTaskChecklistItems(items: ReadonlyArray<TaskChecklistItem>): TaskChecklistItem[] {
  return [...items].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.id.localeCompare(right.id);
  }).map((item, index) => ({
    ...item,
    order: index,
  }));
}

const DEFAULT_SCRIPT_WORKSPACE_CONFIG: ScriptWorkspaceConfig = {
  visualStyle: "电影感写实风，冷暖对比明确，景深层次分明",
  directorMethod: "静态镜头为主，必要时用缓推、硬切和空镜过渡",
  aiTool: "即梦Ai",
  aiModel: "默认",
  generationStrategy: "chapter",
  chaptersPerEpisode: 2,
  episodeDurationSec: 60,
  segmentDurationSec: 12,
  segmentDurationMinSec: 10,
  segmentDurationMaxSec: 15,
  scriptPrompts: {
    script: "请根据章节内容提取场景、角色、道具与素材，输出可执行剧本，要求按集拆分，并保留每段可视化信息。",
    image: "请基于剧本生成文生图提示词，突出视觉风格、人物状态、场景布局、光影与道具。",
    video: "请基于文生图提示词生成图生视频提示词，按每段10-15秒拆分，保持镜头连续与动作明确。",
  },
};

const SCRIPT_CHARACTER_STOPWORDS = new Set([
  "但是", "如果", "因为", "所以", "一个", "没有", "我们", "你们", "他们", "她们", "自己", "时候", "这个", "那个",
  "这里", "那里", "不会", "可以", "然后", "已经", "还是", "不是", "只是", "而且", "终于", "突然", "继续",
]);

const SCRIPT_OBJECT_KEYWORDS = [
  "手机", "钥匙", "车钥匙", "门", "窗", "照片", "信", "文件", "刀", "枪", "书", "包", "箱子", "药", "杯子",
  "手表", "项链", "戒指", "地图", "灯", "伞", "电脑", "平板", "耳机", "火", "花", "衣服", "制服", "徽章",
];

const SCRIPT_LOCATION_KEYWORDS = [
  "房间", "卧室", "客厅", "走廊", "街道", "巷子", "巷口", "学校", "教室", "医院", "办公室", "餐厅", "酒吧",
  "车站", "地铁", "广场", "工厂", "仓库", "森林", "山路", "海边", "码头", "庭院", "楼顶", "雨夜", "夜色",
];

function normalizeNumberList(values: ReadonlyArray<unknown> | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value))
  )].sort((left, right) => left - right);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function normalizeWorkspaceEntity(entity: Partial<ScriptWorkspaceEntity> & { readonly name?: unknown }): ScriptWorkspaceEntity {
  const name = typeof entity.name === "string" ? entity.name.trim() : "";
  const description = typeof entity.description === "string" ? entity.description.trim() : "";
  return {
    name: name || "未命名",
    description: description || "根据章节内容自动提取",
    sourceChapterNumbers: normalizeNumberList(entity.sourceChapterNumbers as ReadonlyArray<unknown> | undefined),
  };
}

function normalizeWorkspaceConfig(config?: Partial<ScriptWorkspaceConfig> | null): ScriptWorkspaceConfig {
  const scriptPrompts: Partial<ScriptWorkspaceConfig["scriptPrompts"]> = config?.scriptPrompts ?? {};
  const generationStrategy = config?.generationStrategy === "episode" ? "episode" : "chapter";
  return {
    visualStyle: typeof config?.visualStyle === "string" && config.visualStyle.trim()
      ? config.visualStyle.trim()
      : DEFAULT_SCRIPT_WORKSPACE_CONFIG.visualStyle,
    directorMethod: typeof config?.directorMethod === "string" && config.directorMethod.trim()
      ? config.directorMethod.trim()
      : DEFAULT_SCRIPT_WORKSPACE_CONFIG.directorMethod,
    aiTool: typeof config?.aiTool === "string" && config.aiTool.trim()
      ? config.aiTool.trim()
      : DEFAULT_SCRIPT_WORKSPACE_CONFIG.aiTool,
    aiModel: typeof config?.aiModel === "string" && config.aiModel.trim()
      ? config.aiModel.trim()
      : DEFAULT_SCRIPT_WORKSPACE_CONFIG.aiModel,
    generationStrategy,
    chaptersPerEpisode: clampInt(config?.chaptersPerEpisode, DEFAULT_SCRIPT_WORKSPACE_CONFIG.chaptersPerEpisode ?? 2, 1, 20),
    episodeDurationSec: clampInt(config?.episodeDurationSec, DEFAULT_SCRIPT_WORKSPACE_CONFIG.episodeDurationSec, 30, 1800),
    segmentDurationSec: clampInt(config?.segmentDurationSec, DEFAULT_SCRIPT_WORKSPACE_CONFIG.segmentDurationSec, 5, 60),
    segmentDurationMinSec: clampInt(config?.segmentDurationMinSec, DEFAULT_SCRIPT_WORKSPACE_CONFIG.segmentDurationMinSec, 1, 60),
    segmentDurationMaxSec: clampInt(config?.segmentDurationMaxSec, DEFAULT_SCRIPT_WORKSPACE_CONFIG.segmentDurationMaxSec, 1, 120),
    scriptPrompts: {
      script: typeof scriptPrompts.script === "string" && scriptPrompts.script.trim()
        ? scriptPrompts.script.trim()
        : DEFAULT_SCRIPT_WORKSPACE_CONFIG.scriptPrompts.script,
      image: typeof scriptPrompts.image === "string" && scriptPrompts.image.trim()
        ? scriptPrompts.image.trim()
        : DEFAULT_SCRIPT_WORKSPACE_CONFIG.scriptPrompts.image,
      video: typeof scriptPrompts.video === "string" && scriptPrompts.video.trim()
        ? scriptPrompts.video.trim()
        : DEFAULT_SCRIPT_WORKSPACE_CONFIG.scriptPrompts.video,
    },
  };
}

function normalizeWorkspaceScene(scene: Partial<ScriptWorkspaceScene> & { readonly id?: unknown }): ScriptWorkspaceScene {
  return {
    id: typeof scene.id === "string" && scene.id.trim() ? scene.id.trim() : `scene-${Date.now()}`,
    episodeNumber: clampInt(scene.episodeNumber, 1, 1, 1_000_000),
    chapterNumber: clampInt(scene.chapterNumber, 1, 1, 1_000_000),
    sourceChapterNumbers: normalizeNumberList(scene.sourceChapterNumbers as ReadonlyArray<unknown> | undefined),
    title: typeof scene.title === "string" && scene.title.trim() ? scene.title.trim() : "场景",
    description: typeof scene.description === "string" ? scene.description.trim() : "",
    location: typeof scene.location === "string" ? scene.location.trim() : "",
    timeOfDay: typeof scene.timeOfDay === "string" ? scene.timeOfDay.trim() : "",
    characters: Array.isArray(scene.characters) ? scene.characters.map((item) => String(item).trim()).filter(Boolean) : [],
    props: Array.isArray(scene.props) ? scene.props.map((item) => String(item).trim()).filter(Boolean) : [],
    assets: Array.isArray(scene.assets) ? scene.assets.map((item) => String(item).trim()).filter(Boolean) : [],
  };
}

function normalizeWorkspaceSegment(segment: Partial<ScriptWorkspaceSegment> & { readonly id?: unknown }): ScriptWorkspaceSegment {
  return {
    id: typeof segment.id === "string" && segment.id.trim() ? segment.id.trim() : `segment-${Date.now()}`,
    order: clampInt(segment.order, 0, 0, 1_000_000),
    episodeNumber: clampInt(segment.episodeNumber, 1, 1, 1_000_000),
    chapterNumber: clampInt(segment.chapterNumber, 1, 1, 1_000_000),
    sourceChapterNumbers: normalizeNumberList(segment.sourceChapterNumbers as ReadonlyArray<unknown> | undefined),
    title: typeof segment.title === "string" && segment.title.trim() ? segment.title.trim() : "分段",
    scene: typeof segment.scene === "string" ? segment.scene.trim() : "",
    durationSec: clampInt(segment.durationSec, 12, 1, 120),
    characters: Array.isArray(segment.characters) ? segment.characters.map((item) => String(item).trim()).filter(Boolean) : [],
    props: Array.isArray(segment.props) ? segment.props.map((item) => String(item).trim()).filter(Boolean) : [],
    assets: Array.isArray(segment.assets) ? segment.assets.map((item) => String(item).trim()).filter(Boolean) : [],
    scriptText: typeof segment.scriptText === "string" ? segment.scriptText.trim() : "",
    textToImagePrompt: typeof segment.textToImagePrompt === "string" ? segment.textToImagePrompt.trim() : "",
    imageToVideoPrompt: typeof segment.imageToVideoPrompt === "string" ? segment.imageToVideoPrompt.trim() : "",
  };
}

function normalizeWorkspaceEpisode(episode: Partial<ScriptWorkspaceEpisode> & { readonly episodeNumber?: unknown }): ScriptWorkspaceEpisode {
  return {
    episodeNumber: clampInt(episode.episodeNumber, 1, 1, 1_000_000),
    chapterNumber: clampInt(episode.chapterNumber, 1, 1, 1_000_000),
    sourceChapterNumbers: normalizeNumberList(episode.sourceChapterNumbers as ReadonlyArray<unknown> | undefined),
    chapterTitle: typeof episode.chapterTitle === "string" && episode.chapterTitle.trim() ? episode.chapterTitle.trim() : "章节",
    title: typeof episode.title === "string" && episode.title.trim() ? episode.title.trim() : "第1集",
    summary: typeof episode.summary === "string" ? episode.summary.trim() : "",
    durationSec: clampInt(episode.durationSec, DEFAULT_SCRIPT_WORKSPACE_CONFIG.episodeDurationSec, 30, 1800),
    segments: Array.isArray(episode.segments) ? episode.segments.map((item, index) => normalizeWorkspaceSegment({ ...item, order: index })) : [],
  };
}

function normalizeScriptWorkspace(workspace: Partial<ScriptWorkspace> & { readonly bookId?: unknown }): ScriptWorkspace {
  return {
    bookId: typeof workspace.bookId === "string" && workspace.bookId.trim() ? workspace.bookId.trim() : "unknown",
    selectedChapterNumbers: normalizeNumberList(workspace.selectedChapterNumbers as ReadonlyArray<unknown> | undefined),
    updatedAt: typeof workspace.updatedAt === "string" && workspace.updatedAt.trim() ? workspace.updatedAt.trim() : new Date().toISOString(),
    config: normalizeWorkspaceConfig(workspace.config ?? null),
    scriptPrompt: typeof workspace.scriptPrompt === "string" ? workspace.scriptPrompt.trim() : "",
    extraction: {
      scenes: Array.isArray(workspace.extraction?.scenes) ? workspace.extraction.scenes.map((item) => normalizeWorkspaceScene(item)) : [],
      characters: Array.isArray(workspace.extraction?.characters) ? workspace.extraction.characters.map((item) => normalizeWorkspaceEntity(item)) : [],
      props: Array.isArray(workspace.extraction?.props) ? workspace.extraction.props.map((item) => normalizeWorkspaceEntity(item)) : [],
      assets: Array.isArray(workspace.extraction?.assets) ? workspace.extraction.assets.map((item) => normalizeWorkspaceEntity(item)) : [],
    },
    episodes: Array.isArray(workspace.episodes) ? workspace.episodes.map((item) => normalizeWorkspaceEpisode(item)) : [],
  };
}

function normalizeProductionDialogueType(value: unknown): ProductionDialogueType {
  return value === "dialogue" || value === "inner_monologue" || value === "voiceover" ? value : "none";
}

function normalizeProductionShot(shot: Partial<ProductionShot> & { readonly id?: unknown }): ProductionShot {
  return {
    id: typeof shot.id === "string" && shot.id.trim() ? shot.id.trim() : `shot-${Date.now()}`,
    episodeNumber: clampInt(shot.episodeNumber, 1, 1, 1_000_000),
    chapterNumber: clampInt(shot.chapterNumber, 1, 1, 1_000_000),
    sourceChapterNumbers: normalizeNumberList(shot.sourceChapterNumbers as ReadonlyArray<unknown> | undefined),
    segmentId: typeof shot.segmentId === "string" && shot.segmentId.trim() ? shot.segmentId.trim() : "segment",
    segmentOrder: clampInt(shot.segmentOrder, 0, 0, 1_000_000),
    shotNumber: clampInt(shot.shotNumber, 1, 1, 1_000_000),
    track: typeof shot.track === "string" && shot.track.trim() ? shot.track.trim() : "main",
    title: typeof shot.title === "string" && shot.title.trim() ? shot.title.trim() : "镜头",
    scene: typeof shot.scene === "string" ? shot.scene.trim() : "",
    durationSec: clampInt(shot.durationSec, 5, 1, 120),
    shotType: typeof shot.shotType === "string" && shot.shotType.trim() ? shot.shotType.trim() : "中景",
    cameraMovement: typeof shot.cameraMovement === "string" && shot.cameraMovement.trim() ? shot.cameraMovement.trim() : "缓推",
    dialogue: typeof shot.dialogue === "string" ? shot.dialogue.trim() : "",
    dialogueType: normalizeProductionDialogueType(shot.dialogueType),
    mood: typeof shot.mood === "string" && shot.mood.trim() ? shot.mood.trim() : "克制紧张",
    lighting: typeof shot.lighting === "string" && shot.lighting.trim() ? shot.lighting.trim() : "环境主光明确，保留层次阴影",
    shouldGenerateImage: shot.shouldGenerateImage !== false,
    characters: Array.isArray(shot.characters) ? shot.characters.map((item) => String(item).trim()).filter(Boolean) : [],
    props: Array.isArray(shot.props) ? shot.props.map((item) => String(item).trim()).filter(Boolean) : [],
    assets: Array.isArray(shot.assets) ? shot.assets.map((item) => String(item).trim()).filter(Boolean) : [],
    scriptText: typeof shot.scriptText === "string" ? shot.scriptText.trim() : "",
    textToImagePrompt: typeof shot.textToImagePrompt === "string" ? shot.textToImagePrompt.trim() : "",
    imageToVideoPrompt: typeof shot.imageToVideoPrompt === "string" ? shot.imageToVideoPrompt.trim() : "",
  };
}

function normalizeProductionEpisode(episode: Partial<ProductionEpisode> & { readonly episodeNumber?: unknown }): ProductionEpisode {
  return {
    episodeNumber: clampInt(episode.episodeNumber, 1, 1, 1_000_000),
    chapterNumber: clampInt(episode.chapterNumber, 1, 1, 1_000_000),
    sourceChapterNumbers: normalizeNumberList(episode.sourceChapterNumbers as ReadonlyArray<unknown> | undefined),
    title: typeof episode.title === "string" && episode.title.trim() ? episode.title.trim() : "第1集",
    chapterTitle: typeof episode.chapterTitle === "string" && episode.chapterTitle.trim() ? episode.chapterTitle.trim() : "章节",
    summary: typeof episode.summary === "string" ? episode.summary.trim() : "",
    durationSec: clampInt(episode.durationSec, DEFAULT_SCRIPT_WORKSPACE_CONFIG.episodeDurationSec, 30, 1800),
    trackCount: clampInt(episode.trackCount, 1, 1, 128),
    shots: Array.isArray(episode.shots) ? episode.shots.map((item) => normalizeProductionShot(item)) : [],
  };
}

function normalizeProductionWorkspace(workspace: Partial<ProductionWorkspace> & { readonly bookId?: unknown }): ProductionWorkspace {
  return {
    bookId: typeof workspace.bookId === "string" && workspace.bookId.trim() ? workspace.bookId.trim() : "unknown",
    selectedChapterNumbers: normalizeNumberList(workspace.selectedChapterNumbers as ReadonlyArray<unknown> | undefined),
    updatedAt: typeof workspace.updatedAt === "string" && workspace.updatedAt.trim() ? workspace.updatedAt.trim() : new Date().toISOString(),
    sourceScriptUpdatedAt: typeof workspace.sourceScriptUpdatedAt === "string" && workspace.sourceScriptUpdatedAt.trim()
      ? workspace.sourceScriptUpdatedAt.trim()
      : new Date().toISOString(),
    sourceConfig: normalizeWorkspaceConfig(workspace.sourceConfig ?? null),
    episodes: Array.isArray(workspace.episodes) ? workspace.episodes.map((item) => normalizeProductionEpisode(item)) : [],
  };
}

function normalizeDirectorPlanEpisode(episode: Partial<DirectorPlanEpisode> & { readonly episodeNumber?: unknown }): DirectorPlanEpisode {
  return {
    episodeNumber: clampInt(episode.episodeNumber, 1, 1, 1_000_000),
    title: typeof episode.title === "string" && episode.title.trim() ? episode.title.trim() : "第1集",
    storyGoal: typeof episode.storyGoal === "string" ? episode.storyGoal.trim() : "",
    emotionalBeat: typeof episode.emotionalBeat === "string" ? episode.emotionalBeat.trim() : "",
    pacing: typeof episode.pacing === "string" ? episode.pacing.trim() : "",
    lensLanguage: typeof episode.lensLanguage === "string" ? episode.lensLanguage.trim() : "",
    blockingNotes: typeof episode.blockingNotes === "string" ? episode.blockingNotes.trim() : "",
    lightingNotes: typeof episode.lightingNotes === "string" ? episode.lightingNotes.trim() : "",
    soundNotes: typeof episode.soundNotes === "string" ? episode.soundNotes.trim() : "",
    continuityNotes: typeof episode.continuityNotes === "string" ? episode.continuityNotes.trim() : "",
  };
}

function normalizeDirectorPlan(plan: Partial<DirectorPlan> & { readonly bookId?: unknown }): DirectorPlan {
  return {
    bookId: typeof plan.bookId === "string" && plan.bookId.trim() ? plan.bookId.trim() : "unknown",
    updatedAt: typeof plan.updatedAt === "string" && plan.updatedAt.trim() ? plan.updatedAt.trim() : new Date().toISOString(),
    sourceProductionUpdatedAt: typeof plan.sourceProductionUpdatedAt === "string" && plan.sourceProductionUpdatedAt.trim()
      ? plan.sourceProductionUpdatedAt.trim()
      : new Date().toISOString(),
    sourceConfig: normalizeWorkspaceConfig(plan.sourceConfig ?? null),
    visualStatement: typeof plan.visualStatement === "string" ? plan.visualStatement.trim() : "",
    directorIntent: typeof plan.directorIntent === "string" ? plan.directorIntent.trim() : "",
    visualRules: Array.isArray(plan.visualRules) ? plan.visualRules.map((item) => String(item).trim()).filter(Boolean) : [],
    cameraRules: Array.isArray(plan.cameraRules) ? plan.cameraRules.map((item) => String(item).trim()).filter(Boolean) : [],
    colorScript: Array.isArray(plan.colorScript) ? plan.colorScript.map((item) => String(item).trim()).filter(Boolean) : [],
    episodePlans: Array.isArray(plan.episodePlans) ? plan.episodePlans.map((item) => normalizeDirectorPlanEpisode(item)) : [],
  };
}

function normalizeAssetLibraryItemType(value: unknown): AssetLibraryItemType {
  return value === "character" || value === "prop" || value === "scene" ? value : "reference";
}

function normalizeAssetGenerationStatus(value: unknown): AssetGenerationStatus {
  return value === "queued"
    || value === "generating"
    || value === "ready"
    || value === "failed"
    || value === "rejected"
    ? value
    : "pending";
}

function normalizeAssetLibraryItemStatus(value: unknown): AssetLibraryItemStatus {
  return value === "prompt_ready"
    || value === "image_generating"
    || value === "image_ready"
    || value === "video_generating"
    || value === "video_ready"
    || value === "rejected"
    ? value
    : "draft";
}

function normalizeAssetLibraryItem(item: Partial<AssetLibraryItem> & { readonly id?: unknown }): AssetLibraryItem {
  const shotIds = uniqStrings(Array.isArray(item.shotIds) ? item.shotIds.map((value) => String(value).trim()).filter(Boolean) : []);
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `asset-${Date.now()}`,
    type: normalizeAssetLibraryItemType(item.type),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "素材",
    description: typeof item.description === "string" ? item.description.trim() : "",
    episodeNumbers: normalizeNumberList(item.episodeNumbers as ReadonlyArray<unknown> | undefined),
    shotIds,
    referenceCount: clampInt(item.referenceCount, shotIds.length, shotIds.length, 1_000_000),
    prompt: typeof item.prompt === "string" ? item.prompt.trim() : "",
    status: normalizeAssetLibraryItemStatus(item.status),
    thumbnailPath: typeof item.thumbnailPath === "string" ? item.thumbnailPath.trim() : "",
    filePath: typeof item.filePath === "string" ? item.filePath.trim() : "",
    generation: {
      imageStatus: normalizeAssetGenerationStatus(item.generation?.imageStatus),
      videoStatus: normalizeAssetGenerationStatus(item.generation?.videoStatus),
      needsRegeneration: Boolean(item.generation?.needsRegeneration),
      lastError: typeof item.generation?.lastError === "string" ? item.generation.lastError.trim() : "",
      notes: typeof item.generation?.notes === "string" ? item.generation.notes.trim() : "",
    },
    tags: Array.isArray(item.tags) ? item.tags.map((value) => String(value).trim()).filter(Boolean) : [],
  };
}

function normalizeAssetLibrary(library: Partial<AssetLibrary> & { readonly bookId?: unknown }): AssetLibrary {
  return {
    bookId: typeof library.bookId === "string" && library.bookId.trim() ? library.bookId.trim() : "unknown",
    updatedAt: typeof library.updatedAt === "string" && library.updatedAt.trim() ? library.updatedAt.trim() : new Date().toISOString(),
    sourceProductionUpdatedAt: typeof library.sourceProductionUpdatedAt === "string" && library.sourceProductionUpdatedAt.trim()
      ? library.sourceProductionUpdatedAt.trim()
      : new Date().toISOString(),
    items: Array.isArray(library.items) ? library.items.map((item) => normalizeAssetLibraryItem(item)) : [],
  };
}

function splitTextSegments(content: string, count: number): string[] {
  return rebalanceTextBeats(buildSemanticTextBeats(content), count);
}

function resolveSegmentDurations(totalSec: number, targetSec: number, minSec: number, maxSec: number): number[] {
  const segmentCount = Math.max(1, Math.ceil(totalSec / Math.max(1, targetSec)));
  const durations = new Array(segmentCount).fill(Math.max(minSec, Math.min(maxSec, targetSec)));
  let sum = durations.reduce((acc, value) => acc + value, 0);
  while (sum < totalSec) {
    for (let index = 0; index < durations.length && sum < totalSec; index += 1) {
      if (durations[index] >= maxSec) continue;
      durations[index] += 1;
      sum += 1;
    }
    if (durations.every((value) => value >= maxSec)) break;
  }
  while (sum > totalSec) {
    for (let index = durations.length - 1; index >= 0 && sum > totalSec; index -= 1) {
      if (durations[index] <= minSec) continue;
      durations[index] -= 1;
      sum -= 1;
    }
    if (durations.every((value) => value <= minSec)) break;
  }
  return durations;
}

function extractKeywordCandidates(content: string, limit: number): string[] {
  const matches = content.match(/[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z0-9_-]{1,18}/g) ?? [];
  const frequency = new Map<string, number>();
  for (const match of matches) {
    const token = match.trim();
    if (!token || SCRIPT_CHARACTER_STOPWORDS.has(token)) continue;
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return [...frequency.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function inferLocationLabel(content: string): string {
  for (const keyword of SCRIPT_LOCATION_KEYWORDS) {
    if (content.includes(keyword)) return keyword;
  }
  return "故事现场";
}

function inferProps(content: string): string[] {
  return SCRIPT_OBJECT_KEYWORDS.filter((keyword) => content.includes(keyword)).slice(0, 4);
}

function buildWorkspacePrompt(workspace: ScriptWorkspace): string {
  return [
    `生成策略：${workspace.config.generationStrategy === "episode" ? `按集（每集 ${workspace.config.chaptersPerEpisode ?? 2} 章）` : "按章"}`,
    `视觉风格：${workspace.config.visualStyle}`,
    `导演手法：${workspace.config.directorMethod}`,
    `AI：${workspace.config.aiTool} / ${workspace.config.aiModel}`,
    `剧本提示词：${workspace.config.scriptPrompts.script}`,
    `文生图提示词：${workspace.config.scriptPrompts.image}`,
    `图生视频提示词：${workspace.config.scriptPrompts.video}`,
    `选中章节：${workspace.selectedChapterNumbers.join("、") || "无"}`,
  ].join("\n");
}

function inferTimeOfDay(content: string): string {
  if (/(凌晨|清晨|早晨|天亮|晨)/.test(content)) return "清晨";
  if (/(中午|午后|正午|白天)/.test(content)) return "白天";
  if (/(傍晚|黄昏|日落)/.test(content)) return "傍晚";
  if (/(夜里|夜晚|深夜|晚上|夜)/.test(content)) return "夜晚";
  return "不定时段";
}

function summarizeText(content: string, maxLength = 80): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

function buildCharacterCandidates(content: string, limit: number): string[] {
  const candidates = extractKeywordCandidates(content, limit * 2)
    .filter((token) => !SCRIPT_OBJECT_KEYWORDS.includes(token))
    .filter((token) => !SCRIPT_LOCATION_KEYWORDS.includes(token));
  return [...new Set(candidates)].slice(0, limit);
}

type WorkspaceEntityDraft = {
  name: string;
  description: string;
  sourceChapterNumbers: number[];
};

type ScriptWorkspaceChapterInput = {
  chapterNumber: number;
  chapterTitle: string;
  rawContent: string;
  sceneLocation: string;
  timeOfDay: string;
  characters: string[];
  props: string[];
  assetNames: string[];
};

type ScriptWorkspaceSegmentBlueprint = {
  title: string;
  scene: string;
  durationSec: number;
  location: string;
  timeOfDay: string;
  intent: string;
  characters: string[];
  props: string[];
  assets: string[];
};

type ScriptWorkspaceEpisodePlan = {
  episodeNumber: number;
  chapterNumber: number;
  sourceChapterNumbers: number[];
  chapterTitle: string;
  title: string;
  summary: string;
  durationSec: number;
  segmentBlueprints: ScriptWorkspaceSegmentBlueprint[];
};

type ScriptWorkspacePlan = {
  scriptPrompt: string;
  extraction: ScriptWorkspaceExtraction;
  episodes: ScriptWorkspaceEpisodePlan[];
};

function createEntity(name: string, description: string, chapterNumber: number): WorkspaceEntityDraft {
  return {
    name,
    description,
    sourceChapterNumbers: [chapterNumber],
  };
}

function uniqStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function splitParagraphIntoSentences(paragraph: string): string[] {
  const normalized = paragraph.replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  return normalized
    .split(/\n+/)
    .flatMap((line) => line.match(/[^。！？!?；;]+[。！？!?；;]?|“[^”]+”|「[^」]+」|"[^"]+"/g) ?? [line])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function buildSemanticTextBeats(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [""];

  const beats: string[] = [];
  let current: string[] = [];
  let currentLocation = "";
  let currentTimeOfDay = "";
  let currentHasDialogue = false;

  const flushCurrent = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text) beats.push(text);
    current = [];
    currentLocation = "";
    currentTimeOfDay = "";
    currentHasDialogue = false;
  };

  for (const paragraph of paragraphs) {
    const sentences = splitParagraphIntoSentences(paragraph);
    if (sentences.length === 0) continue;
    for (const sentence of sentences) {
      const location = inferLocationLabel(sentence);
      const timeOfDay = inferTimeOfDay(sentence);
      const hasDialogue = /[“”"「」]/.test(sentence);
      const isTransition = /(忽然|突然|这时|随后|片刻|转眼|紧接着|与此同时|另一边|另一头|很快|下一秒)/.test(sentence);
      const shouldBreak = current.length > 0 && (
        isTransition
        || (location !== "故事现场" && currentLocation && location !== currentLocation)
        || (timeOfDay !== "不定时段" && currentTimeOfDay && timeOfDay !== currentTimeOfDay)
        || hasDialogue !== currentHasDialogue
        || current.join(" ").length >= 90
      );
      if (shouldBreak) flushCurrent();
      current.push(sentence);
      currentLocation = location !== "故事现场" ? location : currentLocation;
      currentTimeOfDay = timeOfDay !== "不定时段" ? timeOfDay : currentTimeOfDay;
      currentHasDialogue = currentHasDialogue || hasDialogue;
    }
    if (current.join(" ").length >= 120) flushCurrent();
  }

  flushCurrent();
  return beats.length > 0 ? beats : [content.trim() || ""];
}

function splitBeatByCenter(text: string): [string, string] | null {
  const sentences = splitParagraphIntoSentences(text);
  if (sentences.length >= 2) {
    const middle = Math.ceil(sentences.length / 2);
    return [
      sentences.slice(0, middle).join(" ").trim(),
      sentences.slice(middle).join(" ").trim(),
    ];
  }
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const middle = Math.ceil(parts.length / 2);
  return [
    parts.slice(0, middle).join(" ").trim(),
    parts.slice(middle).join(" ").trim(),
  ];
}

function rebalanceTextBeats(beats: ReadonlyArray<string>, count: number): string[] {
  const targetCount = Math.max(1, count);
  const result = beats.map((beat) => beat.trim()).filter(Boolean);
  if (result.length === 0) return Array.from({ length: targetCount }, () => "");

  while (result.length > targetCount) {
    let mergeIndex = 0;
    let minLength = Number.POSITIVE_INFINITY;
    for (let index = 0; index < result.length - 1; index += 1) {
      const combinedLength = result[index]!.length + result[index + 1]!.length;
      if (combinedLength < minLength) {
        minLength = combinedLength;
        mergeIndex = index;
      }
    }
    result.splice(mergeIndex, 2, `${result[mergeIndex]} ${result[mergeIndex + 1]}`.replace(/\s+/g, " ").trim());
  }

  while (result.length < targetCount) {
    let splitIndex = 0;
    let maxLength = -1;
    for (let index = 0; index < result.length; index += 1) {
      if (result[index]!.length > maxLength) {
        splitIndex = index;
        maxLength = result[index]!.length;
      }
    }
    const split = splitBeatByCenter(result[splitIndex]!);
    if (!split) break;
    result.splice(splitIndex, 1, split[0], split[1]);
  }

  while (result.length < targetCount) {
    result.push(result[result.length - 1] ?? "");
  }
  return result.slice(0, targetCount);
}

function buildSceneSlices(content: string, limit = 4): string[] {
  const beats = buildSemanticTextBeats(content).slice(0, Math.max(1, limit * 2));
  return rebalanceTextBeats(beats, Math.min(Math.max(1, beats.length), limit));
}

function buildSegmentSceneLabel(location: string, timeOfDay: string): string {
  return `${location || "故事现场"} / ${timeOfDay || "不定时段"}`;
}

function buildSegmentPromptPack(args: {
  readonly config: ScriptWorkspaceConfig;
  readonly durationSec: number;
  readonly sourceChapterNumbers: ReadonlyArray<number>;
  readonly location: string;
  readonly timeOfDay: string;
  readonly characters: ReadonlyArray<string>;
  readonly props: ReadonlyArray<string>;
  readonly assets: ReadonlyArray<string>;
  readonly focus: string;
}): { textToImagePrompt: string; imageToVideoPrompt: string } {
  const strategyLabel = args.config.generationStrategy === "episode"
    ? `按集，覆盖${describeChapterNumbers(args.sourceChapterNumbers)}`
    : "按章";
  return {
    textToImagePrompt: [
      args.config.scriptPrompts.image,
      `生成策略：${strategyLabel}`,
      `视觉风格：${args.config.visualStyle}`,
      `场景：${args.location || "故事现场"}`,
      `时间：${args.timeOfDay || "不定时段"}`,
      `角色：${args.characters.join("、") || "无"}`,
      `道具：${args.props.join("、") || "无"}`,
      `素材：${args.assets.join("、") || "无"}`,
      `画面重点：${args.focus}`,
    ].join("\n"),
    imageToVideoPrompt: [
      args.config.scriptPrompts.video,
      `每段时长：${args.durationSec}秒`,
      `生成策略：${strategyLabel}`,
      `导演手法：${args.config.directorMethod}`,
      `AI：${args.config.aiTool} / ${args.config.aiModel}`,
      `镜头重点：${args.focus}`,
      `出镜角色：${args.characters.join("、") || "无"}`,
      `核心动作/情绪：围绕“${args.focus}”设计明确动作、视线和转场`,
    ].join("\n"),
  };
}

function chunkNumberList(values: ReadonlyArray<number>, size: number): number[][] {
  const chunkSize = Math.max(1, size);
  const result: number[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    result.push(values.slice(index, index + chunkSize));
  }
  return result;
}

function describeChapterNumbers(chapterNumbers: ReadonlyArray<number>): string {
  const normalized = normalizeNumberList(chapterNumbers as ReadonlyArray<unknown>);
  if (normalized.length === 0) return "无";
  if (normalized.length === 1) return `第${normalized[0]}章`;
  return `第${normalized[0]}-${normalized[normalized.length - 1]}章`;
}

async function readChapterContent(bookDir: string, chapterNumber: number): Promise<{
  readonly chapterNumber: number;
  readonly fileName: string | null;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
}> {
  const chaptersDir = join(bookDir, "chapters");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const paddedNum = String(chapterNumber).padStart(4, "0");
  const fileName = files.find((file) => file.startsWith(paddedNum) && file.endsWith(".md")) ?? null;
  if (!fileName) {
    return {
      chapterNumber,
      fileName: null,
      title: `第${chapterNumber}章`,
      content: "",
      wordCount: 0,
    };
  }
  const content = await readFile(join(bookDir, "chapters", fileName), "utf-8").catch(() => "");
  return {
    chapterNumber,
    fileName,
    title: deriveChapterTitle({ chapterNumber, fileName, markdown: content }),
    content,
    wordCount: estimateChapterWordCount(content),
  };
}

async function loadScriptWorkspaceChapterInputs(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly selectedChapterNumbers: ReadonlyArray<number>;
  readonly config: ScriptWorkspaceConfig;
}): Promise<{
  readonly selectedChapterNumbers: number[];
  readonly chapterInputs: ScriptWorkspaceChapterInput[];
  readonly chapterGroups: number[][];
}> {
  const bookDir = args.state.bookDir(args.bookId);
  const chapterIndex = await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]);
  const selectedChapterNumbers = normalizeNumberList(args.selectedChapterNumbers.length > 0
    ? args.selectedChapterNumbers
    : chapterIndex.map((chapter) => Number(chapter.number)));
  const chapterInputs = await Promise.all(selectedChapterNumbers.map(async (chapterNumber) => {
    const chapterMeta = chapterIndex.find((chapter) => Number(chapter.number) === chapterNumber);
    const chapter = await readChapterContent(bookDir, chapterNumber);
    const chapterTitle = chapter.title || (typeof chapterMeta?.title === "string" && chapterMeta.title.trim() ? chapterMeta.title.trim() : `第${chapterNumber}章`);
    const rawContent = chapter.content.trim();
    const sceneLocation = inferLocationLabel(rawContent || chapterTitle);
    const timeOfDay = inferTimeOfDay(rawContent || chapterTitle);
    const characters = buildCharacterCandidates(rawContent, 5);
    const props = inferProps(rawContent);
    const assetNames = uniqStrings([
      `场景素材:${sceneLocation}`,
      `视觉风格:${args.config.visualStyle}`,
      `导演方法:${args.config.directorMethod}`,
      ...characters.map((item) => `角色参考:${item}`),
      ...props.map((item) => `道具参考:${item}`),
    ]);
    return {
      chapterNumber,
      chapterTitle,
      rawContent,
      sceneLocation,
      timeOfDay,
      characters,
      props,
      assetNames,
    } satisfies ScriptWorkspaceChapterInput;
  }));
  const chapterGroups = args.config.generationStrategy === "episode"
    ? chunkNumberList(selectedChapterNumbers, args.config.chaptersPerEpisode ?? 2)
    : selectedChapterNumbers.map((chapterNumber) => [chapterNumber]);
  return {
    selectedChapterNumbers,
    chapterInputs,
    chapterGroups,
  };
}

async function buildScriptWorkspaceFromChapters(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly selectedChapterNumbers: ReadonlyArray<number>;
  readonly config?: Partial<ScriptWorkspaceConfig> | null;
  readonly existing?: Partial<ScriptWorkspace> | null;
}): Promise<ScriptWorkspace> {
  const config = normalizeWorkspaceConfig(args.config ?? args.existing?.config ?? null);
  const { selectedChapterNumbers, chapterInputs, chapterGroups } = await loadScriptWorkspaceChapterInputs({
    state: args.state,
    bookId: args.bookId,
    selectedChapterNumbers: args.selectedChapterNumbers,
    config,
  });
  const extractedScenes: ScriptWorkspaceScene[] = [];
  const extractedCharacters = new Map<string, WorkspaceEntityDraft>();
  const extractedProps = new Map<string, WorkspaceEntityDraft>();
  const extractedAssets = new Map<string, WorkspaceEntityDraft>();
  const episodes: ScriptWorkspaceEpisode[] = [];

  for (let episodeIndex = 0; episodeIndex < chapterGroups.length; episodeIndex += 1) {
    const sourceChapterNumbers = chapterGroups[episodeIndex]!;
    const groupInputs = sourceChapterNumbers
      .map((chapterNumber) => chapterInputs.find((item) => item.chapterNumber === chapterNumber) ?? null)
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (groupInputs.length === 0) continue;

    const leadChapterNumber = groupInputs[0]!.chapterNumber;
    const leadChapterTitle = groupInputs[0]!.chapterTitle;
    const mergedTitle = groupInputs.map((item) => item.chapterTitle).join(" / ");
    const mergedContent = groupInputs.map((item) => item.rawContent).filter(Boolean).join("\n\n");
    const mergedLocation = groupInputs.map((item) => item.sceneLocation).filter(Boolean).join(" / ");
    const mergedTimeOfDay = groupInputs.map((item) => item.timeOfDay).filter(Boolean).join(" / ");
    const mergedCharacters = uniqStrings(groupInputs.flatMap((item) => item.characters));
    const mergedProps = uniqStrings(groupInputs.flatMap((item) => item.props));
    const mergedAssets = uniqStrings(groupInputs.flatMap((item) => item.assetNames));

    for (const input of groupInputs) {
      for (const character of input.characters) {
        if (!extractedCharacters.has(character)) {
          extractedCharacters.set(character, createEntity(character, `第${input.chapterNumber}章出现的角色`, input.chapterNumber));
        } else {
          extractedCharacters.get(character)?.sourceChapterNumbers.push(input.chapterNumber);
        }
      }
      for (const prop of input.props) {
        if (!extractedProps.has(prop)) {
          extractedProps.set(prop, createEntity(prop, `第${input.chapterNumber}章出现的道具`, input.chapterNumber));
        } else {
          extractedProps.get(prop)?.sourceChapterNumbers.push(input.chapterNumber);
        }
      }
      for (const assetName of input.assetNames) {
        if (!extractedAssets.has(assetName)) {
          extractedAssets.set(assetName, createEntity(assetName, `用于${describeChapterNumbers([input.chapterNumber])}剧本生成`, input.chapterNumber));
        } else {
          extractedAssets.get(assetName)?.sourceChapterNumbers.push(input.chapterNumber);
        }
      }

      const sceneSlices = buildSceneSlices(input.rawContent || input.chapterTitle, 3);
      sceneSlices.forEach((slice, sliceIndex) => {
        const sliceLocation = inferLocationLabel(slice || input.chapterTitle);
        const sliceTimeOfDay = inferTimeOfDay(slice || input.chapterTitle);
        const sliceCharacters = buildCharacterCandidates(slice || input.rawContent, 4);
        const sliceProps = inferProps(slice || input.rawContent);
        extractedScenes.push({
          id: `scene-${episodeIndex + 1}-${input.chapterNumber}-${sliceIndex + 1}`,
          episodeNumber: episodeIndex + 1,
          chapterNumber: input.chapterNumber,
          sourceChapterNumbers: [input.chapterNumber],
          title: sceneSlices.length > 1 ? `${input.chapterTitle}-场景${sliceIndex + 1}` : input.chapterTitle,
          description: summarizeText(slice || input.rawContent || input.chapterTitle, 180),
          location: sliceLocation,
          timeOfDay: sliceTimeOfDay,
          characters: sliceCharacters.length > 0 ? sliceCharacters : input.characters,
          props: sliceProps.length > 0 ? sliceProps : input.props,
          assets: input.assetNames,
        });
      });
    }

    const durations = resolveSegmentDurations(
      config.episodeDurationSec,
      config.segmentDurationSec,
      config.segmentDurationMinSec,
      config.segmentDurationMaxSec,
    );
    const segmentCount = Math.max(durations.length, 1);
    const scriptChunks = splitTextSegments(mergedContent || mergedTitle, segmentCount);
    const segments = durations.map((durationSec, segmentIndex) => {
      const scriptText = scriptChunks[segmentIndex] ?? mergedContent;
      const sceneSummary = summarizeText(scriptText || mergedTitle, 120);
      const location = inferLocationLabel(scriptText || mergedLocation || mergedTitle);
      const timeOfDay = inferTimeOfDay(scriptText || mergedTimeOfDay || mergedTitle);
      const segmentCharacters = uniqStrings([
        ...buildCharacterCandidates(scriptText || mergedContent, 4),
        ...mergedCharacters,
      ]).slice(0, 5);
      const segmentProps = uniqStrings([
        ...inferProps(scriptText || mergedContent),
        ...mergedProps,
      ]).slice(0, 5);
      const segmentAssets = uniqStrings([
        ...mergedAssets,
        `镜头参考:${sceneSummary || mergedTitle}`,
      ]);
      const promptPack = buildSegmentPromptPack({
        config,
        durationSec,
        sourceChapterNumbers,
        location,
        timeOfDay,
        characters: segmentCharacters,
        props: segmentProps,
        assets: segmentAssets,
        focus: sceneSummary || mergedTitle,
      });
      return {
        id: `seg-${episodeIndex + 1}-${segmentIndex + 1}`,
        order: segmentIndex,
        episodeNumber: episodeIndex + 1,
        chapterNumber: leadChapterNumber,
        sourceChapterNumbers,
        title: `${config.generationStrategy === "episode" ? describeChapterNumbers(sourceChapterNumbers) : leadChapterTitle}-分段${segmentIndex + 1}`,
        scene: buildSegmentSceneLabel(location, timeOfDay),
        durationSec,
        characters: segmentCharacters,
        props: segmentProps,
        assets: segmentAssets,
        scriptText,
        textToImagePrompt: promptPack.textToImagePrompt,
        imageToVideoPrompt: promptPack.imageToVideoPrompt,
      } satisfies ScriptWorkspaceSegment;
    });

    episodes.push({
      episodeNumber: episodeIndex + 1,
      chapterNumber: leadChapterNumber,
      sourceChapterNumbers,
      chapterTitle: mergedTitle,
      title: `第${episodeIndex + 1}集`,
      summary: summarizeText(mergedContent || mergedTitle, 140),
      durationSec: config.episodeDurationSec,
      segments,
    });
  }

  const workspace = normalizeScriptWorkspace({
    bookId: args.bookId,
    selectedChapterNumbers,
    updatedAt: new Date().toISOString(),
    config,
    scriptPrompt: "",
    extraction: {
      scenes: extractedScenes,
      characters: [...extractedCharacters.values()],
      props: [...extractedProps.values()],
      assets: [...extractedAssets.values()],
    },
    episodes,
  });
  return {
    ...workspace,
    scriptPrompt: buildWorkspacePrompt(workspace),
  };
}

function extractJsonObjectCandidate(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) return content.slice(start, end + 1).trim();
  return content.trim();
}

function buildScriptWorkspacePlanFromWorkspace(workspace: ScriptWorkspace): ScriptWorkspacePlan {
  return {
    scriptPrompt: workspace.scriptPrompt,
    extraction: workspace.extraction,
    episodes: workspace.episodes.map((episode) => ({
      episodeNumber: episode.episodeNumber,
      chapterNumber: episode.chapterNumber,
      sourceChapterNumbers: [...(episode.sourceChapterNumbers ?? [episode.chapterNumber])],
      chapterTitle: episode.chapterTitle,
      title: episode.title,
      summary: episode.summary,
      durationSec: episode.durationSec,
      segmentBlueprints: episode.segments.map((segment) => ({
        title: segment.title,
        scene: segment.scene,
        durationSec: segment.durationSec,
        location: segment.scene.split("/")[0]?.trim() || inferLocationLabel(segment.scriptText || segment.scene),
        timeOfDay: segment.scene.split("/")[1]?.trim() || inferTimeOfDay(segment.scriptText || segment.scene),
        intent: segment.scriptText || summarizeText(segment.title, 80),
        characters: [...segment.characters],
        props: [...segment.props],
        assets: [...segment.assets],
      })),
    })),
  };
}

function normalizeScriptWorkspacePlan(raw: unknown, fallback: ScriptWorkspace): ScriptWorkspacePlan {
  if (!raw || typeof raw !== "object") {
    return buildScriptWorkspacePlanFromWorkspace(fallback);
  }
  const payload = raw as {
    scriptPrompt?: unknown;
    extraction?: Partial<ScriptWorkspaceExtraction>;
    episodes?: Array<{
      episodeNumber?: unknown;
      chapterNumber?: unknown;
      sourceChapterNumbers?: ReadonlyArray<unknown>;
      chapterTitle?: unknown;
      title?: unknown;
      summary?: unknown;
      durationSec?: unknown;
      segmentBlueprints?: Array<Partial<ScriptWorkspaceSegmentBlueprint>>;
      segments?: Array<Partial<ScriptWorkspaceSegment>>;
    }>;
  };
  const fallbackPlan = buildScriptWorkspacePlanFromWorkspace(fallback);
  return {
    scriptPrompt: typeof payload.scriptPrompt === "string" && payload.scriptPrompt.trim()
      ? payload.scriptPrompt.trim()
      : fallbackPlan.scriptPrompt,
    extraction: {
      scenes: Array.isArray(payload.extraction?.scenes)
        ? payload.extraction.scenes.map((scene) => normalizeWorkspaceScene(scene ?? {}))
        : fallbackPlan.extraction.scenes,
      characters: Array.isArray(payload.extraction?.characters)
        ? payload.extraction.characters.map((entity) => normalizeWorkspaceEntity(entity ?? {}))
        : fallbackPlan.extraction.characters,
      props: Array.isArray(payload.extraction?.props)
        ? payload.extraction.props.map((entity) => normalizeWorkspaceEntity(entity ?? {}))
        : fallbackPlan.extraction.props,
      assets: Array.isArray(payload.extraction?.assets)
        ? payload.extraction.assets.map((entity) => normalizeWorkspaceEntity(entity ?? {}))
        : fallbackPlan.extraction.assets,
    },
    episodes: Array.isArray(payload.episodes) && payload.episodes.length > 0
      ? payload.episodes.map((episode, index) => {
        const fallbackEpisode = fallbackPlan.episodes[index] ?? fallbackPlan.episodes[fallbackPlan.episodes.length - 1];
        const blueprintSource = Array.isArray(episode.segmentBlueprints) && episode.segmentBlueprints.length > 0
          ? episode.segmentBlueprints
          : (Array.isArray(episode.segments) ? episode.segments : []);
        const segmentBlueprints = blueprintSource.length > 0
          ? blueprintSource.map((segment, segmentIndex) => {
            const fallbackBlueprint = fallbackEpisode?.segmentBlueprints[segmentIndex] ?? fallbackEpisode?.segmentBlueprints[0];
            const scene = typeof segment.scene === "string" && segment.scene.trim()
              ? segment.scene.trim()
              : (fallbackBlueprint?.scene ?? "故事现场 / 不定时段");
            const location = typeof (segment as { location?: unknown }).location === "string" && String((segment as { location?: unknown }).location).trim()
              ? String((segment as { location?: unknown }).location).trim()
              : scene.split("/")[0]?.trim() || fallbackBlueprint?.location || "故事现场";
            const timeOfDay = typeof (segment as { timeOfDay?: unknown }).timeOfDay === "string" && String((segment as { timeOfDay?: unknown }).timeOfDay).trim()
              ? String((segment as { timeOfDay?: unknown }).timeOfDay).trim()
              : scene.split("/")[1]?.trim() || fallbackBlueprint?.timeOfDay || "不定时段";
            return {
              title: typeof segment.title === "string" && segment.title.trim()
                ? segment.title.trim()
                : (fallbackBlueprint?.title ?? `分段${segmentIndex + 1}`),
              scene,
              durationSec: clampInt(
                (segment as { durationSec?: unknown }).durationSec,
                fallbackBlueprint?.durationSec ?? DEFAULT_SCRIPT_WORKSPACE_CONFIG.segmentDurationSec,
                1,
                120,
              ),
              location,
              timeOfDay,
              intent: typeof (segment as { intent?: unknown }).intent === "string" && String((segment as { intent?: unknown }).intent).trim()
                ? String((segment as { intent?: unknown }).intent).trim()
                : typeof (segment as { scriptText?: unknown }).scriptText === "string" && String((segment as { scriptText?: unknown }).scriptText).trim()
                  ? String((segment as { scriptText?: unknown }).scriptText).trim()
                  : (fallbackBlueprint?.intent ?? fallbackBlueprint?.title ?? `分段${segmentIndex + 1}`),
              characters: uniqStrings(Array.isArray(segment.characters) ? segment.characters.map(String) : fallbackBlueprint?.characters ?? []),
              props: uniqStrings(Array.isArray(segment.props) ? segment.props.map(String) : fallbackBlueprint?.props ?? []),
              assets: uniqStrings(Array.isArray(segment.assets) ? segment.assets.map(String) : fallbackBlueprint?.assets ?? []),
            } satisfies ScriptWorkspaceSegmentBlueprint;
          })
          : (fallbackEpisode?.segmentBlueprints ?? []);
        return {
          episodeNumber: clampInt(episode.episodeNumber, fallbackEpisode?.episodeNumber ?? index + 1, 1, 1_000_000),
          chapterNumber: clampInt(episode.chapterNumber, fallbackEpisode?.chapterNumber ?? 1, 1, 1_000_000),
          sourceChapterNumbers: normalizeNumberList(episode.sourceChapterNumbers as ReadonlyArray<unknown> | undefined).length > 0
            ? normalizeNumberList(episode.sourceChapterNumbers as ReadonlyArray<unknown> | undefined)
            : [...(fallbackEpisode?.sourceChapterNumbers ?? [fallbackEpisode?.chapterNumber ?? 1])],
          chapterTitle: typeof episode.chapterTitle === "string" && episode.chapterTitle.trim()
            ? episode.chapterTitle.trim()
            : (fallbackEpisode?.chapterTitle ?? "章节"),
          title: typeof episode.title === "string" && episode.title.trim()
            ? episode.title.trim()
            : (fallbackEpisode?.title ?? `第${index + 1}集`),
          summary: typeof episode.summary === "string" && episode.summary.trim()
            ? episode.summary.trim()
            : (fallbackEpisode?.summary ?? ""),
          durationSec: clampInt(episode.durationSec, fallbackEpisode?.durationSec ?? DEFAULT_SCRIPT_WORKSPACE_CONFIG.episodeDurationSec, 30, 1800),
          segmentBlueprints,
        } satisfies ScriptWorkspaceEpisodePlan;
      })
      : fallbackPlan.episodes,
  };
}

function buildScriptWorkspaceLLMPlanPrompt(args: {
  readonly config: ScriptWorkspaceConfig;
  readonly chapterInputs: ReadonlyArray<ScriptWorkspaceChapterInput>;
  readonly chapterGroups: ReadonlyArray<ReadonlyArray<number>>;
}): string {
  const chapterSections = args.chapterGroups.map((group, index) => {
    const groupInputs = group
      .map((chapterNumber) => args.chapterInputs.find((item) => item.chapterNumber === chapterNumber))
      .filter((item): item is ScriptWorkspaceChapterInput => Boolean(item));
    const mergedText = groupInputs.map((item) => item.rawContent).filter(Boolean).join("\n\n").slice(0, 10_000);
    return [
      `### 第${index + 1}集候选`,
      `覆盖章节：${describeChapterNumbers(group)}`,
      `章节标题：${groupInputs.map((item) => item.chapterTitle).join(" / ")}`,
      `候选角色：${uniqStrings(groupInputs.flatMap((item) => item.characters)).join("、") || "无"}`,
      `候选道具：${uniqStrings(groupInputs.flatMap((item) => item.props)).join("、") || "无"}`,
      mergedText || "（正文为空，请根据章节标题规划分集结构）",
    ].join("\n");
  });
  return [
    "你是小说转短视频剧本工作台的分集规划助手。",
    "请输出严格 JSON，不要输出 markdown，不要解释。",
    "任务：先做分集规划与提取，不生成最终段落正文。",
    "要求：",
    "1. extraction 必须包含 scenes / characters / props / assets。",
    `2. 当前策略：${args.config.generationStrategy === "episode" ? `按集，每集 ${args.config.chaptersPerEpisode ?? 2} 章` : "按章，每章一集"}。`,
    "3. episodes 必须覆盖所有输入章节并保持顺序。",
    "4. 每集必须给出 summary 和 segmentBlueprints。",
    "5. segmentBlueprints 必须尽量接近镜头级切分，按地点变化、时间变化、动作转折、对白交锋拆段。",
    "6. 每段 durationSec 必须落在配置范围内。",
    "7. 只输出 JSON，字段内容全部用中文。",
    "",
    "输出 JSON 结构：",
    "{",
    '  "scriptPrompt": "整体改编策略总结",',
    '  "extraction": {',
    '    "scenes": [{ "id": "scene-1", "episodeNumber": 1, "chapterNumber": 1, "sourceChapterNumbers": [1], "title": "场景名", "description": "场景说明", "location": "地点", "timeOfDay": "时间", "characters": ["角色"], "props": ["道具"], "assets": ["素材"] }],',
    '    "characters": [{ "name": "角色名", "description": "角色说明", "sourceChapterNumbers": [1] }],',
    '    "props": [{ "name": "道具名", "description": "道具说明", "sourceChapterNumbers": [1] }],',
    '    "assets": [{ "name": "素材名", "description": "素材说明", "sourceChapterNumbers": [1] }]',
    "  },",
    '  "episodes": [{',
    '    "episodeNumber": 1,',
    '    "chapterNumber": 1,',
    '    "sourceChapterNumbers": [1],',
    '    "chapterTitle": "章节标题",',
    '    "title": "第1集",',
    '    "summary": "本集概述",',
    `    "durationSec": ${args.config.episodeDurationSec},`,
    '    "segmentBlueprints": [{ "title": "分镜段标题", "scene": "地点 / 时段", "durationSec": 12, "location": "地点", "timeOfDay": "时段", "intent": "这一段的动作与情绪目标", "characters": ["角色"], "props": ["道具"], "assets": ["素材"] }]',
    "  }]",
    "}",
    "",
    `视觉风格：${args.config.visualStyle}`,
    `导演手法：${args.config.directorMethod}`,
    `AI：${args.config.aiTool} / ${args.config.aiModel}`,
    `每集时长：${args.config.episodeDurationSec}秒`,
    `每段目标时长：${args.config.segmentDurationSec}秒`,
    `每段最小时长：${args.config.segmentDurationMinSec}秒`,
    `每段最大时长：${args.config.segmentDurationMaxSec}秒`,
    `剧本提示词：${args.config.scriptPrompts.script}`,
    `文生图提示词：${args.config.scriptPrompts.image}`,
    `图生视频提示词：${args.config.scriptPrompts.video}`,
    "",
    "输入章节：",
    ...chapterSections,
  ].join("\n");
}

function buildScriptWorkspaceLLMEpisodePrompt(args: {
  readonly config: ScriptWorkspaceConfig;
  readonly episodePlan: ScriptWorkspaceEpisodePlan;
  readonly chapterInputs: ReadonlyArray<ScriptWorkspaceChapterInput>;
}): string {
  const chapterText = args.chapterInputs
    .map((item) => [
      `### 第${item.chapterNumber}章 ${item.chapterTitle}`,
      item.rawContent ? item.rawContent.slice(0, 8_000) : "（正文为空）",
    ].join("\n"))
    .join("\n\n");
  return [
    "你是小说转短视频剧本工作台的逐集分镜生成助手。",
    "请输出严格 JSON，不要输出 markdown，不要解释。",
    "任务：基于既定分集规划，生成这一集每个分段的剧本正文、文生图提示词、图生视频提示词。",
    "要求：",
    "1. 只能输出一个 JSON 对象。",
    "2. segments 数量应与给定的 segmentBlueprints 基本一致。",
    "3. 每段必须保持镜头级表达，动作、视线、情绪、转场清晰。",
    "4. 文生图提示词要明确视觉风格、景别、人物状态、光影、材质、道具。",
    "5. 图生视频提示词要明确镜头运动、表演动作、节奏和转场。",
    "6. 所有字段内容使用中文。",
    "",
    "输出 JSON 结构：",
    "{",
    '  "summary": "可选，本集总结",',
    '  "segments": [{',
    '    "title": "分段标题",',
    '    "scene": "地点 / 时段",',
    `    "durationSec": ${args.config.segmentDurationSec},`,
    '    "characters": ["角色"],',
    '    "props": ["道具"],',
    '    "assets": ["素材"],',
    '    "scriptText": "该分段剧本正文，强调动作、冲突、情绪与镜头重点",',
    '    "textToImagePrompt": "文生图提示词",',
    '    "imageToVideoPrompt": "图生视频提示词"',
    "  }]",
    "}",
    "",
    `视觉风格：${args.config.visualStyle}`,
    `导演手法：${args.config.directorMethod}`,
    `AI：${args.config.aiTool} / ${args.config.aiModel}`,
    `本集标题：${args.episodePlan.title}`,
    `覆盖章节：${describeChapterNumbers(args.episodePlan.sourceChapterNumbers)}`,
    `本集概述：${args.episodePlan.summary}`,
    `剧本提示词：${args.config.scriptPrompts.script}`,
    `文生图提示词：${args.config.scriptPrompts.image}`,
    `图生视频提示词：${args.config.scriptPrompts.video}`,
    "",
    "已定分集规划：",
    JSON.stringify(args.episodePlan, null, 2),
    "",
    "原始章节内容：",
    chapterText,
  ].join("\n");
}

function buildWorkspaceFromPlanWithEpisodeOutputs(args: {
  readonly bookId: string;
  readonly selectedChapterNumbers: ReadonlyArray<number>;
  readonly config: ScriptWorkspaceConfig;
  readonly plan: ScriptWorkspacePlan;
  readonly fallback: ScriptWorkspace;
  readonly episodeOutputs: ReadonlyArray<unknown>;
}): ScriptWorkspace {
  const fallbackByEpisode = new Map<number, ScriptWorkspaceEpisode>(
    args.fallback.episodes.map((episode) => [episode.episodeNumber, episode]),
  );

  const episodes = args.plan.episodes.map((episodePlan, episodeIndex) => {
    const fallbackEpisode = fallbackByEpisode.get(episodePlan.episodeNumber)
      ?? args.fallback.episodes[episodeIndex]
      ?? args.fallback.episodes[0];
    const rawOutput = args.episodeOutputs[episodeIndex];
    const parsedOutput = rawOutput && typeof rawOutput === "object"
      ? rawOutput as {
        summary?: unknown;
        segments?: Array<Partial<ScriptWorkspaceSegment> & { intent?: unknown; location?: unknown; timeOfDay?: unknown }>;
      }
      : null;
    const outputSegments = Array.isArray(parsedOutput?.segments) ? parsedOutput.segments : [];
    const segmentBlueprints = episodePlan.segmentBlueprints.length > 0
      ? episodePlan.segmentBlueprints
      : fallbackEpisode?.segments.map((segment) => ({
        title: segment.title,
        scene: segment.scene,
        durationSec: segment.durationSec,
        location: segment.scene.split("/")[0]?.trim() || "故事现场",
        timeOfDay: segment.scene.split("/")[1]?.trim() || "不定时段",
        intent: segment.scriptText || segment.title,
        characters: [...segment.characters],
        props: [...segment.props],
        assets: [...segment.assets],
      })) ?? [];

    const segments = segmentBlueprints.map((blueprint, segmentIndex) => {
      const generated = outputSegments[segmentIndex] ?? null;
      const title = typeof generated?.title === "string" && generated.title.trim()
        ? generated.title.trim()
        : blueprint.title;
      const scene = typeof generated?.scene === "string" && generated.scene.trim()
        ? generated.scene.trim()
        : blueprint.scene;
      const location = typeof generated?.location === "string" && generated.location.trim()
        ? generated.location.trim()
        : scene.split("/")[0]?.trim() || blueprint.location || "故事现场";
      const timeOfDay = typeof generated?.timeOfDay === "string" && generated.timeOfDay.trim()
        ? generated.timeOfDay.trim()
        : scene.split("/")[1]?.trim() || blueprint.timeOfDay || "不定时段";
      const durationSec = clampInt(
        generated?.durationSec,
        blueprint.durationSec,
        args.config.segmentDurationMinSec,
        args.config.segmentDurationMaxSec,
      );
      const characters = uniqStrings(Array.isArray(generated?.characters) ? generated!.characters!.map(String) : blueprint.characters);
      const props = uniqStrings(Array.isArray(generated?.props) ? generated!.props!.map(String) : blueprint.props);
      const assets = uniqStrings(Array.isArray(generated?.assets) ? generated!.assets!.map(String) : blueprint.assets);
      const scriptText = typeof generated?.scriptText === "string" && generated.scriptText.trim()
        ? generated.scriptText.trim()
        : blueprint.intent;
      const promptPack = buildSegmentPromptPack({
        config: args.config,
        durationSec,
        sourceChapterNumbers: episodePlan.sourceChapterNumbers,
        location,
        timeOfDay,
        characters,
        props,
        assets,
        focus: summarizeText(scriptText || blueprint.intent || title, 120),
      });
      return {
        id: `seg-${episodePlan.episodeNumber}-${segmentIndex + 1}`,
        order: segmentIndex,
        episodeNumber: episodePlan.episodeNumber,
        chapterNumber: episodePlan.chapterNumber,
        sourceChapterNumbers: episodePlan.sourceChapterNumbers,
        title,
        scene: buildSegmentSceneLabel(location, timeOfDay),
        durationSec,
        characters,
        props,
        assets,
        scriptText,
        textToImagePrompt: typeof generated?.textToImagePrompt === "string" && generated.textToImagePrompt.trim()
          ? generated.textToImagePrompt.trim()
          : promptPack.textToImagePrompt,
        imageToVideoPrompt: typeof generated?.imageToVideoPrompt === "string" && generated.imageToVideoPrompt.trim()
          ? generated.imageToVideoPrompt.trim()
          : promptPack.imageToVideoPrompt,
      } satisfies ScriptWorkspaceSegment;
    });

    return {
      episodeNumber: episodePlan.episodeNumber,
      chapterNumber: episodePlan.chapterNumber,
      sourceChapterNumbers: episodePlan.sourceChapterNumbers,
      chapterTitle: episodePlan.chapterTitle,
      title: episodePlan.title,
      summary: typeof parsedOutput?.summary === "string" && parsedOutput.summary.trim()
        ? parsedOutput.summary.trim()
        : episodePlan.summary,
      durationSec: episodePlan.durationSec,
      segments,
    } satisfies ScriptWorkspaceEpisode;
  });

  const workspace = normalizeScriptWorkspace({
    bookId: args.bookId,
    selectedChapterNumbers: args.selectedChapterNumbers,
    updatedAt: new Date().toISOString(),
    config: args.config,
    scriptPrompt: args.plan.scriptPrompt,
    extraction: args.plan.extraction,
    episodes,
  });
  return {
    ...workspace,
    scriptPrompt: workspace.scriptPrompt || buildWorkspacePrompt(workspace),
  };
}

async function readTaskChecklist(bookDir: string, bookId: string): Promise<{ bookId: string; templateId: string; items: TaskChecklistItem[]; updatedAt: string }> {
  const checklistPath = join(bookDir, "story", "state", "task-checklist.json");
  try {
    const raw = await readFile(checklistPath, "utf-8");
    const parsed = JSON.parse(raw) as { bookId?: unknown; templateId?: unknown; updatedAt?: unknown; items?: unknown };
    const items = Array.isArray(parsed.items) ? parsed.items.map((item) => normalizeTaskChecklistItem(item as never)) : [];
    return {
      bookId,
      templateId: resolveScriptWorkspaceChecklistTemplateId(typeof parsed.templateId === "string" ? parsed.templateId : undefined),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      items: sortTaskChecklistItems(items),
    };
  } catch {
    return {
      bookId,
      templateId: resolveScriptWorkspaceChecklistTemplateId(),
      updatedAt: new Date().toISOString(),
      items: [],
    };
  }
}

async function writeTaskChecklist(bookDir: string, checklist: { bookId: string; templateId?: string; items: ReadonlyArray<TaskChecklistItem>; updatedAt?: string }): Promise<void> {
  const checklistPath = join(bookDir, "story", "state", "task-checklist.json");
  await mkdir(join(bookDir, "story", "state"), { recursive: true });
  await writeFile(checklistPath, JSON.stringify({
    bookId: checklist.bookId,
    templateId: resolveScriptWorkspaceChecklistTemplateId(checklist.templateId),
    updatedAt: checklist.updatedAt ?? new Date().toISOString(),
    items: sortTaskChecklistItems(checklist.items),
  }, null, 2), "utf-8");
}

async function readScriptWorkspace(bookDir: string, bookId: string, state: StateManager): Promise<ScriptWorkspace> {
  const workspacePath = join(bookDir, "story", "state", "script-workspace.json");
  try {
    const raw = await readFile(workspacePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ScriptWorkspace>;
    return normalizeScriptWorkspace({
      ...parsed,
      bookId,
    });
  } catch {
    const selectedChapterNumbers = (await state.loadChapterIndex(bookId).catch(() => [] as ChapterIndexEntryLike[]))
      .map((chapter) => Number(chapter.number))
      .filter((chapterNumber) => Number.isFinite(chapterNumber) && chapterNumber > 0);
    return buildScriptWorkspaceFromChapters({
      state,
      bookId,
      selectedChapterNumbers,
    });
  }
}

function productionWorkspacePath(bookDir: string): string {
  return join(bookDir, "story", "state", PRODUCTION_WORKSPACE_FILE);
}

function directorPlanPath(bookDir: string): string {
  return join(bookDir, "story", "state", DIRECTOR_PLAN_FILE);
}

function directorPlanHistoryPath(bookDir: string): string {
  return join(bookDir, "story", "state", DIRECTOR_PLAN_HISTORY_FILE);
}

function assetLibraryPath(bookDir: string): string {
  return join(bookDir, "story", "state", ASSET_LIBRARY_FILE);
}

function assetLibraryHistoryPath(bookDir: string): string {
  return join(bookDir, "story", "state", ASSET_LIBRARY_HISTORY_FILE);
}

function inferShotType(text: string, durationSec: number): string {
  if (/[“”"「」]/.test(text) || /(凝视|眼神|表情|低声|压低声音)/.test(text)) return "近景";
  if (/(远眺|俯瞰|人群|街道|广场|城楼|山路|全貌|全景)/.test(text) || durationSec >= 14) return "全景";
  return "中景";
}

function inferShotCameraMovement(text: string, order: number): string {
  if (/(冲|跑|追|扑|转身|逼近|靠近|登上|走向)/.test(text)) return "跟拍";
  if (/(忽然|突然|猛地|一下)/.test(text)) return "快速摇镜";
  if (/[“”"「」]/.test(text)) return "缓推";
  return order % 2 === 0 ? "静态镜头" : "缓推";
}

function inferShotMood(text: string): string {
  if (/(愤怒|暴怒|杀意|压迫)/.test(text)) return "压迫紧绷";
  if (/(悲伤|哽咽|沉默|落寞)/.test(text)) return "压抑低沉";
  if (/(坚定|决绝|对峙|试探)/.test(text)) return "克制紧张";
  if (/(惊讶|慌乱|害怕|惊恐)/.test(text)) return "不安失衡";
  return "稳定叙事";
}

function inferShotLighting(text: string, scene: string): string {
  if (/(夜|深夜|夜晚)/.test(text) || /夜/.test(scene)) return "低照度冷色边缘光，保留高反差阴影";
  if (/(清晨|晨|天亮)/.test(text)) return "清晨侧光，空气透视明显";
  if (/(黄昏|傍晚|日落)/.test(text)) return "黄昏逆光，暖冷交错";
  return "环境主光明确，人物与背景层次分明";
}

function extractShotDialogue(text: string): { dialogue: string; dialogueType: ProductionDialogueType } {
  const quoted = text.match(/[“"「]([^”"」]+)[”"」]/);
  if (quoted?.[1]?.trim()) {
    if (/(心想|心道|暗道|内心)/.test(text)) {
      return { dialogue: quoted[1].trim(), dialogueType: "inner_monologue" };
    }
    if (/(画外音|旁白)/.test(text)) {
      return { dialogue: quoted[1].trim(), dialogueType: "voiceover" };
    }
    return { dialogue: quoted[1].trim(), dialogueType: "dialogue" };
  }
  return { dialogue: "", dialogueType: "none" };
}

function buildProductionShotsFromSegment(segment: ScriptWorkspaceSegment, config: ScriptWorkspaceConfig): ProductionShot[] {
  const beats = buildSemanticTextBeats(segment.scriptText || segment.title);
  const shotCount = Math.max(1, Math.min(3, beats.length));
  const shotTexts = rebalanceTextBeats(beats, shotCount);
  const shotDurations = resolveSegmentDurations(
    segment.durationSec,
    Math.max(3, Math.round(segment.durationSec / shotCount)),
    3,
    Math.max(3, segment.durationSec),
  );
  return shotTexts.map((shotText, index) => {
    const scene = buildSegmentSceneLabel(
      inferLocationLabel(shotText || segment.scene),
      inferTimeOfDay(shotText || segment.scene),
    );
    const dialogue = extractShotDialogue(shotText);
    const shotType = inferShotType(shotText, shotDurations[index] ?? 5);
    const cameraMovement = inferShotCameraMovement(shotText, index);
    const mood = inferShotMood(shotText);
    const lighting = inferShotLighting(shotText, scene);
    const promptPack = buildSegmentPromptPack({
      config,
      durationSec: shotDurations[index] ?? 5,
      sourceChapterNumbers: segment.sourceChapterNumbers ?? [segment.chapterNumber],
      location: scene.split("/")[0]?.trim() || "故事现场",
      timeOfDay: scene.split("/")[1]?.trim() || "不定时段",
      characters: segment.characters,
      props: segment.props,
      assets: uniqStrings([
        ...segment.assets,
        `镜头类型:${shotType}`,
        `运镜:${cameraMovement}`,
      ]),
      focus: summarizeText(shotText || segment.scriptText || segment.title, 100),
    });
    return normalizeProductionShot({
      id: `shot-${segment.episodeNumber}-${segment.order + 1}-${index + 1}`,
      episodeNumber: segment.episodeNumber,
      chapterNumber: segment.chapterNumber,
      sourceChapterNumbers: segment.sourceChapterNumbers,
      segmentId: segment.id,
      segmentOrder: segment.order,
      shotNumber: index + 1,
      track: "main",
      title: `${segment.title}-镜头${index + 1}`,
      scene,
      durationSec: shotDurations[index] ?? 5,
      shotType,
      cameraMovement,
      dialogue: dialogue.dialogue,
      dialogueType: dialogue.dialogueType,
      mood,
      lighting,
      shouldGenerateImage: true,
      characters: segment.characters,
      props: segment.props,
      assets: uniqStrings([
        ...segment.assets,
        `镜头类型:${shotType}`,
        `运镜:${cameraMovement}`,
      ]),
      scriptText: shotText,
      textToImagePrompt: promptPack.textToImagePrompt,
      imageToVideoPrompt: promptPack.imageToVideoPrompt,
    });
  });
}

function buildProductionWorkspaceFromScriptWorkspace(workspace: ScriptWorkspace): ProductionWorkspace {
  const episodes = workspace.episodes.map((episode) => {
    const shots = episode.segments.flatMap((segment) => buildProductionShotsFromSegment(segment, workspace.config));
    return normalizeProductionEpisode({
      episodeNumber: episode.episodeNumber,
      chapterNumber: episode.chapterNumber,
      sourceChapterNumbers: episode.sourceChapterNumbers,
      title: episode.title,
      chapterTitle: episode.chapterTitle,
      summary: episode.summary,
      durationSec: episode.durationSec,
      trackCount: 1,
      shots,
    });
  });
  return normalizeProductionWorkspace({
    bookId: workspace.bookId,
    selectedChapterNumbers: workspace.selectedChapterNumbers,
    updatedAt: new Date().toISOString(),
    sourceScriptUpdatedAt: workspace.updatedAt,
    sourceConfig: workspace.config,
    episodes,
  });
}

function buildDirectorPlanFromProductionWorkspace(workspace: ProductionWorkspace): DirectorPlan {
  const episodePlans = workspace.episodes.map((episode) => {
    const moods = uniqStrings(episode.shots.map((shot) => shot.mood).filter(Boolean));
    const lightings = uniqStrings(episode.shots.map((shot) => shot.lighting).filter(Boolean));
    const lensRules = uniqStrings(episode.shots.map((shot) => `${shot.shotType} / ${shot.cameraMovement}`).filter(Boolean));
    const characters = uniqStrings(episode.shots.flatMap((shot) => shot.characters));
    const props = uniqStrings(episode.shots.flatMap((shot) => shot.props));
    return normalizeDirectorPlanEpisode({
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      storyGoal: episode.summary || summarizeText(episode.shots.map((shot) => shot.scriptText).join(" "), 120),
      emotionalBeat: moods.join(" -> ") || "稳定叙事",
      pacing: `${episode.durationSec} 秒 / ${episode.shots.length} 镜头，按 ${workspace.sourceConfig.directorMethod} 控制节奏切换`,
      lensLanguage: lensRules.join("；") || workspace.sourceConfig.directorMethod,
      blockingNotes: `场景围绕 ${episode.chapterTitle} 展开，重点角色：${characters.join("、") || "无"}。`,
      lightingNotes: lightings.join("；") || workspace.sourceConfig.visualStyle,
      soundNotes: episode.shots.some((shot) => shot.dialogueType !== "none")
        ? "保留关键对白，环境声衔接镜头转场。"
        : "以环境氛围和动作声补足镜头节奏。",
      continuityNotes: `注意角色造型、道具 ${props.join("、") || "无"} 与镜头顺序连续性。`,
    });
  });
  return normalizeDirectorPlan({
    bookId: workspace.bookId,
    updatedAt: new Date().toISOString(),
    sourceProductionUpdatedAt: workspace.updatedAt,
    sourceConfig: workspace.sourceConfig,
    visualStatement: `${workspace.sourceConfig.visualStyle}，服务于 ${workspace.episodes.length} 集短视频改编的统一视觉表达。`,
    directorIntent: `${workspace.sourceConfig.directorMethod}，并确保每段镜头在 ${workspace.sourceConfig.segmentDurationMinSec}-${workspace.sourceConfig.segmentDurationMaxSec} 秒内完成明确动作和情绪交代。`,
    visualRules: [
      `角色、场景、道具需保持 ${workspace.sourceConfig.visualStyle} 的统一质感`,
      "每个镜头必须有明确的主体、景别与前后景关系",
      "出图镜头优先保证角色识别度与场景连续性",
    ],
    cameraRules: [
      `主导运镜遵循：${workspace.sourceConfig.directorMethod}`,
      "对白镜头优先保证视线关系和轴线稳定",
      "动作镜头优先保留运动方向连续性",
    ],
    colorScript: episodePlans.map((episode) => `${episode.title}：${episode.lightingNotes || "延续统一色彩脚本"}`),
    episodePlans,
  });
}

function buildAssetLibraryFromProductionWorkspace(workspace: ProductionWorkspace): AssetLibrary {
  const records = new Map<string, AssetLibraryItem>();
  const pushItem = (
    type: AssetLibraryItemType,
    name: string,
    description: string,
    episodeNumber: number,
    shotId: string,
    prompt: string,
    tags: ReadonlyArray<string>,
  ) => {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    const key = `${type}:${normalizedName}`;
    const existing = records.get(key);
    if (existing) {
      records.set(key, normalizeAssetLibraryItem({
        ...existing,
        description: existing.description || description,
        episodeNumbers: normalizeNumberList([...existing.episodeNumbers, episodeNumber]),
        shotIds: uniqStrings([...existing.shotIds, shotId]),
        referenceCount: uniqStrings([...existing.shotIds, shotId]).length,
        prompt: existing.prompt || prompt,
        tags: uniqStrings([...existing.tags, ...tags]),
      }));
      return;
    }
    records.set(key, normalizeAssetLibraryItem({
      id: `asset-${records.size + 1}`,
      type,
      name: normalizedName,
      description,
      episodeNumbers: [episodeNumber],
      shotIds: [shotId],
      referenceCount: 1,
      prompt,
      status: "draft",
      thumbnailPath: "",
      filePath: "",
      generation: {
        imageStatus: "pending",
        videoStatus: "pending",
        needsRegeneration: false,
        lastError: "",
        notes: "",
      },
      tags,
    }));
  };

  for (const episode of workspace.episodes) {
    for (const shot of episode.shots) {
      for (const character of shot.characters) {
        pushItem(
          "character",
          character,
          `${episode.title} 出镜角色`,
          episode.episodeNumber,
          shot.id,
          `${workspace.sourceConfig.visualStyle}，角色 ${character}，匹配镜头 ${shot.title} 的表演与服化道连续性`,
          [episode.title, "character"],
        );
      }
      for (const prop of shot.props) {
        pushItem(
          "prop",
          prop,
          `${episode.title} 关键道具`,
          episode.episodeNumber,
          shot.id,
          `${workspace.sourceConfig.visualStyle}，道具 ${prop}，与场景 ${shot.scene} 保持材质和比例一致`,
          [episode.title, "prop"],
        );
      }
      pushItem(
        "scene",
        shot.scene,
        `${episode.title} 场景参考`,
        episode.episodeNumber,
        shot.id,
        `${workspace.sourceConfig.visualStyle}，场景 ${shot.scene}，适配 ${shot.shotType} 与 ${shot.cameraMovement}`,
        [episode.title, "scene"],
      );
      for (const asset of shot.assets) {
        pushItem(
          "reference",
          asset,
          `${episode.title} 视觉参考`,
          episode.episodeNumber,
          shot.id,
          `${workspace.sourceConfig.visualStyle}，参考资产 ${asset}，用于镜头 ${shot.title} 的画面一致性控制`,
          [episode.title, "reference"],
        );
      }
    }
  }

  return normalizeAssetLibrary({
    bookId: workspace.bookId,
    updatedAt: new Date().toISOString(),
    sourceProductionUpdatedAt: workspace.updatedAt,
    items: [...records.values()],
  });
}

async function readProductionWorkspace(bookDir: string, bookId: string, state: StateManager): Promise<ProductionWorkspace> {
  const workspacePath = productionWorkspacePath(bookDir);
  try {
    const raw = await readFile(workspacePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProductionWorkspace>;
    return normalizeProductionWorkspace({
      ...parsed,
      bookId,
    });
  } catch {
    const scriptWorkspace = await readScriptWorkspace(bookDir, bookId, state);
    return buildProductionWorkspaceFromScriptWorkspace(scriptWorkspace);
  }
}

async function writeProductionWorkspace(bookDir: string, workspace: ProductionWorkspace): Promise<ProductionWorkspace> {
  const workspacePath = productionWorkspacePath(bookDir);
  const normalized = normalizeProductionWorkspace({
    ...workspace,
    updatedAt: new Date().toISOString(),
  });
  await mkdir(join(bookDir, "story", "state"), { recursive: true });
  await writeFile(workspacePath, JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
}

async function readDirectorPlan(bookDir: string, bookId: string, state: StateManager): Promise<DirectorPlan> {
  const filePath = directorPlanPath(bookDir);
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizeDirectorPlan({
      ...JSON.parse(raw) as Partial<DirectorPlan>,
      bookId,
    });
  } catch {
    const productionWorkspace = await readProductionWorkspace(bookDir, bookId, state);
    return buildDirectorPlanFromProductionWorkspace(productionWorkspace);
  }
}

async function writeDirectorPlan(bookDir: string, plan: DirectorPlan): Promise<DirectorPlan> {
  const { plan: savedPlan } = await writeDirectorPlanWithHistory(bookDir, plan, "save");
  return savedPlan;
}

async function readAssetLibrary(bookDir: string, bookId: string, state: StateManager): Promise<AssetLibrary> {
  const filePath = assetLibraryPath(bookDir);
  try {
    const raw = await readFile(filePath, "utf-8");
    return normalizeAssetLibrary({
      ...JSON.parse(raw) as Partial<AssetLibrary>,
      bookId,
    });
  } catch {
    const productionWorkspace = await readProductionWorkspace(bookDir, bookId, state);
    return buildAssetLibraryFromProductionWorkspace(productionWorkspace);
  }
}

async function writeAssetLibrary(bookDir: string, library: AssetLibrary): Promise<AssetLibrary> {
  const { library: savedLibrary } = await writeAssetLibraryWithHistory(bookDir, library, "save");
  return savedLibrary;
}

function normalizeAssetLibraryHistoryVersion(raw: unknown): number {
  const version = Number(raw);
  if (!Number.isFinite(version) || version < 1) return 1;
  return Math.trunc(version);
}

function cloneAssetLibrarySnapshot(library: unknown): AssetLibrary | null {
  if (!library || typeof library !== "object") return null;
  try {
    return normalizeAssetLibrary(structuredClone(library) as Partial<AssetLibrary>);
  } catch {
    return normalizeAssetLibrary(library as Partial<AssetLibrary>);
  }
}

function normalizeAssetLibraryHistoryEntry(raw: unknown): AssetLibraryHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Partial<AssetLibraryHistoryEntry> & { library?: unknown };
  const library = cloneAssetLibrarySnapshot(payload.library);
  if (!library) return null;
  const bookId = typeof payload.bookId === "string" && payload.bookId.trim()
    ? payload.bookId.trim()
    : library.bookId;
  if (!bookId) return null;
  return {
    bookId,
    version: normalizeAssetLibraryHistoryVersion(payload.version),
    action: typeof payload.action === "string" && payload.action.trim() ? payload.action.trim() : "save",
    savedAt: typeof payload.savedAt === "string" && payload.savedAt.trim() ? payload.savedAt.trim() : new Date().toISOString(),
    library: normalizeAssetLibrary({
      ...library,
      bookId,
    }),
  };
}

interface AssetLibraryHistoryStore {
  readonly entries: AssetLibraryHistoryEntry[];
  readonly updatedAt?: string;
}

function loadAssetLibraryHistoryJson(raw: string): AssetLibraryHistoryStore {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return {
      entries: parsed
        .map((item) => normalizeAssetLibraryHistoryEntry(item))
        .filter((item): item is AssetLibraryHistoryEntry => item !== null),
    };
  }
  if (!parsed || typeof parsed !== "object") return { entries: [] };
  const payload = parsed as { entries?: unknown; updatedAt?: unknown };
  const entries = Array.isArray(payload.entries)
    ? payload.entries
      .map((item) => normalizeAssetLibraryHistoryEntry(item))
      .filter((item): item is AssetLibraryHistoryEntry => item !== null)
    : [];
  return {
    entries,
    ...(typeof payload.updatedAt === "string" && payload.updatedAt.trim() ? { updatedAt: payload.updatedAt.trim() } : {}),
  };
}

async function readAssetLibraryHistoryStore(historyPath: string): Promise<AssetLibraryHistoryStore> {
  try {
    const raw = await readFile(historyPath, "utf-8");
    return loadAssetLibraryHistoryJson(raw);
  } catch {
    return { entries: [] };
  }
}

function dedupeAssetLibraryHistoryEntries(entries: ReadonlyArray<AssetLibraryHistoryEntry>): AssetLibraryHistoryEntry[] {
  const map = new Map<string, AssetLibraryHistoryEntry>();
  for (const entry of entries) {
    const key = `${entry.bookId}:${entry.version}`;
    const existing = map.get(key);
    if (!existing || existing.savedAt <= entry.savedAt) {
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((left, right) => {
    if (left.bookId !== right.bookId) return left.bookId.localeCompare(right.bookId);
    if (left.version !== right.version) return left.version - right.version;
    return left.savedAt.localeCompare(right.savedAt);
  });
}

async function readAssetLibraryHistoryEntries(bookDir: string, bookId: string, currentLibrary?: AssetLibrary | null): Promise<AssetLibraryHistoryEntry[]> {
  const historyPath = assetLibraryHistoryPath(bookDir);
  const store = await readAssetLibraryHistoryStore(historyPath);
  const entries = store.entries.filter((entry) => entry.bookId === bookId);
  if (currentLibrary && entries.length === 0) {
    entries.push({
      bookId,
      version: 1,
      action: "current",
      savedAt: currentLibrary.updatedAt,
      library: normalizeAssetLibrary(currentLibrary),
    });
  }
  return dedupeAssetLibraryHistoryEntries(entries);
}

async function writeAssetLibraryWithHistory(
  bookDir: string,
  library: AssetLibrary,
  action: "save" | "generate" | "rollback" | "upload" = "save",
): Promise<{ library: AssetLibrary; version: number }> {
  const filePath = assetLibraryPath(bookDir);
  const historyPath = assetLibraryHistoryPath(bookDir);
  const now = new Date().toISOString();
  const normalized = normalizeAssetLibrary({
    ...library,
    updatedAt: now,
  });
  await mkdir(join(bookDir, "story", "state"), { recursive: true });
  const historyStore = await readAssetLibraryHistoryStore(historyPath);
  const existing = historyStore.entries.filter((entry) => entry.bookId === normalized.bookId);
  const version = existing.length > 0 ? Math.max(...existing.map((entry) => entry.version)) + 1 : 1;
  historyStore.entries.push({
    bookId: normalized.bookId,
    version,
    action,
    savedAt: now,
    library: normalized,
  });
  await writeFile(filePath, JSON.stringify(normalized, null, 2), "utf-8");
  await writeFile(historyPath, JSON.stringify({
    entries: dedupeAssetLibraryHistoryEntries(historyStore.entries),
    updatedAt: now,
  }, null, 2), "utf-8");
  return { library: normalized, version };
}

function summarizeAssetLibraryHistoryEntry(entry: AssetLibraryHistoryEntry): AssetLibraryHistoryEntry {
  return {
    ...entry,
    library: normalizeAssetLibrary(entry.library),
  };
}

function compareAssetLibraryVersions(from: AssetLibrary, to: AssetLibrary): AssetLibraryDiffResult {
  const changedFields = [
    "sourceProductionUpdatedAt",
    "items",
  ].filter((field) => JSON.stringify(from[field as keyof AssetLibrary]) !== JSON.stringify(to[field as keyof AssetLibrary]));
  return {
    fromVersion: 0,
    toVersion: 0,
    changedFields,
    from,
    to,
  };
}

function sanitizeAssetFileName(value: string): string {
  const cleaned = value.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, "_").trim();
  return cleaned || `asset-${Date.now()}`;
}

function decodeDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], "base64"),
    };
  } catch {
    return null;
  }
}

function assetLibraryPublicUrl(bookId: string, path: string): string {
  return `/api/v1/books/${encodeURIComponent(bookId)}/asset-library/file?path=${encodeURIComponent(path)}`;
}

async function persistAssetLibraryUpload(
  bookDir: string,
  bookId: string,
  payload: AssetLibraryUploadPayload,
  state: StateManager,
): Promise<Omit<AssetLibraryUploadResponse, "library">> {
  const decoded = decodeDataUrl(payload.dataUrl);
  if (!decoded) {
    throw new ApiError(400, "INVALID_UPLOAD", "Invalid dataUrl payload");
  }
  const library = await readAssetLibrary(bookDir, bookId, state);
  const item = library.items.find((entry) => entry.id === payload.itemId);
  if (!item) {
    throw new ApiError(404, "ASSET_NOT_FOUND", "Asset library item not found");
  }
  const safeName = sanitizeAssetFileName(payload.fileName);
  const prefix = payload.kind === "thumbnail" ? "thumb" : "source";
  const targetRelativePath = join("story", "assets", "asset-library", item.id, `${prefix}-${safeName}`).replace(/\\/g, "/");
  const targetAbsolutePath = resolve(bookDir, targetRelativePath);
  const bookRoot = resolve(bookDir);
  if (!targetAbsolutePath.startsWith(bookRoot)) {
    throw new ApiError(400, "INVALID_UPLOAD_PATH", "Resolved upload path escapes book directory");
  }
  await mkdir(dirname(targetAbsolutePath), { recursive: true });
  await writeFile(targetAbsolutePath, decoded.buffer);
  return {
    path: targetRelativePath,
    fileName: safeName,
    url: assetLibraryPublicUrl(bookId, targetRelativePath),
  };
}

function scriptWorkspaceHistoryPath(bookDir: string): string {
  return join(bookDir, "story", "state", SCRIPT_WORKSPACE_HISTORY_FILE);
}

function normalizeDirectorPlanHistoryVersion(raw: unknown): number {
  const version = Number(raw);
  if (!Number.isFinite(version) || version < 1) return 1;
  return Math.trunc(version);
}

function cloneDirectorPlanSnapshot(plan: unknown): DirectorPlan | null {
  if (!plan || typeof plan !== "object") return null;
  try {
    return normalizeDirectorPlan(structuredClone(plan) as Partial<DirectorPlan>);
  } catch {
    return normalizeDirectorPlan(plan as Partial<DirectorPlan>);
  }
}

function normalizeDirectorPlanHistoryEntry(raw: unknown): DirectorPlanHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Partial<DirectorPlanHistoryEntry> & { plan?: unknown };
  const plan = cloneDirectorPlanSnapshot(payload.plan);
  if (!plan) return null;
  const bookId = typeof payload.bookId === "string" && payload.bookId.trim()
    ? payload.bookId.trim()
    : plan.bookId;
  if (!bookId) return null;
  return {
    bookId,
    version: normalizeDirectorPlanHistoryVersion(payload.version),
    action: typeof payload.action === "string" && payload.action.trim() ? payload.action.trim() : "save",
    savedAt: typeof payload.savedAt === "string" && payload.savedAt.trim() ? payload.savedAt.trim() : new Date().toISOString(),
    plan: normalizeDirectorPlan({
      ...plan,
      bookId,
    }),
  };
}

interface DirectorPlanHistoryStore {
  readonly entries: DirectorPlanHistoryEntry[];
  readonly updatedAt?: string;
}

function loadDirectorPlanHistoryJson(raw: string): DirectorPlanHistoryStore {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return {
      entries: parsed
        .map((item) => normalizeDirectorPlanHistoryEntry(item))
        .filter((item): item is DirectorPlanHistoryEntry => item !== null),
    };
  }
  if (!parsed || typeof parsed !== "object") return { entries: [] };
  const payload = parsed as { entries?: unknown; updatedAt?: unknown };
  const entries = Array.isArray(payload.entries)
    ? payload.entries
      .map((item) => normalizeDirectorPlanHistoryEntry(item))
      .filter((item): item is DirectorPlanHistoryEntry => item !== null)
    : [];
  return {
    entries,
    ...(typeof payload.updatedAt === "string" && payload.updatedAt.trim() ? { updatedAt: payload.updatedAt.trim() } : {}),
  };
}

async function readDirectorPlanHistoryStore(historyPath: string): Promise<DirectorPlanHistoryStore> {
  try {
    const raw = await readFile(historyPath, "utf-8");
    return loadDirectorPlanHistoryJson(raw);
  } catch {
    return { entries: [] };
  }
}

function dedupeDirectorPlanHistoryEntries(entries: ReadonlyArray<DirectorPlanHistoryEntry>): DirectorPlanHistoryEntry[] {
  const map = new Map<string, DirectorPlanHistoryEntry>();
  for (const entry of entries) {
    const key = `${entry.bookId}:${entry.version}`;
    const existing = map.get(key);
    if (!existing || existing.savedAt <= entry.savedAt) {
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((left, right) => {
    if (left.bookId !== right.bookId) return left.bookId.localeCompare(right.bookId);
    if (left.version !== right.version) return left.version - right.version;
    return left.savedAt.localeCompare(right.savedAt);
  });
}

async function readDirectorPlanHistoryEntries(bookDir: string, bookId: string, currentPlan?: DirectorPlan | null): Promise<DirectorPlanHistoryEntry[]> {
  const historyPath = directorPlanHistoryPath(bookDir);
  const store = await readDirectorPlanHistoryStore(historyPath);
  const entries = store.entries.filter((entry) => entry.bookId === bookId);
  if (currentPlan && entries.length === 0) {
    entries.push({
      bookId,
      version: 1,
      action: "current",
      savedAt: currentPlan.updatedAt,
      plan: normalizeDirectorPlan(currentPlan),
    });
  }
  return dedupeDirectorPlanHistoryEntries(entries);
}

async function writeDirectorPlanWithHistory(
  bookDir: string,
  plan: DirectorPlan,
  action: "save" | "generate" | "rollback" = "save",
): Promise<{ plan: DirectorPlan; version: number }> {
  const filePath = directorPlanPath(bookDir);
  const historyPath = directorPlanHistoryPath(bookDir);
  const now = new Date().toISOString();
  const normalized = normalizeDirectorPlan({
    ...plan,
    updatedAt: now,
  });
  await mkdir(join(bookDir, "story", "state"), { recursive: true });
  const historyStore = await readDirectorPlanHistoryStore(historyPath);
  const existing = historyStore.entries.filter((entry) => entry.bookId === normalized.bookId);
  const version = existing.length > 0 ? Math.max(...existing.map((entry) => entry.version)) + 1 : 1;
  historyStore.entries.push({
    bookId: normalized.bookId,
    version,
    action,
    savedAt: now,
    plan: normalized,
  });
  await writeFile(filePath, JSON.stringify(normalized, null, 2), "utf-8");
  await writeFile(historyPath, JSON.stringify({
    entries: dedupeDirectorPlanHistoryEntries(historyStore.entries),
    updatedAt: now,
  }, null, 2), "utf-8");
  return { plan: normalized, version };
}

function summarizeDirectorPlanHistoryEntry(entry: DirectorPlanHistoryEntry): DirectorPlanHistoryEntry {
  return {
    ...entry,
    plan: normalizeDirectorPlan(entry.plan),
  };
}

function compareDirectorPlanVersions(from: DirectorPlan, to: DirectorPlan): DirectorPlanDiffResult {
  const changedFields = [
    "sourceProductionUpdatedAt",
    "sourceConfig",
    "visualStatement",
    "directorIntent",
    "visualRules",
    "cameraRules",
    "colorScript",
    "episodePlans",
  ].filter((field) => JSON.stringify(from[field as keyof DirectorPlan]) !== JSON.stringify(to[field as keyof DirectorPlan]));
  return {
    fromVersion: 0,
    toVersion: 0,
    changedFields,
    from,
    to,
  };
}

function normalizeScriptWorkspaceHistoryVersion(raw: unknown): number {
  const version = Number(raw);
  if (!Number.isFinite(version) || version < 1) return 1;
  return Math.trunc(version);
}

function cloneScriptWorkspaceSnapshot(workspace: unknown): ScriptWorkspace | null {
  if (!workspace || typeof workspace !== "object") return null;
  try {
    return normalizeScriptWorkspace(structuredClone(workspace) as Partial<ScriptWorkspace>);
  } catch {
    return normalizeScriptWorkspace(workspace as Partial<ScriptWorkspace>);
  }
}

function normalizeScriptWorkspaceHistoryEntry(raw: unknown): ScriptWorkspaceHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Partial<ScriptWorkspaceHistoryEntry> & { workspace?: unknown };
  const workspace = cloneScriptWorkspaceSnapshot(payload.workspace);
  if (!workspace) return null;
  const bookId = typeof payload.bookId === "string" && payload.bookId.trim()
    ? payload.bookId.trim()
    : workspace.bookId;
  if (!bookId) return null;
  return {
    bookId,
    version: normalizeScriptWorkspaceHistoryVersion(payload.version),
    action: typeof payload.action === "string" && payload.action.trim() ? payload.action.trim() : "save",
    savedAt: typeof payload.savedAt === "string" && payload.savedAt.trim() ? payload.savedAt.trim() : new Date().toISOString(),
    workspace: normalizeScriptWorkspace({
      ...workspace,
      bookId,
    }),
  };
}

function loadScriptWorkspaceHistoryJson(raw: string): ScriptWorkspaceHistoryStore {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return {
      entries: parsed
        .map((item) => normalizeScriptWorkspaceHistoryEntry(item))
        .filter((item): item is ScriptWorkspaceHistoryEntry => item !== null),
    };
  }
  if (!parsed || typeof parsed !== "object") return { entries: [] };
  const payload = parsed as { entries?: unknown; updatedAt?: unknown };
  const entries = Array.isArray(payload.entries)
    ? payload.entries
      .map((item) => normalizeScriptWorkspaceHistoryEntry(item))
      .filter((item): item is ScriptWorkspaceHistoryEntry => item !== null)
    : [];
  return {
    entries,
    ...(typeof payload.updatedAt === "string" && payload.updatedAt.trim() ? { updatedAt: payload.updatedAt.trim() } : {}),
  };
}

async function readScriptWorkspaceHistoryStore(historyPath: string): Promise<ScriptWorkspaceHistoryStore> {
  try {
    const raw = await readFile(historyPath, "utf-8");
    return loadScriptWorkspaceHistoryJson(raw);
  } catch {
    return { entries: [] };
  }
}

function dedupeScriptWorkspaceHistoryEntries(entries: ReadonlyArray<ScriptWorkspaceHistoryEntry>): ScriptWorkspaceHistoryEntry[] {
  const map = new Map<string, ScriptWorkspaceHistoryEntry>();
  for (const entry of entries) {
    const key = `${entry.bookId}:${entry.version}`;
    const existing = map.get(key);
    if (!existing || existing.savedAt <= entry.savedAt) {
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((left, right) => {
    if (left.bookId !== right.bookId) return left.bookId.localeCompare(right.bookId);
    if (left.version !== right.version) return left.version - right.version;
    return left.savedAt.localeCompare(right.savedAt);
  });
}

async function readScriptWorkspaceHistoryEntries(bookDir: string, bookId: string, currentWorkspace?: ScriptWorkspace | null): Promise<ScriptWorkspaceHistoryEntry[]> {
  const historyPath = scriptWorkspaceHistoryPath(bookDir);
  const store = await readScriptWorkspaceHistoryStore(historyPath);
  const entries = store.entries.filter((entry) => entry.bookId === bookId);
  if (currentWorkspace && entries.length === 0) {
    entries.push({
      bookId,
      version: 1,
      action: "current",
      savedAt: currentWorkspace.updatedAt,
      workspace: normalizeScriptWorkspace(currentWorkspace),
    });
  }
  return dedupeScriptWorkspaceHistoryEntries(entries);
}

async function writeScriptWorkspace(
  bookDir: string,
  workspace: ScriptWorkspace,
  action: "save" | "generate" | "rollback" = "save",
): Promise<{ workspace: ScriptWorkspace; version: number }> {
  const workspacePath = join(bookDir, "story", "state", "script-workspace.json");
  const historyPath = scriptWorkspaceHistoryPath(bookDir);
  const now = new Date().toISOString();
  const normalizedWorkspace = normalizeScriptWorkspace({
    ...workspace,
    updatedAt: now,
  });
  await mkdir(join(bookDir, "story", "state"), { recursive: true });
  const historyStore = await readScriptWorkspaceHistoryStore(historyPath);
  const existing = historyStore.entries.filter((entry) => entry.bookId === normalizedWorkspace.bookId);
  const version = existing.length > 0 ? Math.max(...existing.map((entry) => entry.version)) + 1 : 1;
  historyStore.entries.push({
    bookId: normalizedWorkspace.bookId,
    version,
    action,
    savedAt: now,
    workspace: normalizedWorkspace,
  });
  await writeFile(workspacePath, JSON.stringify(normalizedWorkspace, null, 2), "utf-8");
  await writeFile(historyPath, JSON.stringify({
    entries: dedupeScriptWorkspaceHistoryEntries(historyStore.entries),
    updatedAt: now,
  }, null, 2), "utf-8");
  return { workspace: normalizedWorkspace, version };
}

function summarizeScriptWorkspaceHistoryEntry(entry: ScriptWorkspaceHistoryEntry): ScriptWorkspaceHistoryEntry {
  return {
    ...entry,
    workspace: normalizeScriptWorkspace(entry.workspace),
  };
}

function compareScriptWorkspaceVersions(from: ScriptWorkspace, to: ScriptWorkspace): ScriptWorkspaceDiffResult {
  const changedFields = [
    "selectedChapterNumbers",
    "config",
    "scriptPrompt",
    "extraction",
    "episodes",
  ].filter((field) => JSON.stringify(from[field as keyof ScriptWorkspace]) !== JSON.stringify(to[field as keyof ScriptWorkspace]));
  return {
    fromVersion: 0,
    toVersion: 0,
    changedFields,
    from,
    to,
  };
}

function inferChapterNumberFromText(message: string): number | undefined {
  const zhMatch = message.match(/第\s*(\d+)\s*章/i);
  if (zhMatch?.[1]) {
    const value = Number(zhMatch[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const zhSectionMatch = message.match(/章节\s*(\d+)/i);
  if (zhSectionMatch?.[1]) {
    const value = Number(zhSectionMatch[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const enMatch = message.match(/\bchapter\s*(\d+)\b/i);
  if (enMatch?.[1]) {
    const value = Number(enMatch[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function normalizeMarkdownForWrite(content: string): string {
  return content.trimEnd() + "\n";
}

async function readWizardStepMarkdown(bookDir: string, step: BookCreationWizardStep): Promise<string> {
  const wizardDir = join(bookDir, "wizard");
  const candidates = [
    WIZARD_STEP_FILE_NAMES[step],
    LEGACY_WIZARD_STEP_FILE_NAMES[step],
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const fileName of candidates) {
    const content = await readFile(join(wizardDir, fileName), "utf-8").catch(() => "");
    if (content.trim()) {
      return normalizeMarkdownForWrite(content);
    }
  }
  return "";
}

async function writeStoryArtifactCopies(paths: ReadonlyArray<string>, content: string): Promise<void> {
  if (!content.trim()) return;
  const normalized = normalizeMarkdownForWrite(content);
  await Promise.all(paths.map(async (targetPath) => {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, normalized, "utf-8");
  }));
}

async function syncWizardArtifactsToStory(bookDir: string): Promise<void> {
  const syncPlan: ReadonlyArray<{
    readonly step: BookCreationWizardStep;
    readonly targets: ReadonlyArray<string>;
  }> = [
    {
      step: "intro",
      targets: [
        join(bookDir, "story", "foundation_brief.md"),
      ],
    },
    {
      step: "world",
      targets: [
        join(bookDir, "story", "outline", "story_frame.md"),
        join(bookDir, "story", "story_bible.md"),
      ],
    },
    {
      step: "outline",
      targets: [
        join(bookDir, "story", "novel_outline.md"),
      ],
    },
    {
      step: "volume",
      targets: [
        join(bookDir, "story", "outline", "volume_map.md"),
        join(bookDir, "story", "volume_outline.md"),
      ],
    },
    {
      step: "characters",
      targets: [
        join(bookDir, "story", "character_matrix.md"),
      ],
    },
    {
      step: "arc",
      targets: [
        join(bookDir, "story", "character_arc.md"),
      ],
    },
    {
      step: "relation",
      targets: [
        join(bookDir, "story", "relationship_map.md"),
      ],
    },
  ];

  for (const entry of syncPlan) {
    const content = await readWizardStepMarkdown(bookDir, entry.step);
    if (!content.trim()) continue;
    await writeStoryArtifactCopies(entry.targets, content);
  }
}

function resolveTruthFileReadPath(bookDir: string, file: string): string {
  const storagePath = resolveArtifactStoragePath(file);
  return storagePath.startsWith("story/")
    ? join(bookDir, storagePath)
    : join(bookDir, "story", storagePath);
}

function resolveTruthFileResponseName(file: string): string {
  return normalizeArtifactFile(file);
}

function hasLogContextPrefix(message: string): boolean {
  return /^\[run:[^\]]+\]/i.test(message);
}

function withLogContext(args: {
  readonly message: string;
  readonly runId?: string;
  readonly bookId?: string;
  readonly chapterNumber?: number;
}): { message: string; chapterNumber?: number } {
  const raw = args.message.trim();
  if (!raw) return { message: args.message };
  if (hasLogContextPrefix(raw)) {
    const chapterNumber = inferChapterNumberFromText(raw);
    return Number.isFinite(chapterNumber) && (chapterNumber ?? 0) > 0
      ? { message: raw, chapterNumber }
      : { message: raw };
  }
  const chapterNumber = Number.isFinite(args.chapterNumber)
    ? Number(args.chapterNumber)
    : inferChapterNumberFromText(raw);
  const context = [
    args.bookId ? `[book:${args.bookId}]` : null,
    args.runId ? `[run:${args.runId}]` : null,
    Number.isFinite(chapterNumber) && (chapterNumber ?? 0) > 0 ? `[chapter:${chapterNumber}]` : null,
  ].filter(Boolean).join("");
  return {
    message: context ? `${context} ${raw}` : raw,
    ...(Number.isFinite(chapterNumber) && (chapterNumber ?? 0) > 0 ? { chapterNumber } : {}),
  };
}

function extractToolUpdateText(partialResult: unknown): string | null {
  if (typeof partialResult === "string") {
    const text = partialResult.trim();
    return text.length > 0 ? text : null;
  }
  if (!partialResult || typeof partialResult !== "object") return null;
  const payload = partialResult as { text?: unknown; content?: unknown };
  if (typeof payload.text === "string") {
    const text = payload.text.trim();
    if (text) return text;
  }
  if (typeof payload.content === "string") {
    const text = payload.content.trim();
    if (text) return text;
  }
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => String(item.text).trim())
      .filter(Boolean)
      .join("\n");
    return text || null;
  }
  return null;
}

interface TokenUsageSnapshot {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

function zeroTokenUsage(): TokenUsageSnapshot {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function normalizeTokenUsage(value: unknown): TokenUsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as {
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
    input?: unknown;
    output?: unknown;
  };
  const promptTokens = Number(usage.promptTokens ?? usage.input);
  const completionTokens = Number(usage.completionTokens ?? usage.output);
  const totalTokensRaw = Number(usage.totalTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return null;
  }
  const totalTokens = Number.isFinite(totalTokensRaw) ? totalTokensRaw : promptTokens + completionTokens;
  return {
    promptTokens: Math.max(0, Math.trunc(promptTokens)),
    completionTokens: Math.max(0, Math.trunc(completionTokens)),
    totalTokens: Math.max(0, Math.trunc(totalTokens)),
  };
}

function addTokenUsage(left: TokenUsageSnapshot, right?: TokenUsageSnapshot | null): TokenUsageSnapshot {
  if (!right) return { ...left };
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

type AuditSeverity = "critical" | "warning" | "info";
type ReviewEntry = "write-next" | "write-target" | "rewrite";

interface NormalizedAuditIssue {
  readonly severity: AuditSeverity;
  readonly text: string;
}

interface ChapterPlanHistoryEntry {
  readonly chapterNumber: number;
  readonly version: number;
  readonly action: string;
  readonly savedAt: string;
  readonly plan: Record<string, unknown>;
}

interface ChapterPlanHistoryStore {
  readonly entries: ChapterPlanHistoryEntry[];
  readonly updatedAt?: string;
}

interface ScriptWorkspaceHistoryStore {
  readonly entries: ScriptWorkspaceHistoryEntry[];
  readonly updatedAt?: string;
}

function normalizeAuditSeverity(raw: unknown): AuditSeverity {
  if (typeof raw !== "string") return "info";
  const value = raw.trim().toLowerCase();
  if (value === "critical" || value === "error" || value === "严重" || value === "高危") return "critical";
  if (value === "warning" || value === "warn" || value === "警告" || value === "中危") return "warning";
  return "info";
}

function auditSeverityRank(severity: AuditSeverity): number {
  if (severity === "critical") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function parseAuditIssueText(raw: string): NormalizedAuditIssue | null {
  const line = raw.trim();
  if (!line) return null;
  const match = line.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!match?.[1] || !match[2]) {
    return { severity: "info", text: line };
  }
  const severity = normalizeAuditSeverity(match[1]);
  const text = match[2].trim();
  if (!text) return null;
  return { severity, text };
}

function normalizeAuditIssue(issue: unknown): NormalizedAuditIssue | null {
  if (!issue || typeof issue !== "object") return null;
  const payload = issue as {
    severity?: unknown;
    category?: unknown;
    description?: unknown;
  };
  const severity = normalizeAuditSeverity(payload.severity);
  const category = typeof payload.category === "string" && payload.category.trim()
    ? payload.category.trim()
    : "";
  const description = typeof payload.description === "string" && payload.description.trim()
    ? payload.description.trim()
    : "";
  if (!description) return null;
  return {
    severity,
    text: category ? `${category}: ${description}` : description,
  };
}

function formatAuditIssueText(issue: NormalizedAuditIssue): string {
  return `[${issue.severity}] ${issue.text}`;
}

function buildAuditIssueTexts(issues: unknown, limit = 24): string[] {
  if (!Array.isArray(issues)) return [];
  const normalized = issues
    .map((issue) => normalizeAuditIssue(issue))
    .filter((issue): issue is NormalizedAuditIssue => Boolean(issue))
    .sort((left, right) => auditSeverityRank(left.severity) - auditSeverityRank(right.severity));
  return normalized.slice(0, limit).map((issue) => formatAuditIssueText(issue));
}

function countAuditIssueSeverities(issueTexts: ReadonlyArray<string>): AuditSeverityCounts {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const item of issueTexts) {
    const parsed = parseAuditIssueText(item);
    if (!parsed) continue;
    if (parsed.severity === "critical") critical += 1;
    else if (parsed.severity === "warning") warning += 1;
    else info += 1;
  }
  return { critical, warning, info };
}

function countAuditIssueSeveritiesFromIssues(issues: unknown): AuditSeverityCounts {
  if (!Array.isArray(issues)) return { critical: 0, warning: 0, info: 0 };
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const issue of issues) {
    const normalized = normalizeAuditIssue(issue);
    if (!normalized) continue;
    if (normalized.severity === "critical") critical += 1;
    else if (normalized.severity === "warning") warning += 1;
    else info += 1;
  }
  return { critical, warning, info };
}

function describeAuditFailureGate(gate: AuditFailureGate): string | null {
  if (gate === "score") {
    return `失败原因：score gate 未通过（阈值 ${AUDIT_PASS_SCORE_THRESHOLD}/100）。`;
  }
  if (gate === "critical") {
    return "失败原因：critical 问题门禁未通过。";
  }
  return null;
}

function resolveDisplayFailureGate(args: {
  readonly passed: boolean;
  readonly score: number;
  readonly severityCounts: AuditSeverityCounts;
}): AuditFailureGate {
  if (args.passed) return "none";
  if (args.severityCounts.critical > 0) return "critical";
  if (args.score < AUDIT_PASS_SCORE_THRESHOLD) return "score";
  return "critical";
}

function resolveWriterReviewEntry(targetChapterNumber: number | null): ReviewEntry {
  return targetChapterNumber === null ? "write-next" : "write-target";
}

interface IssueClassCounts {
  structural: number;
  textual: number;
}

interface ReviewMetricsCounter {
  total: number;
  firstPass: number;
  passWithinOneRevise: number;
  failedMaxRounds: number;
  structuralIssues: number;
  textualIssues: number;
}

interface ReviewMetricsSnapshot {
  fpr0: number;
  fpr1: number;
  failed_max_rounds_rate: number;
  structural_ratio: number;
  sample_size: number;
}

interface ReviewMetricsBookStore {
  overall: ReviewMetricsCounter;
  byEntry: Record<ReviewEntry, ReviewMetricsCounter>;
}

const STRUCTURAL_ISSUE_HINTS = [
  "结构", "卷纲", "主线", "支线", "伏笔", "回收", "世界观", "设定",
  "连续性", "一致性", "时间线", "时间轴", "账本", "数值", "境界",
  "状态", "角色关系", "人物关系", "前后矛盾", "上下文矛盾",
];

function createReviewMetricsCounter(): ReviewMetricsCounter {
  return {
    total: 0,
    firstPass: 0,
    passWithinOneRevise: 0,
    failedMaxRounds: 0,
    structuralIssues: 0,
    textualIssues: 0,
  };
}

function createReviewMetricsBookStore(): ReviewMetricsBookStore {
  return {
    overall: createReviewMetricsCounter(),
    byEntry: {
      "write-next": createReviewMetricsCounter(),
      "write-target": createReviewMetricsCounter(),
      rewrite: createReviewMetricsCounter(),
    },
  };
}

function safePercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((Math.max(0, numerator) / denominator) * 100);
}

function classifyIssueTextForMetrics(issueText: string): "structural" | "textual" {
  const normalized = issueText.trim().toLowerCase();
  if (!normalized) return "textual";
  if (STRUCTURAL_ISSUE_HINTS.some((hint) => normalized.includes(hint.toLowerCase()))) {
    return "structural";
  }
  return "textual";
}

function deriveIssueClassCountsFromIssueTexts(issueTexts: ReadonlyArray<string>): IssueClassCounts {
  let structural = 0;
  let textual = 0;
  for (const raw of issueTexts) {
    const issueText = typeof raw === "string" ? raw.trim() : "";
    if (!issueText) continue;
    if (classifyIssueTextForMetrics(issueText) === "structural") structural += 1;
    else textual += 1;
  }
  return { structural, textual };
}

function normalizeIssueClassCounts(issueClassCounts?: Readonly<{ structural: number; textual: number }>): IssueClassCounts | null {
  if (!issueClassCounts) return null;
  const structural = Number(issueClassCounts.structural);
  const textual = Number(issueClassCounts.textual);
  if (!Number.isFinite(structural) || !Number.isFinite(textual)) return null;
  return {
    structural: Math.max(0, Math.trunc(structural)),
    textual: Math.max(0, Math.trunc(textual)),
  };
}

function applyReviewMetricsObservation(counter: ReviewMetricsCounter, args: {
  passed: boolean;
  reviseRoundsUsed: number;
  finalState: "passed" | "failed-max-rounds" | "failed-single-audit";
  issueClassCounts?: Readonly<{ structural: number; textual: number }>;
  issueTexts?: ReadonlyArray<string>;
}): void {
  counter.total += 1;
  if (args.passed && args.reviseRoundsUsed === 0) counter.firstPass += 1;
  if (args.passed && args.reviseRoundsUsed <= 1) counter.passWithinOneRevise += 1;
  if (args.finalState === "failed-max-rounds") counter.failedMaxRounds += 1;
  const classCounts = normalizeIssueClassCounts(args.issueClassCounts)
    ?? deriveIssueClassCountsFromIssueTexts(args.issueTexts ?? []);
  counter.structuralIssues += classCounts.structural;
  counter.textualIssues += classCounts.textual;
}

function reviewMetricsSnapshotFromCounter(counter: ReviewMetricsCounter): ReviewMetricsSnapshot {
  const structuralTotal = counter.structuralIssues + counter.textualIssues;
  return {
    fpr0: safePercent(counter.firstPass, counter.total),
    fpr1: safePercent(counter.passWithinOneRevise, counter.total),
    failed_max_rounds_rate: safePercent(counter.failedMaxRounds, counter.total),
    structural_ratio: safePercent(counter.structuralIssues, structuralTotal),
    sample_size: counter.total,
  };
}

function buildAuditReportText(args: {
  readonly chapterNumber: number;
  readonly passed: boolean;
  readonly issueCount: number;
  readonly summary?: string;
  readonly issueTexts?: ReadonlyArray<string>;
  readonly severityCounts?: AuditSeverityCounts;
  readonly failureGate?: AuditFailureGate;
}): string {
  const issueTexts = (args.issueTexts ?? [])
    .map((item) => parseAuditIssueText(item ?? ""))
    .filter((item): item is NormalizedAuditIssue => Boolean(item))
    .sort((left, right) => auditSeverityRank(left.severity) - auditSeverityRank(right.severity))
    .map((item) => formatAuditIssueText(item));
  const issueCount = args.issueCount > 0 ? args.issueCount : issueTexts.length;
  const severityCounts = args.severityCounts ?? countAuditIssueSeverities(issueTexts);
  const score = estimateAuditScoreFromSeverityCounts(severityCounts);
  const header = args.passed
    ? issueCount > 0
      ? `第${args.chapterNumber}章审计通过，发现${issueCount}项非阻断问题。`
      : `第${args.chapterNumber}章审计通过。`
    : `第${args.chapterNumber}章审计未通过，共${issueCount}项问题。`;
  const lines = [header];
  lines.push(`审计评分：${score}/100（严重 ${severityCounts.critical} / 警告 ${severityCounts.warning} / 提示 ${severityCounts.info}）`);
  if (!args.passed) {
    const gateLine = describeAuditFailureGate(args.failureGate ?? "none");
    if (gateLine) lines.push(gateLine);
  }
  const summary = args.summary?.trim();
  if (summary) {
    lines.push(`审计报告：${summary}`);
  }
  lines.push(...buildAuditIssueListLines(issueTexts));
  return lines.join("\n");
}

function buildAuditIssueListLines(issueTexts: ReadonlyArray<string>): string[] {
  if (issueTexts.length === 0) return [];
  const grouped: Record<AuditSeverity, string[]> = { critical: [], warning: [], info: [] };
  issueTexts.forEach((item) => {
    const parsed = parseAuditIssueText(item);
    if (!parsed) return;
    grouped[parsed.severity].push(formatAuditIssueText(parsed));
  });
  const lines: string[] = ["问题清单："];
  if (grouped.critical.length > 0) {
    lines.push("严重：");
    grouped.critical.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  if (grouped.warning.length > 0) {
    lines.push("警告：");
    grouped.warning.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  if (grouped.info.length > 0) {
    lines.push("提示：");
    grouped.info.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  return lines;
}

function normalizeDimensionChecks(value: unknown): ReadonlyArray<{
  dimension: string;
  status: "pass" | "warning" | "failed";
  evidence?: string;
}> {
  type AuditDimensionCheck = {
    dimension: string;
    status: "pass" | "warning" | "failed";
    evidence?: string;
  };
  if (!Array.isArray(value)) return [];
  const normalized: AuditDimensionCheck[] = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as { dimension?: unknown; status?: unknown; evidence?: unknown };
      const dimension = typeof payload.dimension === "string" ? payload.dimension.trim() : "";
      if (!dimension) return null;
      const status = payload.status === "pass" || payload.status === "warning" || payload.status === "failed"
        ? payload.status
        : null;
      if (!status) return null;
      const evidence = typeof payload.evidence === "string" && payload.evidence.trim()
        ? payload.evidence.trim()
        : undefined;
      return {
        dimension,
        status,
        ...(evidence ? { evidence } : {}),
      };
    })
    .filter((item): item is AuditDimensionCheck => item !== null);
  return normalized;
}

function normalizePrimaryIssueClass(value: unknown): "none" | "structural" | "textual" | "mixed" | undefined {
  return value === "none" || value === "structural" || value === "textual" || value === "mixed"
    ? value
    : undefined;
}

function derivePrimaryIssueClassFromCounts(counts: Readonly<{ structural: number; textual: number }>): "none" | "structural" | "textual" | "mixed" {
  if (counts.structural <= 0 && counts.textual <= 0) return "none";
  if (counts.structural > 0 && counts.textual <= 0) return "structural";
  if (counts.structural <= 0 && counts.textual > 0) return "textual";
  return "mixed";
}

interface NormalizedReviseAuditSummary {
  readonly passed: boolean;
  readonly score: number;
  readonly issueCount: number;
  readonly severityCounts: AuditSeverityCounts;
  readonly failureGate: AuditFailureGate;
  readonly dimensionChecks?: ReadonlyArray<{
    dimension: string;
    status: "pass" | "warning" | "failed";
    evidence?: string;
  }>;
  readonly issueClassCounts?: Readonly<{
    structural: number;
    textual: number;
  }>;
  readonly primaryIssueClass?: "none" | "structural" | "textual" | "mixed";
  readonly summary?: string;
  readonly issueTexts: ReadonlyArray<string>;
  readonly report: string;
}

type PipelineAuditDraftResult = Awaited<ReturnType<PipelineRunner["auditDraft"]>>;
type PipelineReviseDraftResult = Awaited<ReturnType<PipelineRunner["reviseDraft"]>>;

const AUTO_REVISE_MAX_ROUNDS = 3;
const AUTO_REVISE_MODE = "spot-fix" as const;
const AUTO_REVISE_MODES = ["polish", "rewrite", "rework", "spot-fix", "anti-detect"] as const;
type AutoReviseMode = typeof AUTO_REVISE_MODES[number];
const STRUCTURAL_STAGNATION_MIN_UNRESOLVED = 2;
const STRUCTURAL_STAGNATION_SCORE_DELTA_THRESHOLD = 1;

function parseBooleanLike(input: unknown): boolean | null {
  if (typeof input === "boolean") return input;
  if (typeof input !== "string") return null;
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function resolveUnifiedReviewLoopEnabled(config: ProjectConfig): boolean {
  const envOverride = parseBooleanLike(process.env.INKOS_UNIFIED_REVIEW_LOOP);
  if (envOverride !== null) return envOverride;
  const raw = config as unknown as {
    unifiedReviewLoop?: unknown;
    autoReview?: { unifiedReviewLoop?: unknown } | unknown;
  };
  const topLevel = parseBooleanLike(raw.unifiedReviewLoop);
  if (topLevel !== null) return topLevel;
  if (raw.autoReview && typeof raw.autoReview === "object") {
    const nested = parseBooleanLike((raw.autoReview as { unifiedReviewLoop?: unknown }).unifiedReviewLoop);
    if (nested !== null) return nested;
  }
  return true;
}

function resolveAutoReviewPolicy(config: ProjectConfig): {
  enabled: boolean;
  maxReviseRounds: number;
  reviseMode: AutoReviseMode;
  stagnation: {
    minUnresolvedStructuralIssues: number;
    scoreDeltaThreshold: number;
  };
} {
  if (!resolveUnifiedReviewLoopEnabled(config)) {
    return {
      enabled: false,
      maxReviseRounds: 0,
      reviseMode: AUTO_REVISE_MODE,
      stagnation: {
        minUnresolvedStructuralIssues: STRUCTURAL_STAGNATION_MIN_UNRESOLVED,
        scoreDeltaThreshold: STRUCTURAL_STAGNATION_SCORE_DELTA_THRESHOLD,
      },
    };
  }
  const raw = (config as unknown as { autoReview?: unknown }).autoReview;
  if (!raw || typeof raw !== "object") {
    return {
      enabled: true,
      maxReviseRounds: AUTO_REVISE_MAX_ROUNDS,
      reviseMode: AUTO_REVISE_MODE,
      stagnation: {
        minUnresolvedStructuralIssues: STRUCTURAL_STAGNATION_MIN_UNRESOLVED,
        scoreDeltaThreshold: STRUCTURAL_STAGNATION_SCORE_DELTA_THRESHOLD,
      },
    };
  }
  const payload = raw as {
    enabled?: unknown;
    maxReviseRounds?: unknown;
    reviseMode?: unknown;
    stagnation?: {
      minUnresolvedStructuralIssues?: unknown;
      scoreDeltaThreshold?: unknown;
    } | unknown;
  };
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : true;
  const parsedRounds = Number(payload.maxReviseRounds);
  const maxReviseRounds = Number.isFinite(parsedRounds)
    ? Math.max(0, Math.min(5, Math.trunc(parsedRounds)))
    : AUTO_REVISE_MAX_ROUNDS;
  const reviseMode = AUTO_REVISE_MODES.includes(payload.reviseMode as AutoReviseMode)
    ? payload.reviseMode as AutoReviseMode
    : AUTO_REVISE_MODE;
  const stagnationRaw = payload.stagnation && typeof payload.stagnation === "object"
    ? payload.stagnation as { minUnresolvedStructuralIssues?: unknown; scoreDeltaThreshold?: unknown }
    : {};
  const minUnresolvedParsed = Number(stagnationRaw.minUnresolvedStructuralIssues);
  const scoreDeltaThresholdParsed = Number(stagnationRaw.scoreDeltaThreshold);
  const stagnation = {
    minUnresolvedStructuralIssues: Number.isFinite(minUnresolvedParsed)
      ? Math.max(1, Math.min(10, Math.trunc(minUnresolvedParsed)))
      : STRUCTURAL_STAGNATION_MIN_UNRESOLVED,
    scoreDeltaThreshold: Number.isFinite(scoreDeltaThresholdParsed)
      ? Math.max(0, Math.min(10, Math.trunc(scoreDeltaThresholdParsed)))
      : STRUCTURAL_STAGNATION_SCORE_DELTA_THRESHOLD,
  };
  return { enabled, maxReviseRounds, reviseMode, stagnation };
}

interface NormalizedAuditDraftSummary extends NormalizedReviseAuditSummary {
  readonly chapterNumber: number;
  readonly tokenUsage?: TokenUsageSnapshot;
  readonly raw: PipelineAuditDraftResult;
}

const AUTO_REVIEW_FINAL_NOTE_PREFIX = "[auto-review-final]";

function buildAutoReviewFinalNote(args: {
  finalState: "failed-max-rounds" | "failed-single-audit";
  stopReason?: string;
  audit: Pick<NormalizedAuditDraftSummary, "score" | "issueCount" | "summary">;
}): string {
  const summaryText = typeof args.audit.summary === "string" ? args.audit.summary.trim() : "";
  const summarySegment = summaryText
    ? `；摘要：${summaryText.slice(0, 180)}`
    : "";
  const reasonText = args.stopReason?.trim()
    || (args.finalState === "failed-max-rounds"
      ? "达到自动修订轮次上限，仍未通过审计"
      : "单次审计未通过");
  return `${AUTO_REVIEW_FINAL_NOTE_PREFIX} 自动审计未通过（${reasonText}）；评分 ${args.audit.score}/100；问题 ${args.audit.issueCount} 项${summarySegment}`;
}

function stripAutoReviewFinalNote(reviewNote: string): string {
  return reviewNote
    .split(/\r?\n/u)
    .filter((line) => !line.trim().startsWith(AUTO_REVIEW_FINAL_NOTE_PREFIX))
    .join("\n")
    .trim();
}

async function persistAutoReviewTerminalNote(args: {
  state: StateManager;
  bookId: string;
  chapterNumber: number;
  finalState: "passed" | "failed-max-rounds" | "failed-single-audit";
  stopReason?: string;
  finalAudit: NormalizedAuditDraftSummary;
}): Promise<void> {
  const indexRaw = await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]);
  const index = normalizeChapterIndexEntries(indexRaw);
  if (index.length === 0) return;
  const nowIso = new Date().toISOString();
  let changed = false;
  const updated = index.map((entry) => {
    const chapterNumber = Number(entry?.number);
    if (!Number.isFinite(chapterNumber) || chapterNumber !== args.chapterNumber) return entry;
    const currentRaw = typeof entry.reviewNote === "string" ? entry.reviewNote : "";
    const current = currentRaw.trim();
    const stripped = stripAutoReviewFinalNote(current);
    const nextNote = args.finalState === "passed"
      ? stripped
      : (() => {
          const autoNote = buildAutoReviewFinalNote({
            finalState: args.finalState,
            stopReason: args.stopReason,
            audit: args.finalAudit,
          });
          return stripped.length > 0 ? `${stripped}\n${autoNote}` : autoNote;
        })();
    if (nextNote === current) return entry;
    changed = true;
    return {
      ...entry,
      ...(nextNote.length > 0 ? { reviewNote: nextNote } : { reviewNote: undefined }),
      updatedAt: nowIso,
    };
  });
  if (changed) {
    await args.state.saveChapterIndex(args.bookId, updated as any);
  }
}

interface AutoAuditCycleResult {
  readonly chapterNumber: number;
  readonly audits: ReadonlyArray<NormalizedAuditDraftSummary>;
  readonly revisions: ReadonlyArray<{
    readonly round: number;
    readonly mode: AutoReviseMode;
    readonly reviseResult: PipelineReviseDraftResult;
    readonly reviseAudit: NormalizedReviseAuditSummary | null;
    readonly basisIssueTexts: ReadonlyArray<string>;
    readonly fixedIssues: ReadonlyArray<string>;
    readonly issueResolutions: ReadonlyArray<{
      readonly issueId: string;
      readonly issue: string;
      readonly outcome: "resolved" | "unresolved";
      readonly fixDelta?: string;
    }>;
    readonly mustFixOutcomes: ReadonlyArray<{
      readonly issueId: string;
      readonly outcome: "resolved" | "partial" | "unresolved";
      readonly reason?: string;
    }>;
  }>;
  readonly finalAudit: NormalizedAuditDraftSummary;
  readonly stoppedByMaxRounds: boolean;
  readonly maxReviseRounds: number;
  readonly stopReason?: string;
}

interface UnifiedReviewLoopAutoReviewPayload {
  readonly enabled: boolean;
  readonly maxReviseRounds: number;
  readonly reviseRoundsUsed: number;
  readonly auditRounds: number;
  readonly stoppedByMaxRounds: boolean;
  readonly finalState: "passed" | "failed-max-rounds" | "failed-single-audit";
  readonly stopReason?: string;
  readonly revisions: ReadonlyArray<{
    readonly round: number;
    readonly applied: boolean;
    readonly status: string;
    readonly wordCount: number;
    readonly fixedIssues: ReadonlyArray<string>;
    readonly issueResolutions: ReadonlyArray<{
      readonly issueId: string;
      readonly issue: string;
      readonly outcome: "resolved" | "unresolved";
      readonly fixDelta?: string;
    }>;
    readonly mustFixOutcomes: ReadonlyArray<{
      readonly issueId: string;
      readonly outcome: "resolved" | "partial" | "unresolved";
      readonly reason?: string;
    }>;
  }>;
}

interface UnifiedReviewLoopResult {
  readonly finalAudit: NormalizedAuditDraftSummary;
  readonly autoReview: UnifiedReviewLoopAutoReviewPayload;
}

function resolveUnifiedReviewFinalState(cycle: AutoAuditCycleResult): "passed" | "failed-max-rounds" | "failed-single-audit" {
  if (cycle.finalAudit.passed) return "passed";
  return cycle.stoppedByMaxRounds ? "failed-max-rounds" : "failed-single-audit";
}

function buildUnifiedAutoReviewPayload(args: {
  enabled: boolean;
  maxReviseRounds: number;
  cycle: AutoAuditCycleResult;
}): UnifiedReviewLoopAutoReviewPayload {
  const finalState = resolveUnifiedReviewFinalState(args.cycle);
  return {
    enabled: args.enabled,
    maxReviseRounds: args.cycle.maxReviseRounds ?? args.maxReviseRounds,
    reviseRoundsUsed: args.cycle.revisions.length,
    auditRounds: args.cycle.audits.length,
    stoppedByMaxRounds: args.cycle.stoppedByMaxRounds,
    finalState,
    ...(args.cycle.stoppedByMaxRounds && !args.cycle.finalAudit.passed
      ? { stopReason: args.cycle.stopReason?.trim() || "达到自动修订轮次上限，仍未通过审计" }
      : {}),
    revisions: args.cycle.revisions.map((entry) => ({
      round: entry.round,
      applied: entry.reviseResult.applied,
      status: entry.reviseResult.status,
      wordCount: entry.reviseResult.wordCount,
      fixedIssues: entry.fixedIssues,
      issueResolutions: entry.issueResolutions,
      mustFixOutcomes: entry.mustFixOutcomes,
    })),
  };
}

const STRUCTURAL_AUDIT_SIGNALS = [
  "volume_outline",
  "卷纲",
  "大纲偏离",
  "hook debt",
  "伏笔债务",
  "paragraph-shape",
  "读者期待管理",
  "资源账本",
  "ledger",
  "状态卡",
  "评分门禁",
  "score gate",
];

function hasStructuralAuditTextSignals(audit: Pick<NormalizedAuditDraftSummary, "issueTexts">): boolean {
  if (audit.issueTexts.length === 0) return false;
  const merged = audit.issueTexts.join("\n").toLowerCase();
  return STRUCTURAL_AUDIT_SIGNALS.some((signal) => merged.includes(signal));
}

function isLengthOnlyIssueTexts(issueTexts: ReadonlyArray<string>): boolean {
  if (issueTexts.length === 0) return false;
  return issueTexts.every((text) => {
    const lower = text.toLowerCase();
    return lower.includes("篇幅控制") || lower.includes("length control");
  });
}

function resolveAdaptiveMaxReviseRounds(
  configuredMaxRounds: number,
  audit: Pick<NormalizedAuditDraftSummary, "severityCounts" | "issueTexts">,
): number {
  if (configuredMaxRounds <= 0) return 0;
  let resolved = configuredMaxRounds;
  if (audit.severityCounts.warning >= 4 || hasStructuralAuditTextSignals(audit)) {
    resolved = Math.max(resolved, 4);
  }
  if (audit.severityCounts.critical >= 2) {
    resolved = Math.max(resolved, 5);
  }
  return Math.max(0, Math.min(5, resolved));
}

function resolveAdaptiveReviseMode(
  configuredMode: AutoReviseMode,
  audit: Pick<NormalizedAuditDraftSummary, "issueTexts">,
  reviseRound: number,
  options?: {
    forceRework?: boolean;
    forceRewrite?: boolean;
  },
): AutoReviseMode {
  if (options?.forceRework) return "rework";
  if (options?.forceRewrite) return "rewrite";
  if (configuredMode !== "spot-fix") return configuredMode;
  if (!hasStructuralAuditTextSignals(audit)) {
    // Pure word-count deficiency: use rewrite (broader than spot-fix but lighter than rework)
    if (isLengthOnlyIssueTexts(audit.issueTexts)) return "rewrite";
    return "spot-fix";
  }
  return reviseRound <= 1 ? "rework" : "rewrite";
}

function hasFailedOutlineDeviationDimension(
  audit: Pick<NormalizedAuditDraftSummary, "dimensionChecks">,
): boolean {
  if (!Array.isArray(audit.dimensionChecks) || audit.dimensionChecks.length === 0) return false;
  return audit.dimensionChecks.some((item) => {
    if (!item || item.status !== "failed") return false;
    const normalized = String(item.dimension ?? "").trim().toLowerCase();
    return normalized.includes("大纲偏离")
      || normalized.includes("卷纲")
      || normalized.includes("outline deviation")
      || normalized.includes("outline alignment");
  });
}

function normalizeIssueTextForCompare(issueText: string): string {
  return issueText
    .replace(/^\[[^\]]+\]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function isStructuralIssueText(issueText: string): boolean {
  const normalized = normalizeIssueTextForCompare(issueText);
  if (!normalized) return false;
  if (classifyIssueTextForMetrics(normalized) === "structural") return true;
  return STRUCTURAL_AUDIT_SIGNALS.some((signal) => normalized.includes(signal.toLowerCase()));
}

function buildStructuralStagnationOverrideIssues(
  unresolvedIssues: ReadonlyArray<string>,
): AutoReviewStructuredIssue[] {
  const dedup = new Map<string, string>();
  for (const issue of unresolvedIssues) {
    const normalized = normalizeIssueTextForCompare(issue);
    if (!normalized) continue;
    if (!dedup.has(normalized)) dedup.set(normalized, issue.trim());
  }
  const topIssues = Array.from(dedup.values()).slice(0, 3);
  if (topIssues.length === 0) return [];
  return topIssues.map((description) => ({
    severity: "critical",
    category: "outline_alignment",
    description,
    suggestion: "连续多轮未收敛。必须先列出本章事件链并逐条对齐卷纲/状态卡/时间线，再执行结构级重写，不可仅做措辞微调。",
  }));
}

function buildRevisionStagnationOverrideIssues(args: {
  readonly previousMode: AutoReviseMode;
  readonly previousStatus: string;
  readonly reviseRound: number;
}): AutoReviewStructuredIssue[] {
  return [{
    severity: "critical",
    category: "revision_stagnation",
    description: `第${Math.max(1, args.reviseRound - 1)}轮${args.previousMode}修订返回 ${args.previousStatus}，未产生可应用正文变化。`,
    suggestion: "本轮必须重构问题段落，先明确要改动的具体段落，再输出真正不同的修订稿。",
  }];
}

function detectStructuralStagnation(args: {
  basisAudit: Pick<NormalizedAuditDraftSummary, "issueTexts" | "score" | "issueCount">;
  previousAudit?: Pick<NormalizedAuditDraftSummary, "score" | "issueCount">;
  previousRevision?: {
    issueResolutions: ReadonlyArray<{
      issue: string;
      outcome: "resolved" | "unresolved";
    }>;
  };
  minUnresolvedStructuralIssues: number;
  scoreDeltaThreshold: number;
}): {
  stalled: boolean;
  unresolvedStructuralIssues: string[];
} {
  if (!args.previousRevision || !args.previousAudit) {
    return { stalled: false, unresolvedStructuralIssues: [] };
  }
  const unresolvedStructuralIssues = args.previousRevision.issueResolutions
    .filter((item) => item.outcome === "unresolved" && isStructuralIssueText(item.issue))
    .map((item) => item.issue.trim())
    .filter((item) => item.length > 0);
  if (unresolvedStructuralIssues.length < args.minUnresolvedStructuralIssues) {
    return { stalled: false, unresolvedStructuralIssues };
  }
  if (!hasStructuralAuditTextSignals(args.basisAudit)) {
    return { stalled: false, unresolvedStructuralIssues };
  }
  const scoreDelta = args.basisAudit.score - args.previousAudit.score;
  const issueDelta = args.basisAudit.issueCount - args.previousAudit.issueCount;
  const stalled = scoreDelta <= args.scoreDeltaThreshold && issueDelta >= 0;
  return { stalled, unresolvedStructuralIssues };
}

function buildReviseStrategyReason(args: {
  configuredMode: AutoReviseMode;
  resolvedMode: AutoReviseMode;
  reviseRound: number;
  stagnationStalled: boolean;
  previousRevisionWasNoop: boolean;
  failedOutlineDeviationDimension: boolean;
  unresolvedIssueCountFromPrevRound: number;
  failureGate: AuditFailureGate;
  hasFailedDimensions: boolean;
  overrideIssueCount: number;
}): string {
  if (args.failedOutlineDeviationDimension && args.resolvedMode === "rewrite") {
    return "检测到大纲偏离检测未通过，已直接升级为 rewrite 执行结构级修复。";
  }
  if (args.stagnationStalled) {
    return "检测到结构问题连续未收敛，已升级为 rewrite 并注入结构化修订约束。";
  }
  if (args.previousRevisionWasNoop) {
    return "上一轮修订未产生有效正文变化，已升级为 rework 并补充修订停滞约束。";
  }
  if (args.configuredMode === "spot-fix" && args.resolvedMode === "rework") {
    return "检测到结构性审计信号，首轮由 spot-fix 升级为 rework。";
  }
  if (args.configuredMode === "spot-fix" && args.resolvedMode === "rewrite" && args.reviseRound > 1) {
    return "结构信号持续存在，已从轻量修订升级为 rewrite。";
  }
  if (args.failureGate === "score") {
    return "评分门禁未通过，本轮优先修复高影响问题并提升总分。";
  }
  if (args.hasFailedDimensions) {
    return "存在 failed 维度，本轮优先对齐对应维度约束。";
  }
  if (args.unresolvedIssueCountFromPrevRound > 0) {
    return "上轮存在未收敛问题，本轮优先闭环未解决项。";
  }
  if (args.overrideIssueCount > 0) {
    return "根据审计优先级重排问题顺序，执行定向修订。";
  }
  return "按当前模式执行常规修订。";
}

interface AutoReviewStructuredIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
}

function extractStructuredIssuesFromAudit(audit: NormalizedAuditDraftSummary): AutoReviewStructuredIssue[] {
  const rawIssues = (audit.raw as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(rawIssues)) return [];
  const issues: AutoReviewStructuredIssue[] = [];
  for (const issue of rawIssues) {
    if (!issue || typeof issue !== "object") continue;
    const row = issue as {
      severity?: unknown;
      category?: unknown;
      description?: unknown;
      suggestion?: unknown;
    };
    const severity = row.severity === "critical" || row.severity === "warning" || row.severity === "info"
      ? row.severity
      : "warning";
    const description = typeof row.description === "string" ? row.description.trim() : "";
    if (!description) continue;
    issues.push({
      severity,
      category: typeof row.category === "string" ? row.category : "",
      description,
      suggestion: typeof row.suggestion === "string" ? row.suggestion : "",
    });
  }
  return issues;
}

function buildPrioritizedOverrideIssuesForRevise(
  currentAudit: NormalizedAuditDraftSummary,
  previousRevision?: {
    issueResolutions: Array<{
      issue: string;
      outcome: "resolved" | "unresolved";
    }>;
  },
): AutoReviewStructuredIssue[] {
  const issues = extractStructuredIssuesFromAudit(currentAudit);
  if (issues.length === 0 || !previousRevision || previousRevision.issueResolutions.length === 0) {
    return issues;
  }
  const unresolvedKeys = new Set(
    previousRevision.issueResolutions
      .filter((item) => item.outcome === "unresolved")
      .map((item) => normalizeIssueTextForCompare(item.issue)),
  );
  if (unresolvedKeys.size === 0) {
    return issues;
  }

  const prioritized: AutoReviewStructuredIssue[] = [];
  const remaining: AutoReviewStructuredIssue[] = [];
  for (const issue of issues) {
    const normalized = normalizeIssueTextForCompare(issue.description);
    if (unresolvedKeys.has(normalized)) prioritized.push(issue);
    else remaining.push(issue);
  }
  if (prioritized.length === 0) {
    return issues;
  }
  return [...prioritized, ...remaining];
}

function buildAutoReviewIssueId(index: number): string {
  return `ISSUE-${String(index + 1).padStart(2, "0")}`;
}

function parseFixedIssueLine(raw: string): { issueId: string | null; text: string } {
  const line = raw.trim();
  if (!line) return { issueId: null, text: "" };
  const match = line.match(/^-?\s*\[(ISSUE-\d{2})\]\s*(.+)$/i);
  if (!match) return { issueId: null, text: line };
  return {
    issueId: String(match[1]).toUpperCase(),
    text: String(match[2]).trim(),
  };
}

function collectUnresolvedIssueIdsFromRevision(
  previousRevision?: {
    issueResolutions: ReadonlyArray<{
      issueId: string;
      outcome: "resolved" | "unresolved";
    }>;
  },
): string[] {
  if (!previousRevision || previousRevision.issueResolutions.length === 0) return [];
  return previousRevision.issueResolutions
    .filter((item) => item.outcome === "unresolved" && typeof item.issueId === "string")
    .map((item) => item.issueId.trim().toUpperCase())
    .filter((item) => /^ISSUE-\d{2}$/u.test(item));
}

function computeMustFixFirstIssueIds(params: {
  basisAudit: Pick<NormalizedAuditDraftSummary, "issueTexts" | "failureGate" | "dimensionChecks">;
  unresolvedIssueIdsFromPrevRound: ReadonlyArray<string>;
}): string[] {
  const mustFix = new Set<string>();
  for (const id of params.unresolvedIssueIdsFromPrevRound) {
    if (/^ISSUE-\d{2}$/u.test(id)) mustFix.add(id);
  }
  const issueMeta = params.basisAudit.issueTexts.map((issueText, index) => ({
    issueId: buildAutoReviewIssueId(index),
    parsed: parseAuditIssueText(issueText),
  }));
  for (const item of issueMeta) {
    if (item.parsed?.severity === "critical") {
      mustFix.add(item.issueId);
    }
  }
  if (params.basisAudit.failureGate === "score") {
    for (const item of issueMeta) {
      if (item.parsed && (item.parsed.severity === "critical" || item.parsed.severity === "warning")) {
        mustFix.add(item.issueId);
      }
    }
  }
  if (Array.isArray(params.basisAudit.dimensionChecks) && params.basisAudit.dimensionChecks.some((item) => item.status === "failed")) {
    for (const item of issueMeta) {
      if (item.parsed && item.parsed.severity !== "info") {
        mustFix.add(item.issueId);
      }
    }
  }
  const ordered = Array.from(mustFix.values());
  ordered.sort((left, right) => left.localeCompare(right));
  return ordered;
}

function normalizeIssueClassCountsForReviseContext(
  value: unknown,
): { structural: number; textual: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as { structural?: unknown; textual?: unknown };
  const structural = Number(payload.structural ?? 0);
  const textual = Number(payload.textual ?? 0);
  if (!Number.isFinite(structural) || !Number.isFinite(textual)) return undefined;
  return {
    structural: Math.max(0, Math.trunc(structural)),
    textual: Math.max(0, Math.trunc(textual)),
  };
}

function buildMustFixOutcomes(params: {
  mustFixFirstIssueIds: ReadonlyArray<string>;
  issueResolutions: ReadonlyArray<{
    issueId: string;
    outcome: "resolved" | "unresolved";
    fixDelta?: string;
  }>;
}): Array<{
  issueId: string;
  outcome: "resolved" | "partial" | "unresolved";
  reason?: string;
}> {
  if (params.mustFixFirstIssueIds.length === 0) return [];
  const resolutionById = new Map(
    params.issueResolutions.map((item) => [item.issueId, item] as const),
  );
  return params.mustFixFirstIssueIds.map((issueId) => {
    const resolution = resolutionById.get(issueId);
    if (!resolution) {
      return {
        issueId,
        outcome: "unresolved" as const,
        reason: "未在问题映射中命中，需人工复核",
      };
    }
    if (resolution.outcome === "resolved") {
      return {
        issueId,
        outcome: "resolved" as const,
        ...(resolution.fixDelta ? { reason: resolution.fixDelta } : {}),
      };
    }
    if (resolution.fixDelta) {
      return {
        issueId,
        outcome: "partial" as const,
        reason: resolution.fixDelta,
      };
    }
    return {
      issueId,
      outcome: "unresolved" as const,
      reason: "审计复核仍未通过",
    };
  });
}

function buildFixDeltaLookup(fixedIssues: ReadonlyArray<string>): {
  byId: Map<string, string>;
  orderedUnbound: string[];
} {
  const byId = new Map<string, string>();
  const orderedUnbound: string[] = [];
  for (const raw of fixedIssues) {
    const parsed = parseFixedIssueLine(raw);
    if (!parsed.text) continue;
    if (!parsed.issueId) {
      orderedUnbound.push(parsed.text);
      continue;
    }
    const existing = byId.get(parsed.issueId);
    byId.set(parsed.issueId, existing ? `${existing} | ${parsed.text}` : parsed.text);
  }
  return { byId, orderedUnbound };
}

function buildAutoReviewAuditEventState(params: {
  round: number;
  maxReviseRounds: number;
  passed: boolean;
  unboundedReview?: boolean;
  stopReason?: string;
}): {
  autoReviewFinal: boolean;
  autoReviewState: "retrying" | "passed" | "failed-max-rounds" | "failed-single-audit";
  autoReviewStopReason?: string;
} {
  const { round, maxReviseRounds, passed, unboundedReview } = params;
  if (maxReviseRounds <= 0) {
    return {
      autoReviewFinal: true,
      autoReviewState: passed ? "passed" : "failed-single-audit",
    };
  }
  if (passed) {
    return {
      autoReviewFinal: true,
      autoReviewState: "passed",
    };
  }
  if (unboundedReview) {
    return {
      autoReviewFinal: false,
      autoReviewState: "retrying",
    };
  }
  if (round <= maxReviseRounds) {
    return {
      autoReviewFinal: false,
      autoReviewState: "retrying",
    };
  }
  return {
    autoReviewFinal: true,
    autoReviewState: "failed-max-rounds",
    autoReviewStopReason: params.stopReason?.trim() || "达到自动修订轮次上限，仍未通过审计",
  };
}

function buildSingleAuditAutoReviewPayload(passed: boolean): UnifiedReviewLoopAutoReviewPayload {
  return {
    enabled: false,
    maxReviseRounds: 0,
    reviseRoundsUsed: 0,
    auditRounds: 1,
    stoppedByMaxRounds: false,
    finalState: passed ? "passed" : "failed-single-audit",
    revisions: [],
  };
}

function normalizeAuditDraftSummary(
  auditResult: PipelineAuditDraftResult,
): NormalizedAuditDraftSummary {
  const issueTexts = buildAuditIssueTexts(auditResult.issues);
  const severityCounts = countAuditIssueSeveritiesFromIssues(auditResult.issues);
  const score = estimateAuditScoreFromSeverityCounts(severityCounts);
  const issueCount = Array.isArray(auditResult.issues) ? auditResult.issues.length : issueTexts.length;
  const summary = typeof auditResult.summary === "string" && auditResult.summary.trim()
    ? auditResult.summary.trim()
    : undefined;
  const chapterNumber = Number.isFinite(Number(auditResult.chapterNumber))
    ? Math.max(1, Math.trunc(Number(auditResult.chapterNumber)))
    : 1;
  const basePassed = Boolean(auditResult.passed);
  const passed = resolveAuditPassedByScore(basePassed, score, AUDIT_PASS_SCORE_THRESHOLD);
  const failureGate = resolveAuditFailureGate({
    basePassed,
    score,
    severityCounts,
    passScoreThreshold: AUDIT_PASS_SCORE_THRESHOLD,
  });
  const dimensionChecks = normalizeDimensionChecks(
    (auditResult as { dimensionChecks?: unknown }).dimensionChecks,
  );
  const payload = auditResult as {
    issueClassCounts?: unknown;
    primaryIssueClass?: unknown;
  };
  const rawClassCounts = payload.issueClassCounts;
  const classCountsFromPayload = rawClassCounts && typeof rawClassCounts === "object"
    ? {
        structural: Number((rawClassCounts as { structural?: unknown }).structural ?? 0),
        textual: Number((rawClassCounts as { textual?: unknown }).textual ?? 0),
      }
    : null;
  const validClassCountsFromPayload = classCountsFromPayload
    && Number.isFinite(classCountsFromPayload.structural)
    && Number.isFinite(classCountsFromPayload.textual)
    ? {
        structural: Math.max(0, Math.trunc(classCountsFromPayload.structural)),
        textual: Math.max(0, Math.trunc(classCountsFromPayload.textual)),
      }
    : undefined;
  const derivedClassCounts = deriveIssueClassCountsFromIssueTexts(issueTexts);
  const issueClassCounts = validClassCountsFromPayload ?? derivedClassCounts;
  const primaryIssueClass = normalizePrimaryIssueClass(payload.primaryIssueClass)
    ?? derivePrimaryIssueClassFromCounts(issueClassCounts);
  const tokenUsage = normalizeTokenUsage((auditResult as { tokenUsage?: unknown }).tokenUsage) ?? undefined;
  return {
    chapterNumber,
    passed,
    score,
    issueCount: Math.max(0, issueCount),
    severityCounts,
    failureGate,
    ...(dimensionChecks.length > 0 ? { dimensionChecks } : {}),
    issueClassCounts,
    primaryIssueClass,
    summary,
    issueTexts,
    report: buildAuditReportText({
      chapterNumber,
      passed,
      issueCount: Math.max(0, issueCount),
      summary,
      issueTexts,
      severityCounts,
      failureGate,
    }),
    ...(tokenUsage ? { tokenUsage } : {}),
    raw: auditResult,
  };
}

async function runAuditWithAutoRevise(args: {
  readonly pipeline: PipelineRunner;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly maxReviseRounds?: number;
  readonly reviseMode?: AutoReviseMode;
  readonly stagnationPolicy?: {
    minUnresolvedStructuralIssues: number;
    scoreDeltaThreshold: number;
  };
  readonly onAuditStart?: (payload: { round: number; maxReviseRounds: number }) => void | Promise<void>;
  readonly onAuditComplete?: (payload: {
    round: number;
    maxReviseRounds: number;
    audit: NormalizedAuditDraftSummary;
    tokenUsage?: TokenUsageSnapshot;
    latestRevisionMustFixOutcomes?: ReadonlyArray<{
      issueId: string;
      outcome: "resolved" | "partial" | "unresolved";
      reason?: string;
    }>;
    latestRevisionMustFixTotalCount?: number;
    latestRevisionMustFixUnresolvedCount?: number;
  }) => void | Promise<void>;
  readonly onReviseStart?: (payload: {
    round: number;
    maxReviseRounds: number;
    mode: AutoReviseMode;
    strategyReason?: string;
  }) => void | Promise<void>;
  readonly onReviseComplete?: (payload: {
    round: number;
    maxReviseRounds: number;
    mode: AutoReviseMode;
    reviseResult: PipelineReviseDraftResult;
    reviseAudit: NormalizedReviseAuditSummary | null;
    tokenUsage?: TokenUsageSnapshot;
  }) => void | Promise<void>;
}): Promise<AutoAuditCycleResult> {
  const configuredMaxReviseRounds = Number.isFinite(Number(args.maxReviseRounds))
    ? Math.max(0, Math.trunc(Number(args.maxReviseRounds)))
    : AUTO_REVISE_MAX_ROUNDS;
  const configuredReviseMode = args.reviseMode ?? AUTO_REVISE_MODE;
  let effectiveMaxReviseRounds = configuredMaxReviseRounds;

  const audits: NormalizedAuditDraftSummary[] = [];
  const revisions: Array<{
    round: number;
    mode: AutoReviseMode;
    reviseResult: PipelineReviseDraftResult;
    reviseAudit: NormalizedReviseAuditSummary | null;
    basisIssueTexts: string[];
    fixedIssues: string[];
    issueResolutions: Array<{
      issueId: string;
      issue: string;
      outcome: "resolved" | "unresolved";
      fixDelta?: string;
    }>;
    mustFixFirstIssueIds: string[];
    mustFixOutcomes: Array<{
      issueId: string;
      outcome: "resolved" | "partial" | "unresolved";
      reason?: string;
    }>;
  }> = [];

  let auditRound = 1;
  await args.onAuditStart?.({ round: auditRound, maxReviseRounds: effectiveMaxReviseRounds });
  let currentAudit = normalizeAuditDraftSummary(
    await args.pipeline.auditDraft(args.bookId, args.chapterNumber),
  );
  effectiveMaxReviseRounds = resolveAdaptiveMaxReviseRounds(configuredMaxReviseRounds, currentAudit);
  audits.push(currentAudit);
  await args.onAuditComplete?.({
    round: auditRound,
    maxReviseRounds: effectiveMaxReviseRounds,
    audit: currentAudit,
    tokenUsage: currentAudit.tokenUsage,
  });
  if (currentAudit.passed) {
    return {
      chapterNumber: currentAudit.chapterNumber,
      audits,
      revisions,
      finalAudit: currentAudit,
      stoppedByMaxRounds: false,
      maxReviseRounds: effectiveMaxReviseRounds,
    };
  }

  let structuralStagnationObserved = false;
  for (let reviseRound = 1; reviseRound <= effectiveMaxReviseRounds; reviseRound += 1) {
    const basisAudit = currentAudit;
    const previousRevision = revisions.length > 0 ? revisions[revisions.length - 1] : undefined;
    const previousRevisionWasNoop = Boolean(
      previousRevision
      && (!previousRevision.reviseResult.applied || previousRevision.reviseResult.status === "unchanged"),
    );
    const previousAudit = audits.length > 1 ? audits[audits.length - 2] : undefined;
    const stagnation = detectStructuralStagnation({
      basisAudit,
      previousAudit,
      previousRevision: previousRevision
        ? { issueResolutions: previousRevision.issueResolutions.map((item) => ({ issue: item.issue, outcome: item.outcome })) }
        : undefined,
      minUnresolvedStructuralIssues: args.stagnationPolicy?.minUnresolvedStructuralIssues
        ?? STRUCTURAL_STAGNATION_MIN_UNRESOLVED,
      scoreDeltaThreshold: args.stagnationPolicy?.scoreDeltaThreshold
        ?? STRUCTURAL_STAGNATION_SCORE_DELTA_THRESHOLD,
    });
    const reviseMode = resolveAdaptiveReviseMode(
      configuredReviseMode,
      basisAudit,
      reviseRound,
      {
        forceRework: previousRevisionWasNoop,
        forceRewrite: stagnation.stalled || hasFailedOutlineDeviationDimension(basisAudit),
      },
    );
    const prioritizedOverrideIssues = previousRevision
      ? buildPrioritizedOverrideIssuesForRevise(
        basisAudit,
        { issueResolutions: previousRevision.issueResolutions.map((item) => ({ issue: item.issue, outcome: item.outcome })) },
      )
      : [];
    const revisionStagnationOverrides = previousRevisionWasNoop && previousRevision
      ? buildRevisionStagnationOverrideIssues({
          previousMode: previousRevision.mode,
          previousStatus: previousRevision.reviseResult.status,
          reviseRound,
        })
      : [];
    const structuralStagnationOverrides = stagnation.stalled
      ? buildStructuralStagnationOverrideIssues(stagnation.unresolvedStructuralIssues)
      : [];
    if (stagnation.stalled) {
      structuralStagnationObserved = true;
    }
    const mergedOverrideIssues = [
      ...revisionStagnationOverrides,
      ...structuralStagnationOverrides,
      ...prioritizedOverrideIssues,
    ];
    const unresolvedIssueIdsFromPrevRound = collectUnresolvedIssueIdsFromRevision(previousRevision);
    const mustFixFirstIssueIds = computeMustFixFirstIssueIds({
      basisAudit,
      unresolvedIssueIdsFromPrevRound,
    });
    const issueClassCountsForContext = normalizeIssueClassCountsForReviseContext(
      (basisAudit as { issueClassCounts?: unknown }).issueClassCounts,
    );
    const primaryIssueClassForContext = normalizePrimaryIssueClass(
      (basisAudit as { primaryIssueClass?: unknown }).primaryIssueClass,
    );
    const reviseContext = {
      failureGate: basisAudit.failureGate,
      score: basisAudit.score,
      passScoreThreshold: AUDIT_PASS_SCORE_THRESHOLD,
      previousRevisionWasNoop,
      unresolvedIssueIdsFromPrevRound,
      ...(mustFixFirstIssueIds.length > 0 ? { mustFixFirstIssueIds } : {}),
      ...(Array.isArray(basisAudit.dimensionChecks) && basisAudit.dimensionChecks.length > 0
        ? { dimensionChecks: basisAudit.dimensionChecks }
        : {}),
      ...(issueClassCountsForContext
        ? { issueClassCounts: issueClassCountsForContext }
        : {}),
      ...(primaryIssueClassForContext
        ? { primaryIssueClass: primaryIssueClassForContext }
        : {}),
    };
    const strategyReason = buildReviseStrategyReason({
      configuredMode: configuredReviseMode,
      resolvedMode: reviseMode,
      reviseRound,
      stagnationStalled: stagnation.stalled,
      previousRevisionWasNoop,
      failedOutlineDeviationDimension: hasFailedOutlineDeviationDimension(basisAudit),
      unresolvedIssueCountFromPrevRound: unresolvedIssueIdsFromPrevRound.length,
      failureGate: basisAudit.failureGate,
      hasFailedDimensions: Array.isArray(basisAudit.dimensionChecks)
        && basisAudit.dimensionChecks.some((item) => item.status === "failed"),
      overrideIssueCount: mergedOverrideIssues.length,
    });
    await args.onReviseStart?.({
      round: reviseRound,
      maxReviseRounds: effectiveMaxReviseRounds,
      mode: reviseMode,
      strategyReason,
    });
    const reviseResult = mergedOverrideIssues.length > 0
      ? await args.pipeline.reviseDraft(
        args.bookId,
        args.chapterNumber,
        reviseMode,
        { overrideIssues: mergedOverrideIssues, reviseContext },
      )
      : await args.pipeline.reviseDraft(
        args.bookId,
        args.chapterNumber,
        reviseMode,
        { reviseContext },
      );
    const reviseAudit = normalizeReviseAuditSummary(
      (reviseResult as { audit?: unknown }).audit,
      args.chapterNumber,
      reviseResult.status !== "audit-failed",
    );
    const fixedIssues = Array.isArray(reviseResult.fixedIssues)
      ? reviseResult.fixedIssues.map((item) => String(item).trim()).filter((item) => item.length > 0)
      : [];
    const revisionEntry = {
      round: reviseRound,
      mode: reviseMode,
      reviseResult,
      reviseAudit,
      basisIssueTexts: [...basisAudit.issueTexts],
      fixedIssues,
      issueResolutions: [] as Array<{
        issueId: string;
        issue: string;
        outcome: "resolved" | "unresolved";
        fixDelta?: string;
      }>,
      mustFixFirstIssueIds,
      mustFixOutcomes: [] as Array<{
        issueId: string;
        outcome: "resolved" | "partial" | "unresolved";
        reason?: string;
      }>,
    };
    revisions.push(revisionEntry);
    await args.onReviseComplete?.({
      round: reviseRound,
      maxReviseRounds: effectiveMaxReviseRounds,
      mode: reviseMode,
      reviseResult,
      reviseAudit,
      tokenUsage: normalizeTokenUsage((reviseResult as { tokenUsage?: unknown }).tokenUsage) ?? undefined,
    });

    auditRound = reviseRound + 1;
    await args.onAuditStart?.({ round: auditRound, maxReviseRounds: effectiveMaxReviseRounds });
    currentAudit = normalizeAuditDraftSummary(
      await args.pipeline.auditDraft(args.bookId, args.chapterNumber),
    );
    const postIssueKeys = new Set(currentAudit.issueTexts.map((issue) => normalizeIssueTextForCompare(issue)));
    const fixDeltaLookup = buildFixDeltaLookup(revisionEntry.fixedIssues);
    let fallbackUnboundIndex = 0;
    revisionEntry.issueResolutions = revisionEntry.basisIssueTexts.map((issue, issueIndex) => {
      const issueId = buildAutoReviewIssueId(issueIndex);
      const unresolved = postIssueKeys.has(normalizeIssueTextForCompare(issue));
      const idBoundDelta = fixDeltaLookup.byId.get(issueId);
      const fallbackDelta = !idBoundDelta && !unresolved
        ? fixDeltaLookup.orderedUnbound[fallbackUnboundIndex]
        : undefined;
      if (!idBoundDelta && !unresolved && fallbackDelta) {
        fallbackUnboundIndex += 1;
      }
      return {
        issueId,
        issue,
        outcome: unresolved ? "unresolved" : "resolved",
        ...((idBoundDelta ?? fallbackDelta) ? { fixDelta: idBoundDelta ?? fallbackDelta } : {}),
      };
    });
    revisionEntry.mustFixOutcomes = buildMustFixOutcomes({
      mustFixFirstIssueIds: revisionEntry.mustFixFirstIssueIds,
      issueResolutions: revisionEntry.issueResolutions,
    });
    audits.push(currentAudit);
    const latestRevisionMustFixOutcomes = revisionEntry.mustFixOutcomes;
    const latestRevisionMustFixTotalCount = latestRevisionMustFixOutcomes.length;
    const latestRevisionMustFixUnresolvedCount = latestRevisionMustFixOutcomes.filter((item) => item.outcome !== "resolved").length;
    await args.onAuditComplete?.({
      round: auditRound,
      maxReviseRounds: effectiveMaxReviseRounds,
      audit: currentAudit,
      latestRevisionMustFixOutcomes,
      latestRevisionMustFixTotalCount,
      latestRevisionMustFixUnresolvedCount,
    });
    if (currentAudit.passed) {
      return {
        chapterNumber: currentAudit.chapterNumber,
        audits,
        revisions,
        finalAudit: currentAudit,
        stoppedByMaxRounds: false,
        maxReviseRounds: effectiveMaxReviseRounds,
      };
    }
  }

  return {
    chapterNumber: currentAudit.chapterNumber,
    audits,
    revisions,
    finalAudit: currentAudit,
    stoppedByMaxRounds: true,
    maxReviseRounds: effectiveMaxReviseRounds,
    ...(structuralStagnationObserved
      ? { stopReason: "达到自动修订轮次上限，且结构性问题持续未收敛，请先人工重构章节主线并对齐卷纲后再审计" }
      : {}),
  };
}

async function runUnifiedReviewLoop(args: {
  readonly state: StateManager;
  readonly pipeline: PipelineRunner;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly entry?: ReviewEntry;
  readonly onFinalized?: (payload: {
    entry: ReviewEntry;
    finalAudit: NormalizedAuditDraftSummary;
    autoReview: UnifiedReviewLoopAutoReviewPayload;
  }) => void | Promise<void>;
  readonly autoReviewPolicy: {
    enabled: boolean;
    maxReviseRounds: number;
    reviseMode: AutoReviseMode;
    stagnation: {
      minUnresolvedStructuralIssues: number;
      scoreDeltaThreshold: number;
    };
  };
  readonly onAuditStart?: (payload: { round: number; maxReviseRounds: number }) => void | Promise<void>;
  readonly onAuditComplete?: (payload: {
    round: number;
    maxReviseRounds: number;
    audit: NormalizedAuditDraftSummary;
    tokenUsage?: TokenUsageSnapshot;
    latestRevisionMustFixOutcomes?: ReadonlyArray<{
      issueId: string;
      outcome: "resolved" | "partial" | "unresolved";
      reason?: string;
    }>;
    latestRevisionMustFixTotalCount?: number;
    latestRevisionMustFixUnresolvedCount?: number;
  }) => void | Promise<void>;
  readonly onReviseStart?: (payload: {
    round: number;
    maxReviseRounds: number;
    mode: AutoReviseMode;
    strategyReason?: string;
  }) => void | Promise<void>;
  readonly onReviseComplete?: (payload: {
    round: number;
    maxReviseRounds: number;
    mode: AutoReviseMode;
    reviseResult: PipelineReviseDraftResult;
    reviseAudit: NormalizedReviseAuditSummary | null;
    tokenUsage?: TokenUsageSnapshot;
  }) => void | Promise<void>;
}): Promise<UnifiedReviewLoopResult> {
  const entry = args.entry ?? "rewrite";
  const runSingleAudit = !args.autoReviewPolicy.enabled || args.autoReviewPolicy.maxReviseRounds <= 0;
  if (runSingleAudit) {
    await args.onAuditStart?.({ round: 1, maxReviseRounds: 0 });
    const normalized = normalizeAuditDraftSummary(
      await args.pipeline.auditDraft(args.bookId, args.chapterNumber),
    );
    await args.onAuditComplete?.({ round: 1, maxReviseRounds: 0, audit: normalized, tokenUsage: normalized.tokenUsage });
    await persistAutoReviewTerminalNote({
      state: args.state,
      bookId: args.bookId,
      chapterNumber: normalized.chapterNumber,
      finalState: normalized.passed ? "passed" : "failed-single-audit",
      finalAudit: normalized,
    });
    await persistChapterAuditSummary({
      state: args.state,
      bookId: args.bookId,
      chapterNumber: normalized.chapterNumber,
      audit: {
        passed: normalized.passed,
        score: normalized.score,
        issueCount: normalized.issueCount,
        summary: normalized.summary,
        report: normalized.report,
        issues: normalized.issueTexts,
        severityCounts: normalized.severityCounts,
        failureGate: normalized.failureGate,
      },
    });
    const autoReview: UnifiedReviewLoopAutoReviewPayload = {
      enabled: args.autoReviewPolicy.enabled,
      maxReviseRounds: 0,
      reviseRoundsUsed: 0,
      auditRounds: 1,
      stoppedByMaxRounds: false,
      finalState: normalized.passed ? "passed" : "failed-single-audit",
      revisions: [],
    };
    await args.onFinalized?.({
      entry,
      finalAudit: normalized,
      autoReview,
    });
    return {
      finalAudit: normalized,
      autoReview,
    };
  }

  const cycle = await runAuditWithAutoRevise({
    pipeline: args.pipeline,
    bookId: args.bookId,
    chapterNumber: args.chapterNumber,
    maxReviseRounds: args.autoReviewPolicy.maxReviseRounds,
    reviseMode: args.autoReviewPolicy.reviseMode,
    stagnationPolicy: args.autoReviewPolicy.stagnation,
    onAuditStart: args.onAuditStart,
    onAuditComplete: args.onAuditComplete,
    onReviseStart: args.onReviseStart,
    onReviseComplete: args.onReviseComplete,
  });
  const finalState = resolveUnifiedReviewFinalState(cycle);
  await persistAutoReviewTerminalNote({
    state: args.state,
    bookId: args.bookId,
    chapterNumber: cycle.finalAudit.chapterNumber,
    finalState,
    ...(finalState === "failed-max-rounds"
      ? { stopReason: cycle.stopReason?.trim() || "达到自动修订轮次上限，仍未通过审计" }
      : {}), 
    finalAudit: cycle.finalAudit,
  });
  await persistChapterAuditSummary({
    state: args.state,
    bookId: args.bookId,
    chapterNumber: cycle.finalAudit.chapterNumber,
    audit: {
      passed: cycle.finalAudit.passed,
      score: cycle.finalAudit.score,
      issueCount: cycle.finalAudit.issueCount,
      summary: cycle.finalAudit.summary,
      report: cycle.finalAudit.report,
      issues: cycle.finalAudit.issueTexts,
      severityCounts: cycle.finalAudit.severityCounts,
      failureGate: cycle.finalAudit.failureGate,
    },
  });
  const autoReview = buildUnifiedAutoReviewPayload({
    enabled: args.autoReviewPolicy.enabled,
    maxReviseRounds: args.autoReviewPolicy.maxReviseRounds,
    cycle,
  });
  await args.onFinalized?.({
    entry,
    finalAudit: cycle.finalAudit,
    autoReview,
  });
  return {
    finalAudit: cycle.finalAudit,
    autoReview,
  };
}

function normalizeReviseAuditSummary(
  audit: unknown,
  chapterNumber: number,
  fallbackPassed?: boolean,
): NormalizedReviseAuditSummary | null {
  if (!audit || typeof audit !== "object") return null;
  const payload = audit as {
    passed?: unknown;
    score?: unknown;
    issueCount?: unknown;
    severityCounts?: unknown;
    dimensionChecks?: unknown;
    issueClassCounts?: unknown;
    primaryIssueClass?: unknown;
    summary?: unknown;
    issues?: unknown;
    report?: unknown;
  };
  const issueTexts = buildAuditIssueTexts(payload.issues);
  const rawCounts = payload.severityCounts;
  const fromPayloadCounts = rawCounts && typeof rawCounts === "object"
    ? {
        critical: Number((rawCounts as { critical?: unknown }).critical ?? 0),
        warning: Number((rawCounts as { warning?: unknown }).warning ?? 0),
        info: Number((rawCounts as { info?: unknown }).info ?? 0),
      }
    : null;
  const validPayloadCounts = fromPayloadCounts
    && Number.isFinite(fromPayloadCounts.critical)
    && Number.isFinite(fromPayloadCounts.warning)
    && Number.isFinite(fromPayloadCounts.info)
    ? {
        critical: Math.max(0, Math.trunc(fromPayloadCounts.critical)),
        warning: Math.max(0, Math.trunc(fromPayloadCounts.warning)),
        info: Math.max(0, Math.trunc(fromPayloadCounts.info)),
      }
    : null;
  const severityCounts = validPayloadCounts ?? countAuditIssueSeverities(issueTexts);
  const rawClassCounts = payload.issueClassCounts;
  const fromPayloadClassCounts = rawClassCounts && typeof rawClassCounts === "object"
    ? {
        structural: Number((rawClassCounts as { structural?: unknown }).structural ?? 0),
        textual: Number((rawClassCounts as { textual?: unknown }).textual ?? 0),
      }
    : null;
  const validClassCounts = fromPayloadClassCounts
    && Number.isFinite(fromPayloadClassCounts.structural)
    && Number.isFinite(fromPayloadClassCounts.textual)
    ? {
        structural: Math.max(0, Math.trunc(fromPayloadClassCounts.structural)),
        textual: Math.max(0, Math.trunc(fromPayloadClassCounts.textual)),
      }
    : undefined;
  const primaryIssueClass = payload.primaryIssueClass === "none"
    || payload.primaryIssueClass === "structural"
    || payload.primaryIssueClass === "textual"
    || payload.primaryIssueClass === "mixed"
    ? payload.primaryIssueClass
    : undefined;
  const issueCount = Number.isFinite(Number(payload.issueCount))
    ? Math.max(0, Math.trunc(Number(payload.issueCount)))
    : issueTexts.length;
  const basePassed = typeof payload.passed === "boolean"
    ? payload.passed
    : (typeof fallbackPassed === "boolean" ? fallbackPassed : issueCount === 0);
  const score = Number.isFinite(Number(payload.score))
    ? clampAuditScore(Number(payload.score))
    : estimateAuditScoreFromSeverityCounts(severityCounts);
  const passed = resolveAuditPassedByScore(basePassed, score, AUDIT_PASS_SCORE_THRESHOLD);
  const failureGate = resolveAuditFailureGate({
    basePassed,
    score,
    severityCounts,
    passScoreThreshold: AUDIT_PASS_SCORE_THRESHOLD,
  });
  const summary = typeof payload.summary === "string" && payload.summary.trim()
    ? payload.summary.trim()
    : undefined;
  const report = typeof payload.report === "string" && payload.report.trim()
    ? payload.report.trim()
    : buildAuditReportText({
        chapterNumber,
        passed,
        issueCount,
        summary,
        issueTexts,
        severityCounts,
        failureGate,
      });
  const dimensionChecks = normalizeDimensionChecks(payload.dimensionChecks);
  return {
    passed,
    score,
    issueCount,
    severityCounts,
    failureGate,
    ...(dimensionChecks.length > 0 ? { dimensionChecks } : {}),
    ...(validClassCounts ? { issueClassCounts: validClassCounts } : {}),
    ...(primaryIssueClass ? { primaryIssueClass } : {}),
    summary,
    issueTexts,
    report,
  };
}

function normalizeWriteAuditSummary(
  auditResult: unknown,
  chapterNumber: number,
): NormalizedReviseAuditSummary | null {
  if (!auditResult || typeof auditResult !== "object") return null;
  const payload = auditResult as {
    passed?: unknown;
    issues?: unknown;
    summary?: unknown;
    dimensionChecks?: unknown;
  };
  const issueTexts = buildAuditIssueTexts(payload.issues);
  const severityCounts = countAuditIssueSeverities(issueTexts);
  const issueCount = issueTexts.length;
  const score = estimateAuditScoreFromSeverityCounts(severityCounts);
  const basePassed = typeof payload.passed === "boolean" ? payload.passed : issueCount === 0;
  const passed = resolveAuditPassedByScore(basePassed, score, AUDIT_PASS_SCORE_THRESHOLD);
  const failureGate = resolveAuditFailureGate({
    basePassed,
    score,
    severityCounts,
    passScoreThreshold: AUDIT_PASS_SCORE_THRESHOLD,
  });
  const summary = typeof payload.summary === "string" && payload.summary.trim()
    ? payload.summary.trim()
    : undefined;
  const dimensionChecks = normalizeDimensionChecks(payload.dimensionChecks);
  return {
    passed,
    score,
    issueCount,
    severityCounts,
    failureGate,
    ...(dimensionChecks.length > 0 ? { dimensionChecks } : {}),
    summary,
    issueTexts,
    report: buildAuditReportText({
      chapterNumber,
      passed,
      issueCount,
      summary,
      issueTexts,
      severityCounts,
      failureGate,
    }),
  };
}

function emitSyntheticThinkingAndDraftDeltas(args: {
  readonly sessionId: string;
  readonly runId: string;
  readonly thinking: string[];
  readonly text: string;
}): void {
  for (const item of args.thinking) {
    const chunk = item.trim();
    if (!chunk) continue;
    broadcast("thinking:start", {
      sessionId: args.sessionId,
      runId: args.runId,
    });
    broadcast("thinking:delta", {
      sessionId: args.sessionId,
      runId: args.runId,
      text: chunk,
    });
    broadcast("thinking:end", {
      sessionId: args.sessionId,
      runId: args.runId,
    });
  }

  const text = args.text;
  if (!text) return;
  const chunkSize = 120;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    if (!chunk) continue;
    broadcast("draft:delta", {
      sessionId: args.sessionId,
      runId: args.runId,
      text: chunk,
    });
  }
}

function emitSyntheticDraftDeltas(args: {
  readonly sessionId: string;
  readonly runId: string;
  readonly text: string;
}): void {
  emitSyntheticThinkingAndDraftDeltas({
    sessionId: args.sessionId,
    runId: args.runId,
    thinking: [],
    text: args.text,
  });
}

interface CollectedToolExec {
  id: string;
  tool: string;
  agent?: string;
  label: string;
  status: "running" | "completed" | "error";
  args?: Record<string, unknown>;
  logs?: string[];
  result?: string;
  error?: string;
  stages?: Array<{ label: string; status: "pending" | "completed" }>;
  batch?: BatchProgressState;
  autoReview?: UnifiedReviewLoopAutoReviewPayload;
  previewText?: string;
  previewChapterNumber?: number;
  previewKind?: "chapter" | "patch";
  startedAt: number;
  completedAt?: number;
}

type PersistedToolExecution = NonNullable<Parameters<typeof upsertBookSessionMessage>[1]["toolExecutions"]>[number];
type PersistedToolExecutionAutoReview = NonNullable<PersistedToolExecution["autoReview"]>;
type PersistedToolExecutionBatch = NonNullable<PersistedToolExecution["batch"]>;

function serializeCollectedToolExecutionAutoReview(
  autoReview: UnifiedReviewLoopAutoReviewPayload,
): PersistedToolExecutionAutoReview {
  const reviseRoundsUsed = Math.max(0, Math.trunc(Number(autoReview.reviseRoundsUsed ?? 0)));
  const auditRoundsRaw = Number(autoReview.auditRounds);
  const round = Number.isFinite(auditRoundsRaw) && auditRoundsRaw > 0
    ? Math.max(1, Math.trunc(auditRoundsRaw))
    : Math.max(1, reviseRoundsUsed + 1);
  const maxRounds = Math.max(0, Math.trunc(Number(autoReview.maxReviseRounds ?? 0)));
  const finalState = autoReview.finalState === "passed"
    ? "passed"
    : autoReview.finalState === "failed-max-rounds"
      ? "failed-max-rounds"
      : "failed-single-audit";

  return {
    enabled: Boolean(autoReview.enabled),
    phase: reviseRoundsUsed > 0 ? "revise" : "audit",
    round,
    maxRounds,
    final: true,
    state: finalState,
    ...(typeof autoReview.stopReason === "string" && autoReview.stopReason.trim().length > 0
      ? { stopReason: autoReview.stopReason.trim() }
      : {}),
    ...(typeof autoReview.reviseRoundsUsed === "number"
      ? { reviseRoundsUsed }
      : {}),
    passed: finalState === "passed",
  };
}

function serializeCollectedToolExecutionBatch(execution: CollectedToolExec): PersistedToolExecutionBatch | undefined {
  if (!execution.batch) return undefined;
  const status = execution.status === "completed"
    ? "completed"
    : execution.status === "error"
      ? "failed"
      : "running";
  const elapsedMs = Number.isFinite(execution.batch.elapsedMs)
    ? Math.max(0, execution.batch.elapsedMs)
    : Math.max(0, (execution.completedAt ?? Date.now()) - execution.batch.startedAt);

  return {
    batchId: execution.batch.batchId,
    status,
    total: execution.batch.total,
    completed: execution.batch.completed,
    elapsedMs,
    ...(typeof execution.batch.currentChapter === "number" ? { currentChapter: execution.batch.currentChapter } : {}),
    ...(typeof execution.batch.currentWords === "number" ? { currentWords: execution.batch.currentWords } : {}),
    ...(typeof execution.batch.failedChapterNumber === "number" ? { failedChapterNumber: execution.batch.failedChapterNumber } : {}),
    ...(typeof execution.batch.error === "string" && execution.batch.error.trim().length > 0
      ? { error: execution.batch.error.trim() }
      : (status === "failed" && typeof execution.error === "string" && execution.error.trim().length > 0
        ? { error: execution.error.trim() }
        : {})),
  };
}

function serializeCollectedToolExecution(
  execution: CollectedToolExec,
): PersistedToolExecution {
  const batch = serializeCollectedToolExecutionBatch(execution);
  return {
    id: execution.id,
    tool: execution.tool,
    ...(execution.agent ? { agent: execution.agent } : {}),
    label: execution.label,
    status: execution.status,
    ...(execution.args ? { args: execution.args } : {}),
    ...(execution.result ? { result: execution.result } : {}),
    ...(execution.error ? { error: execution.error } : {}),
    ...(execution.stages ? { stages: execution.stages } : {}),
    ...(execution.logs ? { logs: execution.logs } : {}),
    ...(execution.previewText ? { previewText: execution.previewText } : {}),
    ...(typeof execution.previewChapterNumber === "number" ? { previewChapterNumber: execution.previewChapterNumber } : {}),
    ...(execution.previewKind === "patch" ? { previewKind: "patch" } : {}),
    ...(batch ? { batch } : {}),
    ...(execution.autoReview ? { autoReview: serializeCollectedToolExecutionAutoReview(execution.autoReview) } : {}),
    startedAt: execution.startedAt,
    ...(typeof execution.completedAt === "number" ? { completedAt: execution.completedAt } : {}),
  };
}

function serializeCollectedToolExecutions(
  executions: ReadonlyArray<CollectedToolExec>,
): PersistedToolExecution[] {
  return executions.map((execution) => serializeCollectedToolExecution(execution));
}

type CheckpointMessagePart =
  | { type: "thinking"; content: string; streaming: boolean }
  | { type: "text"; content: string }
  | { type: "tool"; execution: CollectedToolExec };

function findRunningCheckpointToolPart(
  parts: ReadonlyArray<CheckpointMessagePart>,
): (CheckpointMessagePart & { type: "tool" }) | undefined {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part?.type === "tool" && part.execution.status === "running") {
      return part;
    }
  }
  return undefined;
}

function findCheckpointToolPartById(
  parts: ReadonlyArray<CheckpointMessagePart>,
  toolCallId: string,
): (CheckpointMessagePart & { type: "tool" }) | undefined {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part?.type === "tool" && part.execution.id === toolCallId) {
      return part;
    }
  }
  return undefined;
}

function ensureCheckpointThinkingStart(
  parts: ReadonlyArray<CheckpointMessagePart>,
): CheckpointMessagePart[] {
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.type === "thinking" && last.streaming) {
    return next;
  }
  next.push({ type: "thinking", content: "", streaming: true });
  return next;
}

function appendCheckpointTextPart(
  parts: ReadonlyArray<CheckpointMessagePart>,
  text: string,
): CheckpointMessagePart[] {
  if (!text) return [...parts];
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, content: `${last.content}${text}` };
    return next;
  }
  next.push({ type: "text", content: text });
  return next;
}

function appendCheckpointThinkingDelta(
  parts: ReadonlyArray<CheckpointMessagePart>,
  text: string,
  streaming = true,
): CheckpointMessagePart[] {
  if (!text) return [...parts];
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.type === "thinking") {
    next[next.length - 1] = {
      ...last,
      content: `${last.content}${text}`,
      streaming: last.streaming || streaming,
    };
    return next;
  }
  next.push({ type: "thinking", content: text, streaming });
  return next;
}

function finalizeCheckpointThinkingParts(
  parts: ReadonlyArray<CheckpointMessagePart>,
): CheckpointMessagePart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type !== "thinking" || part.streaming !== true) return part;
    changed = true;
    return { ...part, streaming: false };
  });
  if (changed) return next;
  const latestThinkingIndex = [...next].reverse().findIndex((part) => part.type === "thinking");
  if (latestThinkingIndex < 0) return next;
  const actualIndex = next.length - 1 - latestThinkingIndex;
  if (actualIndex < 0 || actualIndex >= next.length) return next;
  const thinking = next[actualIndex];
  if (thinking?.type !== "thinking" || thinking.streaming !== true) return next;
  next[actualIndex] = { ...thinking, streaming: false };
  return next;
}

function appendCheckpointToolExecution(
  parts: ReadonlyArray<CheckpointMessagePart>,
  execution: CollectedToolExec,
): CheckpointMessagePart[] {
  const next = [...parts];
  const index = next.findIndex((part) => part.type === "tool" && part.execution.id === execution.id);
  if (index >= 0) {
    const existing = next[index];
    if (existing?.type === "tool") {
      next[index] = {
        type: "tool",
        execution: {
          ...existing.execution,
          ...execution,
          ...(existing.execution.logs?.length && !execution.logs ? { logs: existing.execution.logs } : {}),
          ...(existing.execution.batch && !execution.batch ? { batch: existing.execution.batch } : {}),
          ...(existing.execution.result && !execution.result ? { result: existing.execution.result } : {}),
          ...(existing.execution.error && !execution.error ? { error: existing.execution.error } : {}),
        },
      };
    }
    return next;
  }
  next.push({ type: "tool", execution });
  return next;
}

function appendCheckpointToolLogs(
  parts: ReadonlyArray<CheckpointMessagePart>,
  toolCallId: string,
  logs: ReadonlyArray<string>,
): CheckpointMessagePart[] {
  if (logs.length === 0) return [...parts];
  const next = [...parts];
  const index = next.findIndex((part) => part.type === "tool" && part.execution.id === toolCallId);
  if (index < 0) return next;
  const existing = next[index];
  if (existing?.type !== "tool") return next;
  next[index] = {
    type: "tool",
    execution: {
      ...existing.execution,
      logs: [...(existing.execution.logs ?? []), ...logs],
    },
  };
  return next;
}

function setCheckpointToolBatch(
  parts: ReadonlyArray<CheckpointMessagePart>,
  toolCallId: string,
  batch: NonNullable<CollectedToolExec["batch"]>,
): CheckpointMessagePart[] {
  const next = [...parts];
  const index = next.findIndex((part) => part.type === "tool" && part.execution.id === toolCallId);
  if (index < 0) return next;
  const existing = next[index];
  if (existing?.type !== "tool") return next;
  next[index] = {
    type: "tool",
    execution: {
      ...existing.execution,
      batch: {
        ...(existing.execution.batch ?? {}),
        ...batch,
        startedAt: existing.execution.batch?.startedAt ?? batch.startedAt,
      },
    },
  };
  return next;
}

function setCheckpointToolResult(
  parts: ReadonlyArray<CheckpointMessagePart>,
  toolCallId: string,
  result: string,
  isError: boolean,
): CheckpointMessagePart[] {
  const next = [...parts];
  const index = next.findIndex((part) => part.type === "tool" && part.execution.id === toolCallId);
  if (index < 0) return next;
  const existing = next[index];
  if (existing?.type !== "tool") return next;
  next[index] = {
    type: "tool",
    execution: {
      ...existing.execution,
      status: isError ? "error" : "completed",
      completedAt: Date.now(),
      stages: existing.execution.stages?.map((stage) => ({ ...stage, status: "completed" as const })),
      ...(isError ? { error: result } : { result }),
    },
  };
  return next;
}

function deriveCheckpointFlat(parts: ReadonlyArray<CheckpointMessagePart>): {
  content: string;
  thinking?: string;
  thinkingStreaming?: boolean;
  toolExecutions?: CollectedToolExec[];
} {
  let content = "";
  let thinking = "";
  let thinkingStreaming = false;
  const toolExecutions: CollectedToolExec[] = [];

  for (const part of parts) {
    if (part.type === "thinking") {
      if (thinking) thinking += "\n\n---\n\n";
      thinking += part.content;
      if (part.streaming) thinkingStreaming = true;
      continue;
    }
    if (part.type === "text") {
      content += part.content;
      continue;
    }
    toolExecutions.push(part.execution);
  }

  return {
    content,
    ...(thinking ? { thinking } : {}),
    ...(thinkingStreaming ? { thinkingStreaming: true } : {}),
    ...(toolExecutions.length > 0 ? { toolExecutions } : {}),
  };
}

function buildCheckpointAssistantMessage(args: {
  timestamp: number;
  parts: ReadonlyArray<CheckpointMessagePart>;
  terminal?: boolean;
  content?: string;
  thinking?: string;
}): Parameters<typeof upsertBookSessionMessage>[1] | null {
  const flat = deriveCheckpointFlat(args.parts);
  const hasThinkingPart = args.parts.some((part) => part.type === "thinking");
  const content = args.content ?? flat.content;
  const thinking = args.thinking ?? flat.thinking;
  const thinkingStreaming = args.terminal ? false : flat.thinkingStreaming;
  const hasBody = content.length > 0
    || Boolean(thinking)
    || Boolean(thinkingStreaming)
    || hasThinkingPart
    || (flat.toolExecutions?.length ?? 0) > 0;
  if (!hasBody) return null;
  return {
    role: "assistant",
    content,
    timestamp: args.timestamp,
    ...(thinking ? { thinking } : {}),
    ...(args.terminal
      ? { thinkingStreaming: false }
      : thinkingStreaming
        ? { thinkingStreaming: true }
        : {}),
    ...(flat.toolExecutions && flat.toolExecutions.length > 0
      ? { toolExecutions: serializeCollectedToolExecutions(flat.toolExecutions) }
      : {}),
  };
}

interface RunCheckpointWriter {
  handleEvent(event: string, data: unknown): void;
  flush(options?: { terminal?: boolean; content?: string; thinking?: string }): Promise<void>;
  dispose(): void;
}

function createRunCheckpointWriter(args: {
  projectRoot: string;
  sessionId: string;
  runId: string;
  assistantTimestamp: number;
  getSession: () => Awaited<ReturnType<typeof loadBookSession>> | null;
  setSession: (session: Awaited<ReturnType<typeof loadBookSession>>) => void;
}): RunCheckpointWriter {
  let parts: CheckpointMessagePart[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let dirty = false;
  let pendingFlushOptions: { terminal?: boolean; content?: string; thinking?: string } | null = null;

  const mergePendingFlushOptions = (options?: { terminal?: boolean; content?: string; thinking?: string }): void => {
    if (!options) return;
    pendingFlushOptions = {
      ...(pendingFlushOptions ?? {}),
      ...options,
      terminal: Boolean(pendingFlushOptions?.terminal || options.terminal),
    };
  };

  const buildSessionSnapshot = (): Awaited<ReturnType<typeof loadBookSession>> | null => {
    const message = buildCheckpointAssistantMessage({
      timestamp: args.assistantTimestamp,
      parts,
      ...(pendingFlushOptions?.terminal ? { terminal: true } : {}),
      ...(typeof pendingFlushOptions?.content === "string" ? { content: pendingFlushOptions.content } : {}),
      ...(typeof pendingFlushOptions?.thinking === "string" ? { thinking: pendingFlushOptions.thinking } : {}),
    });
    if (!message) return null;
    const session = args.getSession();
    if (!session) return null;
    return upsertBookSessionMessage(session, message);
  };

  const flush = async (options?: { terminal?: boolean; content?: string; thinking?: string }): Promise<void> => {
    mergePendingFlushOptions(options);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    dirty = true;
    if (flushing) return;
    flushing = true;
    try {
      while (dirty) {
        dirty = false;
        const snapshot = buildSessionSnapshot();
        pendingFlushOptions = null;
        if (!snapshot) continue;
        args.setSession(snapshot);
        await persistBookSession(args.projectRoot, snapshot);
      }
    } finally {
      flushing = false;
    }
  };

  const scheduleFlush = (options?: { terminal?: boolean; content?: string; thinking?: string }): void => {
    mergePendingFlushOptions(options);
    dirty = true;
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, 75);
  };

  const updateToolExecution = (toolCallId: string, updater: (execution: CollectedToolExec) => CollectedToolExec): void => {
    const next: CheckpointMessagePart[] = [];
    let updated = false;
    for (const part of parts) {
      if (part.type === "tool" && part.execution.id === toolCallId) {
        next.push({ type: "tool", execution: updater(part.execution) });
        updated = true;
      } else {
        next.push(part);
      }
    }
    if (updated) {
      parts = next;
    }
  };

  const ensureToolExecution = (payload: {
    toolCallId: string;
    tool: string;
    agent?: string;
    args?: Record<string, unknown>;
    stages?: ReadonlyArray<string>;
  }): CollectedToolExec => {
    const existing = findCheckpointToolPartById(parts, payload.toolCallId);
    if (existing?.type === "tool") return existing.execution;
    const execution: CollectedToolExec = {
      id: payload.toolCallId,
      tool: payload.tool,
      ...(payload.agent ? { agent: payload.agent } : {}),
      label: resolveToolLabel(payload.tool, payload.agent),
      status: "running",
      ...(payload.args ? { args: payload.args } : {}),
      ...(payload.stages?.length
        ? { stages: payload.stages.map((label) => ({ label, status: "pending" as const })) }
        : {}),
      startedAt: Date.now(),
    };
    parts = appendCheckpointToolExecution(parts, execution);
    return execution;
  };

  const handleThinkingStart = (): void => {
    parts = ensureCheckpointThinkingStart(parts);
    scheduleFlush();
  };

  const handleThinkingDelta = (text: string): void => {
    if (!text) return;
    parts = appendCheckpointThinkingDelta(parts, text, true);
    scheduleFlush();
  };

  const handleThinkingEnd = (): void => {
    parts = finalizeCheckpointThinkingParts(parts);
    scheduleFlush();
  };

  const handleDraftDelta = (text: string): void => {
    if (!text) return;
    parts = appendCheckpointTextPart(parts, text);
    scheduleFlush();
  };

  const handleToolStart = (data: {
    id?: unknown;
    tool?: unknown;
    args?: unknown;
    stages?: unknown;
  }): void => {
    const toolCallId = typeof data.id === "string" ? data.id : "";
    if (!toolCallId) return;
    const tool = typeof data.tool === "string" ? data.tool : "sub_agent";
    const agent = typeof (data.args as { agent?: unknown } | undefined)?.agent === "string"
      ? String((data.args as { agent?: unknown }).agent)
      : undefined;
    const argsRecord = data.args && typeof data.args === "object" && !Array.isArray(data.args)
      ? data.args as Record<string, unknown>
      : undefined;
    const stages = Array.isArray(data.stages) ? data.stages.filter((stage): stage is string => typeof stage === "string") : undefined;
    const execution = ensureToolExecution({
      toolCallId,
      tool,
      agent,
      args: argsRecord,
      stages,
    });
    updateToolExecution(toolCallId, (existing) => ({
      ...existing,
      ...execution,
      ...(existing.logs?.length ? { logs: existing.logs } : {}),
      ...(existing.batch ? { batch: existing.batch } : {}),
      ...(existing.result ? { result: existing.result } : {}),
      ...(existing.error ? { error: existing.error } : {}),
    }));
    scheduleFlush();
  };

  const handleToolUpdate = (data: {
    id?: unknown;
    tool?: unknown;
    args?: unknown;
    partialResult?: unknown;
  }): void => {
    const partialText = extractToolUpdateText(data.partialResult);
    if (!partialText) return;
    const requestedToolId = typeof data.id === "string" ? data.id : undefined;
    let targetToolId = requestedToolId ?? findRunningCheckpointToolPart(parts)?.execution.id;
    if (requestedToolId && !findCheckpointToolPartById(parts, requestedToolId)) {
      const execution = ensureToolExecution({
        toolCallId: requestedToolId,
        tool: typeof data.tool === "string" ? data.tool : "sub_agent",
        agent: typeof (data.args as { agent?: unknown } | undefined)?.agent === "string"
          ? String((data.args as { agent?: unknown }).agent)
          : undefined,
        args: data.args && typeof data.args === "object" && !Array.isArray(data.args)
          ? data.args as Record<string, unknown>
          : undefined,
      });
      targetToolId = execution.id;
    }
    if (!targetToolId) {
      const execution = ensureToolExecution({
        toolCallId: `telemetry-${args.runId}`,
        tool: typeof data.tool === "string" ? data.tool : "sub_agent",
        agent: typeof (data.args as { agent?: unknown } | undefined)?.agent === "string"
          ? String((data.args as { agent?: unknown }).agent)
          : undefined,
      });
      targetToolId = execution.id;
    }
    if (!targetToolId) return;
    parts = appendCheckpointToolLogs(parts, targetToolId, [partialText]);
    scheduleFlush();
  };

  const handleToolEnd = (data: {
    id?: unknown;
    tool?: unknown;
    args?: unknown;
    result?: unknown;
    isError?: unknown;
  }): void => {
    const toolCallId = typeof data.id === "string" ? data.id : "";
    if (!toolCallId) return;
    const resultText = data.isError ? extractToolError(data.result) : summarizeResult(data.result);
    const isError = Boolean(data.isError);
    if (!findCheckpointToolPartById(parts, toolCallId)) {
      ensureToolExecution({
        toolCallId,
        tool: typeof data.tool === "string" ? data.tool : "sub_agent",
        agent: typeof (data.args as { agent?: unknown } | undefined)?.agent === "string"
          ? String((data.args as { agent?: unknown }).agent)
          : undefined,
        args: data.args && typeof data.args === "object" && !Array.isArray(data.args)
          ? data.args as Record<string, unknown>
          : undefined,
      });
    }
    parts = setCheckpointToolResult(parts, toolCallId, resultText, isError);
    scheduleFlush();
  };

  const handleBatchProgress = (data: {
    id?: unknown;
    batchId?: unknown;
    status?: unknown;
    total?: unknown;
    completed?: unknown;
    elapsedMs?: unknown;
    currentChapter?: unknown;
    currentWords?: unknown;
    failedChapterNumber?: unknown;
    error?: unknown;
  }): void => {
    const toolCallId = typeof data.id === "string" ? data.id : findRunningCheckpointToolPart(parts)?.execution.id;
    if (!toolCallId) return;
    if (!findCheckpointToolPartById(parts, toolCallId)) {
      ensureToolExecution({
        toolCallId,
        tool: "sub_agent",
        agent: "writer",
      });
    }
    const batch: BatchProgressState = {
      batchId: typeof data.batchId === "string" && data.batchId.trim() ? data.batchId : `${args.runId}:${toolCallId}`,
      status: data.status === "completed"
        ? "completed"
        : data.status === "failed"
          ? "failed"
          : "running",
      total: Number.isFinite(Number(data.total)) ? Math.max(0, Math.trunc(Number(data.total))) : 0,
      completed: Number.isFinite(Number(data.completed)) ? Math.max(0, Math.trunc(Number(data.completed))) : 0,
      elapsedMs: Number.isFinite(Number(data.elapsedMs)) ? Math.max(0, Math.trunc(Number(data.elapsedMs))) : 0,
      startedAt: Date.now(),
      ...(typeof data.currentChapter === "number" && Number.isFinite(data.currentChapter)
        ? { currentChapter: Math.max(1, Math.trunc(data.currentChapter)) }
        : {}),
      ...(typeof data.currentWords === "number" && Number.isFinite(data.currentWords)
        ? { currentWords: Math.max(0, Math.trunc(data.currentWords)) }
        : {}),
      ...(typeof data.failedChapterNumber === "number" && Number.isFinite(data.failedChapterNumber)
        ? { failedChapterNumber: Math.max(1, Math.trunc(data.failedChapterNumber)) }
        : {}),
      ...(typeof data.error === "string" && data.error.trim()
        ? { error: data.error.trim() }
        : {}),
    };
    parts = setCheckpointToolBatch(parts, toolCallId, batch);
    scheduleFlush();
  };

  const handleEvent = (event: string, data: unknown): void => {
    if (!data || typeof data !== "object") return;
    const payload = data as { sessionId?: unknown; runId?: unknown };
    if (payload.sessionId !== args.sessionId) return;
    if (payload.runId !== args.runId) return;

    switch (event) {
      case "thinking:start":
        handleThinkingStart();
        break;
      case "thinking:delta":
        handleThinkingDelta(typeof (data as { text?: unknown }).text === "string" ? String((data as { text?: unknown }).text) : "");
        break;
      case "thinking:end":
        handleThinkingEnd();
        break;
      case "draft:delta":
        handleDraftDelta(typeof (data as { text?: unknown }).text === "string" ? String((data as { text?: unknown }).text) : "");
        break;
      case "chapter:delta":
        handleDraftDelta(typeof (data as { text?: unknown }).text === "string" ? String((data as { text?: unknown }).text) : "");
        break;
      case "tool:start":
        handleToolStart(data as { id?: unknown; tool?: unknown; args?: unknown; stages?: unknown });
        break;
      case "tool:update":
        handleToolUpdate(data as { id?: unknown; tool?: unknown; args?: unknown; partialResult?: unknown });
        break;
      case "tool:end":
        handleToolEnd(data as { id?: unknown; tool?: unknown; args?: unknown; result?: unknown; isError?: unknown });
        break;
      case "batch:progress":
        handleBatchProgress(data as {
          id?: unknown;
          batchId?: unknown;
          status?: unknown;
          total?: unknown;
          completed?: unknown;
          elapsedMs?: unknown;
          currentChapter?: unknown;
          currentWords?: unknown;
          failedChapterNumber?: unknown;
          error?: unknown;
        });
        break;
      default:
        break;
    }
  };

  const dispose = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  return {
    handleEvent,
    flush,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Audit tool report helpers
// ---------------------------------------------------------------------------

interface AuditIssueReport {
  severity: string;
  category: string;
  description: string;
  suggestion: string;
}

interface AuditToolReport {
  bookId?: string;
  chapterNumber: number;
  passed: boolean;
  issueCount: number;
  summary: string;
  issues: AuditIssueReport[];
}

function parseAuditToolReport(result: unknown): AuditToolReport | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as { details?: unknown };
  if (!payload.details || typeof payload.details !== "object") return null;
  const details = payload.details as {
    kind?: unknown;
    bookId?: unknown;
    chapterNumber?: unknown;
    passed?: unknown;
    issueCount?: unknown;
    summary?: unknown;
    issues?: unknown;
  };
  if (details.kind !== "audit_report") return null;
  if (typeof details.chapterNumber !== "number" || !Number.isFinite(details.chapterNumber)) return null;
  if (typeof details.passed !== "boolean") return null;
  const issues: AuditIssueReport[] = Array.isArray(details.issues)
    ? details.issues.filter((i): i is AuditIssueReport =>
      i && typeof i === "object" && typeof i.severity === "string")
    : [];
  return {
    bookId: typeof details.bookId === "string" ? details.bookId : undefined,
    chapterNumber: details.chapterNumber,
    passed: details.passed,
    issueCount: typeof details.issueCount === "number" && Number.isFinite(details.issueCount) ? details.issueCount : issues.length,
    summary: typeof details.summary === "string" ? details.summary : "",
    issues,
  };
}

function parseExplicitAuditChapter(instruction: string): number | null {
  const text = instruction.trim();
  const patterns = [
    /^\/audit\s+(\d+)\s*$/i,
    /^audit\s+chapter\s+(\d+)\s*$/i,
    /^审计第?\s*(\d+)\s*(?:章|章节)?\s*$/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const chapter = Number.parseInt(match[1], 10);
    if (Number.isInteger(chapter) && chapter > 0) return chapter;
  }
  return null;
}

function buildAuditInstruction(originalInstruction: string, chapter: number): string {
  return [
    `请执行审计第${chapter}章。`,
    '必须调用且仅调用一次 sub_agent 工具，agent="auditor"，并传入 chapterNumber。',
    "不要改写章节，不要调用 revise/rewrite 工具。",
    "基于工具输出，最后用中文给出完整审计报告：是否通过、summary、问题总数、逐条问题（严重级别/类别/描述/建议）。",
    `用户原始指令：${originalInstruction}`,
  ].join("\n");
}

function formatAuditReportForChat(report: AuditToolReport): string {
  const header = `第${report.chapterNumber}章审计${report.passed ? "通过" : "未通过"}（问题数：${report.issueCount}）`;
  const summary = report.summary.trim().length > 0 ? `摘要：${report.summary.trim()}` : "摘要：无";
  const issueLines = report.issues.length > 0
    ? report.issues.map((issue, index) =>
      `${index + 1}. [${issue.severity}] ${issue.category} - ${issue.description}`
      + (issue.suggestion.trim().length > 0 ? `；建议：${issue.suggestion}` : ""))
    : ["无问题。"];
  return [header, summary, "审计明细：", ...issueLines].join("\n");
}

interface BatchProgressState {
  batchId: string;
  status: "running" | "completed" | "failed";
  total: number;
  completed: number;
  elapsedMs: number;
  startedAt: number;
  currentChapter?: number;
  currentWords?: number;
  failedChapterNumber?: number;
  error?: string;
}

interface ChapterIndexEntryLike {
  number: number;
  title?: string;
  status?: string;
  wordCount?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface PersistCheckTelemetry {
  status: "started" | "completed";
  beforeCount: number;
  afterCount?: number;
  addedChapterNumbers?: number[];
  missingChapterFiles?: number[];
  persisted?: boolean;
}

interface PersistRepairTelemetry {
  status: "started" | "completed" | "failed" | "skipped";
  repairedChapterNumbers: number[];
  reason?: string;
}

interface WritePersistenceRepairResult {
  status: "completed" | "failed" | "skipped";
  repairedChapterNumbers: number[];
  reason?: string;
}

interface WritePersistenceCheckResult {
  persisted: boolean;
  beforeCount: number;
  afterCount: number;
  addedChapterNumbers: number[];
  missingChapterFiles: number[];
  repair: WritePersistenceRepairResult;
}

interface WriteDegradedRecoveryResult {
  attempted: boolean;
  attemptedChapterNumber?: number;
  recovered: boolean;
  remainingDegradedChapterNumbers: number[];
  reason?: string;
}

// --- Event bus for SSE ---

type EventHandler = (event: string, data: unknown) => void;
const subscribers = new Set<EventHandler>();
const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();

// 内存缓存：service -> 模型列表 + 更新时间戳；避免每次 sidebar 挂载时都打真实 LLM /models
const modelListCache = new Map<string, { models: Array<{ id: string; name: string; source?: "manual" | "detected" }>; at: number }>();

interface InFlightAgentRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly controller: AbortController;
  readonly startedAt: number;
}

const inFlightAgentRunsByRunId = new Map<string, InFlightAgentRun>();
const inFlightAgentRunIdBySession = new Map<string, string>();
const chapterDeltaSequenceByRunId = new Map<string, number>();

function createAgentRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function registerInFlightAgentRun(sessionId: string, runId: string, controller: AbortController): void {
  inFlightAgentRunsByRunId.set(runId, {
    sessionId,
    runId,
    controller,
    startedAt: Date.now(),
  });
  inFlightAgentRunIdBySession.set(sessionId, runId);
}

function clearInFlightAgentRun(sessionId: string, runId: string): void {
  const activeRunId = inFlightAgentRunIdBySession.get(sessionId);
  if (activeRunId === runId) {
    inFlightAgentRunIdBySession.delete(sessionId);
  }
  inFlightAgentRunsByRunId.delete(runId);
  chapterDeltaSequenceByRunId.delete(runId);
}

function nextChapterDeltaSequence(runId: string): number {
  const next = (chapterDeltaSequenceByRunId.get(runId) ?? 0) + 1;
  chapterDeltaSequenceByRunId.set(runId, next);
  return next;
}

interface ServiceConfigEntry {
  service: string;
  name?: string;
  models?: ServiceModelEntry[];
  modelMode?: "auto" | "manual" | "hybrid";
  preferredModel?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
}

interface ServiceModelEntry {
  id: string;
  name?: string;
  enabled?: boolean;
  source?: "manual" | "detected";
}

type LLMConfigSource = "env" | "studio";

interface EnvConfigSummary {
  detected: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
}

interface EnvConfigStatus {
  project: EnvConfigSummary;
  global: EnvConfigSummary;
  effectiveSource: "project" | "global" | null;
}

interface ServiceProbeResult {
  ok: boolean;
  models: Array<{ id: string; name: string }>;
  selectedModel?: string;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
  baseUrl?: string;
  modelsSource?: "api" | "fallback";
  error?: string;
}

function broadcast(event: string, data: unknown): void {
  for (const handler of subscribers) {
    handler(event, data);
  }
}

function isCustomServiceId(serviceId: string): boolean {
  return serviceId === "custom" || serviceId.startsWith("custom:");
}

function serviceConfigKey(entry: ServiceConfigEntry): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

function normalizeServiceModels(raw: unknown): ServiceModelEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id.trim() : "",
      ...(typeof entry.name === "string" && entry.name.trim().length > 0 ? { name: entry.name.trim() } : {}),
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      ...(entry.source === "manual" || entry.source === "detected" ? { source: entry.source as "manual" | "detected" } : {}),
    }))
    .filter((entry) => entry.id.length > 0);
}

function normalizeServiceModelsField(raw: unknown): { models: ServiceModelEntry[] } | Record<string, never> {
  if (!Array.isArray(raw)) return {};
  return { models: normalizeServiceModels(raw) };
}

function normalizeServiceEntry(serviceId: string, value: Record<string, unknown>): ServiceConfigEntry {
  if (serviceId.startsWith("custom:")) {
    return {
      service: "custom",
      name: decodeURIComponent(serviceId.slice("custom:".length)),
      ...normalizeServiceModelsField(value.models),
      ...(typeof value.modelMode === "string" && ["auto", "manual", "hybrid"].includes(value.modelMode) ? { modelMode: value.modelMode as "auto" | "manual" | "hybrid" } : {}),
      ...(typeof value.preferredModel === "string" && value.preferredModel.length > 0 ? { preferredModel: value.preferredModel } : {}),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  if (serviceId === "custom") {
    return {
      service: "custom",
      ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
      ...normalizeServiceModelsField(value.models),
      ...(typeof value.modelMode === "string" && ["auto", "manual", "hybrid"].includes(value.modelMode) ? { modelMode: value.modelMode as "auto" | "manual" | "hybrid" } : {}),
      ...(typeof value.preferredModel === "string" && value.preferredModel.length > 0 ? { preferredModel: value.preferredModel } : {}),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  return {
    service: serviceId,
    ...normalizeServiceModelsField(value.models),
    ...(typeof value.modelMode === "string" && ["auto", "manual", "hybrid"].includes(value.modelMode) ? { modelMode: value.modelMode as "auto" | "manual" | "hybrid" } : {}),
    ...(typeof value.preferredModel === "string" && value.preferredModel.length > 0 ? { preferredModel: value.preferredModel } : {}),
    ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
    ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
    ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
    ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
  };
}

function normalizeConfigSource(value: unknown): LLMConfigSource {
  return value === "studio" ? "studio" : "env";
}

function normalizeServiceConfig(raw: unknown): ServiceConfigEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        service: typeof entry.service === "string" && entry.service.length > 0 ? entry.service : "custom",
        ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
        ...normalizeServiceModelsField(entry.models),
        ...(typeof entry.modelMode === "string" && ["auto", "manual", "hybrid"].includes(entry.modelMode) ? { modelMode: entry.modelMode as "auto" | "manual" | "hybrid" } : {}),
        ...(typeof entry.preferredModel === "string" && entry.preferredModel.length > 0 ? { preferredModel: entry.preferredModel } : {}),
        ...(typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? { baseUrl: entry.baseUrl } : {}),
        ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
        ...(typeof entry.maxTokens === "number" ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.apiFormat === "chat" || entry.apiFormat === "responses" ? { apiFormat: entry.apiFormat } : {}),
        ...(typeof entry.stream === "boolean" ? { stream: entry.stream } : {}),
      }));
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value && typeof value === "object")
      .map(([serviceId, value]) => normalizeServiceEntry(serviceId, value as Record<string, unknown>));
  }

  return [];
}

function mergeServiceConfig(existing: ServiceConfigEntry[], updates: ServiceConfigEntry[]): ServiceConfigEntry[] {
  const merged = new Map(existing.map((entry) => [serviceConfigKey(entry), entry]));
  for (const update of updates) {
    const key = serviceConfigKey(update);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, update);
      continue;
    }
    merged.set(key, {
      ...current,
      ...update,
      ...(update.models !== undefined ? { models: update.models } : {}),
    });
  }
  return [...merged.values()];
}

function dedupeModelsById(
  models: Array<{ id: string; name: string; source?: "manual" | "detected" }>,
): Array<{ id: string; name: string; source?: "manual" | "detected" }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; name: string; source?: "manual" | "detected" }> = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...model, id });
  }
  return result;
}

function composeEffectiveModels(args: {
  mode: "auto" | "manual" | "hybrid";
  manualModels: Array<{ id: string; name: string; source?: "manual" | "detected" }>;
  detectedModels: Array<{ id: string; name: string; source?: "manual" | "detected" }>;
  disabledModelIds?: ReadonlySet<string>;
}): Array<{ id: string; name: string; source?: "manual" | "detected" }> {
  const disabledModelIds = args.disabledModelIds ?? new Set<string>();
  const manualModels = dedupeModelsById(args.manualModels)
    .filter((model) => !disabledModelIds.has(model.id));
  const detectedModels = dedupeModelsById(args.detectedModels)
    .filter((model) => !disabledModelIds.has(model.id));

  if (args.mode === "manual") {
    return manualModels;
  }
  if (args.mode === "auto") {
    return detectedModels;
  }
  return dedupeModelsById([...manualModels, ...detectedModels]);
}

function isReasonerLikeModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  if (/(reasoner|reasoning|thinking)/i.test(normalized)) return true;
  if (/\bdeepseek-r1\b/i.test(normalized)) return true;
  if (/\bo1\b|\bo3\b|\bo4-mini-high\b/i.test(normalized)) return true;
  return false;
}

function isWriteInstruction(instruction: string): boolean {
  const text = instruction.trim();
  if (!text) return false;
  if (/(审计|审核|audit|修订|重写|rewrite|revise|polish|rework|spot-fix|anti-detect)/i.test(text)) {
    return false;
  }
  return /(写下一章|下一章|连写|连续写|写第?\d+章|write next|next chapter|write\s+\d+\s+chapters?)/i.test(text);
}

function isWizardStepRequest(step: unknown): step is BookCreationWizardStep {
  return step === "intro"
    || step === "world"
    || step === "outline"
    || step === "volume"
    || step === "characters"
    || step === "arc"
    || step === "relation";
}

type DeterministicAgentAction =
  | { kind: "write-next" }
  | { kind: "write-batch"; chapterCount: number }
  | { kind: "write-target-chapter"; chapterNumber: number }
  | { kind: "audit"; chapterNumber: number }
  | { kind: "audit-latest" }
  | { kind: "audit-impacted" }
  | {
      kind: "revise";
      chapterNumber: number;
      mode: "spot-fix" | "polish" | "rework" | "anti-detect" | "rewrite";
    }
  | {
      kind: "revise-batch";
      startChapter: number;
      endChapter: number;
      chapterCount: number;
      mode: "rewrite";
    }
  | { kind: "rewrite-batch"; startChapter: number; endChapter: number; chapterCount: number }
  | { kind: "rewrite"; chapterNumber: number }
  | { kind: "repair-persistence"; chapterNumber?: number };

function extractChapterNumberFromInstruction(text: string): number | null {
  const normalizedText = normalizeChineseChapterNumerals(text);
  const zhWithDi = normalizedText.match(/第\s*(\d+)\s*章/i);
  if (zhWithDi?.[1]) {
    const value = parseInt(zhWithDi[1], 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const zhBare = normalizedText.match(/(?:^|\s)(\d+)\s*章(?:\s|$|[。.!！?？])/i);
  if (zhBare?.[1]) {
    const value = parseInt(zhBare[1], 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const en = normalizedText.match(/chapter\s*(\d+)/i);
  if (en?.[1]) {
    const value = parseInt(en[1], 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function parseChineseNumeralToken(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const direct = Number.parseInt(raw, 10);
    return Number.isFinite(direct) && direct > 0 ? direct : null;
  }
  if (!/^[零〇一二三四五六七八九十百千万两]+$/.test(raw)) return null;
  const digitMap: Record<string, number> = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
  };
  const unitMap: Record<string, number> = {
    "十": 10,
    "百": 100,
    "千": 1000,
    "万": 10000,
  };
  let total = 0;
  let section = 0;
  let current = 0;
  for (const ch of raw) {
    if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
      current = digitMap[ch]!;
      continue;
    }
    const unit = unitMap[ch];
    if (!unit) return null;
    if (unit === 10000) {
      section = (section + (current || 0)) * 10000;
      total += section;
      section = 0;
      current = 0;
      continue;
    }
    section += (current || 1) * unit;
    current = 0;
  }
  const value = total + section + current;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeChineseChapterNumerals(input: string): string {
  return input.replace(
    /第\s*([零〇一二三四五六七八九十百千万两\d]+)\s*章/gi,
    (full, token: string) => {
      const parsed = parseChineseNumeralToken(token);
      return parsed && parsed > 0 ? `第${parsed}章` : full;
    },
  );
}

function isRepairPersistenceInstruction(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const mentionsIndex = /(索引|index(?:\.json)?|chapter\s*index)/i.test(normalized);
  const mentionsPersist = /(落库|落盘|落地|正文文件|chapter file|persist(?:ed|ence)?)/i.test(normalized);
  const asksRepair = /(修复|补齐|补全|重建|创建|同步|恢复|校验|检查|没有|缺失|丢失|不存在|未落|没落)/i.test(normalized);
  return asksRepair && (mentionsIndex || mentionsPersist);
}

function hasBlockedToolCallMarker(text: string): boolean {
  if (!text.trim()) return false;
  return /tool_call\s*\[\s*blocked\s*\]/i.test(text)
    || /<\/?\s*minimax:tool_call\b/i.test(text)
    || /<\/?\s*[^>\s]*tool_call[^>]*>/i.test(text);
}

function parseDeterministicReviseMode(text: string): "spot-fix" | "polish" | "rework" | "anti-detect" {
  if (/(anti-detect|去ai味|去ai|反检测)/i.test(text)) return "anti-detect";
  if (/(polish|润色|精修)/i.test(text)) return "polish";
  if (/(rework|改写)/i.test(text)) return "rework";
  return "spot-fix";
}

function extractBriefFromReviseInstruction(instruction: string): string {
  const match = instruction.match(
    /^(?:(?:审计|审核)\s*并\s*)?(?:修订|修正|润色|精修|改写|修复)(?:第)?\s*\d+\s*章(?:[。.!！?？,，、；;:：])?\s*([\s\S]*)$/i,
  );
  return match?.[1]?.trim() ?? "";
}

function parseDeterministicAgentAction(instruction: string): DeterministicAgentAction | null {
  const text = normalizeChineseChapterNumerals(instruction.trim());
  if (!text) return null;

  if (/^(写下一章|下一章|write next(?: chapter)?|next chapter)$/i.test(text)) {
    return { kind: "write-next" };
  }

  const zhBatch = text.match(/^(?:连写|连续写)\s*(\d+)\s*章$/i);
  if (zhBatch?.[1]) {
    const chapterCount = parseInt(zhBatch[1], 10);
    if (Number.isFinite(chapterCount) && chapterCount > 0) {
      if (chapterCount === 1) return { kind: "write-next" };
      return { kind: "write-batch", chapterCount };
    }
  }
  const enBatch = text.match(/^(?:write|continue)\s*(\d+)\s*chapters?(?:\s+continuously)?$/i);
  if (enBatch?.[1]) {
    const chapterCount = parseInt(enBatch[1], 10);
    if (Number.isFinite(chapterCount) && chapterCount > 1) {
      return { kind: "write-batch", chapterCount };
    }
  }

  const zhWriteTarget = text.match(/^写(?:第)?\s*(\d+)\s*章[。.!！?？]?$/i);
  if (zhWriteTarget?.[1]) {
    const chapterNumber = parseInt(zhWriteTarget[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      // "写N章" is ambiguous in Chinese.
      // Keep small N as batch shorthand for historical behavior ("写2章"),
      // and treat larger N as a target chapter command ("写17章").
      if (!/第/i.test(text) && chapterNumber <= 9) {
        if (chapterNumber === 1) return { kind: "write-next" };
        return { kind: "write-batch", chapterCount: chapterNumber };
      }
      return { kind: "write-target-chapter", chapterNumber };
    }
  }

  const zhAudit = text.match(/^(?:审计|审核)(?:第)?\s*(\d+)\s*章[。.!！?？]?$/i);
  if (zhAudit?.[1]) {
    const chapterNumber = parseInt(zhAudit[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return { kind: "audit", chapterNumber };
    }
  }
  const enAudit = text.match(/^audit\s*(?:chapter)?\s*(\d+)\b(?:\s+.*)?$/i);
  if (enAudit?.[1]) {
    const chapterNumber = parseInt(enAudit[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return { kind: "audit", chapterNumber };
    }
  }
  if (/^(?:审计|审核|audit|review)(?:[。.!！?？])?$/i.test(text)) {
    return { kind: "audit-latest" };
  }
  if (/^(?:批量)?审计(?:受影响|待复核)(?:章节)?(?:[。.!！?？,，、；;:：]?\s*.*)?$/i.test(text)) {
    return { kind: "audit-impacted" };
  }
  if (/^(?:audit|review)\s*(?:impacted|affected|pending review)\s*chapters?(?:\s+.*)?$/i.test(text)) {
    return { kind: "audit-impacted" };
  }

  if (isRepairPersistenceInstruction(text)) {
    const chapterNumber = extractChapterNumberFromInstruction(text);
    return chapterNumber
      ? { kind: "repair-persistence", chapterNumber }
      : { kind: "repair-persistence" };
  }

  const zhRevise = text.match(/^(?:(?:审计|审核)\s*并\s*)?(?:修订|修正|润色|精修|改写|修复)(?:第)?\s*(\d+)\s*章(?:[。.!！?？,，、；;:：]?\s*[\s\S]*)?$/i);
  if (zhRevise?.[1]) {
    const chapterNumber = parseInt(zhRevise[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return {
        kind: "revise",
        chapterNumber,
        mode: parseDeterministicReviseMode(text),
      };
    }
  }
  const enRevise = text.match(/^(?:revise|polish|spot-fix|anti-detect)\s*(?:chapter)?\s*(\d+)(?:\s+.*)?$/i);
  if (enRevise?.[1]) {
    const chapterNumber = parseInt(enRevise[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return {
        kind: "revise",
        chapterNumber,
        mode: parseDeterministicReviseMode(text),
      };
    }
  }

  const zhRewriteBatchDestructive = text.match(
    /^重写(?:第)?\s*(\d+)\s*(?:章)?\s*(?:-|~|～|到|至)\s*(?:第)?\s*(\d+)\s*章(?:并|且)?(?:回滚|撤销|删除)后续(?:章节)?(?:[。.!！?？,，、；;:：]?\s*.*)?$/i,
  );
  if (zhRewriteBatchDestructive?.[1] && zhRewriteBatchDestructive?.[2]) {
    const startChapter = parseInt(zhRewriteBatchDestructive[1], 10);
    const endChapter = parseInt(zhRewriteBatchDestructive[2], 10);
    if (
      Number.isFinite(startChapter)
      && Number.isFinite(endChapter)
      && startChapter > 0
      && endChapter >= startChapter
    ) {
      if (startChapter === endChapter) {
        return { kind: "rewrite", chapterNumber: startChapter };
      }
      return {
        kind: "rewrite-batch",
        startChapter,
        endChapter,
        chapterCount: endChapter - startChapter + 1,
      };
    }
  }
  const enRewriteBatchDestructive = text.match(
    /^(?:rewrite|rework)\s*(?:chapters?)?\s*(\d+)\s*(?:-|to)\s*(\d+)\s*(?:and|with)?\s*(?:rollback|delete|remove)\s*(?:following|subsequent)\s*(?:chapters?)?(?:\s+.*)?$/i,
  );
  if (enRewriteBatchDestructive?.[1] && enRewriteBatchDestructive?.[2]) {
    const startChapter = parseInt(enRewriteBatchDestructive[1], 10);
    const endChapter = parseInt(enRewriteBatchDestructive[2], 10);
    if (
      Number.isFinite(startChapter)
      && Number.isFinite(endChapter)
      && startChapter > 0
      && endChapter >= startChapter
    ) {
      if (startChapter === endChapter) {
        return { kind: "rewrite", chapterNumber: startChapter };
      }
      return {
        kind: "rewrite-batch",
        startChapter,
        endChapter,
        chapterCount: endChapter - startChapter + 1,
      };
    }
  }

  const zhRewriteSingleDestructive = text.match(
    /^重写(?:第)?\s*(\d+)\s*章(?:并|且)?(?:回滚|撤销|删除)后续(?:章节)?(?:[。.!！?？,，、；;:：]?\s*.*)?$/i,
  );
  if (zhRewriteSingleDestructive?.[1]) {
    const chapterNumber = parseInt(zhRewriteSingleDestructive[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return { kind: "rewrite", chapterNumber };
    }
  }
  const zhRewriteFromChapterDestructive = text.match(
    /^从第\s*(\d+)\s*章开始重写后续(?:章节)?(?:[。.!！?？,，、；;:：]?\s*.*)?$/i,
  );
  if (zhRewriteFromChapterDestructive?.[1]) {
    const chapterNumber = parseInt(zhRewriteFromChapterDestructive[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return { kind: "rewrite", chapterNumber };
    }
  }
  const enRewriteSingleDestructive = text.match(
    /^(?:rewrite|rework)\s*(?:chapter)?\s*(\d+)\s*(?:and|with)?\s*(?:rollback|delete|remove)\s*(?:following|subsequent)\s*(?:chapters?)?(?:\s+.*)?$/i,
  );
  if (enRewriteSingleDestructive?.[1]) {
    const chapterNumber = parseInt(enRewriteSingleDestructive[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return { kind: "rewrite", chapterNumber };
    }
  }

  const zhRewriteBatch = text.match(
    /^重写(?:第)?\s*(\d+)\s*(?:章)?\s*(?:-|~|～|到|至)\s*(?:第)?\s*(\d+)\s*章(?:[。.!！?？,，、；;:：]?\s*.*)?$/i,
  );
  if (zhRewriteBatch?.[1] && zhRewriteBatch?.[2]) {
    const startChapter = parseInt(zhRewriteBatch[1], 10);
    const endChapter = parseInt(zhRewriteBatch[2], 10);
    if (
      Number.isFinite(startChapter)
      && Number.isFinite(endChapter)
      && startChapter > 0
      && endChapter >= startChapter
    ) {
      if (startChapter === endChapter) {
        return { kind: "revise", chapterNumber: startChapter, mode: "rewrite" };
      }
      return {
        kind: "revise-batch",
        startChapter,
        endChapter,
        chapterCount: endChapter - startChapter + 1,
        mode: "rewrite",
      };
    }
  }
  const enRewriteBatch = text.match(
    /^(?:rewrite|rework)\s*(?:chapters?)?\s*(\d+)\s*(?:-|to)\s*(\d+)(?:\s+.*)?$/i,
  );
  if (enRewriteBatch?.[1] && enRewriteBatch?.[2]) {
    const startChapter = parseInt(enRewriteBatch[1], 10);
    const endChapter = parseInt(enRewriteBatch[2], 10);
    if (
      Number.isFinite(startChapter)
      && Number.isFinite(endChapter)
      && startChapter > 0
      && endChapter >= startChapter
    ) {
      if (startChapter === endChapter) {
        return { kind: "revise", chapterNumber: startChapter, mode: "rewrite" };
      }
      return {
        kind: "revise-batch",
        startChapter,
        endChapter,
        chapterCount: endChapter - startChapter + 1,
        mode: "rewrite",
      };
    }
  }

  const zhRewrite = text.match(/^重写(?:第)?\s*(\d+)\s*章(?:[。.!！?？,，、；;:：]?\s*.*)?$/i);
  if (zhRewrite?.[1]) {
    const chapterNumber = parseInt(zhRewrite[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return { kind: "revise", chapterNumber, mode: "rewrite" };
    }
  }
  const enRewrite = text.match(/^(?:rewrite|rework)\s*(?:chapter)?\s*(\d+)(?:\s+.*)?$/i);
  if (enRewrite?.[1]) {
    const chapterNumber = parseInt(enRewrite[1], 10);
    if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
      return { kind: "revise", chapterNumber, mode: "rewrite" };
    }
  }

  return null;
}

async function resolveAuditTargetChapterNumber(args: {
  state: StateManager;
  bookId: string;
  explicitChapterNumber?: number;
}): Promise<number> {
  if (typeof args.explicitChapterNumber === "number" && Number.isFinite(args.explicitChapterNumber) && args.explicitChapterNumber > 0) {
    return Math.trunc(args.explicitChapterNumber);
  }
  const index = await args.state.loadChapterIndex(args.bookId).catch(() => [] as Array<{ number?: unknown }>);
  const indexedNumbers = index
    .map((item) => Number(item.number))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
  if (indexedNumbers.length > 0) {
    return Math.max(...indexedNumbers);
  }
  const nextChapter = await args.state.getNextChapterNumber(args.bookId).catch(() => 1);
  const latestChapter = Number.isFinite(Number(nextChapter)) ? Math.trunc(Number(nextChapter)) - 1 : 0;
  if (latestChapter > 0) return latestChapter;
  throw new Error("No chapters to audit.");
}

function pickFastWriterModelFromEntry(
  entry: ServiceConfigEntry | undefined,
  currentModel: string,
): string | null {
  const enabledModels = normalizeServiceModels(entry?.models ?? [])
    .filter((model) => model.enabled !== false)
    .map((model) => model.id.trim())
    .filter(Boolean);
  if (enabledModels.length === 0) return null;
  const candidates = enabledModels.filter((id) => !isReasonerLikeModel(id) && id !== currentModel);
  if (candidates.length === 0) return null;
  const prioritized = [...candidates].sort((left, right) => {
    const score = (value: string): number => {
      const lower = value.toLowerCase();
      let result = 0;
      if (/(chat|turbo|flash|mini|haiku|sonnet|gpt-4o|gpt-4\.1|deepseek-chat)/i.test(lower)) result += 5;
      if (/(instruct|base|embedding|rerank|vision)/i.test(lower)) result -= 3;
      return result;
    };
    return score(right) - score(left);
  });
  return prioritized[0] ?? null;
}

function resolveFastWriterModelSelection(args: {
  readonly services: ReadonlyArray<ServiceConfigEntry>;
  readonly currentModel?: string;
  readonly preferredServiceKey?: string;
}): { serviceKey: string; model: string } | null {
  const currentModel = args.currentModel?.trim();
  if (!currentModel || !isReasonerLikeModel(currentModel)) return null;
  const normalizedServices = [...args.services];
  if (normalizedServices.length === 0) return null;

  const pickByModelMembership = (entry: ServiceConfigEntry): boolean => {
    const models = normalizeServiceModels(entry.models ?? []);
    if (models.some((model) => model.id.trim() === currentModel)) return true;
    if (entry.preferredModel?.trim() === currentModel) return true;
    return false;
  };

  const preferred = args.preferredServiceKey
    ? normalizedServices.find((entry) => serviceConfigKey(entry) === args.preferredServiceKey)
    : undefined;
  const matched = preferred
    ?? normalizedServices.find((entry) => pickByModelMembership(entry))
    ?? normalizedServices[0];
  if (!matched) return null;

  const fastModel = pickFastWriterModelFromEntry(matched, currentModel);
  if (!fastModel) return null;
  return {
    serviceKey: serviceConfigKey(matched),
    model: fastModel,
  };
}

async function loadRawConfig(root: string): Promise<Record<string, unknown>> {
  const configPath = join(root, "inkos.json");
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function saveRawConfig(root: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "inkos.json"), JSON.stringify(config, null, 2), "utf-8");
}

async function readEnvConfigSummary(path: string): Promise<EnvConfigSummary> {
  try {
    const raw = await readFile(path, "utf-8");
    const values = new Map<string, string>();

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      values.set(key, value.trim());
    }

    const provider = values.get("INKOS_LLM_PROVIDER") ?? null;
    const baseUrl = values.get("INKOS_LLM_BASE_URL") ?? null;
    const model = values.get("INKOS_LLM_MODEL") ?? null;
    const apiKey = values.get("INKOS_LLM_API_KEY") ?? "";
    const detected = Boolean(provider || baseUrl || model || apiKey);

    return {
      detected,
      provider,
      baseUrl,
      model,
      hasApiKey: apiKey.length > 0,
    };
  } catch {
    return {
      detected: false,
      provider: null,
      baseUrl: null,
      model: null,
      hasApiKey: false,
    };
  }
}

async function readEnvConfigStatus(root: string): Promise<EnvConfigStatus> {
  const project = await readEnvConfigSummary(join(root, ".env"));
  const global = await readEnvConfigSummary(GLOBAL_ENV_PATH);
  return {
    project,
    global,
    effectiveSource: project.detected ? "project" : global.detected ? "global" : null,
  };
}

async function resolveConfiguredServiceBaseUrl(root: string, serviceId: string, inlineBaseUrl?: string): Promise<string | undefined> {
  if (inlineBaseUrl?.trim()) return inlineBaseUrl.trim();

  if (!isCustomServiceId(serviceId)) {
    return resolveServicePreset(serviceId)?.baseUrl;
  }

  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
    const matched = services.find((entry) => serviceConfigKey(entry) === serviceId);
    return matched?.baseUrl;
  } catch {
    return undefined;
  }
}

async function resolveConfiguredServiceEntry(root: string, serviceId: string): Promise<ServiceConfigEntry | undefined> {
  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
    return services.find((entry) => serviceConfigKey(entry) === serviceId);
  } catch {
    return undefined;
  }
}

function buildProbePlans(
  preferredApiFormat: "chat" | "responses" | undefined,
  preferredStream: boolean | undefined,
): Array<{ apiFormat: "chat" | "responses"; stream: boolean }> {
  const candidates: Array<{ apiFormat: "chat" | "responses"; stream: boolean }> = [];
  const seen = new Set<string>();
  const push = (apiFormat: "chat" | "responses", stream: boolean) => {
    const key = `${apiFormat}:${stream ? "1" : "0"}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ apiFormat, stream });
  };

  if (preferredApiFormat) {
    push(preferredApiFormat, preferredStream ?? false);
    push(preferredApiFormat, !(preferredStream ?? false));
  }
  const alternate = preferredApiFormat === "responses" ? "chat" : "responses";
  push(alternate, false);
  push(alternate, true);
  push("chat", false);
  push("chat", true);
  push("responses", false);
  push("responses", true);
  return candidates;
}

function buildModelCandidates(args: {
  preferredModel?: string;
  configModel?: string;
  envModel?: string | null;
  discoveredModels: Array<{ id: string; name: string }>;
}): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value || value.trim().length === 0) return;
    const id = value.trim();
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push(id);
  };

  push(args.preferredModel);
  push(args.configModel);
  push(args.envModel ?? undefined);
  for (const model of args.discoveredModels) push(model.id);
  push("gpt-5.4");
  push("gpt-4o");
  push("claude-sonnet-4-6");
  push("MiniMax-M2.7");
  push("kimi-k2.5");
  return candidates;
}

async function fetchModelsFromServiceBaseUrl(
  serviceId: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ models: Array<{ id: string; name: string }>; error?: string; authFailed?: boolean }> {
  const modelsBaseUrl = isCustomServiceId(serviceId)
    ? baseUrl
    : resolveServiceModelsBaseUrl(serviceId) ?? baseUrl;
  const modelsUrl = modelsBaseUrl.replace(/\/$/, "") + "/models";
  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        models: [],
        error: `服务商返回 ${res.status}: ${body.slice(0, 200)}`,
        authFailed: res.status === 401 || res.status === 403,
      };
    }
    const json = await res.json() as { data?: Array<{ id: string }> };
    return {
      models: (json.data ?? []).map((m) => ({ id: m.id, name: m.id })),
    };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function elapsedSince(startedAt: number): number {
  return Math.max(1, Date.now() - startedAt);
}

function parseChapterFileNumber(fileName: string): number | null {
  const match = fileName.match(/^(\d+)_.*\.md$/i);
  if (!match?.[1]) return null;
  const chapterNumber = parseInt(match[1], 10);
  if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) return null;
  return chapterNumber;
}

function normalizeChapterIndexEntries(index: unknown): ChapterIndexEntryLike[] {
  if (!Array.isArray(index)) return [];
  return index.filter((entry): entry is ChapterIndexEntryLike => Boolean(entry) && typeof entry === "object");
}

function uniqueSortedChapterNumbers(values: ReadonlyArray<number>): number[] {
  return [...new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  )].sort((left, right) => left - right);
}

const REWRITE_IMPACT_NOTE_PREFIX = "[rewrite-impact]";

interface RewriteImpactSummary {
  affectedChapterNumbers: number[];
  affectedCount: number;
  startChapter?: number;
  endChapter?: number;
}

interface RewriteRiskSummary {
  rollbackTarget: number;
  discardedChapterNumbers: number[];
  discardedCount: number;
  message: string;
}

interface NonDestructiveRewriteBaseline {
  pivotChapter: number;
  downstreamIndexChapterNumbers: number[];
  downstreamFileChapterNumbers: number[];
  downstreamSnapshotChapterNumbers: number[];
}

interface NonDestructiveRewriteRegression {
  missingIndexChapterNumbers: number[];
  missingFileChapterNumbers: number[];
  missingSnapshotChapterNumbers: number[];
}

function isRewriteImpactNote(note: unknown): boolean {
  return typeof note === "string" && note.trim().startsWith(REWRITE_IMPACT_NOTE_PREFIX);
}

function isTruthyToggle(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function isDestructiveRewriteEnabled(): boolean {
  return isTruthyToggle(process.env.INKOS_ENABLE_DESTRUCTIVE_REWRITE);
}

function assertDestructiveRewriteEnabled(): void {
  if (isDestructiveRewriteEnabled()) return;
  throw new ApiError(
    403,
    "AGENT_DESTRUCTIVE_REWRITE_DISABLED",
    "危险重写模式默认关闭（仅高级用户可用）。请先设置环境变量 INKOS_ENABLE_DESTRUCTIVE_REWRITE=true 并重启 Studio。",
  );
}

function buildRewriteImpactNote(pivotChapter: number): string {
  return `${REWRITE_IMPACT_NOTE_PREFIX} 上游第${pivotChapter}章已重写，请复核本章与上游衔接。`;
}

function formatRewriteImpactSummary(summary: RewriteImpactSummary): string {
  if (summary.affectedCount <= 0) {
    return "后续章节已保留，当前没有需要标记的受影响章节。";
  }
  const startChapter = summary.startChapter ?? summary.affectedChapterNumbers[0];
  const endChapter = summary.endChapter ?? summary.affectedChapterNumbers.at(-1);
  if (!startChapter || !endChapter) {
    return "后续章节已保留，已标记受影响章节为待复核。";
  }
  if (startChapter === endChapter) {
    return `后续章节已保留，已将第${startChapter}章标记为待复核（共1章）。`;
  }
  return `后续章节已保留，已将第${startChapter}-${endChapter}章标记为待复核（共${summary.affectedCount}章）。`;
}

function buildRewriteRiskMessage(summary: RewriteRiskSummary): string {
  if (summary.discardedCount <= 0) {
    return `风险提示：将回滚到第${summary.rollbackTarget}章，当前未检测到会被删除的后续章节。`;
  }
  const first = summary.discardedChapterNumbers[0];
  const last = summary.discardedChapterNumbers.at(-1);
  if (first && last && first !== last) {
    return `风险提示：将回滚到第${summary.rollbackTarget}章，预计删除第${first}-${last}章（共${summary.discardedCount}章）。`;
  }
  const only = first ?? summary.discardedChapterNumbers[0];
  return `风险提示：将回滚到第${summary.rollbackTarget}章，预计删除第${only ?? "?"}章（共${summary.discardedCount}章）。`;
}

function compactInstructionForAuditLog(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

async function collectRewriteImpactChapterNumbers(args: {
  readonly state: StateManager;
  readonly bookId: string;
}): Promise<number[]> {
  const indexRaw = await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]);
  const index = normalizeChapterIndexEntries(indexRaw);
  return uniqueSortedChapterNumbers(
    index
      .map((entry) => {
        const chapterNumber = Number(entry?.number);
        if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) return NaN;
        return isRewriteImpactNote(entry.reviewNote) ? chapterNumber : NaN;
      })
      .filter((value) => Number.isFinite(value) && value > 0),
  );
}

async function clearRewriteImpactNotes(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly chapterNumbers: ReadonlyArray<number>;
}): Promise<void> {
  const normalizedTargets = new Set(uniqueSortedChapterNumbers(args.chapterNumbers));
  if (normalizedTargets.size === 0) return;
  const indexRaw = await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]);
  const index = normalizeChapterIndexEntries(indexRaw);
  if (index.length === 0) return;
  const nowIso = new Date().toISOString();
  let changed = false;
  const updated = index.map((entry) => {
    const chapterNumber = Number(entry?.number);
    if (!Number.isFinite(chapterNumber) || chapterNumber <= 0 || !normalizedTargets.has(chapterNumber)) {
      return entry;
    }
    if (!isRewriteImpactNote(entry.reviewNote)) return entry;
    const { reviewNote: _ignore, ...rest } = entry;
    changed = true;
    return {
      ...rest,
      updatedAt: nowIso,
    };
  });
  if (changed) {
    await args.state.saveChapterIndex(args.bookId, updated as any);
  }
}

async function buildRewriteRiskSummary(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly rollbackTarget: number;
}): Promise<RewriteRiskSummary> {
  const indexRaw = await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]);
  return buildRewriteRiskSummaryFromIndex({
    index: normalizeChapterIndexEntries(indexRaw),
    rollbackTarget: args.rollbackTarget,
  });
}

function buildRewriteRiskSummaryFromIndex(args: {
  readonly index: ReadonlyArray<ChapterIndexEntryLike>;
  readonly rollbackTarget: number;
}): RewriteRiskSummary {
  const discardedChapterNumbers = uniqueSortedChapterNumbers(
    args.index
      .map((entry) => Number(entry?.number))
      .filter((chapterNumber) => Number.isFinite(chapterNumber) && chapterNumber > args.rollbackTarget),
  );
  const summary: RewriteRiskSummary = {
    rollbackTarget: args.rollbackTarget,
    discardedChapterNumbers,
    discardedCount: discardedChapterNumbers.length,
    message: "",
  };
  summary.message = buildRewriteRiskMessage(summary);
  return summary;
}

async function collectChapterFileNumbers(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly minimumChapterNumber: number;
}): Promise<number[]> {
  const chaptersDir = join(args.state.bookDir(args.bookId), "chapters");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  return uniqueSortedChapterNumbers(
    files
      .map((fileName) => parseChapterFileNumber(fileName) ?? NaN)
      .filter((chapterNumber) => Number.isFinite(chapterNumber) && chapterNumber > args.minimumChapterNumber),
  );
}

async function collectSnapshotChapterNumbers(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly minimumChapterNumber: number;
}): Promise<number[]> {
  const snapshotsDir = join(args.state.bookDir(args.bookId), "story", "snapshots");
  const snapshotDirs = await readdir(snapshotsDir).catch(() => [] as string[]);
  return uniqueSortedChapterNumbers(
    snapshotDirs
      .map((segment) => Number.parseInt(segment, 10))
      .filter((chapterNumber) => Number.isFinite(chapterNumber) && chapterNumber > args.minimumChapterNumber),
  );
}

async function buildNonDestructiveRewriteBaseline(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly pivotChapter: number;
  readonly beforeIndex?: ReadonlyArray<ChapterIndexEntryLike>;
}): Promise<NonDestructiveRewriteBaseline> {
  const beforeIndex = normalizeChapterIndexEntries(
    args.beforeIndex ?? await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]),
  );
  const downstreamIndexChapterNumbers = uniqueSortedChapterNumbers(
    beforeIndex
      .map((entry) => Number(entry?.number))
      .filter((chapterNumber) => Number.isFinite(chapterNumber) && chapterNumber > args.pivotChapter),
  );
  const [downstreamFileChapterNumbers, downstreamSnapshotChapterNumbers] = await Promise.all([
    collectChapterFileNumbers({
      state: args.state,
      bookId: args.bookId,
      minimumChapterNumber: args.pivotChapter,
    }),
    collectSnapshotChapterNumbers({
      state: args.state,
      bookId: args.bookId,
      minimumChapterNumber: args.pivotChapter,
    }),
  ]);
  return {
    pivotChapter: args.pivotChapter,
    downstreamIndexChapterNumbers,
    downstreamFileChapterNumbers,
    downstreamSnapshotChapterNumbers,
  };
}

async function detectNonDestructiveRewriteRegression(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly baseline: NonDestructiveRewriteBaseline;
  readonly afterIndex?: ReadonlyArray<ChapterIndexEntryLike>;
}): Promise<NonDestructiveRewriteRegression> {
  const afterIndex = normalizeChapterIndexEntries(
    args.afterIndex ?? await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]),
  );
  const afterIndexNumbers = new Set(
    afterIndex
      .map((entry) => Number(entry?.number))
      .filter((chapterNumber) => Number.isFinite(chapterNumber) && chapterNumber > args.baseline.pivotChapter),
  );
  const [afterFileChapterNumbers, afterSnapshotChapterNumbers] = await Promise.all([
    collectChapterFileNumbers({
      state: args.state,
      bookId: args.bookId,
      minimumChapterNumber: args.baseline.pivotChapter,
    }),
    collectSnapshotChapterNumbers({
      state: args.state,
      bookId: args.bookId,
      minimumChapterNumber: args.baseline.pivotChapter,
    }),
  ]);
  const afterFileNumbers = new Set(afterFileChapterNumbers);
  const afterSnapshotNumbers = new Set(afterSnapshotChapterNumbers);
  return {
    missingIndexChapterNumbers: args.baseline.downstreamIndexChapterNumbers
      .filter((chapterNumber) => !afterIndexNumbers.has(chapterNumber)),
    missingFileChapterNumbers: args.baseline.downstreamFileChapterNumbers
      .filter((chapterNumber) => !afterFileNumbers.has(chapterNumber)),
    missingSnapshotChapterNumbers: args.baseline.downstreamSnapshotChapterNumbers
      .filter((chapterNumber) => !afterSnapshotNumbers.has(chapterNumber)),
  };
}

function formatChapterNumberList(chapterNumbers: ReadonlyArray<number>): string {
  return chapterNumbers.map((chapterNumber) => `第${chapterNumber}章`).join("、");
}

function createNonDestructiveRewriteRegressionError(args: {
  readonly regression: NonDestructiveRewriteRegression;
}): ApiError {
  const reasons: string[] = [];
  if (args.regression.missingIndexChapterNumbers.length > 0) {
    reasons.push(`章节索引缺失：${formatChapterNumberList(args.regression.missingIndexChapterNumbers)}`);
  }
  if (args.regression.missingFileChapterNumbers.length > 0) {
    reasons.push(`章节正文缺失：${formatChapterNumberList(args.regression.missingFileChapterNumbers)}`);
  }
  if (args.regression.missingSnapshotChapterNumbers.length > 0) {
    reasons.push(`章节快照缺失：${formatChapterNumberList(args.regression.missingSnapshotChapterNumbers)}`);
  }
  return new ApiError(
    409,
    "AGENT_REWRITE_CONSISTENCY_REGRESSION",
    `非破坏重写一致性校验失败：${reasons.join("；")}。请先修复后再继续。`,
  );
}

async function enforceNonDestructiveRewriteConsistency(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly baseline: NonDestructiveRewriteBaseline;
  readonly afterIndex?: ReadonlyArray<ChapterIndexEntryLike>;
}): Promise<void> {
  const regression = await detectNonDestructiveRewriteRegression({
    state: args.state,
    bookId: args.bookId,
    baseline: args.baseline,
    afterIndex: args.afterIndex,
  });
  if (
    regression.missingIndexChapterNumbers.length === 0
    && regression.missingFileChapterNumbers.length === 0
    && regression.missingSnapshotChapterNumbers.length === 0
  ) {
    return;
  }
  throw createNonDestructiveRewriteRegressionError({ regression });
}

async function markDownstreamChaptersForReview(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly pivotChapter: number;
  readonly rewrittenStartChapter: number;
  readonly rewrittenEndChapter: number;
}): Promise<RewriteImpactSummary> {
  const indexRaw = await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]);
  const index = normalizeChapterIndexEntries(indexRaw);
  if (index.length === 0) {
    return {
      affectedChapterNumbers: [],
      affectedCount: 0,
    };
  }

  const nowIso = new Date().toISOString();
  const impactNote = buildRewriteImpactNote(args.pivotChapter);
  const affectedChapterNumbers: number[] = [];
  let changed = false;

  const updated = index.map((entry) => {
    const chapterNumber = Number(entry?.number);
    if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) return entry;
    const reviewNote = typeof entry.reviewNote === "string" ? entry.reviewNote.trim() : "";

    if (chapterNumber >= args.rewrittenStartChapter && chapterNumber <= args.rewrittenEndChapter) {
      if (isRewriteImpactNote(reviewNote)) {
        const { reviewNote: _ignore, ...rest } = entry;
        changed = true;
        return { ...rest, updatedAt: nowIso };
      }
      return entry;
    }

    if (chapterNumber > args.pivotChapter) {
      affectedChapterNumbers.push(chapterNumber);
      if (reviewNote !== impactNote) {
        changed = true;
        return {
          ...entry,
          reviewNote: impactNote,
          updatedAt: nowIso,
        };
      }
    }
    return entry;
  });

  if (changed) {
    await args.state.saveChapterIndex(args.bookId, updated as any);
  }

  const uniqueAffected = uniqueSortedChapterNumbers(affectedChapterNumbers);
  return {
    affectedChapterNumbers: uniqueAffected,
    affectedCount: uniqueAffected.length,
    ...(uniqueAffected.length > 0
      ? { startChapter: uniqueAffected[0], endChapter: uniqueAffected.at(-1) }
      : {}),
  };
}

function detectDegradedChapterNumbersFromIndex(args: {
  readonly index: ReadonlyArray<ChapterIndexEntryLike>;
  readonly chapterNumbers: ReadonlyArray<number>;
}): number[] {
  const chapterSet = new Set(uniqueSortedChapterNumbers(args.chapterNumbers));
  if (chapterSet.size === 0) return [];
  const degraded = new Set<number>();
  for (const entry of args.index) {
    const chapterNumber = Number(entry?.number);
    if (!Number.isFinite(chapterNumber) || chapterNumber <= 0 || !chapterSet.has(chapterNumber)) continue;
    const status = typeof entry?.status === "string" ? entry.status.trim().toLowerCase() : "";
    if (status === "state-degraded") {
      degraded.add(chapterNumber);
    }
  }
  return [...degraded].sort((left, right) => left - right);
}

async function findDegradedChapterNumbers(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly chapterNumbers: ReadonlyArray<number>;
}): Promise<number[]> {
  const indexRaw = await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]);
  const index = normalizeChapterIndexEntries(indexRaw);
  return detectDegradedChapterNumbersFromIndex({
    index,
    chapterNumbers: args.chapterNumbers,
  });
}

async function tryAutoRecoverDegradedWrite(args: {
  readonly pipeline: PipelineRunner;
  readonly state: StateManager;
  readonly bookId: string;
  readonly chapterNumbers: ReadonlyArray<number>;
  readonly log: (message: string, level?: "info" | "warning" | "error") => void;
}): Promise<WriteDegradedRecoveryResult> {
  const initialDegraded = await findDegradedChapterNumbers({
    state: args.state,
    bookId: args.bookId,
    chapterNumbers: args.chapterNumbers,
  });
  if (initialDegraded.length === 0) {
    return {
      attempted: false,
      recovered: true,
      remainingDegradedChapterNumbers: [],
    };
  }

  const attemptedChapterNumber = initialDegraded.at(-1);
  if (!attemptedChapterNumber) {
    return {
      attempted: false,
      recovered: false,
      remainingDegradedChapterNumbers: initialDegraded,
      reason: "无法确定需要修复的目标章节。",
    };
  }

  args.log(`检测到状态降级章节：${initialDegraded.join("、")}，尝试自动修复第${attemptedChapterNumber}章。`);
  let recoverReason: string | undefined;
  try {
    await args.pipeline.resyncChapterArtifacts(args.bookId, attemptedChapterNumber);
  } catch (error) {
    recoverReason = error instanceof Error ? error.message : String(error);
    args.log(`自动修复第${attemptedChapterNumber}章失败：${recoverReason}`, "warning");
  }

  const remainingDegradedChapterNumbers = await findDegradedChapterNumbers({
    state: args.state,
    bookId: args.bookId,
    chapterNumbers: args.chapterNumbers,
  });
  const recovered = remainingDegradedChapterNumbers.length === 0;
  if (recovered) {
    args.log(`自动修复成功：已恢复第${attemptedChapterNumber}章状态。`);
  } else {
    args.log(`自动修复后仍有降级章节：${remainingDegradedChapterNumbers.join("、")}`, "warning");
  }
  return {
    attempted: true,
    attemptedChapterNumber,
    recovered,
    remainingDegradedChapterNumbers,
    ...(recoverReason ? { reason: recoverReason } : {}),
  };
}

async function findChapterFileNameByNumber(state: StateManager, bookId: string, chapterNumber: number): Promise<string | null> {
  const chaptersDir = join(state.bookDir(bookId), "chapters");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const paddedNum = String(chapterNumber).padStart(4, "0");
  const matches = files
    .filter((file) => file.startsWith(paddedNum) && file.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));
  return matches.at(-1) ?? null;
}

function estimateChapterWordCount(markdown: string, language?: string): number {
  const countingLanguage = language === "en" ? "en" : "zh";
  return countChapterLengthByLanguage(markdown, countingLanguage);
}

function deriveChapterTitle(args: {
  chapterNumber: number;
  fileName: string;
  markdown: string;
}): string {
  const headingLine = args.markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));
  if (headingLine) {
    const rawHeading = headingLine.replace(/^#+\s*/, "").trim();
    const stripped = rawHeading
      .replace(/^第\s*\d+\s*章[\s:：\-]*/i, "")
      .trim();
    if (stripped) return stripped;
    if (rawHeading) return rawHeading;
  }

  const fileStem = args.fileName.replace(/\.md$/i, "");
  const underscoreIndex = fileStem.indexOf("_");
  const rawTitle = underscoreIndex >= 0 ? fileStem.slice(underscoreIndex + 1) : fileStem;
  const title = rawTitle.replace(/_/g, " ").trim();
  if (title) return title;
  return `第${args.chapterNumber}章`;
}

async function repairChapterIndexFromDisk(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly afterIndex: ReadonlyArray<ChapterIndexEntryLike>;
  readonly minimumChapterNumber?: number;
  readonly onTelemetry?: (payload: PersistRepairTelemetry) => void;
}): Promise<WritePersistenceRepairResult> {
  args.onTelemetry?.({
    status: "started",
    repairedChapterNumbers: [],
  });

  const chaptersDir = join(args.state.bookDir(args.bookId), "chapters");
  const chapterFiles = await readdir(chaptersDir).catch(() => [] as string[]);
  const filesByNumber = new Map<number, string>();
  for (const fileName of chapterFiles) {
    const chapterNumber = parseChapterFileNumber(fileName);
    if (!chapterNumber) continue;
    filesByNumber.set(chapterNumber, fileName);
  }

  if (filesByNumber.size === 0) {
    const skipped = {
      status: "skipped" as const,
      repairedChapterNumbers: [],
      reason: "未发现可用于修复的章节正文文件。",
    };
    args.onTelemetry?.({
      status: "skipped",
      repairedChapterNumbers: [],
      reason: skipped.reason,
    });
    return skipped;
  }

  const indexedNumbers = new Set(
    args.afterIndex
      .map((entry) => Number(entry?.number))
      .filter((chapterNumber) => Number.isFinite(chapterNumber) && chapterNumber > 0),
  );
  const missingIndexNumbers = [...filesByNumber.keys()]
    .filter((chapterNumber) =>
      !indexedNumbers.has(chapterNumber)
      && chapterNumber >= (args.minimumChapterNumber ?? 1),
    )
    .sort((left, right) => left - right);

  if (missingIndexNumbers.length === 0) {
    const skipped = {
      status: "skipped" as const,
      repairedChapterNumbers: [],
      reason: "章节索引与磁盘文件一致，跳过修复。",
    };
    args.onTelemetry?.({
      status: "skipped",
      repairedChapterNumbers: [],
      reason: skipped.reason,
    });
    return skipped;
  }

  const nowIso = new Date().toISOString();
  const repairedEntries: ChapterIndexEntryLike[] = [];
  for (const chapterNumber of missingIndexNumbers) {
    const fileName = filesByNumber.get(chapterNumber);
    if (!fileName) continue;
    const filePath = join(chaptersDir, fileName);
    try {
      const markdown = await readFile(filePath, "utf-8");
      repairedEntries.push({
        number: chapterNumber,
        title: deriveChapterTitle({ chapterNumber, fileName, markdown }),
        status: "ready-for-review",
        wordCount: estimateChapterWordCount(markdown),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } catch {
      // Ignore unreadable chapter file and continue repairing.
    }
  }

  if (repairedEntries.length === 0) {
    const failed = {
      status: "failed" as const,
      repairedChapterNumbers: [],
      reason: "检测到索引缺口，但未能读取对应章节文件完成修复。",
    };
    args.onTelemetry?.({
      status: "failed",
      repairedChapterNumbers: [],
      reason: failed.reason,
    });
    return failed;
  }

  const repairedNumbers = repairedEntries.map((entry) => entry.number).sort((left, right) => left - right);
  const updatedIndex = [...args.afterIndex, ...repairedEntries]
    .sort((left, right) => Number(left.number) - Number(right.number))
    .map((entry) => ({ ...entry }));
  await args.state.saveChapterIndex(args.bookId, updatedIndex as any);

  const completed = {
    status: "completed" as const,
    repairedChapterNumbers: repairedNumbers,
  };
  args.onTelemetry?.({
    status: "completed",
    repairedChapterNumbers: repairedNumbers,
  });
  return completed;
}

async function verifyWritePersistence(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly beforeIndex: ReadonlyArray<ChapterIndexEntryLike>;
  readonly onPersistCheck?: (payload: PersistCheckTelemetry) => void;
  readonly onPersistRepair?: (payload: PersistRepairTelemetry) => void;
}): Promise<WritePersistenceCheckResult> {
  const normalizedBeforeIndex = normalizeChapterIndexEntries(args.beforeIndex);
  const beforeCount = normalizedBeforeIndex.length;
  args.onPersistCheck?.({
    status: "started",
    beforeCount,
  });

  let afterIndexRaw = normalizeChapterIndexEntries(
    await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]),
  );
  const beforeNumbers = new Set(
    normalizedBeforeIndex
      .map((entry) => Number(entry?.number))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  const beforeMaxChapterNumber = beforeNumbers.size > 0 ? Math.max(...beforeNumbers) : 0;
  const chaptersDir = join(args.state.bookDir(args.bookId), "chapters");
  const chapterFiles = await readdir(chaptersDir).catch(() => [] as string[]);
  const computeSnapshot = (index: ReadonlyArray<ChapterIndexEntryLike>): {
    afterCount: number;
    addedChapterNumbers: number[];
    missingChapterFiles: number[];
  } => {
    const addedChapterNumbers = index
      .map((entry) => Number(entry?.number))
      .filter((n) => Number.isFinite(n) && n > 0 && !beforeNumbers.has(n));
    const hasChapterFile = (chapterNumber: number): boolean => {
      const prefix = String(chapterNumber).padStart(4, "0");
      return chapterFiles.some((file) => file.startsWith(prefix) && file.endsWith(".md"));
    };
    const missingChapterFiles = addedChapterNumbers.filter((chapterNumber) => !hasChapterFile(chapterNumber));
    return {
      afterCount: index.length,
      addedChapterNumbers,
      missingChapterFiles,
    };
  };

  let snapshot = computeSnapshot(afterIndexRaw);
  let repair: WritePersistenceRepairResult = {
    status: "skipped",
    repairedChapterNumbers: [],
    reason: "无需修复。",
  };

  if (snapshot.addedChapterNumbers.length === 0 || snapshot.missingChapterFiles.length > 0) {
    repair = await repairChapterIndexFromDisk({
      state: args.state,
      bookId: args.bookId,
      afterIndex: afterIndexRaw,
      minimumChapterNumber: beforeMaxChapterNumber + 1,
      onTelemetry: args.onPersistRepair,
    });
    if (repair.status === "completed") {
      afterIndexRaw = normalizeChapterIndexEntries(
        await args.state.loadChapterIndex(args.bookId).catch(() => [] as ChapterIndexEntryLike[]),
      );
      snapshot = computeSnapshot(afterIndexRaw);
    }
  }

  const persisted = snapshot.addedChapterNumbers.length > 0 && snapshot.missingChapterFiles.length === 0;
  args.onPersistCheck?.({
    status: "completed",
    beforeCount,
    afterCount: snapshot.afterCount,
    addedChapterNumbers: snapshot.addedChapterNumbers,
    missingChapterFiles: snapshot.missingChapterFiles,
    persisted,
  });

  return {
    persisted,
    beforeCount,
    afterCount: snapshot.afterCount,
    addedChapterNumbers: snapshot.addedChapterNumbers,
    missingChapterFiles: snapshot.missingChapterFiles,
    repair,
  };
}

async function prepareRewriteFromChapter(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly chapterNumber: number;
}): Promise<{
  rollbackTarget: number;
  discarded: ReadonlyArray<number>;
  usedFallbackRepair: boolean;
}> {
  const rollbackTarget = args.chapterNumber - 1;
  let discarded: ReadonlyArray<number>;
  let usedFallbackRepair = false;
  try {
    discarded = await args.state.rollbackToChapter(args.bookId, rollbackTarget);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/snapshot/i.test(message) || /restore/i.test(message)) {
      try {
        discarded = await args.state.rollbackToChapterWithoutSnapshot(args.bookId, rollbackTarget);
        usedFallbackRepair = true;
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new ApiError(
          409,
          "AGENT_REWRITE_SNAPSHOT_MISSING",
          `无法重写第${args.chapterNumber}章：缺少可回滚快照（目标第${rollbackTarget}章）。自动修复失败：${fallbackMessage}`,
        );
      }
    } else {
      throw error;
    }
  }
  const nextChapterNumber = await args.state.getNextChapterNumber(args.bookId);
  if (nextChapterNumber !== args.chapterNumber) {
    throw new Error(
      `Cannot rewrite chapter ${args.chapterNumber}: expected next chapter to be ${args.chapterNumber}, but resolved to ${nextChapterNumber}`,
    );
  }
  return { rollbackTarget, discarded, usedFallbackRepair };
}

async function writeRewrittenChapter(args: {
  readonly pipeline: PipelineRunner;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly wordCount?: number;
  readonly quickMode?: boolean;
}): Promise<Awaited<ReturnType<PipelineRunner["writeNextChapter"]>>> {
  const hasWordCount = typeof args.wordCount === "number" && Number.isFinite(args.wordCount);
  const writeOptions = typeof args.quickMode === "boolean"
    ? { quickMode: args.quickMode }
    : undefined;
  let writeResult: Awaited<ReturnType<PipelineRunner["writeNextChapter"]>>;
  try {
    writeResult = (hasWordCount || writeOptions)
      ? await args.pipeline.writeNextChapter(
        args.bookId,
        hasWordCount ? args.wordCount : undefined,
        undefined,
        writeOptions,
      )
      : await args.pipeline.writeNextChapter(args.bookId);
  } catch (error) {
    rethrowWriteErrorAsApiError(error, "重写");
  }

  const writtenChapterNumber = Number(writeResult.chapterNumber ?? 0);
  if (
    Number.isFinite(writtenChapterNumber)
    && writtenChapterNumber > 0
    && writtenChapterNumber !== args.chapterNumber
  ) {
    throw new Error(
      `Cannot rewrite chapter ${args.chapterNumber}: write returned chapter ${writtenChapterNumber}`,
    );
  }
  return writeResult;
}

function extractChapterPreviewBody(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const lines = normalized.split("\n");
  const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmpty < 0) return "";
  const bodyLines = lines.slice(firstNonEmpty);
  if (bodyLines.length > 0 && /^\s*#/.test(bodyLines[0] ?? "")) {
    bodyLines.shift();
  }
  while (bodyLines.length > 0 && bodyLines[0]?.trim().length === 0) {
    bodyLines.shift();
  }
  const body = bodyLines.join("\n").trim();
  return body || normalized;
}

function splitChapterPreviewText(text: string, options?: { maxChars?: number; chunkSize?: number }): string[] {
  const maxChars = Math.max(800, Number(options?.maxChars ?? 6_000));
  const chunkSize = Math.max(60, Number(options?.chunkSize ?? 220));
  const normalized = text.trim().slice(0, maxChars);
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let i = 0; i < normalized.length; i += chunkSize) {
    const chunk = normalized.slice(i, i + chunkSize);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

async function emitChapterDeltaFallbackIfMissing(args: {
  readonly state: StateManager;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly mode: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly emittedChapterPreviewNumbers: Set<number>;
}): Promise<boolean> {
  if (!Number.isFinite(args.chapterNumber) || args.chapterNumber <= 0) return false;
  if (args.emittedChapterPreviewNumbers.has(args.chapterNumber)) return false;
  const chapterFileName = await findChapterFileNameByNumber(args.state, args.bookId, args.chapterNumber);
  if (!chapterFileName) return false;
  const chapterPath = join(args.state.bookDir(args.bookId), "chapters", chapterFileName);
  const markdown = await readFile(chapterPath, "utf-8").catch(() => "");
  if (!markdown.trim()) return false;
  const previewText = extractChapterPreviewBody(markdown);
  const chunks = splitChapterPreviewText(previewText);
  if (chunks.length === 0) return false;
  for (const chunk of chunks) {
    broadcast("chapter:delta", {
      sessionId: args.sessionId,
      runId: args.runId,
      sequence: nextChapterDeltaSequence(args.runId),
      previewType: "chapter",
      bookId: args.bookId,
      chapterNumber: args.chapterNumber,
      mode: args.mode,
      text: chunk,
    });
  }
  args.emittedChapterPreviewNumbers.add(args.chapterNumber);
  return true;
}

function rethrowWriteErrorAsApiError(error: unknown, actionLabel: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/state-degraded/i.test(message)) {
    throw new ApiError(
      409,
      "AGENT_WRITE_DEGRADED",
      `${actionLabel}被阻止：最新章节处于状态降级（state-degraded）。请先修复该章状态后再继续。`,
    );
  }
  throw error;
}

function hasStateDegradedSignal(text: string): boolean {
  return /state-degraded|状态降级/i.test(text);
}

function inferWriterStateDegradedPrecondition(args: {
  readonly toolExecutions: ReadonlyArray<CollectedToolExec>;
  readonly responseText?: string;
}): boolean {
  if (typeof args.responseText === "string" && hasStateDegradedSignal(args.responseText)) {
    return true;
  }
  for (const execution of args.toolExecutions) {
    if (execution.agent !== "writer") continue;
    if (execution.status !== "error") continue;
    if (typeof execution.error === "string" && hasStateDegradedSignal(execution.error)) {
      return true;
    }
    if (Array.isArray(execution.logs)) {
      for (const log of execution.logs) {
        if (hasStateDegradedSignal(String(log))) return true;
      }
    }
  }
  return false;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function tryParseHttpStatusCode(message: string): number | null {
  const patterns = [
    /\b(\d{3})\s*status code\b/i,
    /\bstatus code\s*\(?\s*(\d{3})\s*\)?/i,
    /\bhttp\s*(\d{3})\b/i,
    /\bapi\s*返回\s*(\d{3})\b/i,
    /\b(\d{3})\s*\([^)]*no body[^)]*\)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const status = Number.parseInt(match[1], 10);
    if (Number.isFinite(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return null;
}

function classifyAgentUpstreamFailure(error: unknown): {
  readonly status: 502 | 504;
  readonly code: "AGENT_UPSTREAM_ERROR" | "AGENT_UPSTREAM_TIMEOUT";
  readonly message: string;
} | null {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.trim();
  const normalized = message.toLowerCase();

  if (
    normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("请求超时")
  ) {
    return {
      status: 504,
      code: "AGENT_UPSTREAM_TIMEOUT",
      message: `上游模型服务超时：${message || "unknown timeout"}`,
    };
  }

  const statusCode = tryParseHttpStatusCode(message);
  if (!statusCode || statusCode < 400 || statusCode > 599) return null;
  return {
    status: 502,
    code: "AGENT_UPSTREAM_ERROR",
    message: `上游模型服务异常（HTTP ${statusCode}）：${message || `HTTP ${statusCode}`}`,
  };
}

function classifySingleModelTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("aborted")
  ) {
    return "timeout";
  }
  if (
    normalized.includes("401")
    || normalized.includes("403")
    || normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("api key")
  ) {
    return "auth_failed";
  }
  if (
    normalized.includes("404")
    || normalized.includes("not found")
    || (
      normalized.includes("model")
      && (
        normalized.includes("invalid")
        || normalized.includes("unknown")
        || normalized.includes("not exist")
        || normalized.includes("not available")
        || normalized.includes("doesn't exist")
      )
    )
  ) {
    return "unsupported_model";
  }

  return message;
}

async function runSingleModelConnectivityTest(args: {
  service: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  apiFormat: "chat" | "responses";
  stream: boolean;
}): Promise<{
  ok: boolean;
  elapsedMs: number;
  apiFormat: "chat" | "responses";
  stream: boolean;
  error?: string;
}> {
  const startedAt = Date.now();
  const baseService = isCustomServiceId(args.service) ? "custom" : args.service;
  const client = createLLMClient({
    provider: resolveServiceProviderFamily(baseService) ?? "openai",
    service: baseService,
    configSource: "studio",
    baseUrl: args.baseUrl,
    apiKey: args.apiKey.trim(),
    model: args.model,
    temperature: 0.7,
    maxTokens: 2048,
    thinkingBudget: 0,
    apiFormat: args.apiFormat,
    stream: args.stream,
  } as ProjectConfig["llm"]);

  try {
    await withTimeout(
      chatCompletion(client, args.model, [{ role: "user", content: "ping" }], { maxTokens: 256 }),
      12_000,
    );
    return {
      ok: true,
      elapsedMs: elapsedSince(startedAt),
      apiFormat: args.apiFormat,
      stream: args.stream,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: elapsedSince(startedAt),
      apiFormat: args.apiFormat,
      stream: args.stream,
      error: classifySingleModelTestError(error),
    };
  }
}

async function probeServiceCapabilities(args: {
  root: string;
  service: string;
  apiKey: string;
  baseUrl: string;
  preferredApiFormat?: "chat" | "responses";
  preferredStream?: boolean;
  preferredModel?: string;
}): Promise<ServiceProbeResult> {
  const rawConfig = await loadRawConfig(args.root).catch(() => ({} as Record<string, unknown>));
  const llm = (rawConfig.llm as Record<string, unknown> | undefined) ?? {};
  const envConfig = await readEnvConfigStatus(args.root);
  const envModel = envConfig.effectiveSource === "project"
    ? envConfig.project.model
    : envConfig.effectiveSource === "global"
      ? envConfig.global.model
      : null;

  const baseService = isCustomServiceId(args.service) ? "custom" : args.service;
  const modelsResponse = await fetchModelsFromServiceBaseUrl(baseService, args.baseUrl, args.apiKey);
  if (modelsResponse.authFailed) {
    return {
      ok: false,
      models: [],
      error: modelsResponse.error ?? "API Key 无效或无权访问模型列表。",
    };
  }
  const discoveredModels = modelsResponse.models;
  // For services with knownModels, use their first model as top candidate — not the global default
  const preset = resolveServicePreset(baseService);
  const serviceFirstModel = preset?.knownModels?.[0];
  const modelCandidates = buildModelCandidates({
    preferredModel: args.preferredModel ?? serviceFirstModel,
    configModel: typeof llm.defaultModel === "string" ? llm.defaultModel : typeof llm.model === "string" ? llm.model : undefined,
    envModel,
    discoveredModels,
  });

  if (modelCandidates.length === 0) {
    return {
      ok: false,
      models: [],
      error: "无法自动确定模型，请先填写可用模型或提供支持 /models 的服务端点。",
    };
  }

  let lastError = modelsResponse.error ?? "自动探测失败";

  for (const model of modelCandidates) {
    for (const plan of buildProbePlans(args.preferredApiFormat, args.preferredStream)) {
      const client = createLLMClient({
        provider: resolveServiceProviderFamily(baseService) ?? "openai",
        service: baseService,
        configSource: "studio",
        baseUrl: args.baseUrl,
        apiKey: args.apiKey.trim(),
        model,
        temperature: 0.7,
        maxTokens: 2048,
        thinkingBudget: 0,
        apiFormat: plan.apiFormat,
        stream: plan.stream,
      } as ProjectConfig["llm"]);

      try {
        await chatCompletion(client, model, [{ role: "user", content: "ping" }], { maxTokens: 2048 });
        const models = discoveredModels.length > 0
          ? discoveredModels
          : preset?.knownModels?.map((id) => ({ id, name: id })) ?? [{ id: model, name: model }];
        return {
          ok: true,
          models,
          selectedModel: model,
          apiFormat: plan.apiFormat,
          stream: plan.stream,
          baseUrl: args.baseUrl,
          modelsSource: discoveredModels.length > 0 ? "api" : "fallback",
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return {
    ok: false,
    models: discoveredModels,
    error: lastError,
  };
}

// --- Server factory ---

export function createStudioServer(initialConfig: ProjectConfig, root: string, options: StudioServerOptions = {}) {
  const app = new Hono();
  const state = new StateManager(root);
  const reviewMetricsByBook = new Map<string, ReviewMetricsBookStore>();
  let cachedConfig = initialConfig;
  const openPath = options.openPath ?? openPathWithSystemDefault;

  function recordReviewMetrics(args: {
    bookId: string;
    entry: ReviewEntry;
    passed: boolean;
    reviseRoundsUsed: number;
    finalState: "passed" | "failed-max-rounds" | "failed-single-audit";
    issueClassCounts?: Readonly<{ structural: number; textual: number }>;
    issueTexts?: ReadonlyArray<string>;
  }): void {
    const key = args.bookId.trim();
    if (!key) return;
    const bookStore = reviewMetricsByBook.get(key) ?? createReviewMetricsBookStore();
    applyReviewMetricsObservation(bookStore.overall, {
      passed: args.passed,
      reviseRoundsUsed: args.reviseRoundsUsed,
      finalState: args.finalState,
      issueClassCounts: args.issueClassCounts,
      issueTexts: args.issueTexts,
    });
    applyReviewMetricsObservation(bookStore.byEntry[args.entry], {
      passed: args.passed,
      reviseRoundsUsed: args.reviseRoundsUsed,
      finalState: args.finalState,
      issueClassCounts: args.issueClassCounts,
      issueTexts: args.issueTexts,
    });
    reviewMetricsByBook.set(key, bookStore);
  }

  function getReviewMetricsPayload(bookId: string): {
    reviewMetrics: ReviewMetricsSnapshot;
    reviewMetricsByEntry: Record<ReviewEntry, ReviewMetricsSnapshot>;
  } {
    const key = bookId.trim();
    const empty = createReviewMetricsBookStore();
    const store = reviewMetricsByBook.get(key) ?? empty;
    return {
      reviewMetrics: reviewMetricsSnapshotFromCounter(store.overall),
      reviewMetricsByEntry: {
        "write-next": reviewMetricsSnapshotFromCounter(store.byEntry["write-next"]),
        "write-target": reviewMetricsSnapshotFromCounter(store.byEntry["write-target"]),
        rewrite: reviewMetricsSnapshotFromCounter(store.byEntry.rewrite),
      },
    };
  }

  app.use("/*", cors());

  // Structured error handler — ApiError returns typed JSON, others return 500
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    console.error("[studio] uncaught api error:", error);
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } },
      500,
    );
  });

  // BookId validation middleware — blocks path traversal on all book routes
  app.use("/api/v1/books/:id/*", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });
  app.use("/api/v1/books/:id", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });

  // Logger sink that broadcasts to SSE
  const sseSink: LogSink = {
    write(entry: LogEntry): void {
      if (shouldSuppressStageHeartbeatLog(entry.message)) return;
      const contextual = withLogContext({ message: entry.message });
      broadcast("log", {
        level: entry.level,
        tag: entry.tag,
        message: contextual.message,
        ...(typeof contextual.chapterNumber === "number" ? { chapterNumber: contextual.chapterNumber } : {}),
      });
    },
  };

  // Logger sink that prints to server terminal
  const consoleSink: LogSink = {
    write(entry: LogEntry): void {
      if (shouldSuppressStageHeartbeatLog(entry.message)) return;
      const contextual = withLogContext({ message: entry.message });
      const prefix = `[${entry.tag}]`;
      if (entry.level === "warn") console.warn(prefix, contextual.message);
      else if (entry.level === "error") console.error(prefix, contextual.message);
      else console.log(prefix, contextual.message);
    },
  };

  async function loadCurrentProjectConfig(
    options?: { readonly requireApiKey?: boolean },
  ): Promise<ProjectConfig> {
    const freshConfig = await loadProjectConfig(root, options);
    cachedConfig = freshConfig;
    return freshConfig;
  }

  async function buildPipelineConfig(
    overrides?: Partial<Pick<PipelineConfig, "externalContext" | "client" | "model" | "defaultWriteNextQuickMode" | "writeStageHeartbeatMs" | "onStreamProgress">> & {
      readonly currentConfig?: ProjectConfig;
      readonly bookId?: string;
      readonly sessionIdForSSE?: string;
      readonly runIdForSSE?: string;
      readonly onTaskSignal?: PipelineConfig["onTaskSignal"];
      readonly onChapterDelta?: (payload: {
        previewType: "chapter" | "patch";
        chapterNumber?: number;
        mode?: string;
      }) => void;
    },
  ): Promise<PipelineConfig> {
    const currentConfig = overrides?.currentConfig ?? await loadCurrentProjectConfig();
    const scopedSseSink: LogSink = overrides?.sessionIdForSSE
      ? {
          write(entry) {
            if (shouldSuppressStageHeartbeatLog(entry.message)) return;
            const contextual = withLogContext({
              message: entry.message,
              bookId: overrides.bookId,
              runId: overrides.runIdForSSE,
            });
            broadcast("log", {
              sessionId: overrides.sessionIdForSSE,
              ...(overrides.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
              level: entry.level,
              tag: entry.tag,
              message: contextual.message,
              ...(typeof contextual.chapterNumber === "number" ? { chapterNumber: contextual.chapterNumber } : {}),
            });
          },
        }
      : sseSink;
    const scopedConsoleSink: LogSink = overrides?.runIdForSSE
      ? {
          write(entry) {
            if (shouldSuppressStageHeartbeatLog(entry.message)) return;
            const contextual = withLogContext({
              message: entry.message,
              bookId: overrides.bookId,
              runId: overrides.runIdForSSE,
            });
            const prefix = `[${entry.tag}]`;
            if (entry.level === "warn") console.warn(prefix, contextual.message);
            else if (entry.level === "error") console.error(prefix, contextual.message);
            else console.log(prefix, contextual.message);
          },
        }
      : consoleSink;
    const logger = createLogger({ tag: "studio", sinks: [scopedSseSink, scopedConsoleSink] });
    return {
      client: overrides?.client ?? createLLMClient(currentConfig.llm),
      model: overrides?.model ?? currentConfig.llm.model,
      projectRoot: root,
      defaultLLMConfig: currentConfig.llm,
      enforceOutlineAnchorMatch: true,
      modelOverrides: currentConfig.modelOverrides,
      notifyChannels: currentConfig.notify,
      logger,
      onStreamProgress: (progress) => {
        broadcast("llm:progress", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          status: progress.status,
          elapsedMs: progress.elapsedMs,
          totalChars: progress.totalChars,
          chineseChars: progress.chineseChars,
        });
        overrides?.onStreamProgress?.(progress);
      },
      onWriterTextDelta: (payload) => {
        const sequence = overrides?.runIdForSSE ? nextChapterDeltaSequence(overrides.runIdForSSE) : undefined;
        overrides?.onChapterDelta?.({
          previewType: "chapter",
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
        });
        broadcast("chapter:delta", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          ...(typeof sequence === "number" ? { sequence } : {}),
          previewType: "chapter",
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
          text: payload.text,
        });
      },
      onReviserTextDelta: (payload) => {
        const sequence = overrides?.runIdForSSE ? nextChapterDeltaSequence(overrides.runIdForSSE) : undefined;
        overrides?.onChapterDelta?.({
          previewType: "chapter",
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
        });
        broadcast("chapter:delta", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          ...(typeof sequence === "number" ? { sequence } : {}),
          previewType: "chapter",
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
          text: payload.text,
        });
      },
      onReviserPatchDelta: (payload) => {
        const sequence = overrides?.runIdForSSE ? nextChapterDeltaSequence(overrides.runIdForSSE) : undefined;
        overrides?.onChapterDelta?.({
          previewType: "patch",
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
        });
        broadcast("chapter:delta", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          ...(typeof sequence === "number" ? { sequence } : {}),
          previewType: "patch",
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
          text: payload.text,
        });
      },
      onReviserThinkingDelta: (payload) => {
        broadcast("thinking:delta", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
          text: payload.text,
        });
      },
      onReviserThinkingEnd: (payload) => {
        broadcast("thinking:end", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          mode: payload.mode,
        });
      },
      onAuditorTextDelta: (payload) => {
        broadcast("thinking:delta", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          text: payload.text,
        });
      },
      onAuditorThinkingEnd: (payload) => {
        broadcast("thinking:end", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
        });
      },
      onTaskSignal: (signal) => {
        overrides?.onTaskSignal?.(signal);
      },
      onWriteNextAuditStart: (payload) => {
        broadcast("audit:start", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          entry: "write-next",
          chapter: payload.chapterNumber,
          round: payload.round,
          maxRounds: payload.maxReviseRounds,
          phase: payload.phase,
          unboundedReview: payload.unboundedReview,
        });
        overrides?.onTaskSignal?.({
          kind: "audit:start",
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          round: payload.round,
          maxReviseRounds: payload.maxReviseRounds,
          unboundedReview: payload.unboundedReview,
          phase: payload.phase,
        });
      },
      onWriteNextAuditComplete: (payload) => {
        const auditClassMeta = payload.audit as {
          issueClassCounts?: { structural?: number; textual?: number };
          primaryIssueClass?: "none" | "structural" | "textual" | "mixed";
          dimensionChecks?: ReadonlyArray<{
            dimension: string;
            status: "pass" | "warning" | "failed";
            evidence?: string;
          }>;
        };
        const failureGate = resolveDisplayFailureGate({
          passed: payload.audit.passed,
          score: payload.audit.score,
          severityCounts: payload.audit.severityCounts,
        });
        const issueTexts = buildAuditIssueTexts(payload.audit.issues);
        const report = buildAuditReportText({
          chapterNumber: payload.chapterNumber,
          passed: payload.audit.passed,
          issueCount: payload.audit.issueCount,
          summary: payload.audit.summary,
          issueTexts,
          severityCounts: payload.audit.severityCounts,
          failureGate,
        });
        const autoReviewState = buildAutoReviewAuditEventState({
          round: payload.round,
          maxReviseRounds: payload.maxReviseRounds,
          passed: payload.audit.passed,
          unboundedReview: payload.unboundedReview,
        });
        if (!overrides?.runIdForSSE && autoReviewState.autoReviewFinal) {
          const terminalState = autoReviewState.autoReviewState === "failed-max-rounds"
            ? "failed-max-rounds"
            : (autoReviewState.autoReviewState === "passed" ? "passed" : "failed-single-audit");
          recordReviewMetrics({
            bookId: payload.bookId,
            entry: "write-next",
            passed: payload.audit.passed,
            reviseRoundsUsed: Math.max(0, payload.round - 1),
            finalState: terminalState,
            issueClassCounts: auditClassMeta.issueClassCounts
              ? {
                  structural: Number(auditClassMeta.issueClassCounts.structural ?? 0),
                  textual: Number(auditClassMeta.issueClassCounts.textual ?? 0),
                }
              : undefined,
            issueTexts,
          });
        }
        broadcast("audit:complete", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          entry: "write-next",
          chapter: payload.chapterNumber,
          round: payload.round,
          maxRounds: payload.maxReviseRounds,
          phase: payload.phase,
          unboundedReview: payload.unboundedReview,
          passed: payload.audit.passed,
          issueCount: payload.audit.issueCount,
          score: payload.audit.score,
          severityCounts: payload.audit.severityCounts,
          failureGate,
          issueClassCounts: auditClassMeta.issueClassCounts,
          primaryIssueClass: auditClassMeta.primaryIssueClass,
          summary: payload.audit.summary,
          dimensionChecks: auditClassMeta.dimensionChecks,
          issues: issueTexts,
          report,
          ...autoReviewState,
        });
        overrides?.onTaskSignal?.({
          kind: "audit:complete",
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          round: payload.round,
          maxReviseRounds: payload.maxReviseRounds,
          unboundedReview: payload.unboundedReview,
          phase: payload.phase,
          passed: payload.audit.passed,
          issueCount: payload.audit.issueCount,
          score: payload.audit.score,
          summary: payload.audit.summary,
        });
      },
      onWriteNextReviseStart: (payload) => {
        broadcast("revise:start", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          entry: "write-next",
          chapter: payload.chapterNumber,
          round: payload.round,
          maxRounds: payload.maxReviseRounds,
          phase: payload.phase,
          mode: payload.mode,
          autoTriggeredByAudit: true,
          unboundedReview: payload.unboundedReview,
        });
        overrides?.onTaskSignal?.({
          kind: "revise:start",
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          round: payload.round,
          maxReviseRounds: payload.maxReviseRounds,
          unboundedReview: payload.unboundedReview,
          phase: payload.phase,
          mode: payload.mode,
        });
      },
      onWriteNextReviseComplete: (payload) => {
        const auditClassMeta = payload.audit as {
          issueClassCounts?: { structural?: number; textual?: number };
          primaryIssueClass?: "none" | "structural" | "textual" | "mixed";
          dimensionChecks?: ReadonlyArray<{
            dimension: string;
            status: "pass" | "warning" | "failed";
            evidence?: string;
          }>;
        } | null;
        const reviseStatus = payload.audit
          ? (payload.audit.passed ? "ready-for-review" : "audit-failed")
          : (payload.applied ? "ready-for-review" : "unchanged");
        const reviseAudit = payload.audit
          ? (() => {
              const failureGate = resolveDisplayFailureGate({
                passed: payload.audit.passed,
                score: payload.audit.score,
                severityCounts: payload.audit.severityCounts,
              });
              const issueTexts = buildAuditIssueTexts(payload.audit.issues);
              return {
                passed: payload.audit.passed,
                score: payload.audit.score,
                issueCount: payload.audit.issueCount,
                severityCounts: payload.audit.severityCounts,
                failureGate,
                issueClassCounts: auditClassMeta?.issueClassCounts,
                primaryIssueClass: auditClassMeta?.primaryIssueClass,
                summary: payload.audit.summary,
                dimensionChecks: auditClassMeta?.dimensionChecks,
                issues: issueTexts,
                report: buildAuditReportText({
                  chapterNumber: payload.chapterNumber,
                  passed: payload.audit.passed,
                  issueCount: payload.audit.issueCount,
                  summary: payload.audit.summary,
                  issueTexts,
                  severityCounts: payload.audit.severityCounts,
                  failureGate,
                }),
              };
            })()
          : null;
        broadcast("revise:complete", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
          bookId: payload.bookId,
          entry: "write-next",
          chapter: payload.chapterNumber,
          round: payload.round,
          maxRounds: payload.maxReviseRounds,
          phase: payload.phase,
          mode: payload.mode,
          autoTriggeredByAudit: true,
          wordCount: payload.wordCount,
          status: reviseStatus,
          applied: payload.applied,
          unboundedReview: payload.unboundedReview,
          ...(reviseAudit ? { audit: reviseAudit } : {}),
        });
        overrides?.onTaskSignal?.({
          kind: "revise:complete",
          bookId: payload.bookId,
          chapterNumber: payload.chapterNumber,
          round: payload.round,
          maxReviseRounds: payload.maxReviseRounds,
          unboundedReview: payload.unboundedReview,
          phase: payload.phase,
          mode: payload.mode,
          wordCount: payload.wordCount,
          applied: payload.applied,
          summary: payload.audit?.summary,
        });
      },
      externalContext: overrides?.externalContext,
      defaultWriteNextQuickMode: overrides?.defaultWriteNextQuickMode,
      writeStageHeartbeatMs: overrides?.writeStageHeartbeatMs,
    };
  }

  async function resolvePipelineClientFromSelection(args: {
    readonly currentConfig: ProjectConfig;
    readonly selectedService?: string;
    readonly selectedModel?: string;
  }): Promise<{ client?: ReturnType<typeof createLLMClient>; model?: string; error?: string }> {
    const selectedService = args.selectedService?.trim();
    const selectedModel = args.selectedModel?.trim();
    if (!selectedService || !selectedModel) return {};

    try {
      const configuredEntry = await resolveConfiguredServiceEntry(root, selectedService);
      const resolved = await resolveServiceModel(
        selectedService,
        selectedModel,
        root,
        await resolveConfiguredServiceBaseUrl(root, selectedService),
        configuredEntry?.apiFormat,
      );

      const client = createLLMClient({
        ...args.currentConfig.llm,
        service: configuredEntry?.service ?? selectedService,
        model: selectedModel,
        apiKey: resolved.apiKey,
        ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
        ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
        baseUrl: configuredEntry?.baseUrl ?? "",
      } as any);

      return {
        client,
        model: selectedModel,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/API key/i.test(message)) {
        return { error: `请先为 ${selectedService} 配置 API Key` };
      }
      return { error: message };
    }
  }

  const bookTaskController = new BookTaskController({
    state,
    loadCurrentProjectConfig,
    buildPipelineConfig,
    resolvePipelineClientFromSelection,
    createPipeline: (config) => new PipelineRunner(config),
    broadcast,
    resolveWriteStageHeartbeatMs,
  });
  void (async () => {
    try {
      const currentConfig = await loadCurrentProjectConfig();
      const bookIds = await state.listBooks();
      for (const bookId of bookIds) {
        await bookTaskController.recoverPendingTasks(bookId, currentConfig);
      }
    } catch (error) {
      console.warn("[studio] book task recovery skipped:", error);
    }
  })();

  async function loadGlobalTasks() {
    const bookIds = await state.listBooks();
    const books = await Promise.all(bookIds.map(async (bookId) => {
      const [book, tasks] = await Promise.all([
        state.loadBookConfig(bookId).catch(() => null),
        bookTaskController.list(bookId).catch(() => []),
      ]);
      return {
        bookId,
        bookTitle: book?.title ?? null,
        tasks,
      };
    }));

    const tasks = books.flatMap((book) => book.tasks.map((task) => ({
      ...task,
      bookTitle: book.bookTitle,
    })));

    const summary = tasks.reduce((acc, task) => {
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

    return { summary, tasks };
  }

  async function tryGenerateScriptWorkspaceWithLLM(args: {
    readonly bookId: string;
    readonly selectedChapterNumbers: ReadonlyArray<number>;
    readonly config: ScriptWorkspaceConfig;
  }): Promise<ScriptWorkspace | null> {
    try {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const client = createLLMClient(currentConfig.llm);
      const fallbackWorkspace = await buildScriptWorkspaceFromChapters({
        state,
        bookId: args.bookId,
        selectedChapterNumbers: args.selectedChapterNumbers,
        config: args.config,
      });
      const { chapterInputs, chapterGroups, selectedChapterNumbers } = await loadScriptWorkspaceChapterInputs({
        state,
        bookId: args.bookId,
        selectedChapterNumbers: args.selectedChapterNumbers,
        config: args.config,
      });

      const planPrompt = buildScriptWorkspaceLLMPlanPrompt({
        config: args.config,
        chapterInputs,
        chapterGroups,
      });
      const planResponse = await chatCompletion(
        client,
        currentConfig.llm.model,
        [
          {
            role: "system",
            content: "你是短视频剧本与提示词结构化输出助手。只输出 JSON，不要输出任何额外说明。",
          },
          { role: "user", content: planPrompt },
        ],
        { maxTokens: 8_192 },
      );
      const planCandidate = extractJsonObjectCandidate(planResponse.content ?? "");
      if (!planCandidate) return null;
      const parsedPlan = JSON.parse(planCandidate) as unknown;
      const normalizedPlan = normalizeScriptWorkspacePlan(parsedPlan, fallbackWorkspace);
      if (normalizedPlan.episodes.length === 0) return null;

      const episodeOutputs: unknown[] = [];
      for (const episodePlan of normalizedPlan.episodes) {
        const episodeChapterInputs = chapterInputs.filter((input) => episodePlan.sourceChapterNumbers.includes(input.chapterNumber));
        const episodePrompt = buildScriptWorkspaceLLMEpisodePrompt({
          config: args.config,
          episodePlan,
          chapterInputs: episodeChapterInputs.length > 0 ? episodeChapterInputs : chapterInputs,
        });
        const episodeResponse = await chatCompletion(
          client,
          currentConfig.llm.model,
          [
            {
              role: "system",
              content: "你是短视频剧本与提示词结构化输出助手。只输出 JSON，不要输出任何额外说明。",
            },
            { role: "user", content: episodePrompt },
          ],
          { maxTokens: 8_192 },
        );
        const episodeCandidate = extractJsonObjectCandidate(episodeResponse.content ?? "");
        episodeOutputs.push(episodeCandidate ? JSON.parse(episodeCandidate) : null);
      }

      const workspace = buildWorkspaceFromPlanWithEpisodeOutputs({
        bookId: args.bookId,
        selectedChapterNumbers,
        config: args.config,
        plan: normalizedPlan,
        fallback: fallbackWorkspace,
        episodeOutputs,
      });
      if (workspace.episodes.length === 0) return null;
      return workspace;
    } catch {
      return null;
    }
  }

  const WIZARD_STEP_ORDER: ReadonlyArray<BookCreationWizardStep> = [
    "intro",
    "world",
    "outline",
    "volume",
    "characters",
    "arc",
    "relation",
  ];

  type BookCreationSummary = {
    readonly shellCreated: boolean;
    readonly wizardCompleted: boolean;
    readonly currentStep: BookCreationWizardStep;
    readonly resumeStep: BookCreationWizardStep;
    readonly completedSteps: ReadonlyArray<BookCreationWizardStep>;
    readonly completedCount: number;
    readonly totalSteps: number;
  };

  type BookConfigWithCreationState = Awaited<ReturnType<typeof state.loadBookConfig>> & {
    readonly creationState?: "wizard" | "ready";
  };

  function resolveBookCreationSummary(
    creationState: "wizard" | "ready" | undefined,
    wizard: Awaited<ReturnType<typeof state.loadBookWizardState>> | null | undefined,
  ): BookCreationSummary {
    if (creationState === "ready") {
      return {
        shellCreated: false,
        wizardCompleted: true,
        currentStep: "relation",
        resumeStep: "relation",
        completedSteps: WIZARD_STEP_ORDER,
        completedCount: WIZARD_STEP_ORDER.length,
        totalSteps: WIZARD_STEP_ORDER.length,
      };
    }

    const savedStepCount = wizard ? WIZARD_STEP_ORDER.filter((step) => wizard.steps?.[step]?.status === "saved").length : 0;
    const hasWizardProgress = Boolean(
      wizard?.bookShellCreated
      || savedStepCount > 0
      || (wizard && WIZARD_STEP_ORDER.some((step) => wizard.steps?.[step]?.version && wizard.steps?.[step]?.version > 0)),
    );

    if (!hasWizardProgress && creationState !== "wizard") {
      return {
        shellCreated: false,
        wizardCompleted: true,
        currentStep: "relation",
        resumeStep: "relation",
        completedSteps: WIZARD_STEP_ORDER,
        completedCount: WIZARD_STEP_ORDER.length,
        totalSteps: WIZARD_STEP_ORDER.length,
      };
    }

    const completedSteps = WIZARD_STEP_ORDER.filter((step) => wizard?.steps?.[step]?.status === "saved");
    const wizardCompleted = completedSteps.length >= WIZARD_STEP_ORDER.length;
    const firstIncompleteStep = WIZARD_STEP_ORDER.find((step) => !completedSteps.includes(step));
    const currentStep = wizard && WIZARD_STEP_ORDER.includes(wizard.currentStep) ? wizard.currentStep : "intro";

    return {
      shellCreated: Boolean(wizard?.bookShellCreated || creationState === "wizard"),
      wizardCompleted,
      currentStep,
      resumeStep: wizardCompleted ? "relation" : (firstIncompleteStep ?? currentStep),
      completedSteps,
      completedCount: completedSteps.length,
      totalSteps: WIZARD_STEP_ORDER.length,
    };
  }

  // --- Books ---

  app.get("/api/v1/books", async (c) => {
    const bookIds = await state.listBooks();
    const books = await Promise.all(
      bookIds.map(async (id) => {
        const book = await state.loadBookConfig(id) as BookConfigWithCreationState;
        const nextChapter = await state.getNextChapterNumber(id);
        const wizard = await state.loadBookWizardState(id).catch(() => null);
        return {
          ...book,
          chaptersWritten: nextChapter - 1,
          creation: resolveBookCreationSummary(book.creationState, wizard),
        };
      }),
    );
    return c.json({ books });
  });

  app.get("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const book = await state.loadBookConfig(id) as BookConfigWithCreationState;
      const chapters = await state.loadChapterIndex(id);
      const nextChapter = await state.getNextChapterNumber(id);
      const wizard = await state.loadBookWizardState(id).catch(() => null);
      return c.json({
        book,
        chapters,
        nextChapter,
        creation: resolveBookCreationSummary(book.creationState, wizard),
      });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Wizard ---

  app.get("/api/v1/books/:id/wizard", async (c) => {
    const id = c.req.param("id");
    const book = await state.loadBookConfig(id).catch(() => null);
    if (!book) {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
    const wizard = await state.loadBookWizardState(id).catch(() => null);
    if (!wizard) return c.json({ error: `Wizard state for "${id}" not found` }, 404);
    return c.json({ wizard });
  });

  app.get("/api/v1/books/:id/wizard/:step", async (c) => {
    const id = c.req.param("id");
    const step = c.req.param("step") as BookCreationWizardStep;
    if (!["intro", "world", "outline", "volume", "characters", "arc", "relation"].includes(step)) {
      return c.json({ error: `Invalid wizard step "${step}"` }, 400);
    }
    const book = await state.loadBookConfig(id).catch(() => null);
    if (!book) return c.json({ error: `Book "${id}" not found` }, 404);
    try {
      const wizard = await state.loadBookWizardStep(id, step);
      return c.json({ step, ...wizard });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.post("/api/v1/books/:id/wizard/shell", async (c) => {
    const id = c.req.param("id");
    const book = await state.loadBookConfig(id).catch(() => null);
    if (!book) return c.json({ error: `Book "${id}" not found` }, 404);
    try {
      const wizard = await state.markBookShellCreated(id);
      return c.json({ ok: true, wizard });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.post("/api/v1/books/:id/wizard/complete", async (c) => {
    const id = c.req.param("id");
    const book = await state.loadBookConfig(id).catch(() => null);
    if (!book) return c.json({ error: `Book "${id}" not found` }, 404);
    try {
      const updatedBook = await state.markBookReady(id);
      const wizard = await state.markBookShellCreated(id);
      return c.json({ ok: true, book: updatedBook, wizard });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.post("/api/v1/books/:id/wizard/:step", async (c) => {
    const id = c.req.param("id");
    const step = c.req.param("step") as BookCreationWizardStep;
    if (!["intro", "world", "outline", "volume", "characters", "arc", "relation"].includes(step)) {
      return c.json({ error: `Invalid wizard step "${step}"` }, 400);
    }
    const book = await state.loadBookConfig(id).catch(() => null);
    if (!book) return c.json({ error: `Book "${id}" not found` }, 404);
    const body = await c.req.json<{
      content?: string;
      expectedVersion?: number;
    }>().catch(() => null);
    const content = body?.content ?? "";
    const expectedVersion = body?.expectedVersion;
    try {
      const result = await state.saveBookWizardStep(
        id,
        step,
        content,
        expectedVersion,
      );
      return c.json({ ok: true, step, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/version conflict/i.test(message)) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 400);
    }
  });

  const WIZARD_FILES = new Set([
    "intro.md",
    "world.md",
    "outline.md",
    "volume.md",
    "characters.md",
    "character_arc.md",
    "relationship_map.md",
  ]);

  const WIZARD_FILE_TO_STEP: Readonly<Record<string, BookCreationWizardStep>> = {
    "intro.md": "intro",
    "world.md": "world",
    "outline.md": "outline",
    "volume.md": "volume",
    "characters.md": "characters",
    "character_arc.md": "arc",
    "relationship_map.md": "relation",
  };

  app.get("/api/v1/books/:id/wizard-file/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    if (!WIZARD_FILES.has(file)) {
      return c.json({ error: "Invalid wizard file" }, 400);
    }
    try {
      const step = WIZARD_FILE_TO_STEP[file];
      const wizard = await state.loadBookWizardStep(id, step);
      return c.json({ step, file, ...wizard });
    } catch {
      const step = WIZARD_FILE_TO_STEP[file];
      return c.json({ step, file, content: "", status: "empty", version: 0 });
    }
  });

  app.put("/api/v1/books/:id/wizard-file/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    if (!WIZARD_FILES.has(file)) {
      return c.json({ error: "Invalid wizard file" }, 400);
    }
    const body = await c.req.json<{ content?: string; expectedVersion?: number }>().catch(() => null);
    const content = typeof body?.content === "string" ? body.content : "";
    try {
      const step = WIZARD_FILE_TO_STEP[file];
      const result = await state.saveBookWizardStep(
        id,
        step,
        content,
        typeof body?.expectedVersion === "number" ? body.expectedVersion : undefined,
      );
      return c.json({ ok: true, step, file, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/version conflict/i.test(message)) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }
  });

  // --- Genres ---

  app.get("/api/v1/genres", async (c) => {
    const { listAvailableGenres, readGenreProfile } = await import("@actalk/inkos-core");
    const rawGenres = await listAvailableGenres(root);
    const genres = await Promise.all(
      rawGenres.map(async (g) => {
        try {
          const { profile } = await readGenreProfile(root, g.id);
          return { ...g, language: profile.language ?? "zh" };
        } catch {
          return { ...g, language: "zh" };
        }
      }),
    );
    return c.json({ genres });
  });

  // --- Book Create ---

  app.post("/api/v1/books/create-shell", async (c) => {
    const body = await c.req.json<{
      title: string;
      genre: string;
      language?: string;
      platform?: string;
      chapterWordCount?: number;
      targetChapters?: number;
      blurb?: string;
      storyBackground?: string;
      introMarkdown?: string;
    }>();

    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig(body, now);
    const bookId = bookConfig.id;
    const bookDir = state.bookDir(bookId);
    const introContent = body.introMarkdown?.trim()
      || [body.blurb?.trim(), body.storyBackground?.trim()].filter(Boolean).join("\n\n");

    try {
      await access(join(bookDir, "book.json"));
    } catch {
      await state.saveBookConfig(bookId, bookConfig);
    }

    await mkdir(join(bookDir, "story", "outline"), { recursive: true });

    const introState = await state.loadBookWizardStep(bookId, "intro");
    await state.saveBookWizardStep(bookId, "intro", introContent || "", introState.version);
    const wizard = await state.markBookShellCreated(bookId);
    return c.json({ ok: true, bookId, book: bookConfig, wizard });
  });

  app.post("/api/v1/books/create", async (c) => {
    const body = await c.req.json<{
      title: string;
      genre: string;
      language?: string;
      platform?: string;
      chapterWordCount?: number;
      targetChapters?: number;
    }>();

    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig(body, now);
    const bookId = bookConfig.id;
    const bookDir = state.bookDir(bookId);

    try {
      await access(join(bookDir, "book.json"));
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    } catch {
      // book.json not found — creation can proceed
    }

    broadcast("book:creating", { bookId, title: body.title });
    bookCreateStatus.set(bookId, { status: "creating" });

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    const tools = createInteractionToolsFromDeps(pipeline, state);
    const timeoutMs = 300_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Book creation timed out after ${timeoutMs / 1000}s`)), timeoutMs),
    );
    Promise.race([
      processProjectInteractionRequest({
        projectRoot: root,
        request: {
          intent: "create_book",
          title: body.title,
          genre: body.genre,
          language: body.language === "en" ? "en" : body.language === "zh" ? "zh" : undefined,
          platform: body.platform,
          chapterWordCount: body.chapterWordCount,
          targetChapters: body.targetChapters,
        },
        tools,
      }),
      timeoutPromise,
    ]).then(
      (result: {
        readonly session: { readonly activeBookId?: string; readonly sessionId?: string };
        readonly details?: Readonly<Record<string, unknown>>;
      }) => {
        const createdBookId = (result.details?.bookId as string | undefined) ?? result.session.activeBookId ?? bookId;
        bookCreateStatus.delete(createdBookId);
        broadcast("book:created", { bookId: createdBookId, sessionId: result.session.sessionId });
      },
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        bookCreateStatus.set(bookId, { status: "error", error });
        broadcast("book:error", { bookId, error });
      },
    );

    return c.json({ status: "creating", bookId });
  });

  app.get("/api/v1/books/:id/create-status", async (c) => {
    const id = c.req.param("id");
    const status = bookCreateStatus.get(id);
    if (!status) {
      return c.json({ status: "missing" }, 404);
    }
    return c.json(status);
  });

  // --- Chapters ---

  app.get("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);
      const content = await readFile(join(chaptersDir, match), "utf-8");
      const book = await state.loadBookConfig(id).catch(() => null);
      const wordCount = estimateChapterWordCount(content, book?.language);
      const chapterIndex = await state.loadChapterIndex(id).catch(() => []);
      if (chapterIndex.length > 0) {
        const updatedAt = new Date().toISOString();
        let changed = false;
        const updatedIndex = chapterIndex.map((chapter) => {
          if (chapter.number !== num) return chapter;
          if ((chapter.wordCount ?? 0) === wordCount) return chapter;
          changed = true;
          return { ...chapter, wordCount, updatedAt };
        });
        if (changed) {
          await state.saveChapterIndex(id, updatedIndex);
        }
      }
      return c.json({ chapterNumber: num, filename: match, content, wordCount });
    } catch {
      return c.json({ error: "Chapter not found" }, 404);
    }
  });

  // --- Chapter Save ---

  app.put("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const { content } = await c.req.json<{ content: string }>();

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(join(chaptersDir, match), content, "utf-8");
      const book = await state.loadBookConfig(id).catch(() => null);
      const chapterWordCount = estimateChapterWordCount(content, book?.language);
      const chapterIndex = await state.loadChapterIndex(id).catch(() => []);
      if (chapterIndex.length > 0) {
        const updatedAt = new Date().toISOString();
        const updatedIndex = chapterIndex.map((chapter) =>
          chapter.number === num
            ? { ...chapter, wordCount: chapterWordCount, updatedAt }
            : chapter,
        );
        await state.saveChapterIndex(id, updatedIndex);
      }
      return c.json({ ok: true, chapterNumber: num, wordCount: chapterWordCount });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Chapter Delete (rollback from chapter N to N-1) ---

  app.delete("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    broadcast("delete:start", { bookId: id, chapter: num });

    try {
      const index = await state.loadChapterIndex(id);
      const target = index.find((ch) => ch.number === num);
      if (!target) return c.json({ error: "Chapter not found" }, 404);

      const rollbackTarget = num - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      broadcast("delete:complete", {
        bookId: id,
        chapterNumber: num,
        rolledBackTo: rollbackTarget,
        discarded,
      });
      return c.json({
        ok: true,
        chapterNumber: num,
        rolledBackTo: rollbackTarget,
        discarded,
      });
    } catch (e) {
      broadcast("delete:error", { bookId: id, chapter: num, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth files ---

  const TRUTH_FILES = [
    "foundation_brief.md",
    "author_intent.md", "current_focus.md",
    "story/outline/story_frame.md",
    "story/outline/volume_map.md",
    "story_bible.md", "novel_outline.md", "volume_outline.md", "current_state.md",
    "particle_ledger.md", "pending_hooks.md", "chapter_summaries.md",
    "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    "character_arc.md", "relationship_map.md",
    "style_guide.md", "parent_canon.md", "fanfic_canon.md", "book_rules.md",
  ];
  const TRUTH_FILE_PATHS = new Set([
    "foundation_brief.md",
    "author_intent.md",
    "current_focus.md",
    "story/author_intent.md",
    "story/current_focus.md",
    "story/outline/story_frame.md",
    "story/outline/volume_map.md",
    "story_bible.md",
    "novel_outline.md",
    "volume_outline.md",
    "current_state.md",
    "particle_ledger.md",
    "pending_hooks.md",
    "chapter_summaries.md",
    "subplot_board.md",
    "emotional_arcs.md",
    "character_matrix.md",
    "character_arc.md",
    "relationship_map.md",
    "style_guide.md",
    "parent_canon.md",
    "fanfic_canon.md",
    "book_rules.md",
  ]);

  app.get("/api/v1/books/:id/truth/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");

    if (!TRUTH_FILES.includes(file) && !TRUTH_FILE_PATHS.has(file)) {
      return c.json({ error: "Invalid truth file" }, 400);
    }

    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(resolveTruthFileReadPath(bookDir, file), "utf-8");
      return c.json({ file: resolveTruthFileResponseName(file), content });
    } catch {
      return c.json({ file: resolveTruthFileResponseName(file), content: null });
    }
  });

  // --- Analytics ---

  app.get("/api/v1/books/:id/analytics", async (c) => {
    const id = c.req.param("id");
    try {
      const chapters = await state.loadChapterIndex(id);
      const analytics = computeAnalytics(id, chapters);
      const metrics = getReviewMetricsPayload(id);
      return c.json({
        ...analytics,
        ...metrics,
      });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  app.get("/api/v1/books/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const tasks = await bookTaskController.list(id);
    return c.json({ tasks });
  });

  app.get("/api/v1/tasks", async (c) => {
    const globalTasks = await loadGlobalTasks();
    return c.json(globalTasks);
  });

  app.get("/api/v1/tasks/:bookId/:taskId", async (c) => {
    const bookId = c.req.param("bookId");
    const taskId = c.req.param("taskId");
    const task = await bookTaskController.get(bookId, taskId);
    if (!task) {
      return c.json({ error: `Task "${taskId}" not found` }, 404);
    }
    const book = await state.loadBookConfig(bookId).catch(() => null);
    return c.json({ task: { ...task, bookTitle: book?.title ?? null } });
  });

  app.post("/api/v1/books/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      type?: "write" | "audit";
      source?: "book-detail" | "task-center";
      requestedChapters?: number;
      auditChapterStart?: number;
      auditChapterEnd?: number;
      wordCount?: number;
      quickMode?: boolean;
      preferFastWriterModel?: boolean;
      service?: string;
      model?: string;
    }>().catch(() => ({}));
    const task = await bookTaskController.create(id, body);
    return c.json({ task }, 201);
  });

  app.get("/api/v1/books/:id/tasks/:taskId", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    const task = await bookTaskController.get(id, taskId);
    if (!task) {
      return c.json({ error: `Task "${taskId}" not found` }, 404);
    }
    return c.json({ task });
  });

  app.post("/api/v1/books/:id/tasks/:taskId/stop", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    const task = await bookTaskController.stop(id, taskId);
    return c.json({ task });
  });

  app.post("/api/v1/books/:id/tasks/:taskId/resume", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    const task = await bookTaskController.resume(id, taskId);
    return c.json({ task });
  });

  app.patch("/api/v1/tasks/:bookId/:taskId", async (c) => {
    const bookId = c.req.param("bookId");
    const taskId = c.req.param("taskId");
    const body = await c.req.json<{
      retryEnabled?: boolean;
      options?: {
        service?: string | null;
        model?: string | null;
        quickMode?: boolean;
      };
      service?: string | null;
      model?: string | null;
      quickMode?: boolean;
    }>().catch(() => null);
    const mergedOptions = body ? {
      ...(body.options ?? {}),
      ...(body.service !== undefined ? { service: body.service } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.quickMode !== undefined ? { quickMode: body.quickMode } : {}),
    } : {};
    const patch = body ? {
      ...(typeof body.retryEnabled === "boolean" ? { retryEnabled: body.retryEnabled } : {}),
      ...(Object.keys(mergedOptions).length > 0 ? { options: mergedOptions } : {}),
    } : {};
    const task = await bookTaskController.patch(bookId, taskId, patch as never);
    const book = await state.loadBookConfig(bookId).catch(() => null);
    return c.json({ task: { ...task, bookTitle: book?.title ?? null } });
  });

  app.delete("/api/v1/tasks/:bookId/:taskId", async (c) => {
    const bookId = c.req.param("bookId");
    const taskId = c.req.param("taskId");
    const task = await bookTaskController.get(bookId, taskId);
    if (!task) {
      return c.json({ error: `Task "${taskId}" not found` }, 404);
    }
    await bookTaskController.delete(bookId, taskId);
    return c.json({ ok: true, task });
  });

  app.post("/api/v1/tasks/:bookId/:taskId/retry", async (c) => {
    const bookId = c.req.param("bookId");
    const taskId = c.req.param("taskId");
    const task = await bookTaskController.retry(bookId, taskId);
    const book = await state.loadBookConfig(bookId).catch(() => null);
    return c.json({ task: { ...task, bookTitle: book?.title ?? null } });
  });

  app.post("/api/v1/tasks/:bookId/:taskId/cancel", async (c) => {
    const bookId = c.req.param("bookId");
    const taskId = c.req.param("taskId");
    const task = await bookTaskController.cancel(bookId, taskId);
    const book = await state.loadBookConfig(bookId).catch(() => null);
    return c.json({ task: { ...task, bookTitle: book?.title ?? null } });
  });

  // --- Actions ---

  app.post("/api/v1/books/:id/write-next", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      wordCount?: number;
      service?: string;
      model?: string;
      quickMode?: boolean;
      preferFastWriterModel?: boolean;
    }>()
      .catch(() => ({
        wordCount: undefined,
        service: undefined,
        model: undefined,
        quickMode: undefined,
        preferFastWriterModel: undefined,
      }));
    const currentConfig = await loadCurrentProjectConfig();
    const quickMode = body.quickMode ?? false;
    const preferFastWriterModel = body.preferFastWriterModel ?? true;
    let selectedService = body.service?.trim();
    let selectedModel = body.model?.trim();
    if (preferFastWriterModel) {
      const services = normalizeServiceConfig((currentConfig.llm as Record<string, unknown>).services);
      const configuredDefaultModel = (currentConfig.llm as Record<string, unknown>).defaultModel;
      const fallbackModel = typeof configuredDefaultModel === "string" && configuredDefaultModel.trim().length > 0
        ? configuredDefaultModel.trim()
        : currentConfig.llm.model;
      const fastSelection = resolveFastWriterModelSelection({
        services,
        currentModel: selectedModel ?? fallbackModel,
        preferredServiceKey: selectedService,
      });
      if (fastSelection) {
        const fromModel = selectedModel ?? fallbackModel;
        const fromService = selectedService ?? fastSelection.serviceKey;
        selectedService = fastSelection.serviceKey;
        selectedModel = fastSelection.model;
        broadcast("log", {
          bookId: id,
          level: "info",
          tag: "studio",
          message: `写作快速模式：模型已从 ${fromService}/${fromModel} 自动切换为 ${selectedService}/${selectedModel}`,
        });
      }
    }
    const selectedRuntime = await resolvePipelineClientFromSelection({
      currentConfig,
      selectedService,
      selectedModel,
    });
    if (selectedRuntime.error) {
      return c.json({ error: selectedRuntime.error }, 400);
    }

    broadcast("write:start", { bookId: id });

    // Fire and forget — progress/completion/errors pushed via SSE
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        currentConfig,
        bookId: id,
        ...(selectedRuntime.client ? { client: selectedRuntime.client } : {}),
        ...(selectedRuntime.model ? { model: selectedRuntime.model } : {}),
        writeStageHeartbeatMs: resolveWriteStageHeartbeatMs(),
      }));
    void pipeline.writeNextChapter(id, body.wordCount, undefined, {
      quickMode,
    }).then(
      (result) => {
        const autoReview = (() => {
          const payload = (result as { autoReview?: unknown }).autoReview;
          if (payload && typeof payload === "object") {
            const parsed = payload as Partial<UnifiedReviewLoopAutoReviewPayload>;
            if (
              typeof parsed.enabled === "boolean"
              && typeof parsed.maxReviseRounds === "number"
              && typeof parsed.reviseRoundsUsed === "number"
              && typeof parsed.auditRounds === "number"
              && typeof parsed.stoppedByMaxRounds === "boolean"
              && (parsed.finalState === "passed" || parsed.finalState === "failed-max-rounds" || parsed.finalState === "failed-single-audit")
              && Array.isArray(parsed.revisions)
            ) {
              return parsed as UnifiedReviewLoopAutoReviewPayload;
            }
          }
          const passed = typeof (result.auditResult as { passed?: unknown } | undefined)?.passed === "boolean"
            ? Boolean((result.auditResult as { passed?: unknown }).passed)
            : result.status !== "audit-failed";
          return buildSingleAuditAutoReviewPayload(passed);
        })();
        broadcast("write:complete", {
          bookId: id,
          chapterNumber: result.chapterNumber,
          status: result.status,
          title: result.title,
          wordCount: result.wordCount,
          autoReview,
        });
      },
      (e) => {
        broadcast("write:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
      },
    );

    return c.json({ status: "writing", bookId: id });
  });

  app.post("/api/v1/books/:id/draft", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number; context?: string; service?: string; model?: string }>()
      .catch(() => ({ wordCount: undefined, context: undefined, service: undefined, model: undefined }));
    const currentConfig = await loadCurrentProjectConfig();
    const selectedRuntime = await resolvePipelineClientFromSelection({
      currentConfig,
      selectedService: body.service,
      selectedModel: body.model,
    });
    if (selectedRuntime.error) {
      return c.json({ error: selectedRuntime.error }, 400);
    }

    broadcast("draft:start", { bookId: id });

    const pipeline = new PipelineRunner(await buildPipelineConfig({
      currentConfig,
      bookId: id,
      ...(selectedRuntime.client ? { client: selectedRuntime.client } : {}),
      ...(selectedRuntime.model ? { model: selectedRuntime.model } : {}),
    }));
    pipeline.writeDraft(id, body.context, body.wordCount).then(
      (result) => {
        broadcast("draft:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        broadcast("draft:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
      },
    );

    return c.json({ status: "drafting", bookId: id });
  });

  app.post("/api/v1/books/:id/chapters/:num/approve", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    broadcast("approve:start", { bookId: id, chapter: num });

    try {
      const index = await state.loadChapterIndex(id);
      const target = index.find((ch) => ch.number === num);
      if (!target) {
        return c.json({ error: `Chapter ${num} not found` }, 404);
      }
      const latestAudit = Array.isArray(target.auditHistory) ? target.auditHistory[target.auditHistory.length - 1] : undefined;
      const latestScore = typeof latestAudit?.score === "number" ? Math.trunc(latestAudit.score) : null;
      if (!latestAudit || latestScore === null || latestScore < AUDIT_PASS_SCORE_THRESHOLD || latestAudit.passed !== true) {
        return c.json({ error: `Chapter ${num} audit score must be at least ${AUDIT_PASS_SCORE_THRESHOLD} before approval.` }, 409);
      }
      const updated = index.map((ch) =>
        ch.number === num ? { ...ch, status: "approved" as const } : ch,
      );
      await state.saveChapterIndex(id, updated);
      broadcast("approve:complete", { bookId: id, chapterNumber: num, status: "approved" });
      return c.json({ ok: true, chapterNumber: num, status: "approved" });
    } catch (e) {
      broadcast("approve:error", { bookId: id, chapter: num, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/reject", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);

    try {
      const index = await state.loadChapterIndex(id);
      const target = index.find((ch) => ch.number === num);
      if (!target) {
        return c.json({ error: `Chapter ${num} not found` }, 404);
      }

      const rollbackTarget = num - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      return c.json({
        ok: true,
        chapterNumber: num,
        status: "rejected",
        rolledBackTo: rollbackTarget,
        discarded,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- SSE ---

  app.get("/api/v1/events", (c) => {
    return streamSSE(c, async (stream) => {
      const handler: EventHandler = (event, data) => {
        stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      subscribers.add(handler);

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" });
      }, 30000);

      stream.onAbort(() => {
        subscribers.delete(handler);
        clearInterval(keepAlive);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // --- Model discovery ---

  app.get("/api/v1/services", async (c) => {
    const secrets = await loadSecrets(root);

    const SERVICE_KEYS = [
      "openai", "anthropic", "deepseek", "moonshot", "minimax",
      "bailian", "zhipu", "siliconflow", "ppio", "openrouter", "ollama",
    ];

    // Fast: only check connection status from secrets, no external API calls
    const services = SERVICE_KEYS.map((key) => {
      const preset = resolveServicePreset(key);
      return {
        service: key,
        label: preset?.label ?? key,
        connected: Boolean(secrets.services[key]?.apiKey),
      };
    });

    // Add custom services from inkos.json
    try {
      const config = await loadRawConfig(root);
      for (const svc of normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services)) {
        if (svc.service === "custom") {
          const secretKey = `custom:${svc.name}`;
          services.push({
            service: secretKey,
            label: svc.name ?? "Custom",
            connected: Boolean(secrets.services[secretKey]?.apiKey),
          });
        }
      }
    } catch { /* no config file */ }

    return c.json({ services });
  });

  app.get("/api/v1/services/config", async (c) => {
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const services = normalizeServiceConfig(llm.services);
    const envConfig = await readEnvConfigStatus(root);
    const configuredService = typeof llm.service === "string" && llm.service.trim().length > 0
      ? llm.service.trim()
      : null;
    return c.json({
      services,
      service: configuredService,
      defaultModel: llm.defaultModel ?? null,
      configSource: normalizeConfigSource(llm.configSource),
      envConfig,
    });
  });

  app.put("/api/v1/services/config", async (c) => {
    const body = await c.req.json<{ services?: unknown; defaultModel?: string; configSource?: LLMConfigSource; service?: string }>();
    const config = await loadRawConfig(root);
    config.llm = config.llm ?? {};
    const llm = config.llm as Record<string, unknown>;
    if (body.services !== undefined) {
      const existingServices = normalizeServiceConfig(llm.services);
      const incomingServices = normalizeServiceConfig(body.services);
      llm.services = mergeServiceConfig(existingServices, incomingServices);
    }
    if (body.defaultModel !== undefined) {
      llm.defaultModel = body.defaultModel;
      if (typeof body.defaultModel === "string" && body.defaultModel.length > 0) {
        llm.model = body.defaultModel;
      }
    }
    if (body.configSource !== undefined) {
      llm.configSource = normalizeConfigSource(body.configSource);
    }
    if (body.service !== undefined) {
      llm.service = body.service;
    }
    await saveRawConfig(root, config);
    modelListCache.clear();
    return c.json({ ok: true });
  });

  app.post("/api/v1/services/:service/test", async (c) => {
    const service = c.req.param("service");
    const { apiKey, baseUrl, apiFormat, stream } = await c.req.json<{
      apiKey: string;
      baseUrl?: string;
      apiFormat?: "chat" | "responses";
      stream?: boolean;
    }>();

    if (!apiKey?.trim()) {
      return c.json({ ok: false, error: "API Key 不能为空" }, 400);
    }

    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, baseUrl);
    if (!resolvedBaseUrl) {
      return c.json({ ok: false, error: `未知服务商: ${service}` }, 400);
    }

    const probe = await probeServiceCapabilities({
      root,
      service,
      apiKey: apiKey.trim(),
      baseUrl: resolvedBaseUrl,
      preferredApiFormat: apiFormat,
      preferredStream: stream,
    });

    if (!probe.ok) {
      return c.json({ ok: false, error: probe.error ?? "连接失败" }, 400);
    }

    return c.json({
      ok: true,
      modelCount: probe.models.length,
      models: probe.models,
      selectedModel: probe.selectedModel,
      detected: {
        apiFormat: probe.apiFormat,
        stream: probe.stream,
        baseUrl: probe.baseUrl,
        modelsSource: probe.modelsSource,
      },
    });
  });

  app.post("/api/v1/services/:service/models/:model/test", async (c) => {
    const service = c.req.param("service");
    const model = c.req.param("model").trim();
    const body = await c.req.json<{
      apiKey?: string;
      baseUrl?: string;
      apiFormat?: "chat" | "responses";
      stream?: boolean;
    }>().catch(() => ({} as {
      apiKey?: string;
      baseUrl?: string;
      apiFormat?: "chat" | "responses";
      stream?: boolean;
    }));

    if (!model) {
      return c.json({
        ok: false,
        model: "",
        canConnect: false,
        elapsedMs: 0,
        apiFormat: "chat",
        stream: false,
        error: "模型名称不能为空",
      }, 400);
    }

    const configuredEntry = await resolveConfiguredServiceEntry(root, service);
    const apiFormat = body.apiFormat ?? configuredEntry?.apiFormat ?? "chat";
    const stream = typeof body.stream === "boolean" ? body.stream : configuredEntry?.stream ?? false;
    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, body.baseUrl);

    if (!resolvedBaseUrl) {
      return c.json({
        ok: false,
        model,
        canConnect: false,
        elapsedMs: 0,
        apiFormat,
        stream,
        error: `未知服务商: ${service}`,
      }, 400);
    }

    const providedApiKey = body.apiKey?.trim();
    const apiKey = providedApiKey && providedApiKey.length > 0
      ? providedApiKey
      : await getServiceApiKey(root, service);

    if (!apiKey?.trim()) {
      return c.json({
        ok: false,
        model,
        canConnect: false,
        elapsedMs: 0,
        apiFormat,
        stream,
        error: "API Key 不能为空",
      }, 400);
    }

    const result = await runSingleModelConnectivityTest({
      service,
      model,
      apiKey,
      baseUrl: resolvedBaseUrl,
      apiFormat,
      stream,
    });

    const payload = {
      ok: result.ok,
      model,
      canConnect: result.ok,
      elapsedMs: result.elapsedMs,
      apiFormat: result.apiFormat,
      stream: result.stream,
      ...(result.error ? { error: result.error } : {}),
    };
    return c.json(payload, result.ok ? 200 : 400);
  });

  app.put("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const { apiKey } = await c.req.json<{ apiKey: string }>();
    const secrets = await loadSecrets(root);
    if (apiKey?.trim()) {
      secrets.services[service] = { apiKey: apiKey.trim() };
    } else {
      delete secrets.services[service];
    }
    await saveSecrets(root, secrets);
    for (const key of modelListCache.keys()) {
      if (key.startsWith(`${service}::`)) {
        modelListCache.delete(key);
      }
    }
    return c.json({ ok: true });
  });

  app.get("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const secrets = await loadSecrets(root);
    return c.json({
      apiKey: secrets.services[service]?.apiKey ?? "",
    });
  });

  app.get("/api/v1/services/:service/models", async (c) => {
    const service = c.req.param("service");
    const refresh = c.req.query("refresh") === "1";
    const sourceFilter = c.req.query("source");
    const configuredEntry = await resolveConfiguredServiceEntry(root, service);
    const configuredModels = configuredEntry?.models ?? [];
    const disabledModelIds = new Set(
      configuredModels
        .filter((model) => model.enabled === false)
        .map((model) => model.id.trim())
        .filter((id) => id.length > 0),
    );
    const modelMode = configuredEntry?.modelMode ?? "hybrid";
    const manualModels = configuredModels
      .filter((model) => model.enabled !== false)
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        source: model.source ?? "manual" as const,
      }));
    const returnAutoOnly = sourceFilter === "auto";
    const apiKey = c.req.query("apiKey") || await getServiceApiKey(root, service);

    // No key = no models
    if (!apiKey) {
      const effective = returnAutoOnly
        ? []
        : composeEffectiveModels({
            mode: modelMode,
            manualModels,
            detectedModels: [],
            disabledModelIds,
          });
      return c.json({
        models: effective,
        modelMode,
        preferredModel: configuredEntry?.preferredModel ?? null,
      });
    }

    const preset = resolveServicePreset(isCustomServiceId(service) ? "custom" : service);
    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service);

    // Cache by service + resolved baseUrl + apiKey fingerprint; valid for 10 min unless ?refresh=1
    const modelConfigFingerprint = configuredModels
      .map((model) => `${model.id}:${model.name ?? model.id}:${model.enabled === false ? "0" : "1"}:${model.source ?? "manual"}`)
      .join("|");
    const cacheKey = `${service}::${resolvedBaseUrl ?? ""}::${apiKey.slice(-8)}::${modelMode}::${modelConfigFingerprint}`;
    if (!refresh) {
      const cached = modelListCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        const models = returnAutoOnly
          ? cached.models.filter((model) => model.source !== "manual" && !disabledModelIds.has(model.id))
          : cached.models;
        return c.json({
          models,
          modelMode,
          preferredModel: configuredEntry?.preferredModel ?? null,
        });
      }
    }

    let detectedModels: Array<{ id: string; name: string; source?: "manual" | "detected" }> = [];

    // Fast path: services with knownModels return immediately
    if (preset?.knownModels && preset.knownModels.length > 0) {
      detectedModels = preset.knownModels.map((id) => ({ id, name: id, source: "detected" }));
    } else if (resolvedBaseUrl) {
      // Simple /models API call + fallback to pi-ai built-in list (no slow probe)
      const modelsBase = preset?.modelsBaseUrl ?? resolvedBaseUrl;
      try {
        const modelsUrl = modelsBase.replace(/\/$/, "") + "/models";
        const res = await fetch(modelsUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const json = await res.json() as { data?: Array<{ id: string }> };
          detectedModels = (json.data ?? []).map((m) => ({ id: m.id, name: m.id, source: "detected" as const }));
        }
      } catch { /* timeout or network error */ }
      if (detectedModels.length === 0) {
        const builtIn = await listModelsForService(service, apiKey);
        detectedModels = builtIn.map((m) => ({ id: m.id, name: m.name, source: "detected" as const }));
      }
    }

    const effectiveModels = composeEffectiveModels({
      mode: modelMode,
      manualModels,
      detectedModels,
      disabledModelIds,
    });
    modelListCache.set(cacheKey, { models: effectiveModels, at: Date.now() });

    const autoModels = dedupeModelsById(detectedModels)
      .filter((model) => !disabledModelIds.has(model.id));

    return c.json({
      models: returnAutoOnly ? autoModels : effectiveModels,
      modelMode,
      preferredModel: configuredEntry?.preferredModel ?? null,
    });
  });

  // --- Project info ---

  app.get("/api/v1/project", async (c) => {
    const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
    // Check if language was explicitly set in inkos.json (not just the schema default)
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const languageExplicit = "language" in raw && raw.language !== "";

    return c.json({
      name: currentConfig.name,
      language: currentConfig.language,
      languageExplicit,
      model: currentConfig.llm.model,
      provider: currentConfig.llm.provider,
      baseUrl: currentConfig.llm.baseUrl,
      stream: currentConfig.llm.stream,
      temperature: currentConfig.llm.temperature,
      maxTokens: currentConfig.llm.maxTokens,
    });
  });

  // --- Config editing ---

  app.put("/api/v1/project", async (c) => {
    const updates = await c.req.json<Record<string, unknown>>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      // Merge LLM settings
      if (updates.temperature !== undefined) {
        existing.llm.temperature = updates.temperature;
      }
      if (updates.maxTokens !== undefined) {
        existing.llm.maxTokens = updates.maxTokens;
      }
      if (updates.stream !== undefined) {
        existing.llm.stream = updates.stream;
      }
      if (updates.language === "zh" || updates.language === "en") {
        existing.language = updates.language;
      }
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth files browser ---

  app.get("/api/v1/books/:id/truth", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const storyDir = join(bookDir, "story");
    try {
      const rootFiles = await readdir(storyDir).catch(() => [] as string[]);
      const outlineDir = join(storyDir, "outline");
      const outlineFiles = await readdir(outlineDir).catch(() => [] as string[]);
      const mdFiles = [
        ...rootFiles.filter((f) => f.endsWith(".md")),
        ...outlineFiles.filter((f) => f.endsWith(".md")).map((f) => `story/outline/${f}`),
      ];
      const deduped = new Map<string, { path: string; alias: string }>();
      for (const file of mdFiles) {
        const alias = TRUTH_FILE_ALIASES[file] ?? file;
        const existing = deduped.get(alias);
        if (!existing || (existing.path === "volume_outline.md" && file === "story/outline/volume_map.md")) {
          deduped.set(alias, { path: file, alias });
        }
      }
      const result = await Promise.all(
        [...deduped.values()].map(async ({ path, alias }) => {
          const content = await readFile(resolveTruthFileReadPath(bookDir, path), "utf-8");
          return { name: resolveTruthFileResponseName(alias), size: content.length, preview: content.slice(0, 200) };
        }),
      );
      return c.json({ files: result });
    } catch {
      return c.json({ files: [] });
    }
  });

  // --- Daemon control ---

  let schedulerInstance: import("@actalk/inkos-core").Scheduler | null = null;

  app.get("/api/v1/daemon", (c) => {
    return c.json({
      running: schedulerInstance?.isRunning ?? false,
    });
  });

  app.post("/api/v1/daemon/start", async (c) => {
    if (schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon already running" }, 400);
    }
    try {
      const { Scheduler } = await import("@actalk/inkos-core");
      const currentConfig = await loadCurrentProjectConfig();
      const scheduler = new Scheduler({
        ...(await buildPipelineConfig()),
        radarCron: currentConfig.daemon.schedule.radarCron,
        writeCron: currentConfig.daemon.schedule.writeCron,
        maxConcurrentBooks: currentConfig.daemon.maxConcurrentBooks,
        chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
        retryDelayMs: currentConfig.daemon.retryDelayMs,
        cooldownAfterChapterMs: currentConfig.daemon.cooldownAfterChapterMs,
        maxChaptersPerDay: currentConfig.daemon.maxChaptersPerDay,
        onChapterComplete: (bookId, chapter, status) => {
          broadcast("daemon:chapter", { bookId, chapter, status });
        },
        onError: (bookId, error) => {
          broadcast("daemon:error", { bookId, error: error.message });
        },
      });
      schedulerInstance = scheduler;
      broadcast("daemon:started", {});
      void scheduler.start().catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        if (schedulerInstance === scheduler) {
          scheduler.stop();
          schedulerInstance = null;
          broadcast("daemon:stopped", {});
        }
        broadcast("daemon:error", { bookId: "scheduler", error: error.message });
      });
      return c.json({ ok: true, running: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/daemon/stop", (c) => {
    if (!schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon not running" }, 400);
    }
    schedulerInstance.stop();
    schedulerInstance = null;
    broadcast("daemon:stopped", {});
    return c.json({ ok: true, running: false });
  });

  // --- Logs ---

  app.get("/api/v1/logs", async (c) => {
    const logPath = join(root, "inkos.log");
    try {
      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").slice(-100);
      const entries = lines.map((line) => {
        try { return JSON.parse(line); } catch { return { message: line }; }
      });
      return c.json({ entries });
    } catch {
      return c.json({ entries: [] });
    }
  });

  // --- Agent chat ---

  app.get("/api/v1/interaction/session", async (c) => {
    const session = await loadProjectSession(root);
    const activeBookId = await resolveSessionActiveBook(root, session);
    return c.json({
      session: activeBookId && session.activeBookId !== activeBookId
        ? { ...session, activeBookId }
        : session,
      activeBookId,
    });
  });

  app.post("/api/v1/interaction/session", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      input?: string;
      request?: unknown;
      activeBookId?: string;
    };

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    const tools = createInteractionToolsFromDeps(pipeline, state);
    const activeBookId = body.activeBookId?.trim() || undefined;

    try {
      const result = body.request !== undefined
        ? await processProjectInteractionRequest({
            projectRoot: root,
            request: InteractionRequestSchema.parse(body.request),
            tools,
            activeBookId,
          })
        : await processProjectInteractionInput({
            projectRoot: root,
            input: body.input ?? "",
            tools,
            activeBookId,
          });

      return c.json({
        response: result.responseText,
        details: result.details,
        session: result.session,
        request: result.request,
      });
    } catch (error) {
      if (error && typeof error === "object") {
        const structured = error as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
        if (typeof structured.status === "number" && typeof structured.code === "string" && structured.code.trim() && typeof structured.message === "string") {
          return new Response(JSON.stringify({
            error: {
              code: structured.code,
              message: structured.message,
            },
            ...(structured.details !== undefined ? { details: structured.details } : {}),
          }), {
            status: structured.status,
            headers: { "content-type": "application/json" },
          });
        }
      }
      throw error;
    }
  });

  // -- Per-book session endpoints --

  app.get("/api/v1/sessions", async (c) => {
    const bookId = c.req.query("bookId");
    const sessions = await listBookSessions(root, bookId === undefined ? null : bookId === "null" ? null : bookId);
    return c.json({ sessions });
  });

  app.get("/api/v1/sessions/:sessionId", async (c) => {
    const session = await loadBookSession(root, c.req.param("sessionId"));
    if (!session) return c.json({ session: null });
    return c.json({ session });
  });

  app.post("/api/v1/sessions", async (c) => {
    const body = await c.req.json<{ bookId?: string | null; sessionId?: string }>().catch(() => ({}));
    const bookId = (body as { bookId?: string | null }).bookId ?? null;
    const sessionId = (body as { sessionId?: string }).sessionId;
    // sessionId 只允许 timestamp-random 格式；防止注入任意文件名
    const safeSessionId = sessionId && /^[0-9]+-[a-z0-9]+$/.test(sessionId) ? sessionId : undefined;
    const session = await createAndPersistBookSession(root, bookId, safeSessionId);
    return c.json({ session });
  });

  app.put("/api/v1/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
    const title = body.title?.trim();
    if (!title) {
      throw new ApiError(400, "INVALID_SESSION_TITLE", "Session title is required");
    }

    const session = await renameBookSession(root, sessionId, title);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ session });
  });

  app.delete("/api/v1/sessions/:sessionId", async (c) => {
    await deleteBookSession(root, c.req.param("sessionId"));
    return c.json({ ok: true });
  });

  app.post("/api/v1/agent/stop", async (c) => {
    const payload = await c.req.json<{ sessionId?: string; runId?: string }>()
      .catch(() => ({} as { sessionId?: string; runId?: string }));
    const sessionId = payload.sessionId?.trim();
    const requestedRunId = payload.runId?.trim();
    if (!sessionId) {
      throw new ApiError(400, "SESSION_ID_REQUIRED", "sessionId is required");
    }

    const targetRunId = requestedRunId || inFlightAgentRunIdBySession.get(sessionId);
    if (!targetRunId) {
      return c.json({ ok: true, stopped: false, sessionId, runId: null });
    }

    const inFlight = inFlightAgentRunsByRunId.get(targetRunId);
    if (!inFlight || inFlight.sessionId !== sessionId) {
      return c.json({ ok: true, stopped: false, sessionId, runId: targetRunId });
    }

    inFlight.controller.abort();
    broadcast("agent:stopped", { sessionId, runId: inFlight.runId });
    const waitUntil = Date.now() + 1_500;
    while (
      inFlightAgentRunIdBySession.get(sessionId) === inFlight.runId
      && Date.now() < waitUntil
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return c.json({ ok: true, stopped: true, sessionId, runId: inFlight.runId });
  });

  app.get("/api/v1/agent/status", async (c) => {
    const sessionId = c.req.query("sessionId")?.trim();
    const requestedRunId = c.req.query("runId")?.trim();
    if (!sessionId) {
      throw new ApiError(400, "SESSION_ID_REQUIRED", "sessionId is required");
    }

    const targetRunId = requestedRunId || inFlightAgentRunIdBySession.get(sessionId);
    if (!targetRunId) {
      return c.json({ ok: true, running: false, sessionId, runId: null });
    }

    const inFlight = inFlightAgentRunsByRunId.get(targetRunId);
    if (!inFlight || inFlight.sessionId !== sessionId) {
      return c.json({ ok: true, running: false, sessionId, runId: targetRunId });
    }

    return c.json({
      ok: true,
      running: true,
      sessionId,
      runId: inFlight.runId,
      startedAt: inFlight.startedAt,
      aborted: inFlight.controller.signal.aborted,
    });
  });

  app.post("/api/v1/agent", async (c) => {
    const payload = await c.req.json<{
      instruction: string;
      activeBookId?: string;
      sessionId?: string;
      runId?: string;
      model?: string;
      service?: string;
      quickMode?: boolean;
      preferFastWriterModel?: boolean;
      forceStream?: boolean;
      responseFormat?: "json_object";
      wizardStep?: string;
      wizardAdvance?: {
        wizardStep: string;
        nextStep?: string;
        language: string;
        stepTitle: string;
        title?: string;
        genre?: string;
        platform?: string;
        targetChapters?: number;
        chapterWordCount?: number;
        instruction?: string;
      };
    }>();
    const {
      instruction,
      activeBookId,
      sessionId: reqSessionId,
      runId: reqRunId,
      model: reqModel,
      service: reqService,
      quickMode: reqQuickMode,
      preferFastWriterModel: reqPreferFastWriterModel,
      forceStream: reqForceStream,
      responseFormat: reqResponseFormat,
      wizardStep: reqWizardStep,
      wizardAdvance: reqWizardAdvance,
    } = payload;
    const sessionId = reqSessionId;
    const runId = reqRunId?.trim() || createAgentRunId();
    const isWizardContext = isWizardStepRequest(reqWizardStep)
      || isWizardStepRequest(reqWizardAdvance?.wizardStep)
      || isWizardStepRequest(reqWizardAdvance?.nextStep);
    const writeIntent = isWizardContext ? false : isWriteInstruction(instruction ?? "");
    const deterministicAction = activeBookId && !isWizardContext
      ? parseDeterministicAgentAction(instruction ?? "")
      : null;
    const destructiveInstructionRequested = deterministicAction?.kind === "rewrite"
      || deterministicAction?.kind === "rewrite-batch";
    const writerKernelIntent = writeIntent
      || deterministicAction?.kind === "rewrite"
      || deterministicAction?.kind === "rewrite-batch";
    const quickMode = reqQuickMode ?? writeIntent;
    const preferFastWriterModel = reqPreferFastWriterModel ?? true;
    const forceStream = reqForceStream === true;
    const responseFormat = reqResponseFormat;
    let writeIndexBefore: ReadonlyArray<ChapterIndexEntryLike> = [];
    if (!instruction?.trim()) {
      return c.json({ error: "No instruction provided" }, 400);
    }
    if (!sessionId?.trim()) {
      throw new ApiError(400, "SESSION_ID_REQUIRED", "sessionId is required");
    }

    if (inFlightAgentRunIdBySession.has(sessionId)) {
      return c.json({
        error: { code: "AGENT_BUSY", message: "正在处理中，请等待当前操作完成" },
        response: "正在处理中，请等待当前操作完成后再发送。",
        runId,
      }, 429);
    }

    const abortController = new AbortController();
    registerInFlightAgentRun(sessionId, runId, abortController);
    let persistedBookSession: Awaited<ReturnType<typeof loadBookSession>> = null;
    let assistantCheckpointTimestamp = Date.now() + 1;
    let checkpointWriter: RunCheckpointWriter | null = null;
    let checkpointSubscriber: EventHandler | null = null;
    const persistAssistantErrorResponse = async (message: string): Promise<void> => {
      if (checkpointWriter) {
        await checkpointWriter.flush({ terminal: true });
      }
      if (!persistedBookSession) return;
      persistedBookSession = appendBookSessionMessage(persistedBookSession, {
        role: "assistant",
        content: `✗ ${message}`,
        timestamp: assistantCheckpointTimestamp + 1,
      });
      await persistBookSession(root, persistedBookSession);
    };

    if (writerKernelIntent && activeBookId) {
      writeIndexBefore = await state.loadChapterIndex(activeBookId).catch(() => [] as ChapterIndexEntryLike[]);
    }

    broadcast("agent:start", { instruction, activeBookId, sessionId, runId });

    try {
      // Load config + create LLM client (pipeline created after model resolution)
      const config = await loadCurrentProjectConfig({ requireApiKey: false });
      const mergedLlmExtra = responseFormat
        ? { ...(config.llm.extra ?? {}), response_format: { type: responseFormat } }
        : config.llm.extra;
      const baseLlmConfig = {
        ...config.llm,
        ...(mergedLlmExtra ? { extra: mergedLlmExtra } : {}),
      };
      const client = createLLMClient(forceStream ? { ...baseLlmConfig, stream: true } : baseLlmConfig);

      const loadedBookSession = await loadBookSession(root, sessionId);
      if (!loadedBookSession) {
        throw new ApiError(404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      }
      let bookSession = loadedBookSession;
      persistedBookSession = bookSession;

      // 向导推进预处理：在 Agent 运行前先完成保存，确保 Agent 读到最新 draft
      if (reqWizardAdvance) {
        const wizardPipeline = new PipelineRunner(await buildPipelineConfig());
        const wizardTools = createInteractionToolsFromDeps(wizardPipeline, state);
        try {
          const wizardResult = await processProjectInteractionRequest({
            projectRoot: root,
            request: InteractionRequestSchema.parse({
              intent: "advance_book_wizard",
              language: reqWizardAdvance.language,
              stepTitle: reqWizardAdvance.stepTitle,
              wizardStep: reqWizardAdvance.wizardStep,
              ...(reqWizardAdvance.nextStep ? { nextStep: reqWizardAdvance.nextStep } : {}),
              ...(reqWizardAdvance.title ? { title: reqWizardAdvance.title } : {}),
              ...(reqWizardAdvance.genre ? { genre: reqWizardAdvance.genre } : {}),
              ...(reqWizardAdvance.platform ? { platform: reqWizardAdvance.platform } : {}),
              ...(typeof reqWizardAdvance.targetChapters === "number" ? { targetChapters: reqWizardAdvance.targetChapters } : {}),
              ...(typeof reqWizardAdvance.chapterWordCount === "number" ? { chapterWordCount: reqWizardAdvance.chapterWordCount } : {}),
              ...(reqWizardAdvance.instruction ? { instruction: reqWizardAdvance.instruction } : {}),
            }),
            tools: wizardTools,
          });
          // 用保存后的 session 替换，确保 Agent 读到最新 creationDraft
          if (wizardResult.session) {
            const savedSession = await loadBookSession(root, sessionId);
            if (savedSession) {
              bookSession = savedSession;
              persistedBookSession = bookSession;
            }
          }
          // 广播向导推进事件，前端可据此更新 wizard 状态
          broadcast("wizard:advanced", {
            sessionId,
            runId,
            creationDraft: wizardResult.session?.creationDraft,
            creationWizard: wizardResult.session?.creationWizard,
          });
        } catch (wizardError) {
          // 向导保存失败时广播错误，但不中断 Agent（降级为只生成内容）
          const wizardErrMsg = wizardError instanceof Error ? wizardError.message : String(wizardError);
          broadcast("wizard:advance_failed", { sessionId, runId, error: wizardErrMsg });
        }
      }
      const streamSessionId = loadedBookSession.sessionId;
      const emitAgentLog = (
        message: string,
        level: "info" | "warning" | "error" = "info",
        options?: { chapterNumber?: number },
      ): void => {
        const contextual = withLogContext({
          message,
          runId,
          chapterNumber: options?.chapterNumber,
        });
        broadcast("log", {
          sessionId: streamSessionId,
          runId,
          activeBookId,
          level,
          tag: "studio",
          message: contextual.message,
          ...(typeof contextual.chapterNumber === "number" ? { chapterNumber: contextual.chapterNumber } : {}),
        });
      };
      const emitRewriteAuditLog = (args: {
        readonly mode: "destructive" | "non-destructive";
        readonly target: string;
        readonly riskMessage?: string;
      }): void => {
        const compactInstruction = compactInstructionForAuditLog(instruction ?? "");
        const message = [
          `[rewrite:audit] mode=${args.mode}`,
          `target=${args.target}`,
          `instruction="${compactInstruction}"`,
          args.riskMessage ? `risk="${args.riskMessage}"` : null,
        ].filter(Boolean).join(" ");
        emitAgentLog(message, args.mode === "destructive" ? "warning" : "info");
      };
      let effectiveReqService = reqService?.trim();
      let effectiveReqModel = reqModel?.trim();
      if (writerKernelIntent && preferFastWriterModel) {
        const services = normalizeServiceConfig((config.llm as Record<string, unknown>).services);
        const configuredDefaultModel = (config.llm as Record<string, unknown>).defaultModel;
        const fallbackModel = typeof configuredDefaultModel === "string" && configuredDefaultModel.trim().length > 0
          ? configuredDefaultModel.trim()
          : config.llm.model;
        const fastSelection = resolveFastWriterModelSelection({
          services,
          currentModel: effectiveReqModel ?? fallbackModel,
          preferredServiceKey: effectiveReqService,
        });
        if (fastSelection) {
          const fromModel = effectiveReqModel ?? fallbackModel;
          const fromService = effectiveReqService ?? fastSelection.serviceKey;
          effectiveReqService = fastSelection.serviceKey;
          effectiveReqModel = fastSelection.model;
          emitAgentLog(`写作快速模式：模型已从 ${fromService}/${fromModel} 自动切换为 ${effectiveReqService}/${effectiveReqModel}`);
        }
      }

      // Build initial message context from persisted session
      const initialMessages = bookSession.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const explicitAuditChapter = parseExplicitAuditChapter(instruction);
      const targetBookId = activeBookId ?? bookSession.bookId ?? null;
      if (explicitAuditChapter !== null && !targetBookId) {
        return c.json({
          error: "当前会话未绑定书籍，无法执行审计。请先打开一本书后再试。",
          response: "当前会话未绑定书籍，无法执行审计。请先打开一本书后再试。",
        }, 400);
      }
      const effectiveInstruction = explicitAuditChapter !== null
        ? buildAuditInstruction(instruction, explicitAuditChapter)
        : instruction;

      // Persist the user's turn immediately so the session history survives
      // later model/tool failures, aborts, or write-integrity rejections.
      const userMessageTimestamp = Date.now();
      bookSession = appendBookSessionMessage(bookSession, {
        role: "user",
        content: instruction,
        timestamp: userMessageTimestamp,
      });
      persistedBookSession = bookSession;
      assistantCheckpointTimestamp = userMessageTimestamp + 1;
      if (bookSession.title === null) {
        const oneLine = instruction.trim().replace(/\s+/g, " ");
        const title = oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
        if (title) {
          bookSession = { ...bookSession, title };
          persistedBookSession = bookSession;
          broadcast("session:title", { sessionId: bookSession.sessionId, title });
        }
      }
      await persistBookSession(root, bookSession);
      checkpointWriter = createRunCheckpointWriter({
        projectRoot: root,
        sessionId: bookSession.sessionId,
        runId,
        assistantTimestamp: assistantCheckpointTimestamp,
        getSession: () => persistedBookSession,
        setSession: (session) => {
          if (!session) return;
          bookSession = session;
          persistedBookSession = session;
        },
      });
      checkpointSubscriber = (event, data) => {
        checkpointWriter?.handleEvent(event, data);
      };
      subscribers.add(checkpointSubscriber);

      // Resolve model — multi-service resolution
      let resolvedModel: ResolvedModel["model"] | undefined;
      let resolvedApiKey: string | undefined;

      if (effectiveReqService && effectiveReqModel) {
        // 1. Frontend explicitly selected a service+model — fail loudly if no key
        try {
          const configuredEntry = await resolveConfiguredServiceEntry(root, effectiveReqService);
          const resolved = await resolveServiceModel(
            effectiveReqService,
            effectiveReqModel,
            root,
            await resolveConfiguredServiceBaseUrl(root, effectiveReqService),
            configuredEntry?.apiFormat,
          );
          resolvedModel = resolved.model;
          resolvedApiKey = resolved.apiKey;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (/API key/i.test(msg)) {
            return c.json({
              error: `请先为 ${effectiveReqService} 配置 API Key`,
              response: `请先在模型配置中为 ${effectiveReqService} 填写 API Key，然后再试。`,
            }, 400);
          }
          throw e;
        }
      }

      if (!resolvedModel) {
        // 2. Try defaultModel from new config format
        const rawConfig = config.llm as unknown as Record<string, unknown>;
        const defaultModel = rawConfig.defaultModel as string | undefined;
        const servicesArr = normalizeServiceConfig(rawConfig.services);
        const firstService = servicesArr[0];
        if (firstService?.service && defaultModel) {
          try {
            const resolved = await resolveServiceModel(
              serviceConfigKey(firstService),
              defaultModel,
              root,
              firstService.baseUrl,
              firstService.apiFormat,
            );
            resolvedModel = resolved.model;
            resolvedApiKey = resolved.apiKey;
          } catch { /* fall through */ }
        }
      }

      if (!resolvedModel) {
        // 3. Try first connected service from secrets
        const secrets = await loadSecrets(root);
        for (const [svcName, svcData] of Object.entries(secrets.services)) {
          if (svcData?.apiKey) {
            try {
              const models = await listModelsForService(svcName, svcData.apiKey);
              if (models.length > 0) {
                const configuredEntry = await resolveConfiguredServiceEntry(root, svcName);
                const resolved = await resolveServiceModel(
                  svcName,
                  models[0].id,
                  root,
                  await resolveConfiguredServiceBaseUrl(root, svcName),
                  configuredEntry?.apiFormat,
                );
                resolvedModel = resolved.model;
                resolvedApiKey = resolved.apiKey;
                break;
              }
            } catch { /* try next */ }
          }
        }
      }

      if (!resolvedModel) {
        // 4. Legacy fallback: use createLLMClient
        resolvedModel = client._piModel
          ? client._piModel
          : { provider: config.llm.provider ?? "anthropic", modelId: config.llm.model } as any;
        resolvedApiKey = client._apiKey;
      }

      const model = resolvedModel!;
      const agentApiKey = resolvedApiKey;
      const configuredEntry = effectiveReqService
        ? await resolveConfiguredServiceEntry(root, effectiveReqService)
        : undefined;
      const emittedChapterPreviewNumbers = new Set<number>();

      // Create pipeline with resolved model (so sub_agent tools use the frontend-selected model)
      // Don't spread config.llm — its baseUrl/provider belong to the old service.
      // Let createLLMClient resolve baseUrl from the service preset.
      const pipelineClient = (effectiveReqService && effectiveReqModel && resolvedApiKey)
        ? createLLMClient({
            ...baseLlmConfig,
            service: configuredEntry?.service ?? effectiveReqService,
            model: effectiveReqModel,
            apiKey: resolvedApiKey,
            ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
            ...(forceStream ? { stream: true } : configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
            baseUrl: configuredEntry?.baseUrl ?? "",
          } as any)
        : client;
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        client: pipelineClient,
        model: effectiveReqModel ?? config.llm.model,
        currentConfig: config,
        bookId: activeBookId,
        sessionIdForSSE: bookSession.sessionId,
        runIdForSSE: runId,
        onChapterDelta: (payload) => {
          if (payload.previewType !== "chapter") return;
          const chapterNumber = Number(payload.chapterNumber ?? 0);
          if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) return;
          emittedChapterPreviewNumbers.add(chapterNumber);
        },
        defaultWriteNextQuickMode: quickMode,
        writeStageHeartbeatMs: resolveWriteStageHeartbeatMs(),
      }));
      const tools = createInteractionToolsFromDeps(pipeline, state, {
        onThinkingDelta: (text: string) => {
          broadcast("thinking:delta", { sessionId: streamSessionId, runId, text });
        },
        onDraftTextDelta: (text: string) => {
          broadcast("draft:delta", { sessionId: streamSessionId, runId, text });
        },
        onDraftRawDelta: (text: string) => {
          broadcast("draft:delta", { sessionId: streamSessionId, runId, text });
        },
      } as any);

      // Run pi-agent session
      const collectedToolExecs: CollectedToolExec[] = [];
      const batchProgressByToolCallId = new Map<string, BatchProgressState>();
      let sawDraftDelta = false;
      let sawWriterToolStart = false;
      let sawWriterToolSuccess = false;
      let sawWriterToolError = false;
      let precomputedWritePersistence: WritePersistenceCheckResult | null = null;
      let latestAuditReport: AuditToolReport | null = null;
      let explicitAuditToolCalled = false;
      const isIntroRevisionRequest = typeof instruction === "string"
        && /^\/intro(?:\s+|$)/i.test(instruction.trim())
        && (reqWizardStep === "intro" || reqWizardAdvance?.wizardStep === "intro" || /wizardStep=intro/i.test(instruction));
      const isWizardDraftRequest = !isIntroRevisionRequest
        && isWizardStepRequest(reqWizardStep)
        && reqWizardStep !== "intro";

      if (isIntroRevisionRequest) {
        if (!tools.reviseBookIntro) {
          throw new Error("简介正文生成工具未就绪。");
        }
        const introSeed = reqWizardAdvance?.instruction?.trim() || instruction.trim();
        broadcast("thinking:start", { sessionId: streamSessionId, runId });
        const introToolResult = await tools.reviseBookIntro(
          introSeed,
          bookSession.creationDraft,
          (instruction.includes("mode=polish") || instruction.includes("润色")) ? "polish" : "generate",
          reqWizardAdvance?.genre ?? bookSession.creationDraft?.genre,
        );
        broadcast("thinking:end", { sessionId: streamSessionId, runId });
        const metadata = introToolResult && typeof introToolResult === "object" && "__interaction" in introToolResult
          ? (introToolResult as { __interaction?: { responseText?: string; details?: { creationDraft?: unknown; draftRaw?: string } } }).__interaction
          : undefined;
        const introDraft = metadata?.details?.creationDraft as unknown;
        const responseText = metadata?.responseText?.trim() || (introDraft && typeof introDraft === "object" && "introMarkdown" in introDraft ? String((introDraft as { introMarkdown?: unknown }).introMarkdown ?? "") : "");
        if (!responseText) {
          throw new Error("简介正文生成失败：未返回正文。");
        }
        const nextSession = metadata?.details?.creationDraft
          ? ({
              ...bookSession,
              creationDraft: metadata.details.creationDraft as any,
            } as typeof bookSession)
          : bookSession;
        bookSession = appendBookSessionMessage(nextSession, {
          role: "assistant",
          content: responseText,
          timestamp: assistantCheckpointTimestamp,
        });
        persistedBookSession = bookSession;
        await persistBookSession(root, bookSession);
        return c.json({
          response: responseText,
          runId,
          session: {
            sessionId: bookSession.sessionId,
            bookId: bookSession.bookId,
            title: bookSession.title,
            activeBookId: bookSession.bookId ?? undefined,
            creationDraft: metadata?.details?.creationDraft,
          },
          details: {
            draftRaw: metadata?.details?.draftRaw,
          },
        });
      }

      if (isWizardDraftRequest) {
        if (!tools.saveBookWizardStep) {
          throw new Error("向导正文生成工具未就绪。");
        }
        const wizardStep = reqWizardStep as Exclude<BookCreationWizardStep, "intro">;
        const wizardInput = instruction.trim();
        broadcast("thinking:start", { sessionId: streamSessionId, runId });
        const wizardToolResult = await tools.saveBookWizardStep(
          wizardInput,
          bookSession.creationDraft,
          wizardStep,
        );
        broadcast("thinking:end", { sessionId: streamSessionId, runId });
        const metadata = wizardToolResult && typeof wizardToolResult === "object" && "__interaction" in wizardToolResult
          ? (wizardToolResult as {
              __interaction?: {
                responseText?: string;
                details?: {
                  creationDraft?: unknown;
                  draftRaw?: string;
                };
              };
            }).__interaction
          : undefined;
        const draftRaw = metadata?.details?.draftRaw?.trim() || "";
        const responseText = draftRaw || metadata?.responseText?.trim() || "";
        if (!responseText) {
          throw new Error("向导正文生成失败：未返回正文。");
        }
        broadcast("draft:delta", { sessionId: streamSessionId, runId, text: responseText });
        const nextSession = metadata?.details?.creationDraft
          ? ({
              ...bookSession,
              creationDraft: metadata.details.creationDraft as any,
            } as typeof bookSession)
          : bookSession;
        bookSession = appendBookSessionMessage(nextSession, {
          role: "assistant",
          content: responseText,
          timestamp: assistantCheckpointTimestamp,
          wizardStep,
        } as any);
        persistedBookSession = bookSession;
        await persistBookSession(root, bookSession);
        return c.json({
          response: responseText,
          runId,
          session: {
            sessionId: bookSession.sessionId,
            bookId: bookSession.bookId,
            title: bookSession.title,
            activeBookId: bookSession.bookId ?? undefined,
            creationDraft: metadata?.details?.creationDraft,
          },
          details: {
            draftRaw: metadata?.details?.draftRaw,
          },
        });
      }

      const persistTelemetryHooks = {
        onPersistCheck: (payload: PersistCheckTelemetry) => {
          broadcast("persist:check", {
            sessionId: streamSessionId,
            runId,
            activeBookId,
            ...payload,
          });
          if (payload.status === "started") {
            emitAgentLog(`[persist:check] start beforeCount=${payload.beforeCount}`);
            return;
          }
          emitAgentLog(
            `[persist:check] done persisted=${payload.persisted ? "true" : "false"}`
            + ` before=${payload.beforeCount}`
            + ` after=${payload.afterCount ?? 0}`
            + ` added=${(payload.addedChapterNumbers ?? []).join(",") || "-"}`
            + ` missing=${(payload.missingChapterFiles ?? []).join(",") || "-"}`,
          );
        },
        onPersistRepair: (payload: PersistRepairTelemetry) => {
          broadcast("persist:repair", {
            sessionId: streamSessionId,
            runId,
            activeBookId,
            ...payload,
          });
          if (payload.status === "started") {
            emitAgentLog("[persist:repair] start");
            return;
          }
          if (payload.status === "completed") {
            emitAgentLog(
              `[persist:repair] completed chapters=${payload.repairedChapterNumbers.join(",") || "-"}`,
            );
            return;
          }
          emitAgentLog(
            `[persist:repair] ${payload.status} reason=${payload.reason ?? "unknown"}`
            + ` chapters=${payload.repairedChapterNumbers.join(",") || "-"}`,
            payload.status === "failed" ? "error" : "warning",
          );
        },
      };

      const ensureBatchProgressState = (toolCallId: string, total: number): BatchProgressState | null => {
        if (!Number.isFinite(total) || total <= 1) return null;
        const existing = batchProgressByToolCallId.get(toolCallId);
        if (existing) {
          if (total > existing.total) {
            existing.total = total;
          }
          return existing;
        }
        const state: BatchProgressState = {
          batchId: `${runId}:${toolCallId}`,
          status: "running",
          total,
          completed: 0,
          elapsedMs: 0,
          startedAt: Date.now(),
        };
        batchProgressByToolCallId.set(toolCallId, state);
        broadcast("batch:progress", {
          sessionId: streamSessionId,
          runId,
          id: toolCallId,
          tool: "sub_agent",
          batchId: state.batchId,
          status: "started",
          total: state.total,
          completed: state.completed,
          elapsedMs: 0,
        });
        return state;
      };

      const emitBatchProgress = (
        toolCallId: string,
        status: "progress" | "completed" | "failed",
        state: BatchProgressState,
        options?: {
          readonly currentChapter?: number;
          readonly currentWords?: number;
          readonly failedChapterNumber?: number;
          readonly error?: string;
        },
      ): void => {
        broadcast("batch:progress", {
          sessionId: streamSessionId,
          runId,
          id: toolCallId,
          tool: "sub_agent",
          batchId: state.batchId,
          status,
          total: state.total,
          completed: state.completed,
          elapsedMs: elapsedSince(state.startedAt),
          ...(typeof options?.currentChapter === "number" ? { currentChapter: options.currentChapter } : {}),
          ...(typeof options?.currentWords === "number" ? { currentWords: options.currentWords } : {}),
          ...(typeof options?.failedChapterNumber === "number" ? { failedChapterNumber: options.failedChapterNumber } : {}),
          ...(options?.error ? { error: options.error } : {}),
        });
      };

      let deterministicThinkingActive = false;
      const emitDeterministicThinking = (
        text: string,
        metadata?: {
          readonly toolCallId?: string;
          readonly chapterNumber?: number;
          readonly mode?: string;
          readonly action?: string;
        },
      ): void => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const thinkingMeta = {
          ...(metadata?.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
          ...(typeof metadata?.chapterNumber === "number" ? { chapterNumber: metadata.chapterNumber } : {}),
          ...(metadata?.mode ? { mode: metadata.mode } : {}),
          ...(metadata?.action ? { action: metadata.action } : {}),
        };
        if (!deterministicThinkingActive) {
          broadcast("thinking:start", {
            sessionId: streamSessionId,
            runId,
            ...thinkingMeta,
          });
          deterministicThinkingActive = true;
        }
        broadcast("thinking:delta", {
          sessionId: streamSessionId,
          runId,
          ...thinkingMeta,
          text: trimmed,
        });
      };
      const closeDeterministicThinking = (
        metadata?: {
          readonly toolCallId?: string;
          readonly chapterNumber?: number;
          readonly mode?: string;
          readonly action?: string;
        },
      ): void => {
        if (!deterministicThinkingActive) return;
        broadcast("thinking:end", {
          sessionId: streamSessionId,
          runId,
          ...(metadata?.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
          ...(typeof metadata?.chapterNumber === "number" ? { chapterNumber: metadata.chapterNumber } : {}),
          ...(metadata?.mode ? { mode: metadata.mode } : {}),
          ...(metadata?.action ? { action: metadata.action } : {}),
        });
        deterministicThinkingActive = false;
      };

      let result: {
        responseText: string;
        messages: Array<{ role: string; content: string; thinking?: string }>;
        tokenUsage?: TokenUsageSnapshot;
      } | null = null;
      let completedAgentTokenUsage = zeroTokenUsage();
      let currentAgentTokenUsage: TokenUsageSnapshot | null = null;
      let toolAgentTokenUsage = zeroTokenUsage();
      let modelAgentTokenUsage = zeroTokenUsage();
      let agentTokenUsage = zeroTokenUsage();
      const emitAgentUsage = (
        usage: TokenUsageSnapshot | null | undefined,
        source: "model" | "tool" = "tool",
      ): void => {
        const safeUsage: TokenUsageSnapshot = usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        if (source === "model") {
          modelAgentTokenUsage = safeUsage;
        } else {
          toolAgentTokenUsage = addTokenUsage(toolAgentTokenUsage, safeUsage);
        }
        agentTokenUsage = addTokenUsage(modelAgentTokenUsage, toolAgentTokenUsage);
        broadcast("agent:usage", {
          instruction,
          activeBookId,
          sessionId,
          runId,
          tokenUsage: agentTokenUsage,
        });
      };
      if (deterministicAction && activeBookId) {
        const toolCallId = `det-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const actionMeta = {
          toolCallId,
          action: deterministicAction.kind,
          ...(typeof (deterministicAction as { chapterNumber?: unknown }).chapterNumber === "number"
            ? { chapterNumber: Number((deterministicAction as { chapterNumber?: unknown }).chapterNumber) }
            : {}),
          ...(typeof (deterministicAction as { mode?: unknown }).mode === "string"
            ? { mode: String((deterministicAction as { mode?: unknown }).mode) }
            : {}),
        } as const;
        emitDeterministicThinking(`开始执行 ${deterministicAction.kind}。`, actionMeta);
        try {
        if (deterministicAction.kind === "audit-impacted") {
          const startedAt = Date.now();
          const stages = PIPELINE_STAGES.auditor;
          const impactedChapters = await collectRewriteImpactChapterNumbers({
            state,
            bookId: activeBookId,
          });
          if (impactedChapters.length === 0) {
            const responseText = "当前没有待复核章节。";
            emitDeterministicThinking(responseText, {
              toolCallId,
              action: deterministicAction.kind,
            });
            result = {
              responseText,
              messages: [{ role: "assistant", content: responseText }],
            };
          } else {
            collectedToolExecs.push({
              id: toolCallId,
              tool: "sub_agent",
              agent: "auditor",
              label: resolveToolLabel("sub_agent", "auditor"),
              status: "running",
              args: {
                agent: "auditor",
                action: "audit-impacted",
                bookId: activeBookId,
                chapterNumbers: impactedChapters,
              },
              stages: stages.map((label) => ({ label, status: "pending" as const })),
              startedAt,
            });
            broadcast("tool:start", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              args: {
                agent: "auditor",
                action: "audit-impacted",
                bookId: activeBookId,
                chapterNumbers: impactedChapters,
              },
              stages,
            });
            const batch = ensureBatchProgressState(toolCallId, impactedChapters.length);
            const startText = `Auditor batch started for impacted chapters: ${impactedChapters.join(", ")}.`;
            emitDeterministicThinking(startText, {
              toolCallId,
              action: deterministicAction.kind,
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: startText }] },
            });

            let passedCount = 0;
            let failedCount = 0;
            let errorCount = 0;
            const chapterSummaries: string[] = [];
            const autoReviewPolicy = resolveAutoReviewPolicy(config);
            for (let index = 0; index < impactedChapters.length; index += 1) {
              const chapterNumber = impactedChapters[index]!;
              try {
                const unified = await runUnifiedReviewLoop({
                  state,
                  pipeline,
                  bookId: activeBookId,
                  chapterNumber,
                  entry: "rewrite",
                  onFinalized: ({ entry, finalAudit, autoReview }) => {
                    recordReviewMetrics({
                      bookId: activeBookId,
                      entry,
                      passed: finalAudit.passed,
                      reviseRoundsUsed: autoReview.reviseRoundsUsed,
                      finalState: autoReview.finalState,
                      issueClassCounts: finalAudit.issueClassCounts,
                      issueTexts: finalAudit.issueTexts,
                    });
                  },
                  autoReviewPolicy,
                onAuditStart: ({ round, maxReviseRounds }) => {
                  broadcast("audit:start", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: chapterNumber,
                      round,
                      maxRounds: maxReviseRounds,
                      phase: "audit",
                    });
                  },
                  onAuditComplete: ({
                    round,
                    maxReviseRounds,
                    audit,
                    tokenUsage,
                    latestRevisionMustFixOutcomes,
                    latestRevisionMustFixTotalCount,
                    latestRevisionMustFixUnresolvedCount,
                  }) => {
                    emitAgentUsage(tokenUsage);
                    const autoReviewState = buildAutoReviewAuditEventState({
                      round,
                      maxReviseRounds,
                      passed: audit.passed,
                    });
                  broadcast("audit:complete", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: audit.chapterNumber,
                      round,
                      maxRounds: maxReviseRounds,
                      phase: "audit",
                      passed: audit.passed,
                      issueCount: audit.issueCount,
                      score: audit.score,
                      severityCounts: audit.severityCounts,
                      failureGate: audit.failureGate,
                      summary: audit.summary,
                      issues: audit.issueTexts,
                      report: audit.report,
                      ...autoReviewState,
                    });
                  },
                onReviseStart: ({ round, maxReviseRounds, mode, strategyReason }) => {
                  broadcast("revise:start", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: chapterNumber,
                      round,
                      maxRounds: maxReviseRounds,
                      phase: "revise",
                      mode,
                      ...(typeof strategyReason === "string" && strategyReason.trim()
                        ? { strategyReason: strategyReason.trim() }
                        : {}),
                      autoTriggeredByAudit: true,
                    });
                  },
                onReviseComplete: ({ round, maxReviseRounds, mode, reviseResult, reviseAudit, tokenUsage }) => {
                  emitAgentUsage(tokenUsage);
                  broadcast("revise:complete", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: reviseResult.chapterNumber,
                      round,
                      maxRounds: maxReviseRounds,
                      phase: "revise",
                      mode,
                      autoTriggeredByAudit: true,
                      wordCount: reviseResult.wordCount,
                      status: reviseResult.status,
                      applied: reviseResult.applied,
                      ...(reviseAudit
                        ? {
                          audit: {
                            passed: reviseAudit.passed,
                            score: reviseAudit.score,
                            issueCount: reviseAudit.issueCount,
                            severityCounts: reviseAudit.severityCounts,
                            failureGate: reviseAudit.failureGate,
                            summary: reviseAudit.summary,
                            issues: reviseAudit.issueTexts,
                            report: reviseAudit.report,
                          },
                        }
                        : {}),
                    });
                  },
                });
                const auditResult = unified.finalAudit;
                const issueCount = auditResult.issueCount;
                if (auditResult.passed) passedCount += 1;
                else failedCount += 1;
                const finalWordCount = unified.autoReview.revisions.length > 0
                  ? unified.autoReview.revisions[unified.autoReview.revisions.length - 1]?.wordCount
                  : undefined;
                chapterSummaries.push(
                  `第${auditResult.chapterNumber}章：${auditResult.passed ? "通过" : "未通过"}（评分${auditResult.score}，问题${issueCount}项，字数${typeof finalWordCount === "number" ? finalWordCount : "-"}，修订${unified.autoReview.reviseRoundsUsed}轮）`,
                );
                const progressText = `Audit progress ${index + 1}/${impactedChapters.length}: chapter ${chapterNumber} (${auditResult.passed ? "PASSED" : "FAILED"}).`;
                emitDeterministicThinking(progressText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                });
                broadcast("tool:update", {
                  sessionId: streamSessionId,
                  runId,
                  id: toolCallId,
                  tool: "sub_agent",
                  partialResult: { content: [{ type: "text", text: progressText }] },
                });
              } catch (error) {
                errorCount += 1;
                failedCount += 1;
                const detail = error instanceof Error ? error.message : String(error);
                chapterSummaries.push(`第${chapterNumber}章：执行失败（${detail}）`);
                broadcast("audit:error", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  chapter: chapterNumber,
                  error: detail,
                });
                const progressText = `Audit progress ${index + 1}/${impactedChapters.length}: chapter ${chapterNumber} (ERROR).`;
                emitDeterministicThinking(progressText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                });
                broadcast("tool:update", {
                  sessionId: streamSessionId,
                  runId,
                  id: toolCallId,
                  tool: "sub_agent",
                  partialResult: { content: [{ type: "text", text: progressText }] },
                });
              }
              if (batch) {
                batch.completed = index + 1;
                batch.currentChapter = chapterNumber;
                emitBatchProgress(toolCallId, "progress", batch, {
                  currentChapter: chapterNumber,
                });
              }
            }

            await clearRewriteImpactNotes({
              state,
              bookId: activeBookId,
              chapterNumbers: impactedChapters,
            });

            const finishText = `Audit batch complete for impacted chapters (${impactedChapters.length}).`;
            emitDeterministicThinking(finishText, {
              toolCallId,
              action: deterministicAction.kind,
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: finishText }] },
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "completed";
              exec.completedAt = Date.now();
              exec.result = finishText;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: finishText,
              isError: false,
            });
            if (batch) {
              emitBatchProgress(toolCallId, "completed", batch, {
                ...(typeof batch.currentChapter === "number" ? { currentChapter: batch.currentChapter } : {}),
              });
              batchProgressByToolCallId.delete(toolCallId);
            }
            const lines = [
              `已完成受影响章节批量审计：共${impactedChapters.length}章，通过${passedCount}章，未通过${failedCount - errorCount}章，执行失败${errorCount}章。`,
              `已清理待复核标记：第${impactedChapters[0]}-${impactedChapters.at(-1)}章。`,
            ];
            if (chapterSummaries.length > 0) {
              lines.push("审计结果：");
              chapterSummaries.forEach((summary, index) => lines.push(`${index + 1}. ${summary}`));
            }
            result = {
              responseText: lines.join("\n"),
              messages: [{ role: "assistant", content: lines.join("\n") }],
            };
          }
        } else if (deterministicAction.kind === "audit" || deterministicAction.kind === "audit-latest") {
          const startedAt = Date.now();
          const stages = PIPELINE_STAGES.auditor;
          const chapterNumber = await resolveAuditTargetChapterNumber({
            state,
            bookId: activeBookId,
            explicitChapterNumber: deterministicAction.kind === "audit"
              ? deterministicAction.chapterNumber
              : undefined,
          });
          collectedToolExecs.push({
            id: toolCallId,
            tool: "sub_agent",
            agent: "auditor",
            label: resolveToolLabel("sub_agent", "auditor"),
            status: "running",
            args: {
              agent: "auditor",
              bookId: activeBookId,
              chapterNumber,
            },
            stages: stages.map((label) => ({ label, status: "pending" as const })),
            startedAt,
          });
          broadcast("tool:start", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            args: {
              agent: "auditor",
              bookId: activeBookId,
              chapterNumber,
            },
            stages,
          });
          const startText = `Auditor started for chapter ${chapterNumber}.`;
          emitDeterministicThinking(startText, {
            toolCallId,
            action: deterministicAction.kind,
            chapterNumber,
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            partialResult: { content: [{ type: "text", text: startText }] },
          });
          try {
            const autoReviewPolicy = resolveAutoReviewPolicy(config);
            const unified = await runUnifiedReviewLoop({
              state,
              pipeline,
              bookId: activeBookId,
              chapterNumber,
              entry: "rewrite",
              onFinalized: ({ entry, finalAudit, autoReview }) => {
                recordReviewMetrics({
                  bookId: activeBookId,
                  entry,
                  passed: finalAudit.passed,
                  reviseRoundsUsed: autoReview.reviseRoundsUsed,
                  finalState: autoReview.finalState,
                  issueClassCounts: finalAudit.issueClassCounts,
                  issueTexts: finalAudit.issueTexts,
                });
              },
              autoReviewPolicy,
              onAuditStart: ({ round, maxReviseRounds }) => {
                    broadcast("audit:start", {
                      sessionId: streamSessionId,
                      runId,
                      bookId: activeBookId,
                      entry: "rewrite",
                      chapter: chapterNumber,
                  round,
                  maxRounds: maxReviseRounds,
                  phase: "audit",
                });
              },
              onAuditComplete: ({
                round,
                maxReviseRounds,
                audit,
                tokenUsage,
                latestRevisionMustFixOutcomes,
                latestRevisionMustFixTotalCount,
                latestRevisionMustFixUnresolvedCount,
              }) => {
                emitAgentUsage(tokenUsage);
                const autoReviewState = buildAutoReviewAuditEventState({
                  round,
                  maxReviseRounds,
                  passed: audit.passed,
                });
                broadcast("audit:complete", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  chapter: audit.chapterNumber,
                  round,
                  maxRounds: maxReviseRounds,
                  phase: "audit",
                  passed: audit.passed,
                  issueCount: audit.issueCount,
                  score: audit.score,
                  severityCounts: audit.severityCounts,
                  failureGate: audit.failureGate,
                  summary: audit.summary,
                  dimensionChecks: audit.dimensionChecks,
                  issues: audit.issueTexts,
                  report: audit.report,
                  ...(Array.isArray(latestRevisionMustFixOutcomes)
                    ? { latestRevisionMustFixOutcomes }
                    : {}),
                  ...(typeof latestRevisionMustFixTotalCount === "number"
                    ? { latestRevisionMustFixTotalCount }
                    : {}),
                  ...(typeof latestRevisionMustFixUnresolvedCount === "number"
                    ? { latestRevisionMustFixUnresolvedCount }
                    : {}),
                  ...autoReviewState,
                });
              },
              onReviseStart: ({ round, maxReviseRounds, mode, strategyReason }) => {
                const reviseStartText = `Auto revise round ${round}/${maxReviseRounds} started for chapter ${chapterNumber}.`;
                emitDeterministicThinking(reviseStartText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                  mode,
                });
                broadcast("revise:start", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  chapter: chapterNumber,
                  round,
                  maxRounds: maxReviseRounds,
                  phase: "revise",
                  mode,
                  ...(typeof strategyReason === "string" && strategyReason.trim()
                    ? { strategyReason: strategyReason.trim() }
                    : {}),
                  autoTriggeredByAudit: true,
                });
                broadcast("tool:update", {
                  sessionId: streamSessionId,
                  runId,
                  id: toolCallId,
                  tool: "sub_agent",
                  partialResult: { content: [{ type: "text", text: reviseStartText }] },
                });
              },
              onReviseComplete: ({ round, maxReviseRounds, mode, reviseResult, reviseAudit, tokenUsage }) => {
                emitAgentUsage(tokenUsage);
                const reviseFinishText = `Auto revise round ${round}/${maxReviseRounds} complete for chapter ${chapterNumber}: ${reviseResult.applied ? "APPLIED" : "UNCHANGED"} (${reviseResult.status}).`;
                emitDeterministicThinking(reviseFinishText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                  mode,
                });
                broadcast("tool:update", {
                  sessionId: streamSessionId,
                  runId,
                  id: toolCallId,
                  tool: "sub_agent",
                  partialResult: { content: [{ type: "text", text: reviseFinishText }] },
                });
                broadcast("revise:complete", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  chapter: reviseResult.chapterNumber,
                  round,
                  maxRounds: maxReviseRounds,
                  phase: "revise",
                  mode,
                  autoTriggeredByAudit: true,
                  wordCount: reviseResult.wordCount,
                  status: reviseResult.status,
                  applied: reviseResult.applied,
                  ...(reviseAudit
                    ? {
                      audit: {
                        passed: reviseAudit.passed,
                        score: reviseAudit.score,
                        issueCount: reviseAudit.issueCount,
                        severityCounts: reviseAudit.severityCounts,
                        failureGate: reviseAudit.failureGate,
                        summary: reviseAudit.summary,
                        dimensionChecks: reviseAudit.dimensionChecks,
                        issues: reviseAudit.issueTexts,
                        report: reviseAudit.report,
                      },
                    }
                    : {}),
                });
              },
            });
            const finalAudit = unified.finalAudit;
            const issueCount = finalAudit.issueCount;
            const responseText = finalAudit.report;
            const finishText = `Audit cycle complete for chapter ${finalAudit.chapterNumber}: ${finalAudit.passed ? "PASSED" : "FAILED"} (${issueCount} issue${issueCount === 1 ? "" : "s"}).`;
            const auditExecutionFailed = !finalAudit.passed;
            emitDeterministicThinking(finishText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber: finalAudit.chapterNumber,
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: finishText }] },
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = auditExecutionFailed ? "error" : "completed";
              exec.completedAt = Date.now();
              if (auditExecutionFailed) {
                exec.error = finishText;
              } else {
                exec.result = finishText;
              }
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: finishText,
              isError: auditExecutionFailed,
            });
            const runSingleAudit = unified.autoReview.maxReviseRounds <= 0;
            const autoSummaryLines = runSingleAudit
              ? ["自动闭环：已关闭，仅执行单次审计。"]
              : [
                `自动闭环：最多${unified.autoReview.maxReviseRounds}轮修订，本次执行${unified.autoReview.reviseRoundsUsed}轮。`,
                unified.autoReview.stoppedByMaxRounds && !finalAudit.passed
                  ? `结果：${unified.autoReview.maxReviseRounds}轮修订后仍未通过，已自动中止。`
                  : "结果：已达标并结束自动闭环。",
              ];
            autoSummaryLines.push(
              `审计轮次：共${unified.autoReview.auditRounds}轮，最终评分=${finalAudit.score}，问题数=${finalAudit.issueCount}。`,
            );
            if (unified.autoReview.revisions.length > 0) {
              autoSummaryLines.push("审计轮次：");
              autoSummaryLines.push("修订轮次：");
              unified.autoReview.revisions.forEach((entry) => {
                const resolvedCount = entry.issueResolutions.filter((item) => item.outcome === "resolved").length;
                const unresolvedCount = entry.issueResolutions.length - resolvedCount;
                autoSummaryLines.push(
                  `${entry.round}. applied=${entry.applied ? "yes" : "no"}; status=${entry.status}; wordCount=${entry.wordCount}; resolved=${resolvedCount}; unresolved=${unresolvedCount}`,
                );
                if (entry.issueResolutions.length > 0) {
                  autoSummaryLines.push(`   - 问题映射（前${Math.min(3, entry.issueResolutions.length)}项）：`);
                  entry.issueResolutions.slice(0, 3).forEach((mapping, idx) => {
                    const fixDeltaText = mapping.fixDelta ? `；fixDelta=${mapping.fixDelta}` : "";
                    autoSummaryLines.push(`   - ${idx + 1}. [${mapping.issueId}] ${mapping.issue} => ${mapping.outcome === "resolved" ? "已解决" : "未解决"}${fixDeltaText}`);
                  });
                }
              });
            }
            result = {
              responseText: `${autoSummaryLines.join("\n")}\n\n${responseText}`,
              messages: [{ role: "assistant", content: `${autoSummaryLines.join("\n")}\n\n${responseText}` }],
            };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            emitDeterministicThinking(`Audit failed for chapter ${chapterNumber}: ${detail}`, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber,
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "error";
              exec.completedAt = Date.now();
              exec.error = detail;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: detail,
              isError: true,
            });
            broadcast("audit:error", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              chapter: chapterNumber,
              error: detail,
            });
            if (/chapter not found/i.test(detail) || /章节.*不存在/.test(detail)) {
              throw new ApiError(404, "CHAPTER_NOT_FOUND", `Chapter not found: ${chapterNumber}`);
            }
            const upstreamFailure = classifyAgentUpstreamFailure(error);
            if (upstreamFailure) {
              throw new ApiError(upstreamFailure.status, upstreamFailure.code, upstreamFailure.message);
            }
            throw error;
          }
        } else if (deterministicAction.kind === "revise") {
          const startedAt = Date.now();
          const stages = PIPELINE_STAGES.rewrite;
          const chapterNumber = deterministicAction.chapterNumber;
          const mode = deterministicAction.mode;
          const userBrief = extractBriefFromReviseInstruction(instruction);
          const rewriteConsistencyBaseline = mode === "rewrite"
            ? await buildNonDestructiveRewriteBaseline({
              state,
              bookId: activeBookId,
              pivotChapter: chapterNumber,
            })
            : null;
          if (mode === "rewrite") {
            broadcast("rewrite:start", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              entry: "rewrite",
              chapter: chapterNumber,
              mode: "non-destructive",
            });
          }
          collectedToolExecs.push({
            id: toolCallId,
            tool: "sub_agent",
            agent: "reviser",
            label: resolveToolLabel("sub_agent", "reviser"),
            status: "running",
            args: {
              agent: "reviser",
              bookId: activeBookId,
              chapterNumber,
              mode,
            },
            stages: stages.map((label) => ({ label, status: "pending" as const })),
            startedAt,
          });
          broadcast("tool:start", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            args: {
              agent: "reviser",
              bookId: activeBookId,
              chapterNumber,
              mode,
            },
            stages,
          });
          const startText = `Reviser ${mode} chapter ${chapterNumber} started.`;
          emitDeterministicThinking(startText, {
            toolCallId,
            action: deterministicAction.kind,
            chapterNumber,
            mode,
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            partialResult: { content: [{ type: "text", text: startText }] },
          });
          if (mode === "rewrite") {
            emitRewriteAuditLog({
              mode: "non-destructive",
              target: `chapter:${chapterNumber}`,
            });
          }
          try {
            broadcast("revise:start", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              chapter: chapterNumber,
              round: 1,
              maxRounds: 0,
              phase: "revise",
              mode,
              autoTriggeredByAudit: false,
            });
            const reviseResult = await pipeline.reviseDraft(
              activeBookId,
              chapterNumber,
              mode,
              userBrief ? { userBrief } : undefined,
            );
            emitAgentUsage(normalizeTokenUsage((reviseResult as { tokenUsage?: unknown }).tokenUsage));
            const chapterFileName = await findChapterFileNameByNumber(state, activeBookId, chapterNumber);
            if (rewriteConsistencyBaseline) {
              await enforceNonDestructiveRewriteConsistency({
                state,
                bookId: activeBookId,
                baseline: rewriteConsistencyBaseline,
              });
            }
            const rewriteImpact = mode === "rewrite"
              ? await markDownstreamChaptersForReview({
                state,
                bookId: activeBookId,
                pivotChapter: chapterNumber,
                rewrittenStartChapter: chapterNumber,
                rewrittenEndChapter: chapterNumber,
              })
              : null;
            if (mode === "rewrite") {
              await emitChapterDeltaFallbackIfMissing({
                state,
                bookId: activeBookId,
                chapterNumber,
                mode,
                sessionId: streamSessionId,
                runId,
                emittedChapterPreviewNumbers,
              });
            }
            const finishText = `Revision (${mode}) complete for chapter ${chapterNumber}.`;
            emitDeterministicThinking(finishText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber,
              mode,
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: finishText }] },
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "completed";
              exec.completedAt = Date.now();
              exec.result = finishText;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: finishText,
              isError: false,
            });

            const statusText = reviseResult.status === "ready-for-review"
              ? "ready-for-review"
              : reviseResult.status === "audit-failed"
                ? "audit-failed"
                : "unchanged";
            const fixedIssueCount = Array.isArray(reviseResult.fixedIssues) ? reviseResult.fixedIssues.length : 0;
            const actionLabel = mode === "rewrite" ? "重写" : "修订";
            const lines = [
              `已完成第${chapterNumber}章${actionLabel}。`,
              `模式：${mode}`,
              `状态：${statusText}`,
              `已应用：${reviseResult.applied ? "是" : "否"}`,
              `字数：${Number(reviseResult.wordCount ?? 0)}`,
              reviseResult.applied
                ? `修复项：${fixedIssueCount}`
                : `尝试修复项：${fixedIssueCount}`,
            ];
            if (chapterFileName) {
              lines.push(`正文文件：${chapterFileName}`);
            }
            let structuredAudit = normalizeReviseAuditSummary(
              (reviseResult as { audit?: unknown }).audit,
              chapterNumber,
              reviseResult.status !== "audit-failed",
            );
            let unifiedAutoReview: UnifiedReviewLoopAutoReviewPayload | null = null;
            if (mode === "rewrite") {
              const autoReviewPolicy = resolveAutoReviewPolicy(config);
              const unified = await runUnifiedReviewLoop({
                state,
                pipeline,
                bookId: activeBookId,
                chapterNumber,
                entry: "rewrite",
                onFinalized: ({ entry, finalAudit, autoReview }) => {
                  recordReviewMetrics({
                    bookId: activeBookId,
                    entry,
                    passed: finalAudit.passed,
                    reviseRoundsUsed: autoReview.reviseRoundsUsed,
                    finalState: autoReview.finalState,
                    issueClassCounts: finalAudit.issueClassCounts,
                    issueTexts: finalAudit.issueTexts,
                  });
                },
                autoReviewPolicy,
                onAuditStart: ({ round, maxReviseRounds }) => {
                  broadcast("audit:start", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: chapterNumber,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "audit",
                  });
                },
                onAuditComplete: ({
                  round,
                  maxReviseRounds,
                  audit,
                  tokenUsage,
                  latestRevisionMustFixOutcomes,
                  latestRevisionMustFixTotalCount,
                  latestRevisionMustFixUnresolvedCount,
                }) => {
                  emitAgentUsage(tokenUsage);
                  const autoReviewState = buildAutoReviewAuditEventState({
                    round,
                    maxReviseRounds,
                    passed: audit.passed,
                  });
                  broadcast("audit:complete", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: chapterNumber,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "audit",
                    wordCount: reviseResult.wordCount,
                    status: reviseResult.status,
                    applied: reviseResult.applied,
                    passed: audit.passed,
                    issueCount: audit.issueCount,
                    score: audit.score,
                    severityCounts: audit.severityCounts,
                    failureGate: audit.failureGate,
                    summary: audit.summary,
                    dimensionChecks: audit.dimensionChecks,
                    issues: audit.issueTexts,
                    report: audit.report,
                    ...(Array.isArray(latestRevisionMustFixOutcomes)
                      ? { latestRevisionMustFixOutcomes }
                      : {}),
                    ...(typeof latestRevisionMustFixTotalCount === "number"
                      ? { latestRevisionMustFixTotalCount }
                      : {}),
                    ...(typeof latestRevisionMustFixUnresolvedCount === "number"
                      ? { latestRevisionMustFixUnresolvedCount }
                      : {}),
                    ...autoReviewState,
                  });
                },
                onReviseStart: ({ round, maxReviseRounds, mode: autoMode, strategyReason }) => {
                  broadcast("revise:start", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: chapterNumber,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "revise",
                    mode: autoMode,
                    ...(typeof strategyReason === "string" && strategyReason.trim()
                      ? { strategyReason: strategyReason.trim() }
                      : {}),
                    autoTriggeredByAudit: true,
                  });
                },
                onReviseComplete: ({ round, maxReviseRounds, mode: autoMode, reviseResult: autoReviseResult, reviseAudit, tokenUsage }) => {
                  emitAgentUsage(tokenUsage);
                  broadcast("revise:complete", {
                    sessionId: streamSessionId,
                    runId,
                    bookId: activeBookId,
                    entry: "rewrite",
                    chapter: autoReviseResult.chapterNumber,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "revise",
                    mode: autoMode,
                    autoTriggeredByAudit: true,
                    wordCount: autoReviseResult.wordCount,
                    status: autoReviseResult.status,
                    applied: autoReviseResult.applied,
                    ...(reviseAudit
                      ? {
                      audit: {
                        passed: reviseAudit.passed,
                        score: reviseAudit.score,
                        issueCount: reviseAudit.issueCount,
                        severityCounts: reviseAudit.severityCounts,
                        failureGate: reviseAudit.failureGate,
                        summary: reviseAudit.summary,
                        dimensionChecks: reviseAudit.dimensionChecks,
                        issues: reviseAudit.issueTexts,
                        report: reviseAudit.report,
                      },
                    }
                      : {}),
                  });
                },
              });
              structuredAudit = unified.finalAudit;
              unifiedAutoReview = unified.autoReview;
            }
            if (structuredAudit) {
              lines.push(
                `当前审计评分：${structuredAudit.score}/100（严重 ${structuredAudit.severityCounts.critical} / 警告 ${structuredAudit.severityCounts.warning} / 提示 ${structuredAudit.severityCounts.info}）`,
              );
              lines.push(`当前问题数：${structuredAudit.issueCount}`);
              if (structuredAudit.summary) {
                lines.push(`审计报告：${structuredAudit.summary}`);
              }
              lines.push(...buildAuditIssueListLines(structuredAudit.issueTexts));
              if (mode !== "rewrite") {
                broadcast("audit:start", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  entry: "rewrite",
                  chapter: chapterNumber,
                  round: 1,
                  maxRounds: 0,
                  phase: "audit",
                });
                const autoReviewState = buildAutoReviewAuditEventState({
                  round: 1,
                  maxReviseRounds: 0,
                  passed: structuredAudit.passed,
                });
                broadcast("audit:complete", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  entry: "rewrite",
                  chapter: chapterNumber,
                  round: 1,
                  maxRounds: 0,
                  phase: "audit",
                  wordCount: reviseResult.wordCount,
                  status: reviseResult.status,
                  applied: reviseResult.applied,
                  passed: structuredAudit.passed,
                  issueCount: structuredAudit.issueCount,
                  score: structuredAudit.score,
                  severityCounts: structuredAudit.severityCounts,
                  failureGate: structuredAudit.failureGate,
                  summary: structuredAudit.summary,
                  issues: structuredAudit.issueTexts,
                  report: structuredAudit.report,
                  ...autoReviewState,
                });
              }
            } else {
              const chapterIndex = await state.loadChapterIndex(activeBookId).catch(() => [] as Array<{
                number?: number;
                auditIssues?: ReadonlyArray<string>;
              }>);
              const chapterMeta = chapterIndex.find((item) => item.number === chapterNumber);
              const chapterIssues = Array.isArray(chapterMeta?.auditIssues)
                ? chapterMeta.auditIssues
                : [];
              if (chapterIssues.length > 0 || reviseResult.status === "audit-failed" || reviseResult.status === "ready-for-review") {
                const severityCounts = countAuditIssueSeverities(chapterIssues);
                const score = estimateAuditScoreFromSeverityCounts(severityCounts);
                lines.push(`当前审计评分：${score}/100（严重 ${severityCounts.critical} / 警告 ${severityCounts.warning} / 提示 ${severityCounts.info}）`);
                lines.push(`当前问题数：${chapterIssues.length}`);
              }
            }
            if (typeof reviseResult.skippedReason === "string" && reviseResult.skippedReason.trim()) {
              lines.push(`说明：${reviseResult.skippedReason.trim()}`);
            }
            if (!reviseResult.applied && reviseResult.status === "unchanged") {
              lines.push(`建议：当前模式未通过应用门槛，可尝试“重写第${chapterNumber}章”或“修订第${chapterNumber}章 rework”。`);
            }
            if (rewriteImpact) {
              lines.push(formatRewriteImpactSummary(rewriteImpact));
            }
            if (unifiedAutoReview) {
              lines.push(`自动闭环：最多${unifiedAutoReview.maxReviseRounds}轮，执行${unifiedAutoReview.reviseRoundsUsed}轮，终态=${unifiedAutoReview.finalState}。`);
            }
            broadcast("revise:complete", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              entry: "rewrite",
              chapter: chapterNumber,
              round: 1,
              maxRounds: 0,
              phase: "revise",
              mode,
              autoTriggeredByAudit: false,
              wordCount: reviseResult.wordCount,
              status: reviseResult.status,
              applied: reviseResult.applied,
              ...(structuredAudit
                ? {
                  audit: {
                    passed: structuredAudit.passed,
                    score: structuredAudit.score,
                    issueCount: structuredAudit.issueCount,
                    severityCounts: structuredAudit.severityCounts,
                    failureGate: structuredAudit.failureGate,
                    summary: structuredAudit.summary,
                    issues: structuredAudit.issueTexts,
                    report: structuredAudit.report,
                  },
                }
                : {}),
            });
            if (mode === "rewrite") {
              const reviseAuditPassed = structuredAudit?.passed ?? (reviseResult.status !== "audit-failed");
              broadcast("rewrite:complete", {
                sessionId: streamSessionId,
                runId,
                bookId: activeBookId,
                entry: "rewrite",
                chapter: chapterNumber,
                chapterNumber,
                wordCount: reviseResult.wordCount,
                status: reviseResult.status,
                mode: "non-destructive",
                ...(structuredAudit
                  ? {
                    audit: {
                      passed: structuredAudit.passed,
                      score: structuredAudit.score,
                      issueCount: structuredAudit.issueCount,
                      severityCounts: structuredAudit.severityCounts,
                      failureGate: structuredAudit.failureGate,
                      summary: structuredAudit.summary,
                      issues: structuredAudit.issueTexts,
                      report: structuredAudit.report,
                    },
                  }
                  : {}),
                autoReview: unifiedAutoReview ?? buildSingleAuditAutoReviewPayload(reviseAuditPassed),
                ...(rewriteImpact
                  ? {
                    rewriteImpact: {
                      affectedCount: rewriteImpact.affectedCount,
                      affectedChapterNumbers: rewriteImpact.affectedChapterNumbers,
                      ...(typeof rewriteImpact.startChapter === "number" ? { startChapter: rewriteImpact.startChapter } : {}),
                      ...(typeof rewriteImpact.endChapter === "number" ? { endChapter: rewriteImpact.endChapter } : {}),
                    },
                  }
                  : {}),
              });
            }

            const responseText = lines.join("\n");
            result = {
              responseText,
              messages: [{ role: "assistant", content: responseText }],
            };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (mode === "rewrite") {
              broadcast("rewrite:error", {
                sessionId: streamSessionId,
                runId,
                bookId: activeBookId,
                chapter: chapterNumber,
                mode: "non-destructive",
                error: detail,
              });
            }
            emitDeterministicThinking(`Revision (${mode}) failed for chapter ${chapterNumber}: ${detail}`, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber,
              mode,
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "error";
              exec.completedAt = Date.now();
              exec.error = detail;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: detail,
              isError: true,
            });
            throw error;
          }
        } else if (deterministicAction.kind === "revise-batch") {
          const { startChapter, endChapter, chapterCount, mode } = deterministicAction;
          const startedAt = Date.now();
          const stages = PIPELINE_STAGES.rewrite;
          const rewriteConsistencyBaseline = mode === "rewrite"
            ? await buildNonDestructiveRewriteBaseline({
              state,
              bookId: activeBookId,
              pivotChapter: endChapter,
            })
            : null;
          if (mode === "rewrite") {
            broadcast("rewrite:start", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              entry: "rewrite",
              chapter: startChapter,
              startChapter,
              endChapter,
              chapterCount,
              mode: "non-destructive",
            });
          }
          collectedToolExecs.push({
            id: toolCallId,
            tool: "sub_agent",
            agent: "reviser",
            label: resolveToolLabel("sub_agent", "reviser"),
            status: "running",
            args: {
              agent: "reviser",
              action: "revise-batch",
              bookId: activeBookId,
              startChapter,
              endChapter,
              chapterCount,
              mode,
            },
            stages: stages.map((label) => ({ label, status: "pending" as const })),
            startedAt,
          });
          broadcast("tool:start", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            args: {
              agent: "reviser",
              action: "revise-batch",
              bookId: activeBookId,
              startChapter,
              endChapter,
              chapterCount,
              mode,
            },
            stages,
          });
          const batch = ensureBatchProgressState(toolCallId, chapterCount);
          const startText = `Reviser ${mode} batch ${startChapter}-${endChapter} started.`;
          emitDeterministicThinking(startText, {
            toolCallId,
            action: deterministicAction.kind,
            chapterNumber: startChapter,
            mode,
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            partialResult: { content: [{ type: "text", text: startText }] },
          });
          if (mode === "rewrite") {
            emitRewriteAuditLog({
              mode: "non-destructive",
              target: `chapters:${startChapter}-${endChapter}`,
            });
          }
          try {
            let totalWords = 0;
            const batchAudits: Array<{
              chapterNumber: number;
              passed: boolean;
              score: number;
              issueCount: number;
              severityCounts: AuditSeverityCounts;
              failureGate: AuditFailureGate;
              summary?: string;
              issues: ReadonlyArray<string>;
              report: string;
            }> = [];
            for (let i = 0; i < chapterCount; i += 1) {
              const chapterNumber = startChapter + i;
              broadcast("revise:start", {
                sessionId: streamSessionId,
                runId,
                bookId: activeBookId,
                chapter: chapterNumber,
                round: 1,
                maxRounds: 0,
                phase: "revise",
                mode,
                autoTriggeredByAudit: false,
              });
              const reviseResult = await pipeline.reviseDraft(activeBookId, chapterNumber, mode);
              const structuredAudit = normalizeReviseAuditSummary(
                (reviseResult as { audit?: unknown }).audit,
                chapterNumber,
                reviseResult.status !== "audit-failed",
              );
              broadcast("revise:complete", {
                sessionId: streamSessionId,
                runId,
                bookId: activeBookId,
                chapter: chapterNumber,
                round: 1,
                maxRounds: 0,
                phase: "revise",
                mode,
                autoTriggeredByAudit: false,
                wordCount: reviseResult.wordCount,
                status: reviseResult.status,
                applied: reviseResult.applied,
                ...(structuredAudit
                  ? {
                    audit: {
                      passed: structuredAudit.passed,
                      score: structuredAudit.score,
                      issueCount: structuredAudit.issueCount,
                      severityCounts: structuredAudit.severityCounts,
                      failureGate: structuredAudit.failureGate,
                      summary: structuredAudit.summary,
                      issues: structuredAudit.issueTexts,
                      report: structuredAudit.report,
                    },
                  }
                  : {}),
              });
              if (structuredAudit) {
                broadcast("audit:start", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  chapter: chapterNumber,
                  round: 1,
                  maxRounds: 0,
                  phase: "audit",
                });
                const autoReviewState = buildAutoReviewAuditEventState({
                  round: 1,
                  maxReviseRounds: 0,
                  passed: structuredAudit.passed,
                });
                batchAudits.push({
                  chapterNumber,
                  passed: structuredAudit.passed,
                  score: structuredAudit.score,
                  issueCount: structuredAudit.issueCount,
                  severityCounts: structuredAudit.severityCounts,
                  failureGate: structuredAudit.failureGate,
                  summary: structuredAudit.summary,
                  issues: structuredAudit.issueTexts,
                  report: structuredAudit.report,
                });
                    broadcast("audit:complete", {
                      sessionId: streamSessionId,
                      runId,
                      bookId: activeBookId,
                      entry: "rewrite",
                      chapter: chapterNumber,
                  round: 1,
                  maxRounds: 0,
                  phase: "audit",
                  wordCount: reviseResult.wordCount,
                  status: reviseResult.status,
                  applied: reviseResult.applied,
                  passed: structuredAudit.passed,
                  issueCount: structuredAudit.issueCount,
                  score: structuredAudit.score,
                  severityCounts: structuredAudit.severityCounts,
                  failureGate: structuredAudit.failureGate,
                  summary: structuredAudit.summary,
                  issues: structuredAudit.issueTexts,
                  report: structuredAudit.report,
                  ...autoReviewState,
                });
              }
              if (mode === "rewrite") {
                await emitChapterDeltaFallbackIfMissing({
                  state,
                  bookId: activeBookId,
                  chapterNumber,
                  mode,
                  sessionId: streamSessionId,
                  runId,
                  emittedChapterPreviewNumbers,
                });
              }
              const wordCount = Number(reviseResult.wordCount ?? 0);
              if (Number.isFinite(wordCount) && wordCount > 0) {
                totalWords += wordCount;
              }
              const progressText = `Revision (${mode}) progress ${i + 1}/${chapterCount}: chapter ${chapterNumber} (${Number.isFinite(wordCount) && wordCount > 0 ? wordCount : "unknown"} words).`;
              emitDeterministicThinking(progressText, {
                toolCallId,
                action: deterministicAction.kind,
                chapterNumber,
                mode,
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "sub_agent",
                partialResult: { content: [{ type: "text", text: progressText }] },
              });
              if (batch) {
                batch.completed = i + 1;
                batch.currentChapter = chapterNumber;
                emitBatchProgress(toolCallId, "progress", batch, {
                  currentChapter: chapterNumber,
                  ...(Number.isFinite(wordCount) && wordCount > 0 ? { currentWords: wordCount } : {}),
                });
              }
            }
            if (rewriteConsistencyBaseline) {
              await enforceNonDestructiveRewriteConsistency({
                state,
                bookId: activeBookId,
                baseline: rewriteConsistencyBaseline,
              });
            }
            const rewriteImpact = mode === "rewrite"
              ? await markDownstreamChaptersForReview({
                state,
                bookId: activeBookId,
                pivotChapter: endChapter,
                rewrittenStartChapter: startChapter,
                rewrittenEndChapter: endChapter,
              })
              : null;

            const finishText = `Revision (${mode}) batch complete for chapters ${startChapter}-${endChapter}.`;
            emitDeterministicThinking(finishText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber: endChapter,
              mode,
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: finishText }] },
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "completed";
              exec.completedAt = Date.now();
              exec.result = finishText;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: finishText,
              isError: false,
            });
            if (batch) {
              emitBatchProgress(toolCallId, "completed", batch, {
                ...(typeof batch.currentChapter === "number" ? { currentChapter: batch.currentChapter } : {}),
              });
              batchProgressByToolCallId.delete(toolCallId);
            }
            const lines = [
              `已完成重写第${startChapter}-${endChapter}章（非破坏模式）${totalWords > 0 ? `，共${totalWords}字` : ""}。`,
            ];
            if (batchAudits.length > 0) {
              const passedCount = batchAudits.filter((item) => item.passed).length;
              const failedCount = batchAudits.length - passedCount;
              lines.push(`自动审计：共${batchAudits.length}章，通过${passedCount}章，未通过${failedCount}章。`);
            }
            if (rewriteImpact) {
              lines.push(formatRewriteImpactSummary(rewriteImpact));
            }
            if (mode === "rewrite") {
                const failedCount = batchAudits.filter((item) => !item.passed).length;
                broadcast("rewrite:complete", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  entry: "rewrite",
                  chapter: endChapter,
                chapterNumber: endChapter,
                startChapter,
                endChapter,
                chapterCount,
                totalWords: totalWords > 0 ? totalWords : undefined,
                mode: "non-destructive",
                ...(batchAudits.length > 0
                  ? {
                    audits: batchAudits.map((item) => ({
                      chapterNumber: item.chapterNumber,
                      passed: item.passed,
                      score: item.score,
                      issueCount: item.issueCount,
                      severityCounts: item.severityCounts,
                      failureGate: item.failureGate,
                      summary: item.summary,
                      issues: item.issues,
                      report: item.report,
                    })),
                  }
                  : {}),
                autoReview: {
                  enabled: false,
                  maxReviseRounds: 0,
                  reviseRoundsUsed: 0,
                  auditRounds: Math.max(1, batchAudits.length),
                  stoppedByMaxRounds: false,
                  finalState: failedCount > 0 ? "failed-single-audit" : "passed",
                  revisions: [],
                } satisfies UnifiedReviewLoopAutoReviewPayload,
                ...(rewriteImpact
                  ? {
                    rewriteImpact: {
                      affectedCount: rewriteImpact.affectedCount,
                      affectedChapterNumbers: rewriteImpact.affectedChapterNumbers,
                      ...(typeof rewriteImpact.startChapter === "number" ? { startChapter: rewriteImpact.startChapter } : {}),
                      ...(typeof rewriteImpact.endChapter === "number" ? { endChapter: rewriteImpact.endChapter } : {}),
                    },
                  }
                  : {}),
              });
            }
            const responseText = lines.join("\n");
            result = {
              responseText,
              messages: [{ role: "assistant", content: responseText }],
            };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (mode === "rewrite") {
              broadcast("rewrite:error", {
                sessionId: streamSessionId,
                runId,
                bookId: activeBookId,
                chapter: startChapter,
                startChapter,
                endChapter,
                chapterCount,
                mode: "non-destructive",
                error: detail,
              });
            }
            emitDeterministicThinking(`Revision (${mode}) batch failed for chapters ${startChapter}-${endChapter}: ${detail}`, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber: startChapter,
              mode,
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "error";
              exec.completedAt = Date.now();
              exec.error = detail;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: detail,
              isError: true,
            });
            if (batch) {
              emitBatchProgress(toolCallId, "failed", batch, {
                failedChapterNumber: typeof batch.currentChapter === "number" ? batch.currentChapter + 1 : startChapter,
                error: detail,
              });
              batchProgressByToolCallId.delete(toolCallId);
            }
            throw error;
          }
        } else if (deterministicAction.kind === "rewrite-batch") {
          const { startChapter, endChapter, chapterCount } = deterministicAction;
          assertDestructiveRewriteEnabled();
          const rollbackTarget = startChapter - 1;
          const rewriteRisk = buildRewriteRiskSummaryFromIndex({
            index: normalizeChapterIndexEntries(writeIndexBefore),
            rollbackTarget,
          });
          broadcast("rewrite:start", {
            sessionId: streamSessionId,
            runId,
            bookId: activeBookId,
            entry: "rewrite",
            chapter: startChapter,
            startChapter,
            endChapter,
            chapterCount,
            mode: "destructive",
          });
          const startedAt = Date.now();
          const stages = PIPELINE_STAGES.writer;
          sawWriterToolStart = true;
          collectedToolExecs.push({
            id: toolCallId,
            tool: "sub_agent",
            agent: "writer",
            label: "重写",
            status: "running",
            args: {
              agent: "writer",
              action: "rewrite-batch",
              bookId: activeBookId,
              startChapter,
              endChapter,
              chapterCount,
            },
            stages: stages.map((label) => ({ label, status: "pending" as const })),
            startedAt,
          });
          broadcast("tool:start", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            args: {
              agent: "writer",
              action: "rewrite-batch",
              bookId: activeBookId,
              startChapter,
              endChapter,
              chapterCount,
            },
            stages,
          });
          const batch = ensureBatchProgressState(toolCallId, chapterCount);
          const startText = `Writer rewrite batch ${startChapter}-${endChapter} started.`;
          emitDeterministicThinking(startText, {
            toolCallId,
            action: deterministicAction.kind,
            chapterNumber: startChapter,
            mode: "rewrite",
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            partialResult: { content: [{ type: "text", text: startText }] },
          });
          emitRewriteAuditLog({
            mode: "destructive",
            target: `chapters:${startChapter}-${endChapter}`,
            riskMessage: rewriteRisk.message,
          });
          const riskText = rewriteRisk.message;
          emitDeterministicThinking(riskText, {
            toolCallId,
            action: deterministicAction.kind,
            chapterNumber: startChapter,
            mode: "rewrite",
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            partialResult: { content: [{ type: "text", text: riskText }] },
          });
          broadcast("rewrite:risk", {
            sessionId: streamSessionId,
            runId,
            bookId: activeBookId,
            mode: "destructive",
            rollbackTarget,
            discardedChapterNumbers: rewriteRisk.discardedChapterNumbers,
            discardedCount: rewriteRisk.discardedCount,
            message: rewriteRisk.message,
          });
          try {
            const rollbackStartText = `Rewriting chapters ${startChapter}-${endChapter}: rolling back to snapshot ${rollbackTarget}.`;
            emitDeterministicThinking(rollbackStartText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber: startChapter,
              mode: "rewrite",
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: rollbackStartText }] },
            });
            const { discarded, usedFallbackRepair } = await prepareRewriteFromChapter({
              state,
              bookId: activeBookId,
              chapterNumber: startChapter,
            });
            writeIndexBefore = await state.loadChapterIndex(activeBookId).catch(() => [] as ChapterIndexEntryLike[]);
            const rollbackDoneText = discarded.length > 0
              ? `Rollback complete for chapters ${startChapter}-${endChapter}; discarded chapters: ${discarded.join(", ")}.`
              : `Rollback complete for chapters ${startChapter}-${endChapter}.`;
            emitDeterministicThinking(rollbackDoneText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber: startChapter,
              mode: "rewrite",
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: rollbackDoneText }] },
            });
            if (usedFallbackRepair && rollbackTarget > 0) {
              const repairStartText = `Snapshot chain repaired for rollback target ${rollbackTarget}; rebuilding chapter state before rewrite.`;
              emitDeterministicThinking(repairStartText, {
                toolCallId,
                action: deterministicAction.kind,
                chapterNumber: rollbackTarget,
                mode: "rewrite",
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "sub_agent",
                partialResult: { content: [{ type: "text", text: repairStartText }] },
              });
              await pipeline.resyncChapterArtifacts(activeBookId, rollbackTarget);
              const repairDoneText = `Rollback state rebuilt from chapter ${rollbackTarget}.`;
              emitDeterministicThinking(repairDoneText, {
                toolCallId,
                action: deterministicAction.kind,
                chapterNumber: rollbackTarget,
                mode: "rewrite",
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "sub_agent",
                partialResult: { content: [{ type: "text", text: repairDoneText }] },
              });
            }

            let totalWords = 0;
            for (let i = 0; i < chapterCount; i += 1) {
              const chapterNumber = startChapter + i;
              const writeResult = await writeRewrittenChapter({
                pipeline,
                bookId: activeBookId,
                chapterNumber,
                quickMode,
              });
              sawWriterToolSuccess = true;
              await emitChapterDeltaFallbackIfMissing({
                state,
                bookId: activeBookId,
                chapterNumber,
                mode: "write-next",
                sessionId: streamSessionId,
                runId,
                emittedChapterPreviewNumbers,
              });
              const writeStatus = typeof writeResult.status === "string"
                ? writeResult.status.trim().toLowerCase()
                : "";
              const wordCount = Number(writeResult.wordCount ?? 0);
              if (Number.isFinite(wordCount) && wordCount > 0) {
                totalWords += wordCount;
              }
              const progressText = `Rewrite progress ${i + 1}/${chapterCount}: chapter ${chapterNumber} (${Number.isFinite(wordCount) && wordCount > 0 ? wordCount : "unknown"} words).`;
              emitDeterministicThinking(progressText, {
                toolCallId,
                action: deterministicAction.kind,
                chapterNumber,
                mode: "rewrite",
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "sub_agent",
                partialResult: { content: [{ type: "text", text: progressText }] },
              });
              if (batch) {
                batch.completed = i + 1;
                batch.currentChapter = chapterNumber;
                emitBatchProgress(toolCallId, "progress", batch, {
                  currentChapter: chapterNumber,
                  ...(Number.isFinite(wordCount) && wordCount > 0 ? { currentWords: wordCount } : {}),
                });
              }
              if (writeStatus === "state-degraded") {
                const degradedText = `Rewrite halted after chapter ${chapterNumber}: chapter state is degraded.`;
                emitDeterministicThinking(degradedText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                  mode: "rewrite",
                });
                broadcast("tool:update", {
                  sessionId: streamSessionId,
                  runId,
                  id: toolCallId,
                  tool: "sub_agent",
                  partialResult: { content: [{ type: "text", text: degradedText }] },
                });
                break;
              }
            }

            const finishText = `Rewrite batch complete for chapters ${startChapter}-${endChapter}.`;
            emitDeterministicThinking(finishText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber: endChapter,
              mode: "rewrite",
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: finishText }] },
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "completed";
              exec.completedAt = Date.now();
              exec.result = finishText;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: finishText,
              isError: false,
            });
            if (batch) {
              emitBatchProgress(toolCallId, "completed", batch, {
                ...(typeof batch.currentChapter === "number" ? { currentChapter: batch.currentChapter } : {}),
              });
              batchProgressByToolCallId.delete(toolCallId);
            }
            const responseText = `已完成重写第${startChapter}-${endChapter}章${totalWords > 0 ? `，共${totalWords}字` : ""}。`;
            broadcast("rewrite:complete", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              entry: "rewrite",
              chapter: endChapter,
              chapterNumber: endChapter,
              startChapter,
              endChapter,
              chapterCount,
              totalWords: totalWords > 0 ? totalWords : undefined,
              mode: "destructive",
              autoReview: buildSingleAuditAutoReviewPayload(true),
            });
            result = {
              responseText,
              messages: [{ role: "assistant", content: responseText }],
            };
          } catch (error) {
            sawWriterToolError = true;
            const detail = error instanceof Error ? error.message : String(error);
            broadcast("rewrite:error", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              chapter: startChapter,
              startChapter,
              endChapter,
              chapterCount,
              mode: "destructive",
              error: detail,
            });
            emitDeterministicThinking(`Rewrite batch failed for chapters ${startChapter}-${endChapter}: ${detail}`, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber: startChapter,
              mode: "rewrite",
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "error";
              exec.completedAt = Date.now();
              exec.error = detail;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: detail,
              isError: true,
            });
            if (batch) {
              emitBatchProgress(toolCallId, "failed", batch, {
                failedChapterNumber: typeof batch.currentChapter === "number" ? batch.currentChapter + 1 : startChapter,
                error: detail,
              });
              batchProgressByToolCallId.delete(toolCallId);
            }
            throw error;
          }
        } else if (deterministicAction.kind === "rewrite") {
          const chapterNumber = deterministicAction.chapterNumber;
          assertDestructiveRewriteEnabled();
          const rollbackTarget = chapterNumber - 1;
          const rewriteRisk = buildRewriteRiskSummaryFromIndex({
            index: normalizeChapterIndexEntries(writeIndexBefore),
            rollbackTarget,
          });
          broadcast("rewrite:start", {
            sessionId: streamSessionId,
            runId,
            bookId: activeBookId,
            entry: "rewrite",
            chapter: chapterNumber,
            mode: "destructive",
          });
          const startedAt = Date.now();
          const stages = PIPELINE_STAGES.writer;
          sawWriterToolStart = true;
          collectedToolExecs.push({
            id: toolCallId,
            tool: "sub_agent",
            agent: "writer",
            label: "重写",
            status: "running",
            args: {
              agent: "writer",
              action: "rewrite",
              bookId: activeBookId,
              chapterNumber,
            },
            stages: stages.map((label) => ({ label, status: "pending" as const })),
            startedAt,
          });
          broadcast("tool:start", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            args: {
              agent: "writer",
              action: "rewrite",
              bookId: activeBookId,
              chapterNumber,
            },
            stages,
          });
          const startText = `Writer rewrite chapter ${chapterNumber} started.`;
          emitDeterministicThinking(startText, {
            toolCallId,
            action: deterministicAction.kind,
            chapterNumber,
            mode: "rewrite",
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            partialResult: { content: [{ type: "text", text: startText }] },
          });
          emitRewriteAuditLog({
            mode: "destructive",
            target: `chapter:${chapterNumber}`,
            riskMessage: rewriteRisk.message,
          });
          const riskText = rewriteRisk.message;
          emitDeterministicThinking(riskText, {
            toolCallId,
            action: deterministicAction.kind,
            chapterNumber,
            mode: "rewrite",
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            partialResult: { content: [{ type: "text", text: riskText }] },
          });
          broadcast("rewrite:risk", {
            sessionId: streamSessionId,
            runId,
            bookId: activeBookId,
            mode: "destructive",
            rollbackTarget,
            discardedChapterNumbers: rewriteRisk.discardedChapterNumbers,
            discardedCount: rewriteRisk.discardedCount,
            message: rewriteRisk.message,
          });
          try {
            const rollbackStartText = `Rewriting chapter ${chapterNumber}: rolling back to snapshot ${rollbackTarget}.`;
            emitDeterministicThinking(rollbackStartText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber,
              mode: "rewrite",
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: rollbackStartText }] },
            });
            const { discarded, usedFallbackRepair } = await prepareRewriteFromChapter({
              state,
              bookId: activeBookId,
              chapterNumber,
            });
            writeIndexBefore = await state.loadChapterIndex(activeBookId).catch(() => [] as ChapterIndexEntryLike[]);
            const rollbackDoneText = discarded.length > 0
              ? `Rollback complete for chapter ${chapterNumber}; discarded chapters: ${discarded.join(", ")}.`
              : `Rollback complete for chapter ${chapterNumber}.`;
            emitDeterministicThinking(rollbackDoneText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber,
              mode: "rewrite",
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: rollbackDoneText }] },
            });
            if (usedFallbackRepair && rollbackTarget > 0) {
              const repairStartText = `Snapshot chain repaired for rollback target ${rollbackTarget}; rebuilding chapter state before rewrite.`;
              emitDeterministicThinking(repairStartText, {
                toolCallId,
                action: deterministicAction.kind,
                chapterNumber: rollbackTarget,
                mode: "rewrite",
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "sub_agent",
                partialResult: { content: [{ type: "text", text: repairStartText }] },
              });
              await pipeline.resyncChapterArtifacts(activeBookId, rollbackTarget);
              const repairDoneText = `Rollback state rebuilt from chapter ${rollbackTarget}.`;
              emitDeterministicThinking(repairDoneText, {
                toolCallId,
                action: deterministicAction.kind,
                chapterNumber: rollbackTarget,
                mode: "rewrite",
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "sub_agent",
                partialResult: { content: [{ type: "text", text: repairDoneText }] },
              });
            }
            const writeResult = await writeRewrittenChapter({
              pipeline,
              bookId: activeBookId,
              chapterNumber,
              quickMode,
            });
            sawWriterToolSuccess = true;
            const structuredWriteAudit = normalizeWriteAuditSummary(
              (writeResult as { auditResult?: unknown }).auditResult,
              chapterNumber,
            );
            if (structuredWriteAudit) {
              broadcast("audit:start", {
                sessionId: streamSessionId,
                runId,
                bookId: activeBookId,
                chapter: chapterNumber,
                round: 1,
                maxRounds: 0,
                phase: "audit",
              });
              const autoReviewState = buildAutoReviewAuditEventState({
                round: 1,
                maxReviseRounds: 0,
                passed: structuredWriteAudit.passed,
              });
              broadcast("audit:complete", {
                sessionId: streamSessionId,
                runId,
                bookId: activeBookId,
                chapter: chapterNumber,
                round: 1,
                maxRounds: 0,
                phase: "audit",
                passed: structuredWriteAudit.passed,
                issueCount: structuredWriteAudit.issueCount,
                score: structuredWriteAudit.score,
                severityCounts: structuredWriteAudit.severityCounts,
                failureGate: structuredWriteAudit.failureGate,
                summary: structuredWriteAudit.summary,
                issues: structuredWriteAudit.issueTexts,
                report: structuredWriteAudit.report,
                ...autoReviewState,
              });
            }
            await emitChapterDeltaFallbackIfMissing({
              state,
              bookId: activeBookId,
              chapterNumber,
              mode: "write-next",
              sessionId: streamSessionId,
              runId,
              emittedChapterPreviewNumbers,
            });
            const finishText = `Rewrite complete for chapter ${chapterNumber}.`;
            emitDeterministicThinking(finishText, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber,
              mode: "rewrite",
            });
            broadcast("tool:update", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              partialResult: { content: [{ type: "text", text: finishText }] },
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "completed";
              exec.completedAt = Date.now();
              exec.result = finishText;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: finishText,
              isError: false,
            });
            result = {
              responseText: `已重写第${chapterNumber}章。`,
              messages: [{ role: "assistant", content: `已重写第${chapterNumber}章。` }],
            };
            broadcast("rewrite:complete", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              entry: "rewrite",
              chapter: chapterNumber,
              chapterNumber,
              title: writeResult.title,
              wordCount: writeResult.wordCount,
              status: writeResult.status,
              mode: "destructive",
              autoReview: buildSingleAuditAutoReviewPayload(structuredWriteAudit?.passed ?? (writeResult.status !== "audit-failed")),
              ...(structuredWriteAudit
                ? {
                  audit: {
                    passed: structuredWriteAudit.passed,
                    score: structuredWriteAudit.score,
                    issueCount: structuredWriteAudit.issueCount,
                    severityCounts: structuredWriteAudit.severityCounts,
                    failureGate: structuredWriteAudit.failureGate,
                    summary: structuredWriteAudit.summary,
                    issues: structuredWriteAudit.issueTexts,
                    report: structuredWriteAudit.report,
                  },
                }
                : {}),
            });
          } catch (error) {
            sawWriterToolError = true;
            const detail = error instanceof Error ? error.message : String(error);
            broadcast("rewrite:error", {
              sessionId: streamSessionId,
              runId,
              bookId: activeBookId,
              chapter: chapterNumber,
              mode: "destructive",
              error: detail,
            });
            emitDeterministicThinking(`Rewrite failed for chapter ${chapterNumber}: ${detail}`, {
              toolCallId,
              action: deterministicAction.kind,
              chapterNumber,
              mode: "rewrite",
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "error";
              exec.completedAt = Date.now();
              exec.error = detail;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: detail,
              isError: true,
            });
            throw error;
          }
        } else if (deterministicAction.kind === "repair-persistence") {
          const startedAt = Date.now();
          const chapterNumber = deterministicAction.chapterNumber;
          const stages = ["检查章节落盘状态", "修复章节索引"];
          const toolArgs: Record<string, unknown> = {
            action: "repair_chapter_persistence",
            bookId: activeBookId,
            ...(typeof chapterNumber === "number" ? { chapterNumber } : {}),
          };
          collectedToolExecs.push({
            id: toolCallId,
            tool: "edit",
            label: resolveToolLabel("edit"),
            status: "running",
            args: toolArgs,
            stages: stages.map((label) => ({ label, status: "pending" as const })),
            startedAt,
          });
          broadcast("tool:start", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "edit",
            args: toolArgs,
            stages,
          });
          broadcast("tool:update", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "edit",
            partialResult: {
              content: [{
                type: "text",
                text: typeof chapterNumber === "number"
                  ? `开始校验第${chapterNumber}章落盘与索引状态。`
                  : "开始校验章节落盘与索引状态。",
              }],
            },
          });
          emitDeterministicThinking(
            typeof chapterNumber === "number"
              ? `开始校验第${chapterNumber}章落盘与索引状态。`
              : "开始校验章节落盘与索引状态。",
            {
              toolCallId,
              action: deterministicAction.kind,
              ...(typeof chapterNumber === "number" ? { chapterNumber } : {}),
            },
          );

          const finishDeterministicRepair = (input: {
            readonly ok: boolean;
            readonly responseText: string;
            readonly code?: string;
            readonly details?: Record<string, unknown>;
          }): Response | null => {
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = input.ok ? "completed" : "error";
              exec.completedAt = Date.now();
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
              if (input.ok) exec.result = input.responseText;
              else exec.error = input.responseText;
            }
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "edit",
              result: input.responseText,
              isError: !input.ok,
            });
            if (input.ok) {
              result = {
                responseText: input.responseText,
                messages: [{ role: "assistant", content: input.responseText }],
              };
              return null;
            }
            broadcast("agent:error", {
              instruction,
              activeBookId,
              sessionId,
              runId,
              error: input.responseText,
            });
            return c.json(
              {
                error: {
                  code: input.code ?? "AGENT_PERSISTENCE_REPAIR_FAILED",
                  message: input.responseText,
                },
                response: input.responseText,
                runId,
                ...(input.details ? { details: input.details } : {}),
              },
              409,
            );
          };

          try {
            const beforeIndex = await state.loadChapterIndex(activeBookId).catch(
              () => [] as ChapterIndexEntryLike[],
            );

            let writePersistence = await verifyWritePersistence({
              state,
              bookId: activeBookId,
              beforeIndex,
              ...persistTelemetryHooks,
            });

            let afterIndex = await state.loadChapterIndex(activeBookId).catch(
              () => beforeIndex as ReadonlyArray<ChapterIndexEntryLike>,
            );
            let indexedNumbers = new Set(
              afterIndex
                .map((entry) => Number(entry?.number))
                .filter((n) => Number.isFinite(n) && n > 0),
            );

            const chaptersDir = join(state.bookDir(activeBookId), "chapters");
            const chapterFiles = await readdir(chaptersDir).catch(() => [] as string[]);
            const chapterFileNumbers = new Set(
              chapterFiles
                .map((fileName) => parseChapterFileNumber(fileName))
                .filter((n): n is number => n !== null && Number.isFinite(n) && n > 0),
            );

            if (
              typeof chapterNumber === "number"
              && chapterFileNumbers.has(chapterNumber)
              && !indexedNumbers.has(chapterNumber)
            ) {
              const repairResult = await repairChapterIndexFromDisk({
                state,
                bookId: activeBookId,
                afterIndex,
                minimumChapterNumber: chapterNumber,
                onTelemetry: persistTelemetryHooks.onPersistRepair,
              });
              if (repairResult.status === "completed") {
                afterIndex = await state.loadChapterIndex(activeBookId).catch(
                  () => afterIndex as ReadonlyArray<ChapterIndexEntryLike>,
                );
                indexedNumbers = new Set(
                  afterIndex
                    .map((entry) => Number(entry?.number))
                    .filter((n) => Number.isFinite(n) && n > 0),
                );
                writePersistence = {
                  ...writePersistence,
                  repair: repairResult,
                  addedChapterNumbers: [
                    ...new Set([
                      ...writePersistence.addedChapterNumbers,
                      ...repairResult.repairedChapterNumbers,
                    ]),
                  ].sort((left, right) => left - right),
                };
              }
            }

            if (typeof chapterNumber === "number") {
              const hasFile = chapterFileNumbers.has(chapterNumber);
              const hasIndex = indexedNumbers.has(chapterNumber);

              if (hasFile && hasIndex) {
                const repairHint = writePersistence.repair.status === "completed"
                  && writePersistence.repair.repairedChapterNumbers.includes(chapterNumber)
                  ? "，并已自动补齐索引。"
                  : "，状态一致。";
                const responseText = `第${chapterNumber}章正文已落盘，索引已存在${repairHint}`;
                emitDeterministicThinking(responseText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                });
                const early = finishDeterministicRepair({
                  ok: true,
                  responseText,
                });
                if (early) return early;
              } else if (!hasFile && !hasIndex) {
                const responseText = `第${chapterNumber}章正文与索引均不存在，请重新执行“写第${chapterNumber}章”。`;
                emitDeterministicThinking(responseText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                });
                const early = finishDeterministicRepair({
                  ok: false,
                  responseText,
                  code: "AGENT_TARGET_CHAPTER_NOT_PERSISTED",
                  details: {
                    writeIntegrity: {
                      beforeCount: writePersistence.beforeCount,
                      afterCount: writePersistence.afterCount,
                      addedChapterNumbers: writePersistence.addedChapterNumbers,
                      missingChapterFiles: writePersistence.missingChapterFiles,
                      repair: writePersistence.repair,
                    },
                  },
                });
                if (early) return early;
              } else if (hasFile && !hasIndex) {
                const responseText = `第${chapterNumber}章正文已存在，但索引修复失败，请稍后重试。`;
                emitDeterministicThinking(responseText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                });
                const early = finishDeterministicRepair({
                  ok: false,
                  responseText,
                  code: "AGENT_TARGET_CHAPTER_INDEX_REPAIR_FAILED",
                  details: {
                    writeIntegrity: {
                      beforeCount: writePersistence.beforeCount,
                      afterCount: writePersistence.afterCount,
                      addedChapterNumbers: writePersistence.addedChapterNumbers,
                      missingChapterFiles: writePersistence.missingChapterFiles,
                      repair: writePersistence.repair,
                    },
                  },
                });
                if (early) return early;
              } else {
                const responseText = `第${chapterNumber}章索引存在，但正文文件缺失。请重写该章或先执行章节修复。`;
                emitDeterministicThinking(responseText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  chapterNumber,
                });
                const early = finishDeterministicRepair({
                  ok: false,
                  responseText,
                  code: "AGENT_TARGET_CHAPTER_FILE_MISSING",
                  details: {
                    writeIntegrity: {
                      beforeCount: writePersistence.beforeCount,
                      afterCount: writePersistence.afterCount,
                      addedChapterNumbers: writePersistence.addedChapterNumbers,
                      missingChapterFiles: writePersistence.missingChapterFiles,
                      repair: writePersistence.repair,
                    },
                  },
                });
                if (early) return early;
              }
            } else {
              const repaired = writePersistence.repair.repairedChapterNumbers;
              const responseText = repaired.length > 0
                ? `已修复章节索引：补齐第${repaired.join("、")}章。`
                : "章节索引与正文文件状态一致，无需修复。";
              emitDeterministicThinking(responseText, {
                toolCallId,
                action: deterministicAction.kind,
              });
              const early = finishDeterministicRepair({
                ok: true,
                responseText,
              });
              if (early) return early;
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const early = finishDeterministicRepair({
              ok: false,
              responseText: detail,
            });
            if (early) return early;
          }
        } else {
          let chapterCount = deterministicAction.kind === "write-batch"
            ? deterministicAction.chapterCount
            : 1;
          const targetChapterNumber = deterministicAction.kind === "write-target-chapter"
            ? deterministicAction.chapterNumber
            : null;
          let bypassWriterExecution = false;
          if (targetChapterNumber !== null) {
            const indexedNumbers = writeIndexBefore
              .map((entry) => Number(entry?.number))
              .filter((n) => Number.isFinite(n) && n > 0);
            const chaptersDir = join(state.bookDir(activeBookId), "chapters");
            const chapterFiles = await readdir(chaptersDir).catch(() => [] as string[]);
            const chapterFileNumbers = chapterFiles
              .map((fileName) => parseChapterFileNumber(fileName))
              .filter((chapterNumber): chapterNumber is number => Number.isFinite(chapterNumber));
            const targetChapterExistsInIndex = indexedNumbers.includes(targetChapterNumber);
            const targetChapterExistsInFile = chapterFileNumbers.includes(targetChapterNumber);
            const maxPersistedChapterNumber = Math.max(
              0,
              ...(indexedNumbers.length > 0 ? indexedNumbers : [0]),
              ...(chapterFileNumbers.length > 0 ? chapterFileNumbers : [0]),
            );
            const nextChapterNumber = maxPersistedChapterNumber + 1;

            if (targetChapterExistsInFile && !targetChapterExistsInIndex) {
              emitAgentLog(`检测到第${targetChapterNumber}章正文已存在但索引缺失，开始自动修复索引。`);
              const startedAt = Date.now();
              const stages = ["检查章节落盘状态", "修复章节索引"];
              const toolArgs = {
                action: "repair_chapter_persistence",
                bookId: activeBookId,
                chapterNumber: targetChapterNumber,
              };
              collectedToolExecs.push({
                id: toolCallId,
                tool: "edit",
                label: resolveToolLabel("edit"),
                status: "running",
                args: toolArgs,
                stages: stages.map((label) => ({ label, status: "pending" as const })),
                startedAt,
              });
              broadcast("tool:start", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "edit",
                args: toolArgs,
                stages,
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "edit",
                partialResult: {
                  content: [{ type: "text", text: `开始修复第${targetChapterNumber}章索引。` }],
                },
              });
              precomputedWritePersistence = await verifyWritePersistence({
                state,
                bookId: activeBookId,
                beforeIndex: writeIndexBefore,
                ...persistTelemetryHooks,
              });
              if (
                !precomputedWritePersistence.persisted
                || !precomputedWritePersistence.addedChapterNumbers.includes(targetChapterNumber)
              ) {
                const message = `第${targetChapterNumber}章正文已存在，但自动修复索引失败，请稍后重试。`;
                const exec = collectedToolExecs.find((item) => item.id === toolCallId);
                if (exec) {
                  exec.status = "error";
                  exec.completedAt = Date.now();
                  exec.error = message;
                  exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
                }
                broadcast("tool:end", {
                  sessionId: streamSessionId,
                  runId,
                  id: toolCallId,
                  tool: "edit",
                  result: message,
                  isError: true,
                });
                broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
                return c.json(
                  {
                    error: { code: "AGENT_TARGET_CHAPTER_INDEX_REPAIR_FAILED", message },
                    response: message,
                    runId,
                  },
                  409,
                );
              }
              const repairSummary = `第${targetChapterNumber}章正文已存在，已自动补齐章节索引。`;
              const exec = collectedToolExecs.find((item) => item.id === toolCallId);
              if (exec) {
                exec.status = "completed";
                exec.completedAt = Date.now();
                exec.result = repairSummary;
                exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
              }
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "edit",
                partialResult: {
                  content: [{ type: "text", text: repairSummary }],
                },
              });
              broadcast("tool:end", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "edit",
                result: repairSummary,
                isError: false,
              });
              result = {
                responseText: repairSummary,
                messages: [{ role: "assistant", content: repairSummary }],
              };
              bypassWriterExecution = true;
            } else if (targetChapterNumber < nextChapterNumber) {
              const message = `第${targetChapterNumber}章已存在。若需覆盖，请使用“重写第${targetChapterNumber}章”。`;
              broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
              return c.json(
                {
                  error: { code: "AGENT_TARGET_CHAPTER_ALREADY_EXISTS", message },
                  response: message,
                  runId,
                },
                409,
              );
            } else {
              chapterCount = Math.max(1, targetChapterNumber - nextChapterNumber + 1);
            }
          }
          if (bypassWriterExecution) {
            // handled via index-repair path; skip writer tool execution for this turn
          } else {
          const writeEntry = resolveWriterReviewEntry(targetChapterNumber);
          const startedAt = Date.now();
          const stages = PIPELINE_STAGES.writer;
            sawWriterToolStart = true;
            emitAgentLog(
              `[writer:start] entry=${writeEntry} book=${activeBookId} chapterCount=${chapterCount}`
              + `${targetChapterNumber !== null ? ` targetChapter=${targetChapterNumber}` : ""}`,
              "info",
              targetChapterNumber !== null ? { chapterNumber: targetChapterNumber } : undefined,
            );
            emitDeterministicThinking(
              `Writer started for ${activeBookId}: chapterCount=${chapterCount}${targetChapterNumber !== null ? `, targetChapter=${targetChapterNumber}` : ""}.`,
              {
                toolCallId,
                action: deterministicAction.kind,
                ...(targetChapterNumber !== null ? { chapterNumber: targetChapterNumber } : {}),
                mode: "write-next",
              },
            );
            collectedToolExecs.push({
            id: toolCallId,
            tool: "sub_agent",
            agent: "writer",
            label: resolveToolLabel("sub_agent", "writer"),
            status: "running",
            args: {
              agent: "writer",
              bookId: activeBookId,
              ...(chapterCount > 1 ? { chapterCount } : {}),
              ...(targetChapterNumber !== null ? { targetChapterNumber } : {}),
            },
            stages: stages.map((label) => ({ label, status: "pending" as const })),
            startedAt,
          });
          broadcast("tool:start", {
            sessionId: streamSessionId,
            runId,
            id: toolCallId,
            tool: "sub_agent",
            args: {
              agent: "writer",
              bookId: activeBookId,
              ...(chapterCount > 1 ? { chapterCount } : {}),
              ...(targetChapterNumber !== null ? { targetChapterNumber } : {}),
            },
            stages,
          });
          const batch = ensureBatchProgressState(toolCallId, chapterCount);
          let firstChapterNumber: number | null = null;
          let lastChapterNumber: number | null = null;
          let totalWords = 0;
          try {
            for (let i = 0; i < chapterCount; i += 1) {
              let writeResult: Awaited<ReturnType<PipelineRunner["writeNextChapter"]>>;
              try {
                writeResult = await pipeline.writeNextChapter(activeBookId, undefined, undefined, { quickMode });
              } catch (error) {
                rethrowWriteErrorAsApiError(error, chapterCount > 1 ? "连续写作" : "写作");
              }
              sawWriterToolSuccess = true;
              emitAgentUsage(normalizeTokenUsage((writeResult as { tokenUsage?: unknown }).tokenUsage));
              const writeStatus = typeof writeResult.status === "string"
                ? writeResult.status.trim().toLowerCase()
                : "";
              const chapterNumber = Number(writeResult.chapterNumber ?? 0);
              const wordCount = Number(writeResult.wordCount ?? 0);
              const structuredWriteAudit = Number.isFinite(chapterNumber) && chapterNumber > 0
                ? normalizeWriteAuditSummary(
                  (writeResult as { auditResult?: unknown }).auditResult,
                  chapterNumber,
                )
                : null;
              if (structuredWriteAudit && Number.isFinite(chapterNumber) && chapterNumber > 0) {
                const autoReviewMeta = (writeResult as {
                  autoReview?: {
                    auditRounds?: number;
                    maxReviseRounds?: number;
                    reviseRoundsUsed?: number;
                    finalState?: "passed" | "failed-max-rounds" | "failed-single-audit";
                  };
                }).autoReview;
                const auditRounds = Number.isFinite(Number(autoReviewMeta?.auditRounds))
                  ? Math.max(1, Math.trunc(Number(autoReviewMeta?.auditRounds)))
                  : 1;
                const maxReviseRounds = Number.isFinite(Number(autoReviewMeta?.maxReviseRounds))
                  ? Math.max(0, Math.min(5, Math.trunc(Number(autoReviewMeta?.maxReviseRounds))))
                  : 0;
                const reviseRoundsUsed = Number.isFinite(Number(autoReviewMeta?.reviseRoundsUsed))
                  ? Math.max(0, Math.trunc(Number(autoReviewMeta?.reviseRoundsUsed)))
                  : 0;
                const finalState = autoReviewMeta?.finalState
                  ?? (structuredWriteAudit.passed ? "passed" : "failed-single-audit");
                const autoReviewState = buildAutoReviewAuditEventState({
                  round: auditRounds,
                  maxReviseRounds,
                  passed: structuredWriteAudit.passed,
                });
                broadcast("audit:start", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  entry: writeEntry,
                  chapter: chapterNumber,
                  round: auditRounds,
                  maxRounds: maxReviseRounds,
                  phase: "audit",
                });
                broadcast("audit:complete", {
                  sessionId: streamSessionId,
                  runId,
                  bookId: activeBookId,
                  entry: writeEntry,
                  chapter: chapterNumber,
                  round: auditRounds,
                  maxRounds: maxReviseRounds,
                  phase: "audit",
                  passed: structuredWriteAudit.passed,
                  issueCount: structuredWriteAudit.issueCount,
                  score: structuredWriteAudit.score,
                  severityCounts: structuredWriteAudit.severityCounts,
                  failureGate: structuredWriteAudit.failureGate,
                  summary: structuredWriteAudit.summary,
                  issues: structuredWriteAudit.issueTexts,
                  report: structuredWriteAudit.report,
                  ...autoReviewState,
                });
                recordReviewMetrics({
                  bookId: activeBookId,
                  entry: writeEntry,
                  passed: structuredWriteAudit.passed,
                  reviseRoundsUsed,
                  finalState,
                  issueTexts: structuredWriteAudit.issueTexts,
                });
              }
              if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
                const emittedFallback = await emitChapterDeltaFallbackIfMissing({
                  state,
                  bookId: activeBookId,
                  chapterNumber,
                  mode: "write-next",
                  sessionId: streamSessionId,
                  runId,
                  emittedChapterPreviewNumbers,
                });
                if (emittedFallback) {
                  emitAgentLog(
                    `[writer:preview-fallback] chapter=${chapterNumber} replayed persisted text chunks`,
                    "info",
                    { chapterNumber },
                  );
                }
              }
              if (firstChapterNumber === null && Number.isFinite(chapterNumber) && chapterNumber > 0) {
                firstChapterNumber = chapterNumber;
              }
              if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
                lastChapterNumber = chapterNumber;
              }
              if (Number.isFinite(wordCount) && wordCount > 0) {
                totalWords += wordCount;
              }
              const progressText = `Writer progress ${i + 1}/${chapterCount}: chapter ${Number.isFinite(chapterNumber) && chapterNumber > 0 ? chapterNumber : "unknown"} (${Number.isFinite(wordCount) && wordCount > 0 ? wordCount : "unknown"} words).`;
              if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
                emitAgentLog(
                  `[writer:progress] ${i + 1}/${chapterCount} words=${Number.isFinite(wordCount) && wordCount > 0 ? wordCount : "unknown"}`,
                  "info",
                  { chapterNumber },
                );
              }
              emitDeterministicThinking(progressText, {
                toolCallId,
                action: deterministicAction.kind,
                ...(Number.isFinite(chapterNumber) && chapterNumber > 0 ? { chapterNumber } : {}),
                mode: "write-next",
              });
              broadcast("tool:update", {
                sessionId: streamSessionId,
                runId,
                id: toolCallId,
                tool: "sub_agent",
                partialResult: { content: [{ type: "text", text: progressText }] },
              });
              if (batch) {
                batch.completed = i + 1;
                if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
                  batch.currentChapter = chapterNumber;
                }
                emitBatchProgress(toolCallId, "progress", batch, {
                  ...(Number.isFinite(chapterNumber) && chapterNumber > 0 ? { currentChapter: chapterNumber } : {}),
                  ...(Number.isFinite(wordCount) && wordCount > 0 ? { currentWords: wordCount } : {}),
                });
              }
              if (writeStatus === "state-degraded") {
                const degradedText = `Writer halted after chapter ${Number.isFinite(chapterNumber) && chapterNumber > 0 ? chapterNumber : "unknown"}: chapter state is degraded.`;
                if (Number.isFinite(chapterNumber) && chapterNumber > 0) {
                  emitAgentLog("[writer:degraded] state-degraded detected", "warning", { chapterNumber });
                }
                emitDeterministicThinking(degradedText, {
                  toolCallId,
                  action: deterministicAction.kind,
                  ...(Number.isFinite(chapterNumber) && chapterNumber > 0 ? { chapterNumber } : {}),
                  mode: "write-next",
                });
                broadcast("tool:update", {
                  sessionId: streamSessionId,
                  runId,
                  id: toolCallId,
                  tool: "sub_agent",
                  partialResult: { content: [{ type: "text", text: degradedText }] },
                });
                break;
              }
            }
            const summaryText = chapterCount === 1
              ? `Chapter written for "${activeBookId}".`
              : `Batch write complete for "${activeBookId}": ${chapterCount} chapters.`;
            emitDeterministicThinking(summaryText, {
              toolCallId,
              action: deterministicAction.kind,
              ...(lastChapterNumber !== null ? { chapterNumber: lastChapterNumber } : {}),
              mode: "write-next",
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "completed";
              exec.completedAt = Date.now();
              exec.result = summaryText;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            emitAgentLog(
              `[writer:end] book=${activeBookId} status=success chapters=${chapterCount}`
              + `${firstChapterNumber !== null && lastChapterNumber !== null ? ` range=${firstChapterNumber}-${lastChapterNumber}` : ""}`,
              "info",
              lastChapterNumber !== null ? { chapterNumber: lastChapterNumber } : undefined,
            );
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: summaryText,
              isError: false,
            });
            if (batch) {
              emitBatchProgress(toolCallId, "completed", batch, {
                ...(typeof batch.currentChapter === "number" ? { currentChapter: batch.currentChapter } : {}),
              });
              batchProgressByToolCallId.delete(toolCallId);
            }
            const responseText = chapterCount === 1
              ? (firstChapterNumber
                ? `已完成第${firstChapterNumber}章写作。`
                : "已完成写作。")
              : `已完成连写${chapterCount}章${firstChapterNumber && lastChapterNumber ? `（第${firstChapterNumber}-${lastChapterNumber}章）` : ""}${totalWords > 0 ? `，共${totalWords}字` : ""}。`;
            result = {
              responseText,
              messages: [{ role: "assistant", content: responseText }],
            };
          } catch (error) {
            sawWriterToolError = true;
            const detail = error instanceof Error ? error.message : String(error);
            emitDeterministicThinking(`Writer failed: ${detail}`, {
              toolCallId,
              action: deterministicAction.kind,
              mode: "write-next",
            });
            const exec = collectedToolExecs.find((item) => item.id === toolCallId);
            if (exec) {
              exec.status = "error";
              exec.completedAt = Date.now();
              exec.error = detail;
              exec.stages = exec.stages?.map((stage) => ({ ...stage, status: "completed" as const }));
            }
            emitAgentLog(
              `[writer:end] book=${activeBookId} status=failed error=${detail}`,
              "error",
              lastChapterNumber !== null ? { chapterNumber: lastChapterNumber } : undefined,
            );
            broadcast("tool:end", {
              sessionId: streamSessionId,
              runId,
              id: toolCallId,
              tool: "sub_agent",
              result: detail,
              isError: true,
            });
            if (batch) {
              emitBatchProgress(toolCallId, "failed", batch, {
                ...(typeof batch.currentChapter === "number" ? { failedChapterNumber: batch.currentChapter + 1 } : {}),
                error: detail,
              });
              batchProgressByToolCallId.delete(toolCallId);
            }
            throw error;
          }
          }
      }
      } finally {
        closeDeterministicThinking(actionMeta);
      }
      } else {
        result = await runAgentSession(
          {
            model,
            apiKey: agentApiKey,
            pipeline,
            projectRoot: root,
            bookId: activeBookId ?? null,
            sessionId: bookSession.sessionId,
            language: config.language ?? "zh",
            signal: abortController.signal,
            onEvent: (event: any) => {
              if (event.type === "message_update") {
                const usage = normalizeTokenUsage(
                  (event.message as { usage?: unknown } | undefined)?.usage
                  ?? (event.assistantMessageEvent as { partial?: { usage?: unknown } } | undefined)?.partial?.usage,
                );
                if (usage) {
                  currentAgentTokenUsage = usage;
                  const totalTokenUsage = addTokenUsage(completedAgentTokenUsage, currentAgentTokenUsage);
                  emitAgentUsage(totalTokenUsage, "model");
                }
                const ame = event.assistantMessageEvent;
                if (ame.type === "text_delta") {
                  sawDraftDelta = true;
                  broadcast("draft:delta", { sessionId: streamSessionId, runId, text: ame.delta });
                } else if (ame.type === "thinking_delta") {
                  broadcast("thinking:delta", { sessionId: streamSessionId, runId, text: (ame as any).delta });
                } else if (ame.type === "thinking_start") {
                  broadcast("thinking:start", { sessionId: streamSessionId, runId });
                } else if (ame.type === "thinking_end") {
                  broadcast("thinking:end", { sessionId: streamSessionId, runId });
                }
              }
              if (event.type === "message_end") {
                const usage = normalizeTokenUsage((event.message as { usage?: unknown } | undefined)?.usage);
                if (usage) {
                  completedAgentTokenUsage = addTokenUsage(completedAgentTokenUsage, usage);
                  currentAgentTokenUsage = null;
                  emitAgentUsage(completedAgentTokenUsage, "model");
                }
              }
              if (event.type === "tool_execution_start") {
                const args = event.args as Record<string, unknown> | undefined;
                const agent = event.toolName === "sub_agent" ? (args?.agent as string | undefined) : undefined;
                const stages = agent ? (PIPELINE_STAGES[agent] ?? []) : [];
                if (event.toolName === "sub_agent" && agent === "writer") {
                  sawWriterToolStart = true;
                  const chapterCount = Number(args?.chapterCount ?? 1);
                  emitAgentLog(
                    `[writer:start] book=${activeBookId ?? "unknown"} chapterCount=${Number.isFinite(chapterCount) && chapterCount > 0 ? chapterCount : 1}`,
                  );
                }

                collectedToolExecs.push({
                  id: event.toolCallId,
                  tool: event.toolName,
                  agent,
                  label: resolveToolLabel(event.toolName, agent),
                  status: "running",
                  args,
                  stages: stages.length > 0
                    ? stages.map(l => ({ label: l, status: "pending" as const }))
                    : undefined,
                  startedAt: Date.now(),
                });

                broadcast("tool:start", {
                  sessionId: streamSessionId,
                  runId,
                  id: event.toolCallId,
                  tool: event.toolName,
                  args,
                  stages,
                });

                if (event.toolName === "sub_agent" && agent === "writer") {
                  const chapterCount = Number(args?.chapterCount ?? 0);
                  ensureBatchProgressState(event.toolCallId, chapterCount);
                }
              }
              if (event.type === "tool_execution_update") {
                broadcast("tool:update", {
                  sessionId: streamSessionId,
                  runId,
                  id: event.toolCallId,
                  tool: event.toolName,
                  partialResult: event.partialResult,
                });

                if (event.toolName === "sub_agent") {
                  const text = extractToolUpdateText(event.partialResult);
                  if (text) {
                    const inferredCountMatch = text.match(/inferred chapterCount=(\d+)/i);
                    if (inferredCountMatch?.[1]) {
                      const inferred = parseInt(inferredCountMatch[1], 10);
                      ensureBatchProgressState(event.toolCallId, inferred);
                    }

                    const batchStartMatch = text.match(/writing\s+(\d+)\s+consecutive\s+chapters?/i);
                    if (batchStartMatch?.[1]) {
                      const total = parseInt(batchStartMatch[1], 10);
                      ensureBatchProgressState(event.toolCallId, total);
                    }

                    const progressMatch = text.match(
                      /writer progress\s+(\d+)\/(\d+):\s*chapter\s*(\d+|unknown)(?:\s*\((\d+|unknown)\s*words?\))?/i,
                    );
                    if (progressMatch) {
                      const completed = parseInt(progressMatch[1] ?? "0", 10);
                      const total = parseInt(progressMatch[2] ?? "0", 10);
                      const currentChapter = /^\d+$/.test(progressMatch[3] ?? "")
                        ? parseInt(progressMatch[3]!, 10)
                        : undefined;
                      const currentWords = /^\d+$/.test(progressMatch[4] ?? "")
                        ? parseInt(progressMatch[4]!, 10)
                        : undefined;

                      const batch = ensureBatchProgressState(event.toolCallId, total);
                      if (batch) {
                        batch.completed = Math.max(batch.completed, completed);
                        if (typeof currentChapter === "number") {
                          batch.currentChapter = currentChapter;
                        }
                        emitBatchProgress(event.toolCallId, "progress", batch, {
                          currentChapter,
                          currentWords,
                        });
                      }
                      emitAgentLog(
                        `[writer:progress] ${completed}/${total} words=${typeof currentWords === "number" ? currentWords : "unknown"}`,
                        "info",
                        typeof currentChapter === "number" ? { chapterNumber: currentChapter } : undefined,
                      );
                    }
                  }
                }
              }
              if (event.type === "tool_execution_end") {
                const exec = collectedToolExecs.find(t => t.id === event.toolCallId);
                if (exec) {
                  exec.status = event.isError ? "error" : "completed";
                  exec.completedAt = Date.now();
                  exec.stages = exec.stages?.map(s => ({ ...s, status: "completed" as const }));
                  if (event.isError) exec.error = extractToolError(event.result);
                  else exec.result = summarizeResult(event.result);
                }
                broadcast("tool:end", {
                  sessionId: streamSessionId,
                  runId,
                  id: event.toolCallId,
                  tool: event.toolName,
                  result: event.result,
                  isError: event.isError,
                });
                if (!event.isError) {
                  const resultDetails = (event.result as { details?: { tokenUsage?: unknown } } | null)?.details;
                  const toolUsage = normalizeTokenUsage(resultDetails?.tokenUsage)
                    ?? normalizeTokenUsage((event.result as { tokenUsage?: unknown } | null)?.tokenUsage);
                  emitAgentUsage(toolUsage);
                }
                if (event.toolName === "sub_agent") {
                  const maybeAgent = (
                    collectedToolExecs.find((t) => t.id === event.toolCallId)?.agent
                    ?? (event.args as { agent?: unknown } | undefined)?.agent
                  );
                  if (maybeAgent === "writer") {
                    if (event.isError) {
                      sawWriterToolError = true;
                      const detail = extractToolError(event.result);
                      emitAgentLog(
                        `[writer:end] book=${activeBookId ?? "unknown"} status=failed error=${detail}`,
                        "error",
                      );
                    } else {
                      sawWriterToolSuccess = true;
                      emitAgentLog(`[writer:end] book=${activeBookId ?? "unknown"} status=success`);
                    }
                  }
                }

                const batch = batchProgressByToolCallId.get(event.toolCallId);
                if (batch) {
                  if (event.isError) {
                    const error = extractToolError(event.result);
                    const failedMatch = error.match(/after\s+(\d+)\/(\d+)\s+chapters?/i);
                    if (failedMatch) {
                      batch.completed = parseInt(failedMatch[1] ?? String(batch.completed), 10);
                      batch.total = parseInt(failedMatch[2] ?? String(batch.total), 10);
                    }
                    const failedChapterNumber = typeof batch.currentChapter === "number"
                      ? batch.currentChapter + 1
                      : undefined;
                    emitBatchProgress(event.toolCallId, "failed", batch, {
                      failedChapterNumber,
                      error,
                    });
                  } else {
                    const summary = summarizeResult(event.result);
                    const completedMatch = summary.match(/:\s*(\d+)\s+chapters?/i);
                    if (completedMatch?.[1]) {
                      batch.completed = parseInt(completedMatch[1], 10);
                    } else {
                      batch.completed = Math.max(batch.completed, batch.total);
                    }
                    emitBatchProgress(event.toolCallId, "completed", batch, {
                      currentChapter: batch.currentChapter,
                    });
                  }
                  batchProgressByToolCallId.delete(event.toolCallId);
                }
              }
            },
          } as any,
          instruction,
          initialMessages,
        );
        const finalRunTokenUsage = (result as { tokenUsage?: TokenUsageSnapshot } | null)?.tokenUsage;
        modelAgentTokenUsage = finalRunTokenUsage
          ?? (currentAgentTokenUsage ? addTokenUsage(completedAgentTokenUsage, currentAgentTokenUsage) : completedAgentTokenUsage);
        agentTokenUsage = addTokenUsage(modelAgentTokenUsage, toolAgentTokenUsage);
      }
      if (!result) {
        throw new ApiError(500, "AGENT_INTERNAL_STATE", "内部错误：写作流程未产生响应。");
      }
      if (
        !deterministicAction
        && collectedToolExecs.length === 0
        && hasBlockedToolCallMarker(result.responseText ?? "")
      ) {
        const message = "当前模型返回了被拦截的工具调用，未执行实际操作。请切换支持工具调用的模型，或使用确定性指令（如“写下一章”“写第19章”“修复第19章索引”）。";
        broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
        await persistAssistantErrorResponse(message);
        return c.json(
          {
            error: { code: "AGENT_TOOL_CALL_BLOCKED", message },
            response: message,
            runId,
          },
          409,
        );
      }
      if (result.responseText && !sawDraftDelta) {
        emitSyntheticDraftDeltas({
          sessionId: streamSessionId,
          runId,
          text: result.responseText,
        });
      }
      let writePersistence: WritePersistenceCheckResult | null = precomputedWritePersistence;
      let writeDegradedRecovery: WriteDegradedRecoveryResult | null = null;
      if (writerKernelIntent && activeBookId) {
        if (!writePersistence && (!sawWriterToolStart || !sawWriterToolSuccess)) {
          const degradedPrecondition = sawWriterToolError && inferWriterStateDegradedPrecondition({
            toolExecutions: collectedToolExecs,
            responseText: result.responseText,
          });
          if (degradedPrecondition) {
            const message = "写作被阻止：最新章节处于状态降级（state-degraded）。请先修复该章状态后再继续。";
            broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
            await persistAssistantErrorResponse(message);
            return c.json(
              {
                error: { code: "AGENT_WRITE_DEGRADED", message },
                response: message,
                runId,
                details: {
                  degradedRecovery: {
                    persisted: false,
                    attempted: false,
                    recovered: false,
                    remainingDegradedChapterNumbers: [],
                    reason: "degraded_precondition",
                    suggestion: "可执行修复：修复最新章节落库和索引。",
                  },
                },
              },
              409,
            );
          }
          const message = sawWriterToolError
            ? "写作流程执行失败，未完成章节落盘。"
            : "未触发写作工具，章节尚未生成。";
          broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
          await persistAssistantErrorResponse(message);
          return c.json(
            {
              error: { code: "AGENT_WRITE_NOT_EXECUTED", message },
              response: message,
              runId,
            },
            409,
          );
        }
        if (!writePersistence) {
          writePersistence = await verifyWritePersistence({
            state,
            bookId: activeBookId,
            beforeIndex: writeIndexBefore,
            ...persistTelemetryHooks,
          });
        }
        if (!writePersistence.persisted) {
          const degradedPrecondition = inferWriterStateDegradedPrecondition({
            toolExecutions: collectedToolExecs,
            responseText: result.responseText,
          });
          if (degradedPrecondition && writePersistence.addedChapterNumbers.length === 0) {
            const message = "写作被阻止：最新章节处于状态降级（state-degraded）。请先修复该章状态后再继续。";
            broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
            await persistAssistantErrorResponse(message);
            return c.json(
              {
                error: { code: "AGENT_WRITE_DEGRADED", message },
                response: message,
                runId,
                details: {
                  degradedRecovery: {
                    persisted: false,
                    attempted: false,
                    recovered: false,
                    remainingDegradedChapterNumbers: [],
                    reason: "degraded_precondition",
                    suggestion: "可执行修复：修复最新章节落库和索引。",
                  },
                  writeIntegrity: {
                    beforeCount: writePersistence.beforeCount,
                    afterCount: writePersistence.afterCount,
                    addedChapterNumbers: writePersistence.addedChapterNumbers,
                    missingChapterFiles: writePersistence.missingChapterFiles,
                    repair: writePersistence.repair,
                  },
                },
              },
              409,
            );
          }
          const message = writePersistence.addedChapterNumbers.length === 0
            ? "写作流程结束，但未检测到新章节写入索引。"
            : `写作流程结束，但第${writePersistence.missingChapterFiles.join("、")}章正文文件未落盘。`;
          broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
          await persistAssistantErrorResponse(message);
          return c.json(
            {
              error: { code: "AGENT_WRITE_NOT_PERSISTED", message },
              response: message,
              runId,
              details: {
                writeIntegrity: {
                  beforeCount: writePersistence.beforeCount,
                  afterCount: writePersistence.afterCount,
                  addedChapterNumbers: writePersistence.addedChapterNumbers,
                  missingChapterFiles: writePersistence.missingChapterFiles,
                  repair: writePersistence.repair,
                },
              },
            },
            409,
          );
        }
        const degradedChapterNumbers = await findDegradedChapterNumbers({
          state,
          bookId: activeBookId,
          chapterNumbers: writePersistence.addedChapterNumbers,
        });
        if (degradedChapterNumbers.length > 0) {
          writeDegradedRecovery = await tryAutoRecoverDegradedWrite({
            pipeline,
            state,
            bookId: activeBookId,
            chapterNumbers: writePersistence.addedChapterNumbers,
            log: emitAgentLog,
          });
          if (!writeDegradedRecovery.recovered) {
            const remainingDegraded = writeDegradedRecovery.remainingDegradedChapterNumbers;
            const targetChapter = remainingDegraded.at(-1);
            const suggestion = typeof targetChapter === "number"
              ? `可执行修复：修复第${targetChapter}章落库和索引。`
              : "可执行修复：修复最新章节落库和索引。";
            const message = `写作已完成且正文已落盘，但第${remainingDegraded.join("、")}章状态降级（state-degraded），请先修复后再继续。`;
            broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: message });
            return c.json(
              {
                error: { code: "AGENT_WRITE_DEGRADED", message },
                response: `${message}${writeDegradedRecovery.reason ? ` 自动修复失败：${writeDegradedRecovery.reason}` : ""} ${suggestion}`,
                runId,
                details: {
                  writeIntegrity: {
                    beforeCount: writePersistence.beforeCount,
                    afterCount: writePersistence.afterCount,
                    addedChapterNumbers: writePersistence.addedChapterNumbers,
                    missingChapterFiles: writePersistence.missingChapterFiles,
                    repair: writePersistence.repair,
                    degradedChapterNumbers,
                  },
                  degradedRecovery: {
                    persisted: true,
                    attempted: writeDegradedRecovery.attempted,
                    attemptedChapterNumber: writeDegradedRecovery.attemptedChapterNumber,
                    recovered: writeDegradedRecovery.recovered,
                    remainingDegradedChapterNumbers: remainingDegraded,
                    ...(writeDegradedRecovery.reason ? { reason: writeDegradedRecovery.reason } : {}),
                    suggestion,
                  },
                },
              },
              409,
            );
          }
          emitAgentLog(
            `检测到状态降级已自动恢复：章节 ${degradedChapterNumbers.join("、")}`
            + `${writeDegradedRecovery.attemptedChapterNumber ? `（修复目标：第${writeDegradedRecovery.attemptedChapterNumber}章）` : ""}`,
          );
        }
      }

      let responseText = result.responseText?.trim() ?? "";
      if (explicitAuditChapter !== null) {
        if (!explicitAuditToolCalled) {
          responseText = `未检测到第${explicitAuditChapter}章审计执行。请重试「审计第${explicitAuditChapter}章」。`;
        } else if (latestAuditReport) {
          responseText = formatAuditReportForChat(latestAuditReport);
        } else {
          const auditExecError = collectedToolExecs.find(
            (toolExec) => toolExec.tool === "sub_agent" && toolExec.agent === "auditor" && toolExec.status === "error",
          )?.error;
          responseText = auditExecError
            ? `第${explicitAuditChapter}章审计失败：${auditExecError}`
            : `第${explicitAuditChapter}章审计已执行，但未返回完整报告。请重试。`;
        }
      }
      if (responseText) {
        const lastAssistant = result.messages?.filter((m: any) => m.role === "assistant").pop();
        const thinking = lastAssistant?.thinking;
        if (checkpointWriter) {
          await checkpointWriter.flush({ terminal: true, content: responseText, ...(thinking ? { thinking } : {}) });
        } else {
          bookSession = appendBookSessionMessage(bookSession, {
            role: "assistant",
            content: responseText,
            ...(thinking ? { thinking } : {}),
            ...(collectedToolExecs.length > 0
              ? { toolExecutions: serializeCollectedToolExecutions(collectedToolExecs) }
              : {}),
            timestamp: assistantCheckpointTimestamp,
          });
          persistedBookSession = bookSession;
          await persistBookSession(root, bookSession);
        }
      }
      if (!responseText) {
        if (explicitAuditChapter !== null) {
          const emptyAuditMessage = `第${explicitAuditChapter}章审计未返回文本，请检查模型工具调用链路后重试。`;
          await persistAssistantErrorResponse(emptyAuditMessage);
          return c.json({
            error: { code: "AGENT_EMPTY_RESPONSE", message: emptyAuditMessage },
            response: emptyAuditMessage,
          }, 502);
        }
        try {
          const fallbackClient = createLLMClient({
            ...config.llm,
            service: configuredEntry?.service ?? effectiveReqService ?? config.llm.service,
            model: effectiveReqModel ?? config.llm.model,
            apiKey: agentApiKey ?? config.llm.apiKey,
            baseUrl: configuredEntry?.baseUrl ?? "",
            ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
            ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
          } as ProjectConfig["llm"]);
          const fallback = await chatCompletion(
            fallbackClient,
            effectiveReqModel ?? config.llm.model,
            [
              { role: "system", content: buildAgentSystemPrompt(activeBookId ?? null, config.language ?? "zh") },
              { role: "user", content: instruction },
            ],
            { maxTokens: 256 },
          );
          if (fallback.content?.trim()) {
            const fallbackContent = fallback.content.trim();
            const lastAssistant = result.messages?.filter((m: any) => m.role === "assistant").pop();
            const thinking = lastAssistant?.thinking;
            emitSyntheticDraftDeltas({
              sessionId: streamSessionId,
              runId,
              text: fallbackContent,
            });
            if (checkpointWriter) {
              await checkpointWriter.flush({
                terminal: true,
                content: fallbackContent,
                ...(thinking ? { thinking } : {}),
              });
            } else {
              bookSession = appendBookSessionMessage(bookSession, {
                role: "assistant",
                content: fallbackContent,
                ...(thinking ? { thinking } : {}),
                timestamp: assistantCheckpointTimestamp,
              });
              persistedBookSession = bookSession;
              await persistBookSession(root, bookSession);
            }
            return c.json({
              response: fallbackContent,
              runId,
              session: { sessionId: bookSession.sessionId },
            });
          }
        } catch {
          // fall through to probe-based diagnosis below
        }

        try {
          const probeClient = createLLMClient({
            ...config.llm,
            service: configuredEntry?.service ?? effectiveReqService ?? config.llm.service,
            model: effectiveReqModel ?? config.llm.model,
            apiKey: agentApiKey ?? config.llm.apiKey,
            baseUrl: configuredEntry?.baseUrl ?? "",
            ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
            ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
          } as ProjectConfig["llm"]);
          await chatCompletion(
            probeClient,
            effectiveReqModel ?? config.llm.model,
            [{ role: "user", content: "ping" }],
            { maxTokens: 5 },
          );
        } catch (probeError) {
          const probeMessage = probeError instanceof Error ? probeError.message : String(probeError);
          await persistAssistantErrorResponse(probeMessage);
          return c.json({
            error: { code: "AGENT_EMPTY_RESPONSE", message: probeMessage },
            response: probeMessage,
            runId,
          }, 502);
        }

        const emptyMessage = "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。";
        await persistAssistantErrorResponse(emptyMessage);
        return c.json({
          error: { code: "AGENT_EMPTY_RESPONSE", message: emptyMessage },
          response: emptyMessage,
          runId,
        }, 502);
      }
      broadcast("agent:complete", {
        instruction,
        activeBookId,
        sessionId: bookSession.sessionId,
        runId,
        tokenUsage: agentTokenUsage,
        ...(writePersistence
          ? {
              effects: {
                writeNext: {
                  persisted: true,
                  addedChapterNumbers: writePersistence.addedChapterNumbers,
                  ...(writePersistence.repair.status === "completed"
                    ? { repairedChapterNumbers: writePersistence.repair.repairedChapterNumbers }
                    : {}),
                  ...(writeDegradedRecovery
                    ? {
                        degradedRecovery: {
                          attempted: writeDegradedRecovery.attempted,
                          recovered: writeDegradedRecovery.recovered,
                          remainingDegradedChapterNumbers: writeDegradedRecovery.remainingDegradedChapterNumbers,
                          ...(writeDegradedRecovery.attemptedChapterNumber
                            ? { attemptedChapterNumber: writeDegradedRecovery.attemptedChapterNumber }
                            : {}),
                        },
                      }
                    : {}),
                },
              },
            }
          : {}),
      });

      // If a sub_agent created a new book during this session, broadcast book:created
      // so the sidebar refreshes.
      if (!activeBookId && collectedToolExecs.some((t) => t.agent === "architect" && t.status === "completed")) {
        const books = await state.listBooks();
        const latestBook = books.at(-1);
        if (latestBook) {
          try {
            const migratedSession = await migrateBookSession(root, bookSession.sessionId, latestBook);
            if (migratedSession) {
              bookSession = migratedSession;
              persistedBookSession = migratedSession;
            }
          } catch (e) {
            if (!(e instanceof SessionAlreadyMigratedError)) {
              throw e;
            }
          }
          broadcast("book:created", { bookId: latestBook, sessionId: bookSession.sessionId });
        }
      }

        const interactionDetails = result && typeof result === "object" && "details" in result
          ? ((result as { details?: Record<string, unknown> }).details ?? {})
          : {};
        const details = {
          ...interactionDetails,
          ...(writePersistence
            ? {
                effects: {
                  writeNext: {
                    persisted: true,
                    addedChapterNumbers: writePersistence.addedChapterNumbers,
                    ...(writePersistence.repair.status === "completed"
                      ? { repairedChapterNumbers: writePersistence.repair.repairedChapterNumbers }
                      : {}),
                    ...(writeDegradedRecovery
                      ? {
                          degradedRecovery: {
                            attempted: writeDegradedRecovery.attempted,
                            recovered: writeDegradedRecovery.recovered,
                            remainingDegradedChapterNumbers: writeDegradedRecovery.remainingDegradedChapterNumbers,
                            ...(writeDegradedRecovery.attemptedChapterNumber
                              ? { attemptedChapterNumber: writeDegradedRecovery.attemptedChapterNumber }
                              : {}),
                          },
                        }
                      : {}),
                  },
                },
                writeIntegrity: {
                  beforeCount: writePersistence.beforeCount,
                  afterCount: writePersistence.afterCount,
                  addedChapterNumbers: writePersistence.addedChapterNumbers,
                  missingChapterFiles: writePersistence.missingChapterFiles,
                  repair: writePersistence.repair,
                },
              }
            : {}),
        };
        return c.json({
          response: result.responseText,
          runId,
          tokenUsage: agentTokenUsage,
          ...(Object.keys(details).length > 0 ? { details } : {}),
          ...(destructiveInstructionRequested ? { destructive: true } : {}),
          session: {
            sessionId: bookSession.sessionId,
            ...(bookSession.bookId ? { activeBookId: bookSession.bookId } : {}),
          },
        });
    } catch (e) {
      if (e instanceof ApiError) {
        await persistAssistantErrorResponse(e.message);
        throw e;
      }
      if (e instanceof SessionAlreadyMigratedError) {
        const migratedMessage = e instanceof Error ? e.message : String(e);
        throw new ApiError(409, "SESSION_ALREADY_MIGRATED", migratedMessage);
      }
      const msg = e instanceof Error ? e.message : String(e);
      broadcast("agent:error", { instruction, activeBookId, sessionId, runId, error: msg });

      if (abortController.signal.aborted || /abort/i.test(msg)) {
        await persistAssistantErrorResponse("已停止当前对话");
        return c.json(
          {
            error: { code: "AGENT_ABORTED", message: "已停止当前对话" },
            response: "已停止当前对话",
            runId,
          },
          409,
        );
      }

      // Agent busy — return 429 with user-friendly message
      if (/already processing|prompt.*queue/i.test(msg)) {
        return c.json({
          error: { code: "AGENT_BUSY", message: "正在处理中，请等待当前操作完成" },
          response: "正在处理中，请等待当前操作完成后再发送。",
          runId,
        }, 429);
      }

      const upstreamFailure = classifyAgentUpstreamFailure(e);
      if (upstreamFailure) {
        await persistAssistantErrorResponse(upstreamFailure.message);
        return c.json(
          {
            error: { code: upstreamFailure.code, message: upstreamFailure.message },
            response: upstreamFailure.message,
            runId,
          },
          upstreamFailure.status,
        );
      }

      await persistAssistantErrorResponse(msg);
      return c.json(
        { error: { code: "AGENT_ERROR", message: msg }, runId },
        500,
      );
    } finally {
      if (checkpointSubscriber) {
        subscribers.delete(checkpointSubscriber);
        checkpointSubscriber = null;
      }
      checkpointWriter?.dispose();
      checkpointWriter = null;
      clearInFlightAgentRun(sessionId, runId);
    }
  });

  // --- Language setup ---

  app.post("/api/v1/project/language", async (c) => {
    const { language } = await c.req.json<{ language: "zh" | "en" }>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      existing.language = language;
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true, language });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Audit ---

  app.post("/api/v1/books/:id/audit/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    try {
      const currentConfig = await loadCurrentProjectConfig();
      const autoReviewPolicy = resolveAutoReviewPolicy(currentConfig);
      const pipeline = new PipelineRunner(await buildPipelineConfig({ currentConfig }));
      const unified = await runUnifiedReviewLoop({
        state,
        pipeline,
        bookId: id,
        chapterNumber: chapterNum,
        entry: "write-target",
        onFinalized: ({ entry, finalAudit, autoReview }) => {
          recordReviewMetrics({
            bookId: id,
            entry,
            passed: finalAudit.passed,
            reviseRoundsUsed: autoReview.reviseRoundsUsed,
            finalState: autoReview.finalState,
            issueClassCounts: finalAudit.issueClassCounts,
            issueTexts: finalAudit.issueTexts,
          });
        },
        autoReviewPolicy,
        onAuditStart: ({ round, maxReviseRounds }) => {
          broadcast("audit:start", {
            bookId: id,
            entry: "write-target",
            chapter: chapterNum,
            round,
            maxRounds: maxReviseRounds,
            phase: "audit",
          });
        },
        onAuditComplete: ({
          round,
          maxReviseRounds,
          audit,
          tokenUsage,
          latestRevisionMustFixOutcomes,
          latestRevisionMustFixTotalCount,
          latestRevisionMustFixUnresolvedCount,
        }) => {
          const autoReviewState = buildAutoReviewAuditEventState({
            round,
            maxReviseRounds,
            passed: audit.passed,
          });
          broadcast("audit:complete", {
            bookId: id,
            entry: "write-target",
            chapter: audit.chapterNumber,
            round,
            maxRounds: maxReviseRounds,
            phase: "audit",
            passed: audit.passed,
            issueCount: audit.issueCount,
            score: audit.score,
            severityCounts: audit.severityCounts,
            failureGate: audit.failureGate,
            summary: audit.summary,
            issues: audit.issueTexts,
            report: audit.report,
            ...(Array.isArray(latestRevisionMustFixOutcomes)
              ? { latestRevisionMustFixOutcomes }
              : {}),
            ...(typeof latestRevisionMustFixTotalCount === "number"
              ? { latestRevisionMustFixTotalCount }
              : {}),
            ...(typeof latestRevisionMustFixUnresolvedCount === "number"
              ? { latestRevisionMustFixUnresolvedCount }
              : {}),
            ...autoReviewState,
          });
        },
        onReviseStart: ({ round, maxReviseRounds, mode, strategyReason }) => {
          broadcast("revise:start", {
            bookId: id,
            entry: "write-target",
            chapter: chapterNum,
            round,
            maxRounds: maxReviseRounds,
            phase: "revise",
            mode,
            ...(typeof strategyReason === "string" && strategyReason.trim()
              ? { strategyReason: strategyReason.trim() }
              : {}),
            autoTriggeredByAudit: true,
          });
        },
        onReviseComplete: ({ round, maxReviseRounds, mode, reviseResult, reviseAudit, tokenUsage }) => {
          broadcast("revise:complete", {
            bookId: id,
            entry: "write-target",
            chapter: reviseResult.chapterNumber,
            round,
            maxRounds: maxReviseRounds,
            phase: "revise",
            mode,
            autoTriggeredByAudit: true,
            wordCount: reviseResult.wordCount,
            status: reviseResult.status,
            applied: reviseResult.applied,
            ...(reviseAudit
              ? {
                audit: {
                  passed: reviseAudit.passed,
                  score: reviseAudit.score,
                  issueCount: reviseAudit.issueCount,
                  severityCounts: reviseAudit.severityCounts,
                  failureGate: reviseAudit.failureGate,
                  summary: reviseAudit.summary,
                  issues: reviseAudit.issueTexts,
                  report: reviseAudit.report,
                },
              }
              : {}),
          });
        },
      });
      return c.json({
        ...unified.finalAudit.raw,
        chapterNumber: unified.finalAudit.chapterNumber,
        passed: unified.finalAudit.passed,
        issueCount: unified.finalAudit.issueCount,
        score: unified.finalAudit.score,
        severityCounts: unified.finalAudit.severityCounts,
        failureGate: unified.finalAudit.failureGate,
        summary: unified.finalAudit.summary,
        issues: unified.finalAudit.issueTexts,
        report: unified.finalAudit.report,
        autoReview: unified.autoReview,
      });
    } catch (e) {
      broadcast("audit:error", { bookId: id, chapter: chapterNum, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Revise ---

  app.post("/api/v1/books/:id/revise/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);
    const body = await c.req
      .json<{ mode?: string; brief?: string }>()
      .catch(() => ({ mode: "spot-fix", brief: undefined }));
    const normalizedMode = body.mode ?? "spot-fix";

    broadcast("revise:start", {
      bookId: id,
      chapter: chapterNum,
      round: 1,
      maxRounds: 0,
      phase: "revise",
      mode: normalizedMode,
      autoTriggeredByAudit: false,
    });
    try {
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
        bookId: id,
      }));
      const result = await pipeline.reviseDraft(
        id,
        chapterNum,
        normalizedMode as "polish" | "rewrite" | "rework" | "spot-fix" | "anti-detect",
      );
      const structuredAudit = normalizeReviseAuditSummary(
        (result as { audit?: unknown }).audit,
        chapterNum,
        result.status !== "audit-failed",
      );
      broadcast("revise:complete", {
        bookId: id,
        chapter: chapterNum,
        round: 1,
        maxRounds: 0,
        phase: "revise",
        mode: normalizedMode,
        autoTriggeredByAudit: false,
        wordCount: result.wordCount,
        status: result.status,
        applied: result.applied,
        ...(structuredAudit
          ? {
            audit: {
              passed: structuredAudit.passed,
              score: structuredAudit.score,
              issueCount: structuredAudit.issueCount,
              severityCounts: structuredAudit.severityCounts,
              failureGate: structuredAudit.failureGate,
              summary: structuredAudit.summary,
              issues: structuredAudit.issueTexts,
              report: structuredAudit.report,
            },
          }
          : {}),
      });
      if (structuredAudit) {
        broadcast("audit:start", {
          bookId: id,
          chapter: chapterNum,
          round: 1,
          maxRounds: 0,
          phase: "audit",
        });
        const autoReviewState = buildAutoReviewAuditEventState({
          round: 1,
          maxReviseRounds: 0,
          passed: structuredAudit.passed,
        });
        broadcast("audit:complete", {
          bookId: id,
          chapter: chapterNum,
          round: 1,
          maxRounds: 0,
          phase: "audit",
          wordCount: result.wordCount,
          status: result.status,
          applied: result.applied,
          passed: structuredAudit.passed,
          issueCount: structuredAudit.issueCount,
          score: structuredAudit.score,
          severityCounts: structuredAudit.severityCounts,
          failureGate: structuredAudit.failureGate,
          summary: structuredAudit.summary,
          issues: structuredAudit.issueTexts,
          report: structuredAudit.report,
          ...autoReviewState,
        });
      }
      return c.json(result);
    } catch (e) {
      broadcast("revise:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Export ---

  app.get("/api/v1/books/:id/export", async (c) => {
    const id = c.req.param("id");
    const format = (c.req.query("format") ?? "txt") as string;
    const approvedOnly = c.req.query("approvedOnly") === "true";

    try {
      const artifact = await buildExportArtifact(state, id, {
        format: format as "txt" | "md" | "epub",
        approvedOnly,
      });
      const responseBody = typeof artifact.payload === "string"
        ? artifact.payload
        : new Uint8Array(artifact.payload);
      return new Response(responseBody, {
        headers: {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        },
      });
    } catch {
      return c.json({ error: "Export failed" }, 500);
    }
  });

  // --- Export to file (save to project dir) ---

  app.post("/api/v1/books/:id/export-save", async (c) => {
    const id = c.req.param("id");
    const { format, approvedOnly } = await c.req.json<{ format?: string; approvedOnly?: boolean }>().catch(() => ({ format: "txt", approvedOnly: false }));
    const fmt = format ?? "txt";

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const tools = createInteractionToolsFromDeps(pipeline, state);
      const bookDir = state.bookDir(id);
      const outputPath = join(bookDir, `${id}.${fmt === "epub" ? "epub" : fmt}`);
      const result = await processProjectInteractionRequest({
        projectRoot: root,
        request: {
          intent: "export_book",
          bookId: id,
          format: fmt as "txt" | "md" | "epub",
          approvedOnly,
          outputPath,
        },
        tools,
        activeBookId: id,
      });
      return c.json({
        ok: true,
        path: (result.details?.outputPath as string | undefined) ?? outputPath,
        format: fmt,
        chapters: (result.details?.chaptersExported as number | undefined) ?? 0,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/export-open", async (c) => {
    const id = c.req.param("id");
    const { path: exportPath } = await c.req.json<{ path?: string }>().catch(() => ({ path: "" }));
    if (!exportPath || !exportPath.trim()) {
      return c.json({ error: "Export path is required" }, 400);
    }

    const resolvedPath = resolveExportPathForProject(root, exportPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid export path" }, 400);
    }

    try {
      await openPath(resolvedPath);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre detail + copy ---

  app.get("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    try {
      const { readGenreProfile } = await import("@actalk/inkos-core");
      const { profile, body } = await readGenreProfile(root, genreId);
      return c.json({ profile, body });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });

  app.post("/api/v1/genres/:id/copy", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }
    try {
      const { getBuiltinGenresDir } = await import("@actalk/inkos-core");
      const { mkdir: mkdirFs, copyFile } = await import("node:fs/promises");
      const builtinDir = getBuiltinGenresDir();
      const projectGenresDir = join(root, "genres");
      await mkdirFs(projectGenresDir, { recursive: true });
      await copyFile(join(builtinDir, `${genreId}.md`), join(projectGenresDir, `${genreId}.md`));
      return c.json({ ok: true, path: `genres/${genreId}.md` });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Model overrides ---

  app.get("/api/v1/project/model-overrides", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ overrides: raw.modelOverrides ?? {} });
  });

  app.put("/api/v1/project/model-overrides", async (c) => {
    const { overrides } = await c.req.json<{ overrides: Record<string, unknown> }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.modelOverrides = overrides;
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- Notify channels ---

  app.get("/api/v1/project/notify", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ channels: raw.notify ?? [] });
  });

  app.put("/api/v1/project/notify", async (c) => {
    const { channels } = await c.req.json<{ channels: unknown[] }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.notify = channels;
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- AIGC Detection ---

  app.post("/api/v1/books/:id/detect/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { analyzeAITells } = await import("@actalk/inkos-core");
      const result = analyzeAITells(content);
      return c.json({ chapterNumber: chapterNum, ...result });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth file edit ---

  app.put("/api/v1/books/:id/truth/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    if (!TRUTH_FILES.includes(file) && !TRUTH_FILE_PATHS.has(file)) {
      return c.json({ error: "Invalid truth file" }, 400);
    }
    const { content } = await c.req.json<{ content: string }>();
    const bookDir = state.bookDir(id);
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const targetPath = resolveTruthFileReadPath(bookDir, file);
    await mkdirFs(dirname(targetPath), { recursive: true });
    await writeFileFs(targetPath, content, "utf-8");
    if (file === "story_bible.md") {
      await mkdirFs(join(bookDir, "story"), { recursive: true });
      await writeFileFs(join(bookDir, "story", "story_bible.md"), content, "utf-8");
    }
    if (file === "volume_outline.md") {
      await mkdirFs(join(bookDir, "story"), { recursive: true });
      await writeFileFs(join(bookDir, "story", "volume_outline.md"), content, "utf-8");
    }
    return c.json({ ok: true });
  });

  // =============================================
  // NEW ENDPOINTS — CLI parity
  // =============================================

  // --- Book Delete ---

  app.delete("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      await bookTaskController.deleteBook(id);
      const { rm } = await import("node:fs/promises");
      await rm(bookDir, { recursive: true, force: true });
      broadcast("book:deleted", { bookId: id });
      return c.json({ ok: true, bookId: id });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Update ---

  app.put("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    const updates = await c.req.json<{
      chapterWordCount?: number;
      targetChapters?: number;
      status?: string;
      language?: string;
    }>();
    try {
      const book = await state.loadBookConfig(id);
      const updated = {
        ...book,
        ...(updates.chapterWordCount !== undefined ? { chapterWordCount: Number(updates.chapterWordCount) } : {}),
        ...(updates.targetChapters !== undefined ? { targetChapters: Number(updates.targetChapters) } : {}),
        ...(updates.status !== undefined ? { status: updates.status as typeof book.status } : {}),
        ...(updates.language !== undefined ? { language: updates.language as "zh" | "en" } : {}),
        updatedAt: new Date().toISOString(),
      };
      await state.saveBookConfig(id, updated);
      return c.json({ ok: true, book: updated });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Write Rewrite (specific chapter) ---

  app.post("/api/v1/books/:id/rewrite/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string; destructive?: boolean } = await c.req
      .json<{ brief?: string; destructive?: boolean }>()
      .catch(() => ({}));
    const destructive = body.destructive === true;
    const emitRewriteEndpointAuditLog = (args: {
      readonly mode: "destructive" | "non-destructive";
      readonly riskMessage?: string;
    }): void => {
      const briefSummary = compactInstructionForAuditLog(body.brief ?? "");
      const message = [
        "[entry=rewrite]",
        `[rewrite:audit] mode=${args.mode}`,
        `target=chapter:${chapterNum}`,
        briefSummary ? `brief="${briefSummary}"` : null,
        args.riskMessage ? `risk="${args.riskMessage}"` : null,
      ].filter(Boolean).join(" ");
      broadcast("log", {
        bookId: id,
        level: args.mode === "destructive" ? "warning" : "info",
        tag: "studio",
        message,
      });
    };

    try {
      if (destructive) {
        assertDestructiveRewriteEnabled();
      }
      broadcast("rewrite:start", {
        bookId: id,
        entry: "rewrite",
        chapter: chapterNum,
        mode: destructive ? "destructive" : "non-destructive",
      });
      if (!destructive) {
        emitRewriteEndpointAuditLog({ mode: "non-destructive" });
        const rewriteConsistencyBaseline = await buildNonDestructiveRewriteBaseline({
          state,
          bookId: id,
          pivotChapter: chapterNum,
        });
        const pipeline = new PipelineRunner(await buildPipelineConfig({
          externalContext: body.brief,
        }));
        pipeline.reviseDraft(id, chapterNum, "rewrite").then(
          async (result) => {
            try {
              const currentConfig = await loadCurrentProjectConfig();
              const autoReviewPolicy = resolveAutoReviewPolicy(currentConfig);
              const unified = await runUnifiedReviewLoop({
                state,
                pipeline,
                bookId: id,
                chapterNumber: chapterNum,
                entry: "rewrite",
                onFinalized: ({ entry, finalAudit, autoReview }) => {
                  recordReviewMetrics({
                    bookId: id,
                    entry,
                    passed: finalAudit.passed,
                    reviseRoundsUsed: autoReview.reviseRoundsUsed,
                    finalState: autoReview.finalState,
                    issueClassCounts: finalAudit.issueClassCounts,
                    issueTexts: finalAudit.issueTexts,
                  });
                },
                autoReviewPolicy,
                onAuditStart: ({ round, maxReviseRounds }) => {
                  broadcast("audit:start", {
                    bookId: id,
                    entry: "rewrite",
                    chapter: chapterNum,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "audit",
                  });
                },
                onAuditComplete: ({
                  round,
                  maxReviseRounds,
                  audit,
                  tokenUsage,
                  latestRevisionMustFixOutcomes,
                  latestRevisionMustFixTotalCount,
                  latestRevisionMustFixUnresolvedCount,
                }) => {
                  const autoReviewState = buildAutoReviewAuditEventState({
                    round,
                    maxReviseRounds,
                    passed: audit.passed,
                  });
                  broadcast("audit:complete", {
                    bookId: id,
                    entry: "rewrite",
                    chapter: audit.chapterNumber,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "audit",
                    wordCount: result.wordCount,
                    status: result.status,
                    applied: result.applied,
                    passed: audit.passed,
                    issueCount: audit.issueCount,
                    score: audit.score,
                    severityCounts: audit.severityCounts,
                    failureGate: audit.failureGate,
                    summary: audit.summary,
                    issues: audit.issueTexts,
                    report: audit.report,
                    ...(Array.isArray(latestRevisionMustFixOutcomes)
                      ? { latestRevisionMustFixOutcomes }
                      : {}),
                    ...(typeof latestRevisionMustFixTotalCount === "number"
                      ? { latestRevisionMustFixTotalCount }
                      : {}),
                    ...(typeof latestRevisionMustFixUnresolvedCount === "number"
                      ? { latestRevisionMustFixUnresolvedCount }
                      : {}),
                    ...autoReviewState,
                  });
                },
                onReviseStart: ({ round, maxReviseRounds, mode, strategyReason }) => {
                  broadcast("revise:start", {
                    bookId: id,
                    entry: "rewrite",
                    chapter: chapterNum,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "revise",
                    mode,
                    ...(typeof strategyReason === "string" && strategyReason.trim()
                      ? { strategyReason: strategyReason.trim() }
                      : {}),
                    autoTriggeredByAudit: true,
                  });
                },
                onReviseComplete: ({ round, maxReviseRounds, mode, reviseResult, reviseAudit, tokenUsage }) => {
                  broadcast("revise:complete", {
                    bookId: id,
                    entry: "rewrite",
                    chapter: reviseResult.chapterNumber,
                    round,
                    maxRounds: maxReviseRounds,
                    phase: "revise",
                    mode,
                    autoTriggeredByAudit: true,
                    wordCount: reviseResult.wordCount,
                    status: reviseResult.status,
                    applied: reviseResult.applied,
                    ...(reviseAudit
                      ? {
                        audit: {
                          passed: reviseAudit.passed,
                          score: reviseAudit.score,
                          issueCount: reviseAudit.issueCount,
                          severityCounts: reviseAudit.severityCounts,
                          failureGate: reviseAudit.failureGate,
                          summary: reviseAudit.summary,
                          issues: reviseAudit.issueTexts,
                          report: reviseAudit.report,
                        },
                      }
                      : {}),
                  });
                },
              });
              const finalAudit = unified.finalAudit;
              await enforceNonDestructiveRewriteConsistency({
                state,
                bookId: id,
                baseline: rewriteConsistencyBaseline,
              });
              let rewriteImpact: RewriteImpactSummary | null = null;
              try {
                rewriteImpact = await markDownstreamChaptersForReview({
                  state,
                  bookId: id,
                  pivotChapter: chapterNum,
                  rewrittenStartChapter: chapterNum,
                  rewrittenEndChapter: chapterNum,
                });
              } catch (error) {
                broadcast("log", {
                  bookId: id,
                  level: "warning",
                  tag: "studio",
                  message: `标记受影响章节失败：${error instanceof Error ? error.message : String(error)}`,
                });
              }
              broadcast("rewrite:complete", {
                bookId: id,
                entry: "rewrite",
                chapterNumber: result.chapterNumber,
                wordCount: result.wordCount,
                status: result.status,
                mode: "non-destructive",
                autoReview: unified.autoReview,
                ...(finalAudit
                  ? {
                    audit: {
                      passed: finalAudit.passed,
                      score: finalAudit.score,
                      issueCount: finalAudit.issueCount,
                      severityCounts: finalAudit.severityCounts,
                      failureGate: finalAudit.failureGate,
                      summary: finalAudit.summary,
                      issues: finalAudit.issueTexts,
                      report: finalAudit.report,
                    },
                  }
                  : {}),
                ...(rewriteImpact
                  ? {
                    rewriteImpact: {
                      affectedCount: rewriteImpact.affectedCount,
                      affectedChapterNumbers: rewriteImpact.affectedChapterNumbers,
                      ...(typeof rewriteImpact.startChapter === "number" ? { startChapter: rewriteImpact.startChapter } : {}),
                      ...(typeof rewriteImpact.endChapter === "number" ? { endChapter: rewriteImpact.endChapter } : {}),
                    },
                  }
                  : {}),
              });
            } catch (error) {
              broadcast("rewrite:error", {
                bookId: id,
                chapter: chapterNum,
                mode: "non-destructive",
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
          (e) => broadcast("rewrite:error", {
            bookId: id,
            chapter: chapterNum,
            mode: "non-destructive",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        return c.json({
          status: "rewriting",
          mode: "non-destructive",
          destructive: false,
          bookId: id,
          chapter: chapterNum,
          note: "后续章节已保留，不会回滚或删除。",
        });
      }

      const rollbackTarget = chapterNum - 1;
      const rewriteRisk = await buildRewriteRiskSummary({
        state,
        bookId: id,
        rollbackTarget,
      });
      const { discarded, usedFallbackRepair } = await prepareRewriteFromChapter({
        state,
        bookId: id,
        chapterNumber: chapterNum,
      });
      emitRewriteEndpointAuditLog({
        mode: "destructive",
        riskMessage: rewriteRisk.message,
      });
      broadcast("rewrite:risk", {
        bookId: id,
        mode: "destructive",
        rollbackTarget,
        discardedChapterNumbers: rewriteRisk.discardedChapterNumbers,
        discardedCount: rewriteRisk.discardedCount,
        message: rewriteRisk.message,
      });
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
        writeStageHeartbeatMs: resolveWriteStageHeartbeatMs(),
      }));
      const emitRewriteLog = (message: string, level: "info" | "warning" | "error" = "info"): void => {
        broadcast("log", {
          bookId: id,
          level,
          tag: "studio",
          message,
        });
      };
      if (usedFallbackRepair && rollbackTarget > 0) {
        emitRewriteLog(`回滚目标第${rollbackTarget}章快照缺失，已切换到快照链自动修复并重建章节状态。`, "warning");
        await pipeline.resyncChapterArtifacts(id, rollbackTarget);
        emitRewriteLog(`已完成第${rollbackTarget}章状态重建，继续执行重写。`);
      }
      const rewriteBeforeIndex = normalizeChapterIndexEntries(
        await state.loadChapterIndex(id).catch(() => [] as ChapterIndexEntryLike[]),
      );
      writeRewrittenChapter({
        pipeline,
        bookId: id,
        chapterNumber: chapterNum,
      }).then(
        async (result) => {
          try {
            const writePersistence = await verifyWritePersistence({
              state,
              bookId: id,
              beforeIndex: rewriteBeforeIndex,
            });
            if (!writePersistence.persisted) {
              throw new Error(
                writePersistence.addedChapterNumbers.length === 0
                  ? "重写结束，但未检测到新章节写入索引。"
                  : `重写结束，但第${writePersistence.missingChapterFiles.join("、")}章正文文件未落盘。`,
              );
            }
            const degradedChapterNumbers = await findDegradedChapterNumbers({
              state,
              bookId: id,
              chapterNumbers: writePersistence.addedChapterNumbers,
            });
            if (degradedChapterNumbers.length > 0) {
              const degradedRecovery = await tryAutoRecoverDegradedWrite({
                pipeline,
                state,
                bookId: id,
                chapterNumbers: writePersistence.addedChapterNumbers,
                log: emitRewriteLog,
              });
              if (!degradedRecovery.recovered) {
                throw new Error(
                  `重写已落盘，但第${degradedRecovery.remainingDegradedChapterNumbers.join("、")}章状态降级（state-degraded）。`
                  + `${degradedRecovery.reason ? ` 自动修复失败：${degradedRecovery.reason}` : ""}`,
                );
              }
            }
            broadcast("rewrite:complete", {
              bookId: id,
              entry: "rewrite",
              chapterNumber: result.chapterNumber,
              title: result.title,
              wordCount: result.wordCount,
              mode: "destructive",
              autoReview: buildSingleAuditAutoReviewPayload(true),
            });
          } catch (error) {
            broadcast("rewrite:error", { bookId: id, error: error instanceof Error ? error.message : String(error) });
          }
        },
        (e) => broadcast("rewrite:error", { bookId: id, error: e instanceof Error ? e.message : String(e) }),
      );
      return c.json({
        status: "rewriting",
        mode: "destructive",
        destructive: true,
        bookId: id,
        chapter: chapterNum,
        rolledBackTo: rollbackTarget,
        discarded,
        risk: {
          rollbackTarget,
          discardedChapterNumbers: rewriteRisk.discardedChapterNumbers,
          discardedCount: rewriteRisk.discardedCount,
          message: rewriteRisk.message,
        },
      });
    } catch (e) {
      broadcast("rewrite:error", { bookId: id, error: String(e) });
      if (e instanceof ApiError) throw e;
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/resync/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      const result = await pipeline.resyncChapterArtifacts(id, chapterNum);
      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect All chapters ---

  app.post("/api/v1/books/:id/detect-all", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const { analyzeAITells } = await import("@actalk/inkos-core");

      const results = await Promise.all(
        mdFiles.map(async (f) => {
          const num = parseInt(f.slice(0, 4), 10);
          const content = await readFile(join(chaptersDir, f), "utf-8");
          const result = analyzeAITells(content);
          return { chapterNumber: num, filename: f, ...result };
        }),
      );
      return c.json({ bookId: id, results });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect Stats ---

  app.get("/api/v1/books/:id/detect/stats", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadDetectionHistory, analyzeDetectionInsights } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const history = await loadDetectionHistory(bookDir);
      const insights = analyzeDetectionInsights(history);
      return c.json(insights);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre Create ---

  app.post("/api/v1/genres/create", async (c) => {
    const body = await c.req.json<{
      id: string; name: string; language?: string;
      chapterTypes?: string[]; fatigueWords?: string[];
      numericalSystem?: boolean; powerScaling?: boolean; eraResearch?: boolean;
      pacingRule?: string; satisfactionTypes?: string[]; auditDimensions?: number[];
      body?: string;
    }>();

    if (!body.id || !body.name) {
      return c.json({ error: "id and name are required" }, 400);
    }
    if (/[/\\\0]/.test(body.id) || body.id.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${body.id}"`);
    }

    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const frontmatter = [
      "---",
      `name: ${body.name}`,
      `id: ${body.id}`,
      `language: ${body.language ?? "zh"}`,
      `chapterTypes: ${JSON.stringify(body.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(body.fatigueWords ?? [])}`,
      `numericalSystem: ${body.numericalSystem ?? false}`,
      `powerScaling: ${body.powerScaling ?? false}`,
      `eraResearch: ${body.eraResearch ?? false}`,
      `pacingRule: "${body.pacingRule ?? ""}"`,
      `satisfactionTypes: ${JSON.stringify(body.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(body.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${body.id}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: body.id });
  });

  // --- Genre Edit ---

  app.put("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const body = await c.req.json<{ profile: Record<string, unknown>; body: string }>();
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const p = body.profile;
    const frontmatter = [
      "---",
      `name: ${p.name ?? genreId}`,
      `id: ${p.id ?? genreId}`,
      `language: ${p.language ?? "zh"}`,
      `chapterTypes: ${JSON.stringify(p.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(p.fatigueWords ?? [])}`,
      `numericalSystem: ${p.numericalSystem ?? false}`,
      `powerScaling: ${p.powerScaling ?? false}`,
      `eraResearch: ${p.eraResearch ?? false}`,
      `pacingRule: "${p.pacingRule ?? ""}"`,
      `satisfactionTypes: ${JSON.stringify(p.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(p.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${genreId}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: genreId });
  });

  // --- Genre Delete (project-level only) ---

  app.delete("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const filePath = join(root, "genres", `${genreId}.md`);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(filePath);
      return c.json({ ok: true, id: genreId });
    } catch (e) {
      return c.json({ error: `Genre "${genreId}" not found in project` }, 404);
    }
  });

  // --- Style Analyze ---

  app.post("/api/v1/style/analyze", async (c) => {
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    try {
      const { analyzeStyle } = await import("@actalk/inkos-core");
      const profile = analyzeStyle(text, sourceName ?? "unknown");
      return c.json(profile);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Style Import to Book ---

  app.post("/api/v1/books/:id/style/import", async (c) => {
    const id = c.req.param("id");
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();

    broadcast("style:start", { bookId: id });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.generateStyleGuide(id, text, sourceName ?? "unknown");
      broadcast("style:complete", { bookId: id });
      return c.json({ ok: true, result });
    } catch (e) {
      broadcast("style:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Chapters ---

  app.post("/api/v1/books/:id/import/chapters", async (c) => {
    const id = c.req.param("id");
    const { text, splitRegex } = await c.req.json<{ text: string; splitRegex?: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    broadcast("import:start", { bookId: id, type: "chapters" });
    try {
      const { splitChapters } = await import("@actalk/inkos-core");
      const chapters = [...splitChapters(text, splitRegex)];

      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.importChapters({ bookId: id, chapters });
      broadcast("import:complete", { bookId: id, type: "chapters", count: result.importedCount });
      return c.json(result);
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Canon ---

  app.post("/api/v1/books/:id/import/canon", async (c) => {
    const id = c.req.param("id");
    const { fromBookId } = await c.req.json<{ fromBookId: string }>();
    if (!fromBookId) return c.json({ error: "fromBookId is required" }, 400);

    broadcast("import:start", { bookId: id, type: "canon" });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importCanon(id, fromBookId);
      broadcast("import:complete", { bookId: id, type: "canon" });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Init ---

  app.post("/api/v1/fanfic/init", async (c) => {
    const body = await c.req.json<{
      title: string; sourceText: string; sourceName?: string;
      mode?: string; genre?: string; platform?: string;
      targetChapters?: number; chapterWordCount?: number; language?: string;
    }>();
    if (!body.title || !body.sourceText) {
      return c.json({ error: "title and sourceText are required" }, 400);
    }

    const now = new Date().toISOString();
    const bookId = body.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").slice(0, 30);

    const bookConfig = {
      id: bookId,
      title: body.title,
      platform: (body.platform ?? "other") as "other",
      genre: (body.genre ?? "other") as "xuanhuan",
      status: "outlining" as const,
      targetChapters: body.targetChapters ?? 100,
      chapterWordCount: body.chapterWordCount ?? 3000,
      fanficMode: (body.mode ?? "canon") as "canon",
      ...(body.language ? { language: body.language as "zh" | "en" } : {}),
      createdAt: now,
      updatedAt: now,
    };

    broadcast("fanfic:start", { bookId, title: body.title });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.initFanficBook(bookConfig, body.sourceText, body.sourceName ?? "source", (body.mode ?? "canon") as "canon");
      broadcast("fanfic:complete", { bookId });
      return c.json({ ok: true, bookId });
    } catch (e) {
      broadcast("fanfic:error", { bookId, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Show (read canon) ---

  app.get("/api/v1/books/:id/fanfic", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(join(bookDir, "story", "fanfic_canon.md"), "utf-8");
      return c.json({ bookId: id, content });
    } catch {
      return c.json({ bookId: id, content: null });
    }
  });

  // --- Fanfic Refresh ---

  app.post("/api/v1/books/:id/fanfic/refresh", async (c) => {
    const id = c.req.param("id");
    const { sourceText, sourceName } = await c.req.json<{ sourceText: string; sourceName?: string }>();
    if (!sourceText?.trim()) return c.json({ error: "sourceText is required" }, 400);

    broadcast("fanfic:refresh:start", { bookId: id });
    try {
      const book = await state.loadBookConfig(id);
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importFanficCanon(id, sourceText, sourceName ?? "source", (book.fanficMode ?? "canon") as "canon");
      broadcast("fanfic:refresh:complete", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("fanfic:refresh:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Helpers ---

  async function readRequiredVolumeOutline(bookDir: string): Promise<{
    readonly volumeOutline: string;
  } | null> {
    const volumeOutline = (await readVolumeMap(bookDir, "")).trim();
    if (volumeOutline) return { volumeOutline };

    const wizardVolume = (await readWizardStepMarkdown(bookDir, "volume")).trim();
    if (!wizardVolume) return null;

    await writeStoryArtifactCopies([
      join(bookDir, "story", "outline", "volume_map.md"),
      join(bookDir, "story", "volume_outline.md"),
    ], wizardVolume);

    return { volumeOutline: wizardVolume };
  }

  function resolveChapterLimitFromBook(book: { targetChapters?: number } | null | undefined): number | null {
    const raw = Number(book?.targetChapters);
    if (!Number.isFinite(raw) || raw < 1) return null;
    return Math.trunc(raw);
  }

  async function chapterHasContent(bookDir: string, chapterNumber: number): Promise<boolean> {
    const chaptersDir = join(bookDir, "chapters");
    const chapterFiles = await readdir(chaptersDir).catch(() => [] as string[]);
    return chapterFiles.some((file) => parseChapterFileNumber(file) === chapterNumber);
  }

  async function createDesignAgent(options?: {
    readonly onTextDelta?: (text: string) => void;
  }): Promise<ChapterDesignAgent> {
    const config = await loadCurrentProjectConfig();
    const client = createLLMClient(config.llm);
    const logger = createLogger({ tag: "chapter-design", sinks: [consoleSink, sseSink] });
    const ctx: AgentContext = {
      client,
      model: config.llm.model,
      projectRoot: root,
      logger,
      ...(options?.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
    };
    return new ChapterDesignAgent(ctx);
  }

  function loadPlansJson(raw: string): { plans: any[]; maxChapter: number; collection: Record<string, unknown> } {
    const parsed = JSON.parse(raw) as unknown;
    const collection = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
    const plans = Array.isArray(collection.plans) ? collection.plans as any[] : [];
    const maxChapter = plans.reduce((max: number, p: any) => Math.max(max, p.chapterNumber ?? 0), 0);
    return { plans, maxChapter, collection };
  }

  async function trimPlansBeyondLimit(plansPath: string, chapterLimit: number | null): Promise<number[]> {
    if (!chapterLimit || chapterLimit < 1) return [];
    try {
      const raw = await readFile(plansPath, "utf-8");
      const { plans, collection } = loadPlansJson(raw);
      const excess = plans.filter((p: any) => p.chapterNumber > chapterLimit);
      if (excess.length === 0) return [];
      const trimmed = plans.filter((p: any) => p.chapterNumber <= chapterLimit);
      await writeFile(plansPath, JSON.stringify({ ...collection, plans: trimmed, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
      return excess.map((p: any) => Number(p.chapterNumber)).filter((n: number) => Number.isFinite(n) && n > 0);
    } catch { /* file not found or unreadable — nothing to trim */ }
    return [];
  }

  function chapterPlanHistoryPath(bookDir: string): string {
    return join(bookDir, "story", "state", CHAPTER_PLAN_HISTORY_FILE);
  }

  function normalizeChapterPlanVersion(raw: unknown): number {
    const version = Number(raw);
    if (!Number.isFinite(version) || version < 1) return 1;
    return Math.trunc(version);
  }

  function cloneChapterPlanSnapshot(plan: unknown): Record<string, unknown> {
    if (!plan || typeof plan !== "object") return {};
    return structuredClone(plan) as Record<string, unknown>;
  }

  function normalizeChapterPlanHistoryEntry(raw: unknown): ChapterPlanHistoryEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const payload = raw as Partial<ChapterPlanHistoryEntry> & { plan?: unknown };
    const plan = payload.plan && typeof payload.plan === "object" ? payload.plan as Record<string, unknown> : null;
    const chapterNumber = Number(payload.chapterNumber ?? plan?.chapterNumber ?? NaN);
    if (!Number.isFinite(chapterNumber) || chapterNumber < 1 || !plan) return null;
    return {
      chapterNumber: Math.trunc(chapterNumber),
      version: normalizeChapterPlanVersion(payload.version ?? plan.version),
      action: typeof payload.action === "string" && payload.action.trim() ? payload.action.trim() : "manual",
      savedAt: typeof payload.savedAt === "string" && payload.savedAt.trim() ? payload.savedAt.trim() : new Date().toISOString(),
      plan,
    };
  }

  function loadChapterPlanHistoryJson(raw: string): ChapterPlanHistoryStore {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        entries: parsed.map((item) => normalizeChapterPlanHistoryEntry(item)).filter((item): item is ChapterPlanHistoryEntry => item !== null),
      };
    }
    if (!parsed || typeof parsed !== "object") return { entries: [] };
    const payload = parsed as { entries?: unknown; updatedAt?: unknown };
    const entries = Array.isArray(payload.entries)
      ? payload.entries.map((item) => normalizeChapterPlanHistoryEntry(item)).filter((item): item is ChapterPlanHistoryEntry => item !== null)
      : [];
    return {
      entries,
      ...(typeof payload.updatedAt === "string" && payload.updatedAt.trim() ? { updatedAt: payload.updatedAt.trim() } : {}),
    };
  }

  async function readChapterPlanHistoryStore(historyPath: string): Promise<ChapterPlanHistoryStore> {
    try {
      const raw = await readFile(historyPath, "utf-8");
      return loadChapterPlanHistoryJson(raw);
    } catch {
      return { entries: [] };
    }
  }

  function summarizeChapterPlanHistoryEntry(entry: ChapterPlanHistoryEntry): {
    chapterNumber: number;
    version: number;
    action: string;
    chapterName: string;
    status: string;
    source: string;
    updatedAt: string;
    lockedFields?: ReadonlyArray<string>;
    driftFlags?: ReadonlyArray<{ code: string; message: string }>;
    needsReview?: boolean;
  } {
    const plan = entry.plan as {
      chapterName?: unknown;
      status?: unknown;
      source?: unknown;
      updatedAt?: unknown;
      lockedFields?: unknown;
      driftFlags?: unknown;
      needsReview?: unknown;
    };
    return {
      chapterNumber: entry.chapterNumber,
      version: entry.version,
      action: entry.action,
      chapterName: typeof plan.chapterName === "string" ? plan.chapterName : "",
      status: typeof plan.status === "string" ? plan.status : "planned",
      source: typeof plan.source === "string" ? plan.source : "auto",
      updatedAt: typeof plan.updatedAt === "string" ? plan.updatedAt : entry.savedAt,
      ...(Array.isArray(plan.lockedFields) ? { lockedFields: plan.lockedFields.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(plan.driftFlags)
        ? { driftFlags: plan.driftFlags.filter((item): item is { code: string; message: string } => !!item && typeof item === "object") as Array<{ code: string; message: string }> }
        : {}),
      ...(typeof plan.needsReview === "boolean" ? { needsReview: plan.needsReview } : {}),
    };
  }

  function dedupeChapterPlanHistoryEntries(entries: ReadonlyArray<ChapterPlanHistoryEntry>): ChapterPlanHistoryEntry[] {
    const map = new Map<string, ChapterPlanHistoryEntry>();
    for (const entry of entries) {
      const key = `${entry.chapterNumber}:${entry.version}`;
      const existing = map.get(key);
      if (!existing || existing.savedAt <= entry.savedAt) {
        map.set(key, entry);
      }
    }
    return [...map.values()].sort((left, right) => {
      if (left.chapterNumber !== right.chapterNumber) return left.chapterNumber - right.chapterNumber;
      if (left.version !== right.version) return left.version - right.version;
      return left.savedAt.localeCompare(right.savedAt);
    });
  }

  async function readChapterPlanHistoryEntries(bookDir: string, chapterNumber: number, currentPlan?: Record<string, unknown> | null): Promise<ChapterPlanHistoryEntry[]> {
    const historyPath = chapterPlanHistoryPath(bookDir);
    const store = await readChapterPlanHistoryStore(historyPath);
    const entries = store.entries.filter((entry) => entry.chapterNumber === chapterNumber);
    if (currentPlan && Number.isFinite(Number(currentPlan.chapterNumber)) && Number(currentPlan.chapterNumber) === chapterNumber) {
      const version = normalizeChapterPlanVersion((currentPlan as { version?: unknown }).version);
      entries.push({
        chapterNumber,
        version,
        action: "current",
        savedAt: typeof currentPlan.updatedAt === "string" ? currentPlan.updatedAt : new Date().toISOString(),
        plan: cloneChapterPlanSnapshot(currentPlan),
      });
    }
    return dedupeChapterPlanHistoryEntries(entries);
  }

  async function persistChapterPlansWithHistory(args: {
    readonly bookDir: string;
    readonly plansPath: string;
    readonly collection?: Record<string, unknown>;
    readonly plans: ReadonlyArray<Record<string, unknown>>;
    readonly historyEntries?: ReadonlyArray<ChapterPlanHistoryEntry>;
  }): Promise<void> {
    const now = new Date().toISOString();
    await mkdir(join(args.bookDir, "story", "state"), { recursive: true });
    await writeFile(
      args.plansPath,
      JSON.stringify({
        ...(args.collection ?? {}),
        plans: args.plans,
        updatedAt: now,
      }, null, 2),
      "utf-8",
    );
    if (!args.historyEntries || args.historyEntries.length === 0) return;
    const historyPath = chapterPlanHistoryPath(args.bookDir);
    const historyStore = await readChapterPlanHistoryStore(historyPath);
    historyStore.entries.push(...args.historyEntries);
    await writeFile(
      historyPath,
      JSON.stringify({
        entries: dedupeChapterPlanHistoryEntries(historyStore.entries),
        updatedAt: now,
      }, null, 2),
      "utf-8",
    );
  }

  async function readCurrentChapterPlan(bookDir: string, chapterNumber: number): Promise<Record<string, unknown> | null> {
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    try {
      const raw = await readFile(plansPath, "utf-8");
      const { plans } = loadPlansJson(raw);
      const found = plans.find((plan: any) => Number(plan.chapterNumber) === chapterNumber);
      return found && typeof found === "object" ? cloneChapterPlanSnapshot(found) : null;
    } catch {
      return null;
    }
  }

  // --- Chapter Plans ---

  app.get("/api/v1/books/:id/chapter-plans", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    const book = await state.loadBookConfig(id).catch(() => null);
    const chapterLimit = resolveChapterLimitFromBook(book);
    await trimPlansBeyondLimit(plansPath, chapterLimit);
    try {
      const raw = await readFile(plansPath, "utf-8");
      const { plans } = loadPlansJson(raw);
      return c.json({ count: plans.length, plans });
    } catch {
      return c.json({ count: 0, plans: [] });
    }
  });

  app.post("/api/v1/books/:id/chapter-plans/precheck-generate", async (c) => {
    const id = c.req.param("id");
    const { startChapter, count } = await c.req.json<{ startChapter: number; count: number }>();
    if (!startChapter || !count || startChapter < 1 || count < 1) {
      return c.json({ error: "startChapter and count are required" }, 400);
    }
    const bookDir = state.bookDir(id);
    let book;
    try {
      book = await state.loadBookConfig(id);
    } catch (e) {
      return c.json({ error: `Book not found: ${e}` }, 404);
    }
    const chapterLimit = resolveChapterLimitFromBook(book);
    if (chapterLimit == null) {
      return c.json({ error: "book.json 缺少 targetChapters，无法进行分章设计。" }, 400);
    }
    const endChapter = startChapter + count - 1;
    const effectiveEndChapter = Math.min(endChapter, chapterLimit);

    const outlineData = await readRequiredVolumeOutline(bookDir);
    if (!outlineData) {
      return c.json({ error: "卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。" }, 400);
    }
    if (startChapter > chapterLimit) {
      return c.json({
        startChapter,
        endChapter: chapterLimit,
        count: 0,
        chapters: [],
        hasConflict: false,
        hasExistingPlan: false,
      });
    }
    const effectiveCount = Math.max(0, effectiveEndChapter - startChapter + 1);

    // Trim excess plans beyond outline and load
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    await trimPlansBeyondLimit(plansPath, chapterLimit);
    let existingPlans: any[] = [];
    try {
      const raw = await readFile(plansPath, "utf-8");
      existingPlans = loadPlansJson(raw).plans;
    } catch { /* ignore */ }
    const existingPlanMap = new Map(existingPlans.map((p: any) => [p.chapterNumber, p]));

    // List existing chapter content files
    const chaptersDir = join(bookDir, "chapters");
    let chapterFiles: string[] = [];
    try { chapterFiles = await readdir(chaptersDir); } catch { /* ignore */ }
    const existingChapterNumbers = new Set(
      chapterFiles
        .map((f) => parseChapterFileNumber(f))
        .filter((n): n is number => n !== null),
    );

    // Build per-chapter status
    const chapters = [];
    let hasExistingPlan = false;
    let hasConflict = false;
    for (let ch = startChapter; ch <= effectiveEndChapter; ch++) {
      const plan = existingPlanMap.get(ch);
      const hasPlan = !!plan;
      if (hasPlan) hasExistingPlan = true;
      const hasContent = existingChapterNumbers.has(ch);
      if (hasContent) hasConflict = true;
      chapters.push({
        chapterNumber: ch,
        hasPlan,
        hasContent,
        status: plan?.status ?? null,
      });
    }

    return c.json({
      startChapter,
      endChapter: effectiveEndChapter,
      count: effectiveCount,
      chapters,
      hasConflict,
      hasExistingPlan,
    });
  });

  app.post("/api/v1/books/:id/chapter-plans/generate-batch", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ startChapter?: number; count: number; force?: boolean }>();
    const bookDir = state.bookDir(id);
    const chapterCount = body.count || 20;

    // Load book config and validate against outline
    let book;
    try {
      book = await state.loadBookConfig(id);
    } catch (e) {
      return c.json({ error: `Book not found: ${e}` }, 404);
    }
    const targetChapters = resolveChapterLimitFromBook(book);
    if (targetChapters == null) {
      return c.json({ error: "book.json 缺少 targetChapters，无法进行分章设计。" }, 400);
    }
    const outlineData = await readRequiredVolumeOutline(bookDir);
    if (!outlineData) {
      return c.json({ error: "卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。" }, 400);
    }

    // Trim excess plans beyond outline and load
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    await trimPlansBeyondLimit(plansPath, targetChapters);
    let existingPlans: any[] = [];
    try {
      const raw = await readFile(plansPath, "utf-8");
      existingPlans = loadPlansJson(raw).plans;
    } catch { /* ignore */ }

    // Determine start chapter (first unplanned if not specified)
    let startChapter = body.startChapter;
    if (!startChapter || startChapter < 1) {
      const plannedNumbers = new Set(existingPlans.map((p: any) => p.chapterNumber));
      startChapter = 1;
      while (plannedNumbers.has(startChapter)) startChapter++;
    }

    // Validate range against outline and clamp if needed
    const endChapter = startChapter + chapterCount - 1;
    if (startChapter > targetChapters) {
      return c.json({ error: `起始章节 ${startChapter} 超出 book.json 总章数 (${targetChapters}章)` }, 400);
    }
    const clampedEnd = Math.min(endChapter, targetChapters);
    const clampedCount = clampedEnd - startChapter + 1;
    if (clampedEnd < endChapter) {
      // 超出卷纲范围的分章设计已自动清除，生成范围已自动缩小
    }

    // If not forced, check for existing plans in range
    if (!body.force) {
      const rangePlans = existingPlans.filter((p: any) => p.chapterNumber >= startChapter && p.chapterNumber <= clampedEnd);
      if (rangePlans.length > 0) {
        return c.json({
          ok: false,
          partial: false,
          failedChapters: rangePlans.map((p: any) => ({
            chapterNumber: p.chapterNumber,
            reasonCode: "ALREADY_PLANNED",
            reason: "已有分章设计，如需覆盖请使用强制生成",
          })),
        });
      }
    }

    // Create agent and generate
    try {
      const agent = await createDesignAgent();
      const plans = await agent.designBatch({
        book,
        bookDir,
        volumeOutline: outlineData.volumeOutline,
        startChapter,
        count: clampedCount,
        outlineChapterLimit: targetChapters,
        existingPlans: existingPlans.filter((p: any) => p.chapterNumber < startChapter),
        language: book.language,
      });

      // Merge with existing plans and save
      const merged = [...existingPlans];
      const historyEntries: ChapterPlanHistoryEntry[] = [];
      const now = new Date().toISOString();
      for (const plan of plans) {
        const idx = merged.findIndex((p: any) => p.chapterNumber === plan.chapterNumber);
        const base = idx >= 0 ? merged[idx] : null;
        const nextVersion = base
          ? normalizeChapterPlanVersion((base as { version?: unknown }).version) + 1
          : normalizeChapterPlanVersion(plan.version);
        const nextPlan = base
          ? {
              ...base,
              ...plan,
              chapterNumber: plan.chapterNumber,
              version: nextVersion,
              updatedAt: now,
            }
          : {
              ...plan,
              version: nextVersion,
              createdAt: now,
              updatedAt: now,
            };
        if (idx >= 0) merged[idx] = nextPlan;
        else merged.push(nextPlan);
        historyEntries.push({
          chapterNumber: plan.chapterNumber,
          version: nextVersion,
          action: base ? "generate-replace" : "generate",
          savedAt: now,
          plan: cloneChapterPlanSnapshot(nextPlan),
        });
      }
      merged.sort((a: any, b: any) => a.chapterNumber - b.chapterNumber);
      await persistChapterPlansWithHistory({
        bookDir,
        plansPath,
        plans: merged,
        historyEntries,
      });

      return c.json({ ok: true, successChapters: plans.map((p) => p.chapterNumber) });
    } catch (e) {
      return c.json({ error: `生成失败: ${e}` }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapter-plans/cleanup-overflow", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    let book;
    try {
      book = await state.loadBookConfig(id);
    } catch (e) {
      return c.json({ error: `Book not found: ${e}` }, 404);
    }
    const chapterLimit = resolveChapterLimitFromBook(book);
    if (chapterLimit == null) {
      return c.json({ error: "book.json 缺少 targetChapters，无法进行分章设计。" }, 400);
    }

    const outlineData = await readRequiredVolumeOutline(bookDir);
    if (!outlineData) {
      return c.json({ error: "卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。" }, 400);
    }
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    const removedChapters = await trimPlansBeyondLimit(plansPath, chapterLimit);

    return c.json({
      ok: true,
      removedChapters,
      removedCount: removedChapters.length,
      chapterLimit,
    });
  });

  app.post("/api/v1/books/:id/chapter-plans/fill-missing", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ startChapter?: number; endChapter?: number }>();
    const bookDir = state.bookDir(id);

    // Load book config
    let book;
    try {
      book = await state.loadBookConfig(id);
    } catch (e) {
      return c.json({ error: `Book not found: ${e}` }, 404);
    }
    const chapterLimit = resolveChapterLimitFromBook(book);
    if (chapterLimit == null) {
      return c.json({ error: "book.json 缺少 targetChapters，无法进行分章设计。" }, 400);
    }
    const outlineData = await readRequiredVolumeOutline(bookDir);
    if (!outlineData) {
      return c.json({ error: "卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。" }, 400);
    }
    const startChapterRaw = Number(body.startChapter);
    const endChapterRaw = Number(body.endChapter);
    const startChapter = Number.isFinite(startChapterRaw) ? Math.max(1, Math.trunc(startChapterRaw)) : 1;
    const effectiveEndChapter = Number.isFinite(endChapterRaw)
      ? Math.min(Math.max(1, Math.trunc(endChapterRaw)), chapterLimit)
      : chapterLimit;
    if (startChapter > effectiveEndChapter) {
      return c.json({ ok: true, successChapters: [] });
    }

    // Trim excess plans beyond outline and load
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    await trimPlansBeyondLimit(plansPath, chapterLimit);
    let existingPlans: any[] = [];
    try {
      const raw = await readFile(plansPath, "utf-8");
      existingPlans = loadPlansJson(raw).plans;
    } catch { /* ignore */ }

    // Find missing chapter numbers
    const plannedNumbers = new Set(existingPlans.map((p: any) => p.chapterNumber));
    const missing: number[] = [];
    for (let ch = startChapter; ch <= effectiveEndChapter; ch++) {
      if (!plannedNumbers.has(ch)) missing.push(ch);
    }
    if (missing.length === 0) {
      return c.json({ ok: true, successChapters: [] });
    }

    // Group missing numbers into consecutive ranges (max 20 per batch)
    const BATCH_SIZE = 20;
    const ranges: Array<{ start: number; count: number }> = [];
    let i = 0;
    while (i < missing.length) {
      const rangeStart = missing[i]!;
      let rangeEnd = rangeStart;
      let j = i;
      while (j < missing.length && missing[j]! - rangeEnd <= 1 && (j - i) < BATCH_SIZE) {
        rangeEnd = missing[j]!;
        j++;
      }
      ranges.push({ start: rangeStart, count: rangeEnd - rangeStart + 1 });
      i = j;
    }

    // Generate each range
    const agent = await createDesignAgent();
    const allPlans: any[] = [];
    const failedChapters: Array<{ chapterNumber: number; reason: string }> = [];

    for (const range of ranges) {
      try {
        const plans = await agent.designBatch({
          book,
          bookDir,
          volumeOutline: outlineData.volumeOutline,
          startChapter: range.start,
          count: range.count,
          outlineChapterLimit: chapterLimit,
          existingPlans: existingPlans.filter((p: any) => p.chapterNumber < range.start),
          language: book.language,
        });
        allPlans.push(...plans);
      } catch (e) {
        for (let ch = range.start; ch < range.start + range.count; ch++) {
          failedChapters.push({ chapterNumber: ch, reason: String(e) });
        }
      }
    }

    // Merge and save
    const merged = [...existingPlans];
    const historyEntries: ChapterPlanHistoryEntry[] = [];
    const now = new Date().toISOString();
    for (const plan of allPlans) {
      const idx = merged.findIndex((p: any) => p.chapterNumber === plan.chapterNumber);
      const nextPlan = {
        ...plan,
        version: normalizeChapterPlanVersion(plan.version),
        createdAt: now,
        updatedAt: now,
      };
      if (idx >= 0) {
        const base = merged[idx];
        const nextVersion = normalizeChapterPlanVersion((base as { version?: unknown }).version) + 1;
        merged[idx] = {
          ...base,
          ...nextPlan,
          chapterNumber: plan.chapterNumber,
          version: nextVersion,
          updatedAt: now,
        };
        historyEntries.push({
          chapterNumber: plan.chapterNumber,
          version: nextVersion,
          action: "fill-missing",
          savedAt: now,
          plan: cloneChapterPlanSnapshot(merged[idx]),
        });
      } else {
        merged.push(nextPlan);
        historyEntries.push({
          chapterNumber: plan.chapterNumber,
          version: nextPlan.version,
          action: "fill-missing",
          savedAt: now,
          plan: cloneChapterPlanSnapshot(nextPlan),
        });
      }
    }
    merged.sort((a: any, b: any) => a.chapterNumber - b.chapterNumber);
    await persistChapterPlansWithHistory({
      bookDir,
      plansPath,
      plans: merged,
      historyEntries,
    });

    return c.json({
      ok: failedChapters.length === 0,
      partial: failedChapters.length > 0 && allPlans.length > 0,
      successChapters: allPlans.map((p) => p.chapterNumber),
      failedChapters: failedChapters.length > 0 ? failedChapters : undefined,
    });
  });

  app.post("/api/v1/books/:id/chapter-plans/backfill-from-chapter", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ startChapter?: number; endChapter?: number }>();
    const bookDir = state.bookDir(id);

    // Load book config
    let book;
    try {
      book = await state.loadBookConfig(id);
    } catch (e) {
      return c.json({ error: `Book not found: ${e}` }, 404);
    }
    const chapterLimit = resolveChapterLimitFromBook(book);
    if (chapterLimit == null) {
      return c.json({ error: "book.json 缺少 targetChapters，无法进行分章设计。" }, 400);
    }
    const outlineData = await readRequiredVolumeOutline(bookDir);
    if (!outlineData) {
      return c.json({ error: "卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。" }, 400);
    }
    const startChapterRaw = Number(body.startChapter);
    const endChapterRaw = Number(body.endChapter);
    const startChapter = Number.isFinite(startChapterRaw) ? Math.max(1, Math.trunc(startChapterRaw)) : 1;
    const effectiveEndChapter = Number.isFinite(endChapterRaw)
      ? Math.min(Math.max(1, Math.trunc(endChapterRaw)), chapterLimit)
      : chapterLimit;
    if (startChapter > effectiveEndChapter) {
      return c.json({ ok: true, successChapters: [] });
    }

    // Trim excess plans beyond outline and load
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    await trimPlansBeyondLimit(plansPath, chapterLimit);
    let existingPlans: any[] = [];
    try {
      const raw = await readFile(plansPath, "utf-8");
      existingPlans = loadPlansJson(raw).plans;
    } catch { /* ignore */ }

    // List chapter files that have content and are within the requested range.
    const chaptersDir = join(bookDir, "chapters");
    let chapterFiles: string[] = [];
    try { chapterFiles = await readdir(chaptersDir); } catch { /* ignore */ }

    const existingPlanMap = new Map(existingPlans.map((p: any) => [p.chapterNumber, p]));
    const toBackfill = chapterFiles
      .map((f) => parseChapterFileNumber(f))
      .filter((n): n is number => n !== null && n >= startChapter && n <= effectiveEndChapter)
      .sort((a, b) => a - b);

    if (toBackfill.length === 0) {
      return c.json({ ok: true, successChapters: [] });
    }

    // Backfill each chapter one at a time (needs to read content).
    const agent = await createDesignAgent();
    const allPlans: any[] = [];
    const failedChapters: Array<{ chapterNumber: number; reasonCode?: string; reason: string }> = [];

    for (const ch of toBackfill) {
      try {
        // Find the chapter file
        const file = chapterFiles.find((f) => parseChapterFileNumber(f) === ch);
        if (!file) {
          failedChapters.push({ chapterNumber: ch, reasonCode: "CHAPTER_CONTENT_MISSING", reason: "章节文件未找到" });
          continue;
        }
        const content = await readFile(join(chaptersDir, file), "utf-8");
        const title = deriveChapterTitle({ chapterNumber: ch, fileName: file, markdown: content });

        const plan = await agent.analyzeAndDesignChapter({
          book,
          bookDir,
          volumeOutline: outlineData.volumeOutline,
          chapterNumber: ch,
          title,
          content,
          outlineChapterLimit: chapterLimit,
          language: book.language,
        });
        allPlans.push({
          ...plan,
          status: "backfilled",
          source: "inferred_from_text",
          needsReview: true,
          updatedAt: new Date().toISOString(),
        });
      } catch (e) {
        failedChapters.push({ chapterNumber: ch, reasonCode: "CHAPTER_PLAN_AGENT_FAILED", reason: String(e) });
      }
    }

    // Merge and save
    const merged = [...existingPlans];
    const historyEntries: ChapterPlanHistoryEntry[] = [];
    const now = new Date().toISOString();
    for (const plan of allPlans) {
      const idx = merged.findIndex((p: any) => p.chapterNumber === plan.chapterNumber);
      const base = idx >= 0 ? merged[idx] : existingPlanMap.get(plan.chapterNumber) ?? null;
      const nextPlan = base
        ? {
            ...base,
            ...plan,
            chapterNumber: plan.chapterNumber,
            status: "backfilled",
            source: plan.source ?? base.source ?? "inferred_from_text",
            version: normalizeChapterPlanVersion((base as { version?: unknown }).version) + 1,
            updatedAt: now,
          }
        : {
            ...plan,
            version: normalizeChapterPlanVersion(plan.version),
            createdAt: now,
            updatedAt: now,
          };
      if (idx >= 0) merged[idx] = nextPlan;
      else merged.push(nextPlan);
      historyEntries.push({
        chapterNumber: plan.chapterNumber,
        version: normalizeChapterPlanVersion((nextPlan as { version?: unknown }).version),
        action: "backfill",
        savedAt: now,
        plan: cloneChapterPlanSnapshot(nextPlan),
      });
    }
    merged.sort((a: any, b: any) => a.chapterNumber - b.chapterNumber);
    await persistChapterPlansWithHistory({
      bookDir,
      plansPath,
      plans: merged,
      historyEntries,
    });

    return c.json({
      ok: failedChapters.length === 0,
      partial: failedChapters.length > 0 && allPlans.length > 0,
      successChapters: allPlans.map((p) => p.chapterNumber),
      failedChapters: failedChapters.length > 0 ? failedChapters : undefined,
    });
  });

  // --- Task Checklist ---

  app.get("/api/v1/books/:id/task-checklist", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const checklist = await readTaskChecklist(bookDir, id);
    return c.json({
      checklist,
      templates: listScriptWorkspaceChecklistTemplates(),
    });
  });

  // --- Script Workspace ---

  app.get("/api/v1/books/:id/script-workspace", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const workspace = await readScriptWorkspace(bookDir, id, state);
    return c.json({ workspace });
  });

  app.get("/api/v1/books/:id/script-workspace/history", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const currentWorkspace = await readScriptWorkspace(bookDir, id, state);
    const history = await readScriptWorkspaceHistoryEntries(bookDir, id, currentWorkspace);
    return c.json({
      history: history.map((entry) => summarizeScriptWorkspaceHistoryEntry(entry)),
    } satisfies ScriptWorkspaceHistoryResponse);
  });

  app.put("/api/v1/books/:id/script-workspace", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<ScriptWorkspaceSavePayload>().catch(() => ({ workspace: null as never }));
    const workspace = normalizeScriptWorkspace({
      ...(body.workspace ?? {}),
      bookId: id,
      updatedAt: new Date().toISOString(),
    });
    const saved = await writeScriptWorkspace(bookDir, workspace, "save");
    return c.json({ workspace: saved.workspace });
  });

  app.post("/api/v1/books/:id/script-workspace/generate", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<ScriptWorkspaceGeneratePayload>().catch(() => ({ selectedChapterNumbers: [], config: undefined }));
    const existing = await readScriptWorkspace(bookDir, id, state);
    const selectedChapterNumbers = body.selectedChapterNumbers ?? existing.selectedChapterNumbers;
    const config = normalizeWorkspaceConfig(body.config ?? existing.config);
    const llmWorkspace = await tryGenerateScriptWorkspaceWithLLM({
      bookId: id,
      selectedChapterNumbers,
      config,
    });
    const fallbackWorkspace = await buildScriptWorkspaceFromChapters({
      state,
      bookId: id,
      selectedChapterNumbers,
      config,
      existing,
    });
    const workspace = llmWorkspace ?? fallbackWorkspace;
    const saved = await writeScriptWorkspace(bookDir, workspace, "generate");
    return c.json({ workspace: saved.workspace });
  });

  app.get("/api/v1/books/:id/script-workspace/diff", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const fromVersion = Number(c.req.query("fromVersion"));
    const toVersion = Number(c.req.query("toVersion"));
    if (!Number.isFinite(fromVersion) || !Number.isFinite(toVersion) || fromVersion < 1 || toVersion < 1) {
      return c.json({ error: "fromVersion and toVersion are required" }, 400);
    }
    const currentWorkspace = await readScriptWorkspace(bookDir, id, state);
    const history = await readScriptWorkspaceHistoryEntries(bookDir, id, currentWorkspace);
    const from = history.find((entry) => entry.version === Math.trunc(fromVersion));
    const to = history.find((entry) => entry.version === Math.trunc(toVersion));
    if (!from || !to) {
      return c.json({ error: "Version not found" }, 404);
    }
    const diff = compareScriptWorkspaceVersions(from.workspace, to.workspace);
    return c.json({
      ...diff,
      fromVersion: from.version,
      toVersion: to.version,
    } satisfies ScriptWorkspaceDiffResult);
  });

  app.post("/api/v1/books/:id/script-workspace/rollback", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<{ targetVersion?: number }>().catch(() => ({ targetVersion: undefined }));
    const targetVersion = Number(body.targetVersion);
    if (!Number.isFinite(targetVersion) || targetVersion < 1) {
      return c.json({ error: "targetVersion is required" }, 400);
    }
    const currentWorkspace = await readScriptWorkspace(bookDir, id, state);
    const history = await readScriptWorkspaceHistoryEntries(bookDir, id, currentWorkspace);
    const target = history.find((entry) => entry.version === Math.trunc(targetVersion));
    if (!target) {
      return c.json({ error: "Version not found" }, 404);
    }
    const saved = await writeScriptWorkspace(bookDir, target.workspace, "rollback");
    return c.json({ ok: true, workspace: saved.workspace });
  });

  app.get("/api/v1/books/:id/production-workspace", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const workspace = await readProductionWorkspace(bookDir, id, state);
    return c.json({ workspace } satisfies ProductionWorkspaceResponse);
  });

  app.put("/api/v1/books/:id/production-workspace", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<ProductionWorkspaceSavePayload>().catch(() => ({ workspace: null as never }));
    const workspace = normalizeProductionWorkspace({
      ...(body.workspace ?? {}),
      bookId: id,
      updatedAt: new Date().toISOString(),
    });
    const saved = await writeProductionWorkspace(bookDir, workspace);
    return c.json({ workspace: saved } satisfies ProductionWorkspaceResponse);
  });

  app.post("/api/v1/books/:id/production-workspace/generate", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<ProductionWorkspaceGeneratePayload>().catch(() => ({ scriptWorkspace: undefined }));
    const scriptWorkspace = body.scriptWorkspace
      ? normalizeScriptWorkspace({
        ...body.scriptWorkspace,
        bookId: id,
      })
      : await readScriptWorkspace(bookDir, id, state);
    const workspace = buildProductionWorkspaceFromScriptWorkspace(scriptWorkspace);
    const saved = await writeProductionWorkspace(bookDir, workspace);
    return c.json({ workspace: saved } satisfies ProductionWorkspaceResponse);
  });

  app.get("/api/v1/books/:id/director-plan", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const plan = await readDirectorPlan(bookDir, id, state);
    return c.json({ plan } satisfies DirectorPlanResponse);
  });

  app.get("/api/v1/books/:id/director-plan/history", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const currentPlan = await readDirectorPlan(bookDir, id, state);
    const history = await readDirectorPlanHistoryEntries(bookDir, id, currentPlan);
    return c.json({
      history: history.map((entry) => summarizeDirectorPlanHistoryEntry(entry)),
    } satisfies DirectorPlanHistoryResponse);
  });

  app.put("/api/v1/books/:id/director-plan", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<DirectorPlanSavePayload>().catch(() => ({ plan: null as never }));
    const plan = normalizeDirectorPlan({
      ...(body.plan ?? {}),
      bookId: id,
      updatedAt: new Date().toISOString(),
    });
    const saved = await writeDirectorPlanWithHistory(bookDir, plan, "save");
    return c.json({ plan: saved.plan } satisfies DirectorPlanResponse);
  });

  app.post("/api/v1/books/:id/director-plan/generate", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<DirectorPlanGeneratePayload>().catch(() => ({ productionWorkspace: undefined }));
    const productionWorkspace = body.productionWorkspace
      ? normalizeProductionWorkspace({
        ...body.productionWorkspace,
        bookId: id,
      })
      : await readProductionWorkspace(bookDir, id, state);
    const plan = buildDirectorPlanFromProductionWorkspace(productionWorkspace);
    const saved = await writeDirectorPlanWithHistory(bookDir, plan, "generate");
    return c.json({ plan: saved.plan } satisfies DirectorPlanResponse);
  });

  app.get("/api/v1/books/:id/director-plan/diff", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const fromVersion = Number(c.req.query("fromVersion"));
    const toVersion = Number(c.req.query("toVersion"));
    if (!Number.isFinite(fromVersion) || !Number.isFinite(toVersion) || fromVersion < 1 || toVersion < 1) {
      return c.json({ error: "fromVersion and toVersion are required" }, 400);
    }
    const currentPlan = await readDirectorPlan(bookDir, id, state);
    const history = await readDirectorPlanHistoryEntries(bookDir, id, currentPlan);
    const from = history.find((entry) => entry.version === Math.trunc(fromVersion));
    const to = history.find((entry) => entry.version === Math.trunc(toVersion));
    if (!from || !to) {
      return c.json({ error: "Version not found" }, 404);
    }
    const diff = compareDirectorPlanVersions(from.plan, to.plan);
    return c.json({
      ...diff,
      fromVersion: from.version,
      toVersion: to.version,
    } satisfies DirectorPlanDiffResult);
  });

  app.post("/api/v1/books/:id/director-plan/rollback", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<{ targetVersion?: number }>().catch(() => ({ targetVersion: undefined }));
    const targetVersion = Number(body.targetVersion);
    if (!Number.isFinite(targetVersion) || targetVersion < 1) {
      return c.json({ error: "targetVersion is required" }, 400);
    }
    const currentPlan = await readDirectorPlan(bookDir, id, state);
    const history = await readDirectorPlanHistoryEntries(bookDir, id, currentPlan);
    const target = history.find((entry) => entry.version === Math.trunc(targetVersion));
    if (!target) {
      return c.json({ error: "Version not found" }, 404);
    }
    const saved = await writeDirectorPlanWithHistory(bookDir, target.plan, "rollback");
    return c.json({ ok: true, plan: saved.plan });
  });

  app.get("/api/v1/books/:id/asset-library", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const library = await readAssetLibrary(bookDir, id, state);
    return c.json({ library } satisfies AssetLibraryResponse);
  });

  app.get("/api/v1/books/:id/asset-library/history", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const currentLibrary = await readAssetLibrary(bookDir, id, state);
    const history = await readAssetLibraryHistoryEntries(bookDir, id, currentLibrary);
    return c.json({
      history: history.map((entry) => summarizeAssetLibraryHistoryEntry(entry)),
    } satisfies AssetLibraryHistoryResponse);
  });

  app.put("/api/v1/books/:id/asset-library", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<AssetLibrarySavePayload>().catch(() => ({ library: null as never }));
    const library = normalizeAssetLibrary({
      ...(body.library ?? {}),
      bookId: id,
      updatedAt: new Date().toISOString(),
    });
    const saved = await writeAssetLibrary(bookDir, library);
    return c.json({ library: saved } satisfies AssetLibraryResponse);
  });

  app.get("/api/v1/books/:id/asset-library/diff", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const fromVersion = Number(c.req.query("fromVersion"));
    const toVersion = Number(c.req.query("toVersion"));
    if (!Number.isFinite(fromVersion) || !Number.isFinite(toVersion) || fromVersion < 1 || toVersion < 1) {
      return c.json({ error: "fromVersion and toVersion are required" }, 400);
    }
    const currentLibrary = await readAssetLibrary(bookDir, id, state);
    const history = await readAssetLibraryHistoryEntries(bookDir, id, currentLibrary);
    const from = history.find((entry) => entry.version === Math.trunc(fromVersion));
    const to = history.find((entry) => entry.version === Math.trunc(toVersion));
    if (!from || !to) {
      return c.json({ error: "Version not found" }, 404);
    }
    const diff = compareAssetLibraryVersions(from.library, to.library);
    return c.json({
      ...diff,
      fromVersion: from.version,
      toVersion: to.version,
    } satisfies AssetLibraryDiffResult);
  });

  app.post("/api/v1/books/:id/asset-library/generate", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<AssetLibraryGeneratePayload>().catch(() => ({ productionWorkspace: undefined }));
    const productionWorkspace = body.productionWorkspace
      ? normalizeProductionWorkspace({
        ...body.productionWorkspace,
        bookId: id,
      })
      : await readProductionWorkspace(bookDir, id, state);
    const library = buildAssetLibraryFromProductionWorkspace(productionWorkspace);
    const saved = await writeAssetLibraryWithHistory(bookDir, library, "generate");
    return c.json({ library: saved.library } satisfies AssetLibraryResponse);
  });

  app.post("/api/v1/books/:id/asset-library/rollback", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<{ targetVersion?: number }>().catch(() => ({ targetVersion: undefined }));
    const targetVersion = Number(body.targetVersion);
    if (!Number.isFinite(targetVersion) || targetVersion < 1) {
      return c.json({ error: "targetVersion is required" }, 400);
    }
    const currentLibrary = await readAssetLibrary(bookDir, id, state);
    const history = await readAssetLibraryHistoryEntries(bookDir, id, currentLibrary);
    const target = history.find((entry) => entry.version === Math.trunc(targetVersion));
    if (!target) {
      return c.json({ error: "Version not found" }, 404);
    }
    const saved = await writeAssetLibraryWithHistory(bookDir, target.library, "rollback");
    return c.json({ ok: true, library: saved.library });
  });

  app.post("/api/v1/books/:id/asset-library/upload", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<AssetLibraryUploadPayload>().catch(() => ({
      itemId: "",
      kind: "file" as const,
      fileName: "",
      dataUrl: "",
    }));
    const uploaded = await persistAssetLibraryUpload(bookDir, id, body, state);
    const currentLibrary = await readAssetLibrary(bookDir, id, state);
    const nextLibrary = normalizeAssetLibrary({
      ...currentLibrary,
      items: currentLibrary.items.map((item) => item.id === body.itemId
        ? {
          ...item,
          ...(body.kind === "thumbnail" ? { thumbnailPath: uploaded.path } : { filePath: uploaded.path }),
        }
        : item),
    });
    const saved = await writeAssetLibraryWithHistory(bookDir, nextLibrary, "upload");
    return c.json({
      ...uploaded,
      library: saved.library,
    } satisfies AssetLibraryUploadResponse);
  });

  app.get("/api/v1/books/:id/asset-library/file", async (c) => {
    const id = c.req.param("id");
    const relativePath = String(c.req.query("path") ?? "").trim();
    if (!relativePath) return c.notFound();
    const bookDir = state.bookDir(id);
    const resolvedPath = resolve(bookDir, relativePath);
    const bookRoot = resolve(bookDir);
    if (!resolvedPath.startsWith(bookRoot)) {
      return c.json({ error: "Invalid file path" }, 400);
    }
    try {
      const content = await readFile(resolvedPath);
      const ext = resolvedPath.split(".").pop()?.toLowerCase() ?? "";
      const contentTypes: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        mp4: "video/mp4",
        mov: "video/quicktime",
        txt: "text/plain; charset=utf-8",
        json: "application/json",
      };
      return new Response(content, {
        headers: { "Content-Type": contentTypes[ext] ?? "application/octet-stream" },
      });
    } catch {
      return c.notFound();
    }
  });

  app.put("/api/v1/books/:id/task-checklist", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const body = await c.req.json<{
      templateId?: string;
      items?: Array<{
        id?: string;
        text?: string;
        done?: boolean;
        note?: string | null;
      }>;
    }>().catch(() => ({ templateId: undefined, items: [] as Array<{
      id?: string;
      text?: string;
      done?: boolean;
      note?: string | null;
    }> }));
    const items = (body.items ?? []).map((item, index) => normalizeTaskChecklistItem({
      ...item,
      order: index,
    }));
    const checklist = {
      bookId: id,
      templateId: resolveScriptWorkspaceChecklistTemplateId(body.templateId),
      items: sortTaskChecklistItems(items),
      updatedAt: new Date().toISOString(),
    };
    await writeTaskChecklist(bookDir, checklist);
    return c.json({
      checklist,
      templates: listScriptWorkspaceChecklistTemplates(),
    });
  });

  app.put("/api/v1/books/:id/chapter-plans/:num", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const body = await c.req.json();
    const bookDir = state.bookDir(id);
    if (await chapterHasContent(bookDir, num)) {
      return c.json({ error: "该章已有正文，不允许手工修改分章设计。" }, 400);
    }
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    try {
      const raw = await readFile(plansPath, "utf-8").catch(() => "");
      const data = raw.trim() ? JSON.parse(raw) : {};
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const idx = plans.findIndex((p: any) => p.chapterNumber === num);
      const now = new Date().toISOString();
      const currentVersion = idx >= 0 ? normalizeChapterPlanVersion(plans[idx]?.version) : 0;
      const nextVersion = currentVersion + 1;
      const saveSource = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "manual";
      const updated = {
        ...body,
        chapterNumber: num,
        version: nextVersion,
        status: "planned",
        source: saveSource,
        updatedAt: now,
        ...(typeof body.needsReview === "boolean" ? {} : { needsReview: true }),
      };
      const nextPlan = idx >= 0
        ? { ...plans[idx], ...updated }
        : { ...updated, createdAt: now };
      if (idx >= 0) {
        plans[idx] = nextPlan;
      } else {
        plans.push(nextPlan);
      }
      await persistChapterPlansWithHistory({
        bookDir,
        plansPath,
        plans,
        historyEntries: [{
          chapterNumber: num,
          version: nextVersion,
          action: saveSource === "ai" ? "ai" : "manual",
          savedAt: now,
          plan: cloneChapterPlanSnapshot(nextPlan),
        }],
      });

      // Sync chapter title if chapterName changed and a chapter body exists
      const newTitle = typeof body.chapterName === "string" ? body.chapterName.trim() : "";
      if (newTitle) {
        try {
          const chaptersDir = join(bookDir, "chapters");
          const paddedNum = String(num).padStart(4, "0");
          const files = await readdir(chaptersDir);
          const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
          if (match) {
            const chapterIndex = await state.loadChapterIndex(id).catch(() => [] as any[]);
            const chapterMeta = chapterIndex.find((ch: any) => ch.number === num);
            const oldTitle = chapterMeta?.title ?? "";
            if (oldTitle && oldTitle !== newTitle) {
              // Read and update chapter file heading
              const filePath = join(chaptersDir, match);
              const content = await readFile(filePath, "utf-8");

              // Replace the markdown heading (Chinese or English format)
              const newContent = content.startsWith(`# 第${num}章 ${oldTitle}`)
                ? content.replace(`# 第${num}章 ${oldTitle}`, `# 第${num}章 ${newTitle}`)
                : content.startsWith(`# Chapter ${num}: ${oldTitle}`)
                  ? content.replace(`# Chapter ${num}: ${oldTitle}`, `# Chapter ${num}: ${newTitle}`)
                  : content;

              if (newContent !== content) {
                await writeFile(filePath, newContent, "utf-8");
              }

              // Rename file if title changed (filename includes sanitized title)
              const sanitized = newTitle.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, "_").slice(0, 50);
              const newFilename = `${paddedNum}_${sanitized}.md`;
              if (match !== newFilename) {
                await rename(filePath, join(chaptersDir, newFilename)).catch(() => {});
              }

              // Update chapter index
              const nowIso = new Date().toISOString();
              const updatedIndex = chapterIndex.map((ch: any) => {
                if (ch.number !== num) return ch;
                return { ...ch, title: newTitle, updatedAt: nowIso };
              });
              await state.saveChapterIndex(id, updatedIndex).catch(() => {});
            }
          }
        } catch {
          // Chapter sync is best-effort — don't fail the plan save
        }
      }

      return c.json({ ok: true, plan: updated });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapter-plans/:num/approve", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const bookDir = state.bookDir(id);
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    try {
      const raw = await readFile(plansPath, "utf-8").catch(() => "");
      const data = raw.trim() ? JSON.parse(raw) : {};
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const idx = plans.findIndex((p: any) => p.chapterNumber === num);
      if (idx < 0) return c.json({ error: "Chapter plan not found" }, 404);
      const now = new Date().toISOString();
      const currentVersion = normalizeChapterPlanVersion(plans[idx]?.version);
      const nextPlan = {
        ...plans[idx],
        status: "approved",
        needsReview: false,
        version: currentVersion + 1,
        updatedAt: now,
      };
      plans[idx] = nextPlan;
      await persistChapterPlansWithHistory({
        bookDir,
        plansPath,
        plans,
        historyEntries: [{
          chapterNumber: num,
          version: nextPlan.version,
          action: "approve",
          savedAt: now,
          plan: cloneChapterPlanSnapshot(nextPlan),
        }],
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapter-plans/:num/lock-fields", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const { fields } = await c.req.json();
    const bookDir = state.bookDir(id);
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    try {
      const raw = await readFile(plansPath, "utf-8");
      const data = JSON.parse(raw);
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const idx = plans.findIndex((p: any) => p.chapterNumber === num);
      if (idx < 0) return c.json({ error: "Chapter plan not found" }, 404);
      plans[idx] = { ...plans[idx], lockedFields: Array.isArray(fields) ? fields : [], updatedAt: new Date().toISOString() };
      await writeFile(plansPath, JSON.stringify({ plans }, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapter-plans/:num/unlock-fields", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const bookDir = state.bookDir(id);
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    try {
      const raw = await readFile(plansPath, "utf-8");
      const data = JSON.parse(raw);
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const idx = plans.findIndex((p: any) => p.chapterNumber === num);
      if (idx < 0) return c.json({ error: "Chapter plan not found" }, 404);
      plans[idx] = { ...plans[idx], lockedFields: [], updatedAt: new Date().toISOString() };
      await writeFile(plansPath, JSON.stringify({ plans }, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapter-plans/:num/optimize", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const bookDir = state.bookDir(id);
    const body = (await c.req.json().catch(() => ({}))) as {
      instruction?: string;
      currentPlan?: Record<string, unknown>;
    };
    if (await chapterHasContent(bookDir, num)) {
      return c.json({ error: "该章已有正文，不允许 AI 修改分章设计。" }, 400);
    }
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    if (!instruction) {
      return c.json({ error: "instruction is required" }, 400);
    }
    const savedPlan = await readCurrentChapterPlan(bookDir, num);
    const requestedPlan = body.currentPlan && typeof body.currentPlan === "object"
      ? body.currentPlan
      : null;
    const currentPlan: Record<string, unknown> = {
      ...(savedPlan ?? {}),
      ...(requestedPlan ?? {}),
      chapterNumber: num,
    };
    const basePlan = {
      chapterName: typeof currentPlan["chapterName"] === "string" ? currentPlan["chapterName"] : "",
      highlight: typeof currentPlan["highlight"] === "string" ? currentPlan["highlight"] : "",
      coreConflict: typeof currentPlan["coreConflict"] === "string" ? currentPlan["coreConflict"] : "",
      plotAndConflict: typeof currentPlan["plotAndConflict"] === "string" ? currentPlan["plotAndConflict"] : "",
      emotionalTone: typeof currentPlan["emotionalTone"] === "string" ? currentPlan["emotionalTone"] : "",
      endingHook: typeof currentPlan["endingHook"] === "string" ? currentPlan["endingHook"] : "",
    };
    broadcast("agent:start", {
      bookId: id,
      chapterNumber: num,
      mode: "chapter-plan-optimize",
    });
    broadcast("thinking:start", {
      bookId: id,
      chapterNumber: num,
      mode: "chapter-plan-optimize",
    });
    try {
      const agent = await createDesignAgent({
        onTextDelta: (text) => {
          broadcast("thinking:delta", {
            bookId: id,
            chapterNumber: num,
            mode: "chapter-plan-optimize",
            text,
          });
        },
      });
      const optimized = await agent.optimizePlan({
        chapterNumber: num,
        instruction,
        currentPlan: basePlan,
      });
      const merged = {
        ...currentPlan,
        ...optimized,
        chapterNumber: num,
      };
      broadcast("thinking:end", {
        bookId: id,
        chapterNumber: num,
        mode: "chapter-plan-optimize",
      });
      broadcast("agent:complete", {
        bookId: id,
        chapterNumber: num,
        mode: "chapter-plan-optimize",
      });
      return c.json({ content: JSON.stringify(merged) });
    } catch (e) {
      broadcast("thinking:end", {
        bookId: id,
        chapterNumber: num,
        mode: "chapter-plan-optimize",
      });
      broadcast("agent:error", {
        bookId: id,
        chapterNumber: num,
        mode: "chapter-plan-optimize",
        error: String(e),
      });
      return c.json({ error: `AI优化失败: ${e}` }, 500);
    }
  });

  app.get("/api/v1/books/:id/chapter-plans/:num/history", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const bookDir = state.bookDir(id);
    const currentPlan = await readCurrentChapterPlan(bookDir, num);
    const history = await readChapterPlanHistoryEntries(bookDir, num, currentPlan);
    return c.json({ history: history.map((entry) => summarizeChapterPlanHistoryEntry(entry)) });
  });

  app.get("/api/v1/books/:id/chapter-plans/:num/diff", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const fromVersion = Number(c.req.query("fromVersion"));
    const toVersion = Number(c.req.query("toVersion"));
    const bookDir = state.bookDir(id);
    if (!Number.isFinite(fromVersion) || !Number.isFinite(toVersion) || fromVersion < 1 || toVersion < 1) {
      return c.json({ error: "fromVersion and toVersion are required" }, 400);
    }
    const currentPlan = await readCurrentChapterPlan(bookDir, num);
    const history = await readChapterPlanHistoryEntries(bookDir, num, currentPlan);
    const from = history.find((entry) => entry.version === Math.trunc(fromVersion));
    const to = history.find((entry) => entry.version === Math.trunc(toVersion));
    if (!from || !to) {
      return c.json({ error: "Version not found" }, 404);
    }
    const fromPlan = from.plan as Record<string, unknown>;
    const toPlan = to.plan as Record<string, unknown>;
    const fields = new Set([...Object.keys(fromPlan), ...Object.keys(toPlan)]);
    const changedFields = [...fields].filter((field) => JSON.stringify(fromPlan[field]) !== JSON.stringify(toPlan[field]));
    return c.json({
      fromVersion: from.version,
      toVersion: to.version,
      changedFields,
      from: fromPlan,
      to: toPlan,
    });
  });

  app.post("/api/v1/books/:id/chapter-plans/:num/rollback", async (c) => {
    const id = c.req.param("id");
    const num = Number(c.req.param("num"));
    const body = await c.req.json<{ targetVersion?: number }>().catch(() => ({ targetVersion: undefined }));
    const targetVersion = Number(body.targetVersion);
    if (!Number.isFinite(targetVersion) || targetVersion < 1) {
      return c.json({ error: "targetVersion is required" }, 400);
    }
    const bookDir = state.bookDir(id);
    const plansPath = join(bookDir, "story", "state", "chapter-plans.json");
    const currentPlan = await readCurrentChapterPlan(bookDir, num);
    const history = await readChapterPlanHistoryEntries(bookDir, num, currentPlan);
    const target = history.find((entry) => entry.version === Math.trunc(targetVersion));
    if (!target) {
      return c.json({ error: "Version not found" }, 404);
    }
    try {
      const raw = await readFile(plansPath, "utf-8");
      const data = JSON.parse(raw);
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const idx = plans.findIndex((p: any) => Number(p.chapterNumber) === num);
      if (idx < 0) return c.json({ error: "Chapter plan not found" }, 404);
      const restored = {
        ...cloneChapterPlanSnapshot(target.plan),
        chapterNumber: num,
        version: target.version,
        updatedAt: new Date().toISOString(),
      };
      plans[idx] = restored;
      await writeFile(plansPath, JSON.stringify({ ...data, plans, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
      return c.json({ ok: true, plan: restored });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Radar Scan ---

  app.post("/api/v1/radar/scan", async (c) => {
    broadcast("radar:start", {});
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.runRadar();
      broadcast("radar:complete", { result });
      return c.json(result);
    } catch (e) {
      broadcast("radar:error", { error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Doctor (environment health check) ---

  app.get("/api/v1/doctor", async (c) => {
    const { existsSync } = await import("node:fs");
    const { GLOBAL_ENV_PATH } = await import("@actalk/inkos-core");

    const checks = {
      inkosJson: existsSync(join(root, "inkos.json")),
      projectEnv: existsSync(join(root, ".env")),
      globalEnv: existsSync(GLOBAL_ENV_PATH),
      booksDir: existsSync(join(root, "books")),
      llmConnected: false,
      bookCount: 0,
    };

    try {
      const books = await state.listBooks();
      checks.bookCount = books.length;
    } catch { /* ignore */ }

    try {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const service = currentConfig.llm.service ?? currentConfig.llm.provider;
      const probe = await probeServiceCapabilities({
        root,
        service,
        apiKey: currentConfig.llm.apiKey,
        baseUrl: currentConfig.llm.baseUrl,
        preferredApiFormat: currentConfig.llm.apiFormat,
        preferredStream: currentConfig.llm.stream,
        preferredModel: currentConfig.llm.model,
      });
      checks.llmConnected = probe.ok;
    } catch { /* ignore */ }

    return c.json(checks);
  });

  return app;
}

// --- Standalone runner ---

export async function startStudioServer(
  root: string,
  port = 4567,
  options?: { readonly staticDir?: string },
): Promise<void> {
  const config = await loadProjectConfig(root, { requireApiKey: false });

  const app = createStudioServer(config, root);

  // Serve frontend static files — single process for API + frontend
  if (options?.staticDir) {
    const { readFile: readFileFs } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const { existsSync } = await import("node:fs");

    // Serve static assets (js, css, etc.)
    app.get("/assets/*", async (c) => {
      const filePath = joinPath(options.staticDir!, c.req.path);
      try {
        const content = await readFileFs(filePath);
        const ext = filePath.split(".").pop() ?? "";
        const contentTypes: Record<string, string> = {
          js: "application/javascript",
          css: "text/css",
          svg: "image/svg+xml",
          png: "image/png",
          ico: "image/x-icon",
          json: "application/json",
        };
        return new Response(content, {
          headers: { "Content-Type": contentTypes[ext] ?? "application/octet-stream" },
        });
      } catch {
        return c.notFound();
      }
    });

    // SPA fallback — serve index.html for all non-API routes
    const indexPath = joinPath(options.staticDir!, "index.html");
    if (existsSync(indexPath)) {
      const indexHtml = await readFileFs(indexPath, "utf-8");
      app.get("*", (c) => {
        if (c.req.path.startsWith("/api/v1/")) return c.notFound();
        return c.html(indexHtml);
      });
    }
  }

  const requestTimeoutMsRaw = Number.parseInt(process.env.INKOS_STUDIO_REQUEST_TIMEOUT_MS ?? "0", 10);
  const requestTimeoutMs = Number.isFinite(requestTimeoutMsRaw) && requestTimeoutMsRaw >= 0
    ? requestTimeoutMsRaw
    : 0;
  console.log(
    `InkOS Studio running on http://localhost:${port}`
    + ` (requestTimeout=${requestTimeoutMs === 0 ? "disabled" : `${requestTimeoutMs}ms`})`,
  );
  serve({
    fetch: app.fetch,
    port,
    serverOptions: {
      requestTimeout: requestTimeoutMs,
    },
  });
}





