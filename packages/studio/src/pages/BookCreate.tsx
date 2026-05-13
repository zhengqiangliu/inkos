import { useEffect, useState } from "react";
import type { BookCreationDraft, BookCreationWizardStep, BookCreationWizardState } from "@actalk/inkos-core";
import { fetchJson, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";

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
  readonly activeBookId?: string;
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

const WIZARD_STEPS: ReadonlyArray<{ id: BookCreationWizardStep; title: string; subtitle: string }> = [
  { id: "intro", title: "简介 / 故事背景", subtitle: "先把卖点和故事起点定住" },
  { id: "world", title: "世界观", subtitle: "定义规则、势力和边界" },
  { id: "outline", title: "小说大纲", subtitle: "主线、成长路、章节卡点" },
  { id: "volume", title: "卷纲规划", subtitle: "卷级推进与每卷收束" },
  { id: "characters", title: "主角 / 配角", subtitle: "角色功能与驱动力" },
  { id: "arc", title: "人物弧光", subtitle: "核心弧光与成长转折" },
  { id: "relation", title: "人物关系", subtitle: "关系动力与剧情引擎" },
  { id: "review", title: "最终确认", subtitle: "一致性检查后再落库" },
];

function readStepIndex(step?: BookCreationWizardStep): number {
  return WIZARD_STEPS.findIndex((item) => item.id === step);
}

export function pickValidValue(current: string, available: ReadonlyArray<string>): string {
  if (current && available.includes(current)) {
    return current;
  }
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

export function canCreateFromDraft(draft?: BookCreationDraft): boolean {
  if (!draft) return false;
  if (draft.readyToCreate) return true;
  return Boolean(
    draft.title?.trim()
      && draft.genre?.trim()
      && typeof draft.targetChapters === "number"
      && typeof draft.chapterWordCount === "number",
  );
}

export function buildCreationDraftSummary(
  draft: BookCreationDraft,
  language: "zh" | "en",
): ReadonlyArray<{ key: string; label: string; value: string }> {
  const rows = language === "en"
    ? [
        draft.title ? { key: "title", label: "Title", value: draft.title } : undefined,
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

export async function waitForBookReady(
  bookId: string,
  options: WaitForBookReadyOptions = {},
): Promise<void> {
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

export function BookCreate({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data: project } = useApi<{ language: string }>("/project");
  const projectLang = (project?.language ?? "zh") as "zh" | "en";

  const [draft, setDraft] = useState<BookCreationDraft | undefined>();
  const [wizard, setWizard] = useState<BookCreationWizardState | undefined>();
  const [input, setInput] = useState("");
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refreshDraft = async (): Promise<void> => {
    const data = await fetchJson<InteractionSessionResponse>("/interaction/session");
    setDraft(data.session?.creationDraft);
    setWizard(data.session?.creationWizard);
  };

  useEffect(() => {
    let cancelled = false;
    setLoadingDraft(true);
    void refreshDraft()
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDraft(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentStep = wizard?.currentStep ?? "intro";
  const currentIndex = Math.max(0, readStepIndex(currentStep));
  const currentStepMeta = WIZARD_STEPS[currentIndex] ?? WIZARD_STEPS[0]!;
  const nextStepMeta = WIZARD_STEPS[currentIndex + 1];
  const canGoBack = currentIndex > 0;
  const canCreate = currentStep === "review" && Boolean(draft?.readyToCreate || (draft?.title && draft?.genre && draft?.targetChapters && draft?.chapterWordCount));

  const runAgentInstruction = async (instruction: string): Promise<AgentResponse> => {
    return fetchJson<AgentResponse>("/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    });
  };

  const handleAdvance = async () => {
    if (!nextStepMeta) return;
    setSubmitting(true);
    setError(null);
    try {
      const instruction = input.trim() || `确认当前${currentStepMeta.title}，自动生成下一步 ${nextStepMeta.title}。`;
      const data = await runAgentInstruction(instruction);
      setInput("");
      setStatus(data.response ?? null);
      setDraft(data.session?.creationDraft ?? draft);
      setWizard(data.session?.creationWizard ?? wizard);
      await refreshDraft();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBack = async () => {
    if (!canGoBack) return;
    setSubmitting(true);
    setError(null);
    try {
      const previousStep = WIZARD_STEPS[currentIndex - 1];
      const instruction = input.trim() || `返回上一步，回到 ${previousStep?.title ?? "上一页"}。`;
      const data = await runAgentInstruction(instruction);
      setInput("");
      setStatus(data.response ?? null);
      setDraft(data.session?.creationDraft ?? draft);
      setWizard(data.session?.creationWizard ?? wizard);
      await refreshDraft();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const data = await runAgentInstruction("/create");
      const bookId = data.session?.activeBookId;
      if (!bookId) {
        throw new Error(projectLang === "zh" ? "创建完成后没有返回书籍 ID。" : "Create succeeded but no book id was returned.");
      }
      setStatus(data.response ?? null);
      setDraft(undefined);
      setWizard(undefined);
      nav.toBook(bookId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const handleDiscard = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const data = await runAgentInstruction("/discard");
      setStatus(data.response ?? null);
      setDraft(undefined);
      setWizard(undefined);
      setInput("");
      await refreshDraft().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 min-w-0 overflow-hidden">
      <main className="flex-1 min-w-0 overflow-y-auto px-6 py-6 lg:px-8">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
            <span className="text-border">/</span>
            <span>{t("bread.newBook")}</span>
          </div>

          <div className="space-y-2">
            <h1 className="font-serif text-3xl">{t("create.title")}</h1>
          <p className="text-sm leading-7 text-muted-foreground">
              单面板流程：每次只处理一个阶段，用上一步 / 下一步切换，减少来回滚动。
            </p>
          </div>

          {error && <div className={`rounded-md border ${c.error} px-4 py-3`}>{error}</div>}
          {status && <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">{status}</div>}

          <div className="rounded-2xl border border-border/60 bg-card/70 p-5 space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">向导进度</div>
                <div className="text-sm text-muted-foreground">当前：{currentStepMeta.title}</div>
              </div>
              <div className="text-xs text-muted-foreground">{currentIndex + 1} / {WIZARD_STEPS.length}</div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {WIZARD_STEPS.map((step, index) => {
                const active = step.id === currentStep;
                const done = Boolean(wizard?.completedSteps.includes(step.id));
                return (
                  <div key={step.id} className={`rounded-xl border px-4 py-3 ${active ? "border-primary bg-primary/5" : done ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/50 bg-background/60"}`}>
                    <div className="text-xs font-semibold">{step.title}</div>
                    <div className="mt-1 text-[11px] leading-5 text-muted-foreground">{step.subtitle}</div>
                    <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">{index + 1}</div>
                  </div>
                );
              })}
            </div>

            <div className="rounded-2xl border border-border/60 bg-background/50 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{currentStepMeta.title}</div>
                  <div className="text-xs text-muted-foreground">{currentStepMeta.subtitle}</div>
                </div>
                {loadingDraft ? <div className="text-xs text-muted-foreground">读取中…</div> : null}
              </div>

              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={10}
                className={`w-full rounded-xl ${c.input} resize-y px-4 py-3 text-sm leading-7 focus:outline-none`}
                placeholder="输入当前页的补充要求，或直接用上一步 / 下一步切换。"
              />

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleBack}
                  disabled={!canGoBack || submitting || creating}
                  className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50"
                >
                  上一步
                </button>
                <button
                  onClick={handleAdvance}
                  disabled={submitting || creating || !nextStepMeta}
                  className={`rounded-md px-4 py-3 text-sm font-medium ${c.btnPrimary} disabled:opacity-50`}
                >
                  {nextStepMeta ? (submitting ? "处理中…" : `下一步：${nextStepMeta.title}`) : "已到最后一步"}
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!canCreate || submitting || creating}
                  className="rounded-md border border-border bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground disabled:opacity-50"
                >
                  {creating ? "创建中…" : "最终创建书籍"}
                </button>
                <button
                  onClick={handleDiscard}
                  disabled={submitting || creating}
                  className="rounded-md border border-border px-4 py-3 text-sm font-medium text-muted-foreground disabled:opacity-50"
                >
                  丢弃草案
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
