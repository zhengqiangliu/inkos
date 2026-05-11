import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import { useChatStore } from "../../store/chat";

interface ChapterSelectionToolbarProps {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly selectedText: string;
  readonly selectionRect: DOMRect | null;
  readonly onDismiss: () => void;
}

export function ChapterSelectionToolbar({
  bookId,
  chapterNumber,
  selectedText,
  selectionRect: _selectionRect,
  onDismiss,
}: ChapterSelectionToolbarProps) {
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const createDraftSession = useChatStore((s) => s.createDraftSession);

  const hasSelection = selectedText.length > 0;

  // Clear selection on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
  }, [brief]);

  const handleModify = useCallback(async () => {
    if (!brief.trim() || sending) return;
    setSending(true);
    try {
      let sessionId = activeSessionId;
      if (!sessionId) {
        sessionId = createDraftSession(bookId);
      }
      const instruction = hasSelection
        ? `请对第${chapterNumber}章选中的文本按要求修改，不要改动其他内容：\n\n[选中文本]\n${selectedText}\n\n[要求]\n${brief}`
        : `请按要求修改第${chapterNumber}章，不要改动其他内容：\n${brief}`;
      await sendMessage(sessionId, instruction, bookId);
      setBrief("");
    } finally {
      setSending(false);
    }
  }, [activeSessionId, bookId, chapterNumber, selectedText, brief, sending, sendMessage, createDraftSession, hasSelection]);

  const canModify = brief.trim().length > 0 && !sending;
  const charCount = selectedText.length;
  const truncatedPreview = selectedText.length > 120
    ? `${selectedText.slice(0, 120)}...`
    : selectedText;

  return (
    <div
      ref={popupRef}
      className="absolute top-12 right-2 z-20 w-[240px] rounded-xl border bg-card shadow-xl overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/20">
        <div className="flex items-center gap-2 min-w-0">
          {hasSelection ? (
            <>
              <span className="text-[10px] uppercase tracking-wider text-primary shrink-0">
                选中修改
              </span>
              <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                {charCount} 字
              </span>
            </>
          ) : (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/80 shrink-0">
              全文修改
            </span>
          )}
        </div>
        {hasSelection && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            title="取消选中"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Selected text preview (selection mode only) */}
      {hasSelection && (
        <div className="px-3 pt-2 pb-1">
          <p className="text-[11px] text-foreground/70 leading-5 line-clamp-2 break-words">
            {truncatedPreview}
          </p>
        </div>
      )}

      {/* Modification input */}
      <div className="px-3 pb-2">
        <textarea
          ref={textareaRef}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={hasSelection ? "输入选中文本的修改要求..." : "输入全文修改要求..."}
          disabled={sending}
          rows={2}
          className="w-full rounded-lg border border-border/40 bg-background px-2.5 py-1.5 text-[11px] outline-none transition-colors focus:border-primary/40 resize-none disabled:opacity-50 leading-5"
        />
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between px-3 pb-2.5">
        {hasSelection && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            取消选中
          </button>
        )}
        <button
          type="button"
          onClick={handleModify}
          disabled={!canModify}
          className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 ml-auto"
        >
          {sending ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Send size={11} />
          )}
          {sending ? "处理中..." : hasSelection ? "AI 修改" : "全文修改"}
        </button>
      </div>
    </div>
  );
}
