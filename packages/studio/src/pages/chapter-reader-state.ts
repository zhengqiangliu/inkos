export interface ChapterReaderSelectionState {
  readonly selectedText: string;
  readonly hasSelection: boolean;
  readonly effectiveSelectionMode: boolean;
  readonly showFloatingToolbar: boolean;
}

export function resolveChapterReaderSelectionState(args: {
  readonly editing: boolean;
  readonly selectionModeActive: boolean;
  readonly editorSelectedText: string;
  readonly viewerSelectedText: string;
  readonly viewerIsSelecting: boolean;
}): ChapterReaderSelectionState {
  const selectedText = args.editing ? args.editorSelectedText : args.viewerSelectedText;
  const hasSelection = selectedText.trim().length > 0;
  const effectiveSelectionMode = args.selectionModeActive || hasSelection;
  const showFloatingToolbar = args.editing && (args.selectionModeActive || hasSelection);

  return {
    selectedText,
    hasSelection,
    effectiveSelectionMode,
    showFloatingToolbar,
  };
}
