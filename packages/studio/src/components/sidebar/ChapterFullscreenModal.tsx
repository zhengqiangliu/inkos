import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { fetchJson } from "../../hooks/use-api";
import { useChatStore } from "../../store/chat";
import {
  getChapterFullscreenPaginationCache,
  getChapterFullscreenPaginationSessionCache,
  estimateChapterFullscreenMarkdownFit,
  resolveChapterFullscreenLineHeightMultiplier,
  resolveChapterFullscreenPaginationCacheKey,
  resolveChapterFullscreenContentHeightLimit,
  resolveChapterFullscreenContentWidth,
  resolveChapterFullscreenPageHeight,
  resolveChapterFullscreenPageWidth,
  resolveChapterFullscreenPaginationTimeoutMs,
  setChapterFullscreenPaginationCache,
  resolveChapterFullscreenRenderedPageCount,
} from "./chapter-fullscreen-layout";

const streamdownPlugins = { cjk };

type ReadingMode = "single" | "spread";

interface ChapterFullscreenModalProps {
  readonly bookId: string;
  readonly chapterNumber: number | null;
  readonly title: string;
  readonly content: string | null;
  readonly editing: boolean;
  readonly editContent: string;
  readonly loading: boolean;
  readonly onClose: () => void;
}

const MODE_STORAGE_PREFIX = "studio.chapter.fullscreen.mode.";
const FONT_STORAGE_PREFIX = "studio.chapter.fullscreen.font.";
const PAGE_STORAGE_PREFIX = "studio.chapter.fullscreen.page.";
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 20;
const FONT_STEP = 2;
const PAGINATION_WATCHDOG_TICK_MS = 1000;
const PAGINATION_COMMIT_BATCH_SIZE = 2;
const PAGINATION_FRAME_BUDGET_MS = 12;

type PaginationPageSink = (page: string) => void | Promise<void>;

function readStoredMode(bookId: string): ReadingMode {
  if (typeof window === "undefined") return "spread";
  const raw = window.localStorage.getItem(`${MODE_STORAGE_PREFIX}${bookId}`);
  return raw === "single" || raw === "spread" ? raw : "spread";
}

function readStoredFontSize(bookId: string): number {
  if (typeof window === "undefined") return 16;
  const raw = Number(window.localStorage.getItem(`${FONT_STORAGE_PREFIX}${bookId}`));
  if (!Number.isFinite(raw)) return 16;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.trunc(raw)));
}

function readStoredPageIndex(bookId: string): number {
  if (typeof window === "undefined") return 0;
  const raw = Number(window.localStorage.getItem(`${PAGE_STORAGE_PREFIX}${bookId}`));
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.trunc(raw));
}

function normalizePageIndex(pageIndex: number, mode: ReadingMode): number {
  const normalized = Math.max(0, Math.trunc(pageIndex));
  if (mode !== "spread") return normalized;
  return normalized - (normalized % 2);
}

function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
}

function splitParagraphs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const blocks = trimmed
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks.length > 0 ? blocks : [trimmed];
}

function splitBlockIntoSentences(block: string): string[] {
  const chunks = block
    .split(/(?<=[。！？!?；;：:])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : [block.trim()];
}

function splitTextIntoGraphemes(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
    const graphemes = Array.from(segmenter.segment(trimmed), (item) => item.segment).filter(Boolean);
    if (graphemes.length > 0) return graphemes;
  }
  return Array.from(trimmed);
}

function clampFontSize(next: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.trunc(next)));
}

export function ChapterFullscreenModal({
  bookId,
  chapterNumber,
  title,
  content,
  editing,
  editContent,
  loading,
  onClose,
}: ChapterFullscreenModalProps) {
  const [mode, setMode] = useState<ReadingMode>(() => readStoredMode(bookId));
  const [fontSize, setFontSize] = useState<number>(() => readStoredFontSize(bookId));
  const [pageIndex, setPageIndex] = useState<number>(() => readStoredPageIndex(bookId));
  const [direction, setDirection] = useState<1 | -1>(1);
  const [readerViewport, setReaderViewport] = useState(() => ({
    width: typeof window === "undefined" ? 1120 : Math.max(720, window.innerWidth),
    height: typeof window === "undefined" ? 800 : Math.max(560, window.innerHeight),
  }));
  const [pages, setPages] = useState<string[]>([]);
  const [paginationFailed, setPaginationFailed] = useState(false);
  const [isPaginating, setIsPaginating] = useState(false);
  const [probeSample, setProbeSample] = useState<{ id: number; markdown: string } | null>(null);
  const [chapterNav, setChapterNav] = useState<{ prev: number | null; next: number | null }>({
    prev: null,
    next: null,
  });
  const readerBodyRef = useRef<HTMLDivElement | null>(null);
  const probeContentRef = useRef<HTMLDivElement | null>(null);
  const probeResolveMapRef = useRef(new Map<number, (height: number) => void>());
  const probeHeightCacheRef = useRef(new Map<string, number>());
  const probeIdRef = useRef(0);
  const paginationProgressRef = useRef(0);
  const paginateJobRef = useRef(0);
  const paginationTimeoutRef = useRef<number | null>(null);
  const openChapterArtifact = useChatStore((s) => s.openChapterArtifact);

  const contentToRead = editing ? editContent : content ?? "";
  const pageWidth = useMemo(() => {
    return resolveChapterFullscreenPageWidth(mode, readerViewport.width);
  }, [mode, readerViewport.width]);
  const pageHeight = useMemo(() => {
    return resolveChapterFullscreenPageHeight(pageWidth, readerViewport.height);
  }, [pageWidth, readerViewport.height]);
  const contentWidth = useMemo(() => resolveChapterFullscreenContentWidth(pageWidth), [pageWidth]);
  const contentHeightLimit = useMemo(() => resolveChapterFullscreenContentHeightLimit(pageHeight), [pageHeight]);
  const paginationTimeoutMs = useMemo(
    () => resolveChapterFullscreenPaginationTimeoutMs(mode, contentToRead.length),
    [contentToRead.length, mode],
  );
  const measurementSignature = useMemo(
    () => `${fontSize}:${pageWidth}:${pageHeight}:${contentHeightLimit}`,
    [contentHeightLimit, fontSize, pageHeight, pageWidth],
  );
  const paginationCacheKey = useMemo(
    () => resolveChapterFullscreenPaginationCacheKey(measurementSignature, contentToRead.trim()),
    [contentToRead, measurementSignature],
  );
  const step = mode === "spread" ? 2 : 1;
  const pageStorageKey = useMemo(
    () => `${PAGE_STORAGE_PREFIX}${bookId}:${chapterNumber ?? "none"}:${mode}`,
    [bookId, chapterNumber, mode],
  );
  const currentPage = Math.min(normalizePageIndex(pageIndex, mode), Math.max(0, pages.length - step));
  const visiblePages = pages.slice(currentPage, currentPage + step);
  const renderedPageCount = useMemo(
    () => resolveChapterFullscreenRenderedPageCount(mode, visiblePages.length),
    [mode, visiblePages.length],
  );
  const canGoPrev = currentPage > 0;
  const canGoNext = currentPage + step < pages.length;
  const currentPaperStyle = useMemo(
    () => ({
      width: `${pageWidth}px`,
      height: `${pageHeight}px`,
    }),
    [pageHeight, pageWidth],
  );
  const contentTypographyStyle = useMemo(
    () => ({
      fontSize: `${fontSize}px`,
      lineHeight: resolveChapterFullscreenLineHeightMultiplier(mode),
    }),
    [fontSize, mode],
  );

  const resolveAllPendingMeasures = useCallback((height: number) => {
    for (const resolve of probeResolveMapRef.current.values()) {
      resolve(height);
    }
    probeResolveMapRef.current.clear();
  }, []);

  const markPaginationProgress = useCallback(() => {
    paginationProgressRef.current = Date.now();
  }, []);

  const yieldToBrowser = useCallback(() => {
    if (typeof window === "undefined") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      window.setTimeout(() => resolve(), 0);
    });
  }, []);

  const measureMarkdown = useCallback((markdown: string): Promise<number> => {
    const normalized = markdown.trim();
    if (!normalized) return Promise.resolve(0);
    const cacheKey = `${measurementSignature}::${normalized}`;
    const cached = probeHeightCacheRef.current.get(cacheKey);
    if (typeof cached === "number") {
      markPaginationProgress();
      return Promise.resolve(cached);
    }
    return new Promise<number>((resolve) => {
      const id = ++probeIdRef.current;
      probeResolveMapRef.current.set(id, resolve);
      setProbeSample({ id, markdown: normalized });
      markPaginationProgress();
    });
  }, [markPaginationProgress, measurementSignature]);

  const fitsMarkdown = useCallback(
    async (markdown: string) => {
      const verdict = estimateChapterFullscreenMarkdownFit(markdown, {
        contentWidth,
        contentHeightLimit,
        fontSize,
        mode,
      });
      if (verdict === "fit") {
        markPaginationProgress();
        return true;
      }
      if (verdict === "overflow") {
        markPaginationProgress();
        return false;
      }
      const height = await measureMarkdown(markdown);
      return height > 0 && height <= contentHeightLimit;
    },
    [contentHeightLimit, contentWidth, fontSize, markPaginationProgress, measureMarkdown, mode],
  );

  const splitMarkdownToFit = useCallback(
    async (markdown: string, emitPage?: PaginationPageSink): Promise<string[]> => {
      const normalized = markdown.trim();
      if (!normalized) return [];
      if (await fitsMarkdown(normalized)) {
        await emitPage?.(normalized);
        return [normalized];
      }

      const sentences = splitBlockIntoSentences(normalized);
      if (sentences.length > 1) {
        const result: string[] = [];
        let current = "";
        for (const sentence of sentences) {
          const candidate = current ? `${current}\n\n${sentence}` : sentence;
          if (await fitsMarkdown(candidate)) {
            current = candidate;
            continue;
          }
          if (current) {
            result.push(current);
            await emitPage?.(current);
            current = "";
          }
          if (await fitsMarkdown(sentence)) {
            current = sentence;
            continue;
          }
          const pieces = await splitMarkdownByRenderedHeight(sentence, emitPage);
          if (pieces.length === 1) {
            result.push(...pieces);
          } else {
            result.push(pieces[0]);
            result.push(...await splitMarkdownToFit(pieces[1], emitPage));
          }
        }
        if (current) {
          result.push(current);
          await emitPage?.(current);
        }
        return result.filter(Boolean);
      }

      return splitMarkdownByRenderedHeight(normalized, emitPage);
    },
    [fitsMarkdown],
  );

  const splitMarkdownByRenderedHeight = useCallback(
    async (markdown: string, emitPage?: PaginationPageSink): Promise<string[]> => {
      const normalized = markdown.trim();
      if (!normalized) return [];
      if (await fitsMarkdown(normalized)) {
        await emitPage?.(normalized);
        return [normalized];
      }

      const graphemes = splitTextIntoGraphemes(normalized);
      if (graphemes.length <= 1) {
        await emitPage?.(normalized);
        return [normalized];
      }

      let lo = 1;
      let hi = graphemes.length;
      let best = 0;
      let bestText = "";

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = graphemes.slice(0, mid).join("").trim();
        if (!candidate) {
          lo = mid + 1;
          continue;
        }
        if (await fitsMarkdown(candidate)) {
          best = mid;
          bestText = candidate;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (best <= 0) {
        await emitPage?.(normalized);
        return [normalized];
      }

      const tail = graphemes.slice(best).join("").trim();
      await emitPage?.(bestText);
      if (!tail) return [bestText];
      return [bestText, ...(await splitMarkdownToFit(tail, emitPage))];
    },
    [fitsMarkdown],
  );

  useLayoutEffect(() => {
    const sample = probeSample;
    const node = probeContentRef.current;
    if (!sample || !node) return;
    const frame = requestAnimationFrame(() => {
      const measured = Math.ceil(node.getBoundingClientRect().height || node.scrollHeight || 0);
      probeHeightCacheRef.current.set(`${measurementSignature}::${sample.markdown}`, measured);
      const resolve = probeResolveMapRef.current.get(sample.id);
      if (resolve) {
        probeResolveMapRef.current.delete(sample.id);
        resolve(measured);
      }
      markPaginationProgress();
    });
    return () => cancelAnimationFrame(frame);
  }, [contentWidth, fontSize, markPaginationProgress, measurementSignature, mode, pageHeight, probeSample]);

  useEffect(() => {
    probeHeightCacheRef.current.clear();
  }, [measurementSignature]);

  useEffect(() => {
    let cancelled = false;
    const jobId = ++paginateJobRef.current;
    let settled = false;
    let nextPages: string[] = [];
    let lastCommitSize = 0;
    let lastYieldAt = Date.now();

    const cachedPages =
      getChapterFullscreenPaginationCache(paginationCacheKey)
      ?? getChapterFullscreenPaginationSessionCache(paginationCacheKey);
    if (cachedPages) {
      setPaginationFailed(false);
      setIsPaginating(false);
      setPages(cachedPages.slice());
      return () => {
        cancelled = true;
        settled = true;
      };
    }

    if (paginationTimeoutRef.current !== null) {
      window.clearTimeout(paginationTimeoutRef.current);
      paginationTimeoutRef.current = null;
    }
    paginationProgressRef.current = Date.now();

    const settlePagination = () => {
      if (settled) return false;
      settled = true;
      if (paginationTimeoutRef.current !== null) {
        window.clearTimeout(paginationTimeoutRef.current);
        paginationTimeoutRef.current = null;
      }
      return true;
    };

    const commitProgress = async (force = false) => {
      if (nextPages.length === 0) return;
      const now = Date.now();
      const shouldCommit =
        force
        || nextPages.length === 1
        || nextPages.length - lastCommitSize >= PAGINATION_COMMIT_BATCH_SIZE
        || now - lastYieldAt >= PAGINATION_FRAME_BUDGET_MS;
      if (!shouldCommit) return;
      lastCommitSize = nextPages.length;
      lastYieldAt = now;
      setPages(nextPages.slice());
      markPaginationProgress();
      await yieldToBrowser();
    };

    const emitPage: PaginationPageSink = async (page: string) => {
      const normalized = page.trim();
      if (!normalized || cancelled || jobId !== paginateJobRef.current || settled) return;
      nextPages.push(normalized);
      await commitProgress();
    };

    const paginate = async () => {
      setIsPaginating(true);
      setPaginationFailed(false);
      try {
        const normalized = contentToRead.trim();
        if (!normalized) {
          if (!cancelled && jobId === paginateJobRef.current) setPages([]);
          return;
        }

        const blocks = splitParagraphs(normalized);
        let current = "";

        const flush = async () => {
          if (current.trim()) nextPages.push(current.trim());
          current = "";
          await commitProgress();
        };

        for (const block of blocks) {
          if (cancelled || jobId !== paginateJobRef.current || settled) return;
          const normalizedBlock = block.trim();
          if (!normalizedBlock) continue;

          if (!current) {
            if (await fitsMarkdown(normalizedBlock)) {
              current = normalizedBlock;
              markPaginationProgress();
            } else {
              await splitMarkdownToFit(normalizedBlock, emitPage);
            }
            continue;
          }

          const candidate = `${current}\n\n${normalizedBlock}`;
          if (await fitsMarkdown(candidate)) {
            current = candidate;
            markPaginationProgress();
            continue;
          }

          await flush();
          if (await fitsMarkdown(normalizedBlock)) {
            current = normalizedBlock;
            markPaginationProgress();
          } else {
            await splitMarkdownToFit(normalizedBlock, emitPage);
          }
        }

        await flush();
        await commitProgress(true);
        if (settled) return;
        if (!cancelled && jobId === paginateJobRef.current && settlePagination()) {
          setChapterFullscreenPaginationCache(paginationCacheKey, nextPages);
          setPages(nextPages.slice());
          setPaginationFailed(false);
        }
      } finally {
        if (!cancelled && jobId === paginateJobRef.current) {
          settlePagination();
          setIsPaginating(false);
        }
      }
    };

    const scheduleWatchdog = () => {
      paginationTimeoutRef.current = window.setTimeout(() => {
        if (cancelled || jobId !== paginateJobRef.current || settled) return;
        const stalledFor = Date.now() - paginationProgressRef.current;
        if (stalledFor < paginationTimeoutMs) {
          scheduleWatchdog();
          return;
        }
        settled = true;
        if (paginationTimeoutRef.current !== null) {
          window.clearTimeout(paginationTimeoutRef.current);
          paginationTimeoutRef.current = null;
        }
        setPaginationFailed(true);
        setPages(nextPages.length > 0 ? nextPages.slice() : []);
        setIsPaginating(false);
      }, PAGINATION_WATCHDOG_TICK_MS);
    };

    scheduleWatchdog();

    void paginate().catch(() => {
      if (!cancelled && jobId === paginateJobRef.current && settlePagination()) {
        setPaginationFailed(true);
        setPages(nextPages.length > 0 ? nextPages.slice() : []);
        setIsPaginating(false);
      }
    });
    return () => {
      cancelled = true;
      if (paginationTimeoutRef.current !== null) {
        window.clearTimeout(paginationTimeoutRef.current);
        paginationTimeoutRef.current = null;
      }
      settled = true;
      resolveAllPendingMeasures(Number.POSITIVE_INFINITY);
    };
  }, [
    contentToRead,
    fitsMarkdown,
    markPaginationProgress,
    paginationCacheKey,
    paginationTimeoutMs,
    resolveAllPendingMeasures,
    splitMarkdownByRenderedHeight,
    splitMarkdownToFit,
    yieldToBrowser,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeStoredValue(`${MODE_STORAGE_PREFIX}${bookId}`, mode);
  }, [bookId, mode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeStoredValue(`${FONT_STORAGE_PREFIX}${bookId}`, String(fontSize));
  }, [bookId, fontSize]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeStoredValue(pageStorageKey, String(currentPage));
  }, [currentPage, pageStorageKey]);

  useEffect(() => {
    setPageIndex(normalizePageIndex(readStoredPageIndex(pageStorageKey), mode));
  }, [mode, pageStorageKey, contentToRead]);

  useEffect(() => {
    setPageIndex((current) => Math.min(normalizePageIndex(current, mode), Math.max(0, pages.length - step)));
  }, [mode, pages.length, step]);

  useLayoutEffect(() => {
    const node = readerBodyRef.current;
    if (!node) return;
    const nextWidth = node.getBoundingClientRect().width;
    const nextHeight = node.getBoundingClientRect().height;
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) return;
    setReaderViewport((current) => {
      const normalized = {
        width: Math.max(720, Math.round(nextWidth)),
        height: Math.max(560, Math.round(nextHeight)),
      };
      return normalized.width === current.width && normalized.height === current.height ? current : normalized;
    });
  }, []);

  useEffect(() => {
    const node = readerBodyRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      const nextHeight = entries[0]?.contentRect.height;
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) return;
      setReaderViewport((current) => {
        const normalized = {
          width: Math.max(720, Math.round(nextWidth)),
          height: Math.max(560, Math.round(nextHeight)),
        };
        return normalized.width === current.width && normalized.height === current.height ? current : normalized;
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (chapterNumber === null) {
      setChapterNav({ prev: null, next: null });
      return;
    }
    let alive = true;
    void fetchJson<{ chapters?: ReadonlyArray<{ number?: unknown }> }>(`/books/${bookId}`)
      .then((data) => {
        if (!alive) return;
        const chapters = Array.isArray(data.chapters)
          ? data.chapters
              .map((item) => Number(item.number))
              .filter((value) => Number.isFinite(value))
              .map((value) => Math.trunc(value))
          : [];
        const index = chapters.indexOf(chapterNumber);
        setChapterNav({
          prev: index > 0 ? chapters[index - 1] ?? null : null,
          next: index >= 0 && index < chapters.length - 1 ? chapters[index + 1] ?? null : null,
        });
      })
      .catch(() => {
        if (!alive) return;
        setChapterNav({ prev: null, next: null });
      });
    return () => {
      alive = false;
    };
  }, [bookId, chapterNumber]);

  const handleClose = useCallback(() => onClose(), [onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setDirection(-1);
        setPageIndex((current) => Math.max(0, current - step));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setDirection(1);
        setPageIndex((current) => Math.min(Math.max(0, pages.length - step), current + step));
      }
    },
    [onClose, pages.length, step],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const jumpToChapter = useCallback(
    (nextChapter: number | null) => {
      if (nextChapter === null) return;
      openChapterArtifact(nextChapter, {
        edit: false,
        meta: null,
      });
      setDirection(1);
      setPageIndex(0);
    },
    [openChapterArtifact],
  );

  const handlePrev = useCallback(() => {
    if (!canGoPrev) return;
    setDirection(-1);
    setPageIndex((current) => Math.max(0, current - step));
  }, [canGoPrev, step]);

  const handleNext = useCallback(() => {
    if (!canGoNext) return;
    setDirection(1);
    setPageIndex((current) => Math.min(Math.max(0, pages.length - step), current + step));
  }, [canGoNext, pages.length, step]);

  const pageLabel = pages.length === 0
    ? "0 / 0"
    : mode === "spread" && renderedPageCount > 1
      ? `${currentPage + 1}-${Math.min(currentPage + 2, pages.length)} / ${pages.length}`
      : `${currentPage + 1} / ${pages.length}`;
  const fallbackContent = contentToRead.trim();

  return createPortal(
    <div className="fixed inset-0 z-[220] flex flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border/20 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <span className="rounded-full border border-border/40 px-2 py-0.5 text-[10px] text-muted-foreground">
          {pageLabel}
        </span>
        {chapterNumber !== null && !editing && (
          <div className="flex items-center gap-1 rounded-full border border-border/30 bg-secondary/40 p-1">
            <button
              type="button"
              onClick={() => jumpToChapter(chapterNav.prev)}
              disabled={chapterNav.prev === null}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft size={12} />
              上一章
            </button>
            <button
              type="button"
              onClick={() => jumpToChapter(chapterNav.next)}
              disabled={chapterNav.next === null}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-30"
            >
              下一章
              <ChevronRight size={12} />
            </button>
          </div>
        )}
        <div className="flex items-center gap-1 rounded-full border border-border/30 bg-secondary/40 p-1">
          <button
            type="button"
            onClick={() => setMode("single")}
            className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
              mode === "single" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            单页
          </button>
          <button
            type="button"
            onClick={() => setMode("spread")}
            className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
              mode === "spread" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            双页
          </button>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border/30 bg-secondary/40 p-1">
          <button
            type="button"
            onClick={() => setFontSize((current) => clampFontSize(current - FONT_STEP))}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            aria-label="减小字体"
          >
            <Minus size={14} />
          </button>
          <span className="min-w-10 text-center text-[11px] tabular-nums text-muted-foreground">{fontSize}px</span>
          <button
            type="button"
            onClick={() => setFontSize((current) => clampFontSize(current + FONT_STEP))}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            aria-label="增大字体"
          >
            <Plus size={14} />
          </button>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
          aria-label="关闭全屏"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-1 min-h-0 items-stretch overflow-hidden">
        <div
          ref={readerBodyRef}
          className="relative flex w-full min-w-0 flex-1 items-center justify-center overflow-hidden bg-[linear-gradient(180deg,rgba(0,0,0,0.02),rgba(0,0,0,0.05))] px-4 py-8 sm:px-10 sm:py-10"
        >
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : content === null ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground/60">暂无内容</div>
          ) : pages.length === 0 ? (
            <div className="flex h-full min-h-0 w-full max-w-[1024px] flex-col items-stretch overflow-hidden">
              <div className="mb-3 text-center text-xs text-muted-foreground/60">
                {paginationFailed ? "分页失败，已切换为连续阅读" : (isPaginating ? "分页中..." : "连续阅读")}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-3xl border border-border/30 bg-card/90 px-8 py-8 shadow-[0_20px_60px_rgba(0,0,0,0.12)]">
                <div className="mx-auto w-full max-w-[780px]" style={contentTypographyStyle}>
                  <Streamdown plugins={streamdownPlugins} mode="static">
                    {fallbackContent}
                  </Streamdown>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0 w-full max-w-[1560px] items-stretch gap-3 overflow-hidden">
              <button
                type="button"
                onClick={handlePrev}
                disabled={!canGoPrev}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/30 bg-card/80 text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:opacity-30"
                aria-label="上一页"
              >
                <ChevronLeft size={18} />
              </button>

              <div className="relative min-h-0 flex-1 overflow-hidden">
                <AnimatePresence mode="wait" initial={false} custom={direction}>
                  <motion.div
                    key={`${currentPage}-${mode}-${fontSize}-${pageWidth}-${pageHeight}-${chapterNumber ?? "none"}`}
                    custom={direction}
                    initial={{ opacity: 0, x: direction > 0 ? 48 : -48, rotateY: direction > 0 ? -10 : 10, scale: 0.985 }}
                    animate={{ opacity: 1, x: 0, rotateY: 0, scale: 1 }}
                    exit={{ opacity: 0, x: direction > 0 ? -48 : 48, rotateY: direction > 0 ? 10 : -10, scale: 0.985 }}
                    transition={{ duration: 0.28, ease: "easeOut" }}
                    className="flex h-full min-h-0 w-full items-stretch justify-center overflow-hidden"
                    style={{ perspective: "2200px" }}
                  >
                    <div className={`flex h-full min-h-0 w-full items-stretch gap-4 overflow-hidden ${renderedPageCount === 1 ? "justify-center" : "justify-center"}`}>
                      {Array.from({ length: renderedPageCount }).map((_, index) => {
                        const page = visiblePages[index];
                        const pageNumber = page ? currentPage + index + 1 : null;
                        return (
                          <div
                            key={`${currentPage}-${index}`}
                            style={currentPaperStyle}
                            className={`flex min-h-0 flex-none flex-col overflow-hidden rounded-3xl border bg-card/90 shadow-[0_20px_60px_rgba(0,0,0,0.12)] ${
                              mode === "spread" && renderedPageCount > 1
                                ? index === 0
                                  ? "rounded-r-2xl border-r border-border/25"
                                  : "rounded-l-2xl border-l border-border/25"
                                : "border-border/30"
                            }`}
                          >
                            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/10 px-5 text-[11px] text-muted-foreground">
                              <span>{mode === "spread" && renderedPageCount > 1 ? (index === 0 ? "左页" : "右页") : "正文页"}</span>
                              <span className="tabular-nums">{pageNumber ?? ""}</span>
                            </div>
                            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-5">
                              <div
                                className="h-full overflow-hidden text-foreground"
                                style={contentTypographyStyle}
                              >
                                {page ? (
                                  <Streamdown plugins={streamdownPlugins} mode="static">
                                    {page}
                                  </Streamdown>
                                ) : (
                                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground/40">
                                    空白页
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>

              <button
                type="button"
                onClick={handleNext}
                disabled={!canGoNext}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/30 bg-card/80 text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:opacity-30"
                aria-label="下一页"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}

          <div className="pointer-events-none absolute left-[-10000px] top-0 opacity-0" aria-hidden="true">
            {probeSample && (
              <div style={currentPaperStyle} className="flex flex-none flex-col overflow-hidden rounded-3xl border bg-card/90">
                <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/10 px-5 text-[11px] text-muted-foreground">
                  <span>测量页</span>
                  <span className="tabular-nums">0</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-5">
                  <div
                    ref={probeContentRef}
                    className="overflow-visible text-foreground"
                    style={contentTypographyStyle}
                  >
                    <Streamdown plugins={streamdownPlugins} mode="static">
                      {probeSample.markdown}
                    </Streamdown>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}



