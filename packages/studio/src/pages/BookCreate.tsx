import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookCreationDraft, BookCreationWizardState } from "@actalk/inkos-core";
import { fetchJson, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { chatSelectors, useChatStore } from "../store/chat";
import { useServiceStore } from "../store/service";
import { ChatMessage } from "../components/chat/ChatMessage";
import { AssistantOutputCard } from "../components/chat/AssistantOutputCard";
import { AssistantThinkingCard } from "../components/chat/AssistantThinkingCard";
import { Shimmer } from "../components/ai-elements/shimmer";
import { Message } from "../components/ai-elements/message";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { ArrowUp, BotMessageSquare, Check, ChevronDown, Square } from "lucide-react";
import { clearBookCreateSessionId, filterModelGroups, getBookCreateSessionId, resolveModelSelection, setBookCreateSessionId } from "./chat-page-state";
import {
  buildBookCreateCommand,
  buildChatActionLabels,
  buildChatGuide,
  buildChatQuickTemplates,
  buildConceptSplitSummary,
  buildCreationDraftSummary,
  buildHardParamsSummary,
  buildStepActionSections,
  buildStepFocusCard,
  buildStepRecommendedAction,
  buildStepShortcuts,
  composeIntroSeedText,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  parseIntroCandidateResponse,
  parseIntroSeedText,
  parsePositiveIntegerInput,
  platformOptionsForLanguage,
  pickValidValue,
  rankIntroCandidates,
  type StepShortcut,
  resolveDraftInstruction,
  resolveGenreMapping,
  resolveInitialGenreSelection,
  shouldSubmitChatOnKeyDown,
  waitForBookReady,
} from "./book-create-state";

export {
  buildBookCreateCommand,
  buildChatActionLabels,
  buildChatGuide,
  buildChatQuickTemplates,
  buildConceptSplitSummary,
  buildCreationDraftSummary,
  buildHardParamsSummary,
  buildStepActionSections,
  buildStepFocusCard,
  buildStepRecommendedAction,
  buildStepShortcuts,
  canCreateFromDraft,
  defaultChapterWordsForLanguage,
  parseIntroCandidateResponse,
  parsePositiveIntegerInput,
  platformOptionsForLanguage,
  pickValidValue,
  rankIntroCandidates,
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

interface InteractionSessionResponse {
  readonly session?: {
    readonly activeBookId?: string;
    readonly creationDraft?: BookCreationDraft;
    readonly creationWizard?: BookCreationWizardState;
  };
}

interface AgentResponse {
  readonly response?: string;
  readonly error?: string;
  readonly session?: {
    readonly activeBookId?: string;
    readonly creationDraft?: BookCreationDraft;
    readonly creationWizard?: BookCreationWizardState;
  };
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

const WIZARD_STEPS = [
  { id: "intro", title: "简介 / 故事背景", subtitle: "先把卖点和故事起点定住" },
  { id: "world", title: "世界观", subtitle: "定义规则、势力和边界" },
  { id: "outline", title: "小说大纲", subtitle: "主线、成长路、章节卡点" },
  { id: "volume", title: "卷纲规划", subtitle: "卷级推进与每卷收束" },
  { id: "characters", title: "主角 / 配角", subtitle: "角色功能与驱动力" },
  { id: "arc", title: "人物弧光", subtitle: "核心弧光与成长转折" },
  { id: "relation", title: "人物关系", subtitle: "关系动力与剧情引擎" },
  { id: "review", title: "最终确认", subtitle: "一致性检查后再落库" },
] as const;

function readStepIndex(step?: string): number {
  return WIZARD_STEPS.findIndex((item) => item.id === step);
}

export function BookCreate({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data: project } = useApi<{ language: string }>("/project");
  const { data: genresData } = useApi<{ genres: ReadonlyArray<{ id: string; name: string; language?: string; source?: string }> }>("/genres");
  const projectLang = (project?.language ?? "zh") as "zh" | "en";

  const activeSession = useChatStore(chatSelectors.activeSession);
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const input = useChatStore((s) => s.input);
  const loading = useChatStore(chatSelectors.isActiveSessionStreaming);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  const setInput = useChatStore((s) => s.setInput);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopMessage = useChatStore((s) => s.stopMessage);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const createSession = useChatStore((s) => s.createSession);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);

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
  const [bookTitle, setBookTitle] = useState("");
  const [bookPlatform, setBookPlatform] = useState(platformOptionsForLanguage(projectLang)[0]?.value ?? "");
  const [bookLanguage, setBookLanguage] = useState<"zh" | "en">(projectLang);
  const [bookTargetChapters, setBookTargetChapters] = useState("");
  const [bookChapterWords, setBookChapterWords] = useState("");
  const [selectedGenreId, setSelectedGenreId] = useState("");
  const [introMode, setIntroMode] = useState<"manual" | "auto">("manual");
  const [introSeedText, setIntroSeedText] = useState("");
  const [introModifyNote, setIntroModifyNote] = useState("");
  const [introTheme, setIntroTheme] = useState("");
  const [introCandidateCount, setIntroCandidateCount] = useState("3");
  const [introCandidates, setIntroCandidates] = useState<ReadonlyArray<{ title: string; blurb: string; storyBackground: string; style?: string; reason?: string }>>([]);
  const [selectedIntroCandidateIndex, setSelectedIntroCandidateIndex] = useState(0);
  const [introCandidateLoading, setIntroCandidateLoading] = useState(false);
  const [stepInput, setStepInput] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refreshDraft = useCallback(async (): Promise<void> => {
    const data = await fetchJson<InteractionSessionResponse>("/interaction/session");
    setDraft(data.session?.creationDraft);
    setWizard(data.session?.creationWizard);
  }, []);

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
    if (typeof draft?.targetChapters === "number" && !bookTargetChapters) setBookTargetChapters(String(draft.targetChapters));
    if (typeof draft?.chapterWordCount === "number" && !bookChapterWords) setBookChapterWords(String(draft.chapterWordCount));
    if ((draft?.blurb || draft?.storyBackground) && !introSeedText) setIntroSeedText(composeIntroSeedText(draft?.blurb ?? "", draft?.storyBackground ?? ""));
    if (draft?.genreAlias && !introTheme) setIntroTheme(draft.genreAlias);
  }, [bookChapterWords, bookLanguage, bookPlatform, bookTargetChapters, bookTitle, draft, introSeedText, introTheme, projectLang]);

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
      const existingId = getBookCreateSessionId();
      if (existingId) {
        await loadSessionDetail(existingId);
        if (cancelled) return;
        const state = useChatStore.getState();
        if (state.sessions[existingId]?.bookId === null) {
          activateSession(existingId);
          return;
        }
      }
      const newSessionId = await createSession(null);
      if (!cancelled) setBookCreateSessionId(newSessionId);
    })();
    return () => { cancelled = true; };
  }, [activateSession, createSession, loadSessionDetail]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  const currentStep = wizard?.currentStep ?? "intro";
  const currentStepIndex = Math.max(0, readStepIndex(currentStep));
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
  const autoGenerateAllowed = Boolean(introTheme.trim() || selectedGenre?.name?.trim());
  const stopping = activeSession?.isStopping ?? false;
  const canStop = Boolean(activeSessionId) && (loading || stopping);

  const sendCommand = useCallback(async (instruction: string): Promise<AgentResponse | null> => {
    if (!activeSessionId) {
      setError(projectLang === "zh" ? "右侧 AI 工作台尚未就绪。" : "The AI workbench is not ready yet.");
      return null;
    }
    try {
      const data = await sendMessage(activeSessionId, instruction, undefined, { skipAutoNewPrefix: true }) as AgentResponse | null;
      setStatus(data?.response ?? null);
      await refreshDraft();
      return data;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [activeSessionId, projectLang, refreshDraft, sendMessage]);

  const handleSaveParams = useCallback(async () => {
    await sendCommand(buildBookCreateCommand({
      kind: "params",
      language: projectLang,
      stepTitle: currentStepMeta.title,
      title: bookTitle,
      genre: selectedGenre?.id ?? draft?.genre ?? "",
      platform: bookPlatform,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters),
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords),
    }).instruction);
  }, [bookChapterWords, bookPlatform, bookTitle, currentStepMeta.title, draft?.genre, projectLang, selectedGenre?.id, sendCommand, bookTargetChapters]);

  const handleAdvance = useCallback(async () => {
    if (!nextStepMeta) return;
    await sendCommand(buildBookCreateCommand({
      kind: "advance",
      language: projectLang,
      stepTitle: currentStepMeta.title,
      nextStepTitle: nextStepMeta.title,
      title: bookTitle,
      genre: selectedGenre?.id ?? draft?.genre ?? "",
      platform: bookPlatform,
      targetChapters: parsePositiveIntegerInput(bookTargetChapters),
      chapterWordCount: parsePositiveIntegerInput(bookChapterWords),
    }).instruction);
  }, [bookChapterWords, bookPlatform, bookTitle, currentStepMeta.title, draft?.genre, nextStepMeta, projectLang, selectedGenre?.id, sendCommand, bookTargetChapters]);

  const handleBack = useCallback(async () => {
    if (!canGoBack) return;
    await sendCommand(buildBookCreateCommand({
      kind: "back",
      language: projectLang,
      stepTitle: currentStepMeta.title,
    }).instruction);
  }, [canGoBack, currentStepMeta.title, projectLang, sendCommand]);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const data = await sendCommand(buildBookCreateCommand({
        kind: "create",
        language: projectLang,
        stepTitle: currentStepMeta.title,
      }).instruction);
      const bookId = data?.session?.activeBookId;
      if (!bookId) throw new Error(projectLang === "zh" ? "创建完成但未返回书籍 ID。" : "Create succeeded but no book id was returned.");
      clearBookCreateSessionId();
      setDraft(undefined);
      setWizard(undefined);
      nav.toBook(bookId);
    } finally {
      setCreating(false);
    }
  }, [canCreate, currentStepMeta.title, nav, projectLang, sendCommand]);

  const handleDiscard = useCallback(async () => {
    await sendCommand(buildBookCreateCommand({
      kind: "discard",
      language: projectLang,
      stepTitle: currentStepMeta.title,
    }).instruction);
    setDraft(undefined);
    setWizard(undefined);
    setIntroCandidates([]);
    setIntroSeedText("");
    setIntroModifyNote("");
    setIntroTheme("");
  }, [currentStepMeta.title, projectLang, sendCommand]);

  const handleManualRevise = useCallback(async (revisionKind: "revise" | "polish") => {
    if (!manualModifyAllowed) {
      setError(projectLang === "zh" ? "请先填写修改要求。" : "Please provide edit instructions first.");
      return;
    }
    await sendCommand(buildBookCreateCommand({
      kind: revisionKind === "polish" ? "intro-polish" : "intro-revise",
      language: projectLang,
      stepTitle: currentStepMeta.title,
      title: bookTitle,
      genre: selectedGenre?.id ?? draft?.genre ?? "",
      platform: bookPlatform,
      introBlurb,
      introStoryBackground,
      modifyNote: introModifyNote,
    }).instruction);
  }, [bookTitle, currentStepMeta.title, draft?.genre, introBlurb, introModifyNote, introStoryBackground, manualModifyAllowed, projectLang, bookPlatform, selectedGenre?.id, sendCommand]);

  const handleGenerateCandidates = useCallback(async () => {
    const theme = introTheme.trim() || selectedGenre?.name?.trim() || "";
    if (!theme) {
      setError(projectLang === "zh" ? "请先输入主题或选择题材。" : "Please enter a theme or pick a genre first.");
      return;
    }
    setIntroCandidateLoading(true);
    try {
      const data = await sendCommand(buildBookCreateCommand({
        kind: "intro-generate",
        language: projectLang,
        stepTitle: currentStepMeta.title,
        title: bookTitle,
        genre: selectedGenre?.id ?? theme,
        platform: bookPlatform,
        theme,
        introBlurb,
        introStoryBackground,
        candidateCount: parsePositiveIntegerInput(introCandidateCount) ?? 3,
      }).instruction);
      const raw = data?.response ?? data?.session?.creationDraft?.blurb ?? "";
      const parsed = parseIntroCandidateResponse(raw);
      const fallback = raw.trim()
        ? [{ title: selectedGenre?.name ?? theme, blurb: raw.trim(), storyBackground: raw.trim(), style: selectedGenre?.name ?? theme, reason: "模型未返回结构化候选，已用单条结果兜底。" }]
        : [];
      const ranked = rankIntroCandidates(parsed.length > 0 ? parsed : fallback, selectedGenre?.id ?? theme);
      setIntroCandidates(ranked);
      setSelectedIntroCandidateIndex(0);
    } finally {
      setIntroCandidateLoading(false);
    }
  }, [bookTitle, currentStepMeta.title, introCandidateCount, introTheme, projectLang, sendCommand, selectedGenre, bookPlatform]);

  const handleSelectCandidate = useCallback(async (candidate: { title: string; blurb: string; storyBackground: string; style?: string; reason?: string }, index: number) => {
    const theme = introTheme.trim() || selectedGenre?.name?.trim() || candidate.style || candidate.title;
    if (!theme) return;
    setSelectedIntroCandidateIndex(index);
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
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [bookChapterWords, bookLanguage, bookPlatform, draft?.genre, fetchJson, introCandidates.length, introTheme, projectLang, refreshDraft, selectedGenre?.id, selectedGenre?.name, selectedGenre?.source]);

  const chatGuide = buildChatGuide(currentStep as never, projectLang);
  const hardParams = buildHardParamsSummary({
    title: draft?.title,
    platform: draft?.platform,
    language: draft?.language ?? projectLang,
    targetChapters: draft?.targetChapters,
    chapterWordCount: draft?.chapterWordCount,
  }, projectLang);
  void buildCreationDraftSummary;
  void hardParams;

  const onSend = useCallback((text: string) => {
    if (loading || stopping) return;
    if (!activeSessionId) return;
    void sendMessage(activeSessionId, text, undefined, { skipAutoNewPrefix: true });
  }, [activeSessionId, loading, sendMessage, stopping]);

  return (
    <div className="flex flex-1 min-w-0 overflow-hidden">
      <main className="flex-1 min-w-0 w-full overflow-y-auto px-6 py-6 lg:px-8">
        <div className="w-full space-y-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
            <span className="text-border">/</span>
            <span>{t("bread.newBook")}</span>
          </div>
          <div className="space-y-2">
            <h1 className="font-serif text-3xl">{t("create.title")}</h1>
            <p className="text-sm leading-7 text-muted-foreground">左侧负责向导与主要动作，右侧只保留聊天历史、输入框和模型切换。</p>
          </div>
          {error && <div className={`rounded-md border ${c.error} px-4 py-3`}>{error}</div>}
          {status && <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">{status}</div>}
          <div className="flex min-w-0 w-full flex-col gap-6 xl:flex-row xl:items-start">
            <section className="min-w-0 flex-[1_1_0%] space-y-5">
              <div className="rounded-2xl border border-border/60 bg-card/70 p-5 space-y-5">
                <div className="rounded-2xl border border-border/60 bg-background/50 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">题材 / 基本参数</div>
                      <div className="text-xs text-muted-foreground">题材先定，参数紧跟，尽量少滚动。</div>
                    </div>
                    <div className="text-xs text-muted-foreground text-right">{selectedGenre?.name ?? introTheme.trim() ?? "未选择"}</div>
                  </div>
                  <div className="mt-4 space-y-4">
                    <div className="space-y-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">题材列表</div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-3 2xl:grid-cols-4 max-h-[260px] overflow-y-auto pr-1">
                        {(genresData?.genres ?? []).map((genre) => {
                          const active = genre.id === selectedGenreId;
                          return (
                            <button
                              key={genre.id}
                              type="button"
                              onClick={() => setSelectedGenreId(genre.id)}
                              className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${active ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/70 text-muted-foreground hover:text-foreground"}`}
                            >
                              <div className="truncate font-medium">{genre.name}</div>
                              <div className="mt-0.5 text-[10px] opacity-70">{genre.id}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-border/40 bg-background/40 p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">基础参数</div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5 sm:col-span-2">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">书名</div>
                           <input value={bookTitle} onChange={(e) => setBookTitle(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2.5 text-sm outline-none`} placeholder="输入书名" />
                        </div>
                        <div className="space-y-1.5">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">语言</div>
                          <select value={bookLanguage} onChange={(e) => setBookLanguage(e.target.value === "en" ? "en" : "zh")} className={`w-full rounded-xl ${c.input} px-3 py-2.5 text-sm outline-none`}>
                            <option value="zh">中文</option>
                            <option value="en">English</option>
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">平台</div>
                          <select value={bookPlatform} onChange={(e) => setBookPlatform(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2.5 text-sm outline-none`}>
                            {platformOptionsForLanguage(bookLanguage).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">目标章数</div>
                          <input value={bookTargetChapters} onChange={(e) => setBookTargetChapters(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2.5 text-sm outline-none`} placeholder="例如 120" inputMode="numeric" />
                        </div>
                        <div className="space-y-1.5">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">每章字数</div>
                          <input value={bookChapterWords} onChange={(e) => setBookChapterWords(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2.5 text-sm outline-none`} placeholder={defaultChapterWordsForLanguage(bookLanguage)} inputMode="numeric" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">简介 / 故事背景</div>
                      <div className="text-xs text-muted-foreground">手工与自动两种模式切换，AI 动作统一走右侧工作台。</div>
                    </div>
                    {loadingDraft ? <div className="text-xs text-muted-foreground">读取中...</div> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setIntroMode("manual")} className={`rounded-full border px-4 py-2 text-sm ${introMode === "manual" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background/70 text-muted-foreground"}`}>手工</button>
                    <button type="button" onClick={() => setIntroMode("auto")} className={`rounded-full border px-4 py-2 text-sm ${introMode === "auto" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background/70 text-muted-foreground"}`}>自动</button>
                  </div>
                  {introMode === "manual" ? (
                    <div className="rounded-2xl border border-border/40 bg-background/40 p-4 space-y-3">
                      <textarea value={introSeedText} onChange={(e) => setIntroSeedText(e.target.value)} rows={5} className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`} placeholder="简介/卖点：...\n\n故事背景：..." />
                      <textarea value={introModifyNote} onChange={(e) => setIntroModifyNote(e.target.value)} rows={2} className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`} placeholder="修改要求：AI 修改 / AI 润色必填" />
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => void handleManualRevise("revise")} disabled={loading || creating || !manualModifyAllowed} className={`rounded-md px-4 py-3 text-sm font-medium ${c.btnPrimary} disabled:opacity-50`}>AI 修改</button>
                        <button onClick={() => void handleManualRevise("polish")} disabled={loading || creating || !manualModifyAllowed} className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50">AI 润色</button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-border/40 bg-background/40 p-4 space-y-3">
                      <textarea value={introTheme} onChange={(e) => setIntroTheme(e.target.value)} rows={2} className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`} placeholder="输入主题，生成候选" />
                      <div className="grid gap-3 md:grid-cols-[1fr_160px]">
                        <div className="rounded-xl border border-border/50 bg-background/70 p-3 text-xs leading-6 text-muted-foreground">可以输入一个主题，也可直接按题材生成。生成后可在左侧候选里选择第几套修改或落库。</div>
                        <input value={introCandidateCount} onChange={(e) => setIntroCandidateCount(e.target.value)} className={`w-full rounded-xl ${c.input} px-4 py-3 text-sm outline-none`} placeholder="3" inputMode="numeric" />
                      </div>
                      <button onClick={() => void handleGenerateCandidates()} disabled={loading || creating || introCandidateLoading || !autoGenerateAllowed} className={`rounded-md px-4 py-3 text-sm font-medium ${c.btnPrimary} disabled:opacity-50`}>{introCandidateLoading ? "生成中..." : "按主题生成候选"}</button>
                    </div>
                  )}
                </div>
                {currentStep !== "intro" ? (
                  <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">当前页要求</div>
                    <textarea value={stepInput} onChange={(e) => setStepInput(e.target.value)} rows={4} className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`} placeholder="输入当前页的补充要求" />
                  </div>
                ) : null}
                {currentStep === "intro" && introCandidates.length > 0 ? (
                  <div className="space-y-3 rounded-2xl border border-border/60 bg-background/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">候选池</div>
                        <div className="text-xs text-muted-foreground">选择第几套后，会写回草案并保留在右侧工作台。</div>
                      </div>
                        <div className="text-xs text-muted-foreground">{introCandidates.length} 套</div>
                    </div>
                    <div className="space-y-2 max-h-[30vh] overflow-y-auto pr-1">
                      {introCandidates.map((candidate, index) => {
                        const active = index === selectedIntroCandidateIndex;
                        return <button key={`${candidate.title}-${index}`} type="button" onClick={() => void handleSelectCandidate(candidate, index)} className={`w-full rounded-xl border p-3 text-left transition-colors ${active ? "border-primary bg-primary/5" : "border-border/50 bg-background/70 hover:border-primary/40"}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold">{candidate.title}</div>
                              <div className="mt-1 text-xs text-muted-foreground">{candidate.style || "未标注风格"}</div>
                            </div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{index + 1}</div>
                          </div>
                          <div className="mt-3 space-y-1 text-xs leading-6 text-muted-foreground">
                            <div><span className="font-medium text-foreground">卖点：</span>{candidate.blurb}</div>
                            <div><span className="font-medium text-foreground">背景：</span>{candidate.storyBackground}</div>
                          </div>
                        </button>;
                      })}
                    </div>
                    {selectedIntroCandidate ? <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm"><div className="font-medium">当前选中：{selectedIntroCandidate.title}</div><div className="mt-1 text-xs text-muted-foreground">点击卡片即可写回草案。</div></div> : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button onClick={handleDiscard} disabled={loading || creating} className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50">丢弃草案</button>
                  <button onClick={handleBack} disabled={!canGoBack || loading || creating} className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50">上一步</button>
                  <button onClick={handleAdvance} disabled={loading || creating || !nextStepMeta} className={`rounded-md px-4 py-3 text-sm font-medium ${c.btnPrimary} disabled:opacity-50`}>{nextStepMeta ? `下一步：${nextStepMeta.title}` : "已到最后一步"}</button>
                  {canCreate ? <button onClick={handleCreate} disabled={!canCreate || loading || creating} className="rounded-md border border-border bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground disabled:opacity-50">{creating ? "创建中..." : "最终创建书籍"}</button> : null}
                </div>
              </div>
            </section>
            <BookCreateChatDock
              nav={nav}
              pageTheme={theme}
              title={currentStepMeta.title}
              subtitle={currentStepMeta.subtitle}
              chatGuide={chatGuide}
              canStop={canStop}
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
      </main>
    </div>
  );
}

function BookCreateChatDock(props: {
  nav: Nav;
  pageTheme: Theme;
  title: string;
  subtitle: string;
  chatGuide: { placeholder: string; examples: ReadonlyArray<string>; advanceLabel: string };
  canStop: boolean;
  selectedModel: string | null;
  selectedService: string | null;
  modelPickerStatus: "loading" | "ready" | "no-models";
  filteredGroupedModels: ReadonlyArray<{ service: string; label: string; models: ReadonlyArray<{ id: string; name?: string }> }>;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string; timestamp: number; thinking?: string; thinkingStreaming?: boolean; audit?: unknown }>;
  loading: boolean;
  input: string;
  setInput: (value: string) => void;
  stopMessage: (sessionId: string) => Promise<void>;
  activeSessionId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  c: ReturnType<typeof useColors>;
  onSend: (text: string) => void;
  setSelectedModel: (model: string, service: string) => void;
}) {
  const { nav, pageTheme, title, subtitle, chatGuide, canStop, selectedModel, selectedService, modelPickerStatus, filteredGroupedModels, messages, loading, input, setInput, stopMessage, activeSessionId, scrollRef, textareaRef, c, onSend, setSelectedModel } = props;

  return (
    <aside className="w-full xl:sticky xl:top-6 xl:w-[640px] 2xl:w-[680px] shrink-0 h-[calc(100vh-3rem)] min-h-0 rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-start justify-between gap-3 border-b border-border/40 pb-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">AI 工作台</div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <button onClick={nav.toServices} className="text-xs text-muted-foreground hover:text-primary transition-colors">模型管理</button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4 pr-1">
        {messages.length === 0 && !loading ? (
          <div className="h-full flex flex-col items-center justify-center text-center select-none">
            <div className="w-14 h-14 rounded-2xl border border-dashed border-border flex items-center justify-center mb-4 bg-secondary/30 opacity-40">
              <BotMessageSquare size={24} className="text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground/70 max-w-md leading-7">右侧只保留聊天历史、输入框和模型切换。</p>
            <div className="mt-3 rounded-xl border border-border/50 bg-background/60 p-3 text-left text-xs leading-6 text-muted-foreground">
              <div className="font-medium text-foreground">输入提示</div>
              <div>{chatGuide.placeholder}</div>
              <div className="mt-2">{chatGuide.examples[0]}</div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <div key={`${msg.timestamp}-${i}`}>
                {msg.role === "user" ? (
                  <ChatMessage role="user" content={msg.content} timestamp={msg.timestamp} theme={pageTheme} />
                ) : (
                  <div className="space-y-2">
                    {!!msg.thinking && (
                      <AssistantThinkingCard
                        heading="思考过程（流式）"
                        content={msg.thinking}
                        isStreaming={msg.thinkingStreaming === true}
                      />
                    )}
                    <ChatMessage
                      role="assistant"
                      content={msg.content}
                      timestamp={msg.timestamp}
                      theme={pageTheme}
                      audit={msg.audit as never}
                    />
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <Message from="assistant">
                <AssistantOutputCard>
                  <Shimmer className="text-sm" duration={1.5}>Thinking...</Shimmer>
                </AssistantOutputCard>
              </Message>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border/40 pt-3">
        <div className="rounded-xl bg-secondary/30 transition-all">
          <div className="flex items-center gap-2 px-3 py-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (shouldSubmitChatOnKeyDown(e)) { e.preventDefault(); onSend(input); } }}
              placeholder="输入要求或直接聊天..."
              rows={1}
              className="flex-1 bg-transparent text-sm leading-6 placeholder:text-muted-foreground/50 outline-none! border-none! ring-0! shadow-none focus:outline-none! focus:ring-0! focus:border-none! resize-none disabled:opacity-50 max-h-[200px] overflow-y-auto"
            />
            <button
              type="button"
              onClick={() => {
                if (canStop && activeSessionId) {
                  void stopMessage(activeSessionId);
                  return;
                }
                onSend(input);
              }}
              disabled={!activeSessionId || (!canStop && !input.trim())}
              className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition-all disabled:opacity-20 disabled:scale-100 shadow-sm shadow-primary/20"
            >
              {canStop ? <Square size={12} fill="currentColor" strokeWidth={2.2} /> : <ArrowUp size={14} strokeWidth={2.5} />}
            </button>
          </div>
          <div className="flex items-center gap-2 px-3 pb-2 border-t border-border/20 pt-1.5">
            {modelPickerStatus === "loading" ? (
              <span className="text-xs text-muted-foreground/40 animate-pulse">加载模型...</span>
            ) : modelPickerStatus === "ready" ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted text-sm transition-colors cursor-pointer">
                  <span className="font-medium text-xs truncate max-w-[140px]">{selectedModel ?? "选择模型"}</span>
                  <ChevronDown size={14} className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-64 max-h-80 flex flex-col">
                  <div className="overflow-y-auto flex-1">
                    {filteredGroupedModels.map((group) => (
                      <div key={group.service}>
                        <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{group.label}</div>
                        {group.models.map((m) => {
                          const isSelected = selectedModel === m.id && selectedService === group.service;
                          return (
                            <DropdownMenuItem key={`${group.service}:${m.id}`} onClick={() => setSelectedModel(m.id, group.service)} className={isSelected ? "bg-muted/50" : ""}>
                              <div className="flex flex-1 items-center justify-between">
                                <span className="text-sm">{m.name ?? m.id}</span>
                                {isSelected && <Check size={14} className="text-primary shrink-0" />}
                              </div>
                            </DropdownMenuItem>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button onClick={() => nav.toServices()} className="text-xs text-muted-foreground/50 hover:text-primary transition-colors">配置模型</button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}



