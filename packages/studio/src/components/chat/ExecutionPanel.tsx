import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import type { ToolExecution } from "../../store/chat/types";
import { ToolExecutionSteps } from "./ToolExecutionSteps";
import { resolveRunningStageProgress } from "./execution-stage-progress";
import { describeExecutionAutoReview } from "../../utils/auto-review-display";
import {
  Collapsible,
  CollapsibleContent,
} from "../ui/collapsible";

export interface ExecutionPanelProps {
  readonly executions: ReadonlyArray<ToolExecution>;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}

type PipelineExpandMode = "auto" | "expanded" | "collapsed";

function formatElapsedMs(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function buildExecutionPanelSummary(
  executions: ReadonlyArray<ToolExecution>,
  nowMs = Date.now(),
): {
  readonly total: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly elapsedMs: number;
  readonly activeStageLabel?: string;
  readonly activeStageProgressText?: string;
  readonly latestFailure?: string;
  readonly autoReviewMeta?: ReadonlyArray<string>;
} {
  let running = 0;
  let completed = 0;
  let failed = 0;
  let activeStageLabel: string | undefined;
  let activeStageProgressText: string | undefined;
  let latestFailure: string | undefined;
  let autoReviewMeta: ReadonlyArray<string> | undefined;
  let earliestStartedAt: number | undefined;
  let latestEndedAt: number | undefined;
  for (const execution of executions) {
    earliestStartedAt = earliestStartedAt === undefined
      ? execution.startedAt
      : Math.min(earliestStartedAt, execution.startedAt);
    const endedAt = (execution.status === "running" || execution.status === "processing")
      ? nowMs
      : (execution.completedAt ?? execution.startedAt);
    latestEndedAt = latestEndedAt === undefined
      ? endedAt
      : Math.max(latestEndedAt, endedAt);

    if (execution.status === "running" || execution.status === "processing") {
      running += 1;
      if (!activeStageLabel) {
        const stageProgress = resolveRunningStageProgress(execution);
        const autoReviewDisplay = describeExecutionAutoReview(execution.autoReview);
        const autoReviewProgressText = autoReviewDisplay?.compactText ?? null;
        activeStageLabel = autoReviewProgressText ?? stageProgress?.stageLabel ?? execution.label;
        activeStageProgressText = autoReviewProgressText ?? stageProgress?.progressText ?? undefined;
        autoReviewMeta = autoReviewDisplay?.meta;
      }
    } else if (execution.status === "error") {
      failed += 1;
      if (!latestFailure) {
        latestFailure = execution.error?.trim() || execution.result?.trim() || execution.label;
      }
    } else {
      completed += 1;
    }
  }
  return {
    total: executions.length,
    running,
    completed,
    failed,
    elapsedMs: earliestStartedAt === undefined || latestEndedAt === undefined
      ? 0
      : Math.max(0, latestEndedAt - earliestStartedAt),
    ...(activeStageLabel ? { activeStageLabel } : {}),
    ...(activeStageProgressText ? { activeStageProgressText } : {}),
    ...(latestFailure ? { latestFailure } : {}),
    ...(autoReviewMeta && autoReviewMeta.length > 0 ? { autoReviewMeta } : {}),
  };
}

export function ExecutionPanel({
  executions,
  collapsed,
  onCollapsedChange,
}: ExecutionPanelProps) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [pipelineExpandMode, setPipelineExpandMode] = useState<PipelineExpandMode>("auto");
  const hasRunning = executions.some((execution) => execution.status === "running" || execution.status === "processing");
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);
  const summary = useMemo(() => buildExecutionPanelSummary(executions, nowTick), [executions, nowTick]);
  const isRunning = summary.running > 0;
  const runningStageText = summary.activeStageProgressText ?? summary.activeStageLabel ?? "执行中";
  const compactStatus = isRunning
    ? `执行中：${runningStageText} · 耗时 ${formatElapsedMs(summary.elapsedMs)}`
    : summary.failed > 0
      ? `有 ${summary.failed} 项失败 · 耗时 ${formatElapsedMs(summary.elapsedMs)}`
      : `全部已完成 · 耗时 ${formatElapsedMs(summary.elapsedMs)}`;

  return (
    <Collapsible
      open={!collapsed}
      className="rounded-xl border border-slate-700/70 bg-slate-950/80 text-slate-100 shadow-[0_8px_28px_rgba(2,6,23,0.45)] backdrop-blur-sm"
    >
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        className="w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-slate-900/70"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded border border-cyan-400/40 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-cyan-200">
              执行阶段面板
            </span>
            {collapsed && (
              <span className="min-w-0 truncate text-xs text-slate-300">
                {compactStatus}
              </span>
            )}
            {!collapsed && isRunning && (
              <span className="inline-flex items-center gap-1 text-xs text-cyan-300">
                <Loader2 size={12} className="animate-spin" />
                {runningStageText}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0 whitespace-nowrap">
            {!collapsed && (
              <span className="hidden items-center gap-1 rounded-md border border-slate-700/80 bg-slate-900/70 px-2 py-0.5 text-xs text-slate-300 sm:inline-flex">
                耗时 {formatElapsedMs(summary.elapsedMs)}
              </span>
            )}
            {!collapsed && (
              <span className="hidden items-center gap-1 rounded-md border border-slate-700/80 bg-slate-900/70 px-2 py-0.5 text-xs text-slate-300 sm:inline-flex">
                总计 {summary.total}
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-700/70 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-200">
              完成 {summary.completed}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-rose-700/70 bg-rose-950/40 px-2 py-0.5 text-xs text-rose-200">
              失败 {summary.failed}
            </span>
          </div>
          <ChevronDown
            size={14}
            className={`shrink-0 text-slate-400 transition-transform ${collapsed ? "" : "rotate-180"}`}
          />
        </div>
      </button>
      <CollapsibleContent className="px-2 pb-2">
        {(summary.activeStageLabel || summary.latestFailure) && (
          <div className="mb-2 rounded-lg border border-slate-700/70 bg-slate-900/70 px-3 py-2 text-xs">
            {summary.activeStageLabel && (
              <div className="text-slate-300">
                当前步骤：
                <span className="text-slate-100">
                  {summary.activeStageProgressText ?? summary.activeStageLabel}
                </span>
              </div>
            )}
            {summary.latestFailure && (
              <div className="mt-1 text-rose-300">
                最近失败：{summary.latestFailure}
              </div>
            )}
            {summary.autoReviewMeta && summary.autoReviewMeta.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {summary.autoReviewMeta.map((item) => (
                  <span
                    key={item}
                    className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-200"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="mb-2 flex items-center justify-end gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => setPipelineExpandMode("expanded")}
            className={`rounded border px-2 py-1 transition-colors ${
              pipelineExpandMode === "expanded"
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                : "border-slate-700/70 bg-slate-900/50 text-slate-300 hover:bg-slate-900/80"
            }`}
          >
            全部展开
          </button>
          <button
            type="button"
            onClick={() => setPipelineExpandMode("collapsed")}
            className={`rounded border px-2 py-1 transition-colors ${
              pipelineExpandMode === "collapsed"
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                : "border-slate-700/70 bg-slate-900/50 text-slate-300 hover:bg-slate-900/80"
            }`}
          >
            全部折叠
          </button>
          <button
            type="button"
            onClick={() => setPipelineExpandMode("auto")}
            className={`rounded border px-2 py-1 transition-colors ${
              pipelineExpandMode === "auto"
                ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                : "border-slate-700/70 bg-slate-900/50 text-slate-300 hover:bg-slate-900/80"
            }`}
          >
            自动
          </button>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-1 py-1">
          <ToolExecutionSteps executions={[...executions]} pipelineExpandMode={pipelineExpandMode} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
