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
  readBrief,
  formatRecentSummaries,
} from "./planner-context.js";

export interface DesignChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly language?: string;
}

export interface DesignBatchInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly startChapter: number;
  readonly count: number;
  readonly existingPlans?: ReadonlyArray<ChapterPlan>;
  readonly language?: string;
}

export interface AnalyzeChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
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
    const storyDir = join(input.bookDir, "story");
    const language = input.language ?? input.book.language ?? "zh";

    const context = await this.loadContext(storyDir, language, existingPlans);

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
      chapterNumber: first.chapterNumber,
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
    const storyDir = join(input.bookDir, "story");
    const language = input.language ?? input.book.language ?? "zh";

    const context = await this.loadContext(storyDir, language, input.existingPlans);

    const messages = [
      { role: "system" as const, content: getChapterDesignSystemPrompt(language) },
      { role: "user" as const, content: buildChapterDesignUserMessage(context, input.startChapter, input.count, language) },
    ];

    const response = await this.chat(messages, { temperature: 0.7 });

    const parsed = parseChapterDesignOutput(response.content, input.startChapter, input.count);
    const now = new Date().toISOString();

    return parsed.map((p) =>
      ChapterPlanSchema.parse({
        chapterNumber: p.chapterNumber,
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

  private async loadContext(
    storyDir: string,
    language: string,
    existingPlans?: ReadonlyArray<ChapterPlan>,
  ): Promise<ChapterDesignContext> {
    const [
      volumeOutline,
      characterMatrix,
      storyBible,
      emotionalArcs,
      pendingHooks,
      chapterSummaries,
    ] = await Promise.all([
      this.readFileOrDefault(join(storyDir, "volume_outline.md")),
      readCharacterMatrix(storyDir),
      this.readFileOrDefault(join(storyDir, "story_bible.md")),
      readEmotionalArcs(storyDir),
      readPendingHooks(storyDir),
      this.readFileOrDefault(join(storyDir, "chapter_summaries.md")),
    ]);

    return {
      volumeOutline,
      characterMatrix,
      storyBible: storyBible || undefined,
      emotionalArcs,
      pendingHooks,
      chapterSummaries,
      existingPlans: existingPlans?.map((plan) => ({
        chapterNumber: plan.chapterNumber,
        chapterName: plan.chapterName,
        highlight: plan.highlight,
        endingHook: plan.endingHook,
      })),
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
  async analyzeAndDesignChapter(input: {
    readonly book: BookConfig;
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly title: string;
    readonly content: string;
    readonly language?: string;
  }): Promise<ChapterPlan> {
    const storyDir = join(input.bookDir, "story");
    const language = input.language ?? input.book.language ?? "zh";
    const isZh = language !== "en";

    // Load context for better design
    const context = await this.loadContext(storyDir, language, undefined);

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

    // Instruction
    parts.push(isZh
      ? `请分析以下第 ${input.chapterNumber} 章的正文内容，生成章节设计。`
      : `Please analyze the following Chapter ${input.chapterNumber} content and generate a chapter design.`);
    parts.push("");

    // Chapter title
    parts.push(isZh ? "## 本章标题" : "## Chapter Title");
    parts.push(input.title || `第${input.chapterNumber}章`);
    parts.push("");

    // Chapter content excerpt (first 2000 chars for analysis)
    parts.push(isZh ? "## 正文内容（前2000字）" : "## Chapter Content (first 2000 chars)");
    parts.push(input.content.slice(0, 2000));
    parts.push("");

    // Context: volume outline
    if (context.volumeOutline.trim()) {
      parts.push(isZh ? "## 卷纲（参考）" : "## Volume Outline (reference)");
      parts.push(context.volumeOutline.trim().slice(0, 1500));
      parts.push("");
    }

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
