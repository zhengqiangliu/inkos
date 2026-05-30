import type { BookCreationDraft, BookCreationWizardStep } from "@actalk/inkos-core";
import { fetchJson } from "../hooks/use-api";

export type GenreLike = {
  readonly id: string;
  readonly name: string;
  readonly language?: string;
  readonly source?: string;
};

export type StepFocusCard = {
  readonly title: string;
  readonly description: string;
  readonly highlights: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
};

export type StepShortcutKind = "generate" | "revise" | "advance" | "create" | "params" | "goto" | "save";

export type StepShortcut = {
  readonly kind: StepShortcutKind;
  readonly label: string;
  readonly value: string;
};

export type StepActionSection = {
  readonly title: string;
  readonly items: ReadonlyArray<StepShortcut>;
};

export type ChatGuide = {
  readonly placeholder: string;
  readonly examples: ReadonlyArray<string>;
  readonly advanceLabel: string;
};

export type ChatActionLabels = {
  readonly advanceLabel: string;
  readonly createLabel: string;
};

export type ChatQuickTemplate = {
  readonly action: "modify" | "advance" | "params";
  readonly label: string;
  readonly value: string;
};

export type IntroCandidateLike = {
  readonly title: string;
  readonly blurb: string;
  readonly storyBackground: string;
  readonly style?: string;
  readonly reason?: string;
};

export type CreationDraftFieldTarget =
  | { readonly kind: "basic" }
  | { readonly kind: "step"; readonly step: BookCreationWizardStep };

export type ReviewChecklistItem = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly done: boolean;
  readonly target: CreationDraftFieldTarget;
};

export type WizardAdvanceRequest = {
  readonly currentStep: BookCreationWizardStep;
  readonly nextStep: BookCreationWizardStep;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly language: "zh" | "en";
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly note?: string;
};

export type WizardSaveRequest = {
  readonly currentStep: BookCreationWizardStep;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly language: "zh" | "en";
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly note?: string;
};

export type GenreMappingResult = {
  readonly genre: GenreLike;
  readonly matchedBy: "keyword" | "id" | "name" | "fallback";
};

export const WIZARD_STEPS: ReadonlyArray<{ id: BookCreationWizardStep; title: string; subtitle: string }> = [
  { id: "intro", title: "简介 / 故事背景", subtitle: "先把卖点和故事起点定住" },
  { id: "world", title: "世界观", subtitle: "定义规则、势力和边界" },
  { id: "outline", title: "小说大纲", subtitle: "主线、成长路、章节卡点" },
  { id: "volume", title: "卷纲规划", subtitle: "卷级推进与每卷收束" },
  { id: "characters", title: "主角 / 配角", subtitle: "角色功能与驱动力" },
  { id: "arc", title: "人物弧光", subtitle: "核心弧光与成长转折" },
  { id: "relation", title: "人物关系", subtitle: "关系动力与剧情引擎" },
  { id: "review", title: "收尾校验", subtitle: "一致性检查后再落库" },
];

const GENRE_KEYWORDS: Record<string, ReadonlyArray<string>> = {
  urban: ["都市", "现代", "商战", "港风", "职场", "悬疑"],
  xianxia: ["仙侠", "修仙", "宗门", "灵根", "剑修", "飞升"],
  wuxia: ["武侠", "江湖", "门派", "刀剑", "游侠"],
  fantasy: ["奇幻", "魔法", "龙族", "史诗", "异界"],
  "sci-fi": ["科幻", "星际", "机甲", "人工智能", "宇宙"],
  historical: ["历史", "朝堂", "权谋", "古代", "帝王"],
  horror: ["恐怖", "惊悚", "诡异", "灵异", "悬疑"],
};

function readStepIndex(step?: BookCreationWizardStep): number {
  return WIZARD_STEPS.findIndex((item) => item.id === step);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function fieldLabelFor(key: string, language: "zh" | "en"): string {
  const labels: Record<string, { zh: string; en: string }> = {
    title: { zh: "书名", en: "Title" },
    genre: { zh: "题材", en: "Genre" },
    platform: { zh: "平台", en: "Platform" },
    language: { zh: "语言", en: "Language" },
    targetChapters: { zh: "目标章数", en: "Target Chapters" },
    chapterWordCount: { zh: "每章字数", en: "Words Per Chapter" },
    blurb: { zh: "简介", en: "Blurb" },
    storyBackground: { zh: "故事背景", en: "Story Background" },
    worldPremise: { zh: "世界观", en: "World Premise" },
    protagonist: { zh: "主角", en: "Protagonist" },
    conflictCore: { zh: "核心冲突", en: "Core Conflict" },
    volumeOutline: { zh: "卷纲方向", en: "Volume Outline" },
    nextQuestion: { zh: "下一步", en: "Next" },
    concept: { zh: "概念", en: "Concept" },
  };
  return labels[key]?.[language] ?? key;
}

export function resolveCreationDraftFieldTarget(
  key: string,
): CreationDraftFieldTarget | null {
  switch (key) {
    case "blurb":
    case "storyBackground":
      return { kind: "step", step: "intro" };
    case "worldPremise":
    case "settingNotes":
      return { kind: "step", step: "world" };
    case "novelOutline":
    case "conflictCore":
      return { kind: "step", step: "outline" };
    case "volumeOutline":
      return { kind: "step", step: "volume" };
    case "protagonist":
    case "supportingCast":
    case "characterMatrix":
      return { kind: "step", step: "characters" };
    case "characterArc":
      return { kind: "step", step: "arc" };
    case "relationshipMap":
      return { kind: "step", step: "relation" };
    case "title":
    case "genre":
    case "platform":
    case "language":
    case "targetChapters":
    case "chapterWordCount":
    case "concept":
      return { kind: "basic" };
    case "review":
      return { kind: "basic" };
    default:
      return null;
  }
}

export function buildCreationReviewChecklist(
  draft: Partial<BookCreationDraft>,
  language: "zh" | "en",
): ReadonlyArray<ReviewChecklistItem> {
  const joinValues = (...values: ReadonlyArray<string | undefined>): string => values.map((value) => value?.trim()).filter(Boolean).join(" / ");
  const basicDone = Boolean(draft.title?.trim() && draft.genre?.trim() && draft.platform?.trim() && typeof draft.targetChapters === "number" && typeof draft.chapterWordCount === "number");
  const introDone = Boolean(draft.blurb?.trim() || draft.storyBackground?.trim());
  const worldDone = Boolean(draft.worldPremise?.trim() || draft.settingNotes?.trim());
  const outlineDone = Boolean(draft.novelOutline?.trim() || draft.conflictCore?.trim());
  const volumeDone = Boolean(draft.volumeOutline?.trim());
  const charactersDone = Boolean(draft.protagonist?.trim() || draft.supportingCast?.trim() || draft.characterMatrix?.trim());
  const arcDone = Boolean(draft.characterArc?.trim());
  const relationDone = Boolean(draft.relationshipMap?.trim());

  return [
    {
      key: "basic",
      label: language === "en" ? "Basic Parameters" : "基础参数",
      value: joinValues(
        draft.title ? `${language === "en" ? "Title" : "书名"}: ${draft.title}` : undefined,
        draft.genre ? `${language === "en" ? "Genre" : "题材"}: ${draft.genre}` : undefined,
        draft.platform ? `${language === "en" ? "Platform" : "平台"}: ${draft.platform}` : undefined,
        typeof draft.targetChapters === "number" ? `${language === "en" ? "Target Chapters" : "目标章数"}: ${draft.targetChapters}` : undefined,
        typeof draft.chapterWordCount === "number" ? `${language === "en" ? "Words / Chapter" : "每章字数"}: ${draft.chapterWordCount}` : undefined,
      ),
      done: basicDone,
      target: { kind: "basic" },
    },
    {
      key: "intro",
      label: language === "en" ? "Intro / Blurb" : "简介 / 故事背景",
      value: joinValues(draft.blurb, draft.storyBackground),
      done: introDone,
      target: { kind: "step", step: "intro" },
    },
    {
      key: "world",
      label: language === "en" ? "World" : "世界观",
      value: joinValues(draft.worldPremise, draft.settingNotes),
      done: worldDone,
      target: { kind: "step", step: "world" },
    },
    {
      key: "outline",
      label: language === "en" ? "Outline" : "小说大纲",
      value: joinValues(draft.novelOutline, draft.conflictCore),
      done: outlineDone,
      target: { kind: "step", step: "outline" },
    },
    {
      key: "volume",
      label: language === "en" ? "Volume Plan" : "卷纲规划",
      value: joinValues(draft.volumeOutline),
      done: volumeDone,
      target: { kind: "step", step: "volume" },
    },
    {
      key: "characters",
      label: language === "en" ? "Characters" : "主角 / 配角",
      value: joinValues(draft.protagonist, draft.supportingCast, draft.characterMatrix),
      done: charactersDone,
      target: { kind: "step", step: "characters" },
    },
    {
      key: "arc",
      label: language === "en" ? "Character Arc" : "人物弧光",
      value: joinValues(draft.characterArc),
      done: arcDone,
      target: { kind: "step", step: "arc" },
    },
    {
      key: "relation",
      label: language === "en" ? "Relationships" : "人物关系",
      value: joinValues(draft.relationshipMap),
      done: relationDone,
      target: { kind: "step", step: "relation" },
    },
    {
      key: "review",
      label: language === "en" ? "Wrap-up Check" : "收尾校验",
      value: basicDone ? (language === "en" ? "Ready to finish creation." : "已满足收尾创建条件。") : (language === "en" ? "Finish all sections first." : "请先完成所有分项。"),
      done: canCreateFromDraft(draft as BookCreationDraft),
      target: { kind: "step", step: "review" },
    },
  ];
}
function genreKeywordsFor(genreId: string): ReadonlyArray<string> {
  return GENRE_KEYWORDS[genreId] ?? [];
}

function genreMatchesQuery(genre: GenreLike, query: string): boolean {
  const normalized = normalizeText(query);
  if (!normalized) return false;
  const haystack = `${genre.id} ${genre.name}`.toLowerCase();
  if (haystack.includes(normalized)) return true;
  return genreKeywordsFor(genre.id).some((keyword) => normalized.includes(keyword.toLowerCase()) || haystack.includes(keyword.toLowerCase()));
}

export function resolveInitialGenreSelection(
  currentGenreId: string,
  genres: ReadonlyArray<GenreLike>,
  draftGenre?: string,
  projectLanguage: "zh" | "en" = "zh",
): string {
  const current = genres.find((genre) => genre.id === currentGenreId || genre.name === currentGenreId);
  if (current) return current.id;

  if (draftGenre) {
    const matchedDraftGenre = genres.find((genre) => genre.id === draftGenre || genre.name === draftGenre);
    if (matchedDraftGenre) return matchedDraftGenre.id;
  }

  const languageMatch = genres.find((genre) => genre.language === projectLanguage);
  if (languageMatch) return languageMatch.id;

  return genres[0]?.id ?? "";
}

export function pickValidValue(current: string, available: ReadonlyArray<string>): string {
  if (current && available.includes(current)) return current;
  return available[0] ?? "";
}

export function defaultChapterWordsForLanguage(language: "zh" | "en"): string {
  return language === "en" ? "2000" : "3000";
}

export function platformOptionsForLanguage(language: "zh" | "en"): ReadonlyArray<{ value: string; label: string }> {
  return language === "en"
    ? [
        { value: "royal-road", label: "Royal Road" },
        { value: "kindle-unlimited", label: "Kindle Unlimited" },
        { value: "scribble-hub", label: "Scribble Hub" },
        { value: "other", label: "Other" },
      ]
    : [
        { value: "tomato", label: "番茄小说" },
        { value: "qidian", label: "起点中文网" },
        { value: "feilu", label: "飞卢" },
        { value: "other", label: "其他" },
      ];
}

export function resolveDraftInstruction(input: string, hasDraft: boolean): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return hasDraft ? trimmed : `/new ${trimmed}`;
}

export function parsePositiveIntegerInput(input: string): number | undefined {
  const parsed = Number.parseFloat(input.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const value = Math.floor(parsed);
  return value > 0 ? value : undefined;
}

export function buildWizardStepSeedText(
  step: BookCreationWizardStep,
  draft: Partial<BookCreationDraft>,
  language: "zh" | "en",
): string {
  if (language === "en") {
    switch (step) {
      case "intro":
        return composeIntroSeedText(draft.blurb ?? "", draft.storyBackground ?? "");
      case "world":
        return [draft.worldPremise ? `World premise: ${draft.worldPremise}` : "", draft.settingNotes ? `Setting notes: ${draft.settingNotes}` : ""].filter(Boolean).join("\n\n");
      case "outline":
        return [draft.novelOutline ? `Outline: ${draft.novelOutline}` : "", draft.conflictCore ? `Conflict: ${draft.conflictCore}` : ""].filter(Boolean).join("\n\n");
      case "volume":
        return draft.volumeOutline ? `Volume outline: ${draft.volumeOutline}` : "";
      case "characters":
        return [draft.protagonist ? `Protagonist: ${draft.protagonist}` : "", draft.supportingCast ? `Supporting cast: ${draft.supportingCast}` : "", draft.characterMatrix ? `Character matrix: ${draft.characterMatrix}` : ""].filter(Boolean).join("\n\n");
      case "arc":
        return draft.characterArc ? `Character arc: ${draft.characterArc}` : "";
      case "relation":
        return draft.relationshipMap ? `Relationship map: ${draft.relationshipMap}` : "";
      case "review":
        return [draft.title ? `Title: ${draft.title}` : "", draft.genre ? `Genre: ${draft.genre}` : "", draft.platform ? `Platform: ${draft.platform}` : "", typeof draft.targetChapters === "number" ? `Target chapters: ${draft.targetChapters}` : "", typeof draft.chapterWordCount === "number" ? `Words per chapter: ${draft.chapterWordCount}` : ""].filter(Boolean).join("\n");
    }
  }

  switch (step) {
    case "intro":
      return composeIntroSeedText(draft.blurb ?? "", draft.storyBackground ?? "");
    case "world":
      return [draft.worldPremise ? `世界观：${draft.worldPremise}` : "", draft.settingNotes ? `补充设定：${draft.settingNotes}` : ""].filter(Boolean).join("\n\n");
    case "outline":
      return [draft.novelOutline ? `大纲：${draft.novelOutline}` : "", draft.conflictCore ? `核心冲突：${draft.conflictCore}` : ""].filter(Boolean).join("\n\n");
    case "volume":
      return draft.volumeOutline ? `卷纲：${draft.volumeOutline}` : "";
    case "characters":
      return [draft.protagonist ? `主角：${draft.protagonist}` : "", draft.supportingCast ? `配角：${draft.supportingCast}` : "", draft.characterMatrix ? `角色矩阵：${draft.characterMatrix}` : ""].filter(Boolean).join("\n\n");
    case "arc":
      return draft.characterArc ? `人物弧光：${draft.characterArc}` : "";
    case "relation":
      return draft.relationshipMap ? `人物关系：${draft.relationshipMap}` : "";
    case "review":
      return [draft.title ? `书名：${draft.title}` : "", draft.genre ? `题材：${draft.genre}` : "", draft.platform ? `平台：${draft.platform}` : "", typeof draft.targetChapters === "number" ? `目标章数：${draft.targetChapters}` : "", typeof draft.chapterWordCount === "number" ? `每章字数：${draft.chapterWordCount}` : ""].filter(Boolean).join("\n");
  }
}

export function composeIntroSeedText(blurb: string, storyBackground: string): string {
  const parts: string[] = [];
  const blurbText = blurb.trim();
  const backgroundText = storyBackground.trim();
  if (blurbText) parts.push(`简介/卖点：${blurbText}`);
  if (backgroundText) parts.push(`故事背景：${backgroundText}`);
  return parts.join("\n\n");
}

export function buildIntroCandidateBackfill(candidate: IntroCandidateLike): string {
  return composeIntroSeedText(candidate.blurb, candidate.storyBackground);
}

export function resolveIntroCandidateTitle(candidate: IntroCandidateLike): string {
  return candidate.title.trim() || candidate.style?.trim() || candidate.blurb.trim() || candidate.storyBackground.trim();
}

export function parseIntroSeedText(input: string): { readonly blurb: string; readonly storyBackground: string } {
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
    const normalized = line.replace(/[：:]\s*/g, ":");
    if (/^(简介\/卖点|简介|卖点):/.test(normalized)) {
      current = "blurb";
      write(normalized.replace(/^(简介\/卖点|简介|卖点):\s*/, ""));
      continue;
    }
    if (/^(故事背景|背景):/.test(normalized)) {
      current = "storyBackground";
      write(normalized.replace(/^(故事背景|背景):\s*/, ""));
      continue;
    }
    write(line);
  }

  return { blurb: blurb.trim(), storyBackground: storyBackground.trim() };
}

export function resolveGenreMapping(input: string, genres: ReadonlyArray<GenreLike>): GenreMappingResult | null {
  const normalized = normalizeText(input);
  if (!normalized || genres.length === 0) return null;

  const exactId = genres.find((genre) => normalizeText(genre.id) === normalized);
  if (exactId) return { genre: exactId, matchedBy: "id" };

  const exactName = genres.find((genre) => normalizeText(genre.name) === normalized);
  if (exactName) return { genre: exactName, matchedBy: "name" };

  let best: { genre: GenreLike; score: number } | null = null;
  for (const genre of genres) {
    let score = 0;
    for (const keyword of genreKeywordsFor(genre.id)) {
      if (normalized.includes(keyword.toLowerCase())) score += 3;
    }
    if (genreMatchesQuery(genre, input)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { genre, score };
  }

  if (best) return { genre: best.genre, matchedBy: "keyword" };
  return { genre: genres[0]!, matchedBy: "fallback" };
}

export function parseIntroCandidateResponse(raw: string): ReadonlyArray<{
  readonly title: string;
  readonly blurb: string;
  readonly storyBackground: string;
  readonly hook?: string;
  readonly style?: string;
  readonly reason?: string;
}> {
  const normalizeField = (value: string): string => value.trim().replace(/^[:：\-\s]+/, "").trim();
  const source = raw.trim();
  if (!source) return [];

  const parseCandidateRecord = (value: unknown): ReadonlyArray<{
    readonly title: string;
    readonly blurb: string;
    readonly storyBackground: string;
    readonly hook?: string;
    readonly style?: string;
    readonly reason?: string;
  }> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const blurb = typeof candidate.blurb === "string" ? candidate.blurb.trim() : "";
    const storyBackground = typeof candidate.storyBackground === "string" ? candidate.storyBackground.trim() : "";
    const hook = typeof candidate.hook === "string" ? candidate.hook.trim() : "";
    const style = typeof candidate.style === "string" ? candidate.style.trim() : "";
    const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
    if (!title && !blurb && !storyBackground) return [];
    return [{
      title: title || blurb || storyBackground || "候选方案",
      blurb,
      storyBackground,
      ...(hook ? { hook } : {}),
      ...(style ? { style } : {}),
      ...(reason ? { reason } : {}),
    }];
  };

  const parseCandidateList = (value: unknown): ReadonlyArray<{
    readonly title: string;
    readonly blurb: string;
    readonly storyBackground: string;
    readonly hook?: string;
    readonly style?: string;
    readonly reason?: string;
  }> => {
    if (!Array.isArray(value)) return parseCandidateRecord(value);
    return value.flatMap((item) => parseCandidateRecord(item));
  };

  const parseJsonPayload = (payload: string) => {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (Array.isArray(parsed)) return parseCandidateList(parsed);
      if (parsed && typeof parsed === "object") {
        const record = parsed as { candidates?: unknown };
        return parseCandidateList(record.candidates ?? parsed);
      }
    } catch {
      // fall through to text parsing
    }
    return [];
  };

  const extractJsonSegments = (text: string): ReadonlyArray<string> => {
    const segments: string[] = [];
    const stack: Array<{ char: "{" | "["; index: number }> = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push({ char, index: i });
        continue;
      }

      if (char !== "}" && char !== "]" || stack.length === 0) {
        continue;
      }

      const last = stack[stack.length - 1];
      if (!last) continue;
      const matches = last.char === "{" ? char === "}" : char === "]";
      if (!matches) continue;

      stack.pop();
      if (stack.length === 0) {
        segments.push(text.slice(last.index, i + 1));
      }
    }

    return segments;
  };

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fencedPayload = fenced?.[1]?.trim();
  const parsedJson = parseJsonPayload(fencedPayload ?? source);
  if (parsedJson.length > 0) return parsedJson;

  for (const segment of extractJsonSegments(source)) {
    const parsedSegment = parseJsonPayload(segment);
    if (parsedSegment.length > 0) return parsedSegment;
  }

  const blocks = source
    .replace(/\r/g, "")
    .split(/\n(?=(?:#+\s*)?(?:候选|方案|候选方案)\s*[\d一二三四五六七八九十]+(?:[：:\-\s]|$))/i)
    .flatMap((chunk) => chunk.split(/\n\s*\n+/))
    .map((block) => block.trim())
    .filter(Boolean);

  const fieldPattern = /^(title|书名|blurb|简介|storyBackground|故事背景|style|风格|reason|原因|hook|引爆点)\s*[:=：]\s*(.+)$/i;
  const inlineFieldPattern = /(title|书名|blurb|简介|storyBackground|故事背景|style|风格|reason|原因|hook|引爆点)\s*[:=：]\s*([^]+?)(?=(?:\s+(?:title|书名|blurb|简介|storyBackground|故事背景|style|风格|reason|原因|hook|引爆点)\s*[:=：])|$)/ig;

  const parsedBlocks = blocks.flatMap((block) => {
    const fields: Record<string, string> = {};
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    for (const line of lines) {
      const match = line.match(fieldPattern);
      if (match?.[1] && match[2]) {
        fields[match[1].toLowerCase()] = normalizeField(match[2]);
      }
    }

    const inlineMatches = [...block.matchAll(inlineFieldPattern)];
    for (const match of inlineMatches) {
      const key = match[1]?.toLowerCase();
      const value = match[2];
      if (key && value && !fields[key]) {
        fields[key] = normalizeField(value);
      }
    }

    const headerLine = lines[0] ?? "";
    if (!fields.title) {
      const headerMatch = headerLine.match(/^(?:#+\s*)?(?:候选|方案|候选方案)\s*[\d一二三四五六七八九十]+[：:\-\s]*(.*)$/i);
      if (headerMatch?.[1]) {
        fields.title = normalizeField(headerMatch[1]);
      }
    }

    if (!fields.title && !fields.blurb && !fields.storybackground) {
      return [];
    }

    const title = fields.title ?? fields.书名 ?? fields.blurb ?? fields.storybackground ?? "候选方案";
    const blurb = fields.blurb ?? fields.简介 ?? "";
    const storyBackground = fields.storybackground ?? fields.故事背景 ?? "";
    const hook = fields.hook ?? fields.引爆点;
    const style = fields.style ?? fields.风格;
    const reason = fields.reason ?? fields.原因;

    return [{
      title,
      blurb,
      storyBackground,
      ...(hook ? { hook } : {}),
      ...(style ? { style } : {}),
      ...(reason ? { reason } : {}),
    }];
  });

  if (parsedBlocks.length > 0) return parsedBlocks;

  const payload = fencedPayload?.trim() ?? source;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parseCandidateList(Array.isArray(parsed) ? parsed : (parsed as { candidates?: unknown }).candidates);
  } catch {
    return [];
  }
}

export function parseLatestIntroCandidates(
  messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>,
): ReadonlyArray<{
  readonly title: string;
  readonly blurb: string;
  readonly storyBackground: string;
  readonly hook?: string;
  readonly style?: string;
  readonly reason?: string;
}> {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !message.content.trim()) continue;
    const parsed = parseIntroCandidateResponse(message.content);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

export function selectBookCreateDockMessages<T extends {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly wizardStep?: BookCreationWizardStep;
}>(
  messages: ReadonlyArray<T>,
  currentStep: BookCreationWizardStep,
): {
  readonly visibleMessages: ReadonlyArray<T>;
  readonly legacyMessageCount: number;
} {
  return {
    visibleMessages: messages.filter((message) => message.wizardStep === currentStep),
    legacyMessageCount: messages.filter((message) => !message.wizardStep).length,
  };
}

export function rankIntroCandidates(
  candidates: ReadonlyArray<{
    readonly title: string;
    readonly blurb: string;
    readonly storyBackground: string;
    readonly style?: string;
    readonly reason?: string;
  }>,
  selectedStyle: string,
): ReadonlyArray<{
  readonly title: string;
  readonly blurb: string;
  readonly storyBackground: string;
  readonly style?: string;
  readonly reason?: string;
}> {
  const query = normalizeText(selectedStyle);
  const keywords = genreKeywordsFor(query);
  return candidates
    .map((candidate, index) => {
      const fields = `${candidate.title} ${candidate.blurb} ${candidate.storyBackground} ${candidate.style ?? ""} ${candidate.reason ?? ""}`.toLowerCase();
      let score = 0;
      if (query && (normalizeText(candidate.style ?? "") === query || fields.includes(query))) score += 8;
      for (const keyword of keywords) {
        if (fields.includes(keyword.toLowerCase())) score += 3;
      }
      if (candidate.reason) score += 1;
      return { candidate, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.candidate);
}

export function buildChatActionLabels(step: BookCreationWizardStep, nextStepTitle: string | undefined, language: "zh" | "en"): ChatActionLabels {
  if (language === "en") {
    return {
      advanceLabel: step === "review" ? "Review and finish creation" : `Save and continue to ${nextStepTitle ?? "next step"}`,
      createLabel: "Finish creation",
    };
  }

  return {
    advanceLabel: step === "review" ? "复核并完成创建" : `确认并进入 ${nextStepTitle ?? "下一步"}`,
    createLabel: "完成创建",
  };
}

export function buildChatGuide(step: BookCreationWizardStep, language: "zh" | "en"): ChatGuide {
  const currentMeta = WIZARD_STEPS.find((item) => item.id === step) ?? WIZARD_STEPS[0]!;
  if (language === "en") {
    return {
      placeholder: step === "review"
        ? "Fill in title, genre, chapters, and words, or finish creation directly."
        : `Refine the current ${currentMeta.title} page with AI.`,
      examples: step === "intro"
        ? ["Generate several candidate blurbs by genre.", "Use the chat to polish the intro seed."]
        : ["Refine the current page only.", "Confirm and move forward when the draft is ready."],
      advanceLabel: buildChatActionLabels(step, currentMeta.title, language).advanceLabel,
    };
  }

  return {
    placeholder: step === "review"
      ? "补齐书名、题材、章数和字数，然后完成收尾。"
      : step === "intro"
        ? "围绕题材、卖点、故事背景继续修订，优先只改这一页。"
        : `围绕当前${currentMeta.title}页继续修订，优先只改这一页。`,
    examples: step === "intro"
      ? ["按题材生成 3-5 套简介候选池。", "把一句话卖点改得更抓人。"]
      : step === "review"
        ? ["先核对分项是否齐全，再完成创建。", "只做缺失项核对，不要扩写。"]
        : ["只优化当前页面内容。", "若已完成，可直接进入下一步。"],
    advanceLabel: step === "review"
      ? "复核并完成创建"
      : "确认当前页并进入下一步",
  };
}

export function buildBookCreateCommand(params: {
  readonly kind: "intro-revise" | "intro-polish" | "intro-generate" | "params" | "advance" | "create" | "discard" | "back" | "goto" | "save";
  readonly language: "zh" | "en";
  readonly stepTitle: string;
  readonly currentStep?: BookCreationWizardStep;
  readonly nextStepTitle?: string;
  readonly nextStep?: BookCreationWizardStep;
  readonly wizardStep?: BookCreationWizardStep;
  readonly title?: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly stepContent?: string;
  readonly introBlurb?: string;
  readonly introStoryBackground?: string;
  readonly modifyNote?: string;
  readonly theme?: string;
  readonly candidateIndex?: number;
  readonly candidateCount?: number;
}): { readonly kind: string; readonly label: string; readonly instruction: string; readonly disabled?: boolean } {
  const language = params.language;
  const title = params.title?.trim() ?? "";
  const genre = params.genre?.trim() ?? "";
  const platform = params.platform?.trim() ?? "";
  const targetChapters = params.targetChapters;
  const chapterWordCount = params.chapterWordCount;
  const introBlurb = params.introBlurb?.trim() ?? "";
  const introStoryBackground = params.introStoryBackground?.trim() ?? "";
  const modifyNote = params.modifyNote?.trim() ?? "";
  const theme = params.theme?.trim() ?? "";
  const candidateCount = params.candidateCount;

  switch (params.kind) {
    case "params":
      return {
        kind: "params",
        label: language === "en" ? "Send hard params" : "发送基础参数",
        instruction: `/params 书名=${title} 平台=${platform} 题材=${genre} 目标章数=${targetChapters ?? ""} 每章字数=${chapterWordCount ?? ""}`.trim(),
      };
    case "save":
      return {
        kind: "save",
        label: language === "en" ? "Save current step" : "保存当前页",
        instruction: `/save step=${params.wizardStep ?? params.currentStep ?? "intro"} title=${title || "未填"} genre=${genre || "未选"} platform=${platform || "未选"} target=${targetChapters ?? ""} words=${chapterWordCount ?? ""}${params.stepContent?.trim() ? `\n\n${params.stepContent.trim()}` : ""}`,
      };
    case "advance":
      return {
        kind: "advance",
        label: language === "en" ? "Next step" : "下一步",
        instruction: `/wizard advance current=${params.currentStep ?? params.wizardStep ?? "intro"} next=${params.nextStep ?? "world"} title=${title || "未填"} genre=${genre || "未选"} platform=${platform || "未选"} target=${targetChapters ?? ""} words=${chapterWordCount ?? ""}`,
      };
    case "intro-revise":
      return {
        kind: "intro-revise",
        label: language === "en" ? "AI revise intro" : "AI 修改简介",
        disabled: !modifyNote,
        instruction: `请根据以下要求修改当前简介/故事背景。\n\n书名：${title || "未填"}\n题材：${genre || "未选"}\n平台：${platform || "未选"}\n修改要求：${modifyNote}\n\n当前简介：${introBlurb || "（空）"}\n当前故事背景：${introStoryBackground || "（空）"}`,
      };
    case "intro-polish":
      return {
        kind: "intro-polish",
        label: language === "en" ? "AI polish intro" : "AI 润色简介",
        disabled: !modifyNote,
        instruction: `请润色当前简介/故事背景，并保留原意与题材一致性。\n\n书名：${title || "未填"}\n题材：${genre || "未选"}\n平台：${platform || "未选"}\n修改要求：${modifyNote}\n\n当前简介：${introBlurb || "（空）"}\n当前故事背景：${introStoryBackground || "（空）"}`,
      };
    case "intro-generate":
      return {
        kind: "intro-generate",
        label: language === "en" ? "Generate candidates" : "生成候选池",
        disabled: !theme && !genre,
        instruction: `请按题材和主题生成${candidateCount && candidateCount > 0 ? candidateCount : 3} 套简介候选，只输出候选池，不要直接进入建书。\n\n书名：${title || "未填"}\n题材：${genre || "未选"}\n主题：${theme || genre || "未填"}\n平台：${platform || "未选"}\n当前简介：${introBlurb || "（空）"}\n当前故事背景：${introStoryBackground || "（空）"}\n\n要求：\n1. 每套都要包含 title、blurb、storyBackground、style、reason。\n2. 候选之间风格要有差异。\n3. 请尽量用 JSON 数组输出；如果无法严格 JSON，也要按清晰分隔的多方案格式输出。\n4. 输出后只提示我可以在左侧候选池选择第几套，不要触发建书流程。`,
      };
    case "back":
      return {
        kind: "back",
        label: language === "en" ? "Previous step" : "上一步",
        instruction: `请回到上一步，当前页为${params.stepTitle}。`,
      };
    case "goto":
      return {
        kind: "goto",
        label: language === "en" ? "Go to step" : "跳转步骤",
        instruction: `/goto ${params.wizardStep ?? "intro"}`,
      };
    case "create":
      return {
        kind: "create",
        label: language === "en" ? "Finish creation" : "完成创建",
        instruction: "/create",
      };
    case "discard":
      return {
        kind: "discard",
        label: language === "en" ? "Discard draft" : "丢弃草案",
        instruction: "/discard",
      };
    default:
      return {
        kind: params.kind,
        label: params.kind,
        instruction: params.kind,
      };
  }
}

export function shouldSubmitChatOnKeyDown(event: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function buildChatQuickTemplates(
  _step: BookCreationWizardStep,
  currentStepTitle: string,
  nextStepTitle: string | undefined,
  draft: Pick<BookCreationDraft, "title" | "platform" | "targetChapters" | "chapterWordCount">,
): ReadonlyArray<ChatQuickTemplate> {
  return [
    {
      action: "modify",
      label: "润色当前页",
      value: `只优化当前${currentStepTitle}页，不改其他页面内容。`,
    },
    {
      action: "advance",
      label: nextStepTitle ? `推进到${nextStepTitle}` : "继续补全当前页",
      value: nextStepTitle ? `请继续补全${nextStepTitle}内容，并保持与当前${currentStepTitle}一致。` : `请继续补全当前${currentStepTitle}页内容。`,
    },
    {
      action: "params",
      label: "补参数",
      value: `/params 书名=${draft.title ?? ""} 平台=${draft.platform ?? ""} 目标章数=${draft.targetChapters ?? ""} 每章字数=${draft.chapterWordCount ?? ""}`.trim(),
    },
  ];
}

export function buildConceptSplitSummary(
  draft: Partial<BookCreationDraft>,
  language: "zh" | "en",
): ReadonlyArray<{ key: string; label: string; value: string }> {
  const items = language === "en"
    ? [
        draft.blurb ? { key: "blurb", label: "One-line Hook", value: draft.blurb } : undefined,
        draft.storyBackground ? { key: "storyBackground", label: "Background Seed", value: draft.storyBackground } : undefined,
        draft.worldPremise ? { key: "worldPremise", label: "World Seed", value: draft.worldPremise } : undefined,
        draft.protagonist ? { key: "protagonist", label: "Protagonist", value: draft.protagonist } : undefined,
        draft.conflictCore ? { key: "conflictCore", label: "Core Conflict", value: draft.conflictCore } : undefined,
      ]
    : [
        draft.blurb ? { key: "blurb", label: "一句话卖点", value: draft.blurb } : undefined,
        draft.storyBackground ? { key: "storyBackground", label: "故事背景种子", value: draft.storyBackground } : undefined,
        draft.worldPremise ? { key: "worldPremise", label: "世界观种子", value: draft.worldPremise } : undefined,
        draft.protagonist ? { key: "protagonist", label: "主角", value: draft.protagonist } : undefined,
        draft.conflictCore ? { key: "conflictCore", label: "核心冲突", value: draft.conflictCore } : undefined,
      ];
  return items.filter((item): item is { key: string; label: string; value: string } => Boolean(item));
}

export function buildHardParamsSummary(
  draft: Partial<BookCreationDraft>,
  language: "zh" | "en",
): ReadonlyArray<{ key: string; label: string; value: string }> {
  const items = language === "en"
    ? [
        draft.title ? { key: "title", label: "Title", value: draft.title } : undefined,
        draft.platform ? { key: "platform", label: "Platform", value: draft.platform } : undefined,
        draft.language ? { key: "language", label: "Language", value: draft.language } : undefined,
        typeof draft.targetChapters === "number" ? { key: "targetChapters", label: "Target Chapters", value: String(draft.targetChapters) } : undefined,
        typeof draft.chapterWordCount === "number" ? { key: "chapterWordCount", label: "Words Per Chapter", value: String(draft.chapterWordCount) } : undefined,
      ]
    : [
        draft.title ? { key: "title", label: "书名", value: draft.title } : undefined,
        draft.platform ? { key: "platform", label: "平台", value: draft.platform } : undefined,
        draft.language ? { key: "language", label: "语言", value: draft.language } : undefined,
        typeof draft.targetChapters === "number" ? { key: "targetChapters", label: "目标章数", value: String(draft.targetChapters) } : undefined,
        typeof draft.chapterWordCount === "number" ? { key: "chapterWordCount", label: "每章字数", value: String(draft.chapterWordCount) } : undefined,
      ];
  return items.filter((item): item is { key: string; label: string; value: string } => Boolean(item));
}

export function buildStepFocusCard(
  step: BookCreationWizardStep,
  draft: Partial<BookCreationDraft>,
  language: "zh" | "en",
): StepFocusCard {
  const meta = WIZARD_STEPS[readStepIndex(step) >= 0 ? readStepIndex(step) : 0] ?? WIZARD_STEPS[0]!;

  const highlights = (() => {
    switch (step) {
      case "intro":
        return language === "en"
          ? [
              draft.blurb ? `Hook: ${draft.blurb}` : "Write a sharper hook.",
              draft.storyBackground ? `Background: ${draft.storyBackground}` : "Add the story background seed.",
            ]
          : [
              draft.blurb ? `一句话卖点：${draft.blurb}` : "先写出一句话卖点。",
              draft.storyBackground ? `故事背景：${draft.storyBackground}` : "补齐故事背景。",
            ];
      case "world":
        return language === "en"
          ? [
              draft.worldPremise ? `World premise: ${draft.worldPremise}` : "Define the world premise.",
              draft.settingNotes ? `Setting notes: ${draft.settingNotes}` : "Add the setting notes.",
            ]
          : [
              draft.worldPremise ? `世界观：${draft.worldPremise}` : "先定义世界观。",
              draft.settingNotes ? `补充设定：${draft.settingNotes}` : "补齐补充设定。",
            ];
      case "outline":
        return language === "en"
          ? [
              draft.novelOutline ? `Outline: ${draft.novelOutline}` : "Write the outline.",
              draft.conflictCore ? `Core conflict: ${draft.conflictCore}` : "Add the core conflict.",
            ]
          : [
              draft.novelOutline ? `小说大纲：${draft.novelOutline}` : "先写小说大纲。",
              draft.conflictCore ? `核心冲突：${draft.conflictCore}` : "补齐核心冲突。",
            ];
      case "volume":
        return language === "en"
          ? [draft.volumeOutline ? `Volume plan: ${draft.volumeOutline}` : "Write the volume plan."]
          : [draft.volumeOutline ? `卷纲规划：${draft.volumeOutline}` : "先写卷纲规划。"];
      case "characters":
        return language === "en"
          ? [
              draft.protagonist ? `Protagonist: ${draft.protagonist}` : "Define the protagonist.",
              draft.supportingCast ? `Supporting cast: ${draft.supportingCast}` : "Add supporting cast.",
            ]
          : [
              draft.protagonist ? `主角：${draft.protagonist}` : "先定义主角。",
              draft.supportingCast ? `配角：${draft.supportingCast}` : "补齐配角。",
            ];
      case "arc":
        return language === "en"
          ? [draft.characterArc ? `Character arc: ${draft.characterArc}` : "Write the character arc."]
          : [draft.characterArc ? `人物弧光：${draft.characterArc}` : "先写人物弧光。"];
      case "relation":
        return language === "en"
          ? [draft.relationshipMap ? `Relationship map: ${draft.relationshipMap}` : "Write the relationship map."]
          : [draft.relationshipMap ? `人物关系：${draft.relationshipMap}` : "先写人物关系。"];
      case "review":
        return language === "en"
          ? [
              draft.title ? `Title: ${draft.title}` : "Fill in the title.",
              draft.genre ? `Genre: ${draft.genre}` : "Fill in the genre.",
            ]
          : [
              draft.title ? `书名：${draft.title}` : "先补书名。",
              draft.genre ? `题材：${draft.genre}` : "先补题材。",
            ];
    }
  })();

  const missing: string[] = [];
  if (step === "intro") {
    if (!draft.blurb?.trim()) missing.push(fieldLabelFor("blurb", language));
    if (!draft.storyBackground?.trim()) missing.push(fieldLabelFor("storyBackground", language));
  }
  if (step === "world") {
    if (!draft.worldPremise?.trim()) missing.push(fieldLabelFor("worldPremise", language));
    if (!draft.settingNotes?.trim()) missing.push(fieldLabelFor("settingNotes", language));
  }
  if (step === "review") {
    for (const key of ["title", "genre", "targetChapters", "chapterWordCount"] as const) {
      if (!(draft as Record<string, unknown>)[key]) missing.push(fieldLabelFor(key, language));
    }
  }
  if (step !== "intro") {
    const introLabels = new Set([fieldLabelFor("blurb", language), fieldLabelFor("storyBackground", language)]);
    const filteredMissing = missing.filter((item) => !introLabels.has(item));
    missing.splice(0, missing.length, ...filteredMissing);
  }
  for (const field of draft.missingFields ?? []) {
    const label = fieldLabelFor(field, language);
    if (step !== "intro" && (label === fieldLabelFor("blurb", language) || label === fieldLabelFor("storyBackground", language))) continue;
    if (!missing.includes(label)) missing.push(label);
  }

  const titleByStep: Record<BookCreationWizardStep, string> = {
    intro: language === "en" ? "Intro Focus" : "简介焦点",
    world: language === "en" ? "World Focus" : "世界观焦点",
    outline: language === "en" ? "Outline Focus" : "大纲焦点",
    volume: language === "en" ? "Volume Focus" : "卷纲焦点",
    characters: language === "en" ? "Characters Focus" : "角色焦点",
    arc: language === "en" ? "Arc Focus" : "弧光焦点",
    relation: language === "en" ? "Relation Focus" : "关系焦点",
    review: language === "en" ? "Wrap-up Focus" : "收尾焦点",
  };

  return {
    title: `${titleByStep[step]}: ${meta.title}`,
    description: language === "en"
      ? `Focus on ${meta.subtitle.toLowerCase()}.`
      : `围绕${meta.subtitle}收束当前页内容。`,
    highlights,
    missing,
  };
}

export function buildStepShortcuts(
  step: BookCreationWizardStep,
  focusCard: StepFocusCard,
  nextStepTitle: string | undefined,
  language: "zh" | "en",
): ReadonlyArray<StepShortcut> {
  const createShortcut: StepShortcut = {
    kind: "create",
    label: language === "en" ? "Finish creation" : "完成创建",
    value: language === "en"
      ? "Finish the book creation after reviewing all step drafts."
      : (step === "review"
        ? "先完成分项向导，再在收尾页完成创建。"
        : "保存当前页并继续推进下一步。"),
  };

  if (step === "intro") {
    return [
      {
        kind: "generate",
        label: language === "en" ? "Generate candidate pool" : "生成卖点候选",
        value: language === "en"
          ? "Generate 3-5 intro candidates around the current genre and seed."
          : "围绕当前题材与卖点生成候选池，再挑一套落库。",
      },
      {
        kind: "revise",
        label: language === "en" ? "Rebuild by style" : "按风格重抽",
        value: language === "en"
          ? "Rewrite only the current intro page by style."
          : "只优化当前简介与故事背景，不动其他页面。",
      },
      {
        kind: "params",
        label: language === "en" ? "Fill hard params" : "补齐硬参数",
        value: language === "en"
          ? "Title / Genre / Chapters / Words should be ready before creation."
          : "书名、题材、章数、字数需要先齐，再进入创建。",
      },
    ];
  }

  if (step === "world") {
    return [
      {
        kind: "generate",
        label: language === "en" ? "Generate world rules" : "生成世界观骨架",
        value: language === "en"
          ? "Generate rules, factions, resources, and boundaries."
          : "补齐规则、势力、资源、边界骨架。",
      },
      {
        kind: "revise",
        label: language === "en" ? "Refine world" : "重写世界观",
        value: language === "en"
          ? "Refine the current world page only."
          : "只重写当前世界观页，不动其他内容。",
      },
    ];
  }

  if (step === "review") {
    return [
      {
        kind: "revise",
        label: language === "en" ? "Fix missing fields" : "修订缺失项",
        value: language === "en"
          ? "Check title, genre, chapters, and chapter words."
          : "核对书名、题材、章数、字数是否完整。",
      },
      createShortcut,
    ];
  }

  return [
    {
      kind: "revise",
      label: language === "en" ? `Continue to ${nextStepTitle ?? "next step"}` : `推进到${nextStepTitle ?? "下一步"}`,
      value: language === "en"
        ? `Keep the current ${focusCard.title} aligned with the next page.`
        : `保持当前页和${nextStepTitle ?? "下一步"}一致。`,
    },
    createShortcut,
  ];
}

export function buildStepActionSections(
  step: BookCreationWizardStep,
  focusCard: StepFocusCard,
  nextStepTitle: string | undefined,
  language: "zh" | "en",
): ReadonlyArray<StepActionSection> {
  const shortcuts = buildStepShortcuts(step, focusCard, nextStepTitle, language);
  if (step === "review") {
    return [
      { title: language === "en" ? "Revise" : "修订", items: shortcuts.filter((item) => item.kind === "revise") },
      { title: language === "en" ? "Finalize" : "定稿", items: shortcuts.filter((item) => item.kind === "create") },
    ];
  }
  return [{ title: language === "en" ? "Actions" : "操作", items: shortcuts }];
}

export function buildStepRecommendedAction(params: {
  readonly step: BookCreationWizardStep;
  readonly focusCard: StepFocusCard;
  readonly language: "zh" | "en";
  readonly hasIntroCandidates?: boolean;
  readonly canCreate?: boolean;
}): { readonly shortcut: StepShortcut; readonly reason: string } {
  const shortcuts = buildStepShortcuts(params.step, params.focusCard, undefined, params.language);
  if (params.step === "intro" && !params.hasIntroCandidates) {
    return {
      shortcut: shortcuts[0]!,
      reason: params.language === "en" ? "There is no candidate pool yet." : "当前还没有候选池，先生成一组。",
    };
  }
  if (params.step === "review" && params.canCreate) {
    const create = shortcuts.find((item) => item.kind === "create") ?? shortcuts[shortcuts.length - 1]!;
    return {
      shortcut: create,
      reason: params.language === "en" ? "The draft is ready to finish creation." : "草案已满足收尾条件，可以完成创建。",
    };
  }
  return {
    shortcut: shortcuts[0]!,
    reason: params.language === "en" ? "Use the current page's primary action." : "优先执行当前页的主动作。",
  };
}

export function canCreateFromDraft(draft?: BookCreationDraft): boolean {
  if (!draft) return false;
  if (draft.readyToCreate) return true;
  return Boolean(draft.title?.trim() && draft.genre?.trim() && typeof draft.targetChapters === "number" && typeof draft.chapterWordCount === "number");
}

export function buildCreationDraftSummary(
  draft: BookCreationDraft,
  language: "zh" | "en",
): ReadonlyArray<{ key: string; label: string; value: string }> {
  const rows = language === "en"
    ? [
        draft.title ? { key: "title", label: "Title", value: draft.title } : undefined,
        draft.genre ? { key: "genre", label: "Genre", value: draft.genre } : undefined,
        draft.storyBackground ? { key: "storyBackground", label: "Story Background", value: draft.storyBackground } : undefined,
        draft.worldPremise ? { key: "worldPremise", label: "World", value: draft.worldPremise } : undefined,
        draft.novelOutline ? { key: "novelOutline", label: "Novel Outline", value: draft.novelOutline } : undefined,
        draft.protagonist ? { key: "protagonist", label: "Protagonist", value: draft.protagonist } : undefined,
        draft.characterMatrix ? { key: "characterMatrix", label: "Character Matrix", value: draft.characterMatrix } : undefined,
        draft.characterArc ? { key: "characterArc", label: "Character Arc", value: draft.characterArc } : undefined,
        draft.relationshipMap ? { key: "relationshipMap", label: "Relationship Map", value: draft.relationshipMap } : undefined,
        draft.conflictCore ? { key: "conflictCore", label: "Core Conflict", value: draft.conflictCore } : undefined,
        draft.volumeOutline ? { key: "volumeOutline", label: "Volume Direction", value: draft.volumeOutline } : undefined,
        draft.blurb ? { key: "blurb", label: "Blurb", value: draft.blurb } : undefined,
        draft.nextQuestion ? { key: "nextQuestion", label: "Next", value: draft.nextQuestion } : undefined,
      ]
    : [
        draft.title ? { key: "title", label: "书名", value: draft.title } : undefined,
        draft.genre ? { key: "genre", label: "题材", value: draft.genre } : undefined,
        draft.storyBackground ? { key: "storyBackground", label: "故事背景", value: draft.storyBackground } : undefined,
        draft.worldPremise ? { key: "worldPremise", label: "世界观", value: draft.worldPremise } : undefined,
        draft.novelOutline ? { key: "novelOutline", label: "小说大纲", value: draft.novelOutline } : undefined,
        draft.protagonist ? { key: "protagonist", label: "主角", value: draft.protagonist } : undefined,
        draft.characterMatrix ? { key: "characterMatrix", label: "角色矩阵", value: draft.characterMatrix } : undefined,
        draft.characterArc ? { key: "characterArc", label: "人物弧光", value: draft.characterArc } : undefined,
        draft.relationshipMap ? { key: "relationshipMap", label: "人物关系", value: draft.relationshipMap } : undefined,
        draft.conflictCore ? { key: "conflictCore", label: "核心冲突", value: draft.conflictCore } : undefined,
        draft.volumeOutline ? { key: "volumeOutline", label: "卷纲方向", value: draft.volumeOutline } : undefined,
        draft.blurb ? { key: "blurb", label: "简介", value: draft.blurb } : undefined,
        draft.nextQuestion ? { key: "nextQuestion", label: "下一步", value: draft.nextQuestion } : undefined,
      ];
  return rows.filter((row): row is { key: string; label: string; value: string } => Boolean(row));
}

interface WaitForBookReadyOptions {
  readonly fetchBook?: (bookId: string) => Promise<unknown>;
  readonly fetchStatus?: (bookId: string) => Promise<{ status: string; error?: string }>;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly waitImpl?: (ms: number) => Promise<void>;
}

export async function waitForBookReady(bookId: string, options: WaitForBookReadyOptions = {}): Promise<void> {
  const fetchBook = options.fetchBook ?? ((id: string) => fetchJson(`/books/${id}`));
  const fetchStatus = options.fetchStatus ?? ((id: string) => fetchJson<{ status: string; error?: string }>(`/books/${id}/create-status`));
  const maxAttempts = options.maxAttempts ?? 120;
  const delayMs = options.delayMs ?? 250;
  const waitImpl = options.waitImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  let lastKnownStatus: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fetchBook(bookId);
      return;
    } catch (error) {
      lastError = error;
      try {
        const status = await fetchStatus(bookId);
        lastKnownStatus = status.status;
        if (status.status === "error") {
          throw new Error(status.error ?? `Book "${bookId}" failed to create`);
        }
      } catch (statusError) {
        if (statusError instanceof Error && statusError.message !== "404 Not Found") {
          throw statusError;
        }
      }
      if (attempt === maxAttempts - 1) {
        if (lastKnownStatus === "creating") break;
        throw error;
      }
      await waitImpl(delayMs);
    }
  }

  if (lastKnownStatus === "creating") {
    throw new Error(`Book "${bookId}" is still being created. Wait a moment and refresh.`);
  }

  throw lastError instanceof Error ? lastError : new Error(`Book "${bookId}" was not ready`);
}
