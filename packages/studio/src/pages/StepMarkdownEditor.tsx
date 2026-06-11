import { Edit3, Save, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import type { StepMarkdownSpec } from "./book-create-state";

const streamdownPlugins = { cjk };

export function StepMarkdownEditor(props: {
  readonly spec: StepMarkdownSpec;
  readonly value: string;
  readonly editing: boolean;
  readonly onToggleEditing: () => void;
  readonly onSave?: () => void | Promise<boolean | void>;
  readonly onValueChange: (value: string) => void;
  readonly onAiModify?: (note: string, mode: "revise" | "polish") => void;
  readonly showAiActions?: boolean;
  readonly disabled?: boolean;
  readonly saving?: boolean;
  readonly onSaveSuccess?: () => void;
}) {
  const {
    spec,
    value,
    editing,
    onToggleEditing,
    onSave,
    onValueChange,
    onAiModify,
    showAiActions = true,
    disabled,
    saving,
    onSaveSuccess,
  } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptMode, setPromptMode] = useState<"revise" | "polish">("revise");
  const [promptNote, setPromptNote] = useState("");

  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 560)}px`;
    };
    resize();
  }, [editing, value]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-border/60 bg-background/50 p-4">
      <div className="flex items-start justify-between gap-3 pb-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{spec.title}</div>
          <div className="text-xs text-muted-foreground">{spec.description}</div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onToggleEditing} disabled={disabled} className="rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground disabled:opacity-50">
            <Edit3 size={12} className="mr-1 inline-block" />
            {editing ? "预览" : "编辑"}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={async () => {
                const result = await onSave?.();
                if (result !== false) {
                  onSaveSuccess?.();
                }
              }}
              disabled={disabled || saving || !onSave}
              className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs font-medium text-primary disabled:opacity-50"
            >
              <Save size={12} className="mr-1 inline-block" />
              {saving ? "保存中..." : "保存"}
            </button>
          ) : null}
          {showAiActions ? (
            <>
              <button type="button" onClick={() => { setPromptMode("revise"); setPromptOpen(true); }} disabled={disabled} className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs font-medium text-primary disabled:opacity-50">
                <Sparkles size={12} className="mr-1 inline-block" />
                AI 修改
              </button>
              <button type="button" onClick={() => { setPromptMode("polish"); setPromptOpen(true); }} disabled={disabled} className="rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground disabled:opacity-50">
                AI 润色
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 rounded-xl border border-border/50 bg-background/60">
          {editing ? (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              className="h-full min-h-0 w-full flex-1 resize-none rounded-xl bg-transparent px-4 py-3 text-sm leading-7 outline-none"
              placeholder={spec.sections.map((section) => section.placeholder).join("\n\n")}
            />
          ) : (
            <div className="prose prose-sm max-w-none flex h-full min-h-0 w-full min-w-0 flex-1 overflow-auto px-4 py-3 break-words">
              <Streamdown className="w-full min-w-0 max-w-none break-words [&_*]:min-w-0" plugins={streamdownPlugins} mode="static">{value || "暂无内容"}</Streamdown>
            </div>
          )}
        </div>
      </div>
      <Dialog open={showAiActions && promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{promptMode === "polish" ? "AI 润色" : "AI 修改"}</DialogTitle>
            <DialogDescription>输入修改要求后，Agent 会修改当前页 Markdown，并同步到右侧 AI 工作台。</DialogDescription>
          </DialogHeader>
          <textarea
            value={promptNote}
            onChange={(e) => setPromptNote(e.target.value)}
            className="min-h-[220px] w-full resize-none rounded-xl border border-border/50 bg-background/70 px-3 py-2 text-sm leading-6 outline-none"
            placeholder="例如：补充节奏、强化冲突、调整层次、改成更清晰的 Markdown 结构..."
          />
          <DialogFooter>
            <button type="button" onClick={() => setPromptOpen(false)} className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground">
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                onAiModify?.(promptNote, promptMode);
                setPromptOpen(false);
                setPromptNote("");
              }}
              disabled={!promptNote.trim() || !onAiModify}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              确认修改
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
