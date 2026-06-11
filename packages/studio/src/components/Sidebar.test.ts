import { describe, expect, it } from "vitest";
import { getBookBadgeInitial } from "./Sidebar";

describe("Sidebar book badge", () => {
  it("uses the first meaningful character of the book title", () => {
    expect(getBookBadgeInitial("星海行者")).toBe("星");
    expect(getBookBadgeInitial("The Last Archive")).toBe("T");
    expect(getBookBadgeInitial("《深渊之门》")).toBe("深");
  });

  it("falls back safely for empty titles", () => {
    expect(getBookBadgeInitial("")).toBe("?");
    expect(getBookBadgeInitial("   ")).toBe("?");
  });
});
