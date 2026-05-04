import type { GenreProfile } from "../models/genre-profile.js";
import type { LengthCountingMode } from "../models/length-governance.js";
import type { WriteChapterOutput } from "./writer.js";
import { countChapterLength } from "../utils/length-metrics.js";

export interface CreativeOutput {
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly preWriteCheck: string;
  readonly reasoningLeakDetected?: boolean;
  readonly fallbackRejected?: boolean;
  readonly sanitizedCharsRemoved?: number;
}

export function parseCreativeOutput(
  chapterNumber: number,
  content: string,
  countingMode: LengthCountingMode = "zh_chars",
): CreativeOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const taggedChapterContent = extract("CHAPTER_CONTENT");
  let chapterContent = taggedChapterContent;
  let fallbackRejected = false;
  const reasoningLeakDetected = containsReasoningLeakIndicators(content);
  let sanitizedCharsRemoved = 0;

  // Fallback: if === TAG === parsing fails (common with local/small models),
  // try to extract usable content from the raw output
  if (!chapterContent) {
    const fallback = fallbackExtractContent(content, countingMode);
    chapterContent = fallback.content;
    fallbackRejected = fallback.blockedByReasoning;
    sanitizedCharsRemoved += fallback.sanitizedCharsRemoved;
  } else {
    const sanitized = sanitizeChapterNarrative(chapterContent);
    chapterContent = sanitized.content;
    sanitizedCharsRemoved += sanitized.removedChars;
  }

  let title = extract("CHAPTER_TITLE");
  if (!title) {
    title = fallbackExtractTitle(content, chapterNumber, countingMode);
  }

  return {
    title,
    content: chapterContent,
    wordCount: countChapterLength(chapterContent, countingMode),
    preWriteCheck: extract("PRE_WRITE_CHECK"),
    ...(reasoningLeakDetected ? { reasoningLeakDetected: true } : {}),
    ...(fallbackRejected ? { fallbackRejected: true } : {}),
    ...(sanitizedCharsRemoved > 0 ? { sanitizedCharsRemoved } : {}),
  };
}

interface SanitizedNarrative {
  readonly content: string;
  readonly removedChars: number;
}

interface FallbackExtractionResult {
  readonly content: string;
  readonly blockedByReasoning: boolean;
  readonly sanitizedCharsRemoved: number;
}

const REASONING_BLOCK_PATTERNS: ReadonlyArray<RegExp> = [
  /<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi,
  /<\s*analysis\b[^>]*>[\s\S]*?<\s*\/\s*analysis\s*>/gi,
  /(?:^|\n)```(?:thinking|reasoning|analysis|thoughts?)\b[\s\S]*?```/gim,
  /(?:^|\n)\s*#{1,6}\s*(?:思考过程|推理过程|analysis|reasoning|thinking)\b[\s\S]*?(?=\n\s*#{1,6}\s|\n\s*===\s*[A-Z_]+\s*===|$)/gim,
];

const REASONING_LINE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*(?:思考过程|推理过程|analysis|reasoning|thinking)\s*[:：].*$/i,
  /^\s*(?:-|\*|\d+\.)?\s*(?:analysis|reasoning|thinking)\s*[:：].*$/i,
];

const PARSER_META_LINE_PATTERN = /^(?:PRE_WRITE_CHECK|CHAPTER_TITLE|CHAPTER_CONTENT|POST_SETTLEMENT|UPDATED_STATE|UPDATED_LEDGER|UPDATED_HOOKS|CHAPTER_SUMMARY|UPDATED_SUBPLOTS|UPDATED_EMOTIONAL_ARCS|UPDATED_CHARACTER_MATRIX)\b[:：]?/i;

function containsReasoningLeakIndicators(raw: string): boolean {
  return (
    /<\s*think\b/i.test(raw)
    || /<\s*analysis\b/i.test(raw)
    || /(?:^|\n)```(?:thinking|reasoning|analysis|thoughts?)\b/i.test(raw)
    || /(?:^|\n)\s*(?:思考过程|推理过程|analysis|reasoning|thinking)\s*[:：]/i.test(raw)
    || /(?:^|\n)\s*#{1,6}\s*(?:思考过程|推理过程|analysis|reasoning|thinking)\b/i.test(raw)
  );
}

function sanitizeChapterNarrative(raw: string): SanitizedNarrative {
  let next = raw;
  const originalLength = raw.length;
  for (const pattern of REASONING_BLOCK_PATTERNS) {
    next = next.replace(pattern, "\n");
  }

  const lines = next.split("\n");
  const keptLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^===\s*[A-Z_]+\s*===/.test(trimmed)) continue;
    if (PARSER_META_LINE_PATTERN.test(trimmed)) continue;
    if (REASONING_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;
    keptLines.push(line);
  }
  const normalized = keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    content: normalized,
    removedChars: Math.max(0, originalLength - normalized.length),
  };
}

/**
 * Fallback content extraction when === CHAPTER_CONTENT === tag is missing.
 * Tries common patterns from local/small models, then falls back to
 * stripping metadata and returning the longest prose block.
 */
function fallbackExtractContent(raw: string, countingMode: LengthCountingMode): FallbackExtractionResult {
  if (containsReasoningLeakIndicators(raw)) {
    return {
      content: "",
      blockedByReasoning: true,
      sanitizedCharsRemoved: 0,
    };
  }

  const finalize = (candidate: string): FallbackExtractionResult => {
    const sanitized = sanitizeChapterNarrative(candidate);
    return {
      content: sanitized.content.length > 100 ? sanitized.content : "",
      blockedByReasoning: false,
      sanitizedCharsRemoved: sanitized.removedChars,
    };
  };

  // Try markdown heading: # 第N章 ... followed by content
  const headingMatch = raw.match(/^#\s*第\d+章[^\n]*\n+([\s\S]+)/m);
  if (headingMatch) {
    return finalize(headingMatch[1]!.trim());
  }

  if (countingMode === "en_words") {
    const englishHeadingMatch = raw.match(/^#\s*Chapter\s+\d+(?::|\s+)([^\n]*)\n+([\s\S]+)/im);
    if (englishHeadingMatch) {
      return finalize(englishHeadingMatch[2]!.trim());
    }
  }

  // Try "正文" or "内容" labeled section
  const labelMatch = raw.match(/(?:正文|内容|章节内容)[：:]\s*\n+([\s\S]+)/);
  if (labelMatch) {
    return finalize(labelMatch[1]!.trim());
  }

  if (countingMode === "en_words") {
    const englishLabelMatch = raw.match(/(?:content|chapter content)[：:]\s*\n+([\s\S]+)/i);
    if (englishLabelMatch) {
      return finalize(englishLabelMatch[1]!.trim());
    }
  }

  // Last resort: strip lines that look like metadata/tags, keep the rest
  const lines = raw.split("\n");
  const proseLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip tag-like lines, empty lines at boundaries, and short key-value lines
    if (/^===\s*[A-Z_]+\s*===/.test(trimmed)) return false;
    if (/^(PRE_WRITE_CHECK|CHAPTER_TITLE|章节标题|写作自检)[：:]/.test(trimmed)) return false;
    return true;
  });
  return finalize(proseLines.join("\n").trim());
}

/**
 * Fallback title extraction when === CHAPTER_TITLE === tag is missing.
 */
function fallbackExtractTitle(
  raw: string,
  chapterNumber: number,
  countingMode: LengthCountingMode,
): string {
  // Try: # 第N章 Title
  const headingMatch = raw.match(/^#\s*第\d+章\s*(.+)/m);
  if (headingMatch) {
    return headingMatch[1]!.trim();
  }
  if (countingMode === "en_words") {
    const englishHeadingMatch = raw.match(/^#\s*Chapter\s+\d+(?::|\s+)\s*(.+)/im);
    if (englishHeadingMatch) {
      return englishHeadingMatch[1]!.trim();
    }
  }
  // Try: 章节标题：Title or CHAPTER_TITLE: Title (without === delimiters)
  const labelMatch = raw.match(/(?:章节标题|CHAPTER_TITLE)[：:]\s*(.+)/);
  if (labelMatch) {
    return labelMatch[1]!.trim();
  }
  return defaultChapterTitle(chapterNumber, countingMode);
}

export type ParsedWriterOutput = Omit<WriteChapterOutput, "postWriteErrors" | "postWriteWarnings">;

/**
 * Parse LLM output that uses === TAG === delimiters into structured chapter data.
 * Shared by WriterAgent (writing new chapters) and ChapterAnalyzerAgent (analyzing existing chapters).
 */
export function parseWriterOutput(
  chapterNumber: number,
  content: string,
  genreProfile: GenreProfile,
  countingMode: LengthCountingMode = "zh_chars",
): ParsedWriterOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const chapterContent = extract("CHAPTER_CONTENT");

  return {
    chapterNumber,
    title: extract("CHAPTER_TITLE") || defaultChapterTitle(chapterNumber, countingMode),
    content: chapterContent,
    wordCount: countChapterLength(chapterContent, countingMode),
    preWriteCheck: extract("PRE_WRITE_CHECK"),
    postSettlement: extract("POST_SETTLEMENT"),
    updatedState: extract("UPDATED_STATE") || defaultStatePlaceholder(countingMode),
    updatedLedger: genreProfile.numericalSystem
      ? (extract("UPDATED_LEDGER") || defaultLedgerPlaceholder(countingMode))
      : "",
    updatedHooks: extract("UPDATED_HOOKS") || defaultHooksPlaceholder(countingMode),
    chapterSummary: extract("CHAPTER_SUMMARY"),
    updatedSubplots: extract("UPDATED_SUBPLOTS"),
    updatedEmotionalArcs: extract("UPDATED_EMOTIONAL_ARCS"),
    updatedCharacterMatrix: extract("UPDATED_CHARACTER_MATRIX"),
  };
}

function defaultChapterTitle(
  chapterNumber: number,
  countingMode: LengthCountingMode,
): string {
  return countingMode === "en_words" ? `Chapter ${chapterNumber}` : `第${chapterNumber}章`;
}

function defaultStatePlaceholder(countingMode: LengthCountingMode): string {
  return countingMode === "en_words" ? "(state card not updated)" : "(状态卡未更新)";
}

function defaultLedgerPlaceholder(countingMode: LengthCountingMode): string {
  return countingMode === "en_words" ? "(ledger not updated)" : "(账本未更新)";
}

function defaultHooksPlaceholder(countingMode: LengthCountingMode): string {
  return countingMode === "en_words" ? "(hooks pool not updated)" : "(伏笔池未更新)";
}
