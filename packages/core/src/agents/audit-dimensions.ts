import type { BookRules } from "../models/book-rules.js";
import type { FanficMode } from "../models/book.js";
import type { ChapterPlan } from "../models/chapter-plan.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { getFanficDimensionConfig } from "./fanfic-dimensions.js";

export type AuditPromptLanguage = "zh" | "en";

export interface AuditDimension {
  readonly id: number;
  readonly name: string;
  readonly note: string;
}

const DIMENSION_LABELS: Record<number, { readonly zh: string; readonly en: string }> = {
  1: { zh: "OOC检查", en: "OOC Check" },
  2: { zh: "时间线检查", en: "Timeline Check" },
  3: { zh: "设定冲突", en: "Lore Conflict Check" },
  4: { zh: "战力崩坏", en: "Power Scaling Check" },
  5: { zh: "数值检查", en: "Numerical Consistency Check" },
  6: { zh: "伏笔检查", en: "Hook Check" },
  7: { zh: "节奏检查", en: "Pacing Check" },
  8: { zh: "文风检查", en: "Style Check" },
  9: { zh: "信息越界", en: "Information Boundary Check" },
  10: { zh: "词汇疲劳", en: "Lexical Fatigue Check" },
  11: { zh: "利益链断裂", en: "Incentive Chain Check" },
  12: { zh: "年代考据", en: "Era Accuracy Check" },
  13: { zh: "配角降智", en: "Side Character Competence Check" },
  14: { zh: "配角工具人化", en: "Side Character Instrumentalization Check" },
  15: { zh: "爽点虚化", en: "Payoff Dilution Check" },
  16: { zh: "台词失真", en: "Dialogue Authenticity Check" },
  17: { zh: "流水账", en: "Chronicle Drift Check" },
  18: { zh: "知识库污染", en: "Knowledge Base Pollution Check" },
  19: { zh: "视角一致性", en: "POV Consistency Check" },
  20: { zh: "段落等长", en: "Paragraph Uniformity Check" },
  21: { zh: "套话密度", en: "Cliche Density Check" },
  22: { zh: "公式化转折", en: "Formulaic Twist Check" },
  23: { zh: "列表式结构", en: "List-like Structure Check" },
  24: { zh: "支线停滞", en: "Subplot Stagnation Check" },
  25: { zh: "弧线平坦", en: "Arc Flatline Check" },
  26: { zh: "节奏单调", en: "Pacing Monotony Check" },
  27: { zh: "敏感词检查", en: "Sensitive Content Check" },
  28: { zh: "正传事件冲突", en: "Mainline Canon Event Conflict" },
  29: { zh: "未来信息泄露", en: "Future Knowledge Leak Check" },
  30: { zh: "世界规则跨书一致性", en: "Cross-Book World Rule Check" },
  31: { zh: "番外伏笔隔离", en: "Spinoff Hook Isolation Check" },
  32: { zh: "读者期待管理", en: "Reader Expectation Check" },
  33: { zh: "大纲偏离检测", en: "Outline Drift Check" },
  34: { zh: "角色还原度", en: "Character Fidelity Check" },
  35: { zh: "世界规则遵守", en: "World Rule Compliance Check" },
  36: { zh: "关系动态", en: "Relationship Dynamics Check" },
  37: { zh: "正典事件一致性", en: "Canon Event Consistency Check" },
  38: { zh: "章节衔接检查", en: "Chapter Transition Check" },
};

function dimensionName(id: number, language: AuditPromptLanguage): string | undefined {
  return DIMENSION_LABELS[id]?.[language];
}

function resolveGenreLabel(genreId: string, profileName: string, language: AuditPromptLanguage): string {
  if (language === "zh" || !/[\u4e00-\u9fff]/u.test(profileName)) {
    return profileName;
  }

  if (genreId === "other") {
    return "general";
  }

  return genreId.replace(/[_-]+/g, " ");
}

function buildDimensionNote(
  id: number,
  language: AuditPromptLanguage,
  gp: GenreProfile,
  bookRules: BookRules | null,
  fanficMode: FanficMode | undefined,
  fanficConfig: ReturnType<typeof getFanficDimensionConfig> | undefined,
): string {
  const words = bookRules?.fatigueWordsOverride && bookRules.fatigueWordsOverride.length > 0
    ? bookRules.fatigueWordsOverride
    : gp.fatigueWords;

  if (fanficConfig?.notes.has(id) && language === "zh") {
    return fanficConfig.notes.get(id)!;
  }

  if (id === 1 && fanficMode === "ooc") {
    return language === "en"
      ? "In OOC mode, personality drift can be intentional; record only, do not fail. Evaluate against the character dossiers in fanfic_canon.md."
      : "OOC模式下角色可偏离性格底色，此维度仅记录不判定失败。参照 fanfic_canon.md 角色档案评估偏离程度。";
  }

  if (id === 1 && fanficMode === "canon") {
    return language === "en"
      ? "Canon-faithful fanfic: characters must stay close to their original personality core. Evaluate against fanfic_canon.md character dossiers."
      : "原作向同人：角色必须严格遵守性格底色。参照 fanfic_canon.md 角色档案中的性格底色和行为模式。";
  }

  if (id === 10 && words.length > 0) {
    return language === "en"
      ? `Fatigue words: ${words.join(", ")}. Also check AI tell markers (仿佛/不禁/宛如/竟然/忽然/猛地); warn when any appears more than once per 3,000 words.`
      : `高疲劳词：${words.join("、")}。同时检查AI标记词（仿佛/不禁/宛如/竟然/忽然/猛地）密度，每3000字超过1次即warning`;
  }

  if (id === 15 && gp.satisfactionTypes.length > 0) {
    return language === "en"
      ? `Payoff types: ${gp.satisfactionTypes.join(", ")}`
      : `爽点类型：${gp.satisfactionTypes.join("、")}`;
  }

  if (id === 12 && bookRules?.eraConstraints) {
    const era = bookRules.eraConstraints;
    const parts = [era.period, era.region].filter(Boolean);
    if (parts.length > 0) {
      return language === "en"
        ? `Era: ${parts.join(", ")}`
        : `年代：${parts.join("，")}`;
    }
  }

  switch (id) {
    case 19:
      return language === "en"
        ? "Check whether POV shifts are signaled clearly and stay consistent with the configured viewpoint."
        : "检查视角切换是否有过渡、是否与设定视角一致";
    case 24:
      return language === "en"
        ? "Cross-check subplot_board and chapter_summaries: flag any subplot that stays dormant long enough to feel abandoned, or a recent run where every subplot is only restated instead of genuinely moving."
        : "对照 subplot_board 和 chapter_summaries：标记那些沉寂到接近被遗忘的支线，或近期连续只被重复提及、没有真实推进的支线。";
    case 25:
      return language === "en"
        ? "Cross-check emotional_arcs and chapter_summaries: flag any major character whose emotional line holds one pressure shape across a run instead of taking new pressure, release, reversal, or reinterpretation. Distinguish unchanged circumstances from unchanged inner movement."
        : "对照 emotional_arcs 和 chapter_summaries：标记主要角色在一段时间内始终停留在同一种情绪压力形态、没有新压力、释放、转折或重估的情况。注意区分'处境未变'和'内心未变'。";
    case 26:
      return language === "en"
        ? "Cross-check chapter_summaries for chapter-type distribution: warn when the recent sequence stays in the same mode long enough to flatten rhythm, or when payoff / release beats disappear for too long. Explicitly list the recent type sequence."
        : "对照 chapter_summaries 的章节类型分布：当近期章节长时间停留在同一种模式、把节奏压平，或回收/释放/高潮章节缺席过久时给出 warning。请明确列出最近章节的类型序列。";
    case 28:
      return language === "en"
        ? "Check whether spinoff events contradict the mainline canon constraints."
        : "检查番外事件是否与正典约束表矛盾";
    case 29:
      return language === "en"
        ? "Check whether characters reference information that should only be revealed after the divergence point (see the information-boundary table)."
        : "检查角色是否引用了分歧点之后才揭示的信息（参照信息边界表）";
    case 30:
      return language === "en"
        ? "Check whether the spinoff violates mainline world rules (power system, geography, factions)."
        : "检查番外是否违反正传世界规则（力量体系、地理、阵营）";
    case 31:
      return language === "en"
        ? "Check whether the spinoff resolves mainline hooks without authorization (warning level)."
        : "检查番外是否越权回收正传伏笔（warning级别）";
    case 32:
      return language === "en"
        ? "Check whether the ending renews curiosity, whether promised payoffs are landing on the cadence their hooks imply, whether pressure gets any release, and whether reader expectation gaps are accumulating faster than they are being satisfied."
        : "检查：章尾是否重新点燃好奇心，已经承诺的回收是否按伏笔自身节奏落地，压力是否得到释放，读者期待缺口是在持续累积还是在被满足。";
    case 33:
      return language === "en"
        ? "Cross-check volume_outline: does this chapter match the planned beat for the current chapter range? Did it skip planned nodes or consume later nodes too early? Does actual pacing match the planned chapter span? If a beat planned for N chapters is consumed in 1-2 chapters -> critical."
        : "对照 volume_outline：本章内容是否对应卷纲中当前章节范围的剧情节点？是否跳过了节点或提前消耗了后续节点？剧情推进速度是否与卷纲规划的章节跨度匹配？如果卷纲规划某段剧情跨N章但实际1-2章就讲完→critical";
    case 34:
    case 35:
    case 36:
    case 37: {
      if (!fanficConfig) return "";
      const severity = fanficConfig.severityOverrides.get(id) ?? "warning";
      const baseNote = language === "en"
        ? {
            34: "Check whether dialogue tics, speaking style, and behavior remain consistent with the character dossiers in fanfic_canon.md. Deviations need clear situational motivation.",
            35: "Check whether the chapter violates world rules documented in fanfic_canon.md (geography, power system, faction relations).",
            36: "Check whether relationship beats remain plausible and aligned with, or meaningfully develop from, the key relationships documented in fanfic_canon.md.",
            37: "Check whether the chapter contradicts the key event timeline in fanfic_canon.md.",
          }[id]
        : fanficConfig.notes.get(id);

      return baseNote
        ? `${baseNote} ${severity === "critical" ? (language === "en" ? "Strict check." : "（严格检查）") : severity === "info" ? (language === "en" ? "Log only; do not fail the chapter." : "（仅记录，不判定失败）") : (language === "en" ? "Warning level." : "（警告级别）")}`
        : "";
    }
    case 38:
      return language === "en"
        ? "Compare the end of the previous chapter with the start of this chapter. Check: do events, location, time, character state, and emotional tone connect naturally? Are there missing transitions, contradictions, or abrupt jumps between the two chapters? If no previous chapter exists, skip this dimension."
        : "对比上一章结尾与本章开头：事件、地点、时间、角色状态、情绪基调是否自然衔接？是否有跳跃、矛盾或缺少过渡？如无上一章则跳过本维度。";
    default:
      return "";
  }
}

export function buildAuditDimensions(
  gp: GenreProfile,
  bookRules: BookRules | null,
  language: AuditPromptLanguage,
  hasParentCanon = false,
  fanficMode?: FanficMode,
  options: {
    readonly chapterNumber?: number;
    readonly chapterPlan?: ChapterPlan;
  } = {},
): ReadonlyArray<AuditDimension> {
  const activeIds = new Set(gp.auditDimensions);

  if (bookRules?.additionalAuditDimensions) {
    const nameToId = new Map<string, number>();
    for (const [id, labels] of Object.entries(DIMENSION_LABELS)) {
      nameToId.set(labels.zh, Number(id));
      nameToId.set(labels.en, Number(id));
    }

    for (const dimension of bookRules.additionalAuditDimensions) {
      if (typeof dimension === "number") {
        activeIds.add(dimension);
      } else if (typeof dimension === "string") {
        const exactId = nameToId.get(dimension);
        if (exactId !== undefined) {
          activeIds.add(exactId);
        } else {
          for (const [name, id] of nameToId) {
            if (name.includes(dimension) || dimension.includes(name)) {
              activeIds.add(id);
              break;
            }
          }
        }
      }
    }
  }

  activeIds.add(32);
  activeIds.add(33);
  activeIds.add(38);

  if (bookRules?.protagonist) {
    activeIds.add(1);
    activeIds.add(16);
    activeIds.add(34);
  }

  if (gp.numericalSystem) {
    activeIds.add(5);
    activeIds.add(11);
    activeIds.add(15);
  }

  if (options.chapterPlan?.hookAssignment.length || options.chapterPlan?.requiredRecoverHooks.length || options.chapterPlan?.endingHook) {
    activeIds.add(6);
  }

  if ((options.chapterNumber ?? 0) > 0 && (options.chapterNumber ?? 0) <= 3) {
    activeIds.add(7);
  }

  if (bookRules?.enableFullCastTracking) {
    activeIds.add(13);
    activeIds.add(14);
    activeIds.add(36);
  }

  if (gp.eraResearch || bookRules?.eraConstraints?.enabled) {
    activeIds.add(12);
  }

  if (hasParentCanon && !fanficMode) {
    activeIds.add(28);
    activeIds.add(29);
    activeIds.add(30);
    activeIds.add(31);
  }

  let fanficConfig: ReturnType<typeof getFanficDimensionConfig> | undefined;
  if (fanficMode) {
    fanficConfig = getFanficDimensionConfig(fanficMode, bookRules?.allowedDeviations);
    for (const id of fanficConfig.activeIds) {
      activeIds.add(id);
    }
    for (const id of fanficConfig.deactivatedIds) {
      activeIds.delete(id);
    }
  }

  const dimensions: AuditDimension[] = [];
  for (const id of [...activeIds].sort((a, b) => a - b)) {
    const name = dimensionName(id, language);
    if (!name) continue;
    const note = buildDimensionNote(id, language, gp, bookRules, fanficMode, fanficConfig);
    dimensions.push({ id, name, note });
  }

  return dimensions;
}

export function formatAuditDimensionsPreview(
  gp: GenreProfile,
  bookRules: BookRules | null,
  isEnglish: boolean,
  options: {
    readonly hasParentCanon?: boolean;
    readonly fanficMode?: FanficMode;
    readonly chapterNumber?: number;
    readonly chapterPlan?: ChapterPlan;
  } = {},
): string {
  const language: AuditPromptLanguage = isEnglish ? "en" : "zh";
  const dimensions = buildAuditDimensions(gp, bookRules, language, options.hasParentCanon ?? false, options.fanficMode, {
    chapterNumber: options.chapterNumber,
    chapterPlan: options.chapterPlan,
  });
  const items = dimensions.map((dimension) => (
    isEnglish
      ? `${dimension.id}. ${dimension.name}${dimension.note ? ` (${dimension.note})` : ""}`
      : `${dimension.id}. ${dimension.name}${dimension.note ? `（${dimension.note}）` : ""}`
  ));
  const intro = isEnglish
    ? "This chapter WILL be audited against the following dimensions after generation. Write with these checks in mind:"
    : "本章完成后将按以下维度被审查。请在写作时预先考虑这些检查项：";
  const hardFocus = isEnglish
    ? "Hard focus: chapter intent, hook recovery, POV continuity, and no chapter-level drift."
    : "硬关注点：本章意图、伏笔回收、视角衔接、禁止章节级偏航。";
  return isEnglish
    ? `## Audit Preview\n\n${intro}\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n- ${hardFocus}`
    : `## 审计预览\n\n${intro}\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n- ${hardFocus}`;
}

export function formatAuditPriorityPreview(
  gp: GenreProfile,
  bookRules: BookRules | null,
  isEnglish: boolean,
  options: {
    readonly chapterNumber?: number;
    readonly chapterPlan?: ChapterPlan;
    readonly hasParentCanon?: boolean;
    readonly fanficMode?: FanficMode;
  } = {},
): string {
  const language: AuditPromptLanguage = isEnglish ? "en" : "zh";
  const dimensions = buildAuditDimensions(gp, bookRules, language, options.hasParentCanon ?? false, options.fanficMode, {
    chapterNumber: options.chapterNumber,
    chapterPlan: options.chapterPlan,
  });
  const dimensionMap = new Map(dimensions.map((dimension) => [dimension.id, dimension] as const));

  const priorityIds: number[] = [];
  const push = (...ids: number[]) => {
    for (const id of ids) {
      if (!priorityIds.includes(id)) priorityIds.push(id);
    }
  };

  const chapterNumber = options.chapterNumber;
  const chapterPlan = options.chapterPlan;
  const openingThreeChaptersEnabled = bookRules?.openingThreeChapters?.enabled ?? true;
  if ((chapterNumber ?? 0) > 0 && (chapterNumber ?? 0) <= 3 && openingThreeChaptersEnabled) {
    push(38, 33, 32, 7, 6);
  } else {
    push(38, 33, 32, 6);
  }

  if (chapterPlan?.hookAssignment.length || chapterPlan?.requiredRecoverHooks.length || chapterPlan?.endingHook) {
    push(6, 32, 33);
  }

  if (bookRules?.protagonist) {
    push(1, 16, 34);
  }

  if (gp.numericalSystem) {
    push(5, 11, 15);
  }

  if (gp.eraResearch || bookRules?.eraConstraints?.enabled) {
    push(12);
  }

  if (options.hasParentCanon && !options.fanficMode) {
    push(28, 29, 30, 31);
  }

  if (options.fanficMode) {
    push(34, 35, 36, 37);
  }

  if (bookRules?.enableFullCastTracking) {
    push(13, 14, 36);
  }

  const selected = priorityIds
    .map((id) => dimensionMap.get(id))
    .filter((dimension): dimension is NonNullable<typeof dimension> => Boolean(dimension))
    .slice(0, 7);

  const targetScoreLine = isEnglish
    ? "- Target: pass the first audit on the first attempt, with critical issues at 0 and score at or above 80."
    : "- 目标：首审一次通过，critical=0，分数达到80分及以上。";
  const strategyLine = isEnglish
    ? "- Order of work: structure first, continuity second, character consistency third, then style."
    : "- 处理顺序：先结构，再连续性，再人物一致性，最后才是句面。";
  const fallbackLine = isEnglish
    ? "- Treat the full audit preview below as the backup checklist; do not split attention evenly across all dimensions."
    : "- 下方完整审计预览是备查清单，不要把注意力平均分配到所有维度。";
  const chapterLine = chapterPlan
    ? isEnglish
      ? `- Chapter focus: ${chapterPlan.chapterName} / ${chapterPlan.emotionalTone} / ${chapterPlan.coreConflict}`
      : `- 本章聚焦：${chapterPlan.chapterName} / ${chapterPlan.emotionalTone} / ${chapterPlan.coreConflict}`
    : "";
  const hookLine = chapterPlan?.endingHook
    ? isEnglish
      ? `- Ending hook: ${chapterPlan.endingHook}`
      : `- 结尾钩子：${chapterPlan.endingHook}`
    : "";
  const driftLine = chapterPlan?.driftFlags.length
    ? isEnglish
      ? `- Drift flags: ${chapterPlan.driftFlags.map((flag) => flag.code).join(", ")}`
      : `- 偏离标记：${chapterPlan.driftFlags.map((flag) => flag.code).join("、")}`
    : "";

  const items = selected.map((dimension, index) => {
    const note = dimension.note ? (isEnglish ? ` — ${dimension.note}` : `：${dimension.note}`) : "";
    return isEnglish
      ? `${index + 1}. ${dimension.name}${note}`
      : `${index + 1}. ${dimension.name}${note}`;
  });

  return isEnglish
    ? `## Audit Gate\n\n${targetScoreLine}\n${strategyLine}${chapterLine ? `\n${chapterLine}` : ""}${hookLine ? `\n${hookLine}` : ""}${driftLine ? `\n${driftLine}` : ""}\n\nPriority checks:\n${items.map((item) => `- ${item}`).join("\n")}\n\n${fallbackLine}`
    : `## 审计门禁\n\n${targetScoreLine}\n${strategyLine}${chapterLine ? `\n${chapterLine}` : ""}${hookLine ? `\n${hookLine}` : ""}${driftLine ? `\n${driftLine}` : ""}\n\n优先检查：\n${items.map((item) => `- ${item}`).join("\n")}\n\n${fallbackLine}`;
}
