import type { AutoReviewProgressState } from "../store/chat/types";

export type AutoReviewTone = "info" | "success" | "warning" | "danger" | "muted";

export interface AutoReviewDisplay {
  readonly text: string;
  readonly compactText: string;
  readonly tone: AutoReviewTone;
  readonly meta?: ReadonlyArray<string>;
}

export interface AutoReviewChapterState {
  readonly phase: "audit" | "revise" | "stopped";
  readonly round: number;
  readonly maxRounds: number;
  readonly reason?: string;
}

function normalizeReviseRoundsUsed(state: {
  readonly phase: "audit" | "revise";
  readonly reviseRoundsUsed?: number;
  readonly round: number;
  readonly maxRounds: number;
}): number {
  const fallback = state.phase === "revise"
    ? Math.max(1, state.round)
    : Math.max(0, state.round - 1);
  const raw = Number.isFinite(Number(state.reviseRoundsUsed)) ? Number(state.reviseRoundsUsed) : fallback;
  return Math.max(0, Math.min(Math.trunc(raw), Math.max(0, state.maxRounds)));
}

function buildExecutionAutoReviewMeta(state: AutoReviewProgressState): ReadonlyArray<string> {
  const meta: string[] = [];
  if (state.failureGate && state.failureGate !== "none") {
    meta.push(`门禁 ${state.failureGate}`);
  }
  if (Array.isArray(state.failedDimensions) && state.failedDimensions.length > 0) {
    meta.push(`失败维度 ${state.failedDimensions.length}`);
  }
  if (typeof state.mustFixUnresolvedCount === "number") {
    const total = typeof state.mustFixTotalCount === "number"
      ? Math.max(state.mustFixTotalCount, state.mustFixUnresolvedCount)
      : undefined;
    meta.push(total !== undefined
      ? `关键未收敛 ${state.mustFixUnresolvedCount}/${total}`
      : `关键未收敛 ${state.mustFixUnresolvedCount}`);
  }
  if (typeof state.strategyReason === "string" && state.strategyReason.trim().length > 0) {
    meta.push(`策略 ${state.strategyReason.trim()}`);
  }
  return meta;
}

export function describeExecutionAutoReview(state: AutoReviewProgressState | undefined): AutoReviewDisplay | null {
  if (!state) return null;
  if (!state.enabled || state.maxRounds <= 0) {
    return {
      text: "自动闭环：关闭",
      compactText: "自动闭环：关闭",
      tone: "muted",
    };
  }

  const reviseRoundsUsed = normalizeReviseRoundsUsed(state);
  const currentRound = Math.max(1, Math.trunc(state.round));
  const reviseRoundText = `${currentRound}/${state.maxRounds}`;
  if (state.phase === "revise" && !state.final) {
    const meta = buildExecutionAutoReviewMeta(state);
    return {
      text: `自动修订：第${reviseRoundText}轮`,
      compactText: `自动修订 ${reviseRoundText}`,
      tone: "info",
      ...(meta.length > 0 ? { meta } : {}),
    };
  }
  if (state.phase === "audit" && !state.final) {
    const meta = buildExecutionAutoReviewMeta(state);
    return {
      text: `自动复审：第${state.round}/${state.maxRounds + 1}轮`,
      compactText: `自动复审 ${state.round}/${state.maxRounds + 1}`,
      tone: "info",
      ...(meta.length > 0 ? { meta } : {}),
    };
  }
  if (state.state === "passed" || state.passed === true) {
    const meta = buildExecutionAutoReviewMeta(state);
    return {
      text: `自动闭环：通过（修订${reviseRoundText}轮）`,
      compactText: `自动闭环通过 ${reviseRoundText}`,
      tone: "success",
      ...(meta.length > 0 ? { meta } : {}),
    };
  }
  if (state.state === "failed-max-rounds") {
    const meta = buildExecutionAutoReviewMeta(state);
    return {
      text: `自动闭环：未通过（已达${state.maxRounds}轮上限）`,
      compactText: `自动闭环失败 ${state.maxRounds}/${state.maxRounds}`,
      tone: "danger",
      ...(meta.length > 0 ? { meta } : {}),
    };
  }
  if (state.state === "failed-single-audit") {
    const meta = buildExecutionAutoReviewMeta(state);
    return {
      text: "自动闭环：未通过（单轮审计）",
      compactText: "自动闭环失败 单轮",
      tone: "danger",
      ...(meta.length > 0 ? { meta } : {}),
    };
  }
  if (state.final) {
    const meta = buildExecutionAutoReviewMeta(state);
    return {
      text: `自动闭环：结束（修订${reviseRoundText}轮）`,
      compactText: `自动闭环结束 ${reviseRoundText}`,
      tone: "warning",
      ...(meta.length > 0 ? { meta } : {}),
    };
  }
  return null;
}

export function describeChapterAutoReview(state: AutoReviewChapterState | undefined): AutoReviewDisplay | null {
  if (!state || state.maxRounds <= 0) return null;
  const round = Math.max(1, Math.trunc(state.round));
  if (state.phase === "revise") {
    return {
      text: `自动修订：第${round}/${state.maxRounds}轮`,
      compactText: `自动修订 ${round}/${state.maxRounds}`,
      tone: "info",
    };
  }
  if (state.phase === "audit") {
    return {
      text: `自动复审：第${round}/${state.maxRounds + 1}轮`,
      compactText: `自动复审 ${round}/${state.maxRounds + 1}`,
      tone: "info",
    };
  }
  if (state.reason && state.reason.trim().length > 0) {
    return {
      text: `自动修订已中止：${state.reason.trim()}`,
      compactText: "自动修订已中止",
      tone: "danger",
    };
  }
  return {
    text: `自动修订已中止：达到${state.maxRounds}轮上限`,
    compactText: "自动修订已中止",
    tone: "danger",
  };
}
