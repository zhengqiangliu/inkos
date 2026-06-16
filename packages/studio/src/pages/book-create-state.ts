import type { BookCreationDraft, BookCreationWizardState, BookCreationWizardStep } from "@actalk/inkos-core";
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

export type StepValidationStatus = "checking" | "pass" | "fail" | "fixing";

export type StepValidationIssue = {
  readonly key: string;
  readonly label: string;
  readonly message: string;
  readonly target: CreationDraftFieldTarget;
};

export type StepValidationReport = {
  readonly step: BookCreationWizardStep;
  readonly status: StepValidationStatus;
  readonly done: boolean;
  readonly issues: ReadonlyArray<StepValidationIssue>;
  readonly summary: string;
};

export type StepMarkdownSection = {
  readonly key: string;
  readonly title: string;
  readonly placeholder: string;
};

export type StepMarkdownSpec = {
  readonly title: string;
  readonly description: string;
  readonly sections: ReadonlyArray<StepMarkdownSection>;
};

export type WizardStepHydrationStatus = "idle" | "loading" | "loaded" | "error";
export type GenreSelectionSource = "unknown" | "auto" | "manual";

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
];

export const WIZARD_STEP_FILE_NAMES: Readonly<Record<BookCreationWizardStep, string>> = {
  intro: "intro.md",
  world: "world.md",
  outline: "outline.md",
  volume: "volume.md",
  characters: "characters.md",
  arc: "character_arc.md",
  relation: "relationship_map.md",
};

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

export function mergeCreationWizardState(params: {
  readonly current?: BookCreationWizardState;
  readonly fetched?: BookCreationWizardState;
  readonly pendingStep?: BookCreationWizardStep | null;
}): BookCreationWizardState | undefined {
  const { current, fetched, pendingStep } = params;
  if (!fetched) return current;

  const currentIndex = current ? readStepIndex(current.currentStep) : -1;
  const fetchedIndex = readStepIndex(fetched.currentStep);
  const pendingIndex = pendingStep ? readStepIndex(pendingStep) : -1;

  if (pendingIndex >= 0 && fetchedIndex < pendingIndex) {
    return current ?? {
      ...fetched,
      currentStep: pendingStep as BookCreationWizardStep,
      updatedAt: Date.now(),
    };
  }

  if (!current) return fetched;
  return fetchedIndex >= currentIndex ? fetched : current;
}

export function shouldSyncWizardStep(params: {
  readonly targetStep: BookCreationWizardStep;
  readonly visibleStep?: BookCreationWizardStep | null;
  readonly localWizard?: BookCreationWizardState | null;
  readonly sessionWizard?: BookCreationWizardState | null;
}): boolean {
  const { targetStep, visibleStep, localWizard, sessionWizard } = params;
  if (visibleStep === targetStep) return false;
  if (localWizard?.currentStep === targetStep) return false;
  if (sessionWizard?.currentStep === targetStep) return false;
  return true;
}

export function resolveBookCreationResumeStep(
  wizard?: BookCreationWizardState | null,
): BookCreationWizardStep {
  if (!wizard) return "intro";
  const completedSteps = new Set(wizard.completedSteps ?? []);
  const firstIncomplete = WIZARD_STEPS.find((step) => !completedSteps.has(step.id));
  if (firstIncomplete) {
    return firstIncomplete.id;
  }
  const currentIndex = WIZARD_STEPS.findIndex((step) => step.id === wizard.currentStep);
  if (currentIndex >= 0) {
    return WIZARD_STEPS[currentIndex]!.id;
  }
  return "intro";
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
    settingNotes: { zh: "补充设定", en: "Setting Notes" },
    novelOutline: { zh: "小说大纲", en: "Novel Outline" },
    supportingCast: { zh: "配角", en: "Supporting Cast" },
    characterMatrix: { zh: "角色矩阵", en: "Character Matrix" },
    characterArc: { zh: "人物弧光", en: "Character Arc" },
    relationshipMap: { zh: "人物关系", en: "Relationship Map" },
    protagonist: { zh: "主角", en: "Protagonist" },
    conflictCore: { zh: "核心冲突", en: "Core Conflict" },
    volumeOutline: { zh: "卷纲方向", en: "Volume Outline" },
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
  ];
}

function buildValidationIssue(
  key: string,
  language: "zh" | "en",
  target: CreationDraftFieldTarget,
): StepValidationIssue {
  const labels: Record<string, { zh: string; en: string }> = {
    title: { zh: "书名", en: "Title" },
    genre: { zh: "题材", en: "Genre" },
    platform: { zh: "平台", en: "Platform" },
    targetChapters: { zh: "目标章数", en: "Target Chapters" },
    chapterWordCount: { zh: "每章字数", en: "Words / Chapter" },
    blurb: { zh: "简介", en: "Blurb" },
    storyBackground: { zh: "故事背景", en: "Story Background" },
    worldPremise: { zh: "世界观", en: "World Premise" },
    settingNotes: { zh: "补充设定", en: "Setting Notes" },
    novelOutline: { zh: "小说大纲", en: "Novel Outline" },
    conflictCore: { zh: "核心冲突", en: "Core Conflict" },
    volumeOutline: { zh: "卷纲规划", en: "Volume Plan" },
    protagonist: { zh: "主角", en: "Protagonist" },
    supportingCast: { zh: "配角", en: "Supporting Cast" },
    characterMatrix: { zh: "角色矩阵", en: "Character Matrix" },
    characterArc: { zh: "人物弧光", en: "Character Arc" },
    relationshipMap: { zh: "人物关系", en: "Relationship Map" },
  };
  const label = labels[key]?.[language] ?? key;
  return {
    key,
    label,
    message: language === "zh" ? `请补齐${label}` : `Please fill in ${label}`,
    target,
  };
}

function summarizeValidationIssues(
  issues: ReadonlyArray<StepValidationIssue>,
  language: "zh" | "en",
): string {
  if (issues.length === 0) {
    return language === "zh" ? "当前页已通过校验。" : "This page passed validation.";
  }
  const labels = issues.map((issue) => issue.label).join(language === "zh" ? "、" : ", ");
  return language === "zh" ? `当前页还有 ${issues.length} 项未通过：${labels}` : `${issues.length} issue(s) remain: ${labels}`;
}

export function buildStepValidationReport(
  step: BookCreationWizardStep,
  draft: Partial<BookCreationDraft>,
  language: "zh" | "en",
  stepContent?: string,
): StepValidationReport {
  const issues: StepValidationIssue[] = [];
  const push = (key: string, target: CreationDraftFieldTarget) => {
    issues.push(buildValidationIssue(key, language, target));
  };
  const content = stepContent?.trim() ?? "";
  const introSeed = parseIntroSeedText(content);

  switch (step) {
    case "intro":
      if (!(draft.title?.trim())) {
        push("title", { kind: "basic" });
      }
      if (!(introSeed.blurb || introSeed.storyBackground || draft.blurb?.trim() || draft.storyBackground?.trim())) {
        push("blurb", { kind: "step", step: "intro" });
        push("storyBackground", { kind: "step", step: "intro" });
      }
      break;
    case "world":
      if (!(content || draft.worldPremise?.trim() || draft.settingNotes?.trim())) {
        push("worldPremise", { kind: "step", step: "world" });
        push("settingNotes", { kind: "step", step: "world" });
      }
      break;
    case "outline":
      if (!(content || draft.novelOutline?.trim() || draft.conflictCore?.trim())) {
        push("novelOutline", { kind: "step", step: "outline" });
        push("conflictCore", { kind: "step", step: "outline" });
      }
      break;
    case "volume":
      if (!(content || draft.volumeOutline?.trim())) push("volumeOutline", { kind: "step", step: "volume" });
      break;
    case "characters":
      if (!(content || draft.protagonist?.trim() || draft.supportingCast?.trim() || draft.characterMatrix?.trim())) {
        push("protagonist", { kind: "step", step: "characters" });
        push("supportingCast", { kind: "step", step: "characters" });
        push("characterMatrix", { kind: "step", step: "characters" });
      }
      break;
    case "arc":
      if (!(content || draft.characterArc?.trim())) push("characterArc", { kind: "step", step: "arc" });
      break;
    case "relation":
      if (!(content || draft.relationshipMap?.trim())) push("relationshipMap", { kind: "step", step: "relation" });
      break;
  }

  return {
    step,
    status: issues.length === 0 ? "pass" : "fail",
    done: issues.length === 0,
    issues,
    summary: summarizeValidationIssues(issues, language),
  };
}

export function buildWizardValidationReports(
  draft: Partial<BookCreationDraft> | undefined,
  language: "zh" | "en",
): Readonly<Record<BookCreationWizardStep, StepValidationReport>> {
  const source = draft ?? {};
  return {
    intro: buildStepValidationReport("intro", source, language),
    world: buildStepValidationReport("world", source, language),
    outline: buildStepValidationReport("outline", source, language),
    volume: buildStepValidationReport("volume", source, language),
    characters: buildStepValidationReport("characters", source, language),
    arc: buildStepValidationReport("arc", source, language),
    relation: buildStepValidationReport("relation", source, language),
  };
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
  draftGenreAlias?: string,
  draftMappedGenreId?: string,
  projectLanguage: "zh" | "en" = "zh",
): string {
  const current = genres.find((genre) => genre.id === currentGenreId || genre.name === currentGenreId);
  if (current) return current.id;

  const draftCandidates = [draftMappedGenreId, draftGenre, draftGenreAlias].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of draftCandidates) {
    const matchedDraftGenre = genres.find((genre) => genre.id === candidate || genre.name === candidate);
    if (matchedDraftGenre) return matchedDraftGenre.id;
  }

  const languageMatch = genres.find((genre) => genre.language === projectLanguage);
  if (languageMatch) return languageMatch.id;

  return genres[0]?.id ?? "";
}

export function resolveBookCreateGenreSelection(params: {
  readonly currentGenreId: string;
  readonly currentSource: GenreSelectionSource;
  readonly genres: ReadonlyArray<GenreLike>;
  readonly draftGenre?: string;
  readonly draftGenreAlias?: string;
  readonly draftMappedGenreId?: string;
  readonly projectLanguage: "zh" | "en";
}): {
  readonly genreId: string;
  readonly source: GenreSelectionSource;
} {
  const hasDraftGenre = Boolean(params.draftGenre?.trim() || params.draftGenreAlias?.trim() || params.draftMappedGenreId?.trim());
  const shouldPreferDraft = hasDraftGenre && params.currentSource !== "manual";
  const genreId = resolveInitialGenreSelection(
    shouldPreferDraft ? "" : params.currentGenreId,
    params.genres,
    params.draftGenre,
    params.draftGenreAlias,
    params.draftMappedGenreId,
    params.projectLanguage,
  );
  if (params.currentSource === "manual") {
    return { genreId, source: "manual" };
  }
  return { genreId, source: "auto" };
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
        return buildCharacterArcMarkdownDraft(draft);
      case "relation":
        return buildRelationshipMapMarkdownDraft(draft);
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
      return buildCharacterArcMarkdownDraft(draft);
    case "relation":
      return buildRelationshipMapMarkdownDraft(draft);
  }
}

export function resolveWizardStepDisplayContent(params: {
  readonly step: BookCreationWizardStep;
  readonly draft: Partial<BookCreationDraft>;
  readonly language: "zh" | "en";
  readonly editedDraft?: string;
  readonly persistedDraft?: string;
  readonly introMarkdown?: string;
}): string {
  const {
    step,
    draft,
    language,
    editedDraft,
    persistedDraft,
    introMarkdown,
  } = params;

  if (step === "intro") {
    return introMarkdown?.trim() || buildIntroMarkdownDraft(draft, language);
  }
  const edited = editedDraft?.trim();
  if (edited) return edited;
  const persisted = persistedDraft?.trim();
  if (persisted) return persisted;
  return buildStepMarkdownDraft(step, draft, language);
}

export function hasMeaningfulWizardStepContent(
  step: BookCreationWizardStep,
  content: string,
  draft?: Partial<BookCreationDraft>,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (step === "intro") {
    return Boolean(draft?.draftFields?.introMarkdown?.trim() || draft?.blurb?.trim() || draft?.storyBackground?.trim());
  }
  if (step === "world") {
    if (/^(世界观|补充设定)[:：].*\.{3}$/m.test(trimmed)) return false;
    if (draft?.worldPremise?.trim() || draft?.settingNotes?.trim()) return true;
    const bodyLines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line !== "-" && line !== "—" && line !== "…" && line !== "..." && !/^(##?|[-*])\s*(世界观|补充设定)?[:：]?$/.test(line));
    return bodyLines.some((line) => line.length >= 6);
  }
  if (step === "arc") {
    return !isScaffoldOnlyArc(trimmed);
  }
  if (step === "relation") {
    if (looksLikeWizardStepMarkdown("relation", trimmed)) return true;
    if (isScaffoldOnlyRelation(trimmed)) return false;
    return countMeaningfulRelationEntries(trimmed) >= 2
      && /(冲突|转折|试探|绑定|分化|重组|推进|背叛|联盟|隐瞒|真相|旧债|威胁|关系)/.test(trimmed);
  }
  return true;
}

export function hasMeaningfulManualWizardStepContent(
  step: BookCreationWizardStep,
  content: string,
  draft?: Partial<BookCreationDraft>,
): boolean {
  return explainManualWizardStepContentIssue(step, content, draft) === null;
}

export function explainManualWizardStepContentIssue(
  step: BookCreationWizardStep,
  content: string,
  draft?: Partial<BookCreationDraft>,
): "empty" | "summary" | "scaffold" | "too_short" | null {
  const trimmed = content.trim();
  if (!trimmed) return "empty";
  if (WIZARD_SUMMARY_LANGUAGE_PATTERN.test(trimmed)) return "summary";

  if (step === "intro") {
    return hasMeaningfulWizardStepContent(step, trimmed, draft) ? null : "scaffold";
  }

  if (step === "world") {
    if (hasMeaningfulWizardStepContent(step, trimmed, draft)) return null;
    const bodyLines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        line
        && line !== "-"
        && line !== "—"
        && line !== "…"
        && line !== "..."
        && !/^(##?|[-*])\s*(世界观|补充设定)?[:：]?$/.test(line),
      );
    return bodyLines.some((line) => line.length >= 6) ? null : "scaffold";
  }

  if (step === "outline") {
    if (looksLikeOutlineMarkdown(trimmed)) return null;
    return trimmed.length >= 40 ? null : "too_short";
  }

  if (step === "arc") {
    if (looksLikeWizardStepMarkdown("arc", trimmed)) return null;
    if (isScaffoldOnlyArc(trimmed)) return "scaffold";
    return !isScaffoldOnlyArc(trimmed)
      && /(核心弧光|起点状态|成长转折|终点状态)/.test(trimmed)
      && /(性格缺陷|内心恐惧|错误信念|触发事件|内心挣扎|觉醒时刻|持续考验|性格蜕变|克服恐惧|新信念|残留痕迹)/.test(trimmed)
      ? (trimmed.replace(/\s+/g, "").length >= 80 ? null : "too_short")
      : "scaffold";
  }

  if (step === "relation") {
    if (looksLikeWizardStepMarkdown("relation", trimmed)) return null;
    if (isScaffoldOnlyRelation(trimmed)) return "scaffold";
    return !isScaffoldOnlyRelation(trimmed)
      && /(核心关系|对立关系|隐藏联系|潜在冲突)/.test(trimmed)
      && /(→|：|:)/.test(trimmed)
      && countMeaningfulRelationEntries(trimmed) >= 2
      ? (trimmed.replace(/\s+/g, "").length >= 80 ? null : "too_short")
      : "scaffold";
  }

  return trimmed.length >= 20 ? null : "too_short";
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

export function buildIntroExpansionSeedText(candidate: IntroCandidateLike): string {
  const parts: string[] = [];
  if (candidate.title.trim()) parts.push(`候选标题：${candidate.title.trim()}`);
  if (candidate.style?.trim()) parts.push(`风格：${candidate.style.trim()}`);
  if (candidate.reason?.trim()) parts.push(`候选价值：${candidate.reason.trim()}`);
  if (candidate.blurb.trim()) parts.push(`候选卖点：${candidate.blurb.trim()}`);
  if (candidate.storyBackground.trim()) parts.push(`候选背景：${candidate.storyBackground.trim()}`);
  return parts.join("\n\n");
}

export function buildIntroMarkdownDraft(draft: Partial<BookCreationDraft>, language: "zh" | "en"): string {
  const introMarkdown = draft.draftFields?.introMarkdown?.trim();
  if (introMarkdown) return introMarkdown;
  const blurb = draft.blurb?.trim() ?? "";
  const storyBackground = draft.storyBackground?.trim() ?? "";
  const title = draft.title?.trim() ?? "";
  const genre = draft.genre?.trim() ?? "";
  const platform = draft.platform?.trim() ?? "";
  const theme = draft.genreAlias?.trim() ?? draft.mappedGenreId?.trim() ?? genre;
  const lines = [
    "# 简介正文",
    genre ? `- 题材：${genre}` : undefined,
    platform ? `- 平台：${platform}` : undefined,
    theme ? `- 主题：${theme}` : undefined,
    "",
    blurb ? `## 一句话卖点\n${blurb}` : "## 一句话卖点\n-",
    storyBackground ? `## 故事概述\n${storyBackground}` : "## 故事概述\n-",
    "## 故事走向\n-",
    "## 主要人物成长路径\n-",
    "## 核心冲突\n-",
    "## 核心价值观\n-",
  ];
  return lines.join("\n\n");
}

export function looksLikeIntroBodyMarkdown(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^(已|好的|我来|我先|正在|开始|生成|修改|润色|总结|汇报|说明)/.test(trimmed)) return false;
  return /(^|\n)\s*#\s+/.test(trimmed)
    || /(^|\n)\s*##\s+(一句话卖点|故事概述|故事走向|主要人物成长路径|核心冲突|核心价值观)/.test(trimmed);
}

export function hasMeaningfulIntroMarkdown(content: string): boolean {
  const trimmed = content.trim();
  if (!looksLikeIntroBodyMarkdown(trimmed)) return false;
  const requiredSections = [
    "一句话卖点",
    "故事概述",
    "故事走向",
    "主要人物成长路径",
    "核心冲突",
    "核心价值观",
  ];
  const sectionCount = requiredSections.filter((section) => trimmed.includes(section)).length;
  const meaningfulBodyLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !/^#/.test(line)
      && !/^-+\s*$/.test(line)
      && line !== "-"
      && line !== "—"
      && line !== "…"
      && line !== "..."
      && !/^(题材|平台|主题)[:：]/.test(line),
    );
  const substantiveLines = meaningfulBodyLines.filter((line) => line.length >= 8);
  return sectionCount >= 4 && substantiveLines.length >= 4;
}

function findIntroBodyStartIndex(content: string): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const remaining = lines.slice(i).join("\n").trim();
    if (looksLikeIntroBodyMarkdown(remaining)) {
      return i;
    }
  }
  return -1;
}

export function normalizeIntroMarkdownCandidate(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (looksLikeIntroBodyMarkdown(trimmed)) return trimmed;
  const startIndex = findIntroBodyStartIndex(trimmed);
  if (startIndex < 0) return "";
  return trimmed.split(/\r?\n/).slice(startIndex).join("\n").trim();
}

function scoreIntroMarkdownCandidate(content: string): number {
  const trimmed = content.trim();
  if (!looksLikeIntroBodyMarkdown(trimmed)) return Number.NEGATIVE_INFINITY;
  const requiredSections = [
    "一句话卖点",
    "故事概述",
    "故事走向",
    "主要人物成长路径",
    "核心冲突",
    "核心价值观",
  ];
  const sectionCount = requiredSections.filter((section) => trimmed.includes(section)).length;
  const concreteLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !/^#/.test(line)
      && !/^-+\s*$/.test(line)
      && line !== "-"
      && line !== "—"
      && line !== "…"
      && line !== "..."
      && !/^(题材|平台|主题)[:：]/.test(line),
    );
  const substantiveCount = concreteLines.filter((line) => line.length >= 8).length;
  if (substantiveCount === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const placeholderCount = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line === "-" || line === "—" || line === "…" || line === "..." || /^-\s*$/.test(line))
    .length;
  return sectionCount * 100 + substantiveCount * 12 + Math.min(500, trimmed.length / 2) - placeholderCount * 40;
}

export function pickBestIntroMarkdownCandidate(candidates: ReadonlyArray<string | null | undefined>): string {
  let best = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const normalized = normalizeIntroMarkdownCandidate(candidate?.trim() ?? "");
    if (!normalized) continue;
    const score = scoreIntroMarkdownCandidate(normalized);
    if (score > bestScore) {
      best = normalized;
      bestScore = score;
    }
  }
  return best;
}

export function resolveCanonicalIntroMarkdown(
  candidates: ReadonlyArray<string | null | undefined>,
): string {
  return pickBestIntroMarkdownCandidate(candidates);
}

export function resolvePreferredIntroMarkdown(params: {
  readonly draft: Partial<BookCreationDraft>;
  readonly language: "zh" | "en";
  readonly persistedIntroMarkdown?: string;
  readonly currentIntroMarkdown?: string;
  readonly currentSource?: "draft" | "generated";
}): {
  readonly content: string;
  readonly source: "draft" | "generated";
} {
  const {
    draft,
    language,
    persistedIntroMarkdown,
    currentIntroMarkdown,
    currentSource,
  } = params;

  const persisted = persistedIntroMarkdown?.trim() ?? "";
  const current = currentIntroMarkdown?.trim() ?? "";
  const draftIntro = draft.draftFields?.introMarkdown?.trim() ?? "";
  const canonical = resolveCanonicalIntroMarkdown([
    persisted,
    current,
    draftIntro,
  ]);

  if (canonical) {
    return {
      content: canonical,
      source: "generated",
    };
  }

  if (currentSource === "generated" && current) {
    return {
      content: current,
      source: "generated",
    };
  }

  return {
    content: buildIntroMarkdownDraft({
      ...draft,
      draftFields: undefined,
    }, language),
    source: "draft",
  };
}

export function resolveIntroMarkdownEditorContent(params: {
  readonly draft: Partial<BookCreationDraft>;
  readonly language: "zh" | "en";
  readonly persistedIntroMarkdown?: string;
  readonly currentIntroMarkdown?: string;
  readonly currentSource?: "draft" | "generated";
  readonly dirty?: boolean;
}): string {
  if (params.dirty) {
    return params.currentIntroMarkdown?.trim() ?? "";
  }
  return resolvePreferredIntroMarkdown(params).content;
}

export function buildCharacterArcMarkdownDraft(draft: Partial<BookCreationDraft>): string {
  const arc = draft.characterArc?.trim() || "";
  const protagonist = draft.protagonist?.trim() || "";
  const supportingCast = draft.supportingCast?.trim() || "";
  const conflictCore = draft.conflictCore?.trim() || "";
  const novelOutline = draft.novelOutline?.trim() || "";
  const worldPremise = draft.worldPremise?.trim() || "";
  const settingNotes = draft.settingNotes?.trim() || "";
  const arcSummary = arc || [
    protagonist ? `主角从「${protagonist}」出发` : "主角在开局时仍处在被环境推着走的状态",
    supportingCast ? `关键配角「${supportingCast}」将持续施压并提供镜像` : "关键配角会承担推动与对照作用",
    conflictCore ? `核心冲突是${conflictCore}` : "核心冲突围绕选择、代价与自我更新展开",
    novelOutline ? `故事推进会沿着${novelOutline}逐步递进` : "故事推进会不断把主角推入更高强度的选择",
    worldPremise ? `世界规则限制来自${worldPremise}` : "世界规则会持续放大主角的代价感",
    settingNotes ? `补充约束包括${settingNotes}` : "补充约束会把人物变化压进具体事件里",
  ].join("。");
  return [
    "# 人物弧光",
    "",
    "## 核心弧光",
    arcSummary || "主角将从被动承受转向主动承担，并在反复试错中完成认知更新。",
    "",
    "## 起点状态",
    protagonist ? `- 主角起点：${protagonist}` : "- 主角起点：主角仍停留在被动应对阶段。",
    supportingCast ? `- 关键配角：${supportingCast}` : "- 关键配角：关键配角将作为压力源与镜像角色。",
    conflictCore ? `- 核心冲突映射：${conflictCore}` : "- 核心冲突映射：冲突将迫使主角修正旧信念。",
    "",
    "## 成长转折",
    novelOutline ? `- 故事推进：${novelOutline}` : "- 故事推进：成长会通过连续事件逐步推进。",
    worldPremise ? `- 世界规则压力：${worldPremise}` : "- 世界规则压力：规则压力会不断把选择成本抬高。",
    settingNotes ? `- 补充设定约束：${settingNotes}` : "- 补充设定约束：补充约束会确保转折可写可演。",
    "",
    "## 终点状态",
    arc ? `- 弧光落点：${arc}` : "- 弧光落点：主角最终会形成更稳定的新信念。",
  ].join("\n");
}

export function buildRelationshipMapMarkdownDraft(draft: Partial<BookCreationDraft>): string {
  const protagonist = draft.protagonist?.trim() || "";
  const supportingCast = draft.supportingCast?.trim() || "";
  const characterMatrix = draft.characterMatrix?.trim() || "";
  const relationshipMap = draft.relationshipMap?.trim() || "";
  const conflictCore = draft.conflictCore?.trim() || "";
  const protagonistLabel = protagonist || "主角";
  const keyRoleLabel = supportingCast || "关键角色";
  const conflictLabel = conflictCore || "共同利益、旧债与立场冲突";
  const hiddenLabel = characterMatrix || relationshipMap || "尚未公开的旧案、把柄或身份秘密";
  return [
    "# 人物关系",
    "",
    "## 核心关系",
    `${protagonistLabel} → ${keyRoleLabel}：表面关系只是合作、同门或利益互换，真实关系要能牵动主线走向，并让双方在依赖与提防之间反复拉扯。`,
    "",
    "## 对立关系",
    `${protagonistLabel} → 对手角色：双方的冲突不只是立场相反，还要围绕 ${conflictLabel} 持续升级，并反复逼迫主角做选择。`,
    "",
    "## 隐藏联系",
    `${keyRoleLabel} → 秘密线索：人物之间至少要埋一条暂时不能公开的联系，例如 ${hiddenLabel}，后续揭露时要能直接改变关系判断。`,
    "",
    "## 潜在冲突",
    `${protagonistLabel} 发现真相：当隐藏联系或旧债曝光后，当前联盟、亲密或信任关系必须被重新洗牌，并直接推动下一阶段剧情。`,
  ].join("\n");
}

function hasMeaningfulWizardBullet(content: string): boolean {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => {
      if (!/^[-*]\s+/.test(line)) return false;
      if (/^[-*]\s*[-—–…\.]+$/.test(line)) return false;
      if (/^[-*]\s*[^:：]+[:：]\s*[-—–…\.]+$/.test(line)) return false;
      return /[^\s\-—–…\.]/.test(line);
    });
}

function countMeaningfulWizardBullets(content: string): number {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!/^[-*]\s+/.test(line)) return false;
      if (/^[-*]\s*[-—–…\.]+$/.test(line)) return false;
      if (/^[-*]\s*[^:：]+[:：]\s*[-—–…\.]+$/.test(line)) return false;
      return /[^\s\-—–…\.]/.test(line);
    }).length;
}

function countMeaningfulRelationEntries(content: string): number {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /.+\s*→\s*.+[：:].+/.test(line) || /^[^-#\s][^：:]{1,40}[：:]\s*.+/.test(line))
    .length;
}

function hasArcSpecificBodyContent(content: string): boolean {
  const trimmed = content.trim();
  const requiredSections = [
    "核心弧光",
    "起点状态",
    "成长转折",
    "终点状态",
  ];
  const requiredDetails = [
    "性格缺陷",
    "内心恐惧",
    "错误信念",
    "触发事件",
    "内心挣扎",
    "觉醒时刻",
    "持续考验",
    "性格蜕变",
    "克服恐惧",
    "新信念",
    "残留痕迹",
  ];
  return requiredSections.every((section) => trimmed.includes(section))
    && requiredDetails.filter((detail) => trimmed.includes(detail)).length >= 8
    && countMeaningfulWizardBullets(trimmed) >= 3;
}

function hasRelationSpecificBodyContent(content: string): boolean {
  const trimmed = content.trim();
  const requiredSections = [
    "核心关系",
    "对立关系",
    "隐藏联系",
    "潜在冲突",
  ];
  return requiredSections.every((section) => trimmed.includes(section))
    && /(冲突|转折|试探|绑定|分化|重组|推进|背叛|联盟|隐瞒|真相|旧债|威胁)/.test(trimmed)
    && countMeaningfulRelationEntries(trimmed) >= 4;
}

function isScaffoldOnlyArc(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return (
    /^#\s*人物弧光$/m.test(trimmed)
    && /^##\s*核心弧光$/m.test(trimmed)
    && /^##\s*起点状态$/m.test(trimmed)
    && /^##\s*成长转折$/m.test(trimmed)
    && /^##\s*终点状态$/m.test(trimmed)
    && !/具体|事件|冲突|代价|选择|转折|变化|成长|弧光|关系|人际|关键/.test(trimmed)
  );
}

function isScaffoldOnlyRelation(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return (
    /^#\s*人物关系$/m.test(trimmed)
    && /^##\s*核心关系$/m.test(trimmed)
    && /^##\s*对立关系$/m.test(trimmed)
    && /^##\s*隐藏联系$/m.test(trimmed)
    && /^##\s*潜在冲突$/m.test(trimmed)
    && countMeaningfulRelationEntries(trimmed) === 0
  );
}

export const STEP_MARKDOWN_SPECS: Readonly<Record<Exclude<BookCreationWizardStep, "intro">, StepMarkdownSpec>> = {
  world: {
    title: "世界观",
    description: "只编辑当前页内容，默认以 Markdown 预览显示。",
    sections: [
      { key: "worldPremise", title: "世界观", placeholder: "世界观：..." },
      { key: "settingNotes", title: "补充设定", placeholder: "补充设定：..." },
    ],
  },
  outline: {
    title: "小说大纲",
    description: "只编辑当前页内容，默认以 Markdown 预览显示。",
    sections: [
      { key: "novelOutline", title: "大纲", placeholder: "大纲：..." },
      { key: "conflictCore", title: "核心冲突", placeholder: "核心冲突：..." },
    ],
  },
  volume: {
    title: "卷纲规划",
    description: "只编辑当前页内容，默认以 Markdown 预览显示。",
    sections: [
      { key: "volumeOutline", title: "卷纲方向", placeholder: "卷纲：..." },
    ],
  },
  characters: {
    title: "主角 / 配角",
    description: "只编辑当前页内容，默认以 Markdown 预览显示。",
    sections: [
      { key: "protagonist", title: "主角", placeholder: "主角：..." },
      { key: "supportingCast", title: "配角", placeholder: "配角：..." },
      { key: "characterMatrix", title: "角色矩阵", placeholder: "角色矩阵：..." },
    ],
  },
  arc: {
    title: "人物弧光",
    description: "只编辑当前页内容，默认以 Markdown 预览显示。",
    sections: [
      { key: "characterArc", title: "人物弧光", placeholder: "人物弧光：..." },
    ],
  },
  relation: {
    title: "人物关系",
    description: "只编辑当前页内容，默认以 Markdown 预览显示。",
    sections: [
      { key: "relationshipMap", title: "人物关系", placeholder: "人物关系：..." },
    ],
  },
};

export function getStepMarkdownSpec(step: Exclude<BookCreationWizardStep, "intro">): StepMarkdownSpec {
  return STEP_MARKDOWN_SPECS[step];
}

export function buildWizardStepRegenerationInstruction(params: {
  readonly step: Exclude<BookCreationWizardStep, "intro">;
  readonly title: string;
  readonly language: "zh" | "en";
}): string {
  const wizardFile = WIZARD_STEP_FILE_NAMES[params.step];
  if (params.step === "outline") {
    return params.language === "zh"
      ? `请从头重生成当前${params.title}页正文，只重写这一页，不要修改其他页面，也不要参考当前页原文。\n\n严格要求：\n1. 只输出可直接写入 wizard/${wizardFile} 的 Markdown 正文。\n2. 禁止输出“已重写”“已保存”“相比原内容”“未改动其他页面”等说明、总结、汇报文字。\n3. 必须直接从 Markdown 标题或正文开始，不要写前言和结尾说明。\n4. 内容应围绕主线结构、成长路、章节卡点、核心冲突展开，结构清晰。\n5. 不要复述当前页原文，不要说明当前页是否已经完整。\n\n【当前页】${params.title}`
      : `Please fully regenerate the current ${params.title} page only and do not modify other pages. Rewrite the body from scratch and do not use the current page text as a reference.\n\nStrict requirements:\n1. Output only Markdown body that can be written directly into wizard/${wizardFile}.\n2. Do not include explanations, summaries, status notes, or phrases like rewritten/saved/compared to the original.\n3. Start directly with Markdown headings or body content.\n4. Focus on the main line, growth path, chapter beats, and core conflict.\n5. Do not repeat the current page text or say the page is already complete.\n\n[Current Page] ${params.title}`;
  }

  return params.language === "zh"
    ? `请从头重生成当前${params.title}页正文，只重写这一页，保持 Markdown 结构清晰，不要修改其他页面，也不要参考当前页原文。\n\n请直接输出可写入 wizard/${wizardFile} 的 Markdown 正文。\n\n【当前页】${params.title}`
    : `Please fully regenerate the current ${params.title} page only. Keep the Markdown structure clear, ignore the current text, and do not modify other pages.\n\nOutput Markdown body that can be written directly into wizard/${wizardFile}.\n\n[Current Page] ${params.title}`;
}

export function buildStepMarkdownDraft(
  step: Exclude<BookCreationWizardStep, "intro">,
  draft: Partial<BookCreationDraft>,
  language: "zh" | "en",
): string {
  return buildWizardStepSeedText(step, draft, language);
}

const WIZARD_SUMMARY_LANGUAGE_PATTERN = /已重写|已保存|相较|相比|本次|说明|总结|汇报|未改动其他任何页面|只重写这一页|仅重写|重新生成|已写入/i;

export function isWizardNavigationLocked(params: {
  readonly loadingDraft: boolean;
  readonly loading: boolean;
  readonly creating: boolean;
  readonly isAdvancing: boolean;
  readonly isAutoCompleting: boolean;
  readonly isRegenerating: boolean;
  readonly isAutoGeneratingPage: boolean;
  readonly stopping: boolean;
}): boolean {
  return params.loadingDraft
    || params.loading
    || params.creating
    || params.isAdvancing
    || params.isAutoCompleting
    || params.isRegenerating
    || params.isAutoGeneratingPage
    || params.stopping;
}

export function shouldAutoGenerateWizardStepBody(params: {
  readonly currentStep: BookCreationWizardStep;
  readonly loadingDraft: boolean;
  readonly loading: boolean;
  readonly isAdvancing: boolean;
  readonly isAutoCompleting: boolean;
  readonly isRegenerating: boolean;
  readonly isAutoGeneratingPage: boolean;
  readonly hydrationStatus?: WizardStepHydrationStatus;
  readonly latestBody?: string | null;
  readonly persisted?: string | null;
}): boolean {
  if (params.currentStep === "intro") return false;
  if (params.loadingDraft || params.loading || params.isAdvancing || params.isAutoCompleting || params.isRegenerating || params.isAutoGeneratingPage) {
    return false;
  }
  if (params.hydrationStatus !== "loaded") return false;
  if ((params.latestBody?.trim() ?? "").length > 0) return false;
  if ((params.persisted?.trim() ?? "").length > 0) return false;
  return true;
}

const WIZARD_PREAMBLE_PATTERN = /^(我来|我先|先来|首先|接下来|由于|根据|基于|让我|让我们|分析|思考|推断|考虑|说明|总结|汇报|处理|正在|将要|计划|下面|如下|为了)/;

function getWizardBodyStartIndex(content: string, step: Exclude<BookCreationWizardStep, "intro">): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    if (looksLikeWizardStepMarkdown(step, lines.slice(i).join("\n"))) {
      return i;
    }
  }
  return -1;
}

export function stripWizardPreamble(
  step: Exclude<BookCreationWizardStep, "intro">,
  content: string,
): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;
  if (looksLikeWizardStepMarkdown(step, trimmed)) return trimmed;

  const startIndex = getWizardBodyStartIndex(trimmed, step);
  if (startIndex <= 0) return trimmed;

  const prefixLines = trimmed.split(/\r?\n/).slice(0, startIndex).filter((line) => line.trim().length > 0);
  const hasPreambleSignal = prefixLines.some((line) =>
    WIZARD_PREAMBLE_PATTERN.test(line.trim())
    || /思考|分析|根据|基于|推断|先看|先审|我会|我将|打算|计划|说明|总结|汇报|确认|看看/.test(line),
  );
  if (!hasPreambleSignal) return trimmed;

  return trimmed.split(/\r?\n/).slice(startIndex).join("\n").trim();
}

export function looksLikeOutlineMarkdown(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^(已|本次|相比原内容|未改动|仅重写|重新生成)/m.test(trimmed)) return false;
  const headingCount = (trimmed.match(/^#{1,6}\s+/gm) ?? []).length;
  const hasVolumeOrChapterMarkers = /(^|\n)\s*(##+|\d+\.)\s*(第[一二三四五六七八九十0-9]+卷|卷[一二三四五六七八九十0-9]+|第[一二三四五六七八九十0-9]+章|章节|章节区间|核心主题|关键剧情节点|人物成长主线|节奏与爽感分布|创作原则)/m.test(trimmed);
  const hasSummaryLanguage = WIZARD_SUMMARY_LANGUAGE_PATTERN.test(trimmed);
  return (headingCount >= 1 || hasVolumeOrChapterMarkers) && !hasSummaryLanguage;
}

export function looksLikeWizardStepMarkdown(
  step: Exclude<BookCreationWizardStep, "intro">,
  content: string,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (WIZARD_SUMMARY_LANGUAGE_PATTERN.test(trimmed)) return false;

  switch (step) {
    case "outline":
      return looksLikeOutlineMarkdown(trimmed);
    case "world":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(世界观|补充设定|World premise|Setting notes)/m.test(trimmed) || trimmed.length >= 40;
    case "volume":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(卷纲|第[一二三四五六七八九十0-9]+卷|Volume)/m.test(trimmed) || trimmed.length >= 40;
    case "characters":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(主角|配角|角色矩阵|Protagonist|Supporting cast|Character matrix)/m.test(trimmed) || trimmed.length >= 40;
    case "arc":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(人物弧光|Character arc)/m.test(trimmed)
        && /(^|\n)\s*(###|##|[-*]|\d+\.)\s*(核心弧光|起点状态|成长转折|终点状态|主角弧光|成长阶段详解|主角起点|关键配角|核心冲突映射|故事推进|世界规则压力|补充设定约束|弧光落点)/m.test(trimmed)
        && hasMeaningfulWizardBullet(trimmed)
        && hasArcSpecificBodyContent(trimmed)
        && !isScaffoldOnlyArc(trimmed);
    case "relation":
      return (
        (/(\n|^)\s*(#|##|###)?\s*(人物关系|Relationship map)/m.test(trimmed)
          && /(^|\n)\s*(###|##|[-*]|\d+\.)\s*(核心关系|对立关系|隐藏联系|潜在冲突|Core relationships|Opposing relationships|Hidden links|Potential conflicts)/m.test(trimmed)
          && countMeaningfulRelationEntries(trimmed) >= 2
          && hasRelationSpecificBodyContent(trimmed)
          && !isScaffoldOnlyRelation(trimmed))
        || (
          !isScaffoldOnlyRelation(trimmed)
          && countMeaningfulRelationEntries(trimmed) >= 2
          && /(冲突|转折|试探|绑定|分化|重组|推进|背叛|联盟|隐瞒|真相|旧债|威胁|关系)/.test(trimmed)
        )
      );
    default:
      return trimmed.length >= 20;
  }
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

  const dedupeCandidates = (items: ReadonlyArray<{
    readonly title: string;
    readonly blurb: string;
    readonly storyBackground: string;
    readonly hook?: string;
    readonly style?: string;
    readonly reason?: string;
  }>): ReadonlyArray<{
    readonly title: string;
    readonly blurb: string;
    readonly storyBackground: string;
    readonly hook?: string;
    readonly style?: string;
    readonly reason?: string;
  }> => {
    const seen = new Set<string>();
    const merged: Array<{
      readonly title: string;
      readonly blurb: string;
      readonly storyBackground: string;
      readonly hook?: string;
      readonly style?: string;
      readonly reason?: string;
    }> = [];
    for (const item of items) {
      const key = `${item.title}|${item.blurb}|${item.storyBackground}`.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  };

  const fencedSegments = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((segment): segment is string => Boolean(segment));
  const parsedFencedSegments = fencedSegments.flatMap((segment) => parseJsonPayload(segment));
  if (parsedFencedSegments.length > 0) {
    return dedupeCandidates(parsedFencedSegments);
  }

  const mergedJsonSegments: Array<{
    readonly title: string;
    readonly blurb: string;
    readonly storyBackground: string;
    readonly hook?: string;
    readonly style?: string;
    readonly reason?: string;
  }> = [];
  for (const segment of extractJsonSegments(source)) {
    const parsedSegment = parseJsonPayload(segment);
    if (parsedSegment.length > 0) {
      mergedJsonSegments.push(...parsedSegment);
    }
  }
  if (mergedJsonSegments.length > 0) {
    return dedupeCandidates(mergedJsonSegments);
  }

  const parsedWholeJson = parseJsonPayload(source);
  if (parsedWholeJson.length > 0) return dedupeCandidates(parsedWholeJson);

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

  if (parsedBlocks.length > 0) return dedupeCandidates(parsedBlocks);

  return [];
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

export function normalizeIntroCandidateMessageForDisplay(raw: string): string {
  const parsed = parseIntroCandidateResponse(raw);
  if (parsed.length === 0) return raw;
  const normalized = parsed.map((candidate) => ({
    title: candidate.title,
    blurb: candidate.blurb,
    storyBackground: candidate.storyBackground,
    ...(candidate.style ? { style: candidate.style } : {}),
    ...(candidate.reason ? { reason: candidate.reason } : {}),
    ...(candidate.hook ? { hook: candidate.hook } : {}),
  }));
  return `\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\``;
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

export function buildChatActionLabels(step: BookCreationWizardStep, _nextStepTitle: string | undefined, language: "zh" | "en"): ChatActionLabels {
  if (language === "en") {
    return {
      advanceLabel: step === "relation"
        ? "Finish creation"
        : "Confirm and enter next step",
      createLabel: "Finish creation",
    };
  }

  return {
    advanceLabel: step === "relation"
      ? "完成创建"
      : `确认并进入 ${_nextStepTitle ?? "下一步"}`,
    createLabel: "完成创建",
  };
}

export function buildChatGuide(step: BookCreationWizardStep, language: "zh" | "en"): ChatGuide {
  const currentMeta = WIZARD_STEPS.find((item) => item.id === step) ?? WIZARD_STEPS[0]!;
  if (language === "en") {
    return {
      placeholder: step === "relation"
        ? "Complete the relationship page, then finish creation directly."
        : `Refine the current ${currentMeta.title} page with AI.`,
      examples: step === "intro"
        ? ["Generate several candidate blurbs by genre.", "Use the chat to polish the intro seed."]
        : ["Refine the current page only.", "Confirm and move forward when the draft is ready."],
      advanceLabel: step === "relation" ? "Finish creation" : "Confirm current page and move to next step",
    };
  }

  return {
    placeholder: step === "relation"
      ? "完成人物关系页后，直接完成创建。"
      : step === "intro"
        ? "围绕题材、卖点、故事背景继续修订，优先只改这一页。"
        : `围绕当前${currentMeta.title}页继续修订，优先只改这一页。`,
    examples: step === "intro"
      ? ["按题材生成 3-5 套简介候选池。", "把一句话卖点改得更抓人。"]
      : step === "relation"
        ? ["完成关系动力后，直接完成创建。", "只补当前人物关系页，不改其他页。"]
        : ["只优化当前页面内容。", "若已完成，可直接进入下一步。"],
    advanceLabel: step === "relation" ? "完成创建" : "确认当前页并进入下一步",
  };
}

export function buildBookCreateCommand(params: {
  readonly kind: "intro-generate" | "intro-revise" | "intro-polish" | "params" | "advance" | "create" | "discard" | "back" | "goto" | "save";
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
        label: language === "en" ? "Generate intro" : "生成正式简介",
        disabled: !theme && !genre,
        instruction: buildIntroCandidateGenerationInstruction({
          language,
          title,
          genre,
          platform,
          theme,
          introBlurb,
          introStoryBackground,
          candidateCount,
        }),
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

export function buildIntroCandidateGenerationInstruction(params: {
  readonly language: "zh" | "en";
  readonly title?: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly theme?: string;
  readonly introBlurb?: string;
  readonly introStoryBackground?: string;
  readonly candidateCount?: number;
}): string {
  const { language, title, genre, platform, theme, introBlurb, introStoryBackground, candidateCount } = params;
  const count = candidateCount && candidateCount > 0 ? candidateCount : 3;
  if (language === "en") {
    return `/intro-candidates Generate ${count} intro candidates for the current book. Output only the candidate pool and do not start book creation.\n\n[Title] ${title || "unset"}\n[Genre] ${genre || "unset"}\n[Theme] ${theme || genre || "unset"}\n[Platform] ${platform || "unset"}\n[Current Blurb] ${introBlurb || "(empty)"}\n[Current Story Background] ${introStoryBackground || "(empty)"}\n\nRequired output format:\n[\n  {\n    "title": "Candidate title",\n    "blurb": "One-line hook / blurb",\n    "storyBackground": "Story background seed",\n    "style": "Distinct style note",\n    "reason": "Why this candidate is useful"\n  }\n]\n\nRules:\n1. Return valid JSON array only. No prose, no markdown, no code fences.\n2. Every candidate must contain title, blurb, storyBackground, style, and reason.\n3. blurb and storyBackground are both required for every candidate.\n4. Candidates must be meaningfully different in tone or angle.\n5. Do not wrap JSON in markdown fences.\n6. After the JSON, do not add any extra explanation.`;
  }

  return `/intro-candidates 请按题材和主题生成${count} 套简介候选，只输出候选池，不要直接进入建书。\n\n【书名】${title || "未填"}\n【题材】${genre || "未选"}\n【主题】${theme || genre || "未填"}\n【平台】${platform || "未选"}\n【当前简介】${introBlurb || "（空）"}\n【当前故事背景】${introStoryBackground || "（空）"}\n\n【输出格式】只输出一个 JSON 数组，禁止输出说明文字、Markdown、代码块。\n[\n  {\n    "title": "候选标题",\n    "blurb": "一句话简介 / 卖点",\n    "storyBackground": "故事背景种子",\n    "style": "风格说明",\n    "reason": "为什么这个候选有价值"\n  }\n]\n\n【要求】\n1. 每个候选必须同时包含 title、blurb、storyBackground、style、reason。\n2. blurb 和 storyBackground 都是必填项，不能缺失。\n3. 候选之间风格或切入角度必须明显不同。\n4. 数量必须是 ${count} 套。\n5. 不要使用 Markdown 代码块包裹 JSON。\n6. 输出后不要附加任何额外解释。`;
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

  return [
    {
      kind: "revise",
      label: nextStepTitle
        ? (language === "en" ? `Continue to ${nextStepTitle}` : `推进到${nextStepTitle}`)
        : (language === "en" ? "Finalize current step" : "完成当前页"),
      value: language === "en"
        ? (nextStepTitle ? "Keep the current step aligned with the next page." : "Make the current step ready for final creation.")
        : (nextStepTitle ? `保持当前页和${nextStepTitle}一致。` : "把当前页补齐到可直接完成创建。"),
    },
    {
      kind: "create",
      label: language === "en" ? "Finish creation" : "完成创建",
      value: language === "en"
        ? "Finish the book creation after the current step is complete."
        : "当前页完成后，直接结束建书并进入书籍编辑。",
    },
  ];
}

export function buildStepActionSections(
  step: BookCreationWizardStep,
  focusCard: StepFocusCard,
  nextStepTitle: string | undefined,
  language: "zh" | "en",
): ReadonlyArray<StepActionSection> {
  const shortcuts = buildStepShortcuts(step, focusCard, nextStepTitle, language);
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
  if (params.step === "relation" && params.canCreate) {
    const create = shortcuts.find((item) => item.kind === "create") ?? shortcuts[shortcuts.length - 1]!;
    return {
      shortcut: create,
      reason: params.language === "en" ? "Use the current page's primary action to finish creation." : "优先执行当前页的主动作，直接完成创建。",
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

