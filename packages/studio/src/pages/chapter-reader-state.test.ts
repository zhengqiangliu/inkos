import { describe, expect, it } from "vitest";
import { resolveChapterReaderSelectionState } from "./chapter-reader-state";

describe("resolveChapterReaderSelectionState", () => {
  it("shows the floating toolbar when editing text is selected", () => {
    expect(resolveChapterReaderSelectionState({
      editing: true,
      selectionModeActive: false,
      editorSelectedText: "选中内容",
      viewerSelectedText: "",
      viewerIsSelecting: false,
    })).toMatchObject({
      selectedText: "选中内容",
      hasSelection: true,
      effectiveSelectionMode: true,
      showFloatingToolbar: true,
    });
  });

  it("keeps full-mode toolbar hidden until a viewer selection exists", () => {
    expect(resolveChapterReaderSelectionState({
      editing: false,
      selectionModeActive: false,
      editorSelectedText: "",
      viewerSelectedText: "",
      viewerIsSelecting: false,
    })).toMatchObject({
      hasSelection: false,
      effectiveSelectionMode: false,
      showFloatingToolbar: false,
    });
  });
});
