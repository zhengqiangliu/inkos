/**
 * Chapter Design Agent Prompts
 *
 * Generates chapter design content (chapterName, highlight, coreConflict,
 * plotAndConflict, emotionalTone, endingHook) based on book context.
 */

export const CHAPTER_DESIGN_SYSTEM_PROMPT_ZH = `你是一位资深小说分章设计师，负责根据卷纲和角色设定为每一章生成详细的章节设计方案。

你的职责是根据输入的卷纲大纲、世界观设定、角色信息、感情弧线和伏笔池，生成高质量的章节设计。
其中卷纲是唯一的章节规划依据，必须优先于所有其他参考材料。

## 工作原则

1. **符合卷纲**: 每章设计必须服务于卷纲设定的整体方向和节奏
2. **角色驱动**: 基于角色设定（性格、目标、关系）设计冲突和发展
3. **情感节奏**: 根据情感弧线安排章节的情感基调，确保高低起伏
4. **伏笔呼应**: 适时回收伏笔，同时埋下新的伏笔钩子
5. **具体可写**: 设计要具体到可以指导写作，不能太抽象
6. **章数上限**: 严格遵守卷纲总章数，任何超出上限的章节都不允许生成
7. **卷纲优先**: 所有章节编号、节奏和冲突推进都必须服从卷纲规划，不得自行扩展或补写超纲章节

## 输出字段说明

每个章节设计包含以下字段：

- **chapterName**: 章节名称（简洁有力，5-15字）
- **highlight**: 核心看点（用一句话说明本章最吸引人的点，20-40字）
- **coreConflict**: 核心冲突（本章最主要的矛盾是什么，30-60字）
- **plotAndConflict**: 剧情与冲突（详细描述本章剧情走向和冲突推进，包含具体事件和冲突点，100-200字）
- **emotionalTone**: 情感基调（紧张/温情/悬疑/热血/压抑等，1-3个字）
- **endingHook**: 结尾钩子（本章结尾留下的悬念或转折，吸引读者继续阅读，30-50字）
- **hookAssignment**: 伏笔回收分配（本章计划回收的伏笔，用列表格式，每行一条）
- **requiredRecoverHooks**: 强制回收伏笔（必须在回收的逾期或高优伏笔，不可跳过）
- **maxNewHooks**: 最大新增伏笔数（本章最多埋下的新伏笔数量，推荐1-3，不可超过5）
- **maxRecoveryPerChapter**: 本章最多回收伏笔数（建议与债务压力联动，通常 1-5）

章节编号由系统根据请求顺序自动指定，不需要在 YAML 中输出。

## 批量生成策略

当一次生成多章时，需要注意：
- 每章之间要有连贯性和递进感
- 前章结尾钩子要在下一章得到呼应或发展
- 整体节奏要有起伏，不能全是高潮也不能全是平淡
- 章节编号必须严格按请求顺序连续递增，不能跳号、不能改号、不能越过卷纲总章数；不要在 YAML 中输出 chapterNumber
- 输出的 YAML 章节块数量必须与本次请求数量完全一致，不得少章、不得多章
- 批量生成时章与章之间用 YAML 分隔符分开

## 输出格式

严格遵守以下 YAML 格式，每章用 --- 分隔：

---
chapterName: 章节名称
highlight: 核心看点
coreConflict: 核心冲突
plotAndConflict: |
  剧情与冲突详细描述
emotionalTone: 情感基调
endingHook: 结尾钩子
hookAssignment:
  - 回收伏笔1描述
  - 回收伏笔2描述
requiredRecoverHooks:
  - 强制回收伏笔描述
maxNewHooks: 3
maxRecoveryPerChapter: 3
---

不要输出除了 YAML 之外的任何解释性文字。`;

export const CHAPTER_DESIGN_SYSTEM_PROMPT_EN = `You are a senior novel chapter designer, responsible for generating detailed chapter design plans for each chapter based on the volume outline and character settings.

Your responsibility is to generate high-quality chapter designs based on the input volume outline, worldbuilding, character information, emotional arcs, and pending hooks.
The volume outline is the only authoritative planning source; all other materials are secondary references.

## Working Principles

1. **Align with Volume Outline**: Each chapter design must serve the overall direction and rhythm set by the volume outline
2. **Character-Driven**: Design conflicts and developments based on character settings (personality, goals, relationships)
3. **Emotional Rhythm**: Arrange the emotional tone of chapters according to emotional arcs, ensuring ups and downs
4. **Hook Responsiveness**: Timely resolve hooks while planting new ones
5. **Specific and Writeable**: Designs must be specific enough to guide writing, not too abstract
6. **Chapter Limit**: Never generate chapters beyond the total chapter count in the outline
7. **Outline First**: Chapter numbers, pacing, and conflict progression must obey the outline plan and never expand beyond it

## Output Fields

Each chapter design contains:

- **chapterName**: Chapter name (concise and powerful, 5-15 characters)
- **highlight**: Core highlight (one sentence explaining the most attractive point of this chapter, 20-40 chars)
- **coreConflict**: Core conflict (what is the main conflict in this chapter, 30-60 chars)
- **plotAndConflict**: Plot and conflict (detailed description of this chapter's plot direction and conflict advancement, 100-200 chars)
- **emotionalTone**: Emotional tone (tense/warm/suspenseful/passionate/depressing, 1-3 words)
- **endingHook**: Ending hook (the cliffhanger or twist at the end of this chapter, 30-50 chars)
- **hookAssignment**: Hook recovery assignment (hooks planned to resolve in this chapter, list format, one per line)
- **requiredRecoverHooks**: Required recovery hooks (overdue or high-priority hooks that must be recovered, cannot skip)
- **maxNewHooks**: Maximum new hooks to plant (max number of new hooks to plant in this chapter, recommended 1-3, max 5)
- **maxRecoveryPerChapter**: Max hooks to recover in this chapter (recommend linking to debt pressure, usually 1-5)

Chapter numbers are assigned by the system in request order; do not output chapterNumber in YAML.

## Batch Generation Strategy

When generating multiple chapters at once:
- Each chapter must have coherence and progression with the previous one
- The previous chapter's ending hook should be echoed or developed in the next chapter
- Overall rhythm must have ups and downs, not all climaxes or all平淡
- Chapter numbers must follow the requested sequence exactly, without skipping, renumbering, or exceeding the outline limit; do not output chapterNumber
- The number of YAML chapter blocks must exactly match the requested count; do not output fewer or more chapters
- Separate chapters with YAML delimiters

## Output Format

Strictly follow this YAML format, separate chapters with ---:

---
chapterName: Chapter Name
highlight: Core highlight
coreConflict: Core conflict
plotAndConflict: |
  Detailed plot and conflict description
emotionalTone: Emotional tone
endingHook: Ending hook
hookAssignment:
  - Hook recovery description 1
  - Hook recovery description 2
requiredRecoverHooks:
  - Required hook recovery description
maxNewHooks: 3
maxRecoveryPerChapter: 3
---

Do not output any explanatory text other than YAML.`;

export function getChapterDesignSystemPrompt(language: string): string {
  return language === "en" ? CHAPTER_DESIGN_SYSTEM_PROMPT_EN : CHAPTER_DESIGN_SYSTEM_PROMPT_ZH;
}

export interface ChapterDesignContext {
  readonly volumeOutline: string;
  readonly characterMatrix: string;
  readonly storyBible?: string;
  readonly emotionalArcs: string;
  readonly pendingHooks: string;
  readonly chapterSummaries: string;
  readonly outlineChapterLimit?: number;
  readonly existingPlans?: ReadonlyArray<{
    chapterNumber: number;
    chapterName: string;
    highlight: string;
    endingHook: string;
  }>;
}

export function buildChapterDesignUserMessage(
  context: ChapterDesignContext,
  startChapter: number,
  count: number,
  language: string,
): string {
  const isZh = language !== "en";
  const normalizedVolumeOutline = context.volumeOutline.trim();
  if (!normalizedVolumeOutline) {
    throw new Error("卷纲规划缺失：请先提供 story/outline/volume_map.md 或 legacy story/volume_outline.md。");
  }
  const parts: string[] = [];
  const requestedEnd = startChapter + count - 1;
  const effectiveEnd = typeof context.outlineChapterLimit === "number"
    ? Math.min(requestedEnd, context.outlineChapterLimit)
    : requestedEnd;
  const hasValidRange = effectiveEnd >= startChapter;

  // Header instruction
  if (isZh) {
    parts.push(hasValidRange
      ? `请为第 ${startChapter} 章到第 ${effectiveEnd} 章生成章节设计方案。`
      : `请分析第 ${startChapter} 章到第 ${requestedEnd} 章的请求，但卷纲总章数已不足以覆盖该范围，请不要输出任何超纲章节。`);
    parts.push("");
    if (typeof context.outlineChapterLimit === "number") {
      parts.push(`## 章数硬约束`);
      parts.push(`- 卷纲总章数：${context.outlineChapterLimit}章`);
      if (hasValidRange) {
        parts.push(`- 本次最多生成到第 ${effectiveEnd} 章`);
      } else {
        parts.push(`- 本次请求全部超出卷纲总章数，请不要输出任何章节设计`);
      }
      parts.push(`- 章节编号必须严格按请求顺序连续递增，不能跳号、不能改号、不能越界`);
      parts.push("");
    }
  } else {
    parts.push(hasValidRange
      ? `Please generate chapter design plans for chapters ${startChapter} to ${effectiveEnd}.`
      : `Please analyze the requested range ${startChapter} to ${requestedEnd}, but the outline limit does not cover it. Do not output any out-of-range chapters.`);
    parts.push("");
    if (typeof context.outlineChapterLimit === "number") {
      parts.push("## Chapter Count Constraint");
      parts.push(`- Volume total chapter limit: ${context.outlineChapterLimit}`);
      if (hasValidRange) {
        parts.push(`- Generate at most through chapter ${effectiveEnd}`);
      } else {
        parts.push(`- The entire requested range is beyond the outline limit; output nothing`);
      }
      parts.push(`- Chapter numbers must follow the requested sequence exactly and never exceed the outline limit`);
      parts.push("");
    }
  }

  // Volume outline
  parts.push(isZh ? "## 卷纲规划（必须输入，唯一规划依据）" : "## Volume Outline (required, authoritative)");
  parts.push(normalizedVolumeOutline);
  parts.push("");

  // Character matrix
  if (context.characterMatrix.trim()) {
    parts.push(isZh ? "## 角色矩阵（Character Matrix）" : "## Character Matrix");
    parts.push(context.characterMatrix.trim());
    parts.push("");
  }

  // Story bible
  if (context.storyBible?.trim()) {
    parts.push(isZh ? "## 世界观设定（Story Bible）" : "## Worldbuilding");
    parts.push(context.storyBible.trim());
    parts.push("");
  }

  // Emotional arcs
  if (context.emotionalArcs.trim()) {
    parts.push(isZh ? "## 情感弧线（Emotional Arcs）" : "## Emotional Arcs");
    parts.push(context.emotionalArcs.trim());
    parts.push("");
  }

  // Pending hooks
  if (context.pendingHooks.trim()) {
    parts.push(isZh ? "## 伏笔池（Pending Hooks）" : "## Pending Hooks");
    parts.push(context.pendingHooks.trim());
    parts.push("");
  }

  // Chapter summaries
  if (context.chapterSummaries.trim()) {
    parts.push(isZh ? "## 前章摘要（Previous Chapter Summaries）" : "## Previous Chapter Summaries");
    parts.push(context.chapterSummaries.trim());
    parts.push("");
  }

  // Existing plans (for continuity)
  if (context.existingPlans && context.existingPlans.length > 0) {
    parts.push(isZh ? "## 已有章节设计（Existing Chapter Plans）" : "## Existing Chapter Plans");
    for (const plan of context.existingPlans) {
      parts.push(`### ${isZh ? "第" : "Chapter "}${plan.chapterNumber}${isZh ? "章" : ""}`);
      parts.push(`- ${isZh ? "名称" : "Name"}: ${plan.chapterName}`);
      parts.push(`- ${isZh ? "看点" : "Highlight"}: ${plan.highlight}`);
      parts.push(`- ${isZh ? "结尾钩子" : "Ending Hook"}: ${plan.endingHook}`);
      parts.push("");
    }
  }

  // Output instruction
  parts.push(isZh
    ? "请严格按照上述 YAML 格式输出，不要有任何额外解释。"
    : "Please strictly follow the YAML format above, no additional explanations.");

  return parts.join("\n");
}

/**
 * Parse YAML-like output from the LLM into structured chapter design objects.
 * Handles the --- delimiter format.
 */
export interface ParsedChapterDesign {
  chapterNumber: number;
  chapterName: string;
  highlight: string;
  coreConflict: string;
  plotAndConflict: string;
  emotionalTone: string;
  endingHook: string;
  hookAssignment: readonly string[];
  requiredRecoverHooks: readonly string[];
  maxNewHooks: number;
  maxRecoveryPerChapter: number;
}

export function parseChapterDesignOutput(
  output: string,
  startChapter: number,
  count: number,
): Array<ParsedChapterDesign> {
  const chapters: Array<ParsedChapterDesign> = [];

  // Split by YAML document separators
  const documents = output.split(/^---$/m).filter((doc) => doc.trim());

  for (let i = 0; i < documents.length && chapters.length < count; i++) {
    const doc = documents[i]!.trim();
    const chapter = parseYamlDocument(doc, startChapter + chapters.length);
    if (chapter) {
      chapters.push(chapter);
    }
  }

  return chapters;
}

const LIST_FIELDS = new Set(["hookAssignment", "requiredRecoverHooks"]);

function parseYamlDocument(
  doc: string,
  expectedChapter: number,
): ParsedChapterDesign | null {
  const lines = doc.split("\n");
  const chapterNumber = expectedChapter;
  let chapterName = "";
  let highlight = "";
  let coreConflict = "";
  let plotAndConflict = "";
  let emotionalTone = "";
  let endingHook = "";
  const hookAssignment: string[] = [];
  const requiredRecoverHooks: string[] = [];
  let maxNewHooks = 3;
  let maxRecoveryPerChapter = 3;

  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let currentList: string[] | null = null;
  let inBlockScalar = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;

    // YAML list item
    const listMatch = trimmed.match(/^-\s+(.*)$/);
    if (listMatch && currentList !== null) {
      currentList.push(listMatch[1]!.trim());
      continue;
    }

    // Flush previous key
    if (currentKey && currentList === null) {
      const value = currentValue.join("\n").trim();
      switch (currentKey) {
        case "chapterName":
          chapterName = value;
          break;
        case "highlight":
          highlight = value;
          break;
        case "coreConflict":
          coreConflict = value;
          break;
        case "plotAndConflict":
          plotAndConflict = value;
          break;
        case "emotionalTone":
          emotionalTone = value;
          break;
        case "endingHook":
          endingHook = value;
          break;
        case "maxNewHooks":
          maxNewHooks = Math.max(0, Math.min(5, parseInt(value, 10) || 3));
          break;
        case "maxRecoveryPerChapter":
          maxRecoveryPerChapter = Math.max(0, Math.min(5, parseInt(value, 10) || 3));
          break;
      }
    }

    // Check for key: value pattern
    const keyMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1]!;
      currentValue = keyMatch[2] ? [keyMatch[2]] : [];
      inBlockScalar = false;
      currentList = null;

      if (LIST_FIELDS.has(currentKey)) {
        currentList = currentKey === "hookAssignment" ? hookAssignment : requiredRecoverHooks;
      } else if (!keyMatch[2]) {
        // Empty value, wait for next lines
        continue;
      } else {
        // Single line value
        const singleValue = keyMatch[2]!.trim();
        if (singleValue.startsWith("|")) {
          inBlockScalar = true;
          const rest = singleValue.slice(1).trim();
          if (rest) currentValue = [rest];
        }
      }
    } else if (currentKey && currentList === null && (inBlockScalar || trimmed.startsWith("|"))) {
      // Multi-line block scalar continuation
      currentValue.push(inBlockScalar ? trimmed : trimmed.slice(1).trim());
    } else if (currentKey && currentList === null) {
      // Continuation of previous value
      currentValue.push(trimmed);
    }
  }

  // Save last key
  if (currentKey && currentList === null) {
    const value = currentValue.join("\n").trim();
    switch (currentKey) {
      case "chapterName":
        chapterName = value;
        break;
      case "highlight":
        highlight = value;
        break;
      case "coreConflict":
        coreConflict = value;
        break;
      case "plotAndConflict":
        plotAndConflict = value;
        break;
      case "emotionalTone":
        emotionalTone = value;
        break;
      case "endingHook":
        endingHook = value;
        break;
      case "maxNewHooks":
        maxNewHooks = Math.max(0, Math.min(5, parseInt(value, 10) || 3));
        break;
      case "maxRecoveryPerChapter":
        maxRecoveryPerChapter = Math.max(0, Math.min(5, parseInt(value, 10) || 3));
        break;
    }
  }

  if (!chapterName && !highlight && !coreConflict) {
    return null;
  }

  return {
    chapterNumber,
    chapterName,
    highlight,
    coreConflict,
    plotAndConflict,
    emotionalTone,
    endingHook,
    hookAssignment,
    requiredRecoverHooks,
    maxNewHooks,
    maxRecoveryPerChapter,
  };
}
