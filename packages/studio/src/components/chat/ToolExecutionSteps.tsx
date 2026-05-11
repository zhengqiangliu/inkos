import { useMemo, useState, useEffect } from "react";
import type { ToolExecution, PipelineStage } from "../../store/chat/types";
import { resolveRunningStageProgress } from "./execution-stage-progress";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/collapsible";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Wrench,
} from "lucide-react";
import { describeExecutionAutoReview } from "../../utils/auto-review-display";

const LOGS_OPEN_STORAGE_PREFIX = "studio.execution.logs-open.";

function readLogsOpenFromStorage(executionId: string, fallback = false): boolean {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(`${LOGS_OPEN_STORAGE_PREFIX}${executionId}`);
  if (value === "1") return true;
  if (value === "0") return false;
  return fallback;
}

// -- Status rendering helpers --

function ExecStatusBadge({ status }: { status: ToolExecution["status"] }) {
  switch (status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-primary">
          <Loader2 size={12} className="animate-spin" />
          <span>执行中</span>
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" style={{ animationDuration: "2s" }} />
          <span>处理结果</span>
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <CheckCircle2 size={12} />
          <span>已完成</span>
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <XCircle size={12} />
          <span>失败</span>
        </span>
      );
  }
}

function StageIcon({ status }: { status: PipelineStage["status"] }) {
  switch (status) {
    case "pending":
      return <span className="w-4 h-4 rounded-full border border-border/60 flex items-center justify-center shrink-0 text-[8px] text-muted-foreground/40">○</span>;
    case "active":
      return <Loader2 size={14} className="text-primary animate-spin shrink-0" />;
    case "completed":
      return <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" />;
  }
}

function formatProgress(progress: NonNullable<PipelineStage["progress"]>): string {
  const statusLabel = progress.status === "thinking" ? "思考中" : "";
  const chars = progress.totalChars > 0
    ? progress.chineseChars > 0 ? `${progress.totalChars}字` : `${progress.totalChars} chars`
    : "";
  const parts = [statusLabel, chars].filter(Boolean);
  return parts.join(" · ") || "进行中";
}

function formatElapsedMs(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function suppressStageElapsedHint(label: string): boolean {
  return /生成最终真相文件|rebuilding final truth files/i.test(label);
}

function isHeartbeatLog(line: string): boolean {
  return /（进行中\s*\d+s）|\(\d+s elapsed\)/i.test(line);
}

const STAGE_DURATION_HINTS: ReadonlyArray<{ pattern: RegExp; ms: number }> = [
  { pattern: /准备章节输入|preparing chapter inputs/i, ms: 20_000 },
  { pattern: /撰写章节草稿|writing chapter draft/i, ms: 120_000 },
  { pattern: /落盘最终章节|persisting final chapter/i, ms: 10_000 },
  { pattern: /生成最终真相文件|rebuilding final truth files/i, ms: 45_000 },
  { pattern: /校验真相文件变更|validating truth file updates/i, ms: 30_000 },
  { pattern: /同步记忆索引|syncing memory indexes/i, ms: 20_000 },
  { pattern: /更新章节索引与快照|updating chapter index and snapshots/i, ms: 12_000 },
];

function estimateStageDurationMs(label: string): number {
  for (const hint of STAGE_DURATION_HINTS) {
    if (hint.pattern.test(label)) return hint.ms;
  }
  return 20_000;
}

function estimateRemainingMs(exec: ToolExecution, elapsedMs: number): number | null {
  const stages = exec.stages;
  if (!stages || stages.length === 0) return null;
  const now = Date.now();
  let remaining = 0;
  for (const stage of stages) {
    const stageBudgetMs = estimateStageDurationMs(stage.label);
    if (stage.status === "completed") {
      continue;
    }
    if (stage.status === "pending") {
      remaining += stageBudgetMs;
      continue;
    }
    const stageElapsed = stage.progress?.elapsedMs
      ?? (stage.activatedAt ? Math.max(0, now - stage.activatedAt) : elapsedMs);
    remaining += Math.max(0, stageBudgetMs - stageElapsed);
  }
  return remaining;
}

// -- Live elapsed timer hook --

function useElapsedTimer(startedAt: number, active: boolean): number {
  const [elapsed, setElapsed] = useState(() => active ? Date.now() - startedAt : 0);
  useEffect(() => {
    if (!active) return;
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt, active]);
  return elapsed;
}

type PipelineExpandMode = "auto" | "expanded" | "collapsed";

function PipelineExecutionItem({
  exec,
  pipelineExpandMode,
}: {
  exec: ToolExecution;
  pipelineExpandMode: PipelineExpandMode;
}) {
  const isActive = exec.status === "running" || exec.status === "processing";
  const autoOpenDefault = isActive || exec.status === "error";
  const controlledOpen = pipelineExpandMode === "expanded"
    ? true
    : pipelineExpandMode === "collapsed"
      ? false
      : undefined;
  const [autoOpen, setAutoOpen] = useState(autoOpenDefault);

  useEffect(() => {
    if (pipelineExpandMode !== "auto") return;
    if (exec.status === "running" || exec.status === "error") {
      setAutoOpen(true);
      return;
    }
    if (exec.status === "completed") {
      setAutoOpen(false);
    }
  }, [exec.status, pipelineExpandMode]);

  if (controlledOpen === undefined) {
    return (
      <PipelineExecutionAuto exec={exec} open={autoOpen} onOpenChange={setAutoOpen} />
    );
  }
  return (
    <PipelineExecutionAuto exec={exec} open={controlledOpen} onOpenChange={() => { /* controlled by panel mode */ }} />
  );
}

function PipelineExecutionAuto({
  exec,
  open,
  onOpenChange,
}: {
  exec: ToolExecution;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isActive = exec.status === "running" || exec.status === "processing";
  const [logsOpen, setLogsOpen] = useState(() => readLogsOpenFromStorage(exec.id, false));
  const elapsedMs = useElapsedTimer(exec.startedAt, isActive);
  const totalElapsedMs = isActive
    ? elapsedMs
    : Math.max(0, (exec.completedAt ?? exec.startedAt) - exec.startedAt);
  const etaMs = isActive ? estimateRemainingMs(exec, elapsedMs) : 0;
  const stageProgress = resolveRunningStageProgress(exec);
  const activeStageLabel = stageProgress?.stageLabel;
  const activeStageStatus = stageProgress?.stageStatus;
  const autoReviewDisplay = describeExecutionAutoReview(exec.autoReview);
  const bookId = exec.args?.bookId as string | undefined;
  const visibleLogs = useMemo(
    () => (exec.logs ?? []).filter((line) => !isHeartbeatLog(line)),
    [exec.logs],
  );
  const logPreview = visibleLogs.slice(-2);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(`${LOGS_OPEN_STORAGE_PREFIX}${exec.id}`, logsOpen ? "1" : "0");
  }, [exec.id, logsOpen]);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="rounded-xl border border-border/40 bg-card/60">
      <CollapsibleTrigger className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-card/80 transition-colors cursor-pointer">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {exec.label}
            {bookId && <span className="text-muted-foreground font-normal"> · {bookId}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
            <span>{formatElapsedMs(totalElapsedMs)}</span>
            {isActive && etaMs !== null && <span>预计剩余 {formatElapsedMs(etaMs)}</span>}
          </div>
          <ExecStatusBadge status={exec.status} />
          <ChevronDown size={14} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1">
          {exec.stages && exec.stages.length > 0 && (
            <div className="mb-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                阶段进度
              </div>
              <ul className="space-y-1">
                {exec.stages.map((stage, index) => {
                  const hasWordCount = stage.progress && stage.progress.totalChars > 0;
                  const showWordCount = hasWordCount && (
                    stage.status === "active"
                    || (/^(撰写章节草稿|落盘最终章节)/.test(stage.label))
                  );
                  return (
                    <li key={`${exec.id}-stage-${index}`} className="flex items-start justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <StageIcon status={stage.status} />
                        <span className="truncate text-foreground/90">{stage.label}</span>
                      </div>
                      {showWordCount && (
                        <span className={`shrink-0 text-[11px] ${stage.status === "active" ? "text-primary/90" : "text-muted-foreground/70"}`}>
                          {stage.status === "active"
                            ? formatProgress(stage.progress!)
                            : stage.progress!.chineseChars > 0 ? `${stage.progress!.totalChars}字` : `${stage.progress!.totalChars} chars`}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {activeStageLabel && isActive && etaMs !== null && activeStageStatus === "active" && !suppressStageElapsedHint(activeStageLabel) && (
                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  当前阶段：{stageProgress.progressText} · 预计剩余 {formatElapsedMs(etaMs)}
                </div>
              )}
            </div>
          )}
          {autoReviewDisplay && (
            <div className="mb-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wider text-sky-700/90 dark:text-sky-300/90 mb-0.5">
                自动审计闭环
              </div>
              <div className="text-xs text-sky-700 dark:text-sky-300">
                {autoReviewDisplay.text}
              </div>
              {autoReviewDisplay.meta && autoReviewDisplay.meta.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {autoReviewDisplay.meta.map((item) => (
                    <span
                      key={item}
                      className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-300"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {exec.batch && (
            <div className="mb-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold text-foreground/90">
                  连写进度 {Math.min(exec.batch.completed, exec.batch.total)}/{exec.batch.total}
                </span>
                <span
                  className={`font-medium ${
                    exec.batch.status === "failed"
                      ? "text-destructive"
                      : exec.batch.status === "completed"
                        ? "text-green-600 dark:text-green-400"
                        : "text-primary"
                  }`}
                >
                  {exec.batch.status === "failed" ? "失败" : exec.batch.status === "completed" ? "已完成" : "进行中"}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-secondary/70 overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    exec.batch.status === "failed"
                      ? "bg-destructive"
                      : exec.batch.status === "completed"
                        ? "bg-green-600 dark:bg-green-400"
                        : "bg-primary"
                  }`}
                  style={{
                    width: `${Math.max(0, Math.min(100, (exec.batch.completed / Math.max(1, exec.batch.total)) * 100))}%`,
                  }}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>耗时 {formatElapsedMs(exec.batch.elapsedMs)}</span>
                {typeof exec.batch.currentChapter === "number" && <span>当前章 {exec.batch.currentChapter}</span>}
                {typeof exec.batch.failedChapterNumber === "number" && <span>失败章 {exec.batch.failedChapterNumber}</span>}
              </div>
              {exec.batch.status === "failed" && exec.batch.error && (
                <div className="mt-1 text-[11px] text-destructive break-words">
                  {exec.batch.error}
                </div>
              )}
            </div>
          )}
          {visibleLogs.length > 0 && (
            <Collapsible open={logsOpen} onOpenChange={setLogsOpen} className="mb-2 rounded-lg border border-border/40 bg-background/40">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    运行日志 ({visibleLogs.length})
                  </div>
                  {!logsOpen && logPreview.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {logPreview.map((line, i) => (
                        <div key={i} className="truncate text-xs font-mono text-muted-foreground">
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <ChevronDown size={14} className={`shrink-0 text-muted-foreground transition-transform ${logsOpen ? "rotate-180" : ""}`} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="space-y-0.5 px-2.5 pb-2">
                  {visibleLogs.map((log, i) => {
                    const isError = log.startsWith("[error]") || /error/i.test(log);
                    const isWarn = log.startsWith("[warning]") || /warning|警告/i.test(log);
                    return (
                      <li key={i} className={`text-xs font-mono break-words ${isError ? "text-destructive" : isWarn ? "text-yellow-600 dark:text-yellow-400" : "text-muted-foreground"}`}>
                        {log}
                      </li>
                    );
                  })}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
          {exec.status === "completed" && exec.result && (
            <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-xs text-emerald-700 dark:text-emerald-300 break-words">
              {exec.result}
            </div>
          )}
          {exec.status === "error" && exec.error && (
            <div className="mt-2 text-xs text-destructive bg-destructive/5 rounded-lg px-2.5 py-2">
              {exec.error}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Utility tools (read/edit/grep/ls) grouped --

function UtilityToolsGroup({ execs }: { execs: ToolExecution[] }) {
  const [open, setOpen] = useState(false);
  const allDone = execs.every(e => e.status === "completed" || e.status === "error");
  const hasError = execs.some(e => e.status === "error");

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer text-xs text-muted-foreground">
        <Wrench size={12} />
        <span>{execs.length} 个文件操作</span>
        {allDone && !hasError && <CheckCircle2 size={10} className="text-green-600 dark:text-green-400" />}
        {hasError && <XCircle size={10} className="text-destructive" />}
        {!allDone && <Loader2 size={10} className="animate-spin text-primary" />}
        <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="pl-6 space-y-0.5 py-1">
          {execs.map((exec) => (
            <li key={exec.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono truncate">{exec.tool} {String(exec.args?.path ?? exec.args?.pattern ?? "")}</span>
              {exec.status === "completed" && <CheckCircle2 size={10} className="text-green-600 dark:text-green-400 shrink-0" />}
              {exec.status === "error" && <XCircle size={10} className="text-destructive shrink-0" />}
              {(exec.status === "running" || exec.status === "processing") && <Loader2 size={10} className="animate-spin text-primary shrink-0" />}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Main component --

export interface ToolExecutionStepsProps {
  executions: ToolExecution[];
  pipelineExpandMode?: PipelineExpandMode;
}

/**
 * Group executions chronologically: pipeline ops render individually,
 * consecutive utility tools are merged into a single collapsed group.
 */
type RenderGroup =
  | { type: "pipeline"; exec: ToolExecution }
  | { type: "utilities"; execs: ToolExecution[] };

export function groupChronologically(executions: ToolExecution[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let utilBuf: ToolExecution[] = [];

  const flushUtils = () => {
    if (utilBuf.length > 0) {
      groups.push({ type: "utilities", execs: utilBuf });
      utilBuf = [];
    }
  };

  for (const exec of executions) {
    if (exec.tool === "sub_agent") {
      flushUtils();
      groups.push({ type: "pipeline", exec });
    } else {
      utilBuf.push(exec);
    }
  }
  flushUtils();
  return groups;
}

export function ToolExecutionSteps({
  executions,
  pipelineExpandMode = "auto",
}: ToolExecutionStepsProps) {
  const groups = useMemo(() => groupChronologically(executions), [executions]);

  return (
    <div className="space-y-2 mt-2">
      {groups.map((g, i) =>
        g.type === "pipeline"
          ? <PipelineExecutionItem key={g.exec.id} exec={g.exec} pipelineExpandMode={pipelineExpandMode} />
          : <UtilityToolsGroup key={`utils-${i}`} execs={g.execs} />
      )}
    </div>
  );
}
