import { describe, expect, it, vi } from "vitest";
import {
  SCRIPT_WORKSPACE_FLAG_KEY,
  consumeScriptWorkspaceAutoOpenFlag,
  markScriptWorkspaceAutoOpen,
} from "./script-workspace-routing";

describe("script workspace routing", () => {
  it("marks the detail page to auto-open script mode", () => {
    const setItem = vi.fn();

    markScriptWorkspaceAutoOpen({ setItem });

    expect(setItem).toHaveBeenCalledWith(SCRIPT_WORKSPACE_FLAG_KEY, "1");
  });

  it("consumes the auto-open flag only when book data is ready", () => {
    const getItem = vi.fn(() => "1");
    const removeItem = vi.fn();

    expect(consumeScriptWorkspaceAutoOpenFlag({ getItem, removeItem }, false)).toBe(false);
    expect(removeItem).not.toHaveBeenCalled();

    expect(consumeScriptWorkspaceAutoOpenFlag({ getItem, removeItem }, true)).toBe(true);
    expect(removeItem).toHaveBeenCalledWith(SCRIPT_WORKSPACE_FLAG_KEY);
  });

  it("ignores missing flags", () => {
    const getItem = vi.fn(() => null);
    const removeItem = vi.fn();

    expect(consumeScriptWorkspaceAutoOpenFlag({ getItem, removeItem }, true)).toBe(false);
    expect(removeItem).not.toHaveBeenCalled();
  });
});
