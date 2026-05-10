import type { ContextPackage } from "../models/input-governance.js";

const ZH_STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人",
  "都", "一", "个", "上", "也", "很", "到", "说", "要", "去",
  "你", "这", "他", "她", "它", "们", "那", "为", "以", "能",
  "之", "与", "而", "但", "把", "被", "让", "从", "向", "对",
  "着", "过", "吗", "呢", "啊", "哦", "嗯", "嘛", "吧", "呀",
  "会", "可", "没", "来", "出", "进", "回", "开", "起", "做",
  "看", "听", "走", "跑", "拿", "放", "找", "问", "答", "给",
]);

const EN_STOP_WORDS = new Set([
  "the", "a", "an", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "shall",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "until", "against",
  "and", "but", "or", "nor", "not", "so", "yet", "if",
  "this", "that", "these", "those", "it", "its", "they",
  "them", "their", "we", "our", "you", "your", "he", "she",
  "his", "her", "him", "me", "my", "who", "which", "what",
  "about", "up", "out", "just", "also", "very", "too",
  "here", "there", "then", "now", "no", "yes",
]);

const ZH_SEED_PREFIX = /种于第\d+章：/;
const EN_SEED_PREFIX = /original seed \(ch\d+\):/;

interface OverdueHookEntry {
  hookId: string;
  seedText: string;
}

/**
 * Parse overdue hook entries from the context package.
 * Looks for entries with source "runtime/hook_debt#<id>" and
 * excerpt containing overdue markers (⚠逾期 / ⚠OVERDUE).
 */
export function parseOverdueHookEntries(contextPackage: ContextPackage): OverdueHookEntry[] {
  const entries: OverdueHookEntry[] = [];
  for (const entry of contextPackage.selectedContext) {
    if (!entry.source.startsWith("runtime/hook_debt#")) continue;
    const excerpt = entry.excerpt ?? "";
    if (!excerpt.includes("⚠逾期") && !excerpt.includes("⚠OVERDUE")) continue;

    const hookId = entry.source.slice("runtime/hook_debt#".length);
    if (!hookId) continue;

    // Extract seed text: find the segment after "种于第X章：" or "original seed (chX):"
    const seedText = extractSeedText(excerpt);
    if (seedText) {
      entries.push({ hookId, seedText });
    }
  }
  return entries;
}

/**
 * Extract seed text from a hook debt excerpt.
 * Format (zh): "种于第X章：<seed text> | 推进于第Y章：..."
 * Format (en): "original seed (chX): <seed text> | latest turn ..."
 */
function extractSeedText(excerpt: string): string {
  // Try Chinese format first
  const zhMatch = excerpt.match(ZH_SEED_PREFIX);
  if (zhMatch) {
    const afterSeed = excerpt.slice(zhMatch.index! + zhMatch[0].length);
    // Take everything up to the next "|" or end
    const pipeIndex = afterSeed.indexOf(" | ");
    const seedText = pipeIndex >= 0 ? afterSeed.slice(0, pipeIndex) : afterSeed;
    return seedText.trim();
  }

  // Try English format
  const enMatch = excerpt.match(EN_SEED_PREFIX);
  if (enMatch) {
    const afterSeed = excerpt.slice(enMatch.index! + enMatch[0].length);
    const pipeIndex = afterSeed.indexOf(" | ");
    const seedText = pipeIndex >= 0 ? afterSeed.slice(0, pipeIndex) : afterSeed;
    return seedText.trim();
  }

  return "";
}

/**
 * Extract meaningful keywords from seed text for content matching.
 *
 * For Chinese: extracts 2+ character tokens and 2-char sliding bigrams.
 * For English: extracts content words (nouns/verbs) with >3 characters.
 */
export function extractHookSeedKeywords(
  seedText: string,
  language: "zh" | "en",
): string[] {
  if (language === "zh") {
    return extractChineseKeywords(seedText);
  }
  return extractEnglishKeywords(seedText);
}

function extractChineseKeywords(text: string): string[] {
  const tokens: string[] = [];

  // Split on common delimiters: punctuation, spaces, numbers
  const rawTokens = text.split(/[，。、！？；：""''（）\d\s\[\]【】{}《》/\\|·…—\-+]+/).filter(Boolean);

  for (const token of rawTokens) {
    if (token.length === 0) continue;

    // Keep 2+ character tokens that aren't pure stop words
    if (token.length >= 2 && !isAllStopWords(token)) {
      tokens.push(token);
    }

    // For tokens with 3+ characters, also extract sliding 2-char bigrams
    if (token.length >= 3) {
      for (let i = 0; i < token.length - 1; i++) {
        const bigram = token.slice(i, i + 2);
        if (!ZH_STOP_WORDS.has(bigram)) {
          tokens.push(bigram);
        }
      }
    }
  }

  // Deduplicate while preserving order
  return [...new Set(tokens)];
}

function isAllStopWords(token: string): boolean {
  for (const char of token) {
    if (!ZH_STOP_WORDS.has(char)) return false;
  }
  return true;
}

function extractEnglishKeywords(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[.,!?;:"'()\[\]{}\s\d/\\|·—\-+]+/)
    .filter(Boolean);

  const tokens: string[] = [];
  for (const token of rawTokens) {
    if (token.length <= 3) continue;
    if (EN_STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }

  return [...new Set(tokens)];
}

/**
 * Check which overdue hooks have their seed keywords present in the chapter content.
 *
 * @returns Array of hooks that have NO keyword match in the chapter content.
 */
export function findMissingOverdueHooksInContent(
  contextPackage: ContextPackage,
  chapterContent: string,
  language: "zh" | "en",
): string[] {
  const overdueEntries = parseOverdueHookEntries(contextPackage);
  if (overdueEntries.length === 0) return [];

  const content = chapterContent.toLowerCase();
  const missing: string[] = [];

  for (const { hookId, seedText } of overdueEntries) {
    const keywords = extractHookSeedKeywords(seedText, language);
    if (keywords.length === 0) {
      // No keywords to match — can't verify, don't flag
      continue;
    }

    const hasMatch = keywords.some((kw) => content.includes(kw.toLowerCase()));
    if (!hasMatch) {
      missing.push(hookId);
    }
  }

  return missing;
}

/**
 * Verify that hooks claimed as resolved actually have corresponding keywords
 * present in the chapter content.
 *
 * For each resolved hook, uses its expectedPayoff + notes as seed text,
 * extracts meaningful keywords, and checks if any appear in the content.
 *
 * @returns Array of hookIds that claim resolution but have no keyword match in content.
 */
export function verifyResolveClaims(params: {
  readonly content: string;
  readonly resolvedHookIds: ReadonlyArray<string>;
  readonly hooks: ReadonlyArray<{
    hookId: string;
    expectedPayoff: string;
    notes: string;
  }>;
  readonly language: "zh" | "en";
}): string[] {
  if (params.resolvedHookIds.length === 0) return [];

  const content = params.content.toLowerCase();
  const unverified: string[] = [];

  for (const hookId of params.resolvedHookIds) {
    const hook = params.hooks.find((h) => h.hookId === hookId);
    if (!hook) continue;

    // Combine expectedPayoff + notes as seed text for keyword extraction
    const seedText = [hook.expectedPayoff, hook.notes]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!seedText) {
      // No seed text to match — can't verify, don't flag
      continue;
    }

    const keywords = extractHookSeedKeywords(seedText, params.language);
    if (keywords.length === 0) continue;

    const hasMatch = keywords.some((kw) => content.includes(kw.toLowerCase()));
    if (!hasMatch) {
      unverified.push(hookId);
    }
  }

  return unverified;
}
