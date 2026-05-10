import { describe, expect, it } from "vitest";
import {
  extractHookSeedKeywords,
  findMissingOverdueHooksInContent,
  verifyResolveClaims,
} from "../utils/hook-content-verify.js";
import type { ContextPackage } from "../models/input-governance.js";

describe("hook-content-verify", () => {
  describe("extractHookSeedKeywords", () => {
    describe("Chinese keywords", () => {
      it("extracts 2+ char tokens and bigrams from Chinese text", () => {
        const keywords = extractHookSeedKeywords("胖虎借条 林秋第一次想撕", "zh");
        // Full tokens
        expect(keywords).toContain("胖虎借条");
        // Bigrams from "林秋第一次想撕" (7 chars): 林秋, 秋第, 第一, 一次, 次想, 想撕
        expect(keywords).toContain("林秋");
        expect(keywords).toContain("第一");
        expect(keywords).toContain("一次");
        expect(keywords).toContain("次想");
        expect(keywords).toContain("想撕");
        expect(keywords).toContain("秋第");
      });

      it("includes 2-char bigrams from 3+ char tokens", () => {
        const keywords = extractHookSeedKeywords("守拙诀来历", "zh");
        expect(keywords).toContain("守拙诀来历");
        expect(keywords).toContain("守拙");
        expect(keywords).toContain("拙诀");
        expect(keywords).toContain("来历");
      });

      it("filters pure stop-word tokens", () => {
        const keywords = extractHookSeedKeywords("的 了 是 在", "zh");
        // All single-char stop words → no 2+ char tokens
        expect(keywords.length).toBe(0);
      });

      it("deduplicates keywords", () => {
        const keywords = extractHookSeedKeywords("大大 大大", "zh");
        const deduped = keywords.filter((kw) => kw === "大大");
        expect(deduped).toHaveLength(1);
      });
    });

    describe("English keywords", () => {
      it("extracts content words with >3 chars", () => {
        const keywords = extractHookSeedKeywords(
          "The mentor broke his sacred oath",
          "en",
        );
        expect(keywords).toContain("mentor");
        expect(keywords).toContain("broke");
        expect(keywords).toContain("sacred");
        // "the" is a stop word, "his" is a stop word
        expect(keywords).not.toContain("the");
        expect(keywords).not.toContain("his");
      });

      it("handles punctuation and spacing", () => {
        const keywords = extractHookSeedKeywords(
          "The ledger-fragment's origin: a secret vault.",
          "en",
        );
        expect(keywords).toContain("ledger");
        expect(keywords).toContain("fragment");
        expect(keywords).toContain("origin");
        expect(keywords).toContain("secret");
        expect(keywords).toContain("vault");
      });

      it("returns empty array for short/stop words only", () => {
        const keywords = extractHookSeedKeywords("a an the it is", "en");
        expect(keywords).toHaveLength(0);
      });
    });
  });

  describe("findMissingOverdueHooksInContent", () => {
    function makeDebtEntry(
      hookId: string,
      seedText: string,
      language: "zh" | "en",
    ): ContextPackage["selectedContext"][number] {
      const overdueMarker = language === "en" ? "⚠OVERDUE" : "⚠逾期";
      const seedPrefix = language === "en" ? "original seed (ch5):" : "种于第5章：";
      return {
        source: `runtime/hook_debt#${hookId}`,
        reason: "debt brief",
        excerpt: `[mid-arc, ${overdueMarker}, dorm 5ch] ${hookId} | reader promise: ... | ${seedPrefix} ${seedText}`,
      };
    }

    it("returns missing overdue hooks whose seed keywords are absent from content", () => {
      const ctx: ContextPackage = {
        chapter: 10,
        selectedContext: [
          makeDebtEntry("mentor-oath", "胖虎借条 守拙诀来历", "zh"),
        ],
      };
      const content = "林秋走在山路上，思考着今天的修行。";

      const missing = findMissingOverdueHooksInContent(ctx, content, "zh");
      expect(missing).toContain("mentor-oath");
    });

    it("does not flag hooks whose seed keywords appear in content", () => {
      const ctx: ContextPackage = {
        chapter: 10,
        selectedContext: [
          makeDebtEntry("mentor-oath", "胖虎借条 守拙诀来历", "zh"),
        ],
      };
      const content = "林秋拿出胖虎借条，仔细端详着上面的字迹。";

      const missing = findMissingOverdueHooksInContent(ctx, content, "zh");
      expect(missing).not.toContain("mentor-oath");
    });

    it("works with English content", () => {
      const ctx: ContextPackage = {
        chapter: 10,
        selectedContext: [
          makeDebtEntry("mentor-oath", "mentor broke sacred oath", "en"),
        ],
      };
      const content = "The mentor stood before the council, his oath shattered.";

      const missing = findMissingOverdueHooksInContent(ctx, content, "en");
      expect(missing).not.toContain("mentor-oath");
    });

    it("returns empty array when no overdue hooks in context", () => {
      const ctx: ContextPackage = {
        chapter: 10,
        selectedContext: [
          {
            source: "runtime/hook_debt#mentor-oath",
            reason: "debt brief",
            excerpt: "[slow-burn, STALE, dorm 5ch] mentor-oath | ...",
          },
        ],
      };
      const content = "anything";

      const missing = findMissingOverdueHooksInContent(ctx, content, "zh");
      expect(missing).toHaveLength(0);
    });

    it("returns empty array when seed text is empty or unparseable", () => {
      const ctx: ContextPackage = {
        chapter: 10,
        selectedContext: [
          {
            source: "runtime/hook_debt#empty-seed",
            reason: "debt brief",
            excerpt: "[mid-arc, ⚠逾期] empty-seed | 读者承诺：nothing | ",
          },
        ],
      };
      const content = "anything";

      const missing = findMissingOverdueHooksInContent(ctx, content, "zh");
      expect(missing).toHaveLength(0);
    });

    it("handles multiple overdue hooks, returning only the missing ones", () => {
      const ctx: ContextPackage = {
        chapter: 10,
        selectedContext: [
          makeDebtEntry("hook-present", "玄铁重剑", "zh"),
          makeDebtEntry("hook-missing", "七星海棠", "zh"),
        ],
      };
      const content = "他握紧玄铁重剑，感受着剑身的重量。";

      const missing = findMissingOverdueHooksInContent(ctx, content, "zh");
      expect(missing).not.toContain("hook-present");
      expect(missing).toContain("hook-missing");
    });

    it("matches keywords case-insensitively", () => {
      const ctx: ContextPackage = {
        chapter: 10,
        selectedContext: [
          makeDebtEntry("secret-letter", "Secret Letter", "en"),
        ],
      };
      const content = "The SECRET LETTER was found in the drawer.";

      const missing = findMissingOverdueHooksInContent(ctx, content, "en");
      expect(missing).not.toContain("secret-letter");
    });
  });

  describe("verifyResolveClaims", () => {
    const hooks = [
      { hookId: "mentor-oath", expectedPayoff: "胖虎借条 守拙诀来历", notes: "债务关系" },
      { hookId: "kiln-key", expectedPayoff: "secret vault key origin", notes: "The kiln holds the key" },
      { hookId: "empty-hook", expectedPayoff: "", notes: "" },
    ];

    it("returns empty when no resolved hook IDs", () => {
      const result = verifyResolveClaims({
        content: "anything",
        resolvedHookIds: [],
        hooks,
        language: "zh",
      });
      expect(result).toHaveLength(0);
    });

    it("flags resolved hooks whose keywords are absent from content", () => {
      const result = verifyResolveClaims({
        content: "山路上落叶满地，秋意渐浓。",
        resolvedHookIds: ["mentor-oath"],
        hooks,
        language: "zh",
      });
      expect(result).toContain("mentor-oath");
    });

    it("does not flag resolved hooks whose keywords appear in content", () => {
      const result = verifyResolveClaims({
        content: "他拿出胖虎借条，查看守拙诀来历。",
        resolvedHookIds: ["mentor-oath"],
        hooks,
        language: "zh",
      });
      expect(result).not.toContain("mentor-oath");
    });

    it("works with English content", () => {
      const result = verifyResolveClaims({
        content: "The secret vault key was hidden in the kiln.",
        resolvedHookIds: ["kiln-key"],
        hooks,
        language: "en",
      });
      expect(result).not.toContain("kiln-key");
    });

    it("flags English hooks absent from content", () => {
      const result = verifyResolveClaims({
        content: "The weather was nice today.",
        resolvedHookIds: ["kiln-key"],
        hooks,
        language: "en",
      });
      expect(result).toContain("kiln-key");
    });

    it("skips hooks with empty seed text", () => {
      const result = verifyResolveClaims({
        content: "anything",
        resolvedHookIds: ["empty-hook"],
        hooks,
        language: "zh",
      });
      expect(result).not.toContain("empty-hook");
    });

    it("handles multiple resolved hooks, returning only unverified ones", () => {
      const result = verifyResolveClaims({
        content: "他握紧守拙诀来历，胖虎借条清晰可见。",
        resolvedHookIds: ["mentor-oath", "kiln-key"],
        hooks,
        language: "zh",
      });
      // mentor-oath keywords (胖虎借条, 守拙诀来历) are in content
      expect(result).not.toContain("mentor-oath");
      // kiln-key is English but checking Chinese content → no match
      expect(result).toContain("kiln-key");
    });

    it("matches keywords case-insensitively", () => {
      const hooksEn = [
        { hookId: "secret-letter", expectedPayoff: "Secret Letter contents", notes: "hidden" },
      ];
      const result = verifyResolveClaims({
        content: "The SECRET LETTER was read by the king.",
        resolvedHookIds: ["secret-letter"],
        hooks: hooksEn,
        language: "en",
      });
      expect(result).not.toContain("secret-letter");
    });
  });
});
