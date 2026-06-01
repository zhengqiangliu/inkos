import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InteractionEvent,
  Logger,
  PipelineRunner,
  StateManager,
  ReviseMode,
  LLMClient,
  BookConfig,
  Platform,
  ToolDefinition,
} from "../index.js";
import { chatCompletion, chatWithTools } from "../index.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { executeEditTransaction } from "./edit-controller.js";
import type { InteractionRuntimeTools } from "./runtime.js";
import type { BookCreationDraft, BookCreationWizardStep } from "./session.js";
import type { ParsedGenreProfile } from "../models/genre-profile.js";
import { writeExportArtifact } from "./export-artifact.js";

type PipelineLike = Pick<PipelineRunner, "writeNextChapter" | "reviseDraft"> & {
    readonly initBook?: (
      book: BookConfig,
      options?: {
        readonly externalContext?: string;
        readonly authorIntent?: string;
        readonly currentFocus?: string;
        readonly foundationBrief?: string;
      },
    ) => Promise<void>;
};
type StateLike = Pick<StateManager, "ensureControlDocuments" | "bookDir" | "loadBookConfig" | "loadChapterIndex" | "saveChapterIndex" | "listBooks">;
type InstrumentablePipelineLike = PipelineLike & {
  readonly config?: {
    logger?: Logger;
    client?: LLMClient;
    model?: string;
    projectRoot?: string;
  };
};

interface WizardGenreContext {
  readonly profile: ParsedGenreProfile["profile"];
  readonly body: string;
}

function normalizePlatform(platform?: string): Platform {
  switch (platform) {
    case "tomato":
    case "feilu":
    case "qidian":
      return platform;
    default:
      return "other";
  }
}

function deriveBookId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30);
}

function buildBookConfig(input: {
  readonly title: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
  readonly chapterWordCount?: number;
  readonly targetChapters?: number;
}): BookConfig {
  const now = new Date().toISOString();
  return {
    id: deriveBookId(input.title),
    title: input.title,
    platform: normalizePlatform(input.platform),
    genre: input.genre ?? "other",
    status: "outlining",
    targetChapters: input.targetChapters ?? 200,
    chapterWordCount: input.chapterWordCount ?? 3000,
    ...(input.language ? { language: input.language } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function buildCreationExternalContext(input: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
  readonly novelOutline?: string;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly characterMatrix?: string;
  readonly characterArc?: string;
  readonly relationshipMap?: string;
  readonly conflictCore?: string;
  readonly volumeOutline?: string;
  readonly constraints?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
}): string | undefined {
  const sections = [
    input.storyBackground ? `## 故事背景\n${input.storyBackground}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.protagonist ? `## 主角设定\n${input.protagonist}` : undefined,
    input.supportingCast ? `## 关键角色与势力\n${input.supportingCast}` : undefined,
    input.characterMatrix ? `## 角色矩阵\n${input.characterMatrix}` : undefined,
    input.characterArc ? `## 人物弧光\n${input.characterArc}` : undefined,
    input.relationshipMap ? `## 人物关系\n${input.relationshipMap}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.volumeOutline ? `## 卷纲方向\n${input.volumeOutline}` : undefined,
    input.blurb ? `## 简介卖点\n${input.blurb}` : undefined,
    input.constraints ? `## 创作约束\n${input.constraints}` : undefined,
    input.authorIntent ? `## 作者意图\n${input.authorIntent}` : undefined,
    input.currentFocus ? `## 当前聚焦\n${input.currentFocus}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function parseIntroMarkdownDraft(input: string): { readonly blurb: string; readonly storyBackground: string } {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { blurb: "", storyBackground: "" };

  let blurb = "";
  let storyBackground = "";
  let current: "blurb" | "storyBackground" = "blurb";

  const write = (text: string) => {
    if (!text) return;
    if (current === "blurb") {
      blurb = blurb ? `${blurb} ${text}` : text;
    } else {
      storyBackground = storyBackground ? `${storyBackground} ${text}` : text;
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch?.[1]) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (/(一句话卖点|简介\/卖点|简介|卖点|one-line hook|hook)/i.test(heading)) {
        current = "blurb";
        continue;
      }
      if (/(故事背景|背景|story background)/i.test(heading)) {
        current = "storyBackground";
        continue;
      }
      continue;
    }

    const normalized = line.replace(/[：:]\s*/g, ":");
    if (/^(简介\/卖点|简介|卖点|一句话卖点|one-line hook|hook):/i.test(normalized)) {
      current = "blurb";
      write(normalized.replace(/^(简介\/卖点|简介|卖点|一句话卖点|one-line hook|hook):\s*/i, ""));
      continue;
    }
    if (/^(故事背景|背景|story background):/i.test(normalized)) {
      current = "storyBackground";
      write(normalized.replace(/^(故事背景|背景|story background):\s*/i, ""));
      continue;
    }
    write(line);
  }

  return { blurb: blurb.trim(), storyBackground: storyBackground.trim() };
}

function buildVolumeOutlineContext(input: {
  readonly novelOutline?: string;
  readonly conflictCore?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
}): string | undefined {
  const sections = [
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildCharacterArcContext(input: {
  readonly characterArc?: string;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly conflictCore?: string;
  readonly novelOutline?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
}): string | undefined {
  const sections = [
    input.characterArc ? `## 人物弧光草案\n${input.characterArc}` : undefined,
    input.protagonist ? `## 主角设定\n${input.protagonist}` : undefined,
    input.supportingCast ? `## 关键配角 / 势力\n${input.supportingCast}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

type WizardMode = "generate" | "modify";
type IntroRevisionMode = "generate" | "revise" | "polish";

const WIZARD_STEP_FIELDS: Record<BookCreationWizardStep, ReadonlyArray<string>> = {
  intro: ["blurb", "storyBackground"],
  world: ["worldPremise", "settingNotes"],
  outline: ["novelOutline", "conflictCore"],
  volume: ["volumeOutline"],
  characters: ["protagonist", "supportingCast", "characterMatrix"],
  arc: ["characterArc"],
  relation: ["relationshipMap"],
  review: ["title", "genre", "platform", "language", "targetChapters", "chapterWordCount"],
};

const WIZARD_STEP_PROMPTS: Record<BookCreationWizardStep, {
  readonly title: string;
  readonly framework: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
}> = {
  intro: {
    title: "简介 / 故事背景",
    framework: ["一句话卖点", "故事背景", "主角处境", "引爆点", "核心悬念"],
    constraints: [
      "只补当前页，不要扩写世界观、卷纲、角色矩阵、关系等其他页。",
      "一句话卖点必须能直接用于书籍简介或封面文案开头。",
      "背景和引爆点要具体，不要散文式抒情。",
    ],
  },
  world: {
    title: "世界观",
    framework: ["时间 / 空间背景", "规则体系", "势力 / 阵营", "资源 / 权力结构", "不可违背的世界规则"],
    constraints: [
      "只补世界观页，不要写故事大纲或人物弧光。",
      "世界规则必须可检查、可执行、可复用。",
      "势力和资源结构必须服务冲突，不要堆设定名词。",
    ],
  },
  outline: {
    title: "小说大纲",
    framework: ["开局", "发展", "转折", "高潮", "结局方向", "主角修行路 / 成长路", "大事件时间线（按章节）", "结构设计", "卡点设计（按章节）"],
    constraints: [
      "只补大纲页，不要写卷纲或人物关系页。",
      "大事件时间线和卡点设计必须按章节或章节段落排列。",
      "结构设计要说明前中后段的功能分配。",
    ],
  },
  volume: {
    title: "卷纲规划",
    framework: ["总卷数", "每卷目标", "每卷主冲突", "每卷收束", "卷末钩子", "卷与主线关系"],
    constraints: [
      "只补卷纲页，不要重写全书总大纲。",
      "每卷必须有明确推进目标和卷末收束点。",
      "卷纲必须和主线成长同步，不要空转。",
    ],
  },
  characters: {
    title: "主角 / 配角",
    framework: ["主角卡", "关键配角卡", "角色矩阵", "人物功能", "出场节点"],
    constraints: [
      "只补角色页，不要写完整关系网或结局。",
      "角色必须有明确剧情功能，避免空名词堆砌。",
      "主角和关键配角都要有可追踪的动机与作用。",
    ],
  },
  arc: {
    title: "人物弧光",
    framework: [
      "核心弧光",
      "起点状态：性格缺陷 / 内心恐惧 / 错误信念",
      "成长转折：触发事件 / 内心挣扎 / 觉醒时刻 / 持续考验",
      "终点状态：性格蜕变 / 克服恐惧 / 新信念 / 残留痕迹",
    ],
    constraints: [
      "只补人物弧光页，不要扩写角色矩阵或世界观。",
      "必须按“核心弧光 -> 起点状态 -> 成长转折 -> 终点状态”的顺序输出。",
      "起点状态必须明确写出性格缺陷、内心恐惧、错误信念。",
      "成长转折必须明确写出触发事件、内心挣扎、觉醒时刻、持续考验。",
      "终点状态必须明确写出性格蜕变、克服恐惧、新信念、残留痕迹。",
      "每一项都要具体、可落地、可写进章节，不要空泛总结。",
    ],
  },
  relation: {
    title: "人物关系",
    framework: ["关系矩阵", "核心关系线", "关系驱动力", "关系冲突 / 转折", "关系变化方向"],
    constraints: [
      "只补人物关系页，不要写大纲或卷纲。",
      "关系必须能推动剧情，不只是身份表。",
      "关系变化方向要明确，便于后续章节拆解。",
    ],
  },
  review: {
    title: "最终确认",
    framework: ["完整性检查", "一致性检查", "缺口修补", "可创建确认"],
    constraints: [
      "只做最终核对，不要再扩写新内容。",
      "如果还有缺口，明确指出缺口并给出最小修补建议。",
      "确认通过后才能创建书籍。",
    ],
  },
};

const INTRO_GENERATION_PROMPT = {
  title: "简介 / 故事背景",
  framework: ["一句话卖点", "故事背景", "主角处境", "引爆点", "核心悬念"],
  constraints: [
    "只生成当前页，不要扩写世界观、卷纲、角色矩阵、关系等其他页。",
    "一句话卖点必须能直接用于书籍简介或封面文案开头。",
    "故事背景要具体，不能只写抽象设定。",
    "不要输出生成说明、分析过程、结尾总结或建议下一步。",
  ],
} as const;

const INTRO_REVISION_SYSTEM_PROMPT = [
  "你是 InkOS 的简介 / 故事背景专用修订助手。",
  "你只处理简介页，不要把内容扩写到世界观、角色矩阵、卷纲或章节大纲。",
  "如果用户要求按题材生成，要优先遵守题材约束。",
  "如果用户要求修改或润色，要在保留原意的基础上优化表达和钩子。",
  "必须输出结构化字段，至少返回 blurb 或 storyBackground 之一。",
].join(" ");

function getWizardStepTemplate(step: BookCreationWizardStep) {
  return WIZARD_STEP_PROMPTS[step] ?? WIZARD_STEP_PROMPTS.intro;
}

export function buildWizardPrompt(
  step: BookCreationWizardStep,
  mode: WizardMode,
  userMessage: string,
  existingDraft?: BookCreationDraft,
  genreContext?: WizardGenreContext,
): string {
  const template = step === "intro" && mode === "generate"
    ? INTRO_GENERATION_PROMPT
    : getWizardStepTemplate(step);
  const allowedFields = WIZARD_STEP_FIELDS[step].join("、");
  const draftBlock = existingDraft
    ? ["## 当前草案", JSON.stringify(existingDraft, null, 2)].join("\n")
    : "## 当前草案\n（空）";
  const stepContext = step === "volume"
    ? buildVolumeOutlineContext({
        novelOutline: existingDraft?.novelOutline,
        conflictCore: existingDraft?.conflictCore,
        worldPremise: existingDraft?.worldPremise,
        settingNotes: existingDraft?.settingNotes,
      })
    : step === "arc"
      ? buildCharacterArcContext({
          characterArc: existingDraft?.characterArc,
          protagonist: existingDraft?.protagonist,
          supportingCast: existingDraft?.supportingCast,
          conflictCore: existingDraft?.conflictCore,
          novelOutline: existingDraft?.novelOutline,
          worldPremise: existingDraft?.worldPremise,
          settingNotes: existingDraft?.settingNotes,
        })
    : undefined;
  const modeLabel = step === "intro" && mode === "generate"
    ? "生成正式简介"
    : mode === "generate"
      ? "生成当前页"
      : "只修改当前页";
  const genreBlock = genreContext
    ? [
        "## 题材库约束",
        `- 题材：${genreContext.profile.name} (${genreContext.profile.id})`,
        `- 章节类型：${genreContext.profile.chapterTypes.join("、") || "无"}`,
        `- 节奏规则：${genreContext.profile.pacingRule || "无"}`,
        `- 数值体系：${genreContext.profile.numericalSystem ? "有" : "无"}`,
        `- 战力体系：${genreContext.profile.powerScaling ? "有" : "无"}`,
        `- 时代考据：${genreContext.profile.eraResearch ? "需要" : "不需要"}`,
        `- 疲劳词：${genreContext.profile.fatigueWords.slice(0, 12).join("、") || "无"}`,
        `- 读者爽点：${genreContext.profile.satisfactionTypes.join("、") || "无"}`,
        "",
        "## 题材规则正文",
        genreContext.body.trim() || "（无）",
      ].join("\n")
    : "";

  return [
    `当前步骤：${template.title}`,
    `模式：${modeLabel}`,
    "",
    ...(genreBlock ? [genreBlock, ""] : []),
    ...(stepContext ? [stepContext, ""] : []),
    "内容框架必须包含：",
    ...template.framework.map((item, index) => `${index + 1}. ${item}`),
    "",
    "约束：",
    ...template.constraints.map((item, index) => `${index + 1}. ${item}`),
    "4. blurb：用于书籍简介或卖点开头，必须抓人，不能是说明书语气。",
    "5. storyBackground：交代故事起点、冲突环境和引爆条件，必须具体。",
    `6. 只允许更新以下字段：${allowedFields}。其他字段必须保持草案原值。`,
    "7. 多轮修正时，如果用户只要求改一个字段，只改这个字段，不要顺手重写同页其他字段。",
    "",
    draftBlock,
    "",
    "## 用户输入",
    userMessage.trim(),
  ].join("\n");
}

function parseToolCallArguments(toolCall: { arguments: string } | undefined): Record<string, unknown> {
  if (!toolCall) return {};
  try {
    const parsed = JSON.parse(toolCall.arguments);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function applyWizardStepDraft(
  step: BookCreationWizardStep,
  existingDraft: BookCreationDraft | undefined,
  concept: string,
  fields: Readonly<Record<string, unknown>>,
): BookCreationDraft {
  const draft: BookCreationDraft = {
    concept,
    missingFields: [],
    readyToCreate: false,
    ...(existingDraft ?? {}),
  };
  const allowedFields = new Set(WIZARD_STEP_FIELDS[step]);

  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key) || value === undefined || value === null || value === "") {
      continue;
    }
    const text = typeof value === "string" ? value : String(value);
    switch (key) {
      case "blurb":
        draft.blurb = text;
        break;
      case "storyBackground":
        draft.storyBackground = text;
        break;
      case "worldPremise":
        draft.worldPremise = text;
        break;
      case "settingNotes":
        draft.settingNotes = text;
        break;
      case "novelOutline":
        draft.novelOutline = text;
        break;
      case "conflictCore":
        draft.conflictCore = text;
        break;
      case "volumeOutline":
        draft.volumeOutline = text;
        break;
      case "protagonist":
        draft.protagonist = text;
        break;
      case "supportingCast":
        draft.supportingCast = text;
        break;
      case "characterMatrix":
        draft.characterMatrix = text;
        break;
      case "characterArc":
        draft.characterArc = text;
        break;
      case "relationshipMap":
        draft.relationshipMap = text;
        break;
      case "title":
        draft.title = text;
        break;
      case "genre":
        draft.genre = text;
        break;
      case "platform":
        draft.platform = text;
        break;
      case "language":
        if (text === "zh" || text === "en") draft.language = text;
        break;
      case "targetChapters": {
        const n = Number(text);
        if (Number.isFinite(n) && n > 0) draft.targetChapters = Math.trunc(n);
        break;
      }
      case "chapterWordCount": {
        const n = Number(text);
        if (Number.isFinite(n) && n > 0) draft.chapterWordCount = Math.trunc(n);
        break;
      }
    }
  }

  return draft;
}

async function runWizardDraftTool(params: {
  readonly pipeline: InstrumentablePipelineLike;
  readonly step: BookCreationWizardStep;
  readonly mode: WizardMode;
  readonly input: string;
  readonly existingDraft?: BookCreationDraft;
}): Promise<{
  readonly draft: BookCreationDraft;
  readonly responseText: string;
  readonly fieldsUpdated: ReadonlyArray<string>;
  readonly draftRaw: string;
}> {
  const { pipeline, step, mode, input, existingDraft } = params;
  const concept = input.trim() || existingDraft?.concept || getWizardStepTemplate(step).title;
  const projectRoot = pipeline.config?.projectRoot;
  const genreContext = existingDraft?.genre && projectRoot
    ? await readGenreProfile(projectRoot, existingDraft.genre).catch(() => null)
    : null;

  if (!pipeline.config?.client || !pipeline.config?.model) {
    return {
      draft: applyWizardStepDraft(step, existingDraft, concept, {}),
      responseText: "请先配置 LLM 模型，然后再继续建书向导。",
      fieldsUpdated: [],
      draftRaw: "",
    };
  }

  const result = await chatWithTools(
    pipeline.config.client,
    pipeline.config.model,
    [
      {
        role: "system",
        content: [
          "你是 InkOS 的建书向导助手。",
          "你只能处理当前步骤，并且只能更新当前页允许的字段。",
          "不要改写其他页面内容。",
          "如果信息不足，可以给出合理默认值，但必须保持当前页框架完整。",
          "题材库约束优先于通用表达，必须遵守题材规则和禁忌。",
        ].join(" "),
      },
      {
        role: "user",
        content: buildWizardPrompt(step, mode, input, existingDraft, genreContext ?? undefined),
      },
    ],
    [SAVE_BOOK_WIZARD_STEP_TOOL],
    { temperature: 0.35 },
  );

  const toolArgs = parseToolCallArguments(result.toolCalls[0]);
  const parsedIntro = step === "intro" ? parseIntroMarkdownDraft(input) : null;
  const normalizedArgs = step === "intro" ? {
    blurb: typeof toolArgs.blurb === "string" ? toolArgs.blurb : parsedIntro?.blurb ?? "",
    storyBackground: typeof toolArgs.storyBackground === "string" ? toolArgs.storyBackground : parsedIntro?.storyBackground ?? "",
  } : toolArgs;
  const draft = applyWizardStepDraft(step, existingDraft, concept, normalizedArgs);
  return {
    draft,
    responseText: result.content?.trim() || "已更新当前页内容。",
    fieldsUpdated: Object.keys(normalizedArgs).filter((key) => WIZARD_STEP_FIELDS[step].includes(key)),
    draftRaw: result.content?.trim() || "",
  };
}

async function runIntroRevisionTool(params: {
  readonly pipeline: InstrumentablePipelineLike;
  readonly input: string;
  readonly existingDraft?: BookCreationDraft;
  readonly revisionKind?: IntroRevisionMode;
  readonly themeGenre?: string;
}): Promise<{
  readonly draft: BookCreationDraft;
  readonly responseText: string;
  readonly fieldsUpdated: ReadonlyArray<string>;
  readonly draftRaw: string;
}> {
  const { pipeline, input, existingDraft, revisionKind = "revise", themeGenre } = params;
  const concept = existingDraft?.concept ?? input;
  const projectRoot = pipeline.config?.projectRoot;
  const genreContext = themeGenre && projectRoot
    ? await readGenreProfile(projectRoot, themeGenre).catch(() => null)
    : existingDraft?.genre && projectRoot
      ? await readGenreProfile(projectRoot, existingDraft.genre).catch(() => null)
      : null;

  if (!pipeline.config?.client || !pipeline.config?.model) {
    return {
      draft: applyFieldsToDraft(existingDraft, {}, concept),
      responseText: "请先配置 LLM 模型，然后再修改简介。",
      fieldsUpdated: [],
      draftRaw: "",
    };
  }

  const result = await chatWithTools(
    pipeline.config.client,
    pipeline.config.model,
    [
      { role: "system", content: INTRO_REVISION_SYSTEM_PROMPT },
      { role: "user", content: buildIntroRevisionPrompt({
        mode: revisionKind,
        userMessage: input,
        existingDraft,
        genreContext,
      }) },
    ],
    [SAVE_BOOK_WIZARD_STEP_TOOL],
    { temperature: revisionKind === "polish" ? 0.25 : 0.35 },
  );

  const toolArgs = parseToolCallArguments(result.toolCalls[0]);
  const normalizedArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(toolArgs)) {
    if (value === undefined || value === null) continue;
    normalizedArgs[key] = typeof value === "string" ? value : String(value);
  }

  const draft = applyFieldsToDraft(existingDraft, normalizedArgs, concept);
  if (themeGenre?.trim()) {
    draft.genre = themeGenre.trim();
    draft.mappedGenreId = draft.mappedGenreId ?? themeGenre.trim();
    draft.genreAlias = draft.genreAlias ?? themeGenre.trim();
    draft.genreSource = draft.genreSource ?? "builtin";
  }

  return {
    draft: {
      ...draft,
      readyToCreate: Boolean(draft.title && draft.genre && draft.platform),
    },
    responseText: result.content?.trim() || (revisionKind === "polish" ? "已润色简介与故事背景。" : "已修改简介与故事背景。"),
    fieldsUpdated: Object.keys(normalizedArgs).filter((key) => ["blurb", "storyBackground", "genre", "genreAlias", "genreSource", "mappedGenreId"].includes(key)),
    draftRaw: result.content?.trim() || "",
  };
}

export function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

async function exportBookToPath(state: StateLike, bookId: string, options: {
  readonly format?: "txt" | "md" | "epub";
  readonly approvedOnly?: boolean;
  readonly outputPath?: string;
}) {
  return writeExportArtifact(state, bookId, options);
}

function mapStageMessageToStatus(message: string): InteractionEvent["status"] | undefined {
  const lower = message.trim().toLowerCase();
  if (
    lower.includes("planning next chapter")
    || lower.includes("generating foundation")
    || lower.includes("reviewing foundation")
    || lower.includes("preparing chapter inputs")
    || message.includes("规划下一章意图")
    || message.includes("生成基础设定")
    || message.includes("审核基础设定")
    || message.includes("准备章节输入")
  ) {
    return "planning";
  }
  if (
    lower.includes("composing chapter runtime context")
    || message.includes("组装章节运行时上下文")
  ) {
    return "composing";
  }
  if (
    lower.includes("writing chapter draft")
    || message.includes("撰写章节草稿")
  ) {
    return "writing";
  }
  if (
    lower.includes("auditing draft")
    || message.includes("审计草稿")
  ) {
    return "assessing";
  }
  if (
    lower.includes("fixing")
    || lower.includes("revising chapter")
    || lower.includes("rewrite")
    || lower.includes("repair")
    || message.includes("自动修复")
    || message.includes("整章改写")
    || message.includes("修订第")
  ) {
    return "repairing";
  }
  if (
    lower.includes("persist")
    || lower.includes("saving")
    || lower.includes("snapshot")
    || lower.includes("rebuilding final truth files")
    || lower.includes("validating truth file updates")
    || lower.includes("syncing memory indexes")
    || message.includes("落盘")
    || message.includes("保存")
    || message.includes("快照")
    || message.includes("校验真相文件变更")
    || message.includes("生成最终真相文件")
    || message.includes("同步记忆索引")
  ) {
    return "persisting";
  }
  return undefined;
}

function extractStageDetail(message: string): string | undefined {
  if (message.startsWith("Stage: ")) {
    return message.slice("Stage: ".length).trim();
  }
  if (message.startsWith("阶段：")) {
    return message.slice("阶段：".length).trim();
  }
  return undefined;
}

function createInteractionLogger(
  original: Logger | undefined,
  events: InteractionEvent[],
  bookId: string,
): Logger {
  const emit = (level: "debug" | "info" | "warn" | "error", message: string): void => {
    const stageDetail = extractStageDetail(message);
    const stageStatus = stageDetail ? mapStageMessageToStatus(stageDetail) : undefined;

    if (stageDetail && stageStatus) {
      events.push({
        kind: "stage.changed",
        timestamp: Date.now(),
        status: stageStatus,
        bookId,
        detail: stageDetail,
      });
      return;
    }

    if (level === "warn") {
      events.push({
        kind: "task.warning",
        timestamp: Date.now(),
        status: "blocked",
        bookId,
        detail: message,
      });
      return;
    }

    if (level === "error") {
      events.push({
        kind: "task.failed",
        timestamp: Date.now(),
        status: "failed",
        bookId,
        detail: message,
      });
    }
  };

  const wrap = (base: Logger | undefined): Logger => ({
    debug: (msg, ctx) => {
      emit("debug", msg);
      base?.debug(msg, ctx);
    },
    info: (msg, ctx) => {
      emit("info", msg);
      base?.info(msg, ctx);
    },
    warn: (msg, ctx) => {
      emit("warn", msg);
      base?.warn(msg, ctx);
    },
    error: (msg, ctx) => {
      emit("error", msg);
      base?.error(msg, ctx);
    },
    child: (tag, extraCtx) => wrap(base?.child(tag, extraCtx)),
  });

  return wrap(original);
}

async function withPipelineInteractionTelemetry<T extends { chapterNumber?: number }>(
  pipeline: InstrumentablePipelineLike,
  bookId: string,
  executor: () => Promise<T>,
): Promise<T & {
  __interaction: {
    events: ReadonlyArray<InteractionEvent>;
    activeChapterNumber?: number;
  };
}> {
  const events: InteractionEvent[] = [];
  const originalLogger = pipeline.config?.logger;
  if (pipeline.config) {
    pipeline.config.logger = createInteractionLogger(originalLogger, events, bookId);
  }

  try {
    const result = await executor();
    return {
      ...result,
      __interaction: {
        events,
        ...(typeof result.chapterNumber === "number"
          ? { activeChapterNumber: result.chapterNumber }
          : {}),
      },
    };
  } finally {
    if (pipeline.config) {
      pipeline.config.logger = originalLogger;
    }
  }
}

const CREATE_BOOK_TOOL: ToolDefinition = {
  name: "create_book",
  description: "根据用户描述生成建书参数。系统会将参数渲染为可编辑表单，用户确认后建书。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "书名" },
      genre: { type: "string", description: "题材标识，如 xuanhuan, urban, romance, scifi, mystery" },
      platform: { type: "string", enum: ["tomato", "qidian", "feilu", "other"], description: "发布平台" },
      targetChapters: { type: "number", description: "目标章数，默认 200" },
      chapterWordCount: { type: "number", description: "每章字数，默认 3000" },
      language: { type: "string", enum: ["zh", "en"], description: "写作语言，默认 zh" },
      brief: { type: "string", description: "创意简述，会传给 Architect 智能体生成完整的世界观、主角、冲突等 foundation 文件。把用户提到的所有创意要素都写进这里。" },
      storyBackground: { type: "string", description: "简介 / 故事背景" },
      worldPremise: { type: "string", description: "世界观" },
      novelOutline: { type: "string", description: "小说大纲" },
      volumeOutline: { type: "string", description: "卷纲规划" },
      protagonist: { type: "string", description: "主角 / 配角" },
      supportingCast: { type: "string", description: "配角" },
      characterMatrix: { type: "string", description: "人物矩阵 / 人物弧光" },
      characterArc: { type: "string", description: "核心弧光" },
      relationshipMap: { type: "string", description: "人物关系" },
      settingNotes: { type: "string", description: "补充设定" },
      conflictCore: { type: "string", description: "核心冲突" },
      constraints: { type: "string", description: "创作约束" },
    },
    required: ["title", "genre", "platform", "brief"],
  },
};

const SAVE_BOOK_WIZARD_STEP_TOOL: ToolDefinition = {
  name: "save_book_wizard_step",
  description: "保存当前向导页草案，只更新当前页允许的字段，不创建书籍。",
  parameters: CREATE_BOOK_TOOL.parameters,
};

const BOOK_DRAFT_SYSTEM_PROMPT = [
  "你是 InkOS 的建书助手。用户会描述想写的书，你需要调用 save_book_wizard_step 工具来保存当前页草案。",
  "",
  "规则：",
  "1. 从用户描述中推断所有字段，大胆预填合理默认值。",
  "2. brief 字段要详细，但只用于当前页草案，不要越权补齐其他页面。",
  "3. storyBackground、worldPremise、novelOutline、volumeOutline、characterArc、relationshipMap 都必须按当前页允许的框架填充，不要自由散写。",
  "4. 如果用户后续要求修改某些字段，重新调用 save_book_wizard_step 工具，只更新被提到的字段，其余保持不变。",
  "5. 不要只回复文字讨论——必须调用 save_book_wizard_step 工具输出结构化参数。",
].join("\n");

/** Map directive field keys to BookCreationDraft property names. */
function applyFieldsToDraft(
  existing: BookCreationDraft | undefined,
  fields: Readonly<Record<string, string>>,
  concept: string,
): BookCreationDraft {
  const draft: BookCreationDraft = {
    concept,
    missingFields: [],
    readyToCreate: false,
    ...(existing ?? {}),
  };

  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;

    switch (key) {
      case "title":
        draft.title = value;
        break;
      case "genre":
        draft.genre = value;
        break;
      case "platform":
        draft.platform = value;
        break;
      case "language":
        if (value === "zh" || value === "en") draft.language = value;
        break;
      case "targetChapters": {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n) && n > 0) draft.targetChapters = n;
        break;
      }
      case "chapterWordCount":
      case "chapterLength": {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n) && n > 0) draft.chapterWordCount = n;
        break;
      }
      case "blurb":
        draft.blurb = value;
        break;
      case "brief":
        draft.blurb = value;
        break;
      case "storyBackground":
        draft.storyBackground = value;
        break;
      case "worldPremise":
        draft.worldPremise = value;
        break;
      case "settingNotes":
        draft.settingNotes = value;
        break;
      case "novelOutline":
        draft.novelOutline = value;
        break;
      case "protagonist":
        draft.protagonist = value;
        break;
      case "supportingCast":
        draft.supportingCast = value;
        break;
      case "characterMatrix":
        draft.characterMatrix = value;
        break;
      case "characterArc":
        draft.characterArc = value;
        break;
      case "relationshipMap":
        draft.relationshipMap = value;
        break;
      case "conflictCore":
        draft.conflictCore = value;
        break;
      case "volumeOutline":
        draft.volumeOutline = value;
        break;
      case "constraints":
        draft.constraints = value;
        break;
      case "authorIntent":
        draft.authorIntent = value;
        break;
      case "currentFocus":
        draft.currentFocus = value;
        break;
      // Unknown keys are silently ignored — the LLM may emit
      // application-level keys we don't map to the draft struct.
    }
  }

  return draft;
}

function buildLegacyDraftUserContent(input: string, existingDraft?: BookCreationDraft): string {
  if (!existingDraft) return input;
  return [
    `当前草案参数：${JSON.stringify(existingDraft, null, 2)}`,
    "",
    `用户输入：${input}`,
  ].join("\n");
}

function buildIntroRevisionPrompt(params: {
  readonly mode: IntroRevisionMode;
  readonly userMessage: string;
  readonly existingDraft?: BookCreationDraft;
  readonly genreContext?: WizardGenreContext | null;
}): string {
  const { mode, userMessage, existingDraft, genreContext } = params;
  const draftBlock = existingDraft
    ? ["## 当前草案", JSON.stringify(existingDraft, null, 2)].join("\n")
    : "## 当前草案\n（空）";
  const contentMode = mode === "polish"
    ? "润色正式简介"
    : mode === "generate"
      ? "生成正式简介"
      : "修改正式简介";
  const genreBlock = genreContext
    ? [
        "## 题材库约束",
        `- 题材：${genreContext.profile.name} (${genreContext.profile.id})`,
        `- 章节类型：${genreContext.profile.chapterTypes.join("、") || "无"}`,
        `- 节奏规则：${genreContext.profile.pacingRule || "无"}`,
        `- 数值体系：${genreContext.profile.numericalSystem ? "有" : "无"}`,
        `- 战力体系：${genreContext.profile.powerScaling ? "有" : "无"}`,
        `- 时代考据：${genreContext.profile.eraResearch ? "需要" : "不需要"}`,
        `- 疲劳词：${genreContext.profile.fatigueWords.slice(0, 12).join("、") || "无"}`,
        `- 读者爽点：${genreContext.profile.satisfactionTypes.join("、") || "无"}`,
        "",
        "## 题材规则正文",
        genreContext.body.trim() || "（无）",
      ].join("\n")
    : "";

  return [
    `模式：${contentMode}`,
    "目标页：简介 / 故事背景",
    "",
    ...(genreBlock ? [genreBlock, ""] : []),
    "内容框架必须包含：",
    "1. 一句话卖点",
    "2. 故事背景",
    "3. 主角处境",
    "4. 引爆点",
    "5. 核心悬念",
    "",
    "输出结构：",
    "1. blurb：用于书籍简介或卖点开头，必须抓人，不能是说明书语气。",
    "2. storyBackground：交代故事起点、冲突环境和引爆条件，必须具体。",
    "3. 不要输出“以上是草案”“如果你确认”等前后缀说明。",
    "4. 不要扩写到世界观、人物关系、卷纲或章节目录。",
    "5. 至少返回 blurb 或 storyBackground 之一，且内容要可直接落库。",
    "",
    draftBlock,
    "",
    "## 用户输入",
    userMessage.trim(),
    "",
    "约束：",
    "1. 只更新 blurb、storyBackground、genre、genreAlias、genreSource、mappedGenreId 这些字段。",
    "2. 至少返回 blurb 或 storyBackground 之一。",
    "3. 如果已有题材，必须保留并强化题材一致性。",
    "4. 润色模式优先保留原信息结构，修改模式允许重写表达。",
    "5. 输出正文必须是可直接落库的正式文案，不要夹带生成过程说明。",
  ].join("\n");
}

async function runLegacyDraftTool(params: {
  readonly pipeline: InstrumentablePipelineLike;
  readonly input: string;
  readonly existingDraft?: BookCreationDraft;
  readonly themeGenre?: string;
}): Promise<{
  readonly draft: BookCreationDraft;
  readonly responseText: string;
  readonly toolCall?: { name: string; arguments: Record<string, unknown> };
}> {
  const { pipeline, input, existingDraft, themeGenre } = params;
  const concept = existingDraft?.concept ?? input;

  if (!pipeline.config?.client || !pipeline.config?.model) {
    return {
      draft: applyFieldsToDraft(existingDraft, {}, concept),
      responseText: "请先配置 LLM 模型，然后再创建书籍。",
    };
  }

  const result = await chatWithTools(
    pipeline.config.client,
    pipeline.config.model,
    [
      { role: "system", content: BOOK_DRAFT_SYSTEM_PROMPT },
      { role: "user", content: [
        themeGenre ? `## 题材\n${themeGenre}` : undefined,
        buildLegacyDraftUserContent(input, existingDraft),
      ].filter((item): item is string => Boolean(item)).join("\n\n") },
    ],
    [SAVE_BOOK_WIZARD_STEP_TOOL],
    { temperature: 0.4 },
  );

  const toolCall = result.toolCalls[0];
  const parsedArgs = parseToolCallArguments(toolCall);
  const normalizedArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsedArgs)) {
    if (value === undefined || value === null) continue;
    normalizedArgs[key] = typeof value === "string" ? value : String(value);
  }

  const draft = applyFieldsToDraft(existingDraft, normalizedArgs, concept);
  if (themeGenre?.trim()) {
    draft.genre = themeGenre.trim();
    draft.mappedGenreId = draft.mappedGenreId ?? themeGenre.trim();
    draft.genreAlias = draft.genreAlias ?? themeGenre.trim();
    draft.genreSource = draft.genreSource ?? "builtin";
  }
  return {
    draft: {
      ...draft,
      readyToCreate: Boolean(draft.title && draft.genre && draft.platform),
    },
    responseText: result.content?.trim() || "已生成建书参数，请确认或修改。",
    toolCall: toolCall
      ? {
          name: toolCall.name,
          arguments: parsedArgs,
        }
      : undefined,
  };
}

function formatDraftForUserMessage(
  existingDraft: BookCreationDraft | undefined,
  userMessage: string,
): string {
  const parts: string[] = [];

  if (existingDraft) {
    parts.push("## 当前草案状态");
    const entries = Object.entries(existingDraft).filter(
      ([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
    );
    for (const [key, value] of entries) {
      parts.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    parts.push("");
  }

  parts.push("## 用户输入");
  parts.push(userMessage);

  return parts.join("\n");
}

export function createInteractionToolsFromDeps(
  pipeline: PipelineLike,
  state: StateLike,
  hooks?: {
    readonly onChatTextDelta?: (text: string) => void;
    readonly onDraftTextDelta?: (text: string) => void;
    readonly onDraftRawDelta?: (text: string) => void;
    readonly getChatRequestOptions?: () => {
      readonly temperature?: number;
      readonly maxTokens?: number;
    };
  },
): InteractionRuntimeTools {
  const instrumentedPipeline = pipeline as InstrumentablePipelineLike;

  return {
    listBooks: () => state.listBooks(),
    developBookDraft: async (input, existingDraft, wizardStep, themeGenre) => {
      const result = await runLegacyDraftTool({
        pipeline: instrumentedPipeline,
        input,
        existingDraft,
        themeGenre,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            toolCall: result.toolCall,
          },
        },
      };
    },
    reviseBookIntro: async (input, existingDraft, revisionKind = "revise", themeGenre) => {
      const result = await runIntroRevisionTool({
        pipeline: instrumentedPipeline,
        input,
        existingDraft,
        revisionKind,
        themeGenre,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            fieldsUpdated: result.fieldsUpdated,
            draftRaw: result.draftRaw,
          },
        },
      };
    },
    saveBookWizardStep: async (input, existingDraft, wizardStep = "intro") => {
      const result = await runWizardDraftTool({
        pipeline: instrumentedPipeline,
        step: wizardStep,
        mode: "modify",
        input,
        existingDraft,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            fieldsUpdated: result.fieldsUpdated,
            draftRaw: result.draftRaw,
          },
        },
      };
    },
    advanceBookWizard: async (input, existingDraft, wizardStep = "intro") => {
      const result = await runWizardDraftTool({
        pipeline: instrumentedPipeline,
        step: wizardStep,
        mode: "generate",
        input,
        existingDraft,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            fieldsUpdated: result.fieldsUpdated,
            draftRaw: result.draftRaw,
          },
        },
      };
    },
    createBook: async (input) => {
      const book = buildBookConfig(input);
      if (!pipeline.initBook) {
        throw new Error("Pipeline does not support shared book creation.");
      }
      const foundationBrief = buildCreationExternalContext(input);
      await pipeline.initBook(book, {
        externalContext: foundationBrief,
        foundationBrief,
        authorIntent: input.authorIntent,
        currentFocus: input.currentFocus,
      });
      return {
        bookId: book.id,
        title: book.title,
        __interaction: {
          responseText: `Created ${book.title} (${book.id}).`,
          details: {
            bookId: book.id,
            title: book.title,
          },
        },
      };
    },
    exportBook: async (bookId, options) => {
      const result = await exportBookToPath(state, bookId, options);
      return {
        ...result,
        __interaction: {
          responseText: `Exported ${bookId} to ${result.outputPath} (${result.chaptersExported} chapters).`,
          details: {
            outputPath: result.outputPath,
            chaptersExported: result.chaptersExported,
            totalWords: result.totalWords,
            format: result.format,
          },
        },
      };
    },
    chat: async (input, options) => {
      const bookLabel = options.bookId ?? "none";
      const chatRequestOptions = hooks?.getChatRequestOptions?.() ?? {};
      let response: Awaited<ReturnType<typeof chatCompletion>> | undefined;
      if (instrumentedPipeline.config?.client && instrumentedPipeline.config?.model) {
        try {
          response = await chatCompletion(
            instrumentedPipeline.config.client,
            instrumentedPipeline.config.model,
            [
              {
                role: "system",
                content: [
                  "You are InkOS inside the terminal workbench.",
                  "Respond conversationally and briefly.",
                  "If there is no active book, help the user decide what to write next.",
                  "If there is an active book, keep the answer grounded in that book context.",
                ].join(" "),
              },
              {
                role: "user",
                content: `activeBook=${bookLabel}\nautomationMode=${options.automationMode}\nmessage=${input}`,
              },
            ],
            {
              temperature: chatRequestOptions.temperature ?? 0.4,
              ...(chatRequestOptions.maxTokens !== undefined && { maxTokens: chatRequestOptions.maxTokens }),
              onTextDelta: hooks?.onChatTextDelta,
            },
          );
        } catch (err) {
          // Thinking models (e.g. kimi-k2.5) may return empty content for simple inputs.
          // Only swallow empty-content errors; re-throw everything else (network, auth, etc.)
          const msg = err instanceof Error ? err.message : "";
          if (!msg.includes("empty") && !msg.includes("content")) {
            throw err;
          }
        }
      }

      return {
        __interaction: {
          responseText: response?.content?.trim()
            || (options.bookId
              ? `I’m here. Active book is ${options.bookId}.`
              : "I’m here. No active book yet."),
        },
      };
    },
    writeNextChapter: (bookId) => withPipelineInteractionTelemetry(
      instrumentedPipeline,
      bookId,
      () => pipeline.writeNextChapter(bookId),
    ),
    reviseDraft: (bookId, chapterNumber, mode) => withPipelineInteractionTelemetry(
      instrumentedPipeline,
      bookId,
      () => pipeline.reviseDraft(bookId, chapterNumber, mode as ReviseMode),
    ),
    patchChapterText: async (bookId, chapterNumber, targetText, replacementText) => {
      const execution = await executeEditTransaction(
        {
          bookDir: (targetBookId) => state.bookDir(targetBookId),
          loadChapterIndex: (targetBookId) => state.loadChapterIndex(targetBookId),
          saveChapterIndex: (targetBookId, index) => state.saveChapterIndex(targetBookId, index),
        },
        {
          kind: "chapter-local-edit",
          bookId,
          chapterNumber,
          instruction: `Replace ${targetText} with ${replacementText}`,
          targetText,
          replacementText,
        },
      );
      return {
        __interaction: {
          activeChapterNumber: chapterNumber,
          responseText: execution.summary,
        },
      };
    },
    renameEntity: async (bookId, oldValue, newValue) => {
      const execution = await executeEditTransaction(
        {
          bookDir: (targetBookId) => state.bookDir(targetBookId),
          loadChapterIndex: (targetBookId) => state.loadChapterIndex(targetBookId),
          saveChapterIndex: (targetBookId, index) => state.saveChapterIndex(targetBookId, index),
        },
        {
          kind: "entity-rename",
          bookId,
          entityType: "character",
          oldValue,
          newValue,
        },
      );
      return {
        __interaction: {
          responseText: execution.summary,
        },
      };
    },
    updateCurrentFocus: async (bookId, content) => {
      await state.ensureControlDocuments(bookId);
      await writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), content, "utf-8");
    },
    updateAuthorIntent: async (bookId, content) => {
      await state.ensureControlDocuments(bookId);
      await writeFile(join(state.bookDir(bookId), "story", "author_intent.md"), content, "utf-8");
    },
    writeTruthFile: async (bookId, fileName, content) => {
      await state.ensureControlDocuments(bookId);
      await writeFile(join(state.bookDir(bookId), "story", fileName), content, "utf-8");
    },
  };
}

