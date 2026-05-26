import type { HookAgenda } from "../models/input-governance.js";
import type { HookRecord, HookStatus } from "../models/runtime-state.js";
import type { StoredHook } from "../state/memory-db.js";
import { resolveHookPayoffTiming, localizeHookPayoffTiming } from "./hook-lifecycle.js";
import {
  HOOK_HEALTH_DEFAULTS,
  HOOK_POOL_PHASE_LIMITS,
  HOOK_STALE_THRESHOLDS,
  HOOK_TIMING_PROFILES,
  type HookPhase,
} from "./hook-policy.js";

export const DEFAULT_HOOK_LOOKAHEAD_CHAPTERS = 3;

export const DEFAULT_MAX_RECOVERY_PER_CHAPTER = 3;

/**
 * Infer the effective expected-payoff chapter for a hook that has no explicit
 * expectedChapter set. Uses the timing profile's overdueAge as the deadline
 * window, measured from the hook's startChapter.
 *
 * Only applies when the hook has an explicit payoffTiming field OR has
 * meaningful payoff signal text (expectedPayoff / notes). Hooks with no
 * timing signal at all are left without a deadline — they are handled by
 * the stale/dormant detection path instead.
 *
 * This ensures every hook with a declared timing has a soft deadline even
 * when the planner didn't assign expectedChapter explicitly, while avoiding
 * false overdue flags for hooks that were never given any timing signal.
 */
export function inferExpectedChapter(hook: StoredHook, _currentChapter: number): number | undefined {
  if (hook.expectedChapter != null && hook.expectedChapter > 0) {
    return hook.expectedChapter;
  }
  // Only infer a deadline when the hook has an explicit timing signal.
  const hasExplicitTiming = hook.payoffTiming != null && hook.payoffTiming.trim().length > 0;
  const hasPayoffSignal = (hook.expectedPayoff?.trim().length ?? 0) > 0
    || (hook.notes?.trim().length ?? 0) > 0;
  if (!hasExplicitTiming && !hasPayoffSignal) {
    return undefined;
  }
  const timing = resolveHookPayoffTiming(hook);
  const profile = HOOK_TIMING_PROFILES[timing];
  return Math.max(1, hook.startChapter) + profile.overdueAge;
}

/**
 * Resolve the story phase for a given chapter number.
 * Mirrors the logic in hook-lifecycle.ts resolveHookPhase but also returns
 * "endgame" for the final 10% of the story (when targetChapters is known).
 */
export function resolveStoryPhase(
  chapterNumber: number,
  targetChapters?: number,
): HookPhase | "endgame" {
  if (targetChapters && targetChapters > 0) {
    const progress = chapterNumber / targetChapters;
    if (progress >= 0.90) return "endgame";
    if (progress >= 0.72) return "late";
    if (progress >= 0.33) return "middle";
    return "opening";
  }
  // Fallback when total chapter count is unknown: use absolute chapter numbers.
  if (chapterNumber >= 32) return "late";
  if (chapterNumber >= 8) return "middle";
  return "opening";
}

export interface HookDebtBudget {
  readonly hardClearMode: boolean;
  readonly reason: string;
  readonly maxRecoveryPerChapter: number;
  readonly maxNewHooks: number;
  readonly requiredRecoverHooks: ReadonlyArray<string>;
  readonly hookAssignment: ReadonlyArray<string>;
  readonly staleDebt: ReadonlyArray<string>;
  readonly mustAdvance: ReadonlyArray<string>;
  readonly eligibleResolve: ReadonlyArray<string>;
}

/**
 * Build the hook agenda using simple stalest-first sorting.
 * No lifecycle pressure formulas — just pick the hooks that have been
 * dormant the longest and the ones that are ripe for resolution.
 *
 * Stale detection now uses per-timing thresholds (HOOK_STALE_THRESHOLDS)
 * instead of a single global staleAfterChapters=10, so short-arc hooks
 * (immediate/near-term) are flagged much sooner.
 */
export function buildPlannerHookAgenda(params: {
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
  readonly targetChapters?: number;
  readonly language?: "zh" | "en";
  readonly maxMustAdvance?: number;
  readonly maxEligibleResolve?: number;
  readonly maxStaleDebt?: number;
}): HookAgenda {
  const agendaHooks = params.hooks
    .map(normalizeStoredHook)
    .filter((hook) => !isFuturePlannedHook(hook, params.chapterNumber, 0))
    .filter((hook) => hook.status !== "resolved" && hook.status !== "deferred");

  // mustAdvance: stalest first (lowest lastAdvancedChapter)
  const mustAdvanceHooks = agendaHooks
    .slice()
    .sort((left, right) => (
      left.lastAdvancedChapter - right.lastAdvancedChapter
      || left.startChapter - right.startChapter
      || left.hookId.localeCompare(right.hookId)
    ))
    .slice(0, params.maxMustAdvance ?? 2);

  // staleDebt: hooks dormant beyond their timing-specific stale threshold.
  // Uses HOOK_STALE_THRESHOLDS[timing] instead of the old flat 10-chapter window.
  const staleDebtHooks = agendaHooks
    .filter((hook) => {
      const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
      if (lastTouch <= 0) return false;
      const staleThreshold = HOOK_STALE_THRESHOLDS[hook.payoffTiming ?? "mid-arc"] ?? 10;
      return lastTouch <= params.chapterNumber - staleThreshold;
    })
    .sort((left, right) => (
      left.lastAdvancedChapter - right.lastAdvancedChapter
      || left.startChapter - right.startChapter
      || left.hookId.localeCompare(right.hookId)
    ))
    .slice(0, params.maxStaleDebt ?? 2);

  // eligibleResolve: started 3+ chapters ago AND recently advanced
  const eligibleResolveHooks = agendaHooks
    .filter((hook) => hook.startChapter <= params.chapterNumber - 3)
    .filter((hook) => hook.lastAdvancedChapter >= params.chapterNumber - 2)
    .sort((left, right) => (
      left.startChapter - right.startChapter
      || right.lastAdvancedChapter - left.lastAdvancedChapter
      || left.hookId.localeCompare(right.hookId)
    ))
    .slice(0, params.maxEligibleResolve ?? 1);

  const avoidNewHookFamilies = [...new Set([
    ...staleDebtHooks.map((hook) => hook.type.trim()).filter(Boolean),
    ...mustAdvanceHooks.map((hook) => hook.type.trim()).filter(Boolean),
    ...eligibleResolveHooks.map((hook) => hook.type.trim()).filter(Boolean),
  ])].slice(0, 3);

  return {
    pressureMap: [],
    mustAdvance: mustAdvanceHooks.map((hook) => hook.hookId),
    eligibleResolve: eligibleResolveHooks.map((hook) => hook.hookId),
    staleDebt: staleDebtHooks.map((hook) => hook.hookId),
    avoidNewHookFamilies,
  };
}

export function deriveHookDebtBudget(params: {
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
  readonly targetChapters?: number;
  readonly maxRecoveryPerChapter?: number;
  readonly maxNewHooks?: number;
}): HookDebtBudget {
  const normalizedHooks = params.hooks.map(normalizeStoredHook);
  const agenda = buildPlannerHookAgenda({
    hooks: params.hooks,
    chapterNumber: params.chapterNumber,
    targetChapters: params.targetChapters,
    maxMustAdvance: 3,
    maxEligibleResolve: 2,
    maxStaleDebt: 4,
  });

  const activeHooks = normalizedHooks.filter((hook) => hook.status !== "resolved" && hook.status !== "deferred");

  // Use inferExpectedChapter so hooks with explicit timing signals but no
  // expectedChapter are still caught by overdue detection.
  // Hooks with no timing signal return undefined and are excluded.
  const overdueHooks = activeHooks
    .filter((hook) => {
      const storedHook = params.hooks.find((h) => h.hookId === hook.hookId);
      if (!storedHook) return false;
      const effectiveExpected = inferExpectedChapter(storedHook, params.chapterNumber);
      return effectiveExpected != null && effectiveExpected < params.chapterNumber;
    })
    .sort((left, right) => {
      const leftStored = params.hooks.find((h) => h.hookId === left.hookId);
      const rightStored = params.hooks.find((h) => h.hookId === right.hookId);
      const leftExp = leftStored ? (inferExpectedChapter(leftStored, params.chapterNumber) ?? 0) : 0;
      const rightExp = rightStored ? (inferExpectedChapter(rightStored, params.chapterNumber) ?? 0) : 0;
      return leftExp - rightExp
        || left.lastAdvancedChapter - right.lastAdvancedChapter
        || left.startChapter - right.startChapter
        || left.hookId.localeCompare(right.hookId);
    });

  const activeCount = activeHooks.length;
  const overdueCount = overdueHooks.length;
  const staleCount = agenda.staleDebt.length;
  const eligibleResolveCount = agenda.eligibleResolve.length;

  // Resolve the phase-based pool limit for this chapter.
  const storyPhase = resolveStoryPhase(params.chapterNumber, params.targetChapters);
  const phaseLimit = HOOK_POOL_PHASE_LIMITS[storyPhase];

  // hardClearMode: triggered when pool exceeds the phase limit (not the old
  // flat ≥18 threshold). This fires as soon as the pool goes over its
  // phase-appropriate ceiling, not only when it's 50% over the global max.
  //
  // Additional triggers (unchanged): overdueCount≥3 or staleCount≥4.
  const hardClearMode = activeCount > phaseLimit.maxActive
    || overdueCount >= 3
    || staleCount >= 4
    || (activeCount >= HOOK_HEALTH_DEFAULTS.maxActiveHooks && overdueCount + staleCount >= 4);

  const highPressureMode = hardClearMode
    || overdueCount > 0
    || staleCount >= 2
    || activeCount >= phaseLimit.maxActive;

  const baseRecovery = params.maxRecoveryPerChapter ?? DEFAULT_MAX_RECOVERY_PER_CHAPTER;
  const recoveryTarget = hardClearMode
    ? Math.min(5, Math.max(phaseLimit.minResolveWhenFull, overdueCount + Math.min(staleCount, 2)))
    : overdueCount > 0
      ? Math.min(4, Math.max(2, overdueCount + 1))
      : staleCount >= 3
        ? 3
        : Math.max(phaseLimit.minResolveWhenFull, Math.min(baseRecovery, eligibleResolveCount > 0 ? 2 : 1));

  const maxRecoveryPerChapter = Math.max(1, Math.min(5, Math.max(baseRecovery, recoveryTarget)));

  // maxNewHooks: respect both the caller's cap and the phase-based cap.
  // In hardClearMode or highPressureMode, clamp to 0.
  // In endgame phase, always 0 regardless of pressure.
  const phaseMaxNew = phaseLimit.maxNewPerChapter;
  const maxNewHooks = Math.max(
    0,
    Math.min(
      params.maxNewHooks ?? phaseMaxNew,
      phaseMaxNew,
      hardClearMode || highPressureMode
        ? 0
        : staleCount >= 2 || activeCount >= phaseLimit.maxActive
          ? 1
          : phaseMaxNew,
    ),
  );

  const requiredRecoverHooks = uniqueStrings([
    ...overdueHooks.slice(0, maxRecoveryPerChapter).map((hook) => hook.hookId),
    ...agenda.eligibleResolve.slice(0, Math.max(0, maxRecoveryPerChapter - overdueHooks.length)),
    ...agenda.staleDebt.slice(0, Math.max(0, maxRecoveryPerChapter - overdueHooks.length - eligibleResolveCount)),
  ]).slice(0, maxRecoveryPerChapter);

  const hookAssignment = uniqueStrings([
    ...requiredRecoverHooks,
    ...agenda.mustAdvance.slice(0, Math.max(0, maxRecoveryPerChapter - requiredRecoverHooks.length)),
  ]).slice(0, maxRecoveryPerChapter);

  const reason = hardClearMode
    ? `伏笔债务已进入清债模式（当前 ${activeCount} 个活跃，阶段上限 ${phaseLimit.maxActive}），需要优先回收旧债并停止新增`
    : highPressureMode
      ? `伏笔债务压力偏高（当前 ${activeCount} 个活跃），需要压缩新增并优先回收旧债`
      : "伏笔债务处于正常压力区间";

  return {
    hardClearMode,
    reason,
    maxRecoveryPerChapter,
    maxNewHooks,
    requiredRecoverHooks,
    hookAssignment,
    staleDebt: agenda.staleDebt,
    mustAdvance: agenda.mustAdvance,
    eligibleResolve: agenda.eligibleResolve,
  };
}

function normalizeStoredHook(hook: StoredHook): HookRecord {
  return {
    hookId: hook.hookId,
    startChapter: Math.max(0, hook.startChapter),
    type: hook.type,
    status: normalizeStoredHookStatus(hook.status),
    lastAdvancedChapter: Math.max(0, hook.lastAdvancedChapter),
    expectedPayoff: hook.expectedPayoff,
    payoffTiming: resolveHookPayoffTiming(hook),
    notes: hook.notes,
  };
}

function normalizeStoredHookStatus(status: string): HookStatus {
  if (/^(resolved|closed|done|已回收|已解决)$/i.test(status.trim())) return "resolved";
  if (/^(deferred|paused|hold|延后|延期|搁置|暂缓)$/i.test(status.trim())) return "deferred";
  if (/^(progressing|advanced|重大推进|持续推进)$/i.test(status.trim())) return "progressing";
  return "open";
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function filterActiveHooks(hooks: ReadonlyArray<StoredHook>): StoredHook[] {
  return hooks.filter((hook) => normalizeStoredHookStatus(hook.status) !== "resolved");
}

/**
 * Build a hard constraint block about overdue/stale/resolvable hooks
 * for injection into writer/reviser prompts.
 *
 * Overdue detection now uses inferExpectedChapter so hooks without an
 * explicit expectedChapter are still surfaced when they exceed their
 * timing-profile deadline.
 *
 * Stale detection uses per-timing HOOK_STALE_THRESHOLDS instead of the
 * old flat 10-chapter window.
 */
export function buildHookDebtHardConstraintBlock(params: {
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
  readonly language?: "zh" | "en";
  readonly maxRecoveryPerChapter?: number;
}): string | undefined {
  const language = params.language ?? "zh";
  const maxRecovery = params.maxRecoveryPerChapter ?? DEFAULT_MAX_RECOVERY_PER_CHAPTER;
  const activeHooks = params.hooks
    .filter((hook) => hook.status !== "resolved" && hook.status !== "deferred");

  // Overdue hooks: effective expected chapter (explicit or inferred) < currentChapter.
  // Hooks with no timing signal (inferExpectedChapter returns undefined) are excluded.
  const overdueHooks = activeHooks
    .filter((hook) => {
      const eff = inferExpectedChapter(hook, params.chapterNumber);
      return eff != null && eff < params.chapterNumber;
    })
    .sort((a, b) => {
      const effA = inferExpectedChapter(a, params.chapterNumber) ?? 0;
      const effB = inferExpectedChapter(b, params.chapterNumber) ?? 0;
      return effA - effB;
    });

  // Due this chapter: effective expected chapter === currentChapter.
  const dueThisChapterHooks = activeHooks
    .filter((hook) => inferExpectedChapter(hook, params.chapterNumber) === params.chapterNumber);

  // Approaching: effective expected chapter within next 3 chapters.
  const approachingHooks = activeHooks
    .filter((hook) => {
      const eff = inferExpectedChapter(hook, params.chapterNumber);
      return eff != null && eff > params.chapterNumber && eff <= params.chapterNumber + 3;
    })
    .sort((a, b) => {
      const effA = inferExpectedChapter(a, params.chapterNumber) ?? 0;
      const effB = inferExpectedChapter(b, params.chapterNumber) ?? 0;
      return effA - effB;
    });

  // Stale hooks: dormant beyond their timing-specific stale threshold.
  const staleHooks = params.hooks
    .filter((hook) => {
      if (hook.status === "resolved" || hook.status === "deferred") return false;
      const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
      if (lastTouch <= 0) return false;
      const timing = resolveHookPayoffTiming(hook);
      const staleThreshold = HOOK_STALE_THRESHOLDS[timing] ?? 10;
      return lastTouch <= params.chapterNumber - staleThreshold;
    })
    .sort((a, b) => a.lastAdvancedChapter - b.lastAdvancedChapter)
    .filter((h) => !overdueHooks.includes(h) && !dueThisChapterHooks.includes(h) && !approachingHooks.includes(h))
    .slice(0, 3);

  const resolvableHooks = params.hooks
    .filter((hook) => {
      if (hook.status === "resolved" || hook.status === "deferred") return false;
      return hook.startChapter <= params.chapterNumber - 3
        && hook.lastAdvancedChapter >= params.chapterNumber - 2;
    })
    .sort((a, b) => a.startChapter - b.startChapter)
    .filter((h) => !overdueHooks.includes(h) && !dueThisChapterHooks.includes(h) && !approachingHooks.includes(h))
    .slice(0, 2);

  const dormantHooks = params.hooks
    .filter((hook) => {
      if (hook.status === "resolved" || hook.status === "deferred") return false;
      const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
      return lastTouch > 0 && lastTouch <= params.chapterNumber - 5;
    })
    .sort((a, b) => a.lastAdvancedChapter - b.lastAdvancedChapter)
    .filter((h) => !overdueHooks.includes(h) && !dueThisChapterHooks.includes(h) && !approachingHooks.includes(h))
    .slice(0, 3);

  const allHooks = [...overdueHooks, ...dueThisChapterHooks, ...approachingHooks, ...staleHooks, ...resolvableHooks, ...dormantHooks];
  if (allHooks.length === 0) return undefined;

  const lines: string[] = [];

  if (language === "en") {
    if (overdueHooks.length > 0) {
      lines.push(
        "### Overdue Hooks - Must Resolve",
        `These hooks have passed their expected resolution chapter and MUST be resolved:`,
        ...overdueHooks.map((h) => {
          const eff = inferExpectedChapter(h, params.chapterNumber) ?? h.startChapter;
          return `- ${h.hookId} (overdue by ${params.chapterNumber - eff} chapters, expected ch.${eff})`;
        }),
        "",
      );
    }
    if (dueThisChapterHooks.length > 0) {
      lines.push(
        "### Hooks Due This Chapter",
        `These hooks are scheduled for resolution in this chapter:`,
        ...dueThisChapterHooks.map((h) => {
          const eff = inferExpectedChapter(h, params.chapterNumber) ?? params.chapterNumber;
          return `- ${h.hookId} (expected ch.${eff})`;
        }),
        "",
      );
    }
    if (approachingHooks.length > 0) {
      lines.push(
        "### Upcoming Hook Deadlines",
        "These hooks are due within the next 3 chapters. Consider advancing them:",
        ...approachingHooks.map((h) => {
          const eff = inferExpectedChapter(h, params.chapterNumber) ?? params.chapterNumber;
          return `- ${h.hookId} (expected ch.${eff})`;
        }),
        "",
      );
    }
    if (staleHooks.length > 0) {
      lines.push(
        "### Hook Debt - Must Advance",
        `These hooks have been dormant beyond their timing deadline. Each MUST show real progress:`,
        ...staleHooks.map((h) => {
          const timing = resolveHookPayoffTiming(h);
          const staleThreshold = HOOK_STALE_THRESHOLDS[timing] ?? 10;
          return `- ${h.hookId} (${h.type}, last advanced at ch.${h.lastAdvancedChapter}, stale after ${staleThreshold} chapters)`;
        }),
        "",
      );
    }
    if (resolvableHooks.length > 0) {
      lines.push(
        "### Hook Payoff - Ready to Resolve",
        "These hooks are ready to pay off. Resolve at least one:",
        ...resolvableHooks.map((h) => `- ${h.hookId} (${h.expectedPayoff || h.type}) - active since ch.${h.startChapter}`),
        "",
      );
    }
    if (dormantHooks.length > 0 && staleHooks.length === 0) {
      lines.push(
        "### Stale Hooks - Need Attention",
        "These hooks haven't been touched in 5+ chapters. Advance at least one:",
        ...dormantHooks.map((h) => `- ${h.hookId} (last advanced at ch.${h.lastAdvancedChapter})`),
        "",
      );
    }
    lines.push(
      "",
      `Recovery limit: max ${maxRecovery} hooks can be resolved in this chapter.`,
    );
  } else {
    if (overdueHooks.length > 0) {
      lines.push(
        "### 逾期伏笔——强制回收",
        `以下伏笔已超过预期回收章节，本章必须回收：`,
        ...overdueHooks.map((h) => {
          const eff = inferExpectedChapter(h, params.chapterNumber) ?? h.startChapter;
          return `- ${h.hookId}（逾期 ${params.chapterNumber - eff} 章，原预期第${eff}章回收）`;
        }),
        "",
      );
    }
    if (dueThisChapterHooks.length > 0) {
      lines.push(
        "### 本章到期伏笔",
        `以下伏笔按计划应在本章回收：`,
        ...dueThisChapterHooks.map((h) => {
          const eff = inferExpectedChapter(h, params.chapterNumber) ?? params.chapterNumber;
          return `- ${h.hookId}（预期第${eff}章回收）`;
        }),
        "",
      );
    }
    if (approachingHooks.length > 0) {
      lines.push(
        "### 即将到期伏笔",
        `以下伏笔在未来 3 章内到期，争取推进：`,
        ...approachingHooks.map((h) => {
          const eff = inferExpectedChapter(h, params.chapterNumber) ?? params.chapterNumber;
          return `- ${h.hookId}（预期第${eff}章回收）`;
        }),
        "",
      );
    }
    if (staleHooks.length > 0) {
      lines.push(
        "### 伏笔债务——必须推进",
        `以下伏笔已超过其 timing 对应的沉寂上限，本章必须发生真实推进：`,
        ...staleHooks.map((h) => {
          const timing = resolveHookPayoffTiming(h);
          const staleThreshold = HOOK_STALE_THRESHOLDS[timing] ?? 10;
          return `- ${h.hookId}（${h.type}，上次推进：第${h.lastAdvancedChapter}章，${staleThreshold}章未推进即陈旧）`;
        }),
        "",
      );
    }
    if (resolvableHooks.length > 0) {
      lines.push(
        "### 伏笔回收——成熟可收",
        "以下伏笔已满足回收条件，至少回收一条：",
        ...resolvableHooks.map((h) => `- ${h.hookId}（${h.expectedPayoff || h.type}）—— 自第${h.startChapter}章激活`),
        "",
      );
    }
    if (dormantHooks.length > 0 && staleHooks.length === 0) {
      lines.push(
        "### 伏笔关注——待推进",
        `以下伏笔已 5+ 章未推进，争取推进其中一条：`,
        ...dormantHooks.map((h) => `- ${h.hookId}（上次推进：第${h.lastAdvancedChapter}章）`),
        "",
      );
    }
    lines.push(
      "",
      `回收限制：本章最多回收 ${maxRecovery} 个伏笔（不含续写自然发展的伏笔）。`,
    );
  }

  return lines.join("\n");
}

export function isFuturePlannedHook(
  hook: StoredHook,
  chapterNumber: number,
  lookahead: number = DEFAULT_HOOK_LOOKAHEAD_CHAPTERS,
): boolean {
  return hook.lastAdvancedChapter <= 0 && hook.startChapter > chapterNumber + lookahead;
}

export function isHookWithinChapterWindow(
  hook: StoredHook,
  chapterNumber: number,
  recentWindow: number = 5,
  lookahead: number = DEFAULT_HOOK_LOOKAHEAD_CHAPTERS,
): boolean {
  const recentCutoff = Math.max(0, chapterNumber - recentWindow);

  if (hook.lastAdvancedChapter > 0 && hook.lastAdvancedChapter >= recentCutoff) {
    return true;
  }

  if (hook.lastAdvancedChapter > 0) {
    return false;
  }

  if (hook.startChapter <= 0) {
    return true;
  }

  if (hook.startChapter >= recentCutoff && hook.startChapter <= chapterNumber) {
    return true;
  }

  return hook.startChapter > chapterNumber && hook.startChapter <= chapterNumber + lookahead;
}
