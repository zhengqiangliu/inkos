import { describe, expect, it } from "vitest";
import { chatSelectors } from "../selectors";

describe("chatSelectors.activeWizardMessages", () => {
  it("only returns messages tagged with the requested wizard step", () => {
    const state = {
      activeSessionId: "s1",
      sessions: {
        s1: {
          messages: [
            { role: "user", content: "old", timestamp: 1 },
            { role: "assistant", content: "old assistant", timestamp: 2 },
            { role: "user", content: "world", timestamp: 3, wizardStep: "world" as const },
            { role: "assistant", content: "world assistant", timestamp: 4, wizardStep: "world" as const },
          ],
        },
      },
    } as never;

    const result = chatSelectors.activeWizardMessages(state, "world");
    expect(result).toHaveLength(2);
    expect(result.map((message) => message.content)).toEqual(["world", "world assistant"]);
  });
});
