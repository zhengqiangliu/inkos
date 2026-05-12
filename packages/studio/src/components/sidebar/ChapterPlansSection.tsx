import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson } from "../../hooks/use-api";
import { SidebarCard } from "./SidebarCard";
import { X, Sparkles, ChevronDown, ChevronUp, RotateCcw, Check, Lock, History } from "lucide-react";
import { VersionHistoryModal } from "./VersionHistoryModal";

interface ChapterPlan {
  chapterNumber: number;
  chapterName: string;
  highlight: string;
  coreConflict: string;
  plotAndConflict: string;
  emotionalTone: string;
  endingHook: string;
  status: string;
  source: string;
  version: number;
  needsReview?: boolean;
  lockedFields?: ReadonlyArray<string>;
  driftFlags?: ReadonlyArray<{ code: string; message: string }>;
  maxNewHooks?: number;
  maxRecoveryPerChapter?: number;
  anchorRefs?: {
    outlineAnchorId?: string;
    worldRefs?: ReadonlyArray<string>;
    characterRefs?: ReadonlyArray<string>;
    emotionRefs?: ReadonlyArray<string>;
    hookRefs?: ReadonlyArray<string>;
  };
}

interface ChapterPlansResponse {
  count: number;
  plans: ReadonlyArray<ChapterPlan>;
}

interface BookInfoResponse {
  nextChapter?: number;
}

interface ChapterPlanBatchActionResponse {
  ok?: boolean;
  partial?: boolean;
  successChapters?: ReadonlyArray<number>;
  removedChapters?: ReadonlyArray<number>;
  failedChapters?: ReadonlyArray<{
    chapterNumber: number;
    reasonCode?: string;
    reason?: string;
  }>;
}

type ChapterPlanRow =
  | { kind: "plan"; chapterNumber: number; plan: ChapterPlan }
  | { kind: "missing"; chapterNumber: number; plan: null };

export function computeMissingChapterNumbers(
  plans: ReadonlyArray<ChapterPlan>,
  nextChapter: number,
): number[] {
  const latestChapterPlanned = plans.reduce((max, item) => Math.max(max, item.chapterNumber), 0);
  const coverageEnd = Math.max(1, nextChapter - 1, latestChapterPlanned);
  const existing = new Set(plans.map((plan) => plan.chapterNumber));
  const missing: number[] = [];
  for (let chapter = 1; chapter <= coverageEnd; chapter += 1) {
    if (!existing.has(chapter)) missing.push(chapter);
  }
  return missing;
}

export function buildChapterPlanRows(
  plans: ReadonlyArray<ChapterPlan>,
  missingChapters: ReadonlyArray<number>,
  filter: "all" | "missing" | "backfilled" | "drift",
): ChapterPlanRow[] {
  const mapped = plans.map((plan) => ({ kind: "plan" as const, chapterNumber: plan.chapterNumber, plan }));
  const missing = missingChapters.map((chapterNumber) => ({ kind: "missing" as const, chapterNumber, plan: null }));
  const all = [...mapped, ...missing].sort((a, b) => a.chapterNumber - b.chapterNumber);
  if (filter === "all") return all;
  if (filter === "missing") return all.filter((row) => row.kind === "missing");
  if (filter === "backfilled") return all.filter((row) => row.kind === "plan" && row.plan.status === "backfilled");
  return all.filter((row) => row.kind === "plan" && (row.plan.driftFlags?.length ?? 0) > 0);
}

export function mapChapterPlanFailureReason(item: {
  reasonCode?: string;
  reason?: string;
}): string {
  const code = typeof item.reasonCode === "string" ? item.reasonCode : "";
  if (code === "CHAPTER_PLAN_AGENT_MISSING_OUTPUT") return "Agent 未返回该章节分章设计";
  if (code === "CHAPTER_PLAN_AGENT_FAILED") return item.reason?.trim() || "Agent 生成失败";
  if (code === "CHAPTER_CONTENT_MISSING") return "章节正文缺失，无法回填分章设计";
  if (typeof item.reason === "string" && item.reason.trim()) return item.reason.trim();
  return "unknown-error";
}

const STATUS_CLASS: Record<string, string> = {
  planned: "bg-sky-500/10 text-sky-400",
  backfilled: "bg-amber-500/10 text-amber-500",
  approved: "bg-emerald-500/10 text-emerald-500",
  locked: "bg-violet-500/10 text-violet-400",
  used: "bg-muted/40 text-muted-foreground",
};

export function ChapterPlansSection({ bookId }: { readonly bookId: string }) {
  const [plans, setPlans] = useState<ReadonlyArray<ChapterPlan>>([]);
  const [nextChapter, setNextChapter] = useState(1);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "missing" | "backfilled" | "drift">("all");
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
  const [historyChapter, setHistoryChapter] = useState<number | null>(null);
  const [expandedChapters, setExpandedChapters] = useState<Set<number>>(new Set());
  const [actionSummary, setActionSummary] = useState<{
    label: string;
    partial: boolean;
    successChapters: number[];
    failedChapters: Array<{ chapterNumber: number; reason: string }>;
  } | null>(null);

  // 生成章节弹窗状态
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [generateStart, setGenerateStart] = useState(1);
  const [generateCount, setGenerateCount] = useState(20);
  const [precheckResult, setPrecheckResult] = useState<{
    startChapter: number;
    endChapter: number;
    count: number;
    chapters: Array<{
      chapterNumber: number;
      hasPlan: boolean;
      hasContent: boolean;
      status?: string;
    }>;
    hasConflict: boolean;
    hasExistingPlan: boolean;
  } | null>(null);
  const [prechecking, setPrechecking] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, book] = await Promise.all([
        fetchJson<ChapterPlansResponse>(`/books/${bookId}/chapter-plans`),
        fetchJson<BookInfoResponse>(`/books/${bookId}`),
      ]);
      setPlans(Array.isArray(data.plans) ? data.plans : []);
      setNextChapter(Math.max(1, Number(book.nextChapter ?? 1)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlans([]);
      setNextChapter(1);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const runAction = useCallback(async (label: string, runner: () => Promise<ChapterPlanBatchActionResponse | void>) => {
    setRunning(label);
    setError(null);
    try {
      const result = await runner();
      if (result && (Array.isArray(result.successChapters) || Array.isArray(result.removedChapters) || Array.isArray(result.failedChapters))) {
        setActionSummary({
          label,
          partial: Boolean(result.partial),
          successChapters: Array.isArray(result.successChapters)
            ? [...result.successChapters]
            : Array.isArray(result.removedChapters)
              ? [...result.removedChapters]
              : [],
          failedChapters: Array.isArray(result.failedChapters)
            ? result.failedChapters.map((item) => ({
              chapterNumber: Number(item.chapterNumber),
              reason: mapChapterPlanFailureReason(item),
            }))
            : [],
        });
      } else {
        setActionSummary(null);
      }
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }, [refetch]);

  const missingChapters = useMemo(() => {
    return computeMissingChapterNumbers(plans, nextChapter);
  }, [plans, nextChapter]);

  const latestChapterPlanned = useMemo(
    () => plans.reduce((max, item) => Math.max(max, item.chapterNumber), 0),
    [plans],
  );
  const coverageEnd = useMemo(
    () => Math.max(1, nextChapter - 1, latestChapterPlanned),
    [nextChapter, latestChapterPlanned],
  );

  const displayRows = useMemo(() => {
    return buildChapterPlanRows(plans, missingChapters, filter);
  }, [plans, missingChapters, filter]);

  const handleGenerateClick = useCallback(() => {
    // 默认起始章节为下一章
    setGenerateStart(nextChapter);
    setGenerateCount(20);
    setPrecheckResult(null);
    setShowGenerateModal(true);
  }, [nextChapter]);

  const handlePrecheck = useCallback(async () => {
    setPrechecking(true);
    try {
      const result = await fetchJson<{
        startChapter: number;
        endChapter: number;
        count: number;
        chapters: Array<{
          chapterNumber: number;
          hasPlan: boolean;
          hasContent: boolean;
          status?: string;
        }>;
        hasConflict: boolean;
        hasExistingPlan: boolean;
      }>(`/books/${bookId}/chapter-plans/precheck-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startChapter: generateStart, count: generateCount }),
      });
      setPrecheckResult(result);
    } catch (e) {
      setPrecheckResult(null);
    } finally {
      setPrechecking(false);
    }
  }, [bookId, generateStart, generateCount]);

  const handleGenerate = useCallback(() => {
    const force = precheckResult?.hasExistingPlan ?? false;
    void runAction(`生成第${generateStart}-${generateStart + generateCount - 1}章`, async () => {
      return await fetchJson<ChapterPlanBatchActionResponse>(
        `/books/${bookId}/chapter-plans/generate-batch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startChapter: generateStart, count: generateCount, force }),
        },
      );
    });
    setShowGenerateModal(false);
  }, [bookId, generateStart, generateCount, precheckResult, runAction]);

  const closeGenerateModal = useCallback(() => {
    setShowGenerateModal(false);
    setPrecheckResult(null);
  }, []);

  const handleFillMissing = useCallback(() => {
    void runAction("补全缺失", async () => {
      return await fetchJson<ChapterPlanBatchActionResponse>(`/books/${bookId}/chapter-plans/fill-missing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startChapter: 1, endChapter: Math.max(coverageEnd, 200) }),
      });
    });
  }, [bookId, coverageEnd, runAction]);

  const handleBackfill = useCallback(() => {
    void runAction("回填分章", async () => {
      return await fetchJson<ChapterPlanBatchActionResponse>(`/books/${bookId}/chapter-plans/backfill-from-chapter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startChapter: 1, endChapter: coverageEnd }),
      });
    });
  }, [bookId, coverageEnd, runAction]);

  const handleCleanupOverflow = useCallback(() => {
    void runAction("清理超纲分章", async () => {
      return await fetchJson<ChapterPlanBatchActionResponse>(`/books/${bookId}/chapter-plans/cleanup-overflow`, {
        method: "POST",
      });
    });
  }, [bookId, runAction]);

  const handleApprove = useCallback((chapterNumber: number) => {
    void runAction(`通过第${chapterNumber}章`, async () => {
      await fetchJson(`/books/${bookId}/chapter-plans/${chapterNumber}/approve`, {
        method: "POST",
      });
    });
  }, [bookId, runAction]);

  const handleLockCoreFields = useCallback((chapterNumber: number) => {
    void runAction(`锁定第${chapterNumber}章`, async () => {
      await fetchJson(`/books/${bookId}/chapter-plans/${chapterNumber}/lock-fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: [
            "chapterName",
            "highlight",
            "coreConflict",
            "plotAndConflict",
            "emotionalTone",
            "endingHook",
          ],
        }),
      });
    });
  }, [bookId, runAction]);

  const handleUnlockCoreFields = useCallback((chapterNumber: number) => {
    void runAction(`解锁第${chapterNumber}章`, async () => {
      await fetchJson(`/books/${bookId}/chapter-plans/${chapterNumber}/unlock-fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    });
  }, [bookId, runAction]);

  const toggleExpand = useCallback((chapterNumber: number) => {
    setExpandedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(chapterNumber)) {
        next.delete(chapterNumber);
      } else {
        next.add(chapterNumber);
      }
      return next;
    });
  }, []);

  const openEditModal = useCallback((plan: ChapterPlan) => {
    setSelectedChapter(plan.chapterNumber);
  }, []);

  const closeModal = useCallback(() => {
    setSelectedChapter(null);
  }, []);

  const parseCsv = useCallback((value: string): string[] => (
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  ), []);

  return (
    <SidebarCard
      title="章节分章设计"
      contentClassName="space-y-2"
      actions={running ? <span className="text-[10px] text-primary">{running}</span> : null}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex flex-wrap gap-1.5">
        {[
          { key: "all", label: "全部" },
          { key: "missing", label: `缺失(${missingChapters.length})` },
          { key: "backfilled", label: "待确认" },
          { key: "drift", label: "漂移" },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key as "all" | "missing" | "backfilled" | "drift")}
            className={`rounded-md px-2 py-1 text-[11px] ${
              filter === item.key
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={handleGenerateClick}
          className="rounded-md border border-border/40 px-2 py-1 text-[11px] text-foreground hover:bg-secondary/50"
        >
          生成章节
        </button>
        <button
          type="button"
          onClick={handleFillMissing}
          className="rounded-md border border-border/40 px-2 py-1 text-[11px] text-foreground hover:bg-secondary/50"
        >
          补全缺失
        </button>
        <button
          type="button"
          onClick={handleBackfill}
          className="rounded-md border border-border/40 px-2 py-1 text-[11px] text-foreground hover:bg-secondary/50"
        >
          回填已写章节
        </button>
        <button
          type="button"
          onClick={handleCleanupOverflow}
          className="rounded-md border border-amber-500/30 px-2 py-1 text-[11px] text-amber-500 hover:bg-amber-500/10"
        >
          清理超纲
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {actionSummary && (
        <div className="rounded-md border border-border/30 bg-secondary/20 px-2 py-1 text-[11px] text-foreground">
          <p className="font-medium">
            {actionSummary.label}
            {actionSummary.partial ? "（部分成功）" : "（完成）"}
          </p>
          <p className="text-muted-foreground">
            成功 {actionSummary.successChapters.length} 章，失败 {actionSummary.failedChapters.length} 章
          </p>
          {actionSummary.failedChapters.length > 0 && (
            <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
              {actionSummary.failedChapters.slice(0, 8).map((item) => (
                <p key={`${item.chapterNumber}-${item.reason}`}>
                  第{item.chapterNumber}章：{item.reason}
                </p>
              ))}
              {actionSummary.failedChapters.length > 8 && (
                <p>... 其余 {actionSummary.failedChapters.length - 8} 章失败</p>
              )}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">加载中...</p>
      ) : displayRows.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无章节设计</p>
      ) : (
        <div className="space-y-1 overflow-y-auto">
          {displayRows.map((row) => {
            if (row.kind === "missing") {
              return (
                <div key={`missing-${row.chapterNumber}`} className="rounded-lg border border-destructive/20 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-foreground">第{row.chapterNumber}章</span>
                    <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">missing</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">该章缺少分章设计</p>
                </div>
              );
            }
            const plan = row.plan;
            const isExpanded = expandedChapters.has(plan.chapterNumber);
            return (
              <div
                key={`${plan.chapterNumber}-${plan.version}`}
                className={`relative rounded-lg border ${isExpanded ? "border-primary/40" : "border-border/20"}`}
              >
                {/* Header - always visible */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                  onClick={() => toggleExpand(plan.chapterNumber)}
                >
                  <span className="text-[11px] font-medium text-foreground">第{plan.chapterNumber}章</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[plan.status] ?? "bg-muted/40 text-muted-foreground"}`}>
                    {plan.status}
                  </span>
                  <span className="rounded-full bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    v{plan.version}
                  </span>
                  {(plan.driftFlags?.length ?? 0) > 0 && (
                    <span className="rounded-full bg-orange-500/10 px-1.5 py-0.5 text-[10px] text-orange-500">
                      drift
                    </span>
                  )}
                  {plan.lockedFields?.length ? (
                    <Lock size={10} className="text-violet-400" />
                  ) : null}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </span>
                </div>

                {/* Chapter name - always visible */}
                <div className="px-3 pb-1">
                  <p className="text-xs font-medium text-foreground">{plan.chapterName || "（未命名）"}</p>
                </div>

                {/* Expanded floating panel */}
                {isExpanded && (
                  <div className="absolute top-full left-0 right-0 z-30 mt-1 mx-1 rounded-lg border border-border/30 bg-background shadow-xl animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="p-3 space-y-2 max-h-[60vh] overflow-y-auto">
                      {/* All fields displayed */}
                      <div className="space-y-2">
                        <div>
                          <label className="text-[10px] text-muted-foreground font-medium">核心看点</label>
                          <p className="text-xs text-foreground mt-0.5">{plan.highlight || "—"}</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground font-medium">核心冲突</label>
                          <p className="text-xs text-foreground mt-0.5">{plan.coreConflict || "—"}</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground font-medium">剧情与冲突</label>
                          <p className="text-xs text-foreground mt-0.5 whitespace-pre-wrap">{plan.plotAndConflict || "—"}</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground font-medium">情感基调</label>
                          <p className="text-xs text-foreground mt-0.5">{plan.emotionalTone || "—"}</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground font-medium">结尾钩子</label>
                          <p className="text-xs text-foreground mt-0.5">{plan.endingHook || "—"}</p>
                        </div>
                        <div className="flex gap-4 pt-1">
                          <div>
                            <label className="text-[10px] text-muted-foreground font-medium">新增伏笔上限</label>
                            <p className="text-xs text-foreground mt-0.5">{plan.maxNewHooks ?? 3}</p>
                          </div>
                          <div>
                            <label className="text-[10px] text-muted-foreground font-medium">每章最多回收</label>
                            <p className="text-xs text-foreground mt-0.5">{plan.maxRecoveryPerChapter ?? 3}</p>
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border/10">
                        <button
                          type="button"
                          onClick={() => handleApprove(plan.chapterNumber)}
                          className="inline-flex items-center gap-1 rounded border border-emerald-500/30 px-2 py-1 text-[10px] text-emerald-500 hover:bg-emerald-500/10"
                        >
                          <Check size={10} />通过
                        </button>
                        {plan.lockedFields && plan.lockedFields.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleUnlockCoreFields(plan.chapterNumber)}
                            className="inline-flex items-center gap-1 rounded border border-orange-500/30 px-2 py-1 text-[10px] text-orange-500 hover:bg-orange-500/10"
                          >
                            <Lock size={10} />取消锁定
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleLockCoreFields(plan.chapterNumber)}
                            className="inline-flex items-center gap-1 rounded border border-violet-500/30 px-2 py-1 text-[10px] text-violet-400 hover:bg-violet-500/10"
                          >
                            <Lock size={10} />锁核心
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEditModal(plan)}
                          className="inline-flex items-center gap-1 rounded border border-primary/30 px-2 py-1 text-[10px] text-primary hover:bg-primary/10"
                        >
                          <Sparkles size={10} />编辑优化
                        </button>
                        <button
                          type="button"
                          onClick={() => setHistoryChapter(plan.chapterNumber)}
                          className="inline-flex items-center gap-1 rounded border border-secondary/40 px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary/30 hover:text-foreground"
                        >
                          <History size={10} />版本
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit Modal */}
      {selectedChapter !== null && (
        <EditPlanModal
          bookId={bookId}
          chapterNumber={selectedChapter}
          plan={plans.find((p) => p.chapterNumber === selectedChapter) ?? null}
          onClose={closeModal}
          onSave={async (updated) => {
            await runAction(`保存第${selectedChapter}章`, async () => {
              await fetchJson(`/books/${bookId}/chapter-plans/${selectedChapter}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ...updated,
                  source: "manual",
                  needsReview: false,
                }),
              });
            });
            await refetch();
            closeModal();
          }}
        />
      )}

      {historyChapter !== null && (
        <VersionHistoryModal
          bookId={bookId}
          chapterNumber={historyChapter}
          currentPlan={plans.find((p) => p.chapterNumber === historyChapter)!}
          onClose={() => setHistoryChapter(null)}
          onRestore={async (restoredPlan) => {
            await refetch();
          }}
        />
      )}

      {/* Generate Modal */}
      {showGenerateModal && (
        <GeneratePlanModal
          nextChapter={nextChapter}
          generateStart={generateStart}
          setGenerateStart={setGenerateStart}
          generateCount={generateCount}
          setGenerateCount={setGenerateCount}
          precheckResult={precheckResult}
          prechecking={prechecking}
          onPrecheck={handlePrecheck}
          onGenerate={handleGenerate}
          onClose={closeGenerateModal}
        />
      )}
    </SidebarCard>
  );
}

// Generate Plan Modal Component
interface GeneratePlanModalProps {
  nextChapter: number;
  generateStart: number;
  setGenerateStart: (v: number) => void;
  generateCount: number;
  setGenerateCount: (v: number) => void;
  precheckResult: {
    startChapter: number;
    endChapter: number;
    count: number;
    chapters: Array<{
      chapterNumber: number;
      hasPlan: boolean;
      hasContent: boolean;
      status?: string;
    }>;
    hasConflict: boolean;
    hasExistingPlan: boolean;
  } | null;
  prechecking: boolean;
  onPrecheck: () => void;
  onGenerate: () => void;
  onClose: () => void;
}

function GeneratePlanModal({
  nextChapter,
  generateStart,
  setGenerateStart,
  generateCount,
  setGenerateCount,
  precheckResult,
  prechecking,
  onPrecheck,
  onGenerate,
  onClose,
}: GeneratePlanModalProps) {
  const endChapter = generateStart + generateCount - 1;

  // 分类章节状态
  const conflictChapters = precheckResult?.chapters.filter((c) => c.hasContent && c.hasPlan) ?? [];
  const existingPlanChapters = precheckResult?.chapters.filter((c) => c.hasPlan && !c.hasContent) ?? [];
  const newChapters = precheckResult?.chapters.filter((c) => !c.hasPlan && !c.hasContent) ?? [];

  const canGenerate = precheckResult && !precheckResult.hasConflict;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[85vh] w-[500px] overflow-y-auto rounded-xl border border-border/40 bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/20 px-4 py-3">
          <h3 className="text-sm font-medium text-foreground">生成分章设计</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="space-y-4 p-4">
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="text-[11px] font-medium text-muted-foreground">起始章节</label>
              <input
                type="number"
                min={1}
                value={generateStart}
                onChange={(e) => setGenerateStart(Math.max(1, parseInt(e.target.value) || 1))}
                className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
                placeholder={`下一章: ${nextChapter}`}
              />
            </div>
            <div className="flex-1">
              <label className="text-[11px] font-medium text-muted-foreground">生成数量</label>
              <input
                type="number"
                min={1}
                max={200}
                value={generateCount}
                onChange={(e) => setGenerateCount(Math.max(1, Math.min(200, parseInt(e.target.value) || 1)))}
                className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              />
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            将生成：第{generateStart}章 - 第{endChapter}章，共{generateCount}章
          </div>

          <button
            type="button"
            onClick={onPrecheck}
            disabled={prechecking}
            className="w-full rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            {prechecking ? "检测中..." : "检测章节状态"}
          </button>

          {precheckResult && (
            <div className="space-y-2">
              {precheckResult.hasConflict && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
                  <p className="text-xs font-medium text-destructive">有章节正文已存在，不能生成分章设计</p>
                  <p className="mt-1 text-[10px] text-destructive/70">
                    第{conflictChapters.map((c) => c.chapterNumber).join("、")}章正文已存在，无法覆盖
                  </p>
                </div>
              )}

              {precheckResult.hasExistingPlan && !precheckResult.hasConflict && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <p className="text-xs font-medium text-amber-500">部分章节已有分章设计，将会覆盖</p>
                  <p className="mt-1 text-[10px] text-amber-500/70">
                    第{existingPlanChapters.map((c) => c.chapterNumber).join("、")}章已有分章设计（无正文）
                  </p>
                </div>
              )}

              {newChapters.length > 0 && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                  <p className="text-xs text-emerald-500">新增生成：{newChapters.length}章</p>
                  <p className="mt-1 text-[10px] text-emerald-500/70">
                    第{newChapters[0]?.chapterNumber} -
                    第{newChapters[newChapters.length - 1]?.chapterNumber}章
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border/20 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border/40 px-4 py-1.5 text-xs text-muted-foreground hover:bg-secondary/50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onGenerate}
            disabled={!canGenerate}
            className="rounded-md bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            确认生成
          </button>
        </div>
      </div>
    </div>
  );
}

// Edit Modal Component
interface EditPlanModalProps {
  bookId: string;
  chapterNumber: number;
  plan: ChapterPlan | null;
  onClose: () => void;
  onSave: (updated: Partial<ChapterPlan>) => Promise<void>;
}

function EditPlanModal({ bookId, chapterNumber, plan, onClose, onSave }: EditPlanModalProps) {
  const [form, setForm] = useState({
    chapterName: plan?.chapterName ?? "",
    highlight: plan?.highlight ?? "",
    coreConflict: plan?.coreConflict ?? "",
    plotAndConflict: plan?.plotAndConflict ?? "",
    emotionalTone: plan?.emotionalTone ?? "",
    endingHook: plan?.endingHook ?? "",
    maxNewHooks: plan?.maxNewHooks ?? 3,
    maxRecoveryPerChapter: plan?.maxRecoveryPerChapter ?? 3,
  });
  const [aiPrompt, setAiPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiOptimizing, setAiOptimizing] = useState(false);

  const handleOptimize = useCallback(async () => {
    if (!aiPrompt.trim()) return;
    setAiOptimizing(true);
    try {
      const response = await fetchJson<{ content: string }>(`/books/${bookId}/chapter-plans/${chapterNumber}/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: aiPrompt,
          currentPlan: form,
        }),
      });
      // Try to parse JSON response from AI
      try {
        const parsed = JSON.parse(response.content);
        setForm((prev) => ({
          chapterName: parsed.chapterName ?? prev.chapterName,
          highlight: parsed.highlight ?? prev.highlight,
          coreConflict: parsed.coreConflict ?? prev.coreConflict,
          plotAndConflict: parsed.plotAndConflict ?? prev.plotAndConflict,
          emotionalTone: parsed.emotionalTone ?? prev.emotionalTone,
          endingHook: parsed.endingHook ?? prev.endingHook,
          maxNewHooks: parsed.maxNewHooks ?? prev.maxNewHooks,
          maxRecoveryPerChapter: parsed.maxRecoveryPerChapter ?? prev.maxRecoveryPerChapter,
        }));
      } catch {
        // If not JSON, show as highlight
        setForm((prev) => ({ ...prev, highlight: response.content }));
      }
    } catch (err) {
      console.error("AI optimize failed:", err);
    } finally {
      setAiOptimizing(false);
    }
  }, [aiPrompt, bookId, chapterNumber, form]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  }, [form, onSave]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[85vh] w-[560px] overflow-y-auto rounded-xl border border-border/40 bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/20 px-4 py-3">
          <h3 className="text-sm font-medium text-foreground">编辑第{chapterNumber}章分章设计</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="space-y-3 p-4">
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">章节名称</label>
            <input
              type="text"
              value={form.chapterName}
              onChange={(e) => setForm((p) => ({ ...p, chapterName: e.target.value }))}
              className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              placeholder="例如：夜探城主府"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">核心看点</label>
            <textarea
              value={form.highlight}
              onChange={(e) => setForm((p) => ({ ...p, highlight: e.target.value }))}
              rows={2}
              className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              placeholder="一句话说明本章最吸引人的点"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">核心冲突</label>
            <textarea
              value={form.coreConflict}
              onChange={(e) => setForm((p) => ({ ...p, coreConflict: e.target.value }))}
              rows={2}
              className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              placeholder="本章最主要的矛盾是什么"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">剧情与冲突</label>
            <textarea
              value={form.plotAndConflict}
              onChange={(e) => setForm((p) => ({ ...p, plotAndConflict: e.target.value }))}
              rows={4}
              className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              placeholder="详细描述本章剧情走向和冲突推进"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">情感基调</label>
            <input
              type="text"
              value={form.emotionalTone}
              onChange={(e) => setForm((p) => ({ ...p, emotionalTone: e.target.value }))}
              className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              placeholder="紧张/温情/悬疑/热血/压抑"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground">结尾钩子</label>
            <textarea
              value={form.endingHook}
              onChange={(e) => setForm((p) => ({ ...p, endingHook: e.target.value }))}
              rows={2}
              className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              placeholder="本章结尾留下的悬念或转折"
            />
          </div>

          {/* Hook limits */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="text-[11px] font-medium text-muted-foreground">新增伏笔上限</label>
              <input
                type="number"
                min={0}
                max={10}
                value={form.maxNewHooks}
                onChange={(e) => setForm((p) => ({ ...p, maxNewHooks: Math.max(0, parseInt(e.target.value) || 0) }))}
                className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              />
            </div>
            <div className="flex-1">
              <label className="text-[11px] font-medium text-muted-foreground">每章最多回收伏笔</label>
              <input
                type="number"
                min={0}
                max={10}
                value={form.maxRecoveryPerChapter}
                onChange={(e) => setForm((p) => ({ ...p, maxRecoveryPerChapter: Math.max(0, parseInt(e.target.value) || 0) }))}
                className="mt-1 w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/40"
              />
            </div>
          </div>

          {/* AI Optimize Section */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-primary" />
              <span className="text-[11px] font-medium text-primary">AI 优化修正</span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              输入修改指令，AI 将根据你的要求优化分章设计内容
            </p>
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-border/40 bg-background px-3 py-1.5 text-xs outline-none focus:border-primary/40"
              placeholder="例如：让冲突更激烈，加入更多悬念"
            />
            <button
              type="button"
              onClick={handleOptimize}
              disabled={aiOptimizing || !aiPrompt.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {aiOptimizing ? <RotateCcw size={10} className="animate-spin" /> : <Sparkles size={10} />}
              {aiOptimizing ? "优化中..." : "AI 优化"}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border/20 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border/40 px-4 py-1.5 text-xs text-muted-foreground hover:bg-secondary/50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
