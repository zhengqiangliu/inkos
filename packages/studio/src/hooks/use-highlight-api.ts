import { useEffect, useRef } from "react";

const HIGHLIGHT_NAME = "chapter-selection";

/**
 * Manage a CSS Custom Highlight for persistent visual text highlighting.
 *
 * Registers a named Highlight via `CSS.highlights.set()` so the highlight
 * survives focus/blur cycles. Cleans up on unmount or when `range` is null.
 *
 * Falls back silently if the browser doesn't support the API.
 */
export function useHighlightApi(range: Range | null): void {
  const prevRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    const css = CSS as unknown as { highlights?: Map<string, unknown> };
    if (!css.highlights || typeof css.highlights.set !== "function") return;

    if (range) {
      try {
        const Highlight = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
        if (!Highlight) return;
        const highlight = new Highlight(range);
        css.highlights.set(HIGHLIGHT_NAME, highlight);
        prevRangeRef.current = range;
      } catch {
        // API not available
      }
    } else if (prevRangeRef.current) {
      try {
        css.highlights.delete(HIGHLIGHT_NAME);
      } catch {
        // ignore
      }
      prevRangeRef.current = null;
    }

    return () => {
      try {
        css.highlights?.delete(HIGHLIGHT_NAME);
      } catch {
        // ignore
      }
    };
  }, [range]);
}
