import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChapterAuditReport } from "../../shared/contracts";
import { AlertTriangle, GitCompare, X } from "lucide-react";

export interface ChapterAuditVersion extends ChapterAuditReport {
  readonly version: number;
}

interface ChapterAuditHistoryModalProps {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly history: ReadonlyArray<ChapterAuditReport>;
  readonly onClose: () => void;
}

interface AuditDiff {
  readonly left: ChapterAuditVersion;
  readonly right: ChapterAuditVersion;
  readonly changedFields: ReadonlyArray<string>;
}

const AUDIT_FIELDS = ["passed", "score", "issueCount", "summary", "report", "severityCounts", "failureGate", "issues"] as const;

export function buildChapterAuditVersions(history: ReadonlyArray<ChapterAuditReport>): ChapterAuditVersion[] {
  return history.map((entry, index) => ({
    ...entry,
    version: index + 1,
  }));
}

export function compareChapterAuditVersions(left: ChapterAuditVersion, right: ChapterAuditVersion): AuditDiff {
  const changedFields = AUDIT_FIELDS.filter((field) => {
    const leftValue = normalizeComparableAuditValue(left[field]);
    const rightValue = normalizeComparableAuditValue(right[field]);
    return leftValue !== rightValue;
  });
  return { left, right, changedFields };
}

function normalizeComparableAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatAuditDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSeverityCounts(value: ChapterAuditVersion["severityCounts"]): string | null {
  if (!value) return null;
  return `严重 ${value.critical} / 警告 ${value.warning} / 提示 ${value.info}`;
}

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function AuditFieldRow({ label, value, multiline = false }: { label: string; value: unknown; multiline?: boolean }) {
  const text = formatAuditValue(value);
  return (
    <div className="rounded-lg border border-border/20 bg-background/60 px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-[11px] ${multiline || text.includes("\n") ? "whitespace-pre-wrap" : "truncate"}`}>
        {text}
      </div>
    </div>
  );
}

function AuditVersionCard({
  version,
  selected,
  onSelect,
}: {
  version: ChapterAuditVersion;
  selected: boolean;
  onSelect: () => void;
}) {
  const severityText = formatSeverityCounts(version.severityCounts);
  const reportText = version.report?.trim() || version.summary?.trim() || "";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-primary/50 bg-primary/10 shadow-sm"
          : "border-border/30 bg-card/60 hover:bg-secondary/50"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${version.passed ? "bg-emerald-500/10 text-emerald-700" : "bg-red-500/10 text-red-700"}`}>
          v{version.version} {version.passed ? "通过" : "未通过"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatAuditDate(version.auditedAt)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span>评分 {version.score}</span>
        <span>问题 {version.issueCount}</span>
        {version.failureGate && <span>门禁 {version.failureGate}</span>}
        {severityText && <span>{severityText}</span>}
      </div>
      {reportText && (
        <div className="mt-1 truncate text-[10px] text-foreground/80" title={reportText}>
          {reportText}
        </div>
      )}
    </button>
  );
}

export function ChapterAuditHistoryModal({
  chapterNumber,
  chapterTitle,
  history,
  onClose,
}: ChapterAuditHistoryModalProps) {
  const versions = useMemo(() => buildChapterAuditVersions(history), [history]);
  const [viewMode, setViewMode] = useState<"list" | "compare">("list");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [compareLeft, setCompareLeft] = useState<number | null>(null);
  const [compareRight, setCompareRight] = useState<number | null>(null);
  const [selectedVersionDetail, setSelectedVersionDetail] = useState<ChapterAuditVersion | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (versions.length === 0) {
      setSelectedVersion(null);
      setCompareLeft(null);
      setCompareRight(null);
      setSelectedVersionDetail(null);
      return;
    }
    const latest = versions[versions.length - 1]!;
    setSelectedVersion((current) => (versions.some((item) => item.version === current) ? current : latest.version));
    setCompareLeft((current) => (versions.some((item) => item.version === current) ? current : versions[0]!.version));
    setCompareRight((current) => (versions.some((item) => item.version === current) ? current : latest.version));
  }, [versions]);

  useEffect(() => {
    if (selectedVersion === null) {
      setSelectedVersionDetail(null);
      return;
    }
    const hit = versions.find((item) => item.version === selectedVersion) ?? null;
    setSelectedVersionDetail(hit);
  }, [selectedVersion, versions]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const diff = useMemo<AuditDiff | null>(() => {
    if (compareLeft === null || compareRight === null || compareLeft === compareRight) return null;
    const left = versions.find((item) => item.version === compareLeft) ?? null;
    const right = versions.find((item) => item.version === compareRight) ?? null;
    if (!left || !right) return null;
    return compareChapterAuditVersions(left, right);
  }, [compareLeft, compareRight, versions]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === overlayRef.current) onClose();
      }}
    >
      <div className="w-[min(1120px,calc(100vw-2rem))] max-h-[88vh] overflow-hidden rounded-2xl border border-border/30 bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border/20 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">章节审计历史</div>
            <div className="truncate text-[11px] text-muted-foreground">
              第 {chapterNumber} 章 · {chapterTitle}
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
          {versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <AlertTriangle size={18} />
              <p className="text-xs">暂无审计历史记录</p>
            </div>
          ) : viewMode === "compare" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr]">
                <select
                  value={compareLeft ?? ""}
                  onChange={(event) => setCompareLeft(event.target.value ? Number(event.target.value) : null)}
                  className="h-9 rounded-md border border-border/40 bg-background px-2 text-xs outline-none"
                >
                  {versions.map((version) => (
                    <option key={`left-${version.version}`} value={version.version}>
                      v{version.version} · {formatAuditDate(version.auditedAt)}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-center text-muted-foreground">
                  <GitCompare size={14} />
                </div>
                <select
                  value={compareRight ?? ""}
                  onChange={(event) => setCompareRight(event.target.value ? Number(event.target.value) : null)}
                  className="h-9 rounded-md border border-border/40 bg-background px-2 text-xs outline-none"
                >
                  {versions.map((version) => (
                    <option key={`right-${version.version}`} value={version.version}>
                      v{version.version} · {formatAuditDate(version.auditedAt)}
                    </option>
                  ))}
                </select>
              </div>

              {diff ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border/20 bg-card/40 p-3">
                    <div className="text-[11px] font-medium text-foreground">
                      v{diff.left.version} → v{diff.right.version}
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      变化字段：{diff.changedFields.length > 0 ? diff.changedFields.join(", ") : "无"}
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <AuditVersionColumn label={`v${diff.left.version}`} version={diff.left} />
                    <AuditVersionColumn label={`v${diff.right.version}`} version={diff.right} />
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border/20 bg-card/40 p-6 text-center text-xs text-muted-foreground">
                  请选择两个不同版本进行对比。
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
              <div className="space-y-2">
                {versions.slice().reverse().map((version) => (
                  <AuditVersionCard
                    key={version.version}
                    version={version}
                    selected={selectedVersion === version.version}
                    onSelect={() => setSelectedVersion(version.version)}
                  />
                ))}
              </div>
              <div className="min-w-0 rounded-2xl border border-border/20 bg-card/30 p-4">
                {selectedVersionDetail ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${selectedVersionDetail.passed ? "bg-emerald-500/10 text-emerald-700" : "bg-red-500/10 text-red-700"}`}>
                        v{selectedVersionDetail.version} {selectedVersionDetail.passed ? "通过" : "未通过"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{formatAuditDate(selectedVersionDetail.auditedAt)}</span>
                      <span className="text-[11px] text-muted-foreground">评分 {selectedVersionDetail.score}</span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <AuditFieldRow label="问题数" value={selectedVersionDetail.issueCount} />
                      <AuditFieldRow label="失败门禁" value={selectedVersionDetail.failureGate ?? "—"} />
                      <AuditFieldRow label="严重度统计" value={formatSeverityCounts(selectedVersionDetail.severityCounts) ?? "—"} />
                      <AuditFieldRow label="问题清单" value={selectedVersionDetail.issues} multiline />
                    </div>
                    <AuditFieldRow label="审计摘要" value={selectedVersionDetail.summary ?? "—"} multiline />
                    <AuditFieldRow label="审计报告" value={selectedVersionDetail.report ?? "—"} multiline />
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

function AuditVersionColumn({ label, version }: { label: string; version: ChapterAuditVersion }) {
  return (
    <div className="rounded-2xl border border-border/20 bg-background/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{label}</span>
        <span className="text-[10px] text-muted-foreground">{formatAuditDate(version.auditedAt)}</span>
      </div>
      <div className="space-y-2">
        <AuditFieldRow label="通过状态" value={version.passed ? "通过" : "未通过"} />
        <AuditFieldRow label="评分" value={version.score} />
        <AuditFieldRow label="问题数" value={version.issueCount} />
        <AuditFieldRow label="失败门禁" value={version.failureGate ?? "—"} />
        <AuditFieldRow label="严重度统计" value={formatSeverityCounts(version.severityCounts) ?? "—"} />
        <AuditFieldRow label="审计摘要" value={version.summary ?? "—"} multiline />
        <AuditFieldRow label="审计报告" value={version.report ?? "—"} multiline />
      </div>
    </div>
  );
}
