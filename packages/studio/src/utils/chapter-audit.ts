import type { ChapterAuditReport } from "../shared/contracts";

type ChapterAuditSource = {
  readonly audit?: {
    readonly report?: string;
    readonly summary?: string;
  };
  readonly auditHistory?: ReadonlyArray<ChapterAuditReport>;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveLatestChapterAuditReport(chapter: ChapterAuditSource | null | undefined): string | null {
  if (!chapter) return null;

  const liveReport = normalizeText(chapter.audit?.report);
  if (liveReport) return liveReport;

  const history = Array.isArray(chapter.auditHistory) ? chapter.auditHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry) continue;
    const report = normalizeText(entry.report);
    if (report) return report;
    const summary = normalizeText(entry.summary);
    if (summary) return summary;
  }

  const liveSummary = normalizeText(chapter.audit?.summary);
  if (liveSummary) return liveSummary;
  return null;
}

