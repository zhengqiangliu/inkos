import type { BookCreationWizardStep } from "@actalk/inkos-core";
import type { ReactNode, RefObject } from "react";
import { ArrowUp, BotMessageSquare, Check, ChevronDown, Square } from "lucide-react";
import type { IntroCandidateLike, ReviewChecklistItem, StepValidationReport } from "./book-create-state";
import { defaultChapterWordsForLanguage, platformOptionsForLanguage } from "./book-create-state";
import { shouldSubmitChatOnKeyDown } from "./book-create-state";
import { ChatMessage } from "../components/chat/ChatMessage";
import { AssistantOutputCard } from "../components/chat/AssistantOutputCard";
import { AssistantThinkingCard } from "../components/chat/AssistantThinkingCard";
import { ToolExecutionSteps } from "../components/chat/ToolExecutionSteps";
import { Shimmer } from "../components/ai-elements/shimmer";
import { Message } from "../components/ai-elements/message";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import type { Message as ChatMessageType, ToolExecution } from "../store/chat/types";
import type { Theme } from "../hooks/use-theme";
import { StepMarkdownEditor } from "./StepMarkdownEditor";
import type { StepMarkdownSpec } from "./book-create-state";

type PanelColors = {
  readonly input: string;
  readonly btnPrimary: string;
};

function BookCreateModelPicker(props: {
  readonly selectedModel: string | null;
  readonly selectedService: string | null;
  readonly modelPickerStatus: "loading" | "ready" | "no-models";
  readonly filteredGroupedModels: ReadonlyArray<{ service: string; label: string; models: ReadonlyArray<{ id: string; name?: string }> }>;
  readonly nav: { toServices: () => void };
  readonly setSelectedModel: (model: string, service: string) => void;
}) {
  const { selectedModel, selectedService, modelPickerStatus, filteredGroupedModels, nav, setSelectedModel } = props;

  if (modelPickerStatus === "loading") {
    return <span className="text-xs text-muted-foreground/50 animate-pulse">加载模型...</span>;
  }

  if (modelPickerStatus === "no-models") {
    return <button onClick={() => nav.toServices()} className="text-xs text-muted-foreground/60 hover:text-primary transition-colors">配置模型</button>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors cursor-pointer hover:bg-muted">
        <span className="max-w-[160px] truncate text-xs font-medium">{selectedModel ?? "选择模型"}</span>
        <ChevronDown size={14} className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-64 max-h-80 flex flex-col">
        <div className="overflow-y-auto flex-1">
          {filteredGroupedModels.map((group) => (
            <div key={group.service}>
              <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{group.label}</div>
              {group.models.map((m) => {
                const isSelected = selectedModel === m.id && selectedService === group.service;
                return (
                  <DropdownMenuItem key={`${group.service}:${m.id}`} onClick={() => setSelectedModel(m.id, group.service)} className={isSelected ? "bg-muted/50" : ""}>
                    <div className="flex flex-1 items-center justify-between gap-3">
                      <span className="text-sm">{m.name ?? m.id}</span>
                      {isSelected ? <Check size={14} className="text-primary shrink-0" /> : null}
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IntroSectionShell(props: {
  readonly title: string;
  readonly description: string;
  readonly rightHint?: string;
  readonly children: ReactNode;
}) {
  const { title, description, rightHint, children } = props;
  return (
    <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        {rightHint ? <div className="text-xs text-muted-foreground text-right">{rightHint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function IntroBasicsSection(props: {
  readonly c: PanelColors;
  readonly genres: ReadonlyArray<{ id: string; name: string }>;
  readonly selectedGenreId: string;
  readonly selectedGenreLabel: string;
  readonly bookTitle: string;
  readonly bookLanguage: "zh" | "en";
  readonly bookPlatform: string;
  readonly bookTargetChapters: string;
  readonly bookChapterWords: string;
  readonly setSelectedGenreId: (value: string) => void;
  readonly setBookTitle: (value: string) => void;
  readonly setBookLanguage: (value: "zh" | "en") => void;
  readonly setBookPlatform: (value: string) => void;
  readonly setBookTargetChapters: (value: string) => void;
  readonly setBookChapterWords: (value: string) => void;
}) {
  const {
    c,
    genres,
    selectedGenreId,
    selectedGenreLabel,
    bookTitle,
    bookLanguage,
    bookPlatform,
    bookTargetChapters,
    bookChapterWords,
    setSelectedGenreId,
    setBookTitle,
    setBookLanguage,
    setBookPlatform,
    setBookTargetChapters,
    setBookChapterWords,
  } = props;
  const visibleGenres = genres.slice(0, 18);

  return (
    <IntroSectionShell
      title="题材 / 基本参数"
      description="这一页只处理题材、书名、平台、字数和简介候选。"
      rightHint={selectedGenreLabel || "未选择"}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">题材</div>
            <div className="text-[10px] text-muted-foreground">可横向滑动</div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 pr-1">
            {visibleGenres.map((genre) => {
              const active = genre.id === selectedGenreId;
              return (
                <button
                  key={genre.id}
                  type="button"
                  onClick={() => setSelectedGenreId(genre.id)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-left text-xs transition-colors ${active ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-background/70 text-muted-foreground hover:text-foreground"}`}
                >
                  <div className="truncate font-medium">{genre.name}</div>
                </button>
              );
            })}
          </div>
          {genres.length > visibleGenres.length ? (
            <div className="text-[10px] text-muted-foreground">还有 {genres.length - visibleGenres.length} 个题材未显示。</div>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">书名</div>
            <input value={bookTitle} onChange={(e) => setBookTitle(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2 text-sm outline-none`} placeholder="输入书名" />
          </div>
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">语言</div>
            <select value={bookLanguage} onChange={(e) => setBookLanguage(e.target.value === "en" ? "en" : "zh")} className={`w-full rounded-xl ${c.input} px-3 py-2 text-sm outline-none`}>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">平台</div>
            <select value={bookPlatform} onChange={(e) => setBookPlatform(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2 text-sm outline-none`}>
              {platformOptionsForLanguage(bookLanguage).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">目标章数</div>
            <input value={bookTargetChapters} onChange={(e) => setBookTargetChapters(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2 text-sm outline-none`} placeholder="例如 120" inputMode="numeric" />
          </div>
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">每章字数</div>
            <input value={bookChapterWords} onChange={(e) => setBookChapterWords(e.target.value)} className={`w-full rounded-xl ${c.input} px-3 py-2 text-sm outline-none`} placeholder={defaultChapterWordsForLanguage(bookLanguage)} inputMode="numeric" />
          </div>
        </div>
      </div>
    </IntroSectionShell>
  );
}

function IntroSeedSection(props: {
  readonly c: PanelColors;
  readonly loadingDraft: boolean;
  readonly introMode: "manual" | "auto";
  readonly introSeedText: string;
  readonly introTheme: string;
  readonly introCandidateCount: string;
  readonly selectedIntroCandidateIndex: number;
  readonly selectedIntroCandidate: IntroCandidateLike | null;
  readonly introCandidateLoading: boolean;
  readonly autoGenerateAllowed: boolean;
  readonly loading: boolean;
  readonly creating: boolean;
  readonly setIntroMode: (value: "manual" | "auto") => void;
  readonly setIntroSeedText: (value: string) => void;
  readonly setIntroTheme: (value: string) => void;
  readonly setIntroCandidateCount: (value: string) => void;
  readonly handleGenerateIntroBody: () => void;
  readonly handleGenerateCandidates: () => void;
}) {
  const {
    c,
    loadingDraft,
    introMode,
    introSeedText,
    introTheme,
    introCandidateCount,
    selectedIntroCandidateIndex,
    selectedIntroCandidate,
    introCandidateLoading,
    autoGenerateAllowed,
    loading,
    creating,
    setIntroMode,
    setIntroSeedText,
    setIntroTheme,
    setIntroCandidateCount,
    handleGenerateIntroBody,
    handleGenerateCandidates,
  } = props;

  return (
    <IntroSectionShell
      title="简介 / 故事背景"
      description="只在当前页处理简介候选，不展示世界观与后续页内容。"
      rightHint={loadingDraft ? "读取中..." : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setIntroMode("manual")} className={`rounded-full border px-4 py-2 text-sm ${introMode === "manual" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background/70 text-muted-foreground"}`}>手工模式</button>
        <button type="button" onClick={() => setIntroMode("auto")} className={`rounded-full border px-4 py-2 text-sm ${introMode === "auto" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background/70 text-muted-foreground"}`}>自动生成</button>
        {selectedIntroCandidate ? <span className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-[11px] text-primary">已选中候选 {selectedIntroCandidateIndex + 1}</span> : null}
      </div>
      {introMode === "manual" ? (
        <div className="rounded-2xl border border-border/40 bg-background/40 p-4 space-y-3">
          <textarea value={introSeedText} onChange={(e) => setIntroSeedText(e.target.value)} rows={5} className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`} placeholder="简介/卖点：..." />
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void handleGenerateIntroBody()} disabled={loading || creating || !introSeedText.trim()} className={`rounded-md px-4 py-3 text-sm font-medium ${c.btnPrimary} disabled:opacity-50`}>生成正文</button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/40 bg-background/40 p-4 space-y-3">
          <textarea value={introTheme} onChange={(e) => setIntroTheme(e.target.value)} rows={2} className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`} placeholder="输入主题，生成候选池" />
          <div className="grid gap-3 md:grid-cols-[1fr_160px]">
            <div className="rounded-xl border border-border/50 bg-background/70 p-3 text-xs leading-6 text-muted-foreground">先生成候选池，再选中候选并切到正文页确认。这里不会直接进入右侧确认流程。</div>
            <input value={introCandidateCount} onChange={(e) => setIntroCandidateCount(e.target.value)} className={`w-full rounded-xl ${c.input} px-4 py-3 text-sm outline-none`} placeholder="3" inputMode="numeric" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void handleGenerateCandidates()} disabled={loading || creating || introCandidateLoading || !autoGenerateAllowed} className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50">{introCandidateLoading ? "候选生成中..." : "生成候选池"}</button>
          </div>
        </div>
      )}
    </IntroSectionShell>
  );
}

function IntroCandidatePoolSection(props: {
  readonly introCandidates: ReadonlyArray<IntroCandidateLike>;
  readonly selectedIntroCandidateIndex: number;
  readonly selectedIntroCandidate: IntroCandidateLike | null;
  readonly introMode: "manual" | "auto";
  readonly handleSelectCandidate: (candidate: IntroCandidateLike, index: number) => void;
}) {
  const { introCandidates, selectedIntroCandidateIndex, selectedIntroCandidate, introMode, handleSelectCandidate } = props;
  if (introCandidates.length === 0) return null;

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 bg-background/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">候选池</div>
          <div className="text-xs text-muted-foreground">仅展示当前页候选，点选后回填当前页内容。</div>
        </div>
        <div className="text-xs text-muted-foreground">{introCandidates.length} 套</div>
      </div>
      <div className="space-y-2 max-h-[30vh] overflow-y-auto pr-1">
        {introCandidates.map((candidate, index) => {
          const active = index === selectedIntroCandidateIndex;
          return (
            <button
              key={`${candidate.title}-${index}`}
              type="button"
              onClick={() => handleSelectCandidate(candidate, index)}
              className={`w-full rounded-xl border p-3 text-left transition-colors ${active ? "border-primary bg-primary/5" : "border-border/50 bg-background/70 hover:border-primary/40"}`}
            >
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
            </button>
          );
        })}
      </div>
      {selectedIntroCandidate ? (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">
          <div className="font-medium">当前选中：{selectedIntroCandidate.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">当前状态：{introMode === "manual" ? "手工模式，已回填可继续编辑" : "自动模式，继续生成候选"}</div>
        </div>
      ) : null}
    </div>
  );
}

function IntroDraftParamsSection(props: { readonly hardParams: ReadonlyArray<{ key: string; label: string; value: string }> }) {
  const { hardParams } = props;
  return (
    <div className="rounded-xl border border-border/40 bg-background/40 px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground mb-2">草案参数</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {hardParams.map((item) => (
          <div key={item.key} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{item.label}：</span>{item.value}
          </div>
        ))}
      </div>
    </div>
  );
}

export function IntroPanel(props: {
  c: PanelColors;
  introBodySpec: StepMarkdownSpec;
  introPanelTab: "generate" | "body";
  genres: ReadonlyArray<{ id: string; name: string }>;
  selectedGenreId: string;
  selectedGenreLabel: string;
  introMode: "manual" | "auto";
  introSeedText: string;
  introBodyDraft: string;
  introTheme: string;
  introCandidateCount: string;
  introCandidates: ReadonlyArray<IntroCandidateLike>;
  selectedIntroCandidateIndex: number;
  selectedIntroCandidate: IntroCandidateLike | null;
  loadingDraft: boolean;
  loading: boolean;
  creating: boolean;
  introCandidateLoading: boolean;
  autoGenerateAllowed: boolean;
  introBodyEditing: boolean;
  bookTitle: string;
  bookLanguage: "zh" | "en";
  bookPlatform: string;
  bookTargetChapters: string;
  bookChapterWords: string;
  hardParams: ReadonlyArray<{ key: string; label: string; value: string }>;
  setSelectedGenreId: (value: string) => void;
  setIntroPanelTab: (value: "generate" | "body") => void;
  setIntroMode: (value: "manual" | "auto") => void;
  setIntroSeedText: (value: string) => void;
  setIntroBodyDraft: (value: string) => void;
  setIntroTheme: (value: string) => void;
  setIntroCandidateCount: (value: string) => void;
  setIntroBodyEditing: (value: boolean) => void;
  setBookTitle: (value: string) => void;
  setBookLanguage: (value: "zh" | "en") => void;
  setBookPlatform: (value: string) => void;
  setBookTargetChapters: (value: string) => void;
  setBookChapterWords: (value: string) => void;
  onBookTargetChaptersTouched?: () => void;
  onBookChapterWordsTouched?: () => void;
  handleGenerateIntroBody: () => void;
  handleGenerateCandidates: () => void;
  handleSelectCandidate: (candidate: IntroCandidateLike, index: number) => void;
}) {
  const {
    c,
    introBodySpec,
    introPanelTab,
    genres,
    selectedGenreId,
    selectedGenreLabel,
    introMode,
    introSeedText,
    introBodyDraft,
    introTheme,
    introCandidateCount,
    introCandidates,
    selectedIntroCandidateIndex,
    selectedIntroCandidate,
    loadingDraft,
    loading,
    creating,
    introCandidateLoading,
    autoGenerateAllowed,
    introBodyEditing,
    bookTitle,
    bookLanguage,
    bookPlatform,
    bookTargetChapters,
    bookChapterWords,
    hardParams,
    setSelectedGenreId,
    setIntroPanelTab,
    setIntroMode,
    setIntroSeedText,
    setIntroBodyDraft,
    setIntroTheme,
    setIntroCandidateCount,
    setIntroBodyEditing,
    setBookTitle,
    setBookLanguage,
    setBookPlatform,
    setBookTargetChapters,
    setBookChapterWords,
    onBookTargetChaptersTouched,
    onBookChapterWordsTouched,
    handleGenerateIntroBody,
    handleGenerateCandidates,
    handleSelectCandidate,
  } = props;

  const updateBookTargetChapters = (value: string): void => {
    onBookTargetChaptersTouched?.();
    setBookTargetChapters(value);
  };

  const updateBookChapterWords = (value: string): void => {
    onBookChapterWordsTouched?.();
    setBookChapterWords(value);
  };

  return (
    <div className="space-y-5">
      <IntroBasicsSection
        c={c}
        genres={genres}
        selectedGenreId={selectedGenreId}
        selectedGenreLabel={selectedGenreLabel}
        bookTitle={bookTitle}
        bookLanguage={bookLanguage}
        bookPlatform={bookPlatform}
        bookTargetChapters={bookTargetChapters}
        bookChapterWords={bookChapterWords}
        setSelectedGenreId={setSelectedGenreId}
        setBookTitle={setBookTitle}
        setBookLanguage={setBookLanguage}
        setBookPlatform={setBookPlatform}
        setBookTargetChapters={updateBookTargetChapters}
        setBookChapterWords={updateBookChapterWords}
      />
      <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setIntroPanelTab("generate")} className={`rounded-full border px-4 py-2 text-sm ${introPanelTab === "generate" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background/70 text-muted-foreground"}`}>生成</button>
          <button type="button" onClick={() => setIntroPanelTab("body")} className={`rounded-full border px-4 py-2 text-sm ${introPanelTab === "body" ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background/70 text-muted-foreground"}`}>正文</button>
        </div>
        {introPanelTab === "generate" ? (
          <div className="space-y-5">
            <IntroSeedSection
              c={c}
              loadingDraft={loadingDraft}
              introMode={introMode}
              introSeedText={introSeedText}
              introTheme={introTheme}
              introCandidateCount={introCandidateCount}
              selectedIntroCandidateIndex={selectedIntroCandidateIndex}
              selectedIntroCandidate={selectedIntroCandidate}
              introCandidateLoading={introCandidateLoading}
              autoGenerateAllowed={autoGenerateAllowed}
              loading={loading}
              creating={creating}
              setIntroMode={setIntroMode}
              setIntroSeedText={setIntroSeedText}
              setIntroTheme={setIntroTheme}
              setIntroCandidateCount={setIntroCandidateCount}
              handleGenerateIntroBody={handleGenerateIntroBody}
              handleGenerateCandidates={handleGenerateCandidates}
            />
            <IntroCandidatePoolSection
              introCandidates={introCandidates}
              selectedIntroCandidateIndex={selectedIntroCandidateIndex}
              selectedIntroCandidate={selectedIntroCandidate}
              introMode={introMode}
              handleSelectCandidate={handleSelectCandidate}
            />
          </div>
        ) : (
          <StepMarkdownEditor
            spec={introBodySpec}
            value={introBodyDraft}
            editing={introBodyEditing}
            onToggleEditing={() => setIntroBodyEditing(!introBodyEditing)}
            onValueChange={setIntroBodyDraft}
            showAiActions={false}
          />
        )}
      </div>
      <IntroDraftParamsSection hardParams={hardParams} />
    </div>
  );
}

function StepFieldEditor(props: {
  readonly c: PanelColors;
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly placeholder: string;
  readonly rows?: number;
  readonly onChange: (value: string) => void;
}) {
  const { c, label, hint, value, placeholder, rows = 4, onChange } = props;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
        {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 outline-none`}
        placeholder={placeholder}
      />
    </div>
  );
}

export function OutlinePanel(props: {
  c: PanelColors;
  novelOutline: string;
  conflictCore: string;
  setNovelOutline: (value: string) => void;
  setConflictCore: (value: string) => void;
}) {
  const { c, novelOutline, conflictCore, setNovelOutline, setConflictCore } = props;
  return (
    <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">小说大纲</div>
          <div className="text-xs text-muted-foreground">主线、成长路、章节卡点。只填当前页字段。</div>
        </div>
        <div className="text-xs text-muted-foreground">保存后进入卷纲规划</div>
      </div>
      <StepFieldEditor c={c} label="大纲" hint="主线 / 成长路 / 卡点" value={novelOutline} placeholder="开局 → 发展 → 转折 → 高潮 → 结局方向..." rows={6} onChange={setNovelOutline} />
      <StepFieldEditor c={c} label="核心冲突" value={conflictCore} placeholder="主角面临的核心矛盾与驱动力..." rows={3} onChange={setConflictCore} />
    </div>
  );
}

export function VolumePanel(props: {
  c: PanelColors;
  volumeOutline: string;
  setVolumeOutline: (value: string) => void;
}) {
  const { c, volumeOutline, setVolumeOutline } = props;
  return (
    <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">卷纲规划</div>
          <div className="text-xs text-muted-foreground">卷级推进与每卷收束。只填当前页字段。</div>
        </div>
        <div className="text-xs text-muted-foreground">保存后进入主角 / 配角</div>
      </div>
      <StepFieldEditor c={c} label="卷纲方向" hint="总卷数 / 每卷目标 / 卷末钩子" value={volumeOutline} placeholder="第一卷：...\n第二卷：...\n卷末钩子：..." rows={8} onChange={setVolumeOutline} />
    </div>
  );
}

export function CharactersPanel(props: {
  c: PanelColors;
  protagonist: string;
  supportingCast: string;
  characterMatrix: string;
  setProtagonist: (value: string) => void;
  setSupportingCast: (value: string) => void;
  setCharacterMatrix: (value: string) => void;
}) {
  const { c, protagonist, supportingCast, characterMatrix, setProtagonist, setSupportingCast, setCharacterMatrix } = props;
  return (
    <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">主角 / 配角</div>
          <div className="text-xs text-muted-foreground">角色功能与驱动力。只填当前页字段。</div>
        </div>
        <div className="text-xs text-muted-foreground">保存后进入人物弧光</div>
      </div>
      <StepFieldEditor c={c} label="主角" hint="姓名 / 处境 / 动机" value={protagonist} placeholder="姓名：...\n处境：...\n动机：..." rows={4} onChange={setProtagonist} />
      <StepFieldEditor c={c} label="配角" hint="关键配角卡 / 出场节点" value={supportingCast} placeholder="配角1：...\n配角2：..." rows={4} onChange={setSupportingCast} />
      <StepFieldEditor c={c} label="角色矩阵" hint="功能 / 关系 / 作用" value={characterMatrix} placeholder="角色矩阵表格或说明..." rows={3} onChange={setCharacterMatrix} />
    </div>
  );
}

export function ArcPanel(props: {
  c: PanelColors;
  characterArc: string;
  setCharacterArc: (value: string) => void;
}) {
  const { c, characterArc, setCharacterArc } = props;
  return (
    <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">人物弧光</div>
          <div className="text-xs text-muted-foreground">核心弧光与成长转折。只填当前页字段。</div>
        </div>
        <div className="text-xs text-muted-foreground">保存后进入人物关系</div>
      </div>
      <StepFieldEditor c={c} label="人物弧光" hint="起点 → 转折 → 终点" value={characterArc} placeholder="起点状态：...\n成长转折：...\n终点状态：..." rows={6} onChange={setCharacterArc} />
    </div>
  );
}

export function RelationPanel(props: {
  c: PanelColors;
  relationshipMap: string;
  setRelationshipMap: (value: string) => void;
}) {
  const { c, relationshipMap, setRelationshipMap } = props;
  return (
    <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">人物关系</div>
          <div className="text-xs text-muted-foreground">关系动力与剧情引擎。只填当前页字段。</div>
        </div>
        <div className="text-xs text-muted-foreground">保存后进入收尾校验</div>
      </div>
      <StepFieldEditor c={c} label="人物关系" hint="关系矩阵 / 核心关系线 / 变化方向" value={relationshipMap} placeholder="主角 ↔ 配角1：...\n主角 ↔ 配角2：...\n关系变化方向：..." rows={6} onChange={setRelationshipMap} />
    </div>
  );
}

export function WorldPanel(props: {
  c: PanelColors;
  worldStepDraft: string;
  setWorldStepDraft: (value: string) => void;
}) {
  const { c, worldStepDraft, setWorldStepDraft } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/60 bg-background/50 p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">世界观</div>
            <div className="text-xs text-muted-foreground">本页只处理世界观录入，不再重复展示第一页摘要。</div>
          </div>
          <div className="text-xs text-muted-foreground">保存后进入小说大纲</div>
        </div>
        <textarea
          value={worldStepDraft}
          onChange={(e) => setWorldStepDraft(e.target.value)}
          className={`min-h-[320px] flex-1 w-full rounded-xl ${c.input} resize-none px-4 py-3 text-sm leading-7 outline-none`}
          placeholder="世界观：...补充设定：..."
        />
      </div>
    </div>
  );
}

export function ReviewPanel(props: {
  creationReviewChecklist: ReadonlyArray<ReviewChecklistItem>;
  canCreate: boolean;
  onJumpToStep: (step: BookCreationWizardStep) => void;
}) {
  const { creationReviewChecklist, canCreate, onJumpToStep } = props;
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">收尾校验清单</div>
            <div className="text-xs text-muted-foreground">只做收尾校验，不再展示前面各页的编辑区。</div>
          </div>
          <div className={`text-xs font-medium ${canCreate ? "text-primary" : "text-amber-600"}`}>
            {canCreate ? "已满足创建条件" : "仍有缺项"}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {creationReviewChecklist.map((item) => (
            <div
              key={item.key}
              className={`rounded-xl border px-3 py-2 text-left text-xs leading-6 transition-colors ${item.done ? "border-border/50 bg-background/70" : "border-dashed border-amber-400/60 bg-amber-50/40 text-amber-700"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className={`font-medium ${item.done ? "text-foreground" : "text-amber-800"}`}>{item.label}</div>
                <div className={`text-[10px] font-bold uppercase tracking-[0.18em] ${item.done ? "text-primary" : "text-amber-700/80"}`}>
                  {item.done ? "✓ 完成" : "待补"}
                </div>
              </div>
              <div className={`mt-1 whitespace-pre-wrap ${item.done ? "text-muted-foreground" : "text-amber-700"}`}>{item.value || "待补齐"}</div>
              {!item.done ? (
                <button
                  type="button"
                  onClick={() => {
                    if (item.target.kind === "basic") {
                      window.scrollTo({ top: 0, behavior: "smooth" });
                      return;
                    }
                    onJumpToStep(item.target.step);
                  }}
                  className="mt-2 text-[10px] font-medium uppercase tracking-[0.18em] text-amber-700/80 hover:text-amber-800"
                >
                  {item.target.kind === "basic" ? "去补基本参数" : "去补这一页"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {!canCreate ? (
          <div className="rounded-xl border border-dashed border-amber-400/60 bg-amber-50/40 px-3 py-2 text-xs leading-6 text-amber-700">
            先通过"上一步"或左侧向导补齐缺项，所有关键项完成后继续推进下一页。
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function StepValidationBanner(props: {
  report: StepValidationReport;
  onAutoFix: () => void;
  onAdvance: () => void;
  isAutoFixing: boolean;
  canAdvance: boolean;
}) {
  const { report, onAutoFix, onAdvance, isAutoFixing, canAdvance } = props;
  const hasIssues = report.issues.length > 0;

  return (
    <div className={`rounded-2xl border px-4 py-3 ${hasIssues ? "border-amber-400/60 bg-amber-50/50 text-amber-900" : "border-emerald-500/30 bg-emerald-50/60 text-emerald-900"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-70">当前页校验</div>
          <div className="text-sm font-medium">{report.summary}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasIssues ? (
            <button
              type="button"
              onClick={onAutoFix}
              disabled={isAutoFixing}
              className="rounded-md border border-amber-400/60 bg-white/70 px-3 py-2 text-xs font-medium text-amber-800 disabled:opacity-50"
            >
              {isAutoFixing ? "自动补全中..." : "自动补全本页"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onAdvance}
            disabled={!canAdvance}
            className={`rounded-md px-3 py-2 text-xs font-medium ${hasIssues ? "bg-amber-600 text-white" : "bg-primary text-primary-foreground"} disabled:opacity-50`}
          >
            下一步
          </button>
        </div>
      </div>
      {hasIssues ? <div className="mt-2 text-xs leading-6 opacity-90">{report.issues.map((issue) => issue.message).join(" · ")}</div> : null}
    </div>
  );
}

export function WizardHeader(props: {
  wizardIndex: ReadonlyArray<{
    readonly id: BookCreationWizardStep;
    readonly title: string;
    readonly subtitle: string;
    readonly status: "current" | "done" | "todo";
  }>;
  onJumpToStep: (step: BookCreationWizardStep) => void;
}) {
  const { wizardIndex, onJumpToStep } = props;

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
      <div className="flex gap-2 overflow-x-auto">
        {wizardIndex.map((item, index) => {
          const active = item.status === "current";
          const done = item.status === "done";
          const canEnter = active || done;
          return (
            <button
              key={item.id}
              type="button"
              onClick={canEnter ? () => onJumpToStep(item.id) : undefined}
              disabled={!canEnter}
              title={!canEnter ? "先完成前序步骤后再进入" : undefined}
              className={`shrink-0 rounded-full border px-3 py-2 text-xs transition-colors ${active ? "border-primary bg-primary/10 text-primary" : done ? "border-border/60 bg-background/70 text-foreground" : "border-border/40 bg-background/50 text-muted-foreground opacity-70"} disabled:cursor-not-allowed disabled:hover:text-muted-foreground`}
            >
              {index + 1}. {item.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function WizardActions(props: {
  canGoBack: boolean;
  canAdvance: boolean;
  creating: boolean;
  isAdvancing: boolean;
  isAutoCompleting: boolean;
  currentStep: BookCreationWizardStep;
  isReview: boolean;
  canCreate: boolean;
  showAutoComplete: boolean;
  handleDiscard: () => void;
  handleBack: () => void;
  handleAdvance: () => void;
  handleCreate: () => void;
  handleAutoComplete: () => void;
}) {
  const {
    canGoBack,
    canAdvance,
    creating,
    isAdvancing,
    isAutoCompleting,
    currentStep,
    isReview,
    canCreate,
    showAutoComplete,
    handleDiscard,
    handleBack,
    handleAdvance,
    handleCreate,
    handleAutoComplete,
  } = props;

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <button onClick={handleDiscard} disabled={creating || isAdvancing || isAutoCompleting} className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50">丢弃草案</button>
      <button onClick={handleBack} disabled={!canGoBack || creating || isAdvancing || isAutoCompleting} className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50">上一步</button>
      {!isReview ? <button onClick={handleAdvance} disabled={creating || isAdvancing || isAutoCompleting || !canAdvance} className="rounded-md px-4 py-3 text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50">{isAdvancing ? "生成中..." : "下一步"}</button> : null}
      {!isReview && showAutoComplete ? <button onClick={handleAutoComplete} disabled={creating || isAdvancing || isAutoCompleting || !canAdvance} className="rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm font-medium text-primary disabled:opacity-50">{isAutoCompleting ? "全自动生成中..." : "一键全自动完成"}</button> : null}
      {isReview ? <button onClick={handleCreate} disabled={!canCreate || creating} title={!canCreate ? "请先完成分项向导并补齐书名、题材、章数、字数" : undefined} className="rounded-md border border-border bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground disabled:opacity-50">{creating ? "创建中..." : "完成创建"}</button> : null}
    </div>
  );
}

type BookCreateDockMessage = Pick<
  ChatMessageType,
  "role" | "content" | "timestamp" | "thinking" | "thinkingStreaming" | "audit" | "toolExecutions"
>;

export function BookCreateChatDock(props: {
  nav: { toServices: () => void };
  pageTheme: Theme;
  title: string;
  subtitle: string;
  chatGuide: { placeholder: string; examples: ReadonlyArray<string>; advanceLabel: string };
  legacyMessageCount: number;
  canStop: boolean;
  isAdvancing: boolean;
  selectedModel: string | null;
  selectedService: string | null;
  modelPickerStatus: "loading" | "ready" | "no-models";
  filteredGroupedModels: ReadonlyArray<{ service: string; label: string; models: ReadonlyArray<{ id: string; name?: string }> }>;
  messages: ReadonlyArray<BookCreateDockMessage>;
  loading: boolean;
  input: string;
  setInput: (value: string) => void;
  stopMessage: (sessionId: string) => Promise<void>;
  activeSessionId: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  c: { readonly link: string };
  onSend: (text: string) => void;
  setSelectedModel: (model: string, service: string) => void;
}) {
  const { nav, pageTheme, title, subtitle, chatGuide, legacyMessageCount, canStop, isAdvancing, selectedModel, selectedService, modelPickerStatus, filteredGroupedModels, messages, loading, input, setInput, stopMessage, activeSessionId, scrollRef, textareaRef, c, onSend, setSelectedModel } = props;
  const currentAssistantExecutions = messages.flatMap((message) => (message.role === "assistant" ? [...(message.toolExecutions ?? [])] : [])) as ToolExecution[];

  return (
    <aside className="w-full xl:sticky xl:top-6 xl:w-[640px] 2xl:w-[680px] shrink-0 min-h-0 rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm flex flex-col overflow-hidden xl:h-full">
      <div className="shrink-0 flex flex-col gap-3 border-b border-border/40 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">AI 工作台</div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <BookCreateModelPicker
            nav={nav}
            selectedModel={selectedModel}
            selectedService={selectedService}
            modelPickerStatus={modelPickerStatus}
            filteredGroupedModels={filteredGroupedModels}
            setSelectedModel={setSelectedModel}
          />
          <button onClick={nav.toServices} className="text-xs text-muted-foreground hover:text-primary transition-colors">模型管理</button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4 pr-1">
        {messages.length === 0 && !loading && !isAdvancing ? (
          <div className="h-full flex flex-col items-center justify-center text-center select-none">
            <div className="w-14 h-14 rounded-2xl border border-dashed border-border flex items-center justify-center mb-4 bg-secondary/30 opacity-40">
              <BotMessageSquare size={24} className="text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground/70 max-w-md leading-7">右侧只保留当前页的思考、正文和工具事件。</p>
            {legacyMessageCount > 0 ? (
              <div className="mt-3 rounded-xl border border-border/50 bg-background/60 px-3 py-2 text-left text-xs leading-6 text-muted-foreground">
                已隐藏 {legacyMessageCount} 条未绑定向导页的旧历史消息。
              </div>
            ) : null}
            <div className="mt-3 rounded-xl border border-border/50 bg-background/60 p-3 text-left text-xs leading-6 text-muted-foreground">
              <div className="font-medium text-foreground">输入提示</div>
              <div>{chatGuide.placeholder}</div>
              <div className="mt-2">{chatGuide.examples[0]}</div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {currentAssistantExecutions.length > 0 ? (
              <div className="rounded-2xl border border-border/60 bg-background/50 p-3">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">当前页工具事件</div>
                <ToolExecutionSteps executions={currentAssistantExecutions} />
              </div>
            ) : null}
            {messages
              .filter((msg) => msg.role === "assistant")
              .map((msg, i) => (
                <div key={`${msg.timestamp}-${i}`} className="space-y-2">
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
              ))}
            {loading && (
              <Message from="assistant">
                <AssistantOutputCard>
                  <Shimmer className="text-sm" duration={1.5}>Thinking...</Shimmer>
                </AssistantOutputCard>
              </Message>
            )}
            {isAdvancing && !loading && messages.length === 0 && (
              <Message from="assistant">
                <AssistantOutputCard>
                  <Shimmer className="text-sm" duration={1.5}>{`正在生成 ${title} 内容...`}</Shimmer>
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
        </div>
      </div>
    </aside>
  );
}
