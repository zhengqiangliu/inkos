import { describe, expect, it } from "vitest";
import { normalizeDialogueQuotesToDouble } from "../utils/dialogue-quotes";

describe("normalizeDialogueQuotesToDouble", () => {
  it("replaces corner quotes with double quotes", () => {
    expect(normalizeDialogueQuotesToDouble("他说：「你好」")).toBe("他说：“你好”");
  });

  it("leaves non-quote text unchanged", () => {
    expect(normalizeDialogueQuotesToDouble("旁白段落")).toBe("旁白段落");
  });
});
