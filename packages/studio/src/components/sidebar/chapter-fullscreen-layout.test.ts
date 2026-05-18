import { describe, expect, it } from "vitest";
import {
  getChapterFullscreenPaginationCache,
  estimateChapterFullscreenMarkdownFit,
  resolveChapterFullscreenPaginationCacheKey,
  resolveChapterFullscreenContentHeightLimit,
  resolveChapterFullscreenContentWidth,
  resolveChapterFullscreenPageHeight,
  resolveChapterFullscreenPageWidth,
  resolveChapterFullscreenLineHeightMultiplier,
  resolveChapterFullscreenPaginationTimeoutMs,
  resolveChapterFullscreenRenderedPageCount,
  setChapterFullscreenPaginationCache,
} from "./chapter-fullscreen-layout";

describe("chapter fullscreen layout", () => {
  it("keeps page width identical across modes for the same viewport", () => {
    const viewportWidth = 1600;
    expect(resolveChapterFullscreenPageWidth("single", viewportWidth)).toBe(
      resolveChapterFullscreenPageWidth("spread", viewportWidth),
    );
  });

  it("keeps the shared paper width bounded to a two-page layout", () => {
    expect(resolveChapterFullscreenPageWidth("spread", 2400)).toBeLessThanOrEqual(520);
    expect(resolveChapterFullscreenPageWidth("single", 600)).toBeGreaterThanOrEqual(340);
  });

  it("keeps page height aligned across modes for the same viewport", () => {
    const singleWidth = resolveChapterFullscreenPageWidth("single", 1600);
    const spreadWidth = resolveChapterFullscreenPageWidth("spread", 1600);
    const singleHeight = resolveChapterFullscreenPageHeight(singleWidth, 1000);
    const spreadHeight = resolveChapterFullscreenPageHeight(spreadWidth, 1000);
    expect(singleHeight).toBe(spreadHeight);
  });

  it("keeps line-height identical across modes", () => {
    expect(resolveChapterFullscreenLineHeightMultiplier("single")).toBe(
      resolveChapterFullscreenLineHeightMultiplier("spread"),
    );
  });

  it("derives content size from the resolved paper size", () => {
    const width = resolveChapterFullscreenPageWidth("single", 1600);
    const height = resolveChapterFullscreenPageHeight(width, 1000);
    expect(resolveChapterFullscreenContentWidth(width)).toBeGreaterThan(0);
    expect(resolveChapterFullscreenContentHeightLimit(height)).toBeGreaterThan(0);
  });

  it("renders a single slot when spread mode only has one page", () => {
    expect(resolveChapterFullscreenRenderedPageCount("spread", 1)).toBe(1);
    expect(resolveChapterFullscreenRenderedPageCount("spread", 2)).toBe(2);
    expect(resolveChapterFullscreenRenderedPageCount("single", 2)).toBe(1);
  });

  it("gives spread mode and longer chapters more pagination time", () => {
    const singleShort = resolveChapterFullscreenPaginationTimeoutMs("single", 1000);
    const spreadShort = resolveChapterFullscreenPaginationTimeoutMs("spread", 1000);
    const singleLong = resolveChapterFullscreenPaginationTimeoutMs("single", 8000);
    expect(spreadShort).toBeGreaterThan(singleShort);
    expect(singleLong).toBeGreaterThan(singleShort);
  });

  it("classifies obvious fit and overflow cases without probing", () => {
    const width = resolveChapterFullscreenPageWidth("single", 1600);
    const height = resolveChapterFullscreenContentHeightLimit(
      resolveChapterFullscreenPageHeight(width, 1000),
    );
    expect(estimateChapterFullscreenMarkdownFit("短文。", {
      contentWidth: resolveChapterFullscreenContentWidth(width),
      contentHeightLimit: height,
      fontSize: 16,
      mode: "single",
    })).toBe("fit");
    expect(estimateChapterFullscreenMarkdownFit("长文".repeat(2500), {
      contentWidth: resolveChapterFullscreenContentWidth(width),
      contentHeightLimit: height,
      fontSize: 16,
      mode: "single",
    })).toBe("overflow");
  });

  it("caches pagination results by signature and content hash", () => {
    const cacheKey = resolveChapterFullscreenPaginationCacheKey("sig-a", "chapter body");
    setChapterFullscreenPaginationCache(cacheKey, ["page-1", "page-2"]);
    const cached = getChapterFullscreenPaginationCache(cacheKey);
    expect(cached).toEqual(["page-1", "page-2"]);
    expect(cached).not.toBeNull();
    expect(getChapterFullscreenPaginationCache(resolveChapterFullscreenPaginationCacheKey("sig-b", "chapter body"))).toBeNull();
  });

});
