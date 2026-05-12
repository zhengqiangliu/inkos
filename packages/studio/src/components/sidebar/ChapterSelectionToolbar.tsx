import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import { useChatStore } from "../../store/chat";
import {
  buildChapterRevisionInstruction,
  getChapterRevisionDisplayMeta,
} from "./chapter-revision-utils";

interface ChapterSelectionToolbarProps {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly selectedText: string;
  readonly selectionRect: DOMRect | null;
  readonly selectionModeActive: boolean;
  readonly onDismiss: () => void;
}

export function ChapterSelectionToolbar({
  bookId,
  chapterNumber,
  selectedText,
  selectionRect: _selectionRect,
  selectionModeActive,
  onDismiss,
}: ChapterSelectionToolbarProps) {
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const createDraftSession = useChatStore((s) => s.createDraftSession);

  const hasSelection = selectedText.trim().length > 0;
  const modeMeta = getChapterRevisionDisplayMeta(selectedText, selectionModeActive);
  const waitingForSelection = selectionModeActive && !hasSelection;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
  }, [brief]);

  const handleModify = useCallback(async () => {
    if (!brief.trim() || sending || waitingForSelection) return;
    setSending(true);
    try {
      let sessionId = activeSessionId;
      if (!sessionId) {
        sessionId = createDraftSession(bookId);
      }
      const instruction = buildChapterRevisionInstruction({
        chapterNumber,
        selectedText,
        brief,
        mode: modeMeta.mode,
      });
      await sendMessage(sessionId, instruction, bookId);
      setBrief("");
    } finally {
      setSending(false);
    }
  }, [activeSessionId, bookId, chapterNumber, brief, createDraftSession, modeMeta.mode, selectedText, sendMessage, sending, waitingForSelection]);

  const canModify = brief.trim().length > 0 && !sending && !waitingForSelection;
  const charCount = selectedText.length;
  const truncatedPreview = selectedText.length > 120 ? `${selectedText.slice(0, 120)}...` : selectedText;

  return (
    <div
      ref={popupRef}
      className={`absolute top-12 right-2 z-20 w-[240px] overflow-hidden rounded-xl border shadow-2xl ring-1 ring-black/5 ${modeMeta.panelClassName}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/25 bg-background/65 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide ${modeMeta.chipClassName}`}>
            {modeMeta.label}
          </span>
          {(hasSelection || waitingForSelection) && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">
              {hasSelection ? `${charCount} 字` : "待选区"}
            </span>
          )}
        </div>
        {(hasSelection || waitingForSelection) && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            title={waitingForSelection ? "退出选择模式" : "取消选中"}
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div className={`h-1 ${hasSelection ? "bg-primary/70" : "bg-border/60"}`} />

      <div className="px-3 pt-2 pb-1">
        <div className={`rounded-lg border px-2.5 py-2 ${hasSelection ? "border-primary/25 bg-primary/10" : "border-border/25 bg-background/65"}`}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className={`text-[10px] uppercase tracking-wider ${hasSelection || waitingForSelection ? "text-primary/80" : "text-muted-foreground/70"}`}>
              {waitingForSelection ? "等待正文选中" : hasSelection ? "选中内容" : "全文说明"}
            </span>
            {hasSelection && (
              <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                {charCount} 字
              </span>
            )}
          </div>
          <p className={`text-[11px] leading-5 ${hasSelection || waitingForSelection ? "text-foreground/95" : "text-muted-foreground/80"}`}>
            {waitingForSelection
              ? "请在正文中拖选需要修改的片段，选区会在这里同步显示。"
              : hasSelection
                ? truncatedPreview
                : "未选中文本时，面板将自动按全文修改。"}
          </p>
        </div>
      </div>

      <div className="px-3 pb-2">
        <textarea
          ref={textareaRef}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={waitingForSelection
            ? "先选中正文，再输入修改要求..."
            : hasSelection
              ? "输入选中文本的修改要求..."
              : "输入全文修改要求..."}
          disabled={sending}
          rows={2}
          className="w-full rounded-lg border border-border/40 bg-background/85 px-2.5 py-1.5 text-[11px] outline-none transition-colors focus:border-primary/40 resize-none disabled:opacity-50 leading-5"
        />
      </div>

      <div className="flex items-center justify-between px-3 pb-2.5">
        {(hasSelection || waitingForSelection) && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {waitingForSelection ? "退出选择模式" : "取消选中"}
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
          {sending ? "处理中..." : waitingForSelection ? "等待选区" : hasSelection ? "AI 修改" : "全文修改"}
        </button>
      </div>
    </div>
  );
}
