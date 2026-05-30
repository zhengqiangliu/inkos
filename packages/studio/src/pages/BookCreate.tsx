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
import { BookCreateChatDock, IntroPanel, ReviewPanel, WizardActions, WizardHeader, WorldPanel } from "./book-create-panels";
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
  buildIntroCandidateBackfill,
  resolveIntroCandidateTitle,
  composeIntroSeedText,
  buildWizardStepSeedText,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  parseIntroCandidateResponse,
  parseLatestIntroCandidates,
  parseIntroSeedText,
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
  const [introModifyNote, setIntroModifyNote] = useState("");
  const [introTheme, setIntroTheme] = useState("");
  const [introCandidateCount, setIntroCandidateCount] = useState("3");
  const [introCandidates, setIntroCandidates] = useState<ReadonlyArray<IntroCandidateLike>>([]);
  const [selectedIntroCandidateIndex, setSelectedIntroCandidateIndex] = useState(0);
  const [introCandidateLoading, setIntroCandidateLoading] = useState(false);
  const [stepDrafts, setStepDrafts] = useState<Partial<Record<"intro" | "world" | "outline" | "volume" | "characters" | "arc" | "relation" | "review", string>>>({});
  const [isAdvancing, setIsAdvancing] = useState(false);
  const wizardStepOrder = useMemo(
    () => new Map(WIZARD_STEPS.map((item, index) => [item.id, index] as const)),
    [],
  );

  const patchWizardStep = useCallback((nextStep: BookCreationWizardStep, completedStep?: BookCreationWizardStep, fallback?: BookCreationWizardState) => {
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
    setWizard((current) => {
      const fetched = session?.creationWizard;
      if (!fetched) return current;
      if (!current) return fetched;
      const currentIndex = wizardStepOrder.get(current.currentStep) ?? -1;
      const fetchedIndex = wizardStepOrder.get(fetched.currentStep) ?? -1;
      return fetchedIndex >= currentIndex ? fetched : current;
    });
  }, [draftSessionId, loadSessionDetail, wizardStepOrder]);

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

  const currentStep = wizard?.currentStep ?? "intro";
  const currentStepIndex = Math.max(0, WIZARD_STEPS.findIndex((s) => s.id === currentStep));
  const currentStepMeta = WIZARD_STEPS[currentStepIndex] ?? WIZARD_STEPS[0]!;
  const nextStepMeta = WIZARD_STEPS[currentStepIndex + 1];
  const canGoBack = currentStepIndex > 0;
  const canCreate = currentStep === "review" && canCreateFromDraft(draft);
  const selectedGenre = genresData?.genres.find((genre) => genre.id === selectedGenreId) ?? null;
  const selectedIntroCandidate = introCandidates[selectedIntroCandidateIndex] ?? null;
  const manualModifyAllowed = Boolean(introModifyNote.trim());
  const parsedIntroSeed = parseIntroSeedText(introSeedText);
  const introBlurb = parsedIntroSeed.blurb;
  const introStoryBackground = parsedIntroSeed.storyBackground;
  const worldStepDraft = stepDrafts.world ?? buildWizardStepSeedText("world", draft ?? {}, projectLang);
  const currentStepDraft = currentStep === "intro"
    ? introSeedText
    : currentStep === "world"
      ? worldStepDraft
      : stepDrafts[currentStep] ?? buildWizardStepSeedText(currentStep, draft ?? {}, projectLang);
  const currentStepContent = currentStep === "intro"
    ? introSeedText
    : currentStep === "world"
      ? worldStepDraft
      : currentStepDraft;
  const autoGenerateAllowed = Boolean(introTheme.trim() || selectedGenre?.name?.trim());
  const stopping = activeSession?.isStopping ?? false;
  const canStop = Boolean(activeSessionId) && (loading || stopping);
  const sendCommand = useCallback(async (
    instruction: string,
    wizardStep: BookCreationWizardStep = currentStep,
    options?: { readonly refreshDraft?: boolean },
  ): Promise<AgentResponse | null> => {
    if (!activeSessionId) {
      setError(projectLang === "zh" ? "右侧 AI 工作台尚未就绪。" : "The AI workbench is not ready yet.");
      return null;
    }
    try {
      const data = await sendMessage(activeSessionId, instruction, undefined, { skipAutoNewPrefix: true, wizardStep }) as AgentResponse | null;
      setStatus(data?.response ?? null);
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
      setStatus(response.response ?? successStatus);
      if (response.session?.creationDraft) setDraft(response.session.creationDraft);
      if (response.session?.creationWizard) {
        patchWizardStep(response.session.creationWizard.currentStep, undefined, response.session.creationWizard);
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
  }, [activeSessionId, projectLang, patchWizardStep]);

  const handleAdvance = useCallback(async () => {
    if (!nextStepMeta) return;
    const targetStep = nextStepMeta.id;
    const resolvedWizardStep = currentStep === “intro” || currentStep === “world” || currentStep === “outline” || currentStep === “volume” || currentStep === “characters” || currentStep === “arc” || currentStep === “relation” || currentStep === “review”
      ? currentStep
      : (wizard?.currentStep ?? “intro”);
    const advanceRequest: BookCreateWizardControlRequest = {
      intent: “advance_book_wizard”,
      language: projectLang,
      stepTitle: currentStepMeta.title,
      wizardStep: resolvedWizardStep,
      title: bookTitle || draft?.title || undefined,
      genre: selectedGenre?.id ?? draft?.genre ?? “”,
      platform: bookPlatform || draft?.platform || undefined,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters) ?? draft?.targetChapters,
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords) ?? draft?.chapterWordCount,
      instruction: currentStepContent,
    };

    // 立即切换页面（乐观更新），不等后端保存
    patchWizardStep(targetStep, currentStep);
    setIsAdvancing(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: “smooth” });
    }
    setStatus(projectLang === “zh”
      ? `正在保存并生成 ${nextStepMeta.title} 内容...`
      : `Saving and generating ${nextStepMeta.title}...`);

    // 构建带完整草案上下文的生成 prompt
    const draftContext = draft
      ? buildCreationDraftSummary(draft, projectLang)
          .map((row) => `${row.label}：${row.value}`)
          .join(“\n”)
      : “”;
    const generationRequest = projectLang === “zh”
      ? `你现在在处理”${nextStepMeta.title}”页。请根据已有草案和以下${currentStepMeta.title}内容，生成${nextStepMeta.title}页草案，只补当前页允许的字段，不要扩写其他页面，也不要创建新书。\n\n【已有草案】\n${draftContext || “（空）”}\n\n【${currentStepMeta.title}内容】\n${currentStepContent || “（空）”}`
      : `You are now working on the “${nextStepMeta.title}” page. Based on the existing draft and the ${currentStepMeta.title} content below, generate a draft for the ${nextStepMeta.title} page. Only fill in fields allowed for this page, do not expand other pages or create a new book.\n\n[Existing Draft]\n${draftContext || “(empty)”}\n\n[${currentStepMeta.title} Content]\n${currentStepContent || “(empty)”}`;

    try {
      // 并行：后台保存 + 立即触发 Agent 流式输出
      const [advanced, generated] = await Promise.all([
        sendWizardControlRequest(advanceRequest, projectLang === “zh”
          ? `已保存并进入 ${nextStepMeta.title}。`
          : `Saved and moved to ${nextStepMeta.title}.`),
        sendCommand(generationRequest, targetStep, { refreshDraft: false }),
      ]);

      if (!advanced) {
        // 保存失败，回滚页面
        patchWizardStep(currentStep);
        return;
      }

      const generatedText = generated?.details?.draftRaw?.trim() || generated?.response?.trim() || “”;
      if (generatedText) {
        setStepDrafts((current) => ({ ...current, [targetStep]: generatedText }));
      }
    } finally {
      setIsAdvancing(false);
    }
  }, [bookChapterWords, bookPlatform, bookTitle, bookTargetChapters, currentStep, currentStepContent, currentStepMeta.title, draft, nextStepMeta, patchWizardStep, projectLang, scrollRef, selectedGenre?.id, sendCommand, sendWizardControlRequest, wizard?.currentStep]);

  const handleBack = useCallback(async () => {
    if (!canGoBack) return;
    await sendWizardControlRequest({
      intent: "retreat_book_wizard",
      language: projectLang,
      stepTitle: currentStepMeta.title,
      wizardStep: currentStep,
    }, projectLang === "zh" ? "已返回上一步。" : "Moved back to the previous step.");
  }, [canGoBack, currentStep, currentStepMeta.title, projectLang, sendWizardControlRequest]);

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
      nav.toBook(bookId);
    } finally {
      setCreating(false);
    }
  }, [activeSession?.title, activeSessionId, bookChapterWords, bookPlatform, bookTitle, canCreate, currentStepMeta.title, draft, nav, projectLang, renameSession, selectedGenre?.id, sendCommand, bookTargetChapters]);

  const handleDiscard = useCallback(async () => {
    setDiscardConfirmOpen(true);
  }, []);

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
    setIntroCandidates([]);
    setIntroSeedText("");
    setIntroModifyNote("");
    setIntroTheme("");
    setStepDrafts({});
    if (activeSessionId) {
      await deleteSession(activeSessionId);
    }
    nav.toDashboard();
  }, [activeSessionId, currentStep, currentStepMeta.title, deleteSession, nav, projectLang, sendWizardControlRequest]);

  const handleManualRevise = useCallback(async (revisionKind: "revise" | "polish") => {
    if (!manualModifyAllowed) {
      setError(projectLang === "zh" ? "请先填写修改要求。" : "Please provide edit instructions first.");
      return;
    }
    const command = buildBookCreateCommand({
      kind: revisionKind === "polish" ? "intro-polish" : "intro-revise",
      language: projectLang,
      stepTitle: currentStepMeta.title,
      currentStep,
      title: bookTitle || draft?.title || undefined,
      genre: selectedGenre?.id ?? draft?.genre ?? undefined,
      platform: bookPlatform || draft?.platform || undefined,
      introBlurb: introBlurb || draft?.blurb || undefined,
      introStoryBackground: introStoryBackground || draft?.storyBackground || undefined,
      modifyNote: introModifyNote,
      theme: selectedGenre?.id ?? draft?.genre ?? undefined,
      stepContent: currentStepContent,
    });
    await sendCommand(command.instruction);
  }, [bookTitle, currentStepMeta.title, draft?.blurb, draft?.genre, draft?.platform, draft?.storyBackground, introBlurb, introModifyNote, introStoryBackground, manualModifyAllowed, projectLang, bookPlatform, sendCommand, selectedGenre?.id]);

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
      setSelectedIntroCandidateIndex(0);
      await refreshDraft();
    } finally {
      setIntroCandidateLoading(false);
    }
  }, [activeSessionId, bookPlatform, bookTitle, currentStep, introCandidateCount, introBlurb, introStoryBackground, introTheme, projectLang, refreshDraft, sendMessage, selectedGenre]);

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

  const handleSelectCandidate = useCallback(async (candidate: IntroCandidateLike, index: number) => {
    const theme = introTheme.trim() || selectedGenre?.name?.trim() || candidate.style || candidate.title;
    if (!theme) return;
    const backfill = buildIntroCandidateBackfill(candidate);
    setSelectedIntroCandidateIndex(index);
    setIntroMode("manual");
    setIntroTheme(theme);
    setIntroSeedText(backfill);
    setBookTitle(resolveIntroCandidateTitle(candidate));
    setStepDrafts((current) => ({ ...current, intro: backfill }));
    try {
      const data = await fetchJson<AgentResponse>("/interaction/session", {
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
            candidateCount: introCandidates.length,
            themeGenre: selectedGenre?.id ?? theme,
            blurb: candidate.blurb,
            storyBackground: candidate.storyBackground,
            instruction: `title=${candidate.title}\nblurb=${candidate.blurb}\nstoryBackground=${candidate.storyBackground}\nstyle=${candidate.style ?? theme}\nreason=${candidate.reason ?? ""}`,
          } satisfies BookCreateSessionRequest,
        }),
      });
      setStatus(data.response ?? (projectLang === "zh" ? `已选中第${index + 1} 套候选。` : `Selected candidate #${index + 1}.`));
      await refreshDraft();
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409) {
        setBlockedPrompt({
          title: projectLang === "zh" ? "候选选择被阻挡" : "Candidate selection blocked",
          message: cause.message,
        });
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [bookChapterWords, bookLanguage, bookPlatform, draft?.genre, fetchJson, introCandidates.length, introTheme, projectLang, refreshDraft, selectedGenre?.id, selectedGenre?.name, selectedGenre?.source]);

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
  const onSend = useCallback((text: string) => {
    if (loading || stopping) return;
    if (!activeSessionId) return;
    void sendMessage(activeSessionId, text, undefined, { skipAutoNewPrefix: true, wizardStep: currentStep });
  }, [activeSessionId, currentStep, loading, sendMessage, stopping]);

  return (
    <div className="flex flex-1 min-w-0 overflow-hidden">
      <main className="flex-1 min-w-0 w-full overflow-y-auto px-6 py-6 lg:px-8">
        <div className="w-full space-y-6">
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
          <div className="flex min-w-0 w-full flex-col gap-6 xl:flex-row xl:items-start">
            <section className="min-w-0 flex-[1_1_0%] space-y-5">
              <div className="rounded-2xl border border-border/60 bg-card/70 p-5 space-y-5">
                {currentStep === "intro" ? (
                  <IntroPanel
                    c={c}
                    genres={genresData?.genres ?? []}
                    selectedGenreId={selectedGenreId}
                    selectedGenreLabel={selectedGenre?.name ?? introTheme.trim() ?? "未选择"}
                    introMode={introMode}
                    introSeedText={introSeedText}
                    introModifyNote={introModifyNote}
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
                    manualModifyAllowed={manualModifyAllowed}
                    bookTitle={bookTitle}
                    bookLanguage={bookLanguage}
                    bookPlatform={bookPlatform}
                    bookTargetChapters={bookTargetChapters}
                    bookChapterWords={bookChapterWords}
                    hardParams={hardParams}
                    setSelectedGenreId={setSelectedGenreId}
                    setIntroMode={setIntroMode}
                    setIntroSeedText={setIntroSeedText}
                    setIntroModifyNote={setIntroModifyNote}
                    setIntroTheme={setIntroTheme}
                    setIntroCandidateCount={setIntroCandidateCount}
                    setBookTitle={setBookTitle}
                    setBookLanguage={setBookLanguage}
                    setBookPlatform={setBookPlatform}
                    setBookTargetChapters={setBookTargetChapters}
                    setBookChapterWords={setBookChapterWords}
                    onBookTargetChaptersTouched={() => setBookTargetChaptersTouched(true)}
                    onBookChapterWordsTouched={() => setBookChapterWordsTouched(true)}
                    handleManualRevise={handleManualRevise}
                    handleGenerateCandidates={handleGenerateCandidates}
                    handleSelectCandidate={handleSelectCandidate}
                  />
                ) : currentStep === "world" ? (
                  <WorldPanel
                    c={c}
                    worldStepDraft={worldStepDraft}
                    setWorldStepDraft={(value) => setStepDrafts((current) => ({ ...current, world: value }))}
                  />
                ) : currentStep === "review" ? (
                  <ReviewPanel
                    creationReviewChecklist={creationReviewChecklist}
                    canCreate={canCreate}
                    onJumpToStep={handleJumpToStep}
                  />
                ) : (
                  <div className="space-y-5">
                    <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{currentStepMeta.title}</div>
                          <div className="text-xs text-muted-foreground">{currentStepMeta.subtitle}</div>
                        </div>
                        <div className="text-xs text-muted-foreground">仅保留当前页内容</div>
                      </div>
                      <textarea
                        value={currentStepDraft}
                        onChange={(e) => setStepDrafts((current) => ({ ...current, [currentStep]: e.target.value }))}
                        rows={10}
                        className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`}
                        placeholder={`输入${currentStepMeta.title}的补充内容`}
                      />
                    </div>
                  </div>
                )}
                <WizardActions
                  canGoBack={canGoBack}
                  canAdvance={Boolean(bookTitle.trim()) || currentStep !== "intro"}
                  creating={creating}
                  currentStep={currentStep}
                  isReview={currentStep === "review"}
                  nextStepTitle={nextStepMeta?.title}
                  canCreate={canCreate}
                  handleDiscard={handleDiscard}
                  handleBack={handleBack}
                  handleAdvance={handleAdvance}
                  handleCreate={handleCreate}
                />
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
