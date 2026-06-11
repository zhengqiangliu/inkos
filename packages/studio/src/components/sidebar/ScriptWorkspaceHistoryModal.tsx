import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, GitCompare, RotateCcw, X } from "lucide-react";
import { fetchJson } from "../../hooks/use-api";
import type {
  ScriptWorkspace,
  ScriptWorkspaceDiffResult,
  ScriptWorkspaceHistoryEntry,
  ScriptWorkspaceHistoryResponse,
} from "../../shared/contracts";

interface ScriptWorkspaceHistoryModalProps {
  readonly bookId: string;
  readonly currentWorkspace: ScriptWorkspace;
  readonly onClose: () => void;
  readonly onRestore: (workspace: ScriptWorkspace) => void;
}

type ViewMode = "list" | "compare";

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAction(action: string): string {
  const map: Record<string, string> = {
    save: "保存",
    generate: "生成",
    rollback: "回滚",
    current: "当前",
  };
  return map[action] ?? action;
}

function formatChangedField(field: string): string {
  const map: Record<string, string> = {
    selectedChapterNumbers: "选章范围",
    config: "生成配置",
    scriptPrompt: "整体提示词",
    extraction: "提取结果",
    episodes: "分集分段结果",
  };
  return map[field] ?? field;
}

function WorkspaceSummary({ workspace }: { workspace: ScriptWorkspace }) {
  const segmentCount = workspace.episodes.reduce((sum, episode) => sum + episode.segments.length, 0);
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
        <div className="text-[10px] text-muted-foreground">选中章节</div>
        <div className="mt-1 text-[11px] text-foreground">
          {workspace.selectedChapterNumbers.join("、") || "无"}
        </div>
      </div>
      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
        <div className="text-[10px] text-muted-foreground">时长配置</div>
        <div className="mt-1 text-[11px] text-foreground">
          每集 {workspace.config.episodeDurationSec}s / 每段 {workspace.config.segmentDurationMinSec}-{workspace.config.segmentDurationMaxSec}s
        </div>
      </div>
      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
        <div className="text-[10px] text-muted-foreground">提取结果</div>
        <div className="mt-1 text-[11px] text-foreground">
          场景 {workspace.extraction.scenes.length} / 角色 {workspace.extraction.characters.length}
        </div>
      </div>
      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
        <div className="text-[10px] text-muted-foreground">剧本结果</div>
        <div className="mt-1 text-[11px] text-foreground">
          {workspace.episodes.length} 集 / {segmentCount} 段
        </div>
      </div>
    </div>
  );
}

export function ScriptWorkspaceHistoryModal({
  bookId,
  currentWorkspace,
  onClose,
  onRestore,
}: ScriptWorkspaceHistoryModalProps) {
  const [history, setHistory] = useState<ReadonlyArray<ScriptWorkspaceHistoryEntry>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [selectedLeft, setSelectedLeft] = useState<number | null>(null);
  const [selectedRight, setSelectedRight] = useState<number | null>(null);
  const [diffResult, setDiffResult] = useState<ScriptWorkspaceDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson<ScriptWorkspaceHistoryResponse>(`/books/${bookId}/script-workspace/history`);
        if (cancelled) return;
        setHistory(data.history ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  useEffect(() => {
    if (history.length === 0) {
      setSelectedVersion(null);
      setSelectedLeft(null);
      setSelectedRight(null);
      return;
    }
    const latest = history[history.length - 1]!;
    setSelectedVersion((current) => history.some((entry) => entry.version === current) ? current : latest.version);
    setSelectedLeft((current) => history.some((entry) => entry.version === current) ? current : history[0]!.version);
    setSelectedRight((current) => history.some((entry) => entry.version === current) ? current : latest.version);
  }, [history]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const selectedEntry = useMemo(
    () => history.find((entry) => entry.version === selectedVersion) ?? null,
    [history, selectedVersion],
  );

  const handleCompare = async () => {
    if (selectedLeft === null || selectedRight === null) return;
    setDiffLoading(true);
    setDiffResult(null);
    try {
      const result = await fetchJson<ScriptWorkspaceDiffResult>(
        `/books/${bookId}/script-workspace/diff?fromVersion=${selectedLeft}&toVersion=${selectedRight}`,
      );
      setDiffResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffLoading(false);
    }
  };

  const handleRollback = async (targetVersion: number) => {
    setRestoring(targetVersion);
    try {
      const result = await fetchJson<{ ok: boolean; workspace: ScriptWorkspace }>(
        `/books/${bookId}/script-workspace/rollback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion }),
        },
      );
      if (result.ok) {
        onRestore(result.workspace);
        onClose();
      }
    } finally {
      setRestoring(null);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === overlayRef.current) onClose();
      }}
    >
      <div className="w-[min(1160px,calc(100vw-2rem))] max-h-[88vh] overflow-hidden rounded-2xl border border-border/30 bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border/20 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">剧本版本历史</div>
            <div className="truncate text-[11px] text-muted-foreground">
              当前更新时间 · {formatDate(currentWorkspace.updatedAt)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-full border border-border/40 bg-background/60 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`rounded-full px-3 py-1.5 transition-colors ${viewMode === "list" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                全部版本
              </button>
              <button
                type="button"
                onClick={() => setViewMode("compare")}
                className={`rounded-full px-3 py-1.5 transition-colors ${viewMode === "compare" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                对比分析
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="max-h-[calc(88vh-58px)] overflow-y-auto p-4">
          {loading ? (
            <div className="py-16 text-center text-xs text-muted-foreground">加载中...</div>
          ) : error ? (
            <div className="py-16 text-center text-xs text-destructive">{error}</div>
          ) : history.length === 0 ? (
            <div className="py-16 text-center text-xs text-muted-foreground">暂无剧本版本记录</div>
          ) : viewMode === "compare" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr_auto]">
                <select
                  value={selectedLeft ?? ""}
                  onChange={(event) => setSelectedLeft(event.target.value ? Number(event.target.value) : null)}
                  className="h-9 rounded-md border border-border/40 bg-background px-2 text-xs outline-none"
                >
                  {history.map((entry) => (
                    <option key={`left-${entry.version}`} value={entry.version}>
                      v{entry.version} · {formatAction(entry.action)} · {formatDate(entry.savedAt)}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-center text-muted-foreground">
                  <GitCompare size={14} />
                </div>
                <select
                  value={selectedRight ?? ""}
                  onChange={(event) => setSelectedRight(event.target.value ? Number(event.target.value) : null)}
                  className="h-9 rounded-md border border-border/40 bg-background px-2 text-xs outline-none"
                >
                  {history.map((entry) => (
                    <option key={`right-${entry.version}`} value={entry.version}>
                      v{entry.version} · {formatAction(entry.action)} · {formatDate(entry.savedAt)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleCompare()}
                  disabled={selectedLeft === null || selectedRight === null || diffLoading}
                  className="inline-flex items-center justify-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50"
                >
                  <GitCompare size={10} />
                  {diffLoading ? "对比中..." : "对比"}
                </button>
              </div>

              {diffResult ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border/20 bg-card/40 p-3">
                    <div className="text-[11px] font-medium text-foreground">
                      v{diffResult.fromVersion} → v{diffResult.toVersion}
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      变化字段：{diffResult.changedFields.length > 0 ? diffResult.changedFields.map(formatChangedField).join("、") : "无"}
                    </div>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-2xl border border-border/20 bg-card/30 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-[11px] font-medium text-foreground">v{diffResult.fromVersion}</div>
                        <button
                          type="button"
                          onClick={() => void handleRollback(diffResult.fromVersion)}
                          disabled={restoring !== null}
                          className="inline-flex items-center gap-1 rounded-md border border-border/30 px-2 py-1 text-[10px] hover:bg-secondary/50 disabled:opacity-50"
                        >
                          <RotateCcw size={10} />
                          {restoring === diffResult.fromVersion ? "回滚中..." : "回滚到此版本"}
                        </button>
                      </div>
                      <WorkspaceSummary workspace={diffResult.from} />
                    </div>
                    <div className="rounded-2xl border border-border/20 bg-card/30 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-[11px] font-medium text-foreground">v{diffResult.toVersion}</div>
                        <button
                          type="button"
                          onClick={() => void handleRollback(diffResult.toVersion)}
                          disabled={restoring !== null}
                          className="inline-flex items-center gap-1 rounded-md border border-border/30 px-2 py-1 text-[10px] hover:bg-secondary/50 disabled:opacity-50"
                        >
                          <RotateCcw size={10} />
                          {restoring === diffResult.toVersion ? "回滚中..." : "回滚到此版本"}
                        </button>
                      </div>
                      <WorkspaceSummary workspace={diffResult.to} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border/20 bg-card/40 p-6 text-center text-xs text-muted-foreground">
                  选择两个版本后点击“对比”查看差异。
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
              <div className="space-y-2">
                {history.slice().reverse().map((entry) => (
                  <button
                    key={entry.version}
                    type="button"
                    onClick={() => setSelectedVersion(entry.version)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                      selectedVersion === entry.version
                        ? "border-primary/50 bg-primary/10 shadow-sm"
                        : "border-border/30 bg-card/60 hover:bg-secondary/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${entry.action === "current" ? "bg-emerald-500/10 text-emerald-700" : "bg-muted/40 text-muted-foreground"}`}>
                        v{entry.version} {entry.action === "current" ? "当前" : ""}
                      </span>
                      <span className="rounded-full bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {formatAction(entry.action)}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{formatDate(entry.savedAt)}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      章节 {entry.workspace.selectedChapterNumbers.join("、") || "无"} · {entry.workspace.episodes.length} 集
                    </div>
                  </button>
                ))}
              </div>

              <div className="min-w-0 rounded-2xl border border-border/20 bg-card/30 p-4">
                {selectedEntry ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                        v{selectedEntry.version}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{formatAction(selectedEntry.action)}</span>
                      <span className="text-[11px] text-muted-foreground">{formatDate(selectedEntry.savedAt)}</span>
                      {selectedEntry.action !== "current" ? (
                        <button
                          type="button"
                          onClick={() => void handleRollback(selectedEntry.version)}
                          disabled={restoring !== null}
                          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border/30 px-2 py-1 text-[10px] hover:bg-secondary/50 disabled:opacity-50"
                        >
                          <RotateCcw size={10} />
                          {restoring === selectedEntry.version ? "回滚中..." : "回滚到此版本"}
                        </button>
                      ) : null}
                    </div>
                    <WorkspaceSummary workspace={selectedEntry.workspace} />
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Eye size={10} />
                          视觉风格
                        </div>
                        <div className="mt-1 whitespace-pre-wrap text-[11px] text-foreground">{selectedEntry.workspace.config.visualStyle}</div>
                      </div>
                      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
                        <div className="text-[10px] text-muted-foreground">导演手法</div>
                        <div className="mt-1 whitespace-pre-wrap text-[11px] text-foreground">{selectedEntry.workspace.config.directorMethod}</div>
                      </div>
                      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
                        <div className="text-[10px] text-muted-foreground">剧本提示词</div>
                        <div className="mt-1 line-clamp-5 whitespace-pre-wrap text-[11px] text-foreground">{selectedEntry.workspace.config.scriptPrompts.script}</div>
                      </div>
                      <div className="rounded-xl border border-border/20 bg-background/60 px-3 py-2">
                        <div className="text-[10px] text-muted-foreground">图生视频提示词模板</div>
                        <div className="mt-1 line-clamp-5 whitespace-pre-wrap text-[11px] text-foreground">{selectedEntry.workspace.config.scriptPrompts.video}</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-[280px] items-center justify-center text-xs text-muted-foreground">
                    选择一个版本查看详情。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
