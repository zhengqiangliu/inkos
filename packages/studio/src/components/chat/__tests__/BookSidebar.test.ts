import { describe, expect, it } from "vitest";
import {
  countChapterStatusBuckets,
  isSettingsConflictLog,
  resolveArtifactEndpoint,
  resolveEventBookId,
} from "../BookSidebar";

describe("BookSidebar tab helpers", () => {
  it("resolves event book id from payload", () => {
    expect(resolveEventBookId({ bookId: "b1" })).toBe("b1");
    expect(resolveEventBookId({ activeBookId: "b2" })).toBe("b2");
    expect(resolveEventBookId({})).toBeNull();
    expect(resolveEventBookId(null)).toBeNull();
  });

  it("detects settings conflict logs", () => {
    expect(isSettingsConflictLog("检测到设定冲突：角色年龄不一致")).toBe(true);
    expect(isSettingsConflictLog("story_bible requires update")).toBe(true);
    expect(isSettingsConflictLog("普通执行日志：写作完成")).toBe(false);
  });

  it("counts failed and unpublished chapter buckets", () => {
    const buckets = countChapterStatusBuckets([
      { status: "approved" },
      { status: "ready-for-review" },
      { status: "needs-revision" },
      { status: "audit-failed" },
      { status: "state-degraded" },
      { status: "drafted" },
    ]);
    expect(buckets.unpublished).toBe(1);
    expect(buckets.failed).toBe(3);
  });

  it("encodes nested truth artifact paths when building endpoints", () => {
    expect(resolveArtifactEndpoint("demo-book", "story/outline/volume_map.md", "truth")).toBe(
      "/books/demo-book/truth/story%2Foutline%2Fvolume_map.md",
    );
    expect(resolveArtifactEndpoint("demo-book", "volume.md", "wizard")).toBe(
      "/books/demo-book/wizard-file/volume.md",
    );
  });
});
