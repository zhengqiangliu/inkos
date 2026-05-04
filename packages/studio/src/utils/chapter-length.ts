export type ChapterLengthLanguage = "zh" | "en";
export type ChapterCountingMode = "zh_chars" | "en_words";

export function resolveChapterCountingMode(language: ChapterLengthLanguage = "zh"): ChapterCountingMode {
  return language === "en" ? "en_words" : "zh_chars";
}

export function countChapterLength(content: string, countingMode: ChapterCountingMode): number {
  const normalized = stripMarkdownMetadata(content);
  if (countingMode === "en_words") {
    const words = normalized.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return words?.length ?? 0;
  }
  return normalized.replace(/\s+/g, "").length;
}

export function countChapterLengthByLanguage(content: string, language: ChapterLengthLanguage = "zh"): number {
  return countChapterLength(content, resolveChapterCountingMode(language));
}

function stripMarkdownMetadata(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").split("\n");
  const proseLines: string[] = [];
  let index = 0;

  if (lines[index]?.trim() === "---") {
    index += 1;
    while (index < lines.length && lines[index]?.trim() !== "---") {
      index += 1;
    }
    if (index < lines.length) {
      index += 1;
    }
  }

  let inFence = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (trimmed === "---" || trimmed === "...") continue;

    proseLines.push(line);
  }

  return proseLines.join("\n");
}
