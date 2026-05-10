/**
 * Chapter Design Agent Prompts
 *
 * Generates chapter design content (chapterName, highlight, coreConflict,
 * plotAndConflict, emotionalTone, endingHook) based on book context.
 */

export const CHAPTER_DESIGN_SYSTEM_PROMPT_ZH = `你是一位资深小说分章设计师，负责根据卷纲和角色设定为每一章生成详细的章节设计方案。

你的职责是根据输入的卷纲大纲、世界观设定、角色信息、感情弧线和伏笔池，生成高质量的章节设计。

## 工作原则

1. **符合卷纲**: 每章设计必须服务于卷纲设定的整体方向和节奏
2. **角色驱动**: 基于角色设定（性格、目标、关系）设计冲突和发展
3. **情感节奏**: 根据情感弧线安排章节的情感基调，确保高低起伏
4. **伏笔呼应**: 适时回收伏笔，同时埋下新的伏笔钩子
5. **具体可写**: 设计要具体到可以指导写作，不能太抽象

## 输出字段说明

每个章节设计包含以下字段：

- **chapterNumber**: 章节编号（纯数字）
- **chapterName**: 章节名称（简洁有力，5-15字）
- **highlight**: 核心看点（用一句话说明本章最吸引人的点，20-40字）
- **coreConflict**: 核心冲突（本章最主要的矛盾是什么，30-60字）
- **plotAndConflict**: 剧情与冲突（详细描述本章剧情走向和冲突推进，包含具体事件和冲突点，100-200字）
- **emotionalTone**: 情感基调（紧张/温情/悬疑/热血/压抑等，1-3个字）
- **endingHook**: 结尾钩子（本章结尾留下的悬念或转折，吸引读者继续阅读，30-50字）

## 批量生成策略

当一次生成多章时，需要注意：
- 每章之间要有连贯性和递进感
- 前章结尾钩子要在下一章得到呼应或发展
- 整体节奏要有起伏，不能全是高潮也不能全是平淡
- 批量生成时章与章之间用 YAML 分隔符分开

## 输出格式

严格遵守以下 YAML 格式，每章用 --- 分隔：

---
chapterNumber: X
chapterName: 章节名称
highlight: 核心看点
coreConflict: 核心冲突
plotAndConflict: |
  剧情与冲突详细描述
emotionalTone: 情感基调
endingHook: 结尾钩子
---

不要输出除了 YAML 之外的任何解释性文字。`;

export const CHAPTER_DESIGN_SYSTEM_PROMPT_EN = `You are a senior novel chapter designer, responsible for generating detailed chapter design plans for each chapter based on the volume outline and character settings.

Your responsibility is to generate high-quality chapter designs based on the input volume outline, worldbuilding, character information, emotional arcs, and pending hooks.

## Working Principles

1. **Align with Volume Outline**: Each chapter design must serve the overall direction and rhythm set by the volume outline
2. **Character-Driven**: Design conflicts and developments based on character settings (personality, goals, relationships)
3. **Emotional Rhythm**: Arrange the emotional tone of chapters according to emotional arcs, ensuring ups and downs
4. **Hook Responsiveness**: Timely resolve hooks while planting new ones
5. **Specific and Writeable**: Designs must be specific enough to guide writing, not too abstract

## Output Fields

Each chapter design contains:

- **chapterNumber**: Chapter number (pure number)
- **chapterName**: Chapter name (concise and powerful, 5-15 characters)
- **highlight**: Core highlight (one sentence explaining the most attractive point of this chapter, 20-40 chars)
- **coreConflict**: Core conflict (what is the main conflict in this chapter, 30-60 chars)
- **plotAndConflict**: Plot and conflict (detailed description of this chapter's plot direction and conflict advancement, 100-200 chars)
- **emotionalTone**: Emotional tone (tense/warm/suspenseful/passionate/depressing, 1-3 words)
- **endingHook**: Ending hook (the cliffhanger or twist at the end of this chapter, 30-50 chars)

## Batch Generation Strategy

When generating multiple chapters at once:
- Each chapter must have coherence and progression with the previous one
- The previous chapter's ending hook should be echoed or developed in the next chapter
- Overall rhythm must have ups and downs, not all climaxes or all平淡
- Separate chapters with YAML delimiters

## Output Format

Strictly follow this YAML format, separate chapters with ---:

---
chapterNumber: X
chapterName: Chapter Name
highlight: Core highlight
coreConflict: Core conflict
plotAndConflict: |
  Detailed plot and conflict description
emotionalTone: Emotional tone
endingHook: Ending hook
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
  const parts: string[] = [];

  // Header instruction
  if (isZh) {
    parts.push(`请为第 ${startChapter} 章到第 ${startChapter + count - 1} 章生成章节设计方案。`);
    parts.push("");
  } else {
    parts.push(`Please generate chapter design plans for chapters ${startChapter} to ${startChapter + count - 1}.`);
    parts.push("");
  }

  // Volume outline
  if (context.volumeOutline.trim()) {
    parts.push(isZh ? "## 卷纲（Volume Outline）" : "## Volume Outline");
    parts.push(context.volumeOutline.trim());
    parts.push("");
  }

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
export function parseChapterDesignOutput(
  output: string,
  startChapter: number,
  count: number,
): Array<{
  chapterNumber: number;
  chapterName: string;
  highlight: string;
  coreConflict: string;
  plotAndConflict: string;
  emotionalTone: string;
  endingHook: string;
}> {
  const chapters: Array<{
    chapterNumber: number;
    chapterName: string;
    highlight: string;
    coreConflict: string;
    plotAndConflict: string;
    emotionalTone: string;
    endingHook: string;
  }> = [];

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

function parseYamlDocument(
  doc: string,
  expectedChapter: number,
): {
  chapterNumber: number;
  chapterName: string;
  highlight: string;
  coreConflict: string;
  plotAndConflict: string;
  emotionalTone: string;
  endingHook: string;
} | null {
  const lines = doc.split("\n");
  let chapterNumber = expectedChapter;
  let chapterName = "";
  let highlight = "";
  let coreConflict = "";
  let plotAndConflict = "";
  let emotionalTone = "";
  let endingHook = "";

  let currentKey: string | null = null;
  let currentValue: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;

    // Check for key: value pattern
    const keyMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (keyMatch) {
      // Save previous key
      if (currentKey) {
        const value = currentValue.join("\n").trim();
        switch (currentKey) {
          case "chapterNumber":
            chapterNumber = parseInt(value, 10) || expectedChapter;
            break;
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
        }
      }
      currentKey = keyMatch[1]!;
      currentValue = keyMatch[2] ? [keyMatch[2]] : [];

      // Handle empty value with next lines
      if (!keyMatch[2]) continue;

      // Single line value
      const singleValue = keyMatch[2]!.trim();
      if (singleValue && !singleValue.startsWith("|")) {
        // Single line, already handled
      }
    } else if (currentKey === "plotAndConflict" && trimmed.startsWith("|")) {
      // Multi-line block scalar
      currentValue.push(trimmed.slice(1).trim());
    } else if (currentKey) {
      // Continuation of previous value
      currentValue.push(trimmed);
    }
  }

  // Save last key
  if (currentKey) {
    const value = currentValue.join("\n").trim();
    switch (currentKey) {
      case "chapterNumber":
        chapterNumber = parseInt(value, 10) || expectedChapter;
        break;
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
  };
}