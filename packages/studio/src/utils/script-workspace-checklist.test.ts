import { describe, expect, it } from "vitest";
import {
  buildScriptWorkspaceChecklistTemplate,
  listScriptWorkspaceChecklistTemplates,
  resolveScriptWorkspaceChecklistTemplateId,
} from "./script-workspace-checklist";

describe("buildScriptWorkspaceChecklistTemplate", () => {
  it("returns the default novel-to-script checklist template", () => {
    expect(buildScriptWorkspaceChecklistTemplate()).toEqual([
      expect.objectContaining({ id: "scope", text: "确认选章/选集范围", order: 0 }),
      expect.objectContaining({ id: "extract", text: "提取场景、角色、道具、素材", order: 1 }),
      expect.objectContaining({ id: "script", text: "生成剧本与分场", order: 2 }),
      expect.objectContaining({ id: "image-prompt", text: "生成文生图提示词", order: 3 }),
      expect.objectContaining({ id: "video-prompt", text: "生成图生视频提示词", order: 4 }),
      expect.objectContaining({ id: "review", text: "复核并保存", order: 5 }),
    ]);
  });

  it("supports multiple checklist templates", () => {
    expect(listScriptWorkspaceChecklistTemplates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "short-video", label: "短视频改编" }),
      expect.objectContaining({ id: "comic-adaptation", label: "漫改分镜" }),
      expect.objectContaining({ id: "previs", label: "电影预演" }),
    ]));

    expect(buildScriptWorkspaceChecklistTemplate("comic-adaptation")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "scene-board", text: "拆分镜头级场景板" }),
      expect.objectContaining({ id: "video-prompt", text: "生成镜头运动与转场提示词" }),
    ]));
  });

  it("falls back to the default template for unknown ids", () => {
    expect(resolveScriptWorkspaceChecklistTemplateId("unknown")).toBe("short-video");
    expect(buildScriptWorkspaceChecklistTemplate("unknown")).toEqual(buildScriptWorkspaceChecklistTemplate("short-video"));
  });
});
