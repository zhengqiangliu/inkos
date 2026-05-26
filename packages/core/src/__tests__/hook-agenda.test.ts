import { describe, it, expect } from "vitest";
import type { StoredHook } from "../state/memory-db.js";
import {
  buildHookDebtHardConstraintBlock,
  buildPlannerHookAgenda,
  filterActiveHooks,
  isFuturePlannedHook,
  isHookWithinChapterWindow,
} from "../utils/hook-agenda.js";

function makeHook(overrides: Partial<StoredHook> & { hookId: string }): StoredHook {
  return {
    startChapter: 0,
    lastAdvancedChapter: 0,
    type: "mystery",
    status: "open",
    expectedPayoff: "",
    payoffTiming: undefined,
    notes: "",
    ...overrides,
  };
}

describe("buildHookDebtHardConstraintBlock", () => {
  it("returns undefined when no stale or resolvable hooks", () => {
    const result = buildHookDebtHardConstraintBlock({
      hooks: [
        makeHook({ hookId: "H01", startChapter: 8, lastAdvancedChapter: 9 }),
        makeHook({ hookId: "H02", startChapter: 9, lastAdvancedChapter: 9 }),
      ],
      chapterNumber: 10,
      language: "zh",
    });
    expect(result).toBeUndefined();
  });

  it("returns stale hooks block for hooks dormant beyond timing threshold", () => {
    const result = buildHookDebtHardConstraintBlock({
      hooks: [
        makeHook({ hookId: "H01", startChapter: 1, lastAdvancedChapter: 1, type: "character" }),
        makeHook({ hookId: "H02", startChapter: 5, lastAdvancedChapter: 10 }),
      ],
      chapterNumber: 15,
      language: "zh",
    });
    expect(result).toContain("必须推进");
    expect(result).toContain("H01");
    expect(result).not.toContain("H02");
  });

  it("returns resolvable hooks block for hooks ready to pay off", () => {
    const result = buildHookDebtHardConstraintBlock({
      hooks: [
        makeHook({ hookId: "H01", startChapter: 10, lastAdvancedChapter: 13, expectedPayoff: "reveal truth", payoffTiming: "slow-burn" }),
        makeHook({ hookId: "H02", startChapter: 10, lastAdvancedChapter: 14 }),
      ],
      chapterNumber: 15,
      language: "en",
    });
    expect(result).toContain("Ready to Resolve");
    expect(result).toContain("H01");
    expect(result).toContain("reveal truth");
  });

  it("filters out resolved and deferred hooks", () => {
    const result = buildHookDebtHardConstraintBlock({
      hooks: [
        makeHook({ hookId: "H01", startChapter: 1, lastAdvancedChapter: 1, status: "resolved" }),
        makeHook({ hookId: "H02", startChapter: 1, lastAdvancedChapter: 1, status: "deferred" }),
      ],
      chapterNumber: 15,
      language: "zh",
    });
    expect(result).toBeUndefined();
  });

  it("returns dormant block when no 10+ chapter stale hooks exist", () => {
    const result = buildHookDebtHardConstraintBlock({
      hooks: [
        makeHook({ hookId: "H01", startChapter: 6, lastAdvancedChapter: 7 }),
      ],
      chapterNumber: 12,
      language: "zh",
    });
    expect(result).toContain("待推进");
    expect(result).toContain("H01");
  });

  it("localizes to English correctly", () => {
    const result = buildHookDebtHardConstraintBlock({
      hooks: [
        makeHook({ hookId: "H01", startChapter: 1, lastAdvancedChapter: 1 }),
      ],
      chapterNumber: 15,
      language: "en",
    });
    expect(result).toContain("Must Advance");
    expect(result).toContain("H01");
  });
});

describe("buildPlannerHookAgenda", () => {
  it("sorts mustAdvance by stalest first", () => {
    const hooks = [
      makeHook({ hookId: "H03", startChapter: 5, lastAdvancedChapter: 6 }),
      makeHook({ hookId: "H01", startChapter: 1, lastAdvancedChapter: 2 }),
      makeHook({ hookId: "H02", startChapter: 3, lastAdvancedChapter: 4 }),
    ];
    const agenda = buildPlannerHookAgenda({ hooks, chapterNumber: 10, maxMustAdvance: 3 });
    expect(agenda.mustAdvance).toEqual(["H01", "H02", "H03"]);
  });

  it("excludes resolved hooks", () => {
    const hooks = [
      makeHook({ hookId: "H01", startChapter: 1, lastAdvancedChapter: 2, status: "resolved" }),
      makeHook({ hookId: "H02", startChapter: 3, lastAdvancedChapter: 4 }),
    ];
    const agenda = buildPlannerHookAgenda({ hooks, chapterNumber: 10 });
    expect(agenda.mustAdvance).not.toContain("H01");
    expect(agenda.mustAdvance).toContain("H02");
  });

  it("excludes deferred hooks", () => {
    const hooks = [
      makeHook({ hookId: "H01", startChapter: 1, lastAdvancedChapter: 2, status: "deferred" }),
      makeHook({ hookId: "H02", startChapter: 3, lastAdvancedChapter: 4 }),
    ];
    const agenda = buildPlannerHookAgenda({ hooks, chapterNumber: 10 });
    expect(agenda.mustAdvance).not.toContain("H01");
    expect(agenda.mustAdvance).toContain("H02");
  });

  it("filters future planned hooks (startChapter too far ahead)", () => {
    const hooks = [
      makeHook({ hookId: "H01", startChapter: 10, lastAdvancedChapter: 0 }),
      makeHook({ hookId: "H02", startChapter: 14, lastAdvancedChapter: 0 }),
    ];
    const agenda = buildPlannerHookAgenda({ hooks, chapterNumber: 5 });
    expect(agenda.mustAdvance).not.toContain("H02");
  });
});

describe("filterActiveHooks", () => {
  it("filters out resolved hooks", () => {
    const hooks = [
      makeHook({ hookId: "H01", status: "resolved" }),
      makeHook({ hookId: "H02", status: "open" }),
    ];
    expect(filterActiveHooks(hooks)).toHaveLength(1);
    expect(filterActiveHooks(hooks)[0]!.hookId).toBe("H02");
  });

  it("treats Chinese status '已回收' as resolved", () => {
    const hooks = [makeHook({ hookId: "H01", status: "已回收" })];
    expect(filterActiveHooks(hooks)).toHaveLength(0);
  });
});

describe("isFuturePlannedHook", () => {
  it("returns true when startChapter > chapterNumber + lookahead and not yet advanced", () => {
    expect(isFuturePlannedHook(makeHook({ hookId: "H01", startChapter: 15, lastAdvancedChapter: 0 }), 5, 3)).toBe(true);
  });

  it("returns false when within lookahead range", () => {
    expect(isFuturePlannedHook(makeHook({ hookId: "H01", startChapter: 8, lastAdvancedChapter: 0 }), 5, 3)).toBe(false);
  });
});

describe("isHookWithinChapterWindow", () => {
  it("returns true for hooks advanced recently", () => {
    expect(isHookWithinChapterWindow(makeHook({ hookId: "H01", lastAdvancedChapter: 9 }), 10, 5)).toBe(true);
  });

  it("returns false for hooks last advanced outside the window", () => {
    expect(isHookWithinChapterWindow(makeHook({ hookId: "H01", lastAdvancedChapter: 4 }), 10, 5)).toBe(false);
  });
});
