export type ChapterFullscreenReadingMode = "single" | "spread";

const SPREAD_VIEWPORT_MARGIN = 112;
const SPREAD_PAGE_GAP = 24;
const SPREAD_MIN_PAGE_WIDTH = 340;
const SPREAD_MAX_PAGE_WIDTH = 520;

const SINGLE_VIEWPORT_MARGIN = 96;
const SINGLE_MIN_PAGE_WIDTH = 360;
const SINGLE_MAX_PAGE_WIDTH = 760;

const PAGE_HEADER_HEIGHT = 40;
const PAGE_PADDING_X = 24;
const PAGE_PADDING_Y = 24;
const SHARED_LINE_HEIGHT = 1.96;
const PAGINATION_CACHE_LIMIT = 24;
const PAGINATION_SESSION_PREFIX = "studio.chapter.fullscreen.pagination.";

type PaginationCacheEntry = {
  readonly pages: ReadonlyArray<string>;
};

const paginationCache = new Map<string, PaginationCacheEntry>();

export function resolveChapterFullscreenPageWidth(
  mode: ChapterFullscreenReadingMode,
  viewportWidth: number,
): number {
  const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, Math.trunc(viewportWidth)) : 0;
  const available = Math.max(360, safeViewportWidth - SPREAD_VIEWPORT_MARGIN);
  const spreadBasis = Math.floor((available - SPREAD_PAGE_GAP) / 2);
  const sharedWidth = Math.max(SPREAD_MIN_PAGE_WIDTH, Math.min(SPREAD_MAX_PAGE_WIDTH, spreadBasis));
  return mode === "spread" || mode === "single" ? sharedWidth : sharedWidth;
}

export function resolveChapterFullscreenPageHeight(pageWidth: number, viewportHeight: number): number {
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, Math.trunc(viewportHeight)) : 0;
  const available = Math.max(560, safeViewportHeight - 80);
  const ideal = Math.round(safeViewportHeight * 0.88);
  return Math.max(620, Math.min(ideal, available, 920));
}

export function resolveChapterFullscreenContentWidth(pageWidth: number): number {
  return Math.max(300, pageWidth - PAGE_PADDING_X * 2);
}

export function resolveChapterFullscreenContentHeightLimit(pageHeight: number): number {
  return Math.max(420, pageHeight - PAGE_HEADER_HEIGHT - PAGE_PADDING_Y * 2);
}

export function resolveChapterFullscreenRenderedPageCount(
  mode: ChapterFullscreenReadingMode,
  visiblePageCount: number,
): number {
  if (visiblePageCount <= 0) return 0;
  return mode === "spread" && visiblePageCount > 1 ? 2 : 1;
}

export function resolveChapterFullscreenPaginationTimeoutMs(
  mode: ChapterFullscreenReadingMode,
  contentLength: number,
): number {
  const safeLength = Number.isFinite(contentLength) ? Math.max(0, Math.trunc(contentLength)) : 0;
  const base = mode === "spread" ? 20_000 : 15_000;
  const lengthBudget = Math.min(45_000, Math.ceil(safeLength / 300) * 1_000);
  return Math.max(base, base + lengthBudget);
}

export function resolveChapterFullscreenLineHeightMultiplier(mode: ChapterFullscreenReadingMode): number {
  return SHARED_LINE_HEIGHT;
}

export function estimateChapterFullscreenMarkdownFit(
  markdown: string,
  args: {
    readonly contentWidth: number;
    readonly contentHeightLimit: number;
    readonly fontSize: number;
    readonly mode: ChapterFullscreenReadingMode;
  },
): "fit" | "overflow" | "measure" {
  const normalized = markdown.trim();
  if (!normalized) return "fit";

  const safeContentWidth = Number.isFinite(args.contentWidth) ? Math.max(1, Math.trunc(args.contentWidth)) : 1;
  const safeHeightLimit = Number.isFinite(args.contentHeightLimit) ? Math.max(1, Math.trunc(args.contentHeightLimit)) : 1;
  const safeFontSize = Number.isFinite(args.fontSize) ? Math.max(1, Math.trunc(args.fontSize)) : 1;
  const lineHeight = safeFontSize * resolveChapterFullscreenLineHeightMultiplier(args.mode);
  const charsPerLine = Math.max(12, Math.floor(safeContentWidth / Math.max(1, safeFontSize * 0.96)));
  const availableLines = Math.max(4, Math.floor(safeHeightLimit / Math.max(1, lineHeight)));

  const stripped = normalized.replace(/\s+/gu, "");
  const charCount = Array.from(stripped).length;
  const paragraphCount = normalized.split(/\n\s*\n/u).length;
  const specialLineCount = normalized
    .split("\n")
    .filter((line) => /^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/u.test(line.trim()))
    .length;

  const effectiveCharCount = charCount
    + Math.max(0, paragraphCount - 1) * Math.max(6, Math.round(charsPerLine * 0.28))
    + specialLineCount * Math.max(4, Math.round(charsPerLine * 0.18));
  const capacity = charsPerLine * availableLines;

  if (effectiveCharCount <= Math.floor(capacity * 0.72)) return "fit";
  if (effectiveCharCount >= Math.ceil(capacity * 1.18)) return "overflow";
  return "measure";
}

export function resolveChapterFullscreenPaginationCacheKey(
  signature: string,
  content: string,
): string {
  return `${signature}::${hashChapterFullscreenContent(content)}`;
}

export function getChapterFullscreenPaginationCache(cacheKey: string): ReadonlyArray<string> | null {
  const cached = paginationCache.get(cacheKey);
  if (!cached) return null;
  paginationCache.delete(cacheKey);
  paginationCache.set(cacheKey, cached);
  return cached.pages.slice();
}

export function getChapterFullscreenPaginationSessionCache(cacheKey: string): ReadonlyArray<string> | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  const raw = window.sessionStorage.getItem(`${PAGINATION_SESSION_PREFIX}${cacheKey}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const pages = parsed.filter((item): item is string => typeof item === "string");
    return pages.length > 0 ? pages.slice() : [];
  } catch {
    return null;
  }
}

export function setChapterFullscreenPaginationCache(
  cacheKey: string,
  pages: ReadonlyArray<string>,
): void {
  paginationCache.delete(cacheKey);
  paginationCache.set(cacheKey, { pages: pages.slice() });
  while (paginationCache.size > PAGINATION_CACHE_LIMIT) {
    const oldestKey = paginationCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    paginationCache.delete(oldestKey);
  }
  if (typeof window !== "undefined" && window.sessionStorage) {
    try {
      window.sessionStorage.setItem(`${PAGINATION_SESSION_PREFIX}${cacheKey}`, JSON.stringify(pages.slice()));
    } catch {
      // Ignore storage quota / disabled storage errors.
    }
  }
}

function hashChapterFullscreenContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
