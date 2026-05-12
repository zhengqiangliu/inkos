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

  for (const line of lines) {
    const totalMatch = line.match(/(?:^|[^A-Za-z])(?:共|总(?:章数|计)|章节总数|总章节数|total(?:\s+chapters?)?)(?:\s*[:：]?\s*)(\d+|[零〇一二三四五六七八九十两]+)\s*章?/i)
      ?? line.match(/(?:chapter\s*(?:count|total)|total\s*chapters?)(?:\s*[:：]?\s*)(\d+|[零〇一二三四五六七八九十两]+)/i);
    if (!totalMatch) continue;

    const total = parseChineseIntegerToken(totalMatch[1] ?? "");
    if (typeof total === "number" && total > 0) return total;
  }

  const rangePatterns = [
    /(?:chapter\s*range|章节范围|章节区间|卷范围|volume range)(?:\s*[:：]?\s*)?(?:第\s*)?(\d+|[零〇一二三四五六七八九十两]+)\s*[-~–—至到]\s*(\d+|[零〇一二三四五六七八九十两]+)\s*(?:章|chapters?)?/i,
    /(?:第\s*)?(\d+|[零〇一二三四五六七八九十两]+)\s*[-~–—至到]\s*(\d+|[零〇一二三四五六七八九十两]+)\s*(?:章|chapters?)?/i,
  ];

  let maxChapter: number | null = null;
  for (const line of lines) {
    if (!/[章卷]|chapter|range|范围|区间/i.test(line)) continue;
    for (const pattern of rangePatterns) {
      const match = line.match(pattern);
      if (!match) continue;

      const end = parseChineseIntegerToken(match[2] ?? "");
      if (typeof end !== "number" || end < 1) continue;
      maxChapter = maxChapter === null ? end : Math.max(maxChapter, end);
    }
  }

  return maxChapter;
}
