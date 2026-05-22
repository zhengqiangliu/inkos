import { describe, expect, it } from "vitest";
import { resolveBookAgentInstruction } from "./agent-instruction.js";

describe("agent-instruction", () => {
  it("builds deterministic write-next instruction", () => {
    expect(resolveBookAgentInstruction("write-next", { language: "zh" })).toBe("写下一章");
    expect(resolveBookAgentInstruction("write-next", { language: "en" })).toBe("write next chapter");
  });

  it("builds deterministic rewrite instruction with optional brief", () => {
    expect(resolveBookAgentInstruction("rewrite", { chapterNumber: 12, language: "zh" })).toBe("重写第12章");
    expect(resolveBookAgentInstruction("rewrite", { chapterNumber: 12, language: "en" })).toBe("rewrite chapter 12");
    expect(resolveBookAgentInstruction("rewrite", { chapterNumber: 12, language: "zh", brief: "聚焦主线" })).toBe("重写第12章 聚焦主线");
    expect(resolveBookAgentInstruction("rewrite", {
      chapterNumber: 12,
      language: "zh",
      auditReport: "审计通过，发现2项问题。",
    })).toContain("最新审计报告：");
  });
});
