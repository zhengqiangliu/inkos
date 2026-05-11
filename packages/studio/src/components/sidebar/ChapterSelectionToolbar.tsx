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
  selectionRect,
  onDismiss,
}: ChapterSelectionToolbarProps) {
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const createDraftSession = useChatStore((s) => s.createDraftSession);

  // Auto-focus textarea when popup opens
  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  // Dismiss on Escape
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
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [brief]);

  const handleModify = useCallback(async () => {
    if (!brief.trim() || sending) return;
    setSending(true);
    try {
      let sessionId = activeSessionId;
      if (!sessionId) {
        sessionId = createDraftSession(bookId);
      }
      const instruction = `修订第${chapterNumber}章选中内容：\n[选中文本]\n${selectedText}\n\n[要求]\n${brief}`;
      await sendMessage(sessionId, instruction, bookId);
      onDismiss();
    } finally {
      setSending(false);
      setBrief("");
    }
  }, [activeSessionId, bookId, chapterNumber, selectedText, brief, sending, sendMessage, createDraftSession, onDismiss]);

  const canModify = brief.trim().length > 0 && !sending;

  // Compute popup position
  const popupStyle: React.CSSProperties = {};
  if (selectionRect) {
    // Position below the selection, or above if not enough room
    const spaceBelow = window.innerHeight - selectionRect.bottom;
    const popupHeight = 260;
    if (spaceBelow >= popupHeight) {
      popupStyle.top = `${selectionRect.bottom + 6}px`;
    } else {
      popupStyle.bottom = `${window.innerHeight - selectionRect.top + 6}px`;
    }
    // Center horizontally relative to selection, clamped to viewport edges
    const popupWidth = 380;
    let left = selectionRect.left + (selectionRect.width - popupWidth) / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - popupWidth - 12));
    popupStyle.left = `${left}px`;
  }

  return (
    <div
      ref={popupRef}
      className="fixed z-50 w-[380px] rounded-xl border border-border/60 bg-card shadow-xl"
      style={popupStyle}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border/30 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            AI 修改 · 选中内容
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

      {/* Input */}
      <div className="px-3 py-2">
        <textarea
          ref={textareaRef}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="输入修改要求..."
          disabled={sending}
          rows={2}
          className="w-full rounded-lg border border-border/40 bg-background px-3 py-1.5 text-xs outline-none transition-colors focus:border-primary/40 resize-none disabled:opacity-50"
        />
      </div>

      {/* Action */}
      <div className="flex items-center justify-between border-t border-border/30 px-3 py-2">
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleModify}
          disabled={!canModify}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20 transition-colors disabled:opacity-40"
        >
          {sending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Send size={12} />
          )}
          {sending ? "处理中..." : "AI 修改"}
        </button>
      </div>
    </div>
  );
}
