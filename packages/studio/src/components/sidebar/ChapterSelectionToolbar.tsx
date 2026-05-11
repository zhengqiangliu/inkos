import { useEffect, useRef, useCallback } from "react";
import { X, ArrowDown } from "lucide-react";

interface ChapterSelectionToolbarProps {
  readonly selectedText: string;
  readonly onSendToRevision: () => void;
  readonly onDismiss: () => void;
}

export function ChapterSelectionToolbar({
  selectedText,
  onSendToRevision,
  onDismiss,
}: ChapterSelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      ref={toolbarRef}
      className="sticky top-0 z-30 mb-2 rounded-xl border border-primary/20 bg-card shadow-lg"
    >
      <div className="flex items-start justify-between gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            已选中文本
          </div>
          <p className="text-xs text-foreground/80 line-clamp-2 leading-5 break-words">
            {selectedText}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
        >
          <X size={14} />
        </button>
      </div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onSendToRevision}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary hover:bg-primary/20 transition-colors"
        >
          <ArrowDown size={12} />
          发送至修订面板
        </button>
      </div>
    </div>
  );
}
