import { describe, expect, it } from "vitest";
import { deriveActiveBookId } from "./App";
import { routeToHash } from "./hooks/use-hash-route";

describe("deriveActiveBookId", () => {
  it("returns the current book across book-centered routes", () => {
    expect(deriveActiveBookId({ page: "book", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "book-create", bookId: "draft-alpha" })).toBe("draft-alpha");
    expect(deriveActiveBookId({ page: "chapter", bookId: "beta", chapterNumber: 3 })).toBe("beta");
    expect(deriveActiveBookId({ page: "truth", bookId: "gamma" })).toBe("gamma");
    expect(deriveActiveBookId({ page: "analytics", bookId: "delta" })).toBe("delta");
  });

  it("returns undefined for non-book routes", () => {
    expect(deriveActiveBookId({ page: "dashboard" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "services" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "style" })).toBeUndefined();
  });
});

describe("book create routing", () => {
  it("keeps book-create hash stable for fresh starts", () => {
    expect(routeToHash({ page: "book-create" })).toBe("#/book/new");
  });
});
