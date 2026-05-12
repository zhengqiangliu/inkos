import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import { ChapterPlanSchema } from "../models/chapter-plan.js";
import type { ChapterPlan } from "../models/chapter-plan.js";
import {
  buildChapterDesignUserMessage,
  getChapterDesignSystemPrompt,
  parseChapterDesignOutput,
  type ChapterDesignContext,
} from "./chapter-design-prompts.js";
import {
  readCharacterMatrix,
  readEmotionalArcs,
  readPendingHooks,
  formatRecentSummaries,
} from "./planner-context.js";
import { readStoryFrame } from "../utils/outline-paths.js";
import { extractChapterLimitFromOutline } from "../utils/chapter-limit.js";

export interface DesignChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly volumeOutline: string;
  readonly chapterNumber: number;
  readonly outlineChapterLimit?: number;
  readonly language?: string;
}

export interface DesignBatchInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly volumeOutline: string;
  readonly startChapter: number;
  readonly count: number;
  readonly outlineChapterLimit?: number;
  readonly existingPlans?: ReadonlyArray<ChapterPlan>;
  readonly language?: string;
}

export interface AnalyzeChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly volumeOutline: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly outlineChapterLimit?: number;
  readonly language?: string;
}

export class ChapterDesignAgent extends BaseAgent {
  get name(): string {
    return "chapter-design";
  }

  /**
   * Design a single chapter based on book context.
   */
  async designChapter(input: DesignChapterInput, existingPlans?: ReadonlyArray<ChapterPlan>): Promise<ChapterPlan> {
    const language = input.language ?? input.book.language ?? "zh";

    const context = await this.loadContext({
      bookDir: input.bookDir,
      volumeOutline: input.volumeOutline,
      referenceChapterNumber: input.chapterNumber,
      existingPlans,
      outlineChapterLimit: input.outlineChapterLimit,
    });

    if (typeof context.outlineChapterLimit === "number" && input.chapterNumber > context.outlineChapterLimit) {
      throw new Error(`Chapter ${input.chapterNumber} exceeds outline chapter limit ${context.outlineChapterLimit}`);
    }

    const messages = [
      { role: "system" as const, content: getChapterDesignSystemPrompt(language) },
      { role: "user" as const, content: buildChapterDesignUserMessage(context, input.chapterNumber, 1, language) },
    ];

    const response = await this.chat(messages, { temperature: 0.7 });

    const parsed = parseChapterDesignOutput(response.content, input.chapterNumber, 1);
    const first = parsed[0];

    if (!first) {
      throw new Error(`Failed to parse chapter design output for chapter ${input.chapterNumber}`);
    }

    const now = new Date().toISOString();
    return ChapterPlanSchema.parse({
      chapterNumber: input.chapterNumber,
      chapterName: first.chapterName,
      highlight: first.highlight,
      coreConflict: first.coreConflict,
      plotAndConflict: first.plotAndConflict,
      emotionalTone: first.emotionalTone || "推进",
      endingHook: first.endingHook,
      hookAssignment: first.hookAssignment,
      requiredRecoverHooks: first.requiredRecoverHooks,
      maxNewHooks: first.maxNewHooks,
      status: "planned",
      source: "auto",
      version: 1,
      needsReview: true,
      anchorRefs: {
        worldRefs: [],
        characterRefs: [],
        emotionRefs: [],
        hookRefs: [],
      },
      driftFlags: [],
      lockedFields: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Design multiple chapters in batch.
   * Reads more context to ensure coherence across chapters.
   */
  async designBatch(input: DesignBatchInput): Promise<ChapterPlan[]> {
    const language = input.language ?? input.book.language ?? "zh";

    const context = await this.loadContext({
      bookDir: input.bookDir,
      volumeOutline: input.volumeOutline,
      referenceChapterNumber: input.startChapter,
      existingPlans: input.existingPlans,
      outlineChapterLimit: input.outlineChapterLimit,
    });

    if (typeof context.outlineChapterLimit === "number" && input.startChapter > context.outlineChapterLimit) {
      return [];
    }

    const effectiveCount = typeof context.outlineChapterLimit === "number"
      ? Math.max(0, Math.min(input.count, context.outlineChapterLimit - input.startChapter + 1))
      : Math.max(0, input.count);

    if (effectiveCount <= 0) {
      return [];
    }

    const messages = [
      { role: "system" as const, content: getChapterDesignSystemPrompt(language) },
      { role: "user" as const, content: buildChapterDesignUserMessage(context, input.startChapter, effectiveCount, language) },
    ];

    const response = await this.chat(messages, { temperature: 0.7 });

    const parsed = parseChapterDesignOutput(response.content, input.startChapter, effectiveCount);
    if (parsed.length !== effectiveCount) {
      throw new Error(`Failed to parse complete chapter design output for chapters ${input.startChapter}-${input.startChapter + effectiveCount - 1}: expected ${effectiveCount}, got ${parsed.length}`);
    }
    const now = new Date().toISOString();

    return parsed.map((p, index) =>
      ChapterPlanSchema.parse({
        chapterNumber: input.startChapter + index,
        chapterName: p.chapterName,
        highlight: p.highlight,
        coreConflict: p.coreConflict,
        plotAndConflict: p.plotAndConflict,
        emotionalTone: p.emotionalTone || "推进",
        endingHook: p.endingHook,
        hookAssignment: p.hookAssignment,
        requiredRecoverHooks: p.requiredRecoverHooks,
        maxNewHooks: p.maxNewHooks,
        status: "planned",
        source: "auto",
        version: 1,
        needsReview: true,
        anchorRefs: {
          worldRefs: [],
          characterRefs: [],
          emotionRefs: [],
          hookRefs: [],
        },
        driftFlags: [],
        lockedFields: [],
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  private async loadContext(params: {
    readonly bookDir: string;
    readonly volumeOutline: string;
    readonly referenceChapterNumber: number;
    readonly existingPlans?: ReadonlyArray<ChapterPlan>;
    readonly outlineChapterLimit?: number;
  }): Promise<ChapterDesignContext> {
    const normalizedVolumeOutline = params.volumeOutline.trim();
    if (!normalizedVolumeOutline) {
      throw new Error("卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。");
    }

    const outlineChapterLimit = params.outlineChapterLimit ?? extractChapterLimitFromOutline(normalizedVolumeOutline);
    if (typeof outlineChapterLimit !== "number" || !Number.isFinite(outlineChapterLimit) || outlineChapterLimit < 1) {
      throw new Error("卷纲规划缺少总章数或章节范围，无法进行分章设计。");
    }

    const storyDir = join(params.bookDir, "story");
    const [
      characterMatrix,
      storyBible,
      emotionalArcs,
      pendingHooks,
      chapterSummaries,
    ] = await Promise.all([
      readCharacterMatrix(storyDir),
      readStoryFrame(params.bookDir, ""),
      readEmotionalArcs(storyDir),
      readPendingHooks(storyDir),
      this.readFileOrDefault(join(storyDir, "chapter_summaries.md")),
    ]);
    const recentSummaries = formatRecentSummaries(chapterSummaries, params.referenceChapterNumber, 6);
    const existingPlans = params.existingPlans
      ?.filter((plan) => plan.chapterNumber < params.referenceChapterNumber)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
      .slice(-6)
      .map((plan) => ({
        chapterNumber: plan.chapterNumber,
        chapterName: plan.chapterName,
        highlight: plan.highlight,
        endingHook: plan.endingHook,
      }));

    return {
      volumeOutline: normalizedVolumeOutline,
      characterMatrix,
      storyBible: storyBible || undefined,
      emotionalArcs,
      pendingHooks,
      chapterSummaries: recentSummaries === "（暂无前章摘要）" && chapterSummaries.trim()
        ? chapterSummaries.trim()
        : recentSummaries,
      outlineChapterLimit,
      existingPlans,
    };
  }

  private async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Optimize an existing chapter plan based on user instruction.
   */
  async optimizePlan(input: {
    readonly chapterNumber: number;
    readonly instruction: string;
    readonly currentPlan: Readonly<{
      chapterName: string;
      highlight: string;
      coreConflict: string;
      plotAndConflict: string;
      emotionalTone: string;
      endingHook: string;
    }>;
    readonly language?: string;
  }): Promise<{
    chapterName: string;
    highlight: string;
    coreConflict: string;
    plotAndConflict: string;
    emotionalTone: string;
    endingHook: string;
  }> {
    const language = input.language ?? "zh";
    const isZh = language !== "en";

    const systemPrompt = isZh
      ? `你是一位资深小说分章设计师，负责根据用户指令优化章节设计。
输出严格JSON格式，只输出JSON不要解释。`
      : `You are a senior novel chapter designer. Output only JSON, no explanation.`;

    const userMessage = isZh
      ? `## 当前章节设计
- 章节名称：${input.currentPlan.chapterName || "未知"}
- 核心看点：${input.currentPlan.highlight || "未知"}
- 核心冲突：${input.currentPlan.coreConflict || "未知"}
- 剧情与冲突：${input.currentPlan.plotAndConflict || "未知"}
- 情感基调：${input.currentPlan.emotionalTone || "未知"}
- 结尾钩子：${input.currentPlan.endingHook || "未知"}

## 修改指令
${input.instruction}

## 输出
输出JSON格式，包含：chapterName, highlight, coreConflict, plotAndConflict, emotionalTone, endingHook`
      : `## Current Chapter Design
- Chapter Name: ${input.currentPlan.chapterName || "Unknown"}
- Highlight: ${input.currentPlan.highlight || "Unknown"}
- Core Conflict: ${input.currentPlan.coreConflict || "Unknown"}
- Plot & Conflict: ${input.currentPlan.plotAndConflict || "Unknown"}
- Emotional Tone: ${input.currentPlan.emotionalTone || "Unknown"}
- Ending Hook: ${input.currentPlan.endingHook || "Unknown"}

## User Instruction
${input.instruction}

## Output
Output JSON with: chapterName, highlight, coreConflict, plotAndConflict, emotionalTone, endingHook`;

    const messages: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const response = await this.chat(messages, { temperature: 0.7 });

    let content = response.content.trim();
    // Try to extract JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      content = jsonMatch[1]!;
    } else {
      const startIdx = content.indexOf("{");
      const endIdx = content.lastIndexOf("}");
      if (startIdx >= 0 && endIdx > startIdx) {
        content = content.slice(startIdx, endIdx + 1);
      }
    }

    try {
      const parsed = JSON.parse(content);
      return {
        chapterName: parsed.chapterName ?? input.currentPlan.chapterName,
        highlight: parsed.highlight ?? input.currentPlan.highlight,
        coreConflict: parsed.coreConflict ?? input.currentPlan.coreConflict,
        plotAndConflict: parsed.plotAndConflict ?? input.currentPlan.plotAndConflict,
        emotionalTone: parsed.emotionalTone ?? input.currentPlan.emotionalTone,
        endingHook: parsed.endingHook ?? input.currentPlan.endingHook,
      };
    } catch {
      // Fallback: return unchanged
      return { ...input.currentPlan };
    }
  }

  /**
   * Analyze an existing chapter and infer its design from content.
   */
  async analyzeAndDesignChapter(input: AnalyzeChapterInput): Promise<ChapterPlan> {
    const language = input.language ?? input.book.language ?? "zh";
    const isZh = language !== "en";

    // Load context for better design
    const context = await this.loadContext({
      bookDir: input.bookDir,
      volumeOutline: input.volumeOutline,
      referenceChapterNumber: input.chapterNumber,
      outlineChapterLimit: input.outlineChapterLimit,
    });

    if (typeof context.outlineChapterLimit === "number" && input.chapterNumber > context.outlineChapterLimit) {
      throw new Error(`Chapter ${input.chapterNumber} exceeds outline chapter limit ${context.outlineChapterLimit}`);
    }

    // Build prompt for analyzing existing content
    const userMessage = this.buildBackfillUserMessage(input, context, isZh);

    const messages = [
      { role: "system" as const, content: getChapterDesignSystemPrompt(language) },
      { role: "user" as const, content: userMessage },
    ];

    const response = await this.chat(messages, { temperature: 0.7 });

    const parsed = parseChapterDesignOutput(response.content, input.chapterNumber, 1);
    const first = parsed[0];

    const now = new Date().toISOString();
    return ChapterPlanSchema.parse({
      chapterNumber: input.chapterNumber,
      chapterName: first?.chapterName || input.title || `第${input.chapterNumber}章`,
      highlight: first?.highlight || `第${input.chapterNumber}章核心看点待确认`,
      coreConflict: first?.coreConflict || `第${input.chapterNumber}章核心冲突待确认`,
      plotAndConflict: first?.plotAndConflict || `第${input.chapterNumber}章剧情与冲突待确认`,
      emotionalTone: first?.emotionalTone || "待确认",
      endingHook: first?.endingHook || "待确认",
      hookAssignment: first?.hookAssignment ?? [],
      requiredRecoverHooks: first?.requiredRecoverHooks ?? [],
      maxNewHooks: first?.maxNewHooks ?? 3,
      status: "backfilled",
      source: "inferred_from_text",
      version: 1,
      needsReview: true,
      anchorRefs: {
        worldRefs: [],
        characterRefs: [],
        emotionRefs: [],
        hookRefs: [],
      },
      driftFlags: [],
      lockedFields: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  private buildBackfillUserMessage(
    input: AnalyzeChapterInput,
    context: ChapterDesignContext,
    isZh: boolean,
  ): string {
    const parts: string[] = [];
    const normalizedVolumeOutline = context.volumeOutline.trim();
    if (!normalizedVolumeOutline) {
      throw new Error("卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。");
    }

    // Instruction
    parts.push(isZh
      ? `请分析以下第 ${input.chapterNumber} 章的正文内容，生成章节设计。`
      : `Please analyze the following Chapter ${input.chapterNumber} content and generate a chapter design.`);
    parts.push("");
    if (typeof context.outlineChapterLimit === "number") {
      parts.push(isZh ? "## 章数硬约束" : "## Chapter Count Constraint");
      parts.push(isZh
        ? `- 卷纲总章数：${context.outlineChapterLimit}章`
        : `- Volume total chapter limit: ${context.outlineChapterLimit}`);
      parts.push(isZh
        ? `- 仅允许在卷纲总章数范围内分析，不要输出任何超纲章节`
        : `- Only analyze chapters within the outline limit; do not output any out-of-range chapter designs`);
      parts.push("");
    }

    // Chapter title
    parts.push(isZh ? "## 本章标题" : "## Chapter Title");
    parts.push(input.title || `第${input.chapterNumber}章`);
    parts.push("");

    // Volume outline
    parts.push(isZh ? "## 卷纲规划（必须输入，唯一规划依据）" : "## Volume Outline (required, authoritative)");
    parts.push(normalizedVolumeOutline);
    parts.push("");

    // Chapter content excerpt (first 2000 chars for analysis)
    parts.push(isZh ? "## 正文内容（前2000字）" : "## Chapter Content (first 2000 chars)");
    parts.push(input.content.slice(0, 2000));
    parts.push("");

    // Context: character matrix
    if (context.characterMatrix.trim()) {
      parts.push(isZh ? "## 角色设定（参考）" : "## Character Settings (reference)");
      parts.push(context.characterMatrix.trim().slice(0, 1000));
      parts.push("");
    }

    // Context: world/story bible
    if (context.storyBible?.trim()) {
      parts.push(isZh ? "## 世界观设定（参考）" : "## Worldbuilding (reference)");
      parts.push(context.storyBible.trim().slice(0, 1200));
      parts.push("");
    }

    // Context: emotional arcs
    if (context.emotionalArcs.trim()) {
      parts.push(isZh ? "## 感情线（参考）" : "## Emotional Arcs (reference)");
      parts.push(context.emotionalArcs.trim().slice(0, 1000));
      parts.push("");
    }

    // Context: pending hooks
    if (context.pendingHooks.trim()) {
      parts.push(isZh ? "## 伏笔池（参考）" : "## Pending Hooks (reference)");
      parts.push(context.pendingHooks.trim().slice(0, 1000));
      parts.push("");
    }

    if (context.chapterSummaries.trim()) {
      parts.push(isZh ? "## 前章摘要（Previous Chapter Summaries）" : "## Previous Chapter Summaries");
      parts.push(context.chapterSummaries.trim());
      parts.push("");
    }

    // Output instruction
    parts.push(isZh
      ? "输出必须包含以下六个字段：chapterName、highlight、coreConflict、plotAndConflict、emotionalTone、endingHook。"
      : "Output must include six fields: chapterName, highlight, coreConflict, plotAndConflict, emotionalTone, endingHook.");
    parts.push("");
    parts.push(isZh
      ? "请严格按照 YAML 格式输出章节设计，不要有任何额外解释。"
      : "Please strictly follow the YAML format above for chapter design output, no additional explanations.");

    return parts.join("\n");
  }
}
