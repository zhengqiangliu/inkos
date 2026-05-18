import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../../hooks/use-api";
import { X, RotateCcw, Check, Lock, Eye, GitCompare } from "lucide-react";

interface ChapterPlanVersion {
  version: number;
  action?: string;
  chapterName: string;
  status: string;
  source: string;
  chapterNumber?: number;
  lockedFields?: ReadonlyArray<string>;
  driftFlags?: ReadonlyArray<{ code: string; message: string }>;
  updatedAt: string;
}

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
  lockedFields?: ReadonlyArray<string>;
  driftFlags?: ReadonlyArray<{ code: string; message: string }>;
}

interface DiffResult {
  fromVersion: number;
  toVersion: number;
  changedFields: string[];
  from: ChapterPlan;
  to: ChapterPlan;
}

interface VersionHistoryModalProps {
  bookId: string;
  chapterNumber: number;
  currentPlan: ChapterPlan;
  onClose: () => void;
  onRestore: (plan: ChapterPlan) => void;
}

type ViewMode = "list" | "compare";

export function VersionHistoryModal({ bookId, chapterNumber, currentPlan, onClose, onRestore }: VersionHistoryModalProps) {
  const [history, setHistory] = useState<ReadonlyArray<ChapterPlanVersion>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedLeft, setSelectedLeft] = useState<number | null>(null);
  const [selectedRight, setSelectedRight] = useState<number | null>(null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [viewingVersion, setViewingVersion] = useState<ChapterPlanVersion | null>(null);
  const [viewingDetail, setViewingDetail] = useState<ChapterPlan | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ history: ChapterPlanVersion[] }>(
        `/books/${bookId}/chapter-plans/${chapterNumber}/history`
      );
      setHistory(data.history ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [bookId, chapterNumber]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  const handleCompare = useCallback(async () => {
    if (selectedLeft === null || selectedRight === null) return;
    setDiffLoading(true);
    setDiffResult(null);
    try {
      // Fetch both versions via the diff endpoint which returns from/to
      const data = await fetchJson<DiffResult>(
        `/books/${bookId}/chapter-plans/${chapterNumber}/diff?fromVersion=${selectedLeft}&toVersion=${selectedRight}`
      ).catch(() => null);

      // Fallback: load history and find matching versions
      if (!data) {
        const histData = await fetchJson<{ history: ChapterPlanVersion[] }>(
          `/books/${bookId}/chapter-plans/${chapterNumber}/history`
        );
        const allVersions = histData.history ?? [];
        const leftVer = allVersions.find(v => v.version === selectedLeft);
        const rightVer = allVersions.find(v => v.version === selectedRight);
        // Can't do full diff without full content, show simple view
        setDiffResult(null);
        return;
      }
      setDiffResult(data);
    } catch {
      // ignore
    } finally {
      setDiffLoading(false);
    }
  }, [bookId, chapterNumber, selectedLeft, selectedRight]);

  const handleViewVersion = useCallback(async (version: ChapterPlanVersion) => {
    if (viewingVersion?.version === version.version) {
      setViewingVersion(null);
      setViewingDetail(null);
      return;
    }
    setViewingVersion(version);
    setDetailLoading(true);
    try {
      // Fetch diff against current to get the version's full content
      const data = await fetchJson<DiffResult>(
        `/books/${bookId}/chapter-plans/${chapterNumber}/diff?fromVersion=${version.version}&toVersion=${currentPlan.version}`
      );
      // The 'from' field contains the older version
      if (version.version < currentPlan.version) {
        setViewingDetail(data.from);
      } else {
        setViewingDetail(data.to);
      }
    } catch {
      setViewingDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [bookId, chapterNumber, currentPlan.version, viewingVersion]);

  const handleRollback = useCallback(async (targetVersion: number) => {
    setRestoring(targetVersion);
    try {
      const result = await fetchJson<{ ok: boolean; plan: ChapterPlan }>(
        `/books/${bookId}/chapter-plans/${chapterNumber}/rollback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion }),
        }
      );
      if (result.ok) {
        await onRestore(result.plan);
        onClose();
      }
    } catch (e) {
      console.error("Rollback failed:", e);
    } finally {
      setRestoring(null);
    }
  }, [bookId, chapterNumber, onRestore, onClose]);

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  const STATUS_CLASS: Record<string, string> = {
    planned: "bg-sky-500/10 text-sky-400",
    backfilled: "bg-amber-500/10 text-amber-500",
    approved: "bg-emerald-500/10 text-emerald-500",
    locked: "bg-violet-500/10 text-violet-400",
    used: "bg-muted/40 text-muted-foreground",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[85vh] w-[780px] overflow-y-auto rounded-xl border border-border/20 bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/20 px-4 py-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium text-foreground">版本历史 - 第{chapterNumber}章</h3>
            <div className="flex rounded-md border border-border/30 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`px-2 py-1 text-[11px] ${viewMode === "list" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary/50"}`}
              >
                列表
              </button>
              <button
                type="button"
                onClick={() => setViewMode("compare")}
                className={`px-2 py-1 text-[11px] ${viewMode === "compare" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary/50"}`}
              >
                对比
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {loading ? (
            <p className="text-xs text-muted-foreground text-center py-8">加载中...</p>
          ) : error ? (
            <p className="text-xs text-destructive text-center py-8">{error}</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">暂无历史版本</p>
          ) : viewMode === "compare" ? (
            <div className="space-y-3">
              {/* Version selector */}
              <div className="flex items-center gap-2">
                <select
                  value={selectedLeft ?? ""}
                  onChange={e => setSelectedLeft(e.target.value ? Number(e.target.value) : null)}
                  className="flex-1 rounded-md border border-border/40 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/40"
                >
                  <option value="">选择版本</option>
                  {history.map(v => (
                    <option key={v.version} value={v.version}>
                      v{v.version} - {v.chapterName || "（未命名）"} - {formatDate(v.updatedAt)}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">↔</span>
                <select
                  value={selectedRight ?? ""}
                  onChange={e => setSelectedRight(e.target.value ? Number(e.target.value) : null)}
                  className="flex-1 rounded-md border border-border/40 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/40"
                >
                  <option value="">选择版本</option>
                  {history.map(v => (
                    <option key={v.version} value={v.version}>
                      v{v.version} - {v.chapterName || "（未命名）"} - {formatDate(v.updatedAt)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleCompare}
                  disabled={selectedLeft === null || selectedRight === null || diffLoading}
                  className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50"
                >
                  <GitCompare size={10} />
                  {diffLoading ? "对比中..." : "对比"}
                </button>
              </div>

              {/* Diff result */}
              {diffResult && (
                <DiffView diff={diffResult} onRollback={handleRollback} restoring={restoring} />
              )}

              {!diffResult && selectedLeft !== null && selectedRight !== null && !diffLoading && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  点击"对比"查看两个版本之间的差异
                </p>
              )}
            </div>
          ) : (
            /* List mode */
            <div className="space-y-2">
              {history.map((ver) => {
                const isCurrent = ver.version === currentPlan.version;
                const isViewing = viewingVersion?.version === ver.version;
                return (
                  <div key={ver.version} className="rounded-lg border border-border/20 overflow-hidden">
                    {/* Version row */}
                    <div className="flex items-center gap-2 px-3 py-2 bg-muted/10">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${isCurrent ? "bg-emerald-500/10 text-emerald-500" : "bg-muted/40 text-muted-foreground"}`}>
                        v{ver.version}
                        {isCurrent && " 当前"}
                      </span>
                      <span className="rounded-full bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {actionLabel(ver.action)}
                      </span>
                      <span className="text-[11px] font-medium text-foreground">
                        {ver.chapterName || "（未命名）"}
                      </span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[ver.status] ?? "bg-muted/40 text-muted-foreground"}`}>
                        {ver.status}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {formatDate(ver.updatedAt)}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleViewVersion(ver)}
                          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                        >
                          <Eye size={10} />
                          {isViewing ? "收起" : "查看"}
                        </button>
                        {!isCurrent && (
                          <button
                            type="button"
                            onClick={() => handleRollback(ver.version)}
                            disabled={restoring !== null}
                            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-orange-500 hover:bg-orange-500/10 disabled:opacity-50"
                          >
                            <RotateCcw size={10} />
                            {restoring === ver.version ? "回滚中..." : "回滚"}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {isViewing && (
                      <div className="px-3 py-2 border-t border-border/10">
                        {detailLoading ? (
                          <p className="text-[10px] text-muted-foreground">加载中...</p>
                        ) : viewingDetail ? (
                          <div className="space-y-1.5">
                            <FieldRow label="章节名称" value={viewingDetail.chapterName} />
                            <FieldRow label="核心看点" value={viewingDetail.highlight} />
                            <FieldRow label="核心冲突" value={viewingDetail.coreConflict} />
                            <FieldRow label="剧情与冲突" value={viewingDetail.plotAndConflict} multiline />
                            <FieldRow label="情感基调" value={viewingDetail.emotionalTone} />
                            <FieldRow label="结尾钩子" value={viewingDetail.endingHook} />
                            {viewingDetail.lockedFields && viewingDetail.lockedFields.length > 0 && (
                              <div className="flex items-center gap-1 mt-1">
                                <Lock size={10} className="text-violet-400" />
                                <span className="text-[10px] text-violet-400">
                                  已锁定: {viewingDetail.lockedFields.join(", ")}
                                </span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-[10px] text-muted-foreground">无法加载详情</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      <p className={`text-[11px] text-foreground mt-0.5 ${multiline ? "whitespace-pre-wrap" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function actionLabel(action?: string): string {
  const map: Record<string, string> = {
    manual: "手工",
    ai: "AI",
    approve: "复核",
    generate: "生成",
    "generate-replace": "生成覆盖",
    backfill: "回填",
    "fill-missing": "补全",
    current: "当前",
  };
  return map[action ?? ""] ?? (action ?? "未知");
}

function DiffView({ diff, onRollback, restoring }: { diff: DiffResult; onRollback: (v: number) => void; restoring: number | null }) {
  const fields = ["chapterName", "highlight", "coreConflict", "plotAndConflict", "emotionalTone", "endingHook"] as const;
  const changedSet = new Set(diff.changedFields);

  return (
    <div className="rounded-lg border border-border/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/10 border-b border-border/10">
        <span className="text-[11px] font-medium text-foreground">v{diff.fromVersion}</span>
        <span className="text-[10px] text-muted-foreground">→</span>
        <span className="text-[11px] font-medium text-foreground">v{diff.toVersion}</span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          变化字段: {diff.changedFields.length > 0 ? diff.changedFields.join(", ") : "无"}
        </span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border/10">
        {/* Left version */}
        <div className="p-3 space-y-1.5">
          <div className="text-[10px] font-medium text-muted-foreground mb-1">v{diff.fromVersion}</div>
          {fields.map(field => {
            const changed = changedSet.has(field);
            const val = diff.from[field as keyof typeof diff.from];
            return (
              <div key={field} className={changed ? "bg-orange-500/5 -mx-1 px-1 rounded" : ""}>
                <span className="text-[10px] font-medium text-muted-foreground">{fieldLabel(field)}</span>
                <p className={`text-[11px] mt-0.5 ${changed ? "text-orange-600 dark:text-orange-400" : "text-foreground"} ${String(val).includes("\n") ? "whitespace-pre-wrap" : ""}`}>
                  {String(val) || "—"}
                </p>
              </div>
            );
          })}
        </div>
        {/* Right version */}
        <div className="p-3 space-y-1.5">
          <div className="text-[10px] font-medium text-muted-foreground mb-1">v{diff.toVersion}</div>
          {fields.map(field => {
            const changed = changedSet.has(field);
            const val = diff.to[field as keyof typeof diff.to];
            return (
              <div key={field} className={changed ? "bg-green-500/5 -mx-1 px-1 rounded" : ""}>
                <span className="text-[10px] font-medium text-muted-foreground">{fieldLabel(field)}</span>
                <p className={`text-[11px] mt-0.5 ${changed ? "text-green-600 dark:text-green-400" : "text-foreground"} ${String(val).includes("\n") ? "whitespace-pre-wrap" : ""}`}>
                  {String(val) || "—"}
                </p>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-border/10 bg-secondary/5">
        <button
          type="button"
          onClick={() => onRollback(diff.fromVersion)}
          disabled={restoring !== null}
          className="inline-flex items-center gap-1 rounded-md border border-orange-500/30 px-3 py-1.5 text-[11px] text-orange-500 hover:bg-orange-500/10 disabled:opacity-50"
        >
          <RotateCcw size={10} />
          {restoring === diff.fromVersion ? "回滚中..." : `回滚到 v${diff.fromVersion}`}
        </button>
        <button
          type="button"
          onClick={() => onRollback(diff.toVersion)}
          disabled={restoring !== null}
          className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 px-3 py-1.5 text-[11px] text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          <RotateCcw size={10} />
          {restoring === diff.toVersion ? "回滚中..." : `回滚到 v${diff.toVersion}`}
        </button>
      </div>
    </div>
  );
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    chapterName: "章节名称",
    highlight: "核心看点",
    coreConflict: "核心冲突",
    plotAndConflict: "剧情与冲突",
    emotionalTone: "情感基调",
    endingHook: "结尾钩子",
  };
  return labels[field] ?? field;
}
