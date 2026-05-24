export type BookAgentIntent = "write-next" | "rewrite";
export type BookInstructionLanguage = "zh" | "en";

export interface AuditInstructionSeverityCounts {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export interface AuditInstructionContext {
  readonly score?: number;
  readonly passScoreThreshold?: number;
  readonly scoreShortfall?: number;
  readonly issueCount?: number;
  readonly failureGate?: "none" | "critical" | "score";
  readonly summary?: string;
  readonly report?: string;
  readonly issues?: ReadonlyArray<string>;
  readonly severityCounts?: AuditInstructionSeverityCounts;
}

interface ResolveBookInstructionOptions {
  readonly chapterNumber?: number;
  readonly brief?: string;
  readonly auditReport?: string;
  readonly auditSummary?: AuditInstructionContext;
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

function clampNumber(input: unknown): number | undefined {
  const value = Number(input);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildAuditSummaryBlock(
  language: BookInstructionLanguage,
  chapter: number,
  audit?: AuditInstructionContext,
  fallbackReport?: string,
): string {
  if (!audit && !fallbackReport) return "";
  const score = clampNumber(audit?.score);
  const threshold = clampNumber(audit?.passScoreThreshold);
  const shortfall = clampNumber(audit?.scoreShortfall);
  const issueCount = clampNumber(audit?.issueCount);
  const report = normalizeAuditReport(audit?.report ?? fallbackReport);
  const summary = typeof audit?.summary === "string" ? audit.summary.trim() : "";
  const issues = Array.isArray(audit?.issues)
    ? audit.issues.map((item) => item.trim()).filter((item) => item.length > 0).slice(0, 6)
    : [];
  const counts = audit?.severityCounts;
  const gate = audit?.failureGate ?? "none";
  const lines = language === "en"
    ? [`## Audit constraints`, `- Chapter: ${chapter}`]
    : [`## 审计约束`, `- 章节：第${chapter}章`];

  if (typeof score === "number") lines.push(language === "en" ? `- Current score: ${score}/100` : `- 当前评分：${score}/100`);
  if (typeof threshold === "number") lines.push(language === "en" ? `- Pass threshold: ${threshold}/100` : `- 通过阈值：${threshold}/100`);
  if (typeof shortfall === "number") lines.push(language === "en" ? `- Score gap: ${shortfall}` : `- 距离通过阈值还差：${shortfall}`);
  if (typeof issueCount === "number") lines.push(language === "en" ? `- Issue count: ${issueCount}` : `- 问题总数：${issueCount}`);
  lines.push(language === "en" ? `- Gate: ${gate}` : `- 门禁：${gate}`);
  if (counts && Number.isFinite(counts.critical) && Number.isFinite(counts.warning) && Number.isFinite(counts.info)) {
    lines.push(language === "en"
      ? `- Severity counts: critical ${counts.critical}, warning ${counts.warning}, info ${counts.info}`
      : `- 严重/警告/提示：${counts.critical} / ${counts.warning} / ${counts.info}`);
  }
  if (summary) {
    lines.push(language === "en" ? `- Summary: ${summary}` : `- 审计摘要：${summary}`);
  }
  if (issues.length > 0) {
    lines.push(language === "en" ? `## Key issues` : `## 重点问题`);
    issues.forEach((issue, index) => {
      lines.push(`${index + 1}. ${truncateText(issue, 180)}`);
    });
  }
  if (report) {
    lines.push(language === "en" ? `## Audit report` : `## 审计报告`);
    lines.push(truncateText(report, 1200));
  }
  lines.push(
    ...(language === "en"
      ? [
          "## Revision rules",
          "- Fix the listed issues only; do not expand unrelated plot.",
          "- Prioritize critical/warning issues first.",
          "- If a larger rewrite is required, keep the chapter's core outcome unchanged.",
        ]
      : [
          "## 修订要求",
          "- 只围绕上述问题收敛修改，不要扩写无关情节。",
          "- 优先修复 critical / warning 问题。",
          "- 如果需要较大改写，保持本章核心结论不变。",
        ]),
  );
  return lines.join("\n");
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
  const auditSummarySection = buildAuditSummaryBlock(language, chapter, options.auditSummary, auditReport);
  const auditReportSection = auditReport.length > 0 && !auditSummarySection
    ? language === "en"
      ? `\n\nLatest audit report:\n${auditReport}`
      : `\n\n最新审计报告：\n${auditReport}`
    : "";
  if (language === "en") {
    return `rewrite chapter ${chapter}${briefSuffix}${auditSummarySection ? `\n\n${auditSummarySection}` : auditReportSection}`;
  }
  return `重写第${chapter}章${briefSuffix}${auditSummarySection ? `\n\n${auditSummarySection}` : auditReportSection}`;
}
