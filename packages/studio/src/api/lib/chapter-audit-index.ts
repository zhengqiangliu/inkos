import type { StateManager } from "@actalk/inkos-core";
import type { ChapterAuditReport } from "../../shared/contracts.js";
import { clampAuditScore } from "../../utils/audit-score.js";

export interface ChapterAuditIndexEntry {
  readonly number: number;
  readonly title?: string;
  readonly status?: string;
  readonly wordCount?: number;
  readonly auditIssueCount?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly auditIssues?: ReadonlyArray<string>;
  readonly reviewNote?: string;
  readonly auditHistory?: ReadonlyArray<ChapterAuditReport>;
  readonly [key: string]: unknown;
}

export interface PersistChapterAuditSummaryArgs {
  readonly state: StateManager;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly audit: {
    readonly passed: boolean;
    readonly score: number;
    readonly issueCount: number;
    readonly summary?: string | null;
    readonly report?: string | null;
    readonly issues: ReadonlyArray<string>;
    readonly severityCounts?: Readonly<{
      critical: number;
      warning: number;
      info: number;
    }>;
    readonly failureGate?: "none" | "critical" | "score";
  };
  readonly now?: () => string;
}

export interface PersistChapterAuditSummaryResult {
  readonly updated: boolean;
  readonly chapter: ChapterAuditIndexEntry | null;
}

function normalizeEntries(index: unknown): ChapterAuditIndexEntry[] {
  if (!Array.isArray(index)) return [];
  return index.filter((entry): entry is ChapterAuditIndexEntry => Boolean(entry) && typeof entry === "object");
}

function buildAuditHistoryEntry(args: PersistChapterAuditSummaryArgs["audit"], auditedAt: string): ChapterAuditReport {
  return {
    auditedAt,
    passed: args.passed,
    issueCount: Math.max(0, Math.trunc(args.issueCount)),
    score: clampAuditScore(args.score),
    ...(typeof args.summary === "string" && args.summary.trim()
      ? { summary: args.summary.trim() }
      : {}),
    ...(typeof args.report === "string" && args.report.trim()
      ? { report: args.report.trim() }
      : {}),
    issues: [...args.issues],
    ...(args.severityCounts
      ? {
          severityCounts: {
            critical: Math.max(0, Math.trunc(args.severityCounts.critical)),
            warning: Math.max(0, Math.trunc(args.severityCounts.warning)),
            info: Math.max(0, Math.trunc(args.severityCounts.info)),
          },
        }
      : {}),
    ...(args.passed ? {} : { failureGate: args.failureGate ?? "score" }),
  };
}

export async function persistChapterAuditSummary(
  args: PersistChapterAuditSummaryArgs,
): Promise<PersistChapterAuditSummaryResult> {
  const index = normalizeEntries(await args.state.loadChapterIndex(args.bookId).catch(() => []));
  const currentIndex = index.findIndex((entry) => Number(entry.number) === args.chapterNumber);
  if (currentIndex < 0) {
    return { updated: false, chapter: null };
  }

  const current = index[currentIndex]!;
  const now = args.now?.() ?? new Date().toISOString();
  const currentHistory = Array.isArray(current.auditHistory) ? current.auditHistory : [];
  const nextStatus = args.audit.passed
    ? (current.status === "approved" || current.status === "published" ? current.status : "ready-for-review")
    : "audit-failed";
  const chapter: ChapterAuditIndexEntry = {
    ...current,
    status: nextStatus,
    auditIssueCount: Math.max(0, Math.trunc(args.audit.issueCount)),
    auditIssues: [...args.audit.issues],
    auditHistory: [...currentHistory, buildAuditHistoryEntry(args.audit, now)],
    updatedAt: now,
  };
  const nextIndex = index.map((entry, entryIndex) => (entryIndex === currentIndex ? chapter : entry));
  await args.state.saveChapterIndex(args.bookId, nextIndex as never);
  return { updated: true, chapter };
}
