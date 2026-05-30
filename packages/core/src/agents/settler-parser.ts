import type { GenreProfile } from "../models/genre-profile.js";

export interface SettlementOutput {
  readonly postSettlement: string;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly chapterSummary: string;
  readonly updatedSubplots: string;
  readonly updatedEmotionalArcs: string;
  readonly updatedCharacterMatrix: string;
}

export function parseSettlementOutput(
  content: string,
  genreProfile: GenreProfile,
): SettlementOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const extractPreludeBeforeSection = (endTags: ReadonlyArray<string>): string => {
    const endIndices = endTags
      .map((tag) => {
        const marker = `=== ${tag} ===`;
        const index = content.indexOf(marker);
        return index >= 0 ? index : Number.POSITIVE_INFINITY;
      })
      .filter((value) => Number.isFinite(value));
    const endIndex = endIndices.length > 0 ? Math.min(...endIndices) : content.length;
    return content.slice(0, endIndex).trim();
  };

  return {
    postSettlement: extract("POST_SETTLEMENT") || extractPreludeBeforeSection(["UPDATED_STATE", "UPDATED_LEDGER", "UPDATED_HOOKS", "CHAPTER_SUMMARY", "UPDATED_SUBPLOTS", "UPDATED_EMOTIONAL_ARCS", "UPDATED_CHARACTER_MATRIX"]),
    updatedState: extract("UPDATED_STATE") || "(状态卡未更新)",
    updatedLedger: genreProfile.numericalSystem
      ? (extract("UPDATED_LEDGER") || "(账本未更新)")
      : "",
    updatedHooks: extract("UPDATED_HOOKS") || "(伏笔池未更新)",
    chapterSummary: extract("CHAPTER_SUMMARY"),
    updatedSubplots: extract("UPDATED_SUBPLOTS"),
    updatedEmotionalArcs: extract("UPDATED_EMOTIONAL_ARCS"),
    updatedCharacterMatrix: extract("UPDATED_CHARACTER_MATRIX"),
  };
}
