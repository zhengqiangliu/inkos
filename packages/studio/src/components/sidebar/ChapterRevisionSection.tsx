import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useChatStore } from "../../store/chat";
import {
  buildChapterRevisionInstruction,
  getChapterRevisionDisplayMeta,
} from "./chapter-revision-utils";
import { resolveChapterRevisionContent } from "./chapter-revision-response";

interface ChapterRevisionSectionProps {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly selectedText: string;
  readonly selectionModeActive: boolean;
  readonly onToggleSelectionMode: () => void;
  readonly onRevisionComplete: (newContent: string | null) => void;
}

export function ChapterRevisionSection({
  bookId,
  chapterNumber,
  selectedText,
  selectionModeActive,
  onToggleSelectionMode,
  onRevisionComplete,
}: ChapterRevisionSectionProps) {
  const hasSelection = selectedText.trim().length > 0;
  const modeMeta = getChapterRevisionDisplayMeta(selectedText, selectionModeActive);
  const waitingForSelection = selectionModeActive && !hasSelection;
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const createDraftSession = useChatStore((s) => s.createDraftSession);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [brief]);

  const handleRevise = useCallback(async () => {
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
      const response = await sendMessage(sessionId, instruction, bookId);
      const revisedContent = resolveChapterRevisionContent(response);
      onRevisionComplete(revisedContent);
    } finally {
      setSending(false);
      setBrief("");
    }
  }, [activeSessionId, bookId, chapterNumber, brief, createDraftSession, modeMeta.mode, onRevisionComplete, selectedText, sendMessage, sending, waitingForSelection]);

  const canRevise = brief.trim().length > 0 && !sending && !waitingForSelection;
  const submitLabel = sending
    ? "发送中..."
    : waitingForSelection
      ? "等待选区"
      : "提交";
  const submitPlaceholder = waitingForSelection
    ? "先在正文中选中文本，再输入修改要求..."
    : hasSelection
      ? "输入选中文本的修改要求..."
      : "输入全文修改要求...";
  const selectedTextPreviewStyle = {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 3,
    overflow: "hidden",
  } as const;

  return (
    <div className="border-t border-border/40 bg-secondary/25 -mx-4 px-4 py-3">
      <div className={`rounded-2xl border px-3 py-3 shadow-sm ring-1 ring-black/5 ${modeMeta.panelClassName}`}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground/90">{selectionModeActive ? "AI 选择模式" : "AI 修订"}</span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide ${modeMeta.chipClassName}`}>
              {modeMeta.label}
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleSelectionMode}
            className="rounded-lg border border-border/40 bg-background/75 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          >
            选择正文 AI 修改
          </button>
        </div>
        <span className="mb-2 block text-[10px] text-muted-foreground/70">{modeMeta.hint}</span>

        <div className={`mb-3 h-1 rounded-full ${modeMeta.mode === "selected" ? "bg-primary/70" : "bg-border/60"}`} />

        {hasSelection ? (
          <div className="mb-2 h-[88px] overflow-hidden rounded-xl border border-primary/25 bg-primary/10 px-3 py-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wider text-primary/80">
                选中内容
              </div>
              <div className="text-[10px] text-muted-foreground/60 tabular-nums">
                {selectedText.length} 字
              </div>
            </div>
            <p className="text-xs leading-5 text-foreground/95" style={selectedTextPreviewStyle}>
              {selectedText}
            </p>
          </div>
        ) : selectionModeActive ? (
          <div className="mb-2 rounded-xl border border-dashed border-primary/20 bg-background/65 px-3 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              等待正文选区
            </div>
            <p className="text-xs leading-5 text-muted-foreground/80">
              请先在正文中选中需要修改的片段，底部面板会直接按选区提交。
            </p>
          </div>
        ) : (
          <div className="mb-2 rounded-xl border border-border/25 bg-background/65 px-3 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              全文说明
            </div>
            <p className="text-xs leading-5 text-muted-foreground/80">
              未进入选择模式时，当前面板将按全文修订处理。
            </p>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={submitPlaceholder}
          disabled={sending}
          rows={2}
          className="w-full rounded-lg border border-border/40 bg-background/85 px-3 py-1.5 text-xs outline-none transition-colors focus:border-primary/40 resize-none disabled:opacity-50"
        />

        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={handleRevise}
            disabled={!canRevise}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20 transition-colors disabled:opacity-40"
          >
            {sending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Send size={12} />
            )}
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
