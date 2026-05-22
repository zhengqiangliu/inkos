import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ChapterAuditReport, ChapterMeta } from "../models/chapter.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import { buildStateDegradedReviewNote } from "./chapter-state-recovery.js";

export interface ChapterPersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type ChapterPersistenceStatus = "ready-for-review" | "audit-failed" | "state-degraded";

function countAuditIssueSeverities(issues: ReadonlyArray<AuditIssue>): Readonly<{ critical: number; warning: number; info: number }> {
  return issues.reduce((acc, issue) => {
    if (issue.severity === "critical") acc.critical += 1;
    else if (issue.severity === "warning") acc.warning += 1;
    else acc.info += 1;
    return acc;
  }, { critical: 0, warning: 0, info: 0 });
}

function estimateAuditScore(severityCounts: Readonly<{ critical: number; warning: number; info: number }>): number {
  const raw = 100 - severityCounts.critical * 35 - severityCounts.warning * 12;
  return Math.max(0, Math.min(100, raw));
}

function resolveAuditFailureGate(auditResult: AuditResult): "none" | "critical" | "score" {
  if (auditResult.passed) return "none";
  if (auditResult.issues.some((issue) => issue.category === "评分门禁" || issue.category === "Score Gate")) {
    return "score";
  }
  if (auditResult.issues.some((issue) => issue.severity === "critical")) {
    return "critical";
  }
  return "score";
}

export function buildChapterAuditHistoryEntry(auditResult: AuditResult, auditedAt: string, auditReport?: string): ChapterAuditReport {
  const severityCounts = countAuditIssueSeverities(auditResult.issues);
  const report = typeof auditReport === "string" && auditReport.trim().length > 0
    ? auditReport.trim()
    : (typeof auditResult.summary === "string" ? auditResult.summary.trim() : "");
  return {
    auditedAt,
    passed: auditResult.passed,
    issueCount: auditResult.issues.length,
    score: estimateAuditScore(severityCounts),
    summary: typeof auditResult.summary === "string" && auditResult.summary.trim().length > 0
      ? auditResult.summary.trim()
      : undefined,
    ...(report.length > 0 ? { report } : {}),
    issues: auditResult.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    ...(severityCounts.critical > 0 || severityCounts.warning > 0 || severityCounts.info > 0 ? { severityCounts } : {}),
    ...(auditResult.passed ? {} : { failureGate: resolveAuditFailureGate(auditResult) }),
  };
}

export async function persistChapterArtifacts(params: {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly status: ChapterPersistenceStatus;
  readonly auditResult: AuditResult;
  readonly finalWordCount: number;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly reviewNote?: string;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly auditReport?: string;
  readonly tokenUsage?: ChapterPersistenceUsage;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly saveChapter: () => Promise<void>;
  readonly saveTruthFiles: () => Promise<void>;
  readonly saveChapterIndex: (index: ReadonlyArray<ChapterMeta>) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly persistAuditDriftGuidance: (issues: ReadonlyArray<AuditIssue>) => Promise<void>;
  readonly snapshotState: () => Promise<void>;
  readonly syncCurrentStateFactHistory: () => Promise<void>;
  readonly logSnapshotStage: () => void;
  readonly now?: () => string;
}): Promise<{ readonly entry: ChapterMeta }> {
  const commitTruth = params.status === "ready-for-review";
  await params.saveChapter();
  if (commitTruth) {
    await params.saveTruthFiles();
  }

  const existingIndex = await params.loadChapterIndex();
  const now = params.now?.() ?? new Date().toISOString();
  const entry: ChapterMeta = {
    number: params.chapterNumber,
    title: params.chapterTitle,
    status: params.status,
    wordCount: params.finalWordCount,
    createdAt: now,
    updatedAt: now,
    auditIssues: params.auditResult.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    lengthWarnings: [...params.lengthWarnings],
    reviewNote: params.status === "state-degraded"
      ? buildStateDegradedReviewNote(
          params.auditResult.passed ? "ready-for-review" : "audit-failed",
          params.degradedIssues,
        )
      : params.reviewNote,
    lengthTelemetry: params.lengthTelemetry,
    tokenUsage: params.tokenUsage,
  };
  const existingIdx = existingIndex.findIndex((e) => e.number === params.chapterNumber);
  const previousHistory = existingIdx >= 0 && Array.isArray(existingIndex[existingIdx]?.auditHistory)
    ? existingIndex[existingIdx]!.auditHistory
    : [];
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? { ...entry, createdAt: e.createdAt, auditHistory: [...previousHistory, buildChapterAuditHistoryEntry(params.auditResult, now, params.auditReport)] } : e)
    : [...existingIndex, { ...entry, auditHistory: [buildChapterAuditHistoryEntry(params.auditResult, now, params.auditReport)] }];
  await params.saveChapterIndex(updatedIndex);
  await params.markBookActiveIfNeeded();

  const driftIssues = params.auditResult.issues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  await params.persistAuditDriftGuidance(driftIssues);

  if (commitTruth) {
    params.logSnapshotStage();
    await params.snapshotState();
    await params.syncCurrentStateFactHistory();
  }

  return { entry };
}
