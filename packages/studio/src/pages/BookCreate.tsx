import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookCreationDraft, BookCreationWizardState, BookCreationWizardStep } from "@actalk/inkos-core";
import { ApiRequestError, fetchJson, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { chatSelectors, useChatStore } from "../store/chat";
import { useServiceStore } from "../store/service";
import type { Message as ChatMessageType } from "../store/chat/types";
import { filterModelGroups, resolveModelSelection } from "./chat-page-state";
import { BookCreateChatDock, IntroPanel, ReviewPanel, StepValidationBanner, WizardActions, WizardHeader } from "./book-create-panels";
import { StepMarkdownEditor } from "./StepMarkdownEditor";
import {
  buildChatActionLabels,
  buildChatGuide,
  buildChatQuickTemplates,
  buildConceptSplitSummary,
  buildCreationDraftSummary,
  buildCreationReviewChecklist,
  buildHardParamsSummary,
  buildBookCreateCommand,
  buildStepActionSections,
  buildStepFocusCard,
  buildStepRecommendedAction,
  buildStepShortcuts,
  buildStepValidationReport,
  buildWizardValidationReports,
  buildIntroCandidateBackfill,
  buildStepMarkdownDraft,
  buildIntroMarkdownDraft,
  getStepMarkdownSpec,
  mergeCreationWizardState,
  resolveIntroCandidateTitle,
  composeIntroSeedText,
  buildWizardStepSeedText,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  parseIntroCandidateResponse,
  parseLatestIntroCandidates,
  parseIntroSeedText,
  buildIntroExpansionSeedText,
  parsePositiveIntegerInput,
  platformOptionsForLanguage,
  pickValidValue,
  rankIntroCandidates,
  type StepShortcut,
  resolveDraftInstruction,
  resolveGenreMapping,
  resolveInitialGenreSelection,
  selectBookCreateDockMessages,
  shouldSubmitChatOnKeyDown,
  waitForBookReady,
  WIZARD_STEPS,
  type IntroCandidateLike,
  type StepValidationReport,
} from "./book-create-state";

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
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  parseIntroCandidateResponse,
  parseLatestIntroCandidates,
  parsePositiveIntegerInput,
  platformOptionsForLanguage,
  pickValidValue,
  rankIntroCandidates,
  selectBookCreateDockMessages,
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

interface BlockedPromptState {
  readonly title: string;
  readonly message: string;
}

interface BookCreateSessionRequest {
  readonly intent: "select_intro_candidate";
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




export function BookCreate({ nav, theme, t, draftSessionId }: { nav: Nav; theme: Theme; t: TFunction; draftSessionId?: string }) {
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
  const [introCandidateCount, setIntroCandidateCount] = useState("3");
  const [introCandidates, setIntroCandidates] = useState<ReadonlyArray<IntroCandidateLike>>([]);
  const [selectedIntroCandidateIndex, setSelectedIntroCandidateIndex] = useState(0);
  const [introCandidateLoading, setIntroCandidateLoading] = useState(false);
  const [introPanelTab, setIntroPanelTab] = useState<"generate" | "body">("generate");
  const [introBodyEditing, setIntroBodyEditing] = useState(false);
  const [stepDrafts, setStepDrafts] = useState<Partial<Record<"intro" | "world" | "outline" | "volume" | "characters" | "arc" | "relation" | "review", string>>>({});
  const [stepEditing, setStepEditing] = useState<Partial<Record<"world" | "outline" | "volume" | "characters" | "arc" | "relation", boolean>>>({});
  const [validationPanelStep, setValidationPanelStep] = useState<BookCreationWizardStep | null>(null);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [isAutoCompleting, setIsAutoCompleting] = useState(false);
  const [visibleWizardStep, setVisibleWizardStep] = useState<BookCreationWizardStep>("intro");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWizardStepRef = useRef<BookCreationWizardStep | null>(null);
  const suppressIntroAutoSaveRef = useRef(false);
  const suppressAutoSaveRef = useRef(false);
  const wizardStepOrder = useMemo(
    () => new Map(WIZARD_STEPS.map((item, index) => [item.id, index] as const)),
    [],
  );

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
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
    if (!draftSessionId) {
      setDraft(undefined);
      setWizard(undefined);
      return;
    }
    await loadSessionDetail(draftSessionId);
    const state = useChatStore.getState();
    const session = state.sessions[draftSessionId];
    setDraft(session?.creationDraft);
    setWizard((current) => mergeCreationWizardState({
      current,
      fetched: session?.creationWizard,
      pendingStep: pendingWizardStepRef.current,
    }));
  }, [draftSessionId, loadSessionDetail]);

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
    const serverIndex = wizardStepOrder.get(serverStep) ?? 0;
    const visibleIndex = wizardStepOrder.get(visibleWizardStep) ?? 0;
    if (serverIndex > visibleIndex) {
      setVisibleWizardStep(serverStep);
    }
  }, [visibleWizardStep, wizard?.currentStep, wizardStepOrder]);

  useEffect(() => {
    if (!genresData?.genres.length) return;
    const nextGenreId = resolveInitialGenreSelection(selectedGenreId, genresData.genres, draft?.genre, projectLang);
    if (nextGenreId && nextGenreId !== selectedGenreId) setSelectedGenreId(nextGenreId);
  }, [draft?.genre, genresData?.genres, projectLang, selectedGenreId]);

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
    if (draft?.genreAlias && !introTheme) setIntroTheme(draft.genreAlias);
  }, [bookChapterWordsTouched, bookLanguage, bookChapterWords, bookPlatform, bookTargetChaptersTouched, bookTargetChapters, bookTitle, draft, introSeedText, introTheme, projectLang]);

  useEffect(() => {
    if (!draft) return;
    setStepDrafts((current) => {
      const next = { ...current };
      for (const step of WIZARD_STEPS.map((item) => item.id)) {
        if (next[step]) continue;
        const seed = buildWizardStepSeedText(step, draft, projectLang);
        if (seed) next[step] = seed;
      }
      return next;
    });
  }, [draft, projectLang]);

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  useEffect(() => { for (const svc of services) if (svc.connected) void fetchModels(svc.service); }, [services, fetchModels]);

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
    const resolved = resolveModelSelection(groupedModels, selectedModel, selectedService);
    if (resolved && (resolved.model !== selectedModel || resolved.service !== selectedService)) {
      setSelectedModel(resolved.model, resolved.service);
    }
  }, [groupedModels, selectedModel, selectedService, setSelectedModel]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (draftSessionId) {
        await loadSessionDetail(draftSessionId);
        if (cancelled) return;
        const state = useChatStore.getState();
        const session = state.sessions[draftSessionId];
        if (session?.bookId === null) {
          activateSession(draftSessionId);
          return;
        }
        if (session?.bookId) {
          nav.toBook(session.bookId);
          return;
        }
      }
      const sessionId = createDraftSession(null);
      if (!cancelled) activateSession(sessionId);
    })();
    return () => { cancelled = true; };
  }, [activateSession, createDraftSession, draftSessionId, loadSessionDetail, nav]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const currentStep = visibleWizardStep;
  const currentStepIndex = Math.max(0, WIZARD_STEPS.findIndex((s) => s.id === currentStep));
  const currentStepMeta = WIZARD_STEPS[currentStepIndex] ?? WIZARD_STEPS[0]!;
  const nextStepMeta = WIZARD_STEPS[currentStepIndex + 1];
  const canGoBack = currentStepIndex > 0;
  const canCreate = currentStep === "review" && canCreateFromDraft(draft);
  const validationReports = useMemo(() => buildWizardValidationReports(draft, projectLang), [draft, projectLang]);
  const worldStepDraft = stepDrafts.world ?? buildWizardStepSeedText("world", draft ?? {}, projectLang);
  const introMarkdownDraft = introBodyDraft || buildIntroMarkdownDraft(draft ?? {}, projectLang);
  const currentStepDraft = currentStep === "intro"
    ? introMarkdownDraft
    : currentStep === "world"
      ? worldStepDraft
      : stepDrafts[currentStep] ?? buildStepMarkdownDraft(currentStep as Exclude<BookCreationWizardStep, "intro" | "review">, draft ?? {}, projectLang);
  const currentStepContent = currentStep === "intro"
    ? introMarkdownDraft
    : currentStep === "world"
      ? worldStepDraft
      : currentStepDraft;
  const currentValidationReport = useMemo(() => {
    if (currentStep === "intro") {
      return buildStepValidationReport("intro", draft ?? {}, projectLang, currentStepContent);
    }
    if (currentStep === "review") return validationReports[currentStep];
    return buildStepValidationReport(currentStep, draft ?? {}, projectLang, currentStepDraft);
  }, [currentStep, currentStepContent, currentStepDraft, draft, projectLang, validationReports]);
  const selectedGenre = genresData?.genres.find((genre) => genre.id === selectedGenreId) ?? null;
  const selectedIntroCandidate = introCandidates[selectedIntroCandidateIndex] ?? null;
  const parsedIntroSeed = parseIntroSeedText(introSeedText);
  const introBlurb = parsedIntroSeed.blurb;
  const introStoryBackground = parsedIntroSeed.storyBackground;
  useEffect(() => {
    if (!draft) return;
    setIntroBodyDraft(buildIntroMarkdownDraft(draft, projectLang));
  }, [draft, projectLang]);
  const isMarkdownStep = currentStep !== "intro" && currentStep !== "review";
  const currentMarkdownSpec = isMarkdownStep ? getStepMarkdownSpec(currentStep as Exclude<BookCreationWizardStep, "intro" | "review">) : null;
  const autoGenerateAllowed = Boolean(introTheme.trim() || selectedGenre?.name?.trim());
  const stopping = activeSession?.isStopping ?? false;
  const canStop = Boolean(activeSessionId) && (loading || stopping);
  const shouldShowValidationPanel = validationPanelStep === currentStep;
  const syncDisplayedStepDraft = useCallback((step: BookCreationWizardStep) => {
    const sessionId = draftSessionId ?? activeSessionId;
    const latestDraft = sessionId ? (useChatStore.getState().sessions[sessionId]?.creationDraft ?? draft) : draft;
    if (!latestDraft) return;
    if (step === "intro") {
      setIntroSeedText(composeIntroSeedText(latestDraft.blurb ?? "", latestDraft.storyBackground ?? ""));
      setIntroBodyDraft(buildIntroMarkdownDraft(latestDraft, projectLang));
      return;
    }
    if (step === "review") return;
    setStepDrafts((current) => ({
      ...current,
      [step]: buildStepMarkdownDraft(step, latestDraft, projectLang),
    }));
  }, [activeSessionId, draft, draftSessionId, projectLang]);

  useEffect(() => {
    setValidationPanelStep(null);
  }, [currentStep]);

  // 自动保存：stepDrafts / introSeedText 变化后 debounce 600ms，静默 POST save_wizard_step
  useEffect(() => {
    if (!activeSessionId || suppressAutoSaveRef.current || isAdvancing || isAutoCompleting || loading) return;
    const content = currentStep === "intro"
      ? introMarkdownDraft
      : currentStep === "world"
        ? (stepDrafts.world ?? "")
        : (stepDrafts[currentStep] ?? "");
    if (currentStep === "intro" && suppressIntroAutoSaveRef.current) return;
    if (!content.trim()) return;
    clearAutoSaveTimer();
    autoSaveTimerRef.current = setTimeout(() => {
      void fetchJson("/interaction/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: {
            intent: "save_wizard_step",
            language: projectLang,
            stepTitle: currentStepMeta.title,
            wizardStep: currentStep,
            title: bookTitle || undefined,
            genre: selectedGenre?.id ?? draft?.genre ?? undefined,
            platform: bookPlatform || undefined,
            targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
            chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
            instruction: content,
          },
        }),
      }).catch(() => { /* 静默失败，不影响用户操作 */ });
    }, 600);
    return clearAutoSaveTimer;
  }, [activeSessionId, bookChapterWords, bookPlatform, bookTargetChapters, bookTitle, clearAutoSaveTimer, currentStep, currentStepMeta.title, draft?.chapterWordCount, draft?.genre, draft?.targetChapters, introMarkdownDraft, isAdvancing, loading, projectLang, selectedGenre?.id, stepDrafts]);
  const sendCommand = useCallback(async (
    instruction: string,
    wizardStep: BookCreationWizardStep = currentStep,
    options?: {
      readonly refreshDraft?: boolean;
      readonly wizardAdvance?: Omit<BookCreateWizardControlRequest, "intent">;
    },
  ): Promise<AgentResponse | null> => {
    if (!activeSessionId) {
      setError(projectLang === "zh" ? "右侧 AI 工作台尚未就绪。" : "The AI workbench is not ready yet.");
      return null;
    }
    try {
      const data = await sendMessage(activeSessionId, instruction, undefined, {
        skipAutoNewPrefix: true,
        wizardStep,
        ...(options?.wizardAdvance ? { wizardAdvance: options.wizardAdvance } : {}),
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
  }, [activeSessionId, currentStep, projectLang, refreshDraft, sendMessage]);

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
        setVisibleWizardStep(session.creationWizard.currentStep);
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
  }, [activeSessionId, projectLang, visibleWizardStep, wizardStepOrder]);

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
      patchWizardStep(targetStep, currentStep);
      const draftContext = draft
        ? buildCreationDraftSummary(draft, projectLang)
            .map((row) => `${row.label}：${row.value}`)
            .join("\n")
        : "";
      const generationRequest = projectLang === "zh"
        ? `你现在在处理"${nextStepMeta.title}"页。请根据已有草案和以下${currentStepMeta.title}内容，生成${nextStepMeta.title}页草案，只补当前页允许的字段，不要扩写其他页面，也不要创建新书。\n\n【已有草案】\n${draftContext || "（空）"}\n\n【${currentStepMeta.title}内容】\n${currentStepContent || "（空）"}`
        : `You are now working on the "${nextStepMeta.title}" page. Based on the existing draft and the ${currentStepMeta.title} content below, generate a draft for the ${nextStepMeta.title} page. Only fill in fields allowed for this page, do not expand other pages or create a new book.\n\n[Existing Draft]\n${draftContext || "(empty)"}\n\n[${currentStepMeta.title} Content]\n${currentStepContent || "(empty)"}`;

      await sendCommand(generationRequest, targetStep, {
        refreshDraft: false,
        wizardAdvance: {
          wizardStep: currentStep,
          language: projectLang,
          stepTitle: currentStepMeta.title,
          title: bookTitle || draft?.title || undefined,
          genre: selectedGenre?.id ?? draft?.genre ?? "",
          platform: bookPlatform || draft?.platform || undefined,
          targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
          chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
          instruction: currentStepContent,
        },
      });
      await refreshDraft();
      syncDisplayedStepDraft(targetStep);
    } finally {
      pendingWizardStepRef.current = null;
      setIsAdvancing(false);
    }
  }, [bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, clearAutoSaveTimer, currentStep, currentStepContent, currentStepMeta.title, currentValidationReport.status, currentValidationReport.summary, draft, nextStepMeta, patchWizardStep, projectLang, refreshDraft, selectedGenre?.id, sendCommand, syncDisplayedStepDraft]);

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
        ? `请根据当前页缺失项补全当前${currentStepMeta.title}页内容，只补当前页允许的字段，不要改其他页。\n\n【当前页】${currentStepMeta.title}\n【缺失项】${issueSummary}\n\n【已有草案】\n${draftContext || "（空）"}\n\n【当前页内容】\n${currentStepContent || "（空）"}`
        : `Please fill the missing items for the current ${currentStepMeta.title} page only. Do not modify other pages.\n\n[Current Step] ${currentStepMeta.title}\n[Missing Items] ${issueSummary}\n\n[Existing Draft]\n${draftContext || "(empty)"}\n\n[Current Page Content]\n${currentStepContent || "(empty)"}`;
      await sendCommand(instruction, currentStep, { refreshDraft: false });
      await refreshDraft();
      syncDisplayedStepDraft(currentStep);
    } finally {
      setIsAutoCompleting(false);
    }
  }, [activeSessionId, currentStep, currentStepContent, currentStepMeta.title, currentValidationReport.status, currentValidationReport.issues, draft, projectLang, refreshDraft, sendCommand, syncDisplayedStepDraft]);

  const handleBack = useCallback(async () => {
    if (!canGoBack) return;
    await pauseAutoSaveDuring(async () => {
      const saved = await sendWizardControlRequest({
        intent: "save_wizard_step",
        language: projectLang,
        stepTitle: currentStepMeta.title,
        wizardStep: currentStep,
        title: bookTitle || draft?.title || undefined,
        genre: selectedGenre?.id ?? draft?.genre ?? undefined,
        platform: bookPlatform || draft?.platform || undefined,
        targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
        chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
        instruction: currentStepContent,
      }, projectLang === "zh" ? "已保存当前页草稿。" : "Saved the current page draft.");
      if (!saved) return;
      await sendWizardControlRequest({
        intent: "retreat_book_wizard",
        language: projectLang,
        stepTitle: currentStepMeta.title,
        wizardStep: currentStep,
      }, projectLang === "zh" ? "已返回上一步。" : "Moved back to the previous step.");
    });
  }, [bookChapterWords, bookPlatform, bookTitle, canGoBack, currentStep, currentStepContent, currentStepMeta.title, draft?.genre, draft?.platform, draft?.targetChapters, projectLang, pauseAutoSaveDuring, sendWizardControlRequest, selectedGenre?.id]);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const data = await sendCommand(buildBookCreateCommand({
        kind: "create",
        language: projectLang,
        stepTitle: currentStepMeta.title,
        currentStep,
        title: bookTitle || draft?.title || undefined,
        genre: selectedGenre?.id ?? draft?.genre ?? "",
        platform: bookPlatform || draft?.platform || undefined,
        targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
        chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
      }).instruction);
      const bookId = data?.session?.activeBookId ?? data?.details?.activeBookId;
      if (!bookId) throw new Error(projectLang === "zh" ? "创建完成但未返回书籍 ID。" : "Create succeeded but no book id was returned.");
      await waitForBookReady(bookId);
      const nextTitle = bookTitle.trim();
      const currentTitle = activeSession?.title?.trim() ?? "";
      if (activeSessionId && nextTitle && nextTitle !== currentTitle) {
        await renameSession(activeSessionId, nextTitle);
      }
      setDraft(undefined);
      setWizard(undefined);
      setVisibleWizardStep("intro");
      void loadSessionList(null);
      nav.toBook(bookId);
    } finally {
      setCreating(false);
    }
  }, [activeSession?.title, activeSessionId, bookChapterWords, bookPlatform, bookTitle, canCreate, currentStepMeta.title, draft, loadSessionList, nav, projectLang, renameSession, selectedGenre?.id, sendCommand, bookTargetChapters]);

  const handleAutoComplete = useCallback(async () => {
    if (isAutoCompleting || isAdvancing) return;
    const stepsToRun = WIZARD_STEPS.filter((s) => s.id !== "review" && s.id !== "intro").slice(
      Math.max(0, WIZARD_STEPS.findIndex((s) => s.id === currentStep)),
    );
    if (stepsToRun.length === 0) return;
    setIsAutoCompleting(true);
    setStatus(projectLang === "zh" ? "全自动模式：依次生成各步骤内容..." : "Auto mode: generating all steps...");
    try {
      for (const stepMeta of stepsToRun) {
        if (stepMeta.id === "review") break;
        const nextStepIndex = WIZARD_STEPS.findIndex((s) => s.id === stepMeta.id) + 1;
        const nextMeta = WIZARD_STEPS[nextStepIndex];
        if (!nextMeta) break;
        if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
        setStatus(projectLang === "zh" ? `全自动：正在保存并生成 ${nextMeta.title}...` : `Auto: saving and generating ${nextMeta.title}...`);
        const draftContext = draft
          ? buildCreationDraftSummary(draft, projectLang).map((row) => `${row.label}：${row.value}`).join("\n")
          : "";
        const saved = await sendWizardControlRequest({
          intent: "advance_book_wizard",
          language: projectLang,
          stepTitle: stepMeta.title,
          wizardStep: stepMeta.id,
          title: bookTitle || draft?.title || undefined,
          genre: selectedGenre?.id ?? draft?.genre ?? "",
          platform: bookPlatform || draft?.platform || undefined,
          targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
          chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
          instruction: currentStep === "intro" ? introSeedText : (stepDrafts[stepMeta.id] ?? ""),
        }, projectLang === "zh" ? `已进入 ${nextMeta.title}。` : `Moved to ${nextMeta.title}.`);
        if (!saved) break;
        patchWizardStep(nextMeta.id, stepMeta.id);
        if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
        const generationRequest = projectLang === "zh"
          ? `你现在在处理"${nextMeta.title}"页（全自动模式）。请根据已有草案生成${nextMeta.title}页草案，只补当前页允许的字段，不要扩写其他页面，也不要创建新书。\n\n【已有草案】\n${draftContext || "（空）"}`
          : `You are now working on the "${nextMeta.title}" page (auto mode). Based on the existing draft, generate a draft for the ${nextMeta.title} page. Only fill in fields allowed for this page.\n\n[Existing Draft]\n${draftContext || "(empty)"}`;
        await sendCommand(generationRequest, nextMeta.id, { refreshDraft: false });
        await refreshDraft();
        syncDisplayedStepDraft(nextMeta.id);
      }
      setStatus(projectLang === "zh" ? "全自动完成，请在收尾校验页确认后创建。" : "Auto complete. Please review and create.");
    } finally {
      setIsAutoCompleting(false);
    }
  }, [bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, currentStep, draft, isAdvancing, isAutoCompleting, patchWizardStep, projectLang, refreshDraft, selectedGenre?.id, sendCommand, sendWizardControlRequest, stepDrafts, introSeedText, syncDisplayedStepDraft]);

  const handleDiscard = useCallback(async () => {
    setDiscardConfirmOpen(true);
  }, []);

  const handleGenerateIntroBody = useCallback(async () => {
    const seed = introSeedText.trim() || composeIntroSeedText(draft?.blurb ?? "", draft?.storyBackground ?? "");
    if (!seed) {
      setError(projectLang === "zh" ? "请先输入简介或卖点。" : "Please enter a hook or blurb first.");
      return;
    }
    const theme = introTheme.trim() || selectedGenre?.name?.trim() || draft?.genre?.trim() || "";
    const instruction = projectLang === "zh"
      ? `请根据以下输入生成可直接落库的简介正文，只输出正文内容，不要附加说明。

【书名】${bookTitle || "未填"}
【题材】${selectedGenre?.name ?? selectedGenre?.id ?? draft?.genre ?? "未选"}
【主题】${theme || "未填"}
【平台】${bookPlatform || draft?.platform || "未选"}
【输入简介/卖点】${seed}

要求：
1. 只生成正文，不要输出候选池。
2. 正文需覆盖一句话卖点与故事背景。
3. 不要输出生成说明、分析过程、结尾总结。
4. 输出需直接作为简介页正文。`
      : `Please generate the final intro body from the following input. Output body only, no commentary.

[Title] ${bookTitle || "unset"}
[Genre] ${selectedGenre?.name ?? selectedGenre?.id ?? draft?.genre ?? "unset"}
[Theme] ${theme || "unset"}
[Platform] ${bookPlatform || draft?.platform || "unset"}
[Input Hook/Blurb] ${seed}

Requirements:
1. Generate body only, not candidate pool.
2. Cover both hook/blurb and story background.
3. No process notes, analysis, or closing summary.
4. Output must be ready to store as the intro page body.`;
    await sendCommand(instruction, currentStep, { refreshDraft: false });
    await refreshDraft();
    syncDisplayedStepDraft("intro");
  }, [bookPlatform, bookTitle, currentStep, draft?.blurb, draft?.genre, draft?.platform, draft?.storyBackground, introSeedText, introTheme, projectLang, refreshDraft, sendCommand, selectedGenre?.id, selectedGenre?.name, syncDisplayedStepDraft]);

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
    setVisibleWizardStep("intro");
    setIntroCandidates([]);
    setIntroSeedText("");
    setIntroTheme("");
    setStepDrafts({});
    setStepEditing({});
    if (activeSessionId) {
      await deleteSession(activeSessionId);
    }
    nav.toDashboard();
  }, [activeSessionId, currentStep, currentStepMeta.title, deleteSession, nav, projectLang, sendWizardControlRequest]);

  const handleMarkdownAiModify = useCallback(async (note: string, mode: "revise" | "polish", step?: Exclude<BookCreationWizardStep, "intro" | "review">) => {
    const targetStep = step ?? (currentStep as Exclude<BookCreationWizardStep, "intro" | "review">);
    if (!currentMarkdownSpec || currentStep === "intro" || currentStep === "review") return;
    const aiNote = note.trim();
    if (!aiNote.trim()) {
      setError(projectLang === "zh" ? "请先填写修改要求。" : "Please provide edit instructions first.");
      return;
    }
    const instruction = projectLang === "zh"
      ? `请修改当前${currentMarkdownSpec.title}页内容，只改这一页，保持 Markdown 结构清晰。\n\n【当前页】${currentMarkdownSpec.title}\n【修改方式】${mode === "polish" ? "润色" : "修改"}\n【修改要求】${aiNote}\n\n【当前内容】\n${currentStepDraft || "（空）"}`
      : `Please modify the current ${currentMarkdownSpec.title} page only. Keep the Markdown structure clear.\n\n[Current Page] ${currentMarkdownSpec.title}\n[Mode] ${mode === "polish" ? "polish" : "revise"}\n[Instructions] ${aiNote}\n\n[Current Content]\n${currentStepDraft || "(empty)"}`;
    await sendCommand(instruction, currentStep, { refreshDraft: false });
    await refreshDraft();
    syncDisplayedStepDraft(targetStep);
  }, [currentMarkdownSpec, currentStep, currentStepDraft, projectLang, refreshDraft, sendCommand, syncDisplayedStepDraft]);

  const handleSelectCandidate = useCallback(async (candidate: IntroCandidateLike, index: number, candidateCountOverride?: number) => {
    const theme = introTheme.trim() || selectedGenre?.name?.trim() || candidate.style || candidate.title;
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
  }, [bookChapterWords, bookLanguage, bookPlatform, draft?.genre, fetchJson, introCandidates.length, introTheme, pauseAutoSaveDuring, projectLang, refreshDraft, selectedGenre?.id, selectedGenre?.name, selectedGenre?.source, suppressIntroAutoSave, syncDisplayedStepDraft]);

  const handleGenerateCandidates = useCallback(async () => {
    const theme = introTheme.trim() || selectedGenre?.name?.trim() || "";
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
      const data = await sendMessage(
        activeSessionId,
        `请按题材和主题生成${parsePositiveIntegerInput(introCandidateCount) ?? 3} 套简介候选，只输出候选池，不要直接进入建书。\n\n书名：${bookTitle || "未填"}\n题材：${themeLabel}\n主题：${theme || selectedGenre?.name || "未填"}\n平台：${bookPlatform || "未选"}\n当前简介：${introBlurb || "（空）"}\n当前故事背景：${introStoryBackground || "（空）"}\n\n要求：\n1. 每套都要包含 title、blurb、storyBackground、style、reason。\n2. 候选之间风格要有差异。\n3. 请尽量用 JSON 数组输出；如果无法严格 JSON，也要按清晰分隔的多方案格式输出。\n4. 输出后只提示我可以在左侧候选池选择第几套，不要触发建书流程。`,
        undefined,
        { wizardStep: currentStep, forceStream: true },
      ) as AgentResponse | null;
      const raw = data?.response ?? data?.details?.draftRaw ?? "";
      const parsed = parseIntroCandidateResponse(raw);
      const latestMessages = activeSessionId ? (useChatStore.getState().sessions[activeSessionId]?.messages ?? []) : [];
      const sessionParsed = parseLatestIntroCandidates(latestMessages.filter((message) => message.wizardStep === currentStep));
      const fallback = raw.trim()
        ? [{ title: selectedGenre?.name ?? theme, blurb: raw.trim(), storyBackground: raw.trim(), style: selectedGenre?.name ?? theme, reason: "模型未返回结构化候选，已用单条结果兜底。" }]
        : [];
      const ranked = rankIntroCandidates(parsed.length > 0 ? parsed : sessionParsed.length > 0 ? sessionParsed : fallback, selectedGenre?.id ?? theme);
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
  }, [activeSessionId, bookPlatform, bookTitle, currentStep, handleSelectCandidate, introCandidateCount, introBlurb, introStoryBackground, introTheme, projectLang, refreshDraft, sendMessage, selectedGenre]);

  const handleJumpToStep = useCallback(async (step: "intro" | "world" | "outline" | "volume" | "characters" | "arc" | "relation" | "review") => {
    await sendWizardControlRequest({
      intent: "goto_book_wizard",
      language: projectLang,
      stepTitle: currentStepMeta.title,
      wizardStep: step,
      title: bookTitle || draft?.title || undefined,
      genre: selectedGenre?.id ?? draft?.genre ?? undefined,
      platform: bookPlatform || draft?.platform || undefined,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
    }, projectLang === "zh" ? `已切换到 ${step}。` : `Moved to ${step}.`);
  }, [bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, currentStepMeta.title, draft?.genre, draft?.platform, draft?.targetChapters, draft?.chapterWordCount, projectLang, selectedGenre?.id, sendWizardControlRequest]);

  const { visibleMessages: messages, legacyMessageCount } = useMemo(
    () => selectBookCreateDockMessages(allMessages, currentStep),
    [allMessages, currentStep],
  );

  const introPageCandidateMessages = useMemo(() => {
    if (currentStep !== "intro") return [];
    return parseLatestIntroCandidates(messages);
  }, [currentStep, messages]);

  useEffect(() => {
    if (currentStep !== "intro") return;
    if (introPageCandidateMessages.length === 0) return;
    const query = introTheme.trim() || selectedGenre?.name?.trim() || selectedGenre?.id || "";
    const ranked = rankIntroCandidates(introPageCandidateMessages, query);
    setIntroCandidates((current) => {
      const currentSignature = JSON.stringify(current);
      const nextSignature = JSON.stringify(ranked);
      if (currentSignature === nextSignature) return current;
      return ranked;
    });
    setSelectedIntroCandidateIndex((current) => (current < ranked.length ? current : 0));
  }, [currentStep, introPageCandidateMessages, introTheme, selectedGenre?.id, selectedGenre?.name]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  const chatGuide = buildChatGuide(currentStep as never, projectLang);
  const creationReviewChecklist = useMemo(() => {
    if (!draft || currentStep !== "review") return [];
    return buildCreationReviewChecklist(draft, projectLang);
  }, [currentStep, draft, projectLang]);
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
  const onSend = useCallback((text: string) => {
    if (loading || stopping) return;
    if (!activeSessionId) return;
    void sendMessage(activeSessionId, text, undefined, { skipAutoNewPrefix: true, wizardStep: currentStep });
  }, [activeSessionId, currentStep, loading, sendMessage, stopping]);

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
          />
          {error && <div className={`rounded-md border ${c.error} px-4 py-3`}>{error}</div>}
          {status && <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">{status}</div>}
          {shouldShowValidationPanel && currentValidationReport ? (
            <StepValidationBanner
              report={currentValidationReport}
              onAutoFix={handleAutoFixCurrentStep}
              onAdvance={handleAdvance}
              isAutoFixing={isAutoCompleting}
              canAdvance={Boolean(nextStepMeta) && !creating && !isAdvancing && !isAutoCompleting}
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
                    selectedGenreLabel={selectedGenre?.name ?? introTheme.trim() ?? "未选择"}
                    introMode={introMode}
                    introSeedText={introSeedText}
                    introBodyDraft={introBodyDraft}
                    introTheme={introTheme}
                    introCandidateCount={introCandidateCount}
                    introCandidates={introCandidates}
                    selectedIntroCandidateIndex={selectedIntroCandidateIndex}
                    selectedIntroCandidate={selectedIntroCandidate}
                    loadingDraft={loadingDraft}
                    loading={loading}
                    creating={creating}
                    introCandidateLoading={introCandidateLoading}
                    autoGenerateAllowed={autoGenerateAllowed}
                    introBodyEditing={introBodyEditing}
                    bookTitle={bookTitle}
                    bookLanguage={bookLanguage}
                    bookPlatform={bookPlatform}
                    bookTargetChapters={bookTargetChapters}
                    bookChapterWords={bookChapterWords}
                    hardParams={hardParams}
                    setSelectedGenreId={setSelectedGenreId}
                    setIntroPanelTab={setIntroPanelTab}
                    setIntroMode={setIntroMode}
                    setIntroSeedText={setIntroSeedTextWithAutoSaveReset}
                    setIntroBodyDraft={setIntroBodyDraft}
                    setIntroTheme={setIntroTheme}
                    setIntroCandidateCount={setIntroCandidateCount}
                    setIntroBodyEditing={setIntroBodyEditing}
                    setBookTitle={setBookTitle}
                    setBookLanguage={setBookLanguage}
                    setBookPlatform={setBookPlatform}
                    setBookTargetChapters={setBookTargetChapters}
                    setBookChapterWords={setBookChapterWords}
                    onBookTargetChaptersTouched={() => setBookTargetChaptersTouched(true)}
                    onBookChapterWordsTouched={() => setBookChapterWordsTouched(true)}
                    handleGenerateIntroBody={handleGenerateIntroBody}
                    handleGenerateCandidates={handleGenerateCandidates}
                    handleSelectCandidate={handleSelectCandidate}
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
                    onValueChange={(value) => setStepDrafts((current) => ({ ...current, [currentStep]: value }))}
                    onAiModify={(note, mode) => void handleMarkdownAiModify(note, mode, currentStep as Exclude<BookCreationWizardStep, "intro" | "review">)}
                  />
                ) : currentStep === "review" ? (
                  <ReviewPanel
                    creationReviewChecklist={creationReviewChecklist}
                    canCreate={canCreate}
                    onJumpToStep={handleJumpToStep}
                  />
                ) : null}
                <WizardActions
                  canGoBack={canGoBack}
                  canAdvance={Boolean(nextStepMeta) && !creating && !isAdvancing && !isAutoCompleting}
                  creating={creating}
                  isAdvancing={isAdvancing}
                  isAutoCompleting={isAutoCompleting}
                  currentStep={currentStep}
                  isReview={currentStep === "review"}
                  canCreate={canCreate}
                  showAutoComplete={currentStep !== "review" && currentStep !== "intro"}
                  handleDiscard={handleDiscard}
                  handleBack={handleBack}
                  handleAdvance={handleAdvance}
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

