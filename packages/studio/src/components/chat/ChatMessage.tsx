import type { Theme } from "../../hooks/use-theme";
import { cn } from "../../lib/utils";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { BookFormCard } from "./BookFormCard";
import type { BookFormArgs } from "./BookFormCard";
import {
  XCircle,
} from "lucide-react";
import type { MessageAuditSummary } from "../../store/chat/types";

type AuditSeverity = "critical" | "warning" | "info";

interface AuditIssueItem {
  readonly severity: AuditSeverity;
  readonly text: string;
}

interface ParsedAuditReport {
  readonly statusLine: string;
  readonly scoreLine?: string;
  readonly failureReason?: string;
  readonly summary?: string;
  readonly issues: ReadonlyArray<AuditIssueItem>;
  readonly dimensionChecks?: ReadonlyArray<{
    dimension: string;
    status: "pass" | "warning" | "failed";
    evidence?: string;
  }>;
}

function normalizeAuditSeverity(raw: string): AuditSeverity {
  const value = raw.trim().toLowerCase();
  if (value === "critical" || value === "error" || value === "严重" || value === "高危") {
    return "critical";
  }
  if (value === "warning" || value === "warn" || value === "警告" || value === "中危") {
    return "warning";
  }
  return "info";
}

function parseAuditIssueLine(rawLine: string): AuditIssueItem | null {
  const line = rawLine.trim().replace(/^\d+\.\s*/, "").replace(/^-\s*/, "");
  if (!line) return null;
  const severityMatch = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!severityMatch?.[1]) {
    return { severity: "info", text: line };
  }
  const severity = normalizeAuditSeverity(severityMatch[1]);
  const text = (severityMatch[2] ?? "").trim();
  if (!text) return null;
  return { severity, text };
}

function parseAuditReport(content: string): ParsedAuditReport | null {
  if (
    !content.includes("审计评分")
    && !content.includes("审计得分")
    && !content.includes("评分")
    && !content.includes("审计报告")
    && !content.includes("问题清单")
  ) return null;
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const issueHeaderIndex = lines.findIndex((line) => /^问题清单[:：]?$/i.test(line.trim()));

  const statusLine = lines[0]?.trim() ?? "";
  const scoreLine = lines.find((line) =>
    /^审计评分[:：]\s*/.test(line.trim())
    || /^审计得分[:：]\s*/.test(line.trim())
    || /^评分[:：]\s*\d+\s*\/\s*100/.test(line.trim())
    || /^审计报告[:：]\s*评分/i.test(line.trim()),
  );
  const inlineScoreMatch = content.match(/(?:审计评分|审计得分|评分)[:：]\s*([0-9]{1,3}\s*\/\s*100(?:（[^）]*）)?)/i);
  const summaryLine = lines.find((line) => {
    const normalized = line.trim();
    if (/^审计摘要[:：]\s*/.test(normalized)) return true;
    if (!/^审计报告[:：]\s*/.test(normalized)) return false;
    return !/^审计报告[:：]\s*评分/i.test(normalized);
  });
  const summary = summaryLine
    ?.replace(/^审计报告[:：]\s*/, "")
    .replace(/^审计摘要[:：]\s*/, "")
    .trim() || undefined;

  const issues: AuditIssueItem[] = [];
  if (issueHeaderIndex >= 0) {
    let groupSeverity: AuditSeverity | null = null;
    for (let i = issueHeaderIndex + 1; i < lines.length; i += 1) {
      const current = (lines[i] ?? "").trim();
      if (/^严重[:：]?$/i.test(current)) {
        groupSeverity = "critical";
        continue;
      }
      if (/^警告[:：]?$/i.test(current)) {
        groupSeverity = "warning";
        continue;
      }
      if (/^提示[:：]?$/i.test(current)) {
        groupSeverity = "info";
        continue;
      }
      const parsed = parseAuditIssueLine(current);
      if (!parsed) continue;
      const hasExplicitSeverity = /^\d+\.\s*\[[^\]]+\]/.test(current)
        || /^-\s*\[[^\]]+\]/.test(current)
        || /^\[[^\]]+\]/.test(current);
      issues.push(!hasExplicitSeverity && groupSeverity ? { ...parsed, severity: groupSeverity } : parsed);
    }
  }
  if (!statusLine) return null;
  if (!scoreLine && !summary && issueHeaderIndex < 0) return null;

  const sortedIssues = [...issues].sort((left, right) => {
    const rank = (severity: AuditSeverity): number => {
      if (severity === "critical") return 0;
      if (severity === "warning") return 1;
      return 2;
    };
    return rank(left.severity) - rank(right.severity);
  });

  return {
    statusLine,
    scoreLine: scoreLine
      ?.replace(/^审计评分[:：]\s*/, "")
      .replace(/^审计得分[:：]\s*/, "")
      .replace(/^评分[:：]\s*/, "")
      .replace(/^审计报告[:：]\s*评分/i, "")
      .trim()
      || inlineScoreMatch?.[1]?.trim()
      || undefined,
    summary,
    issues: sortedIssues,
  };
}

function parseAuditIssueTexts(rawIssues: ReadonlyArray<string> | undefined): ReadonlyArray<AuditIssueItem> {
  if (!rawIssues || rawIssues.length === 0) return [];
  return rawIssues
    .map((issue) => parseAuditIssueLine(issue))
    .filter((issue): issue is AuditIssueItem => issue !== null)
    .sort((left, right) => {
      const rank = (severity: AuditSeverity): number => {
        if (severity === "critical") return 0;
        if (severity === "warning") return 1;
        return 2;
      };
      return rank(left.severity) - rank(right.severity);
    });
}

function formatStructuredScoreLine(audit: MessageAuditSummary): string {
  if (audit.severityCounts) {
    return `${audit.score}/100（严重 ${audit.severityCounts.critical} / 警告 ${audit.severityCounts.warning} / 提示 ${audit.severityCounts.info}）`;
  }
  return `${audit.score}/100`;
}

function buildAuditReportFromStructuredAudit(audit: MessageAuditSummary): ParsedAuditReport {
  const statusLine = audit.passed
    ? `第${audit.chapter}章审计通过。`
    : `第${audit.chapter}章审计未通过，共${audit.issueCount}项问题。`;
  const failureReason = !audit.passed
    ? audit.failureGate === "score"
      ? "score gate 未通过"
      : audit.failureGate === "critical"
        ? "critical 问题门禁未通过"
        : undefined
    : undefined;
  return {
    statusLine,
    scoreLine: formatStructuredScoreLine(audit),
    failureReason,
    summary: audit.summary,
    issues: parseAuditIssueTexts(audit.issues),
    ...(audit.dimensionChecks && audit.dimensionChecks.length > 0
      ? { dimensionChecks: audit.dimensionChecks }
      : {}),
  };
}

function severityMeta(severity: AuditSeverity): { badge: string; text: string; dot: string; label: string } {
  if (severity === "critical") {
    return {
      badge: "bg-red-500/10 text-red-600 border-red-500/30",
      text: "text-red-700 dark:text-red-300",
      dot: "bg-red-500",
      label: "严重",
    };
  }
  if (severity === "warning") {
    return {
      badge: "bg-amber-500/10 text-amber-600 border-amber-500/30",
      text: "text-amber-700 dark:text-amber-300",
      dot: "bg-amber-500",
      label: "警告",
    };
  }
  return {
    badge: "bg-sky-500/10 text-sky-600 border-sky-500/30",
    text: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
    label: "提示",
  };
}

export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ChatMessageProps {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly theme: Theme;
  readonly audit?: MessageAuditSummary;
  readonly toolCall?: ToolCall;
  readonly onArgsChange?: (args: Record<string, unknown>) => void;
  readonly onConfirm?: () => void;
  readonly confirming?: boolean;
  readonly onQuickCommand?: (command: string) => void;
}

function extractRepairCommand(content: string): string | null {
  const zh = content.match(/(?:可执行修复[:：]\s*)?(修复(?:第\s*\d+\s*章|最新章节)落库和索引)[。.]?/i);
  if (zh?.[1]) return zh[1].replace(/\s+/g, "");
  const en = content.match(/(repair\s+(?:chapter\s*\d+|latest chapter)\s+persistence\s+and\s+index)\.?/i);
  if (en?.[1]) return en[1].trim();
  return null;
}

export function ChatMessage({
  role,
  content,
  timestamp: _timestamp,
  theme,
  audit,
  toolCall,
  onArgsChange,
  onConfirm,
  confirming,
  onQuickCommand,
}: ChatMessageProps) {
  const isUser = role === "user";
  const isError = content.startsWith("\u2717");
  const parsedAuditReport = role === "assistant"
    ? (audit ? buildAuditReportFromStructuredAudit(audit) : parseAuditReport(content))
    : null;
  const groupedAuditIssues = parsedAuditReport
    ? {
        critical: parsedAuditReport.issues.filter((issue) => issue.severity === "critical"),
        warning: parsedAuditReport.issues.filter((issue) => issue.severity === "warning"),
        info: parsedAuditReport.issues.filter((issue) => issue.severity === "info"),
      }
    : null;
  const repairCommand = role === "assistant" ? extractRepairCommand(content) : null;
  const canQuickRepair = Boolean(repairCommand && onQuickCommand);

  const hasBookForm = toolCall?.name === "create_book" && onArgsChange && onConfirm;

  return (
    <Message from={role}>
      <MessageContent>
        {isUser ? (
          <div className="text-sm leading-relaxed">{content}</div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <XCircle size={14} className="shrink-0" />
            <span>{content.replace(/^\u2717\s*/, "")}</span>
          </div>
        ) : parsedAuditReport ? (
          <div className="w-full min-w-0 space-y-2 rounded-xl border border-border/50 bg-card/40 p-3">
            <div className="text-sm font-medium text-foreground">{parsedAuditReport.statusLine}</div>
            {parsedAuditReport.scoreLine && (
              <div className="text-xs text-muted-foreground">审计评分：{parsedAuditReport.scoreLine}</div>
            )}
            {parsedAuditReport.failureReason && (
              <div className="text-xs text-muted-foreground">失败原因：{parsedAuditReport.failureReason}</div>
            )}
            {parsedAuditReport.summary && (
              <div className="text-xs text-muted-foreground">
                审计报告：{parsedAuditReport.summary}
              </div>
            )}
            {parsedAuditReport.dimensionChecks && parsedAuditReport.dimensionChecks.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">维度核查：</div>
                <ul className="space-y-1">
                  {parsedAuditReport.dimensionChecks.map((item, index) => {
                    const statusText = item.status === "pass" ? "通过" : item.status === "warning" ? "警告" : "失败";
                    const statusClass = item.status === "pass"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : item.status === "warning"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-destructive";
                    return (
                      <li key={`dimension-${index}`} className="text-xs leading-5 text-muted-foreground">
                        <span className={cn("font-medium", statusClass)}>[{statusText}]</span>
                        {" "}
                        <span className="text-foreground/90">{item.dimension}</span>
                        {item.evidence ? <span>：{item.evidence}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {parsedAuditReport.issues.length === 0 ? (
              <div className="text-xs text-muted-foreground">问题清单：无</div>
            ) : (
              <div className="space-y-2">
                {(["critical", "warning", "info"] as const).map((severityKey) => {
                  const items = groupedAuditIssues?.[severityKey] ?? [];
                  if (items.length === 0) return null;
                  const meta = severityMeta(severityKey);
                  return (
                    <section key={severityKey} className="space-y-1.5">
                      <div className={cn("text-xs font-medium", meta.text)}>{meta.label}</div>
                      <ul className="space-y-1.5">
                        {items.map((issue, index) => (
                          <li key={`${severityKey}-${index}`} className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-2">
                            <span className={cn("mt-1 inline-block h-1.5 w-1.5 rounded-full shrink-0", meta.dot)} />
                            <div className="min-w-0 flex-1 space-y-1">
                              <span className={cn("inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium", meta.badge)}>
                                {meta.label}
                              </span>
                              <div className={cn("text-xs leading-5 break-words", meta.text)}>
                                {issue.text}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <MessageResponse>{content}</MessageResponse>
            {canQuickRepair && (
              <button
                type="button"
                onClick={() => onQuickCommand?.(repairCommand!)}
                className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/15 transition-colors"
              >
                一键修复
              </button>
            )}
          </div>
        )}
      </MessageContent>

      {hasBookForm && (
        <BookFormCard
          args={toolCall.arguments as BookFormArgs}
          onArgsChange={(a) => onArgsChange(a as Record<string, unknown>)}
          onConfirm={onConfirm}
          confirming={confirming ?? false}
          theme={theme}
        />
      )}
    </Message>
  );
}
