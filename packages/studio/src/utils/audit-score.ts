export type AuditSeverity = "critical" | "warning" | "info";
export type AuditFailureGate = "none" | "critical" | "score";

export interface AuditSeverityCounts {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export const AUDIT_PASS_SCORE_THRESHOLD = 80;

export function clampAuditScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(score)));
}

export function parseAuditSeverityFromIssueText(text: string): AuditSeverity {
  const lowered = text.trim().toLowerCase();
  if (/^\[(critical|error|严重|高危)\]/i.test(lowered)) return "critical";
  if (/^\[(warning|warn|警告|中危)\]/i.test(lowered)) return "warning";
  return "info";
}

export function countAuditSeverityFromIssueTexts(issues: ReadonlyArray<string>): AuditSeverityCounts {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const issue of issues) {
    const severity = parseAuditSeverityFromIssueText(issue);
    if (severity === "critical") critical += 1;
    else if (severity === "warning") warning += 1;
    else info += 1;
  }
  return { critical, warning, info };
}

export function estimateAuditScoreFromSeverityCounts(counts: AuditSeverityCounts): number {
  const raw = 100 - counts.critical * 35 - counts.warning * 12 - counts.info * 4;
  return clampAuditScore(raw);
}

export function estimateAuditScoreFromIssueTexts(issues: ReadonlyArray<string>): number {
  return estimateAuditScoreFromSeverityCounts(countAuditSeverityFromIssueTexts(issues));
}

export function resolveAuditPassedByScore(
  basePassed: boolean,
  score: number,
  passScoreThreshold = AUDIT_PASS_SCORE_THRESHOLD,
  severityCounts?: AuditSeverityCounts,
): boolean {
  if (score < passScoreThreshold) return false;
  if (!severityCounts) return basePassed;
  if (severityCounts.critical > 0) return false;
  return basePassed;
}

export function resolveAuditPassed(args: {
  readonly basePassed: boolean;
  readonly score: number;
  readonly severityCounts?: AuditSeverityCounts;
  readonly issues?: ReadonlyArray<string>;
  readonly passScoreThreshold?: number;
}): boolean {
  const severityCounts = args.severityCounts
    ?? countAuditSeverityFromIssueTexts(args.issues ?? []);
  return resolveAuditPassedByScore(
    args.basePassed,
    args.score,
    args.passScoreThreshold ?? AUDIT_PASS_SCORE_THRESHOLD,
    severityCounts,
  );
}

export function resolveAuditFailureGate(args: {
  readonly basePassed: boolean;
  readonly score: number;
  readonly severityCounts: AuditSeverityCounts;
  readonly passScoreThreshold?: number;
}): AuditFailureGate {
  const passScoreThreshold = args.passScoreThreshold ?? AUDIT_PASS_SCORE_THRESHOLD;
  if (resolveAuditPassedByScore(args.basePassed, args.score, passScoreThreshold, args.severityCounts)) return "none";
  if (args.severityCounts.critical > 0) return "critical";
  if (args.score < passScoreThreshold) return "score";
  return "critical";
}

export function scoreBadgeClass(score: number): string {
  if (score >= 85) return "bg-emerald-500/10 text-emerald-600";
  if (score >= 60) return "bg-amber-500/10 text-amber-600";
  return "bg-destructive/10 text-destructive";
}
