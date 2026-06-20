import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyBulkUpdateToProductionShots,
  filterAndSortProductionShots,
  formatEditableStringList,
  normalizeEditableStringList,
  buildScriptWorkspaceExtractionGroups,
  ProductionWorkspacePanel,
  resolveDisplayedChapterPlans,
  reorderProductionEpisodeShots,
  shouldAutoOpenFirstChapter,
  updateProductionWorkspaceEpisode,
  updateProductionWorkspaceShot,
} from "./BookDetail";
import type { AssetLibrary, DirectorPlan, ProductionWorkspace, ScriptWorkspace } from "../shared/contracts";

describe("shouldAutoOpenFirstChapter", () => {
  it("opens the first chapter when nothing is active", () => {
    expect(shouldAutoOpenFirstChapter([
      { number: 1, title: "第一章", status: "drafted", wordCount: 1200 },
    ], null)).toBe(true);
  });

  it("does not reopen when a chapter is already selected", () => {
    expect(shouldAutoOpenFirstChapter([
      { number: 1, title: "第一章", status: "drafted", wordCount: 1200 },
    ], 1)).toBe(false);
  });

  it("does not open when there are no chapters", () => {
    expect(shouldAutoOpenFirstChapter([], null)).toBe(false);
  });
});

describe("resolveDisplayedChapterPlans", () => {
  it("prefers the latest sidebar snapshot over stale api data", () => {
    const apiData = {
      count: 1,
      plans: [
        {
          chapterNumber: 1,
          chapterName: "旧方案",
          highlight: "旧看点",
          coreConflict: "旧冲突",
          plotAndConflict: "旧剧情",
          emotionalTone: "旧基调",
          endingHook: "旧钩子",
          status: "planned",
          source: "ai",
          version: 1,
        },
      ],
    };
    const snapshot = [
      {
        chapterNumber: 2,
        chapterName: "新方案",
        highlight: "新看点",
        coreConflict: "新冲突",
        plotAndConflict: "新剧情",
        emotionalTone: "新基调",
        endingHook: "新钩子",
        status: "planned",
        source: "ai",
        version: 1,
      },
    ];

    expect(resolveDisplayedChapterPlans(apiData, snapshot)).toEqual(snapshot);
  });
});

describe("production workspace editing helpers", () => {
  const workspace: ProductionWorkspace = {
    bookId: "demo-book",
    selectedChapterNumbers: [3],
    updatedAt: "2026-06-10T00:00:00.000Z",
    sourceScriptUpdatedAt: "2026-06-10T00:00:00.000Z",
    sourceConfig: {
      generationStrategy: "chapter",
      chaptersPerEpisode: 1,
      visualStyle: "电影感夜景",
      directorMethod: "缓推",
      aiTool: "即梦Ai",
      aiModel: "turbo",
      episodeDurationSec: 45,
      segmentDurationSec: 15,
      segmentDurationMinSec: 10,
      segmentDurationMaxSec: 15,
      scriptPrompts: {
        script: "生成剧本",
        image: "生成图片",
        video: "生成视频",
      },
    },
    episodes: [
      {
        episodeNumber: 1,
        chapterNumber: 3,
        title: "第1集",
        chapterTitle: "天台对峙",
        summary: "楼顶交锋",
        durationSec: 45,
        trackCount: 1,
        shots: [
          {
            id: "shot-1",
            episodeNumber: 1,
            chapterNumber: 3,
            segmentId: "seg-1",
            segmentOrder: 0,
            shotNumber: 1,
            track: "main",
            title: "镜头1",
            scene: "楼顶 / 夜晚",
            durationSec: 15,
            shotType: "近景",
            cameraMovement: "缓推",
            dialogue: "把文件交出来",
            dialogueType: "dialogue",
            mood: "克制紧张",
            lighting: "低照度冷色边缘光",
            shouldGenerateImage: true,
            characters: ["陈默", "林雾"],
            props: ["文件"],
            assets: ["场景素材:楼顶"],
            scriptText: "陈默逼近林雾。",
            textToImagePrompt: "楼顶近景",
            imageToVideoPrompt: "15秒缓推",
          },
        ],
      },
    ],
  };
  const directorPlan: DirectorPlan = {
    bookId: "demo-book",
    updatedAt: "2026-06-10T00:00:00.000Z",
    sourceProductionUpdatedAt: "2026-06-10T00:00:00.000Z",
    sourceConfig: workspace.sourceConfig,
    visualStatement: "统一夜景写实风格",
    directorIntent: "保持人物对峙与缓推压迫感",
    visualRules: ["角色造型统一", "夜景反差明确"],
    cameraRules: ["对白镜头保持轴线", "动作镜头优先缓推"],
    colorScript: ["第1集：冷色边缘光"],
    episodePlans: [
      {
        episodeNumber: 1,
        title: "第1集",
        storyGoal: "完成楼顶对峙的核心信息交代",
        emotionalBeat: "克制紧张 -> 压迫升级",
        pacing: "45 秒内完成两次情绪抬升",
        lensLanguage: "近景与缓推交替",
        blockingNotes: "角色保持对角站位",
        lightingNotes: "低照度冷色边缘光",
        soundNotes: "保留对白与风声",
        continuityNotes: "文件道具持续出现在画面内",
      },
    ],
  };
  const assetLibrary: AssetLibrary = {
    bookId: "demo-book",
    updatedAt: "2026-06-10T00:00:00.000Z",
    sourceProductionUpdatedAt: "2026-06-10T00:00:00.000Z",
    items: [
      {
        id: "asset-1",
        type: "character",
        name: "陈默",
        description: "主角造型参考",
        episodeNumbers: [1],
        shotIds: ["shot-1"],
        referenceCount: 1,
        prompt: "电影感夜景，陈默，冷峻写实",
        status: "draft",
        thumbnailPath: "assets/thumbs/chenmo.png",
        filePath: "assets/library/chenmo.png",
        generation: {
          imageStatus: "pending",
          videoStatus: "pending",
          needsRegeneration: false,
          lastError: "",
          notes: "",
        },
        tags: ["第1集", "character"],
      },
    ],
  };

  it("normalizes editable list strings", () => {
    expect(normalizeEditableStringList("陈默、 林雾, 文件\n背包")).toEqual(["陈默", "林雾", "文件", "背包"]);
    expect(formatEditableStringList(["陈默", "林雾"])).toBe("陈默、林雾");
  });

  it("updates an episode in production workspace", () => {
    const updated = updateProductionWorkspaceEpisode(workspace, 1, (episode) => ({
      ...episode,
      title: "第1集-修订",
      trackCount: 2,
    }));
    expect(updated.episodes[0]?.title).toBe("第1集-修订");
    expect(updated.episodes[0]?.trackCount).toBe(2);
    expect(updated.updatedAt).not.toBe(workspace.updatedAt);
  });

  it("updates a shot in production workspace", () => {
    const updated = updateProductionWorkspaceShot(workspace, "shot-1", (shot) => ({
      ...shot,
      shotType: "全景",
      characters: ["陈默"],
      shouldGenerateImage: false,
    }));
    expect(updated.episodes[0]?.shots[0]).toMatchObject({
      shotType: "全景",
      characters: ["陈默"],
      shouldGenerateImage: false,
    });
    expect(updated.updatedAt).not.toBe(workspace.updatedAt);
  });

  it("filters and sorts production shots", () => {
    const shots = [
      workspace.episodes[0]!.shots[0]!,
      {
        ...workspace.episodes[0]!.shots[0]!,
        id: "shot-2",
        shotNumber: 2,
        title: "镜头2",
        scene: "仓库 / 夜晚",
        durationSec: 8,
        dialogue: "",
        dialogueType: "none" as const,
        shouldGenerateImage: false,
        characters: ["顾临"],
        props: ["背包"],
      },
      {
        ...workspace.episodes[0]!.shots[0]!,
        id: "shot-3",
        shotNumber: 3,
        title: "镜头3",
        scene: "街道 / 黄昏",
        durationSec: 20,
        dialogue: "别跟着我",
        dialogueType: "voiceover" as const,
        shouldGenerateImage: true,
        characters: ["顾临"],
      },
    ];

    expect(filterAndSortProductionShots(shots, {
      search: "仓库",
      dialogueType: "all",
      imageFilter: "all",
      sortMode: "shot-number",
    }).map((shot) => shot.id)).toEqual(["shot-2"]);

    expect(filterAndSortProductionShots(shots, {
      search: "",
      dialogueType: "dialogue",
      imageFilter: "all",
      sortMode: "shot-number",
    }).map((shot) => shot.id)).toEqual(["shot-1"]);

    expect(filterAndSortProductionShots(shots, {
      search: "",
      dialogueType: "all",
      imageFilter: "skip-image",
      sortMode: "shot-number",
    }).map((shot) => shot.id)).toEqual(["shot-2"]);

    expect(filterAndSortProductionShots(shots, {
      search: "",
      dialogueType: "all",
      imageFilter: "all",
      sortMode: "duration-desc",
    }).map((shot) => shot.id)).toEqual(["shot-3", "shot-1", "shot-2"]);

    expect(filterAndSortProductionShots(shots, {
      search: "",
      dialogueType: "all",
      imageFilter: "all",
      sortMode: "dialogue-first",
    }).map((shot) => shot.id)).toEqual(["shot-1", "shot-3", "shot-2"]);
  });

  it("applies bulk updates to filtered production shots", () => {
    const bulkWorkspace: ProductionWorkspace = {
      ...workspace,
      episodes: [
        {
          ...workspace.episodes[0]!,
          shots: [
            workspace.episodes[0]!.shots[0]!,
            {
              ...workspace.episodes[0]!.shots[0]!,
              id: "shot-2",
              shotNumber: 2,
              shouldGenerateImage: false,
              dialogueType: "none",
              characters: ["顾临"],
              props: ["背包"],
              assets: ["场景素材:仓库"],
            },
          ],
        },
      ],
    };

    const updated = applyBulkUpdateToProductionShots(bulkWorkspace, ["shot-1", "shot-2"], {
      shouldGenerateImage: true,
      dialogueType: "voiceover",
      addCharacters: ["旁白"],
      removeCharacters: ["陈默"],
      addProps: ["照片"],
      removeProps: ["文件"],
      addAssets: ["镜头类型:全景"],
      removeAssets: ["场景素材:楼顶"],
    });

    expect(updated.episodes[0]?.shots[0]).toMatchObject({
      shouldGenerateImage: true,
      dialogueType: "voiceover",
      characters: ["林雾", "旁白"],
      props: ["照片"],
      assets: ["镜头类型:全景"],
    });
    expect(updated.episodes[0]?.shots[1]).toMatchObject({
      shouldGenerateImage: true,
      dialogueType: "voiceover",
      characters: ["顾临", "旁白"],
      props: ["背包", "照片"],
      assets: ["场景素材:仓库", "镜头类型:全景"],
    });
    expect(updated.updatedAt).not.toBe(bulkWorkspace.updatedAt);
  });

  it("reorders shots within an episode and recalculates shot numbers", () => {
    const reorderWorkspace: ProductionWorkspace = {
      ...workspace,
      episodes: [
        {
          ...workspace.episodes[0]!,
          shots: [
            workspace.episodes[0]!.shots[0]!,
            {
              ...workspace.episodes[0]!.shots[0]!,
              id: "shot-2",
              shotNumber: 2,
              title: "镜头2",
            },
            {
              ...workspace.episodes[0]!.shots[0]!,
              id: "shot-3",
              shotNumber: 3,
              title: "镜头3",
            },
          ],
        },
      ],
    };

    const movedUp = reorderProductionEpisodeShots(reorderWorkspace, 1, "shot-3", "up");
    expect(movedUp.episodes[0]?.shots.map((shot) => [shot.id, shot.shotNumber])).toEqual([
      ["shot-1", 1],
      ["shot-3", 2],
      ["shot-2", 3],
    ]);

    const movedDown = reorderProductionEpisodeShots(reorderWorkspace, 1, "shot-1", "down");
    expect(movedDown.episodes[0]?.shots.map((shot) => [shot.id, shot.shotNumber])).toEqual([
      ["shot-2", 1],
      ["shot-1", 2],
      ["shot-3", 3],
    ]);
    expect(movedDown.updatedAt).not.toBe(reorderWorkspace.updatedAt);
  });

  it("renders the editable production workspace panel", () => {
    const html = renderToStaticMarkup(
      createElement(ProductionWorkspacePanel, {
        bookId: "demo-book",
        workspace,
        directorPlan,
        assetLibrary,
        generating: false,
        saving: false,
        directorPlanGenerating: false,
        directorPlanSaving: false,
        assetLibraryGenerating: false,
        assetLibrarySaving: false,
        onChange: () => {},
        onDirectorPlanChange: () => {},
        onAssetLibraryChange: () => {},
        onGenerate: () => {},
        onSave: () => {},
        onOpenDirectorPlanHistory: () => {},
        onOpenAssetLibraryHistory: () => {},
        onGenerateDirectorPlan: () => {},
        onSaveDirectorPlan: () => {},
        onGenerateAssetLibrary: () => {},
        onSaveAssetLibrary: () => {},
        onUploadAssetLibraryFile: async () => {},
      }),
    );
    expect(html).toContain("生产工作台");
    expect(html).toContain("导演规划");
    expect(html).toContain("资产库");
    expect(html).toContain("镜头标题");
    expect(html).toContain("文生图提示词");
    expect(html).toContain("图生视频提示词");
    expect(html).toContain("搜索镜头");
    expect(html).toContain("对白筛选");
    expect(html).toContain("批量操作当前筛选结果");
    expect(html).toContain("应用出图状态");
    expect(html).toContain("上移");
    expect(html).toContain("下移");
    expect(html).toContain("引用镜头数");
    expect(html).toContain("缩略图路径");
    expect(html).toContain("素材文件路径");
    expect(html).toContain("版本历史");
    expect(html).toContain("第1集");
    expect(html).toContain("楼顶交锋");
  });

  it("renders the production workspace loading state", () => {
    const html = renderToStaticMarkup(
      createElement(ProductionWorkspacePanel, {
        bookId: "demo-book",
        workspace: null,
        directorPlan: null,
        assetLibrary: null,
        generating: false,
        saving: false,
        directorPlanGenerating: false,
        directorPlanSaving: false,
        assetLibraryGenerating: false,
        assetLibrarySaving: false,
        onChange: () => {},
        onDirectorPlanChange: () => {},
        onAssetLibraryChange: () => {},
        onGenerate: () => {},
        onSave: () => {},
        onOpenDirectorPlanHistory: () => {},
        onOpenAssetLibraryHistory: () => {},
        onGenerateDirectorPlan: () => {},
        onSaveDirectorPlan: () => {},
        onGenerateAssetLibrary: () => {},
        onSaveAssetLibrary: () => {},
        onUploadAssetLibraryFile: async () => {},
      }),
    );
    expect(html).toContain("生产工作区加载中");
  });
});

describe("script workspace extraction groups", () => {
  const scriptWorkspace: ScriptWorkspace = {
    bookId: "demo-book",
    selectedChapterNumbers: [1, 2],
    updatedAt: "2026-06-10T00:00:00.000Z",
    config: {
      visualStyle: "电影感",
      directorMethod: "缓推",
      aiTool: "即梦Ai",
      aiModel: "turbo",
      generationStrategy: "episode",
      chaptersPerEpisode: 2,
      episodeDurationSec: 45,
      segmentDurationSec: 15,
      segmentDurationMinSec: 10,
      segmentDurationMaxSec: 15,
      scriptPrompts: {
        script: "生成剧本",
        image: "生成文生图",
        video: "生成图生视频",
      },
    },
    scriptPrompt: "prompt",
    extraction: {
      scenes: [
        {
          id: "scene-1",
          episodeNumber: 1,
          chapterNumber: 1,
          sourceChapterNumbers: [1],
          title: "楼顶",
          description: "楼顶对峙",
          location: "楼顶",
          timeOfDay: "夜晚",
          characters: ["陈默"],
          props: ["文件"],
          assets: ["场景素材"],
        },
      ],
      characters: [
        { name: "陈默", description: "主角", sourceChapterNumbers: [1] },
        { name: "林雾", description: "配角", sourceChapterNumbers: [2] },
      ],
      props: [
        { name: "文件", description: "关键道具", sourceChapterNumbers: [1] },
      ],
      assets: [
        { name: "场景素材", description: "楼顶素材", sourceChapterNumbers: [1, 2] },
      ],
    },
    episodes: [
      {
        episodeNumber: 1,
        chapterNumber: 1,
        sourceChapterNumbers: [1, 2],
        chapterTitle: "第一章 / 第二章",
        title: "第1集",
        summary: "楼顶交锋",
        durationSec: 45,
        segments: [],
      },
    ],
  };

  const chapters = [
    { number: 1, title: "第一章", status: "done", wordCount: 1000 },
    { number: 2, title: "第二章", status: "done", wordCount: 1000 },
  ] as const;

  it("groups extraction by episode", () => {
    const groups = buildScriptWorkspaceExtractionGroups(scriptWorkspace, chapters, "episode");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("第1集");
    expect(groups[0]?.characters.map((item) => item.name)).toContain("林雾");
  });

  it("groups extraction by chapter", () => {
    const groups = buildScriptWorkspaceExtractionGroups(scriptWorkspace, chapters, "chapter");
    expect(groups.map((group) => group.title)).toEqual(["第1章 第一章", "第2章 第二章"]);
    expect(groups[0]?.characters.map((item) => item.name)).toContain("陈默");
    expect(groups[1]?.characters.map((item) => item.name)).toContain("林雾");
  });
});
