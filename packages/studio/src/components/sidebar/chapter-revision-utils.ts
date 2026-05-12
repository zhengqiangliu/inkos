export type ChapterRevisionMode = "selected" | "full";

export function resolveChapterRevisionMode(selectedText: string): ChapterRevisionMode {
  return selectedText.trim().length > 0 ? "selected" : "full";
}

export interface ChapterRevisionModeMeta {
  readonly mode: ChapterRevisionMode;
  readonly label: string;
  readonly hint: string;
  readonly chipClassName: string;
  readonly panelClassName: string;
}

export function getChapterRevisionModeMeta(selectedText: string): ChapterRevisionModeMeta {
  const mode = resolveChapterRevisionMode(selectedText);
  if (mode === "selected") {
    return {
      mode,
      label: "正文选中模式",
      hint: "已自动切换为选中内容修订",
      chipClassName: "border-primary/30 bg-primary/15 text-primary",
      panelClassName: "border-primary/25 bg-[linear-gradient(180deg,oklch(1_0_0_/_0.96),oklch(0.98_0.01_70_/_0.94))]",
    };
  }
  return {
    mode,
    label: "全文模式",
    hint: "未选中文本，默认按全文修订",
    chipClassName: "border-border/30 bg-muted/45 text-muted-foreground",
    panelClassName: "border-border/25 bg-[linear-gradient(180deg,oklch(1_0_0_/_0.94),oklch(0.98_0.01_75_/_0.88))]",
  };
}

export function getChapterRevisionDisplayMeta(
  selectedText: string,
  selectionModeActive: boolean,
): ChapterRevisionModeMeta {
  const base = getChapterRevisionModeMeta(selectedText);
  if (selectionModeActive && base.mode === "full") {
    return {
      mode: "selected",
      label: "AI 选择模式",
      hint: "请在正文中拖选需要修改的片段，右上角会自动弹出修改弹窗。",
      chipClassName: "border-primary/30 bg-primary/15 text-primary",
      panelClassName: "border-primary/25 bg-[linear-gradient(180deg,oklch(1_0_0_/_0.96),oklch(0.98_0.01_70_/_0.94))]",
    };
  }
  return base;
}

export function buildChapterRevisionInstruction(input: {
  readonly chapterNumber: number;
  readonly selectedText: string;
  readonly brief: string;
  readonly mode: ChapterRevisionMode;
}): string {
  const { chapterNumber, selectedText, brief, mode } = input;
  if (mode === "selected" && selectedText.trim().length > 0) {
    return `请对第${chapterNumber}章选中的文本按要求修改，不要改动其他内容：\n\n[选中文本]\n${selectedText}\n\n[要求]\n${brief}`;
  }
  return `请按要求修改第${chapterNumber}章，不要改动其他内容：\n${brief}`;
}
