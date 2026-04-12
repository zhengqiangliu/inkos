import { describe, expect, it } from "vitest";
import { renderComposerDisplay } from "../tui/composer-display.js";

describe("tui composer display", () => {
  it("renders placeholder when empty", () => {
    expect(renderComposerDisplay("", "Ask InkOS", false)).toEqual({
      text: "Ask InkOS",
      cursor: "",
      isPlaceholder: true,
    });
  });

  it("renders plain input text with a blinking bar cursor when active", () => {
    expect(renderComposerDisplay("continue", "Ask InkOS", true)).toEqual({
      text: "continue",
      cursor: "│",
      isPlaceholder: false,
    });
  });

  it("hides the cursor between blink frames", () => {
    expect(renderComposerDisplay("continue", "Ask InkOS", false)).toEqual({
      text: "continue",
      cursor: "",
      isPlaceholder: false,
    });
  });
});
