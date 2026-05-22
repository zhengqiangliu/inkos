export type BookAgentIntent = "write-next" | "rewrite";
export type BookInstructionLanguage = "zh" | "en";

interface ResolveBookInstructionOptions {
  readonly chapterNumber?: number;
  readonly brief?: string;
  readonly auditReport?: string;
  readonly language?: BookInstructionLanguage;
}

function resolveLanguage(input?: BookInstructionLanguage): BookInstructionLanguage {
  return input === "en" ? "en" : "zh";
}

function normalizeChapterNumber(input?: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return 0;
  return Math.max(0, Math.trunc(input));
}

function normalizeBrief(input?: string): string {
  const value = input?.trim() ?? "";
  return value.length > 0 ? ` ${value}` : "";
}

function normalizeAuditReport(input?: string): string {
  const value = input?.trim() ?? "";
  return value.length > 0 ? value : "";
}

export function resolveBookAgentInstruction(
  intent: BookAgentIntent,
  options: ResolveBookInstructionOptions = {},
): string {
  const language = resolveLanguage(options.language);
  if (intent === "write-next") {
    return language === "en" ? "write next chapter" : "写下一章";
  }

  const chapter = normalizeChapterNumber(options.chapterNumber);
  const briefSuffix = normalizeBrief(options.brief);
  const auditReport = normalizeAuditReport(options.auditReport);
  const auditReportSection = auditReport.length > 0
    ? language === "en"
      ? `\n\nLatest audit report:\n${auditReport}`
      : `\n\n最新审计报告：\n${auditReport}`
    : "";
  if (language === "en") {
    return `rewrite chapter ${chapter}${briefSuffix}${auditReportSection}`;
  }
  return `重写第${chapter}章${briefSuffix}${auditReportSection}`;
}
