import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookCreationDraft, BookCreationWizardState, BookCreationWizardStep } from "@actalk/inkos-core";
import { ApiRequestError, fetchJson, postApi, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { chatSelectors, useChatStore } from "../store/chat";
import { useServiceStore } from "../store/service";
import { usePersistedModelSelection } from "../hooks/use-persisted-model-selection";
import type { Message as ChatMessageType } from "../store/chat/types";
import {
  filterModelGroups,
  resolveModelSelection,
  resolvePersistedModelSelection,
  type PersistedModelSelection,
} from "./chat-page-state";
import { BookCreateChatDock, IntroPanel, StepValidationBanner, WizardActions, WizardHeader } from "./book-create-panels";
import { StepMarkdownEditor } from "./StepMarkdownEditor";
import {
  buildChatActionLabels,
  buildChatGuide,
  buildChatQuickTemplates,
  buildConceptSplitSummary,
  buildCreationDraftSummary,
  buildCreationReviewChecklist,
  buildHardParamsSummary,
  buildIntroCandidateGenerationInstruction,
  buildBookCreateCommand,
  buildStepActionSections,
  buildStepFocusCard,
  buildStepRecommendedAction,
  buildStepShortcuts,
  buildStepValidationReport,
  buildWizardStepRegenerationInstruction,
  buildWizardValidationReports,
  buildIntroCandidateBackfill,
  buildStepMarkdownDraft,
  buildIntroMarkdownDraft,
  looksLikeIntroBodyMarkdown,
  normalizeIntroMarkdownCandidate,
  resolveCanonicalIntroMarkdown,
  resolveIntroMarkdownEditorContent,
  resolvePreferredIntroMarkdown,
  getStepMarkdownSpec,
  mergeCreationWizardState,
  isWizardNavigationLocked,
  resolveIntroCandidateTitle,
  composeIntroSeedText,
  buildWizardStepSeedText,
  stripWizardPreamble,
  resolveWizardStepDisplayContent,
  resolveBookCreationResumeStep,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  explainManualWizardStepContentIssue,
  hasMeaningfulIntroMarkdown,
  hasMeaningfulManualWizardStepContent,
  hasMeaningfulWizardStepContent,
  looksLikeWizardStepMarkdown,
  parseIntroCandidateResponse,
  parseLatestIntroCandidates,
  parseIntroSeedText,
  buildIntroExpansionSeedText,
  parsePositiveIntegerInput,
  mergeWizardStepContentIntoDraft,
  normalizeIntroCandidateMessageForDisplay,
  platformOptionsForLanguage,
  pickValidValue,
  rankIntroCandidates,
  type StepShortcut,
  resolveDraftInstruction,
  resolveBookCreateGenreSelection,
  resolveGenreMapping,
  resolveInitialGenreSelection,
  resolveIntroGenerationState,
  selectBookCreateDockMessages,
  shouldAutoSyncVisibleWizardStep,
  shouldSyncWizardStep,
  shouldAutoGenerateWizardStepBody,
  shouldSubmitChatOnKeyDown,
  waitForBookReady,
  WIZARD_STEPS,
  WIZARD_STEP_FILE_NAMES,
  type IntroCandidateLike,
  type StepValidationReport,
  type WizardStepHydrationStatus,
} from "./book-create-state";
import { clearBookCreateSessionId, getBookCreateSessionId, setBookCreateSessionId } from "./chat-page-state";
import { resolvePersistedDraftSessionId, resolveWizardStepsToPrefetch } from "../utils/book-creation-routing";

export {
  buildChatActionLabels,
  buildChatGuide,
  buildChatQuickTemplates,
  buildConceptSplitSummary,
  buildCreationDraftSummary,
  buildCreationReviewChecklist,
  buildHardParamsSummary,
  buildStepActionSections,
  buildStepFocusCard,
  buildStepRecommendedAction,
  buildStepShortcuts,
  buildWizardValidationReports,
  buildIntroCandidateBackfill,
  mergeWizardStepContentIntoDraft,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  parseIntroCandidateResponse,
  parseLatestIntroCandidates,
  parsePositiveIntegerInput,
  normalizeIntroCandidateMessageForDisplay,
  platformOptionsForLanguage,
  pickValidValue,
  rankIntroCandidates,
  resolveIntroGenerationState,
  selectBookCreateDockMessages,
  shouldAutoSyncVisibleWizardStep,
  resolveDraftInstruction,
  resolveGenreMapping,
  resolveInitialGenreSelection,
  shouldSubmitChatOnKeyDown,
  waitForBookReady,
} from "./book-create-state";

interface Nav {
  toDashboard: () => void;
  toBook: (id: string) => void;
  toServices: () => void;
  toBookCreate?: (bookId?: string) => void;
}

interface AgentResponse {
  readonly response?: string;
  readonly error?: string;
  readonly details?: {
    readonly draftRaw?: string;
    readonly creationDraft?: BookCreationDraft;
    readonly creationWizard?: BookCreationWizardState;
    readonly activeBookId?: string;
  };
  readonly session?: {
    readonly activeBookId?: string;
    readonly creationDraft?: BookCreationDraft;
    readonly creationWizard?: BookCreationWizardState;
  };
}

interface SessionListResponse {
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string;
  }>;
}

interface BlockedPromptState {
  readonly title: string;
  readonly message: string;
}

interface WizardStepFilePayload {
  readonly step: BookCreationWizardStep;
  readonly content: string;
  readonly status: "empty" | "saved" | "dirty";
  readonly version: number;
  readonly updatedAt?: string;
}

interface BookCreationSummary {
  readonly shellCreated: boolean;
  readonly wizardCompleted: boolean;
  readonly currentStep: BookCreationWizardStep;
  readonly resumeStep: BookCreationWizardStep;
  readonly completedSteps: ReadonlyArray<BookCreationWizardStep>;
  readonly completedCount: number;
  readonly totalSteps: number;
}

interface BookResumePayload {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly platform: string;
    readonly targetChapters?: number;
    readonly chapterWordCount: number;
    readonly language?: "zh" | "en";
  };
  readonly creation: BookCreationSummary;
}

function normalizeTextValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function resolveIntroRevisionBookId(
  activeBookId: string | null,
  ensureBookShell: () => Promise<string | null>,
): Promise<string | null> {
  return activeBookId ?? await ensureBookShell();
}

export function shouldPersistIntroStepOnAutoSave(activeBookId: string | null, step: BookCreationWizardStep): boolean {
  if (!activeBookId) return false;
  return step !== "intro";
}

export function shouldAllowManualStepSave(step: BookCreationWizardStep): boolean {
  return step !== "intro";
}

function extractWizardStepContent(response: AgentResponse | null, step: BookCreationWizardStep, language: "zh" | "en"): string {
  const draft = response?.session?.creationDraft ?? response?.details?.creationDraft;
  const raw = response?.details?.draftRaw?.trim() || "";
  if (step === "arc" || step === "relation") {
    return raw;
  }
  if (step === "volume" && draft?.volumeOutline?.trim()) {
    return draft.volumeOutline.trim();
  }
  if (step === "characters" && (draft?.protagonist?.trim() || draft?.supportingCast?.trim() || draft?.characterMatrix?.trim())) {
    return [
      draft?.protagonist ? `主角：${draft.protagonist.trim()}` : "",
      draft?.supportingCast ? `配角：${draft.supportingCast.trim()}` : "",
      draft?.characterMatrix ? `角色矩阵：${draft.characterMatrix.trim()}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (step === "outline" && (draft?.novelOutline?.trim() || draft?.conflictCore?.trim())) {
    return [
      draft?.novelOutline ? `大纲：${draft.novelOutline.trim()}` : "",
      draft?.conflictCore ? `核心冲突：${draft.conflictCore.trim()}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (step === "world" && (draft?.worldPremise?.trim() || draft?.settingNotes?.trim())) {
    return [
      draft?.worldPremise ? `世界观：${draft.worldPremise.trim()}` : "",
      draft?.settingNotes ? `补充设定：${draft.settingNotes.trim()}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (step === "intro") {
    return draft?.draftFields?.introMarkdown?.trim()
      || response?.response?.trim()
      || buildIntroMarkdownDraft(draft ?? {}, language);
  }
  if (raw) return raw;
  return buildStepMarkdownDraft(step as Exclude<BookCreationWizardStep, "intro">, draft ?? {}, language);
}

function resolveWizardStepSaveContent(
  response: AgentResponse | null,
  step: Exclude<BookCreationWizardStep, "intro">,
  language: "zh" | "en",
): string {
  const raw = response?.details?.draftRaw?.trim() || response?.response?.trim() || "";
  const normalizedRaw = raw ? stripWizardPreamble(step, raw) : "";
  if (normalizedRaw && looksLikeWizardStepMarkdown(step, normalizedRaw)) return normalizedRaw;
  const draft = response?.session?.creationDraft ?? response?.details?.creationDraft;
  const extracted = stripWizardPreamble(step, extractWizardStepContent(response, step, language).trim());
  if (extracted && looksLikeWizardStepMarkdown(step, extracted)) return extracted;
  if (step === "volume" && draft?.volumeOutline?.trim()) return draft.volumeOutline.trim();
  if (step === "characters" && (draft?.protagonist?.trim() || draft?.supportingCast?.trim() || draft?.characterMatrix?.trim())) {
    return [
      draft?.protagonist ? `主角：${draft.protagonist.trim()}` : "",
      draft?.supportingCast ? `配角：${draft.supportingCast.trim()}` : "",
      draft?.characterMatrix ? `角色矩阵：${draft.characterMatrix.trim()}` : "",
    ].filter(Boolean).join("\n\n");
  }
  return "";
}

function resolveRegeneratedWizardStepContent(
  response: AgentResponse | null,
  step: Exclude<BookCreationWizardStep, "intro">,
  language: "zh" | "en",
): string {
  const raw = response?.details?.draftRaw?.trim() || response?.response?.trim() || "";
  if (!raw) return "";
  if (!looksLikeWizardStepMarkdown(step, raw)) return "";
  return raw;
}

function resolveLatestAssistantWizardStepContent(
  sessionId: string | null,
  step: Exclude<BookCreationWizardStep, "intro">,
): string {
  if (!sessionId) return "";
  const session = useChatStore.getState().sessions[sessionId];
  const latest = [...(session?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.wizardStep === step);
  return latest?.content?.trim() || "";
}

function isEmptyWizardBody(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bodyLines = lines.filter((line) => !/^#{1,6}\s+/.test(line));
  if (bodyLines.length === 0) return true;
  return bodyLines.every((line) => /^[-*]\s*[-—–…\.]+$/.test(line) || /^[-*]\s*[:：]?\s*$/.test(line) || line === "-" || line === "—" || line === "…" || line === "...");
}

interface BookCreateSessionRequest {
  readonly intent: "select_intro_candidate" | "set_book_draft_params";
  readonly title?: string;
  readonly genre?: string;
  readonly genreName?: string;
  readonly genreAlias?: string;
  readonly genreSource?: "builtin" | "project" | "custom";
  readonly language?: "zh" | "en";
  readonly platform?: string;
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly candidateIndex?: number;
  readonly candidateCount?: number;
  readonly themeGenre?: string;
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly instruction?: string;
}

interface BookCreateWizardControlRequest {
  readonly intent: "save_wizard_step" | "advance_book_wizard" | "goto_book_wizard" | "retreat_book_wizard" | "discard_book_draft";
  readonly language: "zh" | "en";
  readonly stepTitle: string;
  readonly wizardStep: BookCreationWizardStep;
  readonly nextStep?: BookCreationWizardStep;
  readonly title?: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly instruction?: string;
}

type BookCreateDockMessage = Pick<
  ChatMessageType,
  "role" | "content" | "timestamp" | "thinking" | "thinkingStreaming" | "audit" | "toolExecutions"
>;

function hasPersistedWizardStepContent(
  step: BookCreationWizardStep,
  draft: Partial<BookCreationDraft> | undefined,
): boolean {
  if (!draft) return false;
  switch (step) {
    case "intro":
      return Boolean(draft.draftFields?.introMarkdown?.trim() || draft.blurb?.trim() || draft.storyBackground?.trim());
    case "world":
      return Boolean(draft.worldPremise?.trim() || draft.settingNotes?.trim());
    case "outline":
      return Boolean(draft.novelOutline?.trim() || draft.conflictCore?.trim());
    case "volume":
      return Boolean(draft.volumeOutline?.trim());
    case "characters":
      return Boolean(draft.protagonist?.trim() || draft.supportingCast?.trim() || draft.characterMatrix?.trim());
    case "arc":
      return Boolean(draft.characterArc?.trim());
    case "relation":
      return Boolean(draft.relationshipMap?.trim());
    default:
      return false;
  }
}




export function BookCreate({ nav, theme, t, draftSessionId, resumeBookId }: { nav: Nav; theme: Theme; t: TFunction; draftSessionId?: string; resumeBookId?: string }) {
  const c = useColors(theme);
  const { data: project } = useApi<{ language: string }>("/project");
  const { data: genresData } = useApi<{ genres: ReadonlyArray<{ id: string; name: string; language?: string; source?: string }> }>("/genres");
  const projectLang = (project?.language ?? "zh") as "zh" | "en";

  const activeSession = useChatStore(chatSelectors.activeSession);
  const allMessages = useChatStore(chatSelectors.activeMessages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const input = useChatStore((s) => s.input);
  const loading = useChatStore(chatSelectors.isActiveSessionStreaming);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  const setInput = useChatStore((s) => s.setInput);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopMessage = useChatStore((s) => s.stopMessage);
  const replaceWizardStepMessage = useChatStore((s) => s.replaceWizardStepMessage);
  const addErrorMessage = useChatStore((s) => s.addErrorMessage);
  const bumpBookDataVersion = useChatStore((s) => s.bumpBookDataVersion);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchModels = useServiceStore((s) => s.fetchModels);

  const [draft, setDraft] = useState<BookCreationDraft | undefined>();
  const [wizard, setWizard] = useState<BookCreationWizardState | undefined>();
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [blockedPrompt, setBlockedPrompt] = useState<BlockedPromptState | null>(null);
  const [bookTitle, setBookTitle] = useState("");
  const [bookPlatform, setBookPlatform] = useState(platformOptionsForLanguage(projectLang)[0]?.value ?? "");
  const [bookLanguage, setBookLanguage] = useState<"zh" | "en">(projectLang);
  const [bookTargetChapters, setBookTargetChapters] = useState("200");
  const [bookChapterWords, setBookChapterWords] = useState("3000");
  const [bookTargetChaptersTouched, setBookTargetChaptersTouched] = useState(false);
  const [bookChapterWordsTouched, setBookChapterWordsTouched] = useState(false);
  const [selectedGenreId, setSelectedGenreId] = useState("");
  const [introMode, setIntroMode] = useState<"manual" | "auto">("manual");
  const [introSeedText, setIntroSeedText] = useState("");
  const [introBodyDraft, setIntroBodyDraft] = useState("");
  const [introTheme, setIntroTheme] = useState("");
  const [introBodyDirty, setIntroBodyDirty] = useState(false);
  const [introCandidateCount, setIntroCandidateCount] = useState("3");
  const [introCandidates, setIntroCandidates] = useState<ReadonlyArray<IntroCandidateLike>>([]);
  const [selectedIntroCandidateIndex, setSelectedIntroCandidateIndex] = useState(0);
  const [introCandidateLoading, setIntroCandidateLoading] = useState(false);
  const [isIntroGenerationPending, setIsIntroGenerationPending] = useState(false);
  const [introPanelTab, setIntroPanelTab] = useState<"generate" | "body">("generate");
  const [introBodyEditing, setIntroBodyEditing] = useState(false);
  const [introBodySource, setIntroBodySource] = useState<"draft" | "generated">("draft");
  const [stepDrafts, setStepDrafts] = useState<Partial<Record<"intro" | "world" | "outline" | "volume" | "characters" | "arc" | "relation", string>>>({});
  const [persistedStepDrafts, setPersistedStepDrafts] = useState<Partial<Record<"intro" | "world" | "outline" | "volume" | "characters" | "arc" | "relation", string>>>({});
  const [stepEditing, setStepEditing] = useState<Partial<Record<"world" | "outline" | "volume" | "characters" | "arc" | "relation", boolean>>>({});
  const [genreSelectionTouched, setGenreSelectionTouched] = useState(false);
  const [validationPanelStep, setValidationPanelStep] = useState<BookCreationWizardStep | null>(null);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [isAutoCompleting, setIsAutoCompleting] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isStepSaving, setIsStepSaving] = useState(false);
  const [isAutoGeneratingPage, setIsAutoGeneratingPage] = useState(false);
  const [visibleWizardStep, setVisibleWizardStep] = useState<BookCreationWizardStep>("intro");
  const [userRequestedVisibleStep, setUserRequestedVisibleStep] = useState<BookCreationWizardStep | null>(null);
  const [wizardBookId, setWizardBookId] = useState<string | null>(null);
  const [resumeDraftSessionId, setResumeDraftSessionId] = useState<string | null>(null);
  const [wizardStepVersions, setWizardStepVersions] = useState<Partial<Record<BookCreationWizardStep, number>>>({});
  const [wizardStepHydrationStatus, setWizardStepHydrationStatus] = useState<Partial<Record<BookCreationWizardStep, WizardStepHydrationStatus>>>({});
  const wizardGenerationSeqRef = useRef(0);
  const activeWizardStepRef = useRef<BookCreationWizardStep>("intro");
  const bootstrapRouteKeyRef = useRef<string | null>(null);
  const wizardStepHydrationRef = useRef<Partial<Record<BookCreationWizardStep, WizardStepHydrationStatus>>>({});
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWizardStepRef = useRef<BookCreationWizardStep | null>(null);
  const suppressIntroAutoSaveRef = useRef(false);
  const suppressAutoSaveRef = useRef(false);
  const lastAutoSaveContentRef = useRef<Partial<Record<BookCreationWizardStep, string>>>({});
  const wizardStepOrder = useMemo(
    () => new Map(WIZARD_STEPS.map((item, index) => [item.id, index] as const)),
    [],
  );
  const introThemeText = normalizeTextValue(introTheme);

  useEffect(() => {
    activeWizardStepRef.current = visibleWizardStep;
  }, [visibleWizardStep]);

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  const updateWizardStepHydrationStatus = useCallback((step: BookCreationWizardStep, status: WizardStepHydrationStatus) => {
    wizardStepHydrationRef.current = {
      ...wizardStepHydrationRef.current,
      [step]: status,
    };
    setWizardStepHydrationStatus((current) => ({
      ...current,
      [step]: status,
    }));
  }, []);

  const pauseAutoSaveDuring = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    clearAutoSaveTimer();
    suppressAutoSaveRef.current = true;
    setIsAdvancing(true);
    try {
      return await task();
    } finally {
      suppressAutoSaveRef.current = false;
      setIsAdvancing(false);
    }
  }, [clearAutoSaveTimer]);

  const suppressIntroAutoSave = useCallback((enabled: boolean) => {
    suppressIntroAutoSaveRef.current = enabled;
    if (enabled) {
      clearAutoSaveTimer();
    }
  }, [clearAutoSaveTimer]);

  const patchWizardStep = useCallback((nextStep: BookCreationWizardStep, completedStep?: BookCreationWizardStep, fallback?: BookCreationWizardState) => {
    setUserRequestedVisibleStep(null);
    setVisibleWizardStep(nextStep);
    setWizard((current) => {
      const base = current ?? fallback ?? {
        currentStep: nextStep,
        completedSteps: [],
        stepNotes: {},
        updatedAt: Date.now(),
      };
      const completedSteps = new Set(base.completedSteps ?? []);
      if (completedStep) completedSteps.add(completedStep);
      return {
        ...base,
        currentStep: nextStep,
        completedSteps: Array.from(completedSteps),
        updatedAt: Date.now(),
      };
    });
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refreshDraft = useCallback(async (): Promise<void> => {
    if (resumeBookId) {
      return;
    }
    if (!resumeDraftSessionId) {
      setDraft(undefined);
      setWizard(undefined);
      return;
    }
    await loadSessionDetail(resumeDraftSessionId);
    const state = useChatStore.getState();
    const session = state.sessions[resumeDraftSessionId];
    setDraft(session?.creationDraft);
    setWizard((current) => mergeCreationWizardState({
      current,
      fetched: session?.creationWizard,
      pendingStep: pendingWizardStepRef.current,
    }));
  }, [loadSessionDetail, resumeBookId, resumeDraftSessionId]);

  const loadResumeBook = useCallback(async (bookId: string): Promise<void> => {
    const data = await fetchJson<BookResumePayload>(`/books/${encodeURIComponent(bookId)}`);
    setWizardBookId(data.book.id);
    setBookTitle(data.book.title);
    setBookPlatform(data.book.platform);
    setBookLanguage((data.book.language ?? projectLang) as "zh" | "en");
    if (typeof data.book.targetChapters === "number") setBookTargetChapters(String(data.book.targetChapters));
    if (typeof data.book.chapterWordCount === "number") setBookChapterWords(String(data.book.chapterWordCount));
    setDraft((current) => ({
      concept: current?.concept ?? data.book.title,
      title: data.book.title,
      genre: data.book.genre,
      platform: data.book.platform,
      language: data.book.language,
      targetChapters: data.book.targetChapters,
      chapterWordCount: data.book.chapterWordCount,
      missingFields: current?.missingFields ?? [],
      readyToCreate: data.creation.wizardCompleted,
      ...(current?.draftFields ? { draftFields: current.draftFields } : {}),
      ...(current?.blurb ? { blurb: current.blurb } : {}),
      ...(current?.storyBackground ? { storyBackground: current.storyBackground } : {}),
      ...(current?.worldPremise ? { worldPremise: current.worldPremise } : {}),
      ...(current?.settingNotes ? { settingNotes: current.settingNotes } : {}),
      ...(current?.novelOutline ? { novelOutline: current.novelOutline } : {}),
      ...(current?.conflictCore ? { conflictCore: current.conflictCore } : {}),
      ...(current?.volumeOutline ? { volumeOutline: current.volumeOutline } : {}),
      ...(current?.protagonist ? { protagonist: current.protagonist } : {}),
      ...(current?.supportingCast ? { supportingCast: current.supportingCast } : {}),
      ...(current?.characterMatrix ? { characterMatrix: current.characterMatrix } : {}),
      ...(current?.characterArc ? { characterArc: current.characterArc } : {}),
      ...(current?.relationshipMap ? { relationshipMap: current.relationshipMap } : {}),
    }));
    setWizard({
      currentStep: data.creation.currentStep,
      completedSteps: [...data.creation.completedSteps],
      stepNotes: {},
      updatedAt: Date.now(),
    });
    setUserRequestedVisibleStep(null);
    setVisibleWizardStep(data.creation.resumeStep);
  }, [projectLang]);

  useEffect(() => {
    if (activeSession?.bookId) {
      setWizardBookId(activeSession.bookId);
    }
  }, [activeSession?.bookId]);

  useEffect(() => {
    if (!genresData?.genres.length) return;
    const { genreId: nextGenreId } = resolveBookCreateGenreSelection({
      currentGenreId: genreSelectionTouched ? selectedGenreId : "",
      currentSource: genreSelectionTouched ? "manual" : "auto",
      genres: genresData.genres,
      draftGenre: draft?.genre,
      draftGenreAlias: draft?.genreAlias,
      draftMappedGenreId: draft?.mappedGenreId,
      projectLanguage: projectLang,
    });
    if (nextGenreId && nextGenreId !== selectedGenreId) setSelectedGenreId(nextGenreId);
  }, [draft?.genre, draft?.genreAlias, draft?.mappedGenreId, genreSelectionTouched, genresData?.genres, projectLang, selectedGenreId]);

  useEffect(() => {
    const defaultPlatform = platformOptionsForLanguage(bookLanguage)[0]?.value ?? "";
    if (!defaultPlatform) return;
    if (!bookPlatform || !platformOptionsForLanguage(bookLanguage).some((item) => item.value === bookPlatform)) {
      setBookPlatform(defaultPlatform);
    }
  }, [bookLanguage, bookPlatform]);

  useEffect(() => {
    if (draft?.title && !bookTitle) setBookTitle(draft.title);
    if (draft?.platform && !bookPlatform) setBookPlatform(draft.platform);
    if (draft?.language && bookLanguage === projectLang) setBookLanguage(draft.language);
    if (typeof draft?.targetChapters === "number" && !bookTargetChaptersTouched) setBookTargetChapters(String(draft.targetChapters));
    if (typeof draft?.chapterWordCount === "number" && !bookChapterWordsTouched) setBookChapterWords(String(draft.chapterWordCount));
    if ((draft?.blurb || draft?.storyBackground) && !introSeedText) setIntroSeedText(composeIntroSeedText(draft?.blurb ?? "", draft?.storyBackground ?? ""));
    if (draft?.genreAlias && !introThemeText) setIntroTheme(normalizeTextValue(draft.genreAlias));
  }, [bookChapterWordsTouched, bookLanguage, bookChapterWords, bookPlatform, bookTargetChaptersTouched, bookTargetChapters, bookTitle, draft, introSeedText, introThemeText, projectLang]);

  useEffect(() => {
    if (!draft) return;
    setStepDrafts((current) => {
      const next = { ...current };
      const nextBaselines: Partial<Record<BookCreationWizardStep, string>> = {};
      for (const step of WIZARD_STEPS.map((item) => item.id)) {
        if (next[step]) continue;
        const seed = buildWizardStepSeedText(step, draft, projectLang);
        if (seed) {
          next[step] = seed;
          nextBaselines[step] = seed;
        }
      }
      lastAutoSaveContentRef.current = {
        ...lastAutoSaveContentRef.current,
        ...nextBaselines,
      };
      return next;
    });
  }, [draft, projectLang]);

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  useEffect(() => { for (const svc of services) if (svc.connected) void fetchModels(svc.service); }, [services, fetchModels]);
  const { persistedSelection, ready: persistedSelectionReady } = usePersistedModelSelection();

  const groupedModels = useMemo(() => services
    .filter((s) => s.connected && (modelsByService[s.service]?.models.length ?? 0) > 0)
    .map((s) => ({ service: s.service, label: s.label, models: modelsByService[s.service]!.models })), [services, modelsByService]);
  const filteredGroupedModels = useMemo(() => filterModelGroups(groupedModels, ""), [groupedModels]);
  const modelPickerStatus = useMemo(() => {
    if (servicesLoading || services.length === 0) return "loading" as const;
    const connected = services.filter((s) => s.connected);
    if (connected.length === 0) return "no-models" as const;
    if (connected.some((s) => modelsByService[s.service]?.loading)) return "loading" as const;
    return connected.some((s) => (modelsByService[s.service]?.models.length ?? 0) > 0) ? "ready" as const : "no-models" as const;
  }, [modelsByService, services, servicesLoading]);

  useEffect(() => {
    if (!persistedSelectionReady) return;
    const resolvedFromConfig = resolvePersistedModelSelection(groupedModels, persistedSelection);
    if (resolvedFromConfig && (resolvedFromConfig.model !== selectedModel || resolvedFromConfig.service !== selectedService)) {
      setSelectedModel(resolvedFromConfig.model, resolvedFromConfig.service, { persist: false });
      return;
    }
    const resolved = resolveModelSelection(groupedModels, selectedModel, selectedService);
    if (resolved && (resolved.model !== selectedModel || resolved.service !== selectedService)) {
      setSelectedModel(resolved.model, resolved.service, { persist: false });
    }
  }, [groupedModels, persistedSelection, persistedSelectionReady, selectedModel, selectedService, setSelectedModel]);

  useEffect(() => {
    let cancelled = false;
    const bootstrapKey = resumeBookId
      ? `book:${resumeBookId}`
      : (draftSessionId ? `draft:${draftSessionId}` : "new");
    if (bootstrapRouteKeyRef.current === bootstrapKey) {
      return () => { cancelled = true; };
    }
    bootstrapRouteKeyRef.current = bootstrapKey;
    void (async () => {
      if (resumeBookId) {
        await loadResumeBook(resumeBookId);
        if (!cancelled) setResumeDraftSessionId(null);
        if (!cancelled) {
          const sessionId = createDraftSession(resumeBookId);
          if (!cancelled) activateSession(sessionId);
        }
        return;
      }
      if (draftSessionId) {
        let persistedDraftSessionId = draftSessionId;
        try {
          const data = await fetchJson<SessionListResponse>("/sessions?bookId=null");
          persistedDraftSessionId = resolvePersistedDraftSessionId(
            draftSessionId,
            getBookCreateSessionId(),
            data.sessions.map((session) => session.sessionId),
          ) ?? draftSessionId;
        } catch {
          // Fall back to the route-provided draft session id when the session list probe fails.
        }
        await loadSessionDetail(persistedDraftSessionId);
        if (cancelled) return;
        const state = useChatStore.getState();
        const session = state.sessions[persistedDraftSessionId];
        if (session?.bookId === null || session?.bookId === undefined) {
          setBookCreateSessionId(persistedDraftSessionId);
          setResumeDraftSessionId(persistedDraftSessionId);
          activateSession(persistedDraftSessionId);
          return;
        }
      }
      clearBookCreateSessionId();
      if (!cancelled) setResumeDraftSessionId(null);
      const sessionId = createDraftSession(null);
      if (!cancelled) {
        activateSession(sessionId);
      }
    })();
    return () => { cancelled = true; };
  }, [activateSession, createDraftSession, draftSessionId, loadResumeBook, loadSessionDetail, resumeBookId]);

  useEffect(() => {
    if (!activeSessionId || activeSession?.bookId !== null || activeSession?.isDraft) {
      return;
    }
    setBookCreateSessionId(activeSessionId);
    setResumeDraftSessionId(activeSessionId);
  }, [activeSession?.bookId, activeSession?.isDraft, activeSessionId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const currentStep = userRequestedVisibleStep ?? visibleWizardStep;
  const currentStepIndex = Math.max(0, WIZARD_STEPS.findIndex((s) => s.id === currentStep));
  const currentStepMeta = WIZARD_STEPS[currentStepIndex] ?? WIZARD_STEPS[0]!;
  const nextStepMeta = WIZARD_STEPS[currentStepIndex + 1];
  const canGoBack = currentStepIndex > 0;
  const relationStepDraft = currentStep === "relation"
    ? (stepDrafts.relation ?? buildStepMarkdownDraft("relation", draft ?? {}, projectLang))
    : "";
  const effectiveDraft = useMemo<BookCreationDraft | undefined>(() => {
    if (!draft && !bookTitle.trim()) return draft;
    if (!draft) {
      return {
        concept: "",
        missingFields: [],
        readyToCreate: false,
        title: bookTitle.trim() || undefined,
        platform: bookPlatform || undefined,
        language: bookLanguage,
        targetChapters: parsePositiveIntegerInput(bookTargetChapters),
        chapterWordCount: parsePositiveIntegerInput(bookChapterWords),
        ...(relationStepDraft.trim() ? { relationshipMap: relationStepDraft.trim() } : {}),
      };
    }
    return {
      ...draft,
      title: bookTitle.trim() || draft.title,
      platform: bookPlatform || draft.platform,
      language: bookLanguage || draft.language,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft.targetChapters,
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft.chapterWordCount,
      ...(relationStepDraft.trim() ? { relationshipMap: relationStepDraft.trim() } : {}),
    };
  }, [bookChapterWords, bookLanguage, bookPlatform, bookTargetChapters, bookTitle, draft, relationStepDraft]);
  const canCreate = currentStep === "relation" && canCreateFromDraft(effectiveDraft);
  const validationReports = useMemo(() => buildWizardValidationReports(effectiveDraft, projectLang), [effectiveDraft, projectLang]);
  const worldStepDraft = stepDrafts.world ?? buildWizardStepSeedText("world", draft ?? {}, projectLang);
  const introMarkdownDraft = resolveIntroMarkdownEditorContent({
    draft: draft ?? {},
    language: projectLang,
    persistedIntroMarkdown: persistedStepDrafts.intro,
    currentIntroMarkdown: introBodyDraft,
    currentSource: introBodySource,
    dirty: introBodyDirty,
  });
  const currentStepDraft = resolveWizardStepDisplayContent({
    step: currentStep,
    draft: draft ?? {},
    language: projectLang,
    editedDraft: stepDrafts[currentStep],
    persistedDraft: persistedStepDrafts[currentStep],
    introMarkdown: introBodyDraft,
  });
  const currentStepContent = currentStepDraft;
  const currentValidationReport = useMemo(() => {
    if (currentStep === "intro") {
      return buildStepValidationReport("intro", effectiveDraft ?? {}, projectLang, currentStepContent);
    }
    return buildStepValidationReport(currentStep, effectiveDraft ?? {}, projectLang, currentStepDraft);
  }, [currentStep, currentStepContent, currentStepDraft, effectiveDraft, projectLang, validationReports]);
  const selectedGenre = genresData?.genres.find((genre) => genre.id === selectedGenreId) ?? null;
  const genreBindingLabel = selectedGenre
    ? `${selectedGenre.name}${selectedGenre.source ? ` · ${selectedGenre.source}` : ""}`
    : draft?.genreAlias?.trim() || draft?.mappedGenreId?.trim() || draft?.genre?.trim() || "未选择";
  const selectedIntroCandidate = introCandidates[selectedIntroCandidateIndex] ?? null;
  const parsedIntroSeed = parseIntroSeedText(introSeedText);
  const introBlurb = parsedIntroSeed.blurb;
  const introStoryBackground = parsedIntroSeed.storyBackground;
  useEffect(() => {
    if (!draft || introBodyDirty) return;
    const preferred = resolvePreferredIntroMarkdown({
      draft,
      language: projectLang,
      persistedIntroMarkdown: persistedStepDrafts.intro,
      currentIntroMarkdown: introBodyDraft,
      currentSource: introBodySource,
    });
    setIntroBodyDraft(preferred.content);
    setIntroBodySource(preferred.source);
    lastAutoSaveContentRef.current.intro = preferred.content;
  }, [draft, introBodyDirty, persistedStepDrafts.intro, projectLang]);
  const isMarkdownStep = currentStep !== "intro";
  const currentMarkdownSpec = isMarkdownStep ? getStepMarkdownSpec(currentStep as Exclude<BookCreationWizardStep, "intro">) : null;
  const autoGenerateAllowed = Boolean(introThemeText.trim() || selectedGenre?.name?.trim());
  const stopping = activeSession?.isStopping ?? false;
  const introGenerationState = useMemo(() => resolveIntroGenerationState(activeSession), [activeSession]);
  const introGenerationActive = currentStep === "intro" && (
    isIntroGenerationPending
    || introGenerationState.active
    || (loading && activeSession?.currentWizardStep === "intro")
  );
  const introGenerationPhase = introGenerationState.active
    ? introGenerationState.phase
    : introGenerationActive
      ? "thinking"
      : "idle";
  const canStop = Boolean(activeSessionId) && (loading || stopping);
  const navigationLocked = isWizardNavigationLocked({
    loadingDraft,
    loading,
    creating,
    isAdvancing,
    isAutoCompleting,
    isRegenerating,
    isAutoGeneratingPage,
    stopping,
  });
  const shouldShowValidationPanel = validationPanelStep === currentStep;
  const syncDisplayedStepDraft = useCallback((step: BookCreationWizardStep) => {
    const sessionId = draftSessionId ?? activeSessionId;
    const latestDraft = sessionId ? (useChatStore.getState().sessions[sessionId]?.creationDraft ?? draft) : draft;
    if (!latestDraft) return;
    if (step === "intro") {
      const introSeed = composeIntroSeedText(latestDraft.blurb ?? "", latestDraft.storyBackground ?? "");
      setIntroSeedText(introSeed);
      const preferred = resolvePreferredIntroMarkdown({
        draft: latestDraft,
        language: projectLang,
        persistedIntroMarkdown: persistedStepDrafts.intro,
        currentIntroMarkdown: introBodyDraft,
        currentSource: introBodySource,
      });
      setIntroBodyDraft(preferred.content);
      setIntroBodySource(preferred.source);
      setIntroBodyDirty(false);
      lastAutoSaveContentRef.current.intro = preferred.content;
      return;
    }
    const persistedStepDraft = persistedStepDrafts[step]?.trim();
    const editedStepDraft = stepDrafts[step]?.trim();
    if (editedStepDraft || persistedStepDraft) {
      const displayed = resolveWizardStepDisplayContent({
        step,
        draft: latestDraft,
        language: projectLang,
        editedDraft: editedStepDraft,
        persistedDraft: persistedStepDraft,
        introMarkdown: introBodyDraft,
      });
      setStepDrafts((current) => ({
        ...current,
        [step]: displayed,
      }));
      lastAutoSaveContentRef.current[step] = displayed;
      return;
    }
    const nextStepDraft = buildStepMarkdownDraft(step, latestDraft, projectLang);
    setStepDrafts((current) => ({
      ...current,
      [step]: nextStepDraft,
    }));
    lastAutoSaveContentRef.current[step] = nextStepDraft;
  }, [activeSessionId, draft, draftSessionId, persistedStepDrafts, projectLang, stepDrafts]);

  const activeBookId = activeSession?.bookId ?? wizardBookId ?? null;

  const applyWizardStepFileContent = useCallback((step: BookCreationWizardStep, content: string) => {
    if (step === "intro") {
      const normalizedIntro = normalizeIntroMarkdownCandidate(content) || content.trim();
      setPersistedStepDrafts((current) => ({ ...current, intro: normalizedIntro }));
      setIntroBodyDraft(normalizedIntro);
      setIntroBodySource("generated");
      setIntroBodyDirty(false);
      lastAutoSaveContentRef.current.intro = normalizedIntro;
      if (activeSessionId && normalizedIntro.trim()) {
        replaceWizardStepMessage(activeSessionId, step, normalizedIntro);
      }
      return;
    }
    setPersistedStepDrafts((current) => ({ ...current, [step]: content }));
    setStepDrafts((current) => ({ ...current, [step]: content }));
    lastAutoSaveContentRef.current[step] = content;
    if (activeSessionId && content.trim()) {
      replaceWizardStepMessage(activeSessionId, step, content);
    }
  }, [activeSessionId, replaceWizardStepMessage]);

  const loadWizardStepFromFile = useCallback(async (bookId: string, step: BookCreationWizardStep): Promise<WizardStepFilePayload | null> => {
    updateWizardStepHydrationStatus(step, "loading");
    try {
      const data = await fetchJson<WizardStepFilePayload>(`/books/${encodeURIComponent(bookId)}/wizard-file/${WIZARD_STEP_FILE_NAMES[step]}`);
      applyWizardStepFileContent(step, data.content ?? "");
      const normalizedContent = step === "intro"
        ? (normalizeIntroMarkdownCandidate(data.content ?? "") || (data.content ?? "").trim())
        : (data.content ?? "");
      if (activeSessionId && normalizedContent.trim()) {
        replaceWizardStepMessage(activeSessionId, step, normalizedContent);
      }
      setWizardStepVersions((current) => ({ ...current, [step]: data.version }));
      updateWizardStepHydrationStatus(step, "loaded");
      return data;
    } catch (cause) {
      updateWizardStepHydrationStatus(step, "error");
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [activeSessionId, applyWizardStepFileContent, replaceWizardStepMessage, updateWizardStepHydrationStatus]);

  const extractAssistantStepBody = useCallback((targetStep: BookCreationWizardStep): string => {
    if (!activeSessionId) return "";
    const session = useChatStore.getState().sessions[activeSessionId];
    const message = [...(session?.messages ?? [])]
      .reverse()
      .find((item) => item.role === "assistant" && item.wizardStep === targetStep);
    if (!message) return "";
    const partsText = (message.parts ?? [])
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.content)
      .join("")
      .trim();
    if (targetStep === "intro") {
      const fromParts = normalizeIntroMarkdownCandidate(partsText);
      if (fromParts) return fromParts;
      const fromContent = normalizeIntroMarkdownCandidate(message.content?.trim() ?? "");
      return fromContent;
    }
    const content = partsText || message?.content?.trim() || "";
    if (!content) return "";
    const stripped = stripWizardPreamble(targetStep as Exclude<BookCreationWizardStep, "intro">, content);
    if (!looksLikeWizardStepMarkdown(targetStep as Exclude<BookCreationWizardStep, "intro">, stripped)) {
      return "";
    }
    return stripped;
  }, [activeSessionId]);

  const resolveLatestAssistantIntroContent = useCallback((): string => {
    return extractAssistantStepBody("intro");
  }, [extractAssistantStepBody]);

  const generateWizardStepBody = useCallback(async (targetStep: Exclude<BookCreationWizardStep, "intro">, instruction: string): Promise<string> => {
    if (!activeSessionId) return "";
    const nextTitle = bookTitle.trim() || draft?.title?.trim() || undefined;
    const nextPlatform = bookPlatform || draft?.platform || undefined;
    const nextLanguage = bookLanguage;
    const nextTargetChapters = parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters;
    const nextChapterWordCount = parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount;
    const hasParamChanges = nextTitle !== (draft?.title?.trim() || undefined)
      || nextPlatform !== (draft?.platform || undefined)
      || nextLanguage !== draft?.language
      || nextTargetChapters !== draft?.targetChapters
      || nextChapterWordCount !== draft?.chapterWordCount;
    if (hasParamChanges) {
      try {
        const paramsResponse = await fetchJson<AgentResponse>("/interaction/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request: {
              intent: "set_book_draft_params",
              title: nextTitle,
              platform: nextPlatform,
              language: nextLanguage,
              targetChapters: nextTargetChapters,
              chapterWordCount: nextChapterWordCount,
            } satisfies BookCreateSessionRequest,
          }),
        });
        const nextDraft = paramsResponse.session?.creationDraft ?? paramsResponse.details?.creationDraft;
        if (nextDraft) {
          setDraft(nextDraft);
          if (nextDraft.title?.trim()) {
            setBookTitle(nextDraft.title.trim());
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return "";
      }
    }
    const requestSeq = ++wizardGenerationSeqRef.current;
    const themeGenre = selectedGenre?.id ?? draft?.genre ?? draft?.mappedGenreId;
    const response = await sendMessage(activeSessionId, instruction, activeBookId ?? undefined, {
      skipAutoNewPrefix: true,
      wizardStep: targetStep,
      forceStream: true,
      themeGenre,
    }) as AgentResponse | null;
    if (wizardGenerationSeqRef.current !== requestSeq || activeWizardStepRef.current !== targetStep) {
      return "";
    }
    const responseContent = resolveWizardStepSaveContent(response, targetStep, projectLang);
    const streamContent = extractAssistantStepBody(targetStep);
    const contentToSave = stripWizardPreamble(
      targetStep,
      responseContent || streamContent,
    );
    const generatedDraft = response?.session?.creationDraft
      ?? response?.details?.creationDraft
      ?? mergeWizardStepContentIntoDraft(targetStep, contentToSave, draft ?? {});
    if (!contentToSave.trim() || !hasMeaningfulWizardStepContent(targetStep, contentToSave, generatedDraft)) {
      const errorMessage = projectLang === "zh"
        ? `${currentStepMeta.title} 生成结果不是当前页有效正文，已拦截保存，请重试。`
        : "The generated result was not valid body text, so saving was blocked.";
      setStatus(errorMessage);
      addErrorMessage(activeSessionId, errorMessage, targetStep);
      return "";
    }
    return contentToSave.trim();
  }, [activeBookId, activeSessionId, addErrorMessage, bookChapterWords, bookLanguage, bookPlatform, bookTargetChapters, bookTitle, currentStepMeta.title, draft, extractAssistantStepBody, projectLang, resolveWizardStepSaveContent, selectedGenre?.id, sendMessage]);

  const saveWizardStepToFile = useCallback(async (bookId: string, step: BookCreationWizardStep, content: string): Promise<boolean> => {
    const normalizedContent = content.trimEnd();
    const attemptSave = async (expectedVersion: number | undefined): Promise<{ ok: boolean; version?: number; conflict?: boolean }> => {
      try {
        const data = await fetchJson<{ ok: boolean; step: BookCreationWizardStep; version: number; updatedAt: string }>(`/books/${encodeURIComponent(bookId)}/wizard/${step}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: normalizedContent,
            expectedVersion,
          }),
        });
        return { ok: true, version: data.version };
      } catch (cause) {
        if (cause instanceof ApiRequestError && cause.status === 409) {
          return { ok: false, conflict: true };
        }
        throw cause;
      }
    };
    try {
      let expectedVersion = wizardStepVersions[step];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await attemptSave(expectedVersion);
        if (result.ok && typeof result.version === "number") {
          setWizardStepVersions((current) => ({ ...current, [step]: result.version! }));
          bumpBookDataVersion();
          return true;
        }
        if (!result.conflict) {
          return false;
        }
        const latest = await fetchJson<WizardStepFilePayload>(`/books/${encodeURIComponent(bookId)}/wizard-file/${WIZARD_STEP_FILE_NAMES[step]}`);
        setWizardStepVersions((current) => ({ ...current, [step]: latest.version }));
        expectedVersion = latest.version;
        const latestContent = (latest.content ?? "").trimEnd();
        if (latestContent === normalizedContent) {
          bumpBookDataVersion();
          return true;
        }
      }
      return false;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [bumpBookDataVersion, wizardStepVersions]);

  const syncDraftFromWizardStepContent = useCallback((step: BookCreationWizardStep, content: string): void => {
    const trimmed = content.trim();
    if (!trimmed || step === "intro") return;
    setDraft((current) => {
      const base: Partial<BookCreationDraft> = current ?? {
        concept: "",
        missingFields: [],
        readyToCreate: false,
      };
      return {
        ...base,
        ...mergeWizardStepContentIntoDraft(step, trimmed, base),
      } as BookCreationDraft;
    });
  }, []);

  const ensureBookShell = useCallback(async (): Promise<string | null> => {
    if (activeBookId) return activeBookId;
    try {
      const payload = await fetchJson<{ ok: boolean; bookId: string }>("/books/create-shell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: bookTitle || resolveIntroCandidateTitle(selectedIntroCandidate ?? { title: "", blurb: "", storyBackground: "" }) || "未命名书稿",
          genre: selectedGenre?.id ?? draft?.genre ?? "other",
          language: bookLanguage,
          platform: bookPlatform,
          chapterWordCount: parsePositiveIntegerInput(bookChapterWords),
          targetChapters: parsePositiveIntegerInput(bookTargetChapters),
          blurb: introBlurb || draft?.blurb || undefined,
          storyBackground: introStoryBackground || draft?.storyBackground || undefined,
          introMarkdown: introBodyDraft || introSeedText,
        }),
      });
      const nextBookId = payload.bookId;
      if (!nextBookId) return null;
      setWizardBookId(nextBookId);
      return nextBookId;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [activeBookId, bookChapterWords, bookLanguage, bookPlatform, bookTargetChapters, bookTitle, draft?.blurb, draft?.genre, draft?.storyBackground, introBlurb, introBodyDraft, introSeedText, introStoryBackground, selectedGenre?.id, selectedIntroCandidate]);

  useEffect(() => {
    if (!activeBookId || loadingDraft) return;
    void loadWizardStepFromFile(activeBookId, currentStep);
  }, [activeBookId, currentStep, loadWizardStepFromFile, loadingDraft]);

  useEffect(() => {
    if (!activeBookId || loadingDraft || currentStep === "intro") return;
    const currentSession = activeSessionId ? useChatStore.getState().sessions[activeSessionId] : null;
    const hydrationStatus = wizardStepHydrationRef.current[currentStep] ?? wizardStepHydrationStatus[currentStep];
    const latestBody = currentSession?.messages
      ?.slice()
      .reverse()
      .find((message) => message.role === "assistant" && message.wizardStep === currentStep)
      ?.content?.trim() ?? "";
    const persisted = persistedStepDrafts[currentStep]?.trim() ?? "";
    if (!shouldAutoGenerateWizardStepBody({
      currentStep,
      loadingDraft,
      loading,
      isAdvancing,
      isAutoCompleting,
      isRegenerating,
      isAutoGeneratingPage,
      hydrationStatus,
      latestBody,
      persisted,
    })) {
      return;
    }
    setIsAutoGeneratingPage(true);
    const targetStep = currentStep as Exclude<BookCreationWizardStep, "intro">;
    const instruction = projectLang === "zh"
      ? `请自动生成当前${currentStepMeta.title}页正文，只写这一页，不要写总结说明，不要修改其他页面。\n\n【当前页】${currentStepMeta.title}\n【当前草案】\n${currentStepDraft}`
      : `Automatically generate the current ${currentStepMeta.title} page only. Write only this page, do not write a summary, and do not modify other pages.\n\n[Current Page] ${currentStepMeta.title}\n[Current Draft]\n${currentStepDraft}`;
    void (async () => {
      try {
        const resolvedBookId = activeBookId ?? await ensureBookShell();
        if (!resolvedBookId) return;
        const content = await generateWizardStepBody(targetStep, instruction);
        if (!content) return;
        const saved = await saveWizardStepToFile(resolvedBookId, targetStep, content);
        if (saved) {
          syncDraftFromWizardStepContent(targetStep, content);
          applyWizardStepFileContent(targetStep, content);
          await loadWizardStepFromFile(resolvedBookId, targetStep);
        }
      } finally {
        setIsAutoGeneratingPage(false);
      }
    })();
  }, [activeBookId, activeSessionId, currentStep, currentStepDraft, currentStepMeta.title, ensureBookShell, generateWizardStepBody, isAdvancing, isAutoCompleting, isAutoGeneratingPage, isRegenerating, loading, loadingDraft, loadWizardStepFromFile, persistedStepDrafts, projectLang, saveWizardStepToFile, wizardStepHydrationStatus]);

  useEffect(() => {
    if (!resumeBookId || !wizardBookId || loadingDraft || !wizard) return;
    const steps = resolveWizardStepsToPrefetch({
      creationState: "wizard",
      creation: {
        wizardCompleted: false,
        resumeStep: visibleWizardStep,
        completedSteps: wizard.completedSteps,
      },
    });
    if (steps.length === 0) return;
    void Promise.all(steps.map((step) => loadWizardStepFromFile(wizardBookId, step)));
  }, [loadWizardStepFromFile, loadingDraft, resumeBookId, visibleWizardStep, wizard, wizardBookId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDraft(true);
    void refreshDraft().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoadingDraft(false);
    });
    return () => { cancelled = true; };
  }, [refreshDraft]);

  useEffect(() => {
    const serverStep = wizard?.currentStep;
    if (!serverStep) return;
    if (shouldAutoSyncVisibleWizardStep({
      userPinnedWizardStep: Boolean(userRequestedVisibleStep),
      visibleStep: userRequestedVisibleStep ?? visibleWizardStep,
      serverStep,
      wizardStepOrder,
    })) {
      setVisibleWizardStep(serverStep);
    }
  }, [userRequestedVisibleStep, visibleWizardStep, wizard?.currentStep, wizardStepOrder]);

  useEffect(() => {
    setValidationPanelStep(null);
  }, [currentStep]);

  // 自动保存：stepDrafts / introSeedText 变化后 debounce 600ms，静默写入 wizard step 文件
  useEffect(() => {
    const bookId = activeBookId;
    if (bookId === null || !shouldPersistIntroStepOnAutoSave(bookId, currentStep) || loadingDraft || suppressAutoSaveRef.current || navigationLocked) return;
    const content = currentStep === "intro"
      ? introMarkdownDraft
      : currentStepDraft;
    if (currentStep === "intro" && suppressIntroAutoSaveRef.current) return;
    if (!content.trim()) return;
    if (lastAutoSaveContentRef.current[currentStep] === content) return;
    clearAutoSaveTimer();
    autoSaveTimerRef.current = setTimeout(() => {
      lastAutoSaveContentRef.current[currentStep] = content;
      void (async () => {
        const saved = await saveWizardStepToFile(bookId, currentStep, content);
        if (saved) {
          syncDraftFromWizardStepContent(currentStep, content);
        }
      })();
    }, 600);
    return clearAutoSaveTimer;
  }, [activeBookId, clearAutoSaveTimer, currentStep, currentStepDraft, introMarkdownDraft, loadingDraft, navigationLocked, saveWizardStepToFile, syncDraftFromWizardStepContent]);
  const sendCommand = useCallback(async (
    instruction: string,
    wizardStep: BookCreationWizardStep = currentStep,
    options?: {
      readonly refreshDraft?: boolean;
      readonly forceStream?: boolean;
      readonly wizardAdvance?: Omit<BookCreateWizardControlRequest, "intent">;
    },
  ): Promise<AgentResponse | null> => {
    if (!activeSessionId) {
      setError(projectLang === "zh" ? "右侧 AI 工作台尚未就绪。" : "The AI workbench is not ready yet.");
      return null;
    }
    try {
      const data = await sendMessage(activeSessionId, instruction, activeBookId ?? undefined, {
        skipAutoNewPrefix: true,
        wizardStep,
        ...(options?.wizardAdvance ? { wizardAdvance: options.wizardAdvance } : {}),
        ...(options?.forceStream !== undefined ? { forceStream: options.forceStream } : {}),
      }) as AgentResponse | null;
      setStatus(projectLang === "zh" ? "操作已完成，已回填当前页。" : "Completed and applied to the current page.");
      if (options?.refreshDraft !== false) {
        await refreshDraft();
      }
      return data;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [activeBookId, activeSessionId, currentStep, projectLang, refreshDraft, sendMessage]);

  const applyIntroGenerationResult = useCallback((response: AgentResponse | null): void => {
    const savedDraft = response?.session?.creationDraft ?? response?.details?.creationDraft;
    if (!savedDraft) return;
    const canonicalIntro = resolveCanonicalIntroMarkdown([
      resolveLatestAssistantIntroContent(),
      response?.details?.draftRaw,
      response?.response,
      savedDraft.draftFields?.introMarkdown,
    ]);
    if (canonicalIntro && hasMeaningfulIntroMarkdown(canonicalIntro)) {
      // Mark dirty BEFORE setDraft so the draft-change useEffect is blocked
      // and cannot overwrite the generated body with the skeleton in savedDraft.
      setIntroBodyDirty(true);
      setIntroBodyDraft(canonicalIntro);
      lastAutoSaveContentRef.current.intro = canonicalIntro;
      setIntroBodySource("generated");
    } else {
      setStatus(projectLang === "zh"
        ? "Agent 未生成有效正文，已保留当前编辑内容，请补充卖点/题材后重试。"
        : "The agent did not produce valid body text, so the current editor content was kept. Add a hook/genre and retry.");
    }
    setDraft(savedDraft);
    if (savedDraft.title?.trim()) {
      setBookTitle(savedDraft.title.trim());
    }
    if (savedDraft.blurb?.trim() || savedDraft.storyBackground?.trim()) {
      setIntroSeedText(composeIntroSeedText(savedDraft.blurb ?? "", savedDraft.storyBackground ?? ""));
    }
    if (!savedDraft.title?.trim()) {
      setStatus(projectLang === "zh"
        ? "简介正文已生成，但未产出书名。请先生成或补录书名，再进入下一步。"
        : "Intro body was generated, but no title was produced. Generate or fill in the title before continuing.");
    }
  }, [projectLang, resolveLatestAssistantIntroContent]);

  const buildIntroStreamInstruction = useCallback((params: {
    readonly title?: string;
    readonly platform?: string;
    readonly language?: string;
    readonly targetChapters?: number;
    readonly chapterWordCount?: number;
    readonly theme?: string;
    readonly blurb?: string;
    readonly storyBackground?: string;
    readonly seed?: string;
  }) => [
    "/intro mode=generate",
    params.theme ? `theme=${encodeURIComponent(params.theme)}` : undefined,
    params.title ? `title=${encodeURIComponent(params.title)}` : undefined,
    params.platform ? `platform=${encodeURIComponent(params.platform)}` : undefined,
    params.language ? `language=${encodeURIComponent(params.language)}` : undefined,
    typeof params.targetChapters === "number" ? `targetChapters=${params.targetChapters}` : undefined,
    typeof params.chapterWordCount === "number" ? `chapterWordCount=${params.chapterWordCount}` : undefined,
    params.blurb ? `blurb=${encodeURIComponent(params.blurb)}` : undefined,
    params.storyBackground ? `storyBackground=${encodeURIComponent(params.storyBackground)}` : undefined,
    params.seed
      ? `instruction=${encodeURIComponent([
        params.seed,
        params.title?.trim()
          ? "已给定书名，必须沿用该书名，并同步写回书籍参数。"
          : "必须先生成一个明确可用的书名，并把书名写回书籍参数 title。",
        "输出的正文首行禁止显示书名，不要写成 '# 书名'。",
      ].join("\n"))}`
      : undefined,
  ].filter((item): item is string => Boolean(item)).join(" "), []);

  const sendWizardControlRequest = useCallback(async (request: BookCreateWizardControlRequest, successStatus: string): Promise<boolean> => {
    if (!activeSessionId) {
      setError(projectLang === "zh" ? "右侧 AI 工作台尚未就绪。" : "The AI workbench is not ready yet.");
      return false;
    }
    try {
      const response = await fetchJson<AgentResponse>("/interaction/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request }),
      });
      setStatus(successStatus);
      const session = response.session;
      if (session?.creationDraft) setDraft(session.creationDraft);
      if (session?.creationWizard) {
        setWizard(session.creationWizard);
        switch (request.intent) {
          case "advance_book_wizard":
          case "retreat_book_wizard":
          case "goto_book_wizard":
            setUserRequestedVisibleStep(null);
            setVisibleWizardStep(session.creationWizard.currentStep);
            break;
          case "discard_book_draft":
            setUserRequestedVisibleStep(null);
            setVisibleWizardStep("intro");
            break;
          case "save_wizard_step":
          default:
            break;
        }
      }
      return true;
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409) {
        setBlockedPrompt({
          title: projectLang === "zh" ? "操作被阻挡" : "Operation blocked",
          message: cause.message,
        });
        return false;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [activeSessionId, projectLang]);

  const saveDraftParams = useCallback(async (params: {
    readonly title?: string;
    readonly platform?: string;
    readonly language?: "zh" | "en";
    readonly targetChapters?: number;
    readonly chapterWordCount?: number;
  }, successStatus?: string): Promise<boolean> => {
    try {
      const response = await fetchJson<AgentResponse>("/interaction/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: {
            intent: "set_book_draft_params",
            title: params.title,
            platform: params.platform,
            language: params.language,
            targetChapters: params.targetChapters,
            chapterWordCount: params.chapterWordCount,
          } satisfies BookCreateSessionRequest,
        }),
      });
      const nextDraft = response.session?.creationDraft ?? response.details?.creationDraft;
      if (nextDraft) {
        setDraft(nextDraft);
        if (nextDraft.title?.trim()) {
          setBookTitle(nextDraft.title.trim());
        }
      }
      if (successStatus) {
        setStatus(successStatus);
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, []);

  const syncBookShellParams = useCallback(async (bookId: string, params?: {
    readonly title?: string;
    readonly genre?: string;
    readonly platform?: string;
    readonly language?: "zh" | "en";
    readonly targetChapters?: number;
    readonly chapterWordCount?: number;
  }): Promise<boolean> => {
    const nextTitle = params?.title?.trim() || bookTitle.trim() || draft?.title?.trim() || "";
    const nextGenre = params?.genre?.trim() || selectedGenre?.id?.trim() || draft?.genre?.trim() || "";
    const nextPlatform = params?.platform?.trim() || bookPlatform || draft?.platform || "";
    const nextLanguage = params?.language ?? bookLanguage;
    const nextTargetChapters = params?.targetChapters ?? parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters;
    const nextChapterWordCount = params?.chapterWordCount ?? parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount;
    try {
      await fetchJson(`/books/${encodeURIComponent(bookId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(nextTitle ? { title: nextTitle } : {}),
          ...(nextGenre ? { genre: nextGenre } : {}),
          ...(nextPlatform ? { platform: nextPlatform } : {}),
          ...(nextLanguage ? { language: nextLanguage } : {}),
          ...(typeof nextTargetChapters === "number" ? { targetChapters: nextTargetChapters } : {}),
          ...(typeof nextChapterWordCount === "number" ? { chapterWordCount: nextChapterWordCount } : {}),
        }),
      });
      bumpBookDataVersion();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [bookChapterWords, bookLanguage, bookPlatform, bookTargetChapters, bookTitle, bumpBookDataVersion, draft?.chapterWordCount, draft?.genre, draft?.platform, draft?.targetChapters, draft?.title, selectedGenre?.id]);

  const runIntroRevision = useCallback(async (request: {
    readonly title?: string;
    readonly platform?: string;
    readonly language?: string;
    readonly targetChapters?: number;
    readonly chapterWordCount?: number;
    readonly seed?: string;
    readonly blurb?: string;
    readonly storyBackground?: string;
    readonly theme?: string;
  }): Promise<AgentResponse | null> => {
    const seed = request.seed?.trim() || "";
    if (!seed) {
      setError(projectLang === "zh" ? "请先输入简介或卖点。" : "Please enter a hook or blurb first.");
      return null;
    }
    if (!activeSessionId) {
      setError(projectLang === "zh" ? "右侧 AI 工作台尚未就绪。" : "The AI workbench is not ready yet.");
      return null;
    }

    let response: AgentResponse | null = null;
    await pauseAutoSaveDuring(async () => {
      suppressIntroAutoSave(true);
      try {
        const instruction = buildIntroStreamInstruction({
          title: request.title,
          platform: request.platform,
          language: request.language,
          targetChapters: request.targetChapters,
          chapterWordCount: request.chapterWordCount,
          theme: request.theme,
          blurb: request.blurb,
          storyBackground: request.storyBackground,
          seed,
        });
        response = await sendMessage(activeSessionId, instruction, activeBookId ?? undefined, {
          skipAutoNewPrefix: true,
          wizardStep: currentStep,
          forceStream: true,
          propagateErrors: true,
        }) as AgentResponse | null;
        applyIntroGenerationResult(response);
        if (response?.error) {
          const errorPayload = response.error as string | { message?: string };
          const rawError = typeof errorPayload === "string"
            ? errorPayload
            : typeof errorPayload.message === "string"
              ? errorPayload.message.trim()
              : "";
          if (rawError) {
            setError(rawError);
            return;
          }
        }
        const canonicalIntro = resolveCanonicalIntroMarkdown([
          resolveLatestAssistantIntroContent(),
          response?.details?.draftRaw,
          response?.response,
          response?.session?.creationDraft?.draftFields?.introMarkdown,
          response?.details?.creationDraft?.draftFields?.introMarkdown,
        ]);
        if (!canonicalIntro || !hasMeaningfulIntroMarkdown(canonicalIntro)) {
          setError(projectLang === "zh" ? "Agent 未生成有效正文（多次重试后仍为空或仅有框架），请补充卖点/题材后重试。" : "The agent did not produce valid body text (still empty or skeleton-only after retries). Add a hook/genre and retry.");
          return;
        }
        const generatedTitle = response?.session?.creationDraft?.title?.trim()
          || response?.details?.creationDraft?.title?.trim()
          || "";
        setIntroBodyDirty(true);
        setIntroBodyDraft(canonicalIntro);
        setIntroBodySource("generated");
        setPersistedStepDrafts((current) => ({ ...current, intro: canonicalIntro }));
        setStepDrafts((current) => ({ ...current, intro: canonicalIntro }));
        lastAutoSaveContentRef.current.intro = canonicalIntro;
        if (generatedTitle) {
          setBookTitle(generatedTitle);
        }
        if (activeSessionId && canonicalIntro.trim()) {
          replaceWizardStepMessage(activeSessionId, "intro", canonicalIntro);
        }
        setIntroPanelTab("body");
        setStatus(generatedTitle
          ? (projectLang === "zh"
            ? "简介正文与书名已生成，并已回填到当前页；未点击下一步前不会保存。"
            : "Intro body and title were generated and applied to the current page.")
          : (projectLang === "zh"
            ? "简介正文已生成并回填到当前页；未点击下一步前不会保存。"
            : "Intro body was generated and applied to the current page, but no title was applied."));
      } catch (cause) {
        if (cause instanceof ApiRequestError && cause.status === 409) {
          setBlockedPrompt({
            title: projectLang === "zh" ? "操作被阻挡" : "Operation blocked",
            message: cause.message,
          });
          return;
        }
        if (cause instanceof ApiRequestError) {
          setError(cause.message);
          return;
        }
        throw cause;
      } finally {
        suppressIntroAutoSave(false);
      }
    });

    return response;
  }, [activeBookId, activeSessionId, applyIntroGenerationResult, buildIntroStreamInstruction, currentStep, pauseAutoSaveDuring, projectLang, replaceWizardStepMessage, resolveLatestAssistantIntroContent, sendMessage, suppressIntroAutoSave]);

  const handleAdvance = useCallback(async () => {
    if (!nextStepMeta) return;
    setValidationPanelStep(currentStep);
    if (currentValidationReport.status !== "pass") {
      setStatus(projectLang === "zh"
        ? `当前页未通过校验：${currentValidationReport.summary}`
        : `Current page failed validation: ${currentValidationReport.summary}`);
      return;
    }
    const targetStep = nextStepMeta.id;
    clearAutoSaveTimer();
    pendingWizardStepRef.current = targetStep;
    setIsAdvancing(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
    setStatus(projectLang === "zh"
      ? `正在保存并进入 ${nextStepMeta.title}...`
      : `Saving and moving to ${nextStepMeta.title}...`);

    try {
      const resolvedBookId = await ensureBookShell();
      if (!resolvedBookId) {
        setStatus(projectLang === "zh" ? "创建书籍壳失败，请检查标题与参数。" : "Failed to create book shell.");
        return;
      }

      const paramsSaved = await saveDraftParams({
        title: bookTitle.trim() || draft?.title || undefined,
        platform: bookPlatform || draft?.platform || undefined,
        language: bookLanguage,
        targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
        chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
      });
      if (!paramsSaved) return;

      const persisted = await saveWizardStepToFile(resolvedBookId, currentStep, currentStepContent ?? "");
      if (!persisted) return;
      syncDraftFromWizardStepContent(currentStep, currentStepContent ?? "");
      await syncBookShellParams(resolvedBookId);

      patchWizardStep(targetStep, currentStep);
      const nextFromFile = await loadWizardStepFromFile(resolvedBookId, targetStep);
      const hasNextContent = hasMeaningfulWizardStepContent(targetStep, nextFromFile?.content ?? "", draft);
      if (!hasNextContent) {
        const draftContext = draft
          ? buildCreationDraftSummary(draft, projectLang)
              .map((row) => `${row.label}：${row.value}`)
              .join("\n")
          : "";
      const generationRequest = projectLang === "zh"
          ? `你现在在处理"${nextStepMeta.title}"页。请根据已有草案从头重写${nextStepMeta.title}页草案，只补当前页允许的字段，不要扩写其他页面，也不要创建新书，也不要参考当前页原文。\n\n【已有草案】\n${draftContext || "（空）"}`
          : `You are now working on the "${nextStepMeta.title}" page. Rewrite the ${nextStepMeta.title} draft from scratch based on the existing draft. Only fill in fields allowed for this page, do not expand other pages or create a new book, and do not use the current page text as a reference.\n\n[Existing Draft]\n${draftContext || "(empty)"}`;

        const generationResponse = await sendCommand(generationRequest, targetStep, {
          refreshDraft: false,
          wizardAdvance: {
            wizardStep: currentStep,
            language: bookLanguage,
            stepTitle: currentStepMeta.title,
            title: bookTitle || draft?.title || undefined,
            genre: selectedGenre?.id ?? draft?.genre ?? "",
            platform: bookPlatform || draft?.platform || undefined,
            targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
            chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
            nextStep: targetStep,
            instruction: currentStepContent,
          },
        });
        const generatedDraft = generationResponse?.session?.creationDraft ?? generationResponse?.details?.creationDraft;
        const generatedContent = extractWizardStepContent(generationResponse, targetStep, projectLang);
        if (hasMeaningfulWizardStepContent(targetStep, generatedContent, generatedDraft ?? draft)) {
          const savedGenerated = await saveWizardStepToFile(resolvedBookId, targetStep, generatedContent);
          if (savedGenerated) {
            syncDraftFromWizardStepContent(targetStep, generatedContent);
            await loadWizardStepFromFile(resolvedBookId, targetStep);
          }
        }
      }
      await refreshDraft();
    } finally {
      pendingWizardStepRef.current = null;
      setIsAdvancing(false);
    }
  }, [bookChapterWords, bookLanguage, bookPlatform, bookTitle, bookTargetChapters, clearAutoSaveTimer, currentStep, currentStepContent, currentStepMeta.title, currentValidationReport.status, currentValidationReport.summary, draft, ensureBookShell, loadWizardStepFromFile, nextStepMeta, patchWizardStep, projectLang, refreshDraft, saveDraftParams, saveWizardStepToFile, selectedGenre?.id, sendCommand, syncBookShellParams, syncDisplayedStepDraft]);

  const handleBookTitleCommit = useCallback(async (value: string): Promise<void> => {
    const trimmed = value.trim();
    setBookTitle(trimmed);
    if (!trimmed || trimmed === (draft?.title?.trim() ?? "")) {
      return;
    }
    await saveDraftParams({
      title: trimmed,
      platform: bookPlatform || draft?.platform || undefined,
      language: bookLanguage,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
    }, projectLang === "zh" ? "书名已保存。" : "Title saved.");
  }, [bookChapterWords, bookLanguage, bookPlatform, bookTargetChapters, draft, projectLang, saveDraftParams]);

  const handleAutoFixCurrentStep = useCallback(async () => {
    if (!activeSessionId || currentValidationReport.status === "pass") return;
    setValidationPanelStep(currentStep);
    setIsAutoCompleting(true);
    try {
      const issueSummary = currentValidationReport.issues.map((issue) => issue.message).join("；");
      const draftContext = draft
        ? buildCreationDraftSummary(draft, projectLang).map((row) => `${row.label}：${row.value}`).join("\n")
        : "";
      const instruction = projectLang === "zh"
        ? `请根据当前页缺失项重写当前${currentStepMeta.title}页内容，只补当前页允许的字段，不要改其他页，也不要参考当前页原文。\n\n【当前页】${currentStepMeta.title}\n【缺失项】${issueSummary}\n\n【已有草案】\n${draftContext || "（空）"}`
        : `Please rewrite the current ${currentStepMeta.title} page to fill the missing items only. Do not modify other pages, and do not use the current page text as a reference.\n\n[Current Step] ${currentStepMeta.title}\n[Missing Items] ${issueSummary}\n\n[Existing Draft]\n${draftContext || "(empty)"}`;
      const resolvedBookId = activeBookId ?? wizardBookId ?? await ensureBookShell();
      if (resolvedBookId && currentStep !== "intro") {
        const contentToSave = await generateWizardStepBody(currentStep as Exclude<BookCreationWizardStep, "intro">, instruction);
        if (contentToSave.trim()) {
          await saveWizardStepToFile(resolvedBookId, currentStep, contentToSave);
          syncDraftFromWizardStepContent(currentStep, contentToSave);
          applyWizardStepFileContent(currentStep, contentToSave);
          await loadWizardStepFromFile(resolvedBookId, currentStep);
        }
      }
      await refreshDraft();
    } finally {
      setIsAutoCompleting(false);
    }
  }, [activeBookId, activeSessionId, applyWizardStepFileContent, bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, currentStep, currentStepMeta.title, currentValidationReport.status, currentValidationReport.issues, draft, ensureBookShell, generateWizardStepBody, loadWizardStepFromFile, projectLang, refreshDraft, saveWizardStepToFile, selectedGenre?.id, wizardBookId]);

  const handleBack = useCallback(async () => {
    if (!canGoBack) return;
    await pauseAutoSaveDuring(async () => {
      const previous = WIZARD_STEPS[currentStepIndex - 1];
      if (!previous) return;
      const resolvedBookId = activeBookId ?? await ensureBookShell();
      if (!resolvedBookId) return;
      const persisted = await saveWizardStepToFile(
        resolvedBookId,
        currentStep,
        currentStepContent ?? "",
      );
      if (!persisted) return;
      syncDraftFromWizardStepContent(currentStep, currentStepContent ?? "");
      await loadWizardStepFromFile(resolvedBookId, previous.id);
      patchWizardStep(previous.id);
      setStatus(projectLang === "zh" ? `已返回 ${previous.title}。` : `Moved back to ${previous.title}.`);
    });
  }, [activeBookId, canGoBack, currentStep, currentStepContent, currentStepIndex, ensureBookShell, loadWizardStepFromFile, patchWizardStep, pauseAutoSaveDuring, projectLang, saveWizardStepToFile, syncDraftFromWizardStepContent]);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const resolvedBookId = activeBookId ?? await ensureBookShell();
      if (!resolvedBookId) {
        setStatus(projectLang === "zh" ? "创建书籍壳失败，请检查标题与参数。" : "Failed to create book shell.");
        return;
      }
      if (currentStep === "relation") {
        const relationMarkdown = relationStepDraft || currentStepContent || draft?.relationshipMap || "";
        if (relationMarkdown.trim()) {
          const relationSaved = await saveWizardStepToFile(resolvedBookId, "relation", relationMarkdown);
          if (!relationSaved) return;
          syncDraftFromWizardStepContent("relation", relationMarkdown);
        }
      }
      const introMarkdown = introBodyDraft || buildIntroMarkdownDraft(draft ?? {}, projectLang);
      const introSaved = await saveWizardStepToFile(resolvedBookId, "intro", introMarkdown);
      if (!introSaved) return;
      await postApi(`/books/${encodeURIComponent(resolvedBookId)}/wizard/complete`);
      const nextTitle = bookTitle.trim();
      const currentTitle = activeSession?.title?.trim() ?? "";
      if (activeSessionId && nextTitle && nextTitle !== currentTitle) {
        await renameSession(activeSessionId, nextTitle);
      }
      setDraft(undefined);
      setWizard(undefined);
      setUserRequestedVisibleStep(null);
      setVisibleWizardStep("intro");
      setResumeDraftSessionId(null);
      clearBookCreateSessionId();
      void loadSessionList(null);
      nav.toBook(resolvedBookId);
    } finally {
      setCreating(false);
    }
  }, [activeBookId, activeSession?.title, activeSessionId, bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, canCreate, currentStep, currentStepContent, draft, ensureBookShell, introBodyDraft, loadSessionList, nav, projectLang, relationStepDraft, renameSession, saveWizardStepToFile, syncDraftFromWizardStepContent]);

  const handleAutoComplete = useCallback(async () => {
    if (isAutoCompleting || isAdvancing) return;
    const stepsToRun = WIZARD_STEPS.filter((s) => s.id !== "intro").slice(
      Math.max(0, WIZARD_STEPS.findIndex((s) => s.id === currentStep)),
    );
    if (stepsToRun.length === 0) return;
    setIsAutoCompleting(true);
    setStatus(projectLang === "zh" ? "全自动模式：依次生成各步骤内容..." : "Auto mode: generating all steps...");
    try {
      for (const stepMeta of stepsToRun) {
        const nextStepIndex = WIZARD_STEPS.findIndex((s) => s.id === stepMeta.id) + 1;
        const nextMeta = WIZARD_STEPS[nextStepIndex];
        if (!nextMeta) {
          if (canCreateFromDraft(useChatStore.getState().sessions[activeSessionId ?? ""]?.creationDraft ?? draft)) {
            await handleCreate();
          }
          break;
        }
        if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
        setStatus(projectLang === "zh" ? `全自动：正在保存并生成 ${nextMeta.title}...` : `Auto: saving and generating ${nextMeta.title}...`);
        const draftContext = draft
          ? buildCreationDraftSummary(draft, projectLang).map((row) => `${row.label}：${row.value}`).join("\n")
          : "";
        const generationRequest = projectLang === "zh"
          ? `你现在在处理"${nextMeta.title}"页（全自动模式）。请根据已有草案生成${nextMeta.title}页草案，只补当前页允许的字段，不要扩写其他页面，也不要创建新书。\n\n【已有草案】\n${draftContext || "（空）"}`
          : `You are now working on the "${nextMeta.title}" page (auto mode). Based on the existing draft, generate a draft for the ${nextMeta.title} page. Only fill in fields allowed for this page.\n\n[Existing Draft]\n${draftContext || "(empty)"}`;
        const resolvedBookId = activeBookId ?? await ensureBookShell();
        if (!resolvedBookId) break;
        if (nextMeta.id === "intro") break;
        const generatedContent = await generateWizardStepBody(nextMeta.id, generationRequest);
        if (!generatedContent) break;
        const savedGenerated = await saveWizardStepToFile(resolvedBookId, nextMeta.id, generatedContent);
        if (savedGenerated) {
          syncDraftFromWizardStepContent(nextMeta.id, generatedContent);
          applyWizardStepFileContent(nextMeta.id, generatedContent);
          patchWizardStep(nextMeta.id, stepMeta.id);
          await refreshDraft();
          await loadWizardStepFromFile(resolvedBookId, nextMeta.id);
        }
        await refreshDraft();
      }
      setStatus(projectLang === "zh" ? "全自动完成，已进入最终创建。" : "Auto complete. Proceeding to final creation.");
    } finally {
      setIsAutoCompleting(false);
    }
  }, [activeBookId, activeSessionId, applyWizardStepFileContent, bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, currentStep, draft, ensureBookShell, generateWizardStepBody, handleCreate, isAdvancing, isAutoCompleting, patchWizardStep, projectLang, refreshDraft, selectedGenre?.id, saveWizardStepToFile, stepDrafts, introSeedText]);

  const handleDiscard = useCallback(async () => {
    setDiscardConfirmOpen(true);
  }, []);

  const handleContinueDraft = useCallback(async () => {
    if (!resumeDraftSessionId) return;
    await loadSessionDetail(resumeDraftSessionId);
    const state = useChatStore.getState();
    const session = state.sessions[resumeDraftSessionId];
    if (!session) return;
    setDraft(session.creationDraft);
    setWizard(session.creationWizard);
    setUserRequestedVisibleStep(null);
    setVisibleWizardStep(resolveBookCreationResumeStep(session.creationWizard));
    activateSession(resumeDraftSessionId);
  }, [activateSession, loadSessionDetail, resumeDraftSessionId]);

  const handleGenerateIntroBody = useCallback(async () => {
    setIsIntroGenerationPending(true);
    try {
      const seed = introSeedText.trim() || composeIntroSeedText(draft?.blurb ?? "", draft?.storyBackground ?? "");
      const theme = introThemeText.trim() || selectedGenre?.name?.trim() || draft?.genre?.trim() || "";
      const response = await runIntroRevision({
        theme,
        title: bookTitle || draft?.title || undefined,
        platform: bookPlatform || draft?.platform || undefined,
        language: bookLanguage,
        targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
        chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
        seed,
        blurb: introBlurb || draft?.blurb || undefined,
        storyBackground: introStoryBackground || draft?.storyBackground || undefined,
        // 统一把手工输入的主题/卖点和候选池来源都归到同一条简介正文生成链路。
      });
      if (response?.session?.creationDraft || response?.details?.creationDraft) {
        setIntroPanelTab("body");
      }
    } finally {
      setIsIntroGenerationPending(false);
    }
  }, [bookChapterWords, bookLanguage, bookPlatform, bookTitle, draft?.blurb, draft?.genre, draft?.genreAlias, draft?.platform, draft?.storyBackground, introBlurb, introSeedText, introStoryBackground, introThemeText, runIntroRevision, selectedGenre?.id, selectedGenre?.name, selectedGenre?.source]);

  const handleGenerateCandidateBody = useCallback(async (candidate: IntroCandidateLike, index: number) => {
    setIsIntroGenerationPending(true);
    try {
      const seed = buildIntroExpansionSeedText(candidate);
      if (!seed.trim()) return;
      const theme = introThemeText.trim() || selectedGenre?.name?.trim() || candidate.style || candidate.title;
      setSelectedIntroCandidateIndex(index);
      setIntroMode("manual");
      setIntroSeedText(composeIntroSeedText(candidate.blurb, candidate.storyBackground));
      setIntroTheme(theme);
      await runIntroRevision({
        theme,
        title: resolveIntroCandidateTitle(candidate) || bookTitle || draft?.title || undefined,
        platform: bookPlatform || draft?.platform || undefined,
        language: bookLanguage,
        targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
        chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
        seed,
        blurb: candidate.blurb,
        storyBackground: candidate.storyBackground,
      });
    } finally {
      setIsIntroGenerationPending(false);
    }
  }, [bookChapterWords, bookLanguage, bookPlatform, bookTitle, draft?.genre, draft?.genreAlias, draft?.platform, introThemeText, runIntroRevision, selectedGenre?.id, selectedGenre?.name, selectedGenre?.source]);

  const handleIntroAiModify = useCallback(async (note: string, mode: "revise" | "polish"): Promise<void> => {
    const aiNote = note.trim();
    if (!aiNote) {
      setError(projectLang === "zh" ? "请先填写修改要求。" : "Please provide edit instructions first.");
      return;
    }
    const currentIntroMarkdown = resolveIntroMarkdownEditorContent({
      draft: draft ?? {},
      language: projectLang,
      persistedIntroMarkdown: persistedStepDrafts.intro,
      currentIntroMarkdown: introBodyDraft,
      currentSource: introBodySource,
      dirty: introBodyDirty,
    });
    const seed = mode === "polish"
      ? (projectLang === "zh"
        ? `请基于当前简介正文进行润色，保留核心设定与题材一致性，并只输出可直接保存的 Markdown 正文。\n\n【修改要求】${aiNote}\n\n【当前正文】\n${currentIntroMarkdown}`
        : `Polish the current intro body, preserve the core setup and genre consistency, and output only Markdown body that can be saved directly.\n\n[Instructions] ${aiNote}\n\n[Current Body]\n${currentIntroMarkdown}`)
      : (projectLang === "zh"
        ? `请基于当前简介正文进行修改，只输出可直接保存的 Markdown 正文。\n\n【修改要求】${aiNote}\n\n【当前正文】\n${currentIntroMarkdown}`
        : `Revise the current intro body and output only Markdown body that can be saved directly.\n\n[Instructions] ${aiNote}\n\n[Current Body]\n${currentIntroMarkdown}`);

    const response = await runIntroRevision({
      theme: introThemeText.trim() || selectedGenre?.name?.trim() || draft?.genre?.trim() || "",
      title: bookTitle || draft?.title || undefined,
      platform: bookPlatform || draft?.platform || undefined,
      language: bookLanguage,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
      seed,
      blurb: introBlurb || draft?.blurb || undefined,
      storyBackground: introStoryBackground || draft?.storyBackground || undefined,
    });

    const canonicalIntro = response?.session?.creationDraft?.draftFields?.introMarkdown?.trim()
      || response?.details?.creationDraft?.draftFields?.introMarkdown?.trim();
    const normalizedIntro = canonicalIntro ? normalizeIntroMarkdownCandidate(canonicalIntro) : "";
    if (normalizedIntro) {
      setIntroBodyDirty(true);
      setIntroBodyDraft(normalizedIntro);
      setIntroBodySource("generated");
      setPersistedStepDrafts((current) => ({ ...current, intro: normalizedIntro }));
      setStepDrafts((current) => ({ ...current, intro: normalizedIntro }));
      lastAutoSaveContentRef.current.intro = normalizedIntro;
      if (activeSessionId && normalizedIntro.trim()) {
        replaceWizardStepMessage(activeSessionId, "intro", normalizedIntro);
      }
      setStatus(projectLang === "zh" ? "简介正文已修改并回填当前页；未点击下一步前不会保存。" : "Intro body revised and applied to the current page.");
    }
  }, [
    activeSessionId,
    bookChapterWords,
    bookLanguage,
    bookPlatform,
    bookTitle,
    bookTargetChapters,
    draft,
    introBlurb,
    introStoryBackground,
    introThemeText,
    projectLang,
    replaceWizardStepMessage,
    runIntroRevision,
    selectedGenre?.name,
  ]);

  const confirmDiscard = useCallback(async () => {
    setDiscardConfirmOpen(false);
    await sendWizardControlRequest({
      intent: "discard_book_draft",
      language: projectLang,
      stepTitle: currentStepMeta.title,
      wizardStep: currentStep,
    }, projectLang === "zh" ? "已清除草稿。" : "Draft cleared.");
    setDraft(undefined);
    setWizard(undefined);
    setUserRequestedVisibleStep(null);
    setVisibleWizardStep("intro");
    setIntroCandidates([]);
    setIntroSeedText("");
    setIntroTheme("");
    setStepDrafts({});
    setStepEditing({});
    setResumeDraftSessionId(null);
    clearBookCreateSessionId();
    if (activeSessionId) {
      await deleteSession(activeSessionId);
    }
    nav.toDashboard();
  }, [activeSessionId, currentStep, currentStepMeta.title, deleteSession, nav, projectLang, sendWizardControlRequest]);

  const handleMarkdownAiModify = useCallback(async (note: string, mode: "revise" | "polish", step?: Exclude<BookCreationWizardStep, "intro">) => {
    const targetStep = step ?? (currentStep as Exclude<BookCreationWizardStep, "intro">);
    if (!currentMarkdownSpec) return;
    const aiNote = note.trim();
    if (!aiNote.trim()) {
      setError(projectLang === "zh" ? "请先填写修改要求。" : "Please provide edit instructions first.");
      return;
    }
    const instruction = projectLang === "zh"
      ? `请修改当前${currentMarkdownSpec.title}页内容，只改这一页，保持 Markdown 结构清晰，不要参考当前页原文。\n\n【当前页】${currentMarkdownSpec.title}\n【修改方式】${mode === "polish" ? "润色" : "修改"}\n【修改要求】${aiNote}`
      : `Please modify the current ${currentMarkdownSpec.title} page only. Keep the Markdown structure clear and do not use the current page text as a reference.\n\n[Current Page] ${currentMarkdownSpec.title}\n[Mode] ${mode === "polish" ? "polish" : "revise"}\n[Instructions] ${aiNote}`;
    const resolvedBookId = activeBookId ?? await ensureBookShell();
    if (!resolvedBookId) return;
    const content = await generateWizardStepBody(targetStep, instruction);
    if (!content) return;
    const saved = await saveWizardStepToFile(resolvedBookId, targetStep, content);
    if (saved) {
      syncDraftFromWizardStepContent(targetStep, content);
      applyWizardStepFileContent(targetStep, content);
      await loadWizardStepFromFile(resolvedBookId, targetStep);
      await refreshDraft();
    }
  }, [activeBookId, activeSessionId, applyWizardStepFileContent, bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, currentMarkdownSpec, currentStep, draft, ensureBookShell, generateWizardStepBody, loadWizardStepFromFile, projectLang, refreshDraft, saveWizardStepToFile, selectedGenre?.id, wizardBookId]);

  const ensureWizardStepSynced = useCallback(async (step: BookCreationWizardStep): Promise<boolean> => {
    const needsSync = shouldSyncWizardStep({
      targetStep: step,
      visibleStep: visibleWizardStep,
      localWizard: wizard,
      sessionWizard: activeSession?.creationWizard,
    });
    if (!needsSync) return true;
    return sendWizardControlRequest({
      intent: "goto_book_wizard",
      language: projectLang,
      stepTitle: WIZARD_STEPS.find((item) => item.id === step)?.title ?? step,
      wizardStep: step,
      title: bookTitle || draft?.title || undefined,
      genre: selectedGenre?.id ?? draft?.genre ?? undefined,
      platform: bookPlatform || draft?.platform || undefined,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
    }, projectLang === "zh" ? `已切换到 ${WIZARD_STEPS.find((item) => item.id === step)?.title ?? step}。` : `Moved to ${WIZARD_STEPS.find((item) => item.id === step)?.title ?? step}.`);
  }, [activeSession?.creationWizard, bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, draft, projectLang, selectedGenre?.id, sendWizardControlRequest, visibleWizardStep, wizard]);

  const handleRegenerateCurrentStep = useCallback(async (): Promise<void> => {
    if (isRegenerating || isAdvancing || isAutoCompleting) return;
    setIsRegenerating(true);
    try {
      if (currentStep === "intro") {
        const seed = introSeedText.trim() || composeIntroSeedText(draft?.blurb ?? "", draft?.storyBackground ?? "");
        const theme = introThemeText.trim() || selectedGenre?.name?.trim() || draft?.genre?.trim() || "";
        const response = await runIntroRevision({
          theme,
          title: bookTitle || draft?.title || undefined,
          platform: bookPlatform || draft?.platform || undefined,
          language: bookLanguage,
          targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
          chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
          seed,
          blurb: introBlurb || draft?.blurb || undefined,
          storyBackground: introStoryBackground || draft?.storyBackground || undefined,
        });
        if (response?.session?.creationDraft || response?.details?.creationDraft) {
          setIntroPanelTab("body");
        }
        return;
      }

      if (!currentMarkdownSpec) return;
      const targetStep = currentStep as Exclude<BookCreationWizardStep, "intro">;
      const synced = await ensureWizardStepSynced(targetStep);
      if (!synced) return;
      const instruction = buildWizardStepRegenerationInstruction({
        step: targetStep,
        title: currentMarkdownSpec.title,
        language: projectLang,
      });
      const resolvedBookId = activeBookId ?? wizardBookId;
      if (resolvedBookId) {
        const contentToSave = await generateWizardStepBody(targetStep, instruction);
        if (!contentToSave.trim() || isEmptyWizardBody(contentToSave)) {
          setStatus(projectLang === "zh" ? "重生成结果不是当前页有效正文，已拦截保存，请重试。" : "Regeneration result was not valid page body text, so saving was blocked.");
          return;
        }
        await saveWizardStepToFile(resolvedBookId, targetStep, contentToSave);
        syncDraftFromWizardStepContent(targetStep, contentToSave);
        applyWizardStepFileContent(targetStep, contentToSave);
        await refreshDraft();
        await loadWizardStepFromFile(resolvedBookId, targetStep);
      }
    } finally {
      setIsRegenerating(false);
    }
  }, [activeBookId, activeSession, activeSessionId, applyWizardStepFileContent, bookChapterWords, bookLanguage, bookPlatform, bookTitle, bookTargetChapters, currentMarkdownSpec, currentStep, draft, ensureWizardStepSynced, generateWizardStepBody, introBlurb, introSeedText, introStoryBackground, introThemeText, isAdvancing, isAutoCompleting, isRegenerating, loadWizardStepFromFile, projectLang, refreshDraft, runIntroRevision, saveWizardStepToFile, selectedGenre?.name, selectedGenre?.id, wizardBookId]);

  const handleSaveCurrentStep = useCallback(async (): Promise<boolean> => {
    if (!shouldAllowManualStepSave(currentStep)) {
      setStatus(projectLang === "zh" ? "第一页不会单独保存。请点击“下一步”后再保存并进入下一页。" : "The first page is not saved on its own. Click Next to save and continue.");
      return false;
    }
    const resolvedBookId = activeBookId ?? await ensureBookShell();
    if (!resolvedBookId) return false;
    setIsStepSaving(true);
    try {
      const content = (() => {
        if (currentStep === "intro") {
          return introBodyDraft;
        }
        if (currentStep === "world") {
          return stepDrafts.world ?? buildStepMarkdownDraft("world", draft ?? {}, projectLang);
        }
        return stepDrafts[currentStep] ?? buildStepMarkdownDraft(currentStep as Exclude<BookCreationWizardStep, "intro">, draft ?? {}, projectLang);
      })();
      const manualIssue = explainManualWizardStepContentIssue(currentStep, content, draft);
      if (manualIssue) {
        const message = projectLang === "zh"
          ? (() => {
              switch (manualIssue) {
                case "empty":
                  return "当前页内容为空，未保存。";
                case "summary":
                  return "当前页内容更像说明或汇报，不是可落库正文，未保存。";
                case "scaffold":
                  return "当前页内容仍以框架或占位符为主，未保存。";
                case "too_short":
                  return "当前页内容过短，缺少足够正文信息，未保存。";
                default:
                  return "当前页内容校验未通过，未保存。";
              }
            })()
          : (() => {
              switch (manualIssue) {
                case "empty":
                  return "Current page content is empty, so it was not saved.";
                case "summary":
                  return "Current page content looks like summary/status text instead of body content, so it was not saved.";
                case "scaffold":
                  return "Current page content is still mostly scaffold/placeholders, so it was not saved.";
                case "too_short":
                  return "Current page content is too short to be treated as valid body text, so it was not saved.";
                default:
                  return "Current page content did not pass validation, so it was not saved.";
              }
            })();
        setStatus(message);
        return false;
      }
      const saved = await saveWizardStepToFile(resolvedBookId, currentStep, content);
      if (saved) {
        syncDraftFromWizardStepContent(currentStep, content);
        applyWizardStepFileContent(currentStep, content);
        await loadWizardStepFromFile(resolvedBookId, currentStep);
        setStatus(projectLang === "zh" ? "当前页已保存。" : "Current step saved.");
        setStepEditing((current) => ({
          ...current,
          [currentStep]: false,
        }));
        return true;
      }
      return false;
    } finally {
      setIsStepSaving(false);
    }
  }, [activeBookId, currentStep, draft, ensureBookShell, introBodyDraft, loadWizardStepFromFile, projectLang, saveWizardStepToFile, stepDrafts, wizardBookId]);

  const handleSelectCandidate = useCallback(async (candidate: IntroCandidateLike, index: number, candidateCountOverride?: number) => {
    const theme = introThemeText.trim() || selectedGenre?.name?.trim() || candidate.style || candidate.title;
    if (!theme) return;
    const expansionSeed = buildIntroExpansionSeedText(candidate);
    const candidateCount = candidateCountOverride ?? introCandidates.length;
    await pauseAutoSaveDuring(async () => {
      suppressIntroAutoSave(true);
      setSelectedIntroCandidateIndex(index);
      setIntroMode("manual");
      setIntroTheme(theme);
      setBookTitle(resolveIntroCandidateTitle(candidate));
      try {
        await fetchJson<AgentResponse>("/interaction/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request: {
              intent: "select_intro_candidate",
              title: candidate.title,
              genre: selectedGenre?.id ?? draft?.genre ?? theme,
              genreName: selectedGenre?.name ?? theme,
              genreAlias: candidate.style ?? theme,
              genreSource: selectedGenre?.source === "builtin" || selectedGenre?.source === "project" || selectedGenre?.source === "custom"
                ? selectedGenre.source
                : "builtin",
              language: bookLanguage,
              platform: bookPlatform,
              targetChapters: parsePositiveIntegerInput(bookTargetChapters),
              chapterWordCount: parsePositiveIntegerInput(bookChapterWords),
              candidateIndex: index + 1,
              candidateCount,
              themeGenre: selectedGenre?.id ?? theme,
              blurb: candidate.blurb,
              storyBackground: candidate.storyBackground,
              instruction: expansionSeed,
            } satisfies BookCreateSessionRequest,
          }),
        });
        setStatus(projectLang === "zh" ? `已选中第${index + 1} 套候选。` : `Selected candidate #${index + 1}.`);
        await refreshDraft();
        syncDisplayedStepDraft("intro");
      } catch (cause) {
        if (cause instanceof ApiRequestError && cause.status === 409) {
          setBlockedPrompt({
            title: projectLang === "zh" ? "候选选择被阻挡" : "Candidate selection blocked",
            message: cause.message,
          });
          suppressIntroAutoSave(false);
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        suppressIntroAutoSave(false);
      }
    });
  }, [bookChapterWords, bookLanguage, bookPlatform, draft?.genre, fetchJson, introCandidates.length, introThemeText, pauseAutoSaveDuring, projectLang, refreshDraft, selectedGenre?.id, selectedGenre?.name, selectedGenre?.source, suppressIntroAutoSave, syncDisplayedStepDraft]);

  const handleGenerateCandidates = useCallback(async () => {
    const theme = introThemeText.trim() || selectedGenre?.name?.trim() || "";
    if (!theme) {
      setError(projectLang === "zh" ? "请先输入主题或选择题材。" : "Please enter a theme or pick a genre first.");
      return;
    }
    const themeGenre = selectedGenre?.id ?? theme;
    const themeLabel = themeGenre || "未选";
    setIntroCandidateLoading(true);
    try {
      if (!activeSessionId) {
        throw new Error(projectLang === "zh" ? "右侧 AI 工作台尚未就绪。" : "The AI workbench is not ready yet.");
      }
      const candidateInstruction = buildIntroCandidateGenerationInstruction({
        language: projectLang,
        title: bookTitle || "未填",
        genre: themeLabel,
        platform: bookPlatform || "未选",
        theme: theme || selectedGenre?.name || "未填",
        introBlurb: introBlurb || "",
        introStoryBackground: introStoryBackground || "",
        candidateCount: parsePositiveIntegerInput(introCandidateCount) ?? 3,
      });
      const data = await sendMessage(
        activeSessionId,
        candidateInstruction,
        activeBookId ?? undefined,
        { wizardStep: currentStep, forceStream: true, responseFormat: "json_object" },
      ) as AgentResponse | null;
      const raw = data?.response ?? data?.details?.draftRaw ?? "";
      const parsed = parseIntroCandidateResponse(raw);
      const fallback = raw.trim()
        ? [{ title: selectedGenre?.name ?? theme, blurb: raw.trim(), storyBackground: raw.trim(), style: selectedGenre?.name ?? theme, reason: "模型未返回结构化候选，已用单条结果兜底。" }]
        : [];
      const ranked = rankIntroCandidates(parsed.length > 0 ? parsed : fallback, selectedGenre?.id ?? theme);
      setIntroCandidates(ranked);
      if (ranked.length > 0) {
        await handleSelectCandidate(ranked[0]!, 0, ranked.length);
        return;
      }
      setSelectedIntroCandidateIndex(0);
      await refreshDraft();
    } finally {
      setIntroCandidateLoading(false);
    }
  }, [activeBookId, activeSessionId, bookPlatform, bookTitle, currentStep, handleSelectCandidate, introCandidateCount, introBlurb, introStoryBackground, introThemeText, projectLang, refreshDraft, sendMessage, selectedGenre]);

  const handleJumpToStep = useCallback(async (step: "intro" | "world" | "outline" | "volume" | "characters" | "arc" | "relation") => {
    if (step === currentStep) return;
    if (navigationLocked) {
      setStatus(projectLang === "zh"
        ? "当前页正在生成中，请先完成或停止后再切换向导页。"
        : "The current page is still generating. Please finish or stop it before switching steps.");
      return;
    }
    await pauseAutoSaveDuring(async () => {
      const resolvedBookId = activeBookId ?? await ensureBookShell();
      if (!resolvedBookId) return;
      const persisted = await saveWizardStepToFile(
        resolvedBookId,
        currentStep,
        currentStepContent ?? "",
      );
      if (!persisted) return;
      syncDraftFromWizardStepContent(currentStep, currentStepContent ?? "");
      await loadWizardStepFromFile(resolvedBookId, step);
      setUserRequestedVisibleStep(step);
      const targetMeta = WIZARD_STEPS.find((item) => item.id === step);
      setStatus(projectLang === "zh"
        ? `已切换到 ${targetMeta?.title ?? step}。`
        : `Moved to ${targetMeta?.title ?? step}.`);
    });
  }, [activeBookId, currentStep, currentStepContent, ensureBookShell, loadWizardStepFromFile, navigationLocked, pauseAutoSaveDuring, projectLang, saveWizardStepToFile, syncDraftFromWizardStepContent]);

  const { visibleMessages: rawStepMessages, legacyMessageCount } = useMemo(
    () => selectBookCreateDockMessages(allMessages, currentStep),
    [allMessages, currentStep],
  );
  const messages = rawStepMessages;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  const chatGuide = buildChatGuide(currentStep as never, projectLang);
  const hardParams = buildHardParamsSummary({
    title: draft?.title,
    platform: draft?.platform,
    language: draft?.language ?? projectLang,
    targetChapters: draft?.targetChapters,
    chapterWordCount: draft?.chapterWordCount,
  }, projectLang);
  const wizardIndex = useMemo(() => WIZARD_STEPS.map((item) => ({
    ...item,
    status: (item.id === currentStep
      ? "current"
      : wizard?.completedSteps?.includes(item.id)
        ? "done"
        : "todo") as "current" | "done" | "todo",
  })), [currentStep, wizard?.completedSteps]);
  const setIntroSeedTextWithAutoSaveReset = useCallback((value: string) => {
    suppressIntroAutoSave(false);
    setIntroSeedText(value);
  }, [suppressIntroAutoSave]);
  const setIntroBodyDraftWithTouch = useCallback((value: string) => {
    setIntroBodyDirty(true);
    setIntroBodyDraft(value);
  }, []);
  const onSend = useCallback((text: string) => {
    if (loading || stopping) return;
    if (!activeSessionId) return;
    void sendMessage(activeSessionId, text, activeBookId ?? undefined, { skipAutoNewPrefix: true, wizardStep: currentStep });
  }, [activeBookId, activeSessionId, currentStep, loading, sendMessage, stopping]);

  const handleSelectGenreId = useCallback((value: string) => {
    setGenreSelectionTouched(true);
    setSelectedGenreId(value);
  }, []);

  return (
    <div className="flex min-h-full min-w-0 flex-1 overflow-hidden">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-6 py-6 lg:px-8">
        <div className="flex min-h-0 w-full flex-1 flex-col gap-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
            <span className="text-border">/</span>
            <span>{t("bread.newBook")}</span>
          </div>
          <h1 className="font-serif text-3xl">{t("create.title")}</h1>
          <WizardHeader
            wizardIndex={wizardIndex}
            onJumpToStep={handleJumpToStep}
            navigationLocked={navigationLocked}
          />
          {navigationLocked ? (
            <div className="rounded-md border border-amber-400/40 bg-amber-50/70 px-4 py-3 text-sm text-amber-900">
              {projectLang === "zh"
                ? "当前页正在生成或保存中，已暂时锁定向导页切换。请等待完成，或先停止当前任务。"
                : "The current page is generating or saving. Wizard navigation is temporarily locked. Wait for completion or stop the current task first."}
            </div>
          ) : null}
          {error && <div className={`rounded-md border ${c.error} px-4 py-3`}>{error}</div>}
          {status && <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">{status}</div>}
          {currentStep === "intro" && !((draft?.title ?? bookTitle).trim()) ? (
            <div className="rounded-md border border-amber-400/50 bg-amber-50/70 px-4 py-3 text-sm text-amber-900">
              {projectLang === "zh"
                ? "当前未生成书名。生成正文后请确认书名已回填，或在书名框手工录入并失焦保存；未补齐前不能进入下一步。"
                : "No title has been generated yet. Confirm the title was filled after intro generation, or enter it manually and save it by blurring the field before continuing."}
            </div>
          ) : null}
          {shouldShowValidationPanel && currentValidationReport ? (
            <StepValidationBanner
              report={currentValidationReport}
              onAutoFix={handleAutoFixCurrentStep}
              onAdvance={currentStep === "relation" ? handleCreate : handleAdvance}
              isAutoFixing={isAutoCompleting}
              canAdvance={currentStep === "relation"
                ? canCreate && !creating && !isAdvancing && !isAutoCompleting
                : Boolean(nextStepMeta) && !creating && !isAdvancing && !isAutoCompleting}
            />
          ) : null}
          <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-6 xl:flex-row xl:items-stretch">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/60 bg-card/70 p-5 overflow-hidden">
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
                {currentStep === "intro" ? (
                  <IntroPanel
                    c={c}
                    introBodySpec={{
                      title: "简介 / 故事背景正文",
                      description: "默认以 Markdown 预览显示，切换到编辑后可直接修改正文。",
                      sections: [
                        { key: "blurb", title: "一句话卖点", placeholder: "一句话卖点..." },
                        { key: "storyBackground", title: "故事背景", placeholder: "故事背景..." },
                      ],
                    }}
                    introPanelTab={introPanelTab}
                    genres={genresData?.genres ?? []}
                    selectedGenreId={selectedGenreId}
                    selectedGenreLabel={selectedGenre?.name ?? introThemeText.trim() ?? "未选择"}
                    genreBindingLabel={genreBindingLabel}
                    introMode={introMode}
                    introSeedText={introSeedText}
                    introBodyDraft={introBodyDraft}
                    introTheme={introThemeText}
                    introCandidateCount={introCandidateCount}
                    introCandidates={introCandidates}
                    selectedIntroCandidateIndex={selectedIntroCandidateIndex}
                    selectedIntroCandidate={selectedIntroCandidate}
                    loadingDraft={loadingDraft}
                    loading={loading}
                    creating={creating}
                    introGenerationActive={introGenerationActive}
                    introGenerationPhase={introGenerationPhase}
                    introCandidateLoading={introCandidateLoading}
                    autoGenerateAllowed={autoGenerateAllowed}
                    introBodyEditing={introBodyEditing}
                    introBodySaving={isStepSaving && currentStep === "intro"}
                    bookTitle={bookTitle}
                    bookLanguage={bookLanguage}
                    bookPlatform={bookPlatform}
                    bookTargetChapters={bookTargetChapters}
                    bookChapterWords={bookChapterWords}
                    titleReady={Boolean((draft?.title ?? bookTitle).trim())}
                    hardParams={hardParams}
                    setSelectedGenreId={handleSelectGenreId}
                    setIntroPanelTab={setIntroPanelTab}
                    setIntroMode={setIntroMode}
                    setIntroSeedText={setIntroSeedTextWithAutoSaveReset}
                    setIntroBodyDraft={setIntroBodyDraftWithTouch}
                    setIntroTheme={setIntroTheme}
                    setIntroCandidateCount={setIntroCandidateCount}
                    setIntroBodyEditing={setIntroBodyEditing}
                    setBookTitle={setBookTitle}
                    commitBookTitle={handleBookTitleCommit}
                    setBookLanguage={setBookLanguage}
                    setBookPlatform={setBookPlatform}
                    setBookTargetChapters={setBookTargetChapters}
                    setBookChapterWords={setBookChapterWords}
                    onBookTargetChaptersTouched={() => setBookTargetChaptersTouched(true)}
                    onBookChapterWordsTouched={() => setBookChapterWordsTouched(true)}
                    handleGenerateIntroBody={handleGenerateIntroBody}
                    handleGenerateCandidates={handleGenerateCandidates}
                    handleSelectCandidate={handleSelectCandidate}
                    handleGenerateCandidateBody={handleGenerateCandidateBody}
                    handleIntroAiModify={handleIntroAiModify}
                    handleSaveIntroBody={undefined}
                  />
                ) : isMarkdownStep && currentMarkdownSpec ? (
                  <StepMarkdownEditor
                    spec={currentMarkdownSpec}
                    value={currentStepDraft}
                    editing={stepEditing[currentStep as keyof typeof stepEditing] ?? false}
                    onToggleEditing={() => {
                      setStepEditing((current) => ({
                        ...current,
                        [currentStep]: !(current[currentStep as keyof typeof current] ?? false),
                      }));
                    }}
                    onSave={handleSaveCurrentStep}
                    onValueChange={(value) => setStepDrafts((current) => ({ ...current, [currentStep]: value }))}
                    onAiModify={(note, mode) => void handleMarkdownAiModify(note, mode, currentStep as Exclude<BookCreationWizardStep, "intro">)}
                    saving={isStepSaving}
                  />
                ) : null}
                <WizardActions
                  canGoBack={canGoBack}
                  canAdvance={Boolean(nextStepMeta) && !creating && !isAdvancing && !isAutoCompleting}
                  creating={creating}
                  isAdvancing={isAdvancing}
                  isAutoCompleting={isAutoCompleting}
                  isRegenerating={isRegenerating}
                  currentStep={currentStep}
                  canCreate={canCreate}
                  showAutoComplete={currentStep !== "intro"}
                  handleDiscard={handleDiscard}
                  handleBack={handleBack}
                  handleAdvance={handleAdvance}
                  handleRegenerate={handleRegenerateCurrentStep}
                  handleCreate={handleCreate}
                  handleAutoComplete={handleAutoComplete}
                />
                </div>
              </div>
            </section>
            <BookCreateChatDock
              nav={nav}
              pageTheme={theme}
              title={currentStepMeta.title}
              subtitle={currentStepMeta.subtitle}
              chatGuide={chatGuide}
              legacyMessageCount={legacyMessageCount}
              canStop={canStop}
              isAdvancing={isAdvancing}
              selectedModel={selectedModel}
              selectedService={selectedService}
              modelPickerStatus={modelPickerStatus}
              filteredGroupedModels={filteredGroupedModels}
              messages={messages}
              loading={loading}
              input={input}
              setInput={setInput}
              stopMessage={stopMessage}
              activeSessionId={activeSessionId}
              scrollRef={scrollRef}
              textareaRef={textareaRef}
              c={c}
              onSend={onSend}
              setSelectedModel={setSelectedModel}
            />
          </div>
        </div>
        <ConfirmDialog
          open={discardConfirmOpen}
          title={projectLang === "zh" ? "清除草稿" : "Clear Draft"}
          message={projectLang === "zh" ? "确认清除当前草稿吗？此操作无法撤销。" : "Clear the current draft? This cannot be undone."}
          confirmLabel={projectLang === "zh" ? "确认清除" : "Clear"}
          cancelLabel={projectLang === "zh" ? "取消" : "Cancel"}
          variant="danger"
          onConfirm={() => { void confirmDiscard(); }}
          onCancel={() => setDiscardConfirmOpen(false)}
        />
        <ConfirmDialog
          open={Boolean(blockedPrompt)}
          title={blockedPrompt?.title ?? (projectLang === "zh" ? "操作被阻挡" : "Operation blocked")}
          message={blockedPrompt?.message ?? ""}
          confirmLabel={projectLang === "zh" ? "知道了" : "OK"}
          cancelLabel={projectLang === "zh" ? "关闭" : "Close"}
          onConfirm={() => setBlockedPrompt(null)}
          onCancel={() => setBlockedPrompt(null)}
        />
      </main>
    </div>
  );
}
