import { describe, it, expect } from "vitest";
import { analyzeHookHealth } from "../utils/hook-health.js";
import type { HookRecord, RuntimeStateDelta } from "../models/runtime-state.js";

function makeHookRecord(overrides: Partial<HookRecord> & { hookId: string }): HookRecord {
  return {
    startChapter: 1,
    type: "mystery",
    status: "open",
    lastAdvancedChapter: 5,
    expectedPayoff: "",
    payoffTiming: "near-term",
    notes: "",
    ...overrides,
  };
}

function makeDelta(resolveCount: number): Pick<RuntimeStateDelta, "chapter" | "hookOps"> {
  return {
    chapter: 10,
    hookOps: {
      upsert: [],
      mention: [],
      resolve: Array.from({ length: resolveCount }, (_, i) => `H${String(i + 1).padStart(2, "0")}`),
      defer: [],
    },
  };
}

describe("analyzeHookHealth - maxResolvePerChapter", () => {
  it("warns when resolve count exceeds per-chapter cap", () => {
    const issues = analyzeHookHealth({
      language: "zh",
      chapterNumber: 10,
      hooks: [
        makeHookRecord({ hookId: "H01" }),
        makeHookRecord({ hookId: "H02" }),
        makeHookRecord({ hookId: "H03" }),
        makeHookRecord({ hookId: "H04" }),
      ],
      delta: makeDelta(4),
      existingHookIds: ["H01", "H02", "H03", "H04"],
      maxResolvePerChapter: 3,
    });
    const resolveIssues = issues.filter((i) => i.description.includes("超过每章上限"));
    expect(resolveIssues).toHaveLength(1);
  });

  it("does not warn when resolve count is within cap", () => {
    const issues = analyzeHookHealth({
      language: "en",
      chapterNumber: 10,
      hooks: [
        makeHookRecord({ hookId: "H01" }),
        makeHookRecord({ hookId: "H02" }),
      ],
      delta: makeDelta(2),
      existingHookIds: ["H01", "H02"],
      maxResolvePerChapter: 3,
    });
    const resolveIssues = issues.filter((i) => i.description.includes("exceeding"));
    expect(resolveIssues).toHaveLength(0);
  });

  it("uses HOOK_HEALTH_DEFAULTS.maxResolvePerChapter when not specified", () => {
    const issues = analyzeHookHealth({
      language: "zh",
      chapterNumber: 10,
      hooks: [
        makeHookRecord({ hookId: "H01" }),
        makeHookRecord({ hookId: "H02" }),
        makeHookRecord({ hookId: "H03" }),
        makeHookRecord({ hookId: "H04" }),
        makeHookRecord({ hookId: "H05" }),
      ],
      delta: makeDelta(5),
      existingHookIds: ["H01", "H02", "H03", "H04", "H05"],
    });
    const resolveIssues = issues.filter((i) => i.category === "伏笔债务");
    const hasResolveOverLimit = resolveIssues.some((i) => i.description.includes("超过每章上限"));
    expect(hasResolveOverLimit).toBe(true);
  });
});
