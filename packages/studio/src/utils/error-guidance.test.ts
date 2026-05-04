import { describe, expect, it } from "vitest";
import { withErrorGuidance } from "./error-guidance";

describe("withErrorGuidance", () => {
  it("appends actionable suggestion for not-triggered writer errors", () => {
    const message = withErrorGuidance("写作失败：未触发写作器（writer），章节未生成。");
    expect(message).toContain("未触发写作器");
    expect(message).toContain("建议：请重试“写第N章”或“写下一章”");
  });

  it("does not duplicate suggestion when message already has guidance", () => {
    const source = "写作降级：正文已落盘，但第23章状态降级。建议：先修复后再继续。";
    const message = withErrorGuidance(source);
    expect(message).toBe(source);
  });

  it("returns original message when no rule matches", () => {
    const source = "quota exceeded";
    const message = withErrorGuidance(source);
    expect(message).toBe(source);
  });
});

