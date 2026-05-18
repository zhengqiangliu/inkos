const CHINESE_NUMERALS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  两: 2,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseIntegerToken(token: string): number | null {
  const raw = token.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (raw === "十") return 10;
  if (raw.length === 1 && raw in CHINESE_NUMERALS) {
    const value = CHINESE_NUMERALS[raw];
    return typeof value === "number" ? value : null;
  }

  const tenMatch = raw.match(/^([一二三四五六七八九两])?十([一二三四五六七八九两])?$/);
  if (tenMatch) {
    const tens = tenMatch[1] ? (CHINESE_NUMERALS[tenMatch[1]] ?? 0) : 1;
    const ones = tenMatch[2] ? (CHINESE_NUMERALS[tenMatch[2]] ?? 0) : 0;
    return tens * 10 + ones;
  }

  return null;
}

export function extractChapterLimitFromOutline(outline: string): number | null {
  const lines = outline.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const chapterMarkers = /(?:第\s*)?(\d+|[零〇一二三四五六七八九十两]+)\s*章(?:\s*[-~–—至到]\s*(?:第\s*)?(\d+|[零〇一二三四五六七八九十两]+)\s*章?)?/gi;
  const chapterTotalPattern = /(?:总章数|章节总数|总章节数|total(?:\s+chapters?)?|chapter(?:\s+count|\s+total)?)(?:\s*[:：]?\s*)(\d+|[零〇一二三四五六七八九十两]+)(?:\s*章)?/i;

  let maxChapter: number | null = null;
  for (const line of lines) {
    const totalMatch = line.match(chapterTotalPattern);
    if (totalMatch) {
      const total = parseChineseIntegerToken(totalMatch[1] ?? "");
      if (typeof total === "number" && total > 0) return total;
    }

    let match: RegExpExecArray | null;
    chapterMarkers.lastIndex = 0;
    while ((match = chapterMarkers.exec(line)) !== null) {
      const start = parseChineseIntegerToken(match[1] ?? "");
      if (typeof start === "number" && start > 0) {
        maxChapter = maxChapter === null ? start : Math.max(maxChapter, start);
      }
      const end = parseChineseIntegerToken(match[2] ?? "");
      if (typeof end === "number" && end > 0) {
        maxChapter = maxChapter === null ? end : Math.max(maxChapter, end);
      }
    }
  }

  return maxChapter;
}
