import { describe, expect, it } from "vitest";
import { resolveChapterRevisionContent } from "./chapter-revision-response";

describe("resolveChapterRevisionContent", () => {
  it("prefers draftRaw when present", () => {
    expect(resolveChapterRevisionContent({
      details: { draftRaw: "修订后的正文" },
      response: "fallback",
    })).toBe("修订后的正文");
  });

  it("falls back to response when draftRaw is absent", () => {
    expect(resolveChapterRevisionContent({
      response: "修订后的正文",
    })).toBe("修订后的正文");
  });
});
