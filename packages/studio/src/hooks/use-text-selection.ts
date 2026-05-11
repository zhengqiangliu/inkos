import { useEffect, useRef, useState } from "react";

export interface TextSelectionState {
  readonly selectedText: string;
  readonly isSelecting: boolean;
  readonly selectionRect: DOMRect | null;
  readonly persistedRange: Range | null;
}

export interface TextSelectionActions {
  readonly clearSelection: () => void;
}

/**
 * Track text selection within a container element.
 *
 * - `persistedRange` stays intact when clicking outside the container
 *   (e.g. a revision textarea), keeping the visual highlight alive.
 * - `persistedRange` is only cleared on explicit `clearSelection()` or
 *   on collapsed selection inside the container while in selection mode.
 * - Uses refs to avoid re-render churn during drag-selection:
 *   state updates are skipped when the selected text hasn't changed,
 *   and `getBoundingClientRect()` is only called on meaningful changes.
 */
export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
): TextSelectionState & TextSelectionActions {
  const [selectedText, setSelectedText] = useState("");
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [persistedRange, setPersistedRange] = useState<Range | null>(null);
  const clearOnNextChange = useRef(false);

  // Refs to avoid re-renders during drag-selection
  const lastTextRef = useRef("");
  const isSelectingRef = useRef(false);

  // Update on selectionchange — track text/rect/range when inside container
  useEffect(() => {
    const handleSelectionChange = () => {
      if (clearOnNextChange.current) {
        clearOnNextChange.current = false;
        return;
      }
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) {
        return;
      }
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (!container) return;

      if (sel.isCollapsed) {
        // Only clear if we're currently in selection mode and the
        // collapsed selection is inside the content container.
        // This prevents clearing during mousedown (which fires a
        // collapsed selectionchange before the drag-selection starts).
        if (isSelectingRef.current && container.contains(range.commonAncestorContainer)) {
          isSelectingRef.current = false;
          lastTextRef.current = "";
          setSelectedText("");
          setSelectionRect(null);
          setPersistedRange(null);
          setIsSelecting(false);
        }
        // Collapsed selection outside the container (e.g. user clicked
        // the toolbar textarea) — keep selection state intact.
        return;
      }

      // Non-collapsed selection inside container → enter selection mode
      if (container.contains(range.commonAncestorContainer)) {
        const text = sel.toString();
        // Skip if text hasn't changed — avoids re-render churn during
        // drag-selection where selectionchange fires on every mousemove.
        if (text === lastTextRef.current && isSelectingRef.current) return;

        lastTextRef.current = text;
        setSelectedText(text);
        setSelectionRect(range.getBoundingClientRect());
        setPersistedRange(range.cloneRange());
        if (!isSelectingRef.current) {
          isSelectingRef.current = true;
          setIsSelecting(true);
        }
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [containerRef]);

  const clearSelection = () => {
    clearOnNextChange.current = true;
    window.getSelection()?.removeAllRanges();
    isSelectingRef.current = false;
    lastTextRef.current = "";
    setPersistedRange(null);
    setSelectedText("");
    setSelectionRect(null);
    setIsSelecting(false);
  };

  return { selectedText, isSelecting, selectionRect, persistedRange, clearSelection };
}
