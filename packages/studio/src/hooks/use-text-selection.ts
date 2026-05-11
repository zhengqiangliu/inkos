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
 *   on mousedown outside the container.
 */
export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
): TextSelectionState & TextSelectionActions {
  const [selectedText, setSelectedText] = useState("");
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [persistedRange, setPersistedRange] = useState<Range | null>(null);
  const clearOnNextChange = useRef(false);

  // Update on selectionchange — track text/rect/range when inside container
  useEffect(() => {
    const handleSelectionChange = () => {
      if (clearOnNextChange.current) {
        clearOnNextChange.current = false;
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectedText("");
        setSelectionRect(null);
        setIsSelecting(false);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        return;
      }
      setSelectedText(sel.toString());
      setSelectionRect(range.getBoundingClientRect());
      setPersistedRange(range.cloneRange());
      setIsSelecting(true);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [containerRef]);

  // Clear persisted range on mousedown outside the container
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const container = containerRef.current;
      if (container && !container.contains(e.target as Node)) {
        setPersistedRange(null);
        setSelectedText("");
        setSelectionRect(null);
        setIsSelecting(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [containerRef]);

  const clearSelection = () => {
    clearOnNextChange.current = true;
    window.getSelection()?.removeAllRanges();
    setPersistedRange(null);
    setSelectedText("");
    setSelectionRect(null);
    setIsSelecting(false);
  };

  return { selectedText, isSelecting, selectionRect, persistedRange, clearSelection };
}
