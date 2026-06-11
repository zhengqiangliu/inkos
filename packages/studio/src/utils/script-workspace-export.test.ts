import { describe, expect, it } from "vitest";
import {
  buildEpisodeVideoPromptExportText,
  buildScriptWorkspaceExportFileName,
  buildWorkspaceVideoPromptExportText,
} from "./script-workspace-export";
import type { ScriptWorkspace } from "../shared/contracts";

const workspace: ScriptWorkspace = {
  bookId: "demo-book",
  selectedChapterNumbers: [3],
  updatedAt: "2026-06-10T00:00:00.000Z",
  config: {
    visualStyle: "国风赛博",
    directorMethod: "短促推镜",
    aiTool: "即梦Ai",
    aiModel: "turbo",
    episodeDurationSec: 45,
    segmentDurationSec: 15,
    segmentDurationMinSec: 15,
    segmentDurationMaxSec: 15,
    scriptPrompts: {
      script: "生成剧本",
      image: "生成文生图",
      video: "生成图生视频",
    },
  },
  scriptPrompt: "script prompt",
  extraction: {
    scenes: [],
    characters: [],
    props: [],
    assets: [],
  },
  episodes: [
    {
      episodeNumber: 1,
      chapterNumber: 3,
      chapterTitle: "天台对峙",
      title: "第1集",
      summary: "summary",
      durationSec: 45,
      segments: [
        {
          id: "seg-1",
          order: 0,
          episodeNumber: 1,
          chapterNumber: 3,
          title: "第一段",
          scene: "楼顶 / 夜晚",
          durationSec: 15,
          characters: [],
          props: [],
          assets: [],
          scriptText: "script",
          textToImagePrompt: "image prompt",
          imageToVideoPrompt: "video prompt A",
        },
        {
          id: "seg-2",
          order: 1,
          episodeNumber: 1,
          chapterNumber: 3,
          title: "第二段",
          scene: "楼顶 / 夜晚",
          durationSec: 15,
          characters: [],
          props: [],
          assets: [],
          scriptText: "script",
          textToImagePrompt: "image prompt",
          imageToVideoPrompt: "video prompt B",
        },
      ],
    },
  ],
};

describe("script workspace export", () => {
  it("builds a safe export file name", () => {
    expect(buildScriptWorkspaceExportFileName("我的小说:第一部", "全部视频提示词")).toBe("我的小说-第一部-全部视频提示词.txt");
  });

  it("builds per-episode video prompt export text", () => {
    const text = buildEpisodeVideoPromptExportText(workspace.episodes[0]!);

    expect(text).toContain("第1集");
    expect(text).toContain("章节：第3章 天台对峙");
    expect(text).toContain("[第一段]");
    expect(text).toContain("video prompt A");
    expect(text).toContain("[第二段]");
    expect(text).toContain("video prompt B");
  });

  it("builds full workspace video prompt export text", () => {
    const text = buildWorkspaceVideoPromptExportText(workspace);

    expect(text).toContain("小说转剧本 - 图生视频提示词汇总");
    expect(text).toContain("视觉风格：国风赛博");
    expect(text).toContain("导演手法：短促推镜");
    expect(text).toContain("AI：即梦Ai / turbo");
    expect(text).toContain("第1集");
  });
});
