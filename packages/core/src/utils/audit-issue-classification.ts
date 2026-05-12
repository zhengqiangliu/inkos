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
  "paragraph-shape",
  "段落等长",
  "paragraph uniformity",
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
  "台词失真",
  "dialogue authenticity",
  "流水账",
  "chronicle drift",
  "知识库污染",
  "knowledge base pollution",
  "视角一致性",
  "pov consistency",
  "列表式结构",
  "list-like structure",
  "支线停滞",
  "subplot stagnation",
  "弧线平坦",
  "arc flatline",
  "节奏单调",
  "pacing monotony",
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
  "评分门禁",
  "score gate",
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
