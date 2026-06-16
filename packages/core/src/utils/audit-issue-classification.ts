export type AuditIssueClass = "structural" | "textual";

export interface AuditIssueSignalSource {
  readonly category: string;
  readonly dimensionId?: string;
  readonly description?: string;
}

export interface AuditIssueClassCounts {
  readonly structural: number;
  readonly textual: number;
}

export const STRUCTURAL_AUDIT_SIGNALS = [
  "OOC",
  "OOC检查",
  "角色一致性",
  "角色还原度",
  "character fidelity",
  "volume_outline",
  "卷纲",
  "卷纲一致性",
  "outline drift",
  "大纲偏离",
  "大纲偏离检测",
  "hook debt",
  "伏笔债务",
  "伏笔检查",
  "时间线",
  "时间线检查",
  "timeline check",
  "设定冲突",
  "lore conflict",
  "战力崩坏",
  "power scaling check",
  "数值检查",
  "numerical consistency check",
  "章节衔接检查",
  "chapter transition",
  "读者期待管理",
  "信息越界",
  "information boundary",
  "利益链断裂",
  "incentive chain",
  "年代考据",
  "era accuracy",
  "配角降智",
  "side character competence",
  "配角工具人化",
  "side character instrumentalization",
  "爽点虚化",
  "payoff dilution",
  "知识库污染",
  "knowledge base pollution",
  "视角一致性",
  "pov consistency",
  "支线停滞",
  "subplot stagnation",
  "弧线平坦",
  "arc flatline",
  "正传事件冲突",
  "mainline canon event conflict",
  "未来信息泄露",
  "future knowledge leak",
  "世界规则跨书一致性",
  "cross-book world rule",
  "番外伏笔隔离",
  "spinoff hook isolation",
  "角色还原度",
  "character fidelity",
  "世界规则遵守",
  "world rule compliance",
  "关系动态",
  "relationship dynamics",
  "正典事件一致性",
  "canon event consistency",
  "资源账本",
  "ledger",
  "状态卡",
] as const;

function normalizeAuditSignalText(value: string): string {
  return value.toLowerCase();
}

export function classifyAuditIssueClass(source: AuditIssueSignalSource): AuditIssueClass {
  const merged = normalizeAuditSignalText(`${source.dimensionId ?? ""} ${source.category} ${source.description ?? ""}`);
  return STRUCTURAL_AUDIT_SIGNALS.some((signal) => merged.includes(normalizeAuditSignalText(signal)))
    ? "structural"
    : "textual";
}

export function isStructuralAuditIssue(source: AuditIssueSignalSource): boolean {
  return classifyAuditIssueClass(source) === "structural";
}

export function countAuditIssueClasses(issues: ReadonlyArray<AuditIssueSignalSource>): AuditIssueClassCounts {
  let structural = 0;
  for (const issue of issues) {
    if (isStructuralAuditIssue(issue)) structural += 1;
  }
  return {
    structural,
    textual: Math.max(0, issues.length - structural),
  };
}

export function splitAuditIssuesByClass<T extends AuditIssueSignalSource>(
  issues: ReadonlyArray<T>,
): {
  structural: ReadonlyArray<T>;
  textual: ReadonlyArray<T>;
} {
  const structural: T[] = [];
  const textual: T[] = [];
  for (const issue of issues) {
    if (isStructuralAuditIssue(issue)) structural.push(issue);
    else textual.push(issue);
  }
  return { structural, textual };
}

export function resolvePrimaryIssueClass(
  counts: AuditIssueClassCounts,
): "none" | "structural" | "textual" | "mixed" {
  if (counts.structural === 0 && counts.textual === 0) return "none";
  if (counts.structural > 0 && counts.textual > 0) return "mixed";
  return counts.structural > 0 ? "structural" : "textual";
}

export interface ScorableAuditIssue extends AuditIssueSignalSource {
  readonly severity: "critical" | "warning" | "info";
}

export const AUDIT_SCORE_DEDUCTION = {
  critical: 30,
  structuralWarning: 8,
  textualWarning: 5,
  info: 0,
} as const;

/**
 * 唯一评分真源：critical -30；warning 按结构性 -8 / 文本性 -5 区分；info 不扣分。
 * 写作链路（writer 门禁预览）、审计链路（review-cycle）、任务编排（controller）共用此函数，
 * 避免同一章在不同路径下评分判定相反而触发假性修订轮。
 */
export function estimateAuditScoreDetailed(
  issues: ReadonlyArray<ScorableAuditIssue>,
): number {
  let deduction = 0;
  for (const issue of issues) {
    if (issue.severity === "critical") {
      deduction += AUDIT_SCORE_DEDUCTION.critical;
    } else if (issue.severity === "warning") {
      deduction += isStructuralAuditIssue(issue)
        ? AUDIT_SCORE_DEDUCTION.structuralWarning
        : AUDIT_SCORE_DEDUCTION.textualWarning;
    }
  }
  const raw = 100 - deduction;
  return Math.max(0, Math.min(100, raw));
}
