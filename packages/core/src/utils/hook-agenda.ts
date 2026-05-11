import type { HookAgenda } from "../models/input-governance.js";
import type { HookRecord, HookStatus } from "../models/runtime-state.js";
import type { StoredHook } from "../state/memory-db.js";
import { resolveHookPayoffTiming, localizeHookPayoffTiming } from "./hook-lifecycle.js";
import { HOOK_HEALTH_DEFAULTS } from "./hook-policy.js";

export const DEFAULT_HOOK_LOOKAHEAD_CHAPTERS = 3;

/**
 * Build the hook agenda using simple stalest-first sorting.
 * No lifecycle pressure formulas — just pick the hooks that have been
 * dormant the longest and the ones that are ripe for resolution.
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

  // staleDebt: hooks not advanced for 10+ chapters
  const staleThreshold = params.chapterNumber - 10;
  const staleDebtHooks = agendaHooks
    .filter((hook) => {
      const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
      return lastTouch > 0 && lastTouch <= staleThreshold;
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

export function filterActiveHooks(hooks: ReadonlyArray<StoredHook>): StoredHook[] {
  return hooks.filter((hook) => normalizeStoredHookStatus(hook.status) !== "resolved");
}

/**
 * Build a hard constraint block about overdue/stale/resolvable hooks
 * for injection into writer/reviser prompts.
 */
export function buildHookDebtHardConstraintBlock(params: {
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
  readonly language?: "zh" | "en";
}): string | undefined {
  const language = params.language ?? "zh";
  const staleThreshold = params.chapterNumber - 10;

  const staleHooks = params.hooks
    .filter((hook) => {
      if (hook.status === "resolved" || hook.status === "deferred") return false;
      const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
      return lastTouch > 0 && lastTouch <= staleThreshold;
    })
    .sort((a, b) => a.lastAdvancedChapter - b.lastAdvancedChapter)
    .slice(0, 3);

  const resolvableHooks = params.hooks
    .filter((hook) => {
      if (hook.status === "resolved" || hook.status === "deferred") return false;
      return hook.startChapter <= params.chapterNumber - 3
        && hook.lastAdvancedChapter >= params.chapterNumber - 2;
    })
    .sort((a, b) => a.startChapter - b.startChapter)
    .slice(0, 2);

  const dormantHooks = params.hooks
    .filter((hook) => {
      if (hook.status === "resolved" || hook.status === "deferred") return false;
      const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
      return lastTouch > 0 && lastTouch <= params.chapterNumber - 5;
    })
    .sort((a, b) => a.lastAdvancedChapter - b.lastAdvancedChapter)
    .slice(0, 3);

  const allHooks = [...staleHooks, ...resolvableHooks, ...dormantHooks];
  if (allHooks.length === 0) return undefined;

  const lines: string[] = [];

  if (language === "en") {
    if (staleHooks.length > 0) {
      lines.push(
        "### Hook Debt - Must Advance",
        `These hooks have been dormant ${params.chapterNumber - staleThreshold}+ chapters. Each MUST show real progress:`,
        ...staleHooks.map((h) => `- ${h.hookId} (${h.type}, last advanced at ch.${h.lastAdvancedChapter})`),
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
  } else {
    if (staleHooks.length > 0) {
      lines.push(
        "### 伏笔债务——必须推进",
        `以下伏笔已沉寂 ${params.chapterNumber - staleThreshold}+ 章，本章必须发生真实推进：`,
        ...staleHooks.map((h) => `- ${h.hookId}（${h.type}，上次推进：第${h.lastAdvancedChapter}章）`),
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
