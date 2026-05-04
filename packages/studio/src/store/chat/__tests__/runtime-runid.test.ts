import { describe, expect, it } from "vitest";
import { buildAgentRunId, isExplicitWriteNextCommand, sessionMatchesEvent } from "../slices/message/runtime";

describe("sessionMatchesEvent runId guard", () => {
  it("matches only same session when runId is not required", () => {
    expect(sessionMatchesEvent("s1", { sessionId: "s1" })).toBe(true);
    expect(sessionMatchesEvent("s1", { sessionId: "s2" })).toBe(false);
  });

  it("matches both sessionId and runId when runId is provided", () => {
    expect(sessionMatchesEvent("s1", { sessionId: "s1", runId: "r1" }, "r1")).toBe(true);
    expect(sessionMatchesEvent("s1", { sessionId: "s1", runId: "r2" }, "r1")).toBe(false);
    expect(sessionMatchesEvent("s1", { sessionId: "s1" }, "r1")).toBe(false);
  });
});

describe("buildAgentRunId", () => {
  it("produces timestamp-random identifiers", () => {
    const runId = buildAgentRunId();
    expect(runId).toMatch(/^\d+-[a-z0-9]{6}$/);
  });
});

describe("isExplicitWriteNextCommand", () => {
  it("matches explicit deterministic write-next commands only", () => {
    expect(isExplicitWriteNextCommand("写下一章")).toBe(true);
    expect(isExplicitWriteNextCommand("连续写2章")).toBe(true);
    expect(isExplicitWriteNextCommand("写17章")).toBe(true);
    expect(isExplicitWriteNextCommand("写第17章")).toBe(true);
    expect(isExplicitWriteNextCommand("写第17章。")).toBe(true);
    expect(isExplicitWriteNextCommand("write next chapter")).toBe(true);
    expect(isExplicitWriteNextCommand("write 3 chapters")).toBe(true);
    expect(isExplicitWriteNextCommand("请写下一章并说明")).toBe(false);
    expect(isExplicitWriteNextCommand("重写第3章")).toBe(false);
  });
});
