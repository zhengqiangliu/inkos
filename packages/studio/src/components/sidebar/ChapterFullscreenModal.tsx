import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";

const streamdownPlugins = { cjk };

interface ChapterFullscreenModalProps {
  readonly title: string;
  readonly content: string | null;
  readonly editing: boolean;
  readonly editContent: string;
  readonly loading: boolean;
  readonly onClose: () => void;
}

export function ChapterFullscreenModal({
  title,
  content,
  editing,
  editContent,
  loading,
  onClose,
}: ChapterFullscreenModalProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div className="fixed inset-0 z-[220] flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0 border-b border-border/20 px-4 py-3">
        <span className="text-sm font-medium truncate">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto w-full max-w-[min(96vw,1200px)]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="text-muted-foreground animate-spin" />
            </div>
          ) : editing ? (
            <textarea
              value={editContent}
              readOnly
              className="w-full min-h-[70vh] bg-transparent text-sm leading-7 resize-none outline-none border-0 font-mono"
            />
          ) : content === null ? (
            <p className="text-xs text-muted-foreground/50 italic">无内容</p>
          ) : (
            <div className="text-sm leading-7">
              <div className="mx-auto w-full max-w-[min(96vw,1200px)]">
                <Streamdown plugins={streamdownPlugins} mode="static">
                  {content}
                </Streamdown>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
