import { z } from "zod";
import { AutomationModeSchema, type AutomationMode } from "./modes.js";
import { ExecutionStateSchema, InteractionEventSchema, type InteractionEvent } from "./events.js";

export const PendingDecisionSchema = z.object({
  kind: z.string().min(1),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().min(1).optional(),
  summary: z.string().min(1),
});

export type PendingDecision = z.infer<typeof PendingDecisionSchema>;

export const MessageAuditDimensionCheckSchema = z.object({
  dimension: z.string(),
  status: z.enum(["pass", "warning", "failed"]),
  evidence: z.string().optional(),
});

export const BookCreationWizardStepSchema = z.enum([
  "intro",
  "world",
  "outline",
  "volume",
  "characters",
  "arc",
  "relation",
]);

export type BookCreationWizardStep = z.infer<typeof BookCreationWizardStepSchema>;

export const MessageAuditSummarySchema = z.object({
  chapter: z.number().int().min(1),
  passed: z.boolean(),
  issueCount: z.number().int().nonnegative(),
  score: z.number().int().nonnegative(),
  severityCounts: z.object({
    critical: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }).optional(),
  failureGate: z.enum(["none", "critical", "score"]).optional(),
  summary: z.string().optional(),
  report: z.string().optional(),
  issues: z.array(z.string()).optional(),
  dimensionChecks: z.array(MessageAuditDimensionCheckSchema).optional(),
});

export type MessageAuditSummary = z.infer<typeof MessageAuditSummarySchema>;

export const PipelineStageProgressSchema = z.object({
  status: z.string().optional(),
  elapsedMs: z.number().int().nonnegative(),
  totalChars: z.number().int().nonnegative(),
  chineseChars: z.number().int().nonnegative(),
});

export const PipelineStageSchema = z.object({
  label: z.string(),
  status: z.enum(["pending", "active", "completed"]),
  activatedAt: z.number().int().nonnegative().optional(),
  progress: PipelineStageProgressSchema.optional(),
});

export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const ToolExecutionBatchSchema = z.object({
  batchId: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  currentChapter: z.number().int().min(1).optional(),
  currentWords: z.number().int().nonnegative().optional(),
  failedChapterNumber: z.number().int().min(1).optional(),
  error: z.string().optional(),
});

export type ToolExecutionBatch = z.infer<typeof ToolExecutionBatchSchema>;

export const ToolExecutionAutoReviewSchema = z.object({
  enabled: z.boolean(),
  phase: z.enum(["audit", "revise"]),
  round: z.number().int().min(1),
  maxRounds: z.number().int().nonnegative(),
  final: z.boolean(),
  state: z.enum(["retrying", "passed", "failed-max-rounds", "failed-single-audit"]).optional(),
  stopReason: z.string().optional(),
  mode: z.string().optional(),
  strategyReason: z.string().optional(),
  passed: z.boolean().optional(),
  reviseRoundsUsed: z.number().int().nonnegative().optional(),
  failureGate: z.enum(["none", "critical", "score"]).optional(),
  failedDimensions: z.array(z.string()).optional(),
  mustFixUnresolvedCount: z.number().int().nonnegative().optional(),
  mustFixTotalCount: z.number().int().nonnegative().optional(),
});

export type ToolExecutionAutoReview = z.infer<typeof ToolExecutionAutoReviewSchema>;

export const ToolExecutionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  agent: z.string().optional(),
  label: z.string(),
  status: z.enum(["running", "processing", "completed", "error"]),
  args: z.record(z.unknown()).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  stages: z.array(PipelineStageSchema).optional(),
  logs: z.array(z.string()).optional(),
  previewText: z.string().optional(),
  previewChapterNumber: z.number().int().min(1).optional(),
  previewKind: z.enum(["patch"]).optional(),
  batch: ToolExecutionBatchSchema.optional(),
  autoReview: ToolExecutionAutoReviewSchema.optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
});

export type ToolExecution = z.infer<typeof ToolExecutionSchema>;

export const InteractionMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  wizardStep: BookCreationWizardStepSchema.optional(),
  thinking: z.string().optional(),
  thinkingStreaming: z.boolean().optional(),
  toolExecutions: z.array(ToolExecutionSchema).optional(),
  audit: MessageAuditSummarySchema.optional(),
  timestamp: z.number().int().nonnegative(),
}).superRefine((message, ctx) => {
  if ((message.role === "user" || message.role === "system") && message.content.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "content is required",
    });
  }
});

export type InteractionMessage = z.infer<typeof InteractionMessageSchema>;

const CHINESE_SURNAME_PATTERN = "(?:赵|钱|孙|李|周|吴|郑|王|冯|陈|褚|卫|蒋|沈|韩|杨|朱|秦|尤|许|何|吕|施|张|孔|曹|严|华|金|魏|陶|姜|戚|谢|邹|喻|柏|水|窦|章|云|苏|潘|葛|奚|范|彭|郎|鲁|韦|昌|马|苗|凤|花|方|俞|任|袁|柳|酆|鲍|史|唐|费|廉|岑|薛|雷|贺|倪|汤|滕|殷|罗|毕|郝|邬|安|常|乐|于|时|傅|皮|卞|齐|康|伍|余|元|卜|顾|孟|平|黄|和|穆|萧|尹|姚|邵|湛|汪|祁|毛|禹|狄|米|贝|明|臧|计|伏|成|戴|谈|宋|茅|庞|熊|纪|舒|屈|项|祝|董|梁|杜|阮|蓝|闵|席|季|麻|强|贾|路|娄|危|江|童|颜|郭|梅|盛|林|刁|钟|徐|邱|骆|高|夏|蔡|田|樊|胡|凌|霍|虞|万|支|柯|昝|管|卢|莫|经|房|裘|缪|干|解|应|宗|丁|宣|贲|邓|郁|单|杭|洪|包|诸|左|石|崔|吉|钮|龚|程|嵇|邢|滑|裴|陆|荣|翁|荀|羊|於|惠|甄|曲|家|封|芮|羿|储|靳|汲|邴|糜|松|井|段|富|巫|乌|焦|巴|弓|牧|隗|山|谷|车|侯|宓|蓬|全|郗|班|仰|秋|仲|伊|宫|宁|仇|栾|暴|甘|钭|厉|戎|祖|武|符|刘|景|詹|束|龙|叶|幸|司|韶|郜|黎|蓟|薄|印|宿|白|怀|蒲|邰|从|鄂|索|咸|籍|赖|卓|蔺|屠|蒙|池|乔|阴|鬱|胥|能|苍|双|闻|莘|党|翟|谭|贡|劳|逄|姬|申|扶|堵|冉|宰|郦|雍|郤|璩|桑|桂|濮|牛|寿|通|边|扈|燕|冀|郏|浦|尚|农|温|别|庄|晏|柴|瞿|阎|充|慕|连|茹|习|宦|艾|鱼|容|向|古|易|慎|戈|廖|庾|终|暨|居|衡|步|都|耿|满|弘|匡|国|文|寇|广|禄|阙|东|欧|殳|沃|利|蔚|越|夔|隆|师|巩|厍|聂|晁|勾|敖|融|冷|訾|辛|阚|那|简|饶|空|曾|沙|乜|养|鞠|须|丰|巢|关|蒯|相|查|后|荆|红|游|竺|权|逯|盖|益|桓|公|欧阳|司马|上官|夏侯|诸葛|东方|尉迟|皇甫|令狐|宇文|长孙|慕容|司徒|司空)";
const CHINESE_NAME_FOLLOWING_PATTERN = "[\\s，。！？；：“”\"'《》（）()、】【,.!?;:在被和与及从向对把将令让使遭因同跟于往来去回入出逼卷拖追查守攻看听说问想要会正仍也却并再已便先后中里内外上下前后间时处分]";
const CHINESE_NAME_REGEX = new RegExp(`(^|[\\s，。！？；：“”"'《》（）()、])(${CHINESE_SURNAME_PATTERN}[\\u4e00-\\u9fff]{1,2})(?=${CHINESE_NAME_FOLLOWING_PATTERN}|$)`, "g");
const CHINESE_NAME_PAIR_REGEX = new RegExp(`(^|[\\s，。！？；：“”"'《》（）()、])(${CHINESE_SURNAME_PATTERN}[\\u4e00-\\u9fff]{1,2})(?:和|与|及)(${CHINESE_SURNAME_PATTERN}[\\u4e00-\\u9fff]{1,2})(?=${CHINESE_NAME_FOLLOWING_PATTERN}|$)`, "g");
const EXPLICIT_ROLE_NAME_REGEX = /(主角|主人公|男主|女主|反派|配角|关键角色|关键配角|角色名|角色)\s*(?:是|为|叫|名叫|叫做|名为|：|:)?\s*([A-Za-z][A-Za-z' -]{1,30}|[\u4e00-\u9fff]{2,6})/g;

function normalizeCharacterNameCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[#>*\-\d.\s]+/, "")
    .replace(/[：:（(][^）)\n]{0,20}[）)]?$/g, "")
    .replace(/[，。！？；：、,!?;:\-]+$/g, "")
    .trim();
}

function looksLikeGenericCharacterToken(value: string): boolean {
  if (!value) return true;
  if (value.length < 2 || value.length > 12) return true;
  return /^(简介|卖点|主角|主人公|男主|女主|反派|配角|角色|人物|世界观|故事背景|故事概述|故事走向|核心冲突|核心价值观|成长路径|卷纲规划|小说大纲)$/.test(value);
}

function normalizeCharacterNameList(names: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const name of names) {
    const candidate = normalizeCharacterNameCandidate(name);
    if (!candidate || looksLikeGenericCharacterToken(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

export function collectCharacterNamesFromText(text: string): ReadonlyArray<string> {
  const source = text.trim();
  if (!source) return [];
  const candidates: Array<{ readonly name: string; readonly order: number }> = [];
  const pushCandidate = (raw: string | undefined, order: number) => {
    const normalized = normalizeCharacterNameCandidate(raw ?? "");
    if (!normalized || looksLikeGenericCharacterToken(normalized)) return;
    candidates.push({ name: normalized, order });
  };

  for (const match of source.matchAll(EXPLICIT_ROLE_NAME_REGEX)) {
    pushCandidate(match[2], match.index ?? Number.MAX_SAFE_INTEGER);
  }
  for (const match of source.matchAll(CHINESE_NAME_PAIR_REGEX)) {
    const order = match.index ?? Number.MAX_SAFE_INTEGER;
    pushCandidate(match[2], order);
    pushCandidate(match[3], order + 0.01);
  }
  for (const match of source.matchAll(CHINESE_NAME_REGEX)) {
    pushCandidate(match[2], match.index ?? Number.MAX_SAFE_INTEGER);
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => a.order - b.order)
    .filter((candidate) => {
      if (seen.has(candidate.name)) return false;
      seen.add(candidate.name);
      return true;
    })
    .map((candidate) => candidate.name);
}

export function extractIntroCharacterNameHints(input?: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly introMarkdown?: string;
  readonly draftFields?: Readonly<Record<string, string>>;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly introCharacterNames?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  if (!input) return [];
  const structuredNames = normalizeCharacterNameList(input.introCharacterNames ?? []);
  if (structuredNames.length > 0) {
    return structuredNames;
  }

  const introOnlyCombined = [
    input.draftFields?.introMarkdown,
    input.introMarkdown,
    input.blurb,
    input.storyBackground,
  ].filter((value): value is string => Boolean(value?.trim())).join("\n");
  const introNames = collectCharacterNamesFromText(introOnlyCombined);
  if (introNames.length > 0) {
    return introNames;
  }

  const legacyFallbackCombined = [
    input.protagonist,
    input.supportingCast,
  ].filter((value): value is string => Boolean(value?.trim())).join("\n");
  return collectCharacterNamesFromText(legacyFallbackCombined);
}

export const BookCreationDraftSchema = z.object({
  concept: z.string().min(1),
  rawConcept: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  genre: z.string().min(1).optional(),
  genreAlias: z.string().min(1).optional(),
  genreSource: z.enum(["builtin", "project", "custom"]).optional(),
  mappedGenreId: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  language: z.enum(["zh", "en"]).optional(),
  targetChapters: z.number().int().min(1).optional(),
  chapterWordCount: z.number().int().min(1).optional(),
  blurb: z.string().min(1).optional(),
  storyBackground: z.string().min(1).optional(),
  introMarkdown: z.string().min(1).optional(),
  introCharacterNames: z.array(z.string().min(1)).optional(),
  worldPremise: z.string().min(1).optional(),
  settingNotes: z.string().min(1).optional(),
  novelOutline: z.string().min(1).optional(),
  protagonist: z.string().min(1).optional(),
  supportingCast: z.string().min(1).optional(),
  characterMatrix: z.string().min(1).optional(),
  characterArc: z.string().min(1).optional(),
  relationshipMap: z.string().min(1).optional(),
  conflictCore: z.string().min(1).optional(),
  volumeOutline: z.string().min(1).optional(),
  constraints: z.string().min(1).optional(),
  authorIntent: z.string().min(1).optional(),
  currentFocus: z.string().min(1).optional(),
  nextQuestion: z.string().min(1).optional(),
  draftFields: z.record(z.string(), z.string()).optional(),
  confirmedFields: z.array(z.string().min(1)).optional(),
  missingFields: z.array(z.string().min(1)).default([]),
  readyToCreate: z.boolean().default(false),
});

export type BookCreationDraft = z.infer<typeof BookCreationDraftSchema>;

export function syncIntroCharacterNames<T extends BookCreationDraft>(draft: T): T {
  const introCharacterNames = extractIntroCharacterNameHints({
    blurb: draft.blurb,
    storyBackground: draft.storyBackground,
    introMarkdown: draft.introMarkdown,
    draftFields: draft.draftFields,
    protagonist: draft.protagonist,
    supportingCast: draft.supportingCast,
    introCharacterNames: draft.introCharacterNames,
  });
  if (introCharacterNames.length === 0) {
    if (!draft.introCharacterNames || draft.introCharacterNames.length === 0) {
      return draft;
    }
    return {
      ...draft,
      introCharacterNames: undefined,
    };
  }
  return {
    ...draft,
    introCharacterNames: [...introCharacterNames],
  };
}

function hasAnyText(...values: ReadonlyArray<string | undefined>): boolean {
  return values.some((value) => typeof value === "string" && value.trim().length > 0);
}

export const BookCreationIntroPageDraftSchema = z.object({
  blurb: z.string().min(1).optional(),
  storyBackground: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.blurb, value.storyBackground)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blurb"],
      message: "intro page requires either blurb or storyBackground",
    });
  }
});

export const BookCreationWorldPageDraftSchema = z.object({
  worldPremise: z.string().min(1).optional(),
  settingNotes: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.worldPremise, value.settingNotes)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["worldPremise"],
      message: "world page requires worldPremise or settingNotes",
    });
  }
});

export const BookCreationOutlinePageDraftSchema = z.object({
  novelOutline: z.string().min(1).optional(),
  conflictCore: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.novelOutline, value.conflictCore)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["novelOutline"],
      message: "outline page requires novelOutline or conflictCore",
    });
  }
});

export const BookCreationVolumePageDraftSchema = z.object({
  volumeOutline: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.volumeOutline)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["volumeOutline"],
      message: "volume page requires volumeOutline",
    });
  }
});

export const BookCreationCharactersPageDraftSchema = z.object({
  protagonist: z.string().min(1).optional(),
  supportingCast: z.string().min(1).optional(),
  characterMatrix: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.protagonist, value.supportingCast, value.characterMatrix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["protagonist"],
      message: "characters page requires protagonist/supportingCast/characterMatrix",
    });
  }
});

export const BookCreationArcPageDraftSchema = z.object({
  characterArc: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.characterArc)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["characterArc"],
      message: "arc page requires characterArc",
    });
  }
});

export const BookCreationRelationPageDraftSchema = z.object({
  relationshipMap: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.relationshipMap)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relationshipMap"],
      message: "relation page requires relationshipMap",
    });
  }
});

export const BookCreationPageDraftSchemaMap = {
  intro: BookCreationIntroPageDraftSchema,
  world: BookCreationWorldPageDraftSchema,
  outline: BookCreationOutlinePageDraftSchema,
  volume: BookCreationVolumePageDraftSchema,
  characters: BookCreationCharactersPageDraftSchema,
  arc: BookCreationArcPageDraftSchema,
  relation: BookCreationRelationPageDraftSchema,
} as const;

export interface BookCreationConsistencyResult {
  readonly readyToCreate: boolean;
  readonly missingFields: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

function extractStepDraftPayload(
  step: BookCreationWizardStep,
  draft: BookCreationDraft,
): Record<string, unknown> {
  switch (step) {
    case "intro":
      return {
        blurb: draft.blurb,
        storyBackground: draft.storyBackground,
      };
    case "world":
      return {
        worldPremise: draft.worldPremise,
        settingNotes: draft.settingNotes,
      };
    case "outline":
      return {
        novelOutline: draft.novelOutline,
        conflictCore: draft.conflictCore,
      };
    case "volume":
      return {
        volumeOutline: draft.volumeOutline,
      };
    case "characters":
      return {
        protagonist: draft.protagonist,
        supportingCast: draft.supportingCast,
        characterMatrix: draft.characterMatrix,
      };
    case "arc":
      return {
        characterArc: draft.characterArc,
      };
    case "relation":
      return {
        relationshipMap: draft.relationshipMap,
      };
  }
}

export const BookCreationWizardStateSchema = z.object({
  currentStep: BookCreationWizardStepSchema.default("intro"),
  completedSteps: z.array(BookCreationWizardStepSchema).default([]),
  stepNotes: z.record(z.string(), z.string()).default({}),
  updatedAt: z.number().int().nonnegative().optional(),
});

export type BookCreationWizardState = z.infer<typeof BookCreationWizardStateSchema>;

const BOOK_CREATION_WIZARD_ORDER: ReadonlyArray<BookCreationWizardStep> = [
  "intro",
  "world",
  "outline",
  "volume",
  "characters",
  "arc",
  "relation",
];

function uniqueWizardSteps(steps: ReadonlyArray<BookCreationWizardStep>): BookCreationWizardStep[] {
  return [...new Set(steps)];
}

function resolveWizardStepOrDefault(step?: BookCreationWizardStep): BookCreationWizardStep {
  return step && BOOK_CREATION_WIZARD_ORDER.includes(step) ? step : "intro";
}

export const DraftRoundSchema = z.object({
  roundId: z.number().int().min(1),
  userMessage: z.string(),
  assistantRaw: z.string(),
  fieldsUpdated: z.array(z.string()).default([]),
  summary: z.string().default(""),
  timestamp: z.number().int().nonnegative(),
});

export type DraftRound = z.infer<typeof DraftRoundSchema>;

export const InteractionSessionSchema = z.object({
  sessionId: z.string().min(1),
  projectRoot: z.string().min(1),
  activeBookId: z.string().min(1).optional(),
  activeChapterNumber: z.number().int().min(1).optional(),
  creationDraft: BookCreationDraftSchema.optional(),
  creationWizard: BookCreationWizardStateSchema.optional(),
  draftRounds: z.array(DraftRoundSchema).default([]),
  automationMode: AutomationModeSchema.default("semi"),
  messages: z.array(InteractionMessageSchema).default([]),
  events: z.array(InteractionEventSchema).default([]),
  pendingDecision: PendingDecisionSchema.optional(),
  currentExecution: ExecutionStateSchema.optional(),
});

export type InteractionSession = z.infer<typeof InteractionSessionSchema>;

// -- Per-book session --

export const BookSessionSchema = z.object({
  sessionId: z.string().min(1),
  bookId: z.string().nullable(),
  title: z.string().nullable().default(null),
  messages: z.array(InteractionMessageSchema).default([]),
  creationDraft: BookCreationDraftSchema.optional(),
  creationWizard: BookCreationWizardStateSchema.optional(),
  draftRounds: z.array(DraftRoundSchema).default([]),
  events: z.array(InteractionEventSchema).default([]),
  currentExecution: ExecutionStateSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type BookSession = z.infer<typeof BookSessionSchema>;

// -- Global session (simplified) --

export const GlobalSessionSchema = z.object({
  activeBookId: z.string().min(1).optional(),
  automationMode: AutomationModeSchema.default("semi"),
});

export type GlobalSession = z.infer<typeof GlobalSessionSchema>;

export function createBookSession(bookId: string | null, sessionId?: string): BookSession {
  const now = Date.now();
  return {
    sessionId: sessionId ?? `${now}-${Math.random().toString(36).slice(2, 8)}`,
    bookId,
    title: null,
    messages: [],
    draftRounds: [],
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function appendBookSessionMessage(
  session: BookSession,
  message: InteractionMessage,
): BookSession {
  return {
    ...session,
    messages: [...session.messages, message].sort((a, b) => a.timestamp - b.timestamp),
    updatedAt: Date.now(),
  };
}

export function upsertBookSessionMessage(
  session: BookSession,
  message: InteractionMessage,
): BookSession {
  const index = session.messages.findIndex(
    (entry) => entry.role === message.role && entry.timestamp === message.timestamp,
  );
  const messages = index >= 0
    ? session.messages.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...message } : entry))
    : [...session.messages, message];
  return {
    ...session,
    messages: [...messages].sort((a, b) => a.timestamp - b.timestamp),
    updatedAt: Date.now(),
  };
}

export function bindActiveBook(
  session: InteractionSession,
  bookId: string,
  chapterNumber?: number,
): InteractionSession {
  return {
    ...session,
    activeBookId: bookId,
    ...(chapterNumber !== undefined ? { activeChapterNumber: chapterNumber } : {}),
  };
}

export function clearPendingDecision(session: InteractionSession): InteractionSession {
  if (!session.pendingDecision) {
    return session;
  }

  return {
    ...session,
    pendingDecision: undefined,
  };
}

export function updateCreationDraft(
  session: InteractionSession,
  draft: BookCreationDraft,
): InteractionSession {
  return {
    ...session,
    creationDraft: syncIntroCharacterNames(draft),
  };
}

export function updateCreationWizard(
  session: InteractionSession,
  wizard: BookCreationWizardState,
): InteractionSession {
  return {
    ...session,
    creationWizard: wizard,
  };
}

export function inferCreationWizardState(
  draft: BookCreationDraft | undefined,
  existing?: BookCreationWizardState,
): BookCreationWizardState | undefined {
  if (!draft) {
    return existing;
  }

  const completedSteps: BookCreationWizardStep[] = [];
  if (draft.storyBackground || draft.blurb) completedSteps.push("intro");
  if (draft.worldPremise || draft.settingNotes) completedSteps.push("world");
  if (draft.novelOutline || draft.conflictCore) completedSteps.push("outline");
  if (draft.volumeOutline) completedSteps.push("volume");
  if (draft.protagonist || draft.supportingCast) completedSteps.push("characters");
  if (draft.characterArc || draft.characterMatrix) completedSteps.push("arc");
  if (draft.relationshipMap) completedSteps.push("relation");

  const completed = uniqueWizardSteps([...(existing?.completedSteps ?? []), ...completedSteps]);
  const currentStep = existing?.currentStep && BOOK_CREATION_WIZARD_ORDER.includes(existing.currentStep)
    ? existing.currentStep
    : BOOK_CREATION_WIZARD_ORDER.find((step) => !completed.includes(step)) ?? "relation";

  return {
    currentStep,
    completedSteps: completed,
    stepNotes: existing?.stepNotes ?? {},
    updatedAt: Date.now(),
  };
}

export function advanceCreationWizardState(
  session: InteractionSession,
  currentStep?: BookCreationWizardStep,
): BookCreationWizardState {
  const wizard = session.creationWizard ?? {
    currentStep: "intro",
    completedSteps: [],
    stepNotes: {},
  };
  const step = resolveWizardStepOrDefault(currentStep ?? wizard.currentStep);
  const stepIndex = BOOK_CREATION_WIZARD_ORDER.indexOf(step);
  const nextStep = BOOK_CREATION_WIZARD_ORDER[stepIndex + 1] ?? "relation";
  return {
    currentStep: nextStep,
    completedSteps: uniqueWizardSteps([...(wizard.completedSteps ?? []), step]),
    stepNotes: wizard.stepNotes ?? {},
    updatedAt: Date.now(),
  };
}

export function retreatCreationWizardState(
  session: InteractionSession,
  currentStep?: BookCreationWizardStep,
): BookCreationWizardState {
  const wizard = session.creationWizard ?? {
    currentStep: "intro",
    completedSteps: [],
    stepNotes: {},
  };
  const step = resolveWizardStepOrDefault(currentStep ?? wizard.currentStep);
  const stepIndex = BOOK_CREATION_WIZARD_ORDER.indexOf(step);
  const previousStep = BOOK_CREATION_WIZARD_ORDER[Math.max(0, stepIndex - 1)] ?? "intro";
  return {
    currentStep: previousStep,
    completedSteps: uniqueWizardSteps((wizard.completedSteps ?? []).filter((item) => item !== step)),
    stepNotes: wizard.stepNotes ?? {},
    updatedAt: Date.now(),
  };
}

export function validateCreationDraftConsistency(
  draft: BookCreationDraft | undefined,
): BookCreationConsistencyResult {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  if (!draft) {
    return {
      readyToCreate: false,
      missingFields: ["concept", "title", "genre", "platform", "targetChapters", "chapterWordCount"],
      warnings: ["draft missing"],
    };
  }

  const pageChecks = [
    ["intro", BookCreationIntroPageDraftSchema.safeParse({
      blurb: draft.blurb,
      storyBackground: draft.storyBackground,
    })],
    ["world", BookCreationWorldPageDraftSchema.safeParse({
      worldPremise: draft.worldPremise,
      settingNotes: draft.settingNotes,
    })],
    ["outline", BookCreationOutlinePageDraftSchema.safeParse({
      novelOutline: draft.novelOutline,
      conflictCore: draft.conflictCore,
    })],
    ["volume", BookCreationVolumePageDraftSchema.safeParse({
      volumeOutline: draft.volumeOutline,
    })],
    ["characters", BookCreationCharactersPageDraftSchema.safeParse({
      protagonist: draft.protagonist,
      supportingCast: draft.supportingCast,
      characterMatrix: draft.characterMatrix,
    })],
    ["arc", BookCreationArcPageDraftSchema.safeParse({
      characterArc: draft.characterArc,
    })],
    ["relation", BookCreationRelationPageDraftSchema.safeParse({
      relationshipMap: draft.relationshipMap,
    })],
  ] as const;

  for (const [step, result] of pageChecks) {
    if (!result.success) {
      missingFields.push(step);
      warnings.push(...result.error.issues.map((issue) => `${step}:${issue.path.join(".") || "page"}`));
    }
  }

  return {
    readyToCreate: missingFields.length === 0,
    missingFields,
    warnings,
  };
}

export function clearCreationDraft(session: InteractionSession): InteractionSession {
  if (!session.creationDraft) {
    return session.creationWizard ? { ...session, creationWizard: undefined } : session;
  }

  return {
    ...session,
    creationDraft: undefined,
    creationWizard: undefined,
    draftRounds: [],
  };
}

export function updateAutomationMode(
  session: InteractionSession,
  automationMode: AutomationMode,
): InteractionSession {
  return {
    ...session,
    automationMode,
  };
}

export function appendInteractionMessage(
  session: InteractionSession,
  message: InteractionMessage,
): InteractionSession {
  return {
    ...session,
    messages: [...session.messages, message].sort((left, right) => left.timestamp - right.timestamp),
  };
}

export function appendInteractionEvent(
  session: InteractionSession,
  event: InteractionEvent,
): InteractionSession {
  return {
    ...session,
    events: [...session.events, event],
  };
}
