import { describe, expect, it } from "vitest";
import type { SSEMessage } from "../hooks/use-sse";
import { resolveLatestAgentTokenSummary, resolveLatestBookTaskTokenSummary } from "./token-summary";

function msg(event: string, data: unknown, timestamp: number): SSEMessage {
  return { event, data, timestamp };
}

describe("token-summary", () => {
  it("keeps agent token summary when only agent:usage remains in the recent SSE buffer", () => {
    const messages = [
      msg("agent:start", { sessionId: "s1", runId: "r1" }, 1000),
      msg("agent:usage", { sessionId: "s1", runId: "r1", tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }, 1500),
    ];

    expect(resolveLatestAgentTokenSummary(messages, "s1", null, 2000)).toContain("总计 30");
  });

  it("resolves task token summary from the terminal complete event", () => {
    const messages = [
      msg("book-task:complete", {
        bookId: "book-1",
        task: {
          id: "task-1",
          status: "succeeded",
          tokenUsage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
          result: { tokenUsage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 } },
        },
      }, 3000),
    ];

    expect(resolveLatestBookTaskTokenSummary(messages, "book-1", 4000)).toContain("总计 46");
  });
});
