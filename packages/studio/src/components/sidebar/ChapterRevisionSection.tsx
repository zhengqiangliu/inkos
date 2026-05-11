import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useChatStore } from "../../store/chat";

interface ChapterRevisionSectionProps {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly selectedText: string;
  readonly onRevisionComplete: (newContent: string | null) => void;
}

export function ChapterRevisionSection({
  bookId,
  chapterNumber,
  selectedText,
  onRevisionComplete: _onRevisionComplete,
}: ChapterRevisionSectionProps) {
  const [mode, setMode] = useState<"selected" | "full">("full");
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const createDraftSession = useChatStore((s) => s.createDraftSession);

  // Auto-switch to "selected" when user selects text
  useEffect(() => {
    if (selectedText) {
      setMode("selected");
    }
  }, [selectedText]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [brief]);

  const handleRevise = useCallback(async () => {
    if (!brief.trim() || sending) return;
    setSending(true);
    try {
      let sessionId = activeSessionId;
      if (!sessionId) {
        sessionId = createDraftSession(bookId);
      }

      const instruction = mode === "selected" && selectedText
        ? `修订第${chapterNumber}章选中内容：\n[选中文本]\n${selectedText}\n\n[要求]\n${brief}`
        : `修订第${chapterNumber}章：${brief}`;

      await sendMessage(sessionId, instruction, bookId);
    } finally {
      setSending(false);
      setBrief("");
    }
  }, [activeSessionId, bookId, chapterNumber, mode, selectedText, brief, sending, sendMessage, createDraftSession]);

  const canRevise = brief.trim().length > 0 && !sending
    && (mode !== "selected" || selectedText.length > 0);

  return (
    <div className="border-t border-border/20 bg-card/30 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-foreground/90">AI 修订</span>
        <div className="flex items-center gap-1 rounded-lg border border-border/30 p-0.5">
          <button
            type="button"
            onClick={() => setMode("selected")}
            disabled={!selectedText}
            className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
              mode === "selected"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground disabled:opacity-30"
            }`}
            title={!selectedText ? "请先在正文中选择文本" : undefined}
          >
            选中
          </button>
          <button
            type="button"
            onClick={() => setMode("full")}
            className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
              mode === "full"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            全文
          </button>
        </div>
      </div>

      {mode === "selected" && selectedText && (
        <div className="mb-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            选中内容
          </div>
          <p className="text-xs text-foreground/80 line-clamp-2 leading-5">
            {selectedText}
          </p>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder={mode === "selected" ? "输入选中文本的修订说明..." : "输入全文修订说明..."}
        disabled={sending}
        rows={2}
        className="w-full rounded-lg border border-border/40 bg-background px-3 py-1.5 text-xs outline-none transition-colors focus:border-primary/40 resize-none disabled:opacity-50"
      />

      <div className="mt-2">
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
          {sending ? "发送中..." : "发送至聊天面板"}
        </button>
      </div>
    </div>
  );
}
