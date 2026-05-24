import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue } from "./continuity.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import { isStructuralAuditIssue } from "../utils/audit-issue-classification.js";
import { extractChapterTail } from "../utils/chapter-tail.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { readBrief } from "./planner-context.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { filterSummaries } from "../utils/context-filter.js";
import {
  buildGovernedCharacterMatrixWorkingSet,
  buildGovernedHookWorkingSet,
  mergeTableMarkdownByKey,
} from "../utils/governed-working-set.js";
import { applySpotFixPatches, parseSpotFixPatches } from "../utils/spot-fix-patches.js";
import type { ChapterPlan } from "../models/chapter-plan.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";
import { buildHookDebtHardConstraintBlock } from "../utils/hook-agenda.js";

export type ReviseMode = "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "spot-fix";

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

function normalizeIssueId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toUpperCase();
  return /^(?:ISSUE-\d{2,}|PW-\d{3})$/u.test(normalized) ? normalized : fallback;
}

function normalizeIssueKey(value: string): string {
  return value.trim().toUpperCase();
}

const MODE_DESCRIPTIONS: Record<ReviseMode, string> = {
  polish: "润色：只改表达、节奏、段落呼吸，不改事实与剧情结论。禁止：增删段落、改变人名/地名/物品名、增加新情节或新对话、改变因果关系。只允许：替换用词、调整句序、修改标点节奏",
  rewrite: "改写：允许重组问题段落、调整画面和叙述力度，但优先保留原文的绝大部分句段。除非问题跨越整章，否则禁止整章推倒重写；只能围绕问题段落及其直接上下文改写，同时保留核心事实与人物动机",
  rework: "重写：可重构场景推进和冲突组织，但不改主设定和大事件结果",
  "anti-detect": `反检测改写：在保持剧情不变的前提下，降低AI生成可检测性。

改写手法（附正例）：
1. 打破句式规律：连续短句 → 长短交替，句式不可预测
2. 口语化替代：✗"然而事情并没有那么简单" → ✓"哪有那么便宜的事"
3. 减少"了"字密度：✗"他走了过去，拿了杯子" → ✓"他走过去，端起杯子"
4. 转折词降频：✗"虽然…但是…" → ✓ 用角色内心吐槽或直接动作切换
5. 情绪外化：✗"他感到愤怒" → ✓"他捏碎了茶杯，滚烫的茶水流过指缝"
6. 删掉叙述者结论：✗"这一刻他终于明白了力量" → ✓ 只写行动，让读者自己感受
7. 群像反应具体化：✗"全场震惊" → ✓"老陈的烟掉在裤子上，烫得他跳起来"
8. 段落长度差异化：不再等长段落，有的段只有一句话，有的段七八行
9. 消灭"不禁""仿佛""宛如"等AI标记词：换成具体感官描写`,
  "spot-fix": "定点修复：只修改审稿意见指出的具体句子或段落，其余所有内容必须原封不动保留。修改范围限定在问题句子及其前后各一句。禁止改动无关段落",
};

function buildOpeningThreeChaptersReviseGuardrail(
  chapterNumber: number,
  bookRules: BookRules | null,
  governedMode: boolean,
): string {
  if (chapterNumber < 1 || chapterNumber > 3) return "";
  const openingCfg = bookRules?.openingThreeChapters;
  const enabled = openingCfg?.enabled ?? true;
  const applyInGovernedMode = openingCfg?.applyInGovernedMode ?? true;
  if (!enabled) return "";
  if (governedMode && !applyInGovernedMode) return "";

  const strict = openingCfg?.strict ?? true;
  const maxCharacters = openingCfg?.maxCharacters ?? 5;
  const strictLine = strict
    ? "- 强约束：若与审计问题冲突，优先修复开篇硬伤（慢热、无冲突、无悬念、主角缺席）再处理润色类问题。"
    : "- 软约束：尽量提升开篇冲突与悬念强度，不破坏本章已成立的关键事实。";

  return `\n## 开篇前三章修订护栏（第${chapterNumber}章）
- 只要涉及开篇节奏问题，优先把首屏改成“动作/对话入戏”，删减背景讲解和世界观灌输。
- 主角必须在前段出场并承压，不能用路人视角或旁白开场。
- 本章人物总量控制在${maxCharacters}个以内（优先保留核心冲突相关角色）。
- 章末必须补一个明确钩子：新风险 / 新疑点 / 新目标三选一。
${strictLine}`;
}

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  async reviseChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    genre?: string,
    options?: {
      userBrief?: string;
      externalContext?: string;
      chapterIntent?: string;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      lengthSpec?: LengthSpec;
      previousChapterContent?: string;
      reviseContext?: {
        failureGate?: "critical" | "score" | "none";
        score?: number;
        passScoreThreshold?: number;
        scoreShortfall?: number;
        unresolvedIssueIdsFromPrevRound?: ReadonlyArray<string>;
        mustFixFirstIssueIds?: ReadonlyArray<string>;
        issueClassCounts?: Readonly<{
          structural: number;
          textual: number;
        }>;
        primaryIssueClass?: "none" | "structural" | "textual" | "mixed";
        dimensionChecks?: ReadonlyArray<{
          dimension: string;
          status: "pass" | "warning" | "failed";
          evidence?: string;
        }>;
      };
      onRevisedContentDelta?: (text: string) => void;
      onSpotFixPatchDelta?: (text: string) => void;
      onThinkingDelta?: (text: string) => void;
      onThinkingEnd?: () => void;
      chapterPlan?: ChapterPlan;
    },
  ): Promise<ReviseOutput> {
    const [currentState, ledger, hooks, styleGuideRaw, volumeOutline, storyBible, characterMatrix, chapterSummaries, parentCanon, fanficCanon] = await Promise.all([
      this.readFileSafe(join(bookDir, "story/current_state.md")),
      this.readFileSafe(join(bookDir, "story/particle_ledger.md")),
      this.readFileSafe(join(bookDir, "story/pending_hooks.md")),
      this.readFileSafe(join(bookDir, "story/style_guide.md")),
      this.readFileSafe(join(bookDir, "story/volume_outline.md")),
      this.readFileSafe(join(bookDir, "story/story_bible.md")),
      this.readFileSafe(join(bookDir, "story/character_matrix.md")),
      this.readFileSafe(join(bookDir, "story/chapter_summaries.md")),
      this.readFileSafe(join(bookDir, "story/parent_canon.md")),
      this.readFileSafe(join(bookDir, "story/fanfic_canon.md")),
    ]);
    const foundationBrief = await readBrief(join(bookDir, "story"));

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    const [{ profile: gp }, bookLanguage] = await Promise.all([
      readGenreProfile(this.ctx.projectRoot, genreId),
      readBookLanguage(bookDir),
    ]);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;

    // Fallback: use book_rules body when style_guide.md doesn't exist
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (parsedRules?.body ?? "(无文风指南)");

    const issueList = issues
      .map((i, index) => {
        const issueId = normalizeIssueId(i.issueId, `ISSUE-${String(index + 1).padStart(2, "0")}`);
        const dimensionId = typeof i.dimensionId === "string" && i.dimensionId.trim().length > 0
          ? i.dimensionId.trim()
          : i.category;
        const excerpt = typeof i.excerpt === "string" && i.excerpt.trim().length > 0
          ? `\n  证据: ${i.excerpt.trim()}`
          : "";
        return `- [${issueId}] [${i.severity}] [${dimensionId}] ${i.category}: ${i.description}\n  建议: ${i.suggestion}${excerpt}`;
      })
      .join("\n");
    const structuralIssueIndexes = issues
      .map((issue, index) => (isStructuralAuditIssue(issue) ? index : -1))
      .filter((index) => index >= 0);
    const structuralIssueRequiredBlock = structuralIssueIndexes.length > 0
      ? `\n## 结构修复模式（强制）\n检测到结构性问题：${structuralIssueIndexes.map((index) => `ISSUE-${String(index + 1).padStart(2, "0")}`).join("、")}。\n你必须输出 STRUCTURAL_TRUTH_ACTIONS，并且每条结构性问题至少给出一条对应 truth-file 修复动作。\n动作必须显式指向以下文件之一：current_state.md / pending_hooks.md${gp.numericalSystem ? " / particle_ledger.md" : ""}。\n`
      : "";

    const modeDesc = MODE_DESCRIPTIONS[mode];
    const numericalRule = gp.numericalSystem
      ? "\n3. 数值错误必须精确修正，前后对账"
      : "";
    const protagonistBlock = bookRules?.protagonist
      ? `\n\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}。修改不得违反人设。`
      : "";
    const lengthGuardrail = options?.lengthSpec
      ? `\n8. 保持章节字数在目标区间内；只有在修复关键问题确实需要时才允许轻微偏离`
      : "";

    const isEnglish = (bookLanguage ?? gp.language) === "en";
    const resolvedLanguage = isEnglish ? "en" : "zh";
    const dialogueConstraint = this.buildDialogueQuoteConstraint(bookRules, resolvedLanguage);
    const chapterPlanBlock = options?.chapterPlan
      ? `\n## 分章设计约束（硬约束，修正时必须匹配）\n- 核心冲突：${options.chapterPlan.coreConflict}\n- 剧情与冲突：${options.chapterPlan.plotAndConflict}\n${options.chapterPlan.endingHook ? `- 结尾钩子（必须实现）：${options.chapterPlan.endingHook}\n` : ""}${options.chapterPlan.hookAssignment.length > 0 ? `- 需回收伏笔：\n${options.chapterPlan.hookAssignment.map((h) => `  - ${h}`).join("\n")}\n` : ""}${options.chapterPlan.requiredRecoverHooks.length > 0 ? `- 强制回收伏笔：\n${options.chapterPlan.requiredRecoverHooks.map((h) => `  - ${h}`).join("\n")}\n` : ""}- 本章最多新增伏笔数：${options.chapterPlan.maxNewHooks}`
      : "";

    const chapterBoundaryGuardrail = mode === "rewrite" || mode === "rework"
      ? "\n11. 章节边界保护：REVISED_CONTENT 只能包含“本章正文”，禁止输出任何其他章节标题（如“第N章”/“Chapter N”），禁止跨章拼接。"
      : "";
    const langPrefix = isEnglish
      ? mode === "spot-fix"
        ? `【LANGUAGE OVERRIDE】ALL output (FIXED_ISSUES, PATCHES, UPDATED_STATE, UPDATED_HOOKS) MUST be in English. Every TARGET_TEXT and REPLACEMENT_TEXT must be written entirely in English.\n\n`
        : `【LANGUAGE OVERRIDE】ALL output (FIXED_ISSUES, REVISED_CONTENT, UPDATED_STATE, UPDATED_HOOKS) MUST be in English. The revised chapter content must be written entirely in English.\n\n`
      : "";
    const governedMode = Boolean(options?.chapterIntent && options?.contextPackage && options?.ruleStack);
    const openingThreeChaptersGuardrail = buildOpeningThreeChaptersReviseGuardrail(
      chapterNumber,
      bookRules,
      governedMode,
    );
    const reviseContext = options?.reviseContext;
    const unresolvedIssueIds = Array.isArray(reviseContext?.unresolvedIssueIdsFromPrevRound)
      ? reviseContext.unresolvedIssueIdsFromPrevRound
        .map((item) => normalizeIssueKey(String(item)))
        .filter((item) => /^(?:ISSUE-\d{2,}|PW-\d{3})$/u.test(item))
      : [];
    const unresolvedIssueBlock = unresolvedIssueIds.length > 0
      ? `\n- 上一轮未收敛问题：${unresolvedIssueIds.join("、")}。本轮必须优先处理这些问题。`
      : "";
    const mustFixFirstIssueIds = Array.isArray(reviseContext?.mustFixFirstIssueIds)
      ? reviseContext.mustFixFirstIssueIds
        .map((item) => normalizeIssueKey(String(item)))
        .filter((item) => /^(?:ISSUE-\d{2,}|PW-\d{3})$/u.test(item))
      : [];
    const mustFixFirstBlock = mustFixFirstIssueIds.length > 0
      ? `\n- 必须优先修复：${mustFixFirstIssueIds.join("、")}。在这些问题未明确“已修复/无法修复（含原因）”前，不得结束本轮。`
      : "";
    const failedDimensions = Array.isArray(reviseContext?.dimensionChecks)
      ? reviseContext.dimensionChecks
        .filter((item) => item && item.status === "failed" && typeof item.dimension === "string" && item.dimension.trim())
        .map((item) => `- ${item.dimension}${item.evidence ? `：${item.evidence}` : ""}`)
      : [];
    const failedDimensionsBlock = failedDimensions.length > 0
      ? `\n## 本轮失败维度（优先修复）\n${failedDimensions.join("\n")}\n`
      : "";
    const failureGate = reviseContext?.failureGate === "critical" || reviseContext?.failureGate === "score" || reviseContext?.failureGate === "none"
      ? reviseContext.failureGate
      : undefined;
    const failureGateStrategyBlock = failureGate === "critical"
      ? `\n- 门禁策略：critical gate。先清空全部 critical 问题，再处理 warning；若 critical 未清空，不得宣称本轮已达标。`
      : failureGate === "score"
        ? `\n- 门禁策略：score gate。优先处理会显著影响评分的 warning/critical 问题（结构、连贯、设定冲突），再处理 info。`
        : failureGate === "none"
          ? `\n- 门禁策略：none。保持保守修改，优先完成 must-fix 与未收敛项。`
          : "";
    const currentScore = Number.isFinite(Number(reviseContext?.score))
      ? Math.trunc(Number(reviseContext?.score))
      : undefined;
    const passScoreThreshold = Number.isFinite(Number(reviseContext?.passScoreThreshold))
      ? Math.trunc(Number(reviseContext?.passScoreThreshold))
      : undefined;
    const scoreShortfall = Number.isFinite(Number(reviseContext?.scoreShortfall))
      ? Math.max(0, Math.trunc(Number(reviseContext?.scoreShortfall)))
      : (typeof currentScore === "number" && typeof passScoreThreshold === "number"
        ? Math.max(0, passScoreThreshold - currentScore)
        : undefined);
    const issueClassCounts = reviseContext?.issueClassCounts;
    const issueClassCountsBlock = issueClassCounts
      && Number.isFinite(Number(issueClassCounts.structural))
      && Number.isFinite(Number(issueClassCounts.textual))
      ? `\n- 问题分类计数：structural=${Math.max(0, Math.trunc(Number(issueClassCounts.structural)))}, textual=${Math.max(0, Math.trunc(Number(issueClassCounts.textual)))}`
      : "";
    const primaryIssueClass = reviseContext?.primaryIssueClass === "none"
      || reviseContext?.primaryIssueClass === "structural"
      || reviseContext?.primaryIssueClass === "textual"
      || reviseContext?.primaryIssueClass === "mixed"
      ? reviseContext.primaryIssueClass
      : undefined;
    const primaryIssueClassBlock = primaryIssueClass
      ? `\n- 主问题类型：${primaryIssueClass}`
      : "";
    const auditGateBlock = failureGate || Number.isFinite(Number(reviseContext?.score)) || Number.isFinite(Number(reviseContext?.passScoreThreshold)) || mustFixFirstBlock.length > 0
      ? `\n## 审计门禁信息\n- failureGate: ${failureGate ?? "none"}${typeof currentScore === "number" ? `\n- 当前评分: ${currentScore}` : ""}${typeof passScoreThreshold === "number" ? `\n- 通过阈值: ${passScoreThreshold}` : ""}${typeof scoreShortfall === "number" ? `\n- 距离通过阈值还差: ${scoreShortfall}` : ""}${failureGateStrategyBlock}${issueClassCountsBlock}${primaryIssueClassBlock}${mustFixFirstBlock}${unresolvedIssueBlock}\n`
      : "";
    const hooksWorkingSet = governedMode && options?.contextPackage
      ? buildGovernedHookWorkingSet({
          hooksMarkdown: hooks,
          contextPackage: options.contextPackage,
          chapterNumber,
          language: resolvedLanguage,
        })
      : hooks;
    const chapterSummariesWorkingSet = governedMode
      ? filterSummaries(chapterSummaries, chapterNumber)
      : chapterSummaries;
    const characterMatrixWorkingSet = governedMode
      ? buildGovernedCharacterMatrixWorkingSet({
          matrixMarkdown: characterMatrix,
          chapterIntent: options?.chapterIntent ?? volumeOutline,
          contextPackage: options!.contextPackage!,
          protagonistName: bookRules?.protagonist?.name,
        })
      : characterMatrix;

    const outputFormat = mode === "spot-fix"
      ? `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条；如果无法安全定点修复，也在这里说明)

=== PATCHES ===
(只输出需要替换的局部补丁，不得输出整章重写。格式如下，可重复多个 PATCH 区块)
--- PATCH 1 ---
TARGET_TEXT:
(必须从原文中精确复制、且能唯一命中的原句或原段)
REPLACEMENT_TEXT:
(替换后的局部文本)
--- END PATCH ---

=== UPDATED_STATE ===
(更新后的完整状态卡)
${gp.numericalSystem ? "\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本)" : ""}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池)`
      : `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条)

=== REVISED_CONTENT ===
(修正后的完整正文)

=== UPDATED_STATE ===
(更新后的完整状态卡)
${gp.numericalSystem ? "\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本)" : ""}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池)`;

    const systemPrompt = `${langPrefix}你是一位专业的${gp.name}网络小说修稿编辑。你的任务是根据审稿意见对章节进行修正。${protagonistBlock}

修稿模式：${modeDesc}

修稿原则：
1. 按模式控制修改幅度
2. 修根因，不做表面润色${numericalRule}
4. 伏笔状态必须与伏笔池同步
5. 不改变剧情走向和核心冲突
6. 保持原文的语言风格和节奏
7. 修改后同步更新状态卡${gp.numericalSystem ? "、账本" : ""}、伏笔池
8. ${dialogueConstraint}
${lengthGuardrail}
9. 必须逐条对应“审稿问题”中的主键处理；优先沿用原 issueId（如 ISSUE-07 / PW-019），禁止跳过 critical/warning 问题。
10. 在 FIXED_ISSUES 中，每一条都必须以原 issueId 开头，说明该问题如何被处理（已修复/部分修复/无法修复及原因）。
${mode === "spot-fix" ? "\n11. spot-fix 只能输出局部补丁，禁止输出整章改写；TARGET_TEXT 必须能在原文中唯一命中\n12. 如果需要大面积改写，说明无法安全 spot-fix，并让 PATCHES 留空" : ""}
${chapterBoundaryGuardrail}
${openingThreeChaptersGuardrail}
${chapterPlanBlock}

输出格式：

先输出分析思路（包含对每个审稿问题的判断），然后再输出结构化内容。分析思路和结构化内容之间用 === FIXED_ISSUES === 分隔。

${outputFormat}${structuralIssueRequiredBlock ? `\n=== STRUCTURAL_TRUTH_ACTIONS ===\n(结构性问题的 truth-file 修订动作；每行必须以 [ISSUE-XX] 开头，格式建议：file=... action=... reason=...)` : ""}${structuralIssueRequiredBlock}`;

    const ledgerBlock = gp.numericalSystem
      ? `\n## 资源账本\n${ledger}`
      : "";
    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;
    const hookDebtBlock = governedMemoryBlocks?.hookDebtBlock ?? "";
    const hooksBlock = governedMemoryBlocks?.hooksBlock
      ?? `\n## 伏笔池\n${hooksWorkingSet}\n`;
    const hookDebtHardConstraint = buildHookDebtHardConstraintBlock({
      hooks: parsePendingHooksMarkdown(hooksWorkingSet),
      chapterNumber,
      language: resolvedLanguage,
      maxRecoveryPerChapter: options?.chapterPlan?.maxRecoveryPerChapter,
    });
    const hookDebtHardConstraintBlock = hookDebtHardConstraint
      ? (resolvedLanguage === "en"
        ? `\n## Hook Debt Hard Constraint (Must Follow)\n${hookDebtHardConstraint}\n`
        : `\n## 伏笔债务硬约束（必须遵守）\n${hookDebtHardConstraint}\n`)
      : "";
    const outlineBlock = volumeOutline !== "(文件不存在)"
      ? `\n## 卷纲\n${volumeOutline}\n`
      : "";
    const bibleBlock = !governedMode && storyBible !== "(文件不存在)"
      ? `\n## 世界观设定\n${storyBible}\n`
      : "";
    const matrixBlock = characterMatrixWorkingSet !== "(文件不存在)"
      ? `\n## 角色交互矩阵\n${characterMatrixWorkingSet}\n`
      : "";
    const foundationBriefBlock = foundationBrief.trim()
      ? isEnglish
        ? `\n## Foundation Brief\n${foundationBrief}\n`
        : `\n## 基础创作摘要\n${foundationBrief}\n`
      : "";
    const summariesBlock = governedMemoryBlocks?.summariesBlock
      ?? (chapterSummariesWorkingSet !== "(文件不存在)"
        ? `\n## 章节摘要\n${chapterSummariesWorkingSet}\n`
        : "");
    const volumeSummariesBlock = governedMemoryBlocks?.volumeSummariesBlock ?? "";

    const hasParentCanon = parentCanon !== "(文件不存在)";
    const hasFanficCanon = fanficCanon !== "(文件不存在)";

    const canonBlock = hasParentCanon
      ? `\n## 正传正典参照（修稿专用）\n本书为番外作品。修改时参照正典约束，不可改变正典事实。\n${parentCanon}\n`
      : "";

    const fanficCanonBlock = hasFanficCanon
      ? `\n## 同人正典参照（修稿专用）\n本书为同人作品。修改时参照正典角色档案和世界规则，不可违反正典事实。角色对话必须保留原作语癖。\n${fanficCanon}\n`
      : "";
    const reducedControlBlock = options?.chapterIntent && options.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(options.chapterIntent, options.contextPackage, options.ruleStack)
      : "";
    const lengthGuidanceBlock = options?.lengthSpec
      ? `\n## 字数护栏\n目标字数：${options.lengthSpec.target}\n允许区间：${options.lengthSpec.softMin}-${options.lengthSpec.softMax}\n极限区间：${options.lengthSpec.hardMin}-${options.lengthSpec.hardMax}\n如果修正后超出允许区间，请优先压缩冗余解释、重复动作和弱信息句，不得新增支线或删掉核心事实。\n`
      : "";
    const styleGuideBlock = reducedControlBlock.length === 0
      ? `\n## 文风指南\n${styleGuide}`
      : "";

    const userBriefBlock = options?.userBrief
      ? `
## 用户修订要求
${options.userBrief}
`
      : "";
    const externalContextBlock = options?.externalContext?.trim()
      ? isEnglish
        ? `
## External Context
${options.externalContext.trim()}
`
        : `
## 外部指令
${options.externalContext.trim()}
`
      : "";

    const previousChapterTail = options?.previousChapterContent
      ? extractChapterTail(options.previousChapterContent, 800)
      : undefined;
    const previousChapterTailBlock = previousChapterTail
      ? (isEnglish
        ? `\n## Seamless Transition Protection
The opening of this chapter must naturally connect to the end of the previous chapter. The ending portion of the previous chapter is provided below — do not break this connection during revision.

${previousChapterTail}

Rules:
1. The first paragraph must not detach from the previous chapter's ending context — if rewriting, ensure the rewritten first paragraph still connects naturally.
2. Do not delete or alter key transition sentences that bridge the chapters.
3. If the chapter opening needs adjustment during revision, ensure it still transitions smoothly.
`
        : `\n## 衔接保护要求
本章开头必须与上一章结尾自然衔接。以下是上一章的结尾部分，改写时不得破坏衔接关系：

${previousChapterTail}

保护规则：
1. 本章第一段不能脱离上一章结尾的语境——如果是重写，必须保证重写后的第一段仍然能自然衔接
2. 不要删除或改变与上一章衔接的关键过渡句
3. 如果本章因改写需要调整开头，需确保调整后依然平滑衔接
`)
      : "";

    const userPrompt = `请修正第${chapterNumber}章。

## 审稿问题
${issueList}
${externalContextBlock}
${userBriefBlock}
## 当前状态卡
${foundationBriefBlock}${currentState}
${ledgerBlock}
${hookDebtBlock}${hookDebtHardConstraintBlock}${hooksBlock}${volumeSummariesBlock}${reducedControlBlock || outlineBlock}${bibleBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}
${auditGateBlock}${failedDimensionsBlock}
${previousChapterTailBlock}

## 待修正章节
${chapterContent}`;

    const maxTokens = mode === "spot-fix" ? 8192 : 16384;

    let streamedResponse = "";
    let emittedRevisedLength = 0;
    let emittedPatchLength = 0;
    let emittedThinkingLength = 0;
    let thinkingSectionDone = false;
    const tryEmitThinkingDelta = (buffer: string): void => {
      if (thinkingSectionDone) return;
      if (!options?.onThinkingDelta) return;
      // Everything before the first === section marker is thinking
      const sectionMatch = buffer.match(/=== [A-Z_]+ ===/);
      const thinkingEndIndex = sectionMatch ? sectionMatch.index! : -1;
      if (thinkingEndIndex >= 0) {
        // Thinking section ends at the first === marker
        const thinkingText = buffer.slice(0, thinkingEndIndex).trim();
        if (thinkingText.length > emittedThinkingLength) {
          const delta = thinkingText.slice(emittedThinkingLength);
          emittedThinkingLength = thinkingText.length;
          if (delta) options.onThinkingDelta(delta);
        }
        thinkingSectionDone = true;
        options.onThinkingEnd?.();
        return;
      }
      // No === marker yet, entire buffer is thinking
      if (buffer.length > emittedThinkingLength) {
        const delta = buffer.slice(emittedThinkingLength);
        emittedThinkingLength = buffer.length;
        if (delta) options.onThinkingDelta(delta);
      }
    };
    const tryEmitRevisedContentDelta = (buffer: string): void => {
      if (mode === "spot-fix") return;
      if (!options?.onRevisedContentDelta) return;
      const match = buffer.match(/=== REVISED_CONTENT ===\s*([\s\S]*?)(?==== [A-Z_]+ ===|$)/);
      const revisedSoFar = (match?.[1] ?? "").trimStart();
      if (!revisedSoFar) return;
      if (revisedSoFar.length <= emittedRevisedLength) return;
      const delta = revisedSoFar.slice(emittedRevisedLength);
      emittedRevisedLength = revisedSoFar.length;
      if (delta) options.onRevisedContentDelta(delta);
    };
    const tryEmitSpotFixPatchDelta = (buffer: string): void => {
      if (mode !== "spot-fix") return;
      if (!options?.onSpotFixPatchDelta) return;
      const match = buffer.match(/=== PATCHES ===\s*([\s\S]*?)(?==== [A-Z_]+ ===|$)/);
      const patchSoFar = (match?.[1] ?? "").trimStart();
      if (!patchSoFar) return;
      if (patchSoFar.length <= emittedPatchLength) return;
      const delta = patchSoFar.slice(emittedPatchLength);
      emittedPatchLength = patchSoFar.length;
      if (delta) options.onSpotFixPatchDelta(delta);
    };

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: 0.3,
        maxTokens,
        onTextDelta: (options?.onRevisedContentDelta || options?.onSpotFixPatchDelta || options?.onThinkingDelta)
          ? (text) => {
              streamedResponse += text;
              tryEmitThinkingDelta(streamedResponse);
              tryEmitRevisedContentDelta(streamedResponse);
              tryEmitSpotFixPatchDelta(streamedResponse);
            }
          : undefined,
      },
    );
    if (!thinkingSectionDone) {
      // No === marker in streamed response — check full content
      tryEmitThinkingDelta(response.content);
    }
    if (options?.onRevisedContentDelta && mode !== "spot-fix") {
      streamedResponse = response.content;
      tryEmitRevisedContentDelta(streamedResponse);
    }
    if (options?.onSpotFixPatchDelta && mode === "spot-fix") {
      streamedResponse = response.content;
      tryEmitSpotFixPatchDelta(streamedResponse);
    }

    const output = this.parseOutput(response.content, gp, mode, chapterContent, chapterNumber, issues);
    const mergedOutput = governedMode
      ? {
          ...output,
          updatedHooks: mergeTableMarkdownByKey(hooks, output.updatedHooks, [0]),
        }
      : output;
    const wordCount = options?.lengthSpec
      ? countChapterLength(mergedOutput.revisedContent, options.lengthSpec.countingMode)
      : mergedOutput.wordCount;
    return { ...mergedOutput, wordCount, tokenUsage: response.usage };
  }

  private parseOutput(
    content: string,
    gp: GenreProfile,
    mode: ReviseMode,
    originalChapter: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
  ): ReviseOutput {
    const extract = (tag: string): string => {
      const regex = new RegExp(
        `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
      );
      const match = content.match(regex);
      return match?.[1]?.trim() ?? "";
    };

    const fixedRaw = extract("FIXED_ISSUES");
    const fixedIssues = this.normalizeFixedIssues(fixedRaw, issues);

    if (mode === "spot-fix") {
      const patches = parseSpotFixPatches(extract("PATCHES"));
      const patchResult = applySpotFixPatches(originalChapter, patches);

      return {
        revisedContent: patchResult.revisedContent,
        wordCount: patchResult.revisedContent.length,
        fixedIssues: patchResult.applied
          ? fixedIssues
          : [...fixedIssues, "[ISSUE-00] 无法安全应用 spot-fix PATCH，正文保持不变。"],
        updatedState: extract("UPDATED_STATE") || "(状态卡未更新)",
        updatedLedger: gp.numericalSystem
          ? (extract("UPDATED_LEDGER") || "(账本未更新)")
          : "",
        updatedHooks: extract("UPDATED_HOOKS") || "(伏笔池未更新)",
      };
    }

    const revisedContent = extract("REVISED_CONTENT");
    const boundaryChecked = this.enforceChapterBoundary({
      revisedContent,
      originalChapter,
      chapterNumber,
    });

    return {
      revisedContent: boundaryChecked.content,
      wordCount: boundaryChecked.content.length,
      fixedIssues: boundaryChecked.crossedBoundary
        ? [...fixedIssues, "[ISSUE-00] 触发章节边界保护：检测到跨章内容，已回退为原始正文。"]
        : fixedIssues,
      updatedState: extract("UPDATED_STATE") || "(状态卡未更新)",
      updatedLedger: gp.numericalSystem
        ? (extract("UPDATED_LEDGER") || "(账本未更新)")
        : "",
      updatedHooks: extract("UPDATED_HOOKS") || "(伏笔池未更新)",
    };
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件不存在)";
    }
  }

  private buildReducedControlBlock(
    chapterIntent: string,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
  ): string {
    const selectedContext = contextPackage.selectedContext
      .map((entry) => `- ${entry.source}: ${entry.reason}${entry.excerpt ? ` | ${entry.excerpt}` : ""}`)
      .join("\n");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : "- none";

    return `\n## 本章控制输入（由 Planner/Composer 编译）
${chapterIntent}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }

  private normalizeFixedIssues(
    fixedRaw: string,
    issues: ReadonlyArray<AuditIssue>,
  ): ReadonlyArray<string> {
    const lines = fixedRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (issues.length === 0) return lines;

    const normalized: string[] = [];
    const seen = new Set<number>();
    const issueIdToIndex = new Map<string, number>();
    const dimensionIdToIndex = new Map<string, number>();
    for (const [index, issue] of issues.entries()) {
      const issueId = normalizeIssueId(issue.issueId, `ISSUE-${String(index + 1).padStart(2, "0")}`);
      issueIdToIndex.set(issueId, index);
      const dimensionId = typeof issue.dimensionId === "string" ? issue.dimensionId.trim().toUpperCase() : "";
      if (dimensionId.length > 0) {
        dimensionIdToIndex.set(dimensionId, index);
      }
      dimensionIdToIndex.set(issue.category.trim().toUpperCase(), index);
    }
    const untagged: string[] = [];
    for (const line of lines) {
      const match = line.match(/\[((?:ISSUE-\d{2,}|PW-\d{3}))\]/i);
      if (!match) {
        untagged.push(line);
        continue;
      }
      const token = normalizeIssueKey(match[1] ?? "");
      const index = issueIdToIndex.get(token) ?? dimensionIdToIndex.get(token);
      if (typeof index === "number" && index >= 0 && index < issues.length && !seen.has(index)) {
        seen.add(index);
        normalized.push(line.replace(/\[((?:ISSUE-\d{2,}|PW-\d{3}))\]/i, `[${normalizeIssueId(issues[index]?.issueId, token)}]`));
      }
    }

    for (const line of untagged) {
      const nextIndex = issues.findIndex((_, index) => !seen.has(index));
      if (nextIndex < 0) break;
      seen.add(nextIndex);
      normalized.push(`[${normalizeIssueId(issues[nextIndex]?.issueId, `ISSUE-${String(nextIndex + 1).padStart(2, "0")}`)}] ${line}`);
    }

    for (let index = 0; index < issues.length; index += 1) {
      if (seen.has(index)) continue;
      normalized.push(
        `[${normalizeIssueId(issues[index]?.issueId, `ISSUE-${String(index + 1).padStart(2, "0")}`)}] 未明确给出修复动作（模型输出缺失），建议重试该问题修订。`,
      );
    }

    return normalized;
  }

  private enforceChapterBoundary(params: {
    revisedContent: string;
    originalChapter: string;
    chapterNumber: number;
  }): { content: string; crossedBoundary: boolean } {
    const trimmed = params.revisedContent.trim();
    if (trimmed.length === 0) {
      return { content: params.revisedContent, crossedBoundary: false };
    }

    const headerMatches = [...trimmed.matchAll(/^#\s*(?:第\s*(\d+)\s*章|Chapter\s*(\d+)).*$/gimu)];
    if (headerMatches.length === 0) {
      return { content: params.revisedContent, crossedBoundary: false };
    }

    const chapterNumbers = headerMatches
      .map((match) => Number.parseInt(match[1] ?? match[2] ?? "", 10))
      .filter((value) => Number.isInteger(value));
    const hasForeignHeader = chapterNumbers.some((value) => value !== params.chapterNumber);
    const hasMultipleHeaders = headerMatches.length > 1;
    if (hasForeignHeader || hasMultipleHeaders) {
      return { content: params.originalChapter, crossedBoundary: true };
    }

    const sameChapterHeader = new RegExp(
      `^#\\s*(?:第\\s*${params.chapterNumber}\\s*章|Chapter\\s*${params.chapterNumber}).*\\n*`,
      "iu",
    );
    return {
      content: trimmed.replace(sameChapterHeader, "").trimStart(),
      crossedBoundary: false,
    };
  }

  private buildDialogueQuoteConstraint(
    bookRules: BookRules | null,
    language: "zh" | "en",
  ): string {
    if (language === "en") {
      return "Keep direct speech punctuation consistent with recent chapters. Do not switch quote style mid-chapter.";
    }
    const policy = bookRules?.dialogueQuotePolicy;
    if (!policy || policy.mode === "auto") {
      return "保持原章的对话标点习惯（如「……」或“……”）；除非用户明确要求切换，否则不得更换对白引号体系";
    }
    if (policy.mode === "force_double") {
      return policy.strict
        ? "本书强制对白格式：所有对白必须使用中文双引号“……”，且不得使用无引号“说话人：内容”体。出现「……」或无引号对白都视为违规。"
        : "本书强制对白格式：所有对白必须使用中文双引号“……”。禁止使用「……」。";
    }
    if (policy.mode === "force_corner") {
      return policy.strict
        ? "本书强制对白格式：所有对白必须使用「……」引号，且不得使用无引号“说话人：内容”体。出现“……”或无引号对白都视为违规。"
        : "本书强制对白格式：所有对白必须使用「……」引号。禁止使用“……”。";
    }
    return "本书强制对白格式：统一使用无引号“说话人：内容”体，不使用“……”或「……」对白引号。";
  }
}
